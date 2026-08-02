#!/usr/bin/env node
/**
 * Capture harness. Boots the game headlessly, stages each shot in the matched-shot
 * protocol, and writes PNGs + a machine-readable report.
 *
 *   node tools/capture.mjs --round r01            # all shots + strips
 *   node tools/capture.mjs --round r01 --only vista_golden,creature_portrait
 *   node tools/capture.mjs --round r01 --width 1280 --height 720   # faster iteration
 *
 * Output: captures/<round>/*.png and captures/<round>/report.json
 *
 * Every critic agent runs THIS, so it must fail loudly: a build that throws produces a
 * report with ok=false and the error text rather than a plausible-looking blank frame.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { SHOTS, STRIPS } from './shots.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const has = (k) => argv.includes(`--${k}`);

const round = arg('round', 'scratch');
const W = Number(arg('width', 1920));
const H = Number(arg('height', 1080));
const SEED = arg('seed', '20240719');
const only = arg('only', null)?.split(',').map((s) => s.trim());
const outDir = path.resolve('captures', round);

/**
 * Guard against the silent-failure mode that cost us the first run: the harness
 * happily screenshotting a loading overlay, a black frame, or a fog-coloured void
 * and reporting OK. Runs in-page against the live canvas.
 */
const FRAME_PROBE = () => {
  const cv = document.querySelector('#app canvas');
  if (!cv) return { ok: false, why: 'no canvas' };
  const overlay = document.getElementById('boot');
  if (overlay) return { ok: false, why: 'boot overlay still present' };
  const s = document.createElement('canvas');
  s.width = 64; s.height = 36;
  const g2 = s.getContext('2d');
  g2.drawImage(cv, 0, 0, 64, 36);
  const d = g2.getImageData(0, 0, 64, 36).data;
  let n = 0, sum = 0, sumSq = 0;
  const lums = [];
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    lums.push(l); sum += l; sumSq += l * l; n++;
  }
  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
  const uniq = new Set(lums.map((l) => Math.round(l / 4))).size;
  return { ok: std > 6 && uniq > 6, why: `std=${std.toFixed(1)} uniqueBands=${uniq} mean=${mean.toFixed(1)}`, std: +std.toFixed(2), mean: +mean.toFixed(1), bands: uniq };
};

const CHROME_ARGS = [
  '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist', '--disable-dev-shm-usage', '--js-flags=--max-old-space-size=4096',
];

async function main() {
  // Only wipe the round when capturing the WHOLE round. `--only` used to delete every
  // other frame in the directory and then write one file back — which silently destroyed
  // a round out from under a critic that was reading it.
  if (!only) await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const server = await createServer({ server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
  await server.listen();
  const port = server.config.server.port ?? server.httpServer.address().port;
  const base = `http://127.0.0.1:${port}`;

  const browser = await chromium.launch({ args: CHROME_ARGS });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });

  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 400)); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`.slice(0, 400)));

  const report = { round, seed: SEED, width: W, height: H, at: new Date().toISOString(), ok: true, shots: [], strips: [], consoleErrors };

  try {
    await page.goto(`${base}/?capture=1&seed=${SEED}`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction(() => window.__game?.ready === true || window.__game?.ready === 'failed', null,
      { timeout: 180000 });

    const ready = await page.evaluate(() => window.__game.ready);
    if (ready !== true) throw new Error('game failed to initialise: ' + JSON.stringify(await page.evaluate(() => window.__game.errors)));

    /**
     * Real isolation between shots. This used to be a comment claiming a fresh page and
     * a call that merely reset the camera — so state leaked forward: interaction_feed
     * taps 'offer', which tamed a creature, which was then still tame during the
     * "creatures left completely alone" behaviour strip. A critic caught the strip
     * showing "Woolkin will follow you now" in a supposedly interaction-free window.
     */
    const freshPage = async () => {
      await page.goto(`${base}/?capture=1&seed=${SEED}`, { waitUntil: 'load', timeout: 120000 });
      await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });
    };

    for (const shot of SHOTS) {
      if (only && !only.includes(shot.id)) continue;
      const t0 = Date.now();
      await freshPage();
      await page.evaluate(`(${shot.setup.toString()})(window.__game)`);
      await page.evaluate(() => window.__game.render());
      const file = path.join(outDir, `${shot.id}.png`);
      await page.screenshot({ path: file, animations: 'disabled' });
      const state = await page.evaluate(() => window.__game.state());
      const stats = await page.evaluate(() => window.__game.stats());
      const probe = await page.evaluate(`(${FRAME_PROBE.toString()})()`);
      if (!probe.ok) { report.ok = false; report.blankFrames = [...(report.blankFrames ?? []), `${shot.id}: ${probe.why}`]; }
      report.shots.push({ id: shot.id, title: shot.title, intent: shot.intent, file: path.relative(process.cwd(), file), ms: Date.now() - t0, probe, state, stats });
      console.log(`  shot ${shot.id.padEnd(22)} ${((Date.now() - t0) / 1000).toFixed(1)}s  ${stats.drawCalls} draws / ${(stats.triangles / 1000).toFixed(0)}k tris  ${probe.ok ? '' : '  ** SUSPECT FRAME: ' + probe.why}`);
    }

    if (!has('no-strips')) {
      for (const strip of STRIPS) {
        if (only && !only.includes(strip.id)) continue;
        const t0 = Date.now();
        await freshPage();
        await page.evaluate(`(${strip.setup.toString()})(window.__game)`);
        const frames = [];
        const descs = [];
        for (let i = 0; i < strip.frames; i++) {
          // re-aim the camera at the subject before each frame, so a strip meant to
          // show creature behaviour actually holds the creature in shot
          if (strip.beforeFrame) await page.evaluate(`(${strip.beforeFrame.toString()})(window.__game, ${i})`);
          await page.evaluate(() => window.__game.render());
          const f = path.join(outDir, `${strip.id}_${String(i).padStart(2, '0')}.png`);
          await page.screenshot({ path: f, animations: 'disabled' });
          frames.push(path.relative(process.cwd(), f));
          descs.push(await page.evaluate(() => window.__game.state().ai?.described ?? null));
          if (i < strip.frames - 1) await page.evaluate(`(${strip.between.toString()})(window.__game)`);
        }
        if (strip.teardown) await page.evaluate(`(${strip.teardown.toString()})(window.__game)`);
        report.strips.push({ id: strip.id, title: strip.title, intent: strip.intent, frames, behaviourLog: descs, ms: Date.now() - t0 });
        console.log(`  strip ${strip.id.padEnd(21)} ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      }
    }
  } catch (err) {
    report.ok = false;
    report.error = String(err?.stack ?? err);
    console.error('CAPTURE FAILED:', err);
  } finally {
    if (consoleErrors.length) { report.ok = false; report.consoleErrors = consoleErrors; }
    await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
    await browser.close();
    await server.close();
  }

  console.log(`\n${report.ok ? 'OK' : 'FAILED'} — ${report.shots.length} shots, ${report.strips.length} strips -> ${outDir}`);
  if (!report.ok) process.exitCode = 1;
}

main();
