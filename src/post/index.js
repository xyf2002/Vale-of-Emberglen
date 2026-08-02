import { ORDER } from '../engine/Game.js';

/**
 * POST-PROCESSING / IMAGE SYSTEM — owned by the look-dev builder. If this system exposes
 * a render(), Game.render() calls it INSTEAD of renderer.render(). That makes it the
 * single place to own the final image: bloom, colour grade, vignette, DOF, AA, exposure.
 *
 * PUBLIC CONTRACT:
 *   render(ctx)                     optional; when absent the engine renders directly
 *   setGrade(name)                  named look ('dawn','noon','golden','dusk','night')
 *   snapshot()
 *
 * Note: it must degrade gracefully — if ctx.quality.post is false, fall back to a plain
 * render rather than shipping a broken frame.
 *
 * STUB: passthrough.
 */
export function createPost() {
  let grade = 'auto';
  return {
    name: 'post',
    order: ORDER.POST,
    init() {},
    // No render() here on purpose: engine falls back to renderer.render().
    setGrade(g) { grade = g; },
    snapshot() { return { grade, enabled: false }; },
  };
}
