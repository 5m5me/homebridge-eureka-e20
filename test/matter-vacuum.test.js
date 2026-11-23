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
  assert.deepEqual(a.context, { deviceId: 'dev1' });
  assert.deepEqual(Object.keys(a.clusters), ['rvcRunMode', 'rvcOperationalState', 'rvcCleanMode', 'powerSource']);
  assert.equal(a.clusters.rvcOperationalState.operationalState, 66);
  assert.equal(a.clusters.powerSource.batPercentRemaining, 190);
  assert.deepEqual(Object.keys(a.handlers), ['rvcRunMode', 'rvcOperationalState', 'rvcCleanMode']);
});

const flush = () => new Promise((r) => setImmediate(r));

test('a change while register is pending is pushed after publish', async () => {
  const t = make();
  let release;
  t.matter.registerPlatformAccessories = (...a) => {
    t.calls.register.push(a);
    return new Promise((r) => { release = r; });
  };
  const p = t.vac.publish();
  await flush();
  t.robot.fresh = false;
  t.vac.push();
  await flush();
  assert.equal(t.calls.state.length, 0);
  release();
  await p;
  await flush();
  assert.deepEqual(t.calls.state.map((c) => c[1]).sort(), ['powerSource', 'rvcOperationalState']);
});

test('updates for one cluster stay in order even when an earlier one is slow', async () => {
  const t = make();
  await t.vac.publish();
  const started = [];
  const releases = [];
  t.matter.updateAccessoryState = (uuid, name, attrs) => {
    started.push([name, attrs.operationalState]);
    return new Promise((r) => releases.push(r));
  };
  t.robot.fresh = false;
  t.vac.push();
  await flush();
  t.robot.fresh = true;
  t.robot.state = { status: 'cleaning', workStatus: 3, battery: 95, water: 0, fault: false, at: 2 };
  t.vac.push();
  await flush();
  const op = () => started.filter((s) => s[0] === 'rvcOperationalState');
  assert.deepEqual(op(), [['rvcOperationalState', 3]], 'second update waits for the first');
  releases.splice(0).forEach((r) => r());
  await flush();
  releases.splice(0).forEach((r) => r());
  await flush();
  assert.deepEqual(op(), [['rvcOperationalState', 3], ['rvcOperationalState', 1]]);
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

test('clean mode change sends nothing to the robot and pushes', async () => {
  const t = make({ ctor: { defer() {} } });
  await t.vac.publish();
  t.calls.update.length = 0;
  await t.vac.accessory.handlers.rvcCleanMode.changeToMode({ newMode: 2 });
  await flush();
  assert.equal(t.robotCalls.length, 0);
  assert.equal(t.runCalls.length, 0);
  assert.equal(t.vac.selectedCleanMode, 2);
  assert.equal(t.calls.update.length, 0, 'the selected mode is not persisted');
  assert.deepEqual(t.calls.state.map((c) => c[1]), ['rvcCleanMode']);
  assert.equal(t.calls.state[0][2].currentMode, 2);
});

test('invalid clean mode throws and changes nothing', async () => {
  const t = make();
  await t.vac.publish();
  await assert.rejects(t.vac.accessory.handlers.rvcCleanMode.changeToMode({ newMode: 1 }), Error);
  assert.equal(t.vac.selectedCleanMode, 0);
  assert.equal(t.robotCalls.length, 0);
});

test('a failing run rejects the handler and still pushes', async () => {
  const t = make({ ctor: { run: async () => { throw new Error('no answer'); } } });
  await t.vac.publish();
  t.robot.state = { status: 'cleaning', workStatus: 3, battery: 80, water: 0, fault: false, at: 2 };
  await assert.rejects(t.vac.accessory.handlers.rvcOperationalState.pause(), /no answer/);
  await flush();
  assert.ok(t.calls.state.some((c) => c[1] === 'rvcRunMode'));
});

test('push sends only changed clusters, nothing when unchanged', async () => {
  const t = make();
  await t.vac.publish();
  t.vac.push();
  await flush();
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
  await flush();
  const op = t.calls.state.find((c) => c[1] === 'rvcOperationalState');
  assert.equal(op[2].operationalState, 3);
  const ps = t.calls.state.find((c) => c[1] === 'powerSource');
  assert.equal(ps[2].status, 3);
});

test('push swallows a rejected or throwing update and logs at debug without retrying', async () => {
  const { matter, calls } = fakeMatter();
  const t = make({ matter, calls });
  await t.vac.publish();
  matter.updateAccessoryState = async (...a) => {
    calls.state.push(a);
    throw new Error('refused');
  };
  t.robot.fresh = false;
  assert.doesNotThrow(() => t.vac.push());
  await flush();
  assert.ok(t.logs.some((l) => l.includes('refused')));
  const sent = calls.state.length;
  t.vac.push();
  await flush();
  assert.equal(calls.state.length, sent, 'no retry of the failed update');
  matter.updateAccessoryState = () => { throw new Error('sync'); };
  t.robot.fresh = true;
  assert.doesNotThrow(() => t.vac.push());
  await flush();
  assert.ok(t.logs.some((l) => l.includes('sync')));
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

// ---- Forced pushes and publish verification ----

// Copies Homebridge: after a changeToMode handler resolves, it sets that
// cluster's currentMode to the requested mode. The write lands on the fake
// tile state, the same place updateAccessoryState writes to.
function homebridgeLike() {
  const tile = {};
  const fake = fakeMatter();
  fake.matter.registerPlatformAccessories = async (plugin, platform, list) => {
    fake.calls.register.push([plugin, platform, list]);
    for (const [name, attrs] of Object.entries(list[0].clusters)) tile[name] = { ...attrs };
  };
  fake.matter.getAccessoryState = async (uuid, name) => tile[name];
  fake.matter.updateAccessoryState = async (uuid, name, attrs) => {
    fake.calls.state.push([uuid, name, attrs]);
    tile[name] = { ...tile[name], ...attrs };
  };
  const wrapHandlers = (handlers) => {
    const out = {};
    for (const [cluster, h] of Object.entries(handlers)) {
      out[cluster] = { ...h };
      if (h.changeToMode) {
        out[cluster].changeToMode = async (req) => {
          const r = await h.changeToMode(req);
          tile[cluster].currentMode = req.newMode;
          return r;
        };
      }
    }
    return out;
  };
  return { ...fake, tile, wrapHandlers };
}

function manualDefer() {
  const queue = [];
  const defer = (fn) => queue.push(fn);
  defer.runAll = async () => {
    while (queue.length) queue.shift()();
    await flush();
  };
  return defer;
}

async function started(extra = {}) {
  const hb = homebridgeLike();
  const defer = manualDefer();
  const t = make({ matter: hb.matter, calls: hb.calls, ctor: { defer, ...extra } });
  await t.vac.publish();
  await flush();
  const h = hb.wrapHandlers(t.vac.accessory.handlers);
  return { ...t, hb, defer, h };
}

// run resolves without the robot changing, like a command still pending when the
// bounded wait ends. The handler resolves, so Homebridge writes the mode.
test('a start that has not worked returns the tile to the robot real state after Homebridge writes the mode', async () => {
  const t = await started({ run: async () => {} });
  assert.equal(t.hb.tile.rvcRunMode.currentMode, 0);
  await t.h.rvcRunMode.changeToMode({ newMode: 1 });
  await flush();
  assert.equal(t.hb.tile.rvcRunMode.currentMode, 1, 'Homebridge wrote Cleaning');
  await t.defer.runAll();
  assert.equal(t.hb.tile.rvcRunMode.currentMode, 0, 'tile is back to Idle');
});

test('a dock that has not worked returns the tile to Cleaning while the robot is cleaning', async () => {
  const t = await started({ run: async () => {} });
  t.robot.state = { status: 'cleaning', workStatus: 2, battery: 80, water: 0, fault: false, at: 2 };
  t.vac.push();
  await flush();
  assert.equal(t.hb.tile.rvcRunMode.currentMode, 1);
  await t.h.rvcRunMode.changeToMode({ newMode: 0 });
  await flush();
  assert.equal(t.hb.tile.rvcRunMode.currentMode, 0, 'Homebridge wrote Idle');
  await t.defer.runAll();
  assert.equal(t.hb.tile.rvcRunMode.currentMode, 1);
});

test('a clean mode change while cleaning shows the water the robot reports', async () => {
  const t = await started();
  t.robot.state = { status: 'cleaning', workStatus: 2, battery: 80, water: 0, fault: false, at: 2 };
  t.vac.push();
  await flush();
  assert.equal(t.hb.tile.rvcCleanMode.currentMode, 0);
  await t.h.rvcCleanMode.changeToMode({ newMode: 2 });
  await flush();
  assert.equal(t.hb.tile.rvcCleanMode.currentMode, 2, 'Homebridge wrote Vacuum and mop');
  await t.defer.runAll();
  assert.equal(t.hb.tile.rvcCleanMode.currentMode, 0, 'the robot is still on Vacuum');
});

test('force sends every cluster even when nothing changed', async () => {
  const t = await started();
  t.calls.state.length = 0;
  t.vac.push();
  await flush();
  assert.equal(t.calls.state.length, 0);
  t.vac.push(true);
  await flush();
  assert.deepEqual(t.calls.state.map((c) => c[1]).sort(),
    ['powerSource', 'rvcCleanMode', 'rvcOperationalState', 'rvcRunMode']);
});

test('every handler schedules a forced push, also when it fails', async () => {
  const t = await started();
  await t.h.rvcOperationalState.pause();
  assert.equal(t.calls.state.length, 0);
  t.calls.state.length = 0;
  await t.defer.runAll();
  assert.equal(t.calls.state.length, 4);
  await assert.rejects(t.h.rvcRunMode.changeToMode({ newMode: 9 }), Error);
  t.calls.state.length = 0;
  await t.defer.runAll();
  assert.equal(t.calls.state.length, 4);
});

test('publish throws when Homebridge did not actually publish the tile', async () => {
  const hb = homebridgeLike();
  hb.matter.getAccessoryState = async () => undefined;
  const t = make({ matter: hb.matter, calls: hb.calls });
  await assert.rejects(t.vac.publish(), /could not be published/);
  t.vac.push(true);
  await flush();
  assert.equal(hb.calls.state.length, 0, 'nothing is pushed to a tile that does not exist');
});

test('publish throws when getAccessoryState rejects', async () => {
  const hb = homebridgeLike();
  hb.matter.getAccessoryState = async () => { throw new Error('boom'); };
  const t = make({ matter: hb.matter, calls: hb.calls });
  await assert.rejects(t.vac.publish(), /could not be published/);
});

test('publish succeeds without getAccessoryState and when the state exists', async () => {
  const noCheck = make();
  assert.equal(typeof noCheck.matter.getAccessoryState, 'undefined');
  await noCheck.vac.publish();
  const hb = homebridgeLike();
  const t = make({ matter: hb.matter, calls: hb.calls });
  await t.vac.publish();
});
