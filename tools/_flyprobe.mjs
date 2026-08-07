#!/usr/bin/env node
/**
 * THROWAWAY. Does creative-mode flight do what the spec says, in numbers?
 *
 *   node tools/_flyprobe.mjs
 *
 * Flight is a numeric system — a ceiling that eases, a descent rate, a floor clamp — and
 * none of that can be checked by looking at a screenshot. Every claim below is asserted
 * against the player snapshot and printed PASS/FAIL; three stills go to
 * captures/wip-fly/ for the pose and the plume, which are the parts that DO need eyes.
 *
 * The double-tap is the one thing most likely to fail silently: if the window and the
 * fixed step disagree the taps land in the same frame or two frames apart, no take-off
 * happens, and every later assertion would then be measuring a walking character. So it
 * is asserted first and the run gives up if it fails.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const OUT = path.resolve('captures', 'wip-fly');
await mkdir(OUT, { recursive: true });

const server = await createServer({
  server: { port: 0, host: '127.0.0.1', strictPort: false, hmr: false, watch: null },
  logLevel: 'error',
});
await server.listen();
const port = server.config.server.port ?? server.httpServer.address().port;
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message.slice(0, 300)));
await page.goto(`http://127.0.0.1:${port}/?capture=1&seed=20240719`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); };

/** shared helpers injected into the page */
const SETUP = () => {
  window.__fly = {
    reset(alt = 0) {
      const g = window.__game;
      for (const a of ['forward', 'back', 'left', 'right', 'sprint', 'jump', 'crouch']) g.hold(a, false);
      const s = g.state();
      g.place(s.player.pos[0], s.player.pos[2], 0);
      g.run(0.4);
    },
    takeOff() {
      const g = window.__game;
      g.tap('jump'); g.run(0.12); g.tap('jump'); g.run(0.06);
      return g.state().player.flying === true;
    },
  };
  return true;
};
await page.evaluate(SETUP);

// ---- 1. take-off on a double tap -------------------------------------------
const t1 = await page.evaluate(() => {
  window.__fly.reset();
  const ok = window.__fly.takeOff();
  const s = window.__game.state().player;
  const st = window.__game.state();
  return {
    ok, state: s.state, alt: s.altitude, stamina: st.vitals?.stamina,
    toasts: st.ui?.toasts ?? [],
  };
});
check('double-tap takes off', t1.ok, `flying=${t1.ok} state=${t1.state} alt=${t1.alt}`);
check('first take-off teaches the controls', t1.toasts.some((t) => /SPACE/i.test(t)),
  `toasts ${JSON.stringify(t1.toasts)}`);
check('state stays jump/fall while flying', t1.state === 'fall' || t1.state === 'jump',
  `state=${t1.state} (src/audio infers grounded from exactly these two)`);
if (!t1.ok) { console.log('take-off failed; the rest would measure a walking character'); await browser.close(); await server.close(); process.exit(1); }

// ---- 2. climb rate and the eased ceiling -----------------------------------
const t2 = await page.evaluate(() => {
  const g = window.__game;
  window.__fly.reset(); window.__fly.takeOff();
  const a0 = g.state().player.altitude;
  g.hold('jump', true); g.run(2.0);
  const a2 = g.state().player.altitude;
  g.run(40);                                     // long enough to sit on the ceiling
  const aTop = g.state().player.altitude;
  g.run(6);
  const aTop2 = g.state().player.altitude;
  g.hold('jump', false); g.run(1.2);
  const aRest = g.state().player.altitude;
  return { rate: (a2 - a0) / 2.0, aTop, drift: aTop2 - aTop, hold: aRest - aTop2 };
});
check('climb ~5 m/s', Math.abs(t2.rate - 5.0) < 0.35, `measured ${t2.rate.toFixed(2)} m/s`);
check('ceiling holds at 90 m', t2.aTop > 86 && t2.aTop <= 90.5, `settled at ${t2.aTop.toFixed(2)} m`);
check('ceiling is stable', Math.abs(t2.drift) < 0.05, `drift ${t2.drift.toFixed(4)} m over 6 s`);
check('release stops the climb', Math.abs(t2.hold) < 0.02, `moved ${t2.hold.toFixed(4)} m in 1.2 s`);

// ---- 3. level speed, boosted and not ---------------------------------------
const t3 = await page.evaluate(() => {
  const g = window.__game;
  window.__fly.reset(); window.__fly.takeOff();
  g.hold('jump', true); g.run(1.5); g.hold('jump', false);
  g.hold('forward', true); g.run(4.0);
  const cruise = g.state().player.speed;
  g.hold('sprint', true); g.run(4.0);
  const boost = g.state().player.speed;
  const stam = g.state().vitals?.stamina;
  g.hold('forward', false); g.hold('sprint', false); g.run(2.5);
  const coast = g.state().player.speed;
  return { cruise, boost, stam, coast };
});
check('cruise ~7.5 m/s', Math.abs(t3.cruise - 7.5) < 0.4, `measured ${t3.cruise}`);
check('boost ~13 m/s', Math.abs(t3.boost - 13.0) < 0.5, `measured ${t3.boost}`);
check('boost is free', t3.stam >= 99.5, `stamina ${t3.stam}/100 after 4 s of boost`);
check('coasts to a stop', t3.coast < 0.15, `speed ${t3.coast} after 2.5 s of no input`);

// ---- 4. the terrain floor ---------------------------------------------------
const t4 = await page.evaluate(() => {
  const g = window.__game;
  window.__fly.reset(); window.__fly.takeOff();
  // hug the deck and fly, sampling clearance every step so a single frame inside the
  // hillside cannot hide between two coarse samples
  g.hold('crouch', true); g.run(1.2); g.hold('crouch', false);
  g.hold('forward', true); g.hold('sprint', true);
  let worst = 99;
  for (let i = 0; i < 60; i++) { g.run(0.25); worst = Math.min(worst, g.state().player.altitude); }
  g.hold('forward', false); g.hold('sprint', false);
  return { worst, alt: g.state().player.altitude };
});
check('never inside the terrain', t4.worst >= 0.0, `worst clearance ${t4.worst.toFixed(3)} m over 15 s of boosted deck-level flight`);

// ---- 5. winded in mid-air: a controlled descent, no impact ------------------
const t5 = await page.evaluate(() => {
  const g = window.__game;
  window.__fly.reset(); window.__fly.takeOff();
  g.hold('jump', true); g.run(5.0); g.hold('jump', false);
  const alt0 = g.state().player.altitude;
  const vit = g.internals.game.get('vitals');
  vit.damage(vit.health(), 'probe');              // straight to a collapse
  g.run(2.0);
  const alt1 = g.state().player.altitude;
  const hp1 = g.state().vitals.health;
  g.run(12);                                      // long enough to touch down and get up
  const s = g.state();
  return {
    rate: (alt0 - alt1) / 2.0, hp1, hpEnd: s.vitals.health,
    falls: s.vitals.stats.falls, flying: s.player.flying, alt: s.player.altitude,
  };
});
check('winded descent ~3 m/s', Math.abs(t5.rate - 3.0) < 0.3, `measured ${t5.rate.toFixed(2)} m/s`);
check('winded touchdown does no fall damage', t5.falls === 0, `vitals.stats.falls = ${t5.falls}`);
check('flight ends on the ground', t5.flying === false && t5.alt < 0.2, `flying=${t5.flying} alt=${t5.alt}`);

// ---- 6. cutting the jets high up still costs you ---------------------------
const t6 = await page.evaluate(() => {
  const g = window.__game;
  window.__fly.reset(); window.__fly.takeOff();
  g.hold('jump', true); g.run(7.0); g.hold('jump', false); g.run(0.3);
  const alt = g.state().player.altitude;
  const hp0 = g.state().vitals.health;
  g.tap('jump'); g.run(0.12); g.tap('jump'); g.run(0.06);   // cut them
  const flying = g.state().player.flying;
  g.run(8);
  const s = g.state();
  return { alt, flying, hp0, hp1: s.vitals.health, falls: s.vitals.stats.falls, grounded: s.player.grounded };
});
check('double-tap cuts the jets', t6.flying === false, `flying=${t6.flying} at ${t6.alt.toFixed(1)} m`);
check('gravity resumes', t6.grounded === true, `back on the ground, alt ${t6.alt.toFixed(1)} m drop`);
check('the drop is paid for', t6.falls >= 1 && t6.hp1 < t6.hp0, `falls=${t6.falls} vigour ${t6.hp0} -> ${t6.hp1}`);

// ---- stills -----------------------------------------------------------------
const SHOT = ({ what }) => {
  const g = window.__game;
  window.__fly.reset(); window.__fly.takeOff();
  g.setTimeOfDay(0.30);
  if (what === 'hover') { g.hold('jump', true); g.run(2.2); g.hold('jump', false); g.run(0.6); }
  if (what === 'level') { g.hold('jump', true); g.run(2.2); g.hold('jump', false); g.hold('forward', true); g.hold('sprint', true); g.run(4.0); }
  if (what === 'deck') { g.hold('crouch', true); g.run(0.8); g.hold('crouch', false); g.hold('forward', true); g.run(1.5); }
  const s = g.state().player;
  const px = s.pos[0], py = s.pos[1], pz = s.pos[2];
  g.setCamera([px + 4.4, py + 1.5, pz + 1.2], [px, py + 0.5, pz], 34);
  g.run(0.02);
  return { alt: s.altitude, thrust: s.flyThrust, speed: s.speed };
};
for (const what of ['hover', 'level', 'deck']) {
  const info = await page.evaluate(SHOT, { what });
  await page.screenshot({ path: path.join(OUT, `${what}.png`), timeout: 120000 });
  console.log(what, JSON.stringify(info));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log('errors', errs.slice(0, 6));

await browser.close();
await server.close();
process.exit(failed.length ? 1 : 0);
