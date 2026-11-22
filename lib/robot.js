'use strict';
const { EventEmitter } = require('node:events');
const { FRAMES, startFrame, parseStatus, statusName } = require('./protocol');

class Robot extends EventEmitter {
  constructor({ cloud, deviceId, log, now }) {
    super();
    this.cloud = cloud;
    this.deviceId = deviceId;
    this.log = log || { debug() {}, warn() {} };
    this.now = now || Date.now;
    this.state = null;
    this.reachable = false;
  }

  isFresh(maxAgeMs) {
    return this.reachable && this.state !== null && this.now() - this.state.at <= maxAgeMs;
  }

  async poll() {
    try {
      const reply = await this.cloud.sendCommand(this.deviceId, FRAMES.queryStatus, 10);
      const s = parseStatus(reply);
      if (!s) throw new Error('The robot did not return a valid status');
      const status = statusName(s.workStatus, s.battery);
      this.state = {
        status, battery: s.battery, fan: s.fan, water: s.water,
        fault: status === 'error' || s.faultClass === 1 || s.faultClass === 2,
        faultClass: s.faultClass, faultCode: s.faultCode, at: this.now(),
      };
      this.reachable = true;
      this.emit('state', this.state);
      return this.state;
    } catch (err) {
      this.reachable = false;
      this.emit('state', this.state);
      throw err;
    }
  }

  async _command(hex) {
    // sendCommand throws if the cloud rejects it or the robot does not answer in time.
    await this.cloud.sendCommand(this.deviceId, hex, 10);
    return this.poll();
  }

  async start() {
    if (!this.state) await this.poll();
    if (this.state.status === 'paused') return this._command(FRAMES.resume);
    return this._command(startFrame(this.state.fan || 2, this.state.water));
  }

  pause() { return this._command(FRAMES.pause); }
  dock() { return this._command(FRAMES.dock); }
}

module.exports = { Robot };
