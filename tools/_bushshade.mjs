#!/usr/bin/env node
/**
 * Did the gatherables actually get grounded, and is the sink SIGN right?
 *
 * Two separate halves, two separate measurements, because they fail independently:
 *
 *  1. OBJECT SIDE — `applyContactShade` on the bush/rock material. Measured as an exact
 *     A/B against the same frame with the band removed: the probe swaps the instanced
 *     mesh's material for a plain clone, re-renders, and diffs. The number that matters
 *     is the DEEPEST darkening ratio anywhere on the prop. `dark` is the floor the mix
 *     reaches when the fragment is exactly at the ground plane, so if the sign of `sink`
 *     is right the measured floor lands near `dark`; if it is backwards the band is
 *     anchored below ground, the visible base only ever samples the middle of the ramp,
 *     and the floor comes out roughly halfway between `dark` and 1. That is the whole
 *     test — reading the sign off the source is exactly how it got got last time.
 *
 *  2. GROUND SIDE — the patches registered through world.setContactPatches. Measured by
 *     dropping our tag out of the field and re-rendering, so the delta is attributable
 *     to THIS system's patches and not to the 900 the world registers for itself.
 *
 * Run: node tools/_bushshade.mjs [shotId]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { SHOTS } from './shots.mjs';

const shotId = process.argv[2] ?? 'creature_group';
const shot = SHOTS.find((s) => s.id === shotId);
if (!shot) { console.error(`no such shot: ${shotId}`); process.exit(2); }

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
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 300)); });
await page.goto(`http://127.0.0.1:${port}/?capture=1&seed=20240719`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });
await page.evaluate(`(${shot.setup.toString()})(window.__game)`);
await page.evaluate(() => window.__game.render());

console.log(`shot ${shotId}`);

/* ---------- inventory ---------- */
const inv = await page.evaluate(() => {
  const w = window.__game.internals.game.ctx.get('world');
  const st = window.__game.state?.() ?? {};
  const meshes = [];
  window.__game.internals.scene.traverse((o) => {
    if (o.isMesh && /^gather/.test(o.name)) {
      meshes.push({
        name: o.name, count: o.count,
        tris: (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3,
        // does the material the RENDERER sees still carry the contact hook?
        cacheKey: String(o.material.customProgramCacheKey?.() ?? '').slice(0, 40),
        hookOwn: Object.prototype.hasOwnProperty.call(o.material, 'onBeforeCompile'),
        matType: o.material.type,
        normals: !!o.geometry.attributes.normal,
      });
    }
  });
  return { worldPatches: w?.snapshot?.().contactPatches ?? null, meshes, interaction: st.interaction?.resources ?? null };
});
console.log('--- inventory -----------------------------------------------------');
console.log(JSON.stringify(inv, null, 1));

/* ---------- full-res pixel grab ---------- */
const grab = () => page.evaluate(() => {
  const cv = document.querySelector('#app canvas');
  const s = document.createElement('canvas');
  s.width = cv.width; s.height = cv.height;
  const g = s.getContext('2d');
  g.drawImage(cv, 0, 0);
  const d = g.getImageData(0, 0, s.width, s.height);
  return { w: s.width, h: s.height, data: Array.from(d.data) };
});

async function objectSide(meshName, label) {
  const A = await grab();
  const ok = await page.evaluate((nm) => {
    let done = false;
    window.__game.internals.scene.traverse((o) => {
      if (o.isMesh && o.name === nm) {
        // NEGATIVE RESULT, KEPT: the first version of this control swapped in
        // `o.material.clone()`, on the reasoning that Material.copy() does not carry the
        // own-property onBeforeCompile that applyContactShade assigns. It does not — but
        // the clone STILL rendered identically, and the control reported the band as a
        // 57-pixel no-op while a factor visualisation showed it covering 90% of the
        // shrub. Do not trust a material swap as a shader control. Removing the hook
        // from the SAME material object and forcing a recompile is the control that
        // actually measures what it claims to.
        o.userData._h = o.material.onBeforeCompile;
        o.userData._k = o.material.customProgramCacheKey;
        o.material.onBeforeCompile = () => {};
        o.material.customProgramCacheKey = () => 'plainprobe';
        o.material.needsUpdate = true;
        done = true;
      }
    });
    window.__game.render();
    return done;
  }, meshName);
  if (!ok) { console.log(`  ${label}: mesh ${meshName} not in scene`); return; }
  const B = await grab();
  await page.evaluate((nm) => {
    window.__game.internals.scene.traverse((o) => {
      if (o.isMesh && o.name === nm && o.userData._h) {
        o.material.onBeforeCompile = o.userData._h;
        o.material.customProgramCacheKey = o.userData._k;
        o.material.needsUpdate = true;
      }
    });
    window.__game.render();
  }, meshName);

  // Only pixels the swap actually changed belong to the prop's shaded band.
  const w = A.w, h = A.h;
  let n = 0, floor = 1, sumRatio = 0;
  let minRow = h, maxRow = -1;
  const rowSum = new Float64Array(h), rowN = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const la = 0.2126 * A.data[i] + 0.7152 * A.data[i + 1] + 0.0722 * A.data[i + 2];
      const lb = 0.2126 * B.data[i] + 0.7152 * B.data[i + 1] + 0.0722 * B.data[i + 2];
      if (lb < 12 || la - lb > 1) continue;           // unlit, or brighter-with-band = not ours
      if (lb - la < 1.5) continue;                     // unchanged
      const r = la / lb;
      n++; sumRatio += r;
      if (r < floor) floor = r;
      rowSum[y] += r; rowN[y]++;
      if (y < minRow) minRow = y;
      if (y > maxRow) maxRow = y;
    }
  }
  if (!n) { console.log(`  ${label}: NO pixel changed — the band is a no-op`); return; }
  // profile: five bands from the top of the affected region to the bottom
  const bands = [];
  for (let b = 0; b < 5; b++) {
    const y0 = minRow + Math.floor((maxRow - minRow + 1) * b / 5);
    const y1 = minRow + Math.floor((maxRow - minRow + 1) * (b + 1) / 5);
    let s = 0, c = 0;
    for (let y = y0; y < y1; y++) { s += rowSum[y]; c += rowN[y]; }
    bands.push(c ? +(s / c).toFixed(3) : null);
  }
  console.log(`  ${label}: ${n} px changed, rows ${minRow}..${maxRow}`);
  console.log(`     mean ratio ${(sumRatio / n).toFixed(3)}   DEEPEST ratio ${floor.toFixed(3)}`);
  console.log(`     top->bottom profile ${JSON.stringify(bands)}`);
}

const setVeg = (v) => page.evaluate((vis) => {
  window.__game.internals.scene.traverse((o) => {
    if ((o.name === 'grass' || o.name === 'clutter') && o.parent && o.parent.type === 'Scene') o.visible = vis;
  });
  window.__game.render();
}, v);

console.log('--- object side: shaded vs unshaded material -----------------------');
await objectSide('gatherBush', 'bush');
await objectSide('gatherRock', 'rock');
// The same measurement with the meadow carpet and the clutter thicket hidden. If the
// band is fine but buried, this is where it shows up: same shader, same instances, ten
// times the pixels. CLAUDE.md already records the creature version of this trap.
console.log('  ... with grass + clutter hidden:');
await setVeg(false);
await objectSide('gatherBush', 'bush (no grass)');
await objectSide('gatherRock', 'rock (no grass)');
await setVeg(true);

/* ---------- which pixels are even OURS? ---------- */
// "the band moved 57 pixels" has two completely different causes — the band is wrong, or
// the prop is not on screen where you think it is. Hide the mesh and count.
for (const nm of ['gatherBush', 'gatherBerry', 'gatherRock', 'gatherBranch']) {
  const before = await grab();
  await page.evaluate((n) => {
    window.__game.internals.scene.traverse((o) => { if (o.isMesh && o.name === n) o.visible = false; });
    window.__game.render();
  }, nm);
  const after = await grab();
  await page.evaluate((n) => {
    window.__game.internals.scene.traverse((o) => { if (o.isMesh && o.name === n) o.visible = true; });
    window.__game.render();
  }, nm);
  let px = 0, minR = before.h, maxR = -1;
  for (let y = 0; y < before.h; y++) {
    for (let x = 0; x < before.w; x++) {
      const i = (y * before.w + x) * 4;
      if (Math.abs(before.data[i] - after.data[i]) + Math.abs(before.data[i + 1] - after.data[i + 1]) > 6) {
        px++; if (y < minR) minR = y; if (y > maxR) maxR = y;
      }
    }
  }
  console.log(`  ${nm}: ${px} visible px (${(100 * px / (before.w * before.h)).toFixed(2)}% of frame), rows ${minR}..${maxR}`);
}

/* ---------- control: does ANY shader hook reach this material? ---------- */
// "the band moved 57 px" and "onBeforeCompile never ran on this material" produce the
// same pixels. Force a flat 50% multiply on the whole prop and count.
{
  const A = await grab();
  await page.evaluate(() => {
    window.__game.internals.scene.traverse((o) => {
      if (o.isMesh && o.name === 'gatherBush') {
        const m = o.material;
        m.onBeforeCompile = (sh) => {
          sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>',
            '#include <emissivemap_fragment>\n diffuseColor.rgb *= 0.5;');
        };
        m.customProgramCacheKey = () => 'forcedhalf';
        m.needsUpdate = true;
      }
    });
    window.__game.render();
  });
  const B = await grab();
  let px = 0;
  for (let i = 0; i < A.data.length; i += 4) if (Math.abs(A.data[i] - B.data[i]) + Math.abs(A.data[i + 1] - B.data[i + 1]) > 4) px++;
  console.log(`--- control: forced 0.5 multiply on gatherBush -> ${px} px changed`);
}

/* ---------- see the band ---------- */
// Paint the band factor straight into the albedo and photograph it. Black = fully
// occluded end of the ramp, white = untouched. This is the only view that shows WHERE
// on the prop the ramp actually lands, as opposed to how much it moved.
{
  await page.evaluate(({ sinkRel, rangeAbs, rangeRel }) => {
    window.__game.internals.scene.traverse((o) => {
      if (o.isMesh && o.name === 'gatherBush') {
        const m = o.material;
        m.onBeforeCompile = (sh) => {
          sh.vertexShader = sh.vertexShader
            .replace('#include <common>', '#include <common>\nvarying float vCH; varying float vCS;')
            .replace('#include <begin_vertex>', `#include <begin_vertex>
              { vec4 cwp_ = vec4(transformed,1.0); float cbase_=0.0; vCS=1.0;
                #ifdef USE_INSTANCING
                  cwp_ = instanceMatrix * cwp_; cbase_ = instanceMatrix[3].y; vCS = length(instanceMatrix[0].xyz);
                #endif
                vCH = cwp_.y - cbase_; }`);
          sh.fragmentShader = sh.fragmentShader
            .replace('#include <common>', '#include <common>\nvarying float vCH; varying float vCS;')
            .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
              { float gy_ = ${sinkRel} * vCS; float rg_ = ${rangeAbs} + ${rangeRel} * vCS;
                diffuseColor.rgb = vec3(smoothstep(0.0, max(rg_,1e-3), vCH - gy_)); }`);
        };
        m.customProgramCacheKey = () => 'bandviz';
        m.needsUpdate = true;
      }
    });
    window.__game.render();
  }, { sinkRel: 0.05, rangeAbs: 0.06, rangeRel: 0.26 });
  const png = await page.evaluate(() => document.querySelector('#app canvas').toDataURL('image/png'));
  const fs = await import('node:fs');
  fs.mkdirSync('captures/_bushshade', { recursive: true });
  fs.writeFileSync('captures/_bushshade/band.png', Buffer.from(png.split(',')[1], 'base64'));
  console.log('--- band factor painted into albedo -> captures/_bushshade/band.png');
}

/* ---------- what does the varying actually see? ---------- */
// The band is `smoothstep(0, rg_, vCH - gy_)` and every term is knowable in JS from the
// geometry and the instance matrix. Computing it here rather than inferring it from
// pixels separates "the hook never ran" from "the hook ran on the wrong range".
const varying = await page.evaluate(({ nm, sinkAbs, sinkRel, rangeAbs, rangeRel }) => {
  let out = null;
  window.__game.internals.scene.traverse((o) => {
    if (!o.isMesh || o.name !== nm || out) return;
    const pos = o.geometry.attributes.position;
    const m = new Float32Array(16);
    const rows = [];
    for (let i = 0; i < Math.min(o.count, 6); i++) {
      o.instanceMatrix.array.slice(i * 16, i * 16 + 16).forEach((v, k) => { m[k] = v; });
      const sx = Math.hypot(m[0], m[1], m[2]);
      const sy = Math.hypot(m[4], m[5], m[6]);
      const oy = m[13];
      let lo = 1e9, hi = -1e9;
      for (let v = 0; v < pos.count; v++) {
        const h = pos.getY(v) * sy;   // no rotation about x/z on these props
        if (h < lo) lo = h;
        if (h > hi) hi = h;
      }
      const gy = sinkAbs + sinkRel * sx;
      const rg = rangeAbs + rangeRel * sx;
      rows.push({
        i, s: +sx.toFixed(3), originY: +oy.toFixed(3),
        vCHlo: +lo.toFixed(3), vCHhi: +hi.toFixed(3),
        groundAt: +gy.toFixed(3), bandTop: +(gy + rg).toFixed(3),
        fracOfVisibleHeightInBand: +(Math.max(0, Math.min(hi, gy + rg) - Math.max(lo, gy)) / Math.max(1e-6, hi - Math.max(lo, gy))).toFixed(3),
      });
    }
    out = rows;
  });
  return out;
}, { nm: 'gatherBush', sinkAbs: 0, sinkRel: 0.05, rangeAbs: 0.06, rangeRel: 0.26 });
console.log('--- bush varying: vCH vs the band ---------------------------------');
console.log(JSON.stringify(varying, null, 1));

/* ---------- ground side: drop our tag ---------- */
const groundLum = () => page.evaluate(() => {
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

await page.evaluate(() => window.__game.render());
const withOurs = await groundLum();
const dropped = await page.evaluate(() => {
  const w = window.__game.internals.game.ctx.get('world');
  const before = w.snapshot().contactPatches;
  w.setContactPatches('gatherables', []);
  const after = w.snapshot().contactPatches;
  window.__game.render();
  return { before, after };
});
const without = await groundLum();
console.log('--- ground side: our tag in vs out --------------------------------');
console.log(`  field ${dropped.before} patches -> ${dropped.after} without ours (ours = ${dropped.before - dropped.after})`);
console.log(`  ours IN   mean ${withOurs.mean.toFixed(2)}  ground ${withOurs.ground.toFixed(2)}`);
console.log(`  ours OUT  mean ${without.mean.toFixed(2)}  ground ${without.ground.toFixed(2)}`);
console.log(`  delta     mean ${(withOurs.mean - without.mean).toFixed(3)}  ground ${(withOurs.ground - without.ground).toFixed(3)}`);

await browser.close();
await server.close();
