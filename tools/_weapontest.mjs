#!/usr/bin/env node
/**
 * THROWAWAY. Drives src/weapons/ headlessly through the whole verb set — equip, aim,
 * fire, bloom, burst-climb, run dry, reload, interrupt a reload, and put rounds into a
 * creature — and asserts the bus fires the right events in the right order with sane
 * payloads. Also writes one mid-burst still so the flash / tracer / impact can be
 * eyeballed rather than taken on trust.
 *
 *   node tools/_weapontest.mjs
 *
 * Everything runs through the same scripted-input path a human uses (hold/tap) and the
 * same deterministic clock the capture harness uses (run(seconds)); no wall-clock time
 * anywhere, so this is reproducible frame for frame.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const OUT = path.resolve('captures', 'wip-weap');
await mkdir(OUT, { recursive: true });

// hmr:false / watch:null — five builders are saving into this tree while this runs, and
// a vite hot reload triggered by somebody else's edit aborts the navigation or swaps the
// finished frame for the boot overlay half way through a shot.
const server = await createServer({
  server: { port: 0, host: '127.0.0.1', strictPort: false, hmr: false, watch: null },
  logLevel: 'error',
});
await server.listen();
const port = server.config.server.port ?? server.httpServer.address().port;
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message.slice(0, 300)));
await page.goto(`http://127.0.0.1:${port}/?capture=1&seed=20240719`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });

// --------------------------------------------------------------------------
// PART 1 — the mechanical verbs, against terrain.
// --------------------------------------------------------------------------
const PART1 = () => {
  const g = window.__game;
  const game = g.internals.game;
  const W = game.get('weapons');
  const log = [];
  game.bus.on('*', (p, evt) => {
    if (!/^(weapon:|creature:weakened|creature:exhausted)/.test(evt)) return;
    const s = { evt };
    for (const k of ['id', 'phase', 'surface', 'inMag', 'spreadDeg', 'distance', 'damage', 'stamina', 'exhausted', 'why', 'aiming', 'species']) {
      if (p && p[k] !== undefined) s[k] = p[k];
    }
    if (p?.point) s.point = [p.point.x, p.point.y, p.point.z];
    if (p?.from) s.from = [p.from.x, p.from.y, p.from.z];
    if (p?.dir) s.dir = [p.dir.x, p.dir.y, p.dir.z];
    log.push(s);
  });

  const out = { log, steps: {} };
  const snap = () => JSON.parse(JSON.stringify(game.get('weapons').snapshot()));

  g.setTimeOfDay(0.32);
  g.setCamera(null);
  const s0 = g.state();
  g.place(s0.player.pos[0], s0.player.pos[2], 0);
  g.run(1.2);
  out.steps.beforeEquip = snap();

  // ---- equip the sidearm (Digit3) ----------------------------------------
  g.tap('slot3');
  g.run(0.45);                                   // longer than the 0.28 s swap
  out.steps.equipped = snap();

  // ---- fire while NOT aiming, to read the hip cone ------------------------
  out.steps.hipSpread = W.spreadDeg();

  // ---- aim: a state with a ramp -------------------------------------------
  g.hold('aim', true);
  g.run(0.05); out.steps.aim05 = W.aimBlend();
  g.run(0.20); out.steps.aim25 = W.aimBlend();
  out.steps.aimedSpread = W.spreadDeg();

  // ---- one shot ------------------------------------------------------------
  const before = snap();
  g.tap('fire');
  g.run(1 / 60);
  out.steps.afterOneShot = snap();
  out.steps.spreadJump = +(W.spreadDeg() - before.spreadDeg).toFixed(3);
  g.run(0.35);
  out.steps.afterOneShotSettled = snap();

  // ---- a burst: does the muzzle climb and does bloom widen? ----------------
  for (let i = 0; i < 5; i++) { g.tap('fire'); g.run(0.20); }
  out.steps.afterBurst = snap();
  g.run(1.5);
  out.steps.afterBurstRecovered = snap();

  // ---- run the magazine dry ------------------------------------------------
  let guard = 0;
  while (W.ammo().inMag > 0 && guard++ < 40) { g.tap('fire'); g.run(0.20); }
  out.steps.emptied = snap();
  g.tap('fire'); g.run(1 / 60);
  out.steps.afterDryPull = snap();
  // a held trigger on an empty gun must not spam the event
  g.hold('fire', true); g.run(0.30); g.hold('fire', false); g.run(1 / 60);
  out.steps.dryEvents = log.filter((e) => e.evt === 'weapon:dry').length;

  // ---- reload, with phases -------------------------------------------------
  g.tap('reload'); g.run(1 / 60);
  out.steps.reloadStart = { progress: W.reloading(), phase: W.reloadPhase() };
  g.run(0.5);
  out.steps.reloadMid = { progress: +W.reloading().toFixed(3), phase: W.reloadPhase() };
  g.run(1.2);
  out.steps.reloadDone = snap();

  // ---- interrupt a reload by swapping to the sphere -------------------------
  for (let i = 0; i < 3; i++) { g.tap('fire'); g.run(0.20); }
  const beforeInterrupt = W.ammo().inMag;
  g.tap('reload'); g.run(0.30);
  const midReloadPhase = W.reloadPhase();
  g.tap('slot2');            // Bond Sphere — the swap must kill the reload
  g.run(0.40);
  const duringSwap = { reloading: W.reloading(), equipped: W.weaponId(), ammo: W.ammo() };
  g.tap('slot3'); g.run(0.45);      // back to the pistol: is the magazine as we left it?
  out.steps.interrupted = { before: beforeInterrupt, midReloadPhase, duringSwap, back: W.ammo(), reloading: W.reloading() };

  g.hold('aim', false);
  g.tap('slot1'); g.run(0.5);
  out.steps.unequipped = snap();
  return out;
};

const p1 = await page.evaluate(`(${PART1.toString()})()`);

// --------------------------------------------------------------------------
// PART 2 — rounds into a creature. Fresh page so nothing leaks forward.
// --------------------------------------------------------------------------
await page.goto(`http://127.0.0.1:${port}/?capture=1&seed=20240719`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });

const PART2 = () => {
  const g = window.__game;
  const game = g.internals.game;
  const W = game.get('weapons');
  const creatures = game.get('creatures');
  const log = [];
  game.bus.on('*', (p, evt) => {
    if (!/^(weapon:hit|creature:weakened|creature:exhausted)/.test(evt)) return;
    log.push({ evt, id: p.id, stamina: p.stamina, exhausted: p.exhausted, absorbed: p.absorbed, damage: p.damage });
  });

  g.setTimeOfDay(0.35);
  g.setCamera(null);
  const s0 = g.state();
  const px = s0.player.pos[0], pz = s0.player.pos[2];
  g.place(px, pz, 0);
  g.run(1.0);

  // a fresh subject 8 m in front, and nothing else in the way
  const cr = g.spawnCreature('woolkin', px, pz - 8);
  g.run(0.4);

  const populationBefore = creatures.list.length;

  // carbine
  g.tap('slot4'); g.run(0.45);
  g.hold('aim', true); g.run(0.30);

  // Frame the camera on the subject and keep it framed: knockback and the creature's
  // own legs move it, and a test that quietly stops hitting is a test that lies.
  const aim = () => {
    const size = cr.def.size;
    const cx = cr.position.x, cy = cr.position.y + size * 0.52, cz = cr.position.z;
    g.setCamera([cx, cy + 0.45, cz + 6.0], [cx, cy, cz], 55);
  };

  const trail = [];
  for (let i = 0; i < 26; i++) {
    aim();
    g.hold('fire', true);
    g.run(0.10);
    trail.push({ t: +(i * 0.10).toFixed(2), stamina: +(cr.stamina01 ?? 1).toFixed(3), stagger: +(cr.staggerT ?? 0).toFixed(3), exhausted: !!cr.exhausted });
  }
  g.hold('fire', false);
  g.run(0.5);

  const w = W.weakness(cr);
  return {
    log, trail,
    populationBefore,
    populationAfter: creatures.list.length,
    stillInScene: creatures.list.indexOf(cr) >= 0 && !!cr.root.parent,
    weakness: { ...w, stamina: +w.stamina.toFixed(3), stagger: +w.stagger.toFixed(3), sinceHit: +w.sinceHit.toFixed(2) },
    catchBonus: +W.catchBonus(cr).toFixed(3),
    isExhausted: W.isExhausted(cr),
    mirrored: { stamina01: +cr.stamina01.toFixed(3), weakened: cr.weakened, exhausted: cr.exhausted },
    ammo: W.ammo(),
    snapshot: JSON.parse(JSON.stringify(W.snapshot())),
    stats: g.stats(),
    // recovery: leave it alone and it gets its wind back
    recovery: (() => { g.run(12); return { stamina: +cr.stamina01.toFixed(3), exhausted: cr.exhausted }; })(),
  };
};

const p2 = await page.evaluate(`(${PART2.toString()})()`);

// --------------------------------------------------------------------------
// PART 3 — a still, mid-burst, aiming, in the over-shoulder framing.
// --------------------------------------------------------------------------
await page.goto(`http://127.0.0.1:${port}/?capture=1&seed=20240719`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });

const PART3 = () => {
  const g = window.__game;
  g.setTimeOfDay(0.29);
  g.setCamera(null);
  const s0 = g.state();
  g.place(s0.player.pos[0], s0.player.pos[2], 0);
  g.run(2.2);
  g.tap('slot4'); g.run(0.5);
  g.hold('aim', true); g.run(0.35);
  g.look(0, 26);                 // pitch down onto the ground ahead
  g.run(0.2);
  g.hold('fire', true);
  g.run(0.30);                   // mid-burst
  g.run(2 / 60);                 // 33 ms after the last round: flash still lit, tracer out
  g.render();
  return { state: g.state().weapons, stats: g.stats() };
};

const p3 = await page.evaluate(`(${PART3.toString()})()`);
await page.screenshot({ path: path.join(OUT, 'burst_overshoulder.png'), animations: 'disabled', timeout: 120000 });

/**
 * PART 3b — put the gun away and check it costs nothing.
 *
 * NOT by comparing total draw calls between two frames: the grass system rebuilds its
 * instance rings as the camera moves, so the scene's own draw count drifts by ±10
 * between any two moments and an A/B on that number measures vegetation, not weapons.
 * The actual claim is that every object this module owns is invisible when no gun is in
 * hand, and an invisible object is never submitted — so that is what gets asserted.
 */
const PART3B = () => {
  const g = window.__game;
  g.tap('slot1'); g.run(0.6); g.hold('fire', false); g.hold('aim', false); g.run(3.5);
  g.render();
  const vis = [];
  g.internals.scene.traverse((o) => {
    if (!/^weapon_/.test(o.name)) return;
    if (o.visible && (o.parent?.visible ?? true) && (o.isMesh || o.isPoints)) vis.push(o.name);
  });
  return { stats: g.stats(), visibleWeaponObjects: vis };
};
const p3b = await page.evaluate(`(${PART3B.toString()})()`);

await browser.close();
await server.close();

// --------------------------------------------------------------------------
// assertions
// --------------------------------------------------------------------------
const fails = [];
const ok = [];
const check = (name, cond, detail = '') => (cond ? ok : fails).push(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);

const evts = p1.log.map((e) => e.evt);
const firstFire = p1.log.findIndex((e) => e.evt === 'weapon:fired');

check('equipping Digit3 selects the pistol', p1.steps.equipped.equipped === 'pistol', p1.steps.equipped.equipped);
check('magazine starts full', p1.steps.equipped.ammo.inMag === 12 && p1.steps.equipped.ammo.reserve === 60, JSON.stringify(p1.steps.equipped.ammo));
check('aim ramps in over ~0.2s', p1.steps.aim05 > 0.35 && p1.steps.aim05 < 0.85 && p1.steps.aim25 > 0.93,
  `t=0.05 -> ${p1.steps.aim05.toFixed(2)}, t=0.25 -> ${p1.steps.aim25.toFixed(2)}`);
check('aimed cone is far tighter than the hip cone', p1.steps.aimedSpread < p1.steps.hipSpread * 0.35,
  `hip ${p1.steps.hipSpread.toFixed(2)}deg -> aimed ${p1.steps.aimedSpread.toFixed(2)}deg`);
check('a shot spends a round', p1.steps.afterOneShot.ammo.inMag === 11, String(p1.steps.afterOneShot.ammo.inMag));
check('weapon:fired then weapon:impact, in that order',
  firstFire >= 0 && evts[firstFire] === 'weapon:fired' && evts[firstFire + 1] === 'weapon:impact', evts.slice(0, 4).join(' -> '));
const fired0 = p1.log[firstFire];
check('the fired payload carries a muzzle point and a unit direction',
  !!fired0?.from && !!fired0?.dir && Math.abs(Math.hypot(...fired0.dir) - 1) < 1e-3,
  JSON.stringify(fired0));
const impacts = p1.log.filter((e) => e.evt === 'weapon:impact');
const KNOWN = ['dirt', 'grass', 'stone', 'sand', 'water', 'creature'];
check('every impact names a surface this world actually has',
  impacts.length > 0 && impacts.every((e) => KNOWN.includes(e.surface)),
  [...new Set(impacts.map((e) => e.surface))].join(','));
check('rounds into the ground read the ground, not a default',
  impacts.some((e) => e.surface !== 'creature'),
  impacts.map((e) => `${e.surface}@${e.distance}m`).slice(0, 6).join(' '));
check('the shot blooms the cone', p1.steps.spreadJump > 0.9, `+${p1.steps.spreadJump}deg`);
check('the cone recovers', p1.steps.afterOneShotSettled.spreadDeg < p1.steps.afterOneShot.spreadDeg,
  `${p1.steps.afterOneShot.spreadDeg} -> ${p1.steps.afterOneShotSettled.spreadDeg}`);
check('a burst climbs the muzzle', Math.abs(p1.steps.afterBurst.recoilPitchDeg) > Math.abs(p1.steps.afterOneShotSettled.recoilPitchDeg) + 0.2,
  `${p1.steps.afterOneShotSettled.recoilPitchDeg}deg -> ${p1.steps.afterBurst.recoilPitchDeg}deg`);
check('recoil does NOT return exactly to zero (residual drift)',
  Math.abs(p1.steps.afterBurstRecovered.recoilPitchDeg) > 0.01, `${p1.steps.afterBurstRecovered.recoilPitchDeg}deg 1.5s later`);
check('the magazine empties', p1.steps.emptied.ammo.inMag === 0);
check('a dry trigger is its own event', evts.includes('weapon:dry'));
check('a HELD dry trigger does not spam', p1.steps.dryEvents <= 2, `${p1.steps.dryEvents} weapon:dry events total`);
const rel = p1.log.filter((e) => e.evt === 'weapon:reload').map((e) => e.phase);
check('reload runs start -> magout -> magin -> charge -> done',
  rel.slice(0, 5).join(',') === 'start,magout,magin,charge,done', rel.join(','));
check('reloading() reports progress', p1.steps.reloadMid.progress > 0.2 && p1.steps.reloadMid.progress < 0.95,
  `${p1.steps.reloadMid.progress} during ${p1.steps.reloadMid.phase}`);
check('the reload actually loads', p1.steps.reloadDone.ammo.inMag === 12 && p1.steps.reloadDone.ammo.reserve === 48,
  JSON.stringify(p1.steps.reloadDone.ammo));
check('a swap interrupts the reload', rel.includes('cancel') && p1.steps.interrupted.duringSwap.reloading === 0,
  JSON.stringify(p1.steps.interrupted));
check('an interrupted reload does not silently load',
  p1.steps.interrupted.back.inMag === p1.steps.interrupted.before,
  `${p1.steps.interrupted.before} rounds before, ${p1.steps.interrupted.back.inMag} after`);
check('ammunition survives a swap', p1.steps.interrupted.back.reserve === 48,
  JSON.stringify(p1.steps.interrupted.back));
check('putting the gun away zeroes the public contract',
  p1.steps.unequipped.ammo.magSize === 0 && p1.steps.unequipped.spreadDeg === 0, JSON.stringify(p1.steps.unequipped.ammo));

const hits = p2.log.filter((e) => e.evt === 'weapon:hit');
check('rounds connect with the creature', hits.length >= 8, `${hits.length} hits`);
check('each hit drains stamina monotonically',
  hits.every((h, i) => i === 0 || h.stamina <= hits[i - 1].stamina), hits.map((h) => h.stamina).join(' '));
check('a weakened creature is announced on the bus', p2.log.some((e) => e.evt === 'creature:weakened'));
check('it reaches exhausted, not dead', p2.isExhausted && p2.weakness.stamina === 0,
  `stamina ${p2.weakness.stamina}, exhausted ${p2.isExhausted}`);
check('creature:exhausted fires exactly once', p2.log.filter((e) => e.evt === 'creature:exhausted').length === 1);
check('further rounds on an exhausted creature are absorbed, not lethal',
  hits.some((h) => h.absorbed === true), `${hits.filter((h) => h.absorbed).length} absorbed`);
check('NOTHING DIED: population unchanged and the creature is still in the scene',
  p2.populationBefore === p2.populationAfter && p2.stillInScene,
  `${p2.populationBefore} -> ${p2.populationAfter}, inScene=${p2.stillInScene}`);
check('catchBonus rises for the sphere system', p2.catchBonus > 1.8, String(p2.catchBonus));
check('the weakened state is mirrored onto the creature record',
  p2.mirrored.exhausted === true && p2.mirrored.weakened === true, JSON.stringify(p2.mirrored));
check('stamina regenerates when left alone', p2.recovery.stamina > 0.3 && !p2.recovery.exhausted, JSON.stringify(p2.recovery));

check('mid-burst still renders inside budget', p3.stats.drawCalls < 300 && p3.stats.triangles < 2_200_000,
  `${p3.stats.drawCalls} draws / ${(p3.stats.triangles / 1000).toFixed(0)}k tris`);
check('a holstered weapon costs nothing: every weapon object is invisible',
  p3b.visibleWeaponObjects.length === 0,
  p3b.visibleWeaponObjects.join(',') || 'none visible');
check('no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));

console.log('\n--- PART 1: mechanics ---');
console.log(JSON.stringify(p1.steps, null, 1));
console.log('\n--- PART 1: event log (first 24) ---');
console.log(p1.log.slice(0, 24).map((e) => JSON.stringify(e)).join('\n'));
console.log('\n--- PART 2: a creature under fire ---');
console.log(JSON.stringify({ trail: p2.trail, weakness: p2.weakness, catchBonus: p2.catchBonus, mirrored: p2.mirrored, recovery: p2.recovery, population: [p2.populationBefore, p2.populationAfter], stats: p2.stats }, null, 1));
console.log('\n--- PART 3: mid-burst still ---');
console.log(JSON.stringify(p3, null, 1), '\nholstered:', JSON.stringify(p3b, null, 1));
console.log('\n--- ASSERTIONS ---');
for (const line of ok) console.log(' ', line);
for (const line of fails) console.log(' ', line);
console.log(`\n${fails.length ? 'FAILED' : 'ALL PASS'} — ${ok.length} passed, ${fails.length} failed`);
if (consoleErrors.length) console.log('console errors:', consoleErrors);
process.exitCode = fails.length ? 1 : 0;
