#!/usr/bin/env node
/**
 * IS THE CASCADE SPLIT WORTH IT?
 *
 * _groundprobe.mjs answers "how much shadow is in this frame" for ONE build. Round 13
 * needed to compare four shadow rigs, and four separate _groundprobe runs is four cold
 * vite boots, four scene builds and four sets of shader compiles -- about twenty
 * minutes, and none of the four is byte-identical to the others because the world is
 * rebuilt each time. This does all four inside ONE staged frame instead, so the only
 * thing that differs between the numbers is the shadow rig.
 *
 * The configs, all on the same key TOTAL (three's directional lights sum, so moving
 * intensity between the two cascades never changes lit ground):
 *
 *   split      far 250 m box at (1-NEAR_SHARE) + near 45 m box at NEAR_SHARE
 *   far only   far 250 m box at 100%, near cascade not casting
 *   near only  near 45 m box at 100%, far cascade not casting
 *   old box    far cascade shrunk back to 140 m at 100%. NOT quite the r12 rig: this
 *              only resizes the ortho box, it does not re-centre it, so the box stays
 *              where the 250 m focus put it (112 m ahead) rather than r12's 63 m.
 *              tools/_boxsweep.mjs re-centres per size and is the one to trust for that.
 *
 * Reported per config: mean |shadows on - off| over the frame and the darkest 16x16
 * patch, i.e. exactly the two numbers _groundprobe prints, so they are comparable.
 *
 * VERDICT (r13): the split lost. See THE SHADOW BOX in src/sky/index.js. The near
 * cascade was deleted, so this probe now finds ONE shadow-casting light and its
 * "split"/"near only" rows collapse onto "far only". It is kept for the numbers in the
 * header above, not for re-running as-is.
 *
 * Usage: node tools/_cascadesplit.mjs [shot]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { SHOTS } from './shots.mjs';

const shotId = process.argv[2] ?? 'vista_golden';
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

// Nothing below advances the sim, so sky.apply() never runs again and the intensities
// written here are not clobbered.
await page.evaluate(() => {
  const { scene } = window.__game.internals;
  const dirs = [];
  scene.traverse((o) => { if (o.isDirectionalLight && o.castShadow) dirs.push(o); });
  dirs.sort((a, b) => b.shadow.camera.right - a.shadow.camera.right);
  window.__cascades = dirs;
  window.__keyTotal = dirs.reduce((s, d) => s + d.intensity, 0);
  window.__farHalf = dirs[0].shadow.camera.right;
});

const relink = () => page.evaluate(() => {
  const { scene } = window.__game.internals;
  scene.traverse((o) => {
    const m = o.material; if (!m) return;
    (Array.isArray(m) ? m : [m]).forEach((x) => { x.needsUpdate = true; });
  });
});

const configure = (farOn, nearOn, farHalf) => page.evaluate(([f, n, h]) => {
  const [far, near] = window.__cascades;
  const total = window.__keyTotal;
  far.castShadow = f; if (near) near.castShadow = n;
  far.intensity = f ? (n && near ? total * 0.65 : total) : 0;
  if (near) near.intensity = total - far.intensity;
  const c = far.shadow.camera;
  c.left = -h; c.right = h; c.top = h; c.bottom = -h;
  c.updateProjectionMatrix();
  far.shadow.map?.dispose(); far.shadow.map = null;
  if (near) { near.shadow.map?.dispose(); near.shadow.map = null; }
}, [farOn, nearOn, farHalf]);

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

const farHalf = await page.evaluate(() => window.__farHalf);
const CONFIGS = [
  ['split', true, true, farHalf],
  ['far only', true, false, farHalf],
  ['near only', false, true, farHalf],
  ['old box', true, false, 140],
];

console.log(`\n--- shadow rig A/B on ${shotId} (one staged frame, ${farHalf} m far box) ---`);
for (const [label, f, n, h] of CONFIGS) {
  await configure(f, n, h);
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
  console.log(`  ${label.padEnd(10)} mean ${whole.toFixed(3)}/255  (${(whole / 255 * 100).toFixed(2)}%)   darkest patch -${worst.toFixed(1)} at ${at}`);
}

await browser.close();
await server.close();
