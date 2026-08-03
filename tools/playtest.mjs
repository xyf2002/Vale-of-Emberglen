#!/usr/bin/env node
/**
 * COLD-OPEN PLAYTEST.
 *
 * Stills tell you whether the game photographs well. This tells you whether it PLAYS.
 * It drives a scripted five minutes of the real build through the same input path a
 * human uses, and records a timeline: a frame every few seconds, the full event log,
 * and what the AI system says each creature is doing and why.
 *
 *   node tools/playtest.mjs --round r01 [--minutes 5] [--width 1280 --height 720]
 *
 * Output: captures/<round>-playtest/{frame_*.png, timeline.json, transcript.md}
 *
 * transcript.md is the artefact a critic reads: a plain-English account of the session
 * with the frames interleaved, so "was this five minutes worth playing?" can actually
 * be judged rather than guessed at.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };

const round = arg('round', 'scratch');
const MINUTES = Number(arg('minutes', 5));
const W = Number(arg('width', 1280));
const H = Number(arg('height', 720));
const SEED = arg('seed', '20240719');
const outDir = path.resolve('captures', `${round}-playtest`);

/**
 * A plausible first-five-minutes player. Deliberately naive: it does what someone
 * who has never seen the game would do — look around, walk toward the interesting
 * thing, try the prompted button, wander off.
 */
const BEATS = [
  { t: 0, label: 'Spawn. Player looks around before moving.', act: (g) => { g.look(220, 0); g.run(1.2); g.look(-380, 0); g.run(1.2); g.look(160, 0); g.run(0.8); } },
  { t: 6, label: 'Walks forward into the world.', act: (g) => { g.hold('forward', true); g.run(6); } },
  { t: 14, label: 'Sprints to cover ground.', act: (g) => { g.hold('sprint', true); g.run(8); g.hold('sprint', false); } },
  { t: 24, label: 'Stops. Turns to survey.', act: (g) => { g.hold('forward', false); g.look(600, 0); g.run(2.5); } },
  { t: 30, label: 'Heads toward the nearest creature.', act: (g, s) => { window.__steer(g, s); g.run(8); } },
  { t: 40, label: 'Approaches slowly.', act: (g, s) => { window.__steer(g, s); g.run(6); } },
  { t: 48, label: 'Tries the interact prompt.', act: (g) => { g.hold('forward', false); g.tap('offer'); g.run(2.5); } },
  { t: 52, label: 'Tries again.', act: (g) => { g.tap('offer'); g.run(2.5); g.tap('offer'); g.run(2.5); } },
  { t: 60, label: 'Jumps around — testing what the game lets them do.', act: (g) => { g.tap('jump'); g.run(1.4); g.tap('jump'); g.run(1.4); g.hold('left', true); g.run(2); g.hold('left', false); } },
  { t: 68, label: 'Wanders to find more creatures.', act: (g) => { g.hold('forward', true); g.hold('sprint', true); g.run(12); } },
  { t: 82, label: 'Finds somewhere to stand and watch.', act: (g) => { g.hold('forward', false); g.hold('sprint', false); g.run(10); } },
  { t: 94, label: 'Approaches a second creature and feeds it.', act: (g, s) => { window.__steer(g, s); g.run(7); g.tap('offer'); g.run(2); g.tap('offer'); g.run(2); g.tap('offer'); g.run(2); } },
  { t: 108, label: 'Explores in a new direction.', act: (g) => { g.look(900, 0); g.hold('forward', true); g.hold('sprint', true); g.run(14); } },
  { t: 124, label: 'Stops to look at the view.', act: (g) => { g.hold('forward', false); g.hold('sprint', false); g.look(0, -140); g.run(4); g.look(0, 140); g.run(2); } },
  { t: 132, label: 'Keeps going.', act: (g) => { g.hold('forward', true); g.run(12); } },
  { t: 146, label: 'Tries interacting with whatever is nearby.', act: (g, s) => { g.hold('forward', false); window.__steer(g, s); g.run(6); g.tap('interact'); g.run(1.5); g.tap('offer'); g.run(2.5); } },
  { t: 158, label: 'Settles in and watches the world for a while.', act: (g) => { g.run(20); } },
];

/**
 * A REACTIVE player: steer toward the nearest creature and press the offered key
 * whenever the game actually offers it, re-evaluating every 0.4s.
 *
 * The fixed beat script could not do this, which made it an unfair test of the HUD:
 * we had just added a "2 berries to go" prompt and a persistent world marker, and then
 * graded the game with a player incapable of responding to either. A human who is told
 * what it costs to finish walks back and finishes. This models that, and nothing more —
 * it presses only keys the game itself is advertising.
 */
function pursueAndInteract(g, seconds) {
  const steps = Math.max(1, Math.round(seconds / 0.4));
  for (let i = 0; i < steps; i++) {
    const s = g.state();
    const p = s.player.pos;
    const list = (s.creatures && s.creatures.sample) || [];
    let best = null, bd = 1e9;
    for (const c of list) {
      const d = Math.hypot(c.pos[0] - p[0], c.pos[1] - p[2]);
      if (d < bd) { bd = d; best = c; }
    }
    if (best) {
      const want = Math.atan2(-(best.pos[0] - p[0]), -(best.pos[1] - p[2]));
      const cur = (s.player.yawDeg * Math.PI) / 180;
      let dd = ((want - cur + Math.PI) % (Math.PI * 2)) - Math.PI;
      if (dd < -Math.PI) dd += Math.PI * 2;
      g.look((-dd / 0.0026) * 0.5, 0);
      // close the distance, but stop pushing once we are at conversational range
      g.hold('forward', bd > 3.2);
    }
    // press whatever the game is currently offering
    if (s.interaction && s.interaction.prompt) g.tap('offer');
    // and try to gather — a player who is told "a bush is 20m north-east, press E at it"
    // goes and presses E. Without this the harness can never restock and every session
    // dead-ends at zero berries, which looks like a game bug but is a harness blind spot.
    g.tap('interact');
    g.run(0.4);
  }
  g.hold('forward', false);
}

/** turn the player toward the nearest creature using only the public capture API */
function steerToNearestCreature(g, _s) {
  const st = g.state();
  const p = st.player?.pos;
  const list = st.creatures?.sample ?? [];
  if (!p || !list.length) { g.hold('forward', true); return; }
  let best = null, bd = Infinity;
  for (const c of list) {
    const d = Math.hypot(c.pos[0] - p[0], c.pos[1] - p[2]);
    if (d < bd) { bd = d; best = c; }
  }
  if (!best) { g.hold('forward', true); return; }
  const want = Math.atan2(-(best.pos[0] - p[0]), -(best.pos[1] - p[2]));
  const cur = (st.player.yawDeg * Math.PI) / 180;
  let d = ((want - cur + Math.PI) % (Math.PI * 2)) - Math.PI;
  g.look((-d / 0.0026) * 1.0, 0);
  g.hold('forward', true);
}

async function main() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const server = await createServer({ server: { port: 0, host: '127.0.0.1', strictPort: false }, logLevel: 'error' });
  await server.listen();
  const port = server.config.server.port ?? server.httpServer.address().port;

  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(e.message.slice(0, 300)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });

  const timeline = { round, seed: SEED, minutes: MINUTES, beats: [], consoleErrors, ok: true };

  try {
    await page.goto(`http://127.0.0.1:${port}/?capture=1&seed=${SEED}`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction(() => window.__game?.ready !== false, null, { timeout: 180000 });
    if (await page.evaluate(() => window.__game.ready) !== true) {
      throw new Error('init failed: ' + JSON.stringify(await page.evaluate(() => window.__game.errors)));
    }

    // Beat bodies are stringified and evaluated inside the page, so any helper they
    // call must exist in the page too — it is not in scope just because it is in this file.
    await page.evaluate(`window.__steer = ${steerToNearestCreature.toString()}`);
    await page.evaluate(`window.__pursue = ${pursueAndInteract.toString()}`);

    // `--minutes 5` used to advance only ~163 simulated seconds, because the scripted
    // beats simply ran out and the flag merely gated which of them fired. The final
    // 2.5 minutes of the vertical slice were never exercised, while the harness
    // reported a five-minute playtest. Extend with generated beats to the real budget.
    const budget = MINUTES * 60;
    const EXTRA = [
      { label: 'Goes back to the creature it was befriending, and finishes.', act: (g) => { window.__pursue(g, 18); } },
      { label: 'Keeps exploring outward.', act: (g) => { g.hold('forward', true); g.hold('sprint', true); g.run(14); g.hold('sprint', false); g.hold('forward', false); } },
      { label: 'Finds another creature and works on it.', act: (g) => { window.__pursue(g, 20); } },
      { label: 'Stands and watches the world.', act: (g) => { g.run(12); } },
      { label: 'Doubles back.', act: (g) => { g.look(1600, 0); g.hold('forward', true); g.run(10); g.hold('forward', false); } },
    ];

    // Drive by ACTUAL simulated time, not by each beat's nominal `t` label. Those labels
    // were only ever hints, so the run stopped when the script ran out rather than when
    // the five minutes were up — reporting a 5-minute playtest after 163 seconds.
    let i = 0, k = 0, simElapsed = 0;
    while (simElapsed < budget && i < 120) {
      const beat = BEATS[i] ?? {
        label: `[extended] ${EXTRA[k % EXTRA.length].label}`,
        act: EXTRA[(k++) % EXTRA.length].act,
      };
      const before = await page.evaluate(() => window.__game.state());
      await page.evaluate(`(${beat.act.toString()})(window.__game, ${JSON.stringify(before)})`);
      await page.evaluate(() => window.__game.render());
      const file = path.join(outDir, `frame_${String(i).padStart(2, '0')}.png`);
      await page.screenshot({ path: file });
      const after = await page.evaluate(() => window.__game.state());
      const events = await page.evaluate(() => window.__game.events(40));
      timeline.beats.push({
        i, simTime: +after.elapsed.toFixed(1), label: beat.label,
        frame: path.relative(process.cwd(), file),
        player: after.player, creatures: after.creatures, ui: after.ui,
        interaction: after.interaction, sky: after.sky,
        behaviour: after.ai?.described ?? [],
        newEvents: events.filter((e) => !['resize'].includes(e.evt)).slice(-10).map((e) => e.evt),
      });
      console.log(`  ${String(after.elapsed.toFixed(0)).padStart(4)}s  ${beat.label}`);
      simElapsed = after.elapsed;
      i++;
    }
  } catch (err) {
    timeline.ok = false; timeline.error = String(err?.stack ?? err);
    console.error('PLAYTEST FAILED:', err);
  } finally {
    if (consoleErrors.length) timeline.ok = false;
    await writeFile(path.join(outDir, 'timeline.json'), JSON.stringify(timeline, null, 2));
    await writeFile(path.join(outDir, 'transcript.md'), renderTranscript(timeline));
    await browser.close();
    await server.close();
  }
  console.log(`\n${timeline.ok ? 'OK' : 'FAILED'} — ${timeline.beats.length} beats -> ${outDir}`);
  if (!timeline.ok) process.exitCode = 1;
}

function renderTranscript(t) {
  const L = [`# Playtest transcript — ${t.round}`, '',
    `Seed \`${t.seed}\`, ${t.minutes} simulated minutes, ${t.beats.length} beats.`,
    t.ok ? '' : `\n> **RUN FAILED** — ${t.error ?? 'console errors'}\n`,
    t.consoleErrors?.length ? `\n> Console errors:\n${t.consoleErrors.map((e) => `> - ${e}`).join('\n')}\n` : '', ''];
  for (const b of t.beats) {
    L.push(`## ${b.simTime}s — ${b.label}`, '');
    L.push(`![frame](${path.basename(b.frame)})`, '');
    L.push(`- player: ${b.player?.state} at ${JSON.stringify(b.player?.pos)}, speed ${b.player?.speed}`);
    L.push(`- creatures: ${b.creatures?.count ?? 0} alive, ${b.creatures?.tamed ?? 0} tamed, moods ${JSON.stringify(b.creatures?.byMood ?? {})}`);
    if (b.ui?.visibleText?.length) L.push(`- on screen: ${b.ui.visibleText.map((s) => `"${s}"`).join(', ')}`);
    else L.push('- on screen: *(nothing)*');
    if (b.behaviour?.length) L.push(`- behaviour: ${b.behaviour.join('; ')}`);
    if (b.newEvents?.length) L.push(`- events: ${[...new Set(b.newEvents)].join(', ')}`);
    L.push('');
  }
  return L.join('\n');
}

main();
