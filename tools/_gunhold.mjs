#!/usr/bin/env node
/**
 * THROWAWAY. Does the avatar actually HOLD the gun?
 *
 * Six frames — rifle and pistol, at low ready / aimed / mid-recoil — plus the number
 * that settles it: the world-space distance from each wrist joint to the grip empty it
 * is meant to be wrapped around. Anything under ~0.06 m is inside the fist (the fist
 * mesh is a 0.05 m sphere hung off the wrist); the support hand may sit further out
 * when the arm cannot reach the handguard, but it must still land ON the weapon line,
 * so `foreGapPerp` — the distance from the wrist to the BORE AXIS rather than to the
 * fore empty — is the one that has to stay small.
 *
 *   node tools/_gunhold.mjs
 *
 * Writes captures/wip-gunhold/*.png and report.json.
 *
 * Measured after the r15 arm-IK pass (0 = the wrist joint is exactly on the empty):
 *   rifle ready   gripGap 0.000   fore off the gun by design (one-handed hip carry)
 *   rifle walking gripGap 0.000   left arm still on the gait swing
 *   rifle aim     gripGap 0.000   foreGap 0.000
 *   rifle firing  gripGap 0.000   foreGap 0.000   (hands ride the recoil kick)
 *   pistol aim    gripGap 0.000   foreGap 0.030   foreGapPerp 0.012
 * The pistol's support hand keeps a 3 cm offset on purpose — both fists cannot occupy
 * the same 5 cm sphere, so the fore empty sits below and left of the grip.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OUT = path.resolve('captures', 'wip-gunhold');
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
const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message.slice(0, 300)));
await page.goto(`http://127.0.0.1:${port}/?capture=1&seed=20240719`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });

const SETUP = () => {
  const g = window.__game;
  g.setTimeOfDay(0.35);
  g.releaseAll();
  g.setCamera(null);
  const s = g.state();
  g.place(s.player.pos[0], s.player.pos[2], 0);
  g.run(1.0);
  const st = g.state();
  return { px: st.player.pos[0], py: st.player.pos[1], pz: st.player.pos[2] };
};

/**
 * NOTE: every shot here runs on the GAMEPLAY camera, never on setCamera(). The weapon
 * aims along the camera's forward axis by design, so a free-fly camera parked to the
 * side is a camera the gun is pointing straight at — it projects to a 30 px disc and
 * shows nothing (the same view-axis trap the sphere beam hit; see CLAUDE.md). The
 * follow camera is also the only framing a player ever sees the hands from.
 */
const SHOT = ({ slot, aim, fire, seconds, walk }) => {
  const g = window.__game;
  const THREE = window.__THREE;
  g.releaseAll();
  g.setCamera(null);
  g.tap(slot);
  g.run(0.6);
  if (aim) g.hold('aim', true);
  if (walk) g.hold('forward', true);
  g.run(seconds);
  if (fire) { g.hold('fire', true); g.run(0.085); }
  g.run(0.02);

  // ---- measure the live graph ----
  const scene = g.internals.scene;
  const byName = {};
  scene.traverse((o) => {
    if (!o.name) return;
    if (o.name === 'handR' || o.name === 'handL') byName[o.name] = o;
    if (/_(grip|fore|muzzle)$/.test(o.name) && o.parent?.visible) byName[o.name.split('_').slice(-1)[0]] = o;
  });
  const P = (o) => { const v = new THREE.Vector3(); o.getWorldPosition(v); return v; };
  const st = g.state();
  const out = { equipped: st.loadout?.equipped ?? null, aim: +(st.weapons?.aimBlend ?? 0).toFixed(2) };
  if (byName.handR && byName.grip) out.gripGap = +P(byName.handR).distanceTo(P(byName.grip)).toFixed(3);
  if (byName.handL && byName.fore) {
    const wl = P(byName.handL), fp = P(byName.fore), mz = P(byName.muzzle);
    out.foreGap = +wl.distanceTo(fp).toFixed(3);
    // perpendicular distance from the left wrist to the bore axis
    const axis = mz.clone().sub(fp).normalize();
    const rel = wl.clone().sub(fp);
    out.foreGapPerp = +rel.clone().sub(axis.clone().multiplyScalar(rel.dot(axis))).length().toFixed(3);
    out.foreAlong = +rel.dot(axis).toFixed(3);
  }
  return out;
};

const base = await page.evaluate(SETUP);

const SHOTS = [
  ['rifle-ready', { slot: 'slot4', aim: false, fire: false, seconds: 0.8 }],
  ['rifle-walk', { slot: 'slot4', aim: false, fire: false, seconds: 1.2, walk: true }],
  ['rifle-aim', { slot: 'slot4', aim: true, fire: false, seconds: 1.0 }],
  ['rifle-fire', { slot: 'slot4', aim: true, fire: true, seconds: 1.0 }],
  ['pistol-ready', { slot: 'slot3', aim: false, fire: false, seconds: 0.8 }],
  ['pistol-aim', { slot: 'slot3', aim: true, fire: false, seconds: 1.0 }],
];

const report = [];
for (const [name, cfg] of SHOTS) {
  const r = await page.evaluate(SHOT, { ...base, ...cfg });
  report.push({ name, ...r });
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log(name.padEnd(16), JSON.stringify(r));
}

await writeFile(path.join(OUT, 'report.json'), JSON.stringify({ report, errors: errs }, null, 2));
console.log('errors:', errs.length ? errs : 'none');
await browser.close();
await server.close();
