#!/usr/bin/env node
/**
 * THROWAWAY. One still, mid-burst, over the shoulder, plus the numbers needed to tell
 * "the effect is not there" apart from "the effect is there and two pixels wide".
 *
 *   node tools/_weapshot.mjs
 *
 * Writes captures/wip-weap/burst_overshoulder.png and prints where the weapon, the
 * muzzle, the tracer and the impact landed in normalised device coordinates.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const OUT = path.resolve('captures', 'wip-weap');
await mkdir(OUT, { recursive: true });

// hmr:false matters here. Five builders are editing this tree at once, and a vite HMR
// reload triggered by somebody else's save mid-shot silently replaced the finished frame
// with the boot overlay — which is exactly the "screenshot of a title card" failure the
// capture harness's frame probe exists to catch.
const server = await createServer({
  server: { port: 0, host: '127.0.0.1', strictPort: false, hmr: false, watch: null },
  logLevel: 'error',
});
await server.listen();
const port = server.config.server.port ?? server.httpServer.address().port;
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message.slice(0, 300)));
await page.goto(`http://127.0.0.1:${port}/?capture=1&seed=20240719`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });

const RUN = () => {
  const g = window.__game;
  const T = window.__THREE;
  const game = g.internals.game;
  const scene = g.internals.scene, cam = g.internals.camera;

  g.setTimeOfDay(0.29);
  g.setCamera(null);
  const s0 = g.state();
  const px = s0.player.pos[0], pz = s0.player.pos[2];
  g.place(px, pz, 0);
  g.run(2.0);

  // a subject on the camera's own axis: the shoulder cam sits 0.7 m right of the body
  const cr = g.spawnCreature('mosshorn', px + 0.7, pz - 11);
  g.run(0.6);

  g.tap('slot4'); g.run(0.5);           // carbine
  g.hold('aim', true); g.run(0.4);

  // Put the crosshair on the animal the way a player would: measure the angle between
  // the camera's forward and the creature's centre of mass and push that much look at
  // the input layer. (Left on the default -5 degree camera pitch the burst passed a
  // hand's width over a Mosshorn's back and buried itself in the hillside at 22 m.)
  const aimAt = () => {
    const fwd = new T.Vector3(); cam.getWorldDirection(fwd);
    const to = new T.Vector3(cr.position.x, cr.position.y + cr.def.size * 0.52, cr.position.z).sub(cam.position).normalize();
    const dPitch = Math.asin(to.y) - Math.asin(fwd.y);
    g.look(0, -dPitch / (0.0025 * 0.86));
  };
  aimAt(); g.run(0.15); aimAt(); g.run(0.15);

  // Mid-burst, but the STILL has to land on a frame where there is something to see:
  // the flash lives 55 ms and the tracer crosses 12 m in 26 ms, so a frame chosen by
  // wall-position rather than by event is usually 100 ms after the last round and shows
  // neither. Step until a round has just left the barrel, then give it one frame of
  // flight so the streak has cleared the muzzle.
  g.hold('fire', true);
  g.run(0.30);
  const W = game.get('weapons');
  let guard = 0;
  // 0.69 is the highest value ever observable from outside: the flash is lit during the
  // trigger step and then decremented by the same frame's fx update before anyone can
  // read it. Asking for 0.75 silently never matched and the still landed on whatever
  // frame the guard ran out on.
  while (guard++ < 40 && W.snapshot().fx.flash < 0.65) g.run(1 / 60);
  g.run(1 / 60);
  g.render();

  // ---- how much of the frame does each piece of evidence actually own? ----
  // Squinting at a 1280x720 still is not a measurement. Toggle each effect object off,
  // re-render, and count how many pixels move. If the tracer owns zero pixels it is not
  // there, whatever the object counts say.
  const cv = document.querySelector('#app canvas');
  const GW = 640, GH = 360;
  const grab = () => {
    const s = document.createElement('canvas'); s.width = GW; s.height = GH;
    const c2 = s.getContext('2d', { willReadFrequently: true });
    c2.drawImage(cv, 0, 0, GW, GH);
    return c2.getImageData(0, 0, GW, GH).data;
  };
  const base = grab();
  const owned = {};
  for (const name of ['weapon_flash', 'weapon_tracers', 'weapon_debris', 'weapon_sparks', 'weapon_cases', 'weapon_rifle_rig']) {
    const o = scene.getObjectByName(name);
    if (!o || !o.visible) { owned[name] = 0; continue; }
    o.visible = false;
    g.render();
    const b = grab();
    o.visible = true;
    let n = 0, peak = 0;
    for (let i = 0; i < base.length; i += 4) {
      const d = Math.abs(base[i] - b[i]) + Math.abs(base[i + 1] - b[i + 1]) + Math.abs(base[i + 2] - b[i + 2]);
      if (d > 12) n++;
      if (d > peak) peak = d;
    }
    owned[name] = { px: n, pctOfFrame: +(100 * n / (GW * GH)).toFixed(2), peakDelta: peak };
  }
  g.render();

  // why is the tracer invisible? dump its instance transform and where it projects
  const tr = scene.getObjectByName('weapon_tracers');
  const trDump = tr ? (() => {
    const m = new T.Matrix4().fromArray(tr.instanceMatrix.array, 0);
    const pos = new T.Vector3(), q = new T.Quaternion(), sc = new T.Vector3();
    m.decompose(pos, q, sc);
    const head = pos.clone(), tail = pos.clone().add(new T.Vector3(0, 0, 1).applyQuaternion(q).multiplyScalar(sc.z));
    const proj = (v) => { const c2 = v.clone().project(cam); return [+c2.x.toFixed(3), +c2.y.toFixed(3), +c2.z.toFixed(3)]; };
    return {
      count: tr.count, visible: tr.visible, hasColor: !!tr.instanceColor,
      opacity: tr.material.opacity, scaleZ: +sc.z.toFixed(2),
      head: [+head.x.toFixed(2), +head.y.toFixed(2), +head.z.toFixed(2)], headNdc: proj(head),
      tail: [+tail.x.toFixed(2), +tail.y.toFixed(2), +tail.z.toFixed(2)], tailNdc: proj(tail),
      camPos: [+cam.position.x.toFixed(2), +cam.position.y.toFixed(2), +cam.position.z.toFixed(2)],
      color: tr.instanceColor ? [+tr.instanceColor.array[0].toFixed(2), +tr.instanceColor.array[1].toFixed(2), +tr.instanceColor.array[2].toFixed(2)] : null,
    };
  })() : null;

  const impacts = game.bus.log.filter((e) => e.evt === 'weapon:impact').slice(-4)
    .map((e) => ({ surface: e.payload.surface, d: e.payload.distance }));
  const hits = game.bus.log.filter((e) => e.evt === 'weapon:hit').length;

  const ndc = (o) => {
    const v = new T.Vector3();
    o.getWorldPosition(v);
    const d = v.distanceTo(cam.position);
    v.project(cam);
    return { x: +v.x.toFixed(3), y: +v.y.toFixed(3), z: +v.z.toFixed(3), dist: +d.toFixed(2) };
  };

  const found = {};
  scene.traverse((o) => {
    if (/^weapon_/.test(o.name)) found[o.name] = { visible: o.visible, parentVisible: o.parent?.visible ?? null, ndc: ndc(o), count: o.count };
  });

  const rig = scene.getObjectByName('weapon_rifle_rig');
  const muzzle = rig ? rig.children.find((c) => c.type === 'Object3D') : null;
  const gun = scene.getObjectByName('weapon_rifle');
  const gcol = gun?.geometry.attributes.color;
  const mat = gun ? {
    metalness: gun.material.metalness, roughness: gun.material.roughness,
    vcol0: gcol ? [+gcol.array[0].toFixed(3), +gcol.array[1].toFixed(3), +gcol.array[2].toFixed(3)] : null,
    worldY: +new T.Vector3().setFromMatrixPosition(gun.matrixWorld).y.toFixed(2),
  } : null;

  return {
    weapons: g.state().weapons,
    stats: g.stats(),
    found,
    muzzleNdc: muzzle ? ndc(muzzle) : null,
    mat, owned, trDump,
    impacts, hits,
    creature: { id: cr.id, stamina: cr.stamina01 ?? 1, pos: [+cr.position.x.toFixed(2), +cr.position.z.toFixed(2)], ndc: ndc(cr.root) },
  };
};

/**
 * A second still from side-on. Fired down the camera axis, the tracer and the impact
 * project into the same 60 px of frame as the muzzle flash — they are foreshortened to
 * nothing, which is true of every third-person shooter and tells you nothing about
 * whether the effects exist. Across the frame, they either read or they do not.
 */
const SIDE = () => {
  const g = window.__game;
  const game = g.internals.game;
  const W = game.get('weapons');
  const scene = g.internals.scene;
  const s = g.state();
  const p = s.player.pos;
  // Over the player's right shoulder but well off the firing line, so the round crosses
  // the frame at ~20 degrees instead of vanishing down the view axis.
  const ex = p[0] + 6.0, ez = p[2] + 3.0;
  g.setCamera([ex, g.groundAt(ex, ez) + 2.2, ez], [p[0] - 1.5, p[1] + 0.6, p[2] - 15], 52);
  g.run(0.2);
  g.hold('fire', true);
  g.run(0.20);
  let guard = 0;
  while (guard++ < 40 && W.snapshot().fx.flash < 0.65) g.run(1 / 60);
  g.run(2 / 60);          // let the streak clear the barrel and cross the frame
  g.render();

  const cv = document.querySelector('#app canvas');
  const GW = 640, GH = 360;
  const grab = () => {
    const c = document.createElement('canvas'); c.width = GW; c.height = GH;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(cv, 0, 0, GW, GH);
    return x.getImageData(0, 0, GW, GH).data;
  };
  const base = grab();
  const owned = {};
  for (const name of ['weapon_flash', 'weapon_tracers', 'weapon_debris']) {
    const o = scene.getObjectByName(name);
    if (!o || !o.visible) { owned[name] = 'not visible'; continue; }
    o.visible = false; g.render(); const b = grab(); o.visible = true;
    let n = 0, peak = 0;
    for (let i = 0; i < base.length; i += 4) {
      const d = Math.abs(base[i] - b[i]) + Math.abs(base[i + 1] - b[i + 1]) + Math.abs(base[i + 2] - b[i + 2]);
      if (d > 12) n++;
      if (d > peak) peak = d;
    }
    owned[name] = { px: n, pctOfFrame: +(100 * n / (GW * GH)).toFixed(2), peakDelta: peak };
  }
  g.render();
  return { fx: W.snapshot().fx, shots: W.snapshot().shots, owned };
};

const out = await page.evaluate(`(${RUN.toString()})()`);
console.log(JSON.stringify(out, null, 1));
if (errs.length) console.log('CONSOLE ERRORS:', errs);
// the box is shared with four other capture harnesses; 30 s is not always enough
await page.screenshot({ path: path.join(OUT, 'burst_overshoulder.png'), animations: 'disabled', timeout: 180000 });
// a crop around the shoulder/target axis, so the weapon and the flash can be judged at
// something better than 25 px wide
await page.screenshot({
  path: path.join(OUT, 'burst_crop.png'), animations: 'disabled', timeout: 180000,
  clip: { x: 440, y: 250, width: 500, height: 320 },
});

const side = await page.evaluate(`(${SIDE.toString()})()`);
console.log('side:', JSON.stringify(side));
await page.screenshot({ path: path.join(OUT, 'burst_side.png'), animations: 'disabled', timeout: 180000 });
await browser.close();
await server.close();
