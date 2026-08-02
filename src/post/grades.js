/**
 * Colour-grade look table.
 *
 * One entry per time-of-day anchor. `resolveGrade(t)` blends the two neighbouring
 * anchors, so the grade slides continuously through the day instead of popping.
 *
 * Design rules taken from reference/INDEX.md:
 *  - #5  creatures are saturated, the world is not. Global saturation is therefore
 *        BELOW 1 for low-chroma pixels (grass, rock, sky) and slightly ABOVE 1 for
 *        high-chroma pixels (which, in this world, is almost exclusively creatures).
 *        See `satLow` / `satHigh`.
 *  - #5  grass must land as mid-value, moderately desaturated YELLOW-green, so a
 *        gentle hue-selective push of green toward yellow (`greenShift`) plus a
 *        green-only saturation trim (`greenSat`).
 *  - #6  skies are high-key and wash out at the horizon: highlight tint stays warm
 *        and near-neutral, highlights are never crushed by contrast.
 *  - #9  shadows are a cooler, less saturated version of the lit colour, never black:
 *        `offset` lifts the blacks a little and `shadowTint` cools them.
 *
 * Everything here is display-referred and applied AFTER the ACES tone curve, except
 * exposure / white balance / bloom, which are scene-referred.
 */

const NIGHT = {
  key: 'night',
  exposure: 1.06,
  whiteBalance: [0.93, 0.975, 1.16],
  contrast: 1.05, pivot: 0.34,
  slope: [1.0, 1.0, 1.0],
  offset: [0.016, 0.020, 0.036],
  power: [1.03, 1.01, 0.95],
  shadowTint: [0.86, 0.94, 1.20],
  highTint: [1.10, 1.00, 0.88],
  satLow: 0.78, satHigh: 1.10,
  greenShift: 0.06, greenSat: 0.86,
  bloomThreshold: 0.42, bloomKnee: 0.30, bloomStrength: 0.62, bloomTint: [1.06, 0.98, 0.86],
  vignette: 0.44, vigStart: 0.34,
  aberration: 1.15, grain: 0.017,
};

const DAWN = {
  key: 'dawn',
  exposure: 1.14,
  whiteBalance: [1.045, 0.998, 1.01],
  contrast: 0.985, pivot: 0.40,
  slope: [1.0, 1.0, 1.0],
  offset: [0.012, 0.013, 0.019],
  power: [1.0, 1.0, 0.99],
  shadowTint: [0.90, 0.96, 1.18],
  highTint: [1.10, 1.01, 0.90],
  satLow: 1.05, satHigh: 1.22,
  greenShift: 0.17, greenSat: 0.86,
  bloomThreshold: 0.66, bloomKnee: 0.42, bloomStrength: 0.42, bloomTint: [1.04, 1.0, 0.94],
  vignette: 0.28, vigStart: 0.37,
  aberration: 0.9, grain: 0.011,
};

const MORNING = {
  key: 'morning',
  exposure: 1.18,
  whiteBalance: [1.015, 1.0, 1.005],
  contrast: 1.025, pivot: 0.42,
  slope: [1.0, 1.0, 1.0],
  offset: [0.010, 0.011, 0.016],
  power: [1.0, 1.0, 0.995],
  shadowTint: [0.90, 0.965, 1.17],
  highTint: [1.08, 1.01, 0.925],
  satLow: 1.05, satHigh: 1.22,
  greenShift: 0.20, greenSat: 0.83,
  bloomThreshold: 0.74, bloomKnee: 0.42, bloomStrength: 0.36, bloomTint: [1.02, 1.0, 0.97],
  vignette: 0.27, vigStart: 0.37,
  aberration: 0.85, grain: 0.010,
};

const NOON = {
  key: 'noon',
  exposure: 1.02,
  whiteBalance: [1.0, 1.0, 1.012],
  contrast: 1.045, pivot: 0.44,
  slope: [1.0, 1.0, 1.0],
  offset: [0.008, 0.009, 0.015],
  power: [1.0, 1.0, 1.0],
  shadowTint: [0.89, 0.955, 1.19],
  highTint: [1.075, 1.01, 0.935],
  satLow: 1.04, satHigh: 1.23,
  greenShift: 0.21, greenSat: 0.82,
  bloomThreshold: 0.78, bloomKnee: 0.42, bloomStrength: 0.32, bloomTint: [1.0, 1.0, 0.99],
  vignette: 0.26, vigStart: 0.38,
  aberration: 0.85, grain: 0.010,
};

const GOLDEN = {
  key: 'golden',
  exposure: 1.04,
  whiteBalance: [1.06, 1.0, 0.945],
  contrast: 1.05, pivot: 0.42,
  slope: [1.0, 1.0, 1.0],
  offset: [0.009, 0.009, 0.018],
  power: [0.995, 1.0, 1.01],
  shadowTint: [0.88, 0.945, 1.20],
  highTint: [1.12, 1.01, 0.88],
  satLow: 1.04, satHigh: 1.24,
  greenShift: 0.18, greenSat: 0.85,
  bloomThreshold: 0.64, bloomKnee: 0.40, bloomStrength: 0.48, bloomTint: [1.07, 1.0, 0.90],
  vignette: 0.30, vigStart: 0.36,
  aberration: 1.0, grain: 0.011,
};

const DUSK = {
  key: 'dusk',
  exposure: 1.16,
  whiteBalance: [1.04, 0.985, 1.045],
  contrast: 1.04, pivot: 0.38,
  slope: [1.0, 1.0, 1.0],
  offset: [0.020, 0.023, 0.037],
  power: [1.01, 1.0, 0.975],
  shadowTint: [0.895, 0.95, 1.18],
  highTint: [1.09, 0.985, 0.93],
  satLow: 0.93, satHigh: 1.16,
  greenShift: 0.10, greenSat: 0.86,
  bloomThreshold: 0.55, bloomKnee: 0.36, bloomStrength: 0.55, bloomTint: [1.08, 0.99, 0.90],
  vignette: 0.36, vigStart: 0.35,
  aberration: 1.1, grain: 0.014,
};

/** anchors in time-of-day order; the table wraps (0 and 1 are both midnight) */
export const ANCHORS = [
  { t: 0.00, look: NIGHT },
  { t: 0.20, look: DAWN },
  { t: 0.33, look: MORNING },
  { t: 0.52, look: NOON },
  { t: 0.72, look: GOLDEN },
  { t: 0.855, look: DUSK },
  { t: 0.95, look: NIGHT },
  { t: 1.00, look: NIGHT },
];

/** named looks the public contract promises */
export const NAMED = {
  night: NIGHT, dawn: DAWN, morning: MORNING, noon: NOON, golden: GOLDEN, dusk: DUSK,
};

const KEYS_F = ['exposure', 'contrast', 'pivot', 'satLow', 'satHigh', 'greenShift', 'greenSat',
  'bloomThreshold', 'bloomKnee', 'bloomStrength', 'vignette', 'vigStart', 'aberration', 'grain'];
const KEYS_V = ['whiteBalance', 'slope', 'offset', 'power', 'shadowTint', 'highTint', 'bloomTint'];

function lerp(a, b, k) { return a + (b - a) * k; }

/** smoothstep-blend two looks */
export function blendLooks(a, b, kRaw) {
  const k = kRaw * kRaw * (3 - 2 * kRaw);
  const out = { key: k < 0.5 ? a.key : b.key };
  for (const f of KEYS_F) out[f] = lerp(a[f], b[f], k);
  for (const v of KEYS_V) out[v] = [lerp(a[v][0], b[v][0], k), lerp(a[v][1], b[v][1], k), lerp(a[v][2], b[v][2], k)];
  return out;
}

/** resolve the auto grade for a 0..1 time of day */
export function resolveGrade(t) {
  const x = ((t % 1) + 1) % 1;
  for (let i = 0; i < ANCHORS.length - 1; i++) {
    const a = ANCHORS[i], b = ANCHORS[i + 1];
    if (x >= a.t && x <= b.t) {
      const span = Math.max(1e-5, b.t - a.t);
      return blendLooks(a.look, b.look, (x - a.t) / span);
    }
  }
  return blendLooks(NIGHT, NIGHT, 0);
}
