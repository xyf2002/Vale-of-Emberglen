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
- **Two clocks on a creature, and they are not interchangeable.** The no-death rule was
  lifted by the owner in r15; creatures now have health and can be killed. Both paths
  must keep working:
  - **Stamina** (`src/weapons/weaken.js`) — what a shot is *for*. It runs out first, the
    creature sits down exhausted, and that is the capture window. This is still the
    intended loop and nothing may make it unreachable.
  - **Health** (`src/creatures/vitality.js`) — the slower clock. At zero the creature
    dies, topples, lies there ~11 s and sinks. Tune `hpDamage` in `weapons/defs.js` only
    while exhaustion still arrives well before death.
  Dead creatures stay in `creatures.list` while the body is up, so **every consumer of
  that list must skip `cr.dead`** — AI, interaction, spheres and targeting already do.
- **The player collapses, never dies.** `src/vitals/` (vigour, focus, stamina — the
  Elden Ring cluster) puts the traveller on one knee for a few seconds at zero vigour and
  stands them back up at 45%. There is no death screen, no respawn and no game over, and
  none may be added.

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

**`normalBias` scales with nothing.** It is a world-space push, so it costs the same
absolute centimetres whether the shadow is a mountain's or a creature's. At 0.12 it walked
every receiver 12 cm out from under its occluder — a fifth of the width off both sides of
a 60 cm contact shadow, in every frame, no matter how many texels the map had. It beat
frustum size and cascade count combined as the cause of "nothing casts a shadow", and a
COARSER box with a lower bias out-measured a finer one by 34%. Check it before you spend a
round on resolution. See `src/sky/index.js`.

**Anything authored along the view axis projects to a point.** Two agents have now lost
time to the same geometry from different directions: a rim light down the view axis (below)
and the sphere's pull-in beam, which was authored along the flight line — and you throw at
what the reticle is on, so the flight line IS the camera's forward axis. A cone down that
axis projects to a bullseye: a glowing target ring with no length or direction near, a pale
30 px disc at range. Give the effect a lateral component so it crosses the frame. See
`src/spheres/index.js`.

**A shadow map cannot ground a creature standing in tall grass.** The meadow carpet is
0.30–0.60 m and creatures stand *in* it, so from any playable camera the pixels around a
creature's base are grass, not ground — darkening the ground plane darkens something nobody
can see, and the diff image is a comb of blade-shaped slivers. Grounding has to be a stack
of occluders through the canopy, not one decal on the floor. Raising the single decal to
clear the canopy detaches it from the feet before it clears. See `src/creatures/materials.js`.

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
