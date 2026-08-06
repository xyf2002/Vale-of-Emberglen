#!/usr/bin/env node
/**
 * THROWAWAY. Four close portraits of the avatar — front, three-quarter, behind and a
 * low hero angle — to check the r14 horned helm reads at the framings a player actually
 * gets. The gameplay camera never gets closer than ~2.5 m, so the front/portrait shots
 * here are diagnostic only: they show what the geometry IS, not what ships.
 *
 *   node tools/_helmshot.mjs
 *
 * Writes captures/wip-helm/*.png.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const OUT = path.resolve('captures', 'wip-helm');
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
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message.slice(0, 300)));
await page.goto(`http://127.0.0.1:${port}/?capture=1&seed=20240719`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });

const SETUP = () => {
  const g = window.__game;
  g.setTimeOfDay(0.30);
  g.setCamera(null);
  const s = g.state();
  const px = s.player.pos[0], pz = s.player.pos[2];
  g.place(px, pz, 0);
  g.run(1.5);
  const st = g.state();
  return { px: st.player.pos[0], py: st.player.pos[1], pz: st.player.pos[2] };
};

const SHOT = ({ px, py, pz, dx, dz, dy, dist, aimY, fov }) => {
  const g = window.__game;
  const tx = px + dx * dist, tz = pz + dz * dist, ty = py + dy;
  g.setCamera([tx, ty, tz], [px, py + aimY, pz], fov);
  g.run(0.1);
  return g.stats();
};

const base = await page.evaluate(SETUP);
const shots = [
  ['front', { dx: 0, dz: 1, dy: 1.55, dist: 1.15, aimY: 1.52, fov: 34 }],
  ['threequarter', { dx: 0.72, dz: 0.69, dy: 1.50, dist: 1.30, aimY: 1.48, fov: 36 }],
  ['behind', { dx: 0, dz: -1, dy: 1.62, dist: 1.60, aimY: 1.40, fov: 40 }],
  ['gameplay_behind', { dx: 0.28, dz: -0.96, dy: 1.75, dist: 3.20, aimY: 1.15, fov: 55 }],
  ['hero_low', { dx: 0.55, dz: 0.83, dy: 0.95, dist: 2.20, aimY: 1.25, fov: 42 }],
  ['nape', { dx: 0.12, dz: -0.99, dy: 1.78, dist: 0.85, aimY: 1.58, fov: 32 }],
];
for (const [name, cfg] of shots) {
  const stats = await page.evaluate(SHOT, { ...base, ...cfg });
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log(name, JSON.stringify(stats));
}
console.log('errors', errs.slice(0, 6));

await browser.close();
await server.close();
