/**
 * Procedural species silhouettes — pressed-specimen ink cutouts for the field journal
 * and discovery cards. No image assets: every shape is generated here as SVG path data.
 *
 * Rule taken from reference/INDEX.md #2: the whole creature must be identifiable as a
 * black-on-white cutout at 100px. So: one dominant convex body mass, all the
 * high-frequency detail in ears / horns / tail, no limb joints.
 *
 * Deterministic: shapes derive from the species id via a string hash, never from rng.
 */

const f = (n) => Math.round(n * 100) / 100;

/** catmull-rom through points -> closed cubic path, so blobs stay smooth and convex-ish */
function smoothClosed(p) {
  const n = p.length;
  let d = `M${f(p[0][0])},${f(p[0][1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = p[(i - 1 + n) % n], p1 = p[i], p2 = p[(i + 1) % n], p3 = p[(i + 2) % n];
    d += `C${f(p1[0] + (p2[0] - p0[0]) / 6)},${f(p1[1] + (p2[1] - p0[1]) / 6)}`
      + ` ${f(p2[0] - (p3[0] - p1[0]) / 6)},${f(p2[1] - (p3[1] - p1[1]) / 6)}`
      + ` ${f(p2[0])},${f(p2[1])}`;
  }
  return `${d}Z`;
}

/** a woolly lobed mass — the puffball outline from pw_00 */
function lobed(cx, cy, rx, ry, lobes, amp) {
  const pts = [];
  const n = lobes * 2;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    const k = i % 2 === 0 ? 1 + amp : 1 - amp * 0.35;
    pts.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k]);
  }
  return smoothClosed(pts);
}

/** an egg: wider and heavier at the bottom, the Palworld torso */
function egg(cx, cy, rx, ry, bias = 0.16) {
  const pts = [];
  const n = 16;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    const s = Math.sin(a);
    pts.push([cx + Math.cos(a) * rx * (1 + bias * s), cy + s * ry]);
  }
  return smoothClosed(pts);
}

/** a tapered horn/ear/tail sweeping from base toward tip */
function taper(bx, by, tx, ty, w, curve = 0.35) {
  const mx = (bx + tx) / 2, my = (by + ty) / 2;
  const dx = tx - bx, dy = ty - by;
  const nx = -dy, ny = dx;
  const l = Math.hypot(nx, ny) || 1;
  const cx = mx + (nx / l) * curve * Math.hypot(dx, dy) * 0.5;
  const cy = my + (ny / l) * curve * Math.hypot(dx, dy) * 0.5;
  const ox = (nx / l) * w, oy = (ny / l) * w;
  return `M${f(bx + ox)},${f(by + oy)}Q${f(cx + ox * 0.5)},${f(cy + oy * 0.5)} ${f(tx)},${f(ty)}`
    + `Q${f(cx - ox * 0.5)},${f(cy - oy * 0.5)} ${f(bx - ox)},${f(by - oy)}Z`;
}

const nub = (x, y, w, h) => `M${f(x - w)},${f(y)}L${f(x - w)},${f(y + h - w)}`
  + `Q${f(x - w)},${f(y + h)} ${f(x)},${f(y + h)}Q${f(x + w)},${f(y + h)} ${f(x + w)},${f(y + h - w)}`
  + `L${f(x + w)},${f(y)}Z`;

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 10000) / 10000;
}

/** id -> array of path `d` strings, drawn in one ink colour, plus eye positions */
const BUILDERS = {
  // fleece puffball: a ring of uniform lobes, head fused into the mass, stub legs
  woolkin: () => ({
    body: [
      nub(36, 74, 5, 18), nub(64, 74, 5, 18),
      lobed(50, 58, 32, 29, 10, 0.13),
      lobed(50, 28, 19, 18, 8, 0.12),
      taper(34, 22, 22, 12, 4, 0.35), taper(66, 22, 78, 12, 4, -0.35),
    ],
    eyes: [[43, 29, 2.9], [57, 29, 2.9]],
  }),
  // big upright ears that overshoot the head, one heavy sweeping tail
  emberfox: () => ({
    body: [
      nub(40, 78, 4.6, 14), nub(60, 78, 4.6, 14),
      taper(66, 74, 78, 50, 9, -0.8), taper(78, 50, 86, 30, 5.5, -0.5),
      egg(50, 63, 24, 26, 0.2),
      egg(50, 37, 20, 19, 0.04),
      taper(39, 26, 30, 4, 7.5, 0.1), taper(61, 26, 70, 4, 7.5, -0.1),
    ],
    eyes: [[43, 38, 3.1], [57, 38, 3.1]],
  }),
  // low broad grazer, thin horns curling up and outward past the body outline
  mosshorn: () => ({
    body: [
      nub(29, 76, 5.4, 16), nub(43, 78, 5.2, 14), nub(57, 78, 5.2, 14), nub(71, 76, 5.4, 16),
      egg(50, 64, 34, 21, -0.08),
      egg(50, 44, 21, 19, 0.04),
      taper(38, 38, 19, 27, 8.5, 0.5), taper(19, 27, 25, 11, 5, -0.55),
      taper(62, 38, 81, 27, 8.5, -0.5), taper(81, 27, 75, 11, 5, 0.55),
    ],
    eyes: [[42.5, 46, 2.9], [57.5, 46, 2.9]],
  }),
  // two clean circles of very different size joined at a waist: the head is the bigger
  // one. Read as ink, that proportion is the whole identity — woolkin is also round, but
  // its outline is scalloped and its mass is uniform.
  pumpkit: () => ({
    body: [
      nub(41, 80, 4.4, 12), nub(59, 80, 4.4, 12),
      taper(64, 66, 84, 42, 4.5, -0.55), taper(84, 42, 79, 25, 3.0, 0.5),
      egg(50, 68, 21, 20, 0.05),
      egg(50, 36, 28, 27, 0.0),
      taper(33, 21, 26, 3, 7, 0.15), taper(67, 21, 74, 3, 7, -0.15),
    ],
    eyes: [[42, 38, 3.4], [58, 38, 3.4]],
  }),
  // HONEST LIMIT, worth knowing before someone "fixes" this icon. Shalehound's identifying
  // feature is a pale keratin shield across its chest, and this is a one-ink cutout drawn
  // head-on: the shield sits INSIDE the body outline, so the union of these paths cannot
  // show it. Its 100px ink identity is what is left — four legs, an upright head and one
  // straight blade off the back, against five creatures whose every edge is an arc. The
  // shield is a value read, not an outline read. An earlier version of this icon drew a
  // dorsal slab above the head; that plate no longer exists on the creature (see the long
  // note in species.js) and the icon must not promise it.
  shalehound: () => ({
    body: [
      nub(31, 76, 5.2, 16), nub(45, 78, 5.0, 14), nub(55, 78, 5.0, 14), nub(69, 76, 5.2, 16),
      taper(26, 62, 9, 34, 4, 0.18),
      egg(50, 64, 29, 20, 0.0),
      egg(50, 41, 19, 20, 0.04),
      taper(38, 27, 31, 13, 5.5, 0.2), taper(62, 27, 69, 13, 5.5, -0.2),
    ],
    eyes: [[44, 43, 3.0], [56, 43, 3.0]],
  }),
};

/** unknown species still get a plausible pal: egg body + two big appendages */
function generic(id) {
  const h = hash(id);
  const earLen = 2 + h * 18;
  return {
    body: [
      nub(40, 76, 4.6, 16), nub(60, 76, 4.6, 16),
      egg(50, 60, 25 + h * 5, 26, 0.18),
      egg(50, 34, 20, 19, 0.05),
      taper(38, 22, 32 - h * 10, earLen, 7, 0.2),
      taper(62, 22, 68 + h * 10, earLen, 7, -0.2),
    ],
    eyes: [[43, 35, 3], [57, 35, 3]],
  };
}

export function silhouetteSVG(id, { size = 64, cls = '' } = {}) {
  const s = (BUILDERS[id] ?? (() => generic(id)))();
  const paths = s.body.map((d) => `<path d="${d}"/>`).join('');
  const eyes = s.eyes.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" class="eg-sil-eye"/>`).join('');
  return `<svg class="eg-sil ${cls}" width="${size}" height="${size}" viewBox="0 0 100 100"`
    + ` aria-hidden="true"><g filter="url(#eg-rough)">${paths}</g><g>${eyes}</g></svg>`;
}
