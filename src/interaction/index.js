import { ORDER } from '../engine/Game.js';

/**
 * INTERACTION SYSTEM — owned by the interaction builder. Owns the verbs: what the player
 * can DO to a creature or the world, and the arc from "wild animal" to "companion".
 * This is the system the quality bar calls "meaningful interaction".
 *
 * PUBLIC CONTRACT:
 *   focus -> Creature | Resource | null      what the player is currently looking at
 *   prompt -> { text, key } | null           what the UI should show
 *   snapshot()
 *
 * Emits (UI and audio listen):
 *   'interact:focus'   {target|null}
 *   'creature:fed'     {creature, trustDelta}
 *   'creature:tamed'   {creature}
 *   'inventory:change' {items}
 *
 * STUB: press E near a creature to raise trust; enough trust tames it.
 */
export function createInteraction() {
  let ctx, creatures, player, ui;
  const inventory = { berry: 5 };
  let focus = null, prompt = null;

  return {
    name: 'interaction',
    order: ORDER.INTERACTION,
    inventory,
    get focus() { return focus; },
    get prompt() { return prompt; },

    init(c) { ctx = c; creatures = c.get('creatures'); player = c.get('player'); ui = c.get('ui'); },

    update(dt, c) {
      const near = creatures.nearest(player.position, 4.5, (cr) => !cr.tamed);
      if (near !== focus) { focus = near; c.bus.emit('interact:focus', { target: focus }); }
      prompt = focus ? { text: `Offer a berry to ${focus.def.name}`, key: 'F' } : null;

      if (focus && c.input.justPressed('offer') && inventory.berry > 0) {
        inventory.berry--;
        focus.trust = Math.min(1, focus.trust + 0.34);
        c.bus.emit('creature:fed', { creature: focus, trustDelta: 0.34 });
        c.bus.emit('inventory:change', { ...inventory });
        if (focus.trust >= 1 && !focus.tamed) {
          focus.tamed = true; focus.mood = 'happy';
          c.bus.emit('creature:tamed', { creature: focus });
        }
      }
    },

    snapshot() {
      return {
        inventory: { ...inventory },
        focus: focus ? { id: focus.id, species: focus.species, trust: +focus.trust.toFixed(2) } : null,
        prompt: prompt?.text ?? null,
      };
    },
  };
}
