import * as THREE from 'three';
import { ORDER } from '../engine/Game.js';
import { WEAPONS, RECOIL_SPRING } from './defs.js';
import { buildWeaponModel } from './model.js';
import { createFX } from './fx.js';
import { traceShot, makeTraceResult } from './ballistics.js';
import { createWeakenLedger } from './weaken.js';

/**
 * WEAPONS — aim, fire, recoil, reload, and the ledger of how tired a creature is.
 *
 * The feel target is GTA's third-person shooting, and the four things that make that
 * feel specific are all here:
 *
 *   AIM IS A STATE, NOT A MODIFIER. Entering aim is a 0.2 s ramp and leaving it is a
 *   slower 0.45 s one; the weapon changes pose, the cone of fire collapses toward its
 *   floor, and `moveScale()` tells the player system to slow down. It is deliberately
 *   asymmetric: a player who taps aim to snap-shoot gets the tight cone, and a player
 *   who releases it mid-burst does not instantly get the hip-fire cone back.
 *
 *   SPREAD IS A LIVE NUMBER. `spreadDeg()` is the actual cone the next round will be
 *   drawn from — hip-fire, movement, sprint and per-shot bloom, recovering over time.
 *   The HUD reticle IS this value; there is no separate cosmetic bloom animation, so
 *   what the crosshair shows is what the gun does.
 *
 *   RECOIL IS TWO CURVES AND A RESIDUAL. A stiff spring for the snap, a soft one for
 *   the climb, and a leaky accumulator that never quite returns to zero (see defs.js).
 *   The recoil offset is applied to the ROUND, not just to the picture, so a burst
 *   genuinely walks off target and holding the trigger genuinely costs accuracy.
 *
 *   EVERY SHOT LEAVES EVIDENCE. Flash, light, tracer, case, and a surface-aware impact
 *   (see fx.js). A shot with a missing piece of evidence reads as a UI event.
 *
 * TONE. Nothing in this module can kill a creature — there is no health, no death and no
 * corpse anywhere under src/weapons/. A hit drains STAMINA and staggers; a creature at
 * zero stamina is exhausted and much easier to befriend. See weaken.js for the full
 * contract the Bond Sphere system consumes.
 *
 * PUBLIC CONTRACT (peers reach this with `ctx.get('weapons')`)
 *   isAiming()     -> boolean
 *   aimBlend()     -> 0..1, for the shoulder-cam shift (src/player owns the camera)
 *   spreadDeg()    -> current cone of fire, degrees
 *   ammo()         -> { inMag, reserve, magSize }
 *   reloading()    -> 0..1 progress, or 0 when not reloading
 *   recoil()       -> { pitch, yaw } radians, for camera kick
 *   moveScale()    -> 1 normally, ~0.6 while aiming
 *   weakness(cr) / catchBonus(cr) / isExhausted(cr)   -> the sphere-system contract
 *
 * BUS EVENTS
 *   weapon:fired    { id, from, dir, inMag, spreadDeg }
 *   weapon:impact   { point, normal, surface, distance }
 *   weapon:hit      { creature, damage }        (+ id, species, stamina, exhausted,
 *                                                hpDamage, health, health01, killed)
 *   weapon:dry      { id }                      trigger pulled on an empty magazine
 *   weapon:reload   { id, phase }               'start'|'magout'|'magin'|'charge'|'done'|'cancel'
 *   weapon:aim      { id, aiming }
 *   creature:weakened  { creature, stamina, drained, exhausted }
 *   creature:exhausted { creature }
 */

const UP = new THREE.Vector3(0, 1, 0);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const damp = (a, b, l, dt) => a + (b - a) * (1 - Math.exp(-l * dt));
const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;

export function createWeapons() {
  let ctx, world, player, loadout, creatures;
  let rng;
  let fx = null;
  const models = {};                 // id -> { group, mesh, muzzle, eject }
  let ledger = null;

  // ---- per-weapon persistent state (ammo survives a swap) -----------------
  const mags = {};

  // ---- live state ---------------------------------------------------------
  let curId = 'none';
  let aiming = false, aimT = 0;
  let bloom = 0;
  let cooldown = 0, dryCool = 0;
  let shotsFired = 0;
  let lastSurface = null;
  let firstShotAt = -1;

  // recoil: two springs plus a leaky residual (defs.js explains the shape)
  let snapX = 0, snapV = 0, climbX = 0, climbV = 0, yawX = 0, yawV = 0;
  let driftP = 0, driftY = 0;

  // reload state machine
  const PHASES = ['magout', 'magin', 'charge'];
  let rl = null;                     // { id, phase, t, dur, total, elapsed }

  // scratch — nothing in update() may allocate
  const _anchor = new THREE.Vector3();
  const _aimAnchor = new THREE.Vector3();
  const _restAnchor = new THREE.Vector3();
  const _bodyFwd = new THREE.Vector3();
  const _bodyRight = new THREE.Vector3();
  const _grip = new THREE.Vector3();
  const _fore = new THREE.Vector3();
  const _bore = new THREE.Vector3();
  const _hold = { grip: _grip, fore: _fore, bore: _bore, slide: 0, weight: 1, foreWeight: 1 };
  const _camFwd = new THREE.Vector3();
  const _camRight = new THREE.Vector3();
  const _camUp = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const _restDir = new THREE.Vector3();
  const _poseDir = new THREE.Vector3();
  const _target = new THREE.Vector3();
  const _muzzle = new THREE.Vector3();
  const _eject = new THREE.Vector3();
  const _right = new THREE.Vector3();
  const _mat = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _qk = new THREE.Quaternion();
  const trace = makeTraceResult();

  function def() { return WEAPONS[curId] ?? null; }

  // ------------------------------------------------------------------ ammo
  function mag(id) {
    if (!mags[id]) {
      const d = WEAPONS[id];
      mags[id] = { inMag: d.magSize, reserve: d.startReserve };
    }
    return mags[id];
  }

  // ---------------------------------------------------------------- reload
  function startReload() {
    const d = def();
    if (!d || rl) return false;
    const m = mag(d.id);
    if (m.inMag >= d.magSize || m.reserve <= 0) return false;
    rl = { id: d.id, phaseIdx: 0, phase: 'magout', t: 0, elapsed: 0, total: d.reload.magout + d.reload.magin + d.reload.charge, filled: false };
    ctx.bus.emit('weapon:reload', { id: d.id, phase: 'start' });
    ctx.bus.emit('weapon:reload', { id: d.id, phase: 'magout' });
    return true;
  }

  function cancelReload(why = 'cancel') {
    if (!rl) return;
    ctx.bus.emit('weapon:reload', { id: rl.id, phase: 'cancel', why });
    rl = null;
  }

  function stepReload(dt) {
    if (!rl) return;
    const d = WEAPONS[rl.id];
    rl.t += dt; rl.elapsed += dt;
    // a missing duration must not silently mean "instant" — see the note in defs.js
    const dur = d.reload[PHASES[rl.phaseIdx]] || 0.4;
    if (rl.t < dur) return;
    rl.t -= dur;
    // ammo lands at the end of magIn — the charge phase is the slide/handle, and a
    // reload interrupted before that point keeps the rounds already in the gun.
    if (PHASES[rl.phaseIdx] === 'magin') {
      const m = mag(rl.id);
      const want = Math.min(d.magSize - m.inMag, m.reserve);
      m.inMag += want; m.reserve -= want;
      rl.filled = true;
    }
    rl.phaseIdx++;
    if (rl.phaseIdx >= PHASES.length) {
      ctx.bus.emit('weapon:reload', { id: rl.id, phase: 'done', inMag: mag(rl.id).inMag });
      rl = null;
      return;
    }
    rl.phase = PHASES[rl.phaseIdx];
    ctx.bus.emit('weapon:reload', { id: rl.id, phase: rl.phase });
  }

  // ------------------------------------------------------------------ spread
  function currentSpreadDeg() {
    const d = def();
    if (!d) return 0;
    const s = d.spread;
    const speed = player ? Math.hypot(player.velocity.x, player.velocity.z) : 0;
    const moveAmt = clamp(speed / 3.9, 0, 1.25);
    const sprintAmt = player?.sprintAmount ?? 0;
    return Math.min(s.max,
      s.aimed + s.hip * (1 - aimT) + s.move * moveAmt + s.sprint * sprintAmt + bloom);
  }

  // ------------------------------------------------------------------ firing
  function fire(c) {
    const d = def();
    const m = mag(d.id);
    m.inMag--;
    shotsFired++;
    cooldown = 60 / d.rpm;
    if (firstShotAt < 0) firstShotAt = c.elapsed;

    const cam = c.camera;
    cam.getWorldDirection(_camFwd).normalize();
    _camRight.crossVectors(_camFwd, UP).normalize();
    _camUp.crossVectors(_camRight, _camFwd).normalize();

    // recoil accumulated by the PREVIOUS rounds bends this one — that is what makes a
    // burst walk. The shot being fired now contributes to the next one, not to itself.
    const pitchOff = snapX * 0.55 + climbX + driftP;
    const yawOff = yawX * 0.55 + driftY;
    _dir.copy(_camFwd)
      .addScaledVector(_camUp, Math.tan(pitchOff))
      .addScaledVector(_camRight, Math.tan(yawOff))
      .normalize();

    // ...then the cone. Uniform over the disc (sqrt), so the cone does not bunch at
    // the centre the way a naive uniform-radius draw does.
    const spreadDeg = currentSpreadDeg();
    const sr = Math.tan(spreadDeg * DEG2RAD);
    const a = rng.range(0, Math.PI * 2);
    const r = Math.sqrt(rng.next()) * sr;
    _dir.addScaledVector(_camRight, Math.cos(a) * r)
      .addScaledVector(_camUp, Math.sin(a) * r)
      .normalize();

    // The round is traced from the CAMERA (so it goes where the crosshair is) but the
    // tracer is drawn from the MUZZLE (so it comes out of the gun). Every third-person
    // shooter does this; the parallax is invisible and the alternative — tracing from
    // the muzzle — makes the crosshair a liar at close range.
    traceShot(world, creatures?.list ?? null, cam.position, _dir, d.range, trace);

    ctx.bus.emit('weapon:fired', {
      id: d.id,
      from: { x: +_muzzle.x.toFixed(3), y: +_muzzle.y.toFixed(3), z: +_muzzle.z.toFixed(3) },
      dir: { x: +_dir.x.toFixed(4), y: +_dir.y.toFixed(4), z: +_dir.z.toFixed(4) },
      inMag: m.inMag,
      spreadDeg: +spreadDeg.toFixed(2),
    });

    // ---- evidence ---------------------------------------------------------
    fx.muzzleFlash(_muzzle, _dir, d.fireHeat);
    models[d.id]?.eject.getWorldPosition(_eject);
    _right.set(_camRight.x, _camRight.y, _camRight.z);
    fx.ejectCase(_eject, _right, UP);
    _target.copy(trace.point);
    fx.tracer(_muzzle, _target, 460);

    lastSurface = trace.surface;
    if (trace.surface !== 'air') {
      const energy = trace.surface === 'creature' ? 1.0 : clamp(1.35 - trace.t / d.range, 0.45, 1.2);
      fx.impact(trace.point, trace.normal, trace.surface, energy);
      ctx.bus.emit('weapon:impact', {
        point: { x: +trace.point.x.toFixed(3), y: +trace.point.y.toFixed(3), z: +trace.point.z.toFixed(3) },
        normal: { x: +trace.normal.x.toFixed(3), y: +trace.normal.y.toFixed(3), z: +trace.normal.z.toFixed(3) },
        surface: trace.surface,
        distance: +trace.t.toFixed(2),
      });
    }

    // ---- what a gun does to a creature ------------------------------------
    // TWO clocks, and they are not interchangeable. The ledger drains STAMINA, which is
    // the befriending loop and always runs out first. Health is the second, slower one,
    // added in r15 when the owner lifted the no-death rule; running it out kills the
    // creature (src/creatures/vitality.js). A shot that only staggered before now also
    // costs health, so nothing that fires may skip this call.
    if (trace.creature) {
      const rec = ledger.hit(trace.creature, d.damage, _dir, d.stagger, d.knockback);
      const wasAlive = !trace.creature.dead;
      // which way to topple: away from the shot, decided here where the direction is known
      trace.creature._deathRoll = _dir.dot(_camRight) >= 0 ? 1 : -1;
      const took = creatures?.hurt?.(trace.creature, d.hpDamage ?? 0, 'shot') ?? 0;
      const killed = wasAlive && trace.creature.dead;
      ctx.bus.emit('weapon:hit', {
        creature: trace.creature,
        id: trace.creature.id,
        species: trace.creature.species,
        damage: +d.damage.toFixed(3),
        hpDamage: +took.toFixed(1),
        health: +(trace.creature.health ?? 0).toFixed(1),
        health01: +(trace.creature.health01 ?? 0).toFixed(3),
        killed,
        stamina: +rec.stamina.toFixed(3),
        exhausted: rec.exhausted,
        absorbed: !!rec.absorbed,
        point: { x: +trace.point.x.toFixed(3), y: +trace.point.y.toFixed(3), z: +trace.point.z.toFixed(3) },
        weapon: d.id,
      });
    }

    // ---- kick -------------------------------------------------------------
    snapV += d.recoil.snap;
    climbV += d.recoil.climb;
    yawV += d.recoil.yaw * (rng.bool() ? 1 : -1) * rng.range(0.55, 1.0);
    driftP += d.recoil.drift * rng.range(0.7, 1.0);
    driftY += d.recoil.drift * 0.5 * (rng.bool() ? 1 : -1);
    bloom = Math.min(d.spread.max, bloom + d.spread.perShot);
  }

  function stepRecoil(dt) {
    const S = RECOIL_SPRING;
    snapV -= (S.snap.k * snapX + S.snap.c * snapV) * dt; snapX += snapV * dt;
    climbV -= (S.climb.k * climbX + S.climb.c * climbV) * dt; climbX += climbV * dt;
    yawV -= (S.snap.k * 0.75 * yawX + S.snap.c * 0.85 * yawV) * dt; yawX += yawV * dt;
    const k = Math.exp(-dt / S.driftTau);
    driftP *= k; driftY *= k;
    if (Math.abs(snapX) < 1e-6 && Math.abs(snapV) < 1e-6) { snapX = 0; snapV = 0; }
  }

  // ------------------------------------------------------------------- pose
  function poseWeapon(dt, c) {
    const d = def();
    const model = d ? models[d.id] : null;
    for (const id in models) models[id].group.visible = !!(model && models[id] === model);
    if (!model || !player) { player?.holdWeapon?.(dt, null); return; }

    const cam = c.camera;
    cam.getWorldDirection(_camFwd).normalize();
    _camRight.crossVectors(_camFwd, UP).normalize();
    _camUp.crossVectors(_camRight, _camFwd).normalize();

    // ---- where the gun sits ---------------------------------------------
    // LOW READY is anchored to the BODY, never to the animated hand. It used to read
    // `player.handPosition()`, which was correct while the arms were pure locomotion —
    // but the arms now IK onto the grip, so hand -> anchor -> grip -> hand closes a
    // loop: each frame the hand chases the grip offset it produced last frame and the
    // weapon walks off the character in a straight line. Body-relative breaks the loop.
    const by = player.bodyYaw ?? 0;
    _bodyFwd.set(-Math.sin(by), 0, -Math.cos(by));
    _bodyRight.set(Math.cos(by), 0, -Math.sin(by));
    _restAnchor.copy(player.position)
      .addScaledVector(UP, 1.16)
      .addScaledVector(_bodyRight, 0.30)
      .addScaledVector(_bodyFwd, 0.16);

    // The aim pose is a shoulder pose, built off the PLAYER, not off the camera: the
    // camera is 2.3 m behind the avatar's back, so anything anchored to it floats.
    //
    // The offsets are large for a reason. The first version sat the receiver 0.26 m in
    // front of the chest and 0.24 m to the right — geometrically a perfectly good
    // shoulder pose, and completely invisible, because the camera is directly behind the
    // avatar and the avatar's own torso occluded the entire weapon. In a third-person
    // shooter the gun has to clear the body silhouette or the player has no idea what
    // they are holding.
    //
    // They are no longer as large as they were (0.32 right / 0.40 forward), because the
    // arms now have to REACH the thing. An arm is 0.555 m from shoulder to wrist; at the
    // old anchor the left wrist was 0.60 m from the left shoulder even with the chest
    // bladed, so the support arm clamped straight and the hand hung short of the gun —
    // which is the same "floating weapon" read the anchor was chosen to avoid, just
    // relocated to the hands. 0.24 / 0.34 keeps both wrists inside reach and still
    // clears the silhouette, because the muzzle is another 0.58 m past the anchor.
    // ...and the aim anchor is BODY-relative too, for the same reason the rest anchor is.
    // It used to be built on _camRight/_camFwd. The body only damps toward the camera
    // while aiming (player/index.js, rate 18/s), so during any quick turn the camera is
    // ahead of the torso by up to tens of degrees — and a weapon whose POSITION comes
    // off one basis while its owner's hands come off another slides around the chest
    // for the length of that lag. Position on the body, direction on the camera, and
    // the player system caps how far apart the two bases are allowed to get.
    _aimAnchor.copy(player.position)
      .addScaledVector(UP, 1.38)
      .addScaledVector(_bodyRight, 0.24)
      .addScaledVector(_bodyFwd, 0.34);
    const raise = loadout?.swapProgress?.() ?? 1;
    _anchor.copy(_restAnchor).lerp(_aimAnchor, aimT);
    // a reload drops the gun out of the aim line, and so does a swap still playing out
    const dip = rl ? (rl.phaseIdx < 2 ? 0.16 : 0.09) : 0;
    _anchor.y -= dip + (1 - raise) * 0.35;

    // ---- where it points -------------------------------------------------
    // Low ready is ONE-HANDED, at the right hip, muzzle forward and down.
    //
    // The two-handed patrol carry (butt at the shoulder, muzzle down and across to the
    // left) was tried first and thrown away twice over. It is invisible: the gameplay
    // camera sits directly behind the avatar, so anything held near the centreline at
    // chest height is inside the torso-and-backpack silhouette and the player sees no
    // weapon at all. And it is unreachable: a two-handed carry keeps the gun near the
    // centreline precisely BECAUSE both arms must reach it, and an arm here is 0.555 m,
    // so pushing the grip far enough right to clear the silhouette (~0.30 m) puts the
    // support hand 0.58 m from the left shoulder and the left arm clamps out straight
    // and short of the gun. One hand at the hip solves both at once — and it frees the
    // left arm to keep swinging with the gait, which is what a carried rifle looks like.
    //
    // The muzzle goes down AND well out to the right, not straight down the sightline:
    // the barrel is the only long feature the weapon has, and a barrel pointed along
    // the view axis projects to a stub of a dozen pixels — the same failure the sphere
    // system's pull-in beam hit (CLAUDE.md). Angled across the frame it reads as a
    // rifle from the first frame.
    //
    // THE BASIS IS THE BODY'S, NOT THE CAMERA'S, and that is the whole fix for "the
    // muzzle keeps changing where it points relative to my character". This vector was
    // built from _camFwd/_camRight while the ANCHOR was already body-relative, so the
    // weapon pivoted about the hand every time the player looked around: standing still
    // only turns the camera (bodyYaw is unchanged unless you move or aim), and the gun
    // chased it. Body basis means the low-ready pose is welded to the torso — look
    // wherever you like, the rifle sits on the hip exactly where it sat.
    //
    // No camera PITCH either: _camFwd carried it, so glancing at the sky lifted the
    // muzzle. A gun carried at the hip does not care where its owner's eyes are.
    // Pitch arrives with aimT, along with the rest of the camera's direction.
    _restDir.copy(_bodyFwd).multiplyScalar(0.50)
      .addScaledVector(UP, -0.60)
      .addScaledVector(_bodyRight, 0.45)
      .normalize();
    _poseDir.copy(_restDir).lerp(_camFwd, aimT).normalize();
    if (dip > 0) _poseDir.addScaledVector(UP, -0.35).normalize();

    _target.copy(_anchor).add(_poseDir);
    _mat.lookAt(_anchor, _target, UP);
    _q.setFromRotationMatrix(_mat);

    // muzzle rise + a shove back along the bore, both driven by the snap spring
    _right.set(1, 0, 0).applyQuaternion(_q);
    _qk.setFromAxisAngle(_right, snapX * 0.85);
    _q.premultiply(_qk);
    // a lazy roll when the gun is down, straightened as the player aims
    _qk.setFromAxisAngle(_poseDir, (1 - aimT) * 0.35 + (rl ? 0.5 : 0));
    _q.premultiply(_qk);

    model.group.quaternion.copy(_q);
    model.group.position.copy(_anchor).addScaledVector(_poseDir, -snapX * (d.recoil.kickBack / 0.03) * 0.6);
    model.group.updateMatrixWorld(true);
    model.muzzle.getWorldPosition(_muzzle);

    // ---- and the hands that are supposed to be on it ---------------------
    // Done here, after the pose and inside the same frame, so the grip the arms solve
    // for is the grip the gun is at right now — including this frame's recoil kick, so
    // the shoulders absorb the shot for free.
    model.grip.getWorldPosition(_grip);
    model.fore.getWorldPosition(_fore);
    _bore.set(0, 0, -1).applyQuaternion(model.group.quaternion);
    _hold.slide = model.slide ?? 0;
    _hold.weight = 1;
    // the support hand only comes up with the gun; at the hip the left arm swings free
    _hold.foreWeight = aimT;
    player.holdWeapon?.(dt, _hold);
  }

  // ----------------------------------------------------------------- system
  const api = {
    name: 'weapons',
    order: ORDER.WEAPONS,

    init(c) {
      ctx = c;
      world = c.get('world');
      player = c.get('player');
      loadout = c.get('loadout');
      creatures = c.get('creatures');
      rng = c.rng.fork(0x574541);

      for (const id of Object.keys(WEAPONS)) {
        const m = buildWeaponModel(id);
        if (!m) continue;
        m.group.visible = false;
        c.scene.add(m.group);
        models[id] = m;
        mag(id);
      }

      fx = createFX(c.scene, rng.fork(11));
      fx.setGround((x, z) => world?.heightAt?.(x, z) ?? 0);
      ledger = createWeakenLedger(c.bus);

      // A swap must cancel a reload, or a player can start a reload, switch to a sphere,
      // throw it, and have the magazine quietly finish loading inside their backpack.
      c.bus.on('loadout:change', ({ to }) => {
        if (rl && to !== rl.id) cancelReload('swapped');
        if (to !== 'pistol' && to !== 'rifle') { aiming = false; }
      });
    },

    update(dt, c) {
      const eq = loadout?.equipped?.() ?? 'none';
      const isGun = eq === 'pistol' || eq === 'rifle';
      if (eq !== curId) {
        curId = isGun ? eq : 'none';
        bloom = 0; cooldown = 0; dryCool = 0;
      }
      const gated = isGun && (loadout?.canAct?.() ?? true);
      const input = c.input;
      const d = def();

      // ---- aim: a state with an asymmetric ramp --------------------------
      const wantAim = !!(gated && input?.down('aim'));
      if (wantAim !== aiming) {
        aiming = wantAim;
        c.bus.emit('weapon:aim', { id: curId, aiming });
      }
      if (d) aimT = damp(aimT, aiming ? 1 : 0, aiming ? d.aimIn : d.aimOut, dt);
      else aimT = damp(aimT, 0, 8, dt);
      if (aimT < 1e-4) aimT = 0;

      // ---- timers ---------------------------------------------------------
      cooldown = Math.max(0, cooldown - dt);
      dryCool = Math.max(0, dryCool - dt);
      if (d) bloom *= Math.exp(-d.spread.recover * dt);
      if (bloom < 1e-3) bloom = 0;
      stepRecoil(dt);
      stepReload(dt);

      // ---- pose first, so the muzzle we fire from is this frame's muzzle ---
      poseWeapon(dt, c);

      // ---- trigger ---------------------------------------------------------
      if (gated && d && !rl) {
        const m = mag(d.id);
        const pull = d.auto ? input.down('fire') : input.justPressed('fire');
        if (pull && cooldown <= 0) {
          if (m.inMag > 0) fire(c);
          else if (dryCool <= 0) {
            // a dry trigger is an EVENT, not silence — the player must be told why
            // nothing happened, and told it once, not thirty times a second
            dryCool = 0.45;
            c.bus.emit('weapon:dry', { id: d.id, reserve: m.reserve });
          }
        }
        if (input.justPressed('reload')) startReload();
      } else if (!gated && rl) {
        cancelReload('unequipped');
      }

      // ---- everything that is still in the air ----------------------------
      fx.update(dt);
      ledger.update(dt);
    },

    // ---- public contract ---------------------------------------------------
    isAiming() { return aiming; },
    aimBlend() { return aimT; },
    spreadDeg() { return currentSpreadDeg(); },
    ammo() {
      const d = def();
      if (!d) return { inMag: 0, reserve: 0, magSize: 0 };
      const m = mag(d.id);
      return { inMag: m.inMag, reserve: m.reserve, magSize: d.magSize };
    },
    reloading() {
      if (!rl) return 0;
      const d = WEAPONS[rl.id];
      const done = PHASES.slice(0, rl.phaseIdx).reduce((a, p) => a + d.reload[p], 0);
      return clamp((done + rl.t) / rl.total, 0, 1);
    },
    reloadPhase() { return rl?.phase ?? null; },
    recoil() { return { pitch: snapX * 0.55 + climbX + driftP, yaw: yawX * 0.55 + driftY }; },
    moveScale() { const d = def(); return d ? 1 - (1 - d.moveScale) * aimT : 1; },
    weaponId() { return curId; },
    muzzlePoint(out = new THREE.Vector3()) { return out.copy(_muzzle); },

    // ---- the contract src/spheres/ consumes (see weaken.js) ----------------
    weakness(cr) { return ledger ? ledger.read(cr) : null; },
    catchBonus(cr) { return ledger ? ledger.catchBonus(cr) : 1; },
    isExhausted(cr) { return ledger ? ledger.isExhausted(cr) : false; },

    snapshot() {
      const a = api.ammo();
      return {
        built: true,
        equipped: curId,
        aiming, aimBlend: +aimT.toFixed(3),
        spreadDeg: +currentSpreadDeg().toFixed(2),
        bloom: +bloom.toFixed(2),
        ammo: a,
        reloading: +api.reloading().toFixed(3),
        phase: rl?.phase ?? null,
        shots: shotsFired,
        recoilPitchDeg: +((snapX * 0.55 + climbX + driftP) * RAD2DEG).toFixed(2),
        recoilYawDeg: +((yawX * 0.55 + driftY) * RAD2DEG).toFixed(2),
        lastSurface,
        firstShotAt: firstShotAt < 0 ? null : +firstShotAt.toFixed(2),
        fx: fx ? fx.stats() : null,
        weakened: ledger ? ledger.summary() : [],
      };
    },
  };

  return api;
}
