'use strict';
// Pure mapping from robot state to Matter cluster state. No I/O.

const RUN_MODE = Object.freeze({ IDLE: 0, CLEANING: 1 });
const CLEAN_MODE = Object.freeze({ VACUUM: 0, VACUUM_AND_MOP: 2 });
const OP_STATE = Object.freeze({
  STOPPED: 0, RUNNING: 1, PAUSED: 2, ERROR: 3, SEEKING_CHARGER: 64, CHARGING: 65, DOCKED: 66,
});
const OP_ERROR = Object.freeze({ NO_ERROR: 0, UNABLE_TO_COMPLETE: 2 });
const POWER_STATUS = Object.freeze({ ACTIVE: 1, UNAVAILABLE: 3 });
const CHARGE_STATE = Object.freeze({ UNKNOWN: 0, IS_CHARGING: 1, IS_AT_FULL_CHARGE: 2, IS_NOT_CHARGING: 3 });

const ACTIVE_STATUSES = ['cleaning', 'moving', 'paused'];

function cleanModeFromWater(water) {
  return water >= 1 ? CLEAN_MODE.VACUUM_AND_MOP : CLEAN_MODE.VACUUM;
}

function runModes() {
  return [
    { label: 'Idle', mode: RUN_MODE.IDLE, modeTags: [{ value: 16384 }] },
    { label: 'Cleaning', mode: RUN_MODE.CLEANING, modeTags: [{ value: 16385 }] },
  ];
}

function cleanModeList() {
  return [
    { label: 'Vacuum', mode: CLEAN_MODE.VACUUM, modeTags: [{ value: 16385 }] },
    { label: 'Vacuum and mop', mode: CLEAN_MODE.VACUUM_AND_MOP, modeTags: [{ value: 16385 }, { value: 16386 }] },
  ];
}

function operationalStateId(state, usable) {
  if (!usable || state.status === 'error' || state.fault === true) return OP_STATE.ERROR;
  switch (state.status) {
    case 'cleaning':
    case 'moving': return OP_STATE.RUNNING;
    case 'paused': return OP_STATE.PAUSED;
    case 'returning': return OP_STATE.SEEKING_CHARGER;
    case 'docked': return isFinished(state) ? OP_STATE.DOCKED : OP_STATE.CHARGING;
    default: return OP_STATE.STOPPED;
  }
}

function isFinished(state) {
  return state.workStatus === 6 || state.battery >= 100;
}

function powerSource(state, usable) {
  const base = {
    order: 0,
    description: 'Battery',
    batReplacementNeeded: false,
    batReplaceability: 0,
    batFunctionalWhileCharging: true,
    batPresent: true,
  };
  if (!usable) {
    return Object.assign(base, {
      status: POWER_STATUS.UNAVAILABLE,
      batPercentRemaining: null,
      batChargeLevel: 0,
      batChargeState: CHARGE_STATE.UNKNOWN,
    });
  }
  const known = Number.isFinite(state.battery);
  const pct = known ? Math.min(100, Math.max(0, state.battery)) : null;
  let level = 0;
  if (pct !== null) level = pct < 10 ? 2 : pct < 20 ? 1 : 0;
  let charge;
  if (state.status !== 'docked') charge = CHARGE_STATE.IS_NOT_CHARGING;
  else charge = isFinished(state) ? CHARGE_STATE.IS_AT_FULL_CHARGE : CHARGE_STATE.IS_CHARGING;
  return Object.assign(base, {
    status: POWER_STATUS.ACTIVE,
    batPercentRemaining: pct === null ? null : Math.round(pct * 2),
    batChargeLevel: level,
    batChargeState: charge,
  });
}

function buildClusters({ state, fresh, selectedCleanMode, cleanModes }) {
  const usable = Boolean(fresh) && state != null;
  const active = usable && ACTIVE_STATUSES.includes(state.status);
  const id = operationalStateId(state, usable);

  const clusters = {
    rvcRunMode: {
      supportedModes: runModes(),
      currentMode: active ? RUN_MODE.CLEANING : RUN_MODE.IDLE,
    },
    rvcOperationalState: {
      phaseList: null,
      currentPhase: null,
      operationalStateList: [0, 1, 2, 3, 64, 65, 66].map((operationalStateId) => ({ operationalStateId })),
      operationalState: id,
      operationalError: { errorStateId: id === OP_STATE.ERROR ? OP_ERROR.UNABLE_TO_COMPLETE : OP_ERROR.NO_ERROR },
    },
  };
  if (cleanModes) {
    clusters.rvcCleanMode = {
      supportedModes: cleanModeList(),
      currentMode: active ? cleanModeFromWater(state.water) : selectedCleanMode,
    };
  }
  clusters.powerSource = powerSource(state, usable);
  return clusters;
}

module.exports = { buildClusters, cleanModeFromWater, RUN_MODE, CLEAN_MODE, OP_STATE };
