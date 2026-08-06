import { ORDER } from '../engine/Game.js';
import { createEngine } from './Engine.js';
import { createMusic, modeForTimeOfDay } from './Music.js';
import { timbreFor, AMBIENT_CUES } from './Cues.js';
import { clamp, smooth } from './dsp.js';

/**
 * AUDIO SYSTEM — owned by the audio builder. Everything is SYNTHESISED at runtime with
 * WebAudio; there are no audio files in this project and there should not be. Wind that
 * responds to elevation, birds that stop when you get close, a creature's voice, a warm
 * chord when one finally trusts you.
 *
 * PUBLIC CONTRACT:
 *   play(name, opts)        one-shot
 *   setAmbience(biome, timeOfDay, weather)
 *   setMuted(bool)
 *   snapshot()
 *
 * IMPORTANT: browsers block audio until a user gesture, and the capture harness never
 * makes one. Audio must therefore no-op cleanly with zero errors when the context is
 * suspended — never let a missing AudioContext break the render loop.
 *
 * ---------------------------------------------------------------------------
 * ARCHITECTURE
 *
 * The system is split in two so the second half can be absent without the first half
 * noticing:
 *
 *   DIRECTOR (this file)  Pure logic. Senses the world, decides what should be heard,
 *                         and logs every decision. Runs on every fixed step, always,
 *                         with or without audio hardware. This is what makes snapshot()
 *                         truthful in the capture harness: the log says exactly what a
 *                         player would have heard at that moment.
 *   ENGINE (Engine.js)    WebAudio. Created lazily on the first user gesture and never
 *                         in capture mode, so a headless run allocates no audio objects
 *                         at all. If it does not exist, cues are logged and dropped.
 *
 * Every peer lookup is optional-chained and the whole update is inside a try/catch that
 * disables the system after repeated failure rather than throwing into the render loop.
 * Nothing here ever writes to console — the capture harness fails a build on console
 * errors, and audio is not allowed to be the reason a round dies.
 * ---------------------------------------------------------------------------
 */

/** how far away a creature can still be heard */
const VOICE_RANGE = 42;
/** moods a creature can be in -> the call it makes when it enters that mood */
const MOOD_CALL = {
  curious: 'chirp', interested: 'chirp', alert: 'chirp',
  wary: 'grumble', suspicious: 'grumble', annoyed: 'grumble',
  afraid: 'yip', fleeing: 'yip', startled: 'yip', scared: 'yip',
  happy: 'trill', playful: 'trill', content: 'purr', bonded: 'purr',
  eating: 'snuffle', grazing: 'snuffle', foraging: 'snuffle',
  calm: 'coo', idle: 'coo', resting: 'hum', sleeping: 'hum',
};
/** what a species says when it is just pottering about */
const IDLE_CALL = { woolkin: 'bleat', emberfox: 'chirp', mosshorn: 'hum' };

export function createAudio() {
  let ctx = null;
  let engine = null;
  let engineState = 'idle';           // idle | starting | running | suspended | unavailable | disabled
  let muted = false;
  let broken = false;
  let errCount = 0;
  const errors = [];

  const played = [];                  // full log (trimmed)
  const notable = [];                 // events a critic actually cares about
  const counts = Object.create(null);
  let total = 0;

  let ambience = null;                // whatever setAmbience() was last told
  let rng = null;
  let music = null;

  // --- sensed world context ------------------------------------------------
  const world = {
    surface: 'grass', biome: 'meadow', grassiness: 1,
    elevation: 0, exposure: 0, nearWater: 0, slope: 0,
    tod: 0.3, weather: 'clear', weatherAmount: 0, mode: 'day',
    dayness: 1, nightness: 0,
  };
  const levels = { windLow: 0, windMid: 0, whistle: 0, rustle: 0, water: 0, night: 0, room: 0.06 };
  let gust = 0, gustBand = 500, windLevel = 0;

  // --- schedulers ----------------------------------------------------------
  let senseT = 0;                     // seconds until the next world probe
  let birdRate = 0, insectRate = 0, cricketRate = 0, owlRate = 0;
  let birdHush = 0;                   // birds go quiet after you crash about
  let gustCool = 0, lapCool = 0;
  let lastGust = 0;

  // --- interaction / UI sting throttles ------------------------------------
  // Event fire during OTHER systems' updates, several can land in one frame (taming:trust
  // precedes creature:fed, which precedes taming:stage). These cools keep a single gesture
  // from stacking three copies of the same sting, and space out repeats of noisy events.
  let trustCool = 0, playCool = 0, suspendRetry = 0;
  // a held trigger must not turn one animal into a chorus of itself
  let hitVoiceCool = 0;
  let lastGatherAt = -100;            // ctx.elapsed when gather:complete last sang

  // --- footsteps -----------------------------------------------------------
  let stepAccum = 0, stepFoot = 1, wasGrounded = true, lastY = 0, fallFrom = 0;
  const prevPos = { x: 0, y: 0, z: 0 };
  let havePrev = false;

  // --- creature bookkeeping (keyed by id, so we never write to their objects) --
  const cstate = new Map();
  let voiceCool = 0, voiceEmitCool = 0;

  // --- inventory watching (for gather stings when nothing emits one) --------
  let lastInv = null, fedRecently = 0;

  // --- last-emitted regime, so 'audio:ambience' only fires on real changes ---
  let lastRegime = '';

  const api = {
    name: 'audio',
    order: ORDER.AUDIO,

    // =====================================================================
    // lifecycle
    // =====================================================================
    init(c) {
      ctx = c;
      rng = c.rng.fork(0x5a1d);
      music = createMusic(c.rng.fork(0x117e));

      // Interaction / world events. Several plausible names are wired for each concept
      // because the systems that emit them are being written in parallel; extra
      // listeners for events that never fire cost nothing.
      const on = (evt, fn) => { try { c.bus.on(evt, fn); } catch { /* ignore */ } };

      on('creature:fed', (p) => onFed(p));
      on('creature:eat', (p) => onFed(p));
      on('creature:tamed', (p) => onTamed(p));
      on('creature:bonded', (p) => onTamed(p));
      on('creature:trust', (p) => onTrust(p));
      on('interact:focus', (p) => onFocus(p));
      on('inventory:change', (p) => onInventory(p));
      for (const e of ['resource:gathered', 'world:gathered', 'item:gathered', 'gather', 'forage']) {
        on(e, () => api.play('gather', spatialOf(playerPos())));
      }
      on('creature:spawned', (cr) => { if (cr?.id != null) ensureCreature(cr); });
      on('creature:call', (p) => {
        // if the AI system ever asks for a specific vocalisation, honour it
        if (p?.creature) voiceCreature(p.creature, p.call ?? p.name ?? null, true);
      });
      // NOTE: 'player:jump'/'player:land' are NOT hooked — updateFootsteps() detects the
      // same transitions from the player transform and carries surface context, so wiring
      // the bus events too would double every hop and landing.

      // --- the social arc, in the order a player meets it ------------------
      on('creature:noticed', (p) => onNoticed(p));       // it froze to look at you
      on('creature:approaching', (p) => onApproach(p));  // curiosity won
      on('creature:settled', (p) => onSettled(p));       // it came as close as it dares
      on('creature:startled', (p) => onStartled(p));     // you rushed its flight distance
      on('creature:play', (p) => onPlay(p));             // two of them chasing

      // --- the taming verbs ------------------------------------------------
      on('taming:notice', (p) => onTamedNotice(p));
      on('taming:offer', (p) => onOffer(p));
      on('taming:trust', (p) => onTrustTick(p));
      on('taming:spook', (p) => onSpook(p));
      on('taming:stage', (p) => onStage(p));
      on('creature:petted', (p) => onPet(p));
      on('gather:start', (p) => onGatherStart(p));
      on('gather:complete', (p) => onGatherComplete(p));

      // --- bond spheres (src/spheres) --------------------------------------
      on('sphere:thrown', (p) => onSphereThrown(p));
      on('sphere:hit', (p) => onSphereHit(p));
      on('sphere:shake', (p) => onSphereShake(p));
      on('sphere:caught', (p) => onSphereCaught(p));
      on('sphere:escaped', (p) => onSphereEscaped(p));

      // --- weapons (src/weapons) -------------------------------------------
      on('weapon:fired', (p) => onWeaponFired(p));
      on('weapon:impact', (p) => onWeaponImpact(p));
      on('weapon:hit', (p) => onWeaponHit(p));
      on('weapon:dry', (p) => onWeaponDry(p));
      on('weapon:reload', (p) => onWeaponReload(p));
      on('weapon:aim', (p) => onWeaponAim(p));
      on('creature:exhausted', (p) => onExhausted(p));

      // --- the field kit ---------------------------------------------------
      on('ui:journal', (p) => onJournal(p));
      on('journal:record', (p) => onDiscover(p));
      on('companion:called', (p) => onWhistle(p));

      // Audio may only start after a gesture, and never in the capture harness.
      if (typeof window !== 'undefined' && !c.game?.captureMode) {
        const start = () => {
          detach();
          this._gesture = true;
          startEngine();
        };
        const detach = () => {
          for (const e of ['pointerdown', 'keydown', 'touchstart']) {
            try { window.removeEventListener(e, start); } catch { /* ignore */ }
          }
        };
        for (const e of ['pointerdown', 'keydown', 'touchstart']) {
          try { window.addEventListener(e, start, { passive: true }); } catch { /* ignore */ }
        }
        // tabs put the context to sleep in the background; waking up should coax it back
        const wake = () => {
          if (engine && engineState === 'suspended' && !document.hidden) {
            try { engine.ac.resume?.().catch?.(() => {}); } catch { /* ignore */ }
          }
        };
        try { document.addEventListener('visibilitychange', wake); } catch { /* ignore */ }
      } else {
        engineState = c.game?.captureMode ? 'disabled' : 'idle';
      }

      senseWorld(c);
    },

    // =====================================================================
    // per-frame
    // =====================================================================
    update(dt, c) {
      try {
        if (c.input?.justPressed?.('mute')) api.setMuted(!muted);
        if (broken) return;

        senseT -= dt;
        if (senseT <= 0) { senseT = 0.35; senseWorld(c); }

        updateWind(dt, c);
        updateAmbientLife(dt, c);
        updateFootsteps(dt, c);
        updateCreatures(dt, c);
        updateMusic(dt, c);

        fedRecently = Math.max(0, fedRecently - dt);
        birdHush = Math.max(0, birdHush - dt);
        voiceCool = Math.max(0, voiceCool - dt);
        voiceEmitCool = Math.max(0, voiceEmitCool - dt);
        gustCool = Math.max(0, gustCool - dt);
        lapCool = Math.max(0, lapCool - dt);
        trustCool = Math.max(0, trustCool - dt);
        hitVoiceCool = Math.max(0, hitVoiceCool - dt);
        playCool = Math.max(0, playCool - dt);

        // some browsers drop a running context into 'suspended' without a tab switch
        // (aggressive autoplay heuristics). A throttled polite resume costs nothing and
        // is the only thing standing between "silent until reload" and a living meadow.
        suspendRetry -= dt;
        if (engine && engineState === 'suspended' && suspendRetry <= 0) {
          suspendRetry = 2.5;
          try { engine.ac.resume?.().catch?.(() => {}); } catch { /* ignore */ }
        }

        if (engine) {
          engine.setAmbience(levels, gustBand);
          if (engine.state !== engineState && engineState !== 'disabled') engineState = engine.state;
        }
        if (played.length > 220) played.splice(0, played.length - 220);
        if (notable.length > 60) notable.splice(0, notable.length - 60);
      } catch (e) {
        errCount++;
        if (errors.length < 5) errors.push(String(e?.message ?? e));
        if (errCount > 6) broken = true;      // fail silent and stay out of everyone's way
      }
    },

    // =====================================================================
    // public contract
    // =====================================================================
    /**
     * Play a cue. Always logged (so snapshot stays truthful with no audio hardware);
     * forwarded to the engine only when one exists and we are not muted.
     */
    play(name, opts = {}) {
      const rec = { name, t: +(ctx?.elapsed ?? 0).toFixed(2), ...opts };
      played.push(rec);
      counts[name] = (counts[name] ?? 0) + 1;
      total++;
      if (!AMBIENT_CUES.has(name)) notable.push(rec);
      if (engine && !muted) {
        try { engine.cue(name, opts); } catch (e) { if (errors.length < 5) errors.push(String(e?.message ?? e)); }
      }
      return rec;
    },

    setAmbience(biome, timeOfDay, weather) {
      ambience = { biome, timeOfDay, weather };
      if (biome != null) world.biome = String(biome);
      if (typeof timeOfDay === 'number') world.tod = ((timeOfDay % 1) + 1) % 1;
      if (weather != null) world.weather = String(weather);
      applyTimeOfDay();
    },

    setMuted(m) {
      muted = !!m;
      try { engine?.setMuted(muted); } catch { /* ignore */ }
      return muted;
    },

    snapshot() {
      return {
        // --- contract fields (shape unchanged) ---
        muted,
        ambience,
        recent: notable.slice(-8).map((p) => p.name),
        // --- additions ---
        engine: engineState,
        audible: !!engine && !muted && engineState === 'running',
        recentAll: played.slice(-12).map((p) => p.name),
        lastEvents: notable.slice(-6).map((p) => ({ name: p.name, t: p.t, call: p.call, species: p.species })),
        context: {
          biome: world.biome, surface: world.surface,
          elevation: +world.elevation.toFixed(1), exposure: +world.exposure.toFixed(2),
          nearWater: +world.nearWater.toFixed(2),
          timeOfDay: +world.tod.toFixed(3), weather: world.weather,
          phase: world.mode,
        },
        layers: {
          wind: +windLevel.toFixed(2), gust: +gust.toFixed(2),
          rustle: +levels.rustle.toFixed(2), water: +levels.water.toFixed(2),
          night: +levels.night.toFixed(2),
          birdsPerSec: +birdRate.toFixed(2), insectsPerSec: +insectRate.toFixed(2),
          cricketsPerSec: +cricketRate.toFixed(2),
        },
        music: music?.snapshot() ?? null,
        voices: {
          tracked: cstate.size,
          audible: [...cstate.values()].filter((s) => s.dist < VOICE_RANGE).length,
        },
        counts: { total, ...counts },
        errors: errors.length ? errors : undefined,
      };
    },

    /** exposed so a browser console / tools can force audio on without clicking */
    resume() { startEngine(); return engineState; },
  };

  // =======================================================================
  // engine start-up
  // =======================================================================
  function startEngine() {
    if (engine || broken || engineState === 'disabled') return;
    try {
      const AC = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;
      if (!AC) { engineState = 'unavailable'; return; }
      engineState = 'starting';
      const ac = new AC({ latencyHint: 'interactive' });
      engine = createEngine(ac, { seed: (ctx?.seed ?? 1) ^ 0xbee7 });
      engine.setMuted(muted);
      engineState = ac.state;
      if (ac.state === 'suspended') {
        // a promise rejection here must not surface as an unhandled rejection
        Promise.resolve(ac.resume()).then(() => { engineState = ac.state; }).catch(() => { engineState = 'suspended'; });
      }
      if (typeof ac.onstatechange !== 'undefined') ac.onstatechange = () => { engineState = ac.state; };
      engine.setAmbience(levels, gustBand);
    } catch (e) {
      engine = null;
      engineState = 'unavailable';
      if (errors.length < 5) errors.push(String(e?.message ?? e));
    }
  }

  // =======================================================================
  // sensing
  // =======================================================================
  function playerPos() {
    const p = ctx?.get?.('player')?.position;
    return p ? { x: p.x, y: p.y, z: p.z } : { x: 0, y: 0, z: 0 };
  }

  /** horizontal distance from the player to a creature (for event-driven handlers) */
  function distTo(cr) {
    const p = playerPos();
    return Math.hypot((cr?.position?.x ?? p.x) - p.x, (cr?.position?.z ?? p.z) - p.z);
  }

  /**
   * Distance / pan / gain for a world position relative to the camera. Uses the camera
   * basis directly rather than a PannerNode: cheaper, and it lets the director report
   * the numbers in snapshot().
   */
  function spatialOf(pos, falloff = 8) {
    const cam = ctx?.camera;
    if (!cam || !pos) return { distance: 0, pan: 0, gain: 1 };
    const cp = cam.position;
    const dx = pos.x - cp.x, dy = (pos.y ?? 0) - cp.y, dz = pos.z - cp.z;
    const d = Math.hypot(dx, dy, dz) || 1e-3;
    let pan = 0;
    const e = cam.matrixWorld?.elements;
    if (e) pan = clamp(((dx * e[0] + dy * e[1] + dz * e[2]) / d) * 1.2, -1, 1);
    return { distance: +d.toFixed(1), pan: +pan.toFixed(2), gain: +clamp(1 / (1 + Math.pow(d / falloff, 1.45)), 0, 1).toFixed(3) };
  }

  function surfaceAt(x, z) {
    const w = ctx?.get?.('world');
    if (!w) return 'grass';
    // if the world builder ever exposes an explicit material, trust it
    const direct = w.surfaceAt?.(x, z) ?? w.materialAt?.(x, z);
    if (typeof direct === 'string' && direct) return normaliseSurface(direct);
    let b = null;
    try { b = w.biomeAt?.(x, z); } catch { /* ignore */ }
    const name = String(b?.surface ?? b?.name ?? '').toLowerCase();
    const s = normaliseSurface(name);
    if (s !== 'grass') return s;
    let slope = 0;
    try { slope = w.slopeAt?.(x, z) ?? 0; } catch { /* ignore */ }
    if (slope > 0.55) return 'rock';
    const g = b?.grass;
    if (typeof g === 'number' && g < 0.25) return 'dirt';
    return 'grass';
  }

  function normaliseSurface(name) {
    if (/water|river|lake|pond|marsh|stream/.test(name)) return 'water';
    if (/shore|beach|sand|dune/.test(name)) return 'sand';
    if (/rock|cliff|scree|stone|mountain|highland|alpine|snow/.test(name)) return 'rock';
    if (/dirt|path|trail|mud|clay|soil|barren/.test(name)) return 'dirt';
    if (/wood|deck|plank|bridge/.test(name)) return 'wood';
    return 'grass';
  }

  function senseWorld(c) {
    const w = c.get?.('world');
    const sky = c.get?.('sky');
    const p = playerPos();

    // time of day / weather (setAmbience() overrides win)
    if (!ambience || typeof ambience.timeOfDay !== 'number') {
      const t = sky?.timeOfDay;
      if (typeof t === 'number') world.tod = ((t % 1) + 1) % 1;
    }
    if (!ambience || ambience.weather == null) {
      let snap = null;
      try { snap = sky?.snapshot?.(); } catch { /* ignore */ }
      if (snap?.weather) world.weather = String(snap.weather);
      if (typeof snap?.weatherAmount === 'number') world.weatherAmount = snap.weatherAmount;
      else world.weatherAmount = world.weather === 'clear' ? 0 : 0.6;
    }
    applyTimeOfDay();

    world.surface = surfaceAt(p.x, p.z);
    world.elevation = p.y;

    let b = null;
    try { b = w?.biomeAt?.(p.x, p.z); } catch { /* ignore */ }
    if (!ambience || ambience.biome == null) world.biome = String(b?.name ?? 'meadow');
    world.grassiness = typeof b?.grass === 'number' ? clamp(b.grass, 0, 1) : (world.surface === 'grass' ? 0.9 : 0.3);
    try { world.slope = w?.slopeAt?.(p.x, p.z) ?? 0; } catch { world.slope = 0; }

    // exposure: how much of the surrounding land sits below you. This is what makes a
    // ridge sound like a ridge — the wind comes up as the ground falls away.
    let exposure = 0;
    if (w?.heightAt) {
      let n = 0;
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const hx = p.x + Math.cos(a) * 45, hz = p.z + Math.sin(a) * 45;
        let h = p.y;
        try { h = w.heightAt(hx, hz); } catch { /* ignore */ }
        exposure += clamp((p.y - h) / 22, 0, 1);
        n++;
      }
      exposure = n ? exposure / n : 0;
    }
    world.exposure = exposure;

    // water proximity
    let near = 0;
    const wl = w?.waterLevel ?? w?.seaLevel;
    if (typeof wl === 'number') near = clamp(1 - (p.y - wl - 0.5) / 10, 0, 1);
    if (typeof w?.distanceToWater === 'function') {
      try { near = Math.max(near, clamp(1 - (w.distanceToWater(p.x, p.z) - 2) / 22, 0, 1)); } catch { /* ignore */ }
    }
    if (world.surface === 'water') near = 1;
    else if (world.surface === 'sand') near = Math.max(near, 0.55);
    else if (/shore|beach|river|lake|marsh/.test(world.biome.toLowerCase())) near = Math.max(near, 0.5);
    world.nearWater = near;
  }

  function applyTimeOfDay() {
    const t = world.tod;
    world.dayness = smooth(0.18, 0.30, t) * (1 - smooth(0.76, 0.88, t));
    world.nightness = clamp(smooth(0.79, 0.90, t) + (1 - smooth(0.11, 0.23, t)), 0, 1);
    const m = modeForTimeOfDay(t);
    if (m !== world.mode) {
      world.mode = m;
      music?.setMode(m);
    }
  }

  // =======================================================================
  // wind and the ambient bed
  // =======================================================================
  function updateWind(dt, c) {
    const t = c.elapsed;
    // deterministic gust envelope — same seed, same weather, every run
    const n = c.noise ? c.noise.fbm(t * 0.05, 17.3, 4) : 0;
    gust = smooth(-0.22, 0.5, n);

    const rain = /rain|storm/.test(world.weather) ? world.weatherAmount || 0.6 : 0;
    const windWeather = rain * 0.5 + (/wind|storm/.test(world.weather) ? 0.5 : 0);
    const elev = clamp(world.elevation / 70, 0, 1);

    windLevel = clamp(0.15 + world.exposure * 0.5 + elev * 0.2 + windWeather * 0.45, 0, 1.1);

    levels.windLow = windLevel * (0.55 + gust * 0.35);
    levels.windMid = windLevel * (0.30 + gust * 0.8);
    levels.whistle = clamp(world.exposure * windLevel * gust * 0.6, 0, 0.5);
    levels.rustle = clamp(windLevel * (0.25 + gust * 0.85) * world.grassiness * 0.85, 0, 1);
    levels.water = clamp(world.nearWater * 0.95, 0, 1);
    levels.night = world.nightness * 0.5;
    levels.room = 0.055 + (1 - world.nightness) * 0.03;
    gustBand = 340 + gust * 880 + windLevel * 260;

    // an audible gust arriving — edge triggered, never more than one at a time
    if (gustCool <= 0 && gust > 0.62 && lastGust <= 0.62 && windLevel > 0.3) {
      api.play('gust', { gain: clamp(windLevel * (0.5 + gust * 0.6), 0, 1.1), rustle: world.grassiness });
      gustCool = 6 + rng.next() * 8;
      birdHush = Math.max(birdHush, 0.8);
    }
    lastGust = gust;
  }

  /** birds, crickets, owls, water laps — the living layer on top of the wind */
  function updateAmbientLife(dt, c) {
    const rain = /rain|storm/.test(world.weather) ? clamp(world.weatherAmount || 0.6, 0, 1) : 0;
    const fog = /fog|mist/.test(world.weather) ? 0.5 : 0;

    // dawn chorus peaks around 0.25, birds thin through the afternoon and stop by dusk
    const dawnBoost = Math.max(0, 1 - Math.abs(world.tod - 0.255) / 0.08);
    birdRate = world.dayness * (0.5 + dawnBoost * 1.4) * (1 - rain * 0.8) * (1 - fog * 0.4);
    // and they hush when something crashes about nearby
    if (birdHush > 0) birdRate *= 0.18;
    birdRate = clamp(birdRate, 0, 2.2);

    cricketRate = clamp(world.nightness * 2.4 * (1 - rain * 0.75), 0, 2.6);
    owlRate = world.nightness * 0.02;

    // The hot middle of the day hums: a narrow band of insects around solar noon so the
    // day has three voices (birds, insects, crickets) that hand over rather than pile up.
    const insectBand = smooth(0.30, 0.42, world.tod) * (1 - smooth(0.58, 0.70, world.tod));
    insectRate = clamp(insectBand * (1 - rain * 0.9) * (1 - fog * 0.3) * (1 - world.exposure * 0.3), 0, 1.6);

    if (birdRate > 0 && rng.next() < birdRate * dt) {
      // birds live in the trees around you, not on your head
      const ang = rng.next() * Math.PI * 2;
      const d = 12 + rng.next() * 30;
      const p = playerPos();
      const s = spatialOf({ x: p.x + Math.cos(ang) * d, y: p.y + 4 + rng.next() * 6, z: p.z + Math.sin(ang) * d }, 26);
      api.play('bird', { gain: s.gain * (0.6 + rng.next() * 0.6), pan: s.pan });
    }
    if (cricketRate > 0 && rng.next() < cricketRate * dt) {
      api.play('cricket', { gain: 0.5 + rng.next() * 0.6, pan: (rng.next() - 0.5) * 1.8 });
    }
    if (insectRate > 0 && rng.next() < insectRate * dt) {
      api.play('insect', { gain: 0.4 + rng.next() * 0.4, pan: (rng.next() - 0.5) * 1.7 });
    }
    if (owlRate > 0 && rng.next() < owlRate * dt) {
      api.play('owl', { gain: 0.6 + rng.next() * 0.4, pan: (rng.next() - 0.5) * 1.2 });
    }
    if (world.nearWater > 0.25 && lapCool <= 0 && rng.next() < world.nearWater * 0.5 * dt) {
      api.play('lap', { gain: world.nearWater, pan: (rng.next() - 0.5) * 1.0 });
      lapCool = 1.2 + rng.next() * 2.5;
    }

    // tell anyone listening when the soundscape changes regime — cheap, and it makes the
    // event log readable ("crickets came in at 4m10s")
    const regime = `${world.mode}|${birdRate > 0.15 ? 'birds' : '-'}|${insectRate > 0.25 ? 'insects' : '-'}|${cricketRate > 0.3 ? 'crickets' : '-'}|${world.nearWater > 0.3 ? 'water' : '-'}|${windLevel > 0.55 ? 'windy' : '-'}`;
    if (regime !== lastRegime) {
      lastRegime = regime;
      emit('audio:ambience', {
        phase: world.mode, birds: +birdRate.toFixed(2), insects: +insectRate.toFixed(2),
        crickets: +cricketRate.toFixed(2), wind: +windLevel.toFixed(2), water: +world.nearWater.toFixed(2),
      });
    }
  }

  // =======================================================================
  // footsteps
  // =======================================================================
  function updateFootsteps(dt, c) {
    const pl = c.get?.('player');
    const p = pl?.position;
    if (!p) return;
    if (!havePrev) { prevPos.x = p.x; prevPos.y = p.y; prevPos.z = p.z; havePrev = true; lastY = p.y; return; }

    const dx = p.x - prevPos.x, dz = p.z - prevPos.z;
    const moved = Math.hypot(dx, dz);
    const speed = dt > 0 ? moved / dt : 0;
    prevPos.x = p.x; prevPos.y = p.y; prevPos.z = p.z;

    const state = pl.state ?? 'idle';
    const grounded = state !== 'jump' && state !== 'fall';

    if (!grounded) {
      fallFrom = Math.max(fallFrom, p.y);
      if (wasGrounded) api.play('jump', { surface: world.surface, gain: 0.8 });
    } else if (!wasGrounded) {
      const drop = clamp((fallFrom - p.y) / 3.5, 0.2, 2);
      api.play('land', { surface: world.surface, impact: drop, gain: 0.9 });
      birdHush = Math.max(birdHush, 2.2 + drop);
      fallFrom = p.y;
      stepAccum = 0;
    } else {
      fallFrom = p.y;
    }
    wasGrounded = grounded;
    lastY = p.y;

    if (!grounded || speed < 0.35) { stepAccum = Math.min(stepAccum, 0.6); return; }

    // stride grows with speed, so a walk and a sprint have different cadence AND
    // different weight rather than just being the same clip played faster
    const gait = state === 'run' ? 'run' : state === 'crouch' ? 'crouch' : 'walk';
    const stride = gait === 'run' ? 2.35 : gait === 'crouch' ? 1.05 : 1.65;
    stepAccum += moved;
    if (stepAccum >= stride) {
      stepAccum -= stride;
      stepFoot = -stepFoot;
      const surf = surfaceAt(p.x, p.z);
      world.surface = surf;
      api.play('step', {
        surface: surf, gait, gain: clamp(0.55 + speed * 0.06, 0.5, 1.15),
        pan: stepFoot * 0.13,
      });
      if (gait === 'run') birdHush = Math.max(birdHush, 1.4);
    }
  }

  // =======================================================================
  // creature voices and footfalls
  // =======================================================================
  function ensureCreature(cr) {
    let s = cstate.get(cr.id);
    if (!s) {
      // per-individual pitch: deterministic from id, so a given Pal always sounds like
      // itself across sessions
      const h = Math.imul(cr.id ^ 0x9e3779b9, 2654435761) >>> 0;
      s = {
        pitch: 0.86 + ((h % 1000) / 1000) * 0.30,
        chatty: 0.6 + ((h >>> 12) % 100) / 100 * 0.8,
        mood: null, cool: rng.range(0, 2), idle: rng.range(4, 16),
        stepAccum: 0, px: cr.position?.x ?? 0, pz: cr.position?.z ?? 0,
        dist: 999, timbre: timbreFor(cr.species, cr.def ?? cr.stats),
      };
      cstate.set(cr.id, s);
    }
    return s;
  }

  function voiceCreature(cr, call, force = false) {
    const s = ensureCreature(cr);
    if (!force && (s.cool > 0 || voiceCool > 0)) return false;
    // a creature that event-fired this frame may not have been sensed yet (s.dist is still
    // the 999 sentinel), which would silently swallow its voice — fill it in on the spot
    if (s.dist >= 999) s.dist = distTo(cr);
    if (s.dist > VOICE_RANGE) return false;
    const sp = spatialOf(cr.position, 9);
    const name = call ?? MOOD_CALL[cr.mood] ?? IDLE_CALL[cr.species] ?? 'coo';
    s.cool = 1.1 + rng.next() * 1.4;
    voiceCool = 0.16;
    api.play('call', {
      call: name, species: cr.species, id: cr.id,
      timbre: s.timbre, pitch: s.pitch,
      gain: sp.gain * (call === 'snuffle' ? 0.8 : 1),
      pan: sp.pan, distance: sp.distance,
    });
    if (voiceEmitCool <= 0) {
      voiceEmitCool = 1.6;
      emit('audio:voice', { species: cr.species, id: cr.id, call: name, distance: sp.distance });
    }
    return true;
  }

  function updateCreatures(dt, c) {
    const cs = c.get?.('creatures');
    const list = cs?.list;
    if (!Array.isArray(list) || !list.length) return;
    const p = playerPos();

    // prune state for creatures that no longer exist
    if (cstate.size > list.length + 8) {
      const live = new Set(list.map((x) => x.id));
      for (const k of [...cstate.keys()]) if (!live.has(k)) cstate.delete(k);
    }

    let stepBudget = 3;
    for (const cr of list) {
      if (!cr || cr.id == null || !cr.position) continue;
      const s = ensureCreature(cr);
      s.cool = Math.max(0, s.cool - dt);
      s.idle -= dt;
      s.dist = Math.hypot(cr.position.x - p.x, cr.position.z - p.z);

      // --- mood changes are the main source of creature sound -------------
      const mood = cr.mood ?? 'calm';
      if (mood !== s.mood) {
        const first = s.mood === null;
        s.mood = mood;
        // don't shout on the very first frame, and don't narrate every tiny flicker
        if (!first && s.dist < VOICE_RANGE && MOOD_CALL[mood]) {
          const urgency = mood === 'afraid' || mood === 'fleeing' ? 1 : 0.55;
          if (rng.next() < urgency) voiceCreature(cr, MOOD_CALL[mood]);
        }
      }

      // --- idle chatter ---------------------------------------------------
      if (s.idle <= 0) {
        s.idle = (7 + rng.next() * 16) / clamp(s.chatty, 0.5, 1.6);
        if (s.dist < 26) {
          const call = cr.tamed ? (rng.next() < 0.5 ? 'purr' : 'trill')
            : MOOD_CALL[cr.mood] ?? IDLE_CALL[cr.species] ?? 'coo';
          voiceCreature(cr, call);
        }
      }

      // --- their footfalls, only for the few nearest ----------------------
      const dx = cr.position.x - s.px, dz = cr.position.z - s.pz;
      s.px = cr.position.x; s.pz = cr.position.z;
      if (stepBudget > 0 && s.dist < 16) {
        const moved = Math.hypot(dx, dz);
        if (moved > 0.001) {
          s.stepAccum += moved;
          const size = cr.stats?.size ?? cr.def?.size ?? 1;
          const stride = clamp(size * 1.15, 0.5, 2.6);
          if (s.stepAccum >= stride) {
            s.stepAccum -= stride;
            stepBudget--;
            const sp = spatialOf(cr.position, 7);
            api.play('creature_step', {
              surface: surfaceAt(cr.position.x, cr.position.z),
              gait: moved / Math.max(dt, 1e-4) > 3 ? 'run' : 'walk',
              gain: sp.gain * clamp(0.35 + size * 0.35, 0.3, 1),
              pan: sp.pan,
            });
          }
        }
      }
    }
  }

  // =======================================================================
  // music
  // =======================================================================
  function updateMusic(dt) {
    if (!music) return;
    const before = music.phase;
    const cues = music.update(dt);
    for (const cue of cues) api.play(cue.name, cue.params);
    if (music.phase !== before) {
      emit('audio:music', { phase: music.phase, mode: music.mode });
    }
  }

  // =======================================================================
  // interaction reactions
  // =======================================================================
  function onFocus(p) {
    const target = p?.target;
    if (!target) return;
    api.play('focus', { gain: 0.8 });
    // a creature notices you noticing it
    if (target.id != null && target.position && rng.next() < 0.55) {
      voiceCreature(target, target.tamed ? 'trill' : 'chirp');
    }
  }

  // ---- the social arc (AI system) -----------------------------------------
  // These fire mid-frame, before the audio update; each handler only speaks when the
  // creature is actually within earshot, and voiceCreature's own cooldowns keep a busy
  // meadow from turning into a shouting match.

  function onNoticed(p) {
    const cr = p?.creature;
    if (cr) voiceCreature(cr, 'chirp');   // "what was that?" — a quiet question
  }

  function onApproach(p) {
    const cr = p?.creature;
    if (cr) voiceCreature(cr, 'coo');     // curiosity won; a soft invitation
  }

  function onSettled(p) {
    const cr = p?.creature;
    if (cr) voiceCreature(cr, 'purr');    // it came as close as it dares — contentment
  }

  function onStartled(p) {
    const cr = p?.creature;
    const d = p?.dist ?? (cr ? distTo(cr) : 99);
    if (cr) voiceCreature(cr, 'yip', true);   // a real alarm, species-timbered
    if (d < 26) birdHush = Math.max(birdHush, 2.6);   // the meadow goes quiet with it
  }

  function onPlay(p) {
    const cr = p?.a ?? p?.b;
    if (!cr || playCool > 0) return;
    playCool = 3.2;
    const sp = spatialOf(cr.position, 8);
    api.play('playful', { gain: sp.gain, pan: sp.pan });
    if (p?.a) voiceCreature(p.a, 'trill', true);
    if (p?.b) voiceCreature(p.b, 'trill', true);
  }

  // ---- the taming verbs (interaction system) ------------------------------

  function onTamedNotice(p) {
    const cr = p?.creature;
    if (cr) voiceCreature(cr, 'chirp');
  }

  function onOffer(p) {
    const mode = p?.mode ?? 'toss';
    const cr = p?.creature;
    const sp = cr?.position ? spatialOf(cr.position, 8) : { pan: 0, gain: 1 };
    api.play('offer', { mode, gain: mode === 'toss' ? 0.9 : 0.85, pan: sp.pan * 0.5 });
    if (mode === 'toss' && cr && rng.next() < 0.5) voiceCreature(cr, 'chirp');
    emit('audio:sting', { name: 'offer', mode, species: cr?.species ?? null });
  }

  function onTrustTick(p) {
    const delta = p?.delta ?? 0;
    if (delta > 0.09 && trustCool <= 0) {
      trustCool = 1.2;
      const cr = p?.creature;
      const sp = cr?.position ? spatialOf(cr.position, 6) : { pan: 0, gain: 1 };
      api.play('trust', { gain: clamp(0.5 + (p?.trust ?? 0.5) * 0.6, 0.4, 1.1), pan: sp.pan * 0.4 });
      emit('audio:sting', { name: 'trust', species: cr?.species ?? null });
    } else if (delta <= -0.12) {
      // lost real ground — the whole area feels the tension
      birdHush = Math.max(birdHush, 1.2);
    }
  }

  function onSpook(p) {
    const cr = p?.creature;
    const sp = cr?.position ? spatialOf(cr.position, 7) : { pan: 0, gain: 1 };
    api.play('spook', { gain: sp.gain, pan: sp.pan });
    if (cr) voiceCreature(cr, 'yip', true);
    if (sp.distance < 20) birdHush = Math.max(birdHush, 2.4);
    emit('audio:sting', { name: 'spook', species: cr?.species ?? null });
  }

  function onStage(p) {
    // a stage-up earned by patience arrives without a taming:trust — give it a small chime
    if (!p?.up || trustCool > 0) return;
    trustCool = 0.8;
    api.play('trust', { gain: 0.5 });
  }

  function onPet(p) {
    const cr = p?.creature;
    const sp = cr?.position ? spatialOf(cr.position, 6) : { pan: 0, gain: 1 };
    api.play('pet', { gain: sp.gain, pan: sp.pan * 0.5 });
    if (cr) voiceCreature(cr, 'purr', true);
    emit('audio:sting', { name: 'pet', species: cr?.species ?? null });
  }

  function onGatherStart(p) {
    api.play('gather_start', { gain: 0.9, kind: p?.kind });
    birdHush = Math.max(birdHush, 0.9);
  }

  function onGatherComplete(p) {
    lastGatherAt = ctx?.elapsed ?? 0;
    const pos = p?.position;
    const sp = pos ? spatialOf(pos, 6) : { pan: 0, gain: 1 };
    api.play('gather', { gain: clamp(sp.gain + 0.15, 0.4, 1), pan: sp.pan * 0.6, kind: p?.kind });
    emit('audio:sting', { name: 'gather', kind: p?.kind, item: p?.item });
  }

  // =======================================================================
  // BOND SPHERES
  //
  // Five beats, five cues, and one editorial decision that runs through all of them:
  // the meadow REACTS. A sphere hitting a creature hushes the birds for as long as a
  // gunshot would; the loop is loud and the world is meant to notice.
  // =======================================================================

  function onSphereThrown(p) {
    const from = p?.from ?? playerPos();
    const sp = spatialOf(from, 10);
    api.play('sphere_throw', { gain: clamp(sp.gain + 0.35, 0.5, 1), pan: sp.pan * 0.5 });
    birdHush = Math.max(birdHush, 1.4);
    emit('audio:sting', { name: 'sphere_throw', chance: p?.chance ?? null });
  }

  function onSphereHit(p) {
    const cr = p?.creature;
    const sp = cr?.position ? spatialOf(cr.position, 9) : { pan: 0, gain: 1, distance: 6 };
    api.play('sphere_hit', { gain: clamp(sp.gain + 0.2, 0.35, 1.05), pan: sp.pan });
    // it gets one startled cry in before the shell shuts on it
    if (cr) voiceCreature(cr, 'yip', true);
    birdHush = Math.max(birdHush, 3.2);
    emit('audio:sting', { name: 'sphere_hit', species: cr?.species ?? null });
  }

  /**
   * The wobble. The RISING part is not a mix trick — `shake` and `of` go straight into
   * the cue, which shortens, brightens and hardens each rock and stacks one more beat of
   * a held tension tone (see Cues.js). Here the only job is to make each one a little
   * louder than the last, so a third wobble is audibly the last chance.
   */
  function onSphereShake(p) {
    const cr = p?.creature;
    const n = Math.max(1, p?.shake ?? 1);
    const sp = cr?.position ? spatialOf(cr.position, 8) : { pan: 0, gain: 1 };
    api.play('sphere_shake', {
      shake: n, of: p?.of ?? 3,
      gain: clamp(sp.gain * (0.8 + n * 0.14) + 0.15, 0.3, 1.05), pan: sp.pan,
    });
    birdHush = Math.max(birdHush, 1.6);
  }

  function onSphereCaught(p) {
    const cr = p?.creature;
    const sp = cr?.position ? spatialOf(cr.position, 8) : { pan: 0, gain: 1 };
    // Just the latch and a glow. `creature:tamed` lands immediately behind this and
    // onTamed() ducks everything for the bond chord — two chords over each other would
    // rob the one moment in the slice that is allowed to be big.
    api.play('sphere_caught', { gain: clamp(sp.gain + 0.3, 0.5, 1), pan: sp.pan * 0.6 });
    emit('audio:sting', { name: 'sphere_caught', species: cr?.species ?? null });
  }

  function onSphereEscaped(p) {
    const cr = p?.creature;
    const sp = cr?.position ? spatialOf(cr.position, 8) : { pan: 0, gain: 1 };
    api.play('sphere_escaped', { gain: clamp(sp.gain + 0.25, 0.45, 1.05), pan: sp.pan });
    if (cr) {
      voiceCreature(cr, 'yip', true);
      const s = ensureCreature(cr);
      s.cool = 0.9; s.idle = 1.6;      // it grumbles again once it is back on its feet
    }
    birdHush = Math.max(birdHush, 3.4);
    emit('audio:sting', { name: 'sphere_escaped', species: cr?.species ?? null, atShake: p?.atShake ?? null });
  }

  // =======================================================================
  // WEAPONS
  // =======================================================================

  function onWeaponFired(p) {
    const from = p?.from ?? playerPos();
    const sp = spatialOf(from, 14);
    api.play('weapon_fire', {
      id: p?.id ?? 'pistol',
      gain: clamp(sp.gain + 0.55, 0.6, 1.15), pan: sp.pan * 0.35,
    });
    // the single loudest thing in the game: nothing sings for a while afterwards
    birdHush = Math.max(birdHush, 7.5);
    emit('audio:sting', { name: 'weapon_fire', id: p?.id ?? null });
  }

  function onWeaponImpact(p) {
    const pt = p?.point;
    if (!pt) return;
    const sp = spatialOf(pt, 12);
    // a hit at 90 m should be a distant tick, not a slap on the ear
    api.play('weapon_impact', { surface: p?.surface ?? 'dirt', gain: clamp(sp.gain * 1.3, 0.05, 1), pan: sp.pan });
  }

  function onWeaponHit(p) {
    const cr = p?.creature;
    const sp = cr?.position ? spatialOf(cr.position, 10) : { pan: 0, gain: 1 };
    api.play('weapon_flesh', { gain: clamp(sp.gain + 0.15, 0.25, 1), pan: sp.pan });
    // A held rifle trigger lands ten rounds a second. Forcing a yelp on each one turns a
    // frightened animal into a machine gun of its own, so the cry is throttled to the
    // rate a real one could make it — the thud of every round still lands.
    if (cr && hitVoiceCool <= 0) {
      hitVoiceCool = 0.42;
      voiceCreature(cr, 'yip', true);
    }
    birdHush = Math.max(birdHush, 7.5);
    emit('audio:sting', { name: 'weapon_hit', species: cr?.species ?? null, exhausted: !!p?.exhausted });
  }

  function onWeaponDry(p) {
    api.play('weapon_dry', { gain: 0.9, id: p?.id ?? null });
  }

  function onWeaponReload(p) {
    const phase = p?.phase;
    // 'start' and 'magout' arrive on the same frame and mean the same thing; 'cancel'
    // gets the settle tick so an interrupted reload is audibly interrupted.
    if (phase === 'start') return;
    api.play('weapon_reload', { phase: phase === 'cancel' ? 'done' : phase, gain: phase === 'done' ? 0.7 : 0.95 });
  }

  function onWeaponAim(p) {
    api.play('weapon_aim', { aiming: !!p?.aiming, gain: 0.85 });
  }

  /**
   * Spent. Not hurt, not dying — winded, and it is the audio layer's job to make that
   * unambiguous, because a sound that reads as damage in a game with no death is a lie
   * the player will believe. A low sagging grumble is an animal getting its breath back.
   */
  function onExhausted(p) {
    const cr = p?.creature;
    if (!cr) return;
    const s = ensureCreature(cr);
    s.cool = 0; voiceCool = 0;
    voiceCreature(cr, 'grumble', true);
    s.cool = 2.2;
    s.idle = 3.0;
    emit('audio:sting', { name: 'exhausted', species: cr.species ?? null });
  }

  // ---- the field kit ------------------------------------------------------

  function onJournal(p) {
    api.play('journal', { open: !!p?.open, gain: 0.8 });
  }

  function onDiscover(p) {
    api.play('discover', { gain: 0.85 });
    emit('audio:sting', { name: 'discover', species: p?.species ?? null });
  }

  function onWhistle(p) {
    api.play('whistle', { gain: 1 });
    // the nearest tamed creature answers with a happy trill
    const list = ctx?.get?.('creatures')?.list;
    let best = null, bd = 16;
    if (Array.isArray(list)) {
      for (const cr of list) {
        if (!cr?.tamed || !cr.position) continue;
        const d = distTo(cr);
        if (d < bd) { bd = d; best = cr; }
      }
    }
    if (best) voiceCreature(best, 'trill', true);
    emit('audio:sting', { name: 'whistle', companions: p?.count ?? 0 });
  }

  function onFed(p) {
    const cr = p?.creature;
    fedRecently = 0.5;
    const sp = cr?.position ? spatialOf(cr.position, 6) : { pan: 0, gain: 1, distance: 2 };
    api.play('nibble', { gain: 0.95, pan: sp.pan * 0.5 });
    if (cr) {
      // the eating snuffle first, then a little sound of approval a beat later
      voiceCreature(cr, 'snuffle', true);
      const s = ensureCreature(cr);
      s.idle = 1.05;             // the follow-up call lands on the next idle tick
      s.cool = 0.85;
      const trust = typeof cr.trust === 'number' ? cr.trust : 0;
      if (trust > 0.25 && trust < 1 && trustCool <= 0) {
        trustCool = 1.0;       // taming:trust usually sings this already; never double it
        api.play('trust', { gain: clamp(0.5 + trust * 0.6, 0.4, 1.1) });
      }
    }
    emit('audio:sting', { name: 'nibble', species: cr?.species ?? null });
  }

  function onTrust(p) {
    if (p?.creature && !p.creature.tamed) api.play('trust', { gain: 0.8 });
  }

  /**
   * THE MOMENT. A creature has decided to trust you. Everything else gets out of the way
   * for four seconds: the ambience and the music duck, the chord swells, the creature
   * trills over the top of it, and the music comes back in behind.
   */
  function onTamed(p) {
    const cr = p?.creature;
    try { engine?.duck(1, 2.2, 3.0); } catch { /* ignore */ }
    api.play('bond', { gain: 1 });
    if (cr) {
      const s = ensureCreature(cr);
      s.cool = 0; voiceCool = 0;
      voiceCreature(cr, 'trill', true);
      s.cool = 2.6;
      s.idle = 3.4;              // it purrs again once the chord has settled
      s.mood = cr.mood ?? 'happy';
    }
    music?.celebrate();
    emit('audio:sting', { name: 'bond', species: cr?.species ?? null });
  }

  /** gather stings, inferred when nothing emits an explicit gather event */
  function onInventory(inv) {
    if (!inv || typeof inv !== 'object') return;
    const prev = lastInv;
    lastInv = { ...inv };
    if (!prev || fedRecently > 0) return;
    // gather:complete is the authoritative source and runs in the same frame — if it has
    // sung recently, stay quiet. This fallback exists only for systems that might add
    // inventory without an accompanying event.
    if ((ctx?.elapsed ?? 0) - lastGatherAt < 2.5) return;
    for (const [k, v] of Object.entries(inv)) {
      if (typeof v === 'number' && v > (prev[k] ?? 0)) {
        api.play('gather', { gain: 1 });
        emit('audio:sting', { name: 'gather', item: k });
        return;
      }
    }
  }

  function emit(evt, payload) {
    try { ctx?.bus?.emit?.(evt, payload); } catch { /* ignore */ }
  }

  return api;
}
