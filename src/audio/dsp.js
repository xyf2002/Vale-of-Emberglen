/**
 * DSP PRIMITIVES — the bottom layer of the audio system.
 *
 * Nothing here touches the game. It is pure WebAudio node plumbing plus deterministic
 * buffer generation (noise, reverb impulse responses). Every buffer is synthesised from
 * a seeded Rng so two runs of the same build produce byte-identical convolution tails.
 *
 * All functions take an AudioContext (real or Offline) as their first argument, which is
 * what lets tools render the synthesis offline and measure it without a speaker.
 */
import { Rng } from '../engine/Rng.js';

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
/** hermite smoothstep between two edges */
export const smooth = (e0, e1, x) => {
  const t = clamp((x - e0) / ((e1 - e0) || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
};
/** MIDI note -> Hz */
export const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
/** decibels -> linear gain */
export const db = (d) => Math.pow(10, d / 20);
/** wrap a 0..1 time-of-day distance, so 0.98 and 0.02 are close */
export const todDist = (a, b) => { const d = Math.abs(a - b) % 1; return d > 0.5 ? 1 - d : d; };

const CACHE = new WeakMap();

/**
 * Noise buffers and reverb impulse responses, generated once per AudioContext.
 * Generating a 3 s stereo IR costs a few ms; we only ever do it after a user gesture.
 */
export function assets(ac) {
  let a = CACHE.get(ac);
  if (a) return a;
  const sr = ac.sampleRate;
  const rng = new Rng(0x9e3711);

  const white = ac.createBuffer(1, Math.floor(sr * 2), sr);
  const wd = white.getChannelData(0);
  for (let i = 0; i < wd.length; i++) wd[i] = rng.next() * 2 - 1;

  // Paul Kellett pink filter — the spectral shape most natural ambience sits on.
  const pink = ac.createBuffer(1, Math.floor(sr * 3), sr);
  const pd = pink.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < pd.length; i++) {
    const w = rng.next() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.96900 * b2 + w * 0.1538520;
    b3 = 0.86650 * b3 + w * 0.3104856;
    b4 = 0.55000 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.0168980;
    pd[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.16;
    b6 = w * 0.115926;
  }

  // brown/red noise — the body of wind, all energy below ~300 Hz
  const brown = ac.createBuffer(1, Math.floor(sr * 3), sr);
  const bd = brown.getChannelData(0);
  let last = 0;
  for (let i = 0; i < bd.length; i++) {
    const w = rng.next() * 2 - 1;
    last = (last + 0.028 * w) / 1.028;
    bd[i] = clamp(last * 3.6, -1, 1);
  }

  a = {
    white, pink, brown,
    hall: impulse(ac, rng, 2.9, 2.1, 0.30),   // outdoor valley tail for bells / calls
    room: impulse(ac, rng, 0.75, 3.6, 0.55),  // tight air around footsteps
  };
  CACHE.set(ac, a);
  return a;
}

function impulse(ac, rng, seconds, decay, bright) {
  const sr = ac.sampleRate;
  const n = Math.max(1, Math.floor(sr * seconds));
  const buf = ac.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const w = (rng.next() * 2 - 1) * Math.pow(1 - t, decay);
      lp += (w - lp) * bright;                 // one-pole LP: a warm tail, not a hiss
      d[i] = lp * (i < 96 ? i / 96 : 1);       // no click on sample 0
    }
  }
  return buf;
}

// ---------------------------------------------------------------------------
// node builders
// ---------------------------------------------------------------------------

export function gain(ac, v = 1) { const g = ac.createGain(); g.gain.value = v; return g; }

export function filter(ac, type, freq, Q = 1) {
  const f = ac.createBiquadFilter();
  f.type = type; f.frequency.value = freq; f.Q.value = Q;
  return f;
}

/** StereoPanner if the platform has one; null when pan is irrelevant or unsupported. */
export function panner(ac, pan) {
  if (!pan || !ac.createStereoPanner) return null;
  const p = ac.createStereoPanner();
  p.pan.value = clamp(pan, -1, 1);
  return p;
}

/** connect a to b to c … and return the last node */
export function chain(...nodes) {
  const list = nodes.filter(Boolean);
  for (let i = 0; i < list.length - 1; i++) list[i].connect(list[i + 1]);
  return list[list.length - 1];
}

/** looping buffer source, already started */
export function loopSource(ac, buffer, rate = 1) {
  const s = ac.createBufferSource();
  s.buffer = buffer;
  s.loop = true;
  s.playbackRate.value = rate;
  return s;
}

/**
 * Percussive gain envelope. Uses setTargetAtTime for the tail so decays sound
 * exponential rather than the plasticky linear ramp that gives synth foley away.
 */
export function perc(ac, t0, { peak = 1, attack = 0.004, decay = 0.12, hold = 0 } = {}) {
  const g = ac.createGain();
  const p = g.gain;
  p.setValueAtTime(0.0001, t0);
  p.linearRampToValueAtTime(peak, t0 + attack);
  if (hold > 0) p.setValueAtTime(peak, t0 + attack + hold);
  p.setTargetAtTime(0.0001, t0 + attack + hold, Math.max(0.005, decay * 0.35));
  return g;
}

/** Sustained ADSR-ish envelope for pads and long calls. */
export function swell(ac, t0, { peak = 1, attack = 0.6, hold = 1.0, release = 1.2 } = {}) {
  const g = ac.createGain();
  const p = g.gain;
  p.setValueAtTime(0.0001, t0);
  p.linearRampToValueAtTime(peak, t0 + attack);
  p.setValueAtTime(peak, t0 + attack + hold);
  p.setTargetAtTime(0.0001, t0 + attack + hold, Math.max(0.02, release * 0.32));
  return g;
}

export function osc(ac, type, freq, detuneCents = 0) {
  const o = ac.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  if (detuneCents) o.detune.value = detuneCents;
  return o;
}

/**
 * One-shot voice bookkeeping: start every source, stop it at `end`, and disconnect the
 * head node when the last source finishes so long sessions do not leak graph nodes.
 */
export function fire(sources, head, t0, end) {
  let alive = sources.length;
  for (const s of sources) {
    try {
      if (s._offset) s.start(t0, s._offset); else s.start(t0);
      s.stop(end);
      s.onended = () => {
        if (--alive <= 0) { try { head.disconnect(); } catch { /* already gone */ } }
      };
    } catch { /* a source that refuses to start must never break the frame */ }
  }
}
