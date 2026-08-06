import * as THREE from 'three';

/**
 * THE ARC IS THE CONTRACT.
 *
 * The preview the player aims with and the path the sphere actually flies come out of
 * exactly one function, `solveThrow`, and are integrated by exactly one stepper. A
 * decorative preview curve that is 10% off the real trajectory is worse than no preview
 * at all: it teaches the player a lie and then punishes them for believing it.
 *
 * The solve is "hit this point": given a launch origin and a target, pick a horizontal
 * speed from the range (short lobs are slow and loopy, long throws flatten out) and
 * then derive the vertical component that lands the sphere exactly on the target. This
 * is preferable to a fixed launch angle because a fixed angle means the aim marker and
 * the impact point disagree at every distance except one.
 */

export const GRAVITY = 19.5;
/** below this the arc is a lob you cannot really aim, so treat it as a minimum reach */
const MIN_REACH = 1.2;

/**
 * Velocity that carries `origin` to `target` under GRAVITY. Writes into `out`,
 * returns the flight time in seconds.
 */
export function solveThrow(origin, target, out) {
  const dx = target.x - origin.x;
  const dz = target.z - origin.z;
  const h = target.y - origin.y;
  const d = Math.hypot(dx, dz);
  const reach = Math.max(MIN_REACH, d);
  const vH = Math.min(25, Math.max(9, reach * 1.55));
  const T = reach / vH;
  out.set(dx / T, (h + 0.5 * GRAVITY * T * T) / T, dz / T);
  return T;
}

/** one integration step, shared by the preview and the live projectile */
export function stepBallistic(pos, vel, dt) {
  vel.y -= GRAVITY * dt;
  pos.x += vel.x * dt;
  pos.y += vel.y * dt;
  pos.z += vel.z * dt;
}

const _p = new THREE.Vector3();
const _v = new THREE.Vector3();

/**
 * Walk the camera ray into the terrain and return where it meets the ground.
 * Marches coarsely then bisects — the heightfield is smooth enough that this is exact
 * to a couple of centimetres and costs ~70 height samples once per frame while aiming.
 */
export function terrainRay(origin, dir, heightAt, out, maxDist = 46) {
  const STEP = 0.6;
  let tPrev = 0;
  let prevAbove = origin.y - heightAt(origin.x, origin.z);
  for (let t = STEP; t <= maxDist; t += STEP) {
    const x = origin.x + dir.x * t;
    const y = origin.y + dir.y * t;
    const z = origin.z + dir.z * t;
    const above = y - heightAt(x, z);
    if (above <= 0 && prevAbove > 0) {
      let a = tPrev, b = t;
      for (let i = 0; i < 8; i++) {
        const m = (a + b) * 0.5;
        const mx = origin.x + dir.x * m, my = origin.y + dir.y * m, mz = origin.z + dir.z * m;
        if (my - heightAt(mx, mz) > 0) a = m; else b = m;
      }
      out.set(origin.x + dir.x * b, origin.y + dir.y * b, origin.z + dir.z * b);
      out.y = heightAt(out.x, out.z);
      return true;
    }
    prevAbove = above;
    tPrev = t;
  }
  // aiming at the sky: put the marker at arm's-length range on whatever ground is there
  const t = maxDist * 0.55;
  out.set(origin.x + dir.x * t, 0, origin.z + dir.z * t);
  out.y = heightAt(out.x, out.z);
  return false;
}

/**
 * Trace the real flight path into a preallocated Vector3 array. Stops at the ground or
 * when the arc passes the aim point. Returns how many points were written.
 */
export function tracePath(origin, vel, heightAt, points, stopAt = null) {
  const dt = 1 / 45;
  _p.copy(origin);
  _v.copy(vel);
  let n = 0;
  const stopSq = stopAt ? 0.16 : 0;
  for (let i = 0; i < points.length * 2 && n < points.length; i++) {
    stepBallistic(_p, _v, dt);
    if (i % 2 === 0) points[n++].copy(_p);
    if (_p.y <= heightAt(_p.x, _p.z)) {
      if (n > 0) points[n - 1].copy(_p);
      break;
    }
    if (stopAt && _v.y < 0 && _p.distanceToSquared(stopAt) < stopSq) {
      if (n < points.length) points[n++].copy(_p);
      break;
    }
  }
  return n;
}
