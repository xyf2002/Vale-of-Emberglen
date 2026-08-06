/**
 * CATCH CHANCE — the single most important number in this system, because it decides
 * whether the sphere REPLACES the berry loop or COMPLETES it.
 *
 * The failure mode to avoid is obvious once you say it out loud: if a thrown sphere
 * catches a wild creature at a decent rate, nobody ever feeds anything again and the
 * whole taming arc — notice, patience, three berries, the hand-feed — becomes a tutorial
 * for a mechanic the player has already skipped. So the curve is built so that the
 * sphere is a CLOSER, not an opener.
 *
 * The taming arc gives trust in hard steps (see interaction/Taming.js): each berry
 * crosses exactly one gate, so a creature in the world is at roughly
 *
 *     0.00  wild, never approached
 *     0.20  noticed, you stood still a while (patience caps just under the next gate)
 *     0.34  one berry      -> "curious"
 *     0.67  two berries    -> "trusting"
 *     1.00  three berries  -> tames itself; the sphere is not involved
 *
 * A logistic centred at 0.38 with width 0.135 maps those onto:
 *
 *     trust 0.00 -> 5.7%    a wild animal essentially cannot be bought with a sphere
 *     trust 0.20 -> 20.4%   patience alone is a long shot
 *     trust 0.34 -> 42.7%   one berry makes it a real gamble
 *     trust 0.67 -> 89.5%   two berries make it nearly a sure thing
 *
 * That is the shape the brief asks for: sharply rising, wild usually breaks out, fed is
 * nearly certain. It also means the sphere is worth exactly one berry of progress — it
 * buys you the third berry, and the risk of losing ground if it fails.
 *
 * On top of trust, three situational modifiers, all of which are things the player DID:
 *   startled  a creature that is fleeing or afraid is off balance
 *   settling  a creature still chewing the berry you just gave it is distracted — this
 *             is the tightest coupling of the two loops: feed, then throw while it eats
 *   tired     briefly winded after breaking out of a sphere
 * and one that punishes spamming:
 *   wary      each breakout makes the next sphere harder, so throwing repeatedly at a
 *             wild creature converges to nothing while feeding it converges to a friend
 *
 * Every one of these is read from state the interaction system already maintains. This
 * file never writes to it.
 *
 * VERIFIED r12 — the `wary` term does apply and does bite, but read the whole table before
 * assuming a spammer is punished. Chances for a wild creature (trust 0.00):
 *
 *   fresh, calm, 0 breakouts                      5.7%
 *   immediate re-throw, 1 breakout, tired=1       18.5%   <- winded + startled outweigh wary
 *   immediate re-throw, 2 breakouts, tired=1      12.7%
 *   immediate re-throw, 3 breakouts, tired=1      12.7%   (waryCap = 2)
 *   once the winding has worn off, 1 breakout      7.5%
 *   once the winding has worn off, 2 breakouts     4.9%
 *
 * So `wary` converges the SPAM line to about 12.7% per throw rather than to nothing: the
 * +0.14 tired and +0.10 startled bonuses are together larger than the −0.12 the wary cap
 * allows. That is arguably the intended "you nearly had it, follow up now" reward, and it
 * is the same shape as feed-then-throw-while-it-eats — so it was left alone. But six
 * spheres thrown back to back at a wild animal is still roughly a coin flip, which is
 * worth a deliberate decision rather than an accident. Raising `waryCap`, or decaying
 * `tired` per breakout, are the two knobs; neither was touched in r12.
 */

export const CATCH = {
  mid: 0.38,
  width: 0.135,
  startled: 0.10,
  settling: 0.09,
  tired: 0.14,
  wary: 0.06,
  waryCap: 2,
  floor: 0.02,
  ceil: 0.97,
  /** how long a creature stays winded after bursting out */
  tiredDecay: 18,
  shakes: 3,
};

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

/** the situational read on one creature — also what the HUD would want to explain odds */
export function readFactors(cr) {
  const st = cr?._tame ?? null;
  const s = cr?._sphere ?? null;
  const trust = Math.max(cr?.trust ?? 0, st?.trust ?? 0);
  const act = st?.act ?? 'idle';
  const startled = (act === 'flee' || cr?.mood === 'afraid') ? 1
    : (act === 'shy' || cr?.mood === 'wary') ? 0.45 : 0;
  const settling = st && st.fedCd > 0.4 ? Math.min(1, st.fedCd / 8) : 0;
  const tired = s ? clamp(s.tired, 0, 1) : 0;
  const wary = s ? Math.min(CATCH.waryCap, s.breakouts) : 0;
  return { trust, startled, settling, tired, wary };
}

/** 0..1 probability that a sphere thrown at this creature right now closes for good */
export function catchChance(cr) {
  const f = readFactors(cr);
  const eff = f.trust
    + CATCH.startled * f.startled
    + CATCH.settling * f.settling
    + CATCH.tired * f.tired
    - CATCH.wary * f.wary;
  const p = 1 / (1 + Math.exp(-(eff - CATCH.mid) / CATCH.width));
  return clamp(p, CATCH.floor, CATCH.ceil);
}

/**
 * Roll the wobbles up front, deterministically, from the system's own forked stream.
 *
 * Three independent gates each at p^(1/3) multiply back out to exactly `p`, so the
 * drama is free: the odds the player was shown are the odds they got, and "it wobbled
 * twice and burst" is a real near-miss rather than a scripted tease.
 */
export function rollShakes(rng, p) {
  const per = Math.pow(p, 1 / CATCH.shakes);
  let survived = 0;
  for (let i = 0; i < CATCH.shakes; i++) {
    if (rng.next() < per) survived++;
    else break;
  }
  return { caught: survived === CATCH.shakes, survived, p, per };
}
