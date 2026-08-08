/**
 * Throwaway probe (r19, surface-grain round).
 *
 * QUESTION IT ANSWERS: which meshes in the scene actually run the material hooks in
 * src/world/materials.js? A cranked-to-absurd rock grain produced a bit-identical
 * boulder in overshoulder_meadow, which has exactly two explanations — the shader patch
 * is not compiling, or the thing that looks like a boulder is not a rock. Guessing
 * between those costs a 3-minute capture per guess; this costs 40 seconds.
 *
 * It walks the scene, and for every Mesh/InstancedMesh reports name, geometry triangle
 * count, material type, whether the material carries the userData tags applyMossShader
 * and makeAerialMaterial leave behind, and whether the compiled program's fragment
 * source contains the grain function. The last one is the load-bearing part: it proves
 * the onBeforeCompile chain survived, rather than assuming it.
 *
 *   node tools/_grainprobe.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

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
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto(`http://127.0.0.1:${port}/?capture=1&seed=20240719`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__game?.ready === true || window.__game?.ready === 'failed',
  null, { timeout: 180000 });

const rows = await page.evaluate(() => {
  const g = window.__game;
  const renderer = g.internals.renderer;
  // three keeps every compiled program on renderer.info.programs with its cacheKey and
  // the WebGLProgram wrapper, which holds the final fragment source in .fragmentShader
  const progs = renderer.info.programs || [];
  const out = [];
  g.internals.scene.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    if (!m) return;
    const idx = m.geometry?.index;
    const tri = Math.round((o.geometry?.index?.count ?? o.geometry?.attributes?.position?.count ?? 0) / 3);
    const prog = progs.find((p) => p.cacheKey && m.program && p.id === m.program.id);
    const src = m.program?.fragmentShader ?? prog?.fragmentShader ?? '';
    out.push({
      name: o.name || '(unnamed)',
      kind: o.isInstancedMesh ? `inst x${o.count}` : 'mesh',
      mat: m.type,
      moss: !!m.userData?.moss,
      grain: !!m.userData?.rockGrain,
      aerial: !!m.uniforms?.uCoarseA,
      hasSg: typeof src === 'string' && src.includes('sgNoise_'),
      visible: o.visible,
      tri,
    });
  });
  return out;
});

// Compiled-program audit. `renderer.info.programs[i].fragmentShader` is the WebGLShader
// OBJECT, not its text — the source has to come back out of the context with
// gl.getShaderSource(). Reading material.program instead does not work in r185; the
// program handle lives in renderer.properties, not on the material.
const progs = await page.evaluate(() => {
  const r = window.__game.internals.renderer;
  const gl = r.getContext();
  return (r.info.programs || []).map((p) => {
    let src = '';
    try { src = gl.getShaderSource(p.fragmentShader) || ''; } catch { /* ignore */ }
    return { key: String(p.cacheKey).slice(0, 90), sg: src.includes('sgNoise_'), n: p.usedTimes };
  });
});
console.log('\n--- compiled fragment programs containing sgNoise_ ---');
for (const p of progs) if (p.sg) console.log('  sgNoise_ YES  x' + p.n, ' ', p.key);
console.log('  (' + progs.filter((p) => p.sg).length + ' of ' + progs.length + ' programs)\n');

const seen = new Map();
for (const r of rows) {
  const k = `${r.name}|${r.mat}|${r.moss}|${r.grain}|${r.aerial}|${r.hasSg}`;
  const e = seen.get(k) || { ...r, n: 0, tri: 0 };
  e.n++; e.tri += r.tri;
  seen.set(k, e);
}
console.log('name'.padEnd(22), 'kind'.padEnd(12), 'material'.padEnd(22), 'moss grain aerial sgNoise  n     tris');
for (const r of [...seen.values()].sort((a, b) => b.tri - a.tri)) {
  console.log(
    r.name.padEnd(22), r.kind.padEnd(12), r.mat.padEnd(22),
    String(r.moss).padEnd(5), String(r.grain).padEnd(5), String(r.aerial).padEnd(6),
    String(r.hasSg).padEnd(8), String(r.n).padEnd(5), r.tri);
}

// ---------------------------------------------------------------------------
// A/B a boulder inside ONE boot. Both frames come from the same build, the same
// seed and the same camera; the only difference is the uRockGrain uniform, which is
// live. That is the only honest way to see what the grain is worth on a rock — a
// two-build A/B also carries whatever else changed in the tree between them, which
// is exactly how an hour went missing this round.
const place = await page.evaluate(() => {
  const T = window.__THREE;
  const scene = window.__game.internals.scene;
  let best = null;
  scene.traverse((o) => {
    if (!o.isInstancedMesh || !o.material?.userData?.rockGrain) return;
    const m = new T.Matrix4(), p = new T.Vector3(), q = new T.Quaternion(), s = new T.Vector3();
    for (let i = 0; i < o.count; i++) {
      o.getMatrixAt(i, m); m.decompose(p, q, s);
      if (!best || s.x > best.s) best = { x: p.x, y: p.y, z: p.z, s: s.x };
    }
  });
  if (!best) return null;
  const d = best.s * 3.2;
  window.__game.setCamera([best.x + d * 0.7, best.y + best.s * 1.5, best.z + d * 0.7],
    [best.x, best.y + best.s * 0.6, best.z], 45);
  window.__game.setTimeOfDay(0.72);
  window.__game.render();
  return best;
});
console.log('biggest rock instance:', place);
// uRockGrain is (bumpMul, albedoMul) and both are live uniforms, so the whole
// amplitude sweep is one boot and one camera. Six screenshots in 8 seconds beats six
// 3-minute captures, and unlike a build-to-build A/B nothing else can drift.
for (const [b, a] of [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]]) {
  await page.evaluate(([bb, aa]) => {
    window.__game.internals.scene.traverse((o) => {
      if (o.material?.userData?.rockGrain) o.material.userData.rockGrain.value.set(bb, aa);
    });
    window.__game.render();
  }, [b, a]);
  await page.screenshot({ path: `captures/_grain_rock_${b}.png`, timeout: 120000 });
}
console.log('wrote captures/_grain_rock_{0..4}.png');

// Same trick for the far ranges. uCoarseA/uFineA/uStrata on every aerial material are
// live, so the mountain amplitude is a sweep rather than a series of builds.
await page.evaluate(() => {
  const g = window.__game;
  // Reuse the vista_golden staging verbatim (tools/shots.mjs, read only). An invented
  // camera is not worth debugging: the elevated one tried first put the lens inside the
  // haze at 260 m and photographed 90% fog, where a 300% albedo swing on the aerial
  // material is genuinely invisible.
  g.setTimeOfDay(0.60);
  g.setCamera(null);
  g.run(1.5);
  const st = g.state();
  const [px, py, pz] = st.player.pos;
  g.setCamera([px - 5, py + 1.7, pz + 7], [px + 34, py + 3.5, pz - 46], 62);
  // NEGATIVE RESULT: setCamera() alone is not enough. The override is consumed by the
  // player camera during update(), so render() straight after it photographs the
  // PREVIOUS camera — the first setCamera in this file appeared to work only because
  // the shot before it had already stepped the sim. Step the clock, then render.
  g.run(0.1); g.run(0.1);
});
for (const k of [0, 1, 2]) {
  const hit = await page.evaluate((kk) => {
    let n = 0;
    window.__game.internals.scene.traverse((o) => {
      const u = o.material?.uniforms;
      if (!u?.uCoarseA) return;
      // 0 = everything off, 1 = STRATA only (pure albedo, no bump), 2 = BUMP only.
      // Splitting them is the only way to tell "the noise is not evaluating" from
      // "the bump construction is wrong", and they need completely different fixes.
      u.uCoarseA.value = kk === 2 ? 40.0 : 0.0;
      u.uFineA.value = kk === 2 ? 10.0 : 0.0;
      u.uStrata.value = kk === 1 ? 3.0 : 0.0;
      // k=2 also hides the mesh outright. If the far ranges do not disappear, they are
      // not drawn by this material and no uniform on it can ever change them.
      o.visible = kk !== 2;
      n++;
    });
    window.__game.render();
    return n;
  }, k);
  console.log('  aerial materials hit at k=' + k + ':', hit);
  await page.screenshot({ path: `captures/_grain_mtn_${k}.png`, timeout: 120000 });
}
console.log('wrote captures/_grain_mtn_{0,1,2}.png  (0 = r18 flat, 1 = shipped, 2 = double)');
// NEGATIVE RESULT on this second sweep, kept so nobody rebuilds it: staging a mountain
// A/B from the SPAWN camera does not work. At player eye height the near grass carpet
// occupies the whole lower two thirds and the far ranges land in a band a hundred pixels
// tall, and the measured luminance sd over that band is identical to three decimal
// places at 0x, 1x and 2x amplitude — not because the uniform did not take (the rock
// sweep above proves the same mechanism works) but because there is almost no mountain
// in the frame to change. Judge the ranges off captures/<round>/vista_golden.png, whose
// camera is staged for exactly that, or give this probe an elevated camera first.

await browser.close();
await server.close();
