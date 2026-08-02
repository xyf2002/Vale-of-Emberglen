/**
 * ENGINE — the mixer. Owns the AudioContext graph and nothing else; it knows how to
 * make a sound but never decides when to make one (that is the director in index.js).
 *
 *   cue ──► bus (ambience|music|voice|foley|sfx) ──┐
 *   cue send ──► reverb ──► reverbReturn ──────────┴─► master ─► limiter ─► out
 *
 * Kept deliberately separate from the game so the whole synthesis stack can be rendered
 * into an OfflineAudioContext and measured without a speaker.
 */
import { assets, gain, clamp, db } from './dsp.js';
import { CUES } from './Cues.js';
import { createAmbience } from './Ambience.js';
import { Rng } from '../engine/Rng.js';

const BUS_TRIM = {
  ambience: db(-4),
  music: db(-9),
  voice: db(-3),
  foley: db(-8),
  sfx: db(-4),
};

/** buses that duck under the bond sting, and by how much */
const DUCK_TARGETS = { ambience: 0.42, music: 0.22, voice: 0.55, foley: 0.5 };

export function createEngine(ac, { masterGain = 0.85, fadeIn = 1.4, seed = 0xbee7 } = {}) {
  const rng = new Rng(seed);

  const limiter = ac.createDynamicsCompressor();
  limiter.threshold.value = -8;
  limiter.knee.value = 6;
  limiter.ratio.value = 8;
  limiter.attack.value = 0.004;
  limiter.release.value = 0.18;
  limiter.connect(ac.destination);

  const master = gain(ac, 0.0001);
  master.connect(limiter);
  master.gain.setValueAtTime(0.0001, ac.currentTime);
  master.gain.linearRampToValueAtTime(masterGain, ac.currentTime + fadeIn);

  const reverbReturn = gain(ac, 0.85);
  const conv = ac.createConvolver();
  conv.buffer = assets(ac).hall;
  const reverbIn = gain(ac, 1);
  reverbIn.connect(conv); conv.connect(reverbReturn); reverbReturn.connect(master);

  const buses = {};
  const busBase = {};
  for (const name of Object.keys(BUS_TRIM)) {
    const g = gain(ac, BUS_TRIM[name]);
    g.connect(master);
    buses[name] = g;
    busBase[name] = BUS_TRIM[name];
  }

  const ambience = createAmbience(ac, buses.ambience, reverbIn);

  let muted = false;
  let userGain = masterGain;
  let fired = 0;          // cues started in the current window
  let windowT = 0;

  function busOf(name) { return buses[CUES[name]?.bus ?? 'sfx'] ?? buses.sfx; }

  return {
    ac,
    ambience,
    get state() { return ac.state; },
    get muted() { return muted; },

    /**
     * Fire a cue. `p.when` may pin an absolute context time (used by offline rendering);
     * otherwise it plays a hair in the future so the scheduler is never late.
     */
    cue(name, p = {}) {
      const spec = CUES[name];
      if (!spec) return false;
      const now = ac.currentTime;
      // crude polyphony guard: never let a pathological frame spawn hundreds of voices
      if (now - windowT > 0.25) { windowT = now; fired = 0; }
      const critical = spec.bus === 'sfx' || spec.bus === 'music';
      if (!critical && fired > 26) return false;
      fired++;
      // `delay` lets the director roll a chord or a bell phrase out over time from a
      // single frame; `when` pins an absolute time (offline rendering / tests).
      const t = p.when != null ? p.when : now + 0.012 + (p.delay || 0);
      spec.fn(ac, { dry: busOf(name), wet: reverbIn, t }, p, rng);
      return true;
    },

    /** continuous ambience levels, 0..1 each */
    setAmbience(levels, gustBand) { ambience.set(levels, gustBand); },

    /** pull everything except the sfx bus down under an important moment */
    duck(amount = 1, holdFor = 1.8, release = 2.6) {
      const t = ac.currentTime;
      for (const [name, factor] of Object.entries(DUCK_TARGETS)) {
        const g = buses[name]?.gain;
        if (!g) continue;
        const base = busBase[name];
        g.cancelScheduledValues(t);
        g.setValueAtTime(g.value, t);
        g.linearRampToValueAtTime(base * (1 - (1 - factor) * clamp(amount, 0, 1)), t + 0.25);
        g.setValueAtTime(base * (1 - (1 - factor) * clamp(amount, 0, 1)), t + holdFor);
        g.linearRampToValueAtTime(base, t + holdFor + release);
      }
    },

    setMuted(m) {
      muted = !!m;
      const t = ac.currentTime;
      master.gain.cancelScheduledValues(t);
      master.gain.setValueAtTime(Math.max(0.0001, master.gain.value), t);
      master.gain.linearRampToValueAtTime(muted ? 0.0001 : userGain, t + 0.25);
    },

    setMasterGain(v) {
      userGain = clamp(v, 0, 1.2);
      if (!muted) master.gain.setTargetAtTime(userGain, ac.currentTime, 0.15);
    },

    /** reverb size follows the space you are in: open valley vs. tight hollow */
    setSpace(size = 1) {
      reverbReturn.gain.setTargetAtTime(clamp(0.45 + size * 0.55, 0.2, 1.3), ac.currentTime, 1.5);
    },

    dispose() {
      try { ambience.dispose(); } catch { /* ignore */ }
      try { master.disconnect(); limiter.disconnect(); } catch { /* ignore */ }
    },
  };
}
