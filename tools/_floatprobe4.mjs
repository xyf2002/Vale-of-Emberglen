#!/usr/bin/env node
/**
 * Throwaway probe, pass 5: the same instance sweep as pass 1, but in WORLD space.
 *
 * Pass 1 read `instanceMatrix` and reported every rock channel correctly sunk. Pass 4
 * then hid groups one at a time and proved the big moss-topped floater vanishes with
 * `no_instanced` — so an instance IS floating while its own matrix says it is grounded.
 * The gap between those two facts is the ancestor chain: pass 1 never multiplied by
 * `matrixWorld`, so any parent Group carrying a Y offset was invisible to it.
 *
 * Reports the offending channel and prints the ancestor chain with each node's position.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

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
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 200)));
await page.goto(`http://127.0.0.1:${port}/?capture=1&seed=20240719`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });

const out = await page.evaluate(() => {
  const THREE = window.THREE;
  const { scene, game } = window.__game.internals;
  const world = game.get('world');
  scene.updateMatrixWorld(true);
  const rows = [];
  const m = new THREE.Matrix4();
  const v = new THREE.Vector3();
  scene.traverse((o) => {
    if (!o.isInstancedMesh || !o.count) return;
    const chain = [];
    for (let p = o; p && p !== scene; p = p.parent) {
      chain.push(`${p.name || p.type}@y=${p.position.y.toFixed(2)}`);
    }
    let worst = null, floating = 0, sum = 0;
    const n = Math.min(o.count, 4000);
    for (let i = 0; i < n; i++) {
      o.getMatrixAt(i, m);
      m.premultiply(o.matrixWorld);
      v.setFromMatrixPosition(m);
      const s = Math.hypot(m.elements[0], m.elements[1], m.elements[2]);
      const gap = v.y - world.heightAt(v.x, v.z);
      sum += gap;
      if (gap > Math.max(0.5, s * 0.9)) floating++;
      if (!worst || gap > worst.gap) worst = { gap: +gap.toFixed(2), s: +s.toFixed(2), at: [Math.round(v.x), Math.round(v.z)], y: +v.y.toFixed(2) };
    }
    rows.push({ chain: chain.join(' < '), count: o.count, meanGap: +(sum / n).toFixed(2), floating, worst });
  });
  return rows;
});

const bad = out.filter((r) => r.floating > 0);
console.log(`${out.length} instanced channels, ${bad.length} with floating instances (world space)\n`);
for (const r of bad) {
  console.log(`${r.chain}`);
  console.log(`    n=${r.count} meanGap=${r.meanGap} floating=${r.floating}  worst gap ${r.worst.gap} (scale ${r.worst.s}) at ${r.worst.at} y=${r.worst.y}`);
}

await browser.close();
await server.close();
