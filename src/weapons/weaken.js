import * as THREE from 'three';

/**
 * THE WEAKEN LEDGER — the only thing a gun is allowed to do to a creature.
 *
 * This module exists to make one rule impossible to break by accident: **nothing here
 * can kill anything.** There is no health, no death state, no corpse and no "remove from
 * list" path in this file, and there never should be. A creature that takes fire loses
 * STAMINA; a creature at zero stamina is EXHAUSTED — winded, sitting down, easy to
 * befriend — and further rounds do nothing to it but rock it on its feet. That is the
 * Palworld loop, and it is the only reason firearms belong in a game about making
 * friends with the wildlife.
 *
 * WHAT THE SPHERE SYSTEM CONSUMES (src/spheres/ is owned by another builder):
 *
 *   ctx.get('weapons').weakness(creature)
 *     -> { stamina, weakened, exhausted, stagger, sinceHit, hits }
 *   ctx.get('weapons').catchBonus(creature)   -> 1.0 .. ~3.2 multiplier
 *   ctx.get('weapons').isExhausted(creature)  -> boolean
 *
 * and, mirrored onto the creature record itself so a peer that already has the object in
 * hand does not need a second lookup:
 *
 *   creature.stamina01  0..1   1 = fresh, 0 = spent
 *   creature.weakened   bool   stamina < 0.55 — visibly tiring
 *   creature.exhausted  bool   stamina <= 0 — sit-down tired, the capture window
 *   creature.staggerT   0..1   transient, decays in ~0.4 s after each hit
 *
 * Stamina regenerates. A creature you shot and then walked away from is back on its feet
 * inside half a minute, so the weapon buys a WINDOW rather than a permanent state — which
 * is what stops "shoot everything first" from being the dominant strategy.
 */

const REGEN_DELAY = 5.0;      // seconds after the last hit before recovery starts
const REGEN_RATE = 0.055;     // stamina per second once it does
const EXHAUST_CLEAR = 0.30;   // stamina at which `exhausted` lifts
const WEAK_AT = 0.55;
const STAGGER_DECAY = 3.0;    // 1/s
const KNOCK_DECAY = 7.0;      // 1/s

const _kb = new THREE.Vector3();

export function createWeakenLedger(bus) {
  /** creature.id -> record. Keyed by id, not by object, so a despawn cannot leak. */
  const book = new Map();
  const touched = [];          // creatures with a live flinch, so idle ones cost nothing

  function rec(cr) {
    let r = book.get(cr.id);
    if (!r) {
      r = {
        id: cr.id, cr, stamina: 1, stagger: 0, hits: 0, sinceHit: 999,
        exhausted: false, kb: new THREE.Vector3(),
        basedRead: false, baseX: 0, baseZ: 0,
      };
      book.set(cr.id, r);
    }
    r.cr = cr;
    return r;
  }

  const api = {
    /**
     * Register a hit. `damage` is in stamina units (0..1); `dir` is the shot axis, used
     * for knockback. Returns the record so the caller can put real numbers on the bus.
     */
    hit(cr, damage, dir, stagger = 0.5, knock = 1.2) {
      const r = rec(cr);
      const size = cr.def?.size ?? 1;
      // a bigger animal soaks more: the same round takes a third longer on a Mosshorn
      const eff = damage / Math.max(0.6, size);
      const before = r.stamina;
      r.stamina = Math.max(0, r.stamina - eff);
      r.hits++;
      r.sinceHit = 0;
      r.stagger = Math.min(1, r.stagger + stagger);
      r.kb.addScaledVector(dir, knock / Math.max(0.6, size));
      r.absorbed = before <= 0;          // already spent: the round only rocks it

      if (!r.exhausted && r.stamina <= 0) {
        r.exhausted = true;
        bus?.emit('creature:exhausted', { creature: cr, id: cr.id });
      }
      bus?.emit('creature:weakened', {
        creature: cr, id: cr.id,
        stamina: +r.stamina.toFixed(3),
        drained: +(before - r.stamina).toFixed(3),
        exhausted: r.exhausted,
      });
      mirror(cr, r);
      if (!touched.includes(cr)) touched.push(cr);
      return r;
    },

    /** the whole ledger entry for a creature, allocation-free */
    read(cr) {
      if (!cr) return null;
      const r = book.get(cr.id);
      if (!r) return { stamina: 1, weakened: false, exhausted: false, stagger: 0, sinceHit: 999, hits: 0 };
      return {
        stamina: r.stamina,
        weakened: r.stamina < WEAK_AT,
        exhausted: r.exhausted,
        stagger: r.stagger,
        sinceHit: r.sinceHit,
        hits: r.hits,
      };
    },

    /**
     * How much easier this creature is to hold, as a multiplier the sphere system can
     * fold straight into its shake odds. 1.0 = untouched. ~3.2 = exhausted and
     * still reeling from the last round.
     */
    catchBonus(cr) {
      const r = cr && book.get(cr.id);
      if (!r) return 1;
      return 1 + (1 - r.stamina) * 1.3 + (r.exhausted ? 0.6 : 0) + r.stagger * 0.35;
    },

    isExhausted(cr) { return !!(cr && book.get(cr.id)?.exhausted); },

    /**
     * Per-frame: decay stagger and knockback, regenerate stamina, and apply the visible
     * flinch. The flinch is applied HERE, in the weapons system's own update slot (which
     * runs after the creature system has posed everything for this frame), by writing
     * only to channels the creature system leaves alone: `pose.rotation.x/z` and the
     * horizontal component of `position`. It never touches `cr.yaw`, `cr.intent` or
     * `pose.rotation.y`, so it cannot fight animation or navigation — and it restores
     * the pose it found the moment the flinch is spent.
     */
    update(dt) {
      for (const r of book.values()) {
        r.sinceHit += dt;
        if (r.sinceHit > REGEN_DELAY && r.stamina < 1) {
          r.stamina = Math.min(1, r.stamina + REGEN_RATE * dt);
          if (r.exhausted && r.stamina > EXHAUST_CLEAR) {
            r.exhausted = false;
            bus?.emit('creature:recovered', { creature: r.cr, id: r.id, stamina: r.stamina });
          }
          // Mirror on every change, not only on a hit. Getting this wrong once meant a
          // creature's stamina recovered inside the ledger while `creature.stamina01`
          // stayed frozen at whatever it was when the last round landed — so the sphere
          // system would have read a permanently weakened animal that was long since
          // back on its feet.
          if (r.cr) mirror(r.cr, r);
        }
        r.stagger *= Math.exp(-STAGGER_DECAY * dt);
        if (r.stagger < 0.002) r.stagger = 0;
      }

      for (let i = touched.length - 1; i >= 0; i--) {
        const cr = touched[i];
        const r = book.get(cr.id);
        if (!r) { touched.splice(i, 1); continue; }

        // knockback: shove along the shot axis, decaying fast. Horizontal only — the
        // creature system re-seats y on the ground every frame anyway.
        const k = Math.exp(-KNOCK_DECAY * dt);
        _kb.copy(r.kb);
        r.kb.multiplyScalar(k);
        if (cr.position) {
          cr.position.x += _kb.x * dt;
          cr.position.z += _kb.z * dt;
        }

        // flinch: a duck and a roll away from the impact
        const pose = cr.pose;
        if (pose) {
          if (!r.basedRead) { r.baseX = pose.rotation.x; r.baseZ = pose.rotation.z; r.basedRead = true; }
          const s = r.stagger;
          pose.rotation.x = r.baseX - s * 0.30;
          pose.rotation.z = r.baseZ + Math.sign(_kb.x || 1) * s * 0.22;
        }

        mirror(cr, r);

        if (r.stagger === 0 && r.kb.lengthSq() < 1e-6) {
          if (pose && r.basedRead) { pose.rotation.x = r.baseX; pose.rotation.z = r.baseZ; r.basedRead = false; }
          r.kb.set(0, 0, 0);
          touched.splice(i, 1);
        }
      }
    },

    /** for snapshot(): only the creatures that are actually carrying something */
    summary() {
      const out = [];
      for (const [id, r] of book) {
        if (r.stamina >= 0.999 && r.stagger === 0) continue;
        out.push({ id, stamina: +r.stamina.toFixed(2), hits: r.hits, exhausted: r.exhausted, stagger: +r.stagger.toFixed(2) });
      }
      return out;
    },

    size() { return book.size; },
  };

  function mirror(cr, r) {
    cr.stamina01 = r.stamina;
    cr.weakened = r.stamina < WEAK_AT;
    cr.exhausted = r.exhausted;
    cr.staggerT = r.stagger;
  }

  return api;
}
