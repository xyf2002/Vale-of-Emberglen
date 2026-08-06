#!/usr/bin/env node
/**
 * DOES THE GROUNDING READ?  (companion to _groundprobe.mjs)
 *
 * _groundprobe.mjs answers "who casts" and "what does the SHADOW MAP remove". It cannot
 * answer the question that matters for the contact term, because the contact decals are
 * not in the shadow map at all — they are multiply-blended geometry. Toggling
 * `renderer.shadowMap.enabled` leaves them untouched, so a build whose contact shadows
 * are 100% occluded by grass scores identically to one where they read perfectly.
 *
 * This probe A/Bs the grounding geometry itself: render the shot with the contact meshes
 * `visible = true`, again with `visible = false`, and diff. That is the only number that
 * says whether a viewer sees anything.
 *
 *   covered      — pixels the grounding changes by more than 1/255. If this is a few
 *                  hundred on a 1280x720 frame, nothing is grounded no matter how good
 *                  the decal texture is.
 *   mean/max     — how much luminance it removes WHERE it lands. A shadow a viewer reads
 *                  as a shadow removes 25-60 of 255.
 *
 * usage: node tools/_groundprobe2.mjs [shot ...]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { SHOTS } from './shots.mjs';

const W = 1280, H = 720;
const OUT = 'captures/_ground2';
const want = process.argv.slice(2);
const shots = SHOTS.filter((s) => (want.length ? want.includes(s.id) : ['creature_group', 'creature_portrait', 'overshoulder_meadow'].includes(s.id)));

// every object the grounding systems own, by name
const GROUNDING = ['creature-contact-shadows', 'player-contact-shadow'];

mkdirSync(OUT, { recursive: true });

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
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 300)));
await page.goto(`http://127.0.0.1:${port}/?capture=1&seed=20240719`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });

const grab = async () => {
  await page.evaluate(() => window.__game.render());
  const raw = await page.evaluate(() => {
    const cv = document.querySelector('#app canvas');
    const c = document.createElement('canvas');
    c.width = cv.width; c.height = cv.height;
    c.getContext('2d').drawImage(cv, 0, 0);
    return Array.from(c.getContext('2d').getImageData(0, 0, cv.width, cv.height).data);
  });
  return Uint8ClampedArray.from(raw);
};
const setVisible = (v) => page.evaluate(([names, on]) => {
  const { scene } = window.__game.internals;
  let n = 0;
  scene.traverse((o) => { if (names.includes(o.name)) { o.visible = on; n++; } });
  return n;
}, [GROUNDING, v]);

/**
 * Put the r13 grounding work back to how r12 behaved, at runtime, so the guardrail
 * movement can be ATTRIBUTED. Three agents were editing this build concurrently (sky
 * was widening the shadow frustum, world was adding its own prop contact field), so a
 * round-over-round table cannot say which change moved `edge`. This can.
 *
 *   grounding meshes hidden        — creature + player contact slabs
 *   uGroundAO 0.42, uGroundAOkey 0 — the fur ground line, ambient only, as in r12
 *   avatar receiveShadow off       — as in r12
 *
 * CAVEAT, so nobody quotes this as an exact r12 reproduction: build.js's formLighting()
 * overrides groundAO PER SPECIES (woolkin ran 0.52/0.30 in r12, not the 0.42/0.20 default
 * restored here), and the probe cannot see those values from outside the material. The
 * `base` column is therefore "r12-ish, very slightly flatter". The A/B DELTA is the
 * number this tool is for; the absolute column is a sanity check, not a baseline.
 */
const setGroundingEra = (era) => page.evaluate(([names, r12]) => {
  const { scene } = window.__game.internals;
  const seen = { meshes: 0, fur: 0, avatar: 0 };
  scene.traverse((o) => {
    if (names.includes(o.name)) { o.visible = !r12; seen.meshes++; }
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) {
      const u = m.userData && m.userData.u;
      if (u && u.uGroundAO && u.uGroundAOkey) {
        u.uGroundAO.value = r12 ? 0.42 : 0.55;
        u.uGroundAOh.value = r12 ? 0.20 : 0.34;
        u.uGroundAOkey.value = r12 ? 0.0 : 0.80;
        seen.fur++;
      }
    }
    if (o.isMesh && o.parent && /avatar/.test(o.parent.name || o.parent.parent?.name || '')) seen.avatar++;
  });
  // the avatar's meshes are nested a few groups deep; find them from the named root
  const av = scene.getObjectByName('avatar');
  if (av) av.traverse((o) => { if (o.isMesh) { o.receiveShadow = !r12; seen.avatar++; } });
  return seen;
}, [GROUNDING, era === 'r12']);

const lum = (a, i) => 0.2126 * a[i] + 0.7152 * a[i + 1] + 0.0722 * a[i + 2];
/** no pngjs in this repo — hand the bytes back to the page and let the browser encode */
const writeDiff = async (name, diff) => {
  const url = await page.evaluate(([w, h, bytes]) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const img = new ImageData(new Uint8ClampedArray(bytes), w, h);
    c.getContext('2d').putImageData(img, 0, 0);
    return c.toDataURL('image/png');
  }, [W, H, Array.from(diff)]);
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(url.split(',')[1], 'base64'));
};

console.log('shot                  found  covered   %frame   mean-dark   max-dark   lightened');
console.log('-'.repeat(84));
for (const shot of shots) {
  await page.evaluate(`(${shot.setup.toString()})(window.__game)`);

  // (a) attribution pair: everything r13 added to the grounding, on vs off
  await setGroundingEra('r13');
  await grab();
  await page.screenshot({ path: `${OUT}/${shot.id}_ours.png`, animations: 'disabled' });
  await setGroundingEra('r12');
  await grab();
  await page.screenshot({ path: `${OUT}/${shot.id}_base.png`, animations: 'disabled' });
  await setGroundingEra('r13');

  // (b) coverage pair: the grounding GEOMETRY alone, everything else identical
  const found = await setVisible(true);
  const on = await grab();
  await page.screenshot({ path: `${OUT}/${shot.id}_on.png`, animations: 'disabled' });
  await setVisible(false);
  const off = await grab();
  await page.screenshot({ path: `${OUT}/${shot.id}_off.png`, animations: 'disabled' });
  await setVisible(true);

  let covered = 0, sum = 0, max = 0, lightened = 0;
  const diff = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < on.length; i += 4) {
    const d = lum(off, i) - lum(on, i);       // positive = the grounding darkened it
    if (Math.abs(d) > 1) covered++;
    if (d > 0) { sum += d; if (d > max) max = d; }
    else if (d < -1) lightened++;
    const v = Math.min(255, Math.abs(d) * 6);
    diff[i] = d < 0 ? v : 0; diff[i + 1] = d > 0 ? v : 0; diff[i + 2] = 0; diff[i + 3] = 255;
  }
  await writeDiff(`${shot.id}_diff`, diff);
  const mean = covered ? sum / covered : 0;
  console.log(`${shot.id.padEnd(21)} ${String(found).padStart(3)}  ${String(covered).padStart(7)}  ${(covered / (W * H) * 100).toFixed(3).padStart(6)}%  ${mean.toFixed(1).padStart(9)}  ${max.toFixed(1).padStart(9)}  ${String(lightened).padStart(9)}`);
}
console.log(`\nwrote ${OUT}/<shot>_{on,off,diff}.png   (diff: green = darkened, red = lightened, x6)`);

await browser.close();
await server.close();
