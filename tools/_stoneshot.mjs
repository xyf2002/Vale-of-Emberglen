#!/usr/bin/env node
/**
 * THROWAWAY PROBE — a close-up of the stone.
 *
 * The six matched shots frame meadow and creatures; measured against r18, rocks and
 * ruins move 0.3% of the pixels in the widest of them and 0.09% in the narrowest. That
 * is not evidence that the stone is fine, it is evidence that the graded shots cannot
 * see it. This stages a camera on the ruin so the course joints, the cavity occlusion
 * and the specular lobe can be looked at directly.
 *
 *   node tools/_stoneshot.mjs [tag]   ->  captures/_stoneshot/<tag>.png
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const TAG = process.argv[2] || 'now';
const OUT = path.resolve('captures', '_stoneshot');
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
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('  [page err]', m.text().slice(0, 300)); });
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game?.ready === true || window.__game?.ready === 'failed', null, { timeout: 240000 });

const info = await page.evaluate(() => {
  const g = window.__game;
  g.setTimeOfDay(0.34);
  g.setCamera(null);
  // the ruins are the only non-instanced meshes carrying the moss uniform
  const ruins = [];
  g.internals.scene.traverse((o) => {
    if (o.isMesh && !o.isInstancedMesh && o.material?.userData?.moss) ruins.push(o);
  });
  if (!ruins.length) return { error: 'no ruin found' };
  const r = ruins[0];
  const px = r.position.x, pz = r.position.z;
  g.place(px + 11, pz + 9, 0);
  g.run(1.2);
  const s = g.state();
  const y = s.player.pos[1];
  g.setCamera([px + 9.5, y + 2.4, pz + 8.0], [px, y + 2.2, pz], 48);
  g.run(0.4);
  g.render();
  return { at: [+px.toFixed(1), +pz.toFixed(1)], ruins: ruins.length };
});
console.log(JSON.stringify(info));
if (!info.error) {
  const cv = await page.$('#app canvas');
  await writeFile(path.join(OUT, `${TAG}.png`), await cv.screenshot());
  console.log('->', path.join(OUT, `${TAG}.png`));
}
await browser.close();
await server.close();
