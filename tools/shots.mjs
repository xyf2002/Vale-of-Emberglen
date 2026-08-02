/**
 * THE MATCHED-SHOT PROTOCOL.
 *
 * Each entry stages the game into a frame that is directly comparable to a specific
 * *kind* of shot in reference/palworld/. Blind A/B is only meaningful if both images
 * are trying to be the same photograph — a wide vista next to a creature close-up
 * tells a critic nothing.
 *
 * `setup` runs inside the page with `g` = window.__game. Use only the documented
 * capture API. Never use wall-clock time; always advance the sim explicitly.
 */

export const SHOTS = [
  {
    id: 'vista_golden',
    // Deliberately NOT golden hour: the only fair reference comp (pw_11) is a bright
    // daylight ground-level vista. Matched-shot means matching the reference, not
    // picking the lighting that flatters us most.
    title: 'Establishing vista, bright day, ground level',
    intent: 'Does the world look like somewhere you want to walk into? Three depth planes, aerial perspective, a landmark at 1-3km.',
    setup: (g) => {
      g.setTimeOfDay(0.60);
      g.setCamera(null);
      g.run(1.5);
      const s = g.state();
      const [x, y, z] = s.player.pos;
      // eye height, near-level pitch — per reference observation #10
      g.setCamera([x - 5, y + 1.7, z + 7], [x + 34, y + 3.5, z - 46], 62);
      g.run(0.6);
    },
  },
  {
    id: 'overshoulder_meadow',
    title: 'Third-person over-shoulder, creatures ahead, morning',
    intent: 'The core Palworld framing: your character, a creature at conversational distance, world behind.',
    setup: (g) => {
      g.setTimeOfDay(0.29);
      g.setCamera(null);
      const s0 = g.state();
      g.place(s0.player.pos[0], s0.player.pos[2], 0);
      g.run(2.2);
    },
  },
  {
    id: 'creature_portrait',
    title: 'Creature at close range',
    intent: 'Charm test. Silhouette, face, material, shading. This is the single hardest shot to fake.',
    setup: (g) => {
      g.setTimeOfDay(0.63);
      g.setCamera(null);
      g.run(0.3);
      const s = g.state();
      const [px, , pz] = s.player.pos;
      // Stage subject and camera against the ground each one actually stands on.
      // Using the player's height for both buries the camera whenever the terrain rises.
      const cx = px + 3, cz = pz + 3;
      const cy = g.groundAt(cx, cz);
      const ex = px + 5.0, ez = pz + 5.1;
      const ey = g.groundAt(ex, ez) + 1.15;   // above the grass line, near creature eye height
      g.spawnCreature('woolkin', cx, cz);
      g.run(0.5);
      // longer lens, creature filling 55-75% of frame height — per reference observation #11
      g.setCamera([ex, ey, ez], [cx, cy + 0.45, cz], 38);
      g.run(0.8);
    },
  },
  {
    id: 'creature_group',
    title: 'A few creatures sharing a meadow',
    intent: 'Aliveness in a still: are they arranged and posed like animals, or scattered like props?',
    // The gameplay camera frames the PLAYER, so this shot used to show three
    // forty-pixel blobs parked in the left third while 60% of frame was empty grass.
    // A group shot has to actually contain its subject: find the creature cluster and
    // frame that, at a distance where individuals read as characters.
    setup: (g) => {
      g.setTimeOfDay(0.34);
      g.setCamera(null);
      g.run(3);
      const s = g.state();
      const list = (s.creatures && s.creatures.sample) || [];
      const p = s.player.pos;
      if (!list.length) { g.run(1); return; }
      // anchor on the creature nearest the player, then include its neighbours
      let anchor = list[0], best = 1e9;
      for (const c of list) {
        const d = (c.pos[0] - p[0]) * (c.pos[0] - p[0]) + (c.pos[1] - p[2]) * (c.pos[1] - p[2]);
        if (d < best) { best = d; anchor = c; }
      }
      let cx = 0, cz = 0, n = 0;
      for (const c of list) {
        const d = Math.hypot(c.pos[0] - anchor.pos[0], c.pos[1] - anchor.pos[1]);
        if (d < 16) { cx += c.pos[0]; cz += c.pos[1]; n++; }
      }
      cx /= n; cz /= n;
      const gy = g.groundAt(cx, cz);
      const ex = cx + 6.5, ez = cz + 6.0;
      const ey = g.groundAt(ex, ez) + 1.9;
      g.setCamera([ex, ey, ez], [cx, gy + 0.55, cz], 46);
      g.run(0.8);
    },
  },
  {
    id: 'interaction_feed',
    title: 'Offering food to a wary creature',
    intent: 'The core loop, mid-beat. Readability of prompt, creature reaction, and framing.',
    setup: (g) => {
      g.setTimeOfDay(0.45);
      g.setCamera(null);
      g.run(1.0);
      g.tap('offer');
      g.run(0.6);
    },
  },
  {
    id: 'dusk_mood',
    title: 'Dusk',
    intent: 'Does the world hold up when the sun is not doing the work for you?',
    setup: (g) => {
      g.setTimeOfDay(0.86);
      g.setCamera(null);
      g.run(1.5);
    },
  },
];

/**
 * Motion strips — the instrument for "believable behaviour", which stills cannot show.
 *
 * A motion critic found these strips could not demonstrate the thing they were grading:
 * the camera was a locked over-shoulder rig at human eye height looking DOWN on 0.5 m
 * creatures 15-25 m away, the subject drifted to the frame edge and then out of frame
 * entirely, and 1.2 s sampling cannot show a 0.3-0.5 s acceleration ramp. So each strip
 * now re-aims at its subject before every frame, sits near creature eye height on a
 * longer lens, and samples fast enough to resolve the behaviour it claims to test.
 */

/** camera helper shared by the strips: hold the subject creature at readable scale */
const TRACK = (g, opts) => {
  const s = g.state();
  const p = s.player.pos;
  const list = (s.creatures && s.creatures.sample) || [];
  if (!list.length) return;
  let c = list[0], best = 1e9;
  for (const k of list) {
    const d = Math.hypot(k.pos[0] - p[0], k.pos[1] - p[2]);
    if (d < best) { best = d; c = k; }
  }
  const cx = c.pos[0], cz = c.pos[1];
  const gy = g.groundAt(cx, cz);
  // stand off along the player->creature axis, near creature eye height
  const dx = cx - p[0], dz = cz - p[2];
  const len = Math.max(0.001, Math.hypot(dx, dz));
  const back = opts.dist;
  const ex = cx + (dx / len) * -back + (dz / len) * opts.side;
  const ez = cz + (dz / len) * -back - (dx / len) * opts.side;
  g.setCamera([ex, g.groundAt(ex, ez) + opts.height, ez], [cx, gy + 0.42, cz], opts.fov);
};

export const STRIPS = [
  {
    id: 'behaviour_idle',
    title: 'Creatures left alone for ~14s, no interaction whatsoever',
    intent: 'Do they behave like animals with their own agenda? Rubric criterion 1: no two creatures may share a pose, phase or facing.',
    frames: 8,
    // The capture harness now reloads the page before each strip, so no earlier shot's
    // taming can leak in and make an "interaction-free" window contain a tamed companion.
    setup: (g) => { g.setTimeOfDay(0.35); g.setCamera(null); g.run(1.5); },
    beforeFrame: (g) => TRACK(g, { dist: 4.6, side: 2.2, height: 0.95, fov: 44 }),
    between: (g) => g.run(1.8),
  },
  {
    id: 'behaviour_approach',
    title: 'Player walks toward a creature',
    intent: 'The Palworld first-contact beat: notice, assess, react. Rubric criteria 5, 8 and 11.',
    frames: 8,
    setup: (g) => { g.setTimeOfDay(0.4); g.setCamera(null); g.run(0.5); g.hold('forward', true); },
    beforeFrame: (g) => TRACK(g, { dist: 5.2, side: 2.6, height: 1.05, fov: 46 }),
    between: (g) => g.run(0.7),
    teardown: (g) => g.hold('forward', false),
  },
  {
    id: 'behaviour_startle',
    title: 'Close-range reaction sampled every 0.25s',
    intent: 'Rubric criterion 8: starts and stops must be events with a 0.2-0.4s lean-before-translate ramp, not switches. Coarser sampling cannot show this.',
    frames: 8,
    setup: (g) => { g.setTimeOfDay(0.45); g.setCamera(null); g.run(2.0); g.hold('sprint', true); g.hold('forward', true); },
    beforeFrame: (g) => TRACK(g, { dist: 4.0, side: 1.8, height: 0.8, fov: 42 }),
    between: (g) => g.run(0.25),
    teardown: (g) => { g.hold('forward', false); g.hold('sprint', false); },
  },
];
