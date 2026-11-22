const test = require('node:test');
const assert = require('node:assert');
const { Robot, CommandUnconfirmedError } = require('../lib/robot');
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
  const calls = [];
  const cloud = {
    sent, calls, inflight: 0, maxInflight: 0,
    sendCommand: async (deviceId, hex, waitSeconds) => {
      sent.push(hex);
      calls.push({ deviceId, hex, waitSeconds });
      cloud.inflight++;
      cloud.maxInflight = Math.max(cloud.maxInflight, cloud.inflight);
      await new Promise((resolve) => setImmediate(resolve));
      cloud.inflight--;
      const r = replies.shift();
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return cloud;
}

function fakeSleep() {
  const calls = [];
  const sleep = async (ms) => { calls.push(ms); };
  sleep.calls = calls;
  return sleep;
}

function make(replies, extra = {}) {
  const cloud = fakeCloud(replies);
  const sleep = fakeSleep();
  const robot = new Robot({ cloud, deviceId: '42', sleep, ...extra });
  return { cloud, sleep, robot };
}

test('poll decodes state and marks the robot reachable', async () => {
  const { cloud, robot } = make([DOCKED], { now: () => 1000 });
  const s = await robot.poll();
  assert.deepStrictEqual(s, { status: 'docked', battery: 95, fan: 3, water: 0,
    fault: false, faultClass: 0, faultCode: 0, at: 1000 });
  assert.strictEqual(robot.reachable, true);
  assert.strictEqual(robot.isFresh(5000), true);
  assert.deepStrictEqual(cloud.calls, [{ deviceId: '42', hex: p.FRAMES.queryStatus, waitSeconds: 10 }]);
});

test('poll failure marks the robot unreachable and rethrows', async () => {
  const { robot } = make([new Error('down')]);
  await assert.rejects(robot.poll(), /down/);
  assert.strictEqual(robot.reachable, false);
  assert.strictEqual(robot.isFresh(5000), false);
});

test('an unparseable reply counts as a failure', async () => {
  const { robot } = make(['zz']);
  await assert.rejects(robot.poll(), /did not return a valid status/);
  assert.strictEqual(robot.reachable, false);
});

test('state is emitted on success and on failure', async () => {
  const { robot } = make([DOCKED, new Error('down')]);
  const seen = [];
  robot.on('state', (s) => seen.push({ s, reachable: robot.reachable }));
  await robot.poll();
  await assert.rejects(robot.poll(), /down/);
  assert.strictEqual(seen.length, 2);
  assert.strictEqual(seen[0].s.status, 'docked');
  assert.strictEqual(seen[0].reachable, true);
  assert.strictEqual(seen[1].s.status, 'docked'); // last known state
  assert.strictEqual(seen[1].reachable, false);
});

test('a throwing state listener does not mark the robot unreachable', async () => {
  const { robot } = make([DOCKED]);
  robot.on('state', () => { throw new Error('listener bug'); });
  await assert.rejects(robot.poll(), /listener bug/);
  assert.strictEqual(robot.reachable, true);
  assert.strictEqual(robot.state.status, 'docked');
});

test('isFresh is false when the state is older than the limit', async () => {
  let t = 1000;
  const { robot } = make([DOCKED], { now: () => t });
  await robot.poll();
  t = 6000;
  assert.strictEqual(robot.isFresh(5000), true);
  t = 6001;
  assert.strictEqual(robot.isFresh(5000), false);
});

test('a fault state sets fault true', async () => {
  const b = Buffer.from(DOCKED, 'hex');
  b[25] = 1; b[b.length - 1] = 0;
  b[b.length - 1] = (-b.subarray(1).reduce((a, x) => a + x, 0)) & 0xFF;
  const { robot } = make([b.toString('hex')]);
  const s = await robot.poll();
  assert.strictEqual(s.faultClass, 1);
  assert.strictEqual(s.fault, true);
});

test('start from docked polls first, then sends the start frame with current suction and water', async () => {
  const { cloud, robot } = make([DOCKED, 'ack', withStatus(2)]);
  await robot.start();
  assert.deepStrictEqual(cloud.sent, [p.FRAMES.queryStatus, p.startFrame(3, 0), p.FRAMES.queryStatus]);
  assert.deepStrictEqual(cloud.calls.map((c) => [c.deviceId, c.waitSeconds]), [['42', 10], ['42', 10], ['42', 10]]);
  assert.strictEqual(robot.state.status, 'cleaning');
});

test('start from paused sends resume', async () => {
  const { cloud, robot } = make([withStatus(8), 'ack', withStatus(2)]);
  await robot.start();
  assert.strictEqual(cloud.sent[1], p.FRAMES.resume);
});

test('start polls first even when state exists and resumes only if the fresh state is paused', async () => {
  const { cloud, robot } = make([withStatus(8), withStatus(4), 'ack', withStatus(2)]);
  await robot.poll(); // cached state says paused
  await robot.start(); // fresh state says docked
  assert.deepStrictEqual(cloud.sent.slice(1, 3), [p.FRAMES.queryStatus, p.startFrame(3, 0)]);
  assert.ok(!cloud.sent.includes(p.FRAMES.resume));
});

test('start accepts moving as confirmation', async () => {
  const { robot } = make([DOCKED, null, withStatus(14)]);
  const s = await robot.start();
  assert.strictEqual(s.status, 'moving');
});

test('an invalid suction value falls back to 2', async () => {
  const b = Buffer.from(DOCKED, 'hex');
  b[17] = 0; b[b.length - 1] = 0;
  b[b.length - 1] = (-b.subarray(1).reduce((a, x) => a + x, 0)) & 0xFF;
  const { cloud, robot } = make([b.toString('hex'), 'ack', withStatus(2)]);
  await robot.start();
  assert.strictEqual(cloud.sent[1], p.startFrame(2, 0));
});

test('pause confirms by polling and records the paused state', async () => {
  const { cloud, robot } = make(['ack', withStatus(8)]);
  const s = await robot.pause();
  assert.deepStrictEqual(cloud.sent, [p.FRAMES.pause, p.FRAMES.queryStatus]);
  assert.strictEqual(s.status, 'paused');
  assert.strictEqual(robot.state.status, 'paused');
});

test('dock sends its frame then re-polls', async () => {
  const { cloud, robot } = make(['ack', withStatus(1)]);
  await robot.dock();
  assert.deepStrictEqual(cloud.sent, [p.FRAMES.dock, p.FRAMES.queryStatus]);
  assert.strictEqual(robot.state.status, 'returning');
});

test('a null reply to dock followed by a poll showing returning succeeds', async () => {
  const { sleep, robot } = make([null, withStatus(1)]);
  const s = await robot.dock();
  assert.strictEqual(s.status, 'returning');
  assert.deepStrictEqual(sleep.calls, []);
});

test('confirmation succeeds on the second poll after one wait', async () => {
  const { cloud, sleep, robot } = make([null, withStatus(2), withStatus(1)]);
  const s = await robot.dock();
  assert.strictEqual(s.status, 'returning');
  assert.deepStrictEqual(sleep.calls, [2000]);
  assert.strictEqual(cloud.sent.length, 3);
});

test('a null reply to dock with 4 polls still cleaning throws CommandUnconfirmedError', async () => {
  const { cloud, sleep, robot } = make([null, withStatus(2), withStatus(2), withStatus(2), withStatus(2)]);
  await assert.rejects(robot.dock(), (err) => {
    assert.ok(err instanceof CommandUnconfirmedError);
    assert.match(err.message, /did not confirm/);
    assert.match(err.message, /cleaning/);
    return true;
  });
  assert.deepStrictEqual(sleep.calls, [2000, 2000, 2000]);
  assert.strictEqual(cloud.sent.length, 5);
});

test('command accepted but every confirmation poll throws gives CommandUnconfirmedError', async () => {
  const cause = new Error('down');
  const { sleep, robot } = make(['ack', cause, cause, cause, cause]);
  await assert.rejects(robot.dock(), (err) => {
    assert.ok(err instanceof CommandUnconfirmedError);
    assert.match(err.message, /status is unknown/);
    assert.strictEqual(err.cause, cause);
    return true;
  });
  assert.deepStrictEqual(sleep.calls, [2000, 2000, 2000]);
});

test('a control command reply is not proof either way', async () => {
  // The reply claims success but the robot never reaches the expected status.
  const { robot } = make([withStatus(1), withStatus(4), withStatus(4), withStatus(4), withStatus(4)]);
  await assert.rejects(robot.pause(), CommandUnconfirmedError);
});

test('a command the robot does not acknowledge fails unchanged', async () => {
  const { cloud, robot } = make([new Error('The robot did not answer')]);
  await assert.rejects(robot.dock(), (err) => {
    assert.ok(!(err instanceof CommandUnconfirmedError));
    assert.match(err.message, /did not answer/);
    return true;
  });
  assert.strictEqual(cloud.sent.length, 1);
});

test('concurrent poll and dock do not interleave their cloud calls', async () => {
  const { cloud, robot } = make([DOCKED, 'ack', withStatus(1)]);
  await Promise.all([robot.poll(), robot.dock()]);
  assert.strictEqual(cloud.maxInflight, 1);
  assert.deepStrictEqual(cloud.sent, [p.FRAMES.queryStatus, p.FRAMES.dock, p.FRAMES.queryStatus]);
});

test('a failed operation does not block the next one', async () => {
  const { robot } = make([new Error('down'), DOCKED]);
  const first = robot.poll();
  const second = robot.poll();
  await assert.rejects(first, /down/);
  const s = await second;
  assert.strictEqual(s.status, 'docked');
});

test('commands log one debug line per command and one warning per unconfirmed command', async () => {
  const debug = []; const warn = [];
  const log = { debug: (m) => debug.push(m), warn: (m) => warn.push(m) };
  const { robot } = make(['ack', withStatus(2), withStatus(2), withStatus(2), withStatus(2)], { log });
  await assert.rejects(robot.dock(), CommandUnconfirmedError);
  assert.strictEqual(debug.length, 1);
  assert.strictEqual(warn.length, 1);
});
