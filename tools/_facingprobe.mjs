#!/usr/bin/env node
/**
 * THROWAWAY. Which way does the avatar face while walking, seen through the REAL
 * gameplay camera (no override)?
 *
 *   node tools/_facingprobe.mjs
 *
 * Walks forward for two seconds and photographs it, then prints bodyYaw, the camera's
 * yaw and the world-space z of the head's face marker vs the pack, so "the face is
 * pointing at the follow camera" is a number and not an opinion.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const OUT = path.resolve('captures', 'wip-facing');
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
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message.slice(0, 300)));
await page.goto(`http://127.0.0.1:${port}/?capture=1&seed=20240719`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });

const RUN = () => {
  const g = window.__game;
  const T = window.__THREE;
  g.setTimeOfDay(0.30);
  g.setCamera(null);
  const s0 = g.state();
  g.place(s0.player.pos[0], s0.player.pos[2], 0);
  g.run(0.5);
  g.hold('forward', true);
  g.run(2.0);

  const st = g.state();
  const game = g.internals.game;
  const player = game.get('player');
  const cam = g.internals.camera;

  // where the avatar's own local +Z and -Z land in world space
  const root = player.root;
  const fwdLocal = new T.Vector3(0, 0, -1).applyQuaternion(root.quaternion);   // rig forward
  const camToBody = new T.Vector3().subVectors(root.position, cam.position).setY(0).normalize();

  return {
    bodyYawDeg: st.player.bodyYawDeg,
    camYawDeg: st.player.cam.yawDeg,
    speed: st.player.speed,
    // +1 = the camera is behind the rig's forward axis (normal third person)
    camBehindRigForward: +fwdLocal.dot(camToBody).toFixed(3),
    velocity: [+player.velocity.x.toFixed(2), +player.velocity.z.toFixed(2)],
    rigForwardWorld: [+fwdLocal.x.toFixed(2), +fwdLocal.z.toFixed(2)],
  };
};

const info = await page.evaluate(RUN);
await page.screenshot({ path: path.join(OUT, 'walking.png') });
console.log(JSON.stringify(info, null, 2));

/**
 * Side-on stills of the three poses whose x-rotation signs were flipped when the torso
 * was turned round: the run lean, the airborne arms and the offer reach. A sign left
 * the wrong way shows up here as a character leaning back while sprinting or reaching
 * behind itself to feed a creature.
 */
const SIDE = ({ what }) => {
  const g = window.__game;
  const s = g.state();
  const px = s.player.pos[0], pz = s.player.pos[2], py = s.player.pos[1];
  g.hold('forward', false); g.hold('sprint', false);
  g.place(px, pz, 0);
  g.run(0.4);
  if (what === 'sprint') { g.hold('forward', true); g.hold('sprint', true); g.run(2.4); }
  if (what === 'jump') { g.hold('forward', true); g.run(0.4); g.tap('jump'); g.run(0.30); }
  if (what === 'offer') {
    // the gesture needs something to offer TO: put a creature 2.2 m down -z, which is
    // where the character is facing after place(.., 0)
    g.spawnCreature('woolkin', px, pz - 2.2);
    g.run(0.4); g.tap('offer'); g.run(0.65);
  }
  const st = g.state();
  const cx = st.player.pos[0], cz = st.player.pos[2];
  // 5 m off the character's right and a little ahead, so the last simulated frames of
  // drift do not walk the subject out of the plate
  const dz = what === 'jump' ? -0.6 : -0.9;
  g.setCamera([cx + 6.5, py + 2.30, cz + dz], [cx, py + 1.25, cz + dz], 30);
  g.run(0.02);
  return { state: st.player.state, speed: st.player.speed, gesture: st.player.gesture };
};
for (const what of ['sprint', 'jump', 'offer']) {
  const r = await page.evaluate(SIDE, { what });
  await page.screenshot({ path: path.join(OUT, `side_${what}.png`) });
  console.log(what, JSON.stringify(r));
}
console.log('errors', errs.slice(0, 4));

await browser.close();
await server.close();
