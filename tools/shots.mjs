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
    title: 'Establishing vista, golden hour',
    intent: 'Does the world look like somewhere you want to walk into? Depth, silhouette, light.',
    setup: (g) => {
      g.setTimeOfDay(0.74);
      g.place(0, 0, 0);
      g.run(1.5);
      const s = g.state();
      const [x, y, z] = s.player.pos;
      g.setCamera([x - 26, y + 17, z + 30], [x + 30, y + 2, z - 40], 46);
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
      const c = g.spawnCreature('woolkin', 12, 12);
      g.run(0.4);
      const s = g.state();
      const p = s.creatures?.sample?.[0];
      g.setCamera([13.6, (p ? 0 : 0) + 1.5, 14.4], [12, 0.9, 12], 40);
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
