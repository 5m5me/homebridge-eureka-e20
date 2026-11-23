'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildClusters, cleanModeFromWater, RUN_MODE, CLEAN_MODE, OP_STATE } = require('../lib/matter-state');

const st = (o) => Object.assign({ status: 'docked', battery: 95, fan: 2, water: 0, fault: false, faultClass: 0, faultCode: 0, workStatus: 6, at: 1 }, o);
const build = (state, extra) => buildClusters(Object.assign({ state, fresh: true, selectedCleanMode: 0, cleanModes: true }, extra));
const op = (state, extra) => build(state, extra).rvcOperationalState;

test('constants match the plan', () => {
  assert.deepStrictEqual(RUN_MODE, { IDLE: 0, CLEANING: 1 });
  assert.deepStrictEqual(CLEAN_MODE, { VACUUM: 0, VACUUM_AND_MOP: 2 });
  assert.strictEqual(OP_STATE.STOPPED, 0);
  assert.strictEqual(OP_STATE.RUNNING, 1);
  assert.strictEqual(OP_STATE.PAUSED, 2);
  assert.strictEqual(OP_STATE.ERROR, 3);
  assert.strictEqual(OP_STATE.SEEKING_CHARGER, 64);
  assert.strictEqual(OP_STATE.CHARGING, 65);
  assert.strictEqual(OP_STATE.DOCKED, 66);
});

test('cleanModeFromWater', () => {
  assert.strictEqual(cleanModeFromWater(0), 0);
  assert.strictEqual(cleanModeFromWater(1), 2);
  assert.strictEqual(cleanModeFromWater(2), 2);
  assert.strictEqual(cleanModeFromWater(3), 2);
});

test('rvcRunMode supported modes', () => {
  const m = build(st()).rvcRunMode.supportedModes;
  assert.deepStrictEqual(m.map((x) => [x.mode, x.modeTags.map((t) => t.value)]), [[0, [16384]], [1, [16385]]]);
  assert.ok(m.every((x) => typeof x.label === 'string'));
});

test('rvcRunMode currentMode', () => {
  for (const s of ['cleaning', 'moving', 'paused']) assert.strictEqual(build(st({ status: s })).rvcRunMode.currentMode, 1, s);
  for (const s of ['returning', 'docked', 'idle', 'error', 'unknown']) assert.strictEqual(build(st({ status: s })).rvcRunMode.currentMode, 0, s);
  assert.strictEqual(build(st({ status: 'cleaning' }), { fresh: false }).rvcRunMode.currentMode, 0);
  assert.strictEqual(build(null).rvcRunMode.currentMode, 0);
});

test('rvcOperationalState static fields carry ids only', () => {
  const o = op(st());
  assert.strictEqual(o.phaseList, null);
  assert.strictEqual(o.currentPhase, null);
  assert.deepStrictEqual(o.operationalStateList, [0, 1, 2, 3, 64, 65, 66].map((operationalStateId) => ({ operationalStateId })));
});

test('each status maps to its operational state', () => {
  const cases = { cleaning: 1, moving: 1, paused: 2, returning: 64, idle: 0, unknown: 0, error: 3 };
  for (const [s, id] of Object.entries(cases)) {
    const o = op(st({ status: s }));
    assert.strictEqual(o.operationalState, id, s);
    assert.deepStrictEqual(o.operationalError, { errorStateId: s === 'error' ? 2 : 0 }, s);
  }
});

test('docked and finished gives Docked, otherwise Charging', () => {
  assert.strictEqual(op(st()).operationalState, 66);
  assert.strictEqual(op(st({ workStatus: 4, battery: 100 })).operationalState, 66);
  const c = op(st({ workStatus: 4, battery: 60 }));
  assert.strictEqual(c.operationalState, 65);
  assert.deepStrictEqual(c.operationalError, { errorStateId: 0 });
});

test('fault true gives Error even while cleaning', () => {
  const o = op(st({ status: 'cleaning', fault: true }));
  assert.strictEqual(o.operationalState, 3);
  assert.deepStrictEqual(o.operationalError, { errorStateId: 2 });
});

test('null state and not fresh are visible errors', () => {
  for (const o of [op(null), op(st({ status: 'cleaning' }), { fresh: false }), op(null, { fresh: false })]) {
    assert.strictEqual(o.operationalState, 3);
    assert.deepStrictEqual(o.operationalError, { errorStateId: 2 });
  }
});

test('rvcCleanMode supported modes and current mode', () => {
  const c = build(st()).rvcCleanMode;
  assert.deepStrictEqual(c.supportedModes.map((x) => [x.mode, x.label, x.modeTags.map((t) => t.value)]),
    [[0, 'Vacuum', [16385]], [2, 'Vacuum and mop', [16385, 16386]]]);
  assert.strictEqual(build(st({ status: 'cleaning', water: 2 }), { selectedCleanMode: 0 }).rvcCleanMode.currentMode, 2);
  assert.strictEqual(build(st({ status: 'paused', water: 0 }), { selectedCleanMode: 2 }).rvcCleanMode.currentMode, 0);
  assert.strictEqual(build(st({ status: 'docked', water: 3 }), { selectedCleanMode: 0 }).rvcCleanMode.currentMode, 0);
  assert.strictEqual(build(st({ status: 'docked', water: 0 }), { selectedCleanMode: 2 }).rvcCleanMode.currentMode, 2);
  assert.strictEqual(build(st({ status: 'cleaning', water: 2 }), { fresh: false, selectedCleanMode: 0 }).rvcCleanMode.currentMode, 0);
  assert.strictEqual(build(null, { selectedCleanMode: 2 }).rvcCleanMode.currentMode, 2);
});

test('cleanModes false omits rvcCleanMode', () => {
  assert.ok(!('rvcCleanMode' in build(st(), { cleanModes: false })));
  assert.ok('rvcCleanMode' in build(st()));
});

test('powerSource static fields', () => {
  const p = build(st()).powerSource;
  assert.strictEqual(p.order, 0);
  assert.strictEqual(p.description, 'Battery');
  assert.strictEqual(p.batReplacementNeeded, false);
  assert.strictEqual(p.batReplaceability, 0);
  assert.strictEqual(p.batFunctionalWhileCharging, true);
  assert.strictEqual(p.batPresent, true);
});

test('captured real state: docked, workStatus 6, battery 95', () => {
  const c = build(st());
  assert.strictEqual(c.rvcOperationalState.operationalState, 66);
  assert.strictEqual(c.powerSource.status, 1);
  assert.strictEqual(c.powerSource.batPercentRemaining, 190);
  assert.strictEqual(c.powerSource.batChargeState, 2);
  assert.strictEqual(c.powerSource.batChargeLevel, 0);
});

test('docked charging battery 60 workStatus 4', () => {
  const p = build(st({ workStatus: 4, battery: 60 })).powerSource;
  assert.strictEqual(p.batChargeState, 1);
  assert.strictEqual(p.batPercentRemaining, 120);
});

test('not docked gives IsNotCharging', () => {
  assert.strictEqual(build(st({ status: 'cleaning', battery: 50 })).powerSource.batChargeState, 3);
  assert.strictEqual(build(st({ status: 'returning', battery: 100, workStatus: 6 })).powerSource.batChargeState, 3);
});

test('battery 100 docked is full even without workStatus 6', () => {
  assert.strictEqual(build(st({ workStatus: 4, battery: 100 })).powerSource.batChargeState, 2);
});

test('charge level thresholds and clamping', () => {
  const lvl = (b) => build(st({ battery: b })).powerSource.batChargeLevel;
  assert.strictEqual(lvl(20), 0);
  assert.strictEqual(lvl(19), 1);
  assert.strictEqual(lvl(10), 1);
  assert.strictEqual(lvl(9), 2);
  assert.strictEqual(lvl(0), 2);
  assert.strictEqual(build(st({ battery: 130 })).powerSource.batPercentRemaining, 200);
  assert.strictEqual(build(st({ battery: -5 })).powerSource.batPercentRemaining, 0);
});

test('not fresh or null state: power source unavailable', () => {
  for (const c of [build(null), build(st(), { fresh: false })]) {
    const p = c.powerSource;
    assert.strictEqual(p.status, 3);
    assert.strictEqual(p.batPresent, true);
    assert.strictEqual(p.batPercentRemaining, null);
    assert.strictEqual(p.batChargeLevel, 0);
    assert.strictEqual(p.batChargeState, 0);
  }
});

test('no label keys anywhere in operational state output', () => {
  const walk = (v, path) => {
    if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) {
        assert.ok(k !== 'operationalStateLabel' && k !== 'errorStateLabel', path + k);
        walk(v[k], path + k + '.');
      }
    }
  };
  for (const s of [st(), null, st({ status: 'error' })]) walk(build(s), '');
  assert.deepStrictEqual(Object.keys(op(st({ status: 'error' }))).sort(),
    ['currentPhase', 'operationalError', 'operationalState', 'operationalStateList', 'phaseList']);
});
