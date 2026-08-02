import * as THREE from 'three';
import { setExpression } from './build.js';

/**
 * PROCEDURAL ANIMATION.
 *
 * No imported clips — every pose here is arithmetic. The rules that matter:
 *
 *  - Reference observation #12: a creature is NEVER in a neutral idle. Idle is a
 *    weight-shift plus a scheduled stream of micro-gestures (ear flick, head cock, look,
 *    sniff, tail flick), each creature on its own phase and its own constant asymmetry
 *    bias, so no two ever share a pose or a facing in one frame.
 *  - Squash-and-stretch is the house style: the body stretches on the way up out of a
 *    hop and flattens on landing.
 *  - Ears and tails are never keyed directly — they are damped springs hanging off the
 *    head and hip motion, so they lag and overshoot for free.
 */

const KEYS = [
  'bodyY', 'hipsPitch', 'hipsYaw', 'hipsRoll', 'hipsSY',
  'spinePitch', 'spineYaw', 'spineRoll', 'spineSY',
  'headPitch', 'headYaw', 'headRoll',
  'earPitch', 'earSpread', 'earTip',
  'armLPitch', 'armRPitch', 'armSpread', 'armLYaw', 'armRYaw',
  'legLPitch', 'legRPitch', 'legSpread',
  'tailPitch', 'tailYaw', 'tailCurl',
];

function newPose() {
  const p = {};
  for (const k of KEYS) p[k] = 0;
  p.hipsSY = 1; p.spineSY = 1;
  return p;
}
function zero(p) { for (const k of KEYS) p[k] = 0; p.hipsSY = 1; p.spineSY = 1; return p; }
function lerpPose(a, b, t) { for (const k of KEYS) a[k] += (b[k] - a[k]) * t; return a; }

const TAU = Math.PI * 2;
const fract = (x) => x - Math.floor(x);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

class Spring {
  constructor(k = 150, d = 17) { this.x = 0; this.v = 0; this.k = k; this.d = d; }
  step(target, dt) {
    const a = (target - this.x) * this.k - this.v * this.d;
    this.v += a * dt;
    this.x += this.v * dt;
    if (!Number.isFinite(this.x)) { this.x = target; this.v = 0; }
    return this.x;
  }
}

/* ------------------------------------------------------------------- states */

function sIdle(c, t, o) {
  const b = c.bias, ph = c.ph;
  const br = Math.sin(t * 1.28 + ph[0]);
  o.spineSY = 1 + br * 0.028;
  o.bodyY = br * 0.008;
  const sw = Math.sin(t * 0.40 + ph[1]);
  o.hipsRoll = sw * 0.055 + b.roll;
  o.hipsYaw = Math.sin(t * 0.29 + ph[2]) * 0.075;
  o.spineRoll = -sw * 0.030 + b.roll * 0.4;
  o.spineYaw = Math.sin(t * 0.26 + ph[3]) * 0.065 + b.yaw;
  o.spinePitch = 0.02 + Math.sin(t * 0.47 + ph[4]) * 0.02;
  o.headRoll = sw * 0.055 + b.headRoll;
  o.headYaw = Math.sin(t * 0.22 + ph[4]) * 0.11 + b.headYaw;
  o.headPitch = -0.03 + Math.sin(t * 0.53 + ph[5]) * 0.045;
  o.armLPitch = 0.09 + Math.sin(t * 0.86 + ph[1]) * 0.06 + b.armL;
  o.armRPitch = 0.09 + Math.sin(t * 0.86 + ph[1] + 2.2) * 0.06 + b.armR;
  o.armSpread = 0.20 + sw * 0.045;
  o.earPitch = b.ear + Math.sin(t * 0.61 + ph[3]) * 0.035;
  o.earSpread = b.earSpread;
  o.tailPitch = -0.06 + Math.sin(t * 0.72 + ph[2]) * 0.10;
  o.tailYaw = Math.sin(t * 0.95 + ph[0]) * 0.18;
  o.legSpread = 0.05;
}

function sHop(c, t, o, spd) {
  const b = c.bias;
  const f = 1.15 + spd * 0.55;
  const p = fract(t * f + c.ph[0] * 0.2);
  const AIR = 0.60;
  const inAir = p < AIR;
  const a = inAir ? p / AIR : 0;
  const h = inAir ? Math.pow(Math.sin(Math.PI * a), 0.82) : 0;
  const land = inAir ? 0 : Math.sin(Math.PI * ((p - AIR) / (1 - AIR)));
  o.bodyY = h * (0.17 + spd * 0.045) - land * 0.045;
  const st = inAir ? Math.cos(Math.PI * a) : 0;          // +1 launch, -1 touchdown
  o.spineSY = 1 + Math.abs(st) * 0.10 * (inAir ? 1 : 0) - land * 0.14;
  o.hipsSY = 1 + Math.abs(st) * 0.05 - land * 0.10;
  o.spinePitch = 0.09 - st * 0.10 + land * 0.08;
  o.hipsPitch = -st * 0.06;
  o.headPitch = -0.10 + st * 0.14 - land * 0.10;
  o.headYaw = b.headYaw * 0.5 + Math.sin(t * 1.7) * 0.05;
  o.headRoll = b.headRoll * 0.5 + Math.sin(t * f * TAU * 0.5) * 0.04;
  const tuck = h * 1.05;
  o.legLPitch = tuck + land * -0.28;
  o.legRPitch = tuck * 0.92 + land * -0.24;
  o.legSpread = 0.10 + h * 0.12;
  o.armLPitch = -0.35 * h + 0.12 + b.armL;
  o.armRPitch = -0.30 * h + 0.12 + b.armR;
  o.armSpread = 0.34 + h * 0.26;
  o.earPitch = b.ear - h * 0.18;
  o.tailPitch = -0.25 - h * 0.30;
  o.tailYaw = Math.sin(t * f * TAU) * 0.16;
}

function sTrot(c, t, o, spd) {
  const b = c.bias;
  const f = 1.5 + spd * 0.95;
  const w = t * f * TAU;
  o.legLPitch = Math.sin(w) * (0.42 + spd * 0.13);
  o.legRPitch = Math.sin(w + Math.PI) * (0.42 + spd * 0.13);
  o.armLPitch = -Math.sin(w) * 0.34 + 0.10 + b.armL;
  o.armRPitch = -Math.sin(w + Math.PI) * 0.34 + 0.10 + b.armR;
  o.armSpread = 0.26;
  o.bodyY = Math.abs(Math.sin(w)) * 0.030 - 0.012;
  o.spineSY = 1 + Math.sin(w * 2) * 0.022;
  o.spinePitch = 0.08 + spd * 0.05;
  o.hipsRoll = Math.sin(w) * 0.055;
  o.spineRoll = -Math.sin(w) * 0.035;
  o.hipsYaw = Math.sin(w) * 0.05;
  o.headPitch = -0.06 - spd * 0.03 + Math.sin(w * 2) * 0.045;
  o.headRoll = Math.sin(w) * 0.05 + b.headRoll * 0.5;
  o.headYaw = b.headYaw * 0.4;
  o.earPitch = b.ear - 0.10 - spd * 0.05;
  o.tailPitch = -0.34 - spd * 0.10;
  o.tailYaw = Math.sin(w * 0.5) * 0.30;
  o.legSpread = 0.06;
}

function sQuad(c, t, o, spd) {
  const b = c.bias;
  const f = 1.05 + spd * 0.65;
  const w = t * f * TAU;
  o.legLPitch = Math.sin(w) * (0.30 + spd * 0.10);
  o.legRPitch = Math.sin(w + Math.PI) * (0.30 + spd * 0.10);
  o.armLPitch = Math.sin(w + Math.PI) * (0.28 + spd * 0.10);
  o.armRPitch = Math.sin(w) * (0.28 + spd * 0.10);
  o.bodyY = Math.abs(Math.sin(w * 2)) * 0.014 - 0.006;
  o.hipsRoll = Math.sin(w) * 0.045;
  o.spineRoll = Math.sin(w + 0.6) * 0.035;
  o.hipsYaw = Math.sin(w) * 0.055;
  o.spineYaw = Math.sin(w + 0.9) * 0.05 + b.yaw * 0.5;
  o.headPitch = 0.04 + Math.sin(w * 2 + 1.1) * 0.05;
  o.headYaw = Math.sin(w) * 0.06 + b.headYaw * 0.4;
  o.headRoll = Math.sin(w + 0.4) * 0.05;
  o.earPitch = b.ear + Math.sin(w * 2) * 0.06;
  o.tailYaw = Math.sin(w * 0.8) * 0.28;
  o.tailPitch = -0.05;
}

function sEat(c, t, o) {
  const b = c.bias;
  const dip = c.def.gait === 'quad' ? 0.24 : 0.62;
  const chew = Math.sin(t * 7.4);
  o.spinePitch = dip * 0.55;
  o.headPitch = dip + chew * 0.055;
  o.bodyY = -0.028;
  o.hipsPitch = -dip * 0.16;
  o.spineSY = 1 - 0.02 + chew * 0.012;
  o.headYaw = Math.sin(t * 0.9 + c.ph[1]) * 0.14;
  o.headRoll = Math.sin(t * 1.3) * 0.05 + b.headRoll;
  o.earPitch = b.ear + 0.22 + chew * 0.05;
  o.tailYaw = Math.sin(t * 3.1) * 0.34;
  o.tailPitch = -0.10;
  o.armLPitch = 0.20 + b.armL; o.armRPitch = 0.18 + b.armR;
  o.armSpread = 0.30;
  o.legSpread = 0.13;
}

function sSit(c, t, o) {
  const b = c.bias;
  const br = Math.sin(t * 1.0 + c.ph[0]);
  o.bodyY = -0.135;
  o.hipsPitch = -0.20;
  o.spinePitch = -0.05 + br * 0.02;
  o.spineSY = 1 + br * 0.026;
  o.spineRoll = b.roll * 0.6;
  o.headPitch = -0.05 + Math.sin(t * 0.4 + c.ph[2]) * 0.06;
  o.headYaw = Math.sin(t * 0.25 + c.ph[3]) * 0.16 + b.headYaw;
  o.headRoll = b.headRoll;
  o.legLPitch = 1.20; o.legRPitch = 1.14; o.legSpread = 0.30;
  o.armLPitch = 0.05 + b.armL; o.armRPitch = 0.05 + b.armR; o.armSpread = 0.30;
  o.earPitch = b.ear - 0.05;
  o.tailPitch = 0.15; o.tailYaw = Math.sin(t * 0.7) * 0.18;
}

function sSleep(c, t, o) {
  const br = Math.sin(t * 0.62);
  o.bodyY = -0.185;
  o.hipsPitch = -0.24;
  o.spinePitch = 0.20 + br * 0.035;
  o.spineSY = 1 + br * 0.045;
  o.headPitch = 0.44 + br * 0.03;
  o.headRoll = 0.12;
  o.headYaw = 0.10;
  o.legLPitch = 1.30; o.legRPitch = 1.24; o.legSpread = 0.34;
  o.armLPitch = 0.30; o.armRPitch = 0.26; o.armSpread = 0.22;
  o.earPitch = 0.62; o.earSpread = 0.24; o.earTip = 0.35;
  o.tailPitch = 0.30; o.tailCurl = 0.4;
}

function sStartle(c, t, o, spd, prog) {
  const e = Math.sin(Math.PI * Math.min(1, prog * 1.25)) ** 0.7;
  const pop = Math.sin(Math.PI * Math.min(1, prog * 2.4));
  o.bodyY = pop * 0.10;
  o.spineSY = 1 + pop * 0.17;
  o.hipsSY = 1 + pop * 0.06;
  o.spinePitch = -0.30 * e;
  o.hipsPitch = 0.10 * e;
  o.headPitch = -0.34 * e;
  o.headYaw = c.bias.headYaw * 0.4;
  o.headRoll = -0.06 * e;
  o.armLPitch = -0.55 * e + 0.1; o.armRPitch = -0.50 * e + 0.1;
  o.armSpread = 0.30 + 0.55 * e;
  o.legLPitch = 0.35 * pop; o.legRPitch = 0.30 * pop; o.legSpread = 0.20 * e;
  o.earPitch = -0.55 * e;
  o.earSpread = 0.30 * e;
  o.tailPitch = -0.70 * e;
}

function sHappy(c, t, o, spd, prog) {
  const p = fract(prog * 2.2);
  const h = Math.sin(Math.PI * Math.min(1, p / 0.7)) ** 0.8;
  const e = Math.sin(Math.PI * Math.min(1, prog));
  o.bodyY = h * 0.145 * e;
  o.spineSY = 1 + (h - 0.35) * 0.14 * e;
  o.spinePitch = -0.10 * e - h * 0.06;
  o.headPitch = -0.20 * e;
  o.headRoll = Math.sin(prog * 9.0) * 0.20 * e;
  o.headYaw = Math.sin(prog * 6.0) * 0.14 * e;
  o.armLPitch = (-0.75 - h * 0.35) * e; o.armRPitch = (-0.70 - h * 0.30) * e;
  o.armSpread = 0.30 + 0.50 * e;
  o.legLPitch = h * 0.75; o.legRPitch = h * 0.68; o.legSpread = 0.14;
  o.earPitch = -0.30 * e;
  o.tailPitch = -0.55 * e; o.tailYaw = Math.sin(prog * 15) * 0.40 * e;
}

function sNuzzle(c, t, o, spd, prog) {
  const e = Math.sin(Math.PI * Math.min(1, prog)) ** 0.6;
  const n = Math.sin(prog * 11.0);
  o.spinePitch = 0.34 * e;
  o.headPitch = (0.50 + n * 0.16) * e;
  o.headYaw = Math.sin(prog * 5.0) * 0.16 * e;
  o.bodyY = -0.035 * e;
  o.armLPitch = -0.20 * e + 0.12; o.armRPitch = -0.16 * e + 0.12;
  o.armSpread = 0.34;
  o.earPitch = c.bias.ear + 0.18 * e;
  o.tailYaw = Math.sin(prog * 14) * 0.42 * e;
  o.tailPitch = -0.30 * e;
}

const STATES = {
  idle: sIdle, walk: null, run: null, hop: null,
  eat: sEat, sit: sSit, sleep: sSleep,
  startle: sStartle, happy: sHappy, nuzzle: sNuzzle,
};
const ONESHOT = { startle: 0.85, happy: 1.35, nuzzle: 1.6 };

function locomotion(c, t, o, spd) {
  if (c.def.gait === 'quad') return sQuad(c, t, o, spd);
  if (c.def.gait === 'trot') return sTrot(c, t, o, spd);
  return sHop(c, t, o, spd);
}

function evalState(c, name, t, spd, prog) {
  const o = zero(c._tmp);
  if (name === 'move') locomotion(c, t, o, spd);
  else (STATES[name] || sIdle)(c, t, o, spd, prog);
  return o;
}

/* ------------------------------------------------------------------ gestures */

const GESTURES = ['earflick', 'headcock', 'lookaround', 'tailflick', 'sniff', 'shiver', 'stretch', 'perk'];
const ATTENTIVE = ['headcock', 'perk', 'earflick', 'headcock', 'sniff', 'perk'];

function applyGesture(c, o, name, k) {
  const e = Math.sin(Math.PI * k);
  switch (name) {
    case 'earflick':
      o.earPitch += -0.55 * Math.sin(Math.PI * Math.min(1, k * 3)) * (k < 0.34 ? 1 : 0);
      o.earSpread += 0.30 * e; o.headRoll += 0.05 * e; break;
    case 'headcock':
      o.headRoll += 0.22 * e; o.headYaw += 0.22 * e; o.headPitch += -0.06 * e;
      o.earSpread += 0.10 * e; break;
    case 'lookaround': {
      const s = Math.sin(k * Math.PI * 2);
      o.headYaw += s * 0.55 * e; o.spineYaw += s * 0.16 * e; o.headPitch += -0.05 * e; break;
    }
    case 'tailflick':
      o.tailYaw += Math.sin(k * Math.PI * 3) * 0.55 * e; o.tailPitch += -0.25 * e; break;
    case 'sniff':
      o.headPitch += 0.30 * e; o.spinePitch += 0.10 * e;
      o.headYaw += Math.sin(k * Math.PI * 4) * 0.12 * e; o.bodyY += -0.014 * e; break;
    case 'shiver': {
      const s = Math.sin(k * Math.PI * 14) * e;
      o.hipsRoll += s * 0.06; o.spineRoll += -s * 0.05; o.headRoll += s * 0.07;
      o.spineSY += Math.abs(s) * 0.02; break;
    }
    case 'stretch':
      o.spineSY += 0.10 * e; o.spinePitch += -0.16 * e; o.headPitch += -0.22 * e;
      o.bodyY += 0.030 * e; o.armLPitch += -0.35 * e; o.armRPitch += -0.32 * e;
      o.armSpread += 0.28 * e; o.earPitch += -0.25 * e; break;
    case 'perk':
      o.earPitch += -0.40 * e; o.headPitch += -0.14 * e; o.spineSY += 0.035 * e;
      o.bodyY += 0.012 * e; break;
  }
}

/* --------------------------------------------------------------------- setup */

export function initRig(cr, rng) {
  const b = cr.bones;
  cr.ph = [0, 1, 2, 3, 4, 5].map(() => rng.range(0, TAU));
  cr.bias = {
    roll: rng.range(-0.05, 0.05), yaw: rng.range(-0.10, 0.10),
    headRoll: rng.range(-0.12, 0.12), headYaw: rng.range(-0.22, 0.22),
    armL: rng.range(-0.14, 0.14), armR: rng.range(-0.14, 0.14),
    ear: rng.range(-0.10, 0.14), earSpread: rng.range(-0.08, 0.10),
    // reference #12 / video #3: one ear forward and one back. A constant per-creature
    // asymmetry, so the two ears are never mirror images even in a still.
    earAsym: rng.range(0.07, 0.20) * (rng.bool() ? 1 : -1),
  };
  cr._tmp = newPose();
  cr._pose = newPose();
  cr._t = rng.range(0, 40);            // never caught at the start of a cycle
  cr.anim = { cur: 'idle', prev: 'idle', k: 1, prog: 0, oneshot: null };
  cr._gest = { name: rng.pick(GESTURES), t0: rng.range(-2, 0.5), dur: rng.range(0.8, 1.5), gap: rng.range(1.2, 3.0) };
  cr._blink = { next: rng.range(0.5, 4), on: 0 };
  cr._sp = {
    earL: new Spring(160, 17), earR: new Spring(160, 17),
    earLT: new Spring(120, 13), earRT: new Spring(120, 13),
    earLS: new Spring(140, 16), earRS: new Spring(140, 16),
    tail0: new Spring(110, 14), tail1: new Spring(85, 11), tail2: new Spring(70, 10),
    tailY0: new Spring(90, 12), tailY1: new Spring(70, 10), tailY2: new Spring(58, 9),
    lookY: new Spring(70, 14), lookP: new Spring(70, 14),
  };
  cr._vy = 0; cr._py = 0; cr._ay = 0;
  cr._rng = rng;
  cr._expr = null;
  cr._boneRest = {};
  for (const k in b) cr._boneRest[k] = b[k].position.clone();
}

/* -------------------------------------------------------------------- update */

const _v = new THREE.Vector3();

export function updateRig(cr, dt, camPos) {
  const b = cr.bones, A = cr.anim, S = cr._sp;
  cr._t += dt;
  const t = cr._t;
  const spd = Math.min(2.2, cr.speed01 || 0);

  // ---- pick the state
  let want = A.oneshot ? A.oneshot : requestedState(cr, spd);
  if (A.oneshot) {
    A.prog += dt / ONESHOT[A.oneshot];
    if (A.prog >= 1) { A.oneshot = null; A.prog = 0; want = requestedState(cr, spd); }
  }
  if (want !== A.cur) { A.prev = A.cur; A.cur = want; A.k = 0; }
  A.k = Math.min(1, A.k + dt / (A.cur === 'startle' ? 0.06 : 0.22));

  const p = cr._pose;
  const a = evalState(cr, A.cur, t, spd, A.prog);
  for (const k of KEYS) p[k] = a[k];
  if (A.k < 1) {
    const q = evalState(cr, A.prev, t, spd, 1);
    lerpPose(p, q, 1 - A.k);
  }

  // ---- idle micro-gestures: the anti-T-pose rule
  const g = cr._gest;
  if (A.cur === 'idle' || A.cur === 'eat') {
    const k = (t - g.t0) / g.dur;
    if (k > 0 && k < 1) applyGesture(cr, p, g.name, k);
    else if (k >= 1 + g.gap) {
      // Video #5/#11: an animal that has clocked you does attentive things — a head
      // cock, an ear perk, a look — not a stretch or a yawn. Attention changes the
      // *content* of the idle, it does not freeze it into a stare.
      g.name = cr._rng.pick((cr.attend ?? 0) > 0.45 ? ATTENTIVE : GESTURES);
      g.t0 = t; g.dur = cr._rng.range(0.7, 1.6); g.gap = cr._rng.range(0.9, 3.4);
    }
  }

  // ---- head look-at, additive and sprung.
  // Measured against the RENDERED torso yaw, not the AI's desired yaw, so that while
  // the body is still swinging around the head is already on target (video #5).
  const bodyYaw = cr.bodyYaw === undefined ? cr.yaw : cr.bodyYaw;
  let lookY = 0, lookP = 0;
  if (cr.lookAt) {
    _v.copy(cr.lookAt).sub(cr.position);
    const d = Math.hypot(_v.x, _v.z);
    const want2 = Math.atan2(-_v.x, -_v.z) - bodyYaw;
    lookY = clamp(Math.atan2(Math.sin(want2), Math.cos(want2)), -1.0, 1.0);
    lookP = clamp(-Math.atan2(_v.y - cr.def.size * 0.72, d), -0.42, 0.55);
  } else {
    // no explicit target: the head still leads whatever turn the body is committing to
    lookY = clamp(cr.yawLag || 0, -0.85, 0.85);
  }
  const ly = S.lookY.step(lookY, dt), lp = S.lookP.step(lookP, dt);
  const lw = cr.lookWeight === undefined ? 1 : cr.lookWeight;
  p.headYaw += ly * 0.72 * lw; p.spineYaw += ly * 0.20 * lw;
  p.headPitch += lp * 0.75 * lw;

  // ---- apply to bones
  const hSY = p.hipsSY, hSX = 1 - (hSY - 1) * 0.55;
  const sSY = p.spineSY, sSX = 1 - (sSY - 1) * 0.60;
  b.hips.position.set(cr._boneRest.hips.x, cr._boneRest.hips.y + p.bodyY, cr._boneRest.hips.z);
  b.hips.rotation.set(p.hipsPitch, p.hipsYaw, p.hipsRoll);
  b.hips.scale.set(hSX, hSY, hSX);
  b.spine.rotation.set(p.spinePitch, p.spineYaw, p.spineRoll);
  b.spine.scale.set(sSX / hSX, sSY / hSY, sSX / hSX);
  b.head.rotation.set(p.headPitch, p.headYaw, p.headRoll);

  const invS = 1 / (sSX / hSX), invSY = 1 / (sSY / hSY);
  b.armL.rotation.set(p.armLPitch, p.armLYaw, -p.armSpread);
  b.armR.rotation.set(p.armRPitch, -p.armRYaw, p.armSpread);
  b.armL.scale.set(invS, invSY, invS);
  b.armR.scale.set(invS, invSY, invS);
  b.legL.rotation.set(p.legLPitch, 0, -p.legSpread);
  b.legR.rotation.set(p.legRPitch, 0, p.legSpread);
  b.legL.scale.set(1 / hSX, 1 / hSY, 1 / hSX);
  b.legR.scale.set(1 / hSX, 1 / hSY, 1 / hSX);

  // ---- secondary motion. Ears and tail follow the body with lag and overshoot.
  const py = cr.root.position.y + p.bodyY * cr.def.size;
  const vy = (py - cr._py) / Math.max(1e-4, dt);
  cr._ay = (vy - cr._vy) / Math.max(1e-4, dt);
  cr._py = py; cr._vy = vy;
  const flop = clamp(cr._ay * 0.010, -0.55, 0.55) + clamp(-vy * 0.10, -0.30, 0.30);
  const turn = clamp((cr.yawRate || 0) * 0.13, -0.35, 0.35);

  const eBase = p.earPitch + flop * (cr.def.earFloppy ?? 1);
  const asym = cr.bias.earAsym ?? 0;
  b.earL.rotation.set(S.earL.step(eBase + asym, dt), turn * 0.5 + asym * 0.5, -p.earSpread - turn * 0.4 - asym * 0.35);
  b.earR.rotation.set(S.earR.step(eBase - asym * 0.75, dt), turn * 0.5 - asym * 0.35, p.earSpread - turn * 0.4 - asym * 0.2);
  if (b.earLT) {
    const tipT = p.earTip + flop * 0.85 + p.earPitch * 0.30;
    b.earLT.rotation.set(S.earLT.step(tipT, dt), 0, -turn * 0.5);
    b.earRT.rotation.set(S.earRT.step(tipT, dt), 0, -turn * 0.5);
  }
  const tp = p.tailPitch - flop * 0.5, ty = p.tailYaw - turn * 1.1;
  b.tail0.rotation.set(S.tail0.step(tp, dt), S.tailY0.step(ty, dt), 0);
  b.tail1.rotation.set(S.tail1.step(tp * 0.8 + p.tailCurl * 0.4, dt), S.tailY1.step(ty * 0.85, dt), 0);
  b.tail2.rotation.set(S.tail2.step(tp * 0.6 + p.tailCurl * 0.6, dt), S.tailY2.step(ty * 0.7, dt), 0);

  // ---- face
  setExpression(cr.rig, chooseExpression(cr, dt, t, spd));
}

function requestedState(cr, spd) {
  if (cr.mood === 'sleeping') return 'sleep';
  if (spd > 0.12) return 'move';
  if (cr.mood === 'eating') return 'eat';
  if (cr.intent?.anim === 'sit' || cr.mood === 'resting') return 'sit';
  return 'idle';
}

function chooseExpression(cr, dt, t, spd) {
  const A = cr.anim;
  if (A.oneshot === 'startle') return 'wide';
  if (A.oneshot === 'happy') return 'happy';
  if (A.oneshot === 'nuzzle') return 'chew';
  if (cr.emote && cr.emoteT > 0) { cr.emoteT -= dt; return cr.emote; }
  if (cr.mood === 'sleeping') return 'sleepy';
  if (cr.mood === 'afraid') return spd > 0.5 ? 'wide' : 'wary';
  if (cr.mood === 'eating' && A.cur === 'eat') return 'chew';
  if (cr.mood === 'happy' || cr.tamed) return t % 5 < 2.2 ? 'happy' : 'neutral';
  if (cr.mood === 'wary') return 'wary';
  if (cr.mood === 'curious') return 'wide';
  // blink
  const bk = cr._blink;
  if (t > bk.next) {
    if (t > bk.next + 0.13) { bk.next = t + cr._rng.range(1.8, 5.5); }
    else return 'blink';
  }
  return 'neutral';
}

export function playAnim(cr, name) {
  if (ONESHOT[name]) { cr.anim.oneshot = name; cr.anim.prog = 0; return; }
  cr.intent.anim = name;
}

export function setEmote(cr, name, ttl = 1.6) {
  if (ONESHOT[name]) { cr.anim.oneshot = name; cr.anim.prog = 0; return; }
  cr.emote = name; cr.emoteT = ttl;
}
