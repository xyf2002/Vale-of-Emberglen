import * as THREE from 'three';
import { ORDER } from '../engine/Game.js';
import { createEffects } from './Effects.js';
import { createResources } from './Resources.js';
import { createTaming, STAGES } from './Taming.js';
import { createOffering } from './Offering.js';
import { createCompanion } from './Companion.js';

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
 *   'interact:focus'    {target|null, kind}
 *   'gather:start'      {node, kind}
 *   'gather:complete'   {kind, item, amount, total, position}
 *   'inventory:change'  {items}
 *   'taming:notice'     {creature, distance}
 *   'taming:stage'      {creature, stage, name, prev, up, trust}
 *   'taming:trust'      {creature, trust, delta, reason}
 *   'taming:offer'      {creature|null, mode:'toss'|'hand'}
 *   'taming:spook'      {creature, reason, trustDelta}
 *   'creature:fed'      {creature, trustDelta, mode}
 *   'creature:petted'   {creature, trustDelta}
 *   'creature:tamed'    {creature}
 *   'companion:joined'  {creature, count}
 *   'companion:called'  {count}
 *   'companion:caughtup'{creature}
 *
 * The arc, in one paragraph: creatures notice you at ~13m and stop to look. Standing
 * still inside their comfort ring earns trust; charging or sprinting burns it, and enough
 * of that knocks a stage back off. Trust buys the right to throw food they will actually
 * walk to, then the right to hold a berry out and have it taken from your hand, then a
 * companion who follows you and reacts to you. Every beat has a particle, a sound hook,
 * a gauge tick and an emote over the creature's head, so none of it needs a sentence.
 */
export function createInteraction() {
  let ctx, creatures, player, ui, world;
  let fx, resources, taming, offering, companion;

  const inventory = { berry: 6, wood: 0, stone: 0 };
  let focus = null, prompt = null;
  let gathering = null;
  let handFeed = null;     // { cr, t }
  let offerHold = 0;
  let hint = null, hintT = 0;
  const log = [];

  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();

  const HAND_RANGE = 2.9;
  const TOSS_RANGE = 11;
  const HAND_TRUST = 0.33;

  function note(text, kind = 'info') {
    log.push(text);
    if (log.length > 24) log.shift();
    ui?.notify?.(text);
    ctx?.bus?.emit?.('interact:hint', { text, kind });
  }

  function setInventory(item, delta) {
    inventory[item] = (inventory[item] ?? 0) + delta;
    ctx.bus.emit('inventory:change', { ...inventory });
  }

  const api = {
    name: 'interaction',
    order: ORDER.INTERACTION,
    inventory,
    get focus() { return focus; },
    get prompt() { return prompt; },
    get companions() { return companion?.members ?? []; },
    get arc() { return taming?.arc ?? []; },

    init(c) {
      ctx = c;
      creatures = c.get('creatures');
      player = c.get('player');
      ui = c.get('ui');
      world = c.get('world');

      fx = createEffects(c);
      fx.rng = c.rng.fork(0xfa11);
      resources = createResources(c, world, fx);
      taming = createTaming(c, { creatures, player, fx, bus: c.bus });
      offering = createOffering(c, { player, world, fx });
      companion = createCompanion(c, { player, world, fx, bus: c.bus });

      resources.populate(player?.position);

      // The first five minutes need something to walk up to. If the creature layer
      // happened to scatter everyone over the horizon, seed one encounter within
      // sight of the spawn using only the public creatures API.
      try {
        const near = creatures?.nearest?.(player.position, 26);
        if (!near && creatures?.spawn && world?.sampleSpawn) {
          const r = c.rng.fork(0xb1a5);
          const spot = world.sampleSpawn(r, { near: player.position, radius: 15, maxSlope: 0.25 });
          if (spot) {
            const ids = Object.keys(creatures.species ?? {});
            creatures.spawn(ids.includes('woolkin') ? 'woolkin' : ids[0], spot.x, spot.z);
          }
        }
      } catch { /* creature layer mid-rewrite: not fatal */ }
    },

    update(dt, c) {
      const pp = player.position;
      const input = c.input;

      // ---- gathering ----------------------------------------------------
      const harvests = resources.update(dt);
      for (const h of harvests) {
        setInventory(h.item, h.amount);
        fx.count(tmp.copy(h.position).setY(h.position.y + 0.75), `+${h.amount}`,
          h.kind === 'berry' ? '#ffb0c2' : h.kind === 'wood' ? '#e8c48c' : '#dfe6da');
        c.bus.emit('gather:complete', {
          kind: h.kind, item: h.item, amount: h.amount,
          total: inventory[h.item], position: h.position.clone(),
        });
        note(h.kind === 'berry' ? `Picked ${h.amount} berries.`
          : h.kind === 'wood' ? `Gathered ${h.amount} sticks.` : `Chipped off ${h.amount} stone.`);
        if (gathering === h.node) gathering = null;
      }
      if (gathering && gathering.channel <= 0) gathering = null;

      // ---- the arc ------------------------------------------------------
      const primary = taming.update(dt, {});

      // creatures that reached food on the ground
      for (const f of offering.food) {
        if (f.dead || !f.landed) continue;
        if (!f.claimedBy) {
          // offer it to the most trusting noticed creature in range
          let cand = null, cd = 9;
          for (const cr of creatures?.list ?? []) {
            if (cr.tamed) continue;
            const st = taming.stateOf(cr);
            if (!st.noticed) continue;
            const d = cr.position.distanceTo(f.position);
            if (d < cd) { cd = d; cand = cr; }
          }
          if (cand) {
            const cst = taming.stateOf(cand);
            if (cst.act !== 'flee' && cst.act !== 'eat' && cst.act !== 'handEat') {
              f.claimedBy = cand;
              taming.claimFood(cand, f);
            }
          }
        } else {
          const cr = f.claimedBy;
          if (cr.tamed) { f.claimedBy = null; continue; }
          if (cr.position.distanceTo(f.position) < 0.72) {
            taming.onEatFromGround(cr, f);
            offering.kill(f);
          }
        }
      }

      // ---- hand-feed sequence -------------------------------------------
      if (handFeed) {
        handFeed.t -= dt;
        const cr = handFeed.cr;
        const st = taming.stateOf(cr);
        offering.setOffering(true);
        if (st.act !== 'flee') { st.act = 'toHand'; st.actT = Math.max(st.actT, 0.4); }
        const d = cr.position.distanceTo(pp);
        if (handFeed.t <= 0 || (d < 1.5 && handFeed.t < 0.55)) {
          if (st.act === 'flee') { handFeed = null; }
          else {
            taming.onEatFromHand(cr);
            offering.handPoint(tmp);
            fx.burst(tmp, { n: 10, color: 0xffdca0, speed: 1.2, size: 0.07, life: 0.6, up: 1.0 });
            handFeed = null;
          }
        }
      }

      // ---- taming completion --------------------------------------------
      for (const cr of creatures?.list ?? []) {
        if (cr.tamed) continue;
        const st = taming.stateOf(cr);
        if (st.trust >= 0.999) {
          taming.complete(cr);
          companion.add(cr);
          note(`${cr.def?.name ?? 'It'} will follow you now.`);
        }
      }

      companion.update(dt);

      // ---- focus + prompt -------------------------------------------------
      const node = resources.nearest(pp, 0.6);
      let crFocus = null, crDist = Infinity;
      if (primary && !primary.tamed) {
        crDist = primary.position.distanceTo(pp);
        if (crDist < 12.5 && taming.stateOf(primary).noticed) crFocus = primary;
      }

      let next = null;
      if (crFocus && (crDist <= HAND_RANGE || !node)) next = crFocus;
      else if (node) next = node;
      else next = crFocus;

      if (next !== focus) {
        focus = next;
        c.bus.emit('interact:focus', { target: focus, kind: focus ? (focus.kind ? 'resource' : 'creature') : null });
      }

      prompt = buildPrompt(focus, crFocus, crDist);

      // ---- input ---------------------------------------------------------
      if (input.justPressed('interact')) {
        if (focus && focus.kind && focus.ready && !gathering) {
          if (resources.beginGather(focus)) {
            gathering = focus;
            c.bus.emit('gather:start', { node: focus, kind: focus.kind });
            fx.ring(focus.position, { r0: 0.25, r1: 0.95, dur: 0.4, color: 0xfff0c8, opacity: 0.45 });
          }
        } else if (crFocus && crDist < 2.4 && taming.stateOf(crFocus).trust >= 0.55 && taming.stateOf(crFocus).petCd <= 0) {
          taming.onPet(crFocus);
        } else if (focus && focus.kind && !focus.ready) {
          note('Picked clean — it will grow back.');
        }
      }

      if (input.justPressed('offer')) doOffer(c, pp, crFocus, crDist);
      if (input.justPressed('call')) {
        if (companion.call()) note('You whistle. They come running.');
      }

      // holding the berry out while a creature is close is its own readable pose
      offerHold = Math.max(0, offerHold - dt);
      const wantHold = !!handFeed || (offerHold > 0)
        || (crFocus && crDist <= HAND_RANGE + 0.6 && inventory.berry > 0
            && taming.stateOf(crFocus).trust >= HAND_TRUST);
      offering.setOffering(!!wantHold);

      offering.update(dt);
      fx.update(dt);

      hintT = Math.max(0, hintT - dt);
    },

    /** used by the audio/UI layers that want the arc in words */
    describe() {
      const p = taming?.primary;
      if (!p) return 'nothing within reach';
      const st = taming.stateOf(p);
      return `${p.def?.name ?? p.species}: ${STAGES[st.stage]} (trust ${st.trust.toFixed(2)}, ${st.act})`;
    },

    snapshot() {
      const f = focus;
      const st = f && !f.kind ? taming.stateOf(f) : null;
      return {
        inventory: { ...inventory },
        focus: f
          ? (f.kind
            ? { kind: f.kind, node: f.id, ready: f.ready }
            : { id: f.id, species: f.species, trust: +(st?.trust ?? f.trust ?? 0).toFixed(2), stage: STAGES[st?.stage ?? 0] })
          : null,
        prompt: prompt?.text ?? null,
        stage: st ? STAGES[st.stage] : null,
        companions: companion?.snapshot?.() ?? [],
        tamed: companion?.members?.length ?? 0,
        resources: resources?.snapshot?.() ?? null,
        arc: (taming?.arc ?? []).slice(-8),
        recent: log.slice(-4),
      };
    },
  };

  const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  function nearestBush(pos) {
    let best = null, bd = Infinity;
    for (const n of resources.nodes) {
      if (n.kind !== 'berry' || !n.ready) continue;
      const d = n.position.distanceToSquared(pos);
      if (d < bd) { bd = d; best = n; }
    }
    if (!best) return null;
    const dx = best.position.x - pos.x, dz = best.position.z - pos.z;
    const a = Math.atan2(dx, -dz);
    const oct = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
    return { node: best, d: Math.sqrt(bd), dir: COMPASS[oct] };
  }

  function buildPrompt(f, crFocus, crDist) {
    if (handFeed) {
      const n = handFeed.cr.def?.name ?? 'it';
      return { text: `Hold still — ${n} is deciding`, key: 'F' };
    }
    if (f && f.kind) {
      if (!f.ready) return { text: 'Picked clean', key: 'E' };
      const label = f.kind === 'berry' ? 'Pick berries' : f.kind === 'wood' ? 'Gather sticks' : 'Take stone';
      return { text: label, key: 'E' };
    }
    if (!f) {
      if (companion.members.length) return { text: 'Whistle', key: 'Q' };
      return null;
    }
    // creature
    const cr = f;
    const st = taming.stateOf(cr);
    const name = cr.def?.name ?? 'it';
    if (cr.tamed) return { text: `${name} is with you`, key: 'Q' };
    if (inventory.berry <= 0) {
      const bush = nearestBush(player.position);
      return {
        text: bush
          ? `${name} is watching — berries ${Math.round(bush.d)}m ${bush.dir}`
          : `${name} is watching — you have nothing to offer`,
        key: 'E',
      };
    }
    if (crDist <= HAND_RANGE) {
      if (st.trust >= HAND_TRUST) {
        const alt = st.trust >= 0.55 && st.petCd <= 0 ? 'E to pet' : null;
        return { text: `Offer the berry to ${name}`, key: 'F', alt };
      }
      return { text: `Too close — back off and toss a berry`, key: 'F' };
    }
    if (crDist <= TOSS_RANGE) return { text: `Toss a berry to ${name}`, key: 'F' };
    return { text: `${name} is keeping its distance`, key: 'F' };
  }

  function doOffer(c, pp, crFocus, crDist) {
    if (handFeed) return;
    if (inventory.berry <= 0) {
      note('No berries left. Bushes carry them.');
      c.bus.emit('taming:offer', { creature: crFocus, mode: 'empty' });
      return;
    }

    // close enough to hold it out
    if (crFocus && crDist <= HAND_RANGE) {
      const st = taming.stateOf(crFocus);
      if (st.trust >= HAND_TRUST) {
        setInventory('berry', -1);
        handFeed = { cr: crFocus, t: 1.5 };
        offerHold = 1.6;
        offering.setOffering(true);
        st.act = 'toHand'; st.actT = 1.5;
        taming.emote(crFocus, 'question', 1.0);
        c.bus.emit('taming:offer', { creature: crFocus, mode: 'hand' });
        note(`You hold out a berry to ${crFocus.def?.name ?? 'it'}.`);
      } else {
        taming.onSpookedByOffer(crFocus);
        note(`${crFocus.def?.name ?? 'It'} flinches — it does not trust your hand yet.`);
      }
      return;
    }

    // throw one down where it can reach it without coming to you
    let target = crFocus;
    if (!target) {
      target = creatures?.nearest?.(pp, TOSS_RANGE + 3, (cr) => !cr.tamed) ?? null;
    }
    setInventory('berry', -1);
    offerHold = 0.9;
    offering.setOffering(true);

    offering.handPoint(tmp);
    if (target) {
      tmp2.copy(pp).sub(target.position).setY(0);
      const d = tmp2.length() || 1;
      tmp2.normalize().multiplyScalar(Math.min(1.5, d * 0.34));
      tmp2.add(target.position);
      tmp2.y = (world?.heightAt?.(tmp2.x, tmp2.z) ?? target.position.y);
      const st = taming.stateOf(target);
      if (!st.noticed) { st.noticed = true; taming.emote(target, 'question', 1.4); }
      taming.emote(target, 'question', 1.2);
      c.bus.emit('taming:offer', { creature: target, mode: 'toss' });
      note(`You toss a berry toward ${target.def?.name ?? 'it'}.`);
    } else {
      const fwd = player.getForward?.() ?? tmp2.set(0, 0, -1);
      tmp2.copy(pp).addScaledVector(fwd, 3.4);
      tmp2.y = world?.heightAt?.(tmp2.x, tmp2.z) ?? pp.y;
      c.bus.emit('taming:offer', { creature: null, mode: 'toss' });
      note('You set a berry down in the grass.');
    }
    offering.toss(tmp, tmp2);
  }

  return api;
}
