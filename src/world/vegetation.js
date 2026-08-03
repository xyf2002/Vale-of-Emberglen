import * as THREE from 'three';
import { clamp, lerp, smoothstep, hash2i } from './util.js';
import { mergeGeos, paint } from './materials.js';

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
const GRASS_PAL = {
  lush: C(0xafb87a),
  dry: C(0xcdc38c),
  shade: C(0x8a9769),
  blue: C(0xa0b48c),
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
  const BANDS = [
    { id: 11, r0: 0, r1: 12, step: 0.21 * spread, w: 0.20, h: 0.30, hv: 0.46, blades: 5 },
    { id: 22, r0: 11, r1: 32, step: 0.58 * spread, w: 0.38, h: 0.40, hv: 0.42, blades: 5 },
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
          // gentle root occlusion only -- reference #9 calls crease occlusion
          // "present but gentle". The old 0.46 floor crushed the bottom two thirds
          // of every blade, and at a grazing view that is most of what you see.
          diffuseColor.rgb *= mix(0.76, 1.05, smoothstep(0.0, 0.55, vBladeH));`);
      applyFoliageWrap(sh, 0.66);
    };
    m.customProgramCacheKey = () => 'grassblade';
    return m;
  }

  const group = new THREE.Group();
  group.name = 'grass';
  const meshes = [];
  const mat = makeMat();

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
          const width = b.w * (0.8 + 0.5 * h4);

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
          // tip highlight as well and the meadow glitters like tinsel; 0.78-1.22
          // keeps the variegation without the sparkle.
          const v = 0.78 + 0.44 * h3;
          col.multiplyScalar(v);
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
    update(dt, elapsed) {
      uniforms.uTime.value = elapsed;
    },
  };
}

/* ============================================================== FLOWERS ======== */

function flowerGeometry(petals = 5) {
  const parts = [];
  // stem
  const stem = new THREE.PlaneGeometry(0.014, 0.24).translate(0, 0.12, 0);
  parts.push(paint(stem, 0x6f8a3e));
  const stem2 = stem.clone().rotateY(Math.PI / 2);
  parts.push(paint(stem2, 0x6f8a3e));
  // petals
  for (let p = 0; p < petals; p++) {
    const a = (p / petals) * Math.PI * 2;
    const pet = new THREE.PlaneGeometry(0.048, 0.075);
    pet.rotateX(-Math.PI / 2);
    pet.translate(0, 0, 0.048);
    pet.rotateX(-0.30);
    pet.rotateY(a);
    pet.translate(0, 0.245, 0);
    parts.push(paint(pet, 0xffffff));
  }
  // centre
  const mid = new THREE.CircleGeometry(0.022, 6).rotateX(-Math.PI / 2).translate(0, 0.252, 0);
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
  // clusters of 5-15 blooms — never an even scatter (reference observation #8)
  const clusters = Math.round(46 * q);
  for (let i = 0; i < clusters; i++) {
    let cx = 0, cz = 0, ok = false;
    for (let t = 0; t < 24; t++) {
      const a = rng.next() * Math.PI * 2;
      const r = 12 + Math.sqrt(rng.next()) * 230;
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
  // two or three broad drifts, like the pink field in pw_11
  const drifts = Math.round(3 * q);
  for (let i = 0; i < drifts; i++) {
    for (let t = 0; t < 30; t++) {
      const a = rng.next() * Math.PI * 2;
      const r = 45 + Math.sqrt(rng.next()) * 150;
      const cx = Math.cos(a) * r, cz = Math.sin(a) * r;
      if (T.slopeAt(cx, cz) > 0.22 || T.grassAt(cx, cz) < 0.7) continue;
      if (T.heightAt(cx, cz) < T.waterLevel + 1.5) continue;
      spots.push({ cx, cz, n: rng.int(90, 150), rad: rng.range(9, 17), hue: rng.pick([0xef7fa8, 0xf6b3cd, 0xfaf3ee]), scale: rng.range(0.9, 1.2) });
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
  merged.userData = { height: h };
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
  let count = 0;
  for (let vi = 0; vi < VARIANTS; vi++) {
    const list = placements[vi];
    if (!list.length) continue;
    const mesh = new THREE.InstancedMesh(geos[vi], mat, list.length);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 3), 3);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      qt.setFromAxisAngle(up, p.rot);
      m4.compose({ x: p.x, y: p.y - 0.15, z: p.z }, qt, { x: p.s, y: p.s * (0.9 + rng.next() * 0.25), z: p.s });
      mesh.setMatrixAt(i, m4);
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
