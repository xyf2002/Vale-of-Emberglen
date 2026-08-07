#!/usr/bin/env node
/**
 * THROWAWAY. Do the three meters mean anything?
 *
 * Drives the real input path through each thing that is supposed to move a bar, and
 * prints the meter values around it. A bar that only animates is a decoration; these
 * numbers are the difference.
 *
 *   node tools/_vitals.mjs
 *
 * Writes captures/wip-vitalhud/*.png and report.json.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// NOT 'wip-vitals': tools/capture.mjs wipes the round directory it is given, so a probe
// sharing a name with a round loses its frames the next time that round is captured.
const OUT = path.resolve('captures', 'wip-vitalhud');
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
const page = await browser.newPage({ viewport: { width: 1100, height: 620 } });
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message.slice(0, 300)));
await page.goto(`http://127.0.0.1:${port}/?capture=1&seed=20240719`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });

const V = () => {
  const s = window.__game.state();
  const v = s.vitals;
  return {
    hp: v.health, fp: v.focus, st: v.stamina,
    exhausted: v.exhausted, collapsed: v.collapsed,
    bars: s.ui?.meters ?? null,
  };
};

const STEP = async (label, fn) => {
  const r = await page.evaluate(fn);
  console.log(label.padEnd(22), JSON.stringify(r));
  return { label, ...r };
};

const report = [];
report.push(await STEP('boot', () => {
  const g = window.__game;
  g.setTimeOfDay(0.35);
  g.releaseAll();
  g.setCamera(null);
  g.run(1.0);
  const s = window.__game.state().vitals;
  return { hp: s.health, fp: s.focus, st: s.stamina };
}));

report.push(await STEP('sprint 4s', () => {
  const g = window.__game;
  g.hold('forward', true); g.hold('sprint', true);
  g.run(4);
  const s = g.state().vitals;
  return { hp: s.health, fp: s.focus, st: +s.stamina.toFixed(1), exhausted: s.exhausted };
}));

report.push(await STEP('sprint to empty', () => {
  const g = window.__game;
  g.run(6);
  const s = g.state().vitals;
  return { st: +s.stamina.toFixed(1), exhausted: s.exhausted, speed: g.state().player.speed };
}));

report.push(await STEP('walk 4s (regen)', () => {
  const g = window.__game;
  g.hold('sprint', false);
  g.run(4);
  const s = g.state().vitals;
  return { st: +s.stamina.toFixed(1), exhausted: s.exhausted };
}));

report.push(await STEP('jump x3', () => {
  const g = window.__game;
  g.hold('forward', false);
  g.run(3);                       // let stamina come back first
  const before = g.state().vitals.stamina;
  for (let i = 0; i < 3; i++) { g.tap('jump'); g.run(1.1); }
  const s = g.state().vitals;
  return { before: +before.toFixed(1), after: +s.stamina.toFixed(1) };
}));

report.push(await STEP('aim 3s (focus)', () => {
  const g = window.__game;
  g.tap('slot4');                 // carbine
  g.run(0.6);
  const before = g.state().vitals.focus;
  g.hold('aim', true); g.run(3); g.hold('aim', false);
  const s = g.state().vitals;
  return { before: +before.toFixed(1), after: +s.focus.toFixed(1) };
}));

report.push(await STEP('throw spheres', () => {
  const g = window.__game;
  g.tap('slot2');                 // bond sphere
  g.run(1.2);
  const out = [];
  for (let i = 0; i < 4; i++) {
    const b = g.state().vitals.focus;
    g.tap('throw'); g.run(1.4);
    const a = g.state();
    out.push({ focus: +a.vitals.focus.toFixed(1), spent: +(b - a.vitals.focus).toFixed(1), left: a.spheres.count });
  }
  return { throws: out, text: g.state().ui.visibleText.slice(-2) };
}));

report.push(await STEP('fall damage', () => {
  const g = window.__game;
  // Dropping the traveller off a real cliff is not reachable through the public API, so
  // this replays the exact event a hard landing emits — which is also the only input
  // src/vitals takes for falls, so nothing is being faked past the seam.
  g.internals.game.bus.emit('player:land', { pos: null, impact: 18 });
  g.run(0.2);
  const v = g.state().vitals;
  return { hp: +v.health.toFixed(1), collapsed: v.collapsed };
}));

report.push(await STEP('eat a berry', () => {
  const g = window.__game;
  const b = g.state();
  g.tap('eat'); g.run(0.3);
  const a = g.state();
  return {
    hp: +a.vitals.health.toFixed(1),
    berriesBefore: b.interaction.inventory.berry,
    berriesAfter: a.interaction.inventory.berry,
  };
}));

await page.screenshot({ path: path.join(OUT, 'hud-spent.png') });

report.push(await STEP('collapse', () => {
  const g = window.__game;
  g.internals.game.bus.emit('player:land', { pos: null, impact: 60 });
  g.run(0.2);
  const v = g.state().vitals;
  return { hp: +v.health.toFixed(1), collapsed: +v.collapsed.toFixed(2), text: g.state().ui.visibleText.slice(-1) };
}));

await page.screenshot({ path: path.join(OUT, 'hud-collapsed.png') });

report.push(await STEP('locked while down', () => {
  const g = window.__game;
  g.hold('forward', true); g.hold('sprint', true);
  g.run(1.0);
  const s = g.state();
  return { speed: +s.player.speed.toFixed(2), state: s.player.state, collapsed: +s.vitals.collapsed.toFixed(2) };
}));

report.push(await STEP('back up', () => {
  const g = window.__game;
  g.run(3.2);
  const s = g.state();
  return { hp: +s.vitals.health.toFixed(1), collapsed: s.vitals.collapsed, speed: +s.player.speed.toFixed(2) };
}));

report.push(await STEP('idle fade', () => {
  const g = window.__game;
  g.releaseAll();
  g.run(30);                      // everything back to full: the cluster should recede
  const s = g.state();
  return { bars: s.ui.meters, hp: +s.vitals.health.toFixed(1), st: +s.vitals.stamina.toFixed(1) };
}));

await page.screenshot({ path: path.join(OUT, 'hud-full.png') });

await writeFile(path.join(OUT, 'report.json'), JSON.stringify({ report, errors: errs }, null, 2));
console.log('errors:', errs.length ? errs : 'none');
await browser.close();
await server.close();
