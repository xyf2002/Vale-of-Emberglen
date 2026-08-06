#!/usr/bin/env node
/**
 * Throwaway probe, pass 7: bisect on the PIXEL, and dump the boulder's real bounds.
 *
 * Two floaters, two owners (pass 4 hid them separately):
 *   - the small grey one dies with `no_ai_props`  -> a plain `ai:boulder` Mesh
 *   - the big moss-topped one dies with `no_instanced` -> some instanced channel
 *
 * Projecting every instance origin (pass 6) found NOTHING within 45 px of the big
 * floater except hillside props 290 m away — which means the owning instance's ORIGIN is
 * nowhere near where its geometry draws, i.e. the geometry is baked with a translation.
 * That is also the only thing that explains `ai:boulder` reporting a bounding-box min of
 * +0.37 (its whole mesh above its own origin) while a ray through it hits 3.87 m up.
 *
 * So: bisect the instanced channels by switching halves off and watching the pixel, and
 * separately print every `ai:` mesh's world matrix and geometry bounding box.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { SHOTS } from './shots.mjs';

const shot = SHOTS.find((s) => s.id === 'vista_golden');
const PX = [700, 341];      // big moss-topped floater
const PX2 = [590, 347];     // small grey floater (known: ai:boulder)

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

// index every instanced channel so we can address them by number
const total = await page.evaluate(() => {
  const { scene } = window.__game.internals;
  let i = 0;
  scene.traverse((o) => { if (o.isInstancedMesh) o.userData.__idx = i++; });
  return i;
});

const sample = async (hide) => {
  await page.evaluate((set) => {
    const { scene } = window.__game.internals;
    const s = new Set(set);
    scene.traverse((o) => { if (o.isInstancedMesh) o.visible = !s.has(o.userData.__idx); });
  }, hide);
  await page.evaluate(() => window.__game.render());
  return page.evaluate(({ a, b }) => {
    const cv = document.querySelector('#app canvas');
    const c = document.createElement('canvas');
    c.width = cv.width; c.height = cv.height;
    c.getContext('2d').drawImage(cv, 0, 0);
    const g = c.getContext('2d');
    const sx = cv.width / 1280, sy = cv.height / 720;
    const at = (p) => Array.from(g.getImageData(Math.round(p[0] * sx), Math.round(p[1] * sy), 1, 1).data).slice(0, 3);
    return { a: at(a), b: at(b) };
  }, { a: PX, b: PX2 });
};

const base = await sample([]);
console.log(`baseline  floaterA=${base.a}  floaterB=${base.b}`);

// bisect: find the smallest set of channels whose removal changes pixel A
let candidates = Array.from({ length: total }, (_, i) => i);
while (candidates.length > 1) {
  const half = candidates.slice(0, Math.ceil(candidates.length / 2));
  const s = await sample(half);
  const changed = s.a.some((v, i) => Math.abs(v - base.a[i]) > 6);
  console.log(`  hiding ${half.length} of ${candidates.length} -> pixelA=${s.a} ${changed ? 'CHANGED' : 'same'}`);
  candidates = changed ? half : candidates.slice(Math.ceil(candidates.length / 2));
}
const owner = candidates[0];
await sample([]);
const info = await page.evaluate((idx) => {
  const { scene, game } = window.__game.internals;
  const world = game.get('world');
  let r = null;
  scene.traverse((o) => {
    if (!o.isInstancedMesh || o.userData.__idx !== idx) return;
    o.geometry.computeBoundingBox();
    const bb = o.geometry.boundingBox;
    const chain = [];
    for (let p = o; p && p !== scene; p = p.parent) chain.push(p.name || p.type);
    r = {
      idx, count: o.count, chain: chain.reverse().join('/'),
      geomBox: { min: bb.min.toArray().map((v) => +v.toFixed(2)), max: bb.max.toArray().map((v) => +v.toFixed(2)) },
      material: o.material?.type, hasShaderPatch: !!o.material?.userData?.shader || !!o.material?.onBeforeCompile,
      defines: o.material?.defines ?? null,
    };
  });
  return r;
}, owner);
console.log(`\nOWNER of the big floater: channel #${owner}`);
console.log(JSON.stringify(info, null, 2));

const ai = await page.evaluate(() => {
  const { scene, game } = window.__game.internals;
  const world = game.get('world');
  const rows = [];
  scene.traverse((o) => {
    if (!o.name?.startsWith('ai:') || !o.geometry) return;
    o.geometry.computeBoundingBox();
    const bb = o.geometry.boundingBox;
    rows.push({
      name: o.name,
      pos: o.position.toArray().map((v) => +v.toFixed(2)),
      scale: o.scale.toArray().map((v) => +v.toFixed(2)),
      geomMin: +bb.min.y.toFixed(2), geomMax: +bb.max.y.toFixed(2),
      heightAt: +world.heightAt(o.position.x, o.position.z).toFixed(2),
      renderedBottom: +(o.position.y + bb.min.y - world.heightAt(o.position.x, o.position.z)).toFixed(2),
    });
  });
  return rows;
});
console.log('\nai: props — rendered bottom relative to ground (positive = floating):');
for (const r of ai) console.log(`  ${r.name.padEnd(12)} pos=${JSON.stringify(r.pos)} geomY=[${r.geomMin},${r.geomMax}] ground=${r.heightAt} bottom=${r.renderedBottom}`);

await browser.close();
await server.close();
