#!/usr/bin/env node
/**
 * Is anything actually grounded? Two consecutive blind critics have now named the same
 * thing as the single biggest gap, in almost the same words:
 *
 *   r11: "it doesn't sit in the world, it sits on top of the image"
 *   r12: "I could not find one shadow... the player standing in the meadow has none,
 *         the Woolkins sitting in grass have none, hillside trees have none"
 *
 * Round 11 DID fix the shadow map — shadows-off moved the mean pixel from 0.362 to
 * 0.773/255. That number is the problem: 0.773/255 is a third of one percent. The map is
 * correct and contributing almost nothing, which is exactly the failure mode CLAUDE.md
 * warns about ("a shadow can only remove the key's contribution").
 *
 * This measures three separate things rather than arguing about one:
 *   1. WHO CASTS      — castShadow/receiveShadow by object, so "everything casts" is a
 *                       fact and not an assumption.
 *   2. HOW MUCH LIGHT — the key directional's irradiance against the sum of every
 *                       unshadowed source. This is the CEILING on what any shadow map can
 *                       ever darken, no matter how many texels it has.
 *   3. WHAT LANDS     — the actual pixel darkening in a patch of ground directly beneath
 *                       a creature, shadows on vs off. This is the number the critic sees.
 *
 * KNOWN LIMIT OF (3), found by the r13 sky builder and recorded here so nobody optimises
 * against it blind: this metric CANNOT TELL SHADOW FROM SELF-SHADOW ACNE. Both darken
 * pixels when the map is on, so both score the same way. Sweeping `normalBias` toward
 * zero makes this number keep climbing after the real contact shadow has already
 * saturated — at bias 0.06 the darkest patch was -36.4 of an eventual -37.0, while the
 * frame mean kept rising all the way to bias 0. That divergence IS the acne signature:
 * when the darkest patch stops moving but the mean does not, the extra "shadow" is
 * speckle spread over the whole frame. Read the darkest-patch figure as the quality
 * number and the mean as coverage, and confirm both by eye before shipping a bias.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { SHOTS } from './shots.mjs';

const shotId = process.argv[2] ?? 'creature_group';
const shot = SHOTS.find((s) => s.id === shotId);

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

/* ---------- 1. who casts ---------- */
const casters = await page.evaluate(() => {
  const { scene } = window.__game.internals;
  const tally = {};
  scene.traverse((o) => {
    if (!(o.isMesh || o.isInstancedMesh || o.isSkinnedMesh)) return;
    let tag = o.name || '(unnamed)';
    for (let p = o.parent; p && p.type !== 'Scene'; p = p.parent) {
      if (p.name) { tag = `${p.name}/${tag}`; break; }
    }
    tag = tag.replace(/#?\d+$/, '').slice(0, 40);
    const k = `${tag}|${o.castShadow ? 'cast' : '----'}|${o.receiveShadow ? 'recv' : '----'}`;
    tally[k] = (tally[k] ?? 0) + 1;
  });
  return tally;
});
console.log('--- who casts / receives -------------------------------------------');
for (const [k, n] of Object.entries(casters).sort()) {
  const [tag, cast, recv] = k.split('|');
  console.log(`  ${tag.padEnd(42)} ${cast} ${recv}   x${n}`);
}

/* ---------- 2. the light budget ---------- */
const lights = await page.evaluate(() => {
  const { scene } = window.__game.internals;
  const out = [];
  scene.traverse((o) => {
    if (!o.isLight) return;
    out.push({
      type: o.type, name: o.name || '', intensity: +o.intensity.toFixed(3),
      castShadow: !!o.castShadow, visible: o.visible,
      color: '#' + o.color.getHexString(),
      groundColor: o.groundColor ? '#' + o.groundColor.getHexString() : null,
    });
  });
  return out;
});
console.log('\n--- the light budget ------------------------------------------------');
let keyed = 0, unkeyed = 0;
for (const l of lights) {
  if (!l.visible) continue;
  (l.castShadow ? (keyed += l.intensity) : (unkeyed += l.intensity));
  console.log(`  ${l.type.padEnd(20)} i=${String(l.intensity).padEnd(7)} ${l.castShadow ? 'CASTS' : 'unshadowed'}  ${l.color}${l.groundColor ? ' / ' + l.groundColor : ''}`);
}
console.log(`\n  shadow-casting intensity : ${keyed.toFixed(3)}`);
console.log(`  unshadowed intensity     : ${unkeyed.toFixed(3)}`);
console.log(`  key share of total       : ${(keyed / (keyed + unkeyed) * 100).toFixed(1)}%   <-- the hard ceiling on any shadow`);

/* ---------- 3. what actually lands on the ground ---------- */
const grab = async () => {
  await page.evaluate(() => window.__game.render());
  return page.evaluate(() => {
    const cv = document.querySelector('#app canvas');
    const c = document.createElement('canvas');
    c.width = cv.width; c.height = cv.height;
    c.getContext('2d').drawImage(cv, 0, 0);
    return Array.from(c.getContext('2d').getImageData(0, 0, cv.width, cv.height).data);
  });
};
const setShadows = async (on) => {
  await page.evaluate((v) => {
    const { renderer, scene } = window.__game.internals;
    renderer.shadowMap.enabled = v;
    // toggling the flag alone does NOTHING: the shadow branch is compiled into every
    // program, so each material must be told to relink. Cost a probe an entire run once.
    scene.traverse((o) => {
      const m = o.material; if (!m) return;
      (Array.isArray(m) ? m : [m]).forEach((x) => { x.needsUpdate = true; });
    });
  }, on);
};

await setShadows(true);
const on = await grab();
await setShadows(false);
const off = await grab();

const W = 1280, H = 720;
const lum = (a, i) => 0.2126 * a[i] + 0.7152 * a[i + 1] + 0.0722 * a[i + 2];
const patch = (a, x0, y0, x1, y1) => {
  let s = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { s += lum(a, (y * W + x) * 4); n++; }
  return s / n;
};
let whole = 0, worst = 0, worstAt = null;
for (let i = 0; i < on.length; i += 4) whole += Math.abs(lum(on, i) - lum(off, i));
whole /= (on.length / 4);
// scan 16x16 tiles for the single most shadow-affected patch in frame
for (let y = 0; y + 16 <= H; y += 16) {
  for (let x = 0; x + 16 <= W; x += 16) {
    const d = patch(off, x, y, x + 16, y + 16) - patch(on, x, y, x + 16, y + 16);
    if (d > worst) { worst = d; worstAt = [x, y]; }
  }
}
console.log('\n--- what the shadow map actually removes ----------------------------');
console.log(`  shot                      : ${shotId}`);
console.log(`  mean |on-off| over frame  : ${whole.toFixed(3)} / 255   (${(whole / 255 * 100).toFixed(2)}% of range)`);
console.log(`  darkest 16x16 patch       : -${worst.toFixed(1)} / 255 at ${worstAt}`);
console.log('\n  For scale: a shadow a viewer reads as a shadow removes 25-60 of 255 in');
console.log('  the shadowed patch. Under 10 is invisible at any exposure.');

await browser.close();
await server.close();
