import * as THREE from 'three';
import { ORDER } from '../engine/Game.js';
import { createSphereFactory, SHELL_R } from './Model.js';
import { createFx } from './Fx.js';
import { solveThrow, stepBallistic, terrainRay, tracePath } from './Ballistics.js';
import { catchChance, rollShakes, readFactors, CATCH } from './Catch.js';

/**
 * BOND SPHERES — throw-to-befriend.
 *
 * The other half of the taming fantasy. Berries are the slow, safe, certain path; the
 * sphere is the fast, loud, uncertain one — and crucially it is not a SEPARATE path. Its
 * odds are read straight off the trust the berries bought (see Catch.js), so feeding is
 * not made obsolete by the sphere, it is what makes the sphere work. Throw at something
 * wild and it will almost certainly burst out, angrier and warier than before. Throw at
 * something you fed twice and it is all but yours.
 *
 * Five beats, in order, each with its own bus event so the audio and UI layers can hang
 * off them:
 *
 *   AIM       hold `aim`: a dotted arc of the ACTUAL trajectory, a landing ring, and —
 *             under a targeted creature — a ground ring whose colour is the odds.
 *   THROW     a wind-up gesture, then a real ballistic launch from the hand with spin.
 *             `sphere:thrown`
 *   CONTACT   the shell hinges open, a beam takes hold, motes spiral in, the creature is
 *             drawn down to a point and the shell slams. `sphere:hit`
 *   WOBBLE    it drops, settles, and rocks 1-3 times, harder and faster each time.
 *             `sphere:shake` per wobble
 *   RESOLVE   a click and a steady glow, then the companion steps out — or it bursts
 *             open and the creature is loose and spooked. `sphere:caught` / `sphere:escaped`
 *
 * PUBLIC CONTRACT (peers reach this with `ctx.get('spheres')`)
 *   count()        -> spheres remaining
 *   inFlight()     -> how many are currently airborne
 *   aimPoint()     -> {x,y,z} | null — where the current arc would land
 *   isAiming()     -> boolean
 *   aimTarget()    -> { creature, chance, factors } | null   (additive; for the HUD)
 *
 * BUS EVENTS
 *   sphere:thrown   { from, to, target, chance }
 *   sphere:hit      { creature, chance }
 *   sphere:shake    { creature, shake, of }      one per wobble
 *   sphere:caught   { creature, chance }
 *   sphere:escaped  { creature, atShake, chance }
 *
 * DETERMINISM. Three independent forked streams: one for the catch roll, one for
 * particles, one for spin. They are separate on purpose — if the particle count fed off
 * the same stream as the roll, adding one spark to the trail would change who gets
 * caught, and every headless A/B would drift.
 */

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const ease = (u) => u * u * (3 - 2 * u);

/** how long each beat lasts, in seconds */
const T = {
  // MUST equal player/Animator.js's THROW_KEYS.release * GESTURE_TIME.throw
  // (0.484 * 0.62). The sphere leaves the hand on the frame the arm reaches full
  // extension; move one of these two numbers without the other and it spawns out of an
  // arm that is still behind the ear. It was 0.17 s, which was also the entire length of
  // the old forward swing — see the measured note on THROW_KEYS.
  windup: 0.30,
  open: 0.12,
  suck: 0.44,
  shut: 0.12,
  settle: 0.30,
  shake: [0.62, 0.56, 0.50],
  gap: [0.34, 0.28, 0.22],
  amp: [0.42, 0.55, 0.70],
  hold: 0.50,
  release: 0.75,
  burst: 0.50,
  fade: 0.40,
  rearm: 0.42,
};

const POOL = 3;
const START_SPHERES = 6;
const AIM_RANGE = 34;
const PICKUP_RANGE = 1.5;

/**
 * WHAT A BREAKOUT COSTS.
 *
 * MEASURED, r12: without this block a failed capture left the creature FRIENDLIER than it
 * was when the sphere left the hand. `tools/_spheretest.mjs [wild]`: trust 0.058 at throw,
 * 0.320 eight seconds later. `penalise()` docked 0.10 exactly as written — and then the
 * ordinary taming arc (interaction/Taming.js, the `patient` term) walked the bar straight
 * back up to `patienceCap(stage)` = 0.32 at 0.05/s while the player stood there. A one-off
 * subtraction cannot survive a continuous accrual; it has to be a CEILING that is held.
 * Same run, `[oneBerry]`: 0.34 -> 0.32. Effectively free. Throwing was strictly better
 * than not throwing, which inverts the entire risk the sphere is supposed to carry.
 *
 * So a breakout now installs a window during which:
 *   - trust is pinned at or below `throwTrust - cost`. Patience cannot buy it back.
 *   - the creature reads `afraid` — it bolts for `bolt` seconds, then holds off at range,
 *     still frightened, rather than snapping back to `curious` when the 1.9 s flee expired.
 *
 * It is a setback, not a wall. A BERRY CLEARS IT OUTRIGHT (see the `creature:fed` hook in
 * init) — that is the loop the design asks for: berries buy trust, trust buys catch odds,
 * and a breakout costs berries to undo. `window` matches CATCH.tiredDecay so the fright
 * and the winding wear off together rather than leaving one dangling past the other.
 *
 * MEASURED after, same wild scenario (trust 0.065 when the sphere left the hand):
 *   no berry:   0.000 at the breakout, 0.000 still at +6 s (mood `afraid`),
 *               0.103 at +20 s once the window has lapsed (mood back to `curious`)
 *   one berry:  ceiling lifted the same frame the meal landed, 0.250 five seconds later
 * i.e. the fright costs about half a minute of patience, or one berry.
 */
const SPOOK = {
  cost: 0.10,   // docked off the trust it had WHEN THE SPHERE LEFT THE HAND
  bolt: 2.4,    // seconds of actual running
  window: 18,   // seconds the ceiling and the fear last
};

export function createSpheres() {
  let ctx, world, player, creatures, loadout;
  let fx, factory;
  let heightAt = () => 0;

  const pool = [];
  let held = null;
  let count = START_SPHERES;
  let handT = 0;                 // re-arm delay after a throw
  let windup = 0;
  let pending = null;            // { creature, point } captured at the moment of the press
  let aiming = false;
  let hasAim = false;
  let aimCreature = null;
  let aimChance = 0;
  const pendingTame = [];        // creatures whose trust we are holding at 1 until tamed
  const touched = new Set();     // creatures carrying _sphere state, for decay
  const spooked = new Map();     // cr -> { t, ceil, bolt } — see SPOOK

  // ---- scratch: nothing below is allocated per frame -------------------------
  const camPos = new THREE.Vector3();
  const camDir = new THREE.Vector3();
  const origin = new THREE.Vector3();
  const aimPt = new THREE.Vector3();
  const v0 = new THREE.Vector3();
  const tv = new THREE.Vector3();
  const tv2 = new THREE.Vector3();
  const arcPts = [];
  for (let i = 0; i < 34; i++) arcPts.push(new THREE.Vector3());
  const UPQ = new THREE.Vector3(0, 1, 0);
  const beamQ = new THREE.Quaternion();
  const viewV = new THREE.Vector3();   // camera forward, flattened — for the stand-off
  const sideV = new THREE.Vector3();   // camera right, flattened
  const camAt = new THREE.Vector3();   // camera world position, sampled inside the FSM
  const carry = new THREE.Vector3();   // where the held sphere rides, body-relative
  let holdAim = 0;                     // 0..1 ramp between the hip carry and the ready pose
  // one reused payload for player.holdWeapon — a sphere is a one-handed carry, so the
  // support hand is weighted out entirely and the left arm keeps its gait swing
  const holdReq = {
    grip: new THREE.Vector3(), fore: new THREE.Vector3(), bore: new THREE.Vector3(0, 0, -1),
    slide: 0, weight: 1, foreWeight: 0,
  };

  const sizeOf = (cr) => (cr?.stats?.size ?? cr?.def?.size ?? 0.9);
  /** the creature's trust as BOTH systems see it — Taming keeps its own copy in _tame */
  const trustOf = (cr) => Math.max(cr?.trust ?? 0, cr?._tame?.trust ?? 0);
  const centreOf = (cr, out) => out.copy(cr.position).setY(cr.position.y + sizeOf(cr) * 0.60);

  // ---------------------------------------------------------------- targeting
  /**
   * Which creature the throw is FOR. A cone in screen terms is wrong — at 3 m it grabs
   * half the meadow and at 30 m it grabs nothing — so the test is lateral distance from
   * the camera ray in metres, widening only slightly with range.
   */
  function pickTarget(from, dir) {
    let best = null, bestScore = Infinity;
    for (const cr of creatures?.list ?? []) {
      // a body is not a target: no aim assist, no odds readout, no catch
      if (!cr?.position || cr.dead || cr.tamed || cr._sphere?.busy) continue;
      centreOf(cr, tv).sub(from);
      const d = tv.length();
      if (d > AIM_RANGE || d < 0.4) continue;
      const along = tv.dot(dir);
      if (along <= 0) continue;
      const lateral = Math.sqrt(Math.max(0, d * d - along * along));
      const tol = 1.5 + sizeOf(cr) * 0.9 + d * 0.045;
      if (lateral > tol) continue;
      const score = lateral - sizeOf(cr) * 0.4 + d * 0.03;
      if (score < bestScore) { bestScore = score; best = cr; }
    }
    return best;
  }

  /** where the sphere leaves — the actual hand, so the arc and the avatar agree */
  function throwOrigin(out) {
    if (player?.handPosition) player.handPosition(out);
    else out.copy(player?.position ?? camPos).setY((player?.position?.y ?? 0) + 1.3);
    out.y += 0.10;
    return out;
  }

  /**
   * Resolve the aim point for this frame; returns false if there is nothing to aim at.
   * `full` marches the camera ray into the terrain, which costs ~80 height samples — so
   * it is only paid while the player is actually aiming or at the instant of a throw.
   * With a creature in the reticle no march is needed at all: the creature IS the point.
   */
  function resolveAim(full) {
    const cam = ctx.camera;
    if (!cam || !player) return false;
    cam.getWorldPosition(camPos);
    cam.getWorldDirection(camDir);
    aimCreature = pickTarget(camPos, camDir);
    if (aimCreature) {
      centreOf(aimCreature, aimPt);
      aimChance = catchChance(aimCreature);
    } else {
      aimChance = 0;
      if (full) terrainRay(camPos, camDir, heightAt, aimPt);
      else {
        const t = 12;
        aimPt.set(camPos.x + camDir.x * t, 0, camPos.z + camDir.z * t);
        aimPt.y = heightAt(aimPt.x, aimPt.z);
      }
    }
    throwOrigin(origin);
    solveThrow(origin, aimPt, v0);
    return true;
  }

  // ------------------------------------------------------------------ spheres
  function freeSlot() {
    for (const s of pool) if (!s.active) return s;
    return null;
  }

  function launch() {
    const s = freeSlot();
    if (!s) return null;
    // re-solve at the moment of release so a creature that walked during the wind-up is
    // still hit; the arc the player saw and the arc that flies are the same solve.
    let target = pending?.creature ?? null;
    if (target && (target.tamed || target._sphere?.busy)) target = null;
    throwOrigin(origin);
    if (target) centreOf(target, aimPt);
    else if (pending?.point) aimPt.copy(pending.point);
    solveThrow(origin, aimPt, v0);

    s.active = true;
    s.phase = 'fly';
    s.t = 0;
    s.pos.copy(origin);
    s.vel.copy(v0);
    s.target = target;
    s.aim.copy(aimPt);
    s.chance = target ? catchChance(target) : 0;
    // the baseline a breakout is measured against. Taken HERE, at release, not at the
    // burst: between the two the taming arc has had a couple of seconds of `patient`
    // accrual, and docking off the drifted value is what made the penalty evaporate.
    s.trust0 = target ? trustOf(target) : 0;
    s.roll = null;
    s.shake = 0;
    s.trailT = 0;
    s.spinAxis.set(spinRng.range(-1, 1), spinRng.range(0.3, 1), spinRng.range(-1, 1)).normalize();
    s.spin = spinRng.range(11, 16);
    s.model.root.visible = true;
    s.model.root.position.copy(s.pos);
    s.model.root.scale.setScalar(1);
    s.model.shell.rotation.set(0, 0, 0);
    s.model.setOpen(0);
    s.model.setGlow(0);
    s.model.setBeam(false);

    count--;
    handT = T.rearm;
    ctx.bus.emit('sphere:thrown', {
      from: origin.clone(), to: aimPt.clone(),
      target: target ?? null,
      chance: target ? +s.chance.toFixed(3) : null,
    });
    fx.burst(origin, { n: 7, color: 0xfff0cc, speed: 1.5, size: 0.04, life: 0.3, up: 0.4, grav: 4 });
    return s;
  }

  function onHit(s, cr) {
    const st = cr._sphere ?? (cr._sphere = { tired: 0, breakouts: 0, busy: false });
    touched.add(cr);
    st.busy = true;

    // a wide throw can clip a creature that was never the target; that one's baseline was
    // never taken at release, so take it now
    if (s.target !== cr) s.trust0 = trustOf(cr);
    s.target = cr;
    s.chance = catchChance(cr);
    s.roll = rollShakes(rollRng, s.chance);
    s.phase = 'open';
    s.t = 0;
    s.vel.set(0, 0, 0);
    s.crStart.copy(cr.position);
    s.crScale = cr.root ? cr.root.scale.x : 1;
    s.crRadius = sizeOf(cr) * 0.9;
    s.range = 8;
    // Stand the sphere off the creature rather than leaving it where it touched. A
    // sphere sitting ON the creature has no room for a beam, and the pull-in is the beat
    // that sells the whole mechanic — it has to be legible in a single frame.
    //
    // MEASURED, r12 (scratch probe, pull-in photographed at 7 m and 26 m): the stand-off
    // used to be "back along the flight line". The flight line is, by construction, the
    // camera's forward axis — the player throws at what the reticle is on — so the beam
    // was aimed almost exactly at the lens. A cone down the view axis projects to a
    // BULLSEYE: at 7 m the pull-in read as a glowing target ring with no length and no
    // direction, and at 26 m as a ~30 px pale disc. Nothing about it said "dragging".
    // Same family as the rim-light trap in CLAUDE.md: geometry authored along the view
    // axis has no silhouette to show.
    //
    // So the stand-off is now mostly LATERAL — across the frame — with only a little of
    // the old backwards component left so the sphere still reads as having arrived from
    // the player's side. The offset grows with camera range to hold a legible beam length
    // in pixels; at the authored ~7 m it is unchanged in magnitude, only rotated.
    centreOf(cr, tv);
    tv2.copy(s.pos).sub(tv).setY(0);
    if (tv2.lengthSq() < 1e-4) tv2.set(0, 0, 1);
    tv2.normalize();
    if (ctx.camera) {
      ctx.camera.getWorldDirection(viewV);
      ctx.camera.getWorldPosition(camAt);
    } else { viewV.set(0, 0, -1); camAt.copy(tv); }
    viewV.y = 0;
    if (viewV.lengthSq() < 1e-6) viewV.set(0, 0, -1);
    viewV.normalize();
    sideV.crossVectors(UPQ, viewV).normalize();
    // keep it on the side the sphere already flew in from, so it does not snap across the
    // creature at the moment of contact
    if (sideV.dot(tv2) < 0) sideV.negate();
    const range = s.range = camAt.distanceTo(tv);
    const off = 1.25 * clamp(range / 9, 1, 1.9);
    tv2.multiplyScalar(0.34).addScaledVector(sideV, 0.94).normalize().multiplyScalar(off);
    s.pos.copy(tv).add(tv2);
    s.pos.y = tv.y + 0.45 + Math.max(0, off - 1.25) * 0.35;
    s.pos.y = Math.max(s.pos.y, heightAt(s.pos.x, s.pos.z) + SHELL_R * 2);

    ctx.bus.emit('sphere:hit', {
      creature: cr, chance: +s.chance.toFixed(3),
      at: s.pos.clone(), factors: readFactors(cr),
    });
    fx.ring(cr.position, { r0: 0.3, r1: 2.2, dur: 0.45, color: 0xfff2cc });
    fx.burst(s.pos, { n: 18, color: 0xffe9bc, speed: 3.2, size: 0.06, life: 0.4, up: 1.0, grav: 6 });
    cr.playAnim?.('idle');
    cr.mood = 'wary';
    return s;
  }

  /** the creature is inside: freeze it, hide it, and own its transform */
  function holdCreature(cr, hidden) {
    if (!cr) return;
    if (cr.intent?.move) cr.intent.move.set(0, 0, 0);
    if (cr._tame) { cr._tame.act = 'idle'; cr._tame.actT = 0.2; }
    if (cr.root) cr.root.visible = !hidden;
  }

  function releaseCreature(cr, s, at, startled) {
    if (!cr) return;
    const x = at.x + (startled ? 0.35 : 0.0);
    const z = at.z + (startled ? 0.25 : 0.0);
    cr.position.set(x, heightAt(x, z), z);
    if (cr.root) {
      cr.root.visible = true;
      cr.root.scale.setScalar(s.crScale || 1);
    }
    if (cr._sphere) cr._sphere.busy = false;
  }

  /**
   * It burst out: warier, winded, and running.
   *
   * `trust0` is what it was worth when the sphere left the hand. The ceiling comes off
   * whichever is LOWER of that and its trust right now, so a creature that lost ground to
   * something else mid-flight is not handed any of it back by the breakout.
   *
   * NOTE (negative result, r12): docking trust once — which is all this used to do — is
   * not a penalty at all while the taming arc is running. See the SPOOK block above for
   * the measured numbers. Do not "simplify" this back into a single subtraction.
   *
   * NOTE: the ideal shape here would be `taming.addTrust(cr, -cost, 'broke-out')`, so the
   * dock ran through the same path as every other trust change and emitted `taming:trust`.
   * It is not reachable: interaction/index.js exposes only { inventory, focus, prompt,
   * marked, readout, companions, forage, arc } to peers — `addTrust`, `stateOf` and the
   * rest of createTaming's api never leave that closure. Writing `cr._tame` directly is
   * the coupling this file already had; widening it was not mine to do.
   */
  function penalise(cr, trust0) {
    const st = cr._sphere;
    st.breakouts++;
    st.tired = 1;
    const t = cr._tame;
    const base = Math.min(trustOf(cr), trust0 ?? 1);
    const ceil = clamp(base - SPOOK.cost, 0, 1);
    cr.trust = ceil;
    if (t) {
      t.trust = ceil;
      t.act = 'flee'; t.actT = SPOOK.bolt; t.spookCd = SPOOK.bolt + 0.4; t.lastDist = 999;
      t.noticed = true;
    }
    cr.mood = 'afraid';
    cr.playAnim?.('run');
    // a second breakout re-arms the window from the already-lowered ceiling, so spamming
    // spheres at one animal ratchets it down rather than resetting it
    spooked.set(cr, { t: SPOOK.window, ceil, bolt: SPOOK.bolt });
  }

  /** a berry (or a catch) ends the fright early — the way back is always food */
  function unspook(cr) { if (cr) spooked.delete(cr); }

  /**
   * It closed. Hand the creature to the EXISTING taming path rather than inventing a
   * second one: interaction/index.js watches for trust >= 0.999 and then runs
   * taming.complete() + companion.add(), which is what fires `creature:tamed` and
   * `companion:joined` and lights the bond banner. A capture that produced its own
   * private "tamed" flag would give a companion the roster never heard about.
   */
  function grant(cr) {
    unspook(cr);        // a later sphere landed: the fright from the earlier one is moot
    cr.trust = 1;
    const t = cr._tame;
    if (t) {
      t.trust = 1; t.fed = 3; t.fedCd = 0; t.noticed = true;
      t.act = 'settle'; t.actT = 1.2;
    }
    pendingTame.push({ cr, t: 3.0 });
  }

  // ------------------------------------------------------------- per-sphere FSM
  function updateSphere(s, dt) {
    const m = s.model;
    s.t += dt;

    switch (s.phase) {
      case 'fly': {
        const SUB = 3;
        const h = dt / SUB;
        for (let i = 0; i < SUB && s.phase === 'fly'; i++) {
          if (s.target && !s.target.tamed) {
            // gentle homing so a walking creature is still met; horizontal only, so the
            // arc keeps the shape the preview promised
            centreOf(s.target, tv).sub(s.pos);
            const hv = Math.hypot(s.vel.x, s.vel.z);
            const dl = Math.hypot(tv.x, tv.z) || 1;
            const k = Math.min(1, 6 * h);
            s.vel.x += ((tv.x / dl) * hv - s.vel.x) * k;
            s.vel.z += ((tv.z / dl) * hv - s.vel.z) * k;
          }
          stepBallistic(s.pos, s.vel, h);

          // contact
          let hit = null;
          for (const cr of creatures?.list ?? []) {
            if (!cr?.position || cr.dead || cr.tamed || cr._sphere?.busy) continue;
            centreOf(cr, tv2);
            const r = cr === s.target ? 0.40 + sizeOf(cr) * 0.65 : 0.24 + sizeOf(cr) * 0.48;
            if (s.pos.distanceToSquared(tv2) < r * r) { hit = cr; break; }
          }
          if (hit) { onHit(s, hit); break; }

          const g = heightAt(s.pos.x, s.pos.z);
          if (s.pos.y <= g + SHELL_R) {
            s.pos.y = g + SHELL_R;
            s.phase = 'idle'; s.t = 0;
            fx.burst(s.pos, { n: 8, color: 0xdcd6c0, speed: 1.4, size: 0.045, life: 0.35, up: 0.5, grav: 8 });
            fx.ring(s.pos, { r0: 0.1, r1: 0.7, dur: 0.35, color: 0xcfd8c0 });
            break;
          }
        }
        if (s.phase === 'fly') {
          m.shell.rotateOnAxis(s.spinAxis, s.spin * dt);
          s.trailT -= dt;
          if (s.trailT <= 0) { s.trailT = 0.018; fx.trail(s.pos); }
        }
        m.root.position.copy(s.pos);
        break;
      }

      case 'open': {
        const u = clamp(s.t / T.open, 0, 1);
        m.setOpen(u);
        m.setGlow(u * 0.7);
        m.root.position.copy(s.pos);
        holdCreature(s.target, false);
        if (u >= 1) { s.phase = 'suck'; s.t = 0; }
        break;
      }

      case 'suck': {
        const u = clamp(s.t / T.suck, 0, 1);
        const e = ease(u);
        const cr = s.target;
        m.setOpen(1);
        m.setGlow(0.7 + 0.3 * u);
        m.root.position.copy(s.pos);
        if (cr) {
          holdCreature(cr, false);
          tv.copy(s.crStart).lerp(s.pos, e * 0.92);
          cr.position.copy(tv);
          if (cr.root) cr.root.scale.setScalar(s.crScale * (1 - e * 0.94));
          // beam from the sphere mouth to the creature's middle
          centreOf(cr, tv2);
          tv.copy(tv2);              // keep the centre; tv2 becomes the direction
          tv2.sub(s.pos);
          const len = Math.max(0.05, tv2.length());
          beamQ.setFromUnitVectors(UPQ, tv2.normalize());
          m.beam.position.copy(s.pos);
          m.beam.quaternion.copy(beamQ);
          // the beam is the load-bearing read of this beat, so it holds a minimum
          // apparent width as the throw gets longer rather than tapering to a hairline
          const far = clamp(s.range / 11, 1, 1.7);
          m.setBeam(true, len, 0.35 + Math.sin(u * Math.PI) * 0.65, far);
          const off = m.beam.material.map.offset;
          off.y = (off.y - dt * 2.6) % 1;
          // Motes spiralling in, off the creature's body rather than its feet. These are
          // the first thing to go at range: 0.05 m is about one pixel at 26 m, and one
          // additive pixel over sunlit grass is nothing. Count and size both lean on
          // camera distance so the vortex survives the throw it was built for.
          const n = far > 1.35 ? 5 : 3;
          for (let i = 0; i < n; i++) fx.swirl(tv, s.pos, s.crRadius * (1 - e * 0.7), 0xffeec4, far);
        }
        if (u >= 1) {
          s.phase = 'shut'; s.t = 0;
          m.setBeam(false);
          if (cr) { holdCreature(cr, true); cr.position.copy(s.pos); }
          fx.burst(s.pos, { n: 22, color: 0xfff6dd, speed: 4.0, size: 0.06, life: 0.35, up: 0.6, grav: 4 });
          fx.ring(s.pos, { r0: 0.15, r1: 1.9, dur: 0.40, color: 0xffffff });
        }
        break;
      }

      case 'shut': {
        const u = clamp(s.t / T.shut, 0, 1);
        m.setOpen(1 - u);
        m.setGlow(1 - u * 0.55);
        m.root.position.copy(s.pos);
        holdCreature(s.target, true);
        if (s.target) s.target.position.copy(s.pos);
        if (u >= 1) {
          s.phase = 'fall'; s.t = 0;
          s.vel.set(0, -0.8, 0);
        }
        break;
      }

      case 'fall': {
        stepBallistic(s.pos, s.vel, dt);
        const g = heightAt(s.pos.x, s.pos.z) + SHELL_R;
        if (s.pos.y <= g) {
          s.pos.y = g;
          if (s.vel.y < -1.4) {
            s.vel.y = -s.vel.y * 0.34;
            fx.burst(s.pos, { n: 5, color: 0xe6dcc0, speed: 1.1, size: 0.04, life: 0.28, up: 0.4, grav: 9 });
          } else {
            s.vel.set(0, 0, 0);
            s.phase = 'settleDown'; s.t = 0;
            fx.ring(s.pos, { r0: 0.12, r1: 0.85, dur: 0.4, color: 0xffe0a8 });
          }
        }
        m.root.position.copy(s.pos);
        m.shell.rotation.z = Math.sin(s.t * 22) * 0.10;
        m.setGlow(0.45);
        holdCreature(s.target, true);
        if (s.target) s.target.position.copy(s.pos);
        break;
      }

      case 'settleDown': {
        m.root.position.copy(s.pos);
        m.shell.rotation.set(0, 0, 0);
        m.setGlow(0.35 + Math.sin(s.t * 9) * 0.12);
        holdCreature(s.target, true);
        if (s.target) s.target.position.copy(s.pos);
        if (s.t >= T.settle) { s.phase = 'shake'; s.t = 0; startShake(s); }
        break;
      }

      case 'shake': {
        const i = s.shake;
        const dur = T.shake[Math.min(i, T.shake.length - 1)];
        const amp = T.amp[Math.min(i, T.amp.length - 1)];
        const u = clamp(s.t / dur, 0, 1);
        const decay = 1 - u;
        const w = Math.sin(u * Math.PI * 3.0) * amp * decay * s.wobbleDir;
        m.shell.rotation.z = w;
        m.shell.rotation.x = Math.sin(u * Math.PI * 3.0 + 1.1) * amp * 0.35 * decay;
        m.root.position.copy(s.pos);
        m.root.position.y += Math.abs(w) * 0.055;
        // the eye brightens through each wobble, and each wobble starts brighter
        m.setGlow(0.30 + i * 0.16 + Math.abs(w) * 0.8);
        holdCreature(s.target, true);
        if (s.target) s.target.position.copy(s.pos);
        if (u >= 1) {
          const last = s.roll.caught ? CATCH.shakes - 1 : s.roll.survived;
          if (i < last) { s.phase = 'gap'; s.t = 0; }
          else if (s.roll.caught) { s.phase = 'hold'; s.t = 0; }
          else { beginBurst(s); }
        }
        break;
      }

      case 'gap': {
        const g = T.gap[Math.min(s.shake, T.gap.length - 1)];
        m.shell.rotation.set(0, 0, 0);
        m.root.position.copy(s.pos);
        m.setGlow(0.30 + s.shake * 0.16);
        holdCreature(s.target, true);
        if (s.target) s.target.position.copy(s.pos);
        if (s.t >= g) { s.shake++; s.phase = 'shake'; s.t = 0; startShake(s); }
        break;
      }

      case 'hold': {
        m.shell.rotation.set(0, 0, 0);
        m.root.position.copy(s.pos);
        m.setGlow(0.55 + Math.sin(s.t * 14) * 0.1);
        holdCreature(s.target, true);
        if (s.target) s.target.position.copy(s.pos);
        if (s.t >= T.hold) {
          s.phase = 'won'; s.t = 0;
          ctx.bus.emit('sphere:caught', { creature: s.target, chance: +s.chance.toFixed(3) });
          fx.ring(s.pos, { r0: 0.2, r1: 3.0, dur: 0.8, color: 0xffe6b0 });
          fx.ring(s.pos, { r0: 0.1, r1: 1.8, dur: 1.1, color: 0xffc0d8 });
          fx.burst(s.pos, { n: 26, color: 0xffe1a8, speed: 2.6, size: 0.07, life: 0.9, up: 2.0, grav: 3 });
        }
        break;
      }

      case 'won': {
        m.root.position.copy(s.pos);
        m.setGlow(1.0);
        holdCreature(s.target, true);
        if (s.target) s.target.position.copy(s.pos);
        if (s.t >= T.release) {
          const cr = s.target;
          releaseCreature(cr, s, s.pos, false);
          if (cr) {
            grant(cr);
            fx.burst(cr.position, { n: 24, color: 0xfff0c8, speed: 2.4, size: 0.08, life: 0.9, up: 1.8, grav: 3 });
          }
          s.phase = 'fade'; s.t = 0;
        }
        break;
      }

      case 'burst': {
        const u = clamp(s.t / T.burst, 0, 1);
        // slam open, then fall shut again as the empty shell drops
        m.setOpen(u < 0.35 ? u / 0.35 : Math.max(0, 1 - (u - 0.35) / 0.65));
        m.setGlow(Math.max(0, 1 - u * 1.6));
        m.shell.rotation.z = Math.sin(u * 30) * 0.25 * (1 - u);
        m.root.position.copy(s.pos);
        if (u >= 1) { s.phase = 'idle'; s.t = 0; m.setOpen(0); m.setGlow(0); }
        break;
      }

      case 'idle': {
        // an empty sphere is never lost — walk over it and it goes back in the satchel,
        // the same promise the berry loop makes about a berry nobody wanted
        m.root.position.copy(s.pos);
        m.root.position.y += Math.sin(s.t * 2.2) * 0.006;
        m.shell.rotation.y += dt * 0.35;
        m.setGlow(0.08 + Math.sin(s.t * 2.6) * 0.05);
        if (player && s.pos.distanceTo(player.position) < PICKUP_RANGE) {
          count++;
          fx.burst(s.pos, { n: 10, color: 0xffeec4, speed: 1.6, size: 0.05, life: 0.45, up: 1.2, grav: 3 });
          fx.ring(s.pos, { r0: 0.1, r1: 0.9, dur: 0.35, color: 0xffe6b0 });
          retire(s);
        }
        break;
      }

      case 'fade': {
        const u = clamp(s.t / T.fade, 0, 1);
        m.root.position.copy(s.pos);
        m.root.scale.setScalar(Math.max(0.001, 1 - u));
        m.setGlow(1 - u);
        if (u >= 1) retire(s);
        break;
      }

      default: retire(s);
    }
  }

  function startShake(s) {
    s.wobbleDir = -s.wobbleDir;
    ctx.bus.emit('sphere:shake', {
      creature: s.target, shake: s.shake + 1, of: CATCH.shakes,
    });
    fx.burst(s.pos, { n: 4, color: 0xffd48a, speed: 0.9, size: 0.035, life: 0.25, up: 0.5, grav: 6 });
  }

  function beginBurst(s) {
    const cr = s.target;
    s.phase = 'burst';
    s.t = 0;
    ctx.bus.emit('sphere:escaped', {
      creature: cr, atShake: s.shake + 1, chance: +s.chance.toFixed(3),
    });
    releaseCreature(cr, s, s.pos, true);
    if (cr) penalise(cr, s.trust0);
    fx.ring(s.pos, { r0: 0.2, r1: 2.6, dur: 0.5, color: 0xffb37a });
    fx.burst(s.pos, { n: 24, color: 0xffc07a, speed: 4.2, size: 0.065, life: 0.5, up: 1.4, grav: 7 });
  }

  function retire(s) {
    s.active = false;
    s.phase = 'off';
    s.target = null;
    s.roll = null;
    s.model.root.visible = false;
    s.model.setBeam(false);
    s.model.root.scale.setScalar(1);
    s.model.shell.rotation.set(0, 0, 0);
  }

  // deliberately separate streams — see the determinism note in the header
  let rollRng, fxRng, spinRng;

  /**
   * Can the traveller pay for a throw? Charged at the PRESS, not at the launch, so the
   * wind-up animation only ever plays for a throw that is actually going to happen —
   * charging at launch means a sphere that visibly leaves the hand and then does not.
   */
  function affordThrow(c) {
    const vitals = c.get('vitals');
    if (!vitals) return true;
    if (!vitals.spend('focus', vitals.costs().throwFocus)) {
      c.get('ui')?.notify?.('Not enough focus to steady a throw.', { ttl: 2.6 });
      return false;
    }
    vitals.drain('stamina', vitals.costs().throwStamina);
    return true;
  }

  const api = {
    name: 'spheres',
    order: ORDER.SPHERES,

    init(c) {
      ctx = c;
      world = c.get('world');
      player = c.get('player');
      creatures = c.get('creatures');
      loadout = c.get('loadout');
      heightAt = (x, z) => world?.heightAt?.(x, z) ?? 0;

      rollRng = c.rng.fork(0x5b0d);
      fxRng = c.rng.fork(0x5b0e);
      spinRng = c.rng.fork(0x5b0f);

      factory = createSphereFactory(c.rng.fork(0x5b10));
      fx = createFx(c, fxRng);

      for (let i = 0; i < POOL; i++) {
        const model = factory.create();
        c.scene.add(model.root);
        c.scene.add(model.beam);
        pool.push({
          model, active: false, phase: 'off', t: 0,
          pos: new THREE.Vector3(), vel: new THREE.Vector3(),
          aim: new THREE.Vector3(), crStart: new THREE.Vector3(),
          spinAxis: new THREE.Vector3(0, 1, 0), spin: 0,
          target: null, roll: null, chance: 0, shake: 0, trust0: 0,
          wobbleDir: 1, trailT: 0, crScale: 1, crRadius: 0.9, range: 8,
        });
      }

      held = factory.create();
      held.root.visible = false;
      c.scene.add(held.root);

      // A berry is the way back. Feeding is the only thing that lifts the ceiling early,
      // which is exactly the intended loop — a breakout costs berries to undo, it does
      // not lock the creature out. Watched over the bus rather than polled: interaction
      // already announces every meal, and `taming.advance()` does the trust step itself.
      c.bus.on('creature:fed', (p) => unspook(p?.creature));
      c.bus.on('creature:tamed', (p) => unspook(p?.creature));
    },

    update(dt, c) {
      const equipped = !!loadout?.is?.('sphere');
      const ready = equipped && !!loadout?.canAct?.();
      const input = c.input;

      // ---- aim ----------------------------------------------------------
      aiming = ready && !!input?.down?.('aim');
      hasAim = false;
      if (equipped && count > 0 && windup <= 0) hasAim = resolveAim(aiming);
      else { aimCreature = null; aimChance = 0; }

      if (aiming && hasAim) {
        const n = tracePath(origin, v0, heightAt, arcPts, aimPt);
        fx.showArc(arcPts, n, aimCreature ? 0xffc24d : 0x8fd8ff);
        tv.copy(aimPt); tv.y = heightAt(tv.x, tv.z);
        fx.showLand(tv, true);
        if (aimCreature) {
          tv2.copy(aimCreature.position); tv2.y = heightAt(tv2.x, tv2.z);
          fx.showOdds(tv2, aimChance, 0.55 + sizeOf(aimCreature) * 0.55);
        } else fx.hideOdds();
      } else {
        fx.hideArc(); fx.showLand(tv, false); fx.hideOdds();
      }

      // ---- throw --------------------------------------------------------
      // A throw costs FOCUS, and focus is the one meter that can refuse an action: the
      // bond is a thing the traveller does with their attention, and a blue bar that
      // only ever goes down decoratively teaches nothing. Stamina is drained too but
      // never blocks — being tired should slow the loop, not stop it.
      if (ready && count > 0 && windup <= 0 && input?.justPressed?.('throw') && freeSlot()
        && affordThrow(c)) {
        // freeze the intent at the press so the throw is the shot the player took
        resolveAim(true);
        hasAim = true;
        pending = { creature: aimCreature, point: aimPt.clone() };
        windup = T.windup;
        // A THROW, not the feeding gesture. This used to play 'offer' — the slow palm-up
        // reach a berry is held out with — so a sphere left the hand while the arm was
        // still extending politely forward, which is the "weird" the owner reported.
        // player/Animator.js's 'throw' releases at 0.17 s, which is exactly T.windup: the
        // ball leaves the hand on the frame the arm reaches full extension. Move either
        // number and the other has to move with it.
        player?.playGesture?.('throw');
      }
      if (windup > 0) {
        windup -= dt;
        if (windup <= 0) { windup = 0; launch(); pending = null; }
      }

      // ---- the one in your hand ------------------------------------------
      // The hand is IK'd ONTO the sphere, not the other way round. Before this, the
      // sphere was parked at whatever world point the locomotion swing happened to put
      // the wrist at, so a walking traveller waved a sphere around at arm's length like
      // a lantern. Now the carry point is body-relative and steady, the arm reaches for
      // it (one hand — the left keeps swinging), and the sphere sits in the palm.
      //
      // Suppressed during the wind-up: the throw animation owns the arm for those 0.17 s
      // and an IK call would fight it to a standstill halfway through the cock-back.
      handT = Math.max(0, handT - dt);
      const showHeld = equipped && count > 0 && handT <= 0;
      held.root.visible = showHeld;
      if (showHeld && player) {
        const by = player.bodyYaw ?? 0;
        const raise = clamp(loadout?.swapProgress?.() ?? 1, 0, 1);
        // carried at the hip; brought up in front of the chest while aiming
        const a = aiming ? 1 : 0;
        holdAim = holdAim + (a - holdAim) * Math.min(1, dt * 9);
        // AIMING IS HALF THE WIND-UP. At rest the sphere rides at the hip; taking aim
        // lifts it to the right ear and a hand's width BEHIND the shoulder line, which
        // is a cocked-and-waiting pose rather than a presentation. Two things fall out
        // of that: the throw itself only has to travel the second half of the arc, so
        // the whole 0.62 s budget goes into the swing that has to be seen; and the
        // predicted-landing arc, which is drawn from the hand, now starts within a few
        // centimetres of where the ball actually leaves it instead of half a metre low.
        const up = 1.10 + holdAim * 0.42;             // hip -> ear
        const rightOff = 0.30 - holdAim * 0.02;
        const fwdOff = 0.16 - holdAim * 0.20;         // 0.16 forward -> 0.04 behind
        carry.set(
          player.position.x + Math.cos(by) * rightOff - Math.sin(by) * fwdOff,
          player.position.y + up - (1 - raise) * 0.3,
          player.position.z - Math.sin(by) * rightOff - Math.cos(by) * fwdOff);

        if (windup <= 0) {
          // the wrist goes a little above the sphere so it rests in the palm, not in the
          // middle of the fist (the hand mesh hangs ~3.5 cm below its own origin)
          holdReq.grip.copy(carry).setY(carry.y + 0.045);
          holdReq.fore.copy(holdReq.grip);
          holdReq.bore.set(-Math.sin(by), 0, -Math.cos(by));
          player.holdWeapon?.(dt, holdReq);
          held.root.position.copy(carry);
        } else {
          // mid-throw the sphere rides the actual hand, which is whipping forward
          throwOrigin(tv);
          held.root.position.copy(tv);
        }
        held.root.scale.setScalar(raise);
        held.shell.rotation.y += dt * 0.5;
        held.shell.rotation.z = Math.sin(c.elapsed * 1.3) * 0.05;
        held.setGlow(0.05 + (aimCreature ? aimChance * 0.25 : 0));
      } else if (player && holdAim > 0) {
        // nothing in hand any more: let the arm fall back to the gait swing
        holdAim = 0;
        player.holdWeapon?.(dt, null);
      }

      // ---- the spheres themselves ----------------------------------------
      for (const s of pool) if (s.active) updateSphere(s, dt);

      // ---- a creature stops being winded ---------------------------------
      for (const cr of touched) {
        const st = cr._sphere;
        if (!st) { touched.delete(cr); continue; }
        if (st.tired > 0) st.tired = Math.max(0, st.tired - dt / CATCH.tiredDecay);
      }

      // ---- a creature that burst out stays spooked ------------------------
      // This runs at ORDER.SPHERES (64), i.e. AFTER ai (50) and interaction (60) have
      // each had their say about mood and trust this frame, so what is written here is
      // what the UI (80) and audio (90) read. That ordering is the whole reason a
      // ceiling works: it is re-asserted downstream of the accrual that fights it.
      for (const [cr, spk] of spooked) {
        spk.t -= dt;
        if (cr.tamed || spk.t <= 0) { spooked.delete(cr); continue; }
        spk.bolt -= dt;
        const t = cr._tame;
        if ((cr.trust ?? 0) > spk.ceil) cr.trust = spk.ceil;
        if (t && t.trust > spk.ceil) t.trust = spk.ceil;
        // Keep it running for the bolt only. Holding `flee` for the whole window was
        // tried and is wrong: flee moves at speed*1.8 away from the player, so eighteen
        // seconds of it carries the creature past Taming's ENGAGE_RANGE, at which point
        // it disengages, stops being driven, and the fright reads as nothing at all.
        if (spk.bolt > 0 && t && t.act !== 'flee') { t.act = 'flee'; t.actT = spk.bolt; }
        // After the bolt it holds off and watches, still frightened. `afraid` rather than
        // `wary` is deliberate: `wary` is what Taming's `shy` means — mildly uneasy — and
        // it would also halve Catch.readFactors' `startled` term mid-window, so waiting
        // would make the follow-up throw HARDER. The fright is the state; it ends when
        // the window ends or when the player feeds it.
        cr.mood = 'afraid';
      }

      // ---- hold a caught creature at full trust until the arc completes ----
      // interaction/index.js does the completing; taming.update can still dock trust in
      // the frame between, so keep re-asserting rather than setting it once and hoping.
      for (let i = pendingTame.length - 1; i >= 0; i--) {
        const p = pendingTame[i];
        p.t -= dt;
        if (p.cr.tamed || p.t <= 0) { pendingTame.splice(i, 1); continue; }
        p.cr.trust = 1;
        if (p.cr._tame) p.cr._tame.trust = 1;
      }

      fx.update(dt);
    },

    // ---- public contract -------------------------------------------------
    count() { return count; },
    inFlight() { let n = 0; for (const s of pool) if (s.active && s.phase !== 'idle') n++; return n; },
    aimPoint() {
      if (!hasAim) return null;
      return { x: aimPt.x, y: aimPt.y, z: aimPt.z };
    },
    isAiming() { return aiming; },
    /** additive: everything a HUD needs to explain the odds it is about to show */
    aimTarget() {
      if (!aimCreature) return null;
      return { creature: aimCreature, chance: aimChance, factors: readFactors(aimCreature) };
    },
    /** additive: what a sphere thrown at this creature right now would do */
    chanceFor(cr) { return cr && !cr.tamed ? catchChance(cr) : 0; },

    snapshot() {
      const act = [];
      for (const s of pool) {
        if (!s.active) continue;
        act.push({
          phase: s.phase,
          shake: s.phase === 'shake' || s.phase === 'gap' ? s.shake + 1 : 0,
          target: s.target?.species ?? null,
          chance: s.target ? +s.chance.toFixed(2) : null,
          caught: s.roll ? s.roll.caught : null,
        });
      }
      return {
        built: true,
        count,
        inFlight: api.inFlight(),
        aiming,
        equipped: !!loadout?.is?.('sphere'),
        aim: hasAim ? [+aimPt.x.toFixed(2), +aimPt.y.toFixed(2), +aimPt.z.toFixed(2)] : null,
        target: aimCreature
          ? { species: aimCreature.species, trust: +(aimCreature.trust ?? 0).toFixed(2), chance: +aimChance.toFixed(3) }
          : null,
        active: act,
        /** additive: creatures still frightened from a breakout, and how long each has left */
        spooked: [...spooked].map(([cr, spk]) => ({
          species: cr.species, left: +spk.t.toFixed(1), ceil: +spk.ceil.toFixed(3),
        })),
        fx: fx?.stats?.() ?? null,
      };
    },
  };

  return api;
}
