#!/usr/bin/env node
/** THROWAWAY. What shadow casters exist in the near field, and what does the shadow
 * actually cover, band by band down the frame? */
import { chromium } from 'playwright';
import { createServer } from 'vite';

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

const RUN = () => {
  const g = window.__game;
  g.setTimeOfDay(0.29); g.setCamera(null);
  const s0 = g.state(); g.place(s0.player.pos[0], s0.player.pos[2], 0); g.run(2.2);
  const post = g.internals.game.get('post'); if (post) post.render = undefined;

  const scene = g.internals.scene, cam = g.internals.camera;
  const sky = g.internals.game.get('sky');
  const key = sky.getKeyDirection();

  // --- inventory of casters, and how many land near the camera ------------
  // No THREE in scope (the capture API deliberately exposes only scene/renderer/
  // camera), so transform instance origins by hand: p' = M * p, column-major.
  const xform = (e, x, y, z) => ({
    x: e[0] * x + e[4] * y + e[8] * z + e[12],
    y: e[1] * x + e[5] * y + e[9] * z + e[13],
    z: e[2] * x + e[6] * y + e[10] * z + e[14],
  });
  const rings = [10, 20, 30, 50, 80];
  const near = {};
  for (const r of rings) near[r] = 0;
  const casters = [];
  const im = new Float32Array(16);
  scene.traverse((o) => {
    if (!o.castShadow || !o.isMesh) return;
    o.updateWorldMatrix(true, false);
    const we = o.matrixWorld.elements;
    const perMesh = {};
    for (const r of rings) perMesh[r] = 0;
    if (o.isInstancedMesh) {
      const arr = o.instanceMatrix.array;
      for (let i = 0; i < o.count; i++) {
        const off = i * 16;
        const lx = arr[off + 12], ly = arr[off + 13], lz = arr[off + 14];
        const v = xform(we, lx, ly, lz);
        const d = Math.hypot(v.x - cam.position.x, v.z - cam.position.z);
        for (const r of rings) if (d < r) { perMesh[r]++; near[r]++; }
      }
    } else if (o.name !== 'ground') {
      const d = Math.hypot(we[12] - cam.position.x, we[14] - cam.position.z);
      for (const r of rings) if (d < r) { perMesh[r]++; near[r]++; }
    }
    casters.push({ name: o.name || o.type, instanced: !!o.isInstancedMesh, count: o.count ?? 1, within30: perMesh[30], within80: perMesh[80] });
  });

  // --- shadowed fraction per horizontal band of the frame -----------------
  const cv = document.querySelector('#app canvas');
  const W = 480, H = 270;
  const grab = () => {
    const s = document.createElement('canvas'); s.width = W; s.height = H;
    const c = s.getContext('2d', { willReadFrequently: true });
    c.drawImage(cv, 0, 0, W, H);
    return c.getImageData(0, 0, W, H).data;
  };
  // toggling shadowMap.enabled alone does nothing — the shadow branch is compiled
  // into each program, so every material has to be recompiled for the flag to bite.
  const recompile = () => scene.traverse((o) => {
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.needsUpdate = true; });
  });
  g.render(); const A = grab();
  g.internals.renderer.shadowMap.enabled = false; recompile();
  g.render(); const B = grab();
  g.internals.renderer.shadowMap.enabled = true; recompile();
  const sun = sky.sunLight; const keep = sun.intensity;
  sun.intensity = 0; g.render(); const C = grab();
  sun.intensity = keep;

  const bands = [];
  const NB = 6;
  for (let b = 0; b < NB; b++) {
    const y0 = Math.floor((b / NB) * H), y1 = Math.floor(((b + 1) / NB) * H);
    let diff = 0, pot = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      for (let k = 0; k < 3; k++) { diff += Math.abs(A[i + k] - B[i + k]); pot += Math.abs(B[i + k] - C[i + k]); n++; }
    }
    bands.push({ band: `${b}/${NB} (${b === 0 ? 'top/sky' : b === NB - 1 ? 'bottom/nearest' : ''})`, meanDiff: +(diff / n).toFixed(2), potential: +(pot / n).toFixed(2), frac: +((diff / n) / Math.max(1e-6, pot / n)).toFixed(3) });
  }

  return {
    sunElevDeg: +sky.sunElevationDeg.toFixed(1),
    keyDir: [+key.x.toFixed(2), +key.y.toFixed(2), +key.z.toFixed(2)],
    shadowLengthPerMetre: +(1 / Math.tan(sky.sunElevationDeg * Math.PI / 180)).toFixed(2),
    castingInstancesWithin: near,
    casterMeshes: casters,
    bands,
  };
};
console.log(JSON.stringify(await page.evaluate(`(${RUN.toString()})()`), null, 1));
await browser.close();
await server.close();
