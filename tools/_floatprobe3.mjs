#!/usr/bin/env node
/**
 * Throwaway probe, pass 4: stop reasoning about who owns the floating rocks and just
 * switch each candidate off.
 *
 * Passes 1-3 gave contradictory answers — no InstancedMesh floats, all 7 `ai:` props sit
 * with their lowest vertex on or under the ground, yet a ray through a visibly airborne
 * rock reports it hit `ai:boulder` 3.87 m above the terrain. When object-space bookkeeping
 * disagrees with the rendered frame, believe the frame. This hides one group at a time,
 * re-renders the identical camera, and writes the crops out for a look.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir } from 'node:fs/promises';
import { SHOTS } from './shots.mjs';

const shot = SHOTS.find((s) => s.id === 'vista_golden');
const OUT = '/tmp/claude-1000/-home-xyf-game-RPG/260c7331-1ecb-448f-b7fd-8db6869c2c87/scratchpad/hide';
await mkdir(OUT, { recursive: true });

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

// Same camera every time. Setup runs once; hiding does not disturb it.
await page.evaluate(`(${shot.setup.toString()})(window.__game)`);

const CASES = [
  ['all', () => false],
  ['no_ai_props', (o) => !!o.name?.startsWith('ai:')],
  ['no_rocks_channel', (o) => o.userData?.channel === 'rocks' || o.parent?.name === 'rocks'],
  ['no_clutter', (o) => o.parent?.name === 'clutter'],
  ['no_instanced', (o) => !!o.isInstancedMesh],
  ['no_plain_mesh', (o) => !!(o.isMesh && !o.isInstancedMesh && o.name !== 'ground')],
];

for (const [label, pred] of CASES) {
  await page.evaluate((src) => {
    const { scene } = window.__game.internals;
    const fn = eval(`(${src})`);
    scene.traverse((o) => {
      if (o.userData.__probeHidden) { o.visible = true; delete o.userData.__probeHidden; }
    });
    scene.traverse((o) => {
      if (o !== scene && fn(o)) { o.visible = false; o.userData.__probeHidden = true; }
    });
  }, pred.toString());
  await page.evaluate(() => window.__game.render());
  await page.screenshot({ path: `${OUT}/${label}.png`, animations: 'disabled', timeout: 120000 });
  const n = await page.evaluate(() => {
    let n = 0; window.__game.internals.scene.traverse((o) => { if (o.userData.__probeHidden) n++; });
    return n;
  });
  console.log(`${label.padEnd(18)} hid ${n} object(s)`);
}

await browser.close();
await server.close();
