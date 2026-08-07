import { ORDER } from '../engine/Game.js';

/**
 * VITALS — the traveller's three meters: vigour (red), focus (blue), stamina (green).
 *
 * Requested as "an Elden Ring bar cluster", and built as one: three stacked meters that
 * every other system spends against, so what the bars show is the simulation and not a
 * decoration that happens to move. src/ui draws them; this file owns the numbers.
 *
 * NO DEATH. That is a project non-negotiable (see CLAUDE.md) and it is not weakened
 * here: vigour reaching zero does NOT kill the traveller. It collapses them — winded,
 * on one knee, movement locked for `COLLAPSE_TIME` seconds — and then they get up with
 * `RECOVER_TO` of their vigour back. There is no death screen, no respawn and no
 * corpse anywhere in this system, and none may be added. A creature can still only be
 * befriended, staggered or exhausted; nothing here changes that either.
 *
 * WHAT SPENDS WHAT
 *   stamina  sprinting (per second), a jump, a sphere throw. Empty = you cannot sprint
 *            again until it recovers past `EXHAUST_CLEAR` — the usual lockout, so a
 *            player who runs themselves flat has to walk it off rather than stutter.
 *   focus    a sphere throw, and holding a weapon aimed (concentration). This is the
 *            one meter that GATES an action: with less than a throw's worth of focus
 *            the sphere stays in the satchel and the UI says so.
 *   vigour   falls. Regenerates slowly a while after the last hit, and a berry eaten
 *            from the satchel is worth `BERRY_HEAL`.
 *
 * PUBLIC CONTRACT (peers reach this with `ctx.get('vitals')`)
 *   healthT() / focusT() / staminaT()  -> 0..1 for the bars
 *   health() / focus() / stamina()     -> absolute, and max<X>() for each
 *   canSprint() / canJump()            -> gates for src/player
 *   spend(kind, amount)                -> all-or-nothing; false if it would go negative
 *   drain(kind, amount)                -> takes what is there, returns how much it took
 *   damage(amount, cause) / heal(amount, why)
 *   collapsed() -> 0..1 through the collapse, or 0
 *
 * EVENTS
 *   vitals:damage  { amount, cause, health }
 *   vitals:heal    { amount, why, health }
 *   vitals:empty   { kind }              a meter just hit zero
 *   vitals:collapse{ cause }             vigour ran out — winded, never dead
 *   vitals:recover { health }            back on their feet
 *
 * Determinism: every number below is driven by the fixed-step `dt` and by events other
 * systems already emit. No rng, no wall clock, so a capture at N simulated seconds is
 * byte-stable — which is the only reason the round-over-round A/B works at all.
 */

const MAX = { health: 100, focus: 80, stamina: 100 };

const COST = {
  sprintPerSec: 16,
  jump: 14,
  throwStamina: 12,
  throwFocus: 20,
  aimFocusPerSec: 3.5,
};

const REGEN = {
  // delay before a meter starts coming back, and the rate once it does
  staminaDelay: 0.65, staminaRate: 26,
  focusDelay: 1.6, focusRate: 8,
  healthDelay: 6.0, healthRate: 1.6,
};

const EXHAUST_CLEAR = 30;      // stamina needed to sprint again after bottoming out
const COLLAPSE_TIME = 3.2;
const RECOVER_TO = 0.45;       // fraction of max vigour you stand up with
const BERRY_HEAL = 28;

/**
 * FALL DAMAGE. `player:land` carries the impact speed in m/s. The jump apex lands at
 * about 7.4 m/s, so the floor sits above that with room to spare — a player who is
 * simply jumping around must never chip their own vigour, or the bar teaches them that
 * the traversal they were given is a mistake.
 */
const FALL = { free: 9.0, perMS: 7.5 };

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

export function createVitals() {
  let ctx, player, weapons, ui, interaction;

  const cur = { health: MAX.health, focus: MAX.focus, stamina: MAX.stamina };
  const since = { health: 99, focus: 99, stamina: 99 };   // seconds since last spend
  let exhausted = false;                                  // stamina lockout latch
  let collapse = 0;                                       // seconds left on the ground
  let collapseCause = null;
  let lastDamage = 0;                                     // for the UI's damage flash
  let taughtBerry = false;                                // the "you can eat those" line
  const stats = { damage: 0, falls: 0, collapses: 0, berriesEaten: 0, throwsBlocked: 0 };

  function emptyCheck(kind, was) {
    if (was > 0 && cur[kind] <= 0) ctx?.bus?.emit('vitals:empty', { kind });
  }

  function take(kind, amount) {
    const was = cur[kind];
    cur[kind] = clamp(was - amount, 0, MAX[kind]);
    since[kind] = 0;
    emptyCheck(kind, was);
    return was - cur[kind];
  }

  function collapseNow(cause) {
    if (collapse > 0) return;
    collapse = COLLAPSE_TIME;
    collapseCause = cause;
    stats.collapses++;
    cur.stamina = 0;
    ctx?.bus?.emit('vitals:collapse', { cause });
    // Say it in words too. A bar emptying tells a player something bad happened; only
    // the line tells them it is survivable, which in a game with no death is the whole
    // point and cannot be left to inference.
    ui?.notify?.('You go down winded. Give it a moment.', { ttl: 3.6 });
  }

  const api = {
    name: 'vitals',
    order: ORDER.VITALS,

    // ---- read ------------------------------------------------------------
    health() { return cur.health; }, maxHealth() { return MAX.health; },
    focus() { return cur.focus; }, maxFocus() { return MAX.focus; },
    stamina() { return cur.stamina; }, maxStamina() { return MAX.stamina; },
    healthT() { return cur.health / MAX.health; },
    focusT() { return cur.focus / MAX.focus; },
    staminaT() { return cur.stamina / MAX.stamina; },
    /** 0 when up, otherwise 0..1 through the collapse (1 = just went down) */
    collapsed() { return collapse > 0 ? collapse / COLLAPSE_TIME : 0; },
    exhausted() { return exhausted; },
    /** seconds since the last hit landed — the UI flashes the bar off this */
    sinceDamage() { return since.health; },
    lastDamage() { return lastDamage; },
    costs() { return { ...COST }; },

    // ---- gates -----------------------------------------------------------
    canSprint() { return !collapse && !exhausted && cur.stamina > 1; },
    canJump() { return !collapse && cur.stamina >= COST.jump; },
    canThrow() { return !collapse && cur.focus >= COST.throwFocus; },

    // ---- spend -----------------------------------------------------------
    /** all-or-nothing: discrete costs (a jump, a throw) either happen or do not */
    spend(kind, amount) {
      if (collapse > 0 || !(kind in cur)) return false;
      if (cur[kind] < amount) return false;
      take(kind, amount);
      // The latch trips just ABOVE zero, not at it. `canSprint()` refuses below 1, so a
      // sprint always stops with a sliver left and an exact-zero test never fired —
      // the lockout existed in the code and never once happened in play.
      if (kind === 'stamina' && cur.stamina <= 1) exhausted = true;
      return true;
    },
    /** take what is there: continuous costs (a second of sprinting) never half-apply */
    drain(kind, amount) {
      if (!(kind in cur)) return 0;
      const got = take(kind, amount);
      // The latch trips just ABOVE zero, not at it. `canSprint()` refuses below 1, so a
      // sprint always stops with a sliver left and an exact-zero test never fired —
      // the lockout existed in the code and never once happened in play.
      if (kind === 'stamina' && cur.stamina <= 1) exhausted = true;
      return got;
    },

    damage(amount, cause = 'hit') {
      if (amount <= 0 || collapse > 0) return 0;
      const got = take('health', amount);
      lastDamage = got;
      stats.damage += got;
      ctx?.bus?.emit('vitals:damage', { amount: +got.toFixed(1), cause, health: +cur.health.toFixed(1) });
      // The satchel is bait AND food, and nothing on screen says so. Said once, the
      // first time it matters — a key the player never learns is a key that does not
      // exist, and a red bar with no answer is just an anxiety meter.
      if (!taughtBerry && cur.health > 0 && cur.health < MAX.health * 0.6) {
        taughtBerry = true;
        ui?.notify?.('Hurt. Press B to eat a berry.', { ttl: 5.0 });
      }
      if (cur.health <= 0) collapseNow(cause);
      return got;
    },

    heal(amount, why = 'rest') {
      if (amount <= 0) return 0;
      const was = cur.health;
      cur.health = clamp(was + amount, 0, MAX.health);
      const got = cur.health - was;
      if (got > 0.01) ctx?.bus?.emit('vitals:heal', { amount: +got.toFixed(1), why, health: +cur.health.toFixed(1) });
      return got;
    },

    /** eat a berry from the satchel; returns false if there is none or it would waste it */
    eatBerry() {
      // Down is down: no eating your way out of a collapse. update() also returns before
      // the key is ever read while collapsed, so this is the belt to that braces.
      if (collapse > 0) return false;
      const inv = interaction?.inventory;
      if (!inv || (inv.berry ?? 0) <= 0) {
        ui?.notify?.('No berries left to eat.', { ttl: 2.4 });
        return false;
      }
      if (cur.health >= MAX.health - 0.5) {
        ui?.notify?.('Not hurt. Save it for a creature.', { ttl: 2.4 });
        return false;
      }
      interaction.consume?.('berry', 1);
      api.heal(BERRY_HEAL, 'berry');
      stats.berriesEaten++;
      return true;
    },

    // ---- system ----------------------------------------------------------
    init(c) {
      ctx = c;
      player = c.get('player');
      interaction = c.get('interaction');

      /**
       * Fall damage is taken off the event the player system ALREADY emits rather than
       * off a velocity this system samples itself. Sampling would double-count: the
       * landing frame is also the frame the player zeroes velocity.y, so whether a
       * sampler sees 20 m/s or 0 depends purely on system order.
       */
      c.bus.on('player:land', ({ impact }) => {
        const over = (impact ?? 0) - FALL.free;
        if (over <= 0) return;
        stats.falls++;
        api.damage(over * FALL.perMS, 'fall');
      });
    },

    update(dt, c) {
      weapons = weapons ?? c.get('weapons');
      ui = ui ?? c.get('ui');
      interaction = interaction ?? c.get('interaction');
      player = player ?? c.get('player');

      // ---- collapse ------------------------------------------------------
      if (collapse > 0) {
        collapse = Math.max(0, collapse - dt);
        // recover on a ramp so the bars visibly refill while the traveller gets up
        cur.health = Math.max(cur.health, MAX.health * RECOVER_TO * (1 - collapse / COLLAPSE_TIME));
        cur.stamina = Math.max(cur.stamina, MAX.stamina * 0.5 * (1 - collapse / COLLAPSE_TIME));
        if (collapse === 0) {
          exhausted = false;
          ctx.bus.emit('vitals:recover', { health: +cur.health.toFixed(1), cause: collapseCause });
          ui?.notify?.('Back on your feet.', { ttl: 2.6 });
        }
        return;
      }

      for (const k in since) since[k] += dt;

      // ---- concentration: a raised weapon burns focus ---------------------
      const aim = weapons?.aimBlend?.() ?? 0;
      if (aim > 0.05) api.drain('focus', COST.aimFocusPerSec * aim * dt);

      // ---- regeneration ---------------------------------------------------
      if (since.stamina > REGEN.staminaDelay) {
        cur.stamina = clamp(cur.stamina + REGEN.staminaRate * dt, 0, MAX.stamina);
      }
      if (since.focus > REGEN.focusDelay) {
        cur.focus = clamp(cur.focus + REGEN.focusRate * dt, 0, MAX.focus);
      }
      if (since.health > REGEN.healthDelay) {
        cur.health = clamp(cur.health + REGEN.healthRate * dt, 0, MAX.health);
      }
      if (exhausted && cur.stamina >= EXHAUST_CLEAR) exhausted = false;

      // ---- eat -------------------------------------------------------------
      if (c.input?.justPressed?.('eat')) api.eatBerry();
    },

    snapshot() {
      return {
        health: +cur.health.toFixed(1), maxHealth: MAX.health,
        focus: +cur.focus.toFixed(1), maxFocus: MAX.focus,
        stamina: +cur.stamina.toFixed(1), maxStamina: MAX.stamina,
        healthT: +api.healthT().toFixed(3),
        focusT: +api.focusT().toFixed(3),
        staminaT: +api.staminaT().toFixed(3),
        exhausted, collapsed: +api.collapsed().toFixed(3),
        stats: { ...stats, damage: +stats.damage.toFixed(1) },
      };
    },
  };

  return api;
}
