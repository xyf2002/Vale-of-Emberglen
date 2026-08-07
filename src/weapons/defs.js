/**
 * WEAPON DEFINITIONS — every number that decides how a gun feels, in one table.
 *
 * The reference for feel is GTA's third-person shooting, and the two things that make
 * that feel specific are here rather than in the code:
 *
 *   1. SPREAD IS A LIVE VALUE, not a per-weapon constant. `spread.aimed` is the floor a
 *      settled, aiming player reaches; everything else is an additive term that widens
 *      the cone (hip fire, movement, sprint, and the bloom each shot adds). The HUD
 *      reticle is literally this number, so a player learns the weapon by watching the
 *      crosshair breathe rather than by reading a stat screen.
 *
 *   2. RECOIL IS TWO CURVES PLUS A RESIDUAL. `recoil.snap` is the fast visible kick that
 *      settles in ~0.15 s; `recoil.climb` is the slower muzzle rise that sustained fire
 *      accumulates; `recoil.drift` is the part that never comes back, so the tenth round
 *      of a burst does not land where the first one did. A single spring cannot produce
 *      that shape — a burst with one spring just oscillates around the original aim.
 *
 * The damage numbers are deliberately NOT health. A shot drains STAMINA (see weaken.js).
 * A creature at zero stamina is exhausted and much easier to befriend, and nothing in
 * this module can kill anything — that is the whole reason firearms are allowed to exist
 * in a game about making friends with the wildlife.
 */

export const WEAPONS = {
  pistol: {
    id: 'pistol',
    name: 'Sidearm',
    auto: false,
    rpm: 320,                 // semi-auto: this is the cyclic *limit*, not a cadence
    magSize: 12,
    reserve: 60,
    startReserve: 60,
    range: 160,
    damage: 0.15,             // stamina drained per hit (1.0 = a fresh creature)
    // Health damage is deliberately the SLOWER of the two clocks. A woolkin has 112
    // health and exhausts after ~7 hits; at 9 per shot it takes 13 to kill. Whoever
    // tunes these next: keep exhaustion arriving first, or the befriending loop
    // becomes unreachable through the weapon that is supposed to open it.
    hpDamage: 9,
    stagger: 0.55,            // how hard one hit rocks the target, 0..1
    knockback: 1.35,          // m/s of impulse along the shot axis

    // ---- cone of fire, degrees -------------------------------------------
    spread: {
      aimed: 0.55,            // settled, aiming, standing still
      hip: 4.6,               // added at aimBlend 0
      move: 2.4,              // added at full walk speed
      sprint: 3.2,            // added on top at full sprint
      perShot: 1.15,          // bloom added by each round
      max: 10.0,
      recover: 4.6,           // bloom decay rate, 1/s
    },

    // ---- recoil impulses, radians of spring velocity ----------------------
    // Sized against the arithmetic, not by eye. A stream of impulses `imp` at rate `f`
    // into a spring of stiffness k settles at imp*f/k, so the CLIMB term is chosen to
    // land at ~2 deg of sustained rise at this weapon's maximum cadence (0.17*5.3/26).
    // The first version was authored at 0.30 and put 5.4 degrees on the sights after
    // four rounds, which at 7 m is half a metre — the burst simply flew over the target.
    // `drift` is per-shot and near-permanent (it only bleeds off over
    // RECOIL_SPRING.driftTau), so it is deliberately tiny: a whole magazine emptied as
    // fast as the trigger allows walks the muzzle about a degree off true.
    recoil: { snap: 3.45, climb: 0.17, drift: 0.0018, yaw: 0.55, kickBack: 0.030 },

    // ---- reload phases, seconds ------------------------------------------
    // Three phases because a reload the player can *read* is a reload the player can
    // learn to cancel. Ammo lands at the end of magin; the charge phase is the slide.
    // (Key names are the phase names that go on the bus, exactly — they were camelCase
    // for one revision and every phase lookup silently returned undefined, which made a
    // 1.2 s reload complete in three frames and the interrupt test unfalsifiable.)
    reload: { magout: 0.40, magin: 0.48, charge: 0.30 },

    aimIn: 14.0,              // damping rate into aim (~0.20 s to settle)
    aimOut: 5.2,              // and the slower ramp back out (~0.45 s)
    moveScale: 0.62,          // how much the player should slow while aiming
    fireHeat: 0.9,            // muzzle-flash scale
  },

  rifle: {
    id: 'rifle',
    name: 'Carbine',
    auto: true,
    rpm: 620,
    magSize: 30,
    reserve: 120,
    startReserve: 120,
    range: 240,
    damage: 0.105,
    hpDamage: 6,              // see the note on the sidearm's hpDamage
    stagger: 0.40,
    knockback: 1.0,

    spread: {
      aimed: 0.32,
      hip: 5.4,
      move: 2.9,
      sprint: 3.8,
      perShot: 0.62,
      max: 11.0,
      recover: 3.4,
    },

    // 10.3 rounds/s, so the climb impulse is proportionally smaller: 0.11*10.3/26 is
    // again ~2.5 deg of sustained rise, reached over a second of held trigger.
    recoil: { snap: 2.30, climb: 0.11, drift: 0.0008, yaw: 0.42, kickBack: 0.022 },

    reload: { magout: 0.46, magin: 0.58, charge: 0.36 },

    aimIn: 12.0,
    aimOut: 4.6,
    moveScale: 0.55,
    fireHeat: 1.15,
  },
};

/** Two springs and a leaky accumulator; see the note at the top of this file. */
export const RECOIL_SPRING = {
  snap: { k: 700, c: 53 },      // critically damped, ~0.15 s to settle
  climb: { k: 26, c: 10.2 },    // the slow rise a burst walks up the screen
  driftTau: 3.6,                // seconds for the residual to bleed off
};
