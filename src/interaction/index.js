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
  let focus = null, prompt = null, marked = null;
  let gathering = null;
  let handFeed = null;     // { cr, t }
  let offerHold = 0;
  let hint = null, hintT = 0;
  const log = [];

  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();

  const HAND_RANGE = 2.9;
  const TOSS_RANGE = 11;
  const HAND_TRUST = 0.34;    // exactly the "curious" gate: once it is curious, it will come to your hand
  const OFFER_RANGE = 14;     // beyond this there is nobody to offer to and the key is not advertised
  const PROMPT_RANGE = 12.5;  // where the full card with a keycap lives
  const MARK_RANGE = 90;      // where the dimmed "you left this one half-tamed" marker lives
  let taughtBerries = false;  // one-time signpost when the satchel runs dry

  /**
   * NOTIFICATIONS, THE ONE RULE: a line the player has just read is not information, it is
   * noise. A measured session ended with "No berries left — a bush is 30m west" printed
   * FOUR TIMES in a single beat, which reads as a bug and shoved the one moment that
   * mattered — a creature becoming a companion — off the bottom of the stack.
   *
   * So: the same sentence cannot repeat inside `gap` seconds, and two different sentences
   * cannot land inside `spacing` seconds of each other unless the second one is important.
   * Everything the player needs continuously (how many berries, where a bush is, what a
   * creature costs) lives in the prompt, which is allowed to persist because it does not
   * stack.
   */
  const noteSeen = new Map();
  let lastNoteT = -99;
  let quietUntil = -99;      // the payoff gets the screen to itself for a few seconds
  const clock = () => ctx?.elapsed ?? 0;

  function note(text, opts = {}) {
    const { kind = 'info', gap = 10, spacing = 0.6, ttl, toast = true, quiet = 0 } = opts;
    const t = clock();
    const seen = noteSeen.get(text);
    if (seen !== undefined && t - seen < gap) return false;
    if (kind !== 'bond') {
      if (t - lastNoteT < spacing) return false;
      if (t < quietUntil) return false;
    }
    noteSeen.set(text, t);
    if (noteSeen.size > 48) noteSeen.delete(noteSeen.keys().next().value);
    lastNoteT = t;
    if (quiet) quietUntil = t + quiet;
    log.push(text);
    if (log.length > 24) log.shift();
    if (toast) ui?.notify?.(text, ttl ? { ttl } : undefined);
    ctx?.bus?.emit?.('interact:hint', { text, kind });
    return true;
  }

  function setInventory(item, delta) {
    inventory[item] = (inventory[item] ?? 0) + delta;
    ctx.bus.emit('inventory:change', { ...inventory });
    // The loop must never dead-end silently. The first time the satchel runs dry, say
    // once, plainly, where more come from.
    if (item === 'berry' && inventory.berry <= 0 && !taughtBerries) {
      taughtBerries = true;
      const bush = nearestBush(player?.position ?? tmp);
      note(bush
        ? `Berries gone. Bushes regrow — nearest is ${Math.round(bush.d)}m ${bush.dir}.`
        : 'Berries gone. Berry bushes regrow — press E at one.');
    }
  }

  const api = {
    name: 'interaction',
    order: ORDER.INTERACTION,
    inventory,
    /**
     * Spend items from the satchel. `inventory` is exposed as a live object, but a peer
     * mutating it directly would skip the 'inventory:change' emit and the satchel in the
     * HUD would quietly stop matching what the player has. Everything that removes an
     * item goes through here. Returns false if the satchel cannot cover it.
     */
    consume(item, n = 1) {
      if (n <= 0 || (inventory[item] ?? 0) < n) return false;
      setInventory(item, -n);
      return true;
    },
    get focus() { return focus; },
    get prompt() { return prompt; },
    /** the half-tamed creature the UI should keep a dim marker on, or null */
    get marked() { return marked; },
    /** {stage,name,trust,need,within,settling} for any creature — the UI's single source */
    readout(cr) { return cr ? taming?.readout?.(cr) ?? null : null; },
    get companions() { return companion?.members ?? []; },
    /** where to restock: the nearest bush that still has berries on it, or null */
    get forage() {
      if (!resources || !player) return null;
      const b = nearestBush(player.position);
      return b ? { position: b.node.position, dist: b.d, dir: b.dir } : null;
    },
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

      // A companion forages for you. This is the only source of berries that finds YOU,
      // and it is the reason a bonded creature is worth having rather than just a thing
      // that follows: the verb that made it yours is the verb it gives back.
      c.bus.on('companion:gift', (p) => {
        const n = p?.amount ?? 1;
        setInventory(p?.item ?? 'berry', n);
        const at = p?.position ?? p?.creature?.position;
        if (at) fx.count(tmp.copy(at).setY(at.y + 0.85), `+${n}`, '#ffb0c2');
        note(`${p?.creature?.def?.name ?? 'Your companion'} noses out a berry for you.`,
          { kind: 'gift', gap: 12 });
      });

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

      // Berries last, and seeded around the animals: see Resources.populate.
      const grazing = [];
      for (const cr of creatures?.list ?? []) if (cr?.position && grazing.length < 10) grazing.push(cr.position);
      resources.populate(player?.position, grazing);
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
          : h.kind === 'wood' ? `Gathered ${h.amount} sticks.` : `Chipped off ${h.amount} stone.`,
        { kind: 'gather', gap: 5, spacing: 0 });
        if (gathering === h.node) gathering = null;
      }
      if (gathering && gathering.channel <= 0) gathering = null;

      // ---- the arc ------------------------------------------------------
      const primary = taming.update(dt, {});

      // creatures that reached food on the ground
      for (const f of offering.food) {
        if (f.dead || !f.landed) continue;
        // A berry you left and nobody wanted is not gone. Walk over it and it is yours
        // again — the taming currency can never be permanently thrown away.
        // (only after it has lain there a while, or a berry set down at your own feet
        //  would be swallowed back into the satchel on the next frame)
        if (!f.claimedBy && f.t > 6 && f.position.distanceTo(pp) < 1.15) {
          offering.kill(f);
          setInventory('berry', 1);
          fx.count(tmp.copy(f.position).setY(f.position.y + 0.6), '+1', '#ffb0c2');
          note('You pick the berry back up.');
          continue;
        }
        if (!f.claimedBy) {
          // Offer it to the creature it was meant for, if that one is free; otherwise to
          // the nearest noticed creature that has finished its last meal.
          let cand = null, cd = 9;
          const free = (cr) => {
            const s = taming.stateOf(cr);
            return s.noticed && s.fedCd <= 0 && s.act !== 'flee' && s.act !== 'eat' && s.act !== 'handEat';
          };
          if (f.intended && !f.intended.tamed && free(f.intended)
              && f.intended.position.distanceTo(f.position) < 14) {
            cand = f.intended;
          } else {
            for (const cr of creatures?.list ?? []) {
              if (cr.dead || cr.tamed || !free(cr)) continue;
              const d = cr.position.distanceTo(f.position);
              if (d < cd) { cd = d; cand = cr; }
            }
          }
          if (cand) {
            f.claimedBy = cand;
            taming.claimFood(cand, f);
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
        // nothing is befriended after it is dead — the arc stops where the animal does
        if (cr.dead || cr.tamed) continue;
        const st = taming.stateOf(cr);
        if (st.trust >= 0.999) {
          taming.complete(cr);
          companion.add(cr);
          // The banner, the roster line and the chord ARE the announcement. A toast saying
          // the same words in the corner at the same moment is not emphasis, it is clutter —
          // and it buys four seconds of silence for everything else.
          note(`${cr.def?.name ?? 'It'} will follow you now.`,
            { kind: 'bond', gap: 0, toast: false, quiet: 4.5 });
        }
      }

      companion.update(dt);

      // ---- focus + prompt -------------------------------------------------
      // A bush you have already stripped must never hide a bush you have not, so the ready
      // one is looked for first and only falls back to the empty one for its "grow back" line.
      const readyNode = resources.nearest(pp, 0.6, true);
      const node = readyNode ?? resources.nearest(pp, 0.6);
      const nodeDist = node ? node.position.distanceTo(pp) : Infinity;
      let crFocus = null, crDist = Infinity;
      // a body is scenery: no card, no prompt, nothing to press E at
      if (primary && !primary.dead && !primary.tamed) {
        crDist = primary.position.distanceTo(pp);
        if (crDist < PROMPT_RANGE && taming.stateOf(primary).noticed) crFocus = primary;
      }

      // ---- the one you left half-tamed ------------------------------------
      // Losing the card the moment a creature drifts past 12.5m is how a player walks
      // away from a nearly-finished tame without knowing it. Keep a quiet world-anchored
      // marker on the best unfinished creature so there is always somewhere to walk back to.
      marked = null;
      let markScore = -Infinity;
      for (const cr of creatures?.list ?? []) {
        if (!cr?.position || cr.dead || cr.tamed || cr === crFocus) continue;
        const st = taming.stateOf(cr);
        if (!st.noticed || (st.stage < 2 && st.trust < 0.14)) continue;
        const d = cr.position.distanceTo(pp);
        if (d > MARK_RANGE) continue;
        const score = st.trust * 100 - d * 0.5;
        if (score > markScore) { markScore = score; marked = cr; }
      }

      // Whichever is actually nearer wins, except that a creature within reach of your hand
      // always beats scenery. Widening the bush reach without this would have let a shrub
      // four metres away steal the card off a creature three metres away.
      let next = null;
      if (crFocus && (crDist <= HAND_RANGE || !node)) next = crFocus;
      else if (node && (!crFocus || nodeDist < crDist)) next = node;
      else next = crFocus ?? node;

      if (next !== focus) {
        focus = next;
        c.bus.emit('interact:focus', { target: focus, kind: focus ? (focus.kind ? 'resource' : 'creature') : null });
      }

      prompt = buildPrompt(focus, crFocus, crDist);

      // ---- input ---------------------------------------------------------
      if (input.justPressed('interact')) {
        // E gathers whatever is in reach, whether or not the reticle happens to be on it.
        // The game tells the player "press E at a bush"; standing at a bush and being told
        // nothing happened because the card was showing a fox instead is the kind of gap
        // that makes an entire economy look broken.
        const petable = crFocus && crDist < 2.4
          && taming.stateOf(crFocus).trust >= 0.55 && taming.stateOf(crFocus).petCd <= 0;
        if (petable) {
          taming.onPet(crFocus);
        } else if (readyNode && !gathering) {
          if (resources.beginGather(readyNode)) {
            gathering = readyNode;
            c.bus.emit('gather:start', { node: readyNode, kind: readyNode.kind });
            fx.ring(readyNode.position, { r0: 0.25, r1: 0.95, dur: 0.4, color: 0xfff0c8, opacity: 0.45 });
          }
        } else if (node && !node.ready && !gathering) {
          note('Picked clean — it will grow back.', { gap: 14 });
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
      const r = f && !f.kind ? taming.readout(f) : null;
      const mr = marked ? taming.readout(marked) : null;
      return {
        inventory: { ...inventory },
        focus: f
          ? (f.kind
            ? { kind: f.kind, node: f.id, ready: f.ready }
            : {
              id: f.id, species: f.species, trust: +(st?.trust ?? f.trust ?? 0).toFixed(2),
              stage: STAGES[st?.stage ?? 0], berriesToGo: r?.need ?? null,
            })
          : null,
        marked: marked
          ? { species: marked.species, stage: mr.name, berriesToGo: mr.need,
            dist: +marked.position.distanceTo(player.position).toFixed(1) }
          : null,
        prompt: prompt?.text ?? null,
        stage: st ? STAGES[st.stage] : null,
        berriesToGo: r?.need ?? null,
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

  /**
   * PROMPT COPY, THE ONE RULE: the line under a creature's name must always name the
   * REMAINING COST, and the keycap is only shown when pressing it does something good.
   * "Too close — back off" while advertising [F], and then docking trust when the player
   * presses the key you just showed them, is the worst beat in the game.
   */
  function costLine(need) {
    if (need <= 1) return 'One more berry and it will follow you';
    if (need === 2) return 'Two more berries and it will follow you';
    return 'Three berries will win it over';
  }

  function buildPrompt(f, crFocus, crDist) {
    if (handFeed) {
      const n = handFeed.cr.def?.name ?? 'it';
      return { text: `Hold still — ${n} is deciding`, key: null };
    }
    if (f && f.kind) {
      if (!f.ready) return { text: 'Picked clean — it will grow back', key: null };
      const label = f.kind === 'berry' ? 'Pick berries' : f.kind === 'wood' ? 'Gather sticks' : 'Take stone';
      return { text: label, key: 'E' };
    }
    if (!f) {
      if (companion.members.length) return { text: 'Whistle them over', key: 'Q' };
      return null;
    }
    // creature
    const cr = f;
    const st = taming.stateOf(cr);
    const r = taming.readout(cr);
    const name = cr.def?.name ?? 'it';
    if (cr.tamed) return { text: `${name} travels with you`, key: 'Q' };

    if (inventory.berry <= 0) {
      const bush = nearestBush(player.position);
      return {
        text: bush
          ? `Out of berries — a bush is ${Math.round(bush.d)}m ${bush.dir}`
          : 'Out of berries — bushes carry them',
        key: null,
      };
    }
    if (crDist > OFFER_RANGE) return { text: 'Too far to offer — get closer', key: null };

    const line = costLine(r.need);
    // A creature with its mouth full will not take another berry, so the game must not
    // advertise the key, and pressing it must not spend one. Throwing your whole satchel
    // into the grass at an animal that is still chewing is how a five-minute session ran
    // itself dry with 2.5 minutes left to play.
    if (r.settling) return { text: 'Still eating — give it a moment', key: null, cost: line };
    if (crDist <= HAND_RANGE && st.trust >= HAND_TRUST) {
      const alt = st.trust >= 0.67 && st.petCd <= 0 ? 'E to pet' : null;
      return { text: r.need <= 1 ? line : 'Hold the berry out', key: 'F', alt, cost: line };
    }
    // Close but not trusted yet: you set it down and give it room. No flinch, no penalty —
    // the same verb, just performed politely.
    if (crDist <= HAND_RANGE) return { text: 'Set a berry down and give it room', key: 'F', cost: line };
    if (crDist <= TOSS_RANGE) return { text: r.need <= 1 ? line : 'Toss it a berry', key: 'F', cost: line };
    return { text: 'Toss it a berry', key: 'F', cost: line };
  }

  function doOffer(c, pp, crFocus, crDist) {
    if (handFeed) return;
    if (inventory.berry <= 0) {
      // Only say it if nothing else already is. When a creature is in prompt range the
      // card is ALREADY reading "Out of berries — a bush is 10m north-west" and the world
      // tag is already pointing at that bush; a toast repeating it is the third copy of
      // one sentence on one screen.
      const bush = nearestBush(pp);
      if (!crFocus) {
        note(bush
          ? `No berries left — a bush is ${Math.round(bush.d)}m ${bush.dir}. Press E at it.`
          : 'No berries left. Berry bushes grow back — press E at one.', { gap: 20 });
      }
      c.bus.emit('taming:offer', { creature: crFocus, mode: 'empty' });
      return;
    }

    // RANGE GATE. Berries are the taming currency and there is no reason on earth to let
    // a player spend one into empty grass 100m from anything. Refuse, and say why.
    const target0 = crFocus ?? creatures?.nearest?.(pp, OFFER_RANGE, (cr) => !cr.tamed) ?? null;
    if (!target0) {
      note('Nothing close enough to offer a berry to.', { gap: 16 });
      c.bus.emit('taming:offer', { creature: null, mode: 'nobody' });
      return;
    }

    // A mouth that is full takes nothing. Refuse before spending, and say so — the berry
    // stays in the satchel where it can still buy a friend.
    if (taming.stateOf(target0).fedCd > 0.4) {
      note(`${target0.def?.name ?? 'It'} is still eating the last one.`, { gap: 9 });
      c.bus.emit('taming:offer', { creature: target0, mode: 'busy' });
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
        return;
      }
      // Not trusted enough for a hand yet — so put it on the ground instead of reaching in.
      // Falls through to the toss below, which lands it a step away from its feet.
    }

    // throw one down where it can reach it without coming to you
    const target = target0;
    setInventory('berry', -1);
    offerHold = 0.9;
    offering.setOffering(true);

    offering.handPoint(tmp);
    tmp2.copy(pp).sub(target.position).setY(0);
    const d = tmp2.length() || 1;
    tmp2.normalize().multiplyScalar(Math.min(1.5, d * 0.34));
    tmp2.add(target.position);
    tmp2.y = (world?.heightAt?.(tmp2.x, tmp2.z) ?? target.position.y);
    const st = taming.stateOf(target);
    if (!st.noticed) { st.noticed = true; taming.emote(target, 'question', 1.4); }
    taming.emote(target, 'question', 1.2);
    c.bus.emit('taming:offer', { creature: target, mode: 'toss' });
    const tName = target.def?.name ?? 'it';
    const left = taming.readout(target).need;
    note(`You toss a berry toward ${tName}. ${left <= 1 ? 'This one seals it.' : ''}`.trim(),
      { kind: 'offer', gap: 5, spacing: 0 });
    const f = offering.toss(tmp, tmp2);
    if (f) f.intended = target;
  }

  return api;
}
