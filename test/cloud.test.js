const test = require('node:test');
const assert = require('node:assert');
const { CloudClient, AuthError, DeviceTimeoutError } = require('../lib/cloud');

// Fake fetch: routes is a list of [urlSubstring, status, jsonBody]; first match wins, calls are recorded.
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const hit = routes.find(([part]) => String(url).includes(part));
    if (!hit) throw new Error('unexpected url ' + url);
    const [, status, body] = hit;
    if (typeof body === 'function') return { status, json: async () => body(calls) };
    return { status, json: async () => body };
  };
  impl.calls = calls;
  return impl;
}

const OK_LOGIN = { errorCode: '0', data: { accessToken: 'A1', refreshToken: 'R1' } };

test('login skips wrong regions and stores tokens', async () => {
  const f = fakeFetch([
    ['global.mzrobo.com/auth/login', 200, { errorCode: '0051204' }],
    ['euprod.mzrobo.com/auth/login', 200, OK_LOGIN],
  ]);
  let saved;
  const c = new CloudClient({ email: 'e', password: 'p', fetchImpl: f, onTokens: (t) => { saved = t; } });
  await c.login();
  assert.deepStrictEqual(saved, { accessToken: 'A1', refreshToken: 'R1', region: 'eu' });
  assert.match(f.calls[1].url, /clientId=1301/);
});

test('login throws AuthError on bad credentials', async () => {
  const f = fakeFetch([['/auth/login', 200, { errorCode: '0051002', msg: 'wrong' }]]);
  const c = new CloudClient({ email: 'e', password: 'p', fetchImpl: f });
  await assert.rejects(c.login(), AuthError);
});

test('getDevices returns the list and sends the bearer token', async () => {
  const f = fakeFetch([
    ['/auth/login', 200, OK_LOGIN],
    ['/app/devices', 200, { errorCode: '0', data: [{ deviceId: '42' }] }],
  ]);
  const c = new CloudClient({ email: 'e', password: 'p', fetchImpl: f });
  assert.deepStrictEqual(await c.getDevices(), [{ deviceId: '42' }]);
  assert.strictEqual(f.calls[1].opts.headers.Authorization, 'Bearer A1');
});

test('sendCommand returns the reply hex', async () => {
  const f = fakeFetch([
    ['/devices/commands/42', 200, { errorCode: '0', data: { data: 'aa00' } }],
  ]);
  const c = new CloudClient({ email: 'e', password: 'p', fetchImpl: f,
    tokens: { accessToken: 'A1', refreshToken: 'R1', region: 'global' } });
  assert.strictEqual(await c.sendCommand('42', 'AA', 10), 'aa00');
  assert.deepStrictEqual(JSON.parse(f.calls[0].opts.body), { data: 'AA', waitTimeoutInSeconds: 10 });
});

test('sendCommand maps the device timeout code', async () => {
  const f = fakeFetch([['/devices/commands/42', 200, { errorCode: '0080005', msg: 'timeout' }]]);
  const c = new CloudClient({ email: 'e', password: 'p', fetchImpl: f,
    tokens: { accessToken: 'A1', refreshToken: 'R1', region: 'global' } });
  await assert.rejects(c.sendCommand('42', 'AA'), DeviceTimeoutError);
});

test('a 401 triggers a token refresh and one retry', async () => {
  let n = 0;
  const f = fakeFetch([
    ['/auth/refresh-token', 200, { errorCode: '0', data: { accessToken: 'A2', refreshToken: 'R2' } }],
    ['/app/devices', 0, null],
  ]);
  const real = f;
  const impl = async (url, opts) => {
    if (String(url).includes('/app/devices')) {
      n += 1;
      return n === 1 ? { status: 401, json: async () => null }
        : { status: 200, json: async () => ({ errorCode: '0', data: [] }) };
    }
    return real(url, opts);
  };
  const c = new CloudClient({ email: 'e', password: 'p', fetchImpl: impl,
    tokens: { accessToken: 'A1', refreshToken: 'R1', region: 'global' } });
  assert.deepStrictEqual(await c.getDevices(), []);
  assert.strictEqual(n, 2);
});
