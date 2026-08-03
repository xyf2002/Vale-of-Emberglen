#!/usr/bin/env node
/**
 * THROWAWAY diagnostic for "nothing casts a shadow". Delete when done.
 *
 *   node tools/_shadowprobe.mjs            # full diagnosis
 *   node tools/_shadowprobe.mjs --diff     # just the on/off pixel diff
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const argv = process.argv.slice(2);
const only = argv.includes('--diff') ? 'diff' : 'all';
const TOD = Number((argv.find((a) => a.startsWith('--tod=')) ?? '--tod=0.30').slice(6));

const server = await createServer({ server: { port: 0, host: '127.0.0.1', strictPort: false }, logLevel: 'error' });
await server.listen();
const port = server.config.server.port ?? server.httpServer.address().port;
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('  [page err]', m.text().slice(0, 200)); });
await page.goto(`http://127.0.0.1:${port}/?capture=1&seed=20240719`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });

// stage: the over-shoulder meadow at low sun — the shot the critic complained about
await page.evaluate((tod) => {
  const g = window.__game;
  g.setTimeOfDay(tod);
  g.setCamera(null);
  const s0 = g.state();
  g.place(s0.player.pos[0], s0.player.pos[2], 0);
  g.run(2.2);
}, TOD);

/* ---------------------------------------------------------------- 1. shader audit */
if (only === 'all') {
  const shaders = await page.evaluate(() => {
    const r = window.__game.internals.renderer;
    const gl = r.getContext();
    return r.info.programs.map((p) => {
      const src = gl.getShaderSource(p.fragmentShader) || '';
      const vsrc = gl.getShaderSource(p.vertexShader) || '';
      return {
        key: p.cacheKey.slice(0, 60),
        used: p.usedTimes,
        defShadowmap: /^#define USE_SHADOWMAP/m.test(src),
        nDirShadows: (src.match(/#define NUM_DIR_LIGHT_SHADOWS (\d+)/) || [])[1] ?? null,
        nDirLights: (src.match(/#define NUM_DIR_LIGHTS (\d+)/) || [])[1] ?? null,
        hasGetShadowDef: /float getShadow\(/.test(src),
        getShadowCalls: (src.match(/getShadow\(/g) || []).length,
        hasShadowmaskChunk: /directLight\.color \*= /.test(src),
        hasLambertRE: /RE_Direct_Lambert/.test(src),
        vHasShadowCoord: /vDirectionalShadowCoord/.test(vsrc),
        fHasShadowCoord: /vDirectionalShadowCoord/.test(src),
      };
    });
  });
  console.log('\n=== COMPILED PROGRAMS ===');
  for (const s of shaders) {
    console.log(`  ${String(s.used).padStart(3)}x  shadowmapDef=${s.defShadowmap ? 'Y' : 'n'} dirLights=${s.nDirLights} dirShadows=${s.nDirShadows} getShadowDef=${s.hasGetShadowDef ? 'Y' : 'n'} calls=${s.getShadowCalls} shadowCoordV=${s.vHasShadowCoord ? 'Y' : 'n'}/F=${s.fHasShadowCoord ? 'Y' : 'n'}  ${s.key}`);
  }

  /* ------------------------------------------------------- 2. lights / scene audit */
  const lights = await page.evaluate(() => {
    const g = window.__game.internals;
    const out = { lights: [], renderer: {}, casters: 0, receivers: 0, castersInFrustum: [] };
    g.scene.traverse((o) => {
      if (o.isLight) {
        out.lights.push({
          type: o.type, intensity: +o.intensity.toFixed(3),
          color: '#' + o.color.getHexString(),
          castShadow: !!o.castShadow,
          pos: o.position ? [o.position.x, o.position.y, o.position.z].map((v) => +v.toFixed(1)) : null,
          shadowIntensity: o.shadow ? o.shadow.intensity : null,
          mapExists: !!(o.shadow && o.shadow.map),
          autoUpdate: o.shadow ? o.shadow.autoUpdate : null,
        });
      }
      if (o.isMesh) { if (o.castShadow) out.casters++; if (o.receiveShadow) out.receivers++; }
    });
    const r = g.renderer;
    out.renderer = { enabled: r.shadowMap.enabled, type: r.shadowMap.type, autoUpdate: r.shadowMap.autoUpdate, needsUpdate: r.shadowMap.needsUpdate };
    return out;
  });
  console.log('\n=== LIGHTS ===');
  console.log(JSON.stringify(lights, null, 1));

  /* --------------------------------------------------- 3. read back the shadow map */
  const smap = await page.evaluate(() => {
    const g = window.__game.internals;
    const sky = g.game.get('sky');
    const sun = sky.sunLight;
    const rt = sun.shadow.map;
    if (!rt) return { error: 'no shadow map' };
    const W = rt.width, H = rt.height;
    const buf = new Uint8Array(W * H * 4);
    g.renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
    // MeshDepthMaterial writes RGBADepthPacking
    const unpack = (i) => (buf[i] * (1 / 255) + buf[i + 1] * (1 / 65025) + buf[i + 2] * (1 / 16581375) + buf[i + 3] * (1 / 4228250625));
    let min = 2, max = -1, nOne = 0, n = 0, sum = 0;
    const hist = new Array(10).fill(0);
    for (let i = 0; i < buf.length; i += 4) {
      const d = unpack(i);
      if (d < min) min = d;
      if (d > max) max = d;
      if (d > 0.9999) nOne++;
      hist[Math.min(9, Math.floor(d * 10))]++;
      sum += d; n++;
    }
    // also raw channel stats in case packing assumption is wrong
    let r0 = 255, r1 = 0, a0 = 255, a1 = 0;
    for (let i = 0; i < buf.length; i += 4) {
      if (buf[i] < r0) r0 = buf[i]; if (buf[i] > r1) r1 = buf[i];
      if (buf[i + 3] < a0) a0 = buf[i + 3]; if (buf[i + 3] > a1) a1 = buf[i + 3];
    }
    return {
      size: [W, H], depthMin: +min.toFixed(5), depthMax: +max.toFixed(5), depthMean: +(sum / n).toFixed(5),
      fracAtFarPlane: +(nOne / n).toFixed(4), hist, rawR: [r0, r1], rawA: [a0, a1],
      cam: {
        left: sun.shadow.camera.left, right: sun.shadow.camera.right,
        top: sun.shadow.camera.top, bottom: sun.shadow.camera.bottom,
        near: sun.shadow.camera.near, far: sun.shadow.camera.far,
      },
      lightPos: [sun.position.x, sun.position.y, sun.position.z].map((v) => +v.toFixed(1)),
      targetPos: [sun.target.position.x, sun.target.position.y, sun.target.position.z].map((v) => +v.toFixed(1)),
      shadowCamPos: [sun.shadow.camera.position.x, sun.shadow.camera.position.y, sun.shadow.camera.position.z].map((v) => +v.toFixed(1)),
      bias: sun.shadow.bias, normalBias: sun.shadow.normalBias, radius: sun.shadow.radius,
      elevDeg: +sky.sunElevationDeg.toFixed(1),
    };
  });
  console.log('\n=== SHADOW MAP CONTENTS ===');
  console.log(JSON.stringify(smap, null, 1));
}

/* ------------------------------------------------------------- 4. the pixel diff */
const DIFF = () => {
  const g = window.__game;
  const cv = document.querySelector('#app canvas');
  const W = cv.width, H = cv.height;
  const grab = () => {
    const s = document.createElement('canvas'); s.width = W; s.height = H;
    const c = s.getContext('2d', { willReadFrequently: true });
    c.drawImage(cv, 0, 0);
    return c.getImageData(0, 0, W, H).data;
  };
  g.render();
  const a = grab();
  g.internals.renderer.shadowMap.enabled = false;
  g.internals.scene.traverse((o) => { if (o.material) { const ms = Array.isArray(o.material) ? o.material : [o.material]; ms.forEach((m) => { m.needsUpdate = true; }); } });
  g.render();
  const b = grab();
  // restore
  g.internals.renderer.shadowMap.enabled = true;
  g.internals.scene.traverse((o) => { if (o.material) { const ms = Array.isArray(o.material) ? o.material : [o.material]; ms.forEach((m) => { m.needsUpdate = true; }); } });
  g.render();
  let sum = 0, max = 0, n = 0, over8 = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let k = 0; k < 3; k++) {
      const d = Math.abs(a[i + k] - b[i + k]);
      sum += d; if (d > max) max = d; n++;
      if (d > 8) over8++;
    }
  }
  return { meanAbs: +(sum / n).toFixed(3), max, pctChannelsOver8: +(100 * over8 / n).toFixed(2) };
};
const diff = await page.evaluate(`(${DIFF.toString()})()`);
console.log('\n=== SHADOWS ON vs OFF (tod ' + TOD + ') ===');
console.log(JSON.stringify(diff));

await browser.close();
await server.close();
