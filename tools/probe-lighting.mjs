#!/usr/bin/env node
/**
 * Decisive experiment for "why is the ground 2-3x too dark?".
 * Renders the same staged shot under several isolated changes and reports the
 * ground/sky luminance ratio for each, so the cause is measured rather than guessed.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OUT = path.resolve('captures', 'probe');
await mkdir(OUT, { recursive: true });

const server = await createServer({ server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const port = server.config.server.port ?? server.httpServer.address().port;
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
await page.goto(`http://127.0.0.1:${port}/?capture=1`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });

// stage the gameplay framing that shows the defect most clearly
await page.evaluate(() => { window.__game.setTimeOfDay(0.29); window.__game.setCamera(null); window.__game.run(2.2); });

const MEASURE = () => {
  const cv = document.querySelector('#app canvas');
  const s = document.createElement('canvas'); s.width = 160; s.height = 90;
  const g = s.getContext('2d'); g.drawImage(cv, 0, 0, 160, 90);
  const d = g.getImageData(0, 0, 160, 90).data;
  let top = 0, bot = 0, nt = 0, nb = 0;
  for (let y = 0; y < 90; y++) for (let x = 0; x < 160; x++) {
    const i = (y * 160 + x) * 4;
    const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    if (y < 45) { top += l; nt++; } else { bot += l; nb++; }
  }
  return { sky: +(top / nt).toFixed(1), ground: +(bot / nb).toFixed(1), ratio: +((bot / nb) / Math.max(1, top / nt)).toFixed(3) };
};

const VARIANTS = {
  baseline: () => {},
  shadowsOff: () => { window.__game.internals.renderer.shadowMap.enabled = false; window.__game.internals.scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; }); },
  postOff: () => { const p = window.__game.internals.game.get('post'); if (p) p._disabledForProbe = true, p.render = null; },
  ambientBoost: () => {
    window.__game.internals.scene.traverse((o) => { if (o.isHemisphereLight || o.isAmbientLight) o.intensity *= 3; });
  },
  exposureUp: () => { window.__game.internals.renderer.toneMappingExposure *= 1.6; },
};

const results = {};
for (const [name, fn] of Object.entries(VARIANTS)) {
  // reload for a clean slate between destructive variants
  await page.goto(`http://127.0.0.1:${port}/?capture=1`, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });
  await page.evaluate(() => { window.__game.setTimeOfDay(0.29); window.__game.setCamera(null); window.__game.run(2.2); });
  await page.evaluate(`(${fn.toString()})()`);
  await page.evaluate(() => window.__game.render());
  results[name] = await page.evaluate(`(${MEASURE.toString()})()`);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log(`${name.padEnd(14)} sky=${String(results[name].sky).padStart(6)}  ground=${String(results[name].ground).padStart(6)}  ratio=${results[name].ratio}`);
}

// what lights actually exist, and what the sun is doing
const lights = await page.evaluate(() => {
  const out = [];
  window.__game.internals.scene.traverse((o) => {
    if (o.isLight) out.push({ type: o.type, intensity: +o.intensity.toFixed(3), color: '#' + o.color.getHexString(), castShadow: !!o.castShadow, pos: o.position.toArray().map((v) => +v.toFixed(1)) });
  });
  return { lights: out, exposure: window.__game.internals.renderer.toneMappingExposure, toneMapping: window.__game.internals.renderer.toneMapping, shadowMap: window.__game.internals.renderer.shadowMap.enabled };
});
console.log('\n' + JSON.stringify(lights, null, 2));
console.log('\nTARGET: real Palworld ground/sky ratio is 0.63-0.96. Ours baseline is the number to move.');

await writeFile(path.join(OUT, 'probe.json'), JSON.stringify({ results, lights }, null, 2));
await browser.close();
await server.close();
