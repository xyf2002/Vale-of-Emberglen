#!/usr/bin/env node
/**
 * THROWAWAY. The throw, sampled every rendered frame, from the SIDE.
 *
 * "It does not look like a throw" is not a number, so this turns it into two:
 *
 *   maxStepDeg  the largest the shoulder moves in one 1/60 s frame. The first version
 *               of the animation scored 156 deg — the arm was behind the head in one
 *               frame and in front of the chest in the next. PASS is <= 35.
 *   swingFrames rendered frames between the wind-up apex (the most negative shoulder
 *               angle) and the frame the sphere leaves the hand. The first version had
 *               about 3, i.e. the swing did not exist to be looked at. PASS is >= 6.
 *
 * Frames are also written out so the arc can be eyeballed, not merely certified.
 * The camera is parked side-on because from the gameplay camera (directly behind) an
 * arm swinging in the sagittal plane projects to almost nothing — the same view-axis
 * trap that has eaten two other effects in this project.
 *
 * The arm pose is driven by the gesture clock alone, so a free-fly camera does not
 * disturb what is being measured; it only changes where the sphere is thrown.
 *
 *   node tools/_throwstrip.mjs
 *
 * Writes captures/wip-throw/*.png plus per-frame joint angles and the two verdicts.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

const OUT = path.resolve('captures', 'wip-throw');
// wipe first: a previous run at a different sampling rate leaves frames behind that
// silently mix into the contact sheet and make the arc look like it stutters
await rm(OUT, { recursive: true, force: true });
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
const page = await browser.newPage({ viewport: { width: 560, height: 620 } });
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message.slice(0, 200)));
await page.goto(`http://127.0.0.1:${port}/?capture=1&seed=20240719`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });

const base = await page.evaluate(() => {
  const g = window.__game;
  g.setTimeOfDay(0.35); g.releaseAll(); g.setCamera(null);
  const s = g.state();
  g.place(s.player.pos[0], s.player.pos[2], 0);   // face -Z
  g.tap('slot2');
  g.run(1.6);
  const st = g.state();
  return { px: st.player.pos[0], py: st.player.pos[1], pz: st.player.pos[2] };
});

const SIDE = ({ px, py, pz }) => {
  const g = window.__game;
  // side-on, slightly high, looking at the chest
  g.setCamera([px + 3.1, py + 1.75, pz - 0.2], [px, py + 1.25, pz - 0.2], 34);
};

await page.evaluate(SIDE, base);

const frames = [];
await page.evaluate(() => { window.__game.tap('throw'); });
// One simulated frame per sample: this is measuring per-FRAME angular travel, so it has
// to step at the rate the renderer does. 0.62 s of gesture plus a little tail.
const STEPS = 44;
for (let i = 0; i < STEPS; i++) {
  const row = await page.evaluate(() => {
    const g = window.__game;
    g.run(1 / 60, 1 / 60);
    const game = g.internals.game;
    const p = game.get('player');
    let hand = null;
    p.root.traverse((o) => { if (o.name === 'handR') hand = o; });
    const el = hand ? hand.parent : null;
    const sh = el ? el.parent : null;
    const D = 180 / Math.PI;
    return {
      gesture: +(g.state().player.gesture ?? 0).toFixed(3),
      shoulderX: sh ? +(sh.rotation.x * D).toFixed(1) : null,
      shoulderZ: sh ? +(sh.rotation.z * D).toFixed(1) : null,
      elbowX: el ? +(el.rotation.x * D).toFixed(1) : null,
      inFlight: g.state().spheres.inFlight ?? 0,
    };
  });
  frames.push(row);
  // every third frame is written out; 44 screenshots is a minute of swiftshader
  if (i % 3 === 0) {
    await page.screenshot({ timeout: 60000, path: path.join(OUT, `f${String(i).padStart(2, '0')}.png`) });
  }
}

// ---- the two verdicts ----
let maxStep = 0, maxAt = -1;
for (let i = 1; i < frames.length; i++) {
  const d = Math.abs(frames[i].shoulderX - frames[i - 1].shoulderX);
  if (d > maxStep) { maxStep = d; maxAt = i; }
}
let apex = 0;
for (let i = 1; i < frames.length; i++) if (frames[i].shoulderX < frames[apex].shoulderX) apex = i;
const launch = frames.findIndex((f) => f.inFlight > 0);
const swingFrames = launch > apex ? launch - apex : null;
const verdict = {
  maxStepDeg: +maxStep.toFixed(1), maxStepAtFrame: maxAt,
  apexFrame: apex, launchFrame: launch, swingFrames,
  pass: maxStep <= 35 && swingFrames != null && swingFrames >= 6,
};
console.log(verdict);

console.table(frames.filter((_, i) => i % 2 === 0));
await writeFile(path.join(OUT, 'report.json'), JSON.stringify({ verdict, frames, errors: errs }, null, 2));
console.log('errors:', errs.length ? errs : 'none');
await browser.close();
await server.close();
