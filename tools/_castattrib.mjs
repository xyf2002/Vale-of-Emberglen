#!/usr/bin/env node
/**
 * THROWAWAY PROBE — WHO ACTUALLY CASTS?
 *
 * The r19 blind critic: "Count the trees: zero of them darken the ground." Two
 * hypotheses were on the table: (a) the trees are missing `castShadow`, or (b) they are
 * in the caster set but their shadows are not reaching the frame.
 *
 * This attributes the shadow term per caster CLASS. It renders the staged shot, then
 * turns castShadow off on one class at a time and diffs. `potential` is the frame with
 * the key at zero, i.e. the largest diff any shadow could possibly produce, so
 * mean/potential is the share of the frame's key that this class is removing.
 *
 * Classes are identified structurally from the scene graph, because the meshes are added
 * anonymously by world/index.js:
 *   trees   InstancedMesh whose geometry.userData.trunkR exists  (buildTree sets it)
 *   ground  the mesh named 'ground'
 *   rest    everything else that has castShadow on
 *
 *   node tools/_castattrib.mjs [shot]
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const SHOT = process.argv[2] || 'vista';

const server = await createServer({
  server: { port: 0, host: '127.0.0.1', strictPort: false, hmr: false, watch: null },
  logLevel: 'error',
});
await server.listen();
const port = server.config.server.port ?? server.httpServer.address().port;
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('  [page err]', m.text().slice(0, 300)); });
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game?.ready === true || window.__game?.ready === 'failed', null, { timeout: 240000 });

await page.evaluate((shot) => {
  const g = window.__game;
  if (shot === 'over') {
    g.setTimeOfDay(0.29); g.setCamera(null);
    const s0 = g.state(); g.place(s0.player.pos[0], s0.player.pos[2], 0); g.run(2.2);
  } else {
    g.setTimeOfDay(0.60); g.setCamera(null); g.run(1.5);
    const s = g.state(); const [x, y, z] = s.player.pos;
    g.setCamera([x - 5, y + 1.7, z + 7], [x + 34, y + 3.5, z - 46], 62);
    g.run(0.6);
  }
}, SHOT);

const out = await page.evaluate(() => {
  const g = window.__game;
  const scene = g.internals.scene;
  const cv = document.querySelector('#app canvas');
  const W = cv.width, H = cv.height;
  const s = document.createElement('canvas'); s.width = W; s.height = H;
  const c2 = s.getContext('2d', { willReadFrequently: true });
  const grab = () => { c2.drawImage(cv, 0, 0); return c2.getImageData(0, 0, W, H).data; };

  const classes = { trees: [], ground: [], bushes: [], rocks: [], rest: [] };
  scene.traverse((o) => {
    if (!o.castShadow || !o.isMesh) return;
    const ud = o.geometry?.userData || {};
    if (ud.trunkR !== undefined) classes.trees.push(o);
    else if (o.name === 'ground') classes.ground.push(o);
    else classes.rest.push(o);
  });

  g.render();
  const A = grab();
  // calibration: key at zero
  const sun = g.internals.game.get('sky').sunLight;
  const keep = sun.intensity;
  sun.intensity = 0; g.render();
  const K = grab();
  sun.intensity = keep;
  let ps = 0;
  for (let i = 0; i < A.length; i += 4) for (let k = 0; k < 3; k++) ps += Math.abs(A[i + k] - K[i + k]);
  const potential = ps / (A.length / 4 * 3);

  const res = {};
  for (const [name, list] of Object.entries(classes)) {
    if (!list.length) { res[name] = { n: 0 }; continue; }
    for (const o of list) o.castShadow = false;
    g.render();
    const B = grab();
    for (const o of list) o.castShadow = true;
    let sum = 0, max = 0, hit = 0;
    const half = A.length / 2;
    let sumLower = 0, nLower = 0;
    for (let i = 0; i < A.length; i += 4) {
      let d = 0;
      for (let k = 0; k < 3; k++) { const q = Math.abs(A[i + k] - B[i + k]); sum += q; if (q > d) d = q; }
      if (d > 4) hit++;
      if (i >= half) { sumLower += d; nLower++; }
      if (d > max) max = d;
    }
    res[name] = {
      n: list.length,
      mean: +(sum / (A.length / 4 * 3)).toFixed(3),
      share: +((sum / (A.length / 4 * 3)) / potential * 100).toFixed(1),
      pixels: +(hit / (A.length / 4) * 100).toFixed(2),
      lowerMean: +(sumLower / nLower).toFixed(3),
      max,
    };
  }
  // and everything at once
  const all = [...classes.trees, ...classes.ground, ...classes.rest];
  for (const o of all) o.castShadow = false;
  g.render();
  const B = grab();
  for (const o of all) o.castShadow = true;
  let sum = 0, hit = 0;
  for (let i = 0; i < A.length; i += 4) {
    let d = 0;
    for (let k = 0; k < 3; k++) { const q = Math.abs(A[i + k] - B[i + k]); sum += q; if (q > d) d = q; }
    if (d > 4) hit++;
  }
  res.ALL = { n: all.length, mean: +(sum / (A.length / 4 * 3)).toFixed(3), share: +((sum / (A.length / 4 * 3)) / potential * 100).toFixed(1), pixels: +(hit / (A.length / 4) * 100).toFixed(2) };
  res.potential = +potential.toFixed(2);

  // is a tree instance actually inside the shadow camera box?
  const sky = g.internals.game.get('sky');
  const cam = sky.sunLight.shadow.camera;
  const inv = new (Object.getPrototypeOf(cam.matrixWorldInverse).constructor)();
  const trees = classes.trees;
  const info = [];
  const THREE = g.internals.THREE;
  for (const t of trees) {
    const bs = t.boundingSphere || (t.computeBoundingSphere(), t.boundingSphere);
    info.push({ count: t.count, r: +bs.radius.toFixed(1), c: [bs.center.x, bs.center.y, bs.center.z].map((v) => +v.toFixed(1)), frustumCulled: t.frustumCulled, visible: t.visible });
  }
  res.treeMeshes = info;
  res.shadowBox = { half: cam.right, near: cam.near, far: cam.far, pos: [sky.sunLight.position.x, sky.sunLight.position.y, sky.sunLight.position.z].map((v) => +v.toFixed(1)), target: [sky.sunLight.target.position.x, sky.sunLight.target.position.y, sky.sunLight.target.position.z].map((v) => +v.toFixed(1)) };
  res.shadowIntensity = sky.sunLight.shadow.intensity;
  res.sunIntensity = sky.sunLight.intensity;
  res.camPos = [g.internals.camera.position.x, g.internals.camera.position.y, g.internals.camera.position.z].map((v) => +v.toFixed(1));
  return res;
});

console.log(JSON.stringify(out, null, 1));
await browser.close();
await server.close();
