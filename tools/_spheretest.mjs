#!/usr/bin/env node
/**
 * THROWAWAY. Drives a real throw-to-capture headlessly through the same input path a
 * human uses (slot2 / aim / throw), and asserts:
 *   1. the bus beats fire in order: thrown -> hit -> shake* -> caught|escaped
 *   2. a catch produces creature:tamed AND companion:joined (i.e. a real companion)
 *   3. a wild creature usually bursts out and ends up warier than it started
 *   4. the same seed + the same simulated seconds gives byte-identical outcomes
 *
 * The fed scenario is also paused at three beats so node can screenshot them:
 * aim / pull-in / wobble. That is done inside ONE page session rather than by rebooting
 * per still — with four other agents saving files into this tree, every extra boot is
 * another chance to load someone's half-written module.
 *
 *   node tools/_spheretest.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const OUT = path.resolve('captures', '_spheretest');
await mkdir(OUT, { recursive: true });

// A fixed high port block, not 5173+: several agents run vite at once here and
// "take the next free port" races, landing the browser on someone else's server.
// hmr/watch OFF because their saves were firing full reloads mid-scenario.
let server = null, port = 0;
for (let p = 5399; p <= 5412 && !server; p++) {
  try {
    const s = await createServer({
      cacheDir: 'node_modules/.vite-spheretest',
      server: { port: p, host: '127.0.0.1', strictPort: true, hmr: false, watch: null },
      logLevel: 'error',
    });
    await s.listen();
    server = s; port = p;
  } catch { /* taken; try the next */ }
}
if (!server) throw new Error('no free port in 5399-5412');
const base = `http://127.0.0.1:${port}`;
const bye = async () => { try { await server.close(); } catch { /* */ } };
process.on('exit', () => { server.httpServer?.close?.(); });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`.slice(0, 300)));

const boot = async () => {
  await page.goto(`${base}/?capture=1&seed=20240719`, { waitUntil: 'domcontentloaded', timeout: 300000 });
  await page.waitForFunction(() => window.__game?.ready === true || window.__game?.ready === 'failed',
    null, { timeout: 300000 });
  const r = await page.evaluate(() => window.__game.ready);
  if (r !== true) throw new Error('init failed: ' + JSON.stringify(await page.evaluate(() => window.__game.errors)));
};

// ---- the scenario, split into stages so node can screenshot between them ----------
// `trust` is what the creature is given before the throw — i.e. how many berries the
// player would have fed it. It is the only thing the scenarios vary.
const SETUP = (opts) => {
  const g = window.__game;
  g.setTimeOfDay(0.29);
  g.setCamera(null);
  g.run(0.4);

  const s0 = g.state();
  const [px, , pz] = s0.player.pos;
  const cx = px, cz = pz - 7;
  const cr = g.spawnCreature('woolkin', cx, cz);
  g.place(px, pz, (Math.atan2(-(cx - px), -(cz - pz)) * 180) / Math.PI);
  g.run(0.5);

  cr.trust = opts.trust;
  if (cr._tame) cr._tame.trust = opts.trust;

  g.tap('slot2');          // equip through the real input path
  g.run(0.5);              // and wait out the swap
  g.hold('aim', true);
  g.run(0.45);
  g.render();

  window.__t = { cr, mark: g.internals.game.bus.log.length, timeline: [] };
  return { equipped: g.state().loadout.equipped, spheres: g.state().spheres };
};

/** throw, then stop a few frames into the pull-in */
const TO_PULLIN = () => {
  const g = window.__game;
  const t = window.__t;
  g.tap('throw');
  g.run(0.35);
  t.afterThrow = g.state().spheres;
  g.hold('aim', false);
  let sucked = 0;
  for (let i = 0; i < 60; i++) {
    g.run(0.06);
    const a = g.state().spheres.active[0];
    if (a) t.timeline.push(a.phase);
    if (a && a.phase === 'suck' && ++sucked >= 4) break;
    if (a && (a.phase === 'shake' || a.phase === 'idle')) break;
  }
  g.render();
  return g.state().spheres;
};

/** carry on to the second wobble */
const TO_WOBBLE = () => {
  const g = window.__game;
  const t = window.__t;
  for (let i = 0; i < 90; i++) {
    g.run(0.06);
    const a = g.state().spheres.active[0];
    if (a) t.timeline.push(a.phase);
    if (a && a.phase === 'shake' && a.shake >= 2) break;
    if (!a) break;
  }
  g.render();
  return g.state().spheres;
};

/** run out the resolution and report */
const FINISH = () => {
  const g = window.__game;
  const t = window.__t;
  const game = g.internals.game;
  for (let i = 0; i < 90; i++) {
    g.run(0.08);
    const a = g.state().spheres.active[0];
    if (a) t.timeline.push(a.phase);
  }
  g.run(1.5);

  const evts = game.bus.log.slice(t.mark).map((e) => ({
    evt: e.evt,
    shake: e.payload?.shake ?? null,
    of: e.payload?.of ?? null,
    atShake: e.payload?.atShake ?? null,
    chance: e.payload?.chance ?? null,
  }));
  const st = g.state();
  const cr = t.cr;
  return {
    afterThrow: { inFlight: t.afterThrow?.inFlight ?? null, count: t.afterThrow?.count ?? null },
    sequence: evts.filter((e) => e.evt.startsWith('sphere:') || e.evt === 'creature:tamed' || e.evt === 'companion:joined')
      .map((e) => e.evt),
    detail: evts.filter((e) => e.evt.startsWith('sphere:')),
    tamed: st.interaction.tamed,
    companions: st.interaction.companions.length,
    creature: { trust: +cr.trust.toFixed(3), tamed: !!cr.tamed, visible: !!cr.root.visible, mood: cr.mood,
      scale: +cr.root.scale.x.toFixed(2), breakouts: cr._sphere?.breakouts ?? 0 },
    spheresLeft: st.spheres.count,
    phases: t.timeline.filter((p, i) => p !== t.timeline[i - 1]),
    stats: g.stats(),
    errors: g.errors.length,
    arc: st.interaction.arc.slice(-4),
  };
};

const call = (fn, arg) => page.evaluate(`(${fn.toString()})(${arg === undefined ? '' : JSON.stringify(arg)})`);

async function scenario(opts, stills = false) {
  await boot();
  const setup = await call(SETUP, opts);
  if (stills) await page.screenshot({ path: path.join(OUT, 'aim.png'), animations: 'disabled', timeout: 120000 });
  const pull = await call(TO_PULLIN);
  if (stills) await page.screenshot({ path: path.join(OUT, 'pullin.png'), animations: 'disabled', timeout: 120000 });
  const wob = await call(TO_WOBBLE);
  if (stills) await page.screenshot({ path: path.join(OUT, 'wobble.png'), animations: 'disabled', timeout: 120000 });
  const done = await call(FINISH);
  if (stills) await page.screenshot({ path: path.join(OUT, 'after.png'), animations: 'disabled', timeout: 120000 });
  return { ...done, aim: setup.spheres, equipped: setup.equipped, pullPhase: pull.active[0]?.phase ?? null,
    wobPhase: wob.active[0]?.phase ?? null };
}

let results = {}, fatal = null;
try {
  results.fed = await scenario({ trust: 0.67 }, true);
  results.fedAgain = await scenario({ trust: 0.67 });
  results.wild = await scenario({ trust: 0.0 });
  results.oneBerry = await scenario({ trust: 0.34 });
} catch (e) {
  fatal = String(e?.message ?? e).slice(0, 400);
}

// --- report -------------------------------------------------------------------
const seq = (r) => r.sequence.join(' -> ');
const checks = [];
const ok = (name, pass, extra = '') => checks.push({ name, pass, extra });

if (!fatal) {
  ok('aim acquires the creature', !!results.fed.aim.target, JSON.stringify(results.fed.aim.target));
  ok('the arc has a landing point', !!results.fed.aim.aim, JSON.stringify(results.fed.aim.aim));
  ok('throw consumed a sphere', results.fed.afterThrow.count === 5, `count=${results.fed.afterThrow.count}`);
  ok('pull-in and wobble beats were reached',
    results.fed.pullPhase === 'suck' && results.fed.wobPhase === 'shake',
    `${results.fed.pullPhase}/${results.fed.wobPhase}`);
  ok('beats fire in order (fed)',
    /^sphere:thrown -> sphere:hit -> (sphere:shake -> ){3}sphere:caught/.test(seq(results.fed)), seq(results.fed));
  ok('fed capture produces a companion',
    results.fed.sequence.includes('creature:tamed') && results.fed.sequence.includes('companion:joined')
    && results.fed.tamed >= 1 && results.fed.companions >= 1,
    `tamed=${results.fed.tamed} companions=${results.fed.companions}`);
  ok('creature is back in the world at full size after the catch',
    results.fed.creature.visible && results.fed.creature.tamed && results.fed.creature.scale > 0.9,
    JSON.stringify(results.fed.creature));
  ok('deterministic across identical runs',
    JSON.stringify(results.fed.detail) === JSON.stringify(results.fedAgain.detail), seq(results.fedAgain));
  ok('wild creature breaks out',
    results.wild.sequence.includes('sphere:escaped') && results.wild.tamed === 0, seq(results.wild));
  ok('a broken-out creature is loose, warier and afraid',
    results.wild.creature.visible && !results.wild.creature.tamed
    && results.wild.creature.mood === 'afraid' && results.wild.creature.breakouts === 1,
    JSON.stringify(results.wild.creature));
  ok('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
  ok('no page errors recorded by the game', results.fed.errors === 0);
}

console.log('\n=== sphere capture harness ===');
if (fatal) console.log('FATAL:', fatal);
for (const [k, r] of Object.entries(results)) {
  console.log(`\n[${k}]`);
  console.log('  chance shown at aim :', JSON.stringify(r.aim.target));
  console.log('  phases              :', r.phases.join(' > '));
  console.log('  bus                 :', seq(r));
  console.log('  detail              :', JSON.stringify(r.detail));
  console.log('  creature after      :', JSON.stringify(r.creature));
  console.log('  arc log             :', JSON.stringify(r.arc));
  console.log(`  tamed=${r.tamed} companions=${r.companions} spheresLeft=${r.spheresLeft}`);
  console.log(`  draws=${r.stats.drawCalls} tris=${r.stats.triangles}`);
}
console.log('\n=== assertions ===');
let fails = fatal ? 1 : 0;
for (const c of checks) {
  if (!c.pass) fails++;
  console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.extra ? `   [${c.extra}]` : ''}`);
}
console.log(`\nstills -> ${OUT}`);
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);

await browser.close();
await bye();
process.exitCode = fails === 0 ? 0 : 1;
