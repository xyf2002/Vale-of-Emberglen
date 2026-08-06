import * as THREE from 'three';
import { RIG } from './Avatar.js';

/**
 * Procedural animation for the traveller.
 *
 * No clips, no skinning: every frame we author a pose from a handful of curves and
 * then solve two-bone IK for the legs against real terrain heights. Foot placement
 * that follows the ground slope is the single cheapest thing that makes a
 * third-person character stop looking like a tech demo.
 *
 * States blend continuously:
 *   idle  -> weight shifted onto one leg, slow sway, breathing, occasional glance
 *   walk/run -> phase-driven stride with pelvis bob/roll, counter-rotating chest
 *   air   -> anticipation crouch, tuck, then a landing absorb that recovers on a spring
 *   crouch, and a one-shot "offer" gesture the interaction system triggers
 */

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const DOWN = new THREE.Vector3(0, -1, 0);
const POLE = new THREE.Vector3(0, 0, -1);   // knees bend toward the character's front
const _tmpTarget = [new THREE.Vector3(), new THREE.Vector3()];
const _hip = [new THREE.Vector3(), new THREE.Vector3()];

// arm IK scratch — holdWeapon() runs every frame and may not allocate
const _sh = new THREE.Vector3();
const _d = new THREE.Vector3();
const _f = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _upper = new THREE.Vector3();
const _elbowP = new THREE.Vector3();
const _fore = new THREE.Vector3();
const _ex = new THREE.Vector3();
const _ey = new THREE.Vector3();
const _ez = new THREE.Vector3();
const _bas = new THREE.Matrix4();
const _inv = new THREE.Matrix4();
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _gripL = new THREE.Vector3();
const _foreL = new THREE.Vector3();
const _boreL = new THREE.Vector3();
const _handL = new THREE.Vector3();

const ARM_REACH = (RIG.upperArm + RIG.foreArm);

const damp = (a, b, l, dt) => a + (b - a) * (1 - Math.exp(-l * dt));
const smooth = (t) => t * t * (3 - 2 * t);
const clamp = THREE.MathUtils.clamp;

export function createAnimator(avatar) {
  const { rig } = avatar;
  const S = {
    phase: 0,
    runBlend: 0,
    crouchBlend: 0,
    airBlend: 0,
    speedSm: 0,
    land: 0,          // landing absorb, decays
    landVel: 0,
    anticip: 0,       // 0..1 pre-jump crouch
    gesture: 0,       // 0..1 progress through the offer animation
    gestureActive: false,
    gestureKind: 'offer',
    lean: 0,
    leanSide: 0,
    glance: 0,
    breath: 0,
    footPlant: [0, 0],
    t: 0,
  };

  // per-leg persistent world foot data for slope sampling
  const footWorld = [new THREE.Vector3(), new THREE.Vector3()];

  /** two-bone IK in root-local space; writes thigh/shin group transforms */
  function solveLeg(nodes, hip, target, l1, l2) {
    _v.subVectors(target, hip);
    let len = _v.length();
    const maxLen = (l1 + l2) * 0.995;
    if (len > maxLen) { _v.multiplyScalar(maxLen / len); len = maxLen; }
    if (len < 1e-4) { _v.set(0, -1e-4, 0); len = 1e-4; }
    const f = _v2.copy(_v).divideScalar(len);

    let cosA = (len * len + l1 * l1 - l2 * l2) / (2 * len * l1);
    const a = Math.acos(clamp(cosA, -1, 1));

    // rotation axis so the knee travels toward POLE
    const axis = new THREE.Vector3().crossVectors(f, POLE);
    if (axis.lengthSq() < 1e-8) axis.set(1, 0, 0); else axis.normalize();

    const thighDir = f.clone().applyAxisAngle(axis, a);
    const knee = hip.clone().addScaledVector(thighDir, l1);
    const shinDir = target.clone().sub(knee).normalize();

    nodes.thigh.position.copy(hip);
    nodes.thigh.quaternion.setFromUnitVectors(DOWN, thighDir);
    nodes.shin.position.copy(knee);
    nodes.shin.quaternion.setFromUnitVectors(DOWN, shinDir);
    return knee;
  }

  return {
    state: S,

    /** external triggers */
    startGesture(kind = 'offer') {
      S.gesture = 0; S.gestureActive = true; S.gestureKind = kind;
    },
    get gesturing() { return S.gestureActive; },
    get gesturePhase() { return S.gesture; },
    notifyLand(impact) { S.land = 1; S.landVel = clamp(impact / 11, 0.25, 1.15); },
    setAnticipation(v) { S.anticip = v; },

    /**
     * @param dt        seconds
     * @param p         { speed, sprint, grounded, crouch, velY, bodyYaw, pos, lookY, turnRate }
     * @param groundAt  (x,z) -> height
     */
    update(dt, p, groundAt) {
      S.t += dt;
      const speed = p.speed;
      S.speedSm = damp(S.speedSm, speed, 14, dt);

      const walkTop = 3.9;
      const runT = clamp((S.speedSm - walkTop * 0.72) / (6.9 - walkTop * 0.72), 0, 1);
      S.runBlend = damp(S.runBlend, runT, 9, dt);
      S.crouchBlend = damp(S.crouchBlend, p.crouch ? 1 : 0, 12, dt);
      S.airBlend = damp(S.airBlend, p.grounded ? 0 : 1, p.grounded ? 16 : 11, dt);
      S.land = Math.max(0, S.land - dt * 3.4);
      S.breath += dt * (1.1 + S.runBlend * 1.9);

      const moving = S.speedSm > 0.25;
      const locomotion = clamp((S.speedSm - 0.18) / 0.9, 0, 1) * (1 - S.airBlend);

      // ---- gait phase ----------------------------------------------------
      // cycle distance grows with speed so the stride never looks like a shuffle
      const cycleDist = 1.52 + S.runBlend * 1.05 - S.crouchBlend * 0.45;
      if (moving) S.phase = (S.phase + (S.speedSm * dt) / cycleDist) % 1;
      else S.phase = (S.phase + dt * 0.0) % 1;

      const strideAmp = cycleDist * 0.30;
      const lift = (0.075 + S.runBlend * 0.14) * (1 - S.crouchBlend * 0.35);

      // ---- torso / pelvis ------------------------------------------------
      const bobAmp = (0.022 + S.runBlend * 0.045) * locomotion;
      const bob = -bobAmp * (0.5 - 0.5 * Math.cos(4 * Math.PI * S.phase + 0.6));
      const breatheY = Math.sin(S.breath * 1.6) * 0.008 * (1 - locomotion);

      // anticipation + landing absorb, on a lightly overshooting spring
      const absorb = -(S.land * S.land) * 0.26 * S.landVel
        + Math.sin(S.land * Math.PI) * 0.03;
      const crouchDrop = -0.30 * S.crouchBlend;
      const anticipDrop = -0.15 * S.anticip;

      // idle weight shift: a real stance is never symmetric (reference note #12)
      const idle = 1 - locomotion;
      const sway = Math.sin(S.t * 0.72) * idle;
      const sway2 = Math.sin(S.t * 0.47 + 1.7) * idle;

      const hipsY = RIG.hipY + bob + breatheY + absorb + crouchDrop + anticipDrop
        - S.airBlend * 0.02;
      const hipsX = sway * 0.022 + Math.sin(2 * Math.PI * S.phase) * 0.012 * locomotion;

      rig.hips.position.set(hipsX, hipsY, -0.012 * S.crouchBlend);
      const pelvisRoll = -Math.sin(2 * Math.PI * S.phase) * (0.055 + S.runBlend * 0.05) * locomotion
        + sway * 0.035;
      const pelvisYaw = Math.sin(2 * Math.PI * S.phase) * (0.06 + S.runBlend * 0.10) * locomotion;
      rig.hips.rotation.set(0, pelvisYaw, pelvisRoll);

      // forward lean: acceleration + run + crouch
      const targetLean = 0.045 + S.runBlend * 0.16 + S.crouchBlend * 0.28
        + clamp(p.accelFwd ?? 0, -0.5, 0.5) * 0.12;
      S.lean = damp(S.lean, targetLean, 7, dt);
      S.leanSide = damp(S.leanSide, clamp(-(p.turnRate ?? 0) * 0.16, -0.2, 0.2), 6, dt);

      const chestYaw = -pelvisYaw * 1.35;
      const chestPitch = S.lean + Math.sin(4 * Math.PI * S.phase) * 0.018 * locomotion
        - S.airBlend * 0.10 + S.anticip * 0.22 + S.land * 0.10;
      rig.chest.rotation.set(chestPitch, chestYaw, S.leanSide + sway2 * 0.02);
      rig.chest.position.set(0, RIG.chestY, 0);

      // head: counter-rotate to stabilise, add slow glances when idle
      const glanceT = Math.sin(S.t * 0.31) * Math.sin(S.t * 0.13 + 2.1);
      S.glance = damp(S.glance, glanceT * 0.45 * idle, 2.5, dt);
      const lookPitch = (p.lookPitch ?? 0);
      rig.neck.rotation.set(
        -chestPitch * 0.65 + lookPitch * 0.35 - S.airBlend * 0.12,
        -chestYaw * 0.8 + S.glance + (p.lookYaw ?? 0) * 0.45,
        -pelvisRoll * 0.3);

      // ---- arms ----------------------------------------------------------
      const armAmp = 0.34 + S.runBlend * 0.62;
      const swingR = Math.sin(2 * Math.PI * S.phase) * armAmp * locomotion;
      const swingL = -swingR;
      const elbowBase = 0.22 + S.runBlend * 0.75 + S.crouchBlend * 0.35;
      const spreadBase = 0.11 + S.runBlend * 0.06 + idle * 0.02;

      // airborne: arms come up and out
      const air = S.airBlend;
      const airArm = -0.55 * air;
      const airSpread = 0.42 * air;

      function poseArm(a, side, swing) {
        a.shoulder.rotation.set(
          swing + airArm + S.anticip * 0.35 - S.lean * 0.35,
          0,
          side * (spreadBase + airSpread) + side * 0.02 * idle);
        a.elbow.rotation.set(
          elbowBase + Math.max(0, swing) * 0.55 + air * 0.55, 0, 0);
        a.hand.rotation.set(0.1, 0, 0);
      }
      poseArm(rig.armR, 1, swingR);
      poseArm(rig.armL, -1, swingL);

      // ---- offer / feed gesture (upper-body overlay) ----------------------
      if (S.gestureActive) {
        S.gesture += dt / 1.55;
        if (S.gesture >= 1) { S.gesture = 1; S.gestureActive = false; }
      } else if (S.gesture > 0) {
        S.gesture = Math.max(0, S.gesture - dt * 1.6);
      }
      const g = S.gesture;
      let gw = 0;
      if (g > 0) {
        // ramp in 0..0.22, hold to 0.7, ease out to 1
        gw = g < 0.22 ? smooth(g / 0.22) : g < 0.7 ? 1 : smooth(1 - (g - 0.7) / 0.3);
      }
      rig.berry.visible = gw > 0.05 && S.gestureKind === 'offer';
      if (gw > 0) {
        const bobG = Math.sin(g * Math.PI * 4) * 0.04 * (g > 0.25 && g < 0.72 ? 1 : 0);
        // right arm reaches forward, palm up
        const sh = rig.armR.shoulder.rotation;
        const el = rig.armR.elbow.rotation;
        sh.x = THREE.MathUtils.lerp(sh.x, -1.02 + bobG, gw);
        sh.z = THREE.MathUtils.lerp(sh.z, 0.20, gw);
        sh.y = THREE.MathUtils.lerp(sh.y, -0.16, gw);
        el.x = THREE.MathUtils.lerp(el.x, 0.85, gw);
        rig.armR.hand.rotation.x = THREE.MathUtils.lerp(0.1, -0.55, gw);
        // left arm tucks back a little
        rig.armL.shoulder.rotation.x = THREE.MathUtils.lerp(rig.armL.shoulder.rotation.x, 0.18, gw);
        rig.armL.elbow.rotation.x = THREE.MathUtils.lerp(rig.armL.elbow.rotation.x, 0.62, gw);
        // lean in and look down at the offered hand
        rig.chest.rotation.x += 0.17 * gw;
        rig.neck.rotation.x += 0.16 * gw;
        rig.neck.rotation.y *= (1 - gw * 0.7);
      }

      // ---- legs: foot targets in world, solved in root-local --------------
      const cosY = Math.cos(p.bodyYaw), sinY = Math.sin(p.bodyYaw);
      const toWorld = (lx, lz, out) => {
        // root.rotation.y = bodyYaw : world = R_y(yaw) * local
        out.set(lx * cosY + lz * sinY, 0, -lx * sinY + lz * cosY);
        return out;
      };

      const plan = [];
      for (let i = 0; i < 2; i++) {
        const side = i === 0 ? 1 : -1;            // 0 = right, 1 = left
        const ph = (S.phase + (i === 0 ? 0 : 0.5)) % 1;

        let fwd, y, plant;
        if (ph < 0.62) {
          const t = ph / 0.62;
          fwd = strideAmp * (1 - 2 * t);
          y = 0;
          plant = 1;
        } else {
          const t = (ph - 0.62) / 0.38;
          const st = smooth(t);
          fwd = strideAmp * (-1 + 2 * st);
          y = Math.sin(Math.PI * t) * lift;
          plant = t < 0.12 ? 1 - t / 0.12 : t > 0.86 ? (t - 0.86) / 0.14 : 0;
        }
        fwd *= locomotion;
        y *= locomotion;

        // idle stance: slight stagger + weight shift, never a symmetric T-pose
        const idleFwd = side > 0 ? 0.055 : -0.035;
        const idleSide = side > 0 ? 0.012 : -0.004;
        fwd += idleFwd * idle;

        // airborne tuck: front leg up and forward, trailing leg back
        const airFwd = (side > 0 ? 0.20 : -0.22) * air;
        const airUp = (side > 0 ? 0.26 : 0.12) * air;

        const lx = side * (RIG.hipHalf + 0.012) + idleSide * idle + sway * 0.006;
        const lz = -(fwd + airFwd) - S.crouchBlend * 0.02;

        toWorld(lx, lz, _v);
        const wx = p.pos.x + _v.x, wz = p.pos.z + _v.z;
        const gy = groundAt(wx, wz);
        footWorld[i].set(wx, gy, wz);

        // root-local target (root sits at p.pos with y = ground under the player).
        // Airborne, the feet follow the body instead of the terrain.
        const targetY = (gy - p.pos.y) * (1 - air) + y + airUp + RIG.ankleY;
        const target = _tmpTarget[i].set(lx, targetY, lz);

        // foot orientation: follow ground slope while planted, toe-down while swinging
        const ahead = toWorld(0, -0.14, _v).clone();
        const hF = groundAt(wx + ahead.x, wz + ahead.z);
        const hB = groundAt(wx - ahead.x, wz - ahead.z);
        const rightV = toWorld(0.10, 0, _v);
        const hR = groundAt(wx + rightV.x, wz + rightV.z);
        const hL = groundAt(wx - rightV.x, wz - rightV.z);
        const slopePitch = clamp(Math.atan2(hF - hB, 0.28), -0.5, 0.5);
        const slopeRoll = clamp(Math.atan2(hL - hR, 0.20), -0.4, 0.4);

        const swingPitch = ph < 0.62
          ? -0.10 * smooth(clamp((ph - 0.42) / 0.2, 0, 1)) * locomotion   // heel-off at toe-off
          : (0.22 - 0.44 * clamp((ph - 0.62) / 0.38, 0, 1)) * locomotion;
        const pitch = slopePitch * plant + swingPitch + air * 0.30 * (side > 0 ? 0.4 : 1.1)
          - S.crouchBlend * 0.05;

        plan.push({ i, side, target, pitch, roll: slopeRoll * plant * (1 - air), plant });
        S.footPlant[i] = plant;
      }

      // if terrain lifts a foot beyond leg reach, drop the pelvis until it fits
      let drop = 0;
      _q.setFromEuler(rig.hips.rotation);
      for (const L of plan) {
        _hip[L.i].set(L.side * RIG.hipHalf, 0, 0).applyQuaternion(_q).add(rig.hips.position);
        const need = _hip[L.i].distanceTo(L.target) - (RIG.thigh + RIG.shin) * 0.985;
        if (need > drop) drop = need;
      }
      if (drop > 0) {
        rig.hips.position.y -= Math.min(drop, 0.30);
        for (const L of plan) {
          _hip[L.i].set(L.side * RIG.hipHalf, 0, 0).applyQuaternion(_q).add(rig.hips.position);
        }
      }

      for (const L of plan) {
        const legNodes = L.i === 0 ? rig.legR : rig.legL;
        solveLeg(legNodes, _hip[L.i], L.target, RIG.thigh, RIG.shin);
        legNodes.foot.position.copy(L.target);
        legNodes.foot.rotation.set(L.pitch, L.side * 0.075 * (0.4 + idle * 0.8), L.roll);
      }

      // ---- scarf: trails with speed, flutters always ----------------------
      const tail = rig.scarfTail.geometry.attributes.position;
      const base = rig.scarfBase;
      const trail = clamp(S.speedSm * 0.085, 0, 0.62) + air * 0.15;
      for (let i = 0; i < tail.count; i++) {
        const bx = base[i * 3], by = base[i * 3 + 1], bz = base[i * 3 + 2];
        const t = clamp(-by / 0.40, 0, 1);
        const flut = Math.sin(S.t * 5.2 - t * 6.0) * (0.014 + trail * 0.05) * t;
        const side = Math.sin(S.t * 3.1 - t * 4.0) * 0.02 * t;
        tail.setXYZ(i,
          bx + side + (p.turnRate ?? 0) * 0.10 * t,
          by * (1 - trail * 0.55) + flut * 0.35,
          bz - trail * 0.42 * Math.pow(t, 1.3) + flut);
      }
      tail.needsUpdate = true;
      rig.scarfTail.geometry.computeVertexNormals();
    },
  };
}
