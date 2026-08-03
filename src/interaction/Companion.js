import * as THREE from 'three';

/**
 * COMPANION — what a tamed creature does afterwards. The promise the taming arc makes is
 * "this one is yours now", and it is broken instantly if the thing gets stuck on a hill
 * or slides along behind you like a trailer.
 *
 * Rules: keep a loose slot beside/behind the player, match speed rather than teleport-lag,
 * stop and look at you when you stop, react when you sprint, and if the world ever
 * separates you, catch up out of frame rather than stand there being sad.
 */
export function createCompanion(ctx, { player, world, fx, bus }) {
  const rng = ctx.rng.fork(0x3c0de);
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();
  const members = [];

  function slotFor(i, yaw) {
    // fan out behind the player, alternating sides
    const side = i % 2 === 0 ? 1 : -1;
    const rank = Math.floor(i / 2);
    const back = 2.1 + rank * 1.25;
    const lat = side * (1.15 + rank * 0.5);
    return tmp.set(
      Math.cos(yaw) * lat - Math.sin(yaw) * -back,
      0,
      -Math.sin(yaw) * lat - Math.cos(yaw) * -back);
  }

  return {
    members,

    add(cr) {
      if (members.includes(cr)) return;
      members.push(cr);
      cr._comp = {
        t: rng.next() * 4, idleT: rng.range(2, 5), lost: 0, cheerCd: 2,
        // The first four seconds of being someone's are not "walk in formation". It bounds
        // a full circle around you, and that lap is the only time any creature in the game
        // does it — the payoff has a body language of its own.
        greet: 4.2,
        // and then it starts earning its keep: a companion noses out berries and brings
        // them to you. The verb that made it yours is the verb it gives back.
        giftT: rng.range(8, 11), forage: 0,
      };
      bus.emit('companion:joined', { creature: cr, count: members.length });
    },

    /** Q — call them in; they perk up and close the gap */
    call() {
      if (!members.length) return false;
      for (const cr of members) {
        const c = cr._comp; if (!c) continue;
        c.idleT = 0;
        c.cheerCd = 0.001;
      }
      bus.emit('companion:called', { count: members.length });
      return true;
    },

    update(dt) {
      if (!members.length) return;
      const pp = player.position;
      const pyaw = player.yaw ?? 0;
      const pSpeed = Math.hypot(player.velocity?.x ?? 0, player.velocity?.z ?? 0);

      for (let i = 0; i < members.length; i++) {
        const cr = members[i];
        if (!cr || !cr.position || !cr.intent) continue;
        const c = cr._comp || (cr._comp = { t: 0, idleT: 3, lost: 0, cheerCd: 2, greet: 0, giftT: 20, forage: 0 });
        c.t += dt; c.cheerCd -= dt;

        // ---- the lap of honour, once, at the moment it becomes yours -------
        if (c.greet > 0) {
          c.greet -= dt;
          const ang = pyaw + (4.2 - c.greet) * 3.1;
          const gx = pp.x + Math.sin(ang) * 2.0, gz = pp.z + Math.cos(ang) * 2.0;
          tmp2.set(gx - cr.position.x, 0, gz - cr.position.z);
          const speedG = (cr.stats?.speed ?? 2.4) * 2.1;
          if (tmp2.lengthSq() > 1e-4) cr.intent.move.copy(tmp2.normalize()).multiplyScalar(speedG);
          tmp2.copy(pp).sub(cr.position); tmp2.y = 0;
          if (tmp2.lengthSq() > 1e-4) {
            cr.yaw = dampAngle(cr.yaw ?? 0, Math.atan2(-tmp2.x, -tmp2.z), 10, dt);
            if (cr.root) cr.root.rotation.y = cr.yaw;
            if (cr.intent) cr.intent.look = tmp2.clone().add(cr.position);
          }
          cr.mood = 'happy';
          cr.playAnim?.('run');
          if (c.greet <= 0) {
            cr.playAnim?.('happy');
            const h0 = (cr.stats?.size ?? 0.9) * 1.35 + 0.4;
            fx.emote(cr.root ?? cr.position, 'heart', { dur: 1.8, height: h0, scale: 0.62 });
          }
          continue;
        }

        // ---- foraging: it brings you berries ------------------------------
        const dP = cr.position.distanceTo(pp);
        if (c.forage > 0) {
          c.forage -= dt;
          cr.intent.move.set(0, 0, 0);
          cr.mood = 'eating';
          cr.playAnim?.('eat');
          if (c.forage <= 0) {
            const h0 = (cr.stats?.size ?? 0.9) * 1.35 + 0.4;
            cr.playAnim?.('happy');
            cr.mood = 'happy';
            fx.emote(cr.root ?? cr.position, 'heart', { dur: 1.4, height: h0, scale: 0.55 });
            fx.burst(tmp2.copy(cr.position).setY(cr.position.y + (cr.stats?.size ?? 0.9) * 0.6),
              { n: 12, color: 0xff87a4, speed: 1.4, size: 0.08, life: 0.65, up: 1.3, debris: 3, debrisColor: 0xc0325a });
            bus.emit('companion:gift', { creature: cr, item: 'berry', amount: 1, position: cr.position.clone() });
          }
          continue;
        }
        c.giftT -= dt;
        if (c.giftT <= 0 && dP < 16) {
          c.giftT = rng.range(16, 23);
          c.forage = 1.5;
          continue;
        }

        const slot = slotFor(i, pyaw).add(pp);
        slot.y = world?.heightAt?.(slot.x, slot.z) ?? pp.y;

        tmp2.copy(slot).sub(cr.position); tmp2.y = 0;
        const d = tmp2.length();
        const dPlayer = cr.position.distanceTo(pp);
        const speed = cr.stats?.speed ?? 2.4;

        // stuck / left behind — recover out of sight rather than pathfind
        if (dPlayer > 22) {
          c.lost += dt;
          if (c.lost > 2.2) {
            c.lost = 0;
            const a = pyaw + Math.PI + rng.range(-0.5, 0.5);
            const nx = pp.x + Math.sin(a) * 3.2, nz = pp.z + Math.cos(a) * 3.2;
            fx.burst(cr.position, { n: 8, color: 0xdfe8f0, speed: 1.4, size: 0.08, life: 0.5, up: 1.0 });
            cr.position.set(nx, world?.heightAt?.(nx, nz) ?? pp.y, nz);
            fx.burst(cr.position, { n: 10, color: 0xffe0b0, speed: 1.6, size: 0.08, life: 0.5, up: 1.2 });
            bus.emit('companion:caughtup', { creature: cr });
          }
        } else c.lost = 0;

        if (d > 1.05) {
          // match the player's pace instead of a fixed trot: reads as "keeping up"
          const urgency = THREE.MathUtils.clamp((d - 0.9) / 3.0, 0, 1);
          const want = THREE.MathUtils.clamp(pSpeed * 1.06 + urgency * 2.2, 0.9, speed * 2.3);
          cr.intent.move.copy(tmp2.normalize()).multiplyScalar(want);
          cr.mood = 'happy';
          cr.playAnim?.(want > speed * 1.15 ? 'run' : 'walk');
          c.idleT = rng.range(2.2, 5.0);
        } else {
          cr.intent.move.set(0, 0, 0);
          // stopped: turn and look at you, occasionally do something with an attitude
          tmp2.copy(pp).sub(cr.position); tmp2.y = 0;
          if (tmp2.lengthSq() > 1e-4) {
            const wantYaw = Math.atan2(-tmp2.x, -tmp2.z);
            cr.yaw = dampAngle(cr.yaw ?? 0, wantYaw, 6, dt);
            if (cr.root) cr.root.rotation.y = cr.yaw;
            if (cr.intent) cr.intent.look = tmp2.clone().add(cr.position);
          }
          c.idleT -= dt;
          if (c.idleT <= 0) {
            c.idleT = rng.range(2.6, 6.0);
            const pick = rng.next();
            if (pick < 0.4) { cr.playAnim?.('happy'); cr.mood = 'happy'; }
            else if (pick < 0.7) { cr.playAnim?.('idle'); cr.mood = 'calm'; }
            else { cr.playAnim?.('eat'); cr.mood = 'eating'; }
          }
        }

        if (c.cheerCd <= 0) {
          c.cheerCd = rng.range(7, 14);
          const h = (cr.stats?.size ?? 0.9) * 1.35 + 0.4;
          fx.emote(cr.root ?? cr.position, rng.next() < 0.55 ? 'heart' : 'note', { dur: 1.5, height: h, scale: 0.5 });
          cr.playAnim?.('happy');
        }
      }
    },

    snapshot() {
      return members.map((c) => ({
        id: c.id, species: c.species,
        dist: +c.position.distanceTo(player.position).toFixed(1),
      }));
    },
  };
}

function dampAngle(a, b, lambda, dt) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * (1 - Math.exp(-lambda * dt));
}
