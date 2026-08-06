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
 *   weapon:hit      { creature, damage }        (+ id, species, stamina, exhausted)
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
  const _hand = new THREE.Vector3();
  const _anchor = new THREE.Vector3();
  const _aimAnchor = new THREE.Vector3();
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

    // ---- the only thing a gun does to a creature --------------------------
    if (trace.creature) {
      const rec = ledger.hit(trace.creature, d.damage, _dir, d.stagger, d.knockback);
      ctx.bus.emit('weapon:hit', {
        creature: trace.creature,
        id: trace.creature.id,
        species: trace.creature.species,
        damage: +d.damage.toFixed(3),
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
    if (!model || !player) return;

    const cam = c.camera;
    cam.getWorldDirection(_camFwd).normalize();
    _camRight.crossVectors(_camFwd, UP).normalize();
    _camUp.crossVectors(_camRight, _camFwd).normalize();

    // ---- where the gun sits ---------------------------------------------
    player.handPosition(_hand);
    // The aim pose is a shoulder pose, built off the PLAYER, not off the camera: the
    // camera is 2.3 m behind the avatar's back, so anything anchored to it floats.
    //
    // The offsets are large for a reason. The first version sat the receiver 0.26 m in
    // front of the chest and 0.24 m to the right — geometrically a perfectly good
    // shoulder pose, and completely invisible, because the camera is directly behind the
    // avatar and the avatar's own torso occluded the entire weapon. In a third-person
    // shooter the gun has to clear the body silhouette or the player has no idea what
    // they are holding. 0.40 m forward puts the receiver past the chest, and the right
    // offset walks it toward the camera's own 0.70 m shoulder line.
    _aimAnchor.copy(player.position)
      .addScaledVector(UP, 1.42)
      .addScaledVector(_camRight, 0.32)
      .addScaledVector(_camFwd, 0.40);
    const raise = loadout?.swapProgress?.() ?? 1;
    _anchor.copy(_hand).lerp(_aimAnchor, aimT);
    // a reload drops the gun out of the aim line, and so does a swap still playing out
    const dip = rl ? (rl.phaseIdx < 2 ? 0.16 : 0.09) : 0;
    _anchor.y -= dip + (1 - raise) * 0.35;

    // ---- where it points -------------------------------------------------
    _restDir.copy(_camFwd).addScaledVector(UP, -0.62).normalize();   // low ready
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
