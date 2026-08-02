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
};

export function createCameraRig() {
  const pivot = new THREE.Vector3();
  const smoothPivot = new THREE.Vector3();
  const aim = new THREE.Vector3();
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
     * @param p { pos:Vector3, speed, sprintT, crouchT, grounded, turnRate }
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

      // ---- pivot: upper back, damped harder vertically than horizontally ----
      const bobRun = Math.sin(p.animPhase * Math.PI * 4) * 0.012 * p.sprintT;
      pivot.set(p.pos.x, p.pos.y + CAM.pivotY - p.crouchT * 0.30 + bobRun, p.pos.z);
      if (!initialised) { smoothPivot.copy(pivot); }
      const lagH = p.grounded ? 12.5 : 9.0;
      const lagV = p.grounded ? 7.5 : 4.5;
      smoothPivot.x = damp(smoothPivot.x, pivot.x, lagH, dt);
      smoothPivot.z = damp(smoothPivot.z, pivot.z, lagH, dt);
      smoothPivot.y = damp(smoothPivot.y, pivot.y, lagV, dt);

      // ---- distance / fov ---------------------------------------------------
      const baseDist = THREE.MathUtils.lerp(
        THREE.MathUtils.lerp(CAM.dist, CAM.distSprint, p.sprintT),
        CAM.distCrouch, p.crouchT) + distUser;
      const targetDist = THREE.MathUtils.lerp(baseDist, 2.05, framing);
      distSm = damp(distSm, targetDist, 6.5, dt);

      const targetFov = THREE.MathUtils.lerp(
        CAM.fov + p.sprintT * (CAM.fovSprint - CAM.fov) + (p.grounded ? 0 : 1.2),
        57, framing);
      fovSm = damp(fovSm, targetFov, 4.5, dt);

      // ---- basis ------------------------------------------------------------
      const cp = Math.cos(pitch), sp = Math.sin(pitch);
      dir.set(-Math.sin(yaw) * cp, sp, -Math.cos(yaw) * cp).normalize();
      right.copy(dir).cross(UP).normalize();

      const shoulder = CAM.shoulder * (1 + framing * 0.22);
      aim.copy(smoothPivot).addScaledVector(right, shoulder);

      // ---- creature aim bias ------------------------------------------------
      let bias = 0;
      if (focus) {
        tmp.copy(focus).sub(smoothPivot);
        const d = tmp.length();
        if (d > 1.0 && d < 16) {
          tmp.divideScalar(d);
          const align = tmp.dot(dir);
          if (align > 0.45) {
            bias = clamp((align - 0.45) / 0.4, 0, 1) * clamp((16 - d) / 8, 0, 1);
            biasTarget.copy(focus);
          }
        }
      }
      biasSm = damp(biasSm, bias, 3.0, dt);
      if (biasSm > 0.001) {
        tmp.copy(biasTarget).sub(aim);
        aim.addScaledVector(tmp, biasSm * (0.14 + framing * 0.26));
      }

      if (!initialised) smoothAim.copy(aim);
      smoothAim.x = damp(smoothAim.x, aim.x, 16, dt);
      smoothAim.y = damp(smoothAim.y, aim.y, 12, dt);
      smoothAim.z = damp(smoothAim.z, aim.z, 16, dt);

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
      rollSm = damp(rollSm, clamp(-(p.turnRate ?? 0) * 0.035, -0.03, 0.03), 4, dt);
      if (Math.abs(rollSm) > 1e-4) camera.rotateZ(rollSm);

      if (Math.abs(camera.fov - fovSm) > 0.01) { camera.fov = fovSm; camera.updateProjectionMatrix(); }
    },

    snapshot() {
      return {
        yawDeg: +THREE.MathUtils.radToDeg(yaw).toFixed(1),
        pitchDeg: +THREE.MathUtils.radToDeg(pitch).toFixed(1),
        dist: +distSm.toFixed(2), fov: +fovSm.toFixed(1),
        collide: +collide.toFixed(2), bias: +biasSm.toFixed(2),
      };
    },
  };
}
