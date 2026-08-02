import * as THREE from 'three';
import { ORDER } from '../engine/Game.js';
import { clamp, smoothstep } from './util.js';
import { createTerrain, buildGroundMesh, buildSkirtGeometry, LAKE, BUTTE, CRAG, AX, AZ, PX, PZ } from './terrain.js';
import { makeNoiseTexture, makeAerialMaterial, syncAerial } from './materials.js';
import { createGrass, createFlowers, createTrees, createBushes } from './vegetation.js';
import { createRocks, createRuin, createWater, createLandmarks } from './props.js';

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
  let ground, skirt, grass, water, landmarks;
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

      const detailTex = makeNoiseTexture(c.seed ^ 0x51, 256, 6, 4, 0.34, 0x8f8f83, 0xffffff);
      detailTex.repeat.set((bounds.radius + 40) * 2 / 7.5, (bounds.radius + 40) * 2 / 7.5);
      const macroTex = makeNoiseTexture(c.seed ^ 0x2711, 128, 4, 3, 0.26, 0x9c9c93, 0xffffff);
      macroTex.wrapS = macroTex.wrapT = THREE.RepeatWrapping;

      const groundMat = new THREE.MeshLambertMaterial({
        vertexColors: true, map: detailTex, color: 0xffffff,
      });
      const macroRepeat = { value: 1 / 96 };
      groundMat.onBeforeCompile = (sh) => {
        sh.uniforms.uMacro = { value: macroTex };
        sh.uniforms.uMacroScale = macroRepeat;
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vGW;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\n vGW = (modelMatrix * vec4(transformed,1.0)).xyz;');
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform sampler2D uMacro;\nuniform float uMacroScale;\nvarying vec3 vGW;')
          .replace('#include <map_fragment>', `#include <map_fragment>
            {
              vec3 m = texture2D(uMacro, vGW.xz * uMacroScale).rgb;
              float mm = dot(m, vec3(0.333));
              diffuseColor.rgb *= (0.80 + 0.40 * mm);
            }`);
      };
      groundMat.customProgramCacheKey = () => 'groundmat';

      ground = new THREE.Mesh(geo, groundMat);
      ground.receiveShadow = true;
      ground.castShadow = false;
      ground.name = 'ground';
      c.scene.add(ground);

      // ---------------------------------------------------------- horizon skirt
      const skirtMat = makeAerialMaterial({ color: 0x94a08c, maxHaze: 0.90, desat: 0.62 });
      aerialMats.push(skirtMat);
      skirt = new THREE.Mesh(buildSkirtGeometry(T, bounds.radius + 30, 3000, 26, 96), skirtMat);
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
      for (const m of rocks.meshes) c.scene.add(m);
      counts.rocks = rocks.count;

      const flowers = createFlowers(c, T, rng.fork(79));
      c.scene.add(flowers.mesh);
      counts.flowers = flowers.count;

      grass = createGrass(c, T);
      c.scene.add(grass.group);

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
      };
    },
  };
}
