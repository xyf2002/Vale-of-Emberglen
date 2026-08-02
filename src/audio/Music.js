/**
 * GENERATIVE MUSIC — a slow pad-and-bell bed that follows the sun.
 *
 * The brief that matters most here is "it must never become annoying on a 5-minute loop",
 * so the structure is built around silence rather than around material:
 *
 *   - music runs in PHRASES (40–90 s) separated by RESTS (20–80 s). During a rest there
 *     is no music at all — just wind and birds. Over a five minute session you hear
 *     roughly three phrases, never the same one twice.
 *   - inside a phrase a chord changes every ~16–26 s and is voiced as a slow roll, not a
 *     block. Attacks are 4–7 s, so no note ever "starts".
 *   - the melody is a constrained random walk over a pentatonic scale with a high chance
 *     of resting. It cannot produce a hook, which means it cannot produce an earworm.
 *   - palettes shift with time of day: bright D major at dawn/day, warmer and lower at
 *     golden hour, B minor and very sparse at night.
 *
 * This module is PURE LOGIC. It returns cue descriptors; it never touches WebAudio, so it
 * runs identically (and truthfully reports itself) when the audio context does not exist.
 */
import { mtof, clamp } from './dsp.js';

const PALETTES = {
  dawn: {
    key: 'D major',
    chords: [
      { name: 'Dmaj9', notes: [50, 57, 62, 66, 69, 76] },
      { name: 'A6/9', notes: [45, 52, 61, 64, 71, 76] },
      { name: 'Bm9', notes: [47, 54, 59, 66, 69, 73] },
      { name: 'Gmaj9', notes: [43, 50, 59, 62, 66, 74] },
    ],
    scale: [62, 66, 69, 71, 74, 78, 81, 83, 86],
    chordEvery: [16, 21], bellEvery: [2.8, 6.5], restProb: 0.30,
    phrase: [55, 85], rest: [22, 38],
    padGain: 0.085, padCutoff: 1500, bellGain: 0.085, bellDecay: 2.8,
  },
  day: {
    key: 'D major',
    chords: [
      { name: 'Dmaj9', notes: [50, 57, 62, 66, 69, 76] },
      { name: 'Bm9', notes: [47, 54, 59, 66, 69, 73] },
      { name: 'Gmaj9', notes: [43, 50, 59, 62, 66, 74] },
      { name: 'A6/9', notes: [45, 52, 61, 64, 69, 76] },
    ],
    scale: [62, 64, 66, 69, 71, 74, 76, 78, 81, 83],
    chordEvery: [18, 25], bellEvery: [3.5, 8], restProb: 0.38,
    phrase: [50, 80], rest: [30, 52],
    padGain: 0.075, padCutoff: 1200, bellGain: 0.075, bellDecay: 2.6,
  },
  golden: {
    key: 'D major (warm)',
    chords: [
      { name: 'Gmaj9', notes: [43, 50, 59, 62, 66, 74] },
      { name: 'F#m11', notes: [42, 49, 54, 61, 64, 71] },
      { name: 'Dmaj9', notes: [50, 57, 62, 66, 69, 76] },
      { name: 'Asus2', notes: [45, 52, 57, 64, 69, 71] },
    ],
    scale: [57, 62, 64, 66, 69, 71, 74, 76, 81],
    chordEvery: [21, 28], bellEvery: [4, 9.5], restProb: 0.36,
    phrase: [55, 90], rest: [26, 46],
    padGain: 0.090, padCutoff: 950, bellGain: 0.070, bellDecay: 3.4,
  },
  dusk: {
    key: 'B dorian',
    chords: [
      { name: 'Bm9', notes: [47, 54, 59, 66, 69, 73] },
      { name: 'Gmaj7', notes: [43, 50, 59, 62, 66, 71] },
      { name: 'Em9', notes: [40, 47, 54, 59, 66, 69] },
      { name: 'F#m7', notes: [42, 49, 54, 61, 64, 68] },
    ],
    scale: [59, 62, 64, 66, 69, 71, 74, 78, 81],
    chordEvery: [20, 27], bellEvery: [4.5, 11], restProb: 0.46,
    phrase: [45, 75], rest: [34, 62],
    padGain: 0.085, padCutoff: 820, bellGain: 0.062, bellDecay: 3.8,
  },
  night: {
    key: 'B minor (low)',
    chords: [
      { name: 'Bm(add9)', notes: [35, 47, 54, 59, 61, 66] },
      { name: 'Gmaj7', notes: [31, 43, 50, 59, 62, 66] },
      { name: 'Em9', notes: [28, 40, 47, 54, 59, 66] },
    ],
    scale: [59, 62, 66, 69, 71, 74, 81],
    chordEvery: [24, 32], bellEvery: [6, 15], restProb: 0.56,
    phrase: [40, 70], rest: [45, 85],
    padGain: 0.080, padCutoff: 620, bellGain: 0.055, bellDecay: 4.6,
  },
};

/** map 0..1 time of day onto a palette name */
export function modeForTimeOfDay(t) {
  const x = ((t % 1) + 1) % 1;
  if (x < 0.18) return 'night';
  if (x < 0.30) return 'dawn';
  if (x < 0.66) return 'day';
  if (x < 0.79) return 'golden';
  if (x < 0.88) return 'dusk';
  return 'night';
}

export function createMusic(rng) {
  let mode = 'day';
  let pal = PALETTES.day;
  let phase = 'rest';
  let phaseLeft = rng.range(4, 12);      // a short beat of quiet before the first phrase
  let chordLeft = 0;
  let chordIdx = 0;
  let bellLeft = rng.range(2, 5);
  let walk = 4;                          // current index into the scale
  let bells = 0, phrases = 0, chords = 0;
  let pendingMode = null;
  let lift = 0;                          // set by celebrate(): brighten for a while

  function pick(range) { return rng.range(range[0], range[1]); }

  function startChord(out) {
    const c = pal.chords[chordIdx % pal.chords.length];
    chordIdx++;
    chords++;
    chordLeft = pick(pal.chordEvery);
    const hold = chordLeft * 0.72;
    // roll the voices in from the bottom so the chord arrives rather than switches on
    for (let i = 0; i < c.notes.length; i++) {
      const top = i / (c.notes.length - 1);
      out.push({
        name: 'pad',
        params: {
          freq: mtof(c.notes[i]),
          gain: pal.padGain * (1 + lift * 0.25) * (i === 0 ? 1.15 : 1 - top * 0.4),
          attack: 4.2 + top * 2.6 + rng.next() * 1.2,
          hold,
          release: 6 + top * 3,
          cutoff: pal.padCutoff * (1 + lift * 0.4) * (0.8 + rng.next() * 0.4),
          pan: (top - 0.5) * 0.7 * (i % 2 ? 1 : -1),
          lfo: i,
          delay: i * (0.25 + rng.next() * 0.35),
        },
      });
    }
    return c;
  }

  let currentChord = null;

  return {
    get mode() { return mode; },
    get phase() { return phase; },

    /** the sky moved; adopt the new palette at the next chord boundary, never mid-chord */
    setMode(m) {
      if (!PALETTES[m] || m === mode) return;
      pendingMode = m;
    },

    /** a creature just bonded — bring the music back in behind the moment */
    celebrate() {
      lift = 1;
      if (phase === 'rest') { phaseLeft = Math.min(phaseLeft, 3.2); }
    },

    /**
     * Advance the generator. Returns an array of cue descriptors to play.
     * Called every fixed step whether or not there is an audio context.
     */
    update(dt) {
      const out = [];
      lift = Math.max(0, lift - dt * 0.045);
      phaseLeft -= dt;

      if (phase === 'rest') {
        if (phaseLeft <= 0) {
          if (pendingMode) { mode = pendingMode; pal = PALETTES[mode]; pendingMode = null; }
          phase = 'play';
          phrases++;
          phaseLeft = pick(pal.phrase);
          chordLeft = 0;
          bellLeft = rng.range(1.5, 5);
          walk = 3 + Math.floor(rng.next() * 3);
        }
        return out;
      }

      // --- playing ---
      chordLeft -= dt;
      if (chordLeft <= 0) {
        if (pendingMode) { mode = pendingMode; pal = PALETTES[mode]; pendingMode = null; chordIdx = 0; }
        currentChord = startChord(out);
      }

      bellLeft -= dt;
      if (bellLeft <= 0) {
        bellLeft = pick(pal.bellEvery);
        if (rng.next() < pal.restProb) {
          // a rest is a musical event too — this is most of why it never nags
          bellLeft += pick(pal.bellEvery) * 0.6;
        } else {
          const count = rng.next() < 0.26 ? (rng.next() < 0.4 ? 3 : 2) : 1;
          let delay = 0;
          for (let i = 0; i < count; i++) {
            // constrained walk: small steps, gently pulled back to the middle
            const stepSize = rng.next() < 0.72 ? 1 : 2;
            const dir = rng.next() < (walk > pal.scale.length * 0.6 ? 0.3 : 0.62) ? 1 : -1;
            walk = clamp(walk + dir * stepSize, 0, pal.scale.length - 1);
            const note = pal.scale[Math.round(walk)];
            const high = note >= 76;
            bells++;
            out.push({
              name: rng.next() < (mode === 'night' ? 0.32 : 0.16) ? 'mpluck' : 'bell',
              params: {
                freq: mtof(note),
                gain: pal.bellGain * (1 + lift * 0.35) * (0.7 + rng.next() * 0.5) * (high ? 0.8 : 1),
                decay: pal.bellDecay * (0.8 + rng.next() * 0.5),
                index: 3.2 + rng.next() * 2.2,
                pan: (rng.next() - 0.5) * 1.1,
                delay,
              },
            });
            delay += 0.30 + rng.next() * 0.45;
          }
        }
      }

      if (phaseLeft <= 0) {
        phase = 'rest';
        phaseLeft = pick(pal.rest);
        currentChord = null;
      }
      return out;
    },

    snapshot() {
      return {
        mode, key: pal.key, phase,
        chord: phase === 'play' ? (currentChord?.name ?? '(entering)') : null,
        secondsLeftInPhase: +phaseLeft.toFixed(1),
        nextChordIn: phase === 'play' ? +Math.max(0, chordLeft).toFixed(1) : null,
        phrasesPlayed: phrases, chordsPlayed: chords, notesPlayed: bells,
      };
    },
  };
}
