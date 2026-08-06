import * as THREE from 'three';

/**
 * Third-person shoulder camera.
 *
 * Geometry is taken straight from reference observation #10 and checked with the
 * lens maths rather than eyeballed:
 *
 *   pivot 1.46 m (upper back), distance 2.30 m, shoulder offset 0.70 m right,
 *   pitch -5 deg, vertical FOV 62 deg on 16:9.
 *
 *   -> camera eye sits at 1.66 m                (brief: 1.6-1.8 m)
 *   -> horizon lands at 42% of frame height     (brief: near vertical centre)
 *   -> the player's head lands at 40% height / 32% width, feet clipped by the
 *      bottom edge                              (brief: lower third, cropped)
 *   -> a creature 4-10 m ahead lands in the middle third
 *
 * On top of that: asymmetric follow lag, terrain collision, sprint FOV kick and a
 * gentle aim bias toward whatever creature the player is closest to.
 *
 * ---------------------------------------------------------------------------
 * THE SHOULDER CAM (added when weapons and spheres arrived)
 *
 * `p.aim` is 0..1 and comes straight off `weapons.aimBlend()` (or the sphere system's
 * own ramp). EVERY aim-driven change is a lerp on that one number, both directions, so
 * entering and leaving aim is the same curve run forwards and backwards and nothing can
 * pop. What it moves:
 *
 *   distance 2.30 -> 1.45 m     the camera comes in over the back
 *   shoulder 0.70 -> 0.42 m     at 1.45 m that is 16 deg off axis, which puts the
 *                               avatar's body centre at ~29% of frame width — the
 *                               classic third-person aim framing. Keeping 0.70 m at
 *                               1.45 m would shove the character off the edge.
 *   pivot    +0.11 m            you look OVER the shoulder, not through it
 *   fov      62 -> 51 deg       (p.aimFov only: a thrown sphere needs to see the
 *                               ground it lands on, so only guns narrow the lens)
 *   lag      x1.6               an aiming camera that lags is an aiming camera that
 *                               lies about where the round is going
 *   creature bias -> 0          the gentle lean toward a nearby creature IS aim assist
 *                               once a gun is up, and it would make the crosshair
 *                               disagree with the shot. It is switched off entirely.
 *
 * The recoil kick is NOT applied here. It is applied in player/index.js postUpdate(),
 * after src/weapons has already read the camera for the frame — see the note there.
 */

const clamp = THREE.MathUtils.clamp;
const damp = (a, b, l, dt) => a + (b - a) * (1 - Math.exp(-l * dt));

export const CAM = {
  pivotY: 1.46,
  dist: 2.30,
  distSprint: 2.95,
  distCrouch: 2.05,
  shoulder: 0.70,
  pitch: -0.0873,        // -5 deg
  fov: 62,
  fovSprint: 68,
  minPitch: -0.62,
  maxPitch: 0.80,
  clearance: 0.42,
  // ---- shoulder-aim pose ----
  aimDist: 1.45,
  aimShoulder: 0.42,
  aimPivot: 0.11,
  aimFov: 51,
};

export function createCameraRig() {
  const pivot = new THREE.Vector3();
  const smoothPivot = new THREE.Vector3();
  const aimPt = new THREE.Vector3();
  const smoothAim = new THREE.Vector3();
  const want = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const right = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);

  let yaw = 0, pitch = CAM.pitch;
  let distUser = 0;              // wheel adjustment, -1..+1 blended into base distance
  let distSm = CAM.dist;
  let collide = 1;               // 0..1 fraction of desired distance currently allowed
  let fovSm = CAM.fov;
  let rollSm = 0;
  let biasSm = 0;
  let framing = 0;               // 0 normal, 1 intimate "interaction" framing
  let aimSm = 0;                 // last aim blend seen, for snapshot()
  let initialised = false;
  let override = null;
  const biasTarget = new THREE.Vector3();

  return {
    get yaw() { return yaw; },
    set yaw(v) { yaw = v; },
    get pitch() { return pitch; },
    get override() { return override; },
    setOverride(o) { override = o; if (!o) initialised = false; },
    setFraming(v) { framing = clamp(v, 0, 1); },
    snap() { initialised = false; },
    look(dx, dy, sens = 0.0025) {
      yaw -= dx * sens;
      pitch = clamp(pitch - dy * sens * 0.86, CAM.minPitch, CAM.maxPitch);
    },
    zoom(w) { distUser = clamp(distUser + w * 0.28, -0.45, 1.9); },

    /**
     * @param p { pos:Vector3, speed, sprintT, crouchT, grounded, turnRate, aim, aimFov }
     *          `aim` 0..1 drives the shoulder pose, `aimFov` 0..1 the lens (guns only).
     * @param focus Vector3|null  a creature of interest to bias the aim toward
     * @param groundAt (x,z)=>y
     */
    update(dt, camera, p, focus, groundAt) {
      if (override) {
        camera.position.set(override.pos[0], override.pos[1], override.pos[2]);
        camera.up.set(0, 1, 0);
        camera.lookAt(override.target[0], override.target[1], override.target[2]);
        const f = override.fov ?? CAM.fov;
        if (Math.abs(camera.fov - f) > 1e-3) { camera.fov = f; camera.updateProjectionMatrix(); }
        fovSm = f;
        return;
      }

      const aim = clamp(p.aim ?? 0, 0, 1);
      const aimFov = clamp(p.aimFov ?? 0, 0, 1);
      aimSm = aim;

      // ---- pivot: upper back, damped harder vertically than horizontally ----
      const bobRun = Math.sin(p.animPhase * Math.PI * 4) * 0.012 * p.sprintT * (1 - aim * 0.7);
      pivot.set(p.pos.x,
        p.pos.y + CAM.pivotY + CAM.aimPivot * aim - p.crouchT * 0.30 + bobRun,
        p.pos.z);
      if (!initialised) { smoothPivot.copy(pivot); }
      // an aiming camera that lags is an aiming camera that lies about where the round goes
      const tighten = 1 + aim * 0.6;
      const lagH = (p.grounded ? 12.5 : 9.0) * tighten;
      const lagV = (p.grounded ? 7.5 : 4.5) * tighten;
      smoothPivot.x = damp(smoothPivot.x, pivot.x, lagH, dt);
      smoothPivot.z = damp(smoothPivot.z, pivot.z, lagH, dt);
      smoothPivot.y = damp(smoothPivot.y, pivot.y, lagV, dt);

      // ---- distance / fov ---------------------------------------------------
      const baseDist = THREE.MathUtils.lerp(
        THREE.MathUtils.lerp(CAM.dist, CAM.distSprint, p.sprintT),
        CAM.distCrouch, p.crouchT) + distUser;
      // The aim pose wins over both the interaction framing and the sprint pull-back:
      // it is the only one of the three the player is actively asking for.
      const targetDist = THREE.MathUtils.lerp(
        THREE.MathUtils.lerp(baseDist, 2.05, framing), CAM.aimDist, aim);
      distSm = damp(distSm, targetDist, 6.5 + aim * 5, dt);

      const targetFov = THREE.MathUtils.lerp(THREE.MathUtils.lerp(
        CAM.fov + p.sprintT * (CAM.fovSprint - CAM.fov) + (p.grounded ? 0 : 1.2),
        57, framing), CAM.aimFov, aimFov);
      fovSm = damp(fovSm, targetFov, 4.5 + aimFov * 5, dt);

      // ---- basis ------------------------------------------------------------
      const cp = Math.cos(pitch), sp = Math.sin(pitch);
      dir.set(-Math.sin(yaw) * cp, sp, -Math.cos(yaw) * cp).normalize();
      right.copy(dir).cross(UP).normalize();

      const shoulder = THREE.MathUtils.lerp(CAM.shoulder * (1 + framing * 0.22), CAM.aimShoulder, aim);
      aimPt.copy(smoothPivot).addScaledVector(right, shoulder);

      // ---- creature aim bias ------------------------------------------------
      // Off entirely once the player is aiming: a camera that leans toward a creature
      // while a gun is up is silent aim assist, and it makes the crosshair a liar.
      let bias = 0;
      if (focus && aim < 0.999) {
        tmp.copy(focus).sub(smoothPivot);
        const d = tmp.length();
        if (d > 1.0 && d < 16) {
          tmp.divideScalar(d);
          const align = tmp.dot(dir);
          if (align > 0.45) {
            bias = clamp((align - 0.45) / 0.4, 0, 1) * clamp((16 - d) / 8, 0, 1) * (1 - aim);
            biasTarget.copy(focus);
          }
        }
      }
      biasSm = damp(biasSm, bias, 3.0, dt);
      if (biasSm > 0.001) {
        tmp.copy(biasTarget).sub(aimPt);
        aimPt.addScaledVector(tmp, biasSm * (0.14 + framing * 0.26));
      }

      if (!initialised) smoothAim.copy(aimPt);
      const aimLag = 1 + aim * 0.9;
      smoothAim.x = damp(smoothAim.x, aimPt.x, 16 * aimLag, dt);
      smoothAim.y = damp(smoothAim.y, aimPt.y, 12 * aimLag, dt);
      smoothAim.z = damp(smoothAim.z, aimPt.z, 16 * aimLag, dt);

      // ---- desired eye, then terrain collision -------------------------------
      want.copy(smoothPivot).addScaledVector(right, shoulder).addScaledVector(dir, -distSm);

      let allowed = 1;
      const steps = 6;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        tmp.lerpVectors(smoothPivot, want, t);
        const g = groundAt(tmp.x, tmp.z) + CAM.clearance;
        if (tmp.y < g) { allowed = Math.max(0.18, (i - 1) / steps); break; }
      }
      // pull in fast, ease back out slowly so the camera never pops
      collide = allowed < collide ? damp(collide, allowed, 26, dt) : damp(collide, allowed, 4.5, dt);
      want.copy(smoothPivot).addScaledVector(right, shoulder).addScaledVector(dir, -distSm * collide);
      const floor = groundAt(want.x, want.z) + CAM.clearance * 0.85;
      if (want.y < floor) want.y = floor;

      if (!initialised) { camera.position.copy(want); initialised = true; }
      else camera.position.lerp(want, 1 - Math.exp(-18 * dt));

      camera.up.set(0, 1, 0);
      camera.lookAt(smoothAim);

      // a whisper of roll when hard-turning; enough to feel, not enough to notice
      // ...and none of it once the gun is up: a rolling frame under a fixed crosshair
      // reads as drift the player cannot correct for.
      rollSm = damp(rollSm, clamp(-(p.turnRate ?? 0) * 0.035, -0.03, 0.03) * (1 - aim), 4, dt);
      if (Math.abs(rollSm) > 1e-4) camera.rotateZ(rollSm);

      if (Math.abs(camera.fov - fovSm) > 0.01) { camera.fov = fovSm; camera.updateProjectionMatrix(); }
    },

    snapshot() {
      return {
        yawDeg: +THREE.MathUtils.radToDeg(yaw).toFixed(1),
        pitchDeg: +THREE.MathUtils.radToDeg(pitch).toFixed(1),
        dist: +distSm.toFixed(2), fov: +fovSm.toFixed(1),
        collide: +collide.toFixed(2), bias: +biasSm.toFixed(2),
        aim: +aimSm.toFixed(3), shoulder: +THREE.MathUtils.lerp(CAM.shoulder, CAM.aimShoulder, aimSm).toFixed(2),
      };
    },
  };
}
