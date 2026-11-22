'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { CloudClient } = require('./cloud');
const { Robot } = require('./robot');

const PLUGIN = 'homebridge-eureka-e20';
const PLATFORM = 'EurekaE20';
const MODEL_SN8 = '750Y000G';
const DOCKED = ['docked'];
// A HomeKit set handler must answer quickly, so wait this long for a command at most.
const COMMAND_WAIT_MS = 7000;
const FAST_POLL_MS = 120000;

class EurekaPlatform {
  // `deps` is optional and only used by tests: makeCloud(opts), makeRobot(opts), commandWaitMs.
  constructor(log, config, api, deps) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    const d = deps || {};
    this.makeCloud = d.makeCloud || ((opts) => new CloudClient(opts));
    this.makeRobot = d.makeRobot || ((opts) => new Robot(opts));
    this.commandWaitMs = d.commandWaitMs === undefined ? COMMAND_WAIT_MS : d.commandWaitMs;
    this.cached = [];
    this.fastUntil = 0;
    this.timer = null;
    this.stopped = false;
    this.ready = null;
    api.on('didFinishLaunching', () => {
      this.ready = this.setup().catch((err) => this.log.error(`Setup failed: ${err.message}`));
    });
    api.on('shutdown', () => this.stop());
  }

  configureAccessory(accessory) { this.cached.push(accessory); }

  async setup() {
    if (!this.config.email || !this.config.password) {
      this.log.warn('Email and password are not set. Open the plugin settings to add them.');
      return;
    }
    const tokenFile = path.join(this.api.user.storagePath(), 'eureka-e20-tokens.json');
    let tokens = null;
    try { tokens = JSON.parse(fs.readFileSync(tokenFile, 'utf8')); } catch (err) { /* first run */ }
    const cloud = this.makeCloud({
      email: this.config.email, password: this.config.password, tokens,
      onTokens: (t) => {
        try {
          fs.writeFileSync(tokenFile, JSON.stringify(t), { mode: 0o600 });
          fs.chmodSync(tokenFile, 0o600);
        } catch (err) { this.log.warn('Could not save the login session'); }
      },
    });
    const devices = await cloud.getDevices();
    const dev = devices.find((x) => x.product && x.product.sn8 === MODEL_SN8);
    if (!dev) {
      this.log.error(`No E20 Plus (model code ${MODEL_SN8}) found on this Eureka account.`);
      return;
    }
    const deviceId = String(dev.deviceId || dev.id);
    this.robot = this.makeRobot({ cloud, deviceId, log: this.log });
    this.buildAccessory(deviceId, dev.nickname || this.config.name || 'Eureka E20 Plus');
    this.robot.on('state', () => this.safePush());
    this.loop();
  }

  buildAccessory(deviceId, name) {
    const { Service, Characteristic } = this.api.hap;
    const uuid = this.api.hap.uuid.generate(`eureka-e20:${deviceId}`);
    let acc = this.cached.find((a) => a.UUID === uuid);
    if (!acc) {
      acc = new this.api.platformAccessory(name, uuid);
      this.api.registerPlatformAccessories(PLUGIN, PLATFORM, [acc]);
    }
    this.accessory = acc;
    acc.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Eureka')
      .setCharacteristic(Characteristic.Model, 'E20 Plus')
      .setCharacteristic(Characteristic.SerialNumber, deviceId);

    const svc = (type, label, sub) => acc.getServiceById(type, sub) || acc.addService(type, label, sub);
    this.clean = svc(Service.Switch, `${name} Clean`, 'clean');
    this.pause = svc(Service.Switch, `${name} Pause`, 'pause');
    this.battery = svc(Service.Battery, `${name} Battery`, 'battery');
    this.fault = svc(Service.ContactSensor, `${name} Fault`, 'fault');

    this.clean.getCharacteristic(Characteristic.On)
      .onGet(() => this.read((s) => s.status === 'cleaning' || s.status === 'moving'))
      .onSet((on) => this.act(on ? () => this.robot.start() : () => this.robot.dock()));
    this.pause.getCharacteristic(Characteristic.On)
      .onGet(() => this.read((s) => s.status === 'paused'))
      .onSet((on) => this.act(on ? () => this.robot.pause() : () => this.robot.start()));
    this.battery.getCharacteristic(Characteristic.BatteryLevel).onGet(() => this.read((s) => s.battery));
    this.battery.getCharacteristic(Characteristic.ChargingState).onGet(() => this.read((s) => this.charging(s)));
    this.battery.getCharacteristic(Characteristic.StatusLowBattery).onGet(() => this.read((s) => (s.battery < 20 ? 1 : 0)));
    this.fault.getCharacteristic(Characteristic.ContactSensorState).onGet(() => this.read((s) => (s.fault ? 1 : 0)));
  }

  charging(s) {
    const { ChargingState } = this.api.hap.Characteristic;
    if (!DOCKED.includes(s.status)) return ChargingState.NOT_CHARGING;
    return s.battery < 100 ? ChargingState.CHARGING : ChargingState.NOT_CHARGING;
  }

  maxAge() { return ((this.config.pollSeconds || 30) * 3 + 20) * 1000; }

  commFailure() {
    return new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  // Throws "No Response" to HomeKit when the last good status is too old.
  read(fn) {
    if (!this.robot.isFresh(this.maxAge())) throw this.commFailure();
    return fn(this.robot.state);
  }

  // Start a command and wait for it for a short time only. A command that is still
  // running after that carries on in the background. Whenever it settles, the real
  // robot state is pushed so a failed command reverts the switches.
  async act(fn) {
    this.fastUntil = Date.now() + FAST_POLL_MS;
    const settled = Promise.resolve().then(fn).then(() => null, (err) => err || new Error('unknown error'));
    settled.then((err) => {
      if (err) this.log.warn(`Command failed: ${err.message}`);
      else this.fastUntil = Date.now() + FAST_POLL_MS;
      this.safePush();
    });
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), this.commandWaitMs); });
    const outcome = await Promise.race([settled, timeout]);
    clearTimeout(timer);
    if (outcome) throw this.commFailure();
    // Either finished successfully, or still running in the background.
  }

  safePush() {
    try { this.push(); } catch (err) { this.log.warn(`Could not update HomeKit: ${err.message}`); }
  }

  push() {
    const { Characteristic } = this.api.hap;
    if (!this.robot.isFresh(this.maxAge())) {
      const gone = this.commFailure();
      this.clean.updateCharacteristic(Characteristic.On, gone);
      this.pause.updateCharacteristic(Characteristic.On, gone);
      return;
    }
    const s = this.robot.state;
    this.clean.updateCharacteristic(Characteristic.On, s.status === 'cleaning' || s.status === 'moving');
    this.pause.updateCharacteristic(Characteristic.On, s.status === 'paused');
    this.battery.updateCharacteristic(Characteristic.BatteryLevel, s.battery);
    this.battery.updateCharacteristic(Characteristic.ChargingState, this.charging(s));
    this.battery.updateCharacteristic(Characteristic.StatusLowBattery, s.battery < 20 ? 1 : 0);
    this.fault.updateCharacteristic(Characteristic.ContactSensorState, s.fault ? 1 : 0);
  }

  // Poll every pollSeconds, or every 10 seconds for two minutes after a command.
  async loop() {
    if (this.stopped) return;
    try {
      const s = await this.robot.poll();
      this.log.debug(`Status ${s.status}, battery ${s.battery}`);
    } catch (err) {
      this.log.warn(`Status check failed: ${err.message}`);
    }
    if (this.stopped) return;
    const wait = Date.now() < this.fastUntil ? 10 : (this.config.pollSeconds || 30);
    this.timer = setTimeout(() => this.loop(), wait * 1000);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

module.exports = { EurekaPlatform };
