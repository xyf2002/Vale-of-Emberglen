import { ORDER } from '../engine/Game.js';

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
 * STUB: no-op that records what it *would* have played, so critics can still audit
 * whether sound is wired to the right moments.
 */
export function createAudio() {
  let ctx, muted = false;
  const played = [];
  let ambience = null;

  return {
    name: 'audio',
    order: ORDER.AUDIO,

    init(c) {
      ctx = c;
      c.bus.on('creature:fed', () => this.play('nibble'));
      c.bus.on('creature:tamed', () => this.play('bond'));
      const resume = () => { this._gesture = true; window.removeEventListener('pointerdown', resume); };
      window.addEventListener('pointerdown', resume);
    },

    update(dt, c) {
      if (c.input.justPressed('mute')) this.setMuted(!muted);
      if (played.length > 200) played.splice(0, played.length - 200);
    },

    play(name, opts = {}) { played.push({ name, t: ctx?.elapsed ?? 0, ...opts }); },
    setAmbience(biome, timeOfDay, weather) { ambience = { biome, timeOfDay, weather }; },
    setMuted(m) { muted = m; },
    snapshot() { return { muted, ambience, recent: played.slice(-8).map((p) => p.name) }; },
  };
}
