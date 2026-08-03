#!/usr/bin/env node
/** THROWAWAY. Writes the shadows-on / shadows-off difference image. */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OUT = path.resolve('captures', '_shadowviz');
await mkdir(OUT, { recursive: true });

const server = await createServer({ server: { port: 0, host: '127.0.0.1', strictPort: false }, logLevel: 'error' });
await server.listen();
const port = server.config.server.port ?? server.httpServer.address().port;
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('  [page err]', m.text().slice(0, 300)); });

const SETUP = (shot) => {
  const g = window.__game;
  if (shot === 'over') {
    g.setTimeOfDay(0.29); g.setCamera(null);
    const s0 = g.state(); g.place(s0.player.pos[0], s0.player.pos[2], 0); g.run(2.2);
  } else {
    g.setTimeOfDay(0.60); g.setCamera(null); g.run(1.5);
    const s = g.state(); const [x, y, z] = s.player.pos;
    g.setCamera([x - 5, y + 1.7, z + 7], [x + 34, y + 3.5, z - 46], 62);
    g.run(0.6);
  }
};

const DIFF = (noPost, box) => {
  const g = window.__game;
  if (box) {
    const sun = g.internals.game.get('sky').sunLight;
    sun.shadow.camera.left = -box; sun.shadow.camera.right = box;
    sun.shadow.camera.top = box; sun.shadow.camera.bottom = -box;
    sun.shadow.camera.updateProjectionMatrix();
    g.internals.game.get('sky').setTimeOfDay(g.internals.game.get('sky').timeOfDay);
  }
  if (noPost) { const p = g.internals.game.get('post'); if (p) p.render = undefined; }
  const cv = document.querySelector('#app canvas');
  const W = cv.width, H = cv.height;
  const grab = () => {
    const s = document.createElement('canvas'); s.width = W; s.height = H;
    const c = s.getContext('2d', { willReadFrequently: true });
    c.drawImage(cv, 0, 0);
    return c.getImageData(0, 0, W, H);
  };
  g.render();
  const A = grab();
  g.internals.renderer.shadowMap.enabled = false;
  g.internals.scene.traverse((o) => { if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.needsUpdate = true; }); });
  g.render();
  const B = grab();
  const a = A.data, b = B.data;
  let sum = 0, max = 0, n = 0;
  const out = document.createElement('canvas'); out.width = W; out.height = H;
  const oc = out.getContext('2d');
  const img = oc.createImageData(W, H);
  for (let i = 0; i < a.length; i += 4) {
    let d = 0;
    for (let k = 0; k < 3; k++) { const q = Math.abs(a[i + k] - b[i + k]); sum += q; n++; if (q > max) max = q; if (q > d) d = q; }
    const v = Math.min(255, d * 6);
    img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = 255;
  }
  oc.putImageData(img, 0, 0);
  // calibration: what the frame would look like with NO key at all. mean|B - keyoff|
  // is the largest diff a 100%-shadowed frame could possibly produce, so
  // meanAbs / potential = the effective fraction of the frame that is in shadow.
  const sun = g.internals.game.get('sky').sunLight;
  const keep = sun.intensity;
  sun.intensity = 0;
  g.render();
  const C = grab().data;
  sun.intensity = keep;
  let s2 = 0, n2 = 0;
  for (let i = 0; i < b.length; i += 4) for (let k = 0; k < 3; k++) { s2 += Math.abs(b[i + k] - C[i + k]); n2++; }
  const potential = s2 / n2;
  return {
    meanAbs: +(sum / n).toFixed(3), max, potential: +potential.toFixed(2),
    shadowedFraction: +((sum / n) / Math.max(1e-6, potential)).toFixed(4),
    png: out.toDataURL('image/png'),
  };
};

const BOXES = (process.env.BOXES ?? '0').split(',').map(Number);
for (const shot of ['over', 'vista']) {
  for (const box of BOXES) {
    for (const noPost of [false, true]) {
      await page.goto(`http://127.0.0.1:${port}/?capture=1&seed=20240719`, { waitUntil: 'load', timeout: 120000 });
      await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });
      await page.evaluate(`(${SETUP.toString()})(${JSON.stringify(shot)})`);
      const r = await page.evaluate(`(${DIFF.toString()})(${noPost}, ${box})`);
      await writeFile(path.join(OUT, `diff_${shot}_${box}_${noPost ? 'nopost' : 'post'}.png`), Buffer.from(r.png.split(',')[1], 'base64'));
      console.log(`${shot.padEnd(6)} box=${String(box).padStart(4)} post=${!noPost}  meanAbs=${r.meanAbs}  max=${r.max}  keyOffPotential=${r.potential}  effShadowFrac=${r.shadowedFraction}`);
    }
  }
}
await browser.close();
await server.close();
