#!/usr/bin/env node
/**
 * Throwaway probe: are props actually sitting on the ground?
 *
 * Every r12 frame shows boulders hanging in mid-air, yet createRocks() places each
 * instance at `T.heightAt(x, z)`.
 *
 * MEASURED, pass 1: no InstancedMesh floats. Every rock/clutter/grass channel reports a
 * NEGATIVE mean gap (instances are sunk, as authored); the only positive gaps are the
 * `motes` firefly channel, which is meant to hang in the air. So the placement code is
 * innocent and `heightAt` agrees with itself.
 *
 * Pass 2 therefore stops trusting `heightAt` and asks the RENDERED scene instead: stage
 * the vista_golden camera, raycast through the screen pixels where a rock visibly hangs,
 * and compare the hit against both `heightAt` under it and against a second ray fired
 * straight down from the hit to find the real terrain surface.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { SHOTS } from './shots.mjs';

const shot = SHOTS.find((s) => s.id === 'vista_golden');

// screen pixels (in the 1280x720 capture) where a rock is visibly airborne
const PIXELS = [[580, 340], [690, 325], [860, 338], [1075, 315], [143, 545]];

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

const out = await page.evaluate((pixels) => {
  const THREE = window.THREE;
  const { scene, camera, game } = window.__game.internals;
  const world = game.get('world');
  const rc = new THREE.Raycaster();
  // Sprites (the firefly motes) throw unless Raycaster.camera is set, and setting it did
  // not take — so raycast an explicit list of solid geometry instead. We want the ground
  // and the rocks, not the particles, anyway.
  const solids = [];
  scene.traverse((o) => { if ((o.isMesh || o.isInstancedMesh) && o.visible) solids.push(o); });
  const cast = (r) => r.intersectObjects(solids, false);
  const res = [];
  for (const [px, py] of pixels) {
    const ndc = new THREE.Vector2((px / 1280) * 2 - 1, -(py / 720) * 2 + 1);
    rc.setFromCamera(ndc, camera);
    const hits = cast(rc);
    if (!hits.length) { res.push({ px, py, miss: true }); continue; }
    const h = hits[0];
    const p = h.point;
    // second ray: straight down from just above the hit, to find what is really under it
    const down = new THREE.Raycaster(new THREE.Vector3(p.x, p.y + 0.2, p.z), new THREE.Vector3(0, -1, 0));
    const below = cast(down).filter((b) => b.distance > 0.01);
    res.push({
      px, py,
      hit: h.object.name || (h.object.isInstancedMesh ? `instanced(${h.object.count})` : h.object.type),
      parent: h.object.parent?.name || '?',
      instanceId: h.instanceId ?? null,
      dist: +h.distance.toFixed(1),
      point: [+p.x.toFixed(1), +p.y.toFixed(2), +p.z.toFixed(1)],
      heightAt: +world.heightAt(p.x, p.z).toFixed(2),
      gapVsHeightAt: +(p.y - world.heightAt(p.x, p.z)).toFixed(2),
      firstThingBelow: below.length
        ? { what: below[0].object.name || below[0].object.parent?.name || below[0].object.type, drop: +below[0].distance.toFixed(2) }
        : 'NOTHING BELOW — open air all the way down',
    });
  }
  return res;
}, PIXELS);

for (const r of out) {
  if (r.miss) { console.log(`px ${r.px},${r.py}  -> no hit`); continue; }
  console.log(`px ${String(r.px).padStart(4)},${String(r.py).padStart(3)} -> ${r.parent}/${r.hit} inst=${r.instanceId} dist=${r.dist}m`);
  console.log(`      world point ${r.point}   heightAt=${r.heightAt}   gap=${r.gapVsHeightAt}`);
  console.log(`      below: ${JSON.stringify(r.firstThingBelow)}`);
}

await browser.close();
await server.close();
