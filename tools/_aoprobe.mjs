#!/usr/bin/env node
/**
 * Are the ground-side contact patches (src/world/contact.js) actually reaching the
 * framebuffer?
 *
 * The failure modes are all silent and all look identical in a screenshot — an empty
 * draw range, a mesh parked at the origin because matrixWorld never updated, a blend
 * mode that resolves to a no-op, or a depth test the patch loses against the very
 * ground it is coplanar with. So measure each of them separately:
 *
 *   1. inventory   — the fields exist, how many patches each holds, draw range, matrix
 *   2. geometry    — patch vertex heights against T.heightAt at the same xz
 *   3. pixels      — mean luminance of the ground with the fields visible vs hidden
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { SHOTS } from './shots.mjs';

const shotId = process.argv[2] ?? 'overshoulder_meadow';
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
page.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 200)); });
await page.goto(`http://127.0.0.1:${port}/?capture=1&seed=20240719`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });
await page.evaluate(`(${shot.setup.toString()})(window.__game)`);
await page.evaluate(() => window.__game.render());

const inv = await page.evaluate(() => {
  const { scene } = window.__game.internals;
  const out = [];
  scene.traverse((o) => {
    if (!o.isMesh) return;
    if (!/^(propContact|clutterContact)$/.test(o.name)) return;
    const g = o.geometry;
    const pos = g.attributes.position;
    const dr = g.drawRange;
    o.updateWorldMatrix(true, false);
    out.push({
      name: o.name,
      verts: pos.count,
      drawCount: dr.count,
      visible: o.visible,
      inScene: true,
      matrix: Array.from(o.matrixWorld.elements).map((v) => +v.toFixed(3)),
      renderOrder: o.renderOrder,
      blending: o.material.blending,
      transparent: o.material.transparent,
      firstVerts: [0, 1, 9].filter((i) => i < pos.count).map((i) => [pos.getX(i), pos.getY(i), pos.getZ(i)].map((v) => +v.toFixed(3))),
    });
  });
  return out;
});
console.log('--- contact fields ------------------------------------------------');
console.log(JSON.stringify(inv, null, 1));

// height agreement: a patch vertex must sit on the surface it darkens
const heights = await page.evaluate(() => {
  const { scene } = window.__game.internals;
  const gh = (x, z) => window.__game.groundAt(x, z);
  const res = [];
  scene.traverse((o) => {
    if (!o.isMesh || !/^(propContact|clutterContact)$/.test(o.name)) return;
    const pos = o.geometry.attributes.position;
    let worst = 0, n = 0;
    for (let i = 0; i < Math.min(pos.count, 3000); i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      if (x === 0 && y === 0 && z === 0) continue;
      const d = y - gh(x, z);
      if (Math.abs(d) > Math.abs(worst)) worst = d;
      n++;
    }
    res.push({ name: o.name, sampled: n, worstDelta: +worst.toFixed(4) });
  });
  return res;
});
console.log('--- patch vertex height minus terrain height -----------------------');
console.log(JSON.stringify(heights));

/* ---------- pixels ---------- */
const lum = async () => page.evaluate(() => {
  const cv = document.querySelector('#app canvas');
  const s = document.createElement('canvas');
  s.width = 320; s.height = 180;
  const g = s.getContext('2d');
  g.drawImage(cv, 0, 0, 320, 180);
  const d = g.getImageData(0, 0, 320, 180).data;
  let bot = 0, nb = 0, all = 0;
  for (let y = 0; y < 180; y++) {
    for (let x = 0; x < 320; x++) {
      const i = (y * 320 + x) * 4;
      const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      all += l;
      if (y >= 90) { bot += l; nb++; }
    }
  }
  return { mean: all / (320 * 180), ground: bot / nb };
});

const on = await lum();
// CONTROL: hiding the ground must move the pixels. If it does not, the probe is
// reading a stale canvas and nothing below it means anything.
await page.evaluate(() => {
  const { scene } = window.__game.internals;
  scene.traverse((o) => { if (o.isMesh && o.name === 'ground') o.visible = false; });
  window.__game.render();
});
const ctrl = await lum();
await page.evaluate(() => {
  const { scene } = window.__game.internals;
  scene.traverse((o) => { if (o.isMesh && o.name === 'ground') o.visible = true; });
  window.__game.render();
});
// FORCE: crank every patch to pure black. If THAT does not move a pixel the patches
// are not reaching the framebuffer at all.
await page.evaluate(() => {
  const { scene } = window.__game.internals;
  scene.traverse((o) => {
    if (o.isMesh && /^(propContact|clutterContact)$/.test(o.name)) {
      o.material.fragmentShader = 'varying float vAo;\nvoid main(){ gl_FragColor = vec4(vec3(0.0), 1.0); }';
      o.material.needsUpdate = true;
    }
  });
  window.__game.render();
});
const forced = await lum();
// Is it the depth test? A coplanar decal that loses depth is indistinguishable from
// one that was never submitted, and the two have completely different fixes.
await page.evaluate(() => {
  const { scene } = window.__game.internals;
  scene.traverse((o) => {
    if (o.isMesh && /^(propContact|clutterContact)$/.test(o.name)) { o.material.depthTest = false; o.material.needsUpdate = true; }
  });
  window.__game.render();
});
const nodepth = await lum();
await page.evaluate(() => {
  const { scene } = window.__game.internals;
  scene.traverse((o) => {
    if (o.isMesh && /^(propContact|clutterContact)$/.test(o.name)) { o.material.depthTest = true; o.material.needsUpdate = true; }
  });
  window.__game.render();
});
console.log(`  ground hidden (control) mean ${ctrl.mean.toFixed(2)}  ground ${ctrl.ground.toFixed(2)}`);
console.log(`  patches forced black    mean ${forced.mean.toFixed(2)}  ground ${forced.ground.toFixed(2)}`);
console.log(`  forced black, no depth  mean ${nodepth.mean.toFixed(2)}  ground ${nodepth.ground.toFixed(2)}`);
await page.evaluate(() => {
  const { scene } = window.__game.internals;
  scene.traverse((o) => {
    if (o.isMesh && /^(propContact|clutterContact)$/.test(o.name)) {
      o.material.fragmentShader = 'varying float vAo;\nvoid main(){ gl_FragColor = vec4(vec3(1.0 - vAo), 1.0); }';
      o.material.needsUpdate = true;
      o.visible = false;
    }
  });
  window.__game.render();
});
const off = await lum();
console.log('--- pixels --------------------------------------------------------');
console.log(`  patches ON   mean ${on.mean.toFixed(2)}  ground ${on.ground.toFixed(2)}`);
console.log(`  patches OFF  mean ${off.mean.toFixed(2)}  ground ${off.ground.toFixed(2)}`);
console.log(`  delta        mean ${(on.mean - off.mean).toFixed(3)}  ground ${(on.ground - off.ground).toFixed(3)}`);

/* ---------- the peer-facing service ---------- */
// src/interaction/Resources.js owns the berry bushes the r11 critic actually named,
// and this directory must not edit it. world.setContactPatches(tag, patches) is how
// that system gets ground occlusion under its own props. Prove it works from outside.
await page.evaluate(() => {
  const { scene } = window.__game.internals;
  scene.traverse((o) => { if (o.isMesh && /^(propContact|clutterContact)$/.test(o.name)) o.visible = true; });
});
const svc = await page.evaluate(() => {
  const w = window.__game.internals.game.ctx.get('world');
  if (!w || !w.setContactPatches) return { ok: false, why: 'no setContactPatches on the world system' };
  const p = window.__game.state().player.pos;
  const list = [];
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    list.push({ x: p[0] + Math.cos(a) * 4, z: p[2] + Math.sin(a) * 4, r: 1.4, dark: 0.55 });
  }
  const before = w.snapshot().contactPatches ?? null;
  const n = w.setContactPatches('probe', list);
  const after = w.snapshot().contactPatches ?? null;
  window.__game.render();
  return { ok: true, returned: n, before, after };
});
console.log('--- world.setContactPatches -----------------------------------------');
console.log(JSON.stringify(svc));
if (svc.ok) {
  const withSvc = await lum();
  await page.evaluate(() => {
    const w = window.__game.internals.game.ctx.get('world');
    w.setContactPatches('probe', null);
    window.__game.render();
  });
  const noSvc = await lum();
  console.log(`  24 registered patches move ground luminance by ${(withSvc.ground - noSvc.ground).toFixed(3)}`);
}

await browser.close();
await server.close();
