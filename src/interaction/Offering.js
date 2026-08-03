import * as THREE from 'three';

/**
 * OFFERING — the physical half of feeding. Two objects:
 *
 *  1. the berry in your hand. It appears when you ready an offer and is held out ahead
 *     of the player, low and slow, which is what makes "eat from my hand" legible.
 *  2. thrown berries. A real parabolic toss that lands on the ground, glows softly and
 *     waits. A creature that trusts you enough will walk over and take it.
 */
export function createOffering(ctx, { player, world, fx }) {
  const berryGeo = new THREE.SphereGeometry(0.075, 10, 8);
  const berryMat = new THREE.MeshStandardMaterial({ color: 0xd4304f, roughness: 0.38, metalness: 0, emissive: 0x35060f, emissiveIntensity: 0.6 });
  const leafGeo = new THREE.ConeGeometry(0.05, 0.07, 5);
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x5c8a34, roughness: 0.85 });

  // ---- held berry ---------------------------------------------------------
  const hand = new THREE.Group();
  const palm = new THREE.Mesh(
    new THREE.SphereGeometry(0.1, 10, 8),
    new THREE.MeshStandardMaterial({ color: 0xe6cfa8, roughness: 0.75 }));
  palm.scale.set(1.25, 0.5, 1.1);
  hand.add(palm);
  const heldBerry = new THREE.Mesh(berryGeo, berryMat);
  heldBerry.position.y = 0.1;
  heldBerry.castShadow = true;
  hand.add(heldBerry);
  const heldLeaf = new THREE.Mesh(leafGeo, leafMat);
  heldLeaf.position.set(0.02, 0.16, 0);
  heldLeaf.rotation.z = 0.5;
  hand.add(heldLeaf);
  hand.visible = false;
  hand.scale.setScalar(0.001);

  let handMounted = false;
  function mountHand() {
    if (handMounted) return;
    const root = player?.root;
    if (root?.add) { root.add(hand); handMounted = true; }
    else if (ctx.scene) { ctx.scene.add(hand); handMounted = 'world'; }
  }

  let extend = 0;      // 0 hidden .. 1 fully offered
  let want = 0;

  // ---- thrown berries -----------------------------------------------------
  const POOL = 6;
  const food = [];
  for (let i = 0; i < POOL; i++) {
    const g = new THREE.Group();
    const m = new THREE.Mesh(berryGeo, berryMat);
    m.castShadow = true;
    g.add(m);
    const lf = new THREE.Mesh(leafGeo, leafMat);
    lf.position.set(0.01, 0.09, 0);
    lf.rotation.z = 0.6;
    g.add(lf);
    g.visible = false;
    ctx.scene.add(g);
    food.push({
      root: g, mesh: m, position: g.position, vel: new THREE.Vector3(),
      dead: true, landed: false, ttl: 0, t: 0, claimedBy: null, intended: null, spin: 0,
    });
  }

  const tmp = new THREE.Vector3();

  return {
    food,
    get hand() { return hand; },
    get extend() { return extend; },

    /** ready/lower the berry in your hand */
    setOffering(on) { want = on ? 1 : 0; },

    /** world position of the berry you are holding out */
    handPoint(out = new THREE.Vector3()) {
      mountHand();
      if (handMounted === true) hand.getWorldPosition(out);
      else out.copy(hand.position);
      return out;
    },

    /** parabolic toss that lands near `target` */
    toss(from, target) {
      const f = food.find((x) => x.dead);
      if (!f) return null;
      const dx = target.x - from.x, dz = target.z - from.z;
      const dist = Math.hypot(dx, dz);
      const g = 16;
      const tof = THREE.MathUtils.clamp(0.35 + dist * 0.115, 0.4, 1.35);
      f.position.copy(from);
      f.vel.set(dx / tof, (target.y - from.y) / tof + 0.5 * g * tof, dz / tof);
      // A creature needs a good while to finish its last berry before it will take the
      // next one, so a berry left on the ground has to outlast a full digestion cycle —
      // otherwise the player's second offer rots in the grass and reads as a bug.
      f.dead = false; f.landed = false; f.ttl = 70; f.t = 0; f.claimedBy = null; f.intended = null;
      f.spin = 6 + ctx.rng.next() * 4;
      f.root.visible = true;
      f.root.scale.setScalar(1);
      return f;
    },

    kill(f) {
      f.dead = true;
      f.root.visible = false;
      f.claimedBy = null;
      f.intended = null;
    },

    update(dt) {
      mountHand();
      // held berry: eases out in front of the chest, bobs, retracts
      extend += (want - extend) * Math.min(1, dt * 9);
      const vis = extend > 0.02;
      hand.visible = vis;
      if (vis) {
        const e = extend;
        const bob = Math.sin(ctx.elapsed * 3.1) * 0.018 * e;
        if (handMounted === true) {
          hand.position.set(0.24 * e, 1.06 + bob, -0.32 - 0.34 * e);
          hand.rotation.set(-0.25 * e, 0, 0);
        } else {
          const p = player.position;
          const yaw = player.yaw ?? 0;
          hand.position.set(
            p.x + Math.cos(yaw) * 0.24 * e - Math.sin(yaw) * (0.32 + 0.34 * e),
            p.y + 1.06 + bob,
            p.z - Math.sin(yaw) * 0.24 * e - Math.cos(yaw) * (0.32 + 0.34 * e));
        }
        hand.scale.setScalar(0.55 + 0.45 * e);
        // faint warm glow so the offered berry reads at distance
        const gl = fx.glow(0);
        this.handPoint(tmp);
        gl.sp.position.copy(tmp);
        gl.sp.visible = true;
        gl.sp.scale.setScalar(0.75 + Math.sin(ctx.elapsed * 4) * 0.06);
        gl.mat.opacity = 0.34 * e;
        if (e > 0.6 && ctx.rng.next() < dt * 5) fx.trail(tmp, 0xffc98a, 0.045, 0.5);
      } else {
        const gl = fx.glow(0);
        gl.sp.visible = false;
      }

      for (const f of food) {
        if (f.dead) continue;
        f.t += dt;
        f.ttl -= dt;
        if (!f.landed) {
          f.vel.y -= 16 * dt;
          f.position.addScaledVector(f.vel, dt);
          f.root.rotation.x += f.spin * dt;
          f.root.rotation.z += f.spin * 0.6 * dt;
          const gy = (world?.heightAt?.(f.position.x, f.position.z) ?? 0) + 0.075;
          if (f.position.y <= gy) {
            f.position.y = gy;
            f.landed = true;
            f.root.rotation.set(0, ctx.rng.next() * 6.28, 0);
            fx.burst(f.position, { n: 6, color: 0xffd9a0, speed: 1.0, size: 0.055, life: 0.4, up: 0.7, debris: 3, debrisColor: 0x7d6a44 });
            fx.ring(f.position, { r0: 0.15, r1: 0.9, dur: 0.5, color: 0xffd9a0, opacity: 0.5 });
          }
          if (ctx.rng.next() < dt * 30) fx.trail(f.position, 0xff9db2, 0.05, 0.3);
        } else {
          const gy = (world?.heightAt?.(f.position.x, f.position.z) ?? 0) + 0.075;
          f.position.y = gy + Math.abs(Math.sin(f.t * 2.2)) * 0.035;
        }
        if (f.ttl < 3) f.root.scale.setScalar(Math.max(0.001, f.ttl / 3));
        if (f.ttl <= 0) this.kill(f);
      }

      // one shared glow marks the freshest dropped berry
      const gl = fx.glow(1);
      const live = food.find((f) => !f.dead && f.landed);
      if (live) {
        gl.sp.visible = true;
        gl.sp.position.set(live.position.x, live.position.y + 0.06, live.position.z);
        gl.sp.scale.setScalar(0.7 + Math.sin(ctx.elapsed * 3.4) * 0.09);
        gl.mat.opacity = 0.3;
      } else gl.sp.visible = false;
    },
  };
}
