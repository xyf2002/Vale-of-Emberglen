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
    setup: (g) => {
      g.setTimeOfDay(0.34);
      g.run(3);
      g.setCamera(null);
      g.run(1.5);
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

/** Motion strips — the instrument for "believable behaviour", which stills cannot show. */
export const STRIPS = [
  {
    id: 'behaviour_idle',
    title: 'Creatures left alone for 12s',
    intent: 'Do they behave like animals with their own agenda when nobody is interacting?',
    frames: 6,
    setup: (g) => { g.setTimeOfDay(0.35); g.setCamera(null); g.run(1); },
    between: (g) => g.run(2.0),
  },
  {
    id: 'behaviour_approach',
    title: 'Player walks toward a creature',
    intent: 'The Palworld "first contact" beat: notice, assess, react. Is there a legible arc?',
    frames: 6,
    setup: (g) => { g.setTimeOfDay(0.4); g.setCamera(null); g.run(0.5); g.hold('forward', true); },
    between: (g) => g.run(1.2),
    teardown: (g) => g.hold('forward', false),
  },
];
