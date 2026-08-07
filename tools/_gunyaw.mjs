#!/usr/bin/env node
/**
 * THROWAWAY. Does the muzzle stay put relative to the CHARACTER when the camera turns?
 *
 * The reported bug: turning the view changed where the gun pointed relative to the hand
 * and the body. The cause was a split basis — the carry ANCHOR was body-relative while
 * the carry DIRECTION was built from the camera — so standing still (which turns only
 * the camera, never `bodyYaw`) pivoted the weapon about the hand.
 *
 * So this sweeps the camera a full turn in both poses and records, per sample:
 *   boreVsBody   angle between the weapon's -Z (the bore) and the body's forward
 *   boreVsForearm angle between the bore and the forearm — the hand/weapon relation.
 *                (wrist-to-grip is exactly 0: the IK solves the wrist ONTO the grip.)
 *   camMinusBody |camera yaw - body yaw|, which the yaw window is supposed to cap
 *
 * PASS: boreVsBody spread (max-min) under ~2 deg at low ready — the weapon is welded to
 * the torso. At full aim the bore follows the camera by design, so there the number that
 * matters is camMinusBody staying inside the 28 deg window.
 *
 *   node tools/_gunyaw.mjs
 *
 * Writes captures/wip-gunyaw/report.json (+ four frames of the sweep).
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OUT = path.resolve('captures', 'wip-gunyaw');
await mkdir(OUT, { recursive: true });

const server = await createServer({
  server: { port: 0, host: '127.0.0.1', strictPort: false, hmr: false, watch: null },
  logLevel: 'error',
});
await server.listen();
const port = server.config.server.port ?? server.httpServer.address().port;
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 520 } });
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message.slice(0, 300)));
await page.goto(`http://127.0.0.1:${port}/?capture=1&seed=20240719`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });

/**
 * One sweep. `aim` decides the pose; `steps` samples are taken around a full turn, each
 * after letting the sim settle so nothing is measured mid-damp.
 */
const SWEEP = ({ aim, steps, settle }) => {
  const g = window.__game, THREE = window.__THREE;
  g.releaseAll();
  g.setCamera(null);
  g.setTimeOfDay(0.35);
  g.tap('slot4');                       // carbine
  g.run(1.2);
  if (aim) { g.hold('aim', true); g.run(1.0); }

  const game = g.internals.game;
  const player = game.get('player');
  const scene = g.internals.scene;

  const DEG = 180 / Math.PI;
  const grip = () => { let o = null; scene.traverse((n) => { if (n.name === 'rifle_grip' && n.parent?.visible) o = n; }); return o; };
  const hand = () => { let o = null; scene.traverse((n) => { if (n.name === 'handR') o = n; }); return o; };
  const rig = () => { let o = null; scene.traverse((n) => { if (n.name === 'weapon_rifle_rig' && n.visible) o = n; }); return o; };

  const out = [];
  // 0.0025 rad per look-unit on yaw (CameraRig.look), so a full turn is 2pi/0.0025
  const perStep = (Math.PI * 2) / steps / 0.0025;
  for (let i = 0; i < steps; i++) {
    g.look(perStep, 0);
    g.run(settle);

    const r = rig(), h = hand(), gp = grip();
    if (!r || !h || !gp) { out.push(null); continue; }
    const bore = new THREE.Vector3(0, 0, -1).applyQuaternion(r.quaternion).normalize();
    const by = player.bodyYaw;
    const fwd = new THREE.Vector3(-Math.sin(by), 0, -Math.cos(by));
    const wrist = new THREE.Vector3(); h.getWorldPosition(wrist);
    const gpw = new THREE.Vector3(); gp.getWorldPosition(gpw);
    // wrist -> grip is a ZERO vector by construction: the arm IK solves the wrist onto
    // the grip empty exactly, so the hand/weapon relationship cannot drift and there is
    // no angle to measure there. The forearm is the honest proxy — if the weapon were
    // swinging in the hand, the angle between the bore and the forearm would move.
    const el = h.parent;
    const elbow = new THREE.Vector3(); el.getWorldPosition(elbow);
    const toGrip = wrist.clone().sub(elbow);

    // flatten the bore for the body comparison: the carry pose has a fixed DOWN angle
    // and the question is only whether it swings sideways relative to the character
    const boreFlat = new THREE.Vector3(bore.x, 0, bore.z).normalize();
    const camYaw = player.camera.yaw;
    let d = camYaw - by;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;

    out.push({
      i,
      boreVsBody: +(Math.acos(Math.max(-1, Math.min(1, boreFlat.dot(fwd)))) * DEG).toFixed(2),
      borePitch: +(Math.asin(Math.max(-1, Math.min(1, bore.y))) * DEG).toFixed(2),
      boreVsForearm: toGrip.lengthSq() > 1e-8
        ? +(Math.acos(Math.max(-1, Math.min(1, toGrip.normalize().dot(bore)))) * DEG).toFixed(2)
        : null,
      camMinusBody: +Math.abs(d * DEG).toFixed(2),
      wristToGrip: +wrist.distanceTo(gpw).toFixed(3),
    });
  }
  return out;
};

const stat = (rows, key) => {
  const v = rows.filter(Boolean).map((r) => r[key]).filter((x) => x != null);
  if (!v.length) return null;
  const min = Math.min(...v), max = Math.max(...v);
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  return { min: +min.toFixed(2), max: +max.toFixed(2), spread: +(max - min).toFixed(2), mean: +mean.toFixed(2) };
};

const report = {};
for (const pose of ['ready', 'aim']) {
  const rows = await page.evaluate(SWEEP, { aim: pose === 'aim', steps: 16, settle: 0.35 });
  report[pose] = {
    boreVsBody: stat(rows, 'boreVsBody'),
    boreVsForearm: stat(rows, 'boreVsForearm'),
    camMinusBody: stat(rows, 'camMinusBody'),
    wristToGrip: stat(rows, 'wristToGrip'),
    samples: rows,
  };
  console.log(pose.padEnd(6),
    'boreVsBody', JSON.stringify(report[pose].boreVsBody),
    'camMinusBody', JSON.stringify(report[pose].camMinusBody));
  await page.screenshot({ timeout: 60000, path: path.join(OUT, `${pose}.png`) });
}

await writeFile(path.join(OUT, 'report.json'), JSON.stringify({ report, errors: errs }, null, 2));
console.log('errors:', errs.length ? errs : 'none');
await browser.close();
await server.close();
