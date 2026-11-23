'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MatterVacuum } = require('../lib/matter-vacuum');

const VAC_TYPE = { name: 'RoboticVacuumCleaner' };

function fakeMatter(overrides = {}) {
  const calls = { register: [], update: [], unregister: [], state: [] };
  const matter = {
    uuid: { generate: (s) => 'uuid:' + s },
    deviceTypes: { RoboticVacuumCleaner: VAC_TYPE },
    registerPlatformAccessories: async (...a) => { calls.register.push(a); },
    updatePlatformAccessories: async (...a) => { calls.update.push(a); },
    unregisterPlatformAccessories: async (...a) => { calls.unregister.push(a); },
    updateAccessoryState: async (...a) => { calls.state.push(a); },
    ...overrides,
  };
  return { matter, calls };
}

function fakeRobot() {
  const calls = [];
  const robot = {
    state: { status: 'docked', workStatus: 6, battery: 95, water: 0, fan: 2, fault: false, at: 1 },
    fresh: true,
    isFresh() { return this.fresh; },
    start: async (...a) => { calls.push(['start', ...a]); },
    pause: async () => { calls.push(['pause']); },
    resume: async () => { calls.push(['resume']); },
    dock: async () => { calls.push(['dock']); },
  };
  return { robot, calls };
}

function make(opts = {}) {
  const m = opts.matter ? { matter: opts.matter, calls: opts.calls } : fakeMatter();
  const r = fakeRobot();
  const runCalls = [];
  const logs = [];
  const log = { debug: (...a) => logs.push(a.join(' ')), warn() {}, info() {} };
  const vac = new MatterVacuum({
    matter: m.matter,
    robot: r.robot,
    log,
    pluginName: 'homebridge-eureka-e20',
    platformName: 'EurekaE20',
    deviceId: 'dev1',
    name: 'Vacuum',
    maxAgeMs: () => 60000,
    cleanModes: true,
    mopWater: 2,
    run: async (fn) => { runCalls.push(1); return fn(); },
    ...opts.ctor,
  });
  return { vac, matter: m.matter, calls: m.calls, robot: r.robot, robotCalls: r.calls, runCalls, logs };
}

test('publish registers one accessory with the right fields', async () => {
  const t = make();
  await t.vac.publish();
  assert.equal(t.calls.register.length, 1);
  assert.equal(t.calls.update.length, 0);
  const [plugin, platform, list] = t.calls.register[0];
  assert.equal(plugin, 'homebridge-eureka-e20');
  assert.equal(platform, 'EurekaE20');
  assert.equal(list.length, 1);
  const a = list[0];
  assert.equal(a, t.vac.accessory);
  assert.equal(a.UUID, 'uuid:eureka-e20-matter:dev1');
  assert.equal(a.displayName, 'Vacuum');
  assert.equal(a.deviceType, VAC_TYPE);
  assert.equal(a.serialNumber, 'dev1');
  assert.equal(a.manufacturer, 'Eureka');
  assert.equal(a.model, 'E20 Plus');
  assert.deepEqual(a.context, { deviceId: 'dev1', cleanMode: 0 });
  assert.deepEqual(Object.keys(a.clusters), ['rvcRunMode', 'rvcOperationalState', 'rvcCleanMode', 'powerSource']);
  assert.equal(a.clusters.rvcOperationalState.operationalState, 66);
  assert.equal(a.clusters.powerSource.batPercentRemaining, 190);
  assert.deepEqual(Object.keys(a.handlers), ['rvcRunMode', 'rvcOperationalState', 'rvcCleanMode']);
});

test('publish with cached updates instead of registering and keeps UUID and clean mode', async () => {
  const cached = { UUID: 'cached-uuid', context: { deviceId: 'dev1', cleanMode: 2, extra: 'x' }, clusters: { old: 1 }, handlers: {} };
  const t = make({ ctor: { cached } });
  await t.vac.publish();
  assert.equal(t.calls.register.length, 0);
  assert.equal(t.calls.update.length, 1);
  assert.deepEqual(t.calls.update[0], [[t.vac.accessory]]);
  assert.equal(t.vac.accessory.UUID, 'cached-uuid');
  assert.equal(t.vac.accessory.context.cleanMode, 2);
  assert.equal(t.vac.accessory.clusters.rvcCleanMode.currentMode, 2);
  assert.equal(t.vac.accessory.clusters.old, undefined);
  assert.equal(typeof t.vac.accessory.handlers.rvcRunMode.changeToMode, 'function');
});

test('cached clean mode other than 0 or 2 falls back to Vacuum', async () => {
  const cached = { UUID: 'u', context: { deviceId: 'dev1', cleanMode: 7 } };
  const t = make({ ctor: { cached } });
  await t.vac.publish();
  assert.equal(t.vac.accessory.context.cleanMode, 0);
});

test('uuid falls back to the injected generator when matter.uuid is missing', async () => {
  const { matter, calls } = fakeMatter({ uuid: undefined });
  const t = make({ matter, calls, ctor: { uuidGenerate: (s) => 'gen:' + s } });
  await t.vac.publish();
  assert.equal(t.vac.accessory.UUID, 'gen:eureka-e20-matter:dev1');
});

test('missing device type makes publish throw and registers nothing', async () => {
  const { matter, calls } = fakeMatter({ deviceTypes: {} });
  const t = make({ matter, calls });
  await assert.rejects(t.vac.publish(), /RoboticVacuumCleaner/);
  assert.equal(calls.register.length, 0);
  assert.equal(calls.update.length, 0);
});

test('Cleaning with Vacuum starts with water 0', async () => {
  const t = make();
  await t.vac.publish();
  await t.vac.accessory.handlers.rvcRunMode.changeToMode({ newMode: 1 });
  assert.deepEqual(t.robotCalls, [['start', { water: 0 }]]);
  assert.equal(t.runCalls.length, 1);
});

test('Cleaning with Vacuum and mop starts with mopWater', async () => {
  const t = make({ ctor: { mopWater: 3 } });
  await t.vac.publish();
  await t.vac.accessory.handlers.rvcCleanMode.changeToMode({ newMode: 2 });
  await t.vac.accessory.handlers.rvcRunMode.changeToMode({ newMode: 1 });
  assert.deepEqual(t.robotCalls, [['start', { water: 3 }]]);
});

test('Cleaning with clean modes off starts with no options', async () => {
  const t = make({ ctor: { cleanModes: false } });
  await t.vac.publish();
  await t.vac.accessory.handlers.rvcRunMode.changeToMode({ newMode: 1 });
  assert.deepEqual(t.robotCalls, [['start']]);
});

test('Idle docks and an unknown run mode throws without touching the robot', async () => {
  const t = make();
  await t.vac.publish();
  await t.vac.accessory.handlers.rvcRunMode.changeToMode({ newMode: 0 });
  assert.deepEqual(t.robotCalls, [['dock']]);
  await assert.rejects(t.vac.accessory.handlers.rvcRunMode.changeToMode({ newMode: 5 }), Error);
  assert.equal(t.robotCalls.length, 1);
});

test('pause, resume and goHome call the right robot methods', async () => {
  const t = make();
  await t.vac.publish();
  const h = t.vac.accessory.handlers.rvcOperationalState;
  await h.pause();
  await h.resume();
  await h.goHome();
  assert.deepEqual(t.robotCalls, [['pause'], ['resume'], ['dock']]);
  assert.equal(t.runCalls.length, 3);
});

test('clean mode change sends nothing to the robot, persists, and pushes', async () => {
  const t = make();
  await t.vac.publish();
  t.calls.update.length = 0;
  await t.vac.accessory.handlers.rvcCleanMode.changeToMode({ newMode: 2 });
  assert.equal(t.robotCalls.length, 0);
  assert.equal(t.runCalls.length, 0);
  assert.equal(t.vac.accessory.context.cleanMode, 2);
  assert.deepEqual(t.calls.update, [[[t.vac.accessory]]]);
  assert.deepEqual(t.calls.state.map((c) => c[1]), ['rvcCleanMode']);
  assert.equal(t.calls.state[0][2].currentMode, 2);
});

test('clean mode persistence errors are logged at debug and do not fail the handler', async () => {
  const { matter, calls } = fakeMatter();
  const t = make({ matter, calls });
  await t.vac.publish();
  matter.updatePlatformAccessories = async () => { throw new Error('disk'); };
  await t.vac.accessory.handlers.rvcCleanMode.changeToMode({ newMode: 2 });
  await new Promise((r) => setImmediate(r));
  assert.ok(t.logs.some((l) => l.includes('disk')));
});

test('invalid clean mode throws and changes nothing', async () => {
  const t = make();
  await t.vac.publish();
  await assert.rejects(t.vac.accessory.handlers.rvcCleanMode.changeToMode({ newMode: 1 }), Error);
  assert.equal(t.vac.accessory.context.cleanMode, 0);
  assert.equal(t.robotCalls.length, 0);
});

test('a failing run rejects the handler and still pushes', async () => {
  const t = make({ ctor: { run: async () => { throw new Error('no answer'); } } });
  await t.vac.publish();
  t.robot.state = { status: 'cleaning', workStatus: 3, battery: 80, water: 0, fault: false, at: 2 };
  await assert.rejects(t.vac.accessory.handlers.rvcOperationalState.pause(), /no answer/);
  assert.ok(t.calls.state.some((c) => c[1] === 'rvcRunMode'));
});

test('push sends only changed clusters, nothing when unchanged', async () => {
  const t = make();
  await t.vac.publish();
  t.vac.push();
  assert.equal(t.calls.state.length, 0);
  t.robot.state = { status: 'cleaning', workStatus: 3, battery: 95, water: 0, fault: false, at: 2 };
  t.vac.push();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(t.calls.state.map((c) => c[1]).sort(), ['powerSource', 'rvcOperationalState', 'rvcRunMode']);
  assert.equal(t.calls.state[0][0], 'uuid:eureka-e20-matter:dev1');
  t.calls.state.length = 0;
  t.vac.push();
  assert.equal(t.calls.state.length, 0);
});

test('unreachable robot is pushed as error, not a stale healthy state', async () => {
  const t = make();
  await t.vac.publish();
  t.robot.fresh = false;
  t.vac.push();
  const op = t.calls.state.find((c) => c[1] === 'rvcOperationalState');
  assert.equal(op[2].operationalState, 3);
  const ps = t.calls.state.find((c) => c[1] === 'powerSource');
  assert.equal(ps[2].status, 3);
});

test('push swallows a rejected or throwing update, logs at debug, and retries later', async () => {
  const { matter, calls } = fakeMatter();
  const t = make({ matter, calls });
  await t.vac.publish();
  let mode = 'reject';
  matter.updateAccessoryState = async (...a) => {
    calls.state.push(a);
    if (mode === 'reject') throw new Error('refused');
  };
  t.robot.fresh = false;
  assert.doesNotThrow(() => t.vac.push());
  await new Promise((r) => setImmediate(r));
  assert.ok(t.logs.some((l) => l.includes('refused')));
  mode = 'ok';
  calls.state.length = 0;
  t.vac.push();
  assert.ok(calls.state.length > 0, 'failed clusters are sent again');
  matter.updateAccessoryState = () => { throw new Error('sync'); };
  t.robot.fresh = true;
  assert.doesNotThrow(() => t.vac.push());
});

test('push before publish does nothing', () => {
  const t = make();
  assert.doesNotThrow(() => t.vac.push());
  assert.equal(t.calls.state.length, 0);
});

test('unpublish unregisters the accessory', async () => {
  const t = make();
  await t.vac.publish();
  await t.vac.unpublish();
  assert.deepEqual(t.calls.unregister, [['homebridge-eureka-e20', 'EurekaE20', [t.vac.accessory]]]);
});

test('with clean modes off there is no rvcCleanMode cluster or handler', async () => {
  const t = make({ ctor: { cleanModes: false } });
  await t.vac.publish();
  assert.equal(t.vac.accessory.clusters.rvcCleanMode, undefined);
  assert.equal(t.vac.accessory.handlers.rvcCleanMode, undefined);
});

test('no em dash characters in the source', () => {
  const src = require('node:fs').readFileSync(require.resolve('../lib/matter-vacuum'), 'utf8');
  assert.ok(!src.includes(String.fromCharCode(0x2014)));
});
