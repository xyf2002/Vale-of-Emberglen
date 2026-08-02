import * as THREE from 'three';
import { clamp, lerp, smoothstep, smootherstep, distToPath, smoothPath } from './util.js';

/**
 * Terrain: an authored landform, not raw fBm.
 *
 * The layout is composed around one "vista axis" A pointing away from spawn. Along A
 * there is a walkable valley; a lake sits in it at ~130 m; a flat-topped butte flanks it
 * on the right at ~230 m and a smaller crag on the left at ~190 m; ridges rise either side
 * to frame the view; a soft bowl rim closes the playable area; and beyond that a low-res
 * skirt carries hills out to 3 km so the horizon never just stops.
 */

// vista axis (matches the vista_golden camera heading in tools/shots.mjs)
export const AX = 0.5934, AZ = -0.8049;   // "along"
export const PX = 0.8049, PZ = 0.5934;    // "right of"

export const LAKE = { x: 84, z: -106, r: 60 };
export const BUTTE = { x: 201, z: -113, r: 112 };
export const CRAG = { x: 37, z: -184, r: 62 };

const toWorld = (u, v) => [u * AX + v * PX, u * AZ + v * PZ];

/** dirt paths worn through the meadow — also used to thin the grass */
export function makePaths() {
  const a = smoothPath([
    toWorld(-70, 22), toWorld(-20, 6), toWorld(18, -8), toWorld(62, 4),
    toWorld(104, 12), toWorld(150, -4), toWorld(196, 16), toWorld(250, 8),
  ], 7);
  const b = smoothPath([
    toWorld(10, -6), toWorld(30, -40), toWorld(52, -76), toWorld(88, -104), toWorld(128, -140),
  ], 7);
  const c = smoothPath([
    toWorld(60, 8), toWorld(96, 44), toWorld(140, 76), toWorld(178, 118),
  ], 7);
  return [a, b, c];
}

export function createTerrain(ctx) {
  const noise = ctx.noise;
  const paths = makePaths();

  // ---------------------------------------------------------------- analytic height
  const warp = (x, z) => {
    const wx = noise.fbm(x * 0.0014 + 11.2, z * 0.0014 - 4.5, 3);
    const wz = noise.fbm(x * 0.0014 - 7.7, z * 0.0014 + 9.1, 3);
    return [x + wx * 78, z + wz * 78];
  };

  function analytic(x, z) {
    const [wx, wz] = warp(x, z);
    const r = Math.hypot(x, z);
    const u = x * AX + z * AZ;
    const v = x * PX + z * PZ;

    const ridgeN = noise.ridged(wx * 0.0043, wz * 0.0043, 4);
    const ridgeN2 = noise.ridged(wx * 0.0016 + 40, wz * 0.0016 - 22, 4);

    // rolling meadow base
    let h = 10 + noise.fbm(wx * 0.0029, wz * 0.0029, 4) * 19;
    const detail = noise.fbm(wx * 0.0128, wz * 0.0128, 4) * 3.2;
    const micro = noise.fbm(x * 0.055, z * 0.055, 2) * 0.5;

    // ---- walkable valley along the vista axis ----
    const vc = Math.sin(u * 0.0092) * 32 + Math.sin(u * 0.0203 + 1.3) * 12;
    const dv = v - vc;
    const half = 60 + 24 * Math.sin(u * 0.006 + 0.7);
    const t = clamp(Math.abs(dv) / half, 0, 1);
    const inValley = 1 - smootherstep(0.30, 1.0, t);
    const floorH = 5.4 + u * 0.012 + noise.fbm(wx * 0.0062, wz * 0.0062, 3) * 3.4;
    h = lerp(h, floorH, inValley * 0.93);
    h += detail * (0.30 + 0.70 * (1 - inValley));

    // ---- flanking ridges that frame the view ----
    const gate = smoothstep(58, 165, Math.abs(dv)) * smoothstep(40, 190, r);
    h += Math.pow(ridgeN, 1.8) * 66 * gate;

    // ---- bowl rim: the playable area is a sheltered basin ----
    const rim = smootherstep(280, 470, r);
    h += rim * (52 + 78 * Math.pow(ridgeN, 1.5));

    // ---- far skirt: mountains marching to the horizon ----
    const far = smootherstep(560, 2100, r);
    h += far * (160 + 430 * Math.pow(ridgeN2, 1.7) + 90 * ridgeN);

    // ---- flat-topped butte (right of the valley, mid ground) ----
    const bd = Math.hypot(x - BUTTE.x, z - BUTTE.z);
    const bt = clamp((BUTTE.r - bd) / 54, 0, 1);
    h += 47 * (bt * bt * (3 - 2 * bt)) * (0.86 + 0.30 * noise.fbm(x * 0.021, z * 0.021, 2));

    // ---- smaller crag (left) ----
    const cd = Math.hypot(x - CRAG.x, z - CRAG.z);
    const cgt = clamp((CRAG.r - cd) / 34, 0, 1);
    h += 26 * (cgt * cgt * (3 - 2 * cgt)) * (0.9 + 0.25 * noise.fbm(x * 0.03 + 5, z * 0.03, 2));

    // ---- lake basin ----
    const ld = Math.hypot(x - LAKE.x, z - LAKE.z);
    const lt = clamp((LAKE.r + 6 - ld) / 52, 0, 1);
    h -= 12.5 * (lt * lt * (3 - 2 * lt));

    // ---- sheltered starting hollow ----
    const hollow = Math.exp(-(r * r) / (54 * 54));
    h -= hollow * 4.6;
    h += micro * (1 - 0.65 * hollow);

    // ---- worn paths cut a shallow trough ----
    let pd = 1e9;
    for (const p of paths) { const d = distToPath(x, z, p); if (d < pd) pd = d; }
    h -= 0.55 * (1 - smoothstep(0.5, 4.5, pd));

    return h;
  }

  // ---------------------------------------------------------------- height LUT
  // Everything (mesh, physics, scatter) samples this so nothing ever floats.
  const STEP = 1.5;
  const HALF = 486;
  const N = Math.round((HALF * 2) / STEP) + 1;
  const heights = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    const z = -HALF + j * STEP;
    for (let i = 0; i < N; i++) {
      heights[j * N + i] = analytic(-HALF + i * STEP, z);
    }
  }

  function heightAt(x, z) {
    const fx = (x + HALF) / STEP, fz = (z + HALF) / STEP;
    if (fx < 0 || fz < 0 || fx >= N - 1 || fz >= N - 1) return analytic(x, z);
    const i = fx | 0, j = fz | 0;
    const tx = fx - i, tz = fz - j;
    const a = heights[j * N + i], b = heights[j * N + i + 1];
    const c = heights[(j + 1) * N + i], d = heights[(j + 1) * N + i + 1];
    return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
  }

  // ---------------------------------------------------------------- water level
  let lakeMin = 1e9;
  for (let a = 0; a < 32; a++) {
    for (let rr = 0; rr <= 8; rr++) {
      const ang = (a / 32) * Math.PI * 2, rad = (rr / 8) * LAKE.r * 0.75;
      const h = heightAt(LAKE.x + Math.cos(ang) * rad, LAKE.z + Math.sin(ang) * rad);
      if (h < lakeMin) lakeMin = h;
    }
  }
  const waterLevel = lakeMin + 4.4;

  // ---------------------------------------------------------------- coverage LUT
  // 0..255 grass density, plus a parallel dirt/exposed-soil field. Bald spots and
  // worn paths live here; the grass builder and the vertex colours both read it.
  const CSTEP = 2.0;
  const CN = Math.round((HALF * 2) / CSTEP) + 1;
  const cover = new Uint8Array(CN * CN);
  const dirt = new Uint8Array(CN * CN);

  function slopeFromLut(x, z) {
    const e = 1.6;
    const hL = heightAt(x - e, z), hR = heightAt(x + e, z);
    const hD = heightAt(x, z - e), hU = heightAt(x, z + e);
    const nx = hL - hR, nz = hD - hU, ny = 2 * e;
    const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
    return 1 - ny * inv;
  }

  for (let j = 0; j < CN; j++) {
    const z = -HALF + j * CSTEP;
    for (let i = 0; i < CN; i++) {
      const x = -HALF + i * CSTEP;
      const h = heightAt(x, z);
      const sl = slopeFromLut(x, z);

      // path wear
      let pd = 1e9;
      for (const p of paths) { const d = distToPath(x, z, p); if (d < pd) pd = d; }
      const onPath = 1 - smoothstep(1.4, 5.2, pd);

      // patchy bald ground — deliberately clumpy, not uniform
      const patch = noise.fbm(x * 0.017 + 33, z * 0.017 - 12, 3);
      const bald = smoothstep(0.16, 0.40, patch);
      const scuff = smoothstep(0.30, 0.56, noise.fbm(x * 0.062 - 8, z * 0.062 + 3, 2));

      // shoreline sand
      const shore = smoothstep(2.6, -0.4, h - waterLevel) * smoothstep(LAKE.r + 26, LAKE.r - 6, Math.hypot(x - LAKE.x, z - LAKE.z));

      let d = clamp(onPath * 0.95 + bald * 0.75 + scuff * 0.16 * bald + shore * 0.9, 0, 1);
      let g = clamp(1 - d * 1.05, 0, 1);
      // rock does not grow grass
      g *= 1 - smoothstep(0.40, 0.68, sl);
      // underwater
      if (h < waterLevel + 0.15) g *= smoothstep(waterLevel - 0.9, waterLevel + 1.4, h);
      // thin out on the highest ground
      g *= 1 - smoothstep(58, 96, h) * 0.55;

      cover[j * CN + i] = Math.round(clamp(g, 0, 1) * 255);
      dirt[j * CN + i] = Math.round(clamp(d, 0, 1) * 255);
    }
  }

  function sampleU8(arr, x, z) {
    const fx = (x + HALF) / CSTEP, fz = (z + HALF) / CSTEP;
    if (fx < 0 || fz < 0 || fx >= CN - 1 || fz >= CN - 1) return 0;
    const i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j;
    const a = arr[j * CN + i], b = arr[j * CN + i + 1];
    const c = arr[(j + 1) * CN + i], d = arr[(j + 1) * CN + i + 1];
    return lerp(lerp(a, b, tx), lerp(c, d, tx), tz) / 255;
  }

  const grassAt = (x, z) => sampleU8(cover, x, z);
  const dirtAt = (x, z) => sampleU8(dirt, x, z);

  return {
    analytic, heightAt, slopeAt: slopeFromLut, grassAt, dirtAt,
    waterLevel, paths, STEP, HALF,
    normalAt(x, z) {
      const e = 1.2;
      const hL = heightAt(x - e, z), hR = heightAt(x + e, z);
      const hD = heightAt(x, z - e), hU = heightAt(x, z + e);
      return new THREE.Vector3(hL - hR, 2 * e, hD - hU).normalize();
    },
  };
}

/* ------------------------------------------------------------------ ground mesh */

const C = (hex) => new THREE.Color(hex).convertSRGBToLinear();

const PAL = {
  lush: C(0x7c9c44),
  dry: C(0xa2a552),
  shade: C(0x5c7a38),
  rock: C(0x8d8f86),
  rockWarm: C(0x9a927f),
  dirtC: C(0xa8916a),
  sand: C(0xc4b489),
  high: C(0x93a184),
};

export function buildGroundMesh(ctx, T, radius, segs) {
  const noise = ctx.noise;
  const geo = new THREE.PlaneGeometry(radius * 2, radius * 2, segs, segs);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colAttr = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  const tmp = new THREE.Color();

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const h = T.heightAt(x, z);
    pos.setY(i, h);

    const sl = T.slopeAt(x, z);
    const d = T.dirtAt(x, z);
    const dryness = smoothstep(-0.22, 0.30, noise.fbm(x * 0.0085 + 61, z * 0.0085 - 19, 3));
    const moist = smoothstep(14, 4, h) * 0.6 + smoothstep(0.30, -0.15, noise.fbm(x * 0.012 - 4, z * 0.012 + 27, 3)) * 0.4;

    c.copy(PAL.lush).lerp(PAL.dry, dryness * 0.85);
    c.lerp(PAL.shade, clamp(moist, 0, 1) * 0.42);
    c.lerp(PAL.high, smoothstep(48, 92, h) * 0.7);
    // slope rock
    const rockAmt = smoothstep(0.34, 0.66, sl);
    tmp.copy(PAL.rock).lerp(PAL.rockWarm, smoothstep(-0.2, 0.2, noise.fbm(x * 0.03, z * 0.03, 2)));
    c.lerp(tmp, rockAmt);
    // worn soil
    c.lerp(PAL.dirtC, d * 0.72 * (1 - rockAmt));
    // shoreline
    const shore = smoothstep(2.2, -0.6, h - T.waterLevel) * smoothstep(LAKE.r + 24, LAKE.r - 8, Math.hypot(x - LAKE.x, z - LAKE.z));
    c.lerp(PAL.sand, shore * 0.85);

    const v = 0.90 + 0.20 * noise.fbm(x * 0.045 + 3, z * 0.045 - 6, 2) + 0.10 * noise.fbm(x * 0.006, z * 0.006, 2);
    colAttr[i * 3] = c.r * v; colAttr[i * 3 + 1] = c.g * v; colAttr[i * 3 + 2] = c.b * v;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colAttr, 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/** Low-res ring carrying the landscape from the playable rim out to the horizon. */
export function buildSkirtGeometry(T, r0, r1, rings, segs) {
  const verts = [];
  const cols = [];
  const idx = [];
  const c = new THREE.Color();
  for (let ri = 0; ri <= rings; ri++) {
    const t = ri / rings;
    const r = r0 * Math.pow(r1 / r0, t);
    for (let si = 0; si <= segs; si++) {
      const a = (si / segs) * Math.PI * 2;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const h = T.analytic(x, z);
      verts.push(x, h, z);
      const green = smoothstep(210, 90, h);
      const snow = smoothstep(330, 470, h);
      c.copy(PAL.rock).lerp(PAL.shade, green * 0.8).lerp(C(0xe8eef2), snow * 0.85);
      cols.push(c.r, c.g, c.b);
    }
  }
  const row = segs + 1;
  for (let ri = 0; ri < rings; ri++) {
    for (let si = 0; si < segs; si++) {
      const a = ri * row + si, b = a + 1, d = a + row, e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}
