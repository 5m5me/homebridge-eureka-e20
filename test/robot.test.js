const test = require('node:test');
const assert = require('node:assert');
const { Robot } = require('../lib/robot');
const p = require('../lib/protocol');

const DOCKED = 'aa39b800000000000103320106000000000300000f005f000100000101000101010000010000020100071e000000000000000000011900000018';
// Same reply with a different work status byte (index 12) and a fixed-up checksum.
function withStatus(ws) {
  const b = Buffer.from(DOCKED, 'hex');
  b[12] = ws; b[b.length - 1] = 0;
  b[b.length - 1] = (-b.subarray(1).reduce((a, x) => a + x, 0)) & 0xFF;
  return b.toString('hex');
}

function fakeCloud(replies) {
  const sent = [];
  return { sent, sendCommand: async (id, hex) => { sent.push(hex); const r = replies.shift(); if (r instanceof Error) throw r; return r; } };
}

test('poll decodes state and marks the robot reachable', async () => {
  const r = new Robot({ cloud: fakeCloud([DOCKED]), deviceId: '42', now: () => 1000 });
  const s = await r.poll();
  assert.deepStrictEqual(s, { status: 'docked', battery: 95, fan: 3, water: 0,
    fault: false, faultClass: 0, faultCode: 0, at: 1000 });
  assert.strictEqual(r.reachable, true);
  assert.strictEqual(r.isFresh(5000), true);
});

test('poll failure marks the robot unreachable and rethrows', async () => {
  const r = new Robot({ cloud: fakeCloud([new Error('down')]), deviceId: '42' });
  await assert.rejects(r.poll(), /down/);
  assert.strictEqual(r.reachable, false);
  assert.strictEqual(r.isFresh(5000), false);
});

test('an unparseable reply counts as a failure', async () => {
  const r = new Robot({ cloud: fakeCloud(['zz']), deviceId: '42' });
  await assert.rejects(r.poll(), /did not return a valid status/);
});

test('start from docked sends the start frame with current suction and water', async () => {
  const cloud = fakeCloud([DOCKED, 'ack', withStatus(2)]);
  const r = new Robot({ cloud, deviceId: '42' });
  await r.start();
  assert.deepStrictEqual(cloud.sent, [p.FRAMES.queryStatus, p.startFrame(3, 0), p.FRAMES.queryStatus]);
  assert.strictEqual(r.state.status, 'cleaning');
});

test('start from paused sends resume', async () => {
  const cloud = fakeCloud([withStatus(8), 'ack', withStatus(2)]);
  const r = new Robot({ cloud, deviceId: '42' });
  await r.start();
  assert.strictEqual(cloud.sent[1], p.FRAMES.resume);
});

test('pause and dock send their frames then re-poll', async () => {
  const cloud = fakeCloud(['ack', withStatus(8), 'ack', withStatus(1)]);
  const r = new Robot({ cloud, deviceId: '42' });
  await r.pause();
  await r.dock();
  assert.deepStrictEqual(cloud.sent, [p.FRAMES.pause, p.FRAMES.queryStatus, p.FRAMES.dock, p.FRAMES.queryStatus]);
  assert.strictEqual(r.state.status, 'returning');
});

test('a command the robot does not acknowledge fails', async () => {
  const r = new Robot({ cloud: fakeCloud([new Error('The robot did not answer')]), deviceId: '42' });
  await assert.rejects(r.dock(), /did not answer/);
});
