#!/usr/bin/env node
/**
 * Throwaway probe, pass 6: name the floater by projection instead of by inference.
 *
 * The forensic trail so far, all measured:
 *   pass 1  instance-local sweep      -> nothing floats but the motes
 *   pass 2  raycast the floater pixel -> hits `ai:boulder`, 3.87 m of air under it
 *   pass 3  every `ai:` prop's bbox   -> all 7 grounded, lowest vertex on/under terrain
 *   pass 4  hide one group at a time  -> the big moss floater dies with `no_instanced`
 *   pass 5  world-space sweep         -> still nothing but motes and one 1.2 m channel
 *
 * Object-space bookkeeping and the rendered frame have now disagreed five times, so this
 * asks the only question that cannot be argued with: of every instance in the scene,
 * which ones PROJECT onto the pixels where a rock is visibly hanging in the air?
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { SHOTS } from './shots.mjs';

const shot = SHOTS.find((s) => s.id === 'vista_golden');
const TARGET = [695, 340];   // centre of the big moss-topped floater, 1280x720
const RADIUS = 45;

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

const out = await page.evaluate(({ target, radius }) => {
  const THREE = window.THREE;
  const { scene, camera, game } = window.__game.internals;
  const world = game.get('world');
  scene.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);
  const m = new THREE.Matrix4(), v = new THREE.Vector3();
  const hits = [];

  const record = (label, wx, wy, wz, s, extra) => {
    v.set(wx, wy, wz).project(camera);
    if (v.z > 1) return;
    const px = (v.x * 0.5 + 0.5) * 1280, py = (-v.y * 0.5 + 0.5) * 720;
    const d = Math.hypot(px - target[0], py - target[1]);
    if (d > radius) return;
    hits.push({
      label, screen: [Math.round(px), Math.round(py)], off: +d.toFixed(0),
      world: [+wx.toFixed(1), +wy.toFixed(2), +wz.toFixed(1)],
      scale: +s.toFixed(2),
      heightAt: +world.heightAt(wx, wz).toFixed(2),
      gap: +(wy - world.heightAt(wx, wz)).toFixed(2),
      dist: +camera.position.distanceTo(new THREE.Vector3(wx, wy, wz)).toFixed(1),
      ...extra,
    });
  };

  scene.traverse((o) => {
    if (!o.visible) return;
    const chain = [];
    for (let p = o; p && p !== scene; p = p.parent) chain.push(p.name || p.type);
    const label = chain.reverse().join('/');
    if (o.isInstancedMesh) {
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, m); m.premultiply(o.matrixWorld);
        const s = Math.hypot(m.elements[0], m.elements[1], m.elements[2]);
        record(`${label}#${i}`, m.elements[12], m.elements[13], m.elements[14], s, { kind: 'instance' });
      }
    } else if (o.isMesh) {
      o.getWorldPosition(v);
      const wx = v.x, wy = v.y, wz = v.z;
      record(label, wx, wy, wz, o.scale.x, { kind: 'mesh' });
    }
  });
  hits.sort((a, b) => a.off - b.off);
  return hits.slice(0, 14);
}, { target: TARGET, radius: RADIUS });

console.log(`objects projecting within ${RADIUS}px of ${TARGET}:\n`);
for (const h of out) {
  console.log(`${h.label.slice(0, 46).padEnd(48)} ${h.kind.padEnd(9)} off=${String(h.off).padStart(3)}px  ` +
    `world=${JSON.stringify(h.world)} scale=${h.scale} dist=${h.dist}m  heightAt=${h.heightAt} GAP=${h.gap}`);
}

await browser.close();
await server.close();
