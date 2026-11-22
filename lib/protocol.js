'use strict';
// Midea B8 (robot vacuum) frames for the Eureka E20 Plus, legacy command family.
// Layout: AA <len> B8 00 00 00 00 00 00 <msgType> <body...> <checksum>
// len = 10 + body length. checksum = two's complement of the sum of every byte after AA.

const MSG_SETTING = 0x02;
const MSG_ACTION = 0x03;

function buildFrame(body, msgType = MSG_SETTING) {
  const frame = [0xAA, 10 + body.length, 0xB8, 0, 0, 0, 0, 0, 0, msgType, ...body];
  const sum = frame.slice(1).reduce((a, b) => a + b, 0);
  frame.push((-sum) & 0xFF);
  return Buffer.from(frame).toString('hex').toUpperCase();
}

const FRAMES = Object.freeze({
  queryStatus: buildFrame([0x32, 0x01], MSG_ACTION),
  dock: buildFrame([0x22, 0x01]),
  stop: buildFrame([0x22, 0x03]),
  pause: buildFrame([0x22, 0x1B]),
  resume: buildFrame([0x22, 0x1C, 0x00]),
});

// Whole-home clean with the given suction (1 to 4) and mop water (0 to 3).
function startFrame(fan, water) {
  return buildFrame([0x22, 0x02, 0x00, 0x02, 0x00, 0x08, fan, 0x00, water, 0x00, 0x00]);
}

function parseStatus(hex) {
  if (typeof hex !== 'string' || !/^([0-9a-fA-F]{2})+$/.test(hex)) return null;
  const f = Buffer.from(hex, 'hex');
  if (f.length < 27 || f[0] !== 0xAA || f[1] !== f.length - 1 || f[2] !== 0xB8) return null;
  if ((f.subarray(1).reduce((a, b) => a + b, 0) & 0xFF) !== 0) return null;
  if (f[9] !== MSG_ACTION || f[10] !== 0x32 || f[11] !== 0x01) return null;
  return {
    workStatus: f[12], fan: f[17], water: f[19], battery: f[22],
    faultClass: f[25], faultCode: f[26],
  };
}

const STATUS = {
  1: 'returning', 2: 'cleaning', 3: 'idle', 4: 'docked', 5: 'idle', 6: 'docked', 7: 'docked',
  8: 'paused', 9: 'idle', 10: 'paused', 11: 'error', 12: 'docked', 13: 'docked', 14: 'moving',
  15: 'docked', 16: 'docked', 17: 'returning', 18: 'docked', 22: 'returning', 23: 'moving',
  24: 'paused',
};

// State 12 is power save: docked when full, otherwise sitting idle off the dock.
function statusName(workStatus, battery) {
  if (workStatus === 12 && battery !== 100) return 'idle';
  return STATUS[workStatus] || 'unknown';
}

module.exports = { buildFrame, FRAMES, startFrame, parseStatus, statusName };
