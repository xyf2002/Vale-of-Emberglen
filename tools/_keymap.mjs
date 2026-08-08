#!/usr/bin/env node
/**
 * THROWAWAY PROBE — WHERE IS THE KEY, per pixel?
 *
 * Final step of the r19 "nothing casts a shadow" chain. _castattrib/_treediff/_recvattrib
 * establish that the trees ARE in the shadow map, that the box size is irrelevant and
 * that the grass carpet is not hiding anything. The one remaining explanation is that
 * the surface the shadow lands on has no key on it to remove.
 *
 * Writes captures/_keymap/key.png = |full - sunIntensity 0|, amplified 3x. A black
 * region is a region the sun is not lighting, and therefore a region where no shadow
 * map, of any resolution or extent, can darken a single pixel.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OUT = path.resolve('captures', '_keymap');
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

const r = await page.evaluate(() => {
  const g = window.__game;
  const cv = document.querySelector('#app canvas');
  const W = cv.width, H = cv.height;
  const s = document.createElement('canvas'); s.width = W; s.height = H;
  const c2 = s.getContext('2d', { willReadFrequently: true });
  const grab = () => { c2.drawImage(cv, 0, 0); return c2.getImageData(0, 0, W, H).data; };
  g.render();
  const A = grab();
  const sun = g.internals.game.get('sky').sunLight;
  const keep = sun.intensity;
  sun.intensity = 0;
  g.render();
  const B = grab();
  sun.intensity = keep;
  const o = document.createElement('canvas'); o.width = W; o.height = H;
  const oc = o.getContext('2d');
  const im = oc.createImageData(W, H);
  // region means: the tree-covered hillside crop used by _treediff, and the meadow
  const box = (x0, y0, x1, y1) => {
    let s2 = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4;
      let d = 0; for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(A[i + k] - B[i + k]));
      s2 += d; n++;
    }
    return +(s2 / n).toFixed(2);
  };
  for (let i = 0; i < A.length; i += 4) {
    let d = 0; for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(A[i + k] - B[i + k]));
    const v = Math.min(255, d * 3);
    im.data[i] = v; im.data[i + 1] = v; im.data[i + 2] = v; im.data[i + 3] = 255;
  }
  oc.putImageData(im, 0, 0);
  return {
    png: o.toDataURL('image/png'),
    treeHillside: box(700, 40, 900, 220),
    meadowNear: box(500, 400, 900, 530),
    meadowMid: box(300, 290, 700, 340),
    leftHill: box(20, 120, 200, 260),
  };
});

await writeFile(path.join(OUT, 'key.png'), Buffer.from(r.png.split(',')[1], 'base64'));
delete r.png;
console.log('mean |full - keyOff| by region, units of 255:');
console.log(JSON.stringify(r, null, 1));
await browser.close();
await server.close();
