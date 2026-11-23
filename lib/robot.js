'use strict';
const { EventEmitter } = require('node:events');
const { FRAMES, startFrame, parseStatus, statusName } = require('./protocol');

// Seconds the cloud client waits for the robot to answer a command.
const WAIT_SECONDS = 10;
// Confirmation polling after a control command: up to 4 polls, 2 s apart.
const CONFIRM_POLLS = 4;
const CONFIRM_DELAY_MS = 2000;

const EXPECTED_START = ['cleaning', 'moving'];
const EXPECTED_PAUSE = ['paused'];
const EXPECTED_DOCK = ['returning', 'docked'];

class CommandUnconfirmedError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'CommandUnconfirmedError';
  }
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Emits 'state' on every successful poll and also when the robot becomes
// unreachable (with the last known state), so consumers must check
// `reachable` or `isFresh()` before trusting the state.
class Robot extends EventEmitter {
  constructor({ cloud, deviceId, log, now, sleep }) {
    super();
    this.cloud = cloud;
    this.deviceId = deviceId;
    this.log = log || { debug() {}, warn() {} };
    this.now = now || Date.now;
    this.sleep = sleep || realSleep;
    this.state = null;
    this.reachable = false;
    this._tail = Promise.resolve();
  }

  isFresh(maxAgeMs) {
    return this.reachable && this.state !== null && this.now() - this.state.at <= maxAgeMs;
  }

  // Run operations one at a time, in call order. A failure does not block the next.
  _enqueue(fn) {
    const run = this._tail.then(fn);
    this._tail = run.catch(() => {});
    return run;
  }

  poll() { return this._enqueue(() => this._pollNow()); }

  async _pollNow() {
    let state;
    try {
      const reply = await this.cloud.sendCommand(this.deviceId, FRAMES.queryStatus, WAIT_SECONDS);
      const s = parseStatus(reply);
      if (!s) throw new Error('The robot did not return a valid status');
      const status = statusName(s.workStatus, s.battery);
      state = {
        status, workStatus: s.workStatus, battery: s.battery, fan: s.fan, water: s.water,
        fault: status === 'error' || s.faultClass === 1 || s.faultClass === 2,
        faultClass: s.faultClass, faultCode: s.faultCode, at: this.now(),
      };
    } catch (err) {
      this.reachable = false;
      this.emit('state', this.state);
      throw err;
    }
    this.state = state;
    this.reachable = true;
    this.emit('state', this.state);
    return this.state;
  }

  // Send a control command and confirm it by polling status. The reply to the
  // command itself is not used as proof either way.
  async _command(name, hex, expected) {
    // sendCommand throws if the cloud rejects it or the robot does not answer in time.
    this.log.debug(`Sending ${name} command`);
    await this.cloud.sendCommand(this.deviceId, hex, WAIT_SECONDS);

    let lastStatus = null;
    let lastError = null;
    for (let i = 0; i < CONFIRM_POLLS; i++) {
      if (i > 0) await this.sleep(CONFIRM_DELAY_MS);
      try {
        const s = await this._pollNow();
        lastStatus = s.status;
        if (expected.includes(s.status)) return s;
      } catch (err) {
        lastError = err;
      }
    }

    let error;
    if (lastStatus === null) {
      error = new CommandUnconfirmedError(
        `The ${name} command was sent but the robot status is unknown`, { cause: lastError });
    } else {
      error = new CommandUnconfirmedError(
        `The robot did not confirm the ${name} command (it reported status: ${lastStatus})`);
    }
    this.log.warn(error.message);
    throw error;
  }

  // options.water: optional integer 0 to 3 mop water override; anything else is ignored.
  start(options) {
    const override = options && options.water;
    return this._enqueue(async () => {
      const state = await this._pollNow();
      if (EXPECTED_START.includes(state.status)) return state;
      if (state.status === 'paused') return this._command('resume', FRAMES.resume, EXPECTED_START);
      const fan = Number.isInteger(state.fan) && state.fan >= 1 && state.fan <= 4 ? state.fan : 2;
      const waterValid = (w) => Number.isInteger(w) && w >= 0 && w <= 3;
      const water = waterValid(override) ? override
        : Number.isInteger(state.water) && state.water >= 0 && state.water <= 3 ? state.water : 0;
      const confirmed = await this._command('start', startFrame(fan, water), EXPECTED_START);
      // A start that was sent with an explicit water value must show that value.
      if (waterValid(override) && Number.isInteger(confirmed.water) && confirmed.water !== water) {
        this.log.warn(`The robot started with mop water ${confirmed.water} but ${water} was sent`);
      }
      return confirmed;
    });
  }

  // Only ever resumes a paused robot. Anything else sends nothing.
  resume() {
    return this._enqueue(async () => {
      const state = await this._pollNow();
      if (state.status !== 'paused') return state;
      return this._command('resume', FRAMES.resume, EXPECTED_START);
    });
  }

  pause() { return this._enqueue(() => this._command('pause', FRAMES.pause, EXPECTED_PAUSE)); }

  dock() {
    return this._enqueue(async () => {
      const state = await this._pollNow();
      if (EXPECTED_DOCK.includes(state.status)) return state;
      return this._command('dock', FRAMES.dock, EXPECTED_DOCK);
    });
  }
}

module.exports = { Robot, CommandUnconfirmedError };
