import * as THREE from 'three';
import { ORDER } from '../engine/Game.js';
import { clamp, smoothstep } from './util.js';
import { createTerrain, buildGroundMesh, buildSkirtGeometry, LAKE, BUTTE, CRAG, AX, AZ, PX, PZ } from './terrain.js';
import { makeMaskTexture, makeAerialMaterial, syncAerial, liftVertexAlbedo, setAerialPivot } from './materials.js';
import { createGrass, createFlowers, createTrees, createBushes } from './vegetation.js';
import { createRocks, createRuin, createWater, createLandmarks, createMotes } from './props.js';

/**
 * WORLD SYSTEM — owned by the world builder. Owns everything you stand on or walk past:
 * terrain, biomes, vegetation, rocks, water, landmarks.
 *
 * PUBLIC CONTRACT (other systems depend on these — do not rename):
 *   heightAt(x, z) -> number            ground height in world units
 *   normalAt(x, z) -> THREE.Vector3     ground normal (unit)
 *   biomeAt(x, z)  -> { name, ... }     biome descriptor at a point
 *   slopeAt(x, z)  -> number            0 flat .. 1 vertical
 *   sampleSpawn(rng, opts) -> {x,z}|null  a plausible standing spot
 *   bounds -> { radius }                playable radius from origin
 *   snapshot() -> object                cheap JSON for the capture harness
 *
 * Extras other systems may use (additive, safe to ignore):
 *   waterLevel, isWater(x,z), grassAt(x,z), dirtAt(x,z), landmarks
 *
 * Composition: a sheltered hollow at the origin, a walkable valley running along the
 * vista axis, a lake at ~130 m, a flat-topped butte and a crag framing the mid ground,
 * ridges either side, a bowl rim, and pale mesas + a ruined tower at 0.9–2.7 km.
 */
const toWorld = (u, v) => [u * AX + v * PX, u * AZ + v * PZ];

export function createWorld() {
  let ctx, T;
  const bounds = { radius: 420 };
  let ground, skirt, grass, water, landmarks, motes;
  const aerialMats = [];
  const counts = {};
  const _n = new THREE.Vector3();

  const BIOMES = {
    meadow: { name: 'meadow', grass: 1.0, tint: 0x86a746, walkable: true },
    grove: { name: 'grove', grass: 0.7, tint: 0x6d8f3f, walkable: true },
    shore: { name: 'shore', grass: 0.25, tint: 0xc4b489, walkable: true },
    water: { name: 'water', grass: 0.0, tint: 0x2f6a70, walkable: false },
    trail: { name: 'trail', grass: 0.15, tint: 0xa8916a, walkable: true },
    rocky: { name: 'rocky', grass: 0.2, tint: 0x8d8f86, walkable: false },
    highland: { name: 'highland', grass: 0.5, tint: 0x93a184, walkable: true },
  };

  return {
    name: 'world',
    order: ORDER.WORLD,
    bounds,

    init(c) {
      ctx = c;
      const rng = c.rng.fork(1301);
      T = createTerrain(c);

      // ---------------------------------------------------------- ground
      const segs = c.quality.tier === 'high' ? 420 : 250;
      const geo = buildGroundMesh(c, T, bounds.radius + 40, segs);

      // ---------------------------------------------------------------------
      // GROUND MATERIAL
      //
      // The ground is 40-70% of every gameplay frame and it used to carry almost no
      // information: one vertex-interpolated olive, modulated by two monochrome noise
      // maps. Every material change (soil, rock, sand) happened as a 2.2 m linear ramp
      // between vertices, which at any sane viewing distance is invisible.
      //
      // Now the mesh exports MASKS (worn soil / slope rock / shore sand / grass cover)
      // and the fragment shader blends real albedos against them, with the transition
      // edges broken up by four world-space samples of a three-channel noise mask at
      // 140 m / 23 m / 4.3 m / 1.15 m. Extra rock weight comes from the interpolated
      // surface normal, so slope drives material directly rather than through a
      // pre-baked vertex ramp.
      //
      // Two rules kept it from turning into sizzle (reference #11 wants "one hero
      // element, large calm areas"):
      //   - patch BOUNDARIES are crisp, patch INTERIORS are calm. All the local
      //     contrast comes from a handful of visible edges per square metre, not from
      //     a fine grain applied everywhere.
      //   - the finest octave only modulates value by +/-8% and is faded out past 30 m
      //     so the mid ground does not shimmer under camera motion.
      // ---------------------------------------------------------------------
      const maskTex = makeMaskTexture(c.seed ^ 0x51, 256, [5, 7, 11], 4);

      const groundMat = new THREE.MeshLambertMaterial({
        vertexColors: true, color: 0xffffff,
      });
      groundMat.onBeforeCompile = (sh) => {
        sh.uniforms.uMask = { value: maskTex };
        // Worn earth, NOT mud. First pass used a saturated 0xc4ab7f and the paths came
        // back as rust-orange slicks. Measured off pw_11 and pw_15: a trodden path sits
        // at roughly the same luminance as the grass beside it or a little LIGHTER, and
        // is close to neutral — the material change reads as a hue/texture break, not as
        // a colour-blob. Reference #5: the world is desaturated, the creatures are not.
        sh.uniforms.uSoil = { value: new THREE.Color(0x9c9781).convertSRGBToLinear() };
        sh.uniforms.uSoilDark = { value: new THREE.Color(0x7d7663).convertSRGBToLinear() };
        sh.uniforms.uRock = { value: new THREE.Color(0xa9aba0).convertSRGBToLinear() };
        sh.uniforms.uRockWarm = { value: new THREE.Color(0xb6af9a).convertSRGBToLinear() };
        sh.uniforms.uSand = { value: new THREE.Color(0xd6c8a2).convertSRGBToLinear() };
        // average albedo of the instanced blade carpet — the terrain fades into this
        // over the same band the blades fade out in, so the grass radius has no edge
        sh.uniforms.uCanopy = { value: new THREE.Color(0xbcc785).convertSRGBToLinear() };
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', `#include <common>
            attribute vec4 aMask;
            varying vec4 vGMask; varying vec3 vGW; varying vec3 vGN;`)
          .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
            vGN = normalize(mat3(modelMatrix) * objectNormal);`)
          .replace('#include <begin_vertex>', `#include <begin_vertex>
            vGW = (modelMatrix * vec4(transformed,1.0)).xyz;
            vGMask = aMask;`);
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <common>', `#include <common>
            uniform sampler2D uMask;
            uniform vec3 uSoil, uSoilDark, uRock, uRockWarm, uSand, uCanopy;
            varying vec4 vGMask; varying vec3 vGW; varying vec3 vGN;
            vec2 rot2g(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c*p.x - s*p.y, s*p.x + c*p.y); }
            // ---------------------------------------------------------------
            // THE REASON THIS GROUND MEASURED FLAT.
            //
            // uMask packs three fbm fields normalised to fill 0..1 by min/max. But a
            // 4-octave fbm is not UNIFORM over that range, it is a narrow bell:
            // measured mean 0.52, standard deviation 0.15. So a term written as
            // "0.79 + 0.44 * n" -- which reads like a +/-22% swing -- actually
            // delivers +/-6.6%, and a threshold written as smoothstep(0.76, 0.97, n)
            // fires on well under 1% of the surface. Every material blend and every
            // value break in the previous version was authored at roughly a quarter
            // of the amplitude it appears to have, and the soil / rock layers
            // essentially never crossed their thresholds on flat ground at all.
            //
            // Measured consequence: our meadow rendered 7 levels of luminance spread
            // where pw_11 and pw_15 measure 31-36. One olive value from the player's
            // feet to the base of the hills.
            //
            // xp() expands a sample about 0.5 so the constants below mean what they
            // look like they mean. It also clips the tails, which is exactly the
            // shape reference #11 wants: patch INTERIORS go flat and calm, and all
            // the local contrast lands on a handful of visible BOUNDARIES per square
            // metre rather than as an even sizzle over the whole frame.
            float xp(float v, float k) { return clamp((v - 0.5) * k + 0.5, 0.0, 1.0); }`)
          .replace('#include <color_fragment>', `#include <color_fragment>
            {
              vec2 w = vGW.xz;
              // five scales, each rotated by a different angle so the 256px tile never
              // lines up with itself across octaves
              vec3 nM = texture2D(uMask, rot2g(w, 0.31) * 0.00714).rgb;   // ~140 m
              vec3 nA = texture2D(uMask, rot2g(w, 1.17) * 0.04350).rgb;   // ~23 m
              vec3 nD = texture2D(uMask, rot2g(w, 1.94) * 0.10870).rgb;   // ~9.2 m
              vec3 nB = texture2D(uMask, rot2g(w, 2.42) * 0.23260).rgb;   // ~4.3 m
              vec3 nC = texture2D(uMask, rot2g(w, 0.83) * 0.86960).rgb;   // ~1.15 m

              float dist = length(vGW - cameraPosition);
              float nearAmt = 1.0 - smoothstep(20.0, 60.0, dist);
              float slope = 1.0 - clamp(normalize(vGN).y, 0.0, 1.0);

              // ---- layer 1: living grass ----------------------------------
              vec3 grass = diffuseColor.rgb;
              // tussocks: lush dark clumps against drier straw, at the 4 m scale you
              // actually read from standing height, drifting over 23 m.
              float tuss = xp(nB.g * 0.58 + nA.b * 0.42, 2.7);
              grass *= 0.64 + 0.72 * tuss;
              // 1-9 m stipple on top, so a tussock interior is not itself flat
              float fine = xp(nC.g * 0.55 + nD.r * 0.45, 2.4);
              grass *= 0.88 + 0.24 * fine;
              // sun-bleached straw: warmer AND lighter, ~25% of the surface
              float straw = smoothstep(0.46, 0.80, xp(nB.r * 0.55 + nA.r * 0.45, 2.6) + (1.0 - vGMask.w) * 0.22);
              grass = mix(grass, grass * vec3(1.44, 1.14, 0.44), straw * 0.78);
              // damp hollows: darker, cooler green, ~20%
              float deep = smoothstep(0.44, 0.08, xp(nA.g * 0.55 + nB.b * 0.45, 2.6));
              grass = mix(grass, grass * vec3(0.54, 0.86, 0.76), deep * 0.74);

              // ---- layer 2: worn / trodden soil ----------------------------
              vec3 soil = mix(uSoilDark, uSoil, xp(nB.b * 0.6 + nC.r * 0.4, 2.2));
              soil *= 0.84 + 0.32 * xp(nD.b, 2.0);

              // ---- layer 3: exposed rock / gravel --------------------------
              vec3 rock = mix(uRock, uRockWarm, xp(nA.r, 2.0)) * (0.72 + 0.56 * xp(nB.b, 2.2));

              // ---- weights, with noise-broken edges ------------------------
              // Reference #8 and the blind critique both ask for the ground to change
              // material three or four times across a single shot. The authored masks
              // only carry paths, shoreline and steep slopes, none of which cross the
              // open starting meadow -- so a genuine patch term has to put worn earth
              // and gravel into flat grass as well. ~15% soil, ~7% gravel by area.
              float soilPatch = smoothstep(0.62, 0.93, xp(nA.b * 0.45 + nD.g * 0.35 + nB.r * 0.20, 2.8));
              float soilW = clamp(vGMask.x * 1.05 + soilPatch * 0.90 + (1.0 - vGMask.w) * 0.55, 0.0, 1.0);
              soilW *= 1.0 - vGMask.z * 0.7;

              float rockPatch = smoothstep(0.74, 0.98, xp(nB.b * 0.5 + nA.r * 0.5, 2.9));
              float rockW = clamp(vGMask.y * 1.15 + smoothstep(0.30, 0.66, slope) * 0.85
                                  + rockPatch * 0.75 * (0.35 + 0.65 * (1.0 - vGMask.w)), 0.0, 1.0);

              // never a full handover — real worn ground keeps stubble in it, and a
              // 100% soil patch reads as a decal stuck on the meadow
              vec3 col = mix(grass, soil, soilW * 0.80);
              col = mix(col, rock, rockW * 0.88);
              col = mix(col, uSand * (0.80 + 0.42 * xp(nB.r, 2.2)), vGMask.z * 0.88);

              // loose stones in the near field: small, dark, sparse. This is the only
              // term allowed to be high-frequency, and it dies off by 60 m.
              float peb = smoothstep(0.85, 0.99, xp(nC.r * 0.6 + nC.g * 0.4, 2.6)) * nearAmt;
              col = mix(col, rock * 0.66, peb * 0.55 * (1.0 - vGMask.z));

              // ---- large-scale value: light and dark sweeps across the meadow
              // (pw_11 and pw_15 both read as broad soft shadow shapes over the grass)
              col *= 0.80 + 0.40 * xp(nM.g * 0.5 + nA.g * 0.5, 2.2);
              // ---- finest grain, near field only ---------------------------
              col *= 1.0 + (xp(nC.b, 2.2) - 0.5) * 0.26 * nearAmt;

              // ---- fade the bare terrain into the blade carpet's own colour -
              // The instanced blades stop at a fixed radius. Against an untinted
              // backing plane that produced a visible RING in the wide shot and a hard
              // horizontal BAND SEAM in the over-shoulder. Pushing the ground toward
              // the carpet's average albedo over the same distance band removes the
              // handoff instead of hiding it. The target colour carries the tussock
              // term with it, so the mid ground keeps its variation rather than
              // dissolving into one flat wash the moment the blades stop.
              float far = smoothstep(30.0, 150.0, dist);
              vec3 canopy = mix(col, uCanopy * (0.64 + 0.74 * tuss), 0.55);
              col = mix(col, canopy, far * vGMask.w * 0.80);

              diffuseColor.rgb = col;
            }`);
      };
      groundMat.customProgramCacheKey = () => 'groundmat3';

      ground = new THREE.Mesh(geo, groundMat);
      ground.receiveShadow = true;
      ground.castShadow = false;
      ground.name = 'ground';
      c.scene.add(ground);

      // ---------------------------------------------------------- horizon skirt
      const skirtMat = makeAerialMaterial({ color: 0x94a08c, maxHaze: 0.90, desat: 0.50, form: 0.80 });
      aerialMats.push(skirtMat);
      const skirtGeo = buildSkirtGeometry(c, T, bounds.radius + 30, 3000, 26, 96);
      setAerialPivot(skirtMat, skirtGeo);
      skirt = new THREE.Mesh(skirtGeo, skirtMat);
      skirt.frustumCulled = false;
      skirt.name = 'horizon';
      c.scene.add(skirt);

      // ---------------------------------------------------------- landmarks
      landmarks = createLandmarks(c, T, rng.fork(21));
      aerialMats.push(...landmarks.mats);
      c.scene.add(landmarks.group);

      // ---------------------------------------------------------- water
      water = createWater(c, T);
      c.scene.add(water.mesh);

      // ---------------------------------------------------------- vegetation
      const trees = createTrees(c, T, rng.fork(41));
      for (const m of trees.meshes) c.scene.add(m);
      counts.trees = trees.count;

      const bushes = createBushes(c, T, rng.fork(53));
      for (const m of bushes.meshes) c.scene.add(m);
      counts.bushes = bushes.count;

      const rocks = createRocks(c, T, rng.fork(67));
      // see liftVertexAlbedo: the rock builder double-converts its palette to linear, so
      // every stone in the world was rendering at roughly a sixth of the albedo a grey
      // rock has. 4.6 puts lit stone at ~0.16 linear (renders ~158/255 in full sun,
      // which is where the reference plates' rock sits) without blowing the highlights.
      for (const m of rocks.meshes) { liftVertexAlbedo(m.geometry, 4.6); c.scene.add(m); }
      counts.rocks = rocks.count;

      const flowers = createFlowers(c, T, rng.fork(79));
      c.scene.add(flowers.mesh);
      counts.flowers = flowers.count;

      grass = createGrass(c, T);
      c.scene.add(grass.group);

      // night practicals — invisible in daylight, see createMotes
      motes = createMotes(c, T, rng.fork(113));
      c.scene.add(motes.mesh);
      counts.motes = motes.count;

      // ---------------------------------------------------------- ruins
      const ruinRng = rng.fork(97);
      const [rx, rz] = toWorld(30, -34);
      c.scene.add(createRuin(c, T, ruinRng, rx, rz, 1.0));
      const [r2x, r2z] = toWorld(112, 62);
      c.scene.add(createRuin(c, T, ruinRng, r2x, r2z, 1.5));

      // seed a first grass field around the origin so frame 0 is never bald
      grass.rebuild(0, 0);
    },

    update(dt, c) {
      grass?.update(dt, c.elapsed);
      if (water) water.material.uniforms.uTime.value = c.elapsed;
      const sky = c.get('sky');
      syncAerial(aerialMats, c.scene, sky);
      motes?.update(c.elapsed, sky?.getNightAmount ? sky.getNightAmount() : 0);
      if (water && sky?.getSunDirection) {
        water.material.uniforms.uSun.value.copy(sky.getSunDirection());
        water.material.uniforms.uSunCol.value.copy(sky.getSunColor());
        const bg = c.scene.fog?.color ?? c.scene.background;
        if (bg?.isColor) water.material.uniforms.uSky.value.copy(bg);
      }
    },

    postUpdate(dt, c) {
      const cam = c.camera;
      grass?.rebuild(cam.position.x, cam.position.z);
    },

    // ------------------------------------------------------------- queries
    heightAt(x, z) { return T ? T.heightAt(x, z) : 0; },

    normalAt(x, z) { return T ? T.normalAt(x, z) : _n.set(0, 1, 0).clone(); },

    slopeAt(x, z) { return T ? T.slopeAt(x, z) : 0; },

    get waterLevel() { return T ? T.waterLevel : 0; },

    isWater(x, z) {
      if (!T) return false;
      return T.heightAt(x, z) < T.waterLevel - 0.05;
    },

    grassAt(x, z) { return T ? T.grassAt(x, z) : 0; },
    dirtAt(x, z) { return T ? T.dirtAt(x, z) : 0; },

    biomeAt(x, z) {
      if (!T) return BIOMES.meadow;
      const h = T.heightAt(x, z);
      if (h < T.waterLevel - 0.05) return BIOMES.water;
      const sl = T.slopeAt(x, z);
      if (sl > 0.55) return BIOMES.rocky;
      if (h < T.waterLevel + 1.8) return BIOMES.shore;
      if (h > 62) return BIOMES.highland;
      if (T.dirtAt(x, z) > 0.62) return BIOMES.trail;
      const g = T.grassAt(x, z);
      if (g < 0.45) return BIOMES.grove;
      return BIOMES.meadow;
    },

    sampleSpawn(rng, { maxSlope = 0.35, minH = null, tries = 48, near = null, radius = 110 } = {}) {
      const floor = minH ?? (T ? T.waterLevel + 1.0 : 1.5);
      const R = near ? radius : Math.min(radius, 120);
      for (let i = 0; i < tries; i++) {
        const a = rng.next() * Math.PI * 2;
        const r = Math.sqrt(rng.next()) * R;
        const x = (near?.x ?? 0) + Math.cos(a) * r;
        const z = (near?.z ?? 0) + Math.sin(a) * r;
        if (Math.hypot(x, z) > bounds.radius) continue;
        if (this.heightAt(x, z) < floor) continue;
        if (this.slopeAt(x, z) > maxSlope) continue;
        return { x, z };
      }
      return null;
    },

    /** points of interest other systems may steer toward */
    get landmarks() {
      return {
        lake: { x: LAKE.x, z: LAKE.z, r: LAKE.r },
        butte: { x: BUTTE.x, z: BUTTE.z },
        crag: { x: CRAG.x, z: CRAG.z },
        tower: landmarks?.tower ?? null,
      };
    },

    snapshot() {
      const p = ctx?.get('player')?.position;
      const b = p ? this.biomeAt(p.x, p.z) : null;
      return {
        radius: bounds.radius,
        biomeAtPlayer: b?.name ?? null,
        waterLevel: T ? +T.waterLevel.toFixed(2) : null,
        grassBlades: grass?.count ?? 0,
        trees: counts.trees ?? 0,
        rocks: counts.rocks ?? 0,
        flowers: counts.flowers ?? 0,
        bushes: counts.bushes ?? 0,
        motes: counts.motes ?? 0,
      };
    },
  };
}
