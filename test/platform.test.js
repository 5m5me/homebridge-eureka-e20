'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { EurekaPlatform } = require('../lib/platform');

// ---- Hand-written fake of the parts of the Homebridge API the platform uses ----
class HapStatusError extends Error {
  constructor(status) { super(`HAP ${status}`); this.hapStatus = status; }
}
const HAPStatus = { SERVICE_COMMUNICATION_FAILURE: -70402 };
const names = ['Manufacturer', 'Model', 'SerialNumber', 'On', 'BatteryLevel', 'ChargingState',
  'StatusLowBattery', 'ContactSensorState'];
const Characteristic = { ChargingState: { NOT_CHARGING: 0, CHARGING: 1 } };
for (const n of names) if (!Characteristic[n]) Characteristic[n] = { name: n };
else Characteristic[n].name = n;
const Service = {};
for (const n of ['AccessoryInformation', 'Switch', 'Battery', 'ContactSensor']) Service[n] = { name: n };

class FakeService {
  constructor(type, label, sub) {
    this.type = type; this.label = label; this.sub = sub;
    this.chars = new Map(); this.updates = [];
  }
  getCharacteristic(c) {
    if (!this.chars.has(c)) {
      const ch = { onGet(fn) { this.get = fn; return this; }, onSet(fn) { this.set = fn; return this; }, value: undefined };
      this.chars.set(c, ch);
    }
    return this.chars.get(c);
  }
  setCharacteristic(c, v) { this.getCharacteristic(c).value = v; return this; }
  updateCharacteristic(c, v) { this.updates.push([c, v]); return this; }
}
class FakeAccessory {
  constructor(name, uuid) {
    this.displayName = name; this.UUID = uuid;
    this.services = [new FakeService(Service.AccessoryInformation)];
  }
  getService(type) { return this.services.find((s) => s.type === type && s.sub === undefined); }
  getServiceById(type, sub) { return this.services.find((s) => s.type === type && s.sub === sub); }
  addService(type, label, sub) { const s = new FakeService(type, label, sub); this.services.push(s); return s; }
}
function makeApi() {
  const api = new EventEmitter();
  api.hap = { Service, Characteristic, HapStatusError, HAPStatus, uuid: { generate: (s) => `uuid:${s}` } };
  api.platformAccessory = FakeAccessory;
  api.registered = [];
  api.registerPlatformAccessories = (plugin, platform, list) => api.registered.push([plugin, platform, list]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eureka-test-'));
  api.user = { storagePath: () => dir };
  return api;
}
function makeLog() {
  const log = { warns: [], errors: [], debugs: [] };
  log.warn = (m) => log.warns.push(m);
  log.error = (m) => log.errors.push(m);
  log.debug = (m) => log.debugs.push(m);
  log.info = () => {};
  return log;
}
function makeRobot() {
  const r = new EventEmitter();
  r.state = { status: 'docked', battery: 80, fault: false, at: Date.now() };
  r.fresh = true;
  r.isFresh = () => r.fresh;
  r.calls = [];
  r.polls = 0;
  r.poll = async () => { r.polls++; return r.state; };
  for (const m of ['start', 'pause', 'dock']) r[m] = async () => { r.calls.push(m); };
  return r;
}
const DEVICE = { deviceId: 'dev1', nickname: 'Vac', product: { sn8: '750Y000G' } };

// Builds a platform, runs setup, returns handles. Always call h.stop().
async function boot({ config, devices = [DEVICE], robot = makeRobot(), cached = [], waitMs = 50 } = {}) {
  const api = makeApi();
  const log = makeLog();
  const cloud = { getDevices: async () => devices };
  const deps = { makeCloud: () => cloud, makeRobot: () => robot, commandWaitMs: waitMs };
  const p = new EurekaPlatform(log, config || { email: 'a@b.c', password: 'pw' }, api, deps);
  for (const a of cached) p.configureAccessory(a);
  api.emit('didFinishLaunching');
  await p.ready;
  const acc = p.accessory;
  const svc = (sub) => acc && acc.getServiceById(sub === 'battery' ? Service.Battery : sub === 'fault' ? Service.ContactSensor : Service.Switch, sub);
  return { api, log, robot, p, acc, svc, stop: () => api.emit('shutdown') };
}
const get = (s, c) => s.getCharacteristic(c).get();
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test('missing email or password warns and creates no accessory', async () => {
  for (const config of [{ password: 'x' }, { email: 'x' }, {}]) {
    const h = await boot({ config });
    assert.equal(h.api.registered.length, 0);
    assert.equal(h.log.warns.length, 1);
    h.stop();
  }
});

test('no device with model code 750Y000G logs an error and creates no accessory', async () => {
  const h = await boot({ devices: [{ deviceId: 'z', product: { sn8: 'OTHER' } }, { deviceId: 'y' }] });
  assert.equal(h.api.registered.length, 0);
  assert.equal(h.log.errors.length, 1);
  assert.match(h.log.errors[0], /750Y000G/);
  h.stop();
});

test('a matching device creates one accessory with four services', async () => {
  const h = await boot();
  assert.equal(h.api.registered.length, 1);
  assert.deepEqual(h.api.registered[0].slice(0, 2), ['homebridge-eureka-e20', 'EurekaE20']);
  assert.equal(h.api.registered[0][2].length, 1);
  const subs = h.acc.services.filter((s) => s.sub).map((s) => `${s.type.name}:${s.sub}`).sort();
  assert.deepEqual(subs, ['Battery:battery', 'ContactSensor:fault', 'Switch:clean', 'Switch:pause']);
  h.stop();
});

test('a cached accessory with the same UUID is reused and not registered again', async () => {
  const cachedAcc = new FakeAccessory('Vac', 'uuid:eureka-e20:dev1');
  const h = await boot({ cached: [cachedAcc] });
  assert.equal(h.api.registered.length, 0);
  assert.equal(h.acc, cachedAcc);
  assert.ok(h.svc('clean'));
  h.stop();
});

test('reads throw the HAP communication failure when the state is stale', async () => {
  const h = await boot();
  h.robot.fresh = false;
  const { On, BatteryLevel, ChargingState, StatusLowBattery, ContactSensorState } = Characteristic;
  for (const [s, c] of [[h.svc('clean'), On], [h.svc('pause'), On], [h.svc('battery'), BatteryLevel],
    [h.svc('battery'), ChargingState], [h.svc('battery'), StatusLowBattery], [h.svc('fault'), ContactSensorState]]) {
    assert.throws(() => get(s, c), (e) => e instanceof HapStatusError && e.hapStatus === HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }
  h.stop();
});

test('reads return values when fresh', async () => {
  const h = await boot();
  const { On, BatteryLevel, ChargingState, StatusLowBattery, ContactSensorState } = Characteristic;
  const set = (o) => { h.robot.state = { status: 'docked', battery: 80, fault: false, at: 1, ...o }; };

  for (const [status, clean, pause] of [['cleaning', true, false], ['moving', true, false], ['paused', false, true],
    ['docked', false, false], ['returning', false, false]]) {
    set({ status });
    assert.equal(get(h.svc('clean'), On), clean, `clean ${status}`);
    assert.equal(get(h.svc('pause'), On), pause, `pause ${status}`);
  }
  set({ battery: 55 });
  assert.equal(get(h.svc('battery'), BatteryLevel), 55);
  assert.equal(get(h.svc('battery'), StatusLowBattery), 0);
  set({ battery: 19 });
  assert.equal(get(h.svc('battery'), StatusLowBattery), 1);
  set({ battery: 20 });
  assert.equal(get(h.svc('battery'), StatusLowBattery), 0);

  set({ status: 'docked', battery: 99 });
  assert.equal(get(h.svc('battery'), ChargingState), 1);
  set({ status: 'docked', battery: 100 });
  assert.equal(get(h.svc('battery'), ChargingState), 0);
  set({ status: 'cleaning', battery: 50 });
  assert.equal(get(h.svc('battery'), ChargingState), 0);

  set({ fault: false });
  assert.equal(get(h.svc('fault'), ContactSensorState), 0);
  set({ fault: true });
  assert.equal(get(h.svc('fault'), ContactSensorState), 1);
  h.stop();
});

test('switch handlers call the matching robot command', async () => {
  const h = await boot();
  const { On } = Characteristic;
  await h.svc('clean').getCharacteristic(On).set(true);
  await h.svc('clean').getCharacteristic(On).set(false);
  await h.svc('pause').getCharacteristic(On).set(true);
  await h.svc('pause').getCharacteristic(On).set(false);
  assert.deepEqual(h.robot.calls, ['start', 'dock', 'pause', 'start']);
  h.stop();
});

test('a command that fails quickly makes the set handler throw and pushes state', async () => {
  const h = await boot();
  h.robot.start = async () => { throw new Error('not confirmed'); };
  const clean = h.svc('clean');
  const before = clean.updates.length;
  await assert.rejects(clean.getCharacteristic(Characteristic.On).set(true),
    (e) => e instanceof HapStatusError && e.hapStatus === HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  assert.ok(h.log.warns.some((m) => m.includes('not confirmed')));
  assert.ok(clean.updates.length > before, 'state was pushed so the switch reverts');
  h.stop();
});

test('a slow command returns after the wait; a later failure warns and pushes without rejection', async () => {
  const rejections = [];
  const onRej = (e) => rejections.push(e);
  process.on('unhandledRejection', onRej);
  try {
    const h = await boot({ waitMs: 20 });
    let fail;
    h.robot.start = () => new Promise((_, rej) => { fail = rej; });
    const clean = h.svc('clean');
    const before = clean.updates.length;
    await clean.getCharacteristic(Characteristic.On).set(true); // returns normally after 20 ms
    assert.equal(h.log.warns.length, 0);
    assert.equal(clean.updates.length, before);
    fail(new Error('late failure'));
    await tick(30);
    assert.ok(h.log.warns.some((m) => m.includes('late failure')));
    assert.ok(clean.updates.length > before);
    await tick(10);
    assert.deepEqual(rejections, []);
    h.stop();
  } finally {
    process.off('unhandledRejection', onRej);
  }
});

test('a slow command that later succeeds pushes state without a warning', async () => {
  const h = await boot({ waitMs: 10 });
  let done;
  h.robot.start = () => new Promise((res) => { done = res; });
  const clean = h.svc('clean');
  const before = clean.updates.length;
  await clean.getCharacteristic(Characteristic.On).set(true);
  done();
  await tick(20);
  assert.equal(h.log.warns.length, 0);
  assert.ok(clean.updates.length > before);
  h.stop();
});

test('push shows No Response on the switches when the state is stale', async () => {
  const h = await boot();
  h.robot.fresh = false;
  h.robot.emit('state', h.robot.state);
  const last = h.svc('clean').updates.at(-1);
  assert.ok(last[1] instanceof HapStatusError);
  h.stop();
});

test('the polling loop runs and stops on shutdown', async () => {
  const h = await boot();
  assert.equal(h.robot.polls, 1);
  assert.ok(h.p.timer, 'timer handle kept');
  h.stop();
  assert.equal(h.p.timer, null);
  await tick(5);
  assert.equal(h.robot.polls, 1);
});
