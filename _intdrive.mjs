#!/usr/bin/env node
/**
 * THROWAWAY (integration agent). Drives the two new loops through the real input path
 * and writes stills so the aim camera, the reticle, the ammo readout and the odds tag
 * can be LOOKED AT rather than taken on trust. Everything is written to report.json in
 * a finally block, so a slow screenshot on a loaded box cannot cost the measurements.
 *
 *   node _intdrive.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OUT = path.resolve('captures', '_intdrive');
await mkdir(OUT, { recursive: true });

const server = await createServer({
  cacheDir: 'node_modules/.vite-intdrive',
  server: { port: 5411, host: '127.0.0.1', strictPort: true },
  logLevel: 'error',
});
await server.listen();
const base = 'http://127.0.0.1:5411';

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message.slice(0, 300)));

const waitReady = async () => {
  await page.waitForFunction(() => window.__game?.ready === true || window.__game?.ready === 'failed',
    null, { timeout: 300000 });
  const r = await page.evaluate(() => window.__game.ready);
  if (r !== true) throw new Error('init failed: ' + JSON.stringify(await page.evaluate(() => window.__game.errors)));
};
// Cold-start vite optimises deps and then forces a full reload, which destroys the
// execution context mid-script. Boot once to warm it, then reload and work on that page.
await page.goto(`${base}/?capture=1&seed=20240719`, { waitUntil: 'domcontentloaded', timeout: 300000 });
await waitReady();
await page.waitForTimeout(2500);
await page.reload({ waitUntil: 'domcontentloaded', timeout: 300000 });
await waitReady();

const report = { steps: {}, shots: [], errors: errs };
const ev = (fn, arg) => page.evaluate(fn, arg);
const shot = async (name) => {
  try {
    await page.evaluate(() => window.__game.render());
    await page.screenshot({ path: path.join(OUT, `${name}.png`), timeout: 150000 });
    report.shots.push(name);
  } catch (e) { report.shots.push(`${name}: FAILED ${e.name}`); }
};
const hud = () => ev(() => {
  const g = window.__game.internals.game;
  const u = g.get('ui').snapshot();
  const host = document.querySelector('#eg-ui');
  const disp = (s) => host.querySelector(s).style.display || 'shown';
  return {
    hands: u.hands, odds: u.odds, visible: u.visibleText,
    display: { cross: disp('.cross'), hand: disp('.hand'), odds: disp('.odds') },
    weapons: g.get('weapons').snapshot(),
    spheres: g.get('spheres').snapshot(),
    player: g.get('player').snapshot(),
  };
});

try {
  await ev(() => {
    const g = window.__game;
    const game = g.internals.game;
    g.setTimeOfDay(0.30);
    g.setCamera(null);
    g.run(0.4);
    window.__log = [];
    game.bus.on('*', (p, evt) => {
      if (!/^(sphere:|weapon:|creature:(weakened|exhausted|recovered|tamed|startled))/.test(evt)) return;
      window.__log.push({ evt, id: p?.id, shake: p?.shake, of: p?.of, phase: p?.phase, surface: p?.surface, stamina: p?.stamina, exhausted: p?.exhausted, atShake: p?.atShake });
    });
    const s0 = g.state();
    const [px, , pz] = s0.player.pos;
    const cr = g.spawnCreature('woolkin', px, pz - 8);
    cr.trust = 0.34;
    if (cr._tame) cr._tame.trust = 0.34;
    window.__cr = cr;
    g.place(px, pz, 0);
    g.run(0.6);
  });

  // ---- SPHERE: equip, aim, throw ------------------------------------------
  await ev(() => { const g = window.__game; g.tap('slot2'); g.run(0.6); g.hold('aim', true); g.run(0.8); });
  report.steps.sphereAim = await hud();
  await shot('1-sphere-aim');
  await ev(() => { const g = window.__game; g.tap('throw'); g.run(2.2); });
  await shot('2-sphere-wobble');
  await ev(() => window.__game.run(4.5));
  report.steps.sphereResolve = await hud();
  report.steps.sphereAI = await ev(() => window.__game.internals.game.get('ai').snapshot().described.slice(0, 2));
  await shot('3-sphere-resolve');
  await ev(() => { window.__game.hold('aim', false); window.__game.run(0.6); });

  // ---- WEAPON: hip, aim, burst, dry, reload -------------------------------
  await ev(() => {
    const g = window.__game;
    const s0 = g.state();
    const [px, , pz] = s0.player.pos;
    window.__cr2 = g.spawnCreature('woolkin', px, pz - 7);
    g.place(px, pz, 0);
    g.run(0.5);
    g.tap('slot3'); g.run(0.6);
  });
  report.steps.gunHip = await hud();
  await shot('4-gun-hip');

  await ev(() => { window.__game.hold('aim', true); window.__game.run(0.9); });
  report.steps.gunAim = await hud();
  await shot('5-gun-aim');

  await ev(() => { const g = window.__game; for (let i = 0; i < 4; i++) { g.tap('fire'); g.run(0.22); } });
  report.steps.burst = await hud();
  report.steps.burstAI = await ev(() => window.__game.internals.game.get('ai').snapshot().described.slice(0, 2));
  await shot('6-gun-burst');

  // empty the magazine into it, then run dry, then reload
  await ev(() => {
    const g = window.__game;
    for (let i = 0; i < 12; i++) { g.tap('fire'); g.run(0.22); }
    g.tap('fire'); g.run(0.12);
    g.tap('reload'); g.run(0.6);
  });
  report.steps.reload = await hud();
  await shot('7-gun-reload');
  await ev(() => window.__game.run(1.2));
  report.steps.afterReload = await hud();

  // ---- the winded state ---------------------------------------------------
  await ev(() => {
    const g = window.__game;
    for (let i = 0; i < 12; i++) { g.tap('fire'); g.run(0.22); }
    g.hold('aim', false);
    g.run(2.0);
  });
  report.steps.winded = await ev(() => {
    const g = window.__game.internals.game;
    const ai = g.get('ai').snapshot();
    return {
      described: ai.described.slice(0, 3), byState: ai.byState, spooked: ai.spooked,
      windedCount: ai.winded, counters: ai.counters,
      weakened: g.get('weapons').snapshot().weakened,
      creatureCount: g.get('creatures').list.length,
      audioRecent: g.get('audio').snapshot().recent,
      audioCounts: g.get('audio').snapshot().counts,
    };
  });
  await shot('8-winded');

  // ---- empty hands: every new element must be gone -------------------------
  await ev(() => { window.__game.tap('slot1'); window.__game.run(4.0); });
  report.steps.emptyHands = await hud();
  await shot('9-empty-hands');

  report.events = await ev(() => window.__log);
  report.stats = await ev(() => window.__game.stats());
} catch (e) {
  report.fatal = `${e.name}: ${e.message}`.slice(0, 400);
} finally {
  await writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    fatal: report.fatal ?? null,
    errors: errs,
    stats: report.stats ?? null,
    shots: report.shots,
    events: (report.events ?? []).map((e) => e.evt),
    emptyHands: report.steps.emptyHands ?? null,
  }, null, 2));
  await browser.close();
  await server.close();
}
