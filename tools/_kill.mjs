#!/usr/bin/env node
/**
 * THROWAWAY. Creature health, death and the body afterwards (r15).
 *
 * Walks up to a creature, empties a magazine into it through the real input path, and
 * reports health, stamina, the death, the corpse and the despawn. The point is the
 * ORDER of the two clocks: exhaustion must arrive well before death, or the befriending
 * loop the weapon is supposed to open becomes unreachable.
 *
 *   node tools/_kill.mjs
 *
 * Writes captures/wip-kill/*.png and report.json.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OUT = path.resolve('captures', 'wip-kill');
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

const STEP = async (label, fn, arg) => {
  const r = await page.evaluate(fn, arg);
  console.log(label.padEnd(18), JSON.stringify(r));
  return { label, ...r };
};

const report = [];

report.push(await STEP('stage', () => {
  const g = window.__game;
  g.setTimeOfDay(0.35);
  g.releaseAll();
  g.setCamera(null);
  g.run(0.5);
  // Stand the traveller a few metres from a creature and FACE it. `place(x, z, yawDeg)`
  // takes a yaw in degrees under the rig's own convention (forward is -Z, yaw measured
  // the same way the movement basis is built), so it has to be derived from the offset
  // rather than guessed: standing due south of the target and passing 180 aimed the
  // camera at empty meadow and the first version of this probe fired thirty rounds into
  // the grass and reported "no damage", which looked exactly like a broken feature.
  const game = g.internals.game;
  const cr = game.get('creatures').list[0];
  const p = game.get('player');
  const off = { x: 0.0, z: 5.5 };                       // stand this far from it
  const px = cr.position.x + off.x, pz = cr.position.z + off.z;
  const dx = cr.position.x - px, dz = cr.position.z - pz;
  const yawDeg = Math.atan2(-dx, -dz) * 180 / Math.PI;  // matches player.getForward()
  g.place(px, pz, yawDeg);
  g.tap('slot4');
  g.run(1.0);

  // ...and PITCH DOWN onto it. Facing the right way is not aiming: the round is traced
  // from the camera along its forward axis, the camera sits at ~1.7 m and a woolkin's
  // chest is at ~0.6 m, so a level crosshair at 5 m passes clean over its back. The
  // second version of this probe fired thirty rounds that way and reported "no damage".
  // `look(dx, dy)` applies sens 0.0025 * 0.86 on the pitch axis, and pitch starts at
  // -5 deg, so the units below are derived, not tuned by hand.
  const cam = g.internals.camera;
  const aimY = cr.position.y + (cr.def?.size ?? 1) * 0.55;
  const want = Math.atan2(aimY - cam.position.y, Math.hypot(cr.position.x - cam.position.x, cr.position.z - cam.position.z));
  const have = p.camera.pitch;
  g.look(0, -(want - have) / (0.0025 * 0.86));
  g.run(0.4);

  const s = g.state();
  return {
    species: cr.species, health: cr.health, max: cr.maxHealth,
    yawDeg: +yawDeg.toFixed(1),
    pitchDeg: +(p.camera.pitch * 180 / Math.PI).toFixed(1),
    dist: +p.position.distanceTo(cr.position).toFixed(2),
    equipped: s.loadout?.equipped,
  };
}));

report.push(await STEP('first blood', () => {
  const g = window.__game;
  const cr = g.internals.game.get('creatures').list[0];
  g.hold('aim', true);
  g.run(0.5);
  for (let i = 0; i < 3; i++) { g.hold('fire', true); g.run(0.10); g.hold('fire', false); g.run(0.06); }
  g.run(0.10);                     // let the numbers pop but not fade
  return { hp: +cr.health.toFixed(1), max: cr.maxHealth, sinceHurt: +cr.sinceHurt.toFixed(2) };
}));

// the frame that has to sell it: spray, numbers, and the creature's own bar
await page.screenshot({ timeout: 60000, path: path.join(OUT, 'hit.png') });

report.push(await STEP('empty a magazine', () => {
  const g = window.__game;
  const game = g.internals.game;
  const cr = game.get('creatures').list[0];
  const marks = [];
  g.hold('aim', true);
  g.run(0.5);
  for (let i = 0; i < 30; i++) {
    g.hold('fire', true); g.run(0.10); g.hold('fire', false); g.run(0.06);
    marks.push({
      shot: i + 1,
      hp: +cr.health.toFixed(1),
      stam: +(cr.stamina01 ?? 1).toFixed(2),
      exhausted: !!cr.exhausted,
      dead: !!cr.dead,
    });
    if (cr.dead) break;
  }
  const firstExhaust = marks.find((m) => m.exhausted)?.shot ?? null;
  const death = marks.find((m) => m.dead)?.shot ?? null;
  return { shots: marks.length, firstExhaust, death, hits: marks[marks.length - 1] };
}));

await page.screenshot({ timeout: 60000, path: path.join(OUT, 'just-died.png') });

report.push(await STEP('body lies there', () => {
  const g = window.__game;
  const game = g.internals.game;
  g.releaseAll();
  g.run(3);
  const cr = game.get('creatures').list.find((c) => c.dead);
  return cr
    ? { dead: true, phase: cr._death?.phase, roll: +cr.root.rotation.z.toFixed(2),
      count: game.get('creatures').list.length }
    : { dead: false };
}));

await page.screenshot({ timeout: 60000, path: path.join(OUT, 'corpse.png') });

report.push(await STEP('despawn', () => {
  const g = window.__game;
  const game = g.internals.game;
  const before = game.get('creatures').list.length;
  g.run(14);
  const after = game.get('creatures').list;
  const s = g.state();
  return {
    before, after: after.length,
    anyDead: after.some((c) => c.dead),
    creatures: s.creatures.alive + '/' + s.creatures.count,
  };
}));

await page.screenshot({ timeout: 60000, path: path.join(OUT, 'gone.png') });

report.push(await STEP('survivors ok', () => {
  const g = window.__game;
  g.run(6);
  const s = g.state();
  return {
    alive: s.creatures.alive, moving: s.ai?.moving ?? null,
    moods: s.creatures.byMood, errors: s.errors,
  };
}));

await writeFile(path.join(OUT, 'report.json'), JSON.stringify({ report, errors: errs }, null, 2));
console.log('errors:', errs.length ? errs : 'none');
await browser.close();
await server.close();
