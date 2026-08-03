import { ORDER } from '../engine/Game.js';

/**
 * LOADOUT — what is in the traveller's hands.
 *
 * This exists so that the sphere system and the weapon system never have to ask each
 * other what is equipped. Both of them are built by separate agents in separate
 * directories; if each owned half of "what am I holding" they would race on the same
 * left-mouse press. So the state lives here, once, and both of them read it.
 *
 * PUBLIC CONTRACT (peers reach this with `ctx.get('loadout')`):
 *   equipped()            -> 'none' | 'sphere' | 'pistol' | 'rifle'
 *   is(id)                -> boolean, convenience
 *   slots()               -> the full slot list, in key order
 *   select(id)            -> force a slot (used by the capture harness)
 *   canAct()              -> false while a swap is still playing out
 *
 * BUS EVENTS EMITTED
 *   loadout:change  { from, to, index }
 *
 * The swap is deliberately not instant. A hand that teleports between a sphere and a
 * rifle reads as a menu, not as a character — and more practically, an instant swap
 * lets a mis-keyed slot press fire a weapon on the same frame at a creature the player
 * was about to befriend. `canAct()` stays false for the length of the swap so both
 * consumers are gated by construction rather than by remembering to check.
 */

const SLOTS = [
  { id: 'none', name: 'Empty hands', hint: 'Nothing in hand' },
  { id: 'sphere', name: 'Bond Sphere', hint: 'Throw to befriend' },
  { id: 'pistol', name: 'Sidearm', hint: 'Aim, then fire' },
  { id: 'rifle', name: 'Carbine', hint: 'Aim, then fire' },
];

const SWAP_TIME = 0.28;

export function createLoadout() {
  let ctx;
  let index = 0;
  let swap = 0;          // seconds remaining in the raise/lower

  function setIndex(next, silent = false) {
    next = Math.max(0, Math.min(SLOTS.length - 1, next | 0));
    if (next === index) return;
    const from = SLOTS[index].id;
    index = next;
    swap = SWAP_TIME;
    if (!silent) ctx?.bus?.emit('loadout:change', { from, to: SLOTS[index].id, index });
  }

  return {
    name: 'loadout',
    order: ORDER.LOADOUT,

    init(c) { ctx = c; },

    update(dt, c) {
      if (swap > 0) swap = Math.max(0, swap - dt);
      const inp = c.input;
      if (!inp) return;
      for (let i = 0; i < SLOTS.length; i++) {
        if (inp.justPressed(`slot${i + 1}`)) setIndex(i);
      }
      // The wheel is a nicety, not the primary path — see the note on absolute slots
      // in engine/Input.js. It is here because a player who grew up on shooters will
      // try it within the first ten seconds and be confused when nothing happens.
      if (inp.wheel) setIndex((index + (inp.wheel > 0 ? 1 : -1) + SLOTS.length) % SLOTS.length);
    },

    // ---- public contract -------------------------------------------------
    equipped() { return SLOTS[index].id; },
    is(id) { return SLOTS[index].id === id; },
    slots() { return SLOTS.map((s, i) => ({ ...s, active: i === index })); },
    select(id) {
      const i = SLOTS.findIndex((s) => s.id === id);
      if (i >= 0) setIndex(i);
      return SLOTS[index].id;
    },
    canAct() { return swap <= 0; },
    swapProgress() { return swap > 0 ? 1 - swap / SWAP_TIME : 1 },

    snapshot() {
      return { equipped: SLOTS[index].id, index, swapping: swap > 0 };
    },
  };
}
