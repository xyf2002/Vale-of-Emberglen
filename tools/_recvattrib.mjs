#!/usr/bin/env node
/**
 * THROWAWAY PROBE — WHO RECEIVES?
 *
 * _castattrib.mjs establishes that the trees are in the caster set and that the frustum
 * is not the constraint. The remaining possibility is that the surface the tree shadow
 * lands on is not the surface the camera can see. This asks the receiver-side question:
 *
 *   A  ship
 *   B  grass carpet + clutter hidden entirely (so the meadow FLOOR is what you see)
 *
 * and inside each, diffs trees-cast on/off. If tree shadows only appear once the grass
 * is hidden, the shadow is landing on a floor that nothing in a playable frame can see.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OUT = path.resolve('captures', '_recvattrib');
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

const res = await page.evaluate(() => {
  const g = window.__game;
  const scene = g.internals.scene;
  const cv = document.querySelector('#app canvas');
  const W = cv.width, H = cv.height;
  const s = document.createElement('canvas'); s.width = W; s.height = H;
  const c2 = s.getContext('2d', { willReadFrequently: true });
  const grab = () => { c2.drawImage(cv, 0, 0); return c2.getImageData(0, 0, W, H).data; };
  const png = () => s.toDataURL('image/png');

  const trees = [];
  const grass = [];
  scene.traverse((o) => {
    if (!o.isMesh) return;
    if (o.geometry?.userData?.trunkR !== undefined) { if (o.castShadow) trees.push(o); return; }
    // the carpet + clutter: instanced, receives shadow, is not a tree, not the ground
    if (o.isInstancedMesh && o.name !== 'motes' && o.receiveShadow && o.name !== 'creature-contact-shadows') grass.push(o);
  });

  const out = {};
  const imgs = {};
  const measure = (tag) => {
    g.render();
    const A = grab();
    imgs[`${tag}_full`] = png();
    for (const o of trees) o.castShadow = false;
    g.render();
    const B = grab();
    for (const o of trees) o.castShadow = true;
    let sum = 0, hit = 0;
    const o2 = document.createElement('canvas'); o2.width = W; o2.height = H;
    const oc = o2.getContext('2d');
    const im = oc.createImageData(W, H);
    for (let i = 0; i < A.length; i += 4) {
      let d = 0;
      for (let k = 0; k < 3; k++) { const q = Math.abs(A[i + k] - B[i + k]); if (q > d) d = q; }
      sum += d; if (d > 4) hit++;
      const v = Math.min(255, d * 8);
      im.data[i] = v; im.data[i + 1] = v; im.data[i + 2] = v; im.data[i + 3] = 255;
    }
    oc.putImageData(im, 0, 0);
    imgs[`${tag}_diff`] = o2.toDataURL('image/png');
    out[tag] = { mean: +(sum / (A.length / 4)).toFixed(3), pixels: +(hit / (A.length / 4) * 100).toFixed(2) };
  };

  measure('ship');
  out.grassMeshes = grass.length;
  for (const o of grass) o.visible = false;
  measure('nograss');
  for (const o of grass) o.visible = true;
  return { out, imgs };
});

for (const [k, v] of Object.entries(res.imgs)) {
  await writeFile(path.join(OUT, `${k}.png`), Buffer.from(v.split(',')[1], 'base64'));
}
console.log(JSON.stringify(res.out, null, 1));
await browser.close();
await server.close();
