# Vale of Emberglen — working notes

A Palworld-inspired 3D survival vertical slice. Three.js, Vite, fully procedural: no
asset files and no network at runtime. Every texture, mesh, animation and sound is
generated in code from a seed.

## The bar

Real Palworld screenshots live in `reference/palworld/`. A fresh-context critic is shown
one of our frames and a real one, normalised to identical resolution and JPEG quality,
and asked **"which is the shipped commercial game?"** That is the bar. Everything else —
`tools/measure.py`, the guardrail bands — is a fast proxy that stops arguments, not the
goal. `reference/INDEX.md` is a 12-point art-direction brief measured off those plates
and is the most useful document in the repo.

## Non-negotiables

- **Determinism.** `ctx.rng` / `ctx.noise` only. Never `Math.random`, never `Date.now`,
  never wall-clock. The same seed and the same number of simulated seconds must produce
  a byte-comparable frame — round-over-round A/B is the whole method and it dies without
  this.
- **Never weaken the instrument to make numbers pass.** `tools/capture.mjs`, its
  `FRAME_PROBE`, `tools/shots.mjs` and `tools/measure.py` are off-limits to builders.
  Making the instrument lie is the worst possible outcome; it has cost more rounds than
  any rendering bug. If you think a band or a shot is wrong, say so in your report with
  evidence.
- **Systems never import each other.** Resolve peers at runtime with `ctx.get('name')`,
  communicate over `ctx.bus`. This is what lets many agents own disjoint directories
  without merge conflicts. See `src/engine/Game.js`.
- **No death.** Creatures are befriended, staggered or exhausted — never killed. There is
  no health, no corpse and no despawn-on-damage path anywhere in the build, and none may
  be added.

## Traps that have bitten more than once

**Double sRGB decode — three separate agents so far.** With three's colour management on
(default since r152) `new THREE.Color(hex)` *already* decodes an sRGB literal to linear.
Calling `.convertSRGBToLinear()` on top squares the albedo — 0.080 becomes 0.007 — and
the object renders as a black hole. Just use `new THREE.Color(hex)`.

**Instanced normals and non-uniform scale.** three applies the inverse transpose to
instanced normals, which is geometrically correct and visually fatal for anything
instanced with a squashed scale (grass blades). It rotates an authored mostly-up normal
almost fully horizontal and the whole field lights on ambient only. Rebuild the normal in
the vertex shader instead. See `src/world/vegetation.js`.

**A shadow can only remove the key's contribution.** If an unshadowed fill out-contributes
the shadow-casting key, no shadow map however perfect can darken the ground by more than
the key's share. Check the key/fill ratio before debugging the shadow map. See the long
comment in `src/sky/index.js`.

**`shadow.bias` is in normalised depth, `normalBias` is a world-space push along the
normal.** Neither can fix terrain acne at a grazing sun — that needs a slope-scaled
offset, i.e. `polygonOffset` on a `customDepthMaterial`. See `src/world/index.js`.

**A rim light down the view axis produces no rim.** At the silhouette edge the normal is
perpendicular to the view, so N·L is zero exactly where you want the light and the lit
band lands on the side the lens cannot see. Yaw it off-axis.

**Preetham's `sunIntensity()` returns exactly zero** below `cos(CUTOFF_ANGLE)` = −0.0401.
Clamp the scattering sun to the *near* side of that or the entire in-scattering term
vanishes the instant the sun sets, and the sky becomes a flat gradient.

## The harness

- `node tools/capture.mjs --round rNN` — the six matched shots plus three motion strips.
- `python3 tools/measure.py --round rNN` — guardrails. Bands are **two-sided**: exceeding
  one is as much a finding as falling short. It refuses to grade a round containing dead
  frames and exits non-zero.
- `node tools/playtest.mjs --minutes 5 --round rNN` — a scripted naive player, five real
  simulated minutes, driven through the same input path a human uses.
- `python3 tools/abpack.py` — builds the blind A/B pack. The answer key is written
  **outside** the pack directory on purpose.
- Throwaway probes are `_`-prefixed in `tools/`. Keep them; the negative results they
  record are worth as much as the fixes.

Both harnesses run vite with `hmr:false, watch:null`. They must photograph the build they
started with — with hot reload live, another agent saving a file mid-round reloads the
page under the capture and what lands on disk is the boot overlay.

## Reporting

Report what you measured, not what you expect. **Negative results are valuable and belong
in the source as comments**, so the next agent does not re-try the same dead end — see the
grass-casting note in `src/world/vegetation.js` and the tracer-pixel-ownership note in
`src/weapons/fx.js`. If you could not reach something from inside your own directories,
say so rather than reaching across.
