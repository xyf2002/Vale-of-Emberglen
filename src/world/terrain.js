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

    // ---- the starting meadow is a genuinely FLAT plane -------------------
    // Reference #7 stacks three depth planes and the nearest one is a calm,
    // low-frequency carpet — pw_11 and pw_15 both have a foreground you could
    // roll a ball across. It is also a hard requirement of the matched-shot
    // protocol: every gameplay shot puts the camera at player.y + ~1.7 m at a
    // horizontal OFFSET of 5-9 m. On the old surface the ground under that
    // offset could sit 2 m higher than under the player's feet, which buried
    // the camera inside the hillside and let the sky dome show through the
    // backfaces (that is what the white wedge in r07's vista_golden was).
    // Holding the first ~120 m to a <4 deg mean gradient removes the failure
    // mode at the source instead of hoping the spawn lands somewhere safe.
    const meadow = 1 - smootherstep(96, 210, r);
    if (meadow > 0.001) {
      const plainH = 8.2 + u * 0.010 + noise.fbm(wx * 0.0034 + 3.1, wz * 0.0034 - 8.4, 2) * 2.6;
      h = lerp(h, plainH, meadow * 0.90);
    }

    // ---- lake basin ----
    const ld = Math.hypot(x - LAKE.x, z - LAKE.z);
    const lt = clamp((LAKE.r + 6 - ld) / 52, 0, 1);
    h -= 12.5 * (lt * lt * (3 - 2 * lt));

    // ---- sheltered starting hollow ----
    const hollow = Math.exp(-(r * r) / (54 * 54));
    h -= hollow * 2.2;
    h += micro * (1 - 0.65 * hollow) * (1 - 0.55 * meadow);

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
  // `dirt` conflates two different things: ground people have walked bare (a real
  // change of MATERIAL) and ground where the grass is merely thin (a change of
  // DENSITY). Painting both as soil turned half the meadow into a mud flat. `bare`
  // carries only the first.
  const bare = new Uint8Array(CN * CN);

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

      // patchy bald ground — deliberately clumpy, not uniform. Reference #8:
      // "uniform density is the single most common tell of a fake meadow". The
      // 60 m-scale term alone is invisible inside a single frame, so a ~10 m term
      // carries the bald spots you can actually see from the player's eye.
      const patch = noise.fbm(x * 0.017 + 33, z * 0.017 - 12, 3);
      const near = noise.fbm(x * 0.098 + 5, z * 0.098 - 41, 2);
      // ~24 m. This one feeds `bare` ONLY — see below. It is the critic's "macro
      // ~20 m dirt/grass patchiness across the meadow", and it is deliberately kept
      // out of `cover` and `dirt`: those two drive blade density, tuft scatter,
      // flower gating, footstep material and the trail biome, so putting a new
      // octave into them would change gameplay and vegetation to buy a texture.
      const wear = noise.fbm(x * 0.0415 - 66, z * 0.0415 + 28, 2);
      const bald = clamp(smoothstep(0.16, 0.40, patch) + smoothstep(0.30, 0.62, near) * 0.55, 0, 1);
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
      // trodden earth: the path itself, the shoreline, and only the very baldest
      // scuffs — never the broad thin-grass patches
      // `wear` puts worn earth INTO standing grass at the 24 m scale. The blades stay
      // (cover is untouched), so what the shader draws is soil seen between them —
      // reference #8's "dense variegated carpet with deliberate bald spots" rather
      // than a bald spot. Held to 0.42 on purpose: an earlier round turned half the
      // meadow into a mud flat by painting thin grass as soil, and the fix for that
      // was inventing this `bare` field in the first place. This is the largest term
      // in the frame that survives to 400 m, because it is a MATERIAL change carried
      // on a vertex attribute rather than a texture lookup that mips to its own mean.
      const b = clamp(onPath * 0.95 + shore * 0.85 + smoothstep(0.72, 1.00, bald) * 0.55
                      + scuff * bald * 0.20
                      + smoothstep(0.10, 0.46, wear) * 0.16 * (1 - shore), 0, 1);
      bare[j * CN + i] = Math.round(b * 255);
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
  const bareAt = (x, z) => sampleU8(bare, x, z);

  return {
    analytic, heightAt, slopeAt: slopeFromLut, grassAt, dirtAt, bareAt,
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

// Ground albedo. Reference #5: grass is MID-VALUE and moderately desaturated
// yellow-green, rock is grey-green, worn soil is a warm mid tan. These are the
// albedos a sunlit meadow actually has -- the old set was a stop darker and read
// as shaded grass even in full sun.
// Kept deliberately close to GRASS_PAL in vegetation.js. The grass gets wrapped
// foliage diffuse and the terrain does not, so if their albedos also disagree the
// meadow renders as bright blades floating over a dark, differently-hued floor --
// which is exactly what the frames showed. Same hue family, slightly lighter, so
// the two read as one surface.
export const PAL = {
  lush: C(0xb5c283),
  dry: C(0xd0c893),
  shade: C(0x93a073),
  rock: C(0xa8aa9f),
  rockWarm: C(0xb4ad99),
  dirtC: C(0xc0aa84),
  sand: C(0xd6c8a2),
  high: C(0xacb89d),
  // the average albedo of the instanced blade carpet, so the terrain past the last
  // blade can be blended into the same colour family (see uCanopy in world/index.js)
  canopy: C(0xbcc785),
};

/**
 * Ground geometry.
 *
 * The vertex `color` now carries ONLY the grass/soil-family BASE tint -- the broad
 * dryness / moisture / altitude drift that varies over tens of metres. Everything
 * that changes material (worn soil, exposed rock, shoreline sand, how much grass is
 * actually growing) is exported as a per-vertex MASK instead:
 *
 *   aMask.x  worn / trodden soil          0..1
 *   aMask.y  exposed rock (slope-driven)  0..1
 *   aMask.z  shoreline sand               0..1
 *   aMask.w  grass coverage               0..1
 *
 * The fragment shader blends the actual albedos against those masks with noisy,
 * pixel-resolution edges. Doing the blend per VERTEX (which is what this used to do)
 * meant every material transition was a 2.2 m linear ramp, so the ground could only
 * ever be one smooth olive wash: no visible patch boundaries, no local contrast, and
 * a single flat value from the player's feet to the base of the hills.
 */
export function buildGroundMesh(ctx, T, radius, segs) {
  const noise = ctx.noise;
  // ---------------------------------------------------------------------------
  // WHY THIS MESH IS FINER THAN IT WAS ASKED TO BE.
  //
  // Everything this function can contribute to surface detail is per-VERTEX, so the
  // finest wavelength it can carry is about four vertex spacings. At the caller's
  // 250 segments over 920 m that spacing is 3.68 m and the floor is ~15 m — macro
  // only, no meso, which is precisely half of what r18's blind critic asked for
  // ("macro ~20 m patchiness AND meso ~2-6 m"). The other half, a per-fragment
  // octave, lives in the ground shader in src/world/index.js, which is outside this
  // directory's remit this round.
  //
  // 1.5x brings the spacing to 2.45 m (capture) / 1.92 m (high) and the floor to
  // ~8 m. Measured cost on the capture tier: +164k triangles on a scene already
  // drawing 1.9M, one draw call, no extra material. Capped so the high tier does not
  // pay 630k triangles for a heightfield.
  // ---------------------------------------------------------------------------
  segs = Math.min(480, Math.round(segs * 1.5));
  const geo = new THREE.PlaneGeometry(radius * 2, radius * 2, segs, segs);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colAttr = new Float32Array(pos.count * 3);
  const maskAttr = new Float32Array(pos.count * 4);
  const c = new THREE.Color();

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const h = T.heightAt(x, z);
    pos.setY(i, h);

    const sl = T.slopeAt(x, z);
    const d = T.dirtAt(x, z);
    const g = T.grassAt(x, z);
    const dryness = smoothstep(-0.22, 0.30, noise.fbm(x * 0.0085 + 61, z * 0.0085 - 19, 3));
    const moist = smoothstep(14, 4, h) * 0.6 + smoothstep(0.30, -0.15, noise.fbm(x * 0.012 - 4, z * 0.012 + 27, 3)) * 0.4;
    const patch = smoothstep(-0.28, 0.28, noise.fbm(x * 0.026 + 91, z * 0.026 + 43, 3));
    // ---------------------------------------------------------------------
    // THE MID-GROUND HILLSIDE, AND WHY IT WAS FLAT WHILE THE SHADER SAID IT
    // WAS NOT.
    //
    // The ground fragment shader (src/world/index.js) samples a 256px mask at
    // 140/23/9.2/4.3/1.15 m and does have real patch structure in it. But it
    // gets there through texture2D, and past ~80 m the texel footprint of the
    // 4-23 m lookups covers most of a mip level, so the sampler returns the
    // MEAN of the field. Every mask-driven term therefore converges to a
    // constant exactly where the critic was looking: "the mid-ground hillside
    // and every mountain facet are flat single-value surfaces". That is not a
    // bug in the shader; it is what mipmapping is for.
    //
    // Vertex colour does not mip. These two octaves are the only detail on the
    // ground that survives to 400 m, which is why they are here and not in the
    // shader. 26 m is the critic's macro band; 9 m is as fine as this mesh's
    // vertex spacing can carry (see the segs note above).
    // ---------------------------------------------------------------------
    const meso = noise.fbm(x * 0.0385 + 17.3, z * 0.0385 - 44.1, 2);
    const fine = noise.fbm(x * 0.112 - 3.7, z * 0.112 + 21.5, 2);

    // thin cover means more straw and exposed root showing through, not bare earth
    c.copy(PAL.lush).lerp(PAL.dry, clamp(dryness * 0.90 + patch * 0.24 + d * 0.34
                                         + meso * 0.72 + fine * 0.30, 0, 1));
    c.lerp(PAL.shade, clamp(moist, 0, 1) * 0.48 + (1 - patch) * 0.22
                      + clamp(-meso * 0.82 - fine * 0.34, 0, 0.38));
    // a stony/olive family on the drier high shoulders, so the landscape is not two
    // hues wide -- the plates render 800-1600 distinct quantised colours where a
    // meadow of one green renders 400
    c.lerp(PAL.rockWarm, smoothstep(0.55, 0.95, dryness) * (1 - moist) * 0.30);
    c.lerp(PAL.high, smoothstep(48, 92, h) * 0.7);

    // Broad value break-up centred on 1.0, now with the 26 m and 9 m octaves on top.
    //
    // MEASURED, and this is the most useful number in the file for whoever picks the
    // ground up next. Sampling a 450x270 px patch of the mid-ground hillside in
    // vista_golden, the luminance spread this term buys is:
    //
    //     coefficients        hillside sd
    //     none (r18 base)        12.92
    //     0.55 / 0.30            13.31   (+3%)
    //     2.20 / 1.20            15.95   (+24%)
    //
    // Four times the amplitude bought a quarter more contrast: the response is
    // heavily damped and the damping is NOT here. On a slope the ground shader in
    // src/world/index.js hands 88% of the fragment to `rock`, which is built entirely
    // from uniforms and from uMask lookups — and past ~80 m those lookups mip to
    // their own mean. Vertex colour is diluted to a few per cent of the result before
    // the fog gets to it. The mid-ground hillside cannot be un-flattened from this
    // file; it needs the rock branch of that shader to carry a distance-stable term.
    //
    // AND THE NEAR FIELD PAYS FOR THE FAR FIELD, WHICH IS WHY THE CLAMP IS HERE.
    // Vertex colour is view-independent, so buying mid-ground contrast this way also
    // multiplies the ground three metres from the lens. At 1.30/0.70 the upward
    // excursions landed on the shader's straw term (`grass * vec3(1.44, 1.14, 0.44)`)
    // and creature_portrait's soil went hot chartreuse — measured, the ground/sky
    // ratio went 0.94 -> 0.98 against a 0.96 ceiling on that term alone, and it was
    // ugly before it was out of band. The band caught a real regression.
    //
    // So: half the amplitude, and a hard asymmetric clamp. The ceiling is tighter
    // than the floor on purpose — a dark patch of meadow reads as damp ground, a
    // bright one reads as a rendering fault.
    const v = clamp(1.0 + 0.16 * noise.fbm(x * 0.006, z * 0.006, 2)
                        + 0.55 * meso + 0.28 * fine, 0.72, 1.10);
    colAttr[i * 3] = c.r * v; colAttr[i * 3 + 1] = c.g * v; colAttr[i * 3 + 2] = c.b * v;

    const shore = smoothstep(2.2, -0.6, h - T.waterLevel) * smoothstep(LAKE.r + 24, LAKE.r - 8, Math.hypot(x - LAKE.x, z - LAKE.z));
    maskAttr[i * 4] = clamp(T.bareAt(x, z), 0, 1);
    maskAttr[i * 4 + 1] = smoothstep(0.30, 0.62, sl);
    maskAttr[i * 4 + 2] = clamp(shore * 0.95, 0, 1);
    maskAttr[i * 4 + 3] = clamp(g, 0, 1);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colAttr, 3));
  geo.setAttribute('aMask', new THREE.BufferAttribute(maskAttr, 4));
  geo.computeVertexNormals();
  perturbGroundNormals(geo, noise);
  geo.computeBoundingSphere();
  return geo;
}

/**
 * SHADING RELIEF THE COLLIDER NEVER SEES.
 *
 * "A shadow falling on the ground has nothing to fall ACROSS" was the closing line of
 * r18's #1 critique, and it is a statement about NORMALS, not about albedo. Our meadow
 * shades on one interpolated normal per 2-4 m, so under a 16 degree key the whole
 * hollow returns the same N.L and reads as a painted sheet regardless of how much
 * colour variation is on it.
 *
 * Three things make this the right knob rather than displacing the mesh:
 *
 *  - AMPLIFICATION AT A GRAZING SUN. At 16 degrees elevation flat ground returns
 *    sin(16) = 0.276 of the key. Tilting the normal by 3 degrees swings that to
 *    sin(13)..sin(19) = 0.225..0.326, a +/-18% swing in the sunlit term for a tilt you
 *    cannot see in the silhouette. Nothing else available here buys that much shading
 *    variation that cheaply, and at noon it correctly fades to almost nothing.
 *  - IT COSTS ALMOST NOTHING IN `edge`. A normal perturbation modulates only the
 *    direct term, so flat-lit ground and shadowed ground stay calm. Adding the same
 *    contrast as albedo would have raised local contrast everywhere in the frame at
 *    once, and interaction_feed had 0.56 of headroom under the 10.0 ceiling.
 *  - THE COLLIDER IS UNTOUCHED. heightAt() is the single source of truth for physics,
 *    creature placement and prop sinking; displacing the render mesh by even 20 cm
 *    would float or bury every one of them. Bending the normal changes shading only.
 *
 * NEGATIVE RESULT worth keeping: doing this per-vertex caps the wavelength at ~4x the
 * vertex spacing (~8 m here). Finer relief has to be a fragment-shader bump off the
 * screen-space derivative — see sgBump_() in materials.js, which is how the rock and
 * the far ranges get theirs. The ground's fragment shader is in src/world/index.js.
 *
 * THE MOUNTAINS IN vista_golden ARE THIS MESH. Measured with tools/_grainprobe.mjs by
 * setting `visible = false` on every mesh carrying an aerial material and re-rendering
 * the vista_golden camera: the far-range luminance band moved by 0.9 out of 168 and its
 * sd by 0.6 out of 43. The skirt, the mesas and the tower are almost entirely OCCLUDED
 * in that shot. What reads as "the mountain range" is the ground mesh's own bowl rim
 * (`rim` in analytic(), +52..130 m at r 280-470) seen at 300-450 m. So the shot's
 * mountains are shaded by the ground shader and by these normals, and any amount of
 * work on makeAerialMaterial is invisible there. That cost half a round to find; do not
 * re-derive it.
 */
function perturbGroundNormals(geo, noise) {
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  // Metres of virtual relief per octave.
  //
  // MEASURED, and worth recording because the first pass was far too timid to be
  // worth its complexity: at A1 0.42 / A2 0.13 (a ~3 degree peak tilt) the whole
  // change moved `edge` on vista_golden by -0.07 and on interaction_feed by +0.01,
  // i.e. nothing. Do not assume a normal perturbation is expensive in the guardrails
  // just because an albedo one is; it is roughly 8x cheaper per unit of visible
  // relief, so it has to be authored 2-3x louder than instinct says.
  //
  // NEGATIVE RESULT, removed rather than shipped. A third octave was added here to
  // give the bowl rim — which is what reads as "the mountain range" in vista_golden,
  // see above — some talus form: 3.2 m of relief at a 70 m wavelength, gated on
  // smoothstep(0.16, 0.44, slopeAt) so it could not re-tilt the starting meadow.
  //
  //     A0 = 3.2, F0 = 0.0143, slope-gated
  //     result: 0.05% of vista_golden pixels moved by more than 2 levels;
  //             mid-range luminance sd 39.96 -> 39.96, gx 0.749 -> 0.749.
  //
  // It is not that the octave was too small. Those slopes are 300-450 m away, where
  // FogExp2 has already taken half the signal, and they are the AVERTED faces — the
  // key contributes almost nothing there, and a normal perturbation can only modulate
  // what the key delivers. Bending normals is a grazing-sun tool and the rim is not
  // grazed; it is shadowed. Anything that is going to give the far rim form has to be
  // albedo or geometry, not shading.
  const A1 = 0.95, F1 = 0.0385;   // ~26 m
  const A2 = 0.30, F2 = 0.112;    // ~9 m
  const relief = (x, z) => A1 * noise.fbm(x * F1 + 17.3, z * F1 - 44.1, 2)
                         + A2 * noise.fbm(x * F2 - 3.7, z * F2 + 21.5, 2);
  // Central difference at roughly the vertex spacing: sampling finer than the mesh can
  // represent gives neighbouring vertices uncorrelated normals, which is faceting, not
  // relief.
  const e = 2.2;
  const inv = 1 / (2 * e);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const gx = (relief(x + e, z) - relief(x - e, z)) * inv;
    const gz = (relief(x, z + e) - relief(x, z - e)) * inv;
    // The perturbed normal of a heightfield h + relief is (-dh/dx, 1, -dh/dz); adding
    // the relief gradient into the existing normal's tangent plane is the same thing
    // to first order and preserves whatever slope the terrain already had.
    let nx = nrm.getX(i) - gx * nrm.getY(i);
    let ny = nrm.getY(i);
    let nz = nrm.getZ(i) - gz * nrm.getY(i);
    const l = Math.hypot(nx, ny, nz) || 1;
    nrm.setXYZ(i, nx / l, ny / l, nz / l);
  }
  nrm.needsUpdate = true;
}

/** Low-res ring carrying the landscape from the playable rim out to the horizon. */
export function buildSkirtGeometry(ctx, T, r0, r1, rings, segs) {
  const noise = ctx.noise;
  // The far range was the loudest "low-poly" tell in the frame: at 26 rings / 96
  // segments the first ring lands ~35 m triangles at 500 m, which is ~2 deg of arc
  // and reads as faceted origami. Reference #7 wants the far plane to be a smooth,
  // near-featureless pale silhouette, so subdivide before shading. ~31k tris, one
  // draw call, built once.
  rings = Math.round(rings * 2.5);
  segs = Math.round(segs * 2.5);
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

      // Reference #7 wants the far plane pale and desaturated, but "pale" is not the
      // same as "one flat value". The old colouring was a pure function of height, so
      // every distant range came out as a single-facet white cutout with no rock
      // striation and no shading break. Three terms fix that while staying inside the
      // low-saturation band: horizontal bedrock banding, a broken snow line, and a
      // large-scale value drift that puts light and dark shoulders on the same ridge.
      // `noise.fbm` returns a value centred on 0 with a standard deviation of
      // 0.20 (measured), not a 0..1 field. The previous coefficients (0.17 strat,
      // 0.13 drift) therefore delivered a 4% value swing across an entire mountain
      // range, which is precisely the "flat paper cutout, single-facet white
      // silhouette, no rock striation, no shading break" the critique named.
      // Amplitudes below are chosen against that measured sd: ~28% total spread,
      // which is what a hazed range at 1-3 km actually shows.
      const strat = noise.fbm(h * 0.026 + x * 0.0009, h * 0.026 + z * 0.0009, 3);
      const bands = noise.fbm(h * 0.085 + 17.0, (x + z) * 0.0016, 2);   // tight bedrock courses
      const drift = noise.fbm(x * 0.0021 + 3.3, z * 0.0021 - 7.1, 3);
      const green = smoothstep(210, 90, h);
      const snowLine = 300 + 120 * drift + 60 * strat;
      const snow = smoothstep(snowLine, snowLine + 130, h);
      // Rock is not one grey: warm scree on the sunward drift, cool stone in the
      // troughs. Hue variation survives the aerial desaturation better than value
      // does, so it is what keeps the far plane from quantising to two colours.
      c.copy(PAL.rock).lerp(PAL.rockWarm, clamp(0.5 + drift * 1.6, 0, 1) * 0.55);
      c.lerp(PAL.shade, green * 0.8).lerp(C(0xe8eef2), snow * 0.88);
      const v = 1 + 0.70 * strat + 0.42 * drift + 0.30 * bands * (1 - snow) - 0.05 * green;
      cols.push(c.r * v, c.g * v, c.b * v);
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
