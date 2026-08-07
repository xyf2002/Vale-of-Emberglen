#!/usr/bin/env node
/**
 * THROWAWAY. The sphere in the hand, and the throw.
 *
 * Two complaints being checked: the sphere was too big, and holding/throwing it looked
 * wrong. So this measures the sphere's actual world radius, the distance from the right
 * wrist to the sphere (it should be IN the hand, not floating near it), and walks the
 * throw frame by frame so the release can be read off rather than guessed at.
 *
 *   node tools/_spherehold.mjs
 *
 * Writes captures/wip-sphere/*.png and report.json.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OUT = path.resolve('captures', 'wip-sphere');
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

const STEP = async (label, fn) => {
  const r = await page.evaluate(fn);
  console.log(label.padEnd(16), JSON.stringify(r));
  return { label, ...r };
};

/** the held sphere's group and the avatar's right wrist, by name, out of the live scene */
const HANDS = `(() => {
  const g = window.__game, THREE = window.__THREE;
  const scene = g.internals.scene;
  let hand = null;
  scene.traverse((o) => { if (o.name === 'handR') hand = o; });
  const sph = g.internals.game.get('spheres');
  return { hand, sph, THREE };
})()`;

const report = [];

report.push(await STEP('carry', () => {
  const g = window.__game, THREE = window.__THREE;
  g.setTimeOfDay(0.35); g.releaseAll(); g.setCamera(null);
  g.tap('slot2');                       // bond sphere
  g.run(1.6);
  const scene = g.internals.scene;
  let hand = null; const spheres = [];
  scene.traverse((o) => {
    if (o.name === 'handR') hand = o;
    if (o.name === 'bond_sphere' && o.visible) spheres.push(o);
  });
  const wrist = new THREE.Vector3(); hand.getWorldPosition(wrist);
  // the held one is whichever visible sphere is nearest the hand
  let held = null, bd = Infinity;
  for (const o of spheres) { const d = wrist.distanceTo(o.position); if (d < bd) { bd = d; held = o; } }
  const box = held ? new THREE.Box3().setFromObject(held) : null;
  const s = g.state();
  return {
    equipped: s.loadout.equipped,
    spheres: s.spheres.count,
    wristToSphere: held ? +bd.toFixed(3) : null,
    acrossM: box ? +(box.max.x - box.min.x).toFixed(3) : null,
    tallM: box ? +(box.max.y - box.min.y).toFixed(3) : null,
  };
}));


await page.screenshot({ timeout: 60000, path: path.join(OUT, 'carry.png') });

report.push(await STEP('aim', () => {
  const g = window.__game;
  g.hold('aim', true);
  g.run(0.9);
  return { aiming: g.state().spheres.aiming ?? null };
}));

await page.screenshot({ timeout: 60000, path: path.join(OUT, 'aim.png') });

// The throw, frame by frame: 0.45 s of gesture at 60 Hz. Screenshot at the cock-back and
// at the release so both halves of the animation can be looked at, not just believed.
report.push(await STEP('throw: press', () => {
  const g = window.__game;
  g.tap('throw');
  g.run(0.12);                 // deep in the cock-back (gesture ~0.27 of 0.45 s)
  const s = g.state();
  return { gesture: s.player.gesture, inFlight: s.spheres.inFlight ?? null };
}));
await page.screenshot({ timeout: 60000, path: path.join(OUT, 'cock.png') });

report.push(await STEP('throw: release', () => {
  const g = window.__game;
  g.run(0.06);                 // T.windup is 0.17 s: this lands right at release
  const s = g.state();
  return { gesture: s.player.gesture, inFlight: s.spheres.inFlight ?? null, left: s.spheres.count };
}));
await page.screenshot({ timeout: 60000, path: path.join(OUT, 'release.png') });

report.push(await STEP('follow through', () => {
  const g = window.__game;
  g.run(0.22);
  const s = g.state();
  return { gesture: s.player.gesture, inFlight: s.spheres.inFlight ?? null };
}));
await page.screenshot({ timeout: 60000, path: path.join(OUT, 'follow.png') });

report.push(await STEP('settled', () => {
  const g = window.__game;
  g.hold('aim', false);
  g.run(2.5);
  const s = g.state();
  return { gesture: s.player.gesture, count: s.spheres.count, errors: s.errors };
}));

await writeFile(path.join(OUT, 'report.json'), JSON.stringify({ report, errors: errs }, null, 2));
console.log('errors:', errs.length ? errs : 'none');
await browser.close();
await server.close();
