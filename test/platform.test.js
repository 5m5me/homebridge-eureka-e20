'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { EurekaPlatform } = require('../lib/platform');
const { AuthError } = require('../lib/cloud');
const { CommandUnconfirmedError } = require('../lib/robot');

// ---- Hand-written fake of the parts of the Homebridge API the platform uses ----
class HapStatusError extends Error {
  constructor(status) { super(`HAP ${status}`); this.hapStatus = status; }
}
const HAPStatus = { SERVICE_COMMUNICATION_FAILURE: -70402 };
const names = ['Manufacturer', 'Model', 'SerialNumber', 'On', 'BatteryLevel', 'ChargingState',
  'StatusLowBattery', 'ContactSensorState', 'ConfiguredName'];
const Characteristic = {
  ChargingState: { NOT_CHARGING: 0, CHARGING: 1 },
  StatusLowBattery: { BATTERY_LEVEL_NORMAL: 0, BATTERY_LEVEL_LOW: 1 },
  ContactSensorState: { CONTACT_DETECTED: 0, CONTACT_NOT_DETECTED: 1 },
};
for (const n of names) if (!Characteristic[n]) Characteristic[n] = { name: n };
else Characteristic[n].name = n;
const Service = {};
for (const n of ['AccessoryInformation', 'Switch', 'Battery', 'ContactSensor']) Service[n] = { name: n };

class FakeService {
  constructor(type, label, sub) {
    this.type = type; this.label = label; this.sub = sub;
    this.chars = new Map(); this.updates = []; this.optional = [];
  }
  addOptionalCharacteristic(c) { this.optional.push(c); }
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
  api.unregistered = [];
  api.unregisterPlatformAccessories = (plugin, platform, list) => api.unregistered.push([plugin, platform, list]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eureka-test-'));
  api.user = { storagePath: () => dir };
  return api;
}
// Fake of api.matter that records every call. Set `failRegister` to make publishing throw.
function makeMatter(over = {}) {
  const m = {
    deviceTypes: { RoboticVacuumCleaner: { name: 'RoboticVacuumCleaner' } },
    uuid: { generate: (s) => `matter:${s}` },
    registered: [], updated: [], unregistered: [], states: [], failRegister: false,
  };
  m.registerPlatformAccessories = async (plugin, platform, list) => {
    if (m.failRegister) throw new Error('matter register boom');
    m.registered.push([plugin, platform, list]);
  };
  m.updatePlatformAccessories = async (list) => { m.updated.push(list); };
  m.unregisterPlatformAccessories = async (plugin, platform, list) => { m.unregistered.push([plugin, platform, list]); };
  m.updateAccessoryState = async (uuid, cluster, attrs) => { m.states.push([uuid, cluster, attrs]); };
  return Object.assign(m, over);
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
  for (const m of ['start', 'pause', 'dock', 'resume']) r[m] = async () => { r.calls.push(m); };
  return r;
}
const DEVICE = { deviceId: 'dev1', nickname: 'Vac', product: { sn8: '750Y000G' } };

// Builds a platform, runs setup, returns handles. Always call h.stop().
// Stage one tests run with the vacuum tile off. Matter tests pass a config and `matter`.
async function boot({ config, devices = [DEVICE], robot = makeRobot(), cached = [], cachedMatter = [], matter, waitMs = 50, cloud, extra = {} } = {}) {
  const api = makeApi();
  if (matter) api.matter = matter;
  const log = makeLog();
  cloud = cloud || { getDevices: async () => devices };
  const deps = { makeCloud: () => cloud, makeRobot: () => robot, commandWaitMs: waitMs, retryMs: 5, ...extra };
  const p = new EurekaPlatform(log, config || { email: 'a@b.c', password: 'pw', matterVacuum: false }, api, deps);
  for (const a of cached) p.configureAccessory(a);
  for (const a of cachedMatter) p.configureMatterAccessory(a);
  api.emit('didFinishLaunching');
  await p.ready;
  const acc = p.accessory;
  const svc = (sub) => acc && acc.getServiceById(sub === 'battery' ? Service.Battery : sub === 'fault' ? Service.ContactSensor : Service.Switch, sub);
  return { api, log, robot, p, acc, svc, matter, stop: () => api.emit('shutdown') };
}
const MATTER_CFG = (extra = {}) => ({ email: 'a@b.c', password: 'pw', ...extra });
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
  h.robot.state = { status: 'paused', battery: 80, fault: false, at: 1 };
  await h.svc('pause').getCharacteristic(On).set(false);
  assert.deepEqual(h.robot.calls, ['start', 'dock', 'pause', 'resume']);
  h.stop();
});

test('a command that fails quickly makes the set handler throw and pushes state', async () => {
  const h = await boot();
  h.robot.start = async () => { throw new Error('not confirmed'); };
  const clean = h.svc('clean');
  const before = clean.updates.length;
  await assert.rejects(clean.getCharacteristic(Characteristic.On).set(true),
    (e) => e instanceof HapStatusError && e.hapStatus === HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  assert.equal(h.log.warns.filter((m) => m.includes('not confirmed')).length, 1);
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
    assert.equal(h.log.warns.filter((m) => m.includes('late failure')).length, 1);
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

test('an unconfirmed command is not logged again by the platform', async () => {
  const h = await boot();
  h.robot.dock = async () => { throw new CommandUnconfirmedError('the robot did not confirm'); };
  await assert.rejects(h.svc('clean').getCharacteristic(Characteristic.On).set(false), HapStatusError);
  assert.equal(h.log.warns.length, 0);
  h.stop();
});

test('Pause off only ever calls resume, never start', async () => {
  const h = await boot();
  const set = h.svc('pause').getCharacteristic(Characteristic.On).set;
  for (const status of ['docked', 'cleaning', 'paused']) {
    h.robot.state = { status, battery: 80, fault: false, at: 1 };
    await set(false);
  }
  h.robot.fresh = false;
  await set(false);
  assert.deepEqual(h.robot.calls, ['resume', 'resume', 'resume', 'resume']);
  h.stop();
});

test('setup retries after a cloud failure and stops retrying once it works', async () => {
  let n = 0;
  const cloud = { getDevices: async () => { if (++n < 3) throw new Error('network down'); return [DEVICE]; } };
  const h = await boot({ cloud });
  assert.equal(h.api.registered.length, 0);
  await tick(60);
  assert.equal(n, 3);
  assert.equal(h.api.registered.length, 1);
  assert.equal(h.log.warns.filter((m) => m.includes('Setup failed')).length, 2);
  assert.equal(h.p.retryTimer, null);
  h.stop();
});

test('a pending setup retry is cleared on shutdown', async () => {
  let n = 0;
  const cloud = { getDevices: async () => { n++; throw new Error('down'); } };
  const h = await boot({ cloud, extra: { retryMs: 20 } });
  h.stop();
  await tick(50);
  assert.equal(n, 1);
});

test('an AuthError at setup logs an error and does not retry', async () => {
  let n = 0;
  const cloud = { getDevices: async () => { n++; throw new AuthError('Wrong email or password'); } };
  const h = await boot({ cloud });
  await tick(30);
  assert.equal(n, 1);
  assert.equal(h.log.errors.length, 1);
  assert.match(h.log.errors[0], /email and password/);
  assert.equal(h.p.retryTimer, null);
  h.stop();
});

test('a cached accessory reads and sets as communication failure before setup completes', async () => {
  const acc = new FakeAccessory('Vac', 'uuid:eureka-e20:dev1');
  acc.addService(Service.Switch, 'c', 'clean');
  acc.addService(Service.Switch, 'p', 'pause');
  acc.addService(Service.Battery, 'b', 'battery');
  acc.addService(Service.ContactSensor, 'f', 'fault');
  const cloud = { getDevices: async () => { throw new Error('down'); } };
  const h = await boot({ cloud, cached: [acc], extra: { retryMs: 100000 } });
  const isFail = (e) => e instanceof HapStatusError && e.hapStatus === HAPStatus.SERVICE_COMMUNICATION_FAILURE;
  const { On, BatteryLevel, ChargingState, StatusLowBattery, ContactSensorState } = Characteristic;
  const sv = (t, sub) => acc.getServiceById(t, sub);
  for (const [t, sub, c] of [[Service.Switch, 'clean', On], [Service.Switch, 'pause', On],
    [Service.Battery, 'battery', BatteryLevel], [Service.Battery, 'battery', ChargingState],
    [Service.Battery, 'battery', StatusLowBattery], [Service.ContactSensor, 'fault', ContactSensorState]]) {
    assert.throws(() => sv(t, sub).getCharacteristic(c).get(), isFail);
  }
  for (const sub of ['clean', 'pause']) {
    await assert.rejects(sv(Service.Switch, sub).getCharacteristic(On).set(true), isFail);
    await assert.rejects(sv(Service.Switch, sub).getCharacteristic(On).set(false), isFail);
  }
  h.stop();
});

test('stale push also reports No Response on battery and fault', async () => {
  const h = await boot();
  h.robot.fresh = false;
  h.robot.emit('state', h.robot.state);
  for (const sub of ['battery', 'fault']) {
    const last = h.svc(sub).updates.at(-1);
    assert.ok(last[1] instanceof HapStatusError, sub);
  }
  h.stop();
});

test('the configured name wins; the nickname is the fallback', async () => {
  let h = await boot({ config: { email: 'a', password: 'b', name: 'Mine' } });
  assert.equal(h.acc.displayName, 'Mine');
  h.stop();
  h = await boot({ config: { email: 'a', password: 'b' } });
  assert.equal(h.acc.displayName, 'Vac');
  h.stop();
});

test('after a command the next poll is within 10 seconds and stays fast for two minutes', async () => {
  const timers = [];
  let clock = 1000000;
  const extra = {
    now: () => clock,
    setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false, unref() {} }; timers.push(t); return t; },
    clearTimeout: (t) => { t.cleared = true; },
  };
  const h = await boot({ extra });
  const live = () => timers.filter((t) => !t.cleared);
  assert.equal(live().length, 1);
  assert.equal(live()[0].ms, 30000);

  await h.svc('clean').getCharacteristic(Characteristic.On).set(true);
  assert.equal(live().length, 1);
  assert.equal(live()[0].ms, 10000);

  // Fire the poll; while inside two minutes it stays at 10 s.
  clock += 10000;
  let t = live()[0]; t.cleared = true; t.fn(); await tick(2);
  assert.equal(live().at(-1).ms, 10000);
  // Past two minutes it returns to the normal interval.
  clock += 130000;
  t = live().at(-1); t.cleared = true; t.fn(); await tick(2);
  assert.equal(live().at(-1).ms, 30000);
  h.stop();
});

test('no log call contains the password or a token', async () => {
  const secretPw = 'S3cretPassw0rd';
  const secretTok = 'TOKEN-ABC-123';
  let n = 0;
  let opts;
  const cloud = { getDevices: async () => { if (++n === 1) throw new Error('network down'); return [DEVICE]; } };
  const api = makeApi();
  const log = makeLog();
  const robot = makeRobot();
  const p = new EurekaPlatform(log, { email: 'a@b.c', password: secretPw }, api,
    { makeCloud: (o) => { opts = o; return cloud; }, makeRobot: () => robot, commandWaitMs: 20, retryMs: 5 });
  api.emit('didFinishLaunching');
  await p.ready;
  await tick(30);
  opts.onTokens({ accessToken: secretTok, refreshToken: secretTok, region: 'eu' });
  robot.start = async () => { throw new Error('boom'); };
  const clean = p.clean;
  await assert.rejects(clean.getCharacteristic(Characteristic.On).set(true));
  await tick(5);
  const file = path.join(api.user.storagePath(), 'eureka-e20-tokens.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const all = [...log.warns, ...log.errors, ...log.debugs].join('\n');
  assert.ok(!all.includes(secretPw));
  assert.ok(!all.includes(secretTok));
  api.emit('shutdown');
});

test('services get short ConfiguredName labels', async () => {
  const h = await boot();
  for (const [sub, label] of [['clean', 'Clean'], ['pause', 'Pause'], ['battery', 'Battery'], ['fault', 'Fault']]) {
    const sv = h.svc(sub);
    assert.ok(sv.optional.includes(Characteristic.ConfiguredName), `${sub} optional`);
    assert.equal(sv.getCharacteristic(Characteristic.ConfiguredName).value, label);
  }
  h.stop();
});

test('a missing ConfiguredName characteristic does not throw', async () => {
  const saved = Characteristic.ConfiguredName;
  delete Characteristic.ConfiguredName;
  try {
    const h = await boot();
    assert.equal(h.api.registered.length, 1);
    h.stop();
  } finally {
    Characteristic.ConfiguredName = saved;
  }
});

test('a throw while binding cached accessories is logged and does not reject', async () => {
  const acc = new FakeAccessory('Vac', 'uuid:eureka-e20:dev1');
  const sv = acc.addService(Service.Switch, 'c', 'clean');
  sv.getCharacteristic = () => { throw new Error('bind boom'); };
  const h = await boot({ cached: [acc] });
  assert.ok(h.log.errors.some((m) => m.includes('bind boom')));
  h.stop();
});

test('a newly registered accessory is added to the cached list so a retry does not register it twice', async () => {
  const h = await boot();
  assert.equal(h.p.cached.length, 1);
  await h.p.setup();
  assert.equal(h.api.registered.length, 1);
  h.stop();
});

test('a device with neither deviceId nor id logs an error and stops setup', async () => {
  const h = await boot({ devices: [{ nickname: 'x', product: { sn8: '750Y000G' } }] });
  assert.equal(h.api.registered.length, 0);
  assert.equal(h.log.errors.length, 1);
  assert.equal(h.p.robot, null);
  h.stop();
});

test('a device with only id uses it', async () => {
  const h = await boot({ devices: [{ id: 77, product: { sn8: '750Y000G' } }] });
  assert.equal(h.api.registered.length, 1);
  assert.ok(h.acc.UUID.endsWith('77'));
  h.stop();
});

async function bootWithTokenFile(content, config) {
  const api = makeApi();
  if (content !== undefined) {
    fs.writeFileSync(path.join(api.user.storagePath(), 'eureka-e20-tokens.json'), JSON.stringify(content));
  }
  let opts;
  const log = makeLog();
  const p = new EurekaPlatform(log, config || { email: 'a@b.c', password: 'pw' }, api,
    { makeCloud: (o) => { opts = o; return { getDevices: async () => [DEVICE] }; }, makeRobot: () => makeRobot(), retryMs: 5 });
  api.emit('didFinishLaunching');
  await p.ready;
  return { api, opts, stop: () => api.emit('shutdown') };
}
const TOK = { accessToken: 'A', refreshToken: 'R', region: 'eu' };

test('stored tokens for the same email are used', async () => {
  const h = await bootWithTokenFile({ email: 'a@b.c', tokens: TOK });
  assert.deepEqual(h.opts.tokens, TOK);
  h.stop();
});

test('stored tokens for a different email, or with no email, are ignored', async () => {
  for (const content of [{ email: 'other@b.c', tokens: TOK }, TOK]) {
    const h = await bootWithTokenFile(content);
    assert.equal(h.opts.tokens, null);
    h.stop();
  }
});

test('saved tokens are stored with the email', async () => {
  const h = await bootWithTokenFile(undefined);
  h.opts.onTokens(TOK);
  const saved = JSON.parse(fs.readFileSync(path.join(h.api.user.storagePath(), 'eureka-e20-tokens.json'), 'utf8'));
  assert.deepEqual(saved, { email: 'a@b.c', tokens: TOK });
  h.stop();
});

test('Status check failed warns once, then debug until a check succeeds again', async () => {
  const h = await boot();
  let fail = true;
  h.robot.poll = async () => { if (fail) throw new Error('offline'); return h.robot.state; };
  const warns = () => h.log.warns.filter((m) => m.includes('Status check failed')).length;
  const debugs = () => h.log.debugs.filter((m) => m.includes('Status check failed')).length;
  await h.p.loop(); await h.p.loop(); await h.p.loop();
  assert.equal(warns(), 1);
  assert.equal(debugs(), 2);
  fail = false;
  await h.p.loop();
  fail = true;
  await h.p.loop();
  assert.equal(warns(), 2);
  h.stop();
});

test('a permanently disabled login is logged as one error and not on every poll', async () => {
  const h = await boot();
  const err = new AuthError('Correct the email and password in the plugin settings and restart.');
  err.permanent = true;
  h.robot.poll = async () => { throw err; };
  await h.p.loop(); await h.p.loop(); await h.p.loop();
  assert.equal(h.log.errors.length, 1);
  assert.match(h.log.errors[0], /email and password/);
  assert.equal(h.log.warns.filter((m) => m.includes('Status check failed')).length, 0);
  h.stop();
});

// ---- Matter vacuum tile ----
test('default config with Matter available publishes the vacuum and no HomeKit accessory', async () => {
  const matter = makeMatter();
  const h = await boot({ config: MATTER_CFG(), matter });
  assert.equal(matter.registered.length, 1);
  assert.deepEqual(matter.registered[0].slice(0, 2), ['homebridge-eureka-e20', 'EurekaE20']);
  const acc = matter.registered[0][2][0];
  assert.equal(acc.UUID, 'matter:eureka-e20-matter:dev1');
  assert.equal(acc.displayName, 'Vac');
  assert.equal(h.api.registered.length, 0);
  assert.ok(!h.acc);
  assert.equal(h.log.warns.length, 0);
  h.stop();
});

test('a cached HomeKit accessory is unregistered when only the vacuum is shown', async () => {
  const cachedAcc = new FakeAccessory('Vac', 'uuid:eureka-e20:dev1');
  const h = await boot({ config: MATTER_CFG(), matter: makeMatter(), cached: [cachedAcc] });
  assert.equal(h.api.unregistered.length, 1);
  assert.deepEqual(h.api.unregistered[0], ['homebridge-eureka-e20', 'EurekaE20', [cachedAcc]]);
  assert.equal(h.api.registered.length, 0);
  assert.ok(!h.p.cached.includes(cachedAcc));
  h.stop();
});

test('switches on publishes both the vacuum and the switches', async () => {
  const matter = makeMatter();
  const h = await boot({ config: MATTER_CFG({ switches: 'on' }), matter });
  assert.equal(matter.registered.length, 1);
  assert.equal(h.api.registered.length, 1);
  assert.ok(h.svc('clean') && h.svc('pause'));
  assert.equal(h.api.unregistered.length, 0);
  h.stop();
});

test('matterVacuum false creates only the switches and unregisters a cached Matter accessory', async () => {
  const matter = makeMatter();
  const old = { UUID: 'matter:old', context: { deviceId: 'dev1' } };
  const h = await boot({ config: MATTER_CFG({ matterVacuum: false }), matter, cachedMatter: [old] });
  assert.equal(matter.registered.length, 0);
  assert.equal(matter.updated.length, 0);
  assert.deepEqual(matter.unregistered, [['homebridge-eureka-e20', 'EurekaE20', [old]]]);
  assert.equal(h.api.registered.length, 1);
  assert.equal(h.log.warns.length, 0);
  h.stop();
});

test('an unregister failure for the cached Matter accessory is logged and does not reject', async () => {
  const matter = makeMatter();
  matter.unregisterPlatformAccessories = async () => { throw new Error('unreg boom'); };
  const h = await boot({ config: MATTER_CFG({ matterVacuum: false }), matter, cachedMatter: [{ UUID: 'x', context: {} }] });
  assert.ok(h.log.warns.some((m) => m.includes('unreg boom')));
  assert.equal(h.api.registered.length, 1);
  h.stop();
});

test('Matter unavailable logs one warning and falls back to the switches', async () => {
  const noMatter = await boot({ config: MATTER_CFG() });
  assert.equal(noMatter.log.warns.length, 1);
  assert.match(noMatter.log.warns[0], /Matter is not enabled for this bridge/);
  assert.equal(noMatter.api.registered.length, 1);
  noMatter.stop();
  const noType = await boot({ config: MATTER_CFG(), matter: makeMatter({ deviceTypes: {} }) });
  assert.equal(noType.log.warns.length, 1);
  assert.match(noType.log.warns[0], /Matter is not enabled for this bridge/);
  assert.equal(noType.api.registered.length, 1);
  noType.stop();
  const noMethod = makeMatter();
  delete noMethod.updateAccessoryState;
  const nm = await boot({ config: MATTER_CFG(), matter: noMethod });
  assert.equal(nm.log.warns.length, 1);
  assert.equal(nm.api.registered.length, 1);
  nm.stop();
});

test('the Matter unavailable warning is not repeated when setup is retried', async () => {
  let n = 0;
  const cloud = { getDevices: async () => { if (++n < 3) throw new Error('down'); return [DEVICE]; } };
  const h = await boot({ config: MATTER_CFG(), cloud });
  await tick(60);
  assert.equal(h.log.warns.filter((m) => m.includes('Matter is not enabled')).length, 1);
  h.stop();
});

test('matterVacuum false with no Matter at all logs no Matter warning', async () => {
  const h = await boot({ config: MATTER_CFG({ matterVacuum: false }) });
  assert.equal(h.log.warns.length, 0);
  h.stop();
});

test('a publish that throws logs one warning and falls back to the switches', async () => {
  const matter = makeMatter();
  matter.failRegister = true;
  const h = await boot({ config: MATTER_CFG(), matter });
  assert.equal(h.log.warns.filter((m) => m.includes('matter register boom')).length, 1);
  assert.equal(h.log.warns.length, 1);
  assert.equal(h.api.registered.length, 1);
  assert.ok(h.svc('clean'));
  // The failed tile does not receive pushes or leave a stale reference.
  h.robot.emit('state', h.robot.state);
  assert.equal(matter.states.length, 0);
  h.stop();
});

test('switches off with a working tile creates no HomeKit accessory', async () => {
  const cachedAcc = new FakeAccessory('Vac', 'uuid:eureka-e20:dev1');
  const h = await boot({ config: MATTER_CFG({ switches: 'off' }), matter: makeMatter(), cached: [cachedAcc] });
  assert.equal(h.api.registered.length, 0);
  assert.equal(h.api.unregistered.length, 1);
  h.stop();
});

test('switches off without a tile unregisters the cached switches and warns that nothing is shown', async () => {
  const cachedAcc = new FakeAccessory('Vac', 'uuid:eureka-e20:dev1');
  const h = await boot({ config: MATTER_CFG({ switches: 'off', matterVacuum: false }), cached: [cachedAcc] });
  assert.equal(h.api.registered.length, 0);
  assert.deepEqual(h.api.unregistered, [['homebridge-eureka-e20', 'EurekaE20', [cachedAcc]]]);
  assert.equal(h.log.warns.length, 1);
  h.robot.emit('state', h.robot.state); // must not throw without an accessory
  h.stop();
});

test('a cached Matter accessory with the same deviceId is passed as cached', async () => {
  const matter = makeMatter();
  const cachedMatter = { UUID: 'matter:cached', context: { deviceId: 'dev1', cleanMode: 2 } };
  const other = { UUID: 'matter:other', context: { deviceId: 'other' } };
  let opts;
  const extra = { makeMatterVacuum: (o) => { opts = o; return new (require('../lib/matter-vacuum').MatterVacuum)(o); } };
  const h = await boot({ config: MATTER_CFG(), matter, cachedMatter: [other, cachedMatter], extra });
  assert.equal(opts.cached, cachedMatter);
  assert.equal(matter.registered.length, 0);
  assert.equal(matter.updated.length, 1);
  assert.equal(matter.updated[0][0].UUID, 'matter:cached');
  assert.equal(typeof matter.updated[0][0].handlers.rvcRunMode.changeToMode, 'function');
  // A cached accessory for a different device is left alone.
  assert.equal(matter.unregistered.length, 0);
  h.stop();
});

test('a robot state event pushes to both accessories when both exist', async () => {
  const matter = makeMatter();
  const h = await boot({ config: MATTER_CFG({ switches: 'on' }), matter });
  const clean = h.svc('clean');
  const swBefore = clean.updates.length;
  const stBefore = matter.states.length;
  h.robot.state = { status: 'cleaning', battery: 50, fault: false, at: 1, water: 0 };
  h.robot.emit('state', h.robot.state);
  assert.ok(clean.updates.length > swBefore);
  assert.ok(matter.states.length > stBefore);
  assert.ok(matter.states.some(([, c, a]) => c === 'rvcRunMode' && a.currentMode === 1));
  h.stop();
});

test('a robot state event pushes to the vacuum alone when there are no switches', async () => {
  const matter = makeMatter();
  const h = await boot({ config: MATTER_CFG(), matter });
  const before = matter.states.length;
  h.robot.state = { status: 'paused', battery: 50, fault: false, at: 1, water: 0 };
  h.robot.emit('state', h.robot.state);
  assert.ok(matter.states.length > before);
  h.robot.fresh = false;
  h.robot.emit('state', h.robot.state);
  assert.ok(matter.states.some(([, c, a]) => c === 'rvcOperationalState' && a.operationalState === 3));
  h.stop();
});

test('a Matter handler failure rejects the handler, warns and causes no unhandled rejection', async () => {
  const rejections = [];
  const onRej = (e) => rejections.push(e);
  process.on('unhandledRejection', onRej);
  try {
    const matter = makeMatter();
    const h = await boot({ config: MATTER_CFG(), matter });
    h.robot.start = async () => { throw new Error('matter start failed'); };
    const handlers = matter.registered[0][2][0].handlers;
    await assert.rejects(handlers.rvcRunMode.changeToMode({ newMode: 1 }),
      (e) => e instanceof Error && !(e instanceof HapStatusError) && /matter start failed/.test(e.message));
    assert.equal(h.log.warns.filter((m) => m.includes('matter start failed')).length, 1);
    // A slow command that fails after the wait is handled in the background.
    const slow = await boot({ config: MATTER_CFG(), matter: makeMatter(), waitMs: 10 });
    let fail;
    slow.robot.dock = () => new Promise((_, rej) => { fail = rej; });
    await slow.matter.registered[0][2][0].handlers.rvcOperationalState.goHome();
    fail(new Error('late matter failure'));
    await tick(20);
    assert.equal(slow.log.warns.filter((m) => m.includes('late matter failure')).length, 1);
    assert.deepEqual(rejections, []);
    h.stop(); slow.stop();
  } finally {
    process.off('unhandledRejection', onRej);
  }
});

test('a Matter command does the same bounded wait, fast poll and push as a switch', async () => {
  const matter = makeMatter();
  const h = await boot({ config: MATTER_CFG(), matter });
  const handlers = matter.registered[0][2][0].handlers;
  await handlers.rvcOperationalState.pause();
  await handlers.rvcOperationalState.resume();
  await handlers.rvcOperationalState.goHome();
  await handlers.rvcRunMode.changeToMode({ newMode: 1 });
  assert.deepEqual(h.robot.calls, ['pause', 'resume', 'dock', 'start']);
  assert.ok(h.p.fastUntil > 0);
  h.stop();
});

test('options are passed through to MatterVacuum', async () => {
  const seen = [];
  const extra = { makeMatterVacuum: (o) => { seen.push(o); return { publish: async () => {}, push() {}, accessory: {} }; } };
  const run = async (config) => {
    const h = await boot({ config: MATTER_CFG(config), matter: makeMatter(), extra });
    h.stop();
    return seen.at(-1);
  };
  let o = await run({});
  assert.equal(o.cleanModes, true);
  assert.equal(o.mopWater, 2);
  assert.equal(o.deviceId, 'dev1');
  assert.equal(o.name, 'Vac');
  assert.equal(o.pluginName, 'homebridge-eureka-e20');
  assert.equal(o.platformName, 'EurekaE20');
  assert.equal(typeof o.run, 'function');
  assert.equal(typeof o.maxAgeMs, 'function');
  assert.equal(o.maxAgeMs(), (30 * 3 + 20) * 1000);
  assert.equal(o.cached, undefined);
  o = await run({ cleanModes: false, mopWater: 3, pollSeconds: 60 });
  assert.equal(o.cleanModes, false);
  assert.equal(o.mopWater, 3);
  assert.equal(o.maxAgeMs(), (60 * 3 + 20) * 1000);
  o = await run({ mopWater: 1 });
  assert.equal(o.mopWater, 1);
  for (const bad of [0, 4, 7, -1, 1.5, '2', null, NaN]) {
    o = await run({ mopWater: bad });
    assert.equal(o.mopWater, 2, `mopWater ${String(bad)}`);
  }
});

test('the run function given to MatterVacuum throws a plain Error on a quick failure', async () => {
  const seen = [];
  const extra = { makeMatterVacuum: (o) => { seen.push(o); return { publish: async () => {}, push() {}, accessory: {} }; } };
  const h = await boot({ config: MATTER_CFG(), matter: makeMatter(), extra });
  const { run } = seen[0];
  await assert.rejects(run(async () => { throw new Error('quick'); }),
    (e) => e instanceof Error && !(e instanceof HapStatusError) && e.message === 'quick');
  assert.equal(await run(async () => 'x'), undefined);
  h.stop();
});

test('setting up twice does not publish the vacuum twice', async () => {
  const matter = makeMatter();
  const h = await boot({ config: MATTER_CFG(), matter });
  await h.p.setup();
  assert.equal(matter.registered.length, 1);
  h.stop();
});
