#!/usr/bin/env node
/**
 * REACH vs TEXEL: a single shadow box swept across half-sizes at a FIXED map size.
 *
 * _cascadesplit.mjs measured four rigs and produced a result nobody expected: widening
 * the far box from 140 m to 250 m changed vista_golden's shadow contribution by 0.009
 * out of 255 (noise), while the 45 m box -- one ninth the area, at 4.4 cm/texel instead
 * of 12.2 -- beat BOTH of them on creature_group by 12%. Reach bought nothing; texels
 * bought everything. This sweeps the one axis that finding points at.
 *
 * Every configuration uses the same 4096 map and the same 100% key, so half-size is
 * simultaneously the reach (0.45*S + S metres down the view axis) and the texel
 * (2S/4096 metres). The box is RE-CENTRED for each size the way sky/index.js centres it
 * -- 45% of a half-size ahead of the camera along its forward vector -- because leaving
 * the centre where a different size put it silently measures a different rig.
 *
 * Each entry is `S` or `S:normalBias`. normalBias turned out to matter as much as either
 * of the other two axes: a 60 m box at 2.9 cm/texel with normalBias 0.12 scored 1.227 on
 * creature_group while a SMALLER 45 m box at a COARSER 4.4 cm with normalBias 0.05
 * scored 1.643. normalBias is a world-space push along the surface normal, so at 12 cm it
 * erodes a 60 cm creature's contact shadow by a fifth of its width from every side no
 * matter how many texels the map has.
 *
 * Usage: node tools/_boxsweep.mjs <shot> [S[:normalBias],...]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { SHOTS } from './shots.mjs';

const shotId = process.argv[2] ?? 'vista_golden';
const HALVES = (process.argv[3] ?? '60,90,120,140,250').split(',').map((t) => {
  const [s, nb] = t.split(':');
  return { half: Number(s), nb: nb === undefined ? null : Number(nb) };
});
const shot = SHOTS.find((s) => s.id === shotId);

const server = await createServer({
  server: { port: 0, host: '127.0.0.1', strictPort: false, hmr: false, watch: null },
  logLevel: 'error',
});
await server.listen();
const port = server.config.server.port ?? server.httpServer.address().port;
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 200)));
await page.goto(`http://127.0.0.1:${port}/?capture=1&seed=20240719`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });
await page.evaluate(`(${shot.setup.toString()})(window.__game)`);

await page.evaluate(() => {
  const { scene } = window.__game.internals;
  const dirs = [];
  scene.traverse((o) => { if (o.isDirectionalLight && o.castShadow) dirs.push(o); });
  dirs.sort((a, b) => b.shadow.camera.right - a.shadow.camera.right);
  window.__cascades = dirs;
  window.__keyTotal = dirs.reduce((s, d) => s + d.intensity, 0);
  const far = dirs[0];
  // light direction and stand-off distance, recovered from the rig as it stands
  const d = far.position.clone().sub(far.target.position);
  window.__dist = d.length();
  window.__dir = d.normalize();
  window.__targetY = far.target.position.y;
});

const configure = (half, nb) => page.evaluate(([h, b]) => {
  const [far, near] = window.__cascades;
  far.castShadow = true; far.intensity = window.__keyTotal;
  if (near) { near.castShadow = false; near.intensity = 0; }
  if (b !== null) far.shadow.normalBias = b;
  const c = far.shadow.camera;
  c.left = -h; c.right = h; c.top = h; c.bottom = -h;
  c.updateProjectionMatrix();
  far.shadow.map?.dispose(); far.shadow.map = null;
  // re-centre exactly as focusForCamera does: 45% of a half-size ahead, horizontally
  const cam = window.__game.internals.camera;
  const e = cam.matrixWorld.elements;
  let fx = -e[8], fz = -e[10];
  const L = Math.hypot(fx, fz) || 1; fx /= L; fz /= L;
  const ahead = h * 0.45;
  far.target.position.set(cam.position.x + fx * ahead, window.__targetY, cam.position.z + fz * ahead);
  far.target.updateMatrixWorld();
  far.position.copy(far.target.position).addScaledVector(window.__dir, window.__dist);
  far.updateMatrixWorld();
}, [half, nb]);

const relink = () => page.evaluate(() => {
  const { scene } = window.__game.internals;
  scene.traverse((o) => {
    const m = o.material; if (!m) return;
    (Array.isArray(m) ? m : [m]).forEach((x) => { x.needsUpdate = true; });
  });
});
const grab = () => page.evaluate(() => {
  window.__game.render();
  const cv = document.querySelector('#app canvas');
  const c = document.createElement('canvas');
  c.width = cv.width; c.height = cv.height;
  c.getContext('2d').drawImage(cv, 0, 0);
  return Array.from(c.getContext('2d').getImageData(0, 0, cv.width, cv.height).data);
});
const setShadows = (on) => page.evaluate((v) => {
  window.__game.internals.renderer.shadowMap.enabled = v;
}, on).then(relink);

const W = 1280, H = 720;
const lum = (a, i) => 0.2126 * a[i] + 0.7152 * a[i + 1] + 0.0722 * a[i + 2];
const patch = (a, x0, y0) => {
  let s = 0;
  for (let y = y0; y < y0 + 16; y++) for (let x = x0; x < x0 + 16; x++) s += lum(a, (y * W + x) * 4);
  return s / 256;
};

const mapSize = await page.evaluate(() => window.__cascades[0].shadow.mapSize.x);
console.log(`\n--- single-box sweep on ${shotId} (map ${mapSize}, 100% key) -------------`);
const baseNB = await page.evaluate(() => window.__cascades[0].shadow.normalBias);
for (const { half: h, nb } of HALVES) {
  await configure(h, nb);
  await setShadows(true);
  const on = await grab();
  await setShadows(false);
  const off = await grab();
  let whole = 0, worst = 0, at = null;
  for (let i = 0; i < on.length; i += 4) whole += Math.abs(lum(on, i) - lum(off, i));
  whole /= (on.length / 4);
  for (let y = 0; y + 16 <= H; y += 16) {
    for (let x = 0; x + 16 <= W; x += 16) {
      const d = patch(off, x, y) - patch(on, x, y);
      if (d > worst) { worst = d; at = [x, y]; }
    }
  }
  console.log(`  S=${String(h).padStart(3)}m  reach ${String(Math.round(h * 1.45)).padStart(3)}m  texel ${(h * 2 / mapSize * 100).toFixed(1).padStart(4)}cm  nBias ${(nb ?? baseNB).toFixed(2)}   mean ${whole.toFixed(3)}/255   darkest -${worst.toFixed(1)} at ${at}`);
}

await browser.close();
await server.close();
