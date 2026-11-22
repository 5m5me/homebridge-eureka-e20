const test = require('node:test');
const assert = require('node:assert');
const p = require('../lib/protocol');

// Real reply captured from Ned's robot on 2026-11-22: docked, suction 3, water 0, no fault.
const REPLY = 'aa39b800000000000103320106000000000300000f005f000100000101000101010000010000020100071e000000000000000000011900000018';

test('command frames match known-good hex', () => {
  assert.strictEqual(p.FRAMES.queryStatus, 'AA0CB800000000000003320106');
  assert.strictEqual(p.FRAMES.dock, 'AA0CB800000000000002220117');
  assert.strictEqual(p.FRAMES.stop, 'AA0CB800000000000002220315');
  assert.strictEqual(p.FRAMES.pause, 'AA0CB800000000000002221BFD');
  assert.strictEqual(p.FRAMES.resume, 'AA0DB800000000000002221C00FB');
  assert.strictEqual(p.startFrame(3, 0), 'AA15B800000000000002220200020008030000000000');
});

test('parseStatus decodes the captured reply', () => {
  assert.deepStrictEqual(p.parseStatus(REPLY), {
    workStatus: 6, fan: 3, water: 0, battery: 95, faultClass: 0, faultCode: 0,
  });
});

test('parseStatus rejects bad input', () => {
  assert.strictEqual(p.parseStatus(null), null);
  assert.strictEqual(p.parseStatus('zz'), null);
  assert.strictEqual(p.parseStatus(REPLY.slice(0, -2) + '19'), null); // bad checksum
  assert.strictEqual(p.parseStatus(p.FRAMES.dock), null);            // not a status reply
});

test('statusName maps work states', () => {
  assert.strictEqual(p.statusName(2, 80), 'cleaning');
  assert.strictEqual(p.statusName(8, 80), 'paused');
  assert.strictEqual(p.statusName(1, 80), 'returning');
  assert.strictEqual(p.statusName(6, 100), 'docked');
  assert.strictEqual(p.statusName(12, 100), 'docked');
  assert.strictEqual(p.statusName(12, 60), 'idle');
  assert.strictEqual(p.statusName(11, 60), 'error');
  assert.strictEqual(p.statusName(99, 60), 'unknown');
});
