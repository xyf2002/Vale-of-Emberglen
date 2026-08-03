#!/usr/bin/env node
/** THROWAWAY. Sun direction vs camera direction per shot, plus terrain occlusion along the sun ray. */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { SHOTS } from './shots.mjs';

const server = await createServer({ server: { port: 0, host: '127.0.0.1', strictPort: false }, logLevel: 'error' });
await server.listen();
const port = server.config.server.port ?? server.httpServer.address().port;
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 480, height: 270 } });

const PROBE = () => {
  const T = window.__THREE;
  const g = window.__game.internals;
  const sky = g.game.get('sky');
  const s = sky.getSunDirection();
  const cam = g.camera;
  const f = new T.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
  const fh = new T.Vector3(f.x, 0, f.z).normalize();
  const sh = new T.Vector3(s.x, 0, s.z).normalize();
  const dot = fh.dot(sh);
  const world = g.game.get('world');
  // does the terrain occlude the sun from the player's feet?
  const p = g.game.get('player').position;
  let occludedAt = null;
  const step = 4;
  for (let d = step; d < 700; d += step) {
    const x = p.x + sh.x * d, z = p.z + sh.z * d;
    const h = world.heightAt(x, z);
    if (h > p.y + d * (s.y / Math.hypot(s.x, s.z))) { occludedAt = { d, h: +h.toFixed(1) }; break; }
  }
  return {
    sunElevDeg: +sky.sunElevationDeg.toFixed(1),
    sunAzDeg: +(Math.atan2(sh.z, sh.x) * 180 / Math.PI).toFixed(1),
    camAzDeg: +(Math.atan2(fh.z, fh.x) * 180 / Math.PI).toFixed(1),
    // 180 = sun dead behind camera (flat frontal light); 90 = side light; 0 = backlit
    sunVsCamDeg: +(Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI).toFixed(1),
    behindCamera: dot < -0.5,
    playerPos: [p.x, p.y, p.z].map((v) => +v.toFixed(1)),
    terrainOccludesSun: occludedAt,
  };
};

for (const shot of SHOTS) {
  await page.goto(`http://127.0.0.1:${port}/?capture=1&seed=20240719`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });
  await page.evaluate(`(${shot.setup.toString()})(window.__game)`);
  const r = await page.evaluate(`(${PROBE.toString()})()`);
  console.log(shot.id.padEnd(22), JSON.stringify(r));
}
await browser.close();
await server.close();
