#!/usr/bin/env node
/**
 * Settle the one question the r13 sky builder could not settle alone: is `normalBias`
 * 0.03 better than the shipped 0.06, or is the extra darkening self-shadow acne?
 *
 * Why a number cannot answer this. The ground probe scores "pixels got darker when the
 * shadow map turned on", and ACNE DARKENS PIXELS TOO. The sky builder measured the frame
 * mean still climbing as bias went to zero (1.414 -> 1.962) while the darkest contact
 * patch had already saturated (-33.4 -> -37.0). Divergence between those two IS the acne
 * signature: real shadow grows the darkest patch, speckle grows only the mean. Which is
 * happening can only be decided by looking.
 *
 * So this renders ONE staged frame at several bias values inside a single browser
 * session — the tree cannot change underneath it, so the only variable is the bias — and
 * writes a magnified crop of a lit, grazing-angle surface where acne shows first. It also
 * reports a cheap speckle statistic: the mean absolute difference between each pixel and
 * its right-hand neighbour, restricted to ground. Acne is high-frequency, so it raises
 * per-pixel neighbour variance sharply while a true shadow edge barely moves it.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir } from 'node:fs/promises';
import { SHOTS } from './shots.mjs';

const shotId = process.argv[2] ?? 'overshoulder_meadow';
const shot = SHOTS.find((s) => s.id === shotId);
const BIASES = [0.12, 0.06, 0.03, 0.0];
const OUT = '/tmp/claude-1000/-home-xyf-game-RPG/260c7331-1ecb-448f-b7fd-8db6869c2c87/scratchpad/bias';
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

const shipped = await page.evaluate(() => {
  let v = null;
  window.__game.internals.scene.traverse((o) => {
    if (o.isDirectionalLight && o.castShadow) v = { normalBias: o.shadow.normalBias, bias: o.shadow.bias };
  });
  return v;
});
console.log(`shot ${shotId}   shipped ${JSON.stringify(shipped)}\n`);
console.log('bias    meanLum   speckle(ground)   note');

for (const nb of BIASES) {
  const stats = await page.evaluate((v) => {
    const { scene, renderer } = window.__game.internals;
    scene.traverse((o) => { if (o.isDirectionalLight && o.castShadow) o.shadow.normalBias = v; });
    renderer.shadowMap.needsUpdate = true;
    window.__game.render();
    const cv = document.querySelector('#app canvas');
    const c = document.createElement('canvas');
    c.width = cv.width; c.height = cv.height;
    const g = c.getContext('2d');
    g.drawImage(cv, 0, 0);
    const W = cv.width, H = cv.height;
    const d = g.getImageData(0, 0, W, H).data;
    const lum = (i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    // ground only: lower 45% of frame, skipping the HUD strip at the very bottom
    const y0 = Math.round(H * 0.55), y1 = Math.round(H * 0.92);
    let sum = 0, spk = 0, n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = (y * W + x) * 4;
        const l = lum(i);
        sum += l;
        spk += Math.abs(l - lum(i + 4));
        n++;
      }
    }
    return { mean: sum / n, speckle: spk / n };
  }, nb);
  await page.screenshot({ path: `${OUT}/nb_${String(nb).replace('.', 'p')}.png`, animations: 'disabled', timeout: 120000 });
  console.log(`${String(nb).padEnd(8)}${stats.mean.toFixed(2).padStart(7)}${stats.speckle.toFixed(3).padStart(18)}`);
}

// restore whatever was shipped, so a probe never leaves the tree in a probe state
await page.evaluate((v) => {
  window.__game.internals.scene.traverse((o) => {
    if (o.isDirectionalLight && o.castShadow) o.shadow.normalBias = v;
  });
}, shipped.normalBias);

console.log(`\ncrops -> ${OUT}`);
console.log('Read the speckle column: a true shadow that grows should barely move it,');
console.log('because a shadow edge is a handful of pixels. Acne raises it monotonically.');

await browser.close();
await server.close();
