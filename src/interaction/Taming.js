import * as THREE from 'three';

/**
 * THE TAMING ARC.
 *
 * Not a progress bar with a button attached. Five earned beats, each one legible from
 * the creature's body language alone:
 *
 *   0 WILD      it has not registered you. Wanders on its own agenda.
 *   1 NOTICED   it stops, turns, watches. "?" over its head. Comfort ring is wide.
 *   2 CURIOUS   it will walk to food you throw down, but not while you are looming.
 *   3 TRUSTING  it holds ground while you close in, and will eat out of your hand.
 *   4 BONDED    tamed. Follows you.
 *
 * Trust is not monotonic. Standing still near a creature earns it; charging or sprinting
 * inside its comfort ring burns it and can knock a stage back off. That is the whole
 * point — trust you cannot lose is not trust.
 */

export const STAGES = ['wild', 'noticed', 'curious', 'trusting', 'bonded'];
export const STAGE_AT = [0, 0.001, 0.25, 0.55, 1.0];

const ENGAGE_RANGE = 20;
const NOTICE_RANGE = 13;

export function createTaming(ctx, { creatures, player, fx, bus }) {
  const rng = ctx.rng.fork(0x7a3ed);
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();
  const arc = [];   // human-readable beat log for the transcript

  function stateOf(cr) {
    if (!cr._tame) {
      cr._tame = {
        trust: cr.trust ?? 0,
        stage: 0,
        noticed: false,
        engaged: false,
        act: 'idle',       // idle | watch | shy | flee | toFood | eat | toHand | handEat | settle
        actT: 0,
        lastDist: 999,
        emoteCd: 0,
        spookCd: 0,
        petCd: 0,
        food: null,
        approachCd: rng.range(0.5, 2.5),
        gaugeT: 0,
        peak: 0,
      };
    }
    return cr._tame;
  }

  /**
   * Stages are sticky in two ways: you never fall back below "noticed" once a creature
   * has clocked you, and losing a stage needs you to fall a clear margin below the
   * threshold rather than jitter across it. Flapping stage transitions would spam the
   * event bus and make the arc read as noise rather than progress.
   */
  function stageFor(trust, current = 0) {
    let s = 0;
    for (let i = 0; i < STAGE_AT.length; i++) if (trust >= STAGE_AT[i]) s = i;
    if (s < current) {
      const need = STAGE_AT[current] - 0.05;
      if (trust >= need) s = current;
    }
    return Math.max(s, current > 0 ? 1 : 0);
  }

  /** comfort ring: how close you may get before the creature is uneasy */
  function comfortOf(cr, st) {
    const shy = cr.stats?.shy ?? cr.def?.shy ?? 0.4;
    return (2.2 + shy * 6.5) * (1 - st.trust * 0.72);
  }

  function emote(cr, kind, dur = 1.4) {
    const st = stateOf(cr);
    if (st.emoteCd > 0) return;
    st.emoteCd = 0.75;
    const h = (cr.stats?.size ?? cr.def?.size ?? 0.9);
    fx.emote(cr.root ?? cr.position, kind, { dur, height: h * 1.35 + 0.42, scale: 0.5 + h * 0.16 });
  }

  function addTrust(cr, delta, reason) {
    const st = stateOf(cr);
    const before = st.trust;
    const prevStage = st.stage;
    st.trust = THREE.MathUtils.clamp(st.trust + delta, 0, 1);
    cr.trust = st.trust;
    st.peak = Math.max(st.peak, st.trust);
    const s = stageFor(st.trust, prevStage);
    if (s !== prevStage) {
      st.stage = s;
      bus.emit('taming:stage', {
        creature: cr, stage: s, name: STAGES[s], prev: prevStage, up: s > prevStage, trust: st.trust,
      });
      if (s !== 1 || prevStage > 1) {
        arc.push(`${cr.def?.name ?? cr.species} -> ${STAGES[s]}${s > prevStage ? '' : ' (lost ground)'}`);
      }
      if (s > prevStage) {
        fx.ring(cr.position, { r0: 0.3, r1: 1.5 + s * 0.25, dur: 0.7, color: 0xffd98a, opacity: 0.8 });
        fx.burst(tmp.copy(cr.position).setY(cr.position.y + 0.5), { n: 12, color: 0xffe3a8, speed: 1.6, size: 0.075, life: 0.7, up: 1.2 });
        emote(cr, s >= 3 ? 'heart' : 'sparkle', 1.5);
      } else {
        emote(cr, 'alert', 1.2);
      }
    }
    if (delta !== 0 && Math.abs(delta) > 0.02) {
      bus.emit('taming:trust', { creature: cr, trust: st.trust, delta, reason });
    }
    return st.trust - before;
  }

  const api = {
    arc,
    stateOf,
    comfortOf,
    stageFor,
    addTrust,
    emote,
    /** the creature the arc is currently "about" */
    primary: null,

    /** food dropped on the ground that a creature may walk to */
    claimFood(cr, food) {
      const st = stateOf(cr);
      st.food = food;
      st.act = 'toFood';
      st.actT = 0;
      emote(cr, 'question', 1.1);
    },

    update(dt, opts) {
      const list = creatures?.list ?? [];
      const pp = player.position;
      const pSpeed = Math.hypot(player.velocity?.x ?? 0, player.velocity?.z ?? 0);
      let best = null, bestScore = -Infinity;

      for (const cr of list) {
        if (!cr || !cr.position) continue;
        const st = stateOf(cr);
        st.emoteCd = Math.max(0, st.emoteCd - dt);
        st.spookCd = Math.max(0, st.spookCd - dt);
        st.petCd = Math.max(0, st.petCd - dt);
        st.approachCd -= dt;

        const d = cr.position.distanceTo(pp);
        const closing = (st.lastDist - d) / Math.max(dt, 1e-4);
        st.lastDist = d;

        if (cr.tamed) { st.engaged = false; continue; }

        if (d > ENGAGE_RANGE && !st.food) {
          if (st.engaged) { st.engaged = false; st.act = 'idle'; }
          continue;
        }
        st.engaged = true;

        // ---- notice ------------------------------------------------------
        if (!st.noticed && d < NOTICE_RANGE) {
          st.noticed = true;
          addTrust(cr, 0.02, 'noticed');
          emote(cr, 'question', 1.5);
          bus.emit('taming:notice', { creature: cr, distance: d });
          arc.push(`${cr.def?.name ?? cr.species} noticed you at ${d.toFixed(1)}m`);
          st.act = 'watch'; st.actT = 0;
        }

        const comfort = comfortOf(cr, st);
        const inside = d < comfort;

        // ---- trust drift -------------------------------------------------
        if (st.act !== 'eat' && st.act !== 'handEat') {
          if (inside && pSpeed > 6.0) {
            // sprinting into its space: it bolts and you lose real ground
            if (st.spookCd <= 0) {
              st.spookCd = 1.6;
              const lost = -0.16 - st.trust * 0.2;
              addTrust(cr, lost, 'charged');
              bus.emit('taming:spook', { creature: cr, reason: 'charged', trustDelta: lost });
              emote(cr, 'alert', 1.2);
              fx.burst(tmp.copy(cr.position).setY(cr.position.y + 0.35), { n: 8, color: 0xffc266, speed: 2.4, size: 0.07, life: 0.45, up: 1.0 });
              arc.push(`${cr.def?.name ?? cr.species} bolted — you charged it`);
            }
            addTrust(cr, -0.22 * dt, 'charged');
            st.act = 'flee'; st.actT = 1.1;
          } else if (inside && closing > 2.0) {
            addTrust(cr, -0.05 * dt, 'crowded');
            if (st.act !== 'flee' && st.act !== 'toFood') { st.act = 'shy'; st.actT = 0.5; }
            if (st.spookCd <= 0) { st.spookCd = 2.4; emote(cr, 'alert', 1.0); }
          } else if (st.noticed && d < comfort * 2.1 && pSpeed < 1.2) {
            // patience is the mechanic: hold still and it settles
            addTrust(cr, 0.055 * dt, 'patient');
            if (st.act === 'flee' || st.act === 'shy') { st.act = 'watch'; st.actT = 0; }
            if (st.emoteCd <= 0 && rng.next() < dt * 0.35) emote(cr, st.trust > 0.5 ? 'note' : 'question', 1.3);
          }
        }

        // ---- behaviour ---------------------------------------------------
        st.actT -= dt;
        driveCreature(cr, st, dt, pp, d, comfort);

        // ---- pick the creature the HUD is about --------------------------
        const score = (st.trust * 30) + (st.noticed ? 8 : 0) - d;
        if (score > bestScore) { bestScore = score; best = cr; }
      }

      api.primary = best;
      // NOTE: trust readout is deliberately NOT drawn here. The UI system already owns
      // a reticle arc fed from creature.trust; two trust meters on screen is the single
      // most obvious "student project" tell. Everything this system shows in-world is
      // diegetic — emotes, body language, particles.
      return best;
    },

    /** hand-feed / toss resolution is driven from index.js; these are the outcomes */
    onEatFromGround(cr, food) {
      const st = stateOf(cr);
      st.act = 'eat'; st.actT = 1.5; st.food = null;
      cr.playAnim?.('eat');
      cr.mood = 'eating';
      const gained = addTrust(cr, 0.19, 'ate-thrown');
      fx.burst(tmp.copy(food.position).setY(food.position.y + 0.16), {
        n: 12, color: 0xff87a4, speed: 1.5, size: 0.08, life: 0.6, up: 1.4, debris: 4, debrisColor: 0xc0325a,
      });
      fx.ring(food.position, { r0: 0.2, r1: 1.2, dur: 0.6, color: 0xffc0cf, opacity: 0.7 });
      emote(cr, 'sparkle', 1.3);
      bus.emit('creature:fed', { creature: cr, trustDelta: gained, mode: 'thrown' });
      arc.push(`${cr.def?.name ?? cr.species} ate a berry you left for it`);
      return gained;
    },

    onEatFromHand(cr) {
      const st = stateOf(cr);
      st.act = 'handEat'; st.actT = 1.8;
      cr.playAnim?.('eat');
      cr.mood = 'eating';
      const gained = addTrust(cr, 0.27, 'ate-from-hand');
      tmp.copy(cr.position); tmp.y += (cr.stats?.size ?? 0.9) * 0.75;
      fx.burst(tmp, { n: 16, color: 0xffd0dd, speed: 1.4, size: 0.085, life: 0.75, up: 1.3, debris: 4, debrisColor: 0xc0325a });
      emote(cr, 'heart', 1.6);
      bus.emit('creature:fed', { creature: cr, trustDelta: gained, mode: 'hand' });
      arc.push(`${cr.def?.name ?? cr.species} ate from your hand`);
      return gained;
    },

    onPet(cr) {
      const st = stateOf(cr);
      st.act = 'settle'; st.actT = 1.0;
      st.petCd = 1.1;
      cr.playAnim?.('happy');
      const gained = addTrust(cr, 0.13, 'petted');
      tmp.copy(cr.position); tmp.y += (cr.stats?.size ?? 0.9) * 0.8;
      fx.burst(tmp, { n: 10, color: 0xffd6e2, speed: 1.0, size: 0.075, life: 0.8, up: 1.1 });
      emote(cr, 'heart', 1.4);
      bus.emit('creature:petted', { creature: cr, trustDelta: gained });
      return gained;
    },

    onSpookedByOffer(cr) {
      const st = stateOf(cr);
      st.act = 'flee'; st.actT = 1.2;
      st.spookCd = 1.5;
      const lost = addTrust(cr, -0.09, 'too-close-too-soon');
      emote(cr, 'alert', 1.2);
      bus.emit('taming:spook', { creature: cr, reason: 'too-close-too-soon', trustDelta: lost });
      arc.push(`${cr.def?.name ?? cr.species} shied away — you reached in too early`);
      return lost;
    },

    complete(cr) {
      const st = stateOf(cr);
      st.trust = 1; cr.trust = 1;
      cr.tamed = true;
      cr.mood = 'happy';
      st.stage = 4;
      st.engaged = false;
      cr.playAnim?.('happy');
      const h = (cr.stats?.size ?? 0.9);
      tmp.copy(cr.position); tmp.y += h * 0.8;
      fx.burst(tmp, { n: 26, color: 0xffe1a8, speed: 2.6, size: 0.1, life: 1.1, up: 2.0 });
      fx.burst(tmp, { n: 14, color: 0xff9dbb, speed: 1.6, size: 0.09, life: 1.3, up: 1.6 });
      fx.ring(cr.position, { r0: 0.3, r1: 3.4, dur: 1.0, color: 0xffe6b0, opacity: 0.95 });
      fx.ring(cr.position, { r0: 0.2, r1: 2.2, dur: 1.4, color: 0xffb0c8, opacity: 0.6 });
      fx.emote(cr.root ?? cr.position, 'heart', { dur: 2.4, height: h * 1.5 + 0.5, scale: 0.72 });
      fx.count(cr.position, `${cr.def?.name ?? 'Pal'}!`, '#ffd2e0');
      arc.push(`${cr.def?.name ?? cr.species} became your companion`);
      bus.emit('creature:tamed', { creature: cr });
    },
  };

  /**
   * Body language. Runs after the AI system, so whatever the AI wanted this frame is
   * replaced for creatures actively inside the arc — but only for those.
   */
  function driveCreature(cr, st, dt, pp, d, comfort) {
    const speed = cr.stats?.speed ?? 2.0;
    const move = cr.intent?.move;
    if (!move) return;

    const face = (target, rate = 8) => {
      tmp2.copy(target).sub(cr.position); tmp2.y = 0;
      if (tmp2.lengthSq() < 1e-5) return;
      const want = Math.atan2(-tmp2.x, -tmp2.z);
      cr.yaw = dampAngle(cr.yaw ?? 0, want, rate, dt);
      if (cr.root) cr.root.rotation.y = cr.yaw;
      if (cr.intent) cr.intent.look = tmp2.clone().add(cr.position);
    };

    switch (st.act) {
      case 'flee': {
        tmp2.copy(cr.position).sub(pp).setY(0);
        if (tmp2.lengthSq() < 1e-4) tmp2.set(1, 0, 0);
        tmp2.normalize().multiplyScalar(speed * 1.8);
        move.copy(tmp2);
        cr.mood = 'afraid';
        cr.playAnim?.('run');
        if (st.actT <= 0) { st.act = 'watch'; st.actT = 1.4; }
        break;
      }
      case 'shy': {
        tmp2.copy(cr.position).sub(pp).setY(0).normalize().multiplyScalar(speed * 0.55);
        move.copy(tmp2);
        cr.mood = 'wary';
        cr.playAnim?.('walk');
        if (st.actT <= 0) { st.act = 'watch'; st.actT = 1.2; }
        break;
      }
      case 'toFood': {
        const f = st.food;
        if (!f || f.dead) { st.act = 'watch'; st.actT = 1; break; }
        tmp2.copy(f.position).sub(cr.position).setY(0);
        const fd = tmp2.length();
        cr.mood = 'curious';
        face(f.position, 6);
        if (fd < 0.55) {
          move.set(0, 0, 0);
          st.act = 'eat'; st.actT = 0.35;
          st._eatFood = f;
        } else {
          move.copy(tmp2.normalize()).multiplyScalar(speed * (fd > 3 ? 0.62 : 0.4));
          cr.playAnim?.('walk');
        }
        break;
      }
      case 'eat': {
        move.set(0, 0, 0);
        cr.mood = 'eating';
        cr.playAnim?.('eat');
        if (st.actT <= 0) { st.act = 'watch'; st.actT = 1.6; }
        break;
      }
      case 'toHand': {
        tmp2.copy(pp).sub(cr.position).setY(0);
        const hd = tmp2.length();
        face(pp, 9);
        cr.mood = 'curious';
        if (hd < 1.35) { move.set(0, 0, 0); cr.playAnim?.('idle'); }
        else { move.copy(tmp2.normalize()).multiplyScalar(speed * 0.5); cr.playAnim?.('walk'); }
        if (st.actT <= 0) { st.act = 'watch'; st.actT = 1.5; }
        break;
      }
      case 'handEat': {
        move.set(0, 0, 0);
        face(pp, 10);
        cr.mood = 'eating';
        cr.playAnim?.('eat');
        if (st.actT <= 0) { st.act = 'settle'; st.actT = 1.4; }
        break;
      }
      case 'settle': {
        move.set(0, 0, 0);
        face(pp, 6);
        cr.mood = 'happy';
        cr.playAnim?.('idle');
        if (st.actT <= 0) { st.act = 'watch'; st.actT = 1.8; }
        break;
      }
      case 'watch': {
        cr.mood = st.trust > 0.5 ? 'calm' : 'curious';
        face(pp, 5);
        // once it trusts you a little it will close the gap on its own — the single
        // clearest read that the arc is moving, because IT approaches YOU
        if (st.trust > 0.22 && d > 2.4 && st.approachCd <= 0) {
          move.copy(tmp2.copy(pp).sub(cr.position).setY(0).normalize()).multiplyScalar(speed * 0.3 * (0.4 + st.trust));
          cr.playAnim?.('walk');
        } else {
          move.set(0, 0, 0);
          cr.playAnim?.('idle');
          if (st.approachCd <= 0) st.approachCd = rng.range(1.2, 3.0);
        }
        if (st.actT <= 0) { st.actT = rng.range(1.0, 2.4); }
        break;
      }
      default:
        // stage 0 / not noticed: leave it entirely to the AI system
        break;
    }
  }

  return api;
}

function dampAngle(a, b, lambda, dt) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * (1 - Math.exp(-lambda * dt));
}
