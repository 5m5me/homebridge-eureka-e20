'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { CloudClient, AuthError } = require('./cloud');
const { Robot, CommandUnconfirmedError } = require('./robot');
const { MatterVacuum } = require('./matter-vacuum');

const PLUGIN = 'homebridge-eureka-e20';
const PLATFORM = 'EurekaE20';
const MODEL_SN8 = '750Y000G';
const DOCKED = ['docked'];
// A HomeKit set handler must answer quickly, so wait this long for a command at most.
const COMMAND_WAIT_MS = 7000;
const FAST_POLL_MS = 120000;
const FAST_POLL_INTERVAL_S = 10;
const SETUP_RETRY_MS = 60000;
const SUBS = ['clean', 'pause', 'battery', 'fault'];
const MATTER_METHODS = ['registerPlatformAccessories', 'updateAccessoryState'];
const DEFAULT_MOP_WATER = 2;

class EurekaPlatform {
  // `deps` is optional and only used by tests: makeCloud(opts), makeRobot(opts), makeMatterVacuum(opts), commandWaitMs.
  constructor(log, config, api, deps) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    const d = deps || {};
    this.makeCloud = d.makeCloud || ((opts) => new CloudClient(opts));
    this.makeRobot = d.makeRobot || ((opts) => new Robot(opts));
    this.makeMatterVacuum = d.makeMatterVacuum || ((opts) => new MatterVacuum(opts));
    this.commandWaitMs = d.commandWaitMs === undefined ? COMMAND_WAIT_MS : d.commandWaitMs;
    this.retryMs = d.retryMs === undefined ? SETUP_RETRY_MS : d.retryMs;
    this.setTimer = d.setTimeout || setTimeout;
    this.clearTimer = d.clearTimeout || clearTimeout;
    this.now = d.now || Date.now;
    this.cached = [];
    this.matterVacuum = null;
    this.matterWarned = false;
    this.accessory = null;
    this.robot = null;
    this.fastUntil = 0;
    this.timer = null;
    this.timerDue = 0;
    this.retryTimer = null;
    this.stopped = false;
    this.offlineLogged = false;
    this.authLogged = false;
    this.ready = null;
    api.on('didFinishLaunching', () => { this.ready = this.start(); });
    api.on('shutdown', () => this.stop());
  }

  configureAccessory(accessory) { this.cached.push(accessory); }

  wantsMatter() { return this.config.matterVacuum !== false; }

  matterAvailable() {
    const m = this.api.matter;
    return Boolean(m && m.deviceTypes && m.deviceTypes.RoboticVacuumCleaner
      && MATTER_METHODS.every((name) => typeof m[name] === 'function'));
  }

  mopWater() {
    const w = this.config.mopWater;
    return Number.isInteger(w) && w >= 1 && w <= 3 ? w : DEFAULT_MOP_WATER;
  }

  // Restored accessories answer No Response until the robot exists and has fresh state.
  async start() {
    try {
      for (const acc of this.cached) {
        for (const sub of SUBS) {
          const service = this.findService(acc, sub);
          if (service) this.bind(sub, service);
        }
      }
    } catch (err) {
      this.log.error(`Could not restore cached accessories: ${err.message}`);
    }
    return this.attempt();
  }

  async attempt() {
    if (this.stopped) return;
    try {
      await this.setup();
    } catch (err) {
      if (err instanceof AuthError) {
        this.log.error('The Eureka cloud rejected the login. Check the email and password in the plugin settings.');
        return;
      }
      if (this.stopped) return;
      this.log.warn(`Setup failed: ${err.message}. Trying again in ${Math.round(this.retryMs / 1000)} seconds.`);
      this.retryTimer = this.setTimer(() => {
        this.retryTimer = null;
        this.ready = this.attempt();
      }, this.retryMs);
      if (this.retryTimer && this.retryTimer.unref) this.retryTimer.unref();
    }
  }

  findService(acc, sub) {
    const { Service } = this.api.hap;
    const type = sub === 'battery' ? Service.Battery : sub === 'fault' ? Service.ContactSensor : Service.Switch;
    return acc.getServiceById(type, sub);
  }

  async setup() {
    if (this.robot) return;
    if (!this.config.email || !this.config.password) {
      this.log.warn('Email and password are not set. Open the plugin settings to add them.');
      return;
    }
    const tokenFile = path.join(this.api.user.storagePath(), 'eureka-e20-tokens.json');
    let tokens = null;
    try {
      // The token file only counts for the account it was saved for.
      const saved = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
      if (saved && typeof saved.email === 'string' && saved.tokens
        && saved.email.toLowerCase() === String(this.config.email).toLowerCase()) tokens = saved.tokens;
    } catch (err) { /* first run */ }
    const cloud = this.makeCloud({
      email: this.config.email, password: this.config.password, tokens,
      onTokens: (t) => {
        try {
          fs.writeFileSync(tokenFile, JSON.stringify({ email: this.config.email, tokens: t }), { mode: 0o600 });
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
    const rawId = dev.deviceId || dev.id;
    if (rawId === undefined || rawId === null || rawId === '') {
      this.log.error('The E20 Plus on this Eureka account has no device id, so it cannot be set up.');
      return;
    }
    const deviceId = String(rawId);
    const robot = this.makeRobot({ cloud, deviceId, log: this.log });
    const name = this.config.name || dev.nickname || 'Eureka E20 Plus';
    const published = await this.publishMatter(robot, deviceId, name);
    const sw = this.config.switches;
    const wantSwitches = sw === 'on' || (sw !== 'off' && !published);
    if (wantSwitches) {
      this.buildAccessory(deviceId, name);
    } else {
      this.removeSwitches(deviceId);
      if (!published) this.log.warn('Both the vacuum tile and the switches are off, so nothing is shown in Apple Home.');
    }
    this.robot = robot;
    robot.on('state', () => this.safePush());
    this.loop();
  }

  // Returns true when the vacuum tile is published. Any failure falls back to the switches.
  async publishMatter(robot, deviceId, name) {
    if (!this.wantsMatter()) return false;
    if (!this.matterAvailable()) {
      if (!this.matterWarned) {
        this.matterWarned = true;
        this.log.warn('Matter is not enabled for this bridge, so the vacuum tile cannot be shown. Using the Clean and Pause switches instead.');
      }
      return false;
    }
    try {
      const vacuum = this.makeMatterVacuum({
        matter: this.api.matter, robot, log: this.log, pluginName: PLUGIN, platformName: PLATFORM,
        deviceId, name, maxAgeMs: () => this.maxAge(),
        cleanModes: this.config.cleanModes !== false, mopWater: this.mopWater(),
        run: (fn) => this.runCommand(fn),
      });
      await vacuum.publish();
      this.matterVacuum = vacuum;
      return true;
    } catch (err) {
      this.log.warn(`Could not publish the vacuum tile: ${err.message}. Using the Clean and Pause switches instead.`);
      return false;
    }
  }

  removeSwitches(deviceId) {
    const uuid = this.api.hap.uuid.generate(`eureka-e20:${deviceId}`);
    const acc = this.cached.find((a) => a.UUID === uuid);
    if (!acc) return;
    this.cached = this.cached.filter((a) => a !== acc);
    try {
      this.api.unregisterPlatformAccessories(PLUGIN, PLATFORM, [acc]);
    } catch (err) {
      this.log.warn(`Could not remove the old switches: ${err.message}`);
    }
  }

  buildAccessory(deviceId, name) {
    const { Service, Characteristic } = this.api.hap;
    const uuid = this.api.hap.uuid.generate(`eureka-e20:${deviceId}`);
    let acc = this.cached.find((a) => a.UUID === uuid);
    if (!acc) {
      acc = new this.api.platformAccessory(name, uuid);
      this.api.registerPlatformAccessories(PLUGIN, PLATFORM, [acc]);
      this.cached.push(acc);
    }
    this.accessory = acc;
    acc.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Eureka')
      .setCharacteristic(Characteristic.Model, 'E20 Plus')
      .setCharacteristic(Characteristic.SerialNumber, deviceId);

    const svc = (type, label, sub, short) => {
      const service = acc.getServiceById(type, sub) || acc.addService(type, label, sub);
      if (Characteristic.ConfiguredName) {
        if (typeof service.addOptionalCharacteristic === 'function') {
          service.addOptionalCharacteristic(Characteristic.ConfiguredName);
        }
        service.setCharacteristic(Characteristic.ConfiguredName, short);
      }
      return service;
    };
    this.clean = svc(Service.Switch, `${name} Clean`, 'clean', 'Clean');
    this.pause = svc(Service.Switch, `${name} Pause`, 'pause', 'Pause');
    this.battery = svc(Service.Battery, `${name} Battery`, 'battery', 'Battery');
    this.fault = svc(Service.ContactSensor, `${name} Fault`, 'fault', 'Fault');

    this.bind('clean', this.clean);
    this.bind('pause', this.pause);
    this.bind('battery', this.battery);
    this.bind('fault', this.fault);
  }

  // Handlers look the robot up when called, so they are safe before the robot exists.
  bind(sub, service) {
    const { Characteristic } = this.api.hap;
    const C = Characteristic;
    if (sub === 'clean') {
      service.getCharacteristic(C.On)
        .onGet(() => this.read((s) => s.status === 'cleaning' || s.status === 'moving'))
        .onSet((on) => this.act(on ? () => this.robot.start() : () => this.robot.dock()));
    } else if (sub === 'pause') {
      service.getCharacteristic(C.On)
        .onGet(() => this.read((s) => s.status === 'paused'))
        // Pause off only resumes a paused robot (the robot checks fresh status). It must never start a clean.
        .onSet((on) => this.act(on ? () => this.robot.pause() : () => this.robot.resume()));
    } else if (sub === 'battery') {
      service.getCharacteristic(C.BatteryLevel).onGet(() => this.read((s) => s.battery));
      service.getCharacteristic(C.ChargingState).onGet(() => this.read((s) => this.charging(s)));
      service.getCharacteristic(C.StatusLowBattery).onGet(() => this.read((s) => this.lowBattery(s)));
    } else if (sub === 'fault') {
      service.getCharacteristic(C.ContactSensorState).onGet(() => this.read((s) => this.faultState(s)));
    }
  }

  lowBattery(s) {
    const { StatusLowBattery } = this.api.hap.Characteristic;
    return s.battery < 20 ? StatusLowBattery.BATTERY_LEVEL_LOW : StatusLowBattery.BATTERY_LEVEL_NORMAL;
  }

  // The contact sensor reads open (not detected) when the robot reports a fault.
  faultState(s) {
    const { ContactSensorState } = this.api.hap.Characteristic;
    return s.fault ? ContactSensorState.CONTACT_NOT_DETECTED : ContactSensorState.CONTACT_DETECTED;
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
    if (!this.robot || !this.robot.isFresh(this.maxAge())) throw this.commFailure();
    return fn(this.robot.state);
  }

  // Start a command and wait for it for a short time only. A command that is still
  // running after that carries on in the background. Whenever it settles, the real
  // robot state is pushed so a failed command reverts the accessories. Throws a plain
  // Error when the command fails quickly. Shared by the switches and the vacuum tile.
  async runCommand(fn) {
    if (!this.robot) throw new Error('The robot is not ready yet');
    this.fastUntil = this.now() + FAST_POLL_MS;
    this.speedUpPoll();
    const settled = Promise.resolve().then(fn).then(() => null, (err) => err || new Error('unknown error'));
    settled.then((err) => {
      // The robot already logs a command it could not confirm.
      if (err && !(err instanceof CommandUnconfirmedError)) this.log.warn(`Command failed: ${err.message}`);
      this.fastUntil = this.now() + FAST_POLL_MS;
      // Homebridge may have written the requested mode to the tile meanwhile, so
      // send the real robot state to the tile whatever was sent last.
      this.safePush(true);
    });
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), this.commandWaitMs); });
    const outcome = await Promise.race([settled, timeout]);
    clearTimeout(timer);
    if (outcome) throw outcome instanceof Error ? outcome : new Error(String(outcome));
    // Either finished successfully, or still running in the background.
  }

  // HomeKit set handlers answer with the communication failure when a command fails.
  async act(fn) {
    if (!this.robot) throw this.commFailure();
    try {
      await this.runCommand(fn);
    } catch (err) {
      throw this.commFailure();
    }
  }

  // Bring a pending poll forward so it happens within the fast interval.
  speedUpPoll() {
    if (this.timer && this.timerDue - this.now() > FAST_POLL_INTERVAL_S * 1000) {
      this.schedule(FAST_POLL_INTERVAL_S * 1000);
    }
  }

  schedule(ms) {
    if (this.timer) this.clearTimer(this.timer);
    this.timerDue = this.now() + ms;
    this.timer = this.setTimer(() => { this.timer = null; this.loop(); }, ms);
    if (this.timer && this.timer.unref) this.timer.unref();
  }

  // Push to whichever of the two accessories exist. `force` only affects the vacuum tile.
  safePush(force) {
    if (this.accessory) {
      try { this.push(); } catch (err) { this.log.warn(`Could not update HomeKit: ${err.message}`); }
    }
    if (this.matterVacuum) {
      try { this.matterVacuum.push(force); } catch (err) { this.log.warn(`Could not update the vacuum tile: ${err.message}`); }
    }
  }

  push() {
    const { Characteristic } = this.api.hap;
    if (!this.robot.isFresh(this.maxAge())) {
      const gone = this.commFailure();
      this.clean.updateCharacteristic(Characteristic.On, gone);
      this.pause.updateCharacteristic(Characteristic.On, gone);
      this.battery.updateCharacteristic(Characteristic.BatteryLevel, gone);
      this.battery.updateCharacteristic(Characteristic.ChargingState, gone);
      this.battery.updateCharacteristic(Characteristic.StatusLowBattery, gone);
      this.fault.updateCharacteristic(Characteristic.ContactSensorState, gone);
      return;
    }
    const s = this.robot.state;
    this.clean.updateCharacteristic(Characteristic.On, s.status === 'cleaning' || s.status === 'moving');
    this.pause.updateCharacteristic(Characteristic.On, s.status === 'paused');
    this.battery.updateCharacteristic(Characteristic.BatteryLevel, s.battery);
    this.battery.updateCharacteristic(Characteristic.ChargingState, this.charging(s));
    this.battery.updateCharacteristic(Characteristic.StatusLowBattery, this.lowBattery(s));
    this.fault.updateCharacteristic(Characteristic.ContactSensorState, this.faultState(s));
  }

  // Poll every pollSeconds, or every 10 seconds for two minutes after a command.
  async loop() {
    if (this.stopped) return;
    try {
      const s = await this.robot.poll();
      this.log.debug(`Status ${s.status}, battery ${s.battery}`);
      this.offlineLogged = false;
    } catch (err) {
      if (err instanceof AuthError && err.permanent) {
        if (!this.authLogged) {
          this.authLogged = true;
          this.log.error(err.message);
        }
      } else if (this.offlineLogged) {
        this.log.debug(`Status check failed: ${err.message}`);
      } else {
        this.offlineLogged = true;
        this.log.warn(`Status check failed: ${err.message}`);
      }
    }
    if (this.stopped) return;
    this.schedule(this.now() < this.fastUntil ? FAST_POLL_INTERVAL_S * 1000 : (this.config.pollSeconds || 30) * 1000);
  }

  stop() {
    this.stopped = true;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    if (this.retryTimer) this.clearTimer(this.retryTimer);
    this.retryTimer = null;
  }
}

module.exports = { EurekaPlatform };
