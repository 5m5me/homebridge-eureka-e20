'use strict';
// The Matter robot vacuum accessory: owns the accessory object, its command
// handlers and its state pushes. Everything Matter specific arrives through
// the `matter` object passed in (api.matter).
const crypto = require('node:crypto');
const { buildClusters, CLEAN_MODE, RUN_MODE } = require('./matter-state');

const NOOP_LOG = { debug() {}, info() {}, warn() {} };

// Deterministic UUID used only when matter.uuid is missing and none is injected.
function defaultUuidGenerate(text) {
  const h = crypto.createHash('sha1').update(text).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const validCleanMode = (m) => m === CLEAN_MODE.VACUUM || m === CLEAN_MODE.VACUUM_AND_MOP;

class MatterVacuum {
  constructor({
    matter, robot, log, pluginName, platformName, deviceId, name, maxAgeMs,
    cleanModes, mopWater, run, uuidGenerate, defer,
  }) {
    this.matter = matter;
    this.robot = robot;
    this.log = log || NOOP_LOG;
    this.pluginName = pluginName;
    this.platformName = platformName;
    this.deviceId = deviceId;
    this.name = name;
    this.maxAgeMs = maxAgeMs;
    this.cleanModes = Boolean(cleanModes);
    this.mopWater = mopWater;
    this.run = run;
    // Runs a function on a later turn of the event loop. Injectable for tests.
    this.defer = defer || ((fn) => setImmediate(fn));
    this.uuidGenerate = uuidGenerate || defaultUuidGenerate;
    this.accessory = null;
    this.selectedCleanMode = CLEAN_MODE.VACUUM;
    this._last = new Map();
    this._chains = new Map();
    this._published = false;
  }

  _uuid() {
    const text = 'eureka-e20-matter:' + this.deviceId;
    const gen = this.matter && this.matter.uuid && typeof this.matter.uuid.generate === 'function'
      ? (s) => this.matter.uuid.generate(s)
      : this.uuidGenerate;
    return gen(text);
  }

  _clusters() {
    return buildClusters({
      state: this.robot.state,
      fresh: this.robot.isFresh(this.maxAgeMs()),
      selectedCleanMode: this.selectedCleanMode,
      cleanModes: this.cleanModes,
    });
  }

  // Every handler pushes state afterwards, whether it worked or not. Homebridge
  // writes currentMode itself once a changeToMode handler resolves, so a forced
  // push is also scheduled for a later turn. It lands after that write and puts
  // the tile back to what the robot really reports.
  _wrap(fn) {
    return async (request) => {
      try {
        return await fn(request);
      } finally {
        this.push();
        this._pushLater();
      }
    };
  }

  _pushLater() {
    try {
      this.defer(() => this.push(true));
    } catch (err) {
      this.log.debug(`Could not schedule a vacuum state update: ${err && err.message}`);
    }
  }

  _handlers() {
    const handlers = {
      rvcRunMode: {
        changeToMode: this._wrap(async ({ newMode } = {}) => {
          if (newMode === RUN_MODE.CLEANING) {
            if (!this.cleanModes) return this.run(() => this.robot.start());
            const water = this.selectedCleanMode === CLEAN_MODE.VACUUM_AND_MOP ? this.mopWater : 0;
            return this.run(() => this.robot.start({ water }));
          }
          if (newMode === RUN_MODE.IDLE) return this.run(() => this.robot.dock());
          throw new Error(`Unsupported run mode ${newMode}`);
        }),
      },
      rvcOperationalState: {
        pause: this._wrap(() => this.run(() => this.robot.pause())),
        resume: this._wrap(() => this.run(() => this.robot.resume())),
        goHome: this._wrap(() => this.run(() => this.robot.dock())),
      },
    };
    if (this.cleanModes) {
      handlers.rvcCleanMode = {
        changeToMode: this._wrap(async ({ newMode } = {}) => {
          if (!validCleanMode(newMode)) throw new Error(`Unsupported clean mode ${newMode}`);
          this.selectedCleanMode = newMode;
        }),
      };
    }
    return handlers;
  }

  async publish() {
    const deviceType = this.matter && this.matter.deviceTypes && this.matter.deviceTypes.RoboticVacuumCleaner;
    if (!deviceType) {
      throw new Error('This Homebridge does not offer the Matter RoboticVacuumCleaner device type, so the vacuum tile cannot be published');
    }
    const clusters = this._clusters();
    const fields = {
      displayName: this.name,
      deviceType,
      serialNumber: this.deviceId,
      manufacturer: 'Eureka',
      model: 'E20 Plus',
      clusters,
      handlers: this._handlers(),
    };
    // A robot vacuum is an external accessory on its own Matter server. Homebridge
    // does not restore it from cache, so it is registered on every start and the
    // clusters given here are its starting state.
    this.accessory = Object.assign({ UUID: this._uuid() }, fields, { context: { deviceId: this.deviceId } });
    this._remember(clusters);
    await this.matter.registerPlatformAccessories(this.pluginName, this.platformName, [this.accessory]);
    // Registering resolves even when Homebridge failed to publish the external
    // accessory (the failure is only logged), so check that it really exists.
    if (typeof this.matter.getAccessoryState === 'function') {
      let state;
      try {
        state = await this.matter.getAccessoryState(this.accessory.UUID, 'rvcRunMode');
      } catch (err) {
        state = undefined;
      }
      if (state === undefined) {
        throw new Error('The vacuum tile could not be published (Homebridge did not start its Matter server, see the Homebridge log for the reason)');
      }
    }
    this._published = true;
    // Changes made while registering are sent now.
    this.push();
  }

  _remember(clusters) {
    this._last.clear();
    for (const [name, attrs] of Object.entries(clusters)) this._last.set(name, JSON.stringify(attrs));
  }

  // Never throws. Sends only the clusters that changed since the last push, or
  // every cluster when `force` is true.
  push(force) {
    if (!this.accessory || !this._published) return;
    let clusters;
    try {
      clusters = this._clusters();
    } catch (err) {
      this.log.debug(`Could not compute the vacuum state: ${err && err.message}`);
      return;
    }
    for (const [name, attrs] of Object.entries(clusters)) {
      const sig = JSON.stringify(attrs);
      if (!force && this._last.get(name) === sig) continue;
      this._last.set(name, sig);
      // One chain per cluster keeps updates for that cluster in order.
      const prev = this._chains.get(name) || Promise.resolve();
      const next = prev
        .then(() => this.matter.updateAccessoryState(this.accessory.UUID, name, attrs))
        .catch((err) => this.log.debug(`Matter state update for ${name} failed: ${err && err.message}`));
      this._chains.set(name, next);
    }
  }

  async unpublish() {
    if (!this.accessory) return;
    await this.matter.unregisterPlatformAccessories(this.pluginName, this.platformName, [this.accessory]);
  }
}

module.exports = { MatterVacuum };
