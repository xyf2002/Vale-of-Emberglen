#!/usr/bin/env node
/**
 * Throwaway probe, pass 3: interrogate the AI system's staged props directly.
 *
 * Pass 1 cleared every InstancedMesh (all sunk, negative gaps). Pass 2 raycast the
 * visible floaters in vista_golden and named the culprit: `ai:boulder`, 33.7 m out,
 * 3.87 m of open air under it. src/ai/props.js DOES call `world.heightAt(x, z)` when it
 * places one, so the bug is not a missing ground query — this asks each staged prop
 * where it actually is, and what the terrain under its own origin actually reads.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { SHOTS } from './shots.mjs';

const shot = SHOTS.find((s) => s.id === 'vista_golden');

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
await page.evaluate(() => window.__game.render());

const out = await page.evaluate(() => {
  const { scene, game } = window.__game.internals;
  const world = game.get('world');
  const rows = [];
  scene.traverse((o) => {
    if (!o.name?.startsWith('ai:')) return;
    o.updateWorldMatrix(true, false);
    const wp = new window.THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
    let bbMin = null;
    if (o.geometry) { o.geometry.computeBoundingBox(); bbMin = +o.geometry.boundingBox.min.y.toFixed(2); }
    const h = world.heightAt(wp.x, wp.z);
    rows.push({
      name: o.name,
      local: +o.position.y.toFixed(2),
      worldY: +wp.y.toFixed(2),
      parent: o.parent?.name || o.parent?.type,
      parentY: +(o.parent?.position?.y ?? 0).toFixed(2),
      heightAt: +h.toFixed(2),
      gap: +(wp.y - h).toFixed(2),
      bbMin,
      bottom: bbMin === null ? null : +(wp.y + bbMin - h).toFixed(2),
    });
  });
  return rows;
});

const bad = out.filter((r) => (r.bottom ?? r.gap) > 0.25);
console.log(`${out.length} ai: props staged, ${bad.length} with their LOWEST vertex above ground\n`);
console.log('name           worldY  heightAt    gap   bbMin  bottomVsGround  parent');
for (const r of out) {
  const flag = (r.bottom ?? r.gap) > 0.25 ? '   ** FLOATING' : '';
  console.log(`${r.name.padEnd(14)}${String(r.worldY).padStart(7)}${String(r.heightAt).padStart(10)}${String(r.gap).padStart(7)}${String(r.bbMin).padStart(8)}${String(r.bottom).padStart(16)}  ${r.parent}${flag}`);
}

await browser.close();
await server.close();
