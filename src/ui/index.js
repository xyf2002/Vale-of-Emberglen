import { ORDER } from '../engine/Game.js';
import { silhouetteSVG } from './silhouettes.js';

/**
 * UI SYSTEM — owned by the UI builder. DOM overlay in #ui-root (not WebGL), so it can be
 * styled properly. Owns HUD, interaction prompts, notifications, the creature journal,
 * and the opening moments that teach the player how to play without a wall of text.
 *
 * PUBLIC CONTRACT:
 *   notify(text, opts)            transient toast
 *   showPrompt({text,key}|null)   contextual action prompt
 *   setJournalOpen(bool)
 *   snapshot()  -> must include { visibleText: string[] } so critics can assert what
 *                  the player is actually being told at a given moment.
 *
 * ART DIRECTION — "the traveller's field kit".
 * The reference screenshots are HUD-free press shots. Anything we draw on top is a
 * handicap in the blind A/B, so the HUD is built out of *ink on the world*: strokes,
 * hairlines and cutouts with a legibility shadow, and exactly one filled surface (the
 * journal, which is a book and is allowed to be paper). Nothing lives in the middle
 * third of the frame except the reticle, which is anchored to the creature you are
 * looking at rather than to the screen.
 *
 * Type: an old-style serif for the things the world names (species, notes) and a very
 * small tracked sans for the things the machine names (labels, keycaps). No panels,
 * no rounded dark-glass cards, no icon font.
 *
 * Determinism: every fade and pulse is driven from the fixed-step `dt`, never from CSS
 * transitions or wall clock, so a capture at N simulated seconds is byte-stable and
 * survives Playwright's `animations: 'disabled'`.
 */

const FIELD_NOTES = {
  woolkin: 'Sleeps standing up. The fleece keeps the cold out and the burrs in.',
  emberfox: 'Warm to the touch. Follows anything that smells of berries, then pretends it did not.',
  mosshorn: 'Moss grows on the left horn only. Walks the same circuit every morning.',
};
/**
 * The line under a creature's name used to be its MOOD — "at ease", "wary", "grazing".
 * A stranger cannot tell those apart in tone, so a creature one berry from being a
 * companion looked exactly like a creature that had never met you. That line now carries
 * the only two facts that matter: how far along the arc you are, and what finishing costs.
 */
const STAGE_WORDS = {
  wild: 'unaware', noticed: 'noticed', curious: 'curious',
  trusting: 'trusting', bonded: 'companion',
};
const RESOURCE_WORDS = {
  berry: ['Berry bush', 'ripe'], wood: ['Fallen branches', 'dry'], stone: ['Loose stone', 'workable'],
};

const CSS = `
#eg-ui{position:absolute;inset:0;pointer-events:none;
  --s:max(0.86px, min(100vw / 1520, 100vh / 855));
  --vellum:#f6ead2;--ink:#1b1409;--ember:#e79b42;--lichen:#a6bd7e;--berry:#c5563f;
  --serif:ui-serif,"Iowan Old Style","Palatino Linotype",Palatino,Georgia,"Times New Roman",serif;
  --micro:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  --lift:0 calc(1*var(--s)) calc(2*var(--s)) rgba(12,8,4,.9),0 0 calc(14*var(--s)) rgba(12,8,4,.55);
  color:var(--vellum);font-family:var(--serif);-webkit-font-smoothing:antialiased}
#eg-ui .micro{font-family:var(--micro);font-size:calc(9.5*var(--s));font-weight:600;
  letter-spacing:.22em;text-transform:uppercase}
#eg-ui .sh{text-shadow:var(--lift)}
#eg-ui .eg-sil{display:block;color:currentColor;fill:currentColor}
#eg-ui .eg-sil-eye{fill:var(--vellum);opacity:.92}

/* ---- key caps: the one solid, printed thing on screen ---- */
#eg-ui .key{display:inline-flex;align-items:center;justify-content:center;
  min-width:calc(19*var(--s));height:calc(19*var(--s));padding:0 calc(4*var(--s));
  border-radius:calc(4*var(--s));background:var(--vellum);color:var(--ink);
  font-family:var(--micro);font-size:calc(10.5*var(--s));font-weight:700;letter-spacing:.06em;
  box-shadow:0 calc(1.5*var(--s)) 0 rgba(120,92,52,.85),0 calc(3*var(--s)) calc(6*var(--s)) rgba(10,7,3,.55)}

/* ---- bottom-left field kit ---- */
#eg-ui .kit{position:absolute;left:calc(36*var(--s));bottom:calc(34*var(--s));
  display:flex;flex-direction:column;gap:calc(9*var(--s));
  padding:calc(14*var(--s)) calc(30*var(--s)) calc(14*var(--s)) calc(16*var(--s));
  margin:calc(-14*var(--s)) calc(-30*var(--s)) calc(-14*var(--s)) calc(-16*var(--s));
  background:radial-gradient(ellipse 78% 66% at 32% 50%,rgba(10,7,3,.6),rgba(10,7,3,0) 76%)}
#eg-ui .kit .tally{display:flex;align-items:center;gap:calc(11*var(--s))}
#eg-ui .kit .tally .micro{font-size:calc(10.5*var(--s));opacity:.85}
#eg-ui .kit .pips{display:flex;gap:calc(6*var(--s))}
#eg-ui .kit .pip{width:calc(7*var(--s));height:calc(7*var(--s));border-radius:50%;
  border:calc(1.4*var(--s)) solid rgba(246,234,210,.7);box-shadow:0 0 calc(7*var(--s)) rgba(10,7,3,.85)}
#eg-ui .kit .pip.on{background:var(--ember);border-color:rgba(255,214,150,.95);
  box-shadow:0 0 calc(9*var(--s)) rgba(231,155,66,.75),0 0 calc(4*var(--s)) rgba(10,7,3,.8)}
/* the roster: who travels with you. permanent, one line, the only lasting proof of a bond */
#eg-ui .kit .party{display:flex;align-items:center;gap:calc(10*var(--s));margin-top:calc(1*var(--s))}
#eg-ui .kit .party .who{display:flex;align-items:center;gap:calc(6*var(--s))}
#eg-ui .kit .party svg{width:calc(17*var(--s));height:calc(17*var(--s));
  filter:drop-shadow(0 calc(1*var(--s)) calc(2*var(--s)) rgba(10,7,3,.9))}
#eg-ui .kit .party .nm{font-size:calc(15*var(--s));letter-spacing:.01em}
#eg-ui .kit .party .lbl{font-family:var(--micro);font-size:calc(9*var(--s));font-weight:600;
  letter-spacing:.2em;text-transform:uppercase;opacity:.62}
#eg-ui .vig{position:relative;width:calc(148*var(--s));height:calc(5*var(--s))}
#eg-ui .vig i{position:absolute;left:0;top:0;height:100%;display:block;border-radius:calc(3*var(--s))}
#eg-ui .vig .bed{width:100%;background:rgba(10,7,3,.55);
  box-shadow:0 0 0 calc(1*var(--s)) rgba(10,7,3,.4)}
#eg-ui .vig .fill{background:linear-gradient(90deg,#f8eed8,rgba(246,234,210,.78));
  box-shadow:0 0 calc(9*var(--s)) rgba(246,234,210,.4)}

/* ---- bottom-right satchel ---- */
#eg-ui .satchel{position:absolute;right:calc(36*var(--s));bottom:calc(30*var(--s));
  display:flex;align-items:center;gap:calc(9*var(--s));
  padding:calc(13*var(--s)) calc(16*var(--s));margin:calc(-13*var(--s)) calc(-16*var(--s));
  background:radial-gradient(ellipse 74% 66% at 62% 50%,rgba(10,7,3,.6),rgba(10,7,3,0) 78%)}
#eg-ui .satchel svg{width:calc(26*var(--s));height:calc(26*var(--s));
  filter:drop-shadow(0 calc(2*var(--s)) calc(3*var(--s)) rgba(10,7,3,.85))}
#eg-ui .satchel .n{font-size:calc(22*var(--s));letter-spacing:.02em}
#eg-ui .satchel .x{font-family:var(--micro);font-size:calc(11*var(--s));opacity:.55;
  margin-right:calc(-5*var(--s))}

/* ---- journal cue, top right ---- */
#eg-ui .jcue{position:absolute;right:calc(34*var(--s));top:calc(30*var(--s));
  display:flex;align-items:center;gap:calc(9*var(--s))}
#eg-ui .jcue .lbl{font-family:var(--micro);font-size:calc(9.5*var(--s));font-weight:600;
  letter-spacing:.2em;text-transform:uppercase;opacity:.8}

/* ---- compass, top centre, only while turning ---- */
#eg-ui .compass{position:absolute;left:50%;top:calc(26*var(--s));transform:translateX(-50%);
  width:calc(320*var(--s));height:calc(20*var(--s));overflow:hidden;
  -webkit-mask-image:linear-gradient(90deg,transparent,#000 22%,#000 78%,transparent);
  mask-image:linear-gradient(90deg,transparent,#000 22%,#000 78%,transparent)}
#eg-ui .compass .tape{position:absolute;top:0;left:0;height:100%}
#eg-ui .compass .m{position:absolute;top:calc(9*var(--s));width:calc(1*var(--s));height:calc(5*var(--s));
  background:rgba(246,234,210,.55)}
#eg-ui .compass .c{position:absolute;top:0;transform:translateX(-50%);
  font-family:var(--micro);font-size:calc(10*var(--s));font-weight:700;letter-spacing:.12em}
#eg-ui .compass .needle{position:absolute;left:50%;top:calc(2*var(--s));width:calc(1.5*var(--s));
  height:calc(14*var(--s));background:var(--ember);transform:translateX(-50%)}

/* ---- reticle: the signature. anchored to the creature, not to the screen ---- */
#eg-ui .ret{position:absolute;left:0;top:0;will-change:transform}
#eg-ui .ret .ring{position:absolute;width:calc(58*var(--s));height:calc(58*var(--s));
  left:calc(-29*var(--s));top:calc(-29*var(--s));overflow:visible;
  filter:drop-shadow(0 calc(1.5*var(--s)) calc(3*var(--s)) rgba(8,5,2,.75))}
#eg-ui .ret .lead{position:absolute;left:calc(23*var(--s));top:0;height:calc(1*var(--s));
  width:calc(24*var(--s));background:rgba(246,234,210,.75);box-shadow:0 calc(1*var(--s)) 0 rgba(10,7,3,.7)}
#eg-ui .ret .card{position:absolute;left:calc(53*var(--s));top:calc(-24*var(--s));white-space:nowrap;
  padding:calc(12*var(--s)) calc(26*var(--s)) calc(13*var(--s)) calc(14*var(--s));
  margin:calc(-12*var(--s)) calc(-26*var(--s)) calc(-13*var(--s)) calc(-14*var(--s));
  background:radial-gradient(ellipse 76% 64% at 26% 50%,rgba(10,7,3,.68),rgba(10,7,3,0) 74%)}
#eg-ui .ret.flip .lead{left:calc(-47*var(--s))}
#eg-ui .ret.flip .card{left:auto;right:calc(53*var(--s));text-align:right;
  padding:calc(12*var(--s)) calc(14*var(--s)) calc(13*var(--s)) calc(26*var(--s));
  margin:calc(-12*var(--s)) calc(-14*var(--s)) calc(-13*var(--s)) calc(-26*var(--s));
  background:radial-gradient(ellipse 76% 64% at 74% 50%,rgba(10,7,3,.68),rgba(10,7,3,0) 74%)}
#eg-ui .ret .nm{font-size:calc(23*var(--s));line-height:1.05;letter-spacing:.01em;
  text-shadow:0 calc(2*var(--s)) calc(5*var(--s)) rgba(8,5,2,.95)}
#eg-ui .ret .md{display:flex;align-items:center;gap:calc(8*var(--s));margin-top:calc(6*var(--s));
  font-family:var(--micro);font-size:calc(9.5*var(--s));font-weight:700;letter-spacing:.22em;
  text-transform:uppercase;color:#e8cf9e;opacity:.86}
#eg-ui .ret.flip .md{justify-content:flex-end}
#eg-ui .ret .md .cost{opacity:.72;letter-spacing:.16em}
#eg-ui .ret .md.last{color:#ffcf86;opacity:1}
#eg-ui .ret .md.last .cost{opacity:.95}
#eg-ui .ret .act{display:flex;align-items:center;gap:calc(9*var(--s));margin-top:calc(11*var(--s))}
#eg-ui .ret.flip .act{justify-content:flex-end}
#eg-ui .ret .vb{font-size:calc(15.5*var(--s));letter-spacing:.01em;
  text-shadow:0 calc(1.5*var(--s)) calc(4*var(--s)) rgba(8,5,2,.95)}

/* ---- tally: four scratched strokes, the naturalist's count of what a creature owes ---- */
#eg-ui .tal{display:inline-flex;align-items:flex-end;gap:calc(3.5*var(--s));flex:0 0 auto}
#eg-ui .tal i{display:block;width:calc(2.4*var(--s));height:calc(11*var(--s));
  background:rgba(246,234,210,.26);box-shadow:0 0 calc(4*var(--s)) rgba(8,5,2,.9)}
#eg-ui .tal i.on{background:var(--ember);
  box-shadow:0 0 calc(8*var(--s)) rgba(231,155,66,.8),0 0 calc(3*var(--s)) rgba(8,5,2,.9)}
#eg-ui .tal i.done{background:#f8eed8;box-shadow:0 0 calc(9*var(--s)) rgba(248,238,216,.7)}

/* ---- the one you left half-tamed: a quiet world-anchored tag, never a card ---- */
#eg-ui .mark{position:absolute;left:0;top:0;display:flex;align-items:center;gap:calc(8*var(--s));
  white-space:nowrap;padding:calc(8*var(--s)) calc(13*var(--s));margin:calc(-8*var(--s)) calc(-13*var(--s));
  background:radial-gradient(ellipse 72% 60% at 50% 50%,rgba(10,7,3,.5),rgba(10,7,3,0) 78%)}
#eg-ui .mark .lbl{font-family:var(--micro);font-size:calc(9.5*var(--s));font-weight:700;
  letter-spacing:.2em;text-transform:uppercase;text-shadow:var(--lift)}
#eg-ui .mark .tal i{height:calc(9*var(--s))}

/* ---- toasts, stacked above the satchel ---- */
#eg-ui .toasts{position:absolute;right:calc(34*var(--s));bottom:calc(66*var(--s));
  display:flex;flex-direction:column;align-items:flex-end;gap:calc(11*var(--s))}
#eg-ui .toast{display:flex;align-items:center;gap:calc(13*var(--s));will-change:transform,opacity;
  padding:calc(11*var(--s)) calc(16*var(--s));margin:calc(-11*var(--s)) calc(-16*var(--s));
  background:radial-gradient(ellipse 74% 62% at 62% 50%,rgba(10,7,3,.66),rgba(10,7,3,0) 76%)}
#eg-ui .toast .body{text-align:right}
#eg-ui .toast .eyebrow{font-family:var(--micro);font-size:calc(9.5*var(--s));font-weight:700;
  letter-spacing:.24em;text-transform:uppercase;color:#f5b566;margin-bottom:calc(3*var(--s))}
#eg-ui .toast .t{font-size:calc(19*var(--s));line-height:1.2}
#eg-ui .toast[data-kind="note"] .t{font-size:calc(16*var(--s));opacity:.94}
#eg-ui .toast .rule{width:calc(1.5*var(--s));height:calc(42*var(--s));background:linear-gradient(
  180deg,rgba(231,155,66,0),rgba(231,155,66,.9),rgba(231,155,66,0))}
#eg-ui .toast .eg-sil{filter:drop-shadow(0 calc(2*var(--s)) calc(3*var(--s)) rgba(10,7,3,.9))}

/* ---- cold open: no sentences, just placement ---- */
#eg-ui .teach{position:absolute;left:50%;bottom:calc(112*var(--s));transform:translateX(-50%);
  display:flex;flex-direction:column;align-items:center;gap:calc(5*var(--s))}
#eg-ui .teach .row{display:flex;gap:calc(5*var(--s))}
#eg-ui .teach .key{opacity:.95}
#eg-ui .chev{position:absolute;left:0;top:0;will-change:transform,opacity}
#eg-ui .chev svg{width:calc(36*var(--s));height:calc(36*var(--s))}
#eg-ui .toast .eg-sil{width:calc(46*var(--s));height:calc(46*var(--s))}
#eg-ui .jcue{padding:calc(11*var(--s)) calc(16*var(--s));margin:calc(-11*var(--s)) calc(-16*var(--s));
  background:radial-gradient(ellipse 74% 62% at 60% 50%,rgba(10,7,3,.55),rgba(10,7,3,0) 78%)}
#eg-ui .whisper{position:absolute;left:50%;bottom:calc(86*var(--s));transform:translateX(-50%);
  font-size:calc(15*var(--s));font-style:italic;letter-spacing:.02em;opacity:.85}

/* ---- the bond: the one moment the HUD is allowed to take the middle of the frame ----
   It lasts nine seconds, once per creature, and it is the only time a name is printed
   at title size. Everything else in this file is deliberately quiet so that this is not. */
#eg-ui .bond{position:absolute;left:50%;bottom:calc(132*var(--s));transform:translateX(-50%);
  display:flex;align-items:center;gap:calc(18*var(--s));white-space:nowrap;
  padding:calc(20*var(--s)) calc(40*var(--s));margin:calc(-20*var(--s)) calc(-40*var(--s));
  background:radial-gradient(ellipse 68% 60% at 50% 50%,rgba(10,7,3,.7),rgba(10,7,3,0) 76%)}
#eg-ui .bond svg{width:calc(56*var(--s));height:calc(56*var(--s));
  filter:drop-shadow(0 calc(2*var(--s)) calc(4*var(--s)) rgba(10,7,3,.95))}
#eg-ui .bond .rule{width:calc(1.5*var(--s));height:calc(62*var(--s));background:linear-gradient(
  180deg,rgba(231,155,66,0),rgba(231,155,66,.95),rgba(231,155,66,0))}
#eg-ui .bond .eyebrow{font-family:var(--micro);font-size:calc(10*var(--s));font-weight:700;
  letter-spacing:.3em;text-transform:uppercase;color:#f5b566;text-shadow:var(--lift)}
#eg-ui .bond .nm{font-size:calc(36*var(--s));line-height:1.08;margin-top:calc(4*var(--s));
  text-shadow:0 calc(2*var(--s)) calc(7*var(--s)) rgba(8,5,2,.98)}
#eg-ui .bond .ln{font-size:calc(16.5*var(--s));font-style:italic;opacity:.92;
  margin-top:calc(5*var(--s));text-shadow:var(--lift)}

/* ---- restock marker: only ever on screen when the satchel is actually empty ---- */
#eg-ui .forage{position:absolute;left:0;top:0;display:flex;align-items:center;gap:calc(7*var(--s));
  white-space:nowrap;padding:calc(8*var(--s)) calc(13*var(--s));margin:calc(-8*var(--s)) calc(-13*var(--s));
  background:radial-gradient(ellipse 72% 60% at 50% 50%,rgba(10,7,3,.5),rgba(10,7,3,0) 78%)}
#eg-ui .forage svg{width:calc(17*var(--s));height:calc(17*var(--s))}
#eg-ui .forage .lbl{font-family:var(--micro);font-size:calc(9.5*var(--s));font-weight:700;
  letter-spacing:.2em;text-transform:uppercase;text-shadow:var(--lift)}

/* ---- the journal: the only filled surface in the game ---- */
#eg-ui .scrim{position:absolute;inset:0;background:radial-gradient(120% 90% at 50% 50%,
  rgba(14,10,6,.36),rgba(14,10,6,.72));backdrop-filter:blur(calc(2*var(--s)))}
#eg-ui .book{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);
  width:min(calc(780*var(--s)),90vw);padding:calc(32*var(--s)) calc(36*var(--s)) calc(24*var(--s));
  color:var(--ink);border-radius:calc(3*var(--s));
  background:
    repeating-linear-gradient(91deg,rgba(140,104,54,.05) 0 calc(1*var(--s)),transparent calc(1*var(--s)) calc(3.5*var(--s))),
    repeating-linear-gradient(1deg,rgba(140,104,54,.038) 0 calc(1*var(--s)),transparent calc(1*var(--s)) calc(5*var(--s))),
    radial-gradient(120% 130% at 50% 0%,#faf0dc 0%,#f1e2c6 52%,#e6d2ae 100%);
  box-shadow:0 calc(28*var(--s)) calc(64*var(--s)) rgba(6,4,2,.66),
    inset 0 0 calc(110*var(--s)) rgba(146,110,58,.26)}
#eg-ui .book::before{content:"";position:absolute;left:0;top:0;bottom:0;width:calc(8*var(--s));
  background:linear-gradient(90deg,rgba(74,52,26,.5),rgba(74,52,26,.04));
  border-radius:calc(3*var(--s)) 0 0 calc(3*var(--s))}
#eg-ui .book::after{content:"";position:absolute;inset:calc(10*var(--s));
  border:calc(1*var(--s)) solid rgba(58,40,18,.14);pointer-events:none}
#eg-ui .book .head{display:flex;align-items:flex-end;justify-content:space-between;gap:calc(20*var(--s))}
#eg-ui .book h2{margin:0;font-size:calc(36*var(--s));font-weight:400;font-style:italic;
  letter-spacing:.005em;line-height:1}
#eg-ui .book .sub{font-family:var(--micro);font-size:calc(9.5*var(--s));font-weight:700;
  letter-spacing:.24em;text-transform:uppercase;opacity:.5;margin-top:calc(9*var(--s))}
#eg-ui .book .count{text-align:right;line-height:1}
#eg-ui .book .count b{display:block;font-family:var(--serif);font-weight:400;font-size:calc(40*var(--s))}
#eg-ui .book .count span{font-family:var(--micro);font-size:calc(9*var(--s));font-weight:700;
  letter-spacing:.24em;text-transform:uppercase;opacity:.5}
#eg-ui .book .rule{height:calc(1*var(--s));background:rgba(58,40,18,.3);margin:calc(20*var(--s)) 0}
#eg-ui .book .rule.dbl{box-shadow:0 calc(3*var(--s)) 0 rgba(58,40,18,.13)}
#eg-ui .book .rule.thin{background:rgba(58,40,18,.18);margin:calc(14*var(--s)) 0 calc(11*var(--s))}
#eg-ui .spreads{display:flex;gap:calc(24*var(--s))}
#eg-ui .spec{flex:1;min-width:0}
#eg-ui .spec .plate{height:calc(132*var(--s));display:flex;align-items:center;justify-content:center;
  color:#4a3116;border:calc(1*var(--s)) solid rgba(58,40,18,.2);border-radius:calc(2*var(--s));
  background:linear-gradient(168deg,rgba(255,250,238,.66),rgba(212,190,152,.34));
  box-shadow:inset 0 calc(2*var(--s)) calc(10*var(--s)) rgba(120,92,50,.14)}
#eg-ui .spec .plate .eg-sil{width:calc(112*var(--s));height:calc(112*var(--s))}
#eg-ui .spec.off .plate{border-style:dashed;border-color:rgba(58,40,18,.32);
  background:repeating-linear-gradient(135deg,rgba(58,40,18,.045) 0 calc(2*var(--s)),
    transparent calc(2*var(--s)) calc(9*var(--s)))}
#eg-ui .spec.off .plate .eg-sil{opacity:.085}
#eg-ui .spec .nm{font-size:calc(21*var(--s));margin-top:calc(9*var(--s));line-height:1.1}
#eg-ui .spec .no{font-family:var(--micro);font-size:calc(9*var(--s));font-weight:700;letter-spacing:.24em;
  text-transform:uppercase;opacity:.42}
#eg-ui .spec .note{font-size:calc(13.5*var(--s));line-height:1.58;opacity:.74;margin-top:calc(7*var(--s))}
#eg-ui .spec .state{display:inline-flex;align-items:center;gap:calc(7*var(--s));
  font-family:var(--micro);font-size:calc(9*var(--s));font-weight:700;letter-spacing:.2em;
  text-transform:uppercase;margin-top:calc(11*var(--s));color:#8a6a34}
#eg-ui .spec .state::before{content:"";width:calc(6*var(--s));height:calc(6*var(--s));border-radius:50%;
  background:currentColor;opacity:.85}
#eg-ui .spec.off .state{color:rgba(58,40,18,.38)}
#eg-ui .spec .state.tamed{color:#5c7a37}
#eg-ui .book .foot{display:flex;align-items:center;justify-content:space-between;
  font-family:var(--micro);font-size:calc(9.5*var(--s));font-weight:600;letter-spacing:.2em;
  text-transform:uppercase;opacity:.5}
#eg-ui .book .foot .key{background:rgba(46,30,12,.9);color:#f3e6cd;box-shadow:none}
`;

const DEFS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
<filter id="eg-rough" x="-25%" y="-25%" width="150%" height="150%">
  <feTurbulence type="fractalNoise" baseFrequency="0.05" numOctaves="2" seed="11" result="n"/>
  <feDisplacementMap in="SourceGraphic" in2="n" scale="1.7" xChannelSelector="R" yChannelSelector="G"/>
</filter></defs></svg>`;

const berryGlyph = (size) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">
<g filter="url(#eg-rough)"><path d="M12 6.6c-1.1-2.6-3.4-3.9-5.6-3.2 .2 2.2 1.9 3.9 4.1 4.2" fill="#8ea864"/>
<circle cx="9.2" cy="15" r="5.2" fill="#c5563f"/><circle cx="15.2" cy="16.2" r="4.2" fill="#a8402f"/>
<circle cx="7.6" cy="13.2" r="1.5" fill="#e28f79" opacity=".8"/></g>
<path d="M12 7.4 12 3.2" stroke="#7a5a2e" stroke-width="1.4" stroke-linecap="round" fill="none"/></svg>`;

export function createUI() {
  let ctx, root, host;
  let creatures = null, interaction = null, player = null;

  const el = {};
  const toasts = [];
  let currentPrompt = null;
  let t = 0;

  // journal
  let speciesOrder = [];
  const discovered = new Set();
  const tamed = new Set();
  let journalOpen = false, journalA = 0;
  let jcueT = 0;             // seconds left showing the "J — field journal" cue

  // hud live values
  let vigour = 1, berries = 0;
  let compassA = 0, lastYaw = 0;

  // cold open
  const open = { beat: 'wake', t: 0, dist: 0, turn: 0, promptSeen: false, a: 0, held: 0 };
  let lastPos = null, engaged = false;

  // reticle
  const ret = { a: 0, x: 0, y: 0, scale: 1, target: null, name: '', mood: '', trust: 0,
    stage: '', cost: '', need: 0, onScreen: false };
  // the dimmed marker on a creature you started taming and walked away from
  const mrk = { a: 0, target: null, name: '', stage: 0, need: 0, text: '', edge: false };
  // the bond moment, and the roster it leaves behind
  const bond = { a: 0, t: 0, name: '', line: '', eyebrow: '' };
  const party = [];                       // [{ species, name }]
  const frg = { a: 0, text: '', edge: false, on: false };
  let goalT = 0, goalDone = false;   // the one line that says what the game is about

  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const approach = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * dt));

  function setText(node, s) { if (node && node._v !== s) { node._v = s; node.textContent = s; } }

  function speciesName(id) {
    return creatures?.species?.[id]?.name ?? (id ? id[0].toUpperCase() + id.slice(1) : 'Unknown');
  }

  function buildJournal() {
    const cards = speciesOrder.map((id, i) => {
      const known = discovered.has(id);
      const note = FIELD_NOTES[id] ?? 'Keeps to the high grass. Notes to follow.';
      return `<div class="spec ${known ? 'on' : 'off'}" data-sp="${id}">
        <div class="plate">${silhouetteSVG(id, { size: 92 })}</div>
        <div class="rule thin"></div>
        <div class="no">Specimen ${String(i + 1).padStart(2, '0')}</div>
        <div class="nm">${known ? speciesName(id) : '&mdash;'}</div>
        <div class="note">${known ? note : 'Unrecorded. Get close enough to see it properly.'}</div>
        <div class="state ${tamed.has(id) ? 'tamed' : ''}">${
  tamed.has(id) ? 'Travels with you' : known ? 'Observed in the wild' : 'No sighting'}</div>
      </div>`;
    }).join('');
    el.book.innerHTML = `
      <div class="head">
        <div><h2>Field Journal</h2><div class="sub">Vale of Emberglen</div></div>
        <div class="count"><b>${discovered.size}<span
          style="font-size:calc(20*var(--s));opacity:.45">/${speciesOrder.length}</span></b>
          <span>Species recorded</span></div>
      </div>
      <div class="rule dbl"></div>
      <div class="spreads">${cards}</div>
      <div class="rule"></div>
      <div class="foot"><span>Kept by hand, in the field</span>
        <span style="display:flex;align-items:center;gap:calc(9*var(--s))"><span class="key">J</span>Close</span></div>`;
  }

  function journalText() {
    const out = ['Field Journal', `Vale of Emberglen · ${discovered.size} of ${speciesOrder.length} recorded`];
    speciesOrder.forEach((id, i) => {
      const known = discovered.has(id);
      out.push(`Specimen ${String(i + 1).padStart(2, '0')} — ${known ? speciesName(id) : 'unrecorded'}`);
      if (known) out.push(FIELD_NOTES[id] ?? '');
    });
    return out.filter(Boolean);
  }

  function discover(id) {
    if (!id || discovered.has(id)) return;
    discovered.add(id);
    api.notify(speciesName(id), { kind: 'discovery', species: id, ttl: 5.2 });
    jcueT = 8;
    refreshTally();
    if (journalOpen) buildJournal();
    ctx?.bus.emit('journal:record', { species: id, count: discovered.size });
  }

  function refreshTally() {
    if (!el.pips) return;
    [...el.pips.children].forEach((p, i) => p.classList.toggle('on', discovered.has(speciesOrder[i])));
  }

  const api = {
    name: 'ui',
    order: ORDER.UI,
    get discovered() { return [...discovered]; },
    get journalOpen() { return journalOpen; },

    init(c) {
      ctx = c;
      creatures = c.get('creatures');
      interaction = c.get('interaction');
      player = c.get('player');
      speciesOrder = Object.keys(creatures?.species ?? {});
      berries = interaction?.inventory?.berry ?? 0;

      root = document.getElementById('ui-root');
      root.innerHTML = `${DEFS}<div id="eg-ui"><style>${CSS}</style>
        <div class="compass" style="opacity:0"><div class="tape"></div><div class="needle"></div></div>

        <div class="ret" style="opacity:0">
          <svg class="ring" width="48" height="48" viewBox="-24 -24 48 48">
            <circle r="16" fill="none" stroke="rgba(10,7,3,.62)" stroke-width="5"/>
            <circle r="16" fill="none" stroke="rgba(248,238,216,.92)" stroke-width="1.5"/>
            <circle class="arc" r="16" fill="none" stroke="#f0a94e" stroke-width="3.4"
              stroke-linecap="round" transform="rotate(-90)" stroke-dasharray="0 200"/>
            <g stroke="rgba(248,238,216,.9)" stroke-width="1.4" stroke-linecap="round">
              <path d="M0,-21.5 v3.4"/><path d="M0,21.5 v-3.4"/>
              <path d="M-21.5,0 h3.4"/><path d="M21.5,0 h-3.4"/>
            </g>
            <circle r="1.5" fill="rgba(248,238,216,.95)"/>
          </svg>
          <div class="lead"></div>
          <div class="card sh"><div class="nm"></div>
            <div class="md"><span class="stg"></span><span class="tal"
              ><i></i><i></i><i></i><i></i></span><span class="cost"></span></div>
            <div class="act"><span class="key"></span><span class="vb"></span></div></div>
        </div>

        <div class="mark" style="opacity:0"><span class="tal"
          ><i></i><i></i><i></i><i></i></span><span class="lbl"></span></div>

        <div class="forage" style="opacity:0">${berryGlyph(16)}<span class="lbl"></span></div>

        <div class="bond" style="opacity:0"><span class="sil"></span><span class="rule"></span>
          <span class="body"><span class="eyebrow"></span>
            <div class="nm"></div><div class="ln"></div></span></div>

        <div class="chev" style="opacity:0"><svg width="30" height="30" viewBox="-15 -15 30 30">
          <g filter="url(#eg-rough)"><path d="M-7,-5 L0,3 L7,-5" fill="none" stroke="rgba(12,8,4,.7)" stroke-width="5"
            stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M-7,-5 L0,3 L7,-5" fill="none" stroke="#f6ead2" stroke-width="2.2"
            stroke-linecap="round" stroke-linejoin="round"/></g></svg></div>

        <div class="teach" style="opacity:0">
          <div class="row"><span class="key">W</span></div>
          <div class="row"><span class="key">A</span><span class="key">S</span><span class="key">D</span></div>
        </div>
        <div class="whisper sh" style="opacity:0"></div>

        <div class="kit sh">
          <div class="tally"><span class="micro">Recorded</span><span class="pips"></span></div>
          <div class="vig"><i class="bed"></i><i class="fill"></i></div>
          <div class="party" style="display:none"></div>
        </div>

        <div class="toasts sh"></div>

        <div class="satchel sh">${berryGlyph(23)}<span class="x">&times;</span><span class="n">0</span></div>

        <div class="jcue sh" style="opacity:0"><span class="lbl">Field journal</span><span class="key">J</span></div>

        <div class="scrim" style="opacity:0;display:none"></div>
        <div class="book" style="opacity:0;display:none"></div>
      </div>`;

      host = root.querySelector('#eg-ui');
      el.compass = host.querySelector('.compass');
      el.tape = host.querySelector('.compass .tape');
      el.ret = host.querySelector('.ret');
      el.arc = host.querySelector('.ret .arc');
      el.retName = host.querySelector('.ret .nm');
      el.retMood = host.querySelector('.ret .md');
      el.retStage = host.querySelector('.ret .md .stg');
      el.retTally = [...host.querySelectorAll('.ret .md .tal i')];
      el.retCost = host.querySelector('.ret .md .cost');
      el.retKey = host.querySelector('.ret .key');
      el.retVerb = host.querySelector('.ret .vb');
      el.mark = host.querySelector('.mark');
      el.markTally = [...host.querySelectorAll('.mark .tal i')];
      el.markLbl = host.querySelector('.mark .lbl');
      el.forage = host.querySelector('.forage');
      el.forageLbl = host.querySelector('.forage .lbl');
      el.bond = host.querySelector('.bond');
      el.bondSil = host.querySelector('.bond .sil');
      el.bondEye = host.querySelector('.bond .eyebrow');
      el.bondName = host.querySelector('.bond .nm');
      el.bondLine = host.querySelector('.bond .ln');
      el.party = host.querySelector('.kit .party');
      el.chev = host.querySelector('.chev');
      el.teach = host.querySelector('.teach');
      el.whisper = host.querySelector('.whisper');
      el.kit = host.querySelector('.kit');
      el.satchel = host.querySelector('.satchel');
      el.pips = host.querySelector('.pips');
      el.vig = host.querySelector('.vig .fill');
      el.toasts = host.querySelector('.toasts');
      el.berries = host.querySelector('.satchel .n');
      el.jcue = host.querySelector('.jcue');
      el.scrim = host.querySelector('.scrim');
      el.book = host.querySelector('.book');

      // compass tape: 16 minor ticks + 4 cardinals across 360deg, 2px per degree
      const PPD = 1.0;
      let tape = '';
      for (let d = -180; d <= 540; d += 15) {
        const x = (d + 180) * PPD;
        const card = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[((d % 360) + 360) % 360];
        tape += card
          ? `<span class="c" style="left:calc(${x}*var(--s))">${card}</span>`
          : `<span class="m" style="left:calc(${x}*var(--s))"></span>`;
      }
      el.tape.innerHTML = tape;
      el.tape.style.width = `calc(720*var(--s))`;

      el.pips.innerHTML = speciesOrder.map(() => '<span class="pip"></span>').join('');
      setText(el.berries, String(berries));
      buildJournal();

      c.bus.on('creature:fed', ({ creature }) => {
        discover(creature.species);
        api.notify(`${creature.def.name} takes the berry.`, { ttl: 3.2 });
      });
      /**
       * THE PAYOFF. A creature became a companion — the emotional peak of the whole slice —
       * and in a measured session it was represented by one 5.5-second toast that a repeated
       * berry warning shoved off the stack. Nothing on screen said "follow", "companion" or
       * the creature's name at the moment it happened.
       *
       * So it gets three things instead: a nine-second banner in the middle of the frame
       * with the name at title size, a permanent line in the field kit naming who travels
       * with you, and the journal entry flipping to "Travels with you". The audio layer
       * already answers `creature:tamed` with a chord; this is what you see while it plays.
       */
      c.bus.on('creature:tamed', ({ creature }) => {
        tamed.add(creature.species);
        discover(creature.species);
        if (journalOpen) buildJournal();
        const nm = creature.def?.name ?? speciesName(creature.species);
        bond.name = nm;
        bond.eyebrow = party.length ? 'Another companion' : 'You have a companion';
        bond.line = `${nm} will follow you now`;
        bond.t = 9;
        el.bondSil.innerHTML = silhouetteSVG(creature.species, { size: 52 });
        setText(el.bondEye, bond.eyebrow);
        setText(el.bondName, nm);
        setText(el.bondLine, bond.line);
      });
      c.bus.on('companion:joined', ({ creature }) => {
        const nm = creature.def?.name ?? speciesName(creature.species);
        if (party.some((p) => p.name === nm)) return;
        party.push({ species: creature.species, name: nm });
        el.party.style.display = '';
        el.party.innerHTML = `<span class="lbl">Travels with you</span>`
          + party.slice(0, 3).map((p) => `<span class="who">${silhouetteSVG(p.species, { size: 16 })}`
            + `<span class="nm">${p.name}</span></span>`).join('');
      });
      c.bus.on('interact:focus', ({ target, kind }) => {
        if (target) discover(target.species);
        // The single sentence that says what the game is about, fired at the only moment
        // it is useful: the first time a wild creature is actually on screen and reachable.
        if (kind === 'creature' && !goalDone) { goalDone = true; goalT = 7.5; }
      });
      c.bus.on('inventory:change', (inv) => { if (inv && typeof inv.berry === 'number') berries = inv.berry; });
      const gathered = (p) => {
        const name = p?.name ?? p?.item ?? 'Berry';
        api.notify(`${name}${p?.amount > 1 ? ` ×${p.amount}` : ''} gathered.`, { ttl: 2.8 });
      };
      c.bus.on('item:gathered', gathered);
      c.bus.on('resource:gathered', gathered);
    },

    update(dt, c) {
      t += dt;
      const p = c.get('interaction')?.prompt ?? null;
      this.showPrompt(p);

      if (c.input.justPressed('journal')) this.setJournalOpen(!journalOpen);

      updateVitals(dt, c);
      updateReticle(dt, c);
      updateMarker(dt, c);
      updateForage(dt, c);
      updateBond(dt);
      scanDiscoveries(c);
      updateColdOpen(dt, c);
      updateToasts(dt);
      updateCompass(dt, c);

      journalA = approach(journalA, journalOpen ? 1 : 0, 14, dt);
      // the book takes the frame; the kit steps out of its way
      const hud = (1 - journalA).toFixed(3);
      el.kit.style.opacity = hud;
      el.satchel.style.opacity = hud;
      el.toasts.style.opacity = hud;
      const jv = journalA > 0.004;
      el.scrim.style.display = jv ? 'block' : 'none';
      el.book.style.display = jv ? 'block' : 'none';
      if (jv) {
        el.scrim.style.opacity = journalA.toFixed(3);
        el.book.style.opacity = journalA.toFixed(3);
        el.book.style.transform =
          `translate(-50%,-50%) scale(${(0.975 + 0.025 * journalA).toFixed(4)})`;
      }

      jcueT = Math.max(0, jcueT - dt);
      el.jcue.style.opacity = (journalOpen ? 0 : clamp01(jcueT) * 0.95).toFixed(3);
    },

    showPrompt(p) {
      currentPrompt = p;
      if (!el.retKey) return;
      if (p) {
        // A keycap is a promise that pressing it helps. When it would not, we do not
        // print one — the line still says what the creature needs.
        el.retKey.style.display = p.key ? '' : 'none';
        setText(el.retKey, p.key ?? '');
        // The name is already the headline of the card; a verb that repeats it reads
        // like a database row. "Toss a berry to Emberfox" -> "Toss a berry".
        let verb = p.text ?? '';
        if (ret.name) {
          const n = ret.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          verb = verb.replace(new RegExp(`\\s+(?:to|toward|towards|at|from|the)\\s+${n}\\b\\.?$`, 'i'), '')
            .replace(new RegExp(`\\s+${n}\\b\\.?$`, 'i'), '');
        }
        setText(el.retVerb, verb);
      }
    },

    /**
     * kind: 'note' (default, one serif line) | 'discovery' (eyebrow + name + ink cutout)
     *
     * Two rules learned from a measured session that printed the same warning four times
     * in one beat: a line already on screen is REFRESHED, never stacked, and when the
     * stack overflows the thing thrown away is the most ordinary note in it — never the
     * discovery or the bond, which are the two things worth reading.
     */
    notify(text, opts = {}) {
      if (!el.toasts) return null;
      const { ttl = 3.5, kind = 'note', species = null, eyebrow = 'New species recorded' } = opts;
      const live = toasts.find((x) => x.text === text && x.t > 0.05);
      if (live) { live.t = Math.max(live.t, ttl); return live; }
      const node = document.createElement('div');
      node.className = 'toast';
      node.dataset.kind = kind;
      node.innerHTML = kind === 'discovery'
        ? `<div class="body"><div class="eyebrow">${eyebrow}</div><div class="t">${text}</div></div>
           <div class="rule"></div>${silhouetteSVG(species ?? 'unknown', { size: 40 })}`
        : `<div class="body"><div class="t">${text}</div></div>`;
      node.style.opacity = '0';
      el.toasts.appendChild(node);
      const rec = {
        el: node, t: ttl, ttl, age: 0, text, kind, pin: kind === 'discovery',
        // What a discovery toast READS as is the eyebrow above the name, not the bare name.
        // Reporting just the name made it collide with the reticle headline and look like
        // the same line printed twice.
        read: kind === 'discovery' ? `${eyebrow}: ${text}` : text,
      };
      toasts.push(rec);
      while (toasts.length > 3) {
        let i = toasts.findIndex((x) => !x.pin);
        if (i < 0 || i === toasts.length - 1) i = 0;
        toasts.splice(i, 1)[0].el.remove();
      }
      return rec;
    },

    setJournalOpen(v) {
      const next = !!v;
      if (next === journalOpen) return;
      journalOpen = next;
      if (journalOpen) { buildJournal(); jcueT = 0; }
      ctx?.bus.emit('ui:journal', { open: journalOpen });
    },

    snapshot() {
      const visible = [];
      if (open.a > 0.3) visible.push('W', 'A S D');
      if (el.whisper && Number(el.whisper.style.opacity) > 0.3 && el.whisper.textContent) {
        visible.push(el.whisper.textContent);
      }
      if (ret.a > 0.35 && currentPrompt) {
        visible.push(ret.name);
        if (ret.stage) {
          const pips = ret.target && !ret.target.kind
            ? ` ${'●'.repeat(ret.need >= 0 ? 4 - ret.need : 4)}${'○'.repeat(Math.max(0, ret.need))}`
            : '';
          visible.push(`${ret.stage.toUpperCase()}${pips}${ret.cost ? ` · ${ret.cost}` : ''}`);
        }
        visible.push(currentPrompt.key
          ? `[${currentPrompt.key}] ${currentPrompt.text}` : currentPrompt.text);
      }
      if (mrk.a > 0.12 && mrk.target) {
        visible.push(`${'●'.repeat(mrk.stage)}${'○'.repeat(Math.max(0, 4 - mrk.stage))} ${mrk.text}`);
      }
      if (frg.a > 0.15 && frg.on) visible.push(frg.text);
      if (bond.a > 0.2) visible.push(bond.eyebrow, bond.line);
      if (journalA < 0.5) for (const t2 of toasts) if (t2.el.style.opacity > 0.3) visible.push(t2.read ?? t2.text);
      if (party.length && journalA < 0.5) {
        visible.push(`Travels with you: ${party.map((p) => p.name).join(', ')}`);
      }
      visible.push(`Recorded ${discovered.size} of ${speciesOrder.length}`);
      if (jcueT > 0 && !journalOpen) visible.push('Field journal [J]');
      if (journalA > 0.5) visible.push(...journalText());
      return {
        visibleText: visible,
        prompt: currentPrompt?.text ?? null,
        promptKey: currentPrompt?.key ?? null,
        focus: ret.target ? { species: ret.target.species, name: ret.name, trust: +ret.trust.toFixed(2) } : null,
        journalOpen,
        discovered: [...discovered],
        tamedSpecies: [...tamed],
        toasts: toasts.map((x) => x.text),
        onboarding: open.beat,
        vigour: +vigour.toFixed(2),
        berries,
        party: party.map((p) => p.name),
        bond: bond.a > 0.2 ? { name: bond.name, line: bond.line } : null,
      };
    },
  };

  // ------------------------------------------------------------------ vitals
  function updateVitals(dt, c) {
    const st = player?.state;
    const external = typeof player?.stamina === 'number' ? player.stamina : null;
    if (external !== null) vigour = clamp01(external);
    else vigour = clamp01(vigour + (st === 'run' ? -0.3 : 0.26) * dt);
    el.vig.style.width = `${(vigour * 100).toFixed(1)}%`;
    el.vig.style.opacity = (0.55 + 0.45 * (1 - vigour)).toFixed(3);

    const inv = c.get('interaction')?.inventory;
    if (inv && typeof inv.berry === 'number') berries = inv.berry;
    setText(el.berries, String(berries));
  }

  // ------------------------------------------------------------------ reticle
  const _v = { x: 0, y: 0, z: 0 };
  let _pv = null;
  function project(c, pos, lift) {
    if (!_pv) _pv = new c.THREE.Vector3();
    const v = _pv.set(pos.x, pos.y + lift, pos.z);
    v.project(c.camera);
    const w = c.renderer.domElement.clientWidth || window.innerWidth;
    const h = c.renderer.domElement.clientHeight || window.innerHeight;
    _v.x = (v.x * 0.5 + 0.5) * w;
    _v.y = (-v.y * 0.5 + 0.5) * h;
    _v.z = v.z;
    return _v;
  }

  /** paint N of 4 strokes; the 4th only lights when the creature is actually a companion */
  function paintTally(list, stage) {
    for (let i = 0; i < list.length; i++) {
      const on = i < stage;
      list[i].className = on ? (stage >= 4 ? 'done' : 'on') : '';
    }
  }

  function updateReticle(dt, c) {
    const inter = c.get('interaction');
    const focus = inter?.focus ?? null;
    ret.target = focus;

    if (focus) {
      // Chest height, not over the head: the interaction layer flies its own trust
      // gauge above the skull and two rings stacked on one creature reads as a bug.
      const size = focus.def?.size ?? 1;
      const s = project(c, focus.position, size * 0.55 + 0.1);
      const w0 = c.renderer.domElement.clientWidth || window.innerWidth;
      const h0 = c.renderer.domElement.clientHeight || window.innerHeight;
      // A card anchored to something behind the camera is drawn at a stale position
      // off the edge of the frame: the snapshot claims the player was told something
      // they could not possibly see. Off-frame means hidden here and handed to the
      // edge-clamped marker instead.
      ret.onScreen = s.z < 1 && s.x > -40 && s.x < w0 + 40 && s.y > -40 && s.y < h0 + 40;
      if (s.z < 1) {
        ret.x = s.x; ret.y = s.y;
        const d = focus.position.distanceTo(player.position);
        ret.scale = Math.max(0.72, Math.min(1.18, 1.5 - d * 0.09));
      }
      if (focus.kind) {
        // a gatherable, not a creature — it has no arc, so it gets a state word and no tally
        const [nm, word] = RESOURCE_WORDS[focus.kind] ?? ['Growth', 'ready'];
        ret.name = nm;
        ret.stage = focus.ready ? word : 'picked clean';
        ret.cost = '';
        ret.need = 0;
        ret.trust = 0;
        paintTally(el.retTally, 0);
        el.retTally.forEach((n) => { n.style.display = 'none'; });
      } else {
        const r = inter?.readout?.(focus) ?? null;
        const stage = focus.tamed ? 4 : (r?.stage ?? 0);
        ret.name = focus.def?.name ?? speciesName(focus.species);
        ret.stage = STAGE_WORDS[r?.name ?? 'wild'] ?? (r?.name ?? '');
        ret.need = r?.need ?? 0;
        // The cost, in the slot where the mood word used to live. This is the whole fix.
        ret.cost = stage >= 4 ? 'travels with you'
          : ret.need <= 1 ? '1 berry to go'
            : `${ret.need} berries to go`;
        ret.trust = focus.trust ?? r?.trust ?? 0;
        el.retTally.forEach((n) => { n.style.display = ''; });
        paintTally(el.retTally, stage);
      }
      el.retMood.classList.toggle('last', !focus.kind && ret.need === 1);
      setText(el.retName, ret.name);
      setText(el.retStage, ret.stage);
      setText(el.retCost, ret.cost);
      ret.mood = ret.cost ? `${ret.stage} · ${ret.cost}` : ret.stage;
      const C = 2 * Math.PI * 16;
      el.arc.setAttribute('stroke-dasharray', `${(C * clamp01(ret.trust)).toFixed(1)} ${C.toFixed(1)}`);
    } else {
      ret.onScreen = false;
    }

    const want = focus && currentPrompt && ret.onScreen && !journalOpen ? 1 : 0;
    ret.a = approach(ret.a, want, 11, dt);

    if (ret.a < 0.004) { el.ret.style.opacity = '0'; return; }
    const breathe = 1 + Math.sin(t * 1.9) * 0.018;
    const w = c.renderer.domElement.clientWidth || window.innerWidth;
    el.ret.classList.toggle('flip', ret.x > w * 0.6);
    el.ret.style.opacity = ret.a.toFixed(3);
    el.ret.style.transform =
      `translate3d(${ret.x.toFixed(1)}px,${ret.y.toFixed(1)}px,0) scale(${(ret.scale * breathe * (0.86 + 0.14 * ret.a)).toFixed(4)})`;
  }

  // ------------------------------------------------------------- world marker
  /**
   * The reticle only lives inside prompt range. Without this, a creature you got to
   * "one more berry" vanishes off the HUD the moment it wanders 13m away, and the player
   * walks off never knowing they were one button from a companion. So the label survives
   * the cutoff: dimmer, smaller, no keycap, clamped to the frame edge if it goes
   * off-screen — a place to walk back to rather than a thing to press.
   */
  function updateMarker(dt, c) {
    const inter = c.get('interaction');
    // If the creature you are actually engaged with has gone behind you, the reticle
    // hides — so the marker picks it up and pins it to the edge of the frame. There is
    // never a moment where an in-progress creature is untracked.
    const offScreenFocus = ret.target && !ret.target.kind && !ret.onScreen ? ret.target : null;
    const cr = offScreenFocus ?? inter?.marked ?? null;
    const show = cr && !journalOpen && (cr !== ret.target || !ret.onScreen);
    mrk.target = show ? cr : null;

    if (show) {
      const r = inter?.readout?.(cr) ?? null;
      mrk.stage = r?.stage ?? 1;
      mrk.need = r?.need ?? 3;
      mrk.name = cr.def?.name ?? speciesName(cr.species);
      const txt = `${mrk.name} · ${mrk.need <= 1 ? '1 berry' : `${mrk.need} berries`}`;
      setText(el.markLbl, txt);
      mrk.text = txt;
      paintTally(el.markTally, mrk.stage);

      const s = project(c, cr.position, (cr.def?.size ?? 1) * 1.55 + 0.5);
      const w = c.renderer.domElement.clientWidth || window.innerWidth;
      const h = c.renderer.domElement.clientHeight || window.innerHeight;
      const behind = s.z > 1;
      let x = behind ? (s.x > w / 2 ? 0 : w) : s.x;
      let y = behind ? h * 0.52 : s.y;
      mrk.edge = behind || x < 96 || x > w - 96 || y < 44 || y > h - 120;
      x = Math.max(96, Math.min(w - 96, x));
      y = Math.max(44, Math.min(h - 120, y));
      el.mark.style.transform =
        `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) translate(-50%,-50%)`;
    }
    // never louder than the thing you are actually looking at
    const wantA = show ? (mrk.edge ? 0.34 : 0.5) * (1 - ret.a * 0.45) : 0;
    mrk.a = approach(mrk.a, wantA, 6, dt);
    el.mark.style.opacity = mrk.a.toFixed(3);
  }

  // --------------------------------------------------------------- restock tag
  /**
   * Berries are the taming currency. The prompt already says how far a bush is and in
   * which compass direction, but a bearing in words is a puzzle and an arrow is not — so
   * when, and only when, the satchel is actually empty, the nearest ripe bush wears a
   * quiet tag, edge-clamped if it is behind you. It disappears the instant you have one
   * berry, which is what keeps it from being HUD clutter.
   */
  function updateForage(dt, c) {
    const inter = c.get('interaction');
    const f = berries <= 0 && !journalOpen ? inter?.forage ?? null : null;
    frg.on = !!f;
    if (f) {
      const s = project(c, f.position, 1.35);
      const w = c.renderer.domElement.clientWidth || window.innerWidth;
      const h = c.renderer.domElement.clientHeight || window.innerHeight;
      const behind = s.z > 1;
      let x = behind ? (s.x > w / 2 ? 0 : w) : s.x;
      let y = behind ? h * 0.5 : s.y;
      frg.edge = behind || x < 110 || x > w - 110 || y < 44 || y > h - 130;
      x = Math.max(110, Math.min(w - 110, x));
      y = Math.max(44, Math.min(h - 130, y));
      frg.text = `Berries · ${Math.round(f.dist)}m`;
      setText(el.forageLbl, frg.text);
      el.forage.style.transform =
        `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) translate(-50%,-50%)`;
    }
    frg.a = approach(frg.a, f ? (frg.edge ? 0.45 : 0.62) : 0, 5, dt);
    el.forage.style.opacity = frg.a.toFixed(3);
  }

  // ---------------------------------------------------------------- bond moment
  function updateBond(dt) {
    bond.t = Math.max(0, bond.t - dt);
    const want = bond.t > 0 && !journalOpen ? 1 : 0;
    bond.a = approach(bond.a, want, want ? 8 : 3.2, dt);
    if (bond.a < 0.004) { el.bond.style.opacity = '0'; return; }
    // a slow breath, so the card feels alive for the seconds it owns the frame
    const pulse = 1 + Math.sin(t * 2.1) * 0.007;
    el.bond.style.opacity = bond.a.toFixed(3);
    el.bond.style.transform = `translateX(-50%) translateY(${((1 - bond.a) * 16).toFixed(1)}px)`
      + ` scale(${((0.962 + 0.038 * bond.a) * pulse).toFixed(4)})`;
  }

  // ------------------------------------------------------------- journal pacing
  /**
   * A specimen used to be recorded only once the interaction layer made it the focus,
   * which needs it inside 12.5m AND already aware of you — so five minutes of play
   * recorded two species of four and the journal read "2 of 4" from start to finish.
   * A naturalist records what they can SEE. Thirty metres and in frame is seeing it.
   */
  function scanDiscoveries(c) {
    const list = creatures?.list;
    if (!list || !player || journalOpen) return;
    const w = c.renderer.domElement.clientWidth || window.innerWidth;
    const h = c.renderer.domElement.clientHeight || window.innerHeight;
    for (const cr of list) {
      if (!cr?.position || discovered.has(cr.species)) continue;
      if (cr.position.distanceTo(player.position) > 32) continue;
      const s = project(c, cr.position, (cr.def?.size ?? 1) * 0.6);
      if (s.z < 1 && s.x > 8 && s.x < w - 8 && s.y > 8 && s.y < h - 8) { discover(cr.species); return; }
    }
  }

  // ------------------------------------------------------------------ compass
  function updateCompass(dt, c) {
    const yaw = player?.yaw ?? 0;
    let d = yaw - lastYaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    lastYaw = yaw;
    const turning = Math.abs(d) / Math.max(dt, 1e-4) > 0.25;
    compassA = approach(compassA, journalOpen ? 0 : (turning ? 1 : 0), turning ? 12 : 1.9, dt);
    el.compass.style.opacity = (compassA * 0.9).toFixed(3);
    if (compassA < 0.004) return;
    // heading in degrees, 0 = -Z (north)
    const deg = ((-yaw * 180) / Math.PI + 360) % 360;
    el.tape.style.transform = `translateX(calc(${(160 - deg).toFixed(2)}*var(--s)))`;
  }

  // ------------------------------------------------------------------ cold open
  /**
   * Four beats, taught by placement and timing rather than prose:
   *   wake  — nothing at all. The world gets the first seconds to itself.
   *   move  — WASD keycaps, low centre, no sentence. Retires the moment you walk 4m.
   *   look  — two words, once. Retires after you have turned ~115 degrees.
   *   seek  — an ink caret over the nearest creature. No words; the reticle takes over.
   *
   * Nothing is taught until the player has actually taken the controls: in a browser
   * you must click for pointer lock before W does anything, so a keycap shown before
   * that is a lie. That also means a scripted capture with no input stays clean.
   */
  function updateColdOpen(dt, c) {
    open.t += dt;
    const inp = c.input;
    if (!engaged) {
      engaged = inp.pointerLocked || inp.down('forward') || inp.down('back') || inp.down('left')
        || inp.down('right') || inp.down('jump') || Math.abs(inp.look.dx) > 0.5;
      if (engaged) open.t = 0;
    }
    const pos = player?.position;
    if (pos) {
      if (!lastPos) lastPos = { x: pos.x, z: pos.z };
      open.dist += Math.hypot(pos.x - lastPos.x, pos.z - lastPos.z);
      lastPos.x = pos.x; lastPos.z = pos.z;
    }
    let d = (player?.yaw ?? 0) - (open._yaw ?? player?.yaw ?? 0);
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    open.turn += Math.abs(d);
    open._yaw = player?.yaw ?? 0;

    if (open.beat === 'wake') {
      if (!engaged) { /* the world alone */ }
      else if (open.dist > 1.2) { open.beat = 'look'; open.turn = 0; }
      else if (open.t > 2.6) open.beat = 'move';
    } else if (open.beat === 'move') {
      open.held += dt;
      // a hint nobody answers for 14s is nagging, not teaching — retire it
      if (open.dist > 4 || open.held > 14) { open.beat = 'look'; open.turn = 0; open.held = 0; }
    } else if (open.beat === 'look') {
      open.held += dt;
      if (open.turn > 2.0 || open.dist > 14 || open.held > 12) { open.beat = 'seek'; open.held = 0; }
    } else if (open.beat === 'seek') {
      if (currentPrompt) { open.beat = 'done'; open.promptSeen = true; }
    }

    // move beat: keycaps, no sentence
    const showKeys = open.beat === 'move' && !journalOpen;
    open.a = approach(open.a, showKeys ? 1 : 0, 8, dt);
    el.teach.style.opacity = open.a.toFixed(3);
    el.teach.style.transform =
      `translateX(-50%) translateY(${((1 - open.a) * 10).toFixed(1)}px)`;

    // Three lines exist in the whole opening. One is a browser fact, one is a nudge, and
    // one — six words, shown once, the first time a creature is in front of you — is the
    // entire premise of the game. Before this the player was never told what to want.
    goalT = Math.max(0, goalT - dt);
    if (!goalDone && open.beat === 'seek' && open.held > 9) { goalDone = true; goalT = 7.5; }
    let line = '';
    if (journalOpen) line = '';
    else if (!engaged && !c.game.captureMode && open.t > 3.2) line = 'Click to look around';
    else if (goalT > 0) line = 'Berries make friends here';
    else if (open.beat === 'look' && engaged) line = 'Look around';
    if (line && el.whisper.textContent !== line) el.whisper.textContent = line;
    const wa = approach(Number(el.whisper.style.opacity) || 0, line ? 0.82 : 0, 6, dt);
    el.whisper.style.opacity = wa.toFixed(3);
    if (wa < 0.01 && !line) el.whisper.textContent = '';

    // seek beat: an ink caret over the nearest creature — placement, not prose
    let chevA = 0;
    if (open.beat === 'seek' && !journalOpen && creatures) {
      const near = creatures.nearest(player.position, 70, (cr) => !cr.tamed);
      if (near) {
        const s = project(c, near.position, (near.def?.size ?? 1) * 1.9 + 0.6);
        const w = c.renderer.domElement.clientWidth || window.innerWidth;
        const h = c.renderer.domElement.clientHeight || window.innerHeight;
        const behind = s.z > 1;
        let x = s.x, y = s.y, rot = 0;
        const off = behind || x < 48 || x > w - 48 || y < 56 || y > h - 96;
        if (off) {
          // clamp to the frame edge and turn the caret so it points off-screen
          const side = behind ? (s.x > w / 2 ? -1 : 1) : (x > w / 2 ? 1 : -1);
          x = side > 0 ? w - 48 : 48;
          y = Math.max(70, Math.min(h - 110, behind ? h * 0.58 : y));
          rot = side > 0 ? -90 : 90;
        }
        el.chev.style.transform =
          `translate3d(${x.toFixed(1)}px,${(y + Math.sin(t * 2.4) * 3).toFixed(1)}px,0)`
          + ` translate(-50%,-50%) rotate(${rot}deg)`;
        chevA = 0.9;
      }
    }
    const ca = approach(Number(el.chev.style.opacity) || 0, chevA, 7, dt);
    el.chev.style.opacity = ca.toFixed(3);
  }

  // ------------------------------------------------------------------ toasts
  function updateToasts(dt) {
    for (let i = toasts.length - 1; i >= 0; i--) {
      const x = toasts[i];
      x.age += dt;
      x.t -= dt;
      const inA = clamp01(x.age / 0.26);
      const outA = clamp01(x.t / 0.55);
      const a = Math.min(inA, outA);
      const ease = 1 - (1 - inA) * (1 - inA);
      x.el.style.opacity = a.toFixed(3);
      x.el.style.transform = `translateX(${((1 - ease) * 22).toFixed(1)}px)`;
      if (x.t <= 0) { x.el.remove(); toasts.splice(i, 1); }
    }
  }

  return api;
}
