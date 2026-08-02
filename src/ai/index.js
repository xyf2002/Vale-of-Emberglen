import * as THREE from 'three';
import { ORDER } from '../engine/Game.js';

/**
 * AI / BEHAVIOUR SYSTEM — owned by the behaviour builder. This is the system the quality
 * bar calls "believable creature behaviour" and "the world feels alive". It writes
 * `creature.intent` and `creature.mood`; it never touches meshes.
 *
 * PUBLIC CONTRACT:
 *   describe(creature) -> string    one-line plain-English account of what it is doing
 *                                   and why (critics read this to judge legibility)
 *   snapshot()                      mood histogram + a few described creatures
 *
 * Design note for whoever owns this: legibility beats complexity. A player must be able
 * to *read* an intention from across a meadow — approach, hesitate, flee, graze, notice.
 *
 * STUB: wander + flee-from-player.
 */
export function createAI() {
  let ctx, creatures, player, world;
  const up = new THREE.Vector3(0, 1, 0);

  return {
    name: 'ai',
    order: ORDER.AI,

    init(c) {
      ctx = c; creatures = c.get('creatures'); player = c.get('player'); world = c.get('world');
      for (const cr of creatures.list) reset(cr, c.rng);
    },

    update(dt, c) {
      const pp = player.position;
      for (const cr of creatures.list) {
        if (!cr._brain) reset(cr, c.rng);
        const b = cr._brain;
        b.t -= dt;
        const d = cr.position.distanceTo(pp);
        const fleeAt = 6 + cr.stats.shy * 10;

        if (!cr.tamed && d < fleeAt) {
          cr.mood = 'afraid';
          const away = cr.position.clone().sub(pp).setY(0).normalize();
          cr.intent.move.copy(away).multiplyScalar(cr.stats.speed * 1.7);
          b.t = 0.4;
        } else if (b.t <= 0) {
          const spot = world.sampleSpawn(c.rng, { near: cr.position, radius: 14, maxSlope: 0.4 });
          b.target = spot ? new THREE.Vector3(spot.x, 0, spot.z) : null;
          b.t = c.rng.range(2.5, 6);
          cr.mood = c.rng.bool(0.4) ? 'eating' : 'calm';
        } else if (b.target) {
          const to = b.target.clone().sub(cr.position).setY(0);
          if (to.length() < 1) { cr.intent.move.set(0, 0, 0); cr.mood = 'eating'; }
          else cr.intent.move.copy(to.normalize()).multiplyScalar(cr.stats.speed * 0.45);
        } else {
          cr.intent.move.set(0, 0, 0);
        }
      }
    },

    describe(cr) {
      const d = cr.position.distanceTo(player.position).toFixed(1);
      return `${cr.def.name}#${cr.id} is ${cr.mood} (${d}m away, trust ${cr.trust.toFixed(2)})`;
    },

    snapshot() {
      return { described: creatures.list.slice(0, 5).map((c) => this.describe(c)) };
    },
  };

  function reset(cr, rng) { cr._brain = { t: rng.range(0, 3), target: null }; }
}
