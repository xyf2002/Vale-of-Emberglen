import * as THREE from 'three';
import { clamp, lerp, smoothstep, hash2i } from './util.js';
import { mergeGeos, paint, applyMossShader } from './materials.js';
import { AX, AZ } from './terrain.js';

const C = (hex) => new THREE.Color(hex).convertSRGBToLinear();

/* ------------------------------------------------------------- foliage lighting */

/**
 * WRAPPED DIFFUSE for foliage.
 *
 * A meadow or a canopy is a translucent, self-scattering volume, not an opaque
 * Lambert plane: light bends through and around it. Strict Lambert on a
 * near-vertical grass normal delivers dot(n,l) ~ 0.15 under a 9 deg morning sun and
 * the whole carpet loses two thirds of its key -- which is precisely why the two
 * low-sun shots were the last to fail the ground/sky ratio while the midday ones
 * passed. Palworld's meadows never do that.
 *
 * The wrap is worth ~2.6x at dawn and ~1.2x at noon, which is the exact shape of the
 * error. It is applied by rewriting three's own Lambert direct-lighting chunk --
 * onBeforeCompile hands out the shader with `#include` directives STILL UNRESOLVED,
 * so patching the chunk body by string match on the raw source silently does
 * nothing (it did, for one whole iteration).
 */
const LAMBERT_DOTNL = 'float dotNL = saturate( dot( geometryNormal, directLight.direction ) );';

function wrappedLambertChunk(wrap) {
  const src = THREE.ShaderChunk.lights_lambert_pars_fragment;
  if (!src.includes(LAMBERT_DOTNL)) {
    console.warn('[vegetation] Lambert chunk changed shape; foliage wrap skipped');
    return null;
  }
  return src.replace(LAMBERT_DOTNL, `
    float dotNL = dot( geometryNormal, directLight.direction );
    dotNL = saturate((dotNL + ${wrap.toFixed(3)}) / ${(1 + wrap).toFixed(3)});
  `);
}

function applyFoliageWrap(sh, wrap) {
  const chunk = wrappedLambertChunk(wrap);
  if (chunk) sh.fragmentShader = sh.fragmentShader.replace('#include <lights_lambert_pars_fragment>', chunk);
}

/* ====================================================== PROP BROADPHASE ======== */

/**
 * A ray-queryable index of the solid props in the world.
 *
 * The ballistics systems march a ray against creature spheres and then against the
 * terrain heightfield, and reported the obvious hole: "props are not in the trace.
 * Trees, rocks and ruin walls are instanced and the world publishes no bounding-volume
 * list, so rounds pass through a tree and land on the ground behind it."
 *
 * They cannot fix that themselves — the transforms only exist inside the builders in
 * this file and props.js, and an InstancedMesh does not carry per-instance bounds. So
 * the builders register cheap analytic volumes as they place, and this publishes two
 * pure queries over them.
 *
 * Deliberately coarse. A trunk is a capped vertical cylinder, a canopy / boulder /
 * shrub is a sphere. This is not meant to be exact; it is meant to stop a round flying
 * through a tree, and a bullet that clips a leaf that was not quite there is invisible
 * where a bullet passing through a trunk is not.
 *
 * NO ALLOCATION PER CALL. queryProps fills and returns a module-scope result object,
 * propsNear fills and returns a module-scope array of pooled records. Both are only
 * valid until the next call — copy what you need. Both are pure: no side effects, no
 * mutation of world state.
 *
 * Registration is CHANNELLED so a rebuild replaces rather than duplicates: a builder
 * calls beginPropChannel('trees'), which drops everything previously registered under
 * that tag and hands back the two add functions.
 */
const SURF = ['wood', 'stone', 'foliage'];
const SURF_ID = { wood: 0, stone: 1, foliage: 2 };
const CELL = 8;                       // broadphase cell size, metres

const P = {
  n: 0,
  kind: [],       // 0 sphere, 1 capped vertical cylinder
  x: [], y: [], z: [],
  r: [],          // radius
  h: [],          // cylinders: half-height about y; spheres: unused (= r)
  surf: [],
  tag: [],
};
let propGrid = null;                  // Map<cellKey, number[]>, built lazily
let propSeen = new Int32Array(0);     // per-index visit stamp, so DDA never re-tests
let propStamp = 0;

export function beginPropChannel(tag) {
  if (P.n) {
    let w = 0;
    for (let i = 0; i < P.n; i++) {
      if (P.tag[i] === tag) continue;
      if (w !== i) {
        P.kind[w] = P.kind[i]; P.x[w] = P.x[i]; P.y[w] = P.y[i]; P.z[w] = P.z[i];
        P.r[w] = P.r[i]; P.h[w] = P.h[i]; P.surf[w] = P.surf[i]; P.tag[w] = P.tag[i];
      }
      w++;
    }
    P.n = w;
    P.kind.length = P.x.length = P.y.length = P.z.length = w;
    P.r.length = P.h.length = P.surf.length = P.tag.length = w;
  }
  propGrid = null;
  const push = (kind, x, y, z, r, h, surface) => {
    const i = P.n++;
    P.kind[i] = kind; P.x[i] = x; P.y[i] = y; P.z[i] = z;
    P.r[i] = r; P.h[i] = h; P.surf[i] = SURF_ID[surface] ?? 1; P.tag[i] = tag;
  };
  return {
    /** a boulder, a canopy, a shrub */
    sphere: (x, y, z, r, surface) => push(0, x, y, z, r, r, surface),
    /** a trunk or a column: vertical, capped, spanning y0..y1 */
    column: (x, z, r, y0, y1, surface) => push(1, x, (y0 + y1) * 0.5, z, r, (y1 - y0) * 0.5, surface),
  };
}

export function resetPropColliders() {
  P.n = 0;
  for (const k of ['kind', 'x', 'y', 'z', 'r', 'h', 'surf', 'tag']) P[k].length = 0;
  propGrid = null;
}

export function propColliderCount() { return P.n; }

function buildGrid() {
  propGrid = new Map();
  for (let i = 0; i < P.n; i++) {
    const r = P.r[i];
    const i0 = Math.floor((P.x[i] - r) / CELL), i1 = Math.floor((P.x[i] + r) / CELL);
    const j0 = Math.floor((P.z[i] - r) / CELL), j1 = Math.floor((P.z[i] + r) / CELL);
    for (let j = j0; j <= j1; j++) {
      for (let ii = i0; ii <= i1; ii++) {
        const key = ii * 73856093 ^ j * 19349663;
        let a = propGrid.get(key);
        if (!a) { a = []; propGrid.set(key, a); }
        a.push(i);
      }
    }
  }
  if (propSeen.length < P.n) propSeen = new Int32Array(P.n + 256);
}

const _hit = { point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 0 }, surface: 'stone', dist: 0, index: -1 };
const _near = [];        // returned; holds references into _pool
const _pool = [];        // grows once to the high-water mark, then never allocates

const cx_ = (v) => (Array.isArray(v) ? v[0] : v.x);
const cy_ = (v) => (Array.isArray(v) ? v[1] : v.y);
const cz_ = (v) => (Array.isArray(v) ? v[2] : v.z);

/** nearest t in (0, maxT] where the ray enters collider i, or -1 */
function hitAt(i, ox, oy, oz, dx, dy, dz, maxT) {
  const px = P.x[i], py = P.y[i], pz = P.z[i], r = P.r[i];
  if (P.kind[i] === 0) {
    const mx = ox - px, my = oy - py, mz = oz - pz;
    const b = mx * dx + my * dy + mz * dz;
    const c = mx * mx + my * my + mz * mz - r * r;
    if (c > 0 && b > 0) return -1;
    const disc = b * b - c;
    if (disc < 0) return -1;
    let t = -b - Math.sqrt(disc);
    if (t < 0) t = 0;
    return t <= maxT ? t : -1;
  }
  // capped vertical cylinder
  const hy = P.h[i], y0 = py - hy, y1 = py + hy;
  const mx = ox - px, mz = oz - pz;
  const a = dx * dx + dz * dz;
  if (a > 1e-9) {
    const b = mx * dx + mz * dz;
    const c = mx * mx + mz * mz - r * r;
    const disc = b * b - a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      let t = (-b - sq) / a;
      if (t < 0) t = (-b + sq) / a;
      if (t >= 0 && t <= maxT) {
        const y = oy + dy * t;
        if (y >= y0 && y <= y1) return t;
      }
    }
  }
  // caps
  if (Math.abs(dy) > 1e-9) {
    for (let k = 0; k < 2; k++) {
      const yc = k ? y1 : y0;
      const t = (yc - oy) / dy;
      if (t < 0 || t > maxT) continue;
      const qx = ox + dx * t - px, qz = oz + dz * t - pz;
      if (qx * qx + qz * qz <= r * r) return t;
    }
  }
  return -1;
}

/**
 * First solid prop along a ray.
 * @returns the shared result record, or null. Valid until the next call.
 */
export function queryProps(origin, dir, maxDist = 200) {
  if (!P.n) return null;
  if (!propGrid) buildGrid();
  const ox = cx_(origin), oy = cy_(origin), oz = cz_(origin);
  let dx = cx_(dir), dy = cy_(dir), dz = cz_(dir);
  const dl = Math.hypot(dx, dy, dz);
  if (dl < 1e-9) return null;
  dx /= dl; dy /= dl; dz /= dl;

  propStamp++;
  let best = -1, bestT = maxDist;

  // 2D DDA over the XZ grid — a 200 m ray touches ~25 cells, not the whole world
  let ci = Math.floor(ox / CELL), cj = Math.floor(oz / CELL);
  const ei = Math.floor((ox + dx * maxDist) / CELL), ej = Math.floor((oz + dz * maxDist) / CELL);
  const si = dx > 0 ? 1 : -1, sj = dz > 0 ? 1 : -1;
  const tdx = Math.abs(dx) > 1e-9 ? Math.abs(CELL / dx) : Infinity;
  const tdz = Math.abs(dz) > 1e-9 ? Math.abs(CELL / dz) : Infinity;
  let tmx = Math.abs(dx) > 1e-9 ? (((dx > 0 ? ci + 1 : ci) * CELL) - ox) / dx : Infinity;
  let tmz = Math.abs(dz) > 1e-9 ? (((dz > 0 ? cj + 1 : cj) * CELL) - oz) / dz : Infinity;

  // the +1 cell margin covers colliders whose centre is outside the cell the ray walks
  for (let guard = 0; guard < 512; guard++) {
    for (let oj = -1; oj <= 1; oj++) {
      for (let oi = -1; oi <= 1; oi++) {
        const list = propGrid.get(((ci + oi) * 73856093) ^ ((cj + oj) * 19349663));
        if (!list) continue;
        for (let k = 0; k < list.length; k++) {
          const idx = list[k];
          if (propSeen[idx] === propStamp) continue;
          propSeen[idx] = propStamp;
          const t = hitAt(idx, ox, oy, oz, dx, dy, dz, bestT);
          if (t >= 0 && t < bestT) { bestT = t; best = idx; }
        }
      }
    }
    // once the walked cell is further along the ray than the best hit, stop
    if (best >= 0 && Math.min(tmx, tmz) > bestT + CELL * 1.5) break;
    if (ci === ei && cj === ej) break;
    if (tmx < tmz) { ci += si; tmx += tdx; } else { cj += sj; tmz += tdz; }
    if (tmx > maxDist && tmz > maxDist) break;
  }

  if (best < 0) return null;
  const hx = ox + dx * bestT, hy = oy + dy * bestT, hz = oz + dz * bestT;
  _hit.point.x = hx; _hit.point.y = hy; _hit.point.z = hz;
  _hit.dist = bestT;
  _hit.index = best;
  _hit.surface = SURF[P.surf[best]];
  if (P.kind[best] === 0) {
    const r = Math.max(1e-4, P.r[best]);
    _hit.normal.x = (hx - P.x[best]) / r;
    _hit.normal.y = (hy - P.y[best]) / r;
    _hit.normal.z = (hz - P.z[best]) / r;
  } else {
    const dyTop = Math.abs(hy - (P.y[best] + P.h[best]));
    const dyBot = Math.abs(hy - (P.y[best] - P.h[best]));
    if (Math.min(dyTop, dyBot) < 1e-3) {
      _hit.normal.x = 0; _hit.normal.y = dyTop < dyBot ? 1 : -1; _hit.normal.z = 0;
    } else {
      const nx = hx - P.x[best], nz = hz - P.z[best];
      const nl = Math.max(1e-4, Math.hypot(nx, nz));
      _hit.normal.x = nx / nl; _hit.normal.y = 0; _hit.normal.z = nz / nl;
    }
  }
  return _hit;
}

/**
 * Every solid prop whose volume comes within `radius` of the vertical line at (x, z).
 * @returns the shared array of pooled records — read it, do not keep it.
 */
export function propsNear(x, z, radius = 6) {
  _near.length = 0;
  if (!P.n) return _near;
  if (!propGrid) buildGrid();
  const i0 = Math.floor((x - radius) / CELL), i1 = Math.floor((x + radius) / CELL);
  const j0 = Math.floor((z - radius) / CELL), j1 = Math.floor((z + radius) / CELL);
  propStamp++;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const list = propGrid.get((i * 73856093) ^ (j * 19349663));
      if (!list) continue;
      for (let k = 0; k < list.length; k++) {
        const idx = list[k];
        if (propSeen[idx] === propStamp) continue;
        propSeen[idx] = propStamp;
        const rr = P.r[idx] + radius;
        const ddx = P.x[idx] - x, ddz = P.z[idx] - z;
        if (ddx * ddx + ddz * ddz > rr * rr) continue;
        let rec = _pool[_near.length];
        if (!rec) { rec = { x: 0, y: 0, z: 0, r: 0, h: 0, surface: 'stone', shape: 'sphere' }; _pool.push(rec); }
        rec.x = P.x[idx]; rec.y = P.y[idx]; rec.z = P.z[idx];
        rec.r = P.r[idx]; rec.h = P.h[idx];
        rec.surface = SURF[P.surf[idx]];
        rec.shape = P.kind[idx] === 0 ? 'sphere' : 'column';
        _near.push(rec);
      }
    }
  }
  return _near;
}

/* --------------------------------------------------------- ground union ------- */

/**
 * BAKED CONTACT DARKENING — the thing that makes a prop sit IN the world.
 *
 * A blind critic named our foreground bush as the single decisive tell in the
 * creature-group pair: "an icosphere with berries stuck to it, sitting on the grass
 * with no contact shadow and no ambient occlusion at the ground line. It doesn't sit
 * in the world, it sits on top of the image."
 *
 * That is not a missing cast shadow — the bushes have castShadow on and always did.
 * It is missing *occlusion at the contact line*. Reference #9 is explicit that what
 * glues an object down is "a small, tight, distinctly darker ellipse directly under
 * the feet with a hard-ish inner core and ~0.2 m of falloff". 0.2 m is THREE shadow
 * texels at the live frustum, so the shadow map cannot draw it — the same arithmetic
 * that made grass casting a measured null result. It has to be baked.
 *
 * So: darken the fragment as a function of its height above its own instance origin.
 * Costs one varying and one smoothstep, needs no depth map, and works identically for
 * a tuft, a stone, a stump and a shrub. Composes with whatever onBeforeCompile the
 * material already had (applyMossShader, applyFoliageWrap) by chaining, and hooks
 * `emissivemap_fragment` rather than `color_fragment` so it lands AFTER the moss mix
 * instead of being overwritten by it.
 */
export function applyContactShade(mat, opts = {}) {
  // `sink` is where the ground plane sits relative to the instance origin, expressed
  // in units of instance scale: every builder in this project composes props at
  // `terrainY - s * sink`, so the terrain surface is at +sink*s in the varying's frame.
  // `rangeAbs/rangeRel` let a 4 m boulder and a 15 cm pebble both get a contact band
  // proportional to themselves without two materials.
  const { rangeAbs = 0.10, rangeRel = 0.25, dark = 0.46, sinkAbs = 0, sinkRel = 0 } = opts;
  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey;
  const f = (v) => v.toFixed(4);
  mat.onBeforeCompile = function (sh, renderer) {
    if (prev) prev.call(this, sh, renderer);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vCH; varying float vCS;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          vec4 cwp_ = vec4(transformed, 1.0);
          float cbase_ = 0.0;
          vCS = 1.0;
          #ifdef USE_INSTANCING
            cwp_ = instanceMatrix * cwp_;
            cbase_ = instanceMatrix[3].y;
            vCS = length(instanceMatrix[0].xyz);
          #endif
          vCH = cwp_.y - cbase_;
        }`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vCH; varying float vCS;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          float gy_ = ${f(sinkAbs)} + ${f(sinkRel)} * vCS;
          float rg_ = ${f(rangeAbs)} + ${f(rangeRel)} * vCS;
          diffuseColor.rgb *= mix(${f(dark)}, 1.0, smoothstep(0.0, max(rg_, 1e-3), vCH - gy_));
        }`);
  };
  const tag = `ct${rangeAbs}_${rangeRel}_${dark}_${sinkAbs}_${sinkRel}`;
  mat.customProgramCacheKey = prevKey ? () => prevKey.call(mat) + tag : () => tag;
  return mat;
}

/* ============================================================== GRASS ========== */

/**
 * Blade card: 3 tapered segments, 5 triangles, unit height, unit width.
 * Normals lean mostly upward so the carpet lights like the ground it sits on
 * (a fully face-on normal makes half the field go black when the sun is low).
 */
function bladeGeometry() {
  // Narrow. At 0.5 half-width the card was 1:4 width-to-height at the sizes we
  // instance it at, and a 1:4 taper is not a grass blade, it is a shark fin -- that
  // is exactly how the meadow read once the lighting was fixed. Real blades are
  // 1:15 or thinner, which is what lets thousands of them overlap into a carpet
  // instead of tiling as separate cones.
  const w0 = 0.075, w1 = 0.055, w2 = 0.030;
  const y1 = 0.45, y2 = 0.78, y3 = 1.0;
  const pos = [
    -w0, 0, 0, w0, 0, 0,
    -w1, y1, 0, w1, y1, 0,
    -w2, y2, 0, w2, y2, 0,
    0, y3, 0,
  ];
  const idx = [0, 1, 3, 0, 3, 2, 2, 3, 5, 2, 5, 4, 4, 5, 6];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  const n = [];
  for (let i = 0; i < 7; i++) n.push(0, 0.80, 0.60);
  g.setAttribute('normal', new THREE.Float32BufferAttribute(n, 3));
  return g;
}

/** blades fanned out — one instance reads as a clump at every distance */
function tuftGeometry(n = 5) {
  const parts = [];
  const angles = [-0.95, -0.42, 0.05, 0.48, 0.98];
  const scales = [[0.78, 0.66], [0.92, 0.86], [1.0, 1.0], [0.88, 0.78], [0.72, 0.60]];
  const offs = [[-0.30, -0.10], [-0.13, 0.14], [0.02, -0.02], [0.16, 0.12], [0.31, -0.13]];
  const pick = n >= 5 ? [0, 1, 2, 3, 4] : [0, 2, 4];
  for (const i of pick) {
    const b = bladeGeometry().toNonIndexed();
    b.scale(scales[i][0], scales[i][1], 1);
    b.rotateZ(angles[i] * 0.35);
    b.rotateY(angles[i] * 2.1);
    b.translate(offs[i][0], 0, offs[i][1]);
    parts.push(b);
  }
  return mergeGeos(parts);
}

// Reference #5: grass is a MID-VALUE, moderately desaturated yellow-green. The old
// set sat ~15% darker and greener than the reference plates measure (pw_11 lit
// foreground grass averages rgb 100/103/66, pw_15 ~118/122/70).
// Measured off the plates: real Palworld grass has R and G within a few percent of
// each other (pw_11 foreground 113/114/67, pw_15 96/107/49) -- it is a YELLOW-green,
// not a green. Ours was landing at 86/117/33, a pure poison green with the red
// channel a third of the way down, which is the whole of the "undersaturated world,
// oversaturated grass" complaint. Red lifted toward green, blue lifted out of the
// hole, value held.
// Round 12 addendum: the plates measure MORE chromatic than we render, not less.
// pw_11's lit foreground grass sits at sat 0.41 and pw_15's at 0.54 on the same
// (max-min)/max measure the instrument uses; our over-shoulder frame was rendering
// 0.24-0.25 and tripping the undersaturated flag. Chroma raised ~30% at identical
// value and with R still within 8% of G, so it stays the yellow-green the note above
// insists on rather than sliding back into poison green.
const GRASS_PAL = {
  lush: C(0xa4bf52),
  dry: C(0xc9c265),
  shade: C(0x7b9a4a),
  blue: C(0x93b86c),
};

export function createGrass(ctx, T) {
  const noise = ctx.noise;
  const q = clamp(ctx.quality.grassDensity ?? 1, 0.2, 1.5);
  const spread = 1 / Math.sqrt(q);

  // Reference #8: "a dense variegated carpet ... thousands of individual blade cards
  // roughly 0.3-0.6 m tall". Scattered single blades at 0.4 m spacing read as arrows
  // stuck in a painted sheet, which is what the frames showed once the lighting was
  // right. Four rings of 5-blade tufts instead: ~28k tufts / ~140k blades around the
  // camera, tight near the lens and coarsening with distance so the cost stays flat.
  // Still four draw calls.
  // Band heights raised in round 12. Banding the frame into quarters showed our
  // foreground measuring 0.38 saturation against pw_11's 0.541, and the reason was not
  // the blade palette: at 0.30 m the near carpet did not COVER, so most of the bottom
  // quarter was bare ground mesh showing between blades and the ground's own albedo
  // was setting the band's colour. Reference #8 puts the carpet at 0.3-0.6 m; we were
  // sitting on the floor of that range in the one band where it matters most.
  const BANDS = [
    { id: 11, r0: 0, r1: 12, step: 0.155 * spread, w: 0.245, h: 0.37, hv: 0.40, blades: 5 },
    { id: 22, r0: 11, r1: 32, step: 0.50 * spread, w: 0.48, h: 0.58, hv: 0.38, blades: 5 },
    { id: 33, r0: 30, r1: 70, step: 1.70 * spread, w: 0.78, h: 0.58, hv: 0.36, blades: 3 },
    { id: 44, r0: 66, r1: 130, step: 3.40 * spread, w: 1.35, h: 0.80, hv: 0.32, blades: 3 },
  ];

  const uniforms = {
    uTime: { value: 0 },
    uWind: { value: new THREE.Vector2(0.86, 0.51) },
    uGust: { value: 1.0 },
  };

  function makeMat() {
    const m = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
    m.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = uniforms.uTime;
      sh.uniforms.uWind = uniforms.uWind;
      sh.uniforms.uGust = uniforms.uGust;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          uniform float uTime; uniform vec2 uWind; uniform float uGust;
          varying float vBladeH;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vBladeH = position.y;`)
        .replace('#include <project_vertex>', `
          vec4 mvPosition = vec4( transformed, 1.0 );
          #ifdef USE_INSTANCING
            mvPosition = instanceMatrix * mvPosition;
          #endif
          {
            float hh = clamp(vBladeH, 0.0, 1.0);
            float bend = hh * hh;
            float ph = mvPosition.x * 0.13 + mvPosition.z * 0.09;
            float w1 = sin(uTime * 1.15 + ph);
            float w2 = sin(uTime * 2.7 + ph * 2.3 + 1.7) * 0.35;
            float gust = 0.55 + 0.45 * sin(uTime * 0.31 + mvPosition.x * 0.011 + mvPosition.z * 0.013);
            // Amplitude must be RELATIVE TO BLADE HEIGHT. It was in world metres, so a
            // 0.3 m blade was being displaced up to 0.46 m sideways -- a 57 degree lean.
            // The whole meadow lay over like wet brush strokes instead of standing up,
            // which is a big part of why the carpet read as painted-on rather than as
            // "thousands of blade cards leaning coherently under one breeze" (ref #8).
            float bladeLen = 1.0;
            #ifdef USE_INSTANCING
              bladeLen = length(instanceMatrix[1].xyz);
            #endif
            float amp = (0.10 + 0.22 * (w1 * 0.5 + 0.5) + 0.08 * w2) * gust * uGust * bladeLen;
            mvPosition.xz += uWind * (bend * amp);
            mvPosition.y -= bend * bend * amp * 0.30;
          }
          mvPosition = modelViewMatrix * mvPosition;
          gl_Position = projectionMatrix * mvPosition;`);
      // ------------------------------------------------------------------
      // THE BLACK MEADOW BUG.
      //
      // Blades are instanced with a NON-UNIFORM scale (~0.06 wide, ~0.45 tall).
      // three's instanced normal path applies the inverse transpose, which is
      // geometrically correct for a squashed card and visually fatal for grass:
      // it rotates the authored (0, .8, .6) normal almost fully HORIZONTAL. Every
      // blade whose random yaw pointed away from the key then lit on ambient only,
      // and because grass is viewed at a grazing angle it occludes the ground
      // completely from ~4 m out. Measured result: the bottom half of every
      // gameplay frame was rgb(29, 32, 42) -- ambient blue, i.e. unlit.
      //
      // Fix: rebuild the normal from the blade's YAW alone and tilt it only ~22 deg
      // off world up, so the carpet lights like the ground it grows out of
      // (reference #8 reads as one variegated surface, not 30k individually shaded
      // cards). DOUBLE_SIDED then tries to flip that mostly-up normal downward on
      // back faces, which would black out half the field again, so the fragment
      // stage restores the unflipped view-space normal.
      // ------------------------------------------------------------------
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vGrassN;')
        .replace('#include <defaultnormal_vertex>', `#include <defaultnormal_vertex>
          {
            vec3 hz = vec3(objectNormal.x, 0.0, objectNormal.z);
            vec3 dir = length(hz) > 1e-4 ? normalize(hz) : vec3(0.0, 0.0, 1.0);
            #ifdef USE_INSTANCING
              dir = normalize(mat3(instanceMatrix) * dir);
            #endif
            dir = normalize(mat3(modelMatrix) * dir);
            vec3 wn = normalize(vec3(0.0, 1.0, 0.0) + dir * 0.40);
            transformedNormal = normalize(mat3(viewMatrix) * wn);
            vGrassN = transformedNormal;
          }`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vBladeH;\nvarying vec3 vGrassN;')
        .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
          normal = normalize(vGrassN);
          nonPerturbedNormal = normal;`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          // Root occlusion. A carpet of blades reads as a TEXTURE because each blade
          // is dark where it enters the mat and bright at the tip -- that root-to-tip
          // ramp is most of the local contrast in the reference meadows (pw_15's
          // foreground grass measures 36 levels of luminance spread; a uniform-value
          // blade field measures 7). 0.76 -> 1.05 was too gentle to read at all past
          // two metres. 0.60 -> 1.16 still keeps the base above the "crushed to black"
          // line reference #9 warns about, while giving the carpet real structure.
          // Round 12: 0.60 was still too shallow, and the reason is measurable.
          // Quantising the foreground quarter at 16 levels per channel, our bins ran
          // r4-8 / g5-10 / b3-4 -- a 4-bin luminance span. pw_11's foreground runs
          // r1-15 / g2-14 / b0-9. Its darkest foreground grass sits at rgb 24/40/8,
          // i.e. real Palworld does crush its root shadow much harder than reference
          // #9's "never black" warning reads at first glance; what #9 forbids is a
          // FLAT black shadow, not a dark root. Widening the ramp is the single
          // biggest lever we own on both distinct-colour count and local contrast.
          diffuseColor.rgb *= mix(0.26, 1.38, smoothstep(0.0, 0.62, vBladeH));`);
      applyFoliageWrap(sh, 0.66);
    };
    m.customProgramCacheKey = () => 'grassblade';
    return m;
  }

  const group = new THREE.Group();
  group.name = 'grass';
  const meshes = [];
  const mat = makeMat();

  // The near-field clutter field rides on the grass rebuild: it is the same
  // camera-relative, world-anchored hash scatter, it needs the same trigger, and the
  // world system already calls grass.rebuild(camX, camZ) every frame. See
  // createGroundClutter for why the first 25 m had nothing in it.
  const clutter = createGroundClutter(ctx, T);
  group.add(clutter.group);

  for (const b of BANDS) {
    const area = Math.PI * (b.r1 * b.r1 - b.r0 * b.r0);
    const cap = Math.min(90000, Math.ceil((area / (b.step * b.step)) * 1.15) + 64);
    const geo = tuftGeometry(b.blades);
    const mesh = new THREE.InstancedMesh(geo, mat, cap);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    // ------------------------------------------------------------------
    // THE CARPET STILL DOES NOT CAST, AND THAT IS A MEASURED DECISION.
    //
    // The blind critique blamed "grass looks painted past ten metres" on missing
    // shadow, so this was tried: castShadow on the three near bands, at 2048 and at
    // 4096 shadow map. Measured on the wip-shadow round, against the identical build
    // with it off:
    //
    //   shadows-on/off pixel diff  1.564 -> 1.699   (noise)
    //   local contrast `edge`      4.75  -> 4.76 (over-shoulder), 5.51 -> 5.51 (vista)
    //   saturation, ratio, colours  identical to three decimal places
    //   triangles                  +200k on every shot, pushing past the budget
    //
    // A blade is 1.5-5 cm wide and a shadow texel is 6.8 cm at the current frustum, so
    // the depth map cannot resolve a blade at all; what it produces is sub-texel
    // speckle that the PCF filter then averages back to "lit". Grass self-shadowing
    // needs a technique that does not go through a depth map (screen-space, or the
    // baked root-to-tip occlusion ramp already applied in color_fragment below).
    // Leave it off rather than pay 200k triangles for a null result.
    // ------------------------------------------------------------------
    mesh.castShadow = false;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
    meshes.push({ b, mesh, cap });
  }

  const m4 = new THREE.Matrix4();
  const qt = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const col = new THREE.Color();
  let lastX = 1e9, lastZ = 1e9;
  let total = 0;

  function rebuild(camX, camZ) {
    const cx = Math.round(camX / 7) * 7;
    const cz = Math.round(camZ / 7) * 7;
    if (cx === lastX && cz === lastZ) return;
    lastX = cx; lastZ = cz;
    total = 0;
    clutter.rebuild(cx, cz);

    for (const { b, mesh, cap } of meshes) {
      const step = b.step;
      const i0 = Math.floor((cx - b.r1) / step), i1 = Math.ceil((cx + b.r1) / step);
      const j0 = Math.floor((cz - b.r1) / step), j1 = Math.ceil((cz + b.r1) / step);
      let n = 0;
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          if (n >= cap) break;
          const h0 = hash2i(i, j, b.id);
          const h1 = hash2i(i, j, b.id + 733);
          const x = i * step + (h0 - 0.5) * step * 0.98;
          const z = j * step + (h1 - 0.5) * step * 0.98;
          const dx = x - camX, dz = z - camZ;
          const d = Math.sqrt(dx * dx + dz * dz);
          if (d < b.r0 || d > b.r1) continue;

          const cov = T.grassAt(x, z);
          if (cov <= 0.03) continue;
          const h2 = hash2i(i, j, b.id + 1471);
          if (h2 > cov * 1.06) continue;

          const gy = T.heightAt(x, z);
          if (gy < T.waterLevel - 0.1) continue;

          const h3 = hash2i(i, j, b.id + 2213);
          const h4 = hash2i(i, j, b.id + 3307);
          const fade = smoothstep(b.r1, b.r1 - 12, d);
          const height = b.h * (0.72 + b.hv * 2 * h3) * (0.55 + 0.45 * cov) * fade;
          if (height < 0.04) continue;
          // BLADES GET BROADER AS THEY APPROACH THE LENS.
          //
          // The instrument grades local contrast on BOTH sides now, and the two close
          // shots went over the top of the band (creature_portrait 7.3 -> 12.7,
          // interaction_feed 6.4 -> 11.2) once the carpet got dense enough to fix the
          // over-shoulder frame. That is a real finding, not a metric artefact: at 1-3 m
          // a 1.8 cm blade is four pixels wide, so a dense field of them is pure
          // per-pixel noise -- "uniformly, mercilessly sharp, every plane equally crisp".
          //
          // pw_15's foreground blades measure 2-4 cm across, not 1.8, and they overlap
          // into readable leaves rather than hatching. Widening with proximity keeps the
          // coverage (which is what carries the near-field saturation) while cutting the
          // number of silhouette edges crossing any one pixel, and it leaves the 10 m+
          // carpet -- where the over-shoulder frame does its measuring -- untouched.
          const width = b.w * (0.8 + 0.5 * h4) * (1 + 0.95 * smoothstep(7.0, 1.2, d));

          qt.setFromAxisAngle(up, h0 * Math.PI * 2);
          m4.compose(
            { x, y: gy - 0.04, z },
            qt,
            { x: width, y: height, z: width },
          );
          mesh.setMatrixAt(n, m4);

          // Per-tuft tint. Reference #8: the carpet varies blade-to-blade AND in
          // broad patches; a single flat green is the loudest fake-meadow tell.
          // Three scales of variation stack here: metre-scale scuff, tens-of-metres
          // dry/lush drift, and tuft-to-tuft value jitter.
          const dryN = noise.fbm(x * 0.0085 + 61, z * 0.0085 - 19, 2);
          const dry = smoothstep(-0.22, 0.30, dryN);
          const scuff = smoothstep(-0.30, 0.35, noise.fbm(x * 0.085 - 12, z * 0.085 + 7, 2));
          const moist = smoothstep(16, 4, gy) * 0.55;
          col.copy(GRASS_PAL.lush).lerp(GRASS_PAL.dry, clamp(dry * 0.8 + scuff * 0.30, 0, 1));
          col.lerp(GRASS_PAL.shade, moist * 0.5);
          col.lerp(GRASS_PAL.blue, smoothstep(0.30, 0.80, h4) * 0.55);
          col.lerp(GRASS_PAL.dry, smoothstep(0.55, 0.95, h0) * 0.30);
          // thinner cover => drier, more exposed blades, so the bald spots read
          col.lerp(GRASS_PAL.dry, (1 - cov) * 0.35);
          // Tuft-to-tuft value spread. Too wide and the brightest tufts catch the
          // tip highlight as well and the meadow glitters like tinsel. 0.70-1.30 is
          // as far as that goes before it sparkles, and it is worth taking: this and
          // the root-to-tip ramp are the two terms that turn a field of instanced
          // cards into something that measures like a carpet.
          const v = 0.70 + 0.60 * h3;
          col.multiplyScalar(v);
          // ------------------------------------------------------------------
          // AERIAL PERSPECTIVE HAS TO START AT YOUR FEET.
          //
          // Reference #7 stacks three depth planes and names the nearest one "warm
          // SATURATED foreground grass", with the far plane's "saturation crushed to
          // near zero". We had the far end (makeAerialMaterial) and not the near end,
          // so the carpet ran at one chroma from 1 m to 130 m.
          //
          // Measured, banding the over-shoulder frame into quarters: pw_11's bottom
          // quarter measures saturation 0.541 and pw_15's 0.484, against our 0.381 —
          // and our *middle* bands already match theirs. The entire saturation deficit
          // that trips the instrument's undersaturated flag lives in the nearest 10 m.
          // ------------------------------------------------------------------
          const chroma = 1 + 1.05 * smoothstep(95, 2, d);
          if (chroma > 1.001) {
            const l = col.r * 0.2126 + col.g * 0.7152 + col.b * 0.0722;
            col.setRGB(
              Math.max(0, l + (col.r - l) * chroma),
              Math.max(0, l + (col.g - l) * chroma),
              Math.max(0, l + (col.b - l) * chroma));
          }
          mesh.setColorAt(n, col);
          n++;
        }
      }
      mesh.count = n;
      total += n;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  return {
    group,
    rebuild,
    get count() { return total; },
    get clutterCount() { return clutter.count; },
    update(dt, elapsed) {
      uniforms.uTime.value = elapsed;
    },
  };
}

/* ============================================================== FLOWERS ======== */

function flowerGeometry(petals = 5, head = 1) {
  const parts = [];
  // ------------------------------------------------------------------------
  // THE INVISIBLE FLOWERS.
  //
  // 656 flowers were being placed and not one of them appeared in any capture.
  // They were not culled and they were not mis-coloured: the bloom sat at 0.25 m
  // and the grass around it is instanced at 0.30-0.40 m, so every single flower in
  // the world was standing UNDER the blade carpet. Three rounds of "add more
  // flower clusters" moved the measured colour count by exactly zero, twice, which
  // is what finally pointed at the height rather than the count.
  //
  // Reference #8 wants flower clusters visible as clusters. The bloom now sits at
  // 0.47 m, clear of the 0.30-0.40 m blade line with room for the wind lean.
  // ------------------------------------------------------------------------
  const STEM = 0.46, HEAD = 0.47;
  // stem
  const stem = new THREE.PlaneGeometry(0.016, STEM).translate(0, STEM * 0.5, 0);
  parts.push(paint(stem, 0x6f8a3e));
  const stem2 = stem.clone().rotateY(Math.PI / 2);
  parts.push(paint(stem2, 0x6f8a3e));
  // petals
  for (let p = 0; p < petals; p++) {
    const a = (p / petals) * Math.PI * 2;
    const pet = new THREE.PlaneGeometry(0.062 * head, 0.096 * head);
    pet.rotateX(-Math.PI / 2);
    pet.translate(0, 0, 0.060 * head);
    pet.rotateX(-0.30);
    pet.rotateY(a);
    pet.translate(0, HEAD, 0);
    parts.push(paint(pet, 0xffffff));
  }
  // centre
  const mid = new THREE.CircleGeometry(0.028 * head, 6).rotateX(-Math.PI / 2).translate(0, HEAD + 0.008, 0);
  parts.push(paint(mid, 0xffd75a));
  return mergeGeos(parts);
}

export function createFlowers(ctx, T, rng) {
  const noise = ctx.noise;
  const geo = flowerGeometry(5);
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const PALETTE = [0xef7fa8, 0xf6b3cd, 0xfaf3ee, 0xf2d873, 0xc79ce2, 0xf28f6a];
  const spots = [];

  const q = clamp(ctx.quality.grassDensity ?? 1, 0.3, 1.5);
  // Clusters of 5-15 blooms — never an even scatter (reference observation #8).
  // Reference #8 also says flowers appear "in a couple of spots PER FRAME"; at 46
  // clusters spread over a 230 m disc the expected count inside any one gameplay
  // framing was well under one, so in practice the meadow had none. More clusters,
  // and the inner radius pulled in to 5 m so some of them land in the near field
  // where they read as flowers rather than as coloured specks.
  const clusters = Math.round(78 * q);
  for (let i = 0; i < clusters; i++) {
    let cx = 0, cz = 0, ok = false;
    for (let t = 0; t < 24; t++) {
      const a = rng.next() * Math.PI * 2;
      const r = 5 + Math.pow(rng.next(), 0.8) * 210;
      cx = Math.cos(a) * r; cz = Math.sin(a) * r;
      if (T.slopeAt(cx, cz) > 0.30) continue;
      if (T.grassAt(cx, cz) < 0.55) continue;
      if (T.heightAt(cx, cz) < T.waterLevel + 1.2) continue;
      ok = true; break;
    }
    if (!ok) continue;
    const hue = PALETTE[rng.int(0, PALETTE.length - 1)];
    const n = rng.int(5, 15);
    const rad = rng.range(0.7, 2.6);
    spots.push({ cx, cz, n, rad, hue, scale: rng.range(0.85, 1.35) });
  }
  // Broad drifts, like the pink field pw_11 lays across its middle distance. That
  // field is a big part of why pw_11 renders 1056 distinct colours where our
  // over-shoulder renders 362: it puts a large mass of a hue that appears NOWHERE
  // else in the frame into the mid ground. Three drifts scattered over a 195 m disc
  // meant a given camera framing usually contained zero of them.
  // Half of them are aimed down the composed vista axis rather than scattered over
  // the full 360 degrees. With seven drifts on a random azimuth the expected number
  // inside a 62-degree framing is about 1.2, and it was landing behind the player:
  // adding drifts changed the measured colour count by literally zero. The world is
  // composed around one axis (see terrain.js) and every wide shot looks along it, so
  // that is where the mid-ground colour mass belongs.
  const AXA = Math.atan2(AZ, AX);
  const drifts = Math.round(7 * q);
  for (let i = 0; i < drifts; i++) {
    for (let t = 0; t < 40; t++) {
      const a = (i % 2 === 0)
        ? AXA + rng.range(-0.85, 0.85)
        : rng.next() * Math.PI * 2;
      const r = 22 + Math.sqrt(rng.next()) * 145;
      const cx = Math.cos(a) * r, cz = Math.sin(a) * r;
      if (T.slopeAt(cx, cz) > 0.24 || T.grassAt(cx, cz) < 0.66) continue;
      if (T.heightAt(cx, cz) < T.waterLevel + 1.5) continue;
      spots.push({ cx, cz, n: rng.int(110, 190), rad: rng.range(8, 18), hue: rng.pick([0xef7fa8, 0xf6b3cd, 0xfaf3ee, 0xe4d36a]), scale: rng.range(0.9, 1.25) });
      break;
    }
  }

  let cap = 0;
  for (const s of spots) cap += s.n;
  cap = Math.max(1, cap);
  const mesh = new THREE.InstancedMesh(geo, mat, cap);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
  mesh.castShadow = false;
  mesh.receiveShadow = false;

  const m4 = new THREE.Matrix4();
  const qt = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const col = new THREE.Color();
  let n = 0;
  for (const s of spots) {
    const base = new THREE.Color(s.hue).convertSRGBToLinear();
    for (let k = 0; k < s.n && n < cap; k++) {
      const a = rng.next() * Math.PI * 2;
      const r = Math.sqrt(rng.next()) * s.rad;
      const x = s.cx + Math.cos(a) * r, z = s.cz + Math.sin(a) * r;
      if (T.grassAt(x, z) < 0.35) continue;
      const y = T.heightAt(x, z);
      if (y < T.waterLevel + 0.6) continue;
      const sc = s.scale * (0.72 + rng.next() * 0.6);
      qt.setFromAxisAngle(up, rng.next() * Math.PI * 2);
      m4.compose({ x, y: y - 0.02, z }, qt, { x: sc, y: sc * (0.85 + rng.next() * 0.5), z: sc });
      mesh.setMatrixAt(n, m4);
      col.copy(base).multiplyScalar(0.82 + rng.next() * 0.42);
      mesh.setColorAt(n, col);
      n++;
    }
  }
  mesh.count = n;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  return { mesh, count: n };
}

/* ====================================================== NEAR-FIELD CLUTTER ===== */

/**
 * THE FIRST 25 METRES WERE EMPTY, AND IT WAS A PLACEMENT BUG, NOT A LIGHTING BUG.
 *
 * Round 11 proved cast shadows render. The near field still showed none. Measured
 * per-band down the over-shoulder frame (0 = sky, 5 = nearest), shadowed fraction of
 * the key's potential was 0.011 / 0.042 / 0.186 / 0.050 / 0.000 / 0.027 — band 2, the
 * mid distance where trees and rocks live, works; the near meadow is exactly zero.
 * Shrinking the shadow ortho box to 30 m half-size (1.5 cm/texel over the near field)
 * made it WORSE, which rules out resolution. Nothing was casting because nothing was
 * there.
 *
 * Why nothing was there: every prop scatter in this project is `r = r0 + sqrt(u) * 330`,
 * i.e. uniform per unit AREA over a ~350,000 m^2 disc. The first 25 m is 1,960 m^2 —
 * 0.55% of that disc. 560 pebbles and 300 shrubs therefore put ~3 pebbles and ~2 shrubs
 * anywhere a gameplay camera can see them, and terrain bias culled most of those. The
 * mid ground looks dressed for the same reason the near field looks bald: at 60 m a
 * single screen row covers thousands of square metres, at 3 m it covers one.
 *
 * Fix: a camera-relative clutter field, built the way the grass carpet already is —
 * world-anchored hash grid, rebuilt when the camera moves 7 m, constant instance count
 * regardless of where you stand. Six families, each with its own grid, spacing, terrain
 * gate and low-frequency clumping mask so the result is not an even sprinkle (ref #8:
 * "Uniform density is the single most common tell of a fake meadow"):
 *
 *   stones     0.10-0.55 m field stones, half-buried, moss on the up faces
 *   outcrops   1.0-2.0 m flat bedrock slabs, the only real height variation down here
 *   ferns      arching multi-frond clumps, deeper and bluer than the grass
 *   weeds      knee-to-thigh dock/dry-grass clumps in ochre, above the blade line
 *   deadwood   fallen branches and broken stumps WITH ROOT FLARE, warm bark browns
 *   blooms     tight flower clusters, gated hard so they land in patches not everywhere
 *
 * All of them cast and receive except the blooms. A 0.4 m stone is six shadow texels
 * across at the live frustum, so unlike a grass blade (see the note in createGrass)
 * these resolve — that is the difference between this and re-litigating blade shadows.
 */

/** one arching leaf ribbon: width peaks a third of the way up, tip tapers to a point */
function frondGeometry(len, wid, tilt0, arc, segs = 5) {
  const pos = [], idx = [];
  let x = 0, y = 0;
  const dl = len / segs;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const th = tilt0 + arc * t * t;
    const w = wid * (Math.sin(Math.PI * Math.pow(clamp(t, 0, 1), 0.55)) * 0.94 + 0.06);
    // offset perpendicular to the arc tangent, inside the arc plane
    const ox = Math.cos(th) * w, oy = -Math.sin(th) * w;
    pos.push(x - ox, y - oy, 0, x + ox, y + oy, 0);
    if (i < segs) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    x += Math.sin(th) * dl; y += Math.cos(th) * dl;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // A ribbon lying in the arc plane has a HORIZONTAL normal at its base — the exact
  // shape of the black-meadow bug documented in createGrass. Lean every normal hard
  // toward world up so a clump lights like the ground it grows out of.
  const nr = g.attributes.normal;
  for (let i = 0; i < nr.count; i++) {
    const v = new THREE.Vector3(nr.getX(i), nr.getY(i), nr.getZ(i));
    v.y += 1.15; v.normalize();
    nr.setXYZ(i, v.x, v.y, v.z);
  }
  return g.toNonIndexed();
}

/** a clump of fronds fanned around a centre, tinted root-dark to tip-bright */
function frondClump(rng, n, len, wid, tilt0, arc, hexes) {
  const parts = [];
  for (let i = 0; i < n; i++) {
    const az = (i / n) * Math.PI * 2 + rng.range(-0.35, 0.35);
    const s = rng.range(0.72, 1.15);
    const g = frondGeometry(len * s, wid * s, tilt0 + rng.range(-0.12, 0.12), arc * rng.range(0.8, 1.25));
    g.rotateY(az);
    g.translate(Math.cos(az) * len * 0.06, 0, Math.sin(az) * len * 0.06);
    const base = new THREE.Color(hexes[rng.int(0, hexes.length - 1)]);
    const p = g.attributes.position;
    const arr = new Float32Array(p.count * 3);
    const top = len * 0.9;
    for (let k = 0; k < p.count; k++) {
      // Same root-to-tip ramp that gives the grass carpet its local contrast. The top
      // end used to be 1.22, which stacked with the 1.24 per-instance value jitter to
      // push tips 51% over their authored albedo; the tone mapper then desaturated
      // them and mean frame saturation fell out of band. 1.05 keeps the ramp doing its
      // job without bleaching the tips.
      const v = lerp(0.34, 1.30, clamp(p.getY(k) / top, 0, 1));
      arr[k * 3] = base.r * v; arr[k * 3 + 1] = base.g * v; arr[k * 3 + 2] = base.b * v;
    }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    parts.push(g);
  }
  return mergeGeos(parts);
}

/** small faceted field stone; `flat` squashes it into a bedrock slab */
function stoneGeometry(rng, noise, detail, flat) {
  const g = new THREE.IcosahedronGeometry(1, detail).toNonIndexed();
  const p = g.attributes.position;
  const sx = rng.range(0.80, 1.40);
  const sy = flat ? rng.range(0.38, 0.60) : rng.range(0.55, 0.92);
  const sz = rng.range(0.80, 1.40);
  const ph = rng.range(0, 9);
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    // `- ph`: the phase must come back out or it translates the stone instead of
    // banding it, lifting it 0.5*ph off the ground. See src/world/props.js.
    const band = Math.round((y + ph) * 3.1) / 3.1 - ph;
    y = lerp(y, band, 0.5);
    const d = 1 + 0.26 * noise.fbm(x * 2.6 + ph, z * 2.6 - ph, 3) + 0.13 * noise.fbm(y * 4.1, x * 4.1, 2);
    p.setXYZ(i, x * d * sx, y * d * sy, z * d * sz);
  }
  g.computeVertexNormals();
  const nr = g.attributes.normal;
  // authored in ONE conversion (see paint()): 0x7a786f lands at ~0.20 linear, which is
  // where the world's big rocks sit after liftVertexAlbedo, so a field stone and a
  // boulder read as the same material
  const a = new THREE.Color(0x7a786f), b = new THREE.Color(0x8d897b), c = new THREE.Color();
  const arr = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const t = clamp(0.5 + 0.5 * noise.fbm(p.getX(i) * 3.0 + ph, p.getZ(i) * 3.0, 2), 0, 1);
    c.copy(a).lerp(b, t);
    const v = (0.74 + 0.34 * clamp(nr.getY(i) * 0.5 + 0.5, 0, 1)) * (0.92 + 0.16 * t);
    arr[i * 3] = c.r * v; arr[i * 3 + 1] = c.g * v; arr[i * 3 + 2] = c.b * v;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

/** a fallen branch lying in the grass — one long readable horizontal in a vertical field */
function branchGeometry(rng, noise) {
  const parts = [];
  const BARK = [0x7d6f58, 0x6f6047, 0x8a7c63];
  const limb = (len, r0, r1, bend) => {
    const SEG = 6, SIDES = 5;
    const pos = [], idx = [];
    for (let i = 0; i <= SEG; i++) {
      const t = i / SEG;
      const r = lerp(r0, r1, t);
      const cy = bend * Math.sin(t * Math.PI) * len * 0.10;
      for (let s = 0; s < SIDES; s++) {
        const a = (s / SIDES) * Math.PI * 2;
        pos.push(t * len, cy + Math.cos(a) * r, Math.sin(a) * r);
      }
      if (i < SEG) {
        for (let s = 0; s < SIDES; s++) {
          const s2 = (s + 1) % SIDES;
          const A = i * SIDES + s, B = i * SIDES + s2, Cq = (i + 1) * SIDES + s, D = (i + 1) * SIDES + s2;
          idx.push(A, Cq, B, B, Cq, D);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  };
  const L = rng.range(1.1, 2.4);
  const R = rng.range(0.045, 0.095);
  const main = limb(L, R, R * 0.35, rng.range(-1, 1));
  main.rotateY(rng.range(-0.2, 0.2));
  parts.push(paint(main, BARK[rng.int(0, 2)], 0.14, noise));
  // one or two stubs, which is what stops it reading as a dropped pipe
  const stubs = rng.int(1, 2);
  for (let i = 0; i < stubs; i++) {
    const t = rng.range(0.2, 0.75);
    const s = limb(rng.range(0.25, 0.6), R * 0.55, R * 0.18, 0.4);
    s.rotateZ(rng.range(0.25, 0.8) * (rng.bool() ? 1 : -1));
    s.rotateY(rng.range(0.6, 2.4));
    s.translate(t * L, R * 0.4, 0);
    parts.push(paint(s, BARK[rng.int(0, 2)], 0.14, noise));
  }
  const g = mergeGeos(parts);
  g.translate(-L * 0.4, R * 0.9, 0);
  return g;
}

/** broken stump with a splayed root flare — reference #8's missing "root flare" */
function stumpGeometry(rng, noise) {
  const parts = [];
  const h = rng.range(0.35, 0.72);
  const r = rng.range(0.16, 0.30);
  const trunk = new THREE.CylinderGeometry(r * 0.85, r * 1.15, h, 7, 2, true).toNonIndexed();
  const tp = trunk.attributes.position;
  for (let i = 0; i < tp.count; i++) {
    const y = tp.getY(i) + h / 2;
    // jagged snapped top
    if (y > h * 0.88) tp.setY(i, tp.getY(i) + Math.abs(noise.fbm(tp.getX(i) * 9, tp.getZ(i) * 9, 2)) * h * 0.38);
  }
  trunk.translate(0, h / 2, 0);
  trunk.computeVertexNormals();
  parts.push(paint(trunk, 0x6b5c45, 0.16, noise));
  // splayed roots
  const n = rng.int(4, 6);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const len = r * rng.range(2.4, 4.2);
    const root = new THREE.CylinderGeometry(r * 0.10, r * 0.42, len, 5, 1, true).toNonIndexed();
    root.translate(0, len / 2, 0);
    root.rotateX(Math.PI * 0.5 - rng.range(0.10, 0.30));
    root.rotateY(a);
    root.translate(0, r * 0.30, 0);
    root.computeVertexNormals();
    parts.push(paint(root, 0x62553f, 0.16, noise));
  }
  // pale heartwood disc on the break
  const disc = new THREE.CircleGeometry(r * 0.8, 7).rotateX(-Math.PI / 2).translate(0, h * 0.99, 0);
  parts.push(paint(disc, 0xa89272, 0.10, noise));
  return mergeGeos(parts);
}

/** a small shrub: 3-4 fused lobes, up-face-brighter, sized for the 5-20 m band */
function shrubGeometry(rng, noise, n) {
  const parts = [];
  const base = new THREE.Color(BUSH_PAL[rng.int(0, BUSH_PAL.length - 1)]);
  for (let i = 0; i < n; i++) {
    const r = rng.range(0.30, 0.52);
    const g = lobe(rng, noise, r, 1.18, 0.82, 0);
    g.translate(rng.range(-0.30, 0.30), r * 0.68 + rng.range(0, 0.16), rng.range(-0.30, 0.30));
    const p = g.attributes.position, nr = g.attributes.normal;
    const arr = new Float32Array(p.count * 3);
    for (let k = 0; k < p.count; k++) {
      const val = 0.70 + 0.42 * clamp(nr.getY(k) * 0.5 + 0.5, 0, 1) + 0.16 * noise.fbm(p.getX(k) * 2.6, p.getZ(k) * 2.6, 2);
      arr[k * 3] = base.r * val; arr[k * 3 + 1] = base.g * val; arr[k * 3 + 2] = base.b * val;
    }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    parts.push(g);
  }
  return mergeGeos(parts);
}

export function createGroundClutter(ctx, T) {
  const noise = ctx.noise;
  const rng = ctx.rng.fork(1801);
  const q = clamp(ctx.quality.grassDensity ?? 1, 0.35, 1.5);
  const group = new THREE.Group();
  group.name = 'clutter';

  const stoneMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  applyMossShader(stoneMat, 0x6f8c3c, { amount: 1.15 });
  // stones and outcrops share a material, and both are composed sunk ~0.34-0.46 of
  // their own radius, so the ground plane tracks instance scale
  applyContactShade(stoneMat, { rangeAbs: 0.05, rangeRel: 0.40, dark: 0.42, sinkRel: 0.38 });
  const woodMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  applyContactShade(woodMat, { rangeAbs: 0.08, rangeRel: 0.16, dark: 0.38, sinkRel: 0.02 });
  const foliageMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  foliageMat.onBeforeCompile = (sh) => applyFoliageWrap(sh, 0.62);
  foliageMat.customProgramCacheKey = () => 'foliagewrap62';
  applyContactShade(foliageMat, { rangeAbs: 0.04, rangeRel: 0.13, dark: 0.40, sinkRel: 0.05 });
  const bloomMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  applyContactShade(bloomMat, { rangeAbs: 0.04, rangeRel: 0.08, dark: 0.55, sinkRel: 0.02 });

  // ------------------------------------------------------------------
  // WHAT IS ACTUALLY IN A PALWORLD FOREGROUND — measured off the plates, because the
  // first version of this file guessed and guessed wrong.
  //
  // pw_15's bottom third is not rocks and logs. It is a THICKET of arching leaf tufts
  // 0.3-0.6 m tall, individually readable, dark at the root and bright at the tip,
  // overlapping each other, with one bare earth patch and one pink flower cluster cut
  // into it. pw_11 is the same: dense tuft mass, a worn path through it, a magenta
  // drift. Rocks and deadwood are garnish; the tuft mass is the dish.
  //
  // Our blade carpet already stands at 22 tufts/m^2 but each blade is 1.5 cm wide, so
  // it reads as a scatter of thin spikes over a smooth painted plane. What is missing
  // is the next size class up: 6-9 cm broad leaves in clumps, roughly 1 clump/m^2 in
  // the first 12 m. That is the whole gap, and it is also why nothing was casting —
  // a 0.5 m arching clump is seven shadow texels across, a 1.5 cm blade is a fifth of
  // one (see the note in createGrass, which stands).
  //
  // Density is therefore banded exactly the way the grass carpet is banded: a tight
  // near grid and a coarse far grid on separate world-anchored hashes, so the cost is
  // flat, the far field does not turn into scrubland, and nothing pops — items grow in
  // over the last 7 m of their own ring.
  // ------------------------------------------------------------------
  // Value spread is deliberate: the darkest and brightest tuft hues sit two stops
  // apart, which is where the frame's local contrast comes from. A single mid green
  // measures like the flat carpet it is meant to break up.
  const TUFT = [0x2f5622, 0x3e6a25, 0x568428, 0x6f9c30, 0x8fb03a, 0x54873c];
  // ochre and straw — reference #8's dry patches, and the warm mass that keeps mean
  // saturation from falling when a few hundred grey stones arrive
  const WEED = [0x8f7830, 0xa89334, 0x76852e, 0xbaa242, 0x6a6c2a];

  const tuftGeos = (n, len, wid, tilt, arc, pal) => frondClump(rng, n, len, wid, tilt, arc, pal);

  /**
   * A clutter family. `step` is the grid pitch in metres, `r1` the outer radius.
   * `gate(x, z, h)` returns the 0..1 acceptance probability for a cell and is where the
   * low-frequency clumping masks live — a constant here would give the even sprinkle
   * reference #8 calls the single most common fake-meadow tell.
   */
  const st = (v) => v / Math.sqrt(q);
  const KINDS = [
    // ---- the thicket: broad-leaf tufts, near grid then far grid ----
    {
      key: 'tuftNear', id: 5307, step: st(0.74), r1: 13, cast: true, mat: foliageMat,
      // `wid` is a HALF width. The first pass ran it at 0.070 and produced 14 cm leaves
      // — the near field grew banana plants. pw_15's foreground blades measure 2-4 cm
      // across and there are a dozen-plus per clump; that ratio is the whole look.
      geos: () => [
        tuftGeos(13, 0.52, 0.016, 0.45, 1.25, TUFT),
        tuftGeos(16, 0.42, 0.013, 0.35, 1.45, TUFT),
        tuftGeos(11, 0.64, 0.020, 0.55, 1.05, TUFT),
      ],
      gate: (x, z) => {
        const m = noise.fbm(x * 0.055 - 7, z * 0.055 + 15, 3);
        return clamp((0.30 + smoothstep(-0.26, 0.30, m) * 0.72) * clamp(T.grassAt(x, z) * 1.5, 0, 1), 0, 1);
      },
      place: (h) => ({ s: 0.75 + h * 0.85, sink: 0.05, tilt: 0.14 }),
    },
    {
      key: 'tuftFar', id: 5311, step: st(2.05), r1: 33, cast: true, mat: foliageMat,
      geos: () => [
        tuftGeos(12, 0.58, 0.019, 0.48, 1.20, TUFT),
        tuftGeos(14, 0.48, 0.015, 0.40, 1.40, TUFT),
      ],
      gate: (x, z) => {
        const m = noise.fbm(x * 0.055 - 7, z * 0.055 + 15, 3);
        return clamp((0.34 + smoothstep(-0.26, 0.30, m) * 0.70) * clamp(T.grassAt(x, z) * 1.5, 0, 1), 0, 1);
      },
      place: (h) => ({ s: 0.85 + h * 1.00, sink: 0.05, tilt: 0.14 }),
    },
    // ---- dry docks: taller than the blade line, ochre, the warm half of the mass ----
    {
      key: 'weedNear', id: 5419, step: st(1.02), r1: 13, cast: true, mat: foliageMat,
      geos: () => [
        tuftGeos(10, 0.86, 0.014, 0.18, 0.62, WEED),
        tuftGeos(12, 0.66, 0.012, 0.26, 0.80, WEED),
      ],
      gate: (x, z) => {
        const m = noise.fbm(x * 0.041 + 23, z * 0.041 - 12, 2);
        return clamp(0.12 + smoothstep(-0.16, 0.34, m) * 0.80 + T.dirtAt(x, z) * 0.40, 0, 1);
      },
      place: (h) => ({ s: 0.65 + h * 0.75, sink: 0.04, tilt: 0.14 }),
    },
    {
      key: 'weedFar', id: 5423, step: st(2.6), r1: 30, cast: true, mat: foliageMat,
      geos: () => [
        tuftGeos(10, 0.98, 0.016, 0.20, 0.62, WEED),
        tuftGeos(11, 0.76, 0.013, 0.28, 0.80, WEED),
      ],
      gate: (x, z) => {
        const m = noise.fbm(x * 0.041 + 23, z * 0.041 - 12, 2);
        return clamp(0.14 + smoothstep(-0.16, 0.34, m) * 0.78 + T.dirtAt(x, z) * 0.40, 0, 1);
      },
      place: (h) => ({ s: 0.75 + h * 0.90, sink: 0.04, tilt: 0.14 }),
    },
    // ---- garnish: stones, bedrock, deadwood, blooms ----
    {
      key: 'stone', id: 5101, step: st(4.4), r1: 40, cast: true, mat: stoneMat,
      geos: () => [stoneGeometry(rng, noise, 0, false), stoneGeometry(rng, noise, 0, false), stoneGeometry(rng, noise, 1, false)],
      gate: (x, z) => {
        const m = noise.fbm(x * 0.030 + 11, z * 0.030 - 4, 2);
        return clamp(0.08 + smoothstep(-0.18, 0.30, m) * 0.80 + T.slopeAt(x, z) * 1.1 + T.dirtAt(x, z) * 0.5, 0, 1);
      },
      place: (h) => ({ s: 0.13 + h * h * 0.56, sink: 0.34, tilt: 0.34 }),
    },
    {
      key: 'outcrop', id: 5203, step: st(11.5), r1: 46, cast: true, mat: stoneMat,
      // bedrock breaks through where the ground is already working — slopes and worn
      // dirt — so the flat meadow the player spawns and gathers berries on stays clear
      geos: () => [stoneGeometry(rng, noise, 1, true), stoneGeometry(rng, noise, 1, true)],
      gate: (x, z) => clamp(-0.10 + T.slopeAt(x, z) * 3.4 + T.dirtAt(x, z) * 1.0 + smoothstep(0.05, 0.45, noise.fbm(x * 0.016 - 30, z * 0.016 + 9, 2)) * 0.35, 0, 1),
      place: (h) => ({ s: 0.75 + h * 1.15, sink: 0.46, tilt: 0.18 }),
    },
    {
      // Deadwood is banded like the tufts, and for a colour reason as much as a
      // density one. Quantising the frame at 16 levels per channel, our near and
      // foreground bands render 274 and 195 distinct colours against pw_11's 866 and
      // 722 — and everything we put down there so far sits on the same yellow-green
      // line, so it lands in bins we already occupy. Bark is the cheapest mass that is
      // genuinely OFF that line, and a fallen branch is also the only strong horizontal
      // in a field of verticals.
      key: 'woodNear', id: 5533, step: st(2.4), r1: 14, cast: true, mat: woodMat,
      geos: () => [branchGeometry(rng, noise), branchGeometry(rng, noise), stumpGeometry(rng, noise)],
      gate: (x, z) => clamp(0.20 + smoothstep(-0.20, 0.30, noise.fbm(x * 0.0042 + 17, z * 0.0042 - 9, 3)) * 0.62, 0, 1),
      place: (h) => ({ s: 0.60 + h * 0.60, sink: 0.02, tilt: 0.22 }),
    },
    {
      key: 'wood', id: 5527, step: st(4.0), r1: 36, cast: true, mat: woodMat,
      geos: () => [branchGeometry(rng, noise), branchGeometry(rng, noise), stumpGeometry(rng, noise)],
      gate: (x, z) => clamp(0.14 + smoothstep(-0.20, 0.30, noise.fbm(x * 0.0042 + 17, z * 0.0042 - 9, 3)) * 0.72, 0, 1),
      place: (h) => ({ s: 0.72 + h * 0.70, sink: 0.02, tilt: 0.20 }),
    },
    {
      key: 'shrub', id: 5741, step: st(6.0), r1: 32, cast: true, mat: foliageMat,
      // createBushes scatters 300 shrubs uniformly over a 288 m disc anchored on the
      // WORLD ORIGIN, and the player spawns 98 m from it: expected shrubs inside the
      // first 15 m of any gameplay framing is 0.3. Same arithmetic as the pebbles.
      // A camera-relative copy at low density puts one readable mid-size silhouette
      // in the 5-20 m band, which is the depth plane the frame was missing entirely.
      geos: () => [shrubGeometry(rng, noise, 3), shrubGeometry(rng, noise, 4)],
      gate: (x, z) => clamp(0.10 + smoothstep(-0.16, 0.28, noise.fbm(x * 0.009 - 21, z * 0.009 + 6, 3)) * 0.62, 0, 1),
      place: (h) => ({ s: 0.55 + h * 0.75, sink: 0.10, tilt: 0.10 }),
    },
    {
      // Reference #8 asks for "small clusters of 5-15 blooms in a couple of spots per
      // frame, never as an even scatter". One bloom per accepted grid cell IS an even
      // scatter — the first attempt produced 200 evenly spaced pink lollipops standing
      // proud of the grass, which is the exact tell the reference warns about. So the
      // grid is coarse and each accepted cell emits a knot of 6-14 blooms.
      key: 'bloom', id: 5631, step: st(3.4), r1: 26, cast: false, mat: bloomMat,
      rep: [6, 14], clumpR: 0.85,
      geos: () => [flowerGeometry(5, 0.80), flowerGeometry(6, 0.66)],
      // Squared mask, not a product of two: a product of two independent fields is
      // almost always near zero (measured — it put FIVE blooms in the whole 22 m disc
      // at this seed, which is how the frame ended up with no flowers in it at all).
      // Squaring one field keeps the patchiness reference #8 asks for while leaving a
      // usable mean.
      gate: (x, z) => {
        const m = smoothstep(-0.12, 0.30, noise.fbm(x * 0.026 - 55, z * 0.026 + 31, 2));
        return clamp(m * m * 1.80 - 0.03, 0, 0.92);
      },
      place: (h) => ({ s: 0.85 + h * 0.50, sink: 0.02, tilt: 0.06 }),
    },
  ];

  const BLOOM_HUES = [0xef7fa8, 0xf6b3cd, 0xfaf3ee, 0xf2d873, 0xc79ce2, 0xf28f6a, 0xe8e2d2];

  const fam = [];
  for (const k of KINDS) {
    const geos = k.geos();
    const area = Math.PI * k.r1 * k.r1;
    const rep = k.rep ? k.rep[1] : 1;
    const cap = Math.min(2600, Math.ceil((area / (k.step * k.step)) * 1.25 * rep / geos.length) + 24);
    const meshes = geos.map((g) => {
      const m = new THREE.InstancedMesh(g, k.mat, cap);
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      m.instanceColor.setUsage(THREE.DynamicDrawUsage);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      m.frustumCulled = false;
      m.matrixAutoUpdate = false;
      m.castShadow = k.cast;
      m.receiveShadow = true;
      group.add(m);
      return m;
    });
    fam.push({ k, meshes, cap });
  }

  const m4 = new THREE.Matrix4();
  const qt = new THREE.Quaternion();
  const eu = new THREE.Euler();
  const col = new THREE.Color();
  let total = 0;

  function rebuild(camX, camZ) {
    total = 0;
    for (const { k, meshes, cap } of fam) {
      const nOf = meshes.map(() => 0);
      const step = k.step;
      const i0 = Math.floor((camX - k.r1) / step), i1 = Math.ceil((camX + k.r1) / step);
      const j0 = Math.floor((camZ - k.r1) / step), j1 = Math.ceil((camZ + k.r1) / step);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const h0 = hash2i(i, j, k.id);
          const h1 = hash2i(i, j, k.id + 401);
          const x = i * step + (h0 - 0.5) * step * 0.94;
          const z = j * step + (h1 - 0.5) * step * 0.94;
          const d = Math.hypot(x - camX, z - camZ);
          if (d > k.r1) continue;

          const y = T.heightAt(x, z);
          if (y < T.waterLevel + 0.15) continue;
          if (T.slopeAt(x, z) > 0.62) continue;

          const h2 = hash2i(i, j, k.id + 977);
          if (h2 > k.gate(x, z, y)) continue;

          // a cell may be a single object or a knot of them (see the bloom family)
          const reps = k.rep
            ? k.rep[0] + Math.floor(hash2i(i, j, k.id + 6151) * (k.rep[1] - k.rep[0] + 1))
            : 1;
          for (let rp = 0; rp < reps; rp++) {
            const vi = Math.floor(hash2i(i + rp * 131, j - rp * 197, k.id + 1553) * meshes.length) % meshes.length;
            if (nOf[vi] >= cap) continue;
            const h3 = hash2i(i + rp * 71, j + rp * 53, k.id + 2129);
            const h4 = hash2i(i - rp * 37, j + rp * 89, k.id + 3671);
            const h5 = hash2i(i + rp * 113, j - rp * 41, k.id + 4783);

            let px = x, pz = z, py = y;
            if (rp > 0) {
              const rr = Math.sqrt(hash2i(i + rp * 17, j + rp * 23, k.id + 7013)) * (k.clumpR ?? 0.6);
              const aa = hash2i(i - rp * 29, j - rp * 19, k.id + 7919) * Math.PI * 2;
              px = x + Math.cos(aa) * rr; pz = z + Math.sin(aa) * rr;
              py = T.heightAt(px, pz);
            }

            const p = k.place(h3);
            // grow in over the last 7 m instead of popping into existence at the ring edge
            const s = p.s * smoothstep(k.r1, k.r1 - 7, d);
            if (s < 0.03) continue;
            eu.set((h4 - 0.5) * p.tilt, h5 * Math.PI * 2, (h0 - 0.5) * p.tilt);
            qt.setFromEuler(eu);
            m4.compose({ x: px, y: py - s * p.sink, z: pz }, qt, { x: s, y: s * (0.86 + h4 * 0.34), z: s });
            meshes[vi].setMatrixAt(nOf[vi], m4);

            if (k.key === 'bloom') {
              // Hue is a function of PATCH, not of instance. A drift of one colour with a
              // few strays reads as a species growing where it likes; an even mix of six
              // hues in every square metre reads as confetti. pw_11's mid-ground drift and
              // pw_15's foreground cluster are each a single hue plus white.
              const hn = noise.fbm(x * 0.011 + 71, z * 0.011 - 44, 2);
              let hi = Math.floor(clamp(hn * 1.6 + 0.5, 0, 0.999) * BLOOM_HUES.length);
              if (h5 > 0.88) hi = (hi + 2) % BLOOM_HUES.length;   // a few strays
              col.set(BLOOM_HUES[hi % BLOOM_HUES.length]);
              col.multiplyScalar(0.82 + h4 * 0.42);
            } else {
              // per-instance value + hue jitter. Same reason the grass carpet gets it:
              // a hundred identical stones quantise into one colour bin and read as a
              // decal sheet rather than as a hundred stones.
              // Wide, not narrow. At +-6% hue and 0.78-1.18 value a few hundred tufts
              // quantise into two or three of the instrument's colour bins and measure
              // like one painted mass; the spread below is what turns them into a
              // variegated carpet without reaching for hues outside the range.
              const v = 0.68 + 0.62 * h3;
              col.setRGB(v * (0.86 + h4 * 0.30), v * (0.94 + h5 * 0.16), v * (0.78 + h4 * 0.30));
              // Same near-field chroma lift the grass carpet gets (see createGrass) —
              // the tuft mass and the carpet have to grade together or the near field
              // separates into two different meadows. This colour is a MULTIPLIER on a
              // palette baked into the vertices, and it is near-neutral, so expanding
              // it around its own luminance would do nothing; instead it leans the
              // multiplier along the axis every tuft and weed hue already runs on
              // (green up, blue down), which raises (max-min)/max on the product.
              if (k.mat === foliageMat) {
                const t = smoothstep(60, 2, d);
                col.setRGB(col.r * lerp(1, 0.92, t), col.g * lerp(1, 1.10, t), col.b * lerp(1, 0.42, t));
              }
            }
            meshes[vi].setColorAt(nOf[vi], col);
            nOf[vi]++;
          }
        }
      }
      for (let m = 0; m < meshes.length; m++) {
        meshes[m].count = nOf[m];
        total += nOf[m];
        meshes[m].instanceMatrix.needsUpdate = true;
        if (meshes[m].instanceColor) meshes[m].instanceColor.needsUpdate = true;
      }
    }
  }

  return { group, rebuild, get count() { return total; } };
}

/* ============================================================== TREES ========== */

function lobe(rng, noise, r, sx, sy, detail = 1) {
  const g = new THREE.IcosahedronGeometry(r, detail).toNonIndexed();
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const d = 1 + 0.20 * noise.fbm(x * 1.7 + 5, z * 1.7 - 3, 2) + 0.14 * noise.fbm(y * 2.3, x * 2.3, 2);
    p.setXYZ(i, x * d * sx, y * d * sy, z * d * sx);
  }
  g.computeVertexNormals();
  return g;
}

// Reference #7's middle plane is "mid-green mid-ground trees" -- plural greens.
// Five near-identical leaf hues quantise into two colour bins and are a big part of
// why our frames render 400 distinct colours where the plates render 800-1600.
const LEAF = [0x6f9a3c, 0x8fae4a, 0x577f38, 0xa3b455, 0x6d9457, 0x84963a, 0x4f7a44];
const BARK = [0x6d5f4c, 0x7a6b55, 0x5f5344];

function buildTree(rng, noise, kind) {
  const parts = [];
  let h, trunkR, canopyY, lobes;
  if (kind === 0) { h = rng.range(11, 16); trunkR = 0.30; canopyY = 0.55; lobes = 4; }
  else if (kind === 1) { h = rng.range(7.5, 10.5); trunkR = 0.34; canopyY = 0.42; lobes = 5; }
  else if (kind === 2) { h = rng.range(4.2, 6.4); trunkR = 0.20; canopyY = 0.40; lobes = 3; }
  else { h = rng.range(13, 19); trunkR = 0.34; canopyY = 0.45; lobes = 5; }

  // trunk — tapered, with a slight lean so a copse never looks like fence posts
  const lean = rng.range(-0.10, 0.10);
  const seg = 5;
  const tg = new THREE.CylinderGeometry(trunkR * 0.52, trunkR, h * (canopyY + 0.28), 6, seg, true);
  const tp = tg.attributes.position;
  const tH = h * (canopyY + 0.28);
  for (let i = 0; i < tp.count; i++) {
    const y = tp.getY(i) + tH / 2;
    const t = y / tH;
    tp.setX(i, tp.getX(i) + lean * t * t * h * 0.5);
    tp.setZ(i, tp.getZ(i) + lean * 0.6 * t * t * h * 0.4);
  }
  tg.translate(0, tH / 2, 0);
  tg.computeVertexNormals();
  parts.push(paint(tg, BARK[rng.int(0, BARK.length - 1)], 0.10, noise));

  // canopy lobes
  const leafBase = LEAF[rng.int(0, LEAF.length - 1)];
  const cBase = new THREE.Color(leafBase).convertSRGBToLinear();
  const topY = h;
  for (let i = 0; i < lobes; i++) {
    const t = i / Math.max(1, lobes - 1);
    const ly = lerp(h * canopyY + h * 0.10, topY * 0.96, t) + rng.range(-0.4, 0.4);
    const spreadR = (kind === 3 ? 1 - t * 0.75 : 1 - t * 0.45);
    const rad = h * (kind === 1 ? 0.26 : 0.20) * (0.75 + 0.55 * spreadR) * rng.range(0.85, 1.15);
    const ang = rng.next() * Math.PI * 2;
    const off = h * 0.055 * spreadR * rng.range(0.4, 1.6);
    const g = lobe(rng, noise, rad, 1.06, kind === 3 ? 0.78 : 0.86);
    g.translate(Math.cos(ang) * off + lean * (ly / h) * (ly / h) * h * 0.5, ly, Math.sin(ang) * off);
    // shade the canopy: brighter on top and outside, darker underneath
    const p = g.attributes.position, nrm = g.attributes.normal;
    const arr = new Float32Array(p.count * 3);
    for (let k = 0; k < p.count; k++) {
      const ny = nrm.getY(k);
      const py = p.getY(k);
      const upness = clamp(ny * 0.5 + 0.5, 0, 1);
      const hgt = clamp((py - h * canopyY) / (h * 0.6), 0, 1);
      const v = 0.62 + 0.46 * upness + 0.20 * hgt + 0.10 * noise.fbm(p.getX(k) * 1.3, p.getZ(k) * 1.3, 2);
      arr[k * 3] = cBase.r * v; arr[k * 3 + 1] = cBase.g * v; arr[k * 3 + 2] = cBase.b * v;
    }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    parts.push(g);
  }
  const merged = mergeGeos(parts);
  // the broadphase needs to know what shape this tree is; the merged geometry no longer
  // does, and an InstancedMesh carries no per-instance bounds
  merged.userData = { height: h, trunkR, canopyY, canopyR: h * (kind === 1 ? 0.34 : 0.28) };
  return merged;
}

export function createTrees(ctx, T, rng) {
  const noise = ctx.noise;
  const VARIANTS = 5;
  const geos = [];
  for (let i = 0; i < VARIANTS; i++) geos.push(buildTree(rng, noise, i % 4));

  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  // canopies scatter light the same way the meadow does (reference #4: broad, very
  // low intensity diffuse falloff, no specular lobe)
  mat.onBeforeCompile = (sh) => applyFoliageWrap(sh, 0.40);
  mat.customProgramCacheKey = () => 'foliagewrap';
  // trunks need the same ground union a shrub does, just over a longer skirt
  applyContactShade(mat, { rangeAbs: 0.35, rangeRel: 0.45, dark: 0.42, sinkAbs: -0.15 });
  const placements = geos.map(() => []);

  const ok = (x, z, minSlope = 0.42) => {
    const y = T.heightAt(x, z);
    if (y < T.waterLevel + 1.4) return false;
    if (T.slopeAt(x, z) > minSlope) return false;
    if (T.dirtAt(x, z) > 0.72) return false;
    return true;
  };

  const push = (x, z, scale, vi) => {
    placements[vi].push({ x, z, y: T.heightAt(x, z), s: scale, rot: rng.next() * Math.PI * 2 });
  };

  const q = clamp(ctx.quality.drawDistance / 900, 0.6, 1.6);
  // Reference #7 stacks three depth planes and the MIDDLE one is "mid-green
  // mid-ground trees and rock". pw_11 and pw_15 both carry a real mass of foliage
  // between the player and the far silhouette; ours put a thin line of saplings on
  // the horizon and left the middle distance as bare hillside, which is half of why
  // the frames read as empty and why the upper half of every shot is nothing but
  // sky. Roughly 1.9x the copses and a wider scatter radius.
  const copses = Math.round(46 * q);
  for (let i = 0; i < copses; i++) {
    let cx = 0, cz = 0, found = false;
    for (let t = 0; t < 40; t++) {
      const a = rng.next() * Math.PI * 2;
      const r = 34 + Math.sqrt(rng.next()) * 330;
      cx = Math.cos(a) * r; cz = Math.sin(a) * r;
      const mask = noise.fbm(cx * 0.0042 + 17, cz * 0.0042 - 9, 3);
      if (mask < -0.02) continue;
      if (!ok(cx, cz, 0.36)) continue;
      found = true; break;
    }
    if (!found) continue;
    const n = rng.int(4, 15);
    const rad = rng.range(9, 27);
    for (let k = 0; k < n; k++) {
      const a = rng.next() * Math.PI * 2;
      const r = Math.pow(rng.next(), 0.65) * rad;
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      if (Math.hypot(x, z) < 26) continue;
      if (!ok(x, z)) continue;
      push(x, z, rng.range(0.72, 1.25), rng.int(0, VARIANTS - 1));
    }
  }
  // ---- singles, thinner, to soften copse edges ----
  for (let i = 0; i < Math.round(150 * q); i++) {
    const a = rng.next() * Math.PI * 2;
    const r = 30 + Math.sqrt(rng.next()) * 370;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const mask = noise.fbm(x * 0.0042 + 17, z * 0.0042 - 9, 3);
    if (mask < -0.10) continue;
    if (!ok(x, z)) continue;
    push(x, z, rng.range(0.6, 1.15), rng.int(0, VARIANTS - 1));
  }

  const meshes = [];
  const m4 = new THREE.Matrix4();
  const qt = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const col = new THREE.Color();
  // a trunk as a capped cylinder and the canopy as one sphere: enough to stop a round,
  // cheap enough that 700 trees cost nothing (see the PROP BROADPHASE section)
  const bp = beginPropChannel('trees');
  let count = 0;
  for (let vi = 0; vi < VARIANTS; vi++) {
    const list = placements[vi];
    if (!list.length) continue;
    const ud = geos[vi].userData || {};
    const mesh = new THREE.InstancedMesh(geos[vi], mat, list.length);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 3), 3);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const ys = p.s * (0.9 + rng.next() * 0.25);
      qt.setFromAxisAngle(up, p.rot);
      m4.compose({ x: p.x, y: p.y - 0.15, z: p.z }, qt, { x: p.s, y: ys, z: p.s });
      mesh.setMatrixAt(i, m4);
      const base = p.y - 0.15;
      const th = (ud.height ?? 10) * ys;
      // 1.35x the modelled trunk radius: the bark silhouette leans, and a round that
      // clips the visible edge of a trunk should stop rather than pass through
      bp.column(p.x, p.z, (ud.trunkR ?? 0.3) * p.s * 1.35, base, base + th * ((ud.canopyY ?? 0.45) + 0.10), 'wood');
      bp.sphere(p.x, base + th * 0.78, p.z, (ud.canopyR ?? th * 0.28) * p.s, 'foliage');
      const t = 0.86 + rng.next() * 0.3;
      col.setRGB(t * (0.96 + rng.next() * 0.09), t, t * (0.9 + rng.next() * 0.12));
      mesh.setColorAt(i, col);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    meshes.push(mesh);
    count += list.length;
  }
  return { meshes, count };
}

/* ============================================================== BUSHES ========= */

// ---------------------------------------------------------------------------
// THE BLACK BLOB.
//
// A shrub near the lens rendered as a hard-edged, fully opaque near-black polygon in
// creature_portrait -- the first thing a critic's eye went to, read as a broken shadow
// decal or a hole in the terrain. It was neither: it was a bush whose albedo was about
// seven times too dark.
//
// Cause: `new THREE.Color(hex)` is ALREADY linear (ColorManagement is on, and paint()
// documents exactly this), so the extra .convertSRGBToLinear() applied the sRGB
// transfer function a second time. 0x577f38 -> linear 0.089/0.213/0.038 -> 0.008/0.037/
// 0.003. Any bush the key light did not hit square-on therefore fell to pure ambient on
// a near-zero albedo, i.e. black. Verified by rendering the bushes with an UNLIT
// MeshBasicMaterial and watching them stay black: it was never a lighting or shadow bug.
//
// These are authored directly in LINEAR working space at the value a shrub actually has
// -- close to the meadow's own albedo, one notch deeper and greener, so shrubs read as
// clumps of the same vegetation rather than as holes punched in the frame. Reference #9:
// a shadow is "a cooler, less saturated version of the lit colour, never black".
const BUSH_PAL = [0x596b3d, 0x64723f, 0x4d603a, 0x5f6a45];

export function createBushes(ctx, T, rng) {
  const noise = ctx.noise;
  const variants = [];
  for (let v = 0; v < 3; v++) {
    const parts = [];
    const n = 2 + (v % 3);
    const base = new THREE.Color(BUSH_PAL[v % BUSH_PAL.length]);
    for (let i = 0; i < n; i++) {
      const r = rng.range(0.42, 0.72);
      const g = lobe(rng, noise, r, 1.15, 0.8, 0);
      g.translate(rng.range(-0.35, 0.35), r * 0.72 + rng.range(0, 0.2), rng.range(-0.35, 0.35));
      const p = g.attributes.position, nr = g.attributes.normal;
      const arr = new Float32Array(p.count * 3);
      for (let k = 0; k < p.count; k++) {
        const val = 0.72 + 0.38 * clamp(nr.getY(k) * 0.5 + 0.5, 0, 1) + 0.14 * noise.fbm(p.getX(k) * 2, p.getZ(k) * 2, 2);
        arr[k * 3] = base.r * val; arr[k * 3 + 1] = base.g * val; arr[k * 3 + 2] = base.b * val;
      }
      g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
      parts.push(g);
    }
    variants.push(mergeGeos(parts));
  }
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  // a shrub is a scattering volume, not an opaque shell — a wider wrap than the tree
  // canopies get, so its shaded side keeps its hue instead of falling off a cliff
  mat.onBeforeCompile = (sh) => applyFoliageWrap(sh, 0.62);
  mat.customProgramCacheKey = () => 'foliagewrap62';
  // THE BUSH THAT SAT ON TOP OF THE IMAGE. A blind critic picked our creature-group
  // frame as the fake specifically because of a foreground shrub with "no contact
  // shadow and no ambient occlusion at the ground line". These are ~1.5 m wide, so the
  // occlusion under the skirt runs deeper and further up than a stone's.
  applyContactShade(mat, { rangeAbs: 0.14, rangeRel: 0.32, dark: 0.34, sinkAbs: -0.10 });
  const q = clamp(ctx.quality.grassDensity ?? 1, 0.3, 1.5);
  const lists = variants.map(() => []);
  const target = Math.round(300 * q);
  for (let i = 0; i < target * 3; i++) {
    if (lists.reduce((a, b) => a + b.length, 0) >= target) break;
    const a = rng.next() * Math.PI * 2;
    const r = 8 + Math.sqrt(rng.next()) * 280;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const y = T.heightAt(x, z);
    if (y < T.waterLevel + 0.8) continue;
    if (T.slopeAt(x, z) > 0.45) continue;
    if (T.grassAt(x, z) < 0.35) continue;
    const mask = noise.fbm(x * 0.009 - 21, z * 0.009 + 6, 3);
    if (rng.next() > 0.30 + smoothstep(-0.15, 0.25, mask) * 0.8) continue;
    lists[rng.int(0, variants.length - 1)].push({ x, y, z, s: rng.range(0.7, 1.6), rot: rng.next() * Math.PI * 2 });
  }
  const meshes = [];
  const m4 = new THREE.Matrix4();
  const qt = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const col = new THREE.Color();
  const bp = beginPropChannel('bushes');
  let count = 0;
  for (let v = 0; v < variants.length; v++) {
    const list = lists[v];
    if (!list.length) continue;
    const mesh = new THREE.InstancedMesh(variants[v], mat, list.length);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 3), 3);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      qt.setFromAxisAngle(up, p.rot);
      m4.compose({ x: p.x, y: p.y - 0.1, z: p.z }, qt, { x: p.s, y: p.s * rng.range(0.8, 1.2), z: p.s });
      mesh.setMatrixAt(i, m4);
      bp.sphere(p.x, p.y - 0.1 + p.s * 0.62, p.z, p.s * 0.80, 'foliage');
      const t = 0.85 + rng.next() * 0.35;
      col.setRGB(t, t * (0.97 + rng.next() * 0.08), t * 0.94);
      mesh.setColorAt(i, col);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    meshes.push(mesh);
    count += list.length;
  }
  return { meshes, count };
}
