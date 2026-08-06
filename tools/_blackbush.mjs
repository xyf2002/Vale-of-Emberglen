#!/usr/bin/env node
/**
 * r14 interaction_feed shows several berry bushes rendering as near-black blobs while
 * others in the same frame stay green. Two new things could do that, and they live on
 * opposite sides of the directory boundary:
 *
 *   1. the OBJECT-side band  — applyContactShade() on bushMat in src/interaction/Resources.js
 *   2. the GROUND-side field — world.setContactPatches('gatherables', ...) decals
 *
 * tools/_bushshade.mjs already reports the object-side band as correctly anchored
 * (ground at +0.05, band covering ~36% of visible height) on the instances it sampled —
 * but it sampled two. So instead of reasoning, switch each layer off on its own inside a
 * single session and photograph the same crop.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir } from 'node:fs/promises';
import { SHOTS } from './shots.mjs';

const shot = SHOTS.find((s) => s.id === 'interaction_feed');
const OUT = '/tmp/claude-1000/-home-xyf-game-RPG/260c7331-1ecb-448f-b7fd-8db6869c2c87/scratchpad/blackbush';
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
await page.evaluate(`(${shot.setup.toString()})(window.__game)`);

// a patch of one of the black blobs, and a patch of a green bush, for a number not a vibe
const BLACK = [850, 330];
const GREEN = [430, 360];

const sample = async (label) => {
  await page.evaluate(() => window.__game.render());
  await page.screenshot({ path: `${OUT}/${label}.png`, animations: 'disabled', timeout: 120000 });
  return page.evaluate(({ b, g }) => {
    const cv = document.querySelector('#app canvas');
    const c = document.createElement('canvas');
    c.width = cv.width; c.height = cv.height;
    const x = c.getContext('2d');
    x.drawImage(cv, 0, 0);
    const at = (p) => {
      const d = x.getImageData(p[0] - 6, p[1] - 6, 12, 12).data;
      let s = 0;
      for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      return +(s / (d.length / 4)).toFixed(1);
    };
    return { black: at(b), green: at(g) };
  }, { b: BLACK, g: GREEN });
};

console.log('case                  blackBlobLum  greenBushLum');
console.log(`as shipped            ${JSON.stringify(await sample('a_shipped'))}`);

// 1. ground-side field off — and PROVE it took, because a toggle that silently does
// nothing reports the same number as "this layer is not the cause", which is the exact
// wrong conclusion.
const before = await page.evaluate(() => window.__game.state().world?.contactPatches ?? -1);
await page.evaluate(() => window.__game.internals.game.get('world').setContactPatches('gatherables', []));
const after = await page.evaluate(() => window.__game.state().world?.contactPatches ?? -1);
console.log(`  (contactPatches ${before} -> ${after})`);
console.log(`ground patches OFF    ${JSON.stringify(await sample('b_nopatches'))}`);

// 2. object-side band off too: neutralise the shader term on the bush material
await page.evaluate(() => {
  const { scene } = window.__game.internals;
  let n = 0;
  scene.traverse((o) => {
    if (o.name !== 'gatherBush') return;
    // replace the material outright — reassigning onBeforeCompile on a material three
    // has already compiled does not reliably relink it.
    const m = new window.THREE.MeshStandardMaterial({
      vertexColors: o.material.vertexColors, roughness: o.material.roughness,
      metalness: o.material.metalness,
    });
    o.material = m; n++;
  });
  console.log('swapped', n);
});
console.log(`both OFF              ${JSON.stringify(await sample('c_bothoff'))}`);

const info = await page.evaluate(() => {
  const { scene } = window.__game.internals;
  const out = [];
  scene.traverse((o) => {
    if (o.name !== 'gatherBush') return;
    const m = o.material;
    out.push({
      name: o.name, count: o.count, type: m.type,
      hasInstanceColor: !!o.instanceColor,
      vertexColors: m.vertexColors, flatShading: m.flatShading,
      color: '#' + m.color.getHexString(),
    });
  });
  return out;
});
console.log('\n' + JSON.stringify(info, null, 1));
console.log(`\ncrops -> ${OUT}`);

await browser.close();
await server.close();
