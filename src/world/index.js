import * as THREE from 'three';
import { ORDER } from '../engine/Game.js';

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
 * This is a STUB: a gentle noise-displaced ground plane. Replace freely, keep the API.
 */
export function createWorld() {
  let ctx, noise;
  const bounds = { radius: 420 };
  let ground;

  const H = (x, z) => {
    const n = noise.fbm(x * 0.0032, z * 0.0032, 5);
    const roll = noise.fbm(x * 0.013, z * 0.013, 3) * 0.35;
    return (n * 34 + roll * 8);
  };

  return {
    name: 'world',
    order: ORDER.WORLD,
    bounds,

    init(c) {
      ctx = c; noise = c.noise;
      const seg = c.quality.tier === 'high' ? 320 : 220;
      const size = bounds.radius * 2;
      const geo = new THREE.PlaneGeometry(size, size, seg, seg);
      geo.rotateX(-Math.PI / 2);
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        pos.setY(i, H(pos.getX(i), pos.getZ(i)));
      }
      geo.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({ color: 0x6f8f4e, roughness: 0.95, metalness: 0 });
      ground = new THREE.Mesh(geo, mat);
      ground.receiveShadow = true;
      ground.name = 'ground';
      c.scene.add(ground);
    },

    heightAt(x, z) { return H(x, z); },

    normalAt(x, z) {
      const e = 0.75;
      const hL = H(x - e, z), hR = H(x + e, z), hD = H(x, z - e), hU = H(x, z + e);
      return new THREE.Vector3(hL - hR, 2 * e, hD - hU).normalize();
    },

    slopeAt(x, z) { return 1 - Math.max(0, this.normalAt(x, z).y); },

    biomeAt(x, z) {
      const h = H(x, z);
      if (h < 1.5) return { name: 'shore', grass: 0.2, tint: 0xbfae86 };
      if (h > 26) return { name: 'highland', grass: 0.4, tint: 0x8a9a7a };
      return { name: 'meadow', grass: 1.0, tint: 0x7fa050 };
    },

    sampleSpawn(rng, { maxSlope = 0.35, minH = 1.5, tries = 40, near = null, radius = 120 } = {}) {
      for (let i = 0; i < tries; i++) {
        const a = rng.next() * Math.PI * 2;
        const r = Math.sqrt(rng.next()) * (near ? radius : bounds.radius * 0.9);
        const x = (near?.x ?? 0) + Math.cos(a) * r;
        const z = (near?.z ?? 0) + Math.sin(a) * r;
        if (this.heightAt(x, z) < minH) continue;
        if (this.slopeAt(x, z) > maxSlope) continue;
        return { x, z };
      }
      return null;
    },

    snapshot() { return { biomeAtPlayer: null, radius: bounds.radius }; },
  };
}
