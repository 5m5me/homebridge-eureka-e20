const test = require('node:test');
const assert = require('node:assert');
const { CloudClient, CloudError, AuthError, DeviceTimeoutError } = require('../lib/cloud');

// Fake fetch: routes is a list of [urlSubstring, status, body]; first match wins, calls are recorded.
// status 'throw' simulates a network failure. A string body is returned as a non-JSON body.
// A function body is called with the 1-based hit count for that route and returns [status, body].
function fakeFetch(routes) {
  const calls = [];
  const hits = new Map();
  const impl = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    const route = routes.find(([part]) => String(url).includes(part));
    if (!route) throw new Error('unexpected url ' + url);
    const n = (hits.get(route) || 0) + 1;
    hits.set(route, n);
    let [, status, body] = route;
    if (typeof body === 'function') [status, body] = body(n);
    if (status === 'throw') throw new Error('network down');
    if (typeof body === 'string') {
      return { status, json: async () => { throw new SyntaxError('not json'); } };
    }
    return { status, json: async () => body };
  };
  impl.calls = calls;
  return impl;
}

const OK_LOGIN = { errorCode: '0', data: { accessToken: 'A1', refreshToken: 'R1' } };
const STORED = { accessToken: 'A1', refreshToken: 'R1', region: 'global' };
const isCloudNotAuth = (err) => err instanceof CloudError && !(err instanceof AuthError);

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

test('login reaches the na region when global and eu report wrong region', async () => {
  const f = fakeFetch([
    ['global.mzrobo.com/auth/login', 200, { errorCode: '0051204' }],
    ['euprod.mzrobo.com/auth/login', 200, { errorCode: '0051213' }],
    ['naprod.mzrobo.com/auth/login', 200, OK_LOGIN],
  ]);
  let saved;
  const c = new CloudClient({ email: 'e', password: 'p', fetchImpl: f, onTokens: (t) => { saved = t; } });
  await c.login();
  assert.strictEqual(saved.region, 'na');
  assert.strictEqual(f.calls.length, 3);
});

test('login tries a stored region first', async () => {
  const f = fakeFetch([['/auth/login', 200, OK_LOGIN]]);
  const c = new CloudClient({ email: 'e', password: 'p', fetchImpl: f,
    tokens: { accessToken: 'x', refreshToken: 'y', region: 'eu' } });
  await c.login();
  assert.match(f.calls[0].url, /euprod\.mzrobo\.com/);
  assert.strictEqual(f.calls.length, 1);
});

test('login ignores a stored region that is not known', async () => {
  const f = fakeFetch([
    ['/auth/login', 200, OK_LOGIN],
    ['/app/devices', 200, { errorCode: '0', data: [] }],
  ]);
  const c = new CloudClient({ email: 'e', password: 'p', fetchImpl: f,
    tokens: { accessToken: 'x', refreshToken: 'y', region: 'mars' } });
  assert.deepStrictEqual(await c.getDevices(), []);
  assert.match(f.calls[0].url, /global\.mzrobo\.com\/auth\/login/);
  assert.ok(f.calls.every((call) => !call.url.includes('undefined')));
});

test('login accepts a numeric success code', async () => {
  const f = fakeFetch([['/auth/login', 200, { errorCode: 0, data: { accessToken: 'A1', refreshToken: 'R1' } }]]);
  const c = new CloudClient({ email: 'e', password: 'p', fetchImpl: f });
  await c.login();
  assert.strictEqual(c.tokens.accessToken, 'A1');
});

test('login throws AuthError on bad credentials', async () => {
  const f = fakeFetch([['/auth/login', 200, { errorCode: '0051002', msg: 'wrong' }]]);
  const c = new CloudClient({ email: 'e', password: 'p', fetchImpl: f });
  await assert.rejects(c.login(), AuthError);
});

test('login throws AuthError on HTTP 401', async () => {
  const f = fakeFetch([['/auth/login', 401, {}]]);
  const c = new CloudClient({ email: 'e', password: 'p', fetchImpl: f });
  await assert.rejects(c.login(), AuthError);
});

test('login throws AuthError when every region answers wrong region', async () => {
  const f = fakeFetch([['/auth/login', 200, { errorCode: '0051204' }]]);
  const c = new CloudClient({ email: 'e', password: 'p', fetchImpl: f });
  await assert.rejects(c.login(), AuthError);
  assert.strictEqual(f.calls.length, 3);
});

test('login with every region unreachable is a CloudError, not an AuthError', async () => {
  const f = fakeFetch([['/auth/login', 'throw', null]]);
  const c = new CloudClient({ email: 'e', password: 'p', fetchImpl: f });
  await assert.rejects(c.login(), (err) => {
    assert.ok(isCloudNotAuth(err));
    assert.match(err.message, /cannot be reached/i);
    return true;
  });
  assert.strictEqual(f.calls.length, 3);
});

test('login with a 503 HTML body is a CloudError, not an AuthError', async () => {
  const f = fakeFetch([['/auth/login', 503, '<html>Service Unavailable</html>']]);
  const c = new CloudClient({ email: 'e', password: 'p', fetchImpl: f });
  await assert.rejects(c.login(), isCloudNotAuth);
});

test('login with an empty 200 body is a CloudError, not an AuthError', async () => {
  const f = fakeFetch([['/auth/login', 200, '']]);
  const c = new CloudClient({ email: 'e', password: 'p', fetchImpl: f });
  await assert.rejects(c.login(), isCloudNotAuth);
});

test('login with a 500 JSON body is a CloudError, not an AuthError', async () => {
  const f = fakeFetch([['/auth/login', 500, { msg: 'boom' }]]);
  const c = new CloudClient({ email: 'e', password: 'p', fetchImpl: f });
  await assert.rejects(c.login(), isCloudNotAuth);
});

test('a failed login keeps the existing tokens', async () => {
  const f = fakeFetch([['/auth/login', 200, { errorCode: '0051002' }]]);
  const c = new CloudClient({ email: 'e', password: 'p', fetchImpl: f, tokens: { ...STORED } });
  const pending = c.login();
  assert.deepStrictEqual(c.tokens, STORED);
  await assert.rejects(pending, AuthError);
  assert.deepStrictEqual(c.tokens, STORED);
  assert.strictEqual(f.calls[0].opts.headers.Authorization, undefined);
});

test('after an AuthError, login is refused without network for 15 minutes, then retried', async () => {
  let t = 1000000;
  const f = fakeFetch([['/auth/login', 200, { errorCode: '0051002', msg: 'wrong' }]]);
  const c = new CloudClient({ email: 'e', password: 'p', fetchImpl: f, now: () => t });
  let first;
  await assert.rejects(c.login(), (err) => { first = err; return err instanceof AuthError; });
  assert.strictEqual(f.calls.length, 1);

  t += 14 * 60 * 1000;
  await assert.rejects(c.login(), (err) => err === first);
  assert.strictEqual(f.calls.length, 1);

  t += 2 * 60 * 1000;
  await assert.rejects(c.login(), AuthError);
  assert.strictEqual(f.calls.length, 2);
});

test('a CloudError at login is not remembered', async () => {
  const f = fakeFetch([['/auth/login', 503, '<html></html>']]);
  const c = new CloudClient({ email: 'e', password: 'p', fetchImpl: f });
  await assert.rejects(c.login(), isCloudNotAuth);
  await assert.rejects(c.login(), isCloudNotAuth);
  assert.strictEqual(f.calls.length, 2);
});

test('two concurrent calls with no tokens cause exactly one login request', async () => {
  const f = fakeFetch([
    ['/auth/login', 200, OK_LOGIN],
    ['/app/devices', 200, { errorCode: '0', data: [{ deviceId: '42' }] }],
  ]);
  const c = new CloudClient({ email: 'e', password: 'p', fetchImpl: f });
  const [a, b] = await Promise.all([c.getDevices(), c.getDevices()]);
  assert.deepStrictEqual(a, [{ deviceId: '42' }]);
  assert.deepStrictEqual(b, [{ deviceId: '42' }]);
  assert.strictEqual(f.calls.filter((call) => call.url.includes('/auth/login')).length, 1);
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

test('getDevices throws CloudError on a 500 with a JSON body and no errorCode', async () => {
  const f = fakeFetch([['/app/devices', 500, { msg: 'boom' }]]);
  const c = new CloudClient({ email: 'e', password: 'p', fetchImpl: f, tokens: { ...STORED } });
  await assert.rejects(c.getDevices(), isCloudNotAuth);
});

test('sendCommand returns the reply hex', async () => {
  const f = fakeFetch([
    ['/devices/commands/42', 200, { errorCode: '0', data: { data: 'aa00' } }],
  ]);
  const c = new CloudClient({ email: 'e', password: 'p', fetchImpl: f, tokens: { ...STORED } });
  assert.strictEqual(await c.sendCommand('42', 'AA', 10), 'aa00');
  assert.deepStrictEqual(JSON.parse(f.calls[0].opts.body), { data: 'AA', waitTimeoutInSeconds: 10 });
});

test('sendCommand returns null when the reply has no data string', async () => {
  const f = fakeFetch([['/devices/commands/42', 200, { errorCode: '0', data: {} }]]);
  const c = new CloudClient({ email: 'e', password: 'p', fetchImpl: f, tokens: { ...STORED } });
  assert.strictEqual(await c.sendCommand('42', 'AA'), null);
});

test('sendCommand encodes the device id in the URL', async () => {
  const f = fakeFetch([['/devices/commands/', 200, { errorCode: '0', data: { data: 'aa' } }]]);
  const c = new CloudClient({ email: 'e', password: 'p', fetchImpl: f, tokens: { ...STORED } });
  await c.sendCommand('a/b c', 'AA');
  assert.match(f.calls[0].url, /\/devices\/commands\/a%2Fb%20c$/);
});

test('sendCommand maps the device timeout code', async () => {
  const f = fakeFetch([['/devices/commands/42', 200, { errorCode: '0080005', msg: 'timeout' }]]);
  const c = new CloudClient({ email: 'e', password: 'p', fetchImpl: f, tokens: { ...STORED } });
  await assert.rejects(c.sendCommand('42', 'AA'), DeviceTimeoutError);
});

test('a 401 triggers a token refresh and one retry with the new token', async () => {
  const f = fakeFetch([
    ['/auth/refresh-token', 200, { errorCode: '0', data: { accessToken: 'A2', refreshToken: 'R2' } }],
    ['/app/devices', 0, (n) => (n === 1 ? [401, {}] : [200, { errorCode: '0', data: [] }])],
  ]);
  const saved = [];
  const c = new CloudClient({ email: 'e', password: 'p', fetchImpl: f, tokens: { ...STORED },
    onTokens: (t) => saved.push(t) });
  assert.deepStrictEqual(await c.getDevices(), []);

  const urls = f.calls.map((call) => call.url);
  assert.strictEqual(urls.filter((u) => u.includes('/app/devices')).length, 2);
  const refreshCall = f.calls.find((call) => call.url.includes('/auth/refresh-token'));
  assert.ok(refreshCall, 'refresh endpoint was called');
  assert.match(refreshCall.url, /refreshToken=R1/);
  const deviceCalls = f.calls.filter((call) => call.url.includes('/app/devices'));
  assert.strictEqual(deviceCalls[0].opts.headers.Authorization, 'Bearer A1');
  assert.strictEqual(deviceCalls[1].opts.headers.Authorization, 'Bearer A2');
  assert.deepStrictEqual(saved, [{ accessToken: 'A2', refreshToken: 'R2', region: 'global' }]);
});

test('a failed refresh falls back to a full login', async () => {
  const f = fakeFetch([
    ['/auth/refresh-token', 401, {}],
    ['/auth/login', 200, { errorCode: '0', data: { accessToken: 'A3', refreshToken: 'R3' } }],
    ['/app/devices', 0, (n) => (n === 1 ? [401, {}] : [200, { errorCode: '0', data: [{ deviceId: '7' }] }])],
  ]);
  const c = new CloudClient({ email: 'e', password: 'p', fetchImpl: f, tokens: { ...STORED } });
  assert.deepStrictEqual(await c.getDevices(), [{ deviceId: '7' }]);
  assert.ok(f.calls.some((call) => call.url.includes('/auth/refresh-token')));
  assert.ok(f.calls.some((call) => call.url.includes('/auth/login')));
  const deviceCalls = f.calls.filter((call) => call.url.includes('/app/devices'));
  assert.strictEqual(deviceCalls[1].opts.headers.Authorization, 'Bearer A3');
});

test('concurrent 401s share one refresh', async () => {
  const f = fakeFetch([
    ['/auth/refresh-token', 200, { errorCode: '0', data: { accessToken: 'A2', refreshToken: 'R2' } }],
    ['/app/devices', 0, () => [200, { errorCode: '0', data: [] }]],
  ]);
  const base = f;
  let first = 0;
  const impl = async (url, opts) => {
    if (String(url).includes('/app/devices') && opts.headers.Authorization === 'Bearer A1') {
      first += 1;
      base.calls.push({ url: String(url), opts });
      return { status: 401, json: async () => null };
    }
    return base(url, opts);
  };
  const c = new CloudClient({ email: 'e', password: 'p', fetchImpl: impl, tokens: { ...STORED } });
  await Promise.all([c.getDevices(), c.getDevices()]);
  assert.strictEqual(first, 2);
  assert.strictEqual(base.calls.filter((call) => call.url.includes('/auth/refresh-token')).length, 1);
});
