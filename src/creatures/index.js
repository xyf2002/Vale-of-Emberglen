import * as THREE from 'three';
import { ORDER } from '../engine/Game.js';

/**
 * CREATURE SYSTEM — owned by the creature builder. Owns what a "pal" *is*: species
 * definitions, procedural models, rigs, animation, and the per-creature data record.
 * It does NOT decide what they do — that is the AI system, which writes to
 * `creature.intent` and reads `creature.body`.
 *
 * PUBLIC CONTRACT:
 *   list -> Creature[]
 *   spawn(speciesId, x, z) -> Creature
 *   despawn(creature)
 *   species -> Record<id, SpeciesDef>
 *   nearest(pos, maxDist, filter?) -> Creature | null
 *
 * Creature record (fields other systems read/write):
 *   id, species, root(Object3D), position(Vector3), yaw
 *   intent: { move:Vector3, look:Vector3|null, anim:string, speed:number }  <- AI writes
 *   mood:   'calm'|'curious'|'wary'|'afraid'|'happy'|'eating'|'sleeping'   <- AI writes
 *   trust:  0..1                                                           <- interaction writes
 *   tamed:  boolean
 *   stats:  { size, speed, shy, ... } from species
 *   playAnim(name), setEmote(name)
 *
 * STUB: coloured rounded boxes that hop. Replace with real creature craft.
 */

const SPECIES = {
  woolkin: { id: 'woolkin', name: 'Woolkin', color: 0xf2ece0, size: 0.9, speed: 2.0, shy: 0.35, diet: 'berry' },
  emberfox: { id: 'emberfox', name: 'Emberfox', color: 0xe08447, size: 0.8, speed: 3.4, shy: 0.6, diet: 'berry' },
  mosshorn: { id: 'mosshorn', name: 'Mosshorn', color: 0x7f9c5a, size: 1.5, speed: 1.6, shy: 0.2, diet: 'grass' },
};

let nextId = 1;

export function createCreatures() {
  let ctx, world;
  const list = [];

  function build(def) {
    const g = new THREE.Group();
    const s = def.size;
    const body = new THREE.Mesh(
      new THREE.SphereGeometry(s * 0.5, 16, 12),
      new THREE.MeshStandardMaterial({ color: def.color, roughness: 0.85 }));
    body.scale.set(1, 0.85, 1.15);
    body.position.y = s * 0.5;
    body.castShadow = true;
    g.add(body);
    const eyeMat = new THREE.MeshStandardMaterial({ color: 0x1a1410, roughness: 0.3 });
    for (const sx of [-1, 1]) {
      const e = new THREE.Mesh(new THREE.SphereGeometry(s * 0.075, 8, 8), eyeMat);
      e.position.set(sx * s * 0.16, s * 0.62, -s * 0.42);
      g.add(e);
    }
    return { root: g, body };
  }

  const api = {
    name: 'creatures',
    order: ORDER.CREATURES,
    list,
    species: SPECIES,

    init(c) {
      ctx = c; world = c.get('world');
      const rng = c.rng.fork(21);
      const plan = [['woolkin', 7], ['emberfox', 4], ['mosshorn', 3]];
      for (const [sp, n] of plan) {
        for (let i = 0; i < n; i++) {
          const spot = world?.sampleSpawn?.(rng, { maxSlope: 0.3 });
          if (spot) api.spawn(sp, spot.x, spot.z);
        }
      }
    },

    spawn(speciesId, x, z) {
      const def = SPECIES[speciesId];
      if (!def) return null;
      const { root, body } = build(def);
      const y = world?.heightAt?.(x, z) ?? 0;
      root.position.set(x, y, z);
      ctx.scene.add(root);
      const cr = {
        id: nextId++, species: speciesId, def, root, body,
        position: root.position, yaw: 0,
        intent: { move: new THREE.Vector3(), look: null, anim: 'idle', speed: 0 },
        mood: 'calm', trust: 0, tamed: false, stats: { ...def },
        _t: ctx.rng.next() * 10,
        playAnim(n) { this.intent.anim = n; },
        setEmote() {},
      };
      list.push(cr);
      ctx.bus.emit('creature:spawned', cr);
      return cr;
    },

    despawn(cr) {
      const i = list.indexOf(cr);
      if (i >= 0) { list.splice(i, 1); ctx.scene.remove(cr.root); }
    },

    nearest(pos, maxDist = Infinity, filter = null) {
      let best = null, bd = maxDist * maxDist;
      for (const c of list) {
        if (filter && !filter(c)) continue;
        const d = c.position.distanceToSquared(pos);
        if (d < bd) { bd = d; best = c; }
      }
      return best;
    },

    update(dt, c) {
      for (const cr of list) {
        cr._t += dt;
        // apply AI intent
        const v = cr.intent.move;
        if (v.lengthSq() > 1e-6) {
          cr.position.addScaledVector(v, dt);
          cr.yaw = Math.atan2(-v.x, -v.z);
        }
        cr.position.y = world?.heightAt?.(cr.position.x, cr.position.z) ?? 0;
        cr.root.rotation.y = cr.yaw;
        // stub "animation": a little hop while moving, breathing while idle
        const sp = v.length();
        const hop = sp > 0.2 ? Math.abs(Math.sin(cr._t * 9)) * 0.12 * Math.min(1, sp) : 0;
        cr.body.position.y = cr.def.size * 0.5 + hop + Math.sin(cr._t * 1.6) * 0.012;
      }
    },

    snapshot() {
      return {
        count: list.length,
        tamed: list.filter((c) => c.tamed).length,
        byMood: list.reduce((a, c) => (a[c.mood] = (a[c.mood] || 0) + 1, a), {}),
        sample: list.slice(0, 4).map((c) => ({
          id: c.id, species: c.species, mood: c.mood, trust: +c.trust.toFixed(2),
          pos: [+c.position.x.toFixed(1), +c.position.z.toFixed(1)],
        })),
      };
    },
  };
  return api;
}
