import * as THREE from 'three';
import { ORDER } from '../engine/Game.js';

/**
 * PLAYER SYSTEM — owned by the player builder. Owns the avatar, its animation, and the
 * third-person camera. The camera is over half of "does this feel like Palworld":
 * shoulder offset, framing, collision, lag, FOV kick when sprinting.
 *
 * PUBLIC CONTRACT:
 *   position -> THREE.Vector3 (read-only for others; feet position)
 *   velocity -> THREE.Vector3
 *   yaw -> number (radians, facing)
 *   getForward() -> THREE.Vector3 (horizontal, unit)
 *   place(x, z, yawDeg)              teleport + face; used for matched-shot A/B
 *   camera.setOverride({pos,target,fov} | null)   free-fly for establishing shots
 *   state -> 'idle'|'walk'|'run'|'jump'|'fall'|'crouch'|'interact'
 *   root -> THREE.Object3D           so other systems can parent effects
 *
 * STUB: a capsule that slides over the terrain with an orbit camera.
 */
export function createPlayer() {
  let ctx, world;
  const position = new THREE.Vector3(0, 0, 0);
  const velocity = new THREE.Vector3();
  let yaw = 0, pitch = -0.12, camDist = 6.5, grounded = true, state = 'idle';
  let root, override = null;
  const camTarget = new THREE.Vector3();
  const tmp = new THREE.Vector3();

  const camera = {
    setOverride(o) { override = o; },
    get override() { return override; },
  };

  return {
    name: 'player',
    order: ORDER.PLAYER,
    position, velocity, camera,
    get yaw() { return yaw; },
    get state() { return state; },
    get root() { return root; },

    init(c) {
      ctx = c; world = c.get('world');
      root = new THREE.Group();
      const body = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.34, 0.9, 6, 12),
        new THREE.MeshStandardMaterial({ color: 0xdcc9a8, roughness: 0.7 }));
      body.position.y = 0.9;
      body.castShadow = true;
      root.add(body);
      c.scene.add(root);
      const spot = world?.sampleSpawn?.(c.rng.fork(7), { maxSlope: 0.2 }) ?? { x: 0, z: 0 };
      position.set(spot.x, world?.heightAt?.(spot.x, spot.z) ?? 0, spot.z);
    },

    update(dt, c) {
      const input = c.input;
      // look
      yaw -= input.look.dx * 0.0026;
      pitch = THREE.MathUtils.clamp(pitch - input.look.dy * 0.0022, -0.9, 0.75);
      camDist = THREE.MathUtils.clamp(camDist + input.wheel * 0.7, 2.5, 12);

      // move
      const ax = input.moveAxis();
      const sprint = input.down('sprint');
      const speed = sprint ? 8.2 : 4.1;
      const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
      const right = new THREE.Vector3(fwd.z, 0, -fwd.x);
      tmp.set(0, 0, 0).addScaledVector(fwd, ax.y).addScaledVector(right, ax.x);
      const moving = tmp.lengthSq() > 1e-5;
      if (moving) tmp.normalize().multiplyScalar(speed);
      velocity.x = THREE.MathUtils.damp(velocity.x, tmp.x, 12, dt);
      velocity.z = THREE.MathUtils.damp(velocity.z, tmp.z, 12, dt);

      if (grounded && input.justPressed('jump')) { velocity.y = 7.4; grounded = false; }
      velocity.y -= 21 * dt;

      position.addScaledVector(velocity, dt);
      const g = world?.heightAt?.(position.x, position.z) ?? 0;
      if (position.y <= g) { position.y = g; velocity.y = 0; grounded = true; }

      const r = (world?.bounds?.radius ?? 400) - 6;
      const d = Math.hypot(position.x, position.z);
      if (d > r) { position.x *= r / d; position.z *= r / d; }

      state = !grounded ? (velocity.y > 0 ? 'jump' : 'fall')
        : moving ? (sprint ? 'run' : 'walk') : 'idle';

      root.position.copy(position);
      if (moving) {
        const target = Math.atan2(-velocity.x, -velocity.z);
        root.rotation.y = dampAngle(root.rotation.y, target, 10, dt);
      }

      // camera
      const cam = c.camera;
      if (override) {
        cam.position.set(...override.pos);
        cam.lookAt(new THREE.Vector3(...override.target));
        if (override.fov && cam.fov !== override.fov) { cam.fov = override.fov; cam.updateProjectionMatrix(); }
      } else {
        if (cam.fov !== 55) { cam.fov = 55; cam.updateProjectionMatrix(); }
        camTarget.copy(position).add(new THREE.Vector3(0, 1.55, 0));
        const dir = new THREE.Vector3(
          Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
        const want = camTarget.clone().addScaledVector(dir, camDist).addScaledVector(
          new THREE.Vector3(dir.z, 0, -dir.x).normalize(), 0.55);
        const gh = (world?.heightAt?.(want.x, want.z) ?? 0) + 0.6;
        want.y = Math.max(want.y, gh);
        cam.position.lerp(want, 1 - Math.exp(-9 * dt));
        cam.lookAt(camTarget);
      }
    },

    getForward() { return new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)); },

    place(x, z, yawDeg = 0) {
      position.set(x, world?.heightAt?.(x, z) ?? 0, z);
      velocity.set(0, 0, 0);
      yaw = THREE.MathUtils.degToRad(yawDeg);
      root.position.copy(position); root.rotation.y = yaw;
      return { x, z, y: position.y };
    },

    snapshot() {
      return {
        pos: [+position.x.toFixed(2), +position.y.toFixed(2), +position.z.toFixed(2)],
        yawDeg: +THREE.MathUtils.radToDeg(yaw).toFixed(1),
        speed: +Math.hypot(velocity.x, velocity.z).toFixed(2),
        state, grounded,
      };
    },
  };
}

function dampAngle(a, b, lambda, dt) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * (1 - Math.exp(-lambda * dt));
}
