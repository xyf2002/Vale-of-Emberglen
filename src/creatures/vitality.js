import * as THREE from 'three';

/**
 * CREATURE VITALITY — health, dying, and the body afterwards.
 *
 * READ THIS BEFORE YOU DELETE IT. Until r15 this project had a hard rule: creatures are
 * befriended, staggered or exhausted, never killed, and `src/weapons/weaken.js` still
 * carries the long comment explaining why. **The project owner lifted that rule
 * explicitly** and asked for creature health bars, weapon damage, death, and a body that
 * disappears a while later. CLAUDE.md has been updated to match. This file is that
 * decision, not an accident — do not "restore" the old invariant.
 *
 * The two paths now coexist and mean different things, which is the whole design:
 *
 *   STAMINA (weaken.js)  a shot drains it; at zero the creature is exhausted, sits down
 *                        and is easy to befriend. This is still the intended loop.
 *   HEALTH (here)        the same shot also costs health; at zero the creature dies.
 *                        Health is the *larger* pool by design — a player aiming to
 *                        befriend runs the stamina bar out long before the health bar,
 *                        and killing something takes a deliberate choice to keep firing.
 *
 * Death sequence, all dt-driven so a capture at N seconds is byte-stable:
 *   die     -> `creature:died`, AI/interaction/spheres stop touching it
 *   TOPPLE  -> rolls onto its side over TOPPLE_TIME
 *   LIE     -> lies there for CORPSE_TIME (the body is visible evidence, not a prop
 *              that blinks out under the player's nose)
 *   SINK    -> sinks and shrinks over SINK_TIME, then `creature:despawn` and the
 *              creature system removes it
 *
 * The body sinks rather than fading. Species materials are shared between every
 * instance of that species (see build.js), so setting `opacity` on a corpse fades every
 * other woolkin in the meadow with it — measured, and it looks exactly as broken as it
 * sounds. Sinking touches only this creature's transform.
 */

const TOPPLE_TIME = 0.55;
const CORPSE_TIME = 11.0;
const SINK_TIME = 2.2;

/** health scales with body size: a mosshorn is not a dewhare */
export function maxHealthFor(def) {
  return Math.round(34 + 78 * (def?.size ?? 1));
}

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const _axis = new THREE.Vector3();

export function initVitality(cr) {
  cr.maxHealth = maxHealthFor(cr.def);
  cr.health = cr.maxHealth;
  cr.health01 = 1;
  cr.dead = false;
  cr.sinceHurt = 999;          // seconds; the UI shows a bar for anything recently hurt
  cr._death = null;            // { phase, t, roll } once it dies
}

/**
 * Apply damage. Returns the amount actually taken (0 if it was already dead), so the
 * caller can decide whether there was anything to react to.
 */
export function hurt(bus, cr, amount, cause = 'shot') {
  if (!cr || cr.dead || !(amount > 0)) return 0;
  const was = cr.health;
  cr.health = clamp(was - amount, 0, cr.maxHealth);
  cr.health01 = cr.health / cr.maxHealth;
  cr.sinceHurt = 0;
  const took = was - cr.health;
  bus?.emit?.('creature:hurt', {
    creature: cr, id: cr.id, species: cr.species,
    amount: +took.toFixed(1), health: +cr.health.toFixed(1), max: cr.maxHealth, cause,
  });
  if (cr.health <= 0) kill(bus, cr, cause);
  return took;
}

export function heal(cr, amount) {
  if (!cr || cr.dead || !(amount > 0)) return 0;
  const was = cr.health;
  cr.health = clamp(was + amount, 0, cr.maxHealth);
  cr.health01 = cr.health / cr.maxHealth;
  return cr.health - was;
}

function kill(bus, cr, cause) {
  if (cr.dead) return;
  cr.dead = true;
  cr.health = 0;
  cr.health01 = 0;
  cr.mood = 'afraid';
  // whatever the AI last asked for is now void, and nothing may write it again
  cr.intent.move.set(0, 0, 0);
  cr.intent.look = null;
  cr.intent.speed = 0;
  // roll onto the side the shot came from if we know it, otherwise its own facing
  cr._death = { phase: 'topple', t: 0, roll: cr._deathRoll ?? 1 };
  bus?.emit?.('creature:died', { creature: cr, id: cr.id, species: cr.species, cause });
}

/**
 * Step one dead creature's body. Returns true when it is done and should be despawned.
 * A live creature just ages its `sinceHurt` clock here.
 */
export function stepVitality(cr, dt) {
  cr.sinceHurt += dt;
  const d = cr._death;
  if (!d) return false;

  d.t += dt;
  if (d.phase === 'topple') {
    const k = clamp(d.t / TOPPLE_TIME, 0, 1);
    // ease-out: the body goes over fast and settles, rather than rotating linearly
    const e = 1 - (1 - k) * (1 - k);
    // Roll about the creature's OWN forward axis, in world space. Writing
    // root.rotation.z instead rolls about the world z axis, so a creature that happened
    // to be facing east toppled backwards into the ground instead of onto its side.
    _axis.set(-Math.sin(cr.yaw), 0, -Math.cos(cr.yaw));
    cr.root.quaternion.setFromAxisAngle(_axis, (Math.PI * 0.5) * e * d.roll);
    cr._toppleY = -0.06 * (cr.def?.size ?? 1) * e;
    if (k >= 1) { d.phase = 'lie'; d.t = 0; }
    return false;
  }
  if (d.phase === 'lie') {
    if (d.t >= CORPSE_TIME) { d.phase = 'sink'; d.t = 0; }
    return false;
  }
  // sink: down through the ground and shrinking, then gone
  const k = clamp(d.t / SINK_TIME, 0, 1);
  cr._toppleY = -0.06 * (cr.def?.size ?? 1) - k * 0.9 * (cr.def?.size ?? 1);
  cr.root.scale.setScalar((cr.def?.size ?? 1) * (1 - k * 0.35));
  return k >= 1;
}
