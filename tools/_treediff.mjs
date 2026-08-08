#!/usr/bin/env node
/**
 * THROWAWAY PROBE — where do the tree shadows actually land?
 *
 * Companion to _castattrib.mjs. Writes captures/_treediff/{full,treesoff,diff}.png for
 * the staged vista shot, plus the same triple with the shadow box widened, so the
 * "trees are outside the frustum" hypothesis can be looked at rather than argued about.
 * diff is |full - treesoff| amplified 8x.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OUT = path.resolve('captures', '_treediff');
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
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('  [page err]', m.text().slice(0, 300)); });
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game?.ready === true || window.__game?.ready === 'failed', null, { timeout: 240000 });

await page.evaluate(() => {
  const g = window.__game;
  g.setTimeOfDay(0.60); g.setCamera(null); g.run(1.5);
  const s = g.state(); const [x, y, z] = s.player.pos;
  g.setCamera([x - 5, y + 1.7, z + 7], [x + 34, y + 3.5, z - 46], 62);
  g.run(0.6);
});

for (const box of [0, 90, 400]) {
  const shots = await page.evaluate((boxHalf) => {
    const g = window.__game;
    const scene = g.internals.scene;
    const sky = g.internals.game.get('sky');
    if (boxHalf) {
      const c = sky.sunLight.shadow.camera;
      c.left = -boxHalf; c.right = boxHalf; c.top = boxHalf; c.bottom = -boxHalf;
      c.updateProjectionMatrix();
      sky.sunLight.shadow.map = null;
    }
    const trees = [];
    scene.traverse((o) => { if (o.isMesh && o.castShadow && o.geometry?.userData?.trunkR !== undefined) trees.push(o); });
    const cv = document.querySelector('#app canvas');
    const W = cv.width, H = cv.height;
    const s = document.createElement('canvas'); s.width = W; s.height = H;
    const c2 = s.getContext('2d', { willReadFrequently: true });
    const grab = () => { c2.drawImage(cv, 0, 0); return c2.getImageData(0, 0, W, H); };
    const png = () => s.toDataURL('image/png');

    g.render();
    const A = grab();
    const full = png();
    for (const o of trees) o.castShadow = false;
    g.render();
    const B = grab();
    const off = png();
    for (const o of trees) o.castShadow = true;

    const out = document.createElement('canvas'); out.width = W; out.height = H;
    const oc = out.getContext('2d');
    const img = oc.createImageData(W, H);
    let hit = 0, sum = 0;
    for (let i = 0; i < A.data.length; i += 4) {
      let d = 0;
      for (let k = 0; k < 3; k++) { const q = Math.abs(A.data[i + k] - B.data[i + k]); if (q > d) d = q; }
      sum += d; if (d > 4) hit++;
      const v = Math.min(255, d * 8);
      img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = 255;
    }
    oc.putImageData(img, 0, 0);
    return { full, off, diff: out.toDataURL('image/png'), mean: +(sum / (A.data.length / 4)).toFixed(3), pixels: +(hit / (A.data.length / 4) * 100).toFixed(2) };
  }, box);
  const tag = box ? `box${box}` : 'ship';
  for (const k of ['full', 'off', 'diff']) {
    await writeFile(path.join(OUT, `${tag}_${k}.png`), Buffer.from(shots[k].split(',')[1], 'base64'));
  }
  console.log(`${tag}: tree-shadow mean ${shots.mean}/255, pixels touched ${shots.pixels}%`);
}

await browser.close();
await server.close();
