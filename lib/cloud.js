'use strict';
// Client for the Eureka app cloud (mzrobo.com). Undocumented API, reverse engineered by
// the ha-eureka-robotcleaner project; confirmed against Ned's account on 2026-11-22.
const crypto = require('node:crypto');

const CLIENT_ID = '1301';
const HOSTS = {
  global: 'https://global.mzrobo.com',
  eu: 'https://euprod.mzrobo.com',
  na: 'https://naprod.mzrobo.com',
};
const WRONG_REGION = ['0051204', '0051213'];
const BAD_CREDENTIALS = ['0051001', '0051002', '0051004'];
const DEVICE_TIMEOUT = '0080005';

class CloudError extends Error {}
class AuthError extends CloudError {}
class DeviceTimeoutError extends CloudError {}

class CloudClient {
  constructor({ email, password, fetchImpl, tokens, onTokens }) {
    this.email = email;
    this.password = password;
    this.fetch = fetchImpl || globalThis.fetch;
    this.tokens = tokens || null;
    this.onTokens = onTokens || (() => {});
  }

  _headers() {
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
    if (this.tokens) h.Authorization = `Bearer ${this.tokens.accessToken}`;
    return h;
  }

  async _raw(method, url, body, timeoutMs = 15000) {
    let res;
    try {
      res = await this.fetch(url, {
        method, headers: this._headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new CloudError(`Cannot reach the Eureka cloud: ${err.message}`);
    }
    if (res.status === 401) return { status: 401, data: null };
    let data = null;
    try { data = await res.json(); } catch (err) { /* handled by caller as bad response */ }
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

  async login() {
    const first = this.tokens && this.tokens.region;
    const regions = [...new Set([first, 'global', 'eu', 'na'].filter(Boolean))];
    this.tokens = null;
    for (const region of regions) {
      let out;
      try {
        out = await this._raw('POST', `${HOSTS[region]}/auth/login/email-password?clientId=${CLIENT_ID}`,
          { email: this.email, password: this.password });
      } catch (err) { continue; }
      const d = out.data;
      if (out.status === 401 || !d || typeof d !== 'object') throw new AuthError('Login rejected');
      if (WRONG_REGION.includes(d.errorCode)) continue;
      if (BAD_CREDENTIALS.includes(d.errorCode)) throw new AuthError(d.msg || 'Wrong email or password');
      if (d.errorCode && d.errorCode !== '0') throw new CloudError(`Login failed (${d.errorCode})`);
      if (!d.data || !d.data.accessToken) throw new CloudError('Login reply had no token');
      this._setTokens(d.data, region);
      return;
    }
    throw new AuthError('Account not found in any region');
  }

  async _refresh() {
    const region = this.tokens.region;
    if (this.tokens.refreshToken) {
      const out = await this._raw('GET',
        `${HOSTS[region]}/auth/refresh-token?refreshToken=${encodeURIComponent(this.tokens.refreshToken)}`);
      const d = out.data;
      if (out.status !== 401 && d && (d.errorCode === undefined || d.errorCode === '0')
          && d.data && d.data.accessToken) {
        this._setTokens(d.data, region);
        return;
      }
    }
    await this.login();
  }

  async _request(method, path, body, timeoutMs) {
    if (!this.tokens) await this.login();
    let out = await this._raw(method, HOSTS[this.tokens.region] + path, body, timeoutMs);
    if (out.status === 401) {
      await this._refresh();
      out = await this._raw(method, HOSTS[this.tokens.region] + path, body, timeoutMs);
      if (out.status === 401) throw new AuthError('Authentication failed after token refresh');
    }
    const d = out.data;
    if (!d || typeof d !== 'object') throw new CloudError('Unexpected reply from the Eureka cloud');
    if (d.errorCode && d.errorCode !== '0') {
      if (d.errorCode === DEVICE_TIMEOUT) throw new DeviceTimeoutError('The robot did not answer');
      throw new CloudError(`Cloud error ${d.errorCode}: ${d.reason || d.msg || 'unknown'}`);
    }
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
    const data = await this._request('POST', `/devices/commands/${deviceId}`,
      { data: hex, waitTimeoutInSeconds: waitSeconds }, (waitSeconds + 15) * 1000);
    return data && typeof data.data === 'string' ? data.data : null;
  }
}

module.exports = { CloudClient, CloudError, AuthError, DeviceTimeoutError };
