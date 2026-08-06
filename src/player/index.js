import * as THREE from 'three';
import { ORDER } from '../engine/Game.js';
import { buildAvatar, RIG } from './Avatar.js';
import { createAnimator } from './Animator.js';
import { createCameraRig, CAM } from './CameraRig.js';
import { createGrounding } from './Grounding.js';

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
 * ADDED (safe to use, additive only):
 *   bodyYaw -> number                where the avatar is actually facing
 *   eyePosition -> THREE.Vector3     head position, for aiming / dialogue
 *   handPosition(out?) -> Vector3    right hand in world space (attach props here)
 *   playGesture(kind)                'offer' | 'pet' — one-shot upper-body animation
 *   grounded, sprintAmount, crouchAmount
 *   aimAmount -> 0..1                the shoulder-cam blend, for anyone who wants it
 *
 * ---------------------------------------------------------------------------
 * AIMING (added when src/weapons and src/spheres arrived)
 *
 * Three separate things come off ONE number so they cannot disagree:
 *
 *   aimT = max(weapons.aimBlend(), sphereAim)
 *
 * `weapons.aimBlend()` is already an asymmetric ramp (0.2 s in, 0.45 s out) owned by the
 * weapon system. The sphere system only exposes a boolean `isAiming()`, so its ramp is
 * built here to the same asymmetric shape rather than snapping.
 *
 *   1. the camera goes over the shoulder      (CameraRig, p.aim / p.aimFov)
 *   2. the body turns to face the CAMERA rather than the direction of travel, so
 *      strafing round a creature keeps the muzzle on it
 *   3. the walk slows by `weapons.moveScale()` (~0.6)
 *
 * RECOIL is applied in postUpdate(), NOT in update(). src/weapons runs at ORDER 66 —
 * after this system — and derives the direction of the ROUND from the camera basis plus
 * its own recoil offset. If the kick were folded into the camera during update(), the
 * weapon would read an already-kicked camera and add the offset a second time, so every
 * burst would walk twice as fast as the spring says. postUpdate() runs after every
 * system's update() and before render(), so the picture kicks and the ballistics do not
 * double-count. The value is used raw — it is already integrated by the weapon's own
 * spring and re-integrating it here would ring.
 */

const clamp = THREE.MathUtils.clamp;
const damp = (a, b, l, dt) => a + (b - a) * (1 - Math.exp(-l * dt));

const MOVE = {
  walk: 3.9,
  sprint: 6.9,
  crouch: 1.85,
  accel: 32,
  reverseBoost: 1.7,
  decel: 26,
  airAccel: 12,
  gravity: 23.0,
  fallGravity: 31.0,
  jumpVel: 7.5,
  jumpCut: 0.42,
  coyote: 0.12,
  buffer: 0.16,
  anticipation: 0.055,
  stepSnap: 0.45,
  slideSlope: 0.66,
};

export function createPlayer() {
  let ctx, world, avatar, anim, sky, weapons, spheres;
  const position = new THREE.Vector3(0, 0, 0);
  const velocity = new THREE.Vector3();
  const cam = createCameraRig();

  let yaw = 0;              // aim / camera yaw (the public `yaw`)
  let bodyYaw = 0;          // where the avatar faces
  let grounded = true, wasGrounded = true, state = 'idle';
  let sprintT = 0, crouchT = 0, turnRate = 0, accelFwd = 0;
  let coyote = 0, buffer = 0, anticipT = -1;
  let framingT = 0;
  let aimT = 0;             // the one blend everything aim-related reads
  let gunAimT = 0;          // weapons only — the lens narrows for a scope, not a throw
  let sphereAimT = 0;       // our own ramp over the sphere system's boolean
  let root, contact;
  const UP = new THREE.Vector3(0, 1, 0);
  let focusPos = null;
  const focusVec = new THREE.Vector3();

  const fwd = new THREE.Vector3();
  const right = new THREE.Vector3();
  const wish = new THREE.Vector3();
  const hv = new THREE.Vector3();
  const dv = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const rimColor = new THREE.Color();

  const groundAt = (x, z) => world?.heightAt?.(x, z) ?? 0;

  const camera = {
    setOverride(o) { cam.setOverride(o); },
    get override() { return cam.override; },
    get yaw() { return cam.yaw; },
    get pitch() { return cam.pitch; },
    snap() { cam.snap(); },
    rig: cam,
  };

  const api = {
    name: 'player',
    order: ORDER.PLAYER,
    position, velocity, camera,
    get yaw() { return yaw; },
    get bodyYaw() { return bodyYaw; },
    get state() { return state; },
    get root() { return root; },
    get grounded() { return grounded; },
    get sprintAmount() { return sprintT; },
    get crouchAmount() { return crouchT; },
    get aimAmount() { return aimT; },
    get eyePosition() {
      const p = new THREE.Vector3();
      if (avatar) avatar.rig.head.getWorldPosition(p);
      else p.copy(position).setY(position.y + 1.6);
      return p;
    },
    handPosition(out = new THREE.Vector3()) {
      if (avatar) avatar.rig.armR.hand.getWorldPosition(out);
      else out.copy(position);
      return out;
    },
    playGesture(kind = 'offer') {
      if (!anim) return;
      anim.startGesture(kind);
      framingT = 2.6;
      faceNearestCreature();
    },

    init(c) {
      ctx = c; world = c.get('world');
      avatar = buildAvatar(c.rng.fork(31));
      anim = createAnimator(avatar);
      root = avatar.root;
      c.scene.add(root);

      contact = createGrounding({ footprint: 0.46 });
      c.scene.add(contact);

      const spot = world?.sampleSpawn?.(c.rng.fork(7), { maxSlope: 0.18 }) ?? { x: 0, z: 0 };
      position.set(spot.x, groundAt(spot.x, spot.z), spot.z);
      root.position.copy(position);
      cam.snap();

      c.bus.on('creature:fed', () => { if (!anim.gesturing) api.playGesture('offer'); });
      c.bus.on('creature:tamed', () => { framingT = Math.max(framingT, 2.0); });
    },

    update(dt, c) {
      const input = c.input;
      sky = sky ?? c.get('sky');
      weapons = weapons ?? c.get('weapons');
      spheres = spheres ?? c.get('spheres');

      // ---------------------------------------------------------------- aim
      // The weapon system owns its own asymmetric ramp; the sphere system only says
      // yes/no, so give it the same shape here — a wind-up that snaps in and eases out.
      gunAimT = clamp(weapons?.aimBlend?.() ?? 0, 0, 1);
      const wantSphereAim = !!spheres?.isAiming?.();
      sphereAimT = damp(sphereAimT, wantSphereAim ? 1 : 0, wantSphereAim ? 9 : 4.5, dt);
      if (sphereAimT < 1e-4) sphereAimT = 0;
      aimT = Math.max(gunAimT, sphereAimT);

      // ---------------------------------------------------------------- look
      cam.look(input.look.dx, input.look.dy);
      cam.zoom(input.wheel);
      yaw = cam.yaw;

      // ------------------------------------------------------------- intent
      const ax = input.moveAxis();
      const rawMove = Math.hypot(ax.x, ax.y) > 0.02;
      const crouching = input.down('crouch');
      const wantSprint = input.down('sprint') && ax.y > 0.25 && !crouching;

      // sprint spools up — a sprint with weight does not arrive instantly
      sprintT = damp(sprintT, wantSprint ? 1 : 0, wantSprint ? 3.6 : 7.5, dt);
      crouchT = damp(crouchT, crouching && grounded ? 1 : 0, 11, dt);

      fwd.set(-Math.sin(yaw), 0, -Math.cos(yaw));
      right.set(fwd.z, 0, -fwd.x);
      wish.set(0, 0, 0).addScaledVector(fwd, ax.y).addScaledVector(right, ax.x);
      if (rawMove) wish.normalize();

      let maxSpeed = THREE.MathUtils.lerp(MOVE.walk, MOVE.sprint, sprintT);
      maxSpeed = THREE.MathUtils.lerp(maxSpeed, MOVE.crouch, crouchT);
      if (anim.gesturing) maxSpeed *= 0.35;
      // the weapon system's own number, so aiming costs exactly what it says it costs
      maxSpeed *= clamp(weapons?.moveScale?.() ?? 1, 0.2, 1);
      // a wind-up with a sphere in hand is not a sprint either
      maxSpeed *= THREE.MathUtils.lerp(1, 0.72, sphereAimT);

      // uphill costs speed, downhill does not give it back
      if (rawMove && grounded) {
        const g0 = groundAt(position.x, position.z);
        const g1 = groundAt(position.x + wish.x * 0.7, position.z + wish.z * 0.7);
        const slope = (g1 - g0) / 0.7;
        maxSpeed *= clamp(1 - Math.max(0, slope) * 0.62, 0.40, 1);
      }

      // ------------------------------------------------------- acceleration
      hv.set(velocity.x, 0, velocity.z);
      tmp.copy(wish).multiplyScalar(rawMove ? maxSpeed : 0);
      dv.subVectors(tmp, hv);
      let rate;
      if (!grounded) rate = MOVE.airAccel;
      else if (rawMove) {
        const align = hv.lengthSq() > 0.01 ? wish.dot(hv.clone().normalize()) : 1;
        rate = MOVE.accel * (align < 0 ? MOVE.reverseBoost : 1);
      } else rate = MOVE.decel;
      const step = rate * dt;
      const dvLen = dv.length();
      if (dvLen <= step) hv.copy(tmp);
      else hv.addScaledVector(dv.divideScalar(dvLen), step);
      if (grounded && !rawMove) hv.multiplyScalar(Math.exp(-5.0 * dt));

      const prevSpeed = Math.hypot(velocity.x, velocity.z);
      velocity.x = hv.x; velocity.z = hv.z;
      const curSpeed = Math.hypot(velocity.x, velocity.z);
      accelFwd = damp(accelFwd, clamp((curSpeed - prevSpeed) / Math.max(dt, 1e-4) / 22, -1, 1), 8, dt);

      // ------------------------------------------------------------- jumping
      if (input.justPressed('jump')) buffer = MOVE.buffer;
      buffer = Math.max(0, buffer - dt);
      coyote = grounded ? MOVE.coyote : Math.max(0, coyote - dt);

      if (anticipT >= 0) {
        anticipT += dt;
        anim.setAnticipation(clamp(anticipT / MOVE.anticipation, 0, 1));
        if (anticipT >= MOVE.anticipation) {
          velocity.y = MOVE.jumpVel * (1 - crouchT * 0.25);
          grounded = false; coyote = 0; buffer = 0; anticipT = -1;
          anim.setAnticipation(0);
          c.bus.emit('player:jump', { pos: position.clone() });
        }
      } else if (buffer > 0 && coyote > 0) {
        anticipT = 0; buffer = 0;
      }

      if (!grounded && velocity.y > 0 && input.justReleased('jump')) velocity.y *= MOVE.jumpCut;
      velocity.y -= (velocity.y > 0 ? MOVE.gravity : MOVE.fallGravity) * dt;
      velocity.y = Math.max(velocity.y, -38);

      // -------------------------------------------------- integrate + ground
      wasGrounded = grounded;
      position.addScaledVector(velocity, dt);

      const g = groundAt(position.x, position.z);
      if (velocity.y <= 0) {
        if (position.y <= g) {
          const impact = -velocity.y;
          if (!wasGrounded && impact > 2.2) {
            anim.notifyLand(impact);
            c.bus.emit('player:land', { pos: position.clone(), impact: +impact.toFixed(2) });
          }
          position.y = g; velocity.y = 0; grounded = true;
        } else if (wasGrounded && position.y - g < MOVE.stepSnap) {
          position.y = g; velocity.y = 0; grounded = true;   // walk down slopes, don't hop
        } else grounded = false;
      } else grounded = false;

      // steep ground sheds you downhill
      if (grounded && world?.normalAt) {
        const n = world.normalAt(position.x, position.z);
        const slope = 1 - Math.max(0, n.y);
        if (slope > MOVE.slideSlope) {
          const push = (slope - MOVE.slideSlope) * 34 * dt;
          velocity.x += n.x * push; velocity.z += n.z * push;
        }
      }

      const r = (world?.bounds?.radius ?? 400) - 8;
      const d = Math.hypot(position.x, position.z);
      if (d > r) { position.x *= r / d; position.z *= r / d; }

      // -------------------------------------------------------------- verbs
      if (input.justPressed('offer')) api.playGesture('offer');
      else if (input.justPressed('interact')) api.playGesture('pet');

      // --------------------------------------------------------- body facing
      const planar = Math.hypot(velocity.x, velocity.z);
      const prevBodyYaw = bodyYaw;
      if (aimT > 0.02 && !anim.gesturing) {
        // AIMING: face where the camera looks, not where you are going. Blended off the
        // same 0..1 as the camera, so a player who strafes round a creature while easing
        // out of aim watches the body rotate back into the direction of travel rather
        // than snap. `yaw` IS the camera yaw (set above from cam.yaw).
        const moveTarget = planar > 0.55 ? Math.atan2(-velocity.x, -velocity.z) : bodyYaw;
        const target = moveTarget + angleDelta(moveTarget, yaw) * aimT;
        bodyYaw = dampAngle(bodyYaw, target, 10 + aimT * 8, dt);
      } else if (planar > 0.55 && !anim.gesturing) {
        const target = Math.atan2(-velocity.x, -velocity.z);
        bodyYaw = dampAngle(bodyYaw, target, 13 - sprintT * 3.5, dt);
      } else if (anim.gesturing && focusPos) {
        const target = Math.atan2(-(focusPos.x - position.x), -(focusPos.z - position.z));
        bodyYaw = dampAngle(bodyYaw, target, 8, dt);
      }
      turnRate = damp(turnRate, angleDelta(prevBodyYaw, bodyYaw) / Math.max(dt, 1e-4), 10, dt);

      // ---------------------------------------------------------------- state
      state = anim.gesturing ? 'interact'
        : !grounded ? (velocity.y > 0.2 ? 'jump' : 'fall')
          : crouchT > 0.5 ? 'crouch'
            : planar > 0.4 ? (sprintT > 0.45 ? 'run' : 'walk')
              : 'idle';

      // ---------------------------------------------------------------- pose
      root.position.copy(position);
      root.rotation.y = bodyYaw;
      anim.update(dt, {
        speed: planar, grounded, crouch: crouching && grounded,
        velY: velocity.y, bodyYaw, pos: position, turnRate,
        accelFwd, lookPitch: cam.pitch * 0.5, lookYaw: 0,
      }, groundAt);

      // --------------------------------------------------- contact occlusion
      // A stack of multiply slabs through the grass canopy, not a decal on the soil.
      // See src/player/Grounding.js for the measurement that forced that shape.
      const cg = groundAt(position.x, position.z);
      const airGap = clamp((position.y - cg) / 1.4, 0, 1);
      contact.place(position.x, position.z, cg, airGap, crouchT,
        world?.normalAt ? world.normalAt(position.x, position.z) : null);

      // ----------------------------------------------------------- rim light
      if (sky?.getSunColor) {
        const sd = sky.getSunDirection?.() ?? { y: 0.7 };
        const day = clamp(sd.y ?? 0.7, 0, 1);
        rimColor.copy(sky.getSunColor()).lerp(new THREE.Color(0.75, 0.85, 1.0), 0.35);
        avatar.setRim(rimColor, 0.10 + day * 0.16);
      }

      // -------------------------------------------------------------- camera
      framingT = Math.max(0, framingT - dt);
      // the intimate interaction framing has no business fighting a raised weapon
      cam.setFraming(clamp(framingT / 0.6, 0, 1) * 0.9 * (1 - aimT));

      focusPos = pickFocus(c);
      cam.update(dt, c.camera, {
        pos: position, speed: planar, sprintT, crouchT: crouchT,
        grounded, turnRate, animPhase: anim.state.phase,
        aim: aimT, aimFov: gunAimT,
      }, focusPos, groundAt);
    },

    /**
     * The recoil kick. See the note at the top of the file for why this lives in
     * postUpdate and not in update: src/weapons already folds the same offset into the
     * direction of the round during its own update, so kicking the camera any earlier
     * would apply it twice.
     *
     * It is added, never integrated. `weapons.recoil()` is the output of two springs and
     * a leaky residual that the weapon system steps itself; wrapping another spring
     * around it here would put a second pole in the loop and make a burst ring.
     */
    postUpdate(dt, c) {
      const r = (weapons ?? c.get('weapons'))?.recoil?.();
      if (!r) return;
      const p = r.pitch || 0, y = r.yaw || 0;
      if (Math.abs(p) < 1e-5 && Math.abs(y) < 1e-5) return;
      const camera = c.camera;
      camera.rotateX(p);                       // muzzle rise: the frame lifts
      camera.rotateOnWorldAxis(UP, y);         // ...and walks sideways, about world up,
      camera.updateMatrixWorld();              // so the kick never rolls the horizon
    },

    getForward() { return new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)); },

    place(x, z, yawDeg = 0) {
      const y = groundAt(x, z);
      position.set(x, y, z);
      velocity.set(0, 0, 0);
      yaw = THREE.MathUtils.degToRad(yawDeg);
      bodyYaw = yaw;
      cam.yaw = yaw;
      grounded = true; wasGrounded = true; sprintT = 0; crouchT = 0;
      turnRate = 0; accelFwd = 0; anticipT = -1; buffer = 0; coyote = MOVE.coyote;
      framingT = 0; aimT = 0; gunAimT = 0; sphereAimT = 0;
      if (root) { root.position.copy(position); root.rotation.y = bodyYaw; }
      cam.snap();
      return { x, z, y };
    },

    snapshot() {
      return {
        pos: [+position.x.toFixed(2), +position.y.toFixed(2), +position.z.toFixed(2)],
        yawDeg: +THREE.MathUtils.radToDeg(yaw).toFixed(1),
        bodyYawDeg: +THREE.MathUtils.radToDeg(bodyYaw).toFixed(1),
        speed: +Math.hypot(velocity.x, velocity.z).toFixed(2),
        state, grounded,
        sprint: +sprintT.toFixed(2),
        aim: +aimT.toFixed(3),
        gesture: +(anim?.gesturePhase ?? 0).toFixed(2),
        cam: cam.snapshot(),
      };
    },
  };

  /** the creature the camera should lean toward: interaction focus first, else nearest */
  function pickFocus(c) {
    const inter = c.get('interaction');
    if (inter?.focus?.position) return focusVec.copy(inter.focus.position).setY(inter.focus.position.y + 0.45);
    const creatures = c.get('creatures');
    if (!creatures?.nearest) return null;
    const near = creatures.nearest(position, 15);
    if (!near) return null;
    return focusVec.copy(near.position).setY(near.position.y + 0.5);
  }

  function faceNearestCreature() {
    const creatures = ctx?.get?.('creatures');
    const near = creatures?.nearest?.(position, 9);
    if (near) focusPos = focusVec.copy(near.position);
  }

  return api;
}

function angleDelta(a, b) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function dampAngle(a, b, lambda, dt) {
  return a + angleDelta(a, b) * (1 - Math.exp(-lambda * dt));
}
