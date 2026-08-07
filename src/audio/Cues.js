/**
 * CUES — every one-shot sound in the game, synthesised from oscillators and noise.
 *
 * A cue is `(ac, out, p, rng) => void` where
 *   ac   AudioContext (real or Offline)
 *   out  { dry, wet, t }  destination gains + the absolute start time
 *   p    cue parameters from the director (pitch, gain, pan, surface, …)
 *   rng  deterministic Rng for per-hit variation
 *
 * Design rules that keep this from sounding like a synth demo:
 *  - every hit is detuned / re-filtered a little, so no two are identical;
 *  - decays are exponential (setTargetAtTime), never linear;
 *  - transients get a separate short noise layer from the body of the sound;
 *  - anything that happens outdoors gets a reverb send proportional to distance.
 */
import { Rng } from '../engine/Rng.js';
import { assets, gain, filter, panner, chain, loopSource, perc, swell, osc, fire, clamp, mtof } from './dsp.js';

// Deterministic stream used only to pick where in the noise buffer each burst reads from.
// Call order is fixed by the simulation, so this stays reproducible run to run.
const OFFSETS = new Rng(0x0ff5e7);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** short filtered noise burst — the workhorse for footsteps, snuffles, transients */
function burst(ac, out, { t, dur = 0.1, type = 'bandpass', freq = 2000, Q = 1, peak = 0.4, attack = 0.002, buffer = 'white', rate = 1, sweepTo = 0, wet = 0, pan = 0 }) {
  const a = assets(ac);
  const buf = buffer === 'pink' ? a.pink : buffer === 'brown' ? a.brown : a.white;
  const src = loopSource(ac, buf, rate);
  src.loop = false;
  // read from a different slice of the noise buffer every time, otherwise repeated
  // footsteps phase-match and turn into an obvious machine-gun loop
  src._offset = OFFSETS.next() * Math.max(0, buf.duration - dur * rate - 0.1);
  const f = filter(ac, type, freq, Q);
  if (sweepTo) {
    f.frequency.setValueAtTime(freq, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(40, sweepTo), t + dur);
  }
  const g = perc(ac, t, { peak, attack, decay: dur });
  const pn = panner(ac, pan);
  chain(src, f, g, pn || out.dry);
  if (pn) pn.connect(out.dry);
  if (wet > 0) {
    const w = gain(ac, wet);
    g.connect(w); w.connect(out.wet);
  }
  fire([src], g, t, t + dur + 0.35);
  return g;
}

/** a single decaying sine/triangle partial with optional pitch glide */
function partial(ac, out, { t, type = 'sine', freq, to = 0, glide = 0.06, peak = 0.2, attack = 0.004, decay = 0.2, detune = 0, wet = 0, pan = 0 }) {
  const o = osc(ac, type, freq, detune);
  if (to) {
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + glide);
  }
  const g = perc(ac, t, { peak, attack, decay });
  const pn = panner(ac, pan);
  o.connect(g);
  if (pn) { g.connect(pn); pn.connect(out.dry); } else g.connect(out.dry);
  if (wet > 0) { const w = gain(ac, wet); g.connect(w); w.connect(out.wet); }
  fire([o], g, t, t + decay * 3 + 0.1);
  return g;
}

/** Chowning-style FM bell: bright inharmonic attack collapsing to a pure tone. */
function fmBell(ac, out, { t, freq, peak = 0.16, decay = 1.6, index = 5.2, ratio = 3.51, pan = 0, wet = 0.5 }) {
  const car = osc(ac, 'sine', freq);
  const mod = osc(ac, 'sine', freq * ratio);
  const mi = gain(ac, freq * index);
  mi.gain.setValueAtTime(freq * index, t);
  mi.gain.setTargetAtTime(freq * 0.15, t, decay * 0.09);   // index collapses fast: metal -> tone
  mod.connect(mi); mi.connect(car.frequency);
  const g = perc(ac, t, { peak, attack: 0.003, decay });
  const pn = panner(ac, pan);
  car.connect(g);
  if (pn) { g.connect(pn); pn.connect(out.dry); } else g.connect(out.dry);
  const w = gain(ac, wet); g.connect(w); w.connect(out.wet);
  fire([car, mod], g, t, t + decay * 2.2 + 0.2);
  return g;
}

/**
 * Plucked string by additive harmonic decay. (A true Karplus-Strong feedback delay is
 * clamped to one render quantum in browsers, which caps the fundamental around 375 Hz —
 * far too low for a bright gathering pluck.)
 */
function pluck(ac, out, { t, freq, peak = 0.22, decay = 0.9, bright = 1, pan = 0, wet = 0.4 }) {
  const bus = gain(ac, 1);
  const pn = panner(ac, pan);
  if (pn) { bus.connect(pn); pn.connect(out.dry); } else bus.connect(out.dry);
  const w = gain(ac, wet); bus.connect(w); w.connect(out.wet);

  const harm = [1, 2, 3, 4.02, 5.05, 6.1];
  const amps = [1, 0.42, 0.24, 0.13, 0.08, 0.05];
  const srcs = [];
  for (let i = 0; i < harm.length; i++) {
    const f = freq * harm[i];
    if (f > 12000) break;
    const o = osc(ac, 'sine', f, (i % 2 ? 4 : -4));
    // higher partials die first — that is what makes a pluck read as a string
    const d = decay / (1 + i * 0.85 / bright);
    const g = perc(ac, t, { peak: peak * amps[i] * bright, attack: 0.002, decay: d });
    o.connect(g); g.connect(bus);
    srcs.push(o);
  }
  // pick transient
  burst(ac, { dry: bus, wet: out.wet }, { t, dur: 0.03, type: 'highpass', freq: 1800, peak: peak * 0.5, attack: 0.001 });
  fire(srcs, bus, t, t + decay * 2.5 + 0.3);
  return bus;
}

// ---------------------------------------------------------------------------
// FOOTSTEPS
// ---------------------------------------------------------------------------

/** per-surface recipe: the thump under the foot plus the material scuff on top */
const SURFACE = {
  grass: { thump: 78, thumpG: 0.30, scuffF: 2500, scuffQ: 0.8, scuffG: 0.30, scuffD: 0.115, tail: 0.16 },
  dirt: { thump: 68, thumpG: 0.40, scuffF: 1050, scuffQ: 0.7, scuffG: 0.26, scuffD: 0.075, tail: 0.05 },
  rock: { thump: 96, thumpG: 0.24, scuffF: 3900, scuffQ: 2.2, scuffG: 0.30, scuffD: 0.045, tail: 0.03, ring: 1500 },
  sand: { thump: 60, thumpG: 0.22, scuffF: 5200, scuffQ: 0.55, scuffG: 0.32, scuffD: 0.145, tail: 0.10 },
  water: { thump: 120, thumpG: 0.18, scuffF: 900, scuffQ: 0.6, scuffG: 0.42, scuffD: 0.22, tail: 0.22, splash: true },
  wood: { thump: 130, thumpG: 0.34, scuffF: 2200, scuffQ: 3.0, scuffG: 0.18, scuffD: 0.06, tail: 0.04, ring: 420 },
};

function step(ac, out, p, rng) {
  const s = SURFACE[p.surface] ?? SURFACE.grass;
  const t = out.t;
  const g = (p.gain ?? 1);
  const gait = p.gait ?? 'walk';
  // running lands harder and brighter; crouching is almost all scuff and no thump
  const heft = gait === 'run' ? 1.35 : gait === 'crouch' ? 0.4 : 1;
  const bright = gait === 'run' ? 1.25 : 0.95;
  const v = 0.86 + rng.next() * 0.28;      // no two footfalls identical

  partial(ac, out, {
    t, type: 'sine', freq: s.thump * v, to: s.thump * v * 0.55, glide: 0.05,
    peak: s.thumpG * g * heft, decay: 0.085, pan: p.pan ?? 0,
  });
  burst(ac, out, {
    t: t + 0.004, dur: s.scuffD * (gait === 'run' ? 0.85 : 1), type: 'bandpass',
    freq: s.scuffF * bright * v, Q: s.scuffQ, peak: s.scuffG * g * heft,
    pan: p.pan ?? 0, wet: 0.10 * g,
  });
  if (s.tail > 0.06) {
    // the grassy/sandy swish that trails the impact
    burst(ac, out, {
      t: t + 0.02, dur: s.tail, type: 'bandpass', freq: s.scuffF * 1.6 * v, Q: 0.5,
      peak: s.scuffG * 0.42 * g * heft, attack: 0.02, pan: (p.pan ?? 0) * 0.7,
    });
  }
  if (s.ring) partial(ac, out, { t, type: 'triangle', freq: s.ring * v, peak: 0.05 * g, decay: 0.07, pan: p.pan ?? 0 });
  if (s.splash) burst(ac, out, { t: t + 0.01, dur: 0.3, type: 'highpass', freq: 1200, peak: 0.16 * g, attack: 0.01, wet: 0.25 });
}

function land(ac, out, p, rng) {
  const s = SURFACE[p.surface] ?? SURFACE.grass;
  const t = out.t, g = (p.gain ?? 1) * clamp(0.6 + (p.impact ?? 1) * 0.7, 0.6, 1.8);
  partial(ac, out, { t, type: 'sine', freq: s.thump * 0.82, to: s.thump * 0.4, glide: 0.1, peak: 0.5 * g, decay: 0.16 });
  burst(ac, out, { t, dur: 0.19, type: 'bandpass', freq: s.scuffF * 0.85, Q: 0.6, peak: 0.4 * g, wet: 0.16 });
  burst(ac, out, { t: t + 0.03, dur: 0.26, type: 'bandpass', freq: s.scuffF * 2.1, Q: 0.5, peak: 0.16 * g, attack: 0.02 });
  // a breath of exertion, quiet, sells weight
  burst(ac, out, { t: t + 0.02, dur: 0.22, type: 'bandpass', freq: 620 + rng.next() * 120, Q: 1.6, peak: 0.07 * g, attack: 0.03 });
}

function jump(ac, out, p, rng) {
  const t = out.t, g = p.gain ?? 1;
  burst(ac, out, { t, dur: 0.13, type: 'bandpass', freq: 1500, Q: 0.9, peak: 0.2 * g, sweepTo: 2600 });
  burst(ac, out, { t: t + 0.01, dur: 0.24, type: 'bandpass', freq: 560 + rng.next() * 100, Q: 1.8, peak: 0.10 * g, attack: 0.02 });
}

// ---------------------------------------------------------------------------
// CREATURE VOICES
// ---------------------------------------------------------------------------

/**
 * Per-species timbre. `base` is the voice centre in Hz, `formant` the resonance that
 * gives the species its vowel, `grain` how much noise rides on the tone (fur/breath),
 * `wobble` vibrato speed. Individuals shift `base` by up to ±18%.
 */
/**
 * `level` is a loudness normalisation, not a mix choice. A 132 Hz sawtooth through a
 * 470 Hz formant puts out roughly 14 dB more than a 300 Hz triangle through a 950 Hz one,
 * so without this a Mosshorn grumble buries a Woolkin bleat. The curve below was fitted
 * to offline measurements of all three species so every close call peaks near -14 dBFS.
 */
export const TIMBRE = {
  woolkin: { base: 300, formant: 950, Q: 5, grain: 0.55, wobble: 5.0, type: 'triangle', body: 0.9, level: 2.50 },
  emberfox: { base: 640, formant: 2000, Q: 7, grain: 0.22, wobble: 8.5, type: 'sawtooth', body: 0.55, level: 2.00 },
  mosshorn: { base: 132, formant: 470, Q: 4, grain: 0.40, wobble: 3.2, type: 'sawtooth', body: 1.4, level: 0.50 },
  // `level` for these two is not hand-tuned by ear — it is levelFor(base, type) below,
  // evaluated and written out, which is what that function exists for. Retune only with
  // a measurement, the way the first three were.
  pumpkit: { base: 520, formant: 1500, Q: 6, grain: 0.30, wobble: 6.5, type: 'triangle', body: 0.7, level: 2.82 },
  shalehound: { base: 190, formant: 720, Q: 4, grain: 0.45, wobble: 3.6, type: 'sawtooth', body: 1.2, level: 0.69 },
};

/** the fitted normalisation, so species invented later are still in the same mix */
export function levelFor(base, type) {
  const v = type === 'sawtooth' ? 0.00689 * Math.pow(base, 0.878) : 0.46 * Math.pow(base, 0.29);
  return clamp(v, 0.25, 6);
}

/** Unknown species still get a plausible voice, scaled off their body size. */
export function timbreFor(species, def) {
  if (TIMBRE[species]) return TIMBRE[species];
  const size = clamp(def?.size ?? 1, 0.35, 4);
  const base = clamp(620 / Math.pow(size, 0.85), 90, 1400);
  const type = size > 1.2 ? 'sawtooth' : 'triangle';
  return {
    base, formant: base * 3.0, Q: 5, grain: 0.35,
    wobble: clamp(9 / size, 2.5, 9), type, body: size, level: levelFor(base, type),
  };
}

/**
 * Call shapes. Each is a list of syllables: pitch multiplier, glide target, length,
 * gap after, and how open (bright) the vowel is. This is where personality lives —
 * a curious chirp rises, a wary grumble sags, a happy trill dances.
 */
const CALLS = {
  chirp: { syl: [[1.0, 1.55, 0.09, 0.05, 1.0], [1.35, 1.9, 0.07, 0, 1.15]], peak: 0.34, air: 0.5 },
  trill: { syl: [[1.2, 1.5, 0.07, 0.03, 1.2], [1.5, 1.35, 0.06, 0.03, 1.25], [1.35, 1.85, 0.09, 0.04, 1.3], [1.8, 2.0, 0.14, 0, 1.35]], peak: 0.32, air: 0.35, vib: 1.6 },
  grumble: { syl: [[0.72, 0.6, 0.34, 0, 0.55]], peak: 0.30, air: 0.8, vib: 0.5, rough: 1.5 },
  yip: { syl: [[1.5, 1.05, 0.055, 0.07, 1.25], [1.35, 0.95, 0.05, 0, 1.1]], peak: 0.40, air: 0.35 },
  snuffle: { syl: [[0.9, 0.8, 0.055, 0.035, 0.5], [0.85, 0.95, 0.05, 0.04, 0.45], [0.95, 0.78, 0.06, 0, 0.5]], peak: 0.16, air: 2.4 },
  coo: { syl: [[0.95, 1.08, 0.22, 0, 0.7]], peak: 0.18, air: 0.9, vib: 0.9 },
  hum: { syl: [[0.8, 0.82, 0.5, 0, 0.5]], peak: 0.14, air: 0.6, vib: 0.6 },
  purr: { syl: [[0.62, 0.64, 0.7, 0, 0.4]], peak: 0.17, air: 1.4, rough: 3.0 },
  bleat: { syl: [[1.05, 0.9, 0.30, 0, 0.9]], peak: 0.32, air: 0.7, vib: 2.2 },
};

function creatureCall(ac, out, p, rng) {
  const tb = p.timbre ?? TIMBRE.woolkin;
  const shape = CALLS[p.call] ?? CALLS.chirp;
  const base = tb.base * (p.pitch ?? 1);
  const g = (p.gain ?? 1) * shape.peak * (tb.level ?? levelFor(tb.base, tb.type));
  const pan = p.pan ?? 0;
  const wet = clamp(0.18 + (p.distance ?? 4) * 0.02, 0.15, 0.62);
  let t = out.t;

  for (const [m0, m1, len, gap, open] of shape.syl) {
    const f0 = base * m0 * (0.98 + rng.next() * 0.04);
    const f1 = base * m1;
    const dur = len * (0.9 + rng.next() * 0.2);

    // voiced body: two detuned oscillators through a formant band-pass
    const bus = gain(ac, 1);
    const form = filter(ac, 'bandpass', tb.formant * open * (p.pitch ?? 1), tb.Q);
    const lp = filter(ac, 'lowpass', clamp(tb.formant * open * 3.2, 400, 12000), 0.8);
    const env = perc(ac, t, { peak: g, attack: Math.min(0.02, dur * 0.28), decay: dur * 0.9, hold: dur * 0.25 });
    const pn = panner(ac, pan);
    bus.connect(form); form.connect(lp); lp.connect(env);
    if (pn) { env.connect(pn); pn.connect(out.dry); } else env.connect(out.dry);
    const w = gain(ac, wet); env.connect(w); w.connect(out.wet);

    const srcs = [];
    for (let i = 0; i < 2; i++) {
      const o = osc(ac, tb.type, f0, i ? 7 : -7);
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + dur * 0.85);
      srcs.push(o);
      o.connect(bus);
    }
    // vibrato / roughness — a flat pitch is the single biggest "this is a synth" tell
    const vibAmt = (shape.vib ?? 0.6) * f0 * 0.022;
    if (vibAmt > 0.2) {
      const lfo = osc(ac, 'sine', tb.wobble * (0.85 + rng.next() * 0.3));
      const la = gain(ac, vibAmt);
      lfo.connect(la);
      for (const o of srcs) la.connect(o.frequency);
      srcs.push(lfo);
    }
    if (shape.rough) {
      // amplitude buzz for grumbles and purrs
      const r = osc(ac, 'sine', 22 * shape.rough * (0.9 + rng.next() * 0.2));
      const ra = gain(ac, 0.45);
      r.connect(ra); ra.connect(env.gain);
      srcs.push(r);
    }
    // breath / fur grain riding on the call
    if (tb.grain * shape.air > 0.05) {
      burst(ac, { dry: out.dry, wet: out.wet }, {
        t, dur: dur * 1.1, type: 'bandpass', freq: tb.formant * open * 1.4, Q: 1.4,
        peak: g * tb.grain * shape.air * 0.5, attack: dur * 0.2, pan,
      });
    }
    fire(srcs, bus, t, t + dur * 2 + 0.2);
    t += dur + gap;
  }
}

// ---------------------------------------------------------------------------
// INTERACTION STINGS
// ---------------------------------------------------------------------------

function gather(ac, out, p, rng) {
  const t = out.t, g = p.gain ?? 1;
  const kind = p.kind ?? 'berry';
  // a rustle of leaves (or chippings, or shavings) — the shared "you disturbed it" opening
  burst(ac, out, { t, dur: 0.18, type: 'bandpass', freq: kind === 'stone' ? 2100 : 3000, Q: 0.7, peak: 0.20 * g, wet: 0.2 });
  burst(ac, out, { t: t + 0.05, dur: 0.13, type: 'bandpass', freq: kind === 'stone' ? 3200 : 4600, Q: 0.9, peak: 0.11 * g, attack: 0.01 });
  if (kind === 'wood') {
    // two dry woody knocks — the branch surrenders, nothing musical about it
    partial(ac, out, { t: t + 0.02, type: 'sine', freq: 240, to: 170, glide: 0.03, peak: 0.22 * g, decay: 0.1 });
    partial(ac, out, { t: t + 0.09, type: 'sine', freq: 305, to: 215, glide: 0.03, peak: 0.16 * g, decay: 0.09 });
    burst(ac, out, { t: t + 0.12, dur: 0.1, type: 'bandpass', freq: 1200, Q: 1.4, peak: 0.09 * g, attack: 0.01 });
  } else if (kind === 'stone') {
    // a dry mineral clink, inharmonic and immediate
    fmBell(ac, out, { t: t + 0.02, freq: mtof(84), peak: 0.16 * g, decay: 0.5, index: 6, ratio: 4.3, wet: 0.4 });
    fmBell(ac, out, { t: t + 0.1, freq: mtof(88), peak: 0.10 * g, decay: 0.4, index: 6, ratio: 4.3, wet: 0.4 });
  } else {
    // two bright plucked notes — "you took something living"
    const root = mtof(76 + (rng.next() < 0.5 ? 0 : 2));   // E5 / F#5
    pluck(ac, out, { t: t + 0.02, freq: root, peak: 0.24 * g, decay: 0.75, wet: 0.42 });
    pluck(ac, out, { t: t + 0.115, freq: root * 1.5, peak: 0.17 * g, decay: 0.62, bright: 1.15, wet: 0.45 });
    fmBell(ac, out, { t: t + 0.1, freq: root * 3, peak: 0.05 * g, decay: 1.1, wet: 0.6 });
  }
}

/** a bush or tree being worked — the swish you make *before* the reward arrives */
function gatherStart(ac, out, p, rng) {
  const t = out.t, g = p.gain ?? 1;
  burst(ac, out, { t, dur: 0.28, type: 'bandpass', freq: 3400, Q: 0.6, peak: 0.16 * g, attack: 0.05, wet: 0.2 });
  burst(ac, out, { t: t + 0.05, dur: 0.2, type: 'bandpass', freq: 2400, Q: 0.8, peak: 0.10 * g, attack: 0.03 });
  burst(ac, out, { t: t + 0.12, dur: 0.16, type: 'bandpass', freq: 4600, Q: 0.6, peak: 0.07 * g, attack: 0.04, wet: 0.15 });
}

/**
 * Offering a berry. Mode picks the gesture:
 *   toss  — a short arc: the whoosh away, a soft landing out there
 *   hand  — "here": one warm low note, nearly a touch
 *   empty — a rueful double tick, the sound of a pocket that has nothing in it
 */
function offer(ac, out, p, rng) {
  const t = out.t, g = p.gain ?? 1;
  const mode = p.mode ?? 'toss';
  if (mode === 'empty') {
    burst(ac, out, { t, dur: 0.05, type: 'bandpass', freq: 1400, Q: 2.5, peak: 0.09 * g });
    burst(ac, out, { t: t + 0.09, dur: 0.06, type: 'bandpass', freq: 1050, Q: 2.5, peak: 0.07 * g });
    return;
  }
  if (mode === 'hand') {
    partial(ac, out, { t, type: 'triangle', freq: 220, to: 330, glide: 0.12, peak: 0.13 * g, decay: 0.3, wet: 0.35, pan: p.pan ?? 0 });
    burst(ac, out, { t: t + 0.02, dur: 0.09, type: 'bandpass', freq: 3000, Q: 0.8, peak: 0.07 * g, attack: 0.02 });
    return;
  }
  burst(ac, out, { t, dur: 0.22, type: 'bandpass', freq: 2100, Q: 0.7, peak: 0.15 * g, sweepTo: 820, attack: 0.03, pan: (p.pan ?? 0) * 0.8, wet: 0.2 });
  partial(ac, out, { t: t + 0.06, type: 'sine', freq: 300, to: 200, glide: 0.16, peak: 0.05 * g, decay: 0.18, wet: 0.3 });
  burst(ac, out, { t: t + 0.24, dur: 0.05, type: 'bandpass', freq: 700, Q: 1.5, peak: 0.08 * g, attack: 0.005, wet: 0.25 });
}

/** a shy flinch — the sharp breath of an animal that has changed its mind about you */
function spook(ac, out, p, rng) {
  const t = out.t, g = p.gain ?? 1;
  burst(ac, out, { t, dur: 0.07, type: 'bandpass', freq: 2600 + rng.next() * 500, Q: 1.4, peak: 0.16 * g, attack: 0.003, pan: p.pan ?? 0 });
  burst(ac, out, { t: t + 0.02, dur: 0.12, type: 'bandpass', freq: 1300, Q: 1.1, peak: 0.10 * g, attack: 0.006, sweepTo: 700, wet: 0.2 });
  // leaves jump with it
  burst(ac, out, { t: t + 0.03, dur: 0.14, type: 'bandpass', freq: 3800, Q: 0.6, peak: 0.06 * g, attack: 0.015 });
}

/** being petted — a warm low thrum and one soft fur stroke */
function pet(ac, out, p, rng) {
  const t = out.t, g = p.gain ?? 1;
  partial(ac, out, { t, type: 'triangle', freq: 130, to: 165, glide: 0.1, peak: 0.14 * g, decay: 0.34, wet: 0.3, pan: p.pan ?? 0 });
  burst(ac, out, { t: t + 0.03, dur: 0.12, type: 'bandpass', freq: 2400, Q: 0.9, peak: 0.08 * g, attack: 0.02, wet: 0.2 });
}

/** two springy notes chasing each other — the sound of two creatures playing */
function playful(ac, out, p, rng) {
  const t = out.t, g = p.gain ?? 1;
  const root = mtof(81 + Math.floor(rng.next() * 3));
  pluck(ac, out, { t, freq: root, peak: 0.10 * g, decay: 0.4, bright: 1.2, wet: 0.4, pan: -0.3 });
  pluck(ac, out, { t: t + 0.14, freq: root * 1.26, peak: 0.08 * g, decay: 0.35, bright: 1.2, wet: 0.4, pan: 0.3 });
}

/** the field journal opening or closing — paper, then a wooden rest */
function journal(ac, out, p, rng) {
  const t = out.t, g = p.gain ?? 1;
  const open = !!p.open;
  burst(ac, out, { t, dur: 0.16, type: 'bandpass', freq: 2600, Q: 0.7, peak: 0.11 * g, attack: 0.015, pan: open ? 0.2 : -0.2, wet: 0.15 });
  burst(ac, out, { t: t + 0.04, dur: 0.09, type: 'bandpass', freq: 1800, Q: 1.6, peak: 0.07 * g, attack: 0.01 });
  partial(ac, out, { t: t + 0.1, type: 'sine', freq: 320, peak: 0.05 * g, decay: 0.07 });
}

/** a species recorded — a small ink stamp and the nib's tick */
function discover(ac, out, p, rng) {
  const t = out.t, g = p.gain ?? 1;
  partial(ac, out, { t, type: 'sine', freq: 240, to: 180, glide: 0.03, peak: 0.10 * g, decay: 0.09 });
  burst(ac, out, { t: t + 0.01, dur: 0.04, type: 'bandpass', freq: 5200, Q: 2, peak: 0.06 * g, attack: 0.001 });
  partial(ac, out, { t: t + 0.02, type: 'sine', freq: 520, peak: 0.04 * g, decay: 0.06 });
}

/** the player's two-note call — "here" — and the breath that carries it */
function whistle(ac, out, p, rng) {
  const t = out.t, g = p.gain ?? 1;
  for (let i = 0; i < 2; i++) {
    const o = t + i * 0.17;
    const f = 1750 + i * 300;
    const src = osc(ac, 'sine', f);
    src.frequency.setValueAtTime(f, o);
    src.frequency.exponentialRampToValueAtTime(f * (1.05 + i * 0.03), o + 0.16);
    const env = perc(ac, o, { peak: g * 0.12, attack: 0.015, decay: 0.16 });
    const pn = panner(ac, p.pan ?? 0);
    src.connect(env);
    if (pn) { env.connect(pn); pn.connect(out.dry); } else env.connect(out.dry);
    const w = gain(ac, 0.5); env.connect(w); w.connect(out.wet);
    burst(ac, out, { t: o, dur: 0.12, type: 'bandpass', freq: f, Q: 6, peak: g * 0.05, attack: 0.015 });
    fire([src], env, o, o + 0.4);
  }
}

function nibble(ac, out, p, rng) {
  const t = out.t, g = p.gain ?? 1;
  // three tiny wet ticks plus a contented hum — a creature eating out of your hand
  for (let i = 0; i < 3; i++) {
    const o = t + i * (0.075 + rng.next() * 0.03);
    burst(ac, out, { t: o, dur: 0.045, type: 'bandpass', freq: 1500 + rng.next() * 900, Q: 3.2, peak: 0.20 * g, pan: (rng.next() - 0.5) * 0.3 });
    partial(ac, out, { t: o, type: 'sine', freq: 240 + rng.next() * 90, to: 180, glide: 0.04, peak: 0.09 * g, decay: 0.05 });
  }
  partial(ac, out, { t: t + 0.22, type: 'triangle', freq: 330, to: 392, glide: 0.14, peak: 0.10 * g, decay: 0.24, wet: 0.35 });
}

/** small confirmation tick for UI focus / prompt appearing — must be nearly subliminal */
function tick(ac, out, p) {
  const t = out.t, g = p.gain ?? 1;
  partial(ac, out, { t, type: 'sine', freq: 1560, peak: 0.055 * g, decay: 0.06, wet: 0.3 });
  partial(ac, out, { t: t + 0.012, type: 'sine', freq: 2340, peak: 0.03 * g, decay: 0.05 });
}

/** trust rose but the creature is not tamed yet — a small hopeful lift */
function trustUp(ac, out, p) {
  const t = out.t, g = p.gain ?? 1;
  const root = mtof(69);   // A4
  const steps = [0, 4, 7];
  for (let i = 0; i < steps.length; i++) {
    fmBell(ac, out, {
      t: t + i * 0.085, freq: root * Math.pow(2, steps[i] / 12),
      peak: 0.10 * g * (1 - i * 0.15), decay: 1.0, index: 3.4, wet: 0.55,
    });
  }
}

/**
 * THE BOND CHORD — the emotional peak of the slice. A creature has decided to trust you.
 *
 * Five layers, ~4.5 s:
 *   1. a low sub swell that arrives *before* the chord, so it feels inevitable
 *   2. a warm Amaj9 pad (A2 E3 A3 C#4 E4 B4) on stacked detuned triangles + saws
 *   3. a rising bell arpeggio over the top, each note softer than the last
 *   4. a shimmer of high sines that fades in late, like light coming up
 *   5. a soft airy swell underneath everything, for lift
 * The director additionally ducks music and ambience under it.
 */
function bond(ac, out, p) {
  const t = out.t, g = p.gain ?? 1;
  const wetBus = gain(ac, 1);
  wetBus.connect(out.wet);

  // 1. sub
  partial(ac, out, { t, type: 'sine', freq: mtof(33), to: mtof(45), glide: 0.5, peak: 0.16 * g, attack: 0.08, decay: 1.3 });

  // 2. pad
  const chord = [45, 52, 57, 61, 64, 71];        // A2 E3 A3 C#4 E4 B4  — Amaj9
  const padBus = gain(ac, 1);
  const padLp = filter(ac, 'lowpass', 700, 0.7);
  padLp.frequency.setValueAtTime(700, t);
  padLp.frequency.linearRampToValueAtTime(2600, t + 1.1);   // the chord "opens"
  padLp.frequency.linearRampToValueAtTime(1300, t + 4.0);
  const padEnv = swell(ac, t, { peak: 0.28 * g, attack: 0.22, hold: 1.5, release: 2.4 });
  padBus.connect(padLp); padLp.connect(padEnv); padEnv.connect(out.dry);
  const pw = gain(ac, 0.5); padEnv.connect(pw); pw.connect(out.wet);
  const padSrc = [];
  for (let i = 0; i < chord.length; i++) {
    const f = mtof(chord[i]);
    const amp = gain(ac, (i === 0 ? 0.5 : 0.34) / chord.length * 2.2);
    for (const [type, cents] of [['triangle', -6], ['triangle', 6], ['sawtooth', 0]]) {
      const o = osc(ac, type, f, cents);
      const og = gain(ac, type === 'sawtooth' ? 0.16 : 0.42);
      o.connect(og); og.connect(amp);
      padSrc.push(o);
    }
    amp.connect(padBus);
  }
  fire(padSrc, padBus, t, t + 5.2);

  // 3. rising bell arpeggio
  const arp = [69, 73, 76, 81, 83, 88];          // A4 C#5 E5 A5 B5 A6
  for (let i = 0; i < arp.length; i++) {
    fmBell(ac, out, {
      t: t + 0.18 + i * 0.115, freq: mtof(arp[i]),
      peak: 0.15 * g * (1 - i * 0.11), decay: 2.2 - i * 0.15,
      index: 4.0, ratio: 3.51, pan: (i % 2 ? 0.22 : -0.22), wet: 0.62,
    });
  }

  // 4. late shimmer
  const shimSrc = [];
  const shimBus = gain(ac, 1);
  const shimEnv = swell(ac, t + 0.9, { peak: 0.05 * g, attack: 1.1, hold: 0.6, release: 1.8 });
  shimBus.connect(shimEnv); shimEnv.connect(out.dry);
  const sw = gain(ac, 0.8); shimEnv.connect(sw); sw.connect(out.wet);
  for (const n of [88, 90, 93, 95]) {
    const o = osc(ac, 'sine', mtof(n), (n % 3) * 5 - 5);
    const og = gain(ac, 0.25);
    o.connect(og); og.connect(shimBus);
    shimSrc.push(o);
  }
  fire(shimSrc, shimBus, t + 0.9, t + 5.0);

  // 5. air
  burst(ac, out, { t, dur: 1.6, type: 'bandpass', freq: 2200, Q: 0.5, peak: 0.06 * g, attack: 0.5, wet: 0.5 });
}

// ---------------------------------------------------------------------------
// BOND SPHERES
//
// The sphere is a hollow shell with something alive inside it, and every cue here is
// built out of that one idea: a metal body with a ring, a soft interior, and — through
// the wobble — a rising argument between the two. The five beats in spheres/index.js get
// five cues and they are deliberately a family: the same 620 Hz shell partial and the
// same 3.9 kHz hinge tick run through all of them, so a player hears one object.
// ---------------------------------------------------------------------------

/** the shell's own voice: a small inharmonic bell, reused by every sphere cue */
const SHELL = 620;

/** wind-up, release, and the whistle of a thrown thing */
function sphereThrow(ac, out, p, rng) {
  const t = out.t, g = p.gain ?? 1;
  // the arm: a short low swish that sweeps up as it accelerates
  burst(ac, out, {
    t, dur: 0.16, type: 'bandpass', freq: 700, Q: 0.8, peak: 0.20 * g,
    sweepTo: 2400, attack: 0.05, pan: (p.pan ?? 0) * 0.6, wet: 0.15,
  });
  // the release: metal leaving the hand
  partial(ac, out, { t: t + 0.02, type: 'triangle', freq: SHELL * 1.6, to: SHELL, glide: 0.05, peak: 0.10 * g, decay: 0.08, pan: p.pan ?? 0 });
  burst(ac, out, { t: t + 0.02, dur: 0.035, type: 'highpass', freq: 3900, peak: 0.09 * g, attack: 0.001 });
  // ...and the doppler of it going away, which is what tells you it is in the air
  const o = osc(ac, 'sine', 1500);
  o.frequency.setValueAtTime(1500, t + 0.04);
  o.frequency.exponentialRampToValueAtTime(760, t + 0.34);
  const env = perc(ac, t + 0.04, { peak: 0.045 * g, attack: 0.03, decay: 0.28 });
  o.connect(env); env.connect(out.dry);
  const w = gain(ac, 0.45); env.connect(w); w.connect(out.wet);
  fire([o], env, t + 0.04, t + 0.7);
}

/** contact: the hinge opens, a beam takes hold, and the shell slams */
function sphereHit(ac, out, p, rng) {
  const t = out.t, g = p.gain ?? 1;
  // 1. hinge — two bright ticks as the halves part
  burst(ac, out, { t, dur: 0.03, type: 'highpass', freq: 3900, peak: 0.16 * g, attack: 0.001, pan: p.pan ?? 0 });
  fmBell(ac, out, { t, freq: SHELL * 2, peak: 0.09 * g, decay: 0.35, index: 6.5, ratio: 4.1, wet: 0.45 });
  // 2. the beam: a rising filtered swell — the only sustained thing in the whole family
  const a = assets(ac);
  const src = loopSource(ac, a.white, 1);
  const bp = filter(ac, 'bandpass', 700, 3.2);
  bp.frequency.setValueAtTime(620, t + 0.04);
  bp.frequency.exponentialRampToValueAtTime(3200, t + 0.44);
  const env = swell(ac, t + 0.04, { peak: 0.10 * g, attack: 0.16, hold: 0.14, release: 0.14 });
  const pn = panner(ac, p.pan ?? 0);
  src.connect(bp); bp.connect(env);
  if (pn) { env.connect(pn); pn.connect(out.dry); } else env.connect(out.dry);
  const w = gain(ac, 0.5); env.connect(w); w.connect(out.wet);
  fire([src], env, t + 0.04, t + 0.9);
  // a tone rising with it, so the pull-in has a pitch and not just a hiss
  partial(ac, out, { t: t + 0.06, type: 'sine', freq: 240, to: 900, glide: 0.36, peak: 0.07 * g, attack: 0.08, decay: 0.32, wet: 0.4 });
  // 3. the slam — the loudest single moment in the sphere family
  partial(ac, out, { t: t + 0.50, type: 'sine', freq: 150, to: 78, glide: 0.05, peak: 0.34 * g, decay: 0.14 });
  burst(ac, out, { t: t + 0.50, dur: 0.05, type: 'bandpass', freq: 2600, Q: 1.6, peak: 0.24 * g, attack: 0.001, pan: p.pan ?? 0 });
  fmBell(ac, out, { t: t + 0.505, freq: SHELL, peak: 0.13 * g, decay: 0.55, index: 5.6, ratio: 3.4, wet: 0.55 });
}

/**
 * One wobble. `p.shake` is 0-based and `p.of` is how many there could be, and the whole
 * point of this cue is that it is NOT the same sound three times: each rock is faster,
 * higher, harder, and carries one more beat of a tension tone that is only resolved by
 * the click or the burst. Three identical ticks would make the wobble a progress bar.
 */
function sphereShake(ac, out, p, rng) {
  const t = out.t, g = p.gain ?? 1;
  const i = Math.min(2, Math.max(0, (p.shake ?? 1) - 1));   // 0,1,2
  const tension = i / 2;                                     // 0 .. 1
  const rate = 1 + tension * 0.45;
  const pitch = 1 + tension * 0.30;

  // the body rocking on the grass: a low scrape that leans one way then knocks back
  burst(ac, out, {
    t, dur: 0.13 / rate, type: 'bandpass', freq: 420 * pitch, Q: 1.1,
    peak: (0.13 + tension * 0.10) * g, attack: 0.02, sweepTo: 900 * pitch, pan: p.pan ?? 0,
  });
  partial(ac, out, { t, type: 'sine', freq: 110 * pitch, to: 78, glide: 0.07, peak: (0.14 + tension * 0.12) * g, decay: 0.10 });
  // the shell answering — brighter and shorter each time
  fmBell(ac, out, {
    t: t + 0.02, freq: SHELL * pitch, peak: (0.07 + tension * 0.07) * g,
    decay: 0.42 - tension * 0.14, index: 4.5 + tension * 2.5, ratio: 3.51,
    pan: (p.pan ?? 0) * 0.7, wet: 0.5,
  });
  // and the thing inside pushing back: a rising held tone that only the resolve releases
  partial(ac, out, {
    t: t + 0.03, type: 'triangle', freq: mtof(64 + i * 3), to: mtof(65 + i * 3),
    glide: 0.3, peak: (0.035 + tension * 0.05) * g, attack: 0.06, decay: 0.34 + tension * 0.2, wet: 0.5,
  });
  // the last wobble gets an extra knock a beat later — the near-miss you can hear
  if (i >= 2) {
    burst(ac, out, { t: t + 0.19, dur: 0.05, type: 'bandpass', freq: 1500, Q: 2.2, peak: 0.11 * g, attack: 0.002 });
  }
}

/**
 * The click. Deliberately SMALL — `creature:tamed` fires immediately behind it and the
 * bond chord is the emotional payload. This is the mechanical fact of the catch: a latch
 * dropping, then a steady glow settling in under it.
 */
function sphereCaught(ac, out, p) {
  const t = out.t, g = p.gain ?? 1;
  burst(ac, out, { t, dur: 0.02, type: 'highpass', freq: 4600, peak: 0.20 * g, attack: 0.0008 });
  partial(ac, out, { t, type: 'sine', freq: 1900, peak: 0.10 * g, decay: 0.035 });
  partial(ac, out, { t: t + 0.05, type: 'sine', freq: 160, to: 120, glide: 0.05, peak: 0.16 * g, decay: 0.12 });
  // the steady glow: a fifth settling in, quiet, under whatever comes next
  fmBell(ac, out, { t: t + 0.07, freq: mtof(69), peak: 0.09 * g, decay: 1.5, index: 3.2, wet: 0.6 });
  fmBell(ac, out, { t: t + 0.16, freq: mtof(76), peak: 0.06 * g, decay: 1.7, index: 3.0, wet: 0.65 });
}

/** it bursts open: the tension tone is released downward, which is the whole point */
function sphereEscaped(ac, out, p, rng) {
  const t = out.t, g = p.gain ?? 1;
  burst(ac, out, { t, dur: 0.045, type: 'highpass', freq: 2600, peak: 0.30 * g, attack: 0.0008, pan: p.pan ?? 0 });
  partial(ac, out, { t, type: 'sine', freq: 220, to: 90, glide: 0.09, peak: 0.24 * g, decay: 0.16 });
  // the halves flying apart, ringing off-key
  fmBell(ac, out, { t: t + 0.01, freq: SHELL * 1.19, peak: 0.12 * g, decay: 0.7, index: 7.5, ratio: 2.72, pan: -0.2, wet: 0.55 });
  fmBell(ac, out, { t: t + 0.04, freq: SHELL * 0.84, peak: 0.09 * g, decay: 0.6, index: 7.0, ratio: 2.72, pan: 0.24, wet: 0.55 });
  // the held tension falling away
  partial(ac, out, { t: t + 0.02, type: 'triangle', freq: mtof(70), to: mtof(58), glide: 0.4, peak: 0.07 * g, attack: 0.01, decay: 0.42, wet: 0.5 });
  burst(ac, out, { t: t + 0.06, dur: 0.3, type: 'bandpass', freq: 3200, Q: 0.5, peak: 0.07 * g, attack: 0.03, wet: 0.3 });
}

// ---------------------------------------------------------------------------
// WEAPONS
//
// A gunshot outdoors is three things and every one of them has to be there or it reads
// as a UI blip: a 4 ms CRACK with no pitch at all, a BODY with a downward pitch glide
// that carries the calibre, and a TAIL that is mostly reverb and tells you how open the
// ground is. Everything below is that shape, scaled by weapon.
// ---------------------------------------------------------------------------

const GUN = {
  pistol: { body: 168, crack: 0.30, bodyG: 0.46, tail: 0.34, tailF: 900, bright: 5200 },
  rifle: { body: 122, crack: 0.38, bodyG: 0.56, tail: 0.52, tailF: 700, bright: 6200 },
};

function weaponFire(ac, out, p, rng) {
  const t = out.t, g = p.gain ?? 1;
  const d = GUN[p.id] ?? GUN.pistol;
  const v = 0.94 + rng.next() * 0.12;

  // 1. crack — no tone, all edge. This is the part the ear locates.
  burst(ac, out, { t, dur: 0.006, type: 'highpass', freq: d.bright, peak: d.crack * g, attack: 0.0004, pan: p.pan ?? 0 });
  burst(ac, out, { t, dur: 0.028, type: 'bandpass', freq: 2400 * v, Q: 0.6, peak: d.crack * 0.75 * g, attack: 0.0006, pan: p.pan ?? 0, wet: 0.28 });
  // 2. body — the pitch glide is the calibre
  partial(ac, out, { t, type: 'sine', freq: d.body * v, to: d.body * 0.42, glide: 0.055, peak: d.bodyG * g, attack: 0.0008, decay: 0.10 });
  burst(ac, out, { t: t + 0.002, dur: 0.085, type: 'bandpass', freq: 620 * v, Q: 0.75, peak: 0.26 * g, attack: 0.001, sweepTo: 230, wet: 0.3 });
  // 3. tail — mostly reverb; this is the meadow answering
  burst(ac, out, { t: t + 0.012, dur: d.tail, type: 'bandpass', freq: d.tailF, Q: 0.45, peak: 0.11 * g, attack: 0.02, wet: 0.85, buffer: 'pink' });
  // the action cycling, a beat behind the shot
  burst(ac, out, { t: t + 0.045, dur: 0.05, type: 'bandpass', freq: 3400, Q: 2.4, peak: 0.055 * g, attack: 0.002, pan: (p.pan ?? 0) * 0.5 });
}

/**
 * Where the round lands. Surface-aware, off the same SURFACE table the footsteps use, so
 * a bullet into grass and a boot into grass are demonstrably the same ground.
 */
function weaponImpact(ac, out, p, rng) {
  const t = out.t, g = (p.gain ?? 1);
  const surf = p.surface ?? 'grass';
  const s = SURFACE[surf] ?? SURFACE.dirt;
  const pan = p.pan ?? 0;

  if (surf === 'rock' || surf === 'stone') {
    // chips: a hard tick, a ricochet whine, and two fragments landing
    burst(ac, out, { t, dur: 0.018, type: 'highpass', freq: 5200, peak: 0.26 * g, attack: 0.0005, pan });
    fmBell(ac, out, { t, freq: 2600 + rng.next() * 900, peak: 0.11 * g, decay: 0.28, index: 8, ratio: 4.7, pan, wet: 0.6 });
    for (let i = 0; i < 2; i++) {
      burst(ac, out, { t: t + 0.06 + i * (0.05 + rng.next() * 0.05), dur: 0.02, type: 'bandpass', freq: 3000 + rng.next() * 1500, Q: 3, peak: 0.05 * g, attack: 0.001, pan: pan + (rng.next() - 0.5) * 0.4 });
    }
    return;
  }
  if (surf === 'water') {
    burst(ac, out, { t, dur: 0.06, type: 'bandpass', freq: 1800, Q: 0.9, peak: 0.22 * g, attack: 0.001, sweepTo: 600, pan });
    burst(ac, out, { t: t + 0.02, dur: 0.34, type: 'highpass', freq: 1400, peak: 0.13 * g, attack: 0.015, wet: 0.4, pan });
    partial(ac, out, { t: t + 0.01, type: 'sine', freq: 380, to: 900, glide: 0.09, peak: 0.08 * g, decay: 0.1 });
    return;
  }
  if (surf === 'wood') {
    partial(ac, out, { t, type: 'sine', freq: 260, to: 170, glide: 0.03, peak: 0.24 * g, decay: 0.09, pan });
    burst(ac, out, { t, dur: 0.035, type: 'bandpass', freq: 2200, Q: 2.2, peak: 0.17 * g, attack: 0.0008, pan });
    partial(ac, out, { t: t + 0.01, type: 'triangle', freq: 420, peak: 0.06 * g, decay: 0.11, wet: 0.3 });
    return;
  }
  // grass / dirt / sand: a dull slap and a spray of loose material
  partial(ac, out, { t, type: 'sine', freq: s.thump * 1.15, to: s.thump * 0.5, glide: 0.035, peak: 0.20 * g, decay: 0.075, pan });
  burst(ac, out, { t, dur: 0.045, type: 'bandpass', freq: s.scuffF * 1.3, Q: 0.7, peak: 0.17 * g, attack: 0.0008, pan, wet: 0.18 });
  burst(ac, out, { t: t + 0.02, dur: 0.17, type: 'bandpass', freq: s.scuffF * 2.2, Q: 0.5, peak: 0.07 * g, attack: 0.02, pan: pan * 0.7 });
}

/**
 * A round into something alive. Soft, low and short — no crunch, no wet gore. It has to
 * read as "that hurt and it is winded", never as damage, because nothing in this game
 * dies and the sound is half of what tells the player so. The creature's own yelp is
 * fired separately by the director, in its own species timbre.
 */
function weaponFlesh(ac, out, p, rng) {
  const t = out.t, g = p.gain ?? 1;
  const pan = p.pan ?? 0;
  partial(ac, out, { t, type: 'sine', freq: 96, to: 62, glide: 0.06, peak: 0.26 * g, decay: 0.13, pan });
  burst(ac, out, { t, dur: 0.05, type: 'lowpass', freq: 900, Q: 0.6, peak: 0.20 * g, attack: 0.001, buffer: 'brown', pan });
  // the breath knocked out of it
  burst(ac, out, { t: t + 0.03, dur: 0.16, type: 'bandpass', freq: 700 + rng.next() * 200, Q: 1.5, peak: 0.09 * g, attack: 0.02, pan, wet: 0.2 });
}

/** the trigger on an empty magazine: one dry mechanical click and nothing else */
function weaponDry(ac, out, p) {
  const t = out.t, g = p.gain ?? 1;
  burst(ac, out, { t, dur: 0.014, type: 'highpass', freq: 3600, peak: 0.14 * g, attack: 0.0006 });
  partial(ac, out, { t, type: 'sine', freq: 1250, peak: 0.05 * g, decay: 0.02 });
  burst(ac, out, { t: t + 0.03, dur: 0.02, type: 'bandpass', freq: 1800, Q: 3.4, peak: 0.06 * g, attack: 0.001 });
}

/**
 * The reload, one cue per phase, because the phases are the point: a player who can hear
 * "magazine out / fresh magazine / charging" can learn where the cancel window is.
 */
function weaponReload(ac, out, p, rng) {
  const t = out.t, g = p.gain ?? 1;
  const pan = (p.pan ?? 0) * 0.4;
  switch (p.phase) {
    case 'magout':
      // catch released, then the magazine sliding free
      burst(ac, out, { t, dur: 0.016, type: 'highpass', freq: 3200, peak: 0.13 * g, attack: 0.0006, pan });
      burst(ac, out, { t: t + 0.05, dur: 0.14, type: 'bandpass', freq: 1500, Q: 1.2, peak: 0.09 * g, attack: 0.02, sweepTo: 800, pan });
      partial(ac, out, { t: t + 0.20, type: 'sine', freq: 190, to: 140, glide: 0.03, peak: 0.08 * g, decay: 0.07, pan });
      break;
    case 'magin':
      // a fresh magazine seated: one firm thunk with a spring ring on top
      partial(ac, out, { t: t + 0.20, type: 'sine', freq: 150, to: 105, glide: 0.04, peak: 0.20 * g, decay: 0.10, pan });
      burst(ac, out, { t: t + 0.20, dur: 0.03, type: 'bandpass', freq: 2400, Q: 2.0, peak: 0.14 * g, attack: 0.0008, pan });
      fmBell(ac, out, { t: t + 0.21, freq: 1750, peak: 0.045 * g, decay: 0.22, index: 6, ratio: 4.3, pan, wet: 0.35 });
      break;
    case 'charge':
      // the slide/bolt: pulled back, then let go
      burst(ac, out, { t, dur: 0.07, type: 'bandpass', freq: 2000, Q: 1.4, peak: 0.11 * g, attack: 0.006, sweepTo: 3200, pan });
      burst(ac, out, { t: t + 0.12, dur: 0.028, type: 'bandpass', freq: 3000, Q: 1.8, peak: 0.18 * g, attack: 0.0006, pan });
      partial(ac, out, { t: t + 0.12, type: 'sine', freq: 210, to: 150, glide: 0.03, peak: 0.11 * g, decay: 0.06, pan });
      break;
    default:
      // 'done' — a single settle tick, so the player knows without looking
      partial(ac, out, { t, type: 'sine', freq: 900, peak: 0.045 * g, decay: 0.05 });
      break;
  }
}

/** raising or lowering the weapon: cloth, leather, and a breath */
function weaponAim(ac, out, p, rng) {
  const t = out.t, g = p.gain ?? 1;
  const up = !!p.aiming;
  burst(ac, out, {
    t, dur: 0.13, type: 'bandpass', freq: up ? 1800 : 1300, Q: 0.7, peak: 0.055 * g,
    attack: 0.03, sweepTo: up ? 2600 : 900, pan: (p.pan ?? 0) * 0.3,
  });
  partial(ac, out, { t: t + 0.02, type: 'sine', freq: up ? 640 : 480, peak: 0.022 * g, decay: 0.05 });
}

// ---------------------------------------------------------------------------
// AMBIENT ONE-SHOTS
// ---------------------------------------------------------------------------

/** a 2–5 note bird phrase, high and far, drenched in the valley tail */
function bird(ac, out, p, rng) {
  const g = (p.gain ?? 1) * 0.16;
  const pan = p.pan ?? 0;
  const notes = 2 + Math.floor(rng.next() * 3.4);
  const base = 2100 + rng.next() * 1900;
  const warble = rng.next() < 0.3;
  let t = out.t;
  for (let i = 0; i < notes; i++) {
    const up = rng.next() < 0.6;
    const f0 = base * (0.85 + rng.next() * 0.4);
    const f1 = f0 * (up ? 1.35 + rng.next() * 0.5 : 0.66 + rng.next() * 0.2);
    const dur = 0.035 + rng.next() * 0.06;
    const o = osc(ac, rng.next() < 0.35 ? 'triangle' : 'sine', f0);
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur * 0.9);
    const env = perc(ac, t, { peak: g * (0.7 + rng.next() * 0.5), attack: 0.006, decay: dur });
    const hp = filter(ac, 'highpass', 900, 0.7);
    const pn = panner(ac, pan);
    o.connect(hp); hp.connect(env);
    if (pn) { env.connect(pn); pn.connect(out.dry); } else env.connect(out.dry);
    const w = gain(ac, 0.75); env.connect(w); w.connect(out.wet);   // birds are mostly reverb
    const srcs = [o];
    if (warble) {
      const lfo = osc(ac, 'sine', 26 + rng.next() * 18);
      const la = gain(ac, f0 * 0.05);
      lfo.connect(la); la.connect(o.frequency);
      srcs.push(lfo);
    }
    fire(srcs, env, t, t + dur + 0.15);
    t += dur + 0.03 + rng.next() * 0.07;
  }
}

/** a cricket "train": 3–5 resonant pulses, the sound of a summer night */
function cricket(ac, out, p, rng) {
  const g = (p.gain ?? 1) * 0.055;
  const pan = p.pan ?? 0;
  const f = 4200 + rng.next() * 1300;
  const n = 3 + Math.floor(rng.next() * 3);
  const spacing = 0.028 + rng.next() * 0.016;
  for (let i = 0; i < n; i++) {
    burst(ac, out, {
      t: out.t + i * spacing, dur: 0.018, type: 'bandpass', freq: f, Q: 22,
      peak: g, attack: 0.001, pan, wet: 0.25,
    });
  }
}

/** a midday insect "chirr" — sharper than a cricket, thinner, and only out at noon */
function insect(ac, out, p, rng) {
  const g = (p.gain ?? 1) * 0.05;
  const pan = p.pan ?? 0;
  const f = 3300 + rng.next() * 1400;
  const n = 2 + Math.floor(rng.next() * 2);
  for (let i = 0; i < n; i++) {
    burst(ac, out, {
      t: out.t + i * (0.045 + rng.next() * 0.03), dur: 0.02, type: 'bandpass',
      freq: f * (1 + i * 0.02), Q: 10, peak: g * (1 - i * 0.25), attack: 0.001, pan, wet: 0.15,
    });
  }
}

/** distant night bird — two soft hoots, very wet, very rare */
function owl(ac, out, p, rng) {
  const g = (p.gain ?? 1) * 0.13;
  const f = 360 + rng.next() * 70;
  for (let i = 0; i < 2; i++) {
    const t = out.t + i * 0.42;
    partial(ac, out, { t, type: 'sine', freq: f * (i ? 0.94 : 1), to: f * 0.86, glide: 0.28, peak: g, attack: 0.06, decay: 0.3, wet: 0.9, pan: p.pan ?? 0 });
    partial(ac, out, { t, type: 'sine', freq: f * 2, peak: g * 0.16, attack: 0.06, decay: 0.22, wet: 0.9 });
  }
}

/** a single gust arriving — noise swelling through a moving band, no tonal content */
function gust(ac, out, p, rng) {
  const a = assets(ac);
  const t = out.t;
  const g = (p.gain ?? 1) * 0.3;
  const dur = 1.6 + rng.next() * 2.2;
  const src = loopSource(ac, a.brown, 0.8 + rng.next() * 0.5);
  const bp = filter(ac, 'bandpass', 420, 0.55);
  bp.frequency.setValueAtTime(280, t);
  bp.frequency.linearRampToValueAtTime(760 + rng.next() * 500, t + dur * 0.45);
  bp.frequency.linearRampToValueAtTime(240, t + dur);
  const env = swell(ac, t, { peak: g, attack: dur * 0.4, hold: dur * 0.12, release: dur * 0.6 });
  const pn = panner(ac, (rng.next() - 0.5) * 1.2);
  src.connect(bp); bp.connect(env);
  if (pn) { env.connect(pn); pn.connect(out.dry); } else env.connect(out.dry);
  fire([src], src, t, t + dur * 1.6);

  // leaves lifting with it
  burst(ac, out, {
    t: t + dur * 0.18, dur: dur * 0.7, type: 'bandpass', freq: 3400, Q: 0.45,
    peak: g * 0.5 * (p.rustle ?? 1), attack: dur * 0.3,
  });
}

/** water lapping — used as a positional one-shot near a shoreline */
function lap(ac, out, p, rng) {
  const g = (p.gain ?? 1) * 0.16;
  burst(ac, out, {
    t: out.t, dur: 0.5 + rng.next() * 0.4, type: 'bandpass', freq: 700 + rng.next() * 600,
    Q: 0.55, peak: g, attack: 0.12, buffer: 'pink', pan: p.pan ?? 0, wet: 0.3,
  });
}

// ---------------------------------------------------------------------------
// MUSIC VOICES (driven by Music.js)
// ---------------------------------------------------------------------------

function padNote(ac, out, p) {
  const t = out.t;
  const g = p.gain ?? 0.1;
  const bus = gain(ac, 1);
  const lp = filter(ac, 'lowpass', p.cutoff ?? 900, 0.6);
  const env = swell(ac, t, { peak: g, attack: p.attack ?? 5, hold: p.hold ?? 8, release: p.release ?? 7 });
  const pn = panner(ac, p.pan ?? 0);
  bus.connect(lp); lp.connect(env);
  if (pn) { env.connect(pn); pn.connect(out.dry); } else env.connect(out.dry);
  const w = gain(ac, 0.45); env.connect(w); w.connect(out.wet);

  const srcs = [];
  const f = p.freq;
  for (const [type, cents, amp] of [['triangle', -7, 0.5], ['triangle', 7, 0.5], ['sine', 0, 0.6], ['sawtooth', 3, 0.09]]) {
    const o = osc(ac, type, f, cents);
    const og = gain(ac, amp);
    o.connect(og); og.connect(bus);
    srcs.push(o);
  }
  // slow chorus so the pad breathes instead of sitting still
  const lfo = osc(ac, 'sine', 0.11 + (p.lfo ?? 0) * 0.05);
  const la = gain(ac, f * 0.0035);
  lfo.connect(la);
  for (const o of srcs) la.connect(o.frequency);
  srcs.push(lfo);

  const total = (p.attack ?? 5) + (p.hold ?? 8) + (p.release ?? 7) * 2.2;
  fire(srcs, bus, t, t + total);
}

function musicBell(ac, out, p) {
  fmBell(ac, out, {
    t: out.t, freq: p.freq, peak: p.gain ?? 0.09, decay: p.decay ?? 2.4,
    index: p.index ?? 4.2, ratio: p.ratio ?? 3.51, pan: p.pan ?? 0, wet: 0.65,
  });
}

function musicPluck(ac, out, p) {
  pluck(ac, out, { t: out.t, freq: p.freq, peak: p.gain ?? 0.1, decay: p.decay ?? 1.4, bright: 0.8, pan: p.pan ?? 0, wet: 0.55 });
}

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

/** name -> { bus, fn }. `bus` picks which mixer group and therefore which duck. */
export const CUES = {
  step: { bus: 'foley', fn: step },
  land: { bus: 'foley', fn: land },
  jump: { bus: 'foley', fn: jump },
  creature_step: { bus: 'foley', fn: step },

  call: { bus: 'voice', fn: creatureCall },

  gather: { bus: 'sfx', fn: gather },
  gather_start: { bus: 'sfx', fn: gatherStart },
  offer: { bus: 'sfx', fn: offer },
  spook: { bus: 'sfx', fn: spook },
  pet: { bus: 'sfx', fn: pet },
  playful: { bus: 'sfx', fn: playful },
  nibble: { bus: 'sfx', fn: nibble },
  bond: { bus: 'sfx', fn: bond },
  trust: { bus: 'sfx', fn: trustUp },
  focus: { bus: 'sfx', fn: tick },
  tick: { bus: 'sfx', fn: tick },
  journal: { bus: 'sfx', fn: journal },
  discover: { bus: 'sfx', fn: discover },
  whistle: { bus: 'sfx', fn: whistle },

  // ---- bond spheres ----
  sphere_throw: { bus: 'sfx', fn: sphereThrow },
  sphere_hit: { bus: 'sfx', fn: sphereHit },
  sphere_shake: { bus: 'sfx', fn: sphereShake },
  sphere_caught: { bus: 'sfx', fn: sphereCaught },
  sphere_escaped: { bus: 'sfx', fn: sphereEscaped },

  // ---- weapons. Foley bus for the mechanical verbs (they are hands on metal),
  // sfx for the report itself so it is not ducked with the footsteps.
  weapon_fire: { bus: 'sfx', fn: weaponFire },
  weapon_impact: { bus: 'foley', fn: weaponImpact },
  weapon_flesh: { bus: 'foley', fn: weaponFlesh },
  weapon_dry: { bus: 'foley', fn: weaponDry },
  weapon_reload: { bus: 'foley', fn: weaponReload },
  weapon_aim: { bus: 'foley', fn: weaponAim },

  bird: { bus: 'ambience', fn: bird },
  cricket: { bus: 'ambience', fn: cricket },
  insect: { bus: 'ambience', fn: insect },
  owl: { bus: 'ambience', fn: owl },
  gust: { bus: 'ambience', fn: gust },
  lap: { bus: 'ambience', fn: lap },

  pad: { bus: 'music', fn: padNote },
  bell: { bus: 'music', fn: musicBell },
  mpluck: { bus: 'music', fn: musicPluck },
};

/** cues that are texture rather than events — excluded from the "notable" log */
export const AMBIENT_CUES = new Set(['step', 'creature_step', 'bird', 'cricket', 'insect', 'gust', 'lap', 'pad', 'bell', 'mpluck', 'tick',
  // A held trigger fires ten of these a second. The SHOT is the event and stays in the
  // notable log; where it landed is texture hung off it, and letting it in would push
  // every other cue out of the six-entry window a critic actually reads.
  'weapon_impact', 'weapon_aim']);
