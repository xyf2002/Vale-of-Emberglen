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

/** seconds each one-shot gesture runs for; see the gesture block in update() */
const GESTURE_TIME = { offer: 1.55, pet: 1.55, throw: 0.45 };

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
    hold: 0,          // 0..1 both hands on a held weapon (see holdWeapon)
    gestureW: 0,      // the offer gesture's own weight, so it can outrank the hold
    holdGrip: new THREE.Vector3(),
    holdFore: new THREE.Vector3(),
    holdBore: new THREE.Vector3(0, 0, -1),
    holdSlide: 0,
    holdForeW: 1,     // support hand, weighted apart from the firing hand
    holdSeen: false,
    holdClaimed: false,   // a payload arrived this frame; see holdWeapon()
    pivot: 0,             // 0..1 turning on the spot — see the gait phase block
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

  /**
   * Two-bone IK for an arm, in CHEST space, blended over the FK pose by `w`.
   *
   * The legs are flat nodes the solver can place outright; the arms are a real chain
   * (chest -> shoulder -> elbow -> hand), each link hanging along its parent's -Y, so
   * the solve has to come back as a shoulder ORIENTATION plus one elbow angle rather
   * than as positions.
   *
   * The elbow bends about the shoulder's local +X (that is the axis the FK pose already
   * uses), so the shoulder basis is not free: its +X must be the normal of the plane
   * that contains the upper arm and the forearm, or the hand lands somewhere else
   * entirely and the whole arm twists. Hence the explicit basis rather than a
   * setFromUnitVectors, which picks the minimal-arc roll and leaves the bend plane to
   * chance.
   *
   * `_pole` is where the elbow is pushed: out, down and BACK. A pole pointing forward
   * gives an anatomically inverted elbow that reads instantly as broken.
   */
  function solveArm(a, side, target, w) {
    const l1 = RIG.upperArm, l2 = RIG.foreArm;
    _sh.set(side * RIG.shoulderHalf, RIG.shoulderY, 0);
    _d.subVectors(target, _sh);
    let len = _d.length();
    const maxLen = ARM_REACH * 0.995;
    if (len > maxLen) { _d.multiplyScalar(maxLen / len); len = maxLen; }
    if (len < 0.08) { _d.set(0, -0.08, 0); len = 0.08; }
    _f.copy(_d).divideScalar(len);

    const cosE = clamp((l1 * l1 + l2 * l2 - len * len) / (2 * l1 * l2), -1, 1);
    const bend = Math.PI - Math.acos(cosE);                       // elbow.rotation.x >= 0
    const cosS = clamp((len * len + l1 * l1 - l2 * l2) / (2 * len * l1), -1, 1);
    const swing = Math.acos(cosS);

    _pole.set(side * 0.45, -0.62, 0.62).normalize();
    _axis.crossVectors(_f, _pole);
    if (_axis.lengthSq() < 1e-8) _axis.set(1, 0, 0); else _axis.normalize();
    _upper.copy(_f).applyAxisAngle(_axis, swing);                  // shoulder -> elbow
    _elbowP.copy(_sh).addScaledVector(_upper, l1);
    _fore.subVectors(target, _elbowP);
    if (_fore.lengthSq() < 1e-8) _fore.copy(_upper); else _fore.normalize();

    _ey.copy(_upper).negate();                                     // limb hangs along -Y
    _ex.crossVectors(_upper, _fore);                               // = sin(bend) * +X
    if (_ex.lengthSq() < 1e-8) _ex.crossVectors(_ey, _pole);
    _ex.normalize();
    _ez.crossVectors(_ex, _ey);
    _bas.makeBasis(_ex, _ey, _ez);
    _qa.setFromRotationMatrix(_bas);

    _qb.setFromEuler(a.shoulder.rotation);
    a.shoulder.quaternion.copy(_qb.slerp(_qa, w));
    a.elbow.rotation.set(
      THREE.MathUtils.lerp(a.elbow.rotation.x, bend, w),
      a.elbow.rotation.y * (1 - w),
      a.elbow.rotation.z * (1 - w));
    // wrist: cocked forward onto the grip, thumb rolled inboard
    a.hand.rotation.set(
      THREE.MathUtils.lerp(a.hand.rotation.x, -0.30, w), 0, -side * 0.30 * w);
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
     * Put both hands on a held weapon. Called by src/weapons AFTER it has posed the
     * gun, in the SAME frame — the arms have to solve against this frame's grip, not
     * last frame's, or the hands lag the weapon by 16 ms in exactly the situations
     * (spinning, recoiling) where a player is looking straight at them.
     *
     * That means this runs after update() and overwrites the arm pose it authored;
     * everything above the elbow (chest lean, breathing, gait) survives untouched.
     *
     * @param hold { grip, fore, bore, slide, weight, foreWeight } — grip/fore/bore in
     *             WORLD space; `weight` blends the whole hold over the FK pose and
     *             `foreWeight` the support hand alone. Pass null when nothing is held
     *             and the arms fall back to the locomotion swing over ~0.15 s.
     *
     * The support hand is not pinned: it starts at `fore` and slides forward along the
     * bore as far as the left arm can actually reach, up to `slide`. A rifle's foregrip
     * is ~0.70 m from a squared-up left shoulder and the arm is 0.555 m long, so pinning
     * it there just clamps the IK and leaves the hand hanging in space short of the
     * handguard. Sliding keeps the hand ON the weapon — at the magwell if that is all
     * the reach there is — which is a real grip, and it self-corrects as the aim pose
     * blades the chest and brings the left shoulder forward.
     */
    holdWeapon(dt, hold) {
      // TWO systems call this every frame — src/spheres at ORDER 64 and src/weapons at
      // 66 — and the one with nothing in hand passes null to let the arms go. Without
      // this claim the later caller always wins, so equipping a sphere put it in a hand
      // that the weapon system released 2 ms later, every frame. First payload of the
      // frame owns the arms; a null after it is ignored.
      if (hold) S.holdClaimed = true;
      else if (S.holdClaimed) return;

      // A GESTURE OWNS THE ARMS OUTRIGHT while it plays, and this early return is what
      // makes that true. Weighting the hold by (1 - gestureW) is not enough: the release
      // path still re-poses the arm from the LAST stored grip while `hold` decays, and at
      // 8/s that decay outlives a 0.45 s throw — so the sphere's carry pose kept dragging
      // the hand back to the hip through the entire wind-up and the throw played as a
      // twitch. Measured by eye first, then by the probe: the arm never left the hip.
      if (S.gestureW > 0.02) {
        if (hold) {
          S.holdGrip.copy(hold.grip); S.holdFore.copy(hold.fore);
          S.holdBore.copy(hold.bore).normalize();
          S.holdSlide = Math.max(0, hold.slide ?? 0);
          S.holdForeW = clamp(hold.foreWeight ?? 1, 0, 1);
          S.holdSeen = true;
        }
        S.hold = damp(S.hold, 0, 26, dt);
        return;
      }

      const want = hold ? clamp(hold.weight ?? 1, 0, 1) * (1 - S.gestureW) : 0;
      S.hold = damp(S.hold, want, want > S.hold ? 13 : 8, dt);
      if (S.hold < 1e-3) { S.hold = 0; S.holdSeen = !!hold; return; }
      if (hold) {
        // the caller reuses its scratch vectors, so copy rather than keep the reference
        S.holdGrip.copy(hold.grip);
        S.holdFore.copy(hold.fore);
        S.holdBore.copy(hold.bore).normalize();
        S.holdSlide = Math.max(0, hold.slide ?? 0);
        S.holdForeW = clamp(hold.foreWeight ?? 1, 0, 1);
        S.holdSeen = true;
      } else if (!S.holdSeen) return;

      rig.chest.updateWorldMatrix(true, false);
      _inv.copy(rig.chest.matrixWorld).invert();
      _gripL.copy(S.holdGrip).applyMatrix4(_inv);
      _foreL.copy(S.holdFore).applyMatrix4(_inv);
      _boreL.copy(S.holdFore).add(S.holdBore).applyMatrix4(_inv).sub(_foreL).normalize();

      // how far along the bore the left wrist can go: largest t with
      // |fore + t*bore - shoulderL| <= reach
      const R = ARM_REACH * 0.94;
      _sh.set(-RIG.shoulderHalf, RIG.shoulderY, 0);
      _v.subVectors(_foreL, _sh);
      const pb = _v.dot(_boreL);
      const disc = pb * pb - _v.lengthSq() + R * R;
      const t = clamp(disc > 0 ? -pb + Math.sqrt(disc) : 0, 0, S.holdSlide);
      _handL.copy(_foreL).addScaledVector(_boreL, t);

      solveArm(rig.armR, 1, _gripL, S.hold);
      // the support hand is separately weighted: a one-handed carry leaves the left arm
      // on the gait swing, which is most of what sells "carrying" over "posing"
      const fw = S.hold * S.holdForeW;
      if (fw > 0.02) solveArm(rig.armL, -1, _handL, fw);
      rig.chest.updateMatrixWorld(true);
    },

    /**
     * @param dt        seconds
     * @param p         { speed, sprint, grounded, crouch, velY, bodyYaw, pos, lookY, turnRate }
     * @param groundAt  (x,z) -> height
     */
    update(dt, p, groundAt) {
      S.t += dt;
      S.holdClaimed = false;      // a new frame: whoever calls holdWeapon first owns it
      const speed = p.speed;
      S.speedSm = damp(S.speedSm, speed, 14, dt);

      const walkTop = 3.9;
      const runT = clamp((S.speedSm - walkTop * 0.72) / (6.9 - walkTop * 0.72), 0, 1);
      S.runBlend = damp(S.runBlend, runT, 9, dt);
      S.crouchBlend = damp(S.crouchBlend, p.crouch ? 1 : 0, 12, dt);
      // FLIGHT. `flyW` replaces the airborne pose rather than stacking on it: the air
      // state is a half-second jump tuck (knees up, arms out) and holding that for a
      // minute of hovering reads as a character frozen at frame 8 of a jump. Driving
      // airBlend to zero while flying hands the whole upper body to the block further
      // down, and the stride is muted the same way so the legs stop walking on nothing.
      const flyW = clamp(p.fly ?? 0, 0, 1);
      const flySpeedT = clamp(p.flySpeedT ?? 0, 0, 1);
      const flyClimb = clamp(p.flyClimb ?? 0, -1, 1);
      S.airBlend = damp(S.airBlend, p.grounded ? 0 : (1 - flyW), p.grounded ? 16 : 11, dt);
      S.land = Math.max(0, S.land - dt * 3.4);
      S.breath += dt * (1.1 + S.runBlend * 1.9);

      const moving = S.speedSm > 0.25;
      const locomotion = clamp((S.speedSm - 0.18) / 0.9, 0, 1) * (1 - S.airBlend) * (1 - flyW);

      // ---- gait phase ----------------------------------------------------
      // cycle distance grows with speed so the stride never looks like a shuffle
      const cycleDist = 1.52 + S.runBlend * 1.05 - S.crouchBlend * 0.45;

      /**
       * A PIVOT IS A STEP. Turning on the spot rotates the root, and the foot targets
       * are built in body-local space — so without this the boots simply swivel on the
       * grass like a mannequin on a turntable. The yaw window added in r15 (a rifle in
       * hand drags the shoulders round when the camera gets too far ahead) makes that
       * happen every time a standing player looks behind them, which is exactly when
       * the feet are being looked at.
       *
       * The turn rate is folded into the SAME gait phase the walk uses, so the shuffle
       * that comes out is the walk's own footfall pattern at a low amplitude rather than
       * a second animation to keep in sync. `pivot` then feeds `gait` below, which is
       * what actually lifts the foot clear of the ground.
       */
      const turn = Math.abs(p.turnRate ?? 0);
      S.pivot = damp(S.pivot, clamp((turn - 0.35) / 2.2, 0, 1) * (1 - locomotion), 7, dt);
      const phaseRate = moving
        ? (S.speedSm * dt) / cycleDist
        : S.pivot * dt * 0.85;
      S.phase = (S.phase + phaseRate) % 1;

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
      // THE SIGNS ON EVERY X AND Z ROTATION IN THIS FILE ARE NEGATED FROM r13.
      //
      // The torso and head meshes were authored facing +z while the rig, the stride and
      // the movement basis all face -z (see front() in Avatar.js). Flipping the geometry
      // to match the rig mirrors its x and z axes, so a pitch or roll that used to tip
      // the body one way in the world now tips it the other. Pitch had to flip anyway —
      // the run lean was tilting the character backwards along its direction of travel —
      // and the rolls are negated with it so their world-space motion, and therefore
      // everything the leg IK sees hanging off the pelvis, is bit-for-bit what shipped.
      // Yaw is untouched: a rotation about y means the same thing in both frames.
      rig.hips.rotation.set(0, pelvisYaw, -pelvisRoll);

      // forward lean: acceleration + run + crouch
      const targetLean = 0.045 + S.runBlend * 0.16 + S.crouchBlend * 0.28
        + clamp(p.accelFwd ?? 0, -0.5, 0.5) * 0.12;
      S.lean = damp(S.lean, targetLean, 7, dt);
      S.leanSide = damp(S.leanSide, clamp(-(p.turnRate ?? 0) * 0.16, -0.2, 0.2), 6, dt);

      const chestYaw = -pelvisYaw * 1.35;
      const chestPitch = S.lean + Math.sin(4 * Math.PI * S.phase) * 0.018 * locomotion
        - S.airBlend * 0.10 + S.anticip * 0.22 + S.land * 0.10;
      // chestPitch stays POSITIVE-IS-FORWARD as a quantity; the minus is at the two
      // places it is written into a transform. Forward is -z, so a forward lean is a
      // negative rotation about the chest's +x.
      rig.chest.rotation.set(-chestPitch, chestYaw, -(S.leanSide + sway2 * 0.02));
      rig.chest.position.set(0, RIG.chestY, 0);

      // head: counter-rotate to stabilise, add slow glances when idle
      const glanceT = Math.sin(S.t * 0.31) * Math.sin(S.t * 0.13 + 2.1);
      S.glance = damp(S.glance, glanceT * 0.45 * idle, 2.5, dt);
      const lookPitch = (p.lookPitch ?? 0);
      rig.neck.rotation.set(
        chestPitch * 0.65 - lookPitch * 0.35 + S.airBlend * 0.12,
        -chestYaw * 0.8 + S.glance + (p.lookYaw ?? 0) * 0.45,
        pelvisRoll * 0.3);

      // aiming blades the stance. A right-handed shooter does not stand square to the
      // target: the left shoulder comes forward and the right shoulder goes back. It
      // reads better, and it is also load-bearing for the arm IK — squared up, the
      // support hand cannot reach the handguard at all (see holdWeapon).
      const aim = clamp(p.aim ?? 0, 0, 1);
      if (aim > 0) {
        rig.chest.rotation.y -= 0.38 * aim;
        // x signs flipped with the rest of the file when the torso was turned round to
        // face -z; the yaw blading above is unaffected.
        rig.chest.rotation.x -= 0.05 * aim;
        rig.neck.rotation.y += 0.33 * aim;      // ...but the head keeps looking downrange
        rig.neck.rotation.x += 0.04 * aim;
      }

      // ---- arms ----------------------------------------------------------
      const armAmp = 0.34 + S.runBlend * 0.62;
      const swingR = Math.sin(2 * Math.PI * S.phase) * armAmp * locomotion;
      const swingL = -swingR;
      const elbowBase = 0.22 + S.runBlend * 0.75 + S.crouchBlend * 0.35;
      const spreadBase = 0.11 + S.runBlend * 0.06 + idle * 0.02;

      // airborne: arms come up and out. Positive shoulder.x swings the hanging arm to
      // -z, which is forward — so airborne is +, the pre-jump wind-up (arms back) is -,
      // and the lean compensation (arms trail) stays -. All three were the other way
      // round while the torso faced +z.
      const air = S.airBlend;
      const airArm = 0.55 * air;
      const airSpread = 0.42 * air;

      function poseArm(a, side, swing) {
        a.shoulder.rotation.set(
          swing + airArm - S.anticip * 0.35 - S.lean * 0.35,
          0,
          side * (spreadBase + airSpread) + side * 0.02 * idle);
        a.elbow.rotation.set(
          elbowBase + Math.max(0, swing) * 0.55 + air * 0.55, 0, 0);
        a.hand.rotation.set(0.1, 0, 0);
      }
      poseArm(rig.armR, 1, swingR);
      poseArm(rig.armL, -1, swingL);

      // ---- flight pose (overlay) -------------------------------------------
      // Two poses blended by how fast the traveller is actually moving:
      //
      //   hover  upright, legs hanging and slightly bent, arms a little out from the
      //          body. The jets push from BEHIND AND BELOW the shoulders, so the figure
      //          hangs off them; anything tucked or braced reads as falling instead.
      //   level  pitched into the direction of travel (25 deg at full boost), legs
      //          trailing back and straight, arms swept back along the body.
      //
      // Written as an overlay on top of the poses above rather than as another branch of
      // them: the gesture block below still wants to be able to override an arm, and the
      // weapon hold (holdWeapon) overwrites both arms after update() has returned.
      if (flyW > 0.001) {
        const lean = flySpeedT * 0.44;                  // up to ~25 degrees
        const w = flyW;
        // forward is -z, so a forward lean is a NEGATIVE rotation about x (see the sign
        // note further up this file)
        rig.chest.rotation.x = THREE.MathUtils.lerp(rig.chest.rotation.x, -lean * 0.62 - flyClimb * 0.10, w);
        rig.hips.rotation.x = THREE.MathUtils.lerp(rig.hips.rotation.x, -lean * 0.38, w);
        rig.neck.rotation.x = THREE.MathUtils.lerp(rig.neck.rotation.x, lean * 0.55, w);   // head stays level
        // arms: out in a hover, swept back as the speed comes up
        const armBack = -0.30 - flySpeedT * 0.55;
        const armOut = 0.26 - flySpeedT * 0.12;
        for (const [a, side] of [[rig.armR, 1], [rig.armL, -1]]) {
          a.shoulder.rotation.x = THREE.MathUtils.lerp(a.shoulder.rotation.x, armBack, w);
          a.shoulder.rotation.z = THREE.MathUtils.lerp(a.shoulder.rotation.z, side * armOut, w);
          a.elbow.rotation.x = THREE.MathUtils.lerp(a.elbow.rotation.x, 0.30 - flySpeedT * 0.22, w);
          a.hand.rotation.x = THREE.MathUtils.lerp(a.hand.rotation.x, -0.15, w);
        }
      }

      // ---- one-shot upper-body gestures ------------------------------------
      // Two shapes with different clocks: the offer is a slow, deliberate hold (1.55 s,
      // most of it spent with the berry out where a creature can decide about it), the
      // throw is a whip (0.45 s). Running the throw on the offer's clock was the first
      // attempt and it looked like the traveller was placing the sphere on a shelf.
      const gdur = GESTURE_TIME[S.gestureKind] ?? 1.55;
      if (S.gestureActive) {
        S.gesture += dt / gdur;
        if (S.gesture >= 1) { S.gesture = 1; S.gestureActive = false; }
      } else if (S.gesture > 0) {
        S.gesture = Math.max(0, S.gesture - dt * (S.gestureKind === 'throw' ? 5.5 : 1.6));
      }
      const g = S.gesture;
      const throwing = S.gestureKind === 'throw';
      let gw = 0;
      if (g > 0) {
        gw = throwing
          // a throw is at full authority almost immediately and lets go at the end
          ? (g < 0.10 ? smooth(g / 0.10) : g < 0.82 ? 1 : smooth(1 - (g - 0.82) / 0.18))
          // ramp in 0..0.22, hold to 0.7, ease out to 1
          : (g < 0.22 ? smooth(g / 0.22) : g < 0.7 ? 1 : smooth(1 - (g - 0.7) / 0.3));
      }
      S.gestureW = gw;      // a gesture outranks a held weapon, in holdWeapon()
      rig.berry.visible = gw > 0.05 && S.gestureKind === 'offer';

      /**
       * THE THROW. Cock back over the shoulder, whip through, follow across the body.
       *
       * `RELEASE` is where the hand is open and the sphere leaves — 0.38 of 0.45 s is
       * 0.17 s, which is exactly src/spheres' own wind-up (T.windup), so the ball leaves
       * the hand on the frame the arm reaches full extension. If either number moves the
       * other has to move with it or the sphere spawns out of a hand that is still
       * behind the ear.
       *
       * The elbow leads the shoulder on the way through (it stays flexed until after
       * the shoulder has passed vertical, then extends): that lag is the entire
       * difference between a throw and a salute.
       */
      if (throwing && gw > 0) {
        // Three phases on the gesture's own 0..1, and the middle one is tiny on purpose:
        //   0    -> COCK   the arm goes back and up, elbow folded behind the ear
        //   COCK -> WHIP   0.054 s of arm, passing full forward extension at 0.38
        //   WHIP -> 1      follow-through: the arm falls across the body
        // 0.38 of 0.45 s is 0.17 s, which is src/spheres' T.windup — the ball leaves on
        // the frame the arm is straightest. Move one and the other must move with it.
        const COCK = 0.30, WHIP = 0.42;
        const L = THREE.MathUtils.lerp;
        let shX, shY, shZ, elX, handX, torso;
        if (g < COCK) {
          const k = smooth(g / COCK);
          shX = L(0.15, -1.95, k); elX = L(0.35, 2.05, k);
          shZ = L(0.12, 0.34, k); shY = L(0, -0.34, k);
          handX = L(0.1, -0.30, k); torso = k;              // +1 wound up
        } else if (g < WHIP) {
          const k = smooth((g - COCK) / (WHIP - COCK));
          shX = L(-1.95, 1.55, k); elX = L(2.05, 0.25, k);
          shZ = L(0.34, 0.14, k); shY = L(-0.34, 0.14, k);
          handX = L(-0.30, 0.55, k); torso = 1 - 2 * k;     // whips through to -1
        } else {
          const k = smooth((g - WHIP) / (1 - WHIP));
          shX = L(1.55, 0.45, k); elX = L(0.25, 0.75, k);
          shZ = L(0.14, 0.16, k); shY = L(0.14, 0.05, k);
          handX = L(0.55, 0.15, k); torso = L(-1, 0, k);
        }
        const sh = rig.armR.shoulder.rotation;
        const el = rig.armR.elbow.rotation;
        sh.x = L(sh.x, shX, gw); sh.y = L(sh.y, shY, gw); sh.z = L(sh.z, shZ, gw);
        el.x = L(el.x, elX, gw);
        rig.armR.hand.rotation.set(L(rig.armR.hand.rotation.x, handX, gw), 0, 0);
        // the left arm counterweights: forward while the right is back, and back as the
        // right comes through. Without it the whole body reads as one stiff plank.
        rig.armL.shoulder.rotation.x = L(rig.armL.shoulder.rotation.x, 0.55 * torso, gw);
        rig.armL.elbow.rotation.x = L(rig.armL.elbow.rotation.x, 0.45 + 0.45 * Math.abs(torso), gw);
        // torso winds up and unwinds with the arm; the head stays pointed downrange
        rig.chest.rotation.y += 0.32 * torso * gw;
        rig.chest.rotation.x -= 0.09 * Math.max(0, -torso) * gw;
        rig.neck.rotation.y -= 0.28 * torso * gw;
      } else if (gw > 0) {
        const bobG = Math.sin(g * Math.PI * 4) * 0.04 * (g > 0.25 && g < 0.72 ? 1 : 0);
        // right arm reaches forward, palm up
        const sh = rig.armR.shoulder.rotation;
        const el = rig.armR.elbow.rotation;
        sh.x = THREE.MathUtils.lerp(sh.x, 1.02 + bobG, gw);
        sh.z = THREE.MathUtils.lerp(sh.z, 0.20, gw);
        sh.y = THREE.MathUtils.lerp(sh.y, -0.16, gw);
        el.x = THREE.MathUtils.lerp(el.x, 0.85, gw);
        rig.armR.hand.rotation.x = THREE.MathUtils.lerp(0.1, 0.55, gw);
        // left arm tucks back a little
        rig.armL.shoulder.rotation.x = THREE.MathUtils.lerp(rig.armL.shoulder.rotation.x, -0.18, gw);
        rig.armL.elbow.rotation.x = THREE.MathUtils.lerp(rig.armL.elbow.rotation.x, 0.62, gw);
        // lean in and look down at the offered hand (down is -x now, see the note above)
        rig.chest.rotation.x -= 0.17 * gw;
        rig.neck.rotation.x -= 0.16 * gw;
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
        // A pivot lifts the foot but barely swings it: the boot has to clear the grass
        // to be repositioned, and it has nowhere to travel to, because the body is
        // rotating under it rather than moving across the ground.
        fwd *= Math.max(locomotion, S.pivot * 0.22);
        y *= Math.max(locomotion, S.pivot * 0.65);

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

        // FLIGHT: the feet stop chasing the terrain.
        //
        // The leg targets above are in root space against the ground height under each
        // foot, which is correct for every metre of this game except the ones spent 60 m
        // up: from there the solver is handed a target most of a hundred metres below the
        // hips, clamps at full extension, and both legs point straight down like a
        // dropped puppet's. Under jets they hang from the hips instead — bent in a hover,
        // straightening and trailing as the speed comes up.
        if (flyW > 0.001) {
          const hangY = RIG.hipY - 0.60 - flySpeedT * 0.16 + (side > 0 ? 0.012 : -0.012);
          const hangZ = 0.10 + flySpeedT * 0.30;         // forward is -z, so this trails
          target.set(
            THREE.MathUtils.lerp(target.x, lx * 0.94, flyW),
            THREE.MathUtils.lerp(target.y, hangY, flyW),
            THREE.MathUtils.lerp(target.z, hangZ, flyW));
        }

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

        const flyPitch = 0.55 + flySpeedT * 0.35;        // toes trailing, ballerina-ish
        plan.push({
          i, side, target,
          pitch: THREE.MathUtils.lerp(pitch, flyPitch, flyW),
          roll: slopeRoll * plant * (1 - air) * (1 - flyW),
          plant: plant * (1 - flyW),
        });
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
      // The scarf was removed from the avatar in r14 (the kit went to dark leather and
      // steel and the red no longer belonged), and Avatar.js now exports scarfTail as
      // null. The block is kept behind this guard rather than deleted: it is the only
      // vertex-animated cloth in the build and whatever cloth comes back — a cape, a
      // banner — wants exactly this trail-plus-flutter curve.
      if (!rig.scarfTail) return;
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
