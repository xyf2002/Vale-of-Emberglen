/**
 * AMBIENCE BED — the continuous layers. Everything here runs for the whole session and
 * is only ever *mixed*, never restarted, so there is no seam and no CPU spike.
 *
 * Six layers, each a filtered noise source or drone:
 *   windLow    body of the wind, all sub-300 Hz — rises with elevation and exposure
 *   windMid    the audible "rush", band swept by the gust envelope
 *   whistle    a thin resonant tone that only appears on exposed high ground
 *   rustle     grass and leaves, tracks gust × how much vegetation is around you
 *   water      two bands of pink noise, faded in by proximity to water
 *   night      a low drone + air that replaces the daytime brightness after dusk
 *   room       a floor of very quiet pink air so the world is never digitally silent
 *
 * The director hands this a level object every frame; all changes are smoothed with
 * setTargetAtTime so nothing ever steps.
 */
import { assets, gain, filter, panner, loopSource, osc, clamp } from './dsp.js';

const SMOOTH = 0.55;   // seconds — how fast a layer chases its target level

export function createAmbience(ac, dest, wet) {
  const a = assets(ac);
  const nodes = [];
  const layers = {};

  function layer(name, build, initial = 0) {
    const g = gain(ac, 0.0001);
    build(g);
    g.connect(dest);
    layers[name] = { gain: g, level: 0, target: initial };
    return g;
  }

  function noiseLeg(into, buf, type, freq, Q, amp, pan, rate = 1) {
    const src = loopSource(ac, buf, rate);
    const f = filter(ac, type, freq, Q);
    const g = gain(ac, amp);
    const p = panner(ac, pan);
    src.connect(f); f.connect(g);
    if (p) { g.connect(p); p.connect(into); } else g.connect(into);
    try { src.start(0); } catch { /* ignore */ }
    nodes.push(src);
    return { src, filter: f, gain: g };
  }

  // --- wind ---------------------------------------------------------------
  // Leg amplitudes below were set by rendering the bed offline and measuring it: a calm
  // meadow lands near -37 dBFS RMS and an exposed ridge mid-gust near -23, which is the
  // 14 dB of headroom the one-shots need to stay audible in both.
  let windMidL, windMidR;
  layer('windLow', (g) => {
    noiseLeg(g, a.brown, 'lowpass', 190, 0.5, 0.33, -0.35, 0.85);
    noiseLeg(g, a.brown, 'lowpass', 240, 0.5, 0.33, 0.35, 1.07);
  });
  layer('windMid', (g) => {
    windMidL = noiseLeg(g, a.white, 'bandpass', 520, 0.55, 0.30, -0.75, 0.93);
    windMidR = noiseLeg(g, a.white, 'bandpass', 640, 0.55, 0.30, 0.75, 1.11);
  });
  let whistleF;
  layer('whistle', (g) => {
    const l = noiseLeg(g, a.white, 'bandpass', 1750, 7.5, 0.54, -0.5, 1.0);
    noiseLeg(g, a.white, 'bandpass', 2380, 9.0, 0.36, 0.6, 1.03);
    whistleF = l.filter;
  });
  layer('rustle', (g) => {
    noiseLeg(g, a.white, 'bandpass', 3200, 0.75, 0.30, -0.6, 0.97);
    noiseLeg(g, a.white, 'bandpass', 4300, 0.8, 0.23, 0.65, 1.13);
  });

  // --- water --------------------------------------------------------------
  layer('water', (g) => {
    noiseLeg(g, a.pink, 'bandpass', 780, 0.7, 0.22, -0.45, 0.9);
    noiseLeg(g, a.pink, 'bandpass', 2300, 1.3, 0.10, 0.5, 1.05);
    noiseLeg(g, a.pink, 'lowpass', 300, 0.6, 0.11, -0.15, 1.0);
  });

  // --- night --------------------------------------------------------------
  // A very quiet drone, spread across the stereo field. Loud enough to feel the air
  // change after dusk, quiet enough that you would not name it if asked.
  layer('night', (g) => {
    for (const [f, amp, pan] of [[55, 0.085, -0.3], [82.5, 0.045, 0.35], [110, 0.028, 0.1]]) {
      const o = osc(ac, 'sine', f, (f % 7) - 3);
      const og = gain(ac, amp);
      const pn = panner(ac, pan);
      o.connect(og);
      if (pn) { og.connect(pn); pn.connect(g); } else og.connect(g);
      try { o.start(0); } catch { /* ignore */ }
      nodes.push(o);
    }
    noiseLeg(g, a.pink, 'bandpass', 1400, 0.6, 0.07, 0.45, 0.95);
    noiseLeg(g, a.pink, 'bandpass', 1900, 0.6, 0.05, -0.5, 1.09);
  });

  // --- always-on air floor -------------------------------------------------
  layer('room', (g) => {
    noiseLeg(g, a.pink, 'lowpass', 420, 0.5, 0.5, -0.2, 0.88);
    noiseLeg(g, a.pink, 'lowpass', 560, 0.5, 0.4, 0.25, 1.04);
  }, 0.05);

  // a small permanent send so the bed sits in the same space as everything else
  const bedWet = gain(ac, 0.10);
  bedWet.connect(wet);
  for (const k of ['windMid', 'rustle', 'water', 'whistle']) layers[k].gain.connect(bedWet);

  return {
    layers,

    /** levels: { windLow, windMid, whistle, rustle, water, night, room } in 0..1 */
    set(levels, gustBand = 520) {
      const t = ac.currentTime;
      for (const [k, L] of Object.entries(layers)) {
        const want = clamp(levels[k] ?? 0, 0, 1.4);
        if (Math.abs(want - L.target) < 0.002) continue;
        L.target = want;
        L.gain.gain.setTargetAtTime(Math.max(0.0001, want), t, SMOOTH);
      }
      // the wind band opens up as gusts build — this is what makes wind feel like weather
      if (windMidL) {
        windMidL.filter.frequency.setTargetAtTime(gustBand, t, 0.8);
        windMidR.filter.frequency.setTargetAtTime(gustBand * 1.24, t, 0.8);
      }
      if (whistleF) whistleF.frequency.setTargetAtTime(1500 + gustBand * 0.7, t, 1.2);
    },

    dispose() {
      for (const n of nodes) { try { n.stop(); } catch { /* ignore */ } try { n.disconnect(); } catch { /* ignore */ } }
      nodes.length = 0;
    },
  };
}
