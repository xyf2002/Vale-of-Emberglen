#!/usr/bin/env node
/** THROWAWAY. Dumps the shadow map and a key-light-only render so the failure is visible. */
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
await page.goto(`http://127.0.0.1:${port}/?capture=1&seed=20240719`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });

await page.evaluate(() => {
  const g = window.__game;
  g.setTimeOfDay(0.29);
  g.setCamera(null);
  const s0 = g.state();
  g.place(s0.player.pos[0], s0.player.pos[2], 0);
  g.run(2.2);
});

// ---- 1. what actually renders into the shadow map -------------------------
const casters = await page.evaluate(() => {
  const T = window.__THREE;
  const g = window.__game.internals;
  const sun = g.game.get('sky').sunLight;
  const cam = sun.shadow.camera;
  cam.updateMatrixWorld();
  const proj = new T.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  const frustum = new T.Frustum().setFromProjectionMatrix(proj);
  const out = [];
  g.scene.traverse((o) => {
    if (!o.isMesh || !o.castShadow) return;
    if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
    const sph = (o.boundingSphere ?? o.geometry.boundingSphere).clone();
    sph.applyMatrix4(o.matrixWorld);
    out.push({
      name: o.name || o.type, instanced: !!o.isInstancedMesh, count: o.count ?? null,
      center: [sph.center.x, sph.center.y, sph.center.z].map((v) => +v.toFixed(1)),
      radius: +sph.radius.toFixed(1),
      inFrustum: frustum.intersectsSphere(sph),
    });
  });
  return out;
});
console.log('\n=== SHADOW CASTERS ===');
for (const c of casters) console.log(` ${c.inFrustum ? 'IN ' : 'out'} ${String(c.name).padEnd(24)} inst=${c.instanced} n=${c.count} r=${c.radius} c=${c.center}`);

// ---- 2. shadow map as an image -------------------------------------------
const smapPng = await page.evaluate(() => {
  const g = window.__game.internals;
  const sun = g.game.get('sky').sunLight;
  const rt = sun.shadow.map;
  const W = rt.width, H = rt.height;
  const buf = new Uint8Array(W * H * 4);
  g.renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const c = cv.getContext('2d');
  const img = c.createImageData(W, H);
  for (let i = 0, p = 0; i < buf.length; i += 4, p += 4) {
    const d = buf[i] * (1 / 255) + buf[i + 1] * (1 / 65025) + buf[i + 2] * (1 / 16581375) + buf[i + 3] * (1 / 4228250625);
    // stretch 0.3..0.7 so the interesting band is visible; far plane -> white
    const v = d > 0.999 ? 255 : Math.max(0, Math.min(254, Math.round((d - 0.30) / 0.40 * 254)));
    // flip vertically (GL origin bottom-left)
    const y = H - 1 - Math.floor(i / 4 / W), x = (i / 4) % W;
    const o = (y * W + x) * 4;
    img.data[o] = v; img.data[o + 1] = v; img.data[o + 2] = v; img.data[o + 3] = 255;
  }
  c.putImageData(img, 0, 0);
  return cv.toDataURL('image/png');
});
await writeFile(path.join(OUT, 'shadowmap.png'), Buffer.from(smapPng.split(',')[1], 'base64'));

// ---- 3. key-light-only render (ambient killed) ---------------------------
await page.evaluate(() => {
  const g = window.__game.internals;
  g.scene.traverse((o) => { if (o.isHemisphereLight || o.isAmbientLight) o.intensity = 0.0; });
  g.scene.environmentIntensity = 0.0;
  window.__game.render();
});
await page.screenshot({ path: path.join(OUT, 'keyonly_shadows_on.png'), timeout: 120000 });
await page.evaluate(() => {
  const g = window.__game.internals;
  g.renderer.shadowMap.enabled = false;
  g.scene.traverse((o) => { if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.needsUpdate = true; }); });
  window.__game.render();
});
await page.screenshot({ path: path.join(OUT, 'keyonly_shadows_off.png'), timeout: 120000 });

console.log('\nwrote', OUT);
await browser.close();
await server.close();
