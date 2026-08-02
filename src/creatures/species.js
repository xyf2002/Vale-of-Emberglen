import * as THREE from 'three';
import { sweepGrid, sphereGrid } from './procgen.js';

/**
 * SPECIES — four creatures that are obviously the same world and completely different
 * black cutouts at 100px (reference observation #2).
 *
 *   woolkin   round scalloped cloud + stubby horns + droopy ears   -> WIDE + FLUFFY
 *   emberfox  little pear + oversized head + two tall spear ears   -> SPIKY TRIANGLE
 *   mosshorn  low heavy barrel + a huge curled ram spiral          -> HORIZONTAL + CURL
 *   dewhare   tall narrow teardrop + two towering blade ears       -> VERTICAL
 *
 * All geometry is authored in normalised units where total standing height = 1.0; the
 * root node is scaled by def.size at spawn. Everything is ONE swept surface plus
 * appendages — never a head sphere sitting on a body sphere.
 */

/* ------------------------------------------------------------------ helpers */

const C = (hex) => new THREE.Color(hex).toArray();
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sm = (x) => { x = clamp01(x); return x * x * (3 - 2 * x); };
const mixc = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const scal = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
/** shortest wrapped distance between two normalised angles */
const du = (a, b) => { let d = Math.abs(a - b) % 1; return d > 0.5 ? 1 - d : d; };

export function M(pos = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1]) {
  const m = new THREE.Matrix4();
  m.compose(
    new THREE.Vector3(...pos),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rot[0], rot[1], rot[2], 'YXZ')),
    new THREE.Vector3(...scale));
  return m;
}
export const MIRROR = new THREE.Matrix4().makeScale(-1, 1, 1);
export function mirrored(m) { return new THREE.Matrix4().multiplyMatrices(MIRROR, m); }

/** sample an analytic curve into sweep stops */
export function arc(n, fn) {
  const out = [];
  for (let i = 0; i <= n; i++) { const t = i / n; out.push(Object.assign({ t }, fn(t))); }
  return out;
}

/** rigid attach, with a soft blend into the parent bone near the root of the part */
export function chainWeight(chain, blend = 0.22) {
  return (p, v) => {
    let i = 0;
    for (let k = 1; k < chain.length; k++) if (v >= chain[k][1]) i = k;
    const cCur = chain[i][1];
    if (i > 0 && v < cCur + blend * 0.5) {
      const s = sm((v - (cCur - blend * 0.5)) / blend);
      return [[chain[i - 1][0], 1 - s], [chain[i][0], s]];
    }
    if (i + 1 < chain.length && v > chain[i + 1][1] - blend * 0.5) {
      const s = sm((v - (chain[i + 1][1] - blend * 0.5)) / blend);
      return [[chain[i][0], 1 - s], [chain[i + 1][0], s]];
    }
    return [[chain[i][0], 1]];
  };
}

/** the no-neck weighting: the head fades into the shoulders over a wide band */
export function yChain(chain, blend = 0.2) {
  return (p) => {
    const y = p.y;
    let i = 0;
    for (let k = 1; k < chain.length; k++) if (y >= chain[k][1]) i = k;
    const cCur = chain[i][1];
    if (i > 0 && y < cCur + blend * 0.5) {
      const s = sm((y - (cCur - blend * 0.5)) / blend);
      return [[chain[i - 1][0], 1 - s], [chain[i][0], s]];
    }
    if (i + 1 < chain.length && y > chain[i + 1][1] - blend * 0.5) {
      const s = sm((y - (chain[i + 1][1] - blend * 0.5)) / blend);
      return [[chain[i][0], 1 - s], [chain[i + 1][0], s]];
    }
    return [[chain[i][0], 1]];
  };
}

export const rigid = (b) => () => [[b, 1]];

/**
 * One saturated hero hue + a cream belly patch + dark accents (observation #5), plus
 * gentle baked crease occlusion (observation #9).
 */
export function bodyPaint({ base, top = null, belly = null, patches = [], ao = 0.17, aoV = 0.30 }) {
  const bc = C(base);
  const tc = top ? C(top) : scal(bc, 0.88);
  const bel = belly ? { c: C(belly.color), ...belly } : null;
  const pat = patches.map((p) => ({ ...p, c: C(p.color) }));
  return (u, v, p, n) => {
    // subtle top-down tonal shift: sun-facing surfaces slightly lighter, undersides cooler
    let c = mixc(bc, tc, sm((n.y + 0.15) * 0.7));
    if (bel) {
      const front = sm((Math.cos(u * 6.2832) - (1 - bel.spread * 2)) / (bel.soft ?? 0.5));
      const band = sm((v - bel.v0) / (bel.fade ?? 0.10)) * (1 - sm((v - bel.v1) / (bel.fade ?? 0.10)));
      c = mixc(c, bel.c, front * band * (bel.amt ?? 1));
    }
    for (const q of pat) {
      const dU = du(u, q.u) / q.ru;
      const dV = (v - q.v) / q.rv;
      const d = Math.sqrt(dU * dU + dV * dV);
      c = mixc(c, q.c, (1 - sm((d - 1 + (q.soft ?? 0.35)) / (q.soft ?? 0.35))) * (q.amt ?? 1));
    }
    // crease occlusion: undersides and the base of the mass
    const k = 1 - ao * sm(-n.y * 1.4) - aoV * (1 - sm(v * 3.2));
    return scal(c, k);
  };
}

/** flat colour with a little root shadow — used for limbs, ears, horns */
export function partPaint(hex, { tip = null, tipV = 0.7, rootAo = 0.30, ao = 0.12 } = {}) {
  const a = C(hex), b = tip ? C(tip) : null;
  return (u, v, p, n) => {
    let c = a;
    if (b) c = mixc(a, b, sm((v - tipV) / 0.24));
    const k = 1 - rootAo * (1 - sm(v * 4.0)) - ao * sm(-n.y * 1.3);
    return scal(c, k);
  };
}

/* ------------------------------------------------------- shared bone layout */

function bones(k) {
  const b = [
    { name: 'root', parent: null, at: [0, 0, 0] },
    { name: 'hips', parent: 'root', at: [0, k.hipY, 0] },
    { name: 'spine', parent: 'hips', at: [0, k.spineY, 0] },
    { name: 'head', parent: 'spine', at: [0, k.headY, k.headZ || 0] },
    { name: 'earL', parent: 'head', at: [k.earX, k.earY, k.earZ] },
    { name: 'earR', parent: 'head', at: [-k.earX, k.earY, k.earZ] },
    { name: 'earLT', parent: 'earL', at: [k.earX * 1.05, k.earY + k.earLen, k.earZ] },
    { name: 'earRT', parent: 'earR', at: [-k.earX * 1.05, k.earY + k.earLen, k.earZ] },
    { name: 'armL', parent: 'spine', at: [k.armX, k.armY, k.armZ] },
    { name: 'armR', parent: 'spine', at: [-k.armX, k.armY, k.armZ] },
    { name: 'legL', parent: 'hips', at: [k.legX, k.legY, k.legZ] },
    { name: 'legR', parent: 'hips', at: [-k.legX, k.legY, k.legZ] },
    { name: 'tail0', parent: 'hips', at: [0, k.tailY, k.tailZ] },
    { name: 'tail1', parent: 'tail0', at: [0, k.tailY + k.tailStep[1], k.tailZ + k.tailStep[0]] },
    { name: 'tail2', parent: 'tail1', at: [0, k.tailY + k.tailStep[1] * 2, k.tailZ + k.tailStep[0] * 2] },
  ];
  return b;
}

/* ================================================================= WOOLKIN */
/* A wool cloud. Reference pw_00: the body outline is a ring of uniform puffball lobes,
   the face is a dark patch set INTO the wool, horns and droopy ears do the silhouette. */

const woolkinStops = [
  { t: 0.00, r: 0.006, y: 0.175 },
  { t: 0.07, r: 0.170, y: 0.198, sz: 1.02 },
  { t: 0.20, r: 0.310, y: 0.285, sz: 1.05 },
  { t: 0.36, r: 0.386, y: 0.420, sz: 1.06 },
  { t: 0.52, r: 0.404, y: 0.570, sz: 1.05 },
  { t: 0.66, r: 0.382, y: 0.706, sz: 1.03 },
  { t: 0.78, r: 0.339, y: 0.808, sz: 1.00 },
  { t: 0.88, r: 0.288, y: 0.890, sz: 0.98 },
  { t: 0.95, r: 0.190, y: 0.948, sz: 0.98 },
  { t: 1.00, r: 0.006, y: 0.985 },
];

const WOOLKIN = {
  id: 'woolkin', name: 'Woolkin', size: 1.06, speed: 1.9, shy: 0.30, diet: 'grass',
  gait: 'hop', mass: 1.0,
  pal: { hero: 0xf6f0e2, wool: 0xfbf7ec, face: 0x744f42, ear: 0x5d3f36, horn: 0xf0b657, hoof: 0x6b4d3f },
  fur: { rep: [7, 6], contrast: 0.20, tufts: 90, streak: 0.35, sheen: 0.0, rim: 0.17, fill: 0.36, wrap: 0.66, fuzz: 0.20 },
  face: {
    gap: 0.155, eyeY: 0.485, eyeR: 0.125, tall: 1.28, slant: 0.20, lid: 0.16,
    outlineW: 0.030, outline: '#2c1c18', sclera: '#ffffff',
    iris: '#c8791d', iris2: '#f5c246', pupil: '#241209', irisR: 0.60, irisTall: 1.05, brow: false,
    mouth: 'cat', mouthY: 0.665, mouthW: 0.072, mouthIn: '#59262c', tongue: '#e08f96',
    nose: { y: 0.60, w: 0.020, color: '#3a231d' },
    blush: 'rgba(232,150,140,0.30)', blushGap: 0.30, blushY: 0.615, blushR: 0.085,
  },
  faceU: 0.098, faceV: [0.505, 0.845],
  key: {
    hipY: 0.26, spineY: 0.53, headY: 0.735, headZ: -0.02,
    earX: 0.245, earY: 0.775, earZ: 0.02, earLen: 0.10,
    armX: 0.30, armY: 0.485, armZ: -0.03,
    legX: 0.135, legY: 0.185, legZ: -0.015,
    tailY: 0.60, tailZ: 0.30, tailStep: [0.055, 0.01],
  },
  build(B, i) {
    const P = this.pal;
    const bodyW = yChain([[i.hips, -9], [i.spine, 0.42], [i.head, 0.735]], 0.30);
    // ---- the one dominant primitive
    B.addGrid(sweepGrid({ uSeg: 44, vSeg: 42, stops: woolkinStops }), {
      matrix: M(), weight: bodyW, uvScale: this.fur.rep,
      paint: bodyPaint({
        base: P.hero, top: 0xfffdf6, ao: 0.16, aoV: 0.34,
        patches: [{ color: P.face, u: 0, v: 0.678, ru: 0.115, rv: 0.150, soft: 0.30 }],
      }),
    });
    // ---- wool lobes: the scalloped outline. Placed everywhere EXCEPT the face.
    const lobes = [];
    const ring = (y, rad, n, lr, phase, skipFront) => {
      for (let a = 0; a < n; a++) {
        const th = phase + (a / n);
        if (skipFront && du(th, 0) < skipFront) continue;
        lobes.push([Math.sin(th * 6.2832) * rad, y, Math.cos(th * 6.2832) * rad, lr]);
      }
    };
    ring(0.815, 0.285, 9, 0.128, 0.055, 0.145);
    ring(0.665, 0.375, 10, 0.150, 0.00, 0.115);
    ring(0.480, 0.400, 10, 0.158, 0.05, 0.085);
    ring(0.310, 0.330, 8, 0.140, 0.06, 0.00);
    ring(0.920, 0.165, 5, 0.105, 0.10, 0.00);
    const lobeGrid = sphereGrid(1.0, 12, 9);
    for (const [x, y, z, r] of lobes) {
      B.addGrid(lobeGrid, {
        matrix: M([x, y, z], [0, 0, 0], [r, r * 0.94, r]),
        weight: bodyW, uvScale: [2.4, 2.0],
        paint: bodyPaint({ base: P.wool, top: 0xfffdf4, ao: 0.26, aoV: 0 }),
      });
    }
    // ---- droopy ears (two blade segments so they swing)
    const earStops = arc(12, (t) => ({
      r: 0.085 * Math.sin(Math.min(1, t * 1.06) * Math.PI) ** 0.62 * (1 - 0.15 * t),
      x: 0.245 + t * 0.115, y: 0.775 - t * 0.20 - t * t * 0.10, z: 0.02 + t * 0.05,
      sx: 0.55 + 0.5 * Math.sin(t * 3.0), sz: 1.6 - 0.5 * t,
    }));
    const earW = chainWeight([[i.head, 0], [i.earL, 0.16], [i.earLT, 0.56]], 0.26);
    const earWR = chainWeight([[i.head, 0], [i.earR, 0.16], [i.earRT, 0.56]], 0.26);
    const earG = sweepGrid({ uSeg: 16, vSeg: 18, stops: earStops });
    B.addGrid(earG, { matrix: M(), weight: earW, uvScale: [2, 3], paint: partPaint(P.ear, { rootAo: 0.34 }) });
    B.addGrid(earG, { matrix: MIRROR, weight: earWR, uvScale: [2, 3], paint: partPaint(P.ear, { rootAo: 0.34 }) });
    // ---- horns
    const hornStops = arc(12, (t) => ({
      r: 0.048 * (1 - 0.82 * t) + 0.004,
      x: 0.135 + Math.sin(t * 1.75) * 0.135,
      y: 0.905 + t * 0.075 - t * t * 0.055,
      z: 0.045 + t * 0.02 - t * t * 0.16,
      sx: 1, sz: 1,
    }));
    const hornG = sweepGrid({ uSeg: 12, vSeg: 14, stops: hornStops });
    B.addGrid(hornG, { matrix: M(), weight: rigid(i.head), uvScale: [1.6, 2], paint: partPaint(P.horn, { tip: 0xfbdda2, tipV: 0.55, rootAo: 0.24 }) });
    B.addGrid(hornG, { matrix: MIRROR, weight: rigid(i.head), uvScale: [1.6, 2], paint: partPaint(P.horn, { tip: 0xfbdda2, tipV: 0.55, rootAo: 0.24 }) });
    // ---- stubby legs (mitten feet, no knee)
    const legStops = arc(10, (t) => ({
      r: 0.078 * (1 - 0.10 * t) * Math.sin(Math.min(1, 0.30 + t * 0.78) * Math.PI) ** 0.42,
      y: 0.215 - t * 0.215, z: -0.015 - t * 0.02, sz: 1 + 0.55 * t * t,
    }));
    const legG = sweepGrid({ uSeg: 12, vSeg: 12, stops: legStops });
    for (const [mx, bn] of [[1, i.legL], [-1, i.legR]]) {
      B.addGrid(legG, {
        matrix: mx > 0 ? M([0.135, 0, 0]) : mirrored(M([0.135, 0, 0])),
        weight: rigid(bn), uvScale: [1.6, 1.6], paint: partPaint(P.hero, { tip: P.hoof, tipV: 0.66, rootAo: 0.36 }),
      });
    }
    // ---- little arms
    const armStops = arc(10, (t) => ({
      r: 0.070 * Math.sin(Math.min(1, 0.34 + t * 0.72) * Math.PI) ** 0.4 * (1 + 0.2 * t * t),
      x: 0.30 + t * 0.055, y: 0.485 - t * 0.20, z: -0.03 - t * 0.02,
    }));
    const armG = sweepGrid({ uSeg: 12, vSeg: 12, stops: armStops });
    B.addGrid(armG, { matrix: M(), weight: rigid(i.armL), uvScale: [1.6, 1.6], paint: partPaint(P.wool, { tip: P.hoof, tipV: 0.72, rootAo: 0.34 }) });
    B.addGrid(armG, { matrix: MIRROR, weight: rigid(i.armR), uvScale: [1.6, 1.6], paint: partPaint(P.wool, { tip: P.hoof, tipV: 0.72, rootAo: 0.34 }) });
    // ---- wool tail puff
    B.addGrid(sphereGrid(1, 12, 9), {
      matrix: M([0, 0.615, 0.345], [0, 0, 0], [0.10, 0.095, 0.10]),
      weight: rigid(i.tail0), uvScale: [2, 2], paint: bodyPaint({ base: P.wool, ao: 0.24, aoV: 0 }),
    });
    return { weight: bodyW, stops: woolkinStops };
  },
};

/* ================================================================ EMBERFOX */
/* pw_15 lineage: a small pear body with an oversized head fused straight into it and a
   fan of ear-blades that overshoot the skull by a full head-width. */

const foxStops = [
  { t: 0.00, r: 0.006, y: 0.115 },
  { t: 0.08, r: 0.130, y: 0.140, sz: 1.05 },
  { t: 0.22, r: 0.218, y: 0.235, sz: 1.10 },
  { t: 0.36, r: 0.246, y: 0.345, sz: 1.10, z: -0.005 },
  { t: 0.48, r: 0.232, y: 0.445, sz: 1.06, z: -0.012 },
  { t: 0.57, r: 0.214, y: 0.520, sz: 1.02, z: -0.016 },
  { t: 0.66, r: 0.250, y: 0.595, sz: 1.00, z: -0.020 },   // head flares straight out of the shoulders
  { t: 0.76, r: 0.303, y: 0.690, sz: 0.99, z: -0.022 },
  { t: 0.86, r: 0.300, y: 0.800, sz: 0.98, z: -0.018 },
  { t: 0.94, r: 0.228, y: 0.898, sz: 0.99, z: -0.010 },
  { t: 0.98, r: 0.130, y: 0.955 },
  { t: 1.00, r: 0.006, y: 0.985 },
];

const EMBERFOX = {
  id: 'emberfox', name: 'Emberfox', size: 0.88, speed: 3.2, shy: 0.55, diet: 'berry',
  gait: 'trot', mass: 0.6,
  pal: { hero: 0xef8b62, deep: 0xdb6b46, belly: 0xf7dda6, ear: 0xf7b48e, inner: 0xd25f52, paw: 0x8f4535, tail: 0xfbe6c4 },
  fur: { rep: [7, 7], contrast: 0.15, tufts: 70, streak: 0.7, sheen: 0.0, rim: 0.18, fill: 0.33, wrap: 0.60, fuzz: 0.18 },
  face: {
    gap: 0.165, eyeY: 0.455, eyeR: 0.140, tall: 1.30, slant: 0.30, lid: 0.20,
    outlineW: 0.028, outline: '#2b1a1c', sclera: '#ffffff',
    iris: '#1a86c9', iris2: '#66d2f2', pupil: '#0d2c3f', irisR: 0.62, irisTall: 1.08, brow: false,
    mouth: 'cat', mouthY: 0.655, mouthW: 0.078, mouthIn: '#5c2830', tongue: '#e58a92',
    nose: { y: 0.578, w: 0.024, color: '#38201d' },
    blush: 'rgba(226,116,110,0.34)', blushGap: 0.315, blushY: 0.605, blushR: 0.088,
  },
  faceU: 0.108, faceV: [0.635, 0.945],
  key: {
    hipY: 0.22, spineY: 0.46, headY: 0.72, headZ: -0.02,
    earX: 0.145, earY: 0.845, earZ: 0.03, earLen: 0.20,
    armX: 0.215, armY: 0.435, armZ: -0.05,
    legX: 0.115, legY: 0.145, legZ: -0.02,
    tailY: 0.30, tailZ: 0.20, tailStep: [0.075, 0.075],
  },
  build(B, i) {
    const P = this.pal;
    const bodyW = yChain([[i.hips, -9], [i.spine, 0.36], [i.head, 0.665]], 0.26);
    B.addGrid(sweepGrid({ uSeg: 44, vSeg: 46, stops: foxStops }), {
      matrix: M(), weight: bodyW, uvScale: this.fur.rep,
      paint: bodyPaint({
        base: P.hero, top: P.deep, ao: 0.18, aoV: 0.30,
        belly: { color: P.belly, spread: 0.30, soft: 0.55, v0: 0.14, v1: 0.66, fade: 0.13, amt: 1 },
      }),
    });
    // ---- the two big spear ears (silhouette budget lives here)
    const earStops = arc(14, (t) => ({
      r: 0.098 * Math.sin(Math.min(1, 0.12 + t * 0.92) * Math.PI) ** 0.55 * (1 - 0.25 * t),
      x: 0.145 + t * 0.085 + Math.sin(t * 3.1) * 0.02,
      y: 0.845 + t * 0.395,
      z: 0.03 + t * 0.055 - t * t * 0.02,
      sx: 0.62 + 0.30 * Math.sin(t * 2.6), sz: 1.55 - 0.55 * t,
      roll: -0.22,
    }));
    const earG = sweepGrid({ uSeg: 16, vSeg: 20, stops: earStops });
    const paintEar = partPaint(P.hero, { tip: P.ear, tipV: 0.62, rootAo: 0.30 });
    B.addGrid(earG, { matrix: M(), weight: chainWeight([[i.head, 0], [i.earL, 0.14], [i.earLT, 0.55]], 0.24), uvScale: [2, 4], paint: paintEar });
    B.addGrid(earG, { matrix: MIRROR, weight: chainWeight([[i.head, 0], [i.earR, 0.14], [i.earRT, 0.55]], 0.24), uvScale: [2, 4], paint: paintEar });
    // ---- cheek ear-fins: pw_15's signature fan
    const finStops = arc(10, (t) => ({
      r: 0.055 * Math.sin(Math.min(1, 0.16 + t * 0.88) * Math.PI) ** 0.5 * (1 - 0.2 * t),
      x: 0.245 + t * 0.185, y: 0.735 - t * 0.075, z: 0.02 + t * 0.075,
      sx: 0.8, sz: 1.35,
    }));
    const finG = sweepGrid({ uSeg: 12, vSeg: 12, stops: finStops });
    for (const dy of [0, -0.135]) {
      const mm = M([0, dy, 0], [0, 0, dy < 0 ? -0.30 : 0.10]);
      B.addGrid(finG, { matrix: mm, weight: rigid(i.head), uvScale: [1.6, 2], paint: partPaint(P.hero, { tip: P.ear, tipV: 0.5, rootAo: 0.26 }) });
      B.addGrid(finG, { matrix: mirrored(mm), weight: rigid(i.head), uvScale: [1.6, 2], paint: partPaint(P.hero, { tip: P.ear, tipV: 0.5, rootAo: 0.26 }) });
    }
    // ---- forelock tuft between the ears
    const tuftStops = arc(9, (t) => ({
      r: 0.052 * Math.sin(Math.min(1, 0.2 + t * 0.85) * Math.PI) ** 0.5,
      x: 0, y: 0.935 + t * 0.135, z: -0.02 - t * 0.09, sx: 1.5, sz: 0.7,
    }));
    B.addGrid(sweepGrid({ uSeg: 12, vSeg: 10, stops: tuftStops }), {
      matrix: M(), weight: rigid(i.head), uvScale: [1.5, 2], paint: partPaint(P.deep, { tip: P.ear, tipV: 0.5, rootAo: 0.2 }),
    });
    // ---- mitten arms, held a little forward
    const armStops = arc(11, (t) => ({
      r: 0.058 * Math.sin(Math.min(1, 0.32 + t * 0.74) * Math.PI) ** 0.4 * (1 + 0.28 * t * t),
      x: 0.215 + t * 0.045, y: 0.435 - t * 0.215, z: -0.05 - t * 0.055,
    }));
    const armG = sweepGrid({ uSeg: 12, vSeg: 12, stops: armStops });
    const paintPaw = partPaint(P.hero, { tip: P.paw, tipV: 0.70, rootAo: 0.30 });
    B.addGrid(armG, { matrix: M(), weight: rigid(i.armL), uvScale: [1.6, 1.8], paint: paintPaw });
    B.addGrid(armG, { matrix: MIRROR, weight: rigid(i.armR), uvScale: [1.6, 1.8], paint: paintPaw });
    // ---- toeless feet
    const legStops = arc(10, (t) => ({
      r: 0.072 * Math.sin(Math.min(1, 0.30 + t * 0.78) * Math.PI) ** 0.42,
      y: 0.185 - t * 0.185, z: -0.02 - t * 0.035, sz: 1 + 0.7 * t * t,
    }));
    const legG = sweepGrid({ uSeg: 12, vSeg: 12, stops: legStops });
    B.addGrid(legG, { matrix: M([0.115, 0, 0]), weight: rigid(i.legL), uvScale: [1.6, 1.6], paint: paintPaw });
    B.addGrid(legG, { matrix: mirrored(M([0.115, 0, 0])), weight: rigid(i.legR), uvScale: [1.6, 1.6], paint: paintPaw });
    // ---- big brush tail arcing up behind
    const tailStops = arc(16, (t) => ({
      r: (0.055 + 0.105 * Math.sin(Math.min(1, 0.08 + t * 0.94) * Math.PI) ** 0.75) * (1 - 0.1 * t),
      y: 0.30 + t * 0.42 - t * t * 0.06,
      z: 0.20 + Math.sin(t * 1.9) * 0.16,
      sx: 1.05, sz: 1.0,
    }));
    B.addGrid(sweepGrid({ uSeg: 16, vSeg: 22, stops: tailStops }), {
      matrix: M(), uvScale: [2.5, 5],
      weight: chainWeight([[i.hips, 0], [i.tail0, 0.12], [i.tail1, 0.45], [i.tail2, 0.78]], 0.28),
      paint: partPaint(P.hero, { tip: P.tail, tipV: 0.52, rootAo: 0.28 }),
    });
    return { weight: bodyW, stops: foxStops };
  },
};

/* ================================================================ MOSSHORN */
/* The heavy one. A low barrel whose head hangs forward out of the shoulders — read at
   distance by one enormous curled horn spiral. */

const mossStops = [
  { t: 0.00, r: 0.006, y: 0.285, z: 0.30 },
  { t: 0.07, r: 0.150, y: 0.310, z: 0.295, sz: 1.1 },
  { t: 0.20, r: 0.268, y: 0.400, z: 0.255, sz: 1.35 },
  { t: 0.36, r: 0.310, y: 0.520, z: 0.170, sz: 1.45 },
  { t: 0.50, r: 0.316, y: 0.600, z: 0.055, sz: 1.42 },
  { t: 0.62, r: 0.300, y: 0.640, z: -0.075, sz: 1.30 },
  { t: 0.72, r: 0.268, y: 0.645, z: -0.190, sz: 1.16 },  // shoulders flow into the skull
  { t: 0.82, r: 0.246, y: 0.610, z: -0.300, sz: 1.02 },
  { t: 0.91, r: 0.208, y: 0.548, z: -0.395, sz: 0.95 },
  { t: 0.97, r: 0.135, y: 0.496, z: -0.455, sz: 0.95 },
  { t: 1.00, r: 0.006, y: 0.470, z: -0.482 },
];

const MOSSHORN = {
  id: 'mosshorn', name: 'Mosshorn', size: 1.44, speed: 1.5, shy: 0.18, diet: 'grass',
  gait: 'quad', mass: 2.4,
  pal: { hero: 0x8aa257, deep: 0x6d8543, belly: 0xdcd7b0, horn: 0xd9cba4, hoof: 0x4b4636, moss: 0x6f9a45, muzzle: 0xc9c39a },
  fur: { rep: [8, 5], contrast: 0.17, tufts: 80, streak: 0.9, sheen: 0.02, rim: 0.15, fill: 0.30, wrap: 0.58, fuzz: 0.14 },
  face: {
    gap: 0.170, eyeY: 0.430, eyeR: 0.118, tall: 1.10, slant: 0.16, lid: 0.28,
    outlineW: 0.026, outline: '#2a2416', sclera: '#ffffff',
    iris: '#b1841e', iris2: '#e8c05a', pupil: '#1d1608', irisR: 0.58, brow: true,
    mouth: 'smile', mouthY: 0.745, mouthW: 0.062, mouthIn: '#4a2a26', tongue: '#d98d90',
    nose: null,
    muzzle: { y: 0.735, rx: 0.185, ry: 0.115, color: '#cfc7a2' },
    blush: null,
  },
  faceU: 0.105, faceV: [0.775, 1.0],
  key: {
    hipY: 0.40, spineY: 0.58, headY: 0.60, headZ: -0.26,
    earX: 0.215, earY: -0.03, earZ: -0.02, earLen: 0.02,
    armX: 0.185, armY: -0.06, armZ: -0.185,
    legX: 0.190, legY: -0.10, legZ: 0.215,
    tailY: 0.20, tailZ: 0.28, tailStep: [0.03, -0.03],
  },
  build(B, i) {
    const P = this.pal;
    const bodyW = (p) => {
      // weight by distance along the body axis so the hanging head still turns cleanly
      const s = clamp01((-p.z + 0.10) / 0.42);
      const hs = sm(s);
      if (p.y < 0.46) return [[i.hips, 1]];
      const back = clamp01((0.34 - p.z) / 0.5);
      return hs > 0.02 ? [[i.spine, 1 - hs], [i.head, hs]] : [[i.spine, 1 - back * 0.25], [i.hips, back * 0.25]];
    };
    B.addGrid(sweepGrid({ uSeg: 40, vSeg: 44, stops: mossStops }), {
      matrix: M(), weight: bodyW, uvScale: this.fur.rep,
      paint: bodyPaint({
        base: P.hero, top: P.deep, ao: 0.20, aoV: 0.0,
        belly: { color: P.belly, spread: 0.30, soft: 0.6, v0: 0.05, v1: 0.55, fade: 0.16, amt: 0.85 },
        patches: [{ color: P.muzzle, u: 0, v: 0.985, ru: 0.14, rv: 0.10, soft: 0.5, amt: 0.7 }],
      }),
    });
    // ---- moss saddle: dark clumps on the upward faces only (observation #8, but on fur)
    const mossG = sphereGrid(1, 10, 8);
    const spots = [[0.10, 0.60, 0.05, 0.10], [-0.13, 0.62, -0.03, 0.085], [0.02, 0.615, 0.16, 0.095],
      [0.16, 0.575, 0.20, 0.075], [-0.08, 0.585, 0.22, 0.07]];
    for (const [x, y, z, r] of spots) {
      B.addGrid(mossG, {
        matrix: M([x, y, z], [0, 0, 0], [r * 1.5, r * 0.45, r * 1.5]),
        weight: bodyW, uvScale: [2, 2], paint: bodyPaint({ base: P.moss, ao: 0.2, aoV: 0 }),
      });
    }
    // ---- the ram horns: the whole silhouette budget
    const hornStops = arc(20, (t) => {
      const a = -0.55 + t * 4.4;
      const rr = 0.175 * (1 - 0.52 * t);
      return {
        r: 0.062 * (1 - 0.68 * t) + 0.005,
        x: 0.145 + t * 0.115 + Math.sin(t * 2.2) * 0.03,
        y: 0.640 + Math.cos(a) * rr - 0.075,
        z: -0.235 + Math.sin(a) * rr + 0.11,
        sx: 1, sz: 1, roll: t * 1.2,
      };
    });
    const hornG = sweepGrid({ uSeg: 12, vSeg: 24, stops: hornStops });
    const paintHorn = partPaint(P.horn, { tip: 0xf2e6c6, tipV: 0.6, rootAo: 0.28 });
    B.addGrid(hornG, { matrix: M(), weight: rigid(i.head), uvScale: [1.6, 5], paint: paintHorn });
    B.addGrid(hornG, { matrix: MIRROR, weight: rigid(i.head), uvScale: [1.6, 5], paint: paintHorn });
    // ---- small ear flaps
    const earStops = arc(9, (t) => ({
      r: 0.055 * Math.sin(Math.min(1, 0.2 + t * 0.85) * Math.PI) ** 0.5,
      x: 0.215 + t * 0.145, y: 0.590 - t * 0.06, z: -0.20 + t * 0.02, sx: 0.75, sz: 1.5,
    }));
    const earG = sweepGrid({ uSeg: 12, vSeg: 10, stops: earStops });
    B.addGrid(earG, { matrix: M(), weight: chainWeight([[i.head, 0], [i.earL, 0.22]], 0.3), uvScale: [1.5, 2], paint: partPaint(P.deep, { rootAo: 0.3 }) });
    B.addGrid(earG, { matrix: MIRROR, weight: chainWeight([[i.head, 0], [i.earR, 0.22]], 0.3), uvScale: [1.5, 2], paint: partPaint(P.deep, { rootAo: 0.3 }) });
    // ---- four stubby legs (front pair on the arm bones)
    const legStops = arc(10, (t) => ({
      r: 0.088 * (1 - 0.14 * t) * Math.sin(Math.min(1, 0.28 + t * 0.8) * Math.PI) ** 0.4,
      y: 0.40 - t * 0.40, sz: 1 + 0.5 * t * t,
    }));
    const legG = sweepGrid({ uSeg: 12, vSeg: 12, stops: legStops });
    const paintLeg = partPaint(P.hero, { tip: P.hoof, tipV: 0.72, rootAo: 0.34 });
    const legAt = [[0.190, 0.215, i.legL], [0.190, -0.185, i.armL]];
    for (const [x, z, bn] of legAt) {
      B.addGrid(legG, { matrix: M([x, 0, z]), weight: rigid(bn), uvScale: [1.6, 1.6], paint: paintLeg });
    }
    B.addGrid(legG, { matrix: mirrored(M([0.190, 0, 0.215])), weight: rigid(i.legR), uvScale: [1.6, 1.6], paint: paintLeg });
    B.addGrid(legG, { matrix: mirrored(M([0.190, 0, -0.185])), weight: rigid(i.armR), uvScale: [1.6, 1.6], paint: paintLeg });
    // ---- short tuft tail
    const tailStops = arc(10, (t) => ({
      r: 0.035 + 0.055 * Math.sin(Math.min(1, 0.1 + t * 0.9) * Math.PI) ** 0.8,
      y: 0.545 - t * 0.16, z: 0.30 + t * 0.10, sx: 1, sz: 1,
    }));
    B.addGrid(sweepGrid({ uSeg: 12, vSeg: 12, stops: tailStops }), {
      matrix: M(), uvScale: [1.6, 2.4],
      weight: chainWeight([[i.hips, 0], [i.tail0, 0.2], [i.tail1, 0.62]], 0.3),
      paint: partPaint(P.deep, { tip: P.hoof, tipV: 0.6, rootAo: 0.3 }),
    });
    return { weight: bodyW, stops: mossStops };
  },
};

/* ================================================================= DEWHARE */
/* pw_09 lineage: a tall teardrop that flares to the ground with no visible legs, and
   two blade ears more than half the creature's height. Vertical silhouette. */

const dewStops = [
  { t: 0.00, r: 0.006, y: 0.010 },
  { t: 0.05, r: 0.140, y: 0.018, sz: 1.05 },
  { t: 0.14, r: 0.238, y: 0.055, sz: 1.10 },
  { t: 0.28, r: 0.283, y: 0.160, sz: 1.10 },
  { t: 0.42, r: 0.288, y: 0.290, sz: 1.08 },
  { t: 0.56, r: 0.268, y: 0.430, sz: 1.05 },
  { t: 0.68, r: 0.234, y: 0.560, sz: 1.02, z: -0.01 },
  { t: 0.78, r: 0.208, y: 0.665, sz: 1.00, z: -0.02 },
  { t: 0.87, r: 0.198, y: 0.760, sz: 1.02, z: -0.025 },   // head, same width as the shoulder: no neck at all
  { t: 0.94, r: 0.176, y: 0.845, sz: 1.05, z: -0.02 },
  { t: 0.985, r: 0.100, y: 0.905 },
  { t: 1.00, r: 0.006, y: 0.925 },
];

const DEWHARE = {
  id: 'dewhare', name: 'Dewhare', size: 1.18, speed: 2.6, shy: 0.62, diet: 'berry',
  gait: 'hop', mass: 0.8,
  pal: { hero: 0x8fc9e6, deep: 0x5aa8d4, belly: 0xf3f8fb, tip: 0x2f5fb0, paw: 0xeef5f9, mark: 0x2f5fb0 },
  fur: { rep: [6, 8], contrast: 0.09, tufts: 40, streak: 1.2, sheen: 0.22, rim: 0.20, fill: 0.32, wrap: 0.55, fuzz: 0.14 },
  face: {
    gap: 0.152, eyeY: 0.470, eyeR: 0.122, tall: 1.34, slant: 0.10, lid: 0.10,
    outlineW: 0.024, outline: '#2c2338', sclera: '#ffffff',
    iris: '#8c46c8', iris2: '#f0d878', pupil: null, irisR: 0.66, irisTall: 1.12, brow: false,
    mouth: 'smile', mouthY: 0.635, mouthW: 0.058, mouthIn: '#5a2a3a', tongue: '#e58a9c',
    nose: null,
    blush: 'rgba(160,190,225,0.30)', blushGap: 0.30, blushY: 0.585, blushR: 0.08,
  },
  faceU: 0.128, faceV: [0.775, 1.0],
  key: {
    hipY: 0.16, spineY: 0.44, headY: 0.80, headZ: -0.02,
    earX: 0.095, earY: 0.885, earZ: -0.02, earLen: 0.30,
    armX: 0.185, armY: 0.400, armZ: -0.10,
    legX: 0.115, legY: 0.055, legZ: -0.05,
    tailY: 0.22, tailZ: 0.22, tailStep: [0.04, 0.03],
  },
  build(B, i) {
    const P = this.pal;
    const bodyW = yChain([[i.hips, -9], [i.spine, 0.34], [i.head, 0.72]], 0.32);
    B.addGrid(sweepGrid({ uSeg: 42, vSeg: 46, stops: dewStops }), {
      matrix: M(), weight: bodyW, uvScale: this.fur.rep,
      paint: bodyPaint({
        base: P.hero, top: P.deep, ao: 0.15, aoV: 0.0,
        belly: { color: P.belly, spread: 0.34, soft: 0.62, v0: -0.1, v1: 0.80, fade: 0.16, amt: 1 },
        patches: [
          { color: P.mark, u: 0.0, v: 0.34, ru: 0.028, rv: 0.075, soft: 0.5, amt: 0.85 },
          { color: P.mark, u: 0.045, v: 0.315, ru: 0.024, rv: 0.065, soft: 0.5, amt: 0.85 },
          { color: P.mark, u: -0.045, v: 0.315, ru: 0.024, rv: 0.065, soft: 0.5, amt: 0.85 },
        ],
      }),
    });
    // ---- towering blade ears with dark tips
    const earStops = arc(16, (t) => ({
      r: 0.088 * Math.sin(Math.min(1, 0.10 + t * 0.94) * Math.PI) ** 0.5 * (1 - 0.18 * t),
      x: 0.095 + t * 0.075 + Math.sin(t * 2.6) * 0.022,
      y: 0.885 + t * 0.58,
      z: -0.02 + t * 0.03,
      sx: 0.66 + 0.28 * Math.sin(t * 2.8), sz: 1.5 - 0.5 * t,
      roll: -0.14,
    }));
    const earG = sweepGrid({ uSeg: 16, vSeg: 24, stops: earStops });
    const paintEar = partPaint(P.hero, { tip: P.tip, tipV: 0.76, rootAo: 0.22 });
    B.addGrid(earG, { matrix: M(), weight: chainWeight([[i.head, 0], [i.earL, 0.12], [i.earLT, 0.50]], 0.22), uvScale: [2, 5], paint: paintEar });
    B.addGrid(earG, { matrix: MIRROR, weight: chainWeight([[i.head, 0], [i.earR, 0.12], [i.earRT, 0.50]], 0.22), uvScale: [2, 5], paint: paintEar });
    // ---- cheek fins
    const finStops = arc(10, (t) => ({
      r: 0.042 * Math.sin(Math.min(1, 0.18 + t * 0.86) * Math.PI) ** 0.5,
      x: 0.165 + t * 0.145, y: 0.800 + t * 0.015, z: -0.01 + t * 0.05, sx: 0.8, sz: 1.4,
    }));
    const finG = sweepGrid({ uSeg: 12, vSeg: 10, stops: finStops });
    for (const rz of [0.26, -0.02, -0.30]) {
      const mm = M([0, 0, 0], [0, 0, rz]);
      B.addGrid(finG, { matrix: mm, weight: rigid(i.head), uvScale: [1.4, 2], paint: partPaint(P.belly, { rootAo: 0.2 }) });
      B.addGrid(finG, { matrix: mirrored(mm), weight: rigid(i.head), uvScale: [1.4, 2], paint: partPaint(P.belly, { rootAo: 0.2 }) });
    }
    // ---- tiny mitten arms held at the chest
    const armStops = arc(11, (t) => ({
      r: 0.052 * Math.sin(Math.min(1, 0.32 + t * 0.72) * Math.PI) ** 0.38 * (1 + 0.34 * t * t),
      x: 0.185 - t * 0.045, y: 0.400 - t * 0.115, z: -0.10 - t * 0.115,
    }));
    const armG = sweepGrid({ uSeg: 12, vSeg: 12, stops: armStops });
    const paintPaw = partPaint(P.paw, { rootAo: 0.26 });
    B.addGrid(armG, { matrix: M(), weight: rigid(i.armL), uvScale: [1.5, 1.8], paint: paintPaw });
    B.addGrid(armG, { matrix: MIRROR, weight: rigid(i.armR), uvScale: [1.5, 1.8], paint: paintPaw });
    // ---- toeless feet peeking from under the flare
    const legStops = arc(9, (t) => ({
      r: 0.070 * Math.sin(Math.min(1, 0.36 + t * 0.72) * Math.PI) ** 0.4,
      y: 0.075 - t * 0.055, z: -0.05 - t * 0.10, sz: 1 + 0.55 * t,
    }));
    const legG = sweepGrid({ uSeg: 12, vSeg: 10, stops: legStops });
    B.addGrid(legG, { matrix: M([0.115, 0, 0]), weight: rigid(i.legL), uvScale: [1.5, 1.5], paint: paintPaw });
    B.addGrid(legG, { matrix: mirrored(M([0.115, 0, 0])), weight: rigid(i.legR), uvScale: [1.5, 1.5], paint: paintPaw });
    return { weight: bodyW, stops: dewStops };
  },
};

export const SPECIES_LIST = [WOOLKIN, EMBERFOX, MOSSHORN, DEWHARE];

export const SPECIES = {};
for (const s of SPECIES_LIST) {
  s.color = s.pal.hero;
  s.boneSpec = bones(s.key);
  SPECIES[s.id] = s;
}
