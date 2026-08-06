import * as THREE from 'three';

/**
 * BALLISTICS — where did that round actually go?
 *
 * There is no THREE.Raycaster in here on purpose. Almost everything in this world is an
 * InstancedMesh (grass blades, trees, rocks, flowers) or a 420x420 segment heightfield,
 * so a scene raycast would either be catastrophically slow or silently wrong. What the
 * world DOES expose is a cheap analytic height field — `heightAt`, `normalAt`, `slopeAt`,
 * `biomeAt` — which is the real surface the player is looking at, so the trace marches
 * that directly and refines the crossing by bisection.
 *
 * Creatures are tested first, as spheres, because a hit on a creature is the only
 * outcome the game actually cares about.
 *
 * KNOWN GAP, stated rather than hidden: tree trunks, rocks and ruin walls are NOT in the
 * trace. A round fired into a tree passes through it and lands on the ground behind.
 * Fixing that needs a broadphase the world system does not currently publish (a list of
 * prop bounding volumes); see the report.
 */

const _v = new THREE.Vector3();
const _oc = new THREE.Vector3();

/** what kind of ground is at (x, z), in the vocabulary the FX table understands */
export function classifySurface(world, x, z) {
  if (!world) return 'dirt';
  if (world.isWater?.(x, z)) return 'water';
  const slope = world.slopeAt?.(x, z) ?? 0;
  if (slope > 0.52) return 'stone';
  const biome = world.biomeAt?.(x, z);
  if (biome?.name === 'rocky') return 'stone';
  if (biome?.name === 'shore') return 'sand';
  if ((world.dirtAt?.(x, z) ?? 0) > 0.55) return 'dirt';
  return (world.grassAt?.(x, z) ?? 0) > 0.40 ? 'grass' : 'dirt';
}

/** ray vs sphere; returns the near root or -1 */
function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const ex = ox - cx, ey = oy - cy, ez = oz - cz;
  const b = ex * dx + ey * dy + ez * dz;
  const c = ex * ex + ey * ey + ez * ez - r * r;
  if (c > 0 && b > 0) return -1;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  return t < 0 ? -b + Math.sqrt(disc) : t;
}

/**
 * March `dir` from `origin` and fill `out`.
 *
 * @returns out { hit, t, point, normal, surface, creature }
 */
export function traceShot(world, creatureList, origin, dir, maxDist, out) {
  out.hit = false;
  out.creature = null;
  out.surface = 'air';
  out.t = maxDist;
  out.point.copy(origin).addScaledVector(dir, maxDist);
  out.normal.copy(dir).multiplyScalar(-1);

  // ---- creatures first ---------------------------------------------------
  let bestT = maxDist, best = null;
  if (creatureList) {
    for (let i = 0; i < creatureList.length; i++) {
      const cr = creatureList[i];
      if (!cr || !cr.position) continue;
      const size = cr.def?.size ?? cr.stats?.size ?? 1;
      // a body-sized sphere sitting on the creature's feet position. Generous rather
      // than exact: a shooter that punishes a 5 cm miss on a 0.9 m animal is not fun,
      // and the *point* of shooting one here is to tire it out, not to test the player.
      const cy = cr.position.y + size * 0.52;
      const r = size * 0.62;
      const t = raySphere(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z,
        cr.position.x, cy, cr.position.z, r);
      if (t > 0.35 && t < bestT) { bestT = t; best = cr; }
    }
  }

  // ---- terrain, marched and bisected -------------------------------------
  let terrainT = -1;
  if (world?.heightAt) {
    let prevT = 0.4;
    _v.copy(origin).addScaledVector(dir, prevT);
    let prevAbove = _v.y - world.heightAt(_v.x, _v.z);
    // the ray can start already underground on a steep bank behind the camera
    if (prevAbove < 0) { prevAbove = 0.001; }
    let t = prevT;
    while (t < maxDist) {
      // coarse far away, fine near the shooter — a 0.35 m step at 5 m and a 3 m step
      // at 200 m keeps the whole trace inside ~110 heightAt() calls
      const step = Math.min(3.0, 0.35 + t * 0.022);
      t = Math.min(maxDist, t + step);
      _v.copy(origin).addScaledVector(dir, t);
      const above = _v.y - world.heightAt(_v.x, _v.z);
      if (above <= 0) {
        // bisect the crossing — 8 iterations is ~1 cm over a 3 m step
        let lo = prevT, hi = t;
        for (let i = 0; i < 8; i++) {
          const mid = (lo + hi) * 0.5;
          _v.copy(origin).addScaledVector(dir, mid);
          if (_v.y - world.heightAt(_v.x, _v.z) <= 0) hi = mid; else lo = mid;
        }
        terrainT = hi;
        break;
      }
      prevT = t; prevAbove = above;
      if (t >= maxDist) break;
    }
  }

  // ---- whichever came first ----------------------------------------------
  if (best && (terrainT < 0 || bestT <= terrainT)) {
    out.hit = true;
    out.creature = best;
    out.t = bestT;
    out.surface = 'creature';
    out.point.copy(origin).addScaledVector(dir, bestT);
    const size = best.def?.size ?? 1;
    _oc.set(out.point.x - best.position.x, out.point.y - (best.position.y + size * 0.52), out.point.z - best.position.z);
    if (_oc.lengthSq() < 1e-8) _oc.copy(dir).multiplyScalar(-1);
    out.normal.copy(_oc).normalize();
    return out;
  }

  if (terrainT >= 0) {
    out.hit = true;
    out.t = terrainT;
    out.point.copy(origin).addScaledVector(dir, terrainT);
    const n = world.normalAt?.(out.point.x, out.point.z);
    if (n) out.normal.copy(n); else out.normal.set(0, 1, 0);
    out.surface = classifySurface(world, out.point.x, out.point.z);
    return out;
  }

  return out;
}

export function makeTraceResult() {
  return { hit: false, t: 0, point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0), surface: 'air', creature: null };
}
