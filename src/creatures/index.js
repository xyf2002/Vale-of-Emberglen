import * as THREE from 'three';
import { ORDER } from '../engine/Game.js';
import { SPECIES } from './species.js';
import { speciesAsset, instantiate } from './build.js';
import { initRig, updateRig, playAnim as rigPlayAnim, setEmote as rigSetEmote } from './anim.js';
import { contactShadowTexture } from './procgen.js';
import { makeContactShadows } from './materials.js';
import { initVitality, hurt, heal, stepVitality } from './vitality.js';

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
 * This file is the wiring only. The craft lives next door:
 *   species.js   — the four silhouettes, palettes and swept-surface bodies
 *   procgen.js   — the sweep/skin/paint builder and the canvas textures
 *   build.js     — species def -> one SkinnedMesh (fur group + drawn-face group)
 *   faces.js     — the flat-vector expression atlas (reference observation #3)
 *   materials.js — matte wrapped-diffuse fur shading + warm rim (observation #4)
 *   anim.js      — procedural posing, springs on ears/tails (observations #12, video #6)
 *
 * Two things here are load-bearing for the look and are easy to delete by accident:
 *   1. every creature gets its own animation phase, gesture schedule and asymmetry bias,
 *      so no two are ever in the same pose (observation #12 / video #1);
 *   2. a tight multiply-blended contact-shadow ellipse under each creature
 *      (observation #9) — without it they float, which is the fastest possible tell.
 */

const shortAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const UP = new THREE.Vector3(0, 1, 0);
const strHash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

let nextId = 1;

export function createCreatures() {
  let ctx, world;
  const list = [];
  let shadows = null;
  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _sc = new THREE.Vector3();
  const _pv = new THREE.Vector3();
  const _cam = new THREE.Vector3();
  const _look = new THREE.Vector3();

  const api = {
    name: 'creatures',
    order: ORDER.CREATURES,
    list,
    species: SPECIES,

    init(c) {
      ctx = c;
      world = c.get('world');

      // contact shadows — one instanced multiply decal for the whole population
      shadows = makeContactShadows(contactShadowTexture(), 64);
      c.scene.add(shadows);

      const rng = c.rng.fork(21);
      // POPULATION IS HELD AT 16 while the two new species land. Adding members without
      // adding bodies keeps the round a single-variable A/B — "who is in the meadow"
      // changed, "how busy the meadow is" did not, so a frame that reads better cannot be
      // explained away by there simply being more to look at. Shalehound is deliberately
      // a population of one: shy 0.10 means it never runs, so the player meets it whether
      // or not they look for it, and one is enough for that.
      const plan = [['woolkin', 5], ['emberfox', 3], ['mosshorn', 3], ['dewhare', 2],
        ['pumpkit', 2], ['shalehound', 1]];
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

      const asset = speciesAsset(def, ctx.rng.fork(strHash(speciesId) % 65536));
      const rig = instantiate(asset);
      const root = rig.root;
      root.scale.setScalar(def.size);

      const y = world?.heightAt?.(x, z) ?? 0;
      root.position.set(x, y, z);
      ctx.scene.add(root);

      const rng = ctx.rng.fork(7700 + nextId * 131);
      const cr = {
        id: nextId++, species: speciesId, def, root, rig,
        mesh: rig.mesh, bones: rig.bones,
        body: rig.mesh,                        // legacy alias — some systems poke .body
        position: root.position, yaw: rng.range(0, Math.PI * 2),
        intent: { move: new THREE.Vector3(), look: null, anim: 'idle', speed: 0 },
        mood: 'calm', trust: 0, tamed: false, stats: { ...def },
        speed01: 0, yawRate: 0, lookAt: null, lookWeight: 1,
        bodyYaw: 0, yawLag: 0,
        // reference #12: an idle Pal stands oblique to whatever it is attending to and
        // lets the head do the last 15-30 degrees. Never dead-on, never symmetric.
        stance: rng.range(0.24, 0.50) * (rng.bool() ? 1 : -1),
        // how strongly this individual presents itself to the viewer at close range
        // (see the attention block in update()). Varied per creature so a group never
        // snaps into a chorus line of identical facings — video criterion #10.
        viewBias: rng.range(0.62, 1.0),
        attend: 0,
        _bodyYawV: 0, _prevBodyYaw: 0, _groundY: y,
        playAnim(n) { rigPlayAnim(this, n); },
        setEmote(n, ttl) { rigSetEmote(this, n, ttl); },
      };
      cr.pose = rig.pose;
      initVitality(cr);
      cr.bodyYaw = cr._prevBodyYaw = cr.yaw + cr.stance;
      root.rotation.y = cr.yaw;
      rig.pose.rotation.y = cr.stance;

      initRig(cr, rng);
      // one warm-up tick so the creature is already mid-gesture on its very first
      // rendered frame rather than snapping out of a neutral bind pose
      updateRig(cr, 1 / 60, null);

      list.push(cr);
      ctx.bus.emit('creature:spawned', cr);
      return cr;
    },

    despawn(cr) {
      const i = list.indexOf(cr);
      if (i >= 0) { list.splice(i, 1); ctx.scene.remove(cr.root); }
    },

    /**
     * Hurt / heal a creature. Health is separate from the weaken ledger's stamina —
     * see the header of vitality.js for which one is which and why both exist.
     */
    hurt(cr, amount, cause) { return hurt(ctx?.bus, cr, amount, cause); },
    heal(cr, amount) { return heal(cr, amount); },

    /** Dead creatures are never "nearest": nothing may target, tame or talk to a body. */
    nearest(pos, maxDist = Infinity, filter = null) {
      let best = null, bd = maxDist * maxDist;
      for (const c of list) {
        if (c.dead) continue;
        if (filter && !filter(c)) continue;
        const d = c.position.distanceToSquared(pos);
        if (d < bd) { bd = d; best = c; }
      }
      return best;
    },

    update(dt, c) {
      const cam = c.camera;
      if (cam) _cam.copy(cam.position);
      const step = Math.max(1e-4, dt);

      // A body is stepped and nothing else: no intent, no gait, no attention, no rig.
      // Collected first and removed after the loop — splicing `list` while iterating it
      // skips the next creature, which showed up as one animal freezing mid-stride every
      // time another one died.
      let reap = null;
      for (const cr of list) {
        if (cr.dead) {
          if (stepVitality(cr, dt)) (reap ??= []).push(cr);
          cr.position.y = (world?.heightAt?.(cr.position.x, cr.position.z) ?? 0) + (cr._toppleY ?? 0);
          continue;
        }
        stepVitality(cr, dt);

        // ---- apply AI intent -------------------------------------------------
        const v = cr.intent.move;
        const sp = v.length();
        if (sp > 1e-3) {
          cr.position.addScaledVector(v, dt);
          // the AI only steers yaw itself when standing still; when moving, face travel
          const want = Math.atan2(-v.x, -v.z);
          const d = shortAngle(want - cr.yaw);
          cr.yaw += clamp(d, -6.5 * dt, 6.5 * dt);
        }

        const gy = world?.heightAt?.(cr.position.x, cr.position.z);
        cr._groundY = Number.isFinite(gy) ? gy : 0;
        cr.position.y = cr._groundY;

        // ---- body yaw lags the intent -----------------------------------------
        // Video criterion #5: the head leads the body by 0.15-0.3s and the body only
        // commits afterwards. The AI writes the *desired* facing into cr.yaw; the
        // rendered torso springs toward it slightly under-damped, so turns start and
        // stop as events with a small overshoot rather than as a switch (#8), and the
        // residual is handed to the head/ears so every turn produces ear travel (#6).
        // ---- attention: a creature that has noticed you presents its face ------
        // In a third-person game the camera IS the player's viewpoint — it sits a
        // couple of metres behind the head — so "look at the human" and "look at the
        // viewer" are the same act, and a Pal that has noticed you does it (video #5,
        // reference #12; `tr_045` is a creature looking straight down the lens).
        // This is a PRESENTATION bias carried by the pose node: cr.yaw, which the AI
        // owns and navigation reads, is never written here. It fades out with distance
        // and switches off entirely for a creature that is moving, fleeing or asleep,
        // so it can never overrule a behaviour that means something.
        let attendW = 0, attendYaw = cr.yaw;
        if (cam && cr.speed01 < 0.30 && cr.mood !== 'afraid' && cr.mood !== 'sleeping') {
          const dx = _cam.x - cr.position.x, dz = _cam.z - cr.position.z;
          const dd = Math.hypot(dx, dz);
          if (dd > 0.5) {
            attendW = cr.viewBias * (1 - clamp((dd - 6) / 8, 0, 1));
            attendYaw = Math.atan2(-dx, -dz);
          }
        }
        cr.attend += (attendW - cr.attend) * Math.min(1, dt * 3.5);
        // Only ~80% of the turn goes to the torso. Reference #12: a Pal is never squared
        // dead-on to what it is attending to — the head finishes the last 20-30 degrees,
        // and the head-look below is aimed at the viewer exactly, so it does.
        const face = cr.yaw + shortAngle(attendYaw - cr.yaw) * cr.attend * 0.87;

        // the stance folds away as the creature commits to travelling somewhere
        const stance = cr.stance * (1 - Math.min(1, cr.speed01 * 1.3));
        const lag = shortAngle(face + stance - cr.bodyYaw);
        cr._bodyYawV += (lag * 84 - cr._bodyYawV * 14.5) * dt;
        cr._bodyYawV = clamp(cr._bodyYawV, -9, 9);
        cr.bodyYaw += cr._bodyYawV * dt;
        cr.yawLag = shortAngle(face - cr.bodyYaw);

        cr.yawRate = shortAngle(cr.bodyYaw - cr._prevBodyYaw) / step;
        cr._prevBodyYaw = cr.bodyYaw;
        // root carries the requested facing (other systems write it too); the pose node
        // carries our lag + stance, so it survives whoever else touches root this frame
        cr.root.rotation.y = cr.yaw;
        cr.pose.rotation.y = shortAngle(cr.bodyYaw - cr.yaw);

        // normalised gait rate: ~1.8 at the species' own top speed
        cr.speed01 = sp / Math.max(0.6, (cr.def.speed ?? 2) * 0.55);
        cr.lookAt = cr.intent.look || null;
        // once the creature is really attending to the viewer, the eyes go there too:
        // a head pointed at you with the gaze somewhere else is the uncanny version.
        if (cr.attend > 0.40) cr.lookAt = _look.set(_cam.x, _cam.y - 0.30, _cam.z);

        // ---- pose ------------------------------------------------------------
        updateRig(cr, dt, cam ? _cam : null);
      }

      if (reap) for (const cr of reap) {
        ctx.bus.emit('creature:despawn', { id: cr.id, species: cr.species, reason: 'died' });
        api.despawn(cr);
      }

      // ---- contact occlusion (reference observation #9) -----------------------
      // Not one decal: a stack of horizontal slabs through the grass canopy. See the
      // long note on CONTACT_LAYERS in materials.js for why a ground-plane decal is
      // invisible in a meadow — it is measured, not a preference.
      if (shadows) {
        const layers = shadows.userData.layers;
        const cap = shadows.instanceMatrix.count;
        const col = shadows.instanceColor;
        let n = 0;
        for (const cr of list) {
          if (n + layers.length > cap) break;
          // a body sinking out of the world takes its shadow with it
          if (cr._death?.phase === 'sink') continue;
          const size = cr.def.size ?? 1;
          // tight: roughly the footprint, not the body width. Squashed on the
          // depth axis so it reads as an ellipse under the feet at a low camera.
          const r = size * (cr.def.gait === 'quad' ? 0.72 : 0.48);

          // How far the RENDERED body has left the ground. cr.position.y is pinned to
          // the terrain every frame, so the only place a hop exists is the rig's bodyY
          // (see anim.js: hop peaks at 0.17 of body size, startle pops 0.10). Reading
          // the pose rather than the transform is what makes a startled creature
          // visibly lift off its own shadow, which is most of the value of this term.
          const lift = (cr._pose?.bodyY ?? 0) * size;
          const air = clamp(lift / (0.19 * size), 0, 1);
          // ...and a creature that squats (bodyY goes negative in crouch/sleep) presses
          // itself into the grass instead.
          const squash = clamp(-lift / (0.15 * size), 0, 1);

          const spread = 1 + air * 0.55;
          const fade = (1 - air * 0.78) * (1 + squash * 0.18);

          _q.setFromAxisAngle(UP, cr.bodyYaw);
          for (const L of layers) {
            const rr = r * L.r * spread;
            _pv.set(cr.position.x, cr._groundY + L.y * size, cr.position.z);
            _sc.set(rr * 2.0, 1, rr * 1.65);
            _m.compose(_pv, _q, _sc);
            shadows.setMatrixAt(n, _m);
            const s = L.s * fade;
            col.setXYZ(n, s, s, s);
            n++;
          }
        }
        shadows.count = n;
        shadows.instanceMatrix.needsUpdate = true;
        col.needsUpdate = true;
      }
    },

    snapshot() {
      return {
        count: list.length,
        alive: list.filter((c) => !c.dead).length,
        dead: list.filter((c) => c.dead).length,
        tamed: list.filter((c) => c.tamed).length,
        hurt: list.filter((c) => !c.dead && c.health01 < 1).length,
        byMood: list.reduce((a, c) => (a[c.mood] = (a[c.mood] || 0) + 1, a), {}),
        sample: list.slice(0, 4).map((c) => ({
          id: c.id, species: c.species, mood: c.mood, trust: +c.trust.toFixed(2),
          health: +c.health.toFixed(1), maxHealth: c.maxHealth, dead: c.dead,
          anim: c.anim?.cur ?? '?', expr: c.rig?._expr ?? '?',
          yaw: +c.bodyYaw.toFixed(2), lag: +c.yawLag.toFixed(2),
          pos: [+c.position.x.toFixed(1), +c.position.z.toFixed(1)],
        })),
      };
    },
  };
  return api;
}
