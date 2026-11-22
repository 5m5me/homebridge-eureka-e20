'use strict';
// Client for the Eureka app cloud (mzrobo.com). Undocumented API, based on community
// reverse engineering of the mobile app.
const crypto = require('node:crypto');

const CLIENT_ID = '1301';
const HOSTS = {
  global: 'https://global.mzrobo.com',
  eu: 'https://euprod.mzrobo.com',
  na: 'https://naprod.mzrobo.com',
};
const REGIONS = Object.keys(HOSTS);
const WRONG_REGION = ['0051204', '0051213'];
const BAD_CREDENTIALS = ['0051001', '0051002', '0051004'];
const DEVICE_TIMEOUT = '0080005';
const AUTH_RETRY_WINDOW_MS = 15 * 60 * 1000;

class CloudError extends Error {}
class AuthError extends CloudError {}
class DeviceTimeoutError extends CloudError {}

const isOk = (status) => status >= 200 && status < 300;
const isRegion = (region) => REGIONS.includes(region);
// Error code as a string, or null when the reply carries none (0 and '0' mean success).
function codeOf(d) {
  if (!d || typeof d !== 'object' || d.errorCode === undefined || d.errorCode === null) return null;
  const code = String(d.errorCode);
  return code === '' || code === '0' ? null : code;
}

class CloudClient {
  constructor({ email, password, fetchImpl, tokens, onTokens, now }) {
    this.email = email;
    this.password = password;
    this.fetch = fetchImpl || globalThis.fetch;
    this.tokens = tokens || null;
    this.onTokens = onTokens || (() => {});
    this.now = now || Date.now;
    this._inflight = null; // shared promise for the running login or refresh
    this._authFailure = null; // { error, until } after a rejected login
  }

  _headers(withAuth) {
    const h = {
      'Accept-Language': 'en',
      nonce: crypto.randomUUID().replace(/-/g, ''),
      'x-platform': 'Android29',
      'x-app-version': '1.2.1.26101001',
      'x-app-env': 'prod',
      'x-timezone-id': 'UTC',
      'Content-Type': 'application/json',
      'User-Agent': 'okhttp/4.10.0',
    };
    if (withAuth && this.tokens) h.Authorization = `Bearer ${this.tokens.accessToken}`;
    return h;
  }

  async _raw(method, url, body, timeoutMs = 15000, withAuth = true) {
    let res;
    try {
      res = await this.fetch(url, {
        method, headers: this._headers(withAuth),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new CloudError(`Cannot reach the Eureka cloud: ${err.message}`);
    }
    if (res.status === 401) return { status: 401, data: null };
    let data = null;
    try { data = await res.json(); } catch { /* callers treat a missing body as a bad reply */ }
    return { status: res.status, data };
  }

  _setTokens(data, region) {
    this.tokens = {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken || (this.tokens && this.tokens.refreshToken) || null,
      region,
    };
    this.onTokens(this.tokens);
  }

  // Run fn as the single in-flight login/refresh attempt; concurrent callers share it.
  _serialise(fn) {
    if (!this._inflight) {
      const p = fn();
      this._inflight = p;
      const clear = () => { if (this._inflight === p) this._inflight = null; };
      p.then(clear, clear);
    }
    return this._inflight;
  }

  login() {
    return this._serialise(() => this._login());
  }

  async _login() {
    if (this._authFailure) {
      if (this.now() < this._authFailure.until) throw this._authFailure.error;
      this._authFailure = null;
    }
    try {
      await this._tryRegions();
      this._authFailure = null;
    } catch (err) {
      if (err instanceof AuthError) {
        this._authFailure = { error: err, until: this.now() + AUTH_RETRY_WINDOW_MS };
      }
      throw err;
    }
  }

  async _tryRegions() {
    const hint = this.tokens && isRegion(this.tokens.region) ? this.tokens.region : null;
    const regions = [...new Set([hint, ...REGIONS].filter(Boolean))];
    let answered = false;
    for (const region of regions) {
      let out;
      try {
        out = await this._raw('POST', `${HOSTS[region]}/auth/login/email-password?clientId=${CLIENT_ID}`,
          { email: this.email, password: this.password }, undefined, false);
      } catch {
        continue; // network failure for this region
      }
      answered = true;
      const d = out.data;
      const code = codeOf(d);
      if (out.status === 401) throw new AuthError('Login rejected');
      if (code && WRONG_REGION.includes(code)) continue;
      if (code && BAD_CREDENTIALS.includes(code)) throw new AuthError(d.msg || 'Wrong email or password');
      if (!isOk(out.status)) throw new CloudError(`Login failed (HTTP ${out.status})`);
      if (!d || typeof d !== 'object') throw new CloudError('Unexpected login reply from the Eureka cloud');
      if (code) throw new CloudError(`Login failed (${code})`);
      if (!d.data || !d.data.accessToken) throw new CloudError('Login reply had no token');
      this._setTokens(d.data, region);
      return;
    }
    if (!answered) throw new CloudError('The Eureka cloud cannot be reached');
    throw new AuthError('Account not found in any region');
  }

  // Refresh the token that just got a 401, or fall back to a full login. Shared between callers.
  _renew(usedAccessToken) {
    return this._serialise(async () => {
      const t = this.tokens;
      if (t && t.accessToken !== usedAccessToken) return; // someone already renewed it
      if (t && t.refreshToken && isRegion(t.region)) {
        const out = await this._raw('GET',
          `${HOSTS[t.region]}/auth/refresh-token?refreshToken=${encodeURIComponent(t.refreshToken)}`);
        const d = out.data;
        if (isOk(out.status) && !codeOf(d) && d && d.data && d.data.accessToken) {
          this._setTokens(d.data, t.region);
          return;
        }
      }
      await this._login();
    });
  }

  _host() {
    return this.tokens && isRegion(this.tokens.region) ? HOSTS[this.tokens.region] : null;
  }

  async _request(method, path, body, timeoutMs) {
    if (!this._host()) await this.login();
    if (!this._host()) throw new CloudError('Not logged in to the Eureka cloud');
    const used = this.tokens.accessToken;
    let out = await this._raw(method, this._host() + path, body, timeoutMs);
    if (out.status === 401) {
      await this._renew(used);
      if (!this._host()) throw new CloudError('Not logged in to the Eureka cloud');
      out = await this._raw(method, this._host() + path, body, timeoutMs);
      if (out.status === 401) throw new AuthError('Authentication failed after token refresh');
    }
    const d = out.data;
    const code = codeOf(d);
    if (code) {
      if (code === DEVICE_TIMEOUT) throw new DeviceTimeoutError('The robot did not answer');
      throw new CloudError(`Cloud error ${code}: ${d.reason || d.msg || 'unknown'}`);
    }
    if (!isOk(out.status)) throw new CloudError(`Eureka cloud request failed (HTTP ${out.status})`);
    if (!d || typeof d !== 'object') throw new CloudError('Unexpected reply from the Eureka cloud');
    return d.data;
  }

  async getDevices() {
    const data = await this._request('GET', '/app/devices?version=1&isShared=false');
    if (Array.isArray(data)) return data;
    for (const key of ['list', 'devices', 'items', 'data']) {
      if (data && Array.isArray(data[key])) return data[key];
    }
    return [];
  }

  async sendCommand(deviceId, hex, waitSeconds = 10) {
    const data = await this._request('POST', `/devices/commands/${encodeURIComponent(deviceId)}`,
      { data: hex, waitTimeoutInSeconds: waitSeconds }, (waitSeconds + 15) * 1000);
    return data && typeof data.data === 'string' ? data.data : null;
  }
}

module.exports = { CloudClient, CloudError, AuthError, DeviceTimeoutError };
