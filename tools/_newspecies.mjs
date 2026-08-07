#!/usr/bin/env node
/**
 * THROWAWAY. Portrait plates for species that the graded shot set cannot reach.
 *
 *   node tools/_newspecies.mjs [--ids pumpkit,shalehound] [--round rNN]
 *
 * WHY THIS EXISTS. `tools/shots.mjs` stages `creature_portrait` — the single hardest
 * shot to fake, and the only one that shows a face at readable size — by calling
 * `g.spawnCreature('woolkin', ...)`. That id is hard-coded, and shots.mjs is off-limits
 * to builders. So every species added after woolkin has shipped without its face ever
 * being photographed at portrait scale: dewhare has never appeared in a graded frame at
 * more than a few dozen pixels, and neither would pumpkit or shalehound.
 *
 * This probe reproduces that shot EXACTLY — same time of day (0.63), same 3 m / 5.1 m
 * subject-and-eye offsets from the player, same 38 mm lens, same 1920x1080, same seed —
 * and changes one thing, the species id. It photographs, it does not grade: there is no
 * band here and no pass/fail. Compare its output against the round's real
 * `creature_portrait.png`, which is the woolkin control shot taken through the same lens.
 *
 * The instrument is untouched. If the portrait's woolkin hard-code should become a
 * rotation over the roster, that is a change to shots.mjs and belongs to whoever owns it.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const IDS = arg('ids', 'pumpkit,shalehound').split(',').map((s) => s.trim()).filter(Boolean);
const ROUND = arg('round', 'wip');
const SEED = arg('seed', '20240719');
const W = 1920, H = 1080;

const OUT = path.resolve('captures', `wip-species-${ROUND}`);
await mkdir(OUT, { recursive: true });

// hmr:false / watch:null for the same reason the real harness does it: with hot reload
// live, another agent saving a file mid-run reloads the page under the camera and what
// lands on disk is the boot overlay.
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
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message.slice(0, 400)}`));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`console: ${m.text().slice(0, 400)}`); });

/** byte-for-byte the staging block from shots.mjs `creature_portrait`, id parameterised */
const PORTRAIT = (id) => {
  const g = window.__game;
  g.setTimeOfDay(0.63);
  g.setCamera(null);
  g.run(0.3);
  const s = g.state();
  const [px, , pz] = s.player.pos;
  const cx = px + 3, cz = pz + 3;
  const cy = g.groundAt(cx, cz);
  const ex = px + 5.0, ez = pz + 5.1;
  const ey = g.groundAt(ex, ez) + 1.15;
  const cr = g.spawnCreature(id, cx, cz);
  g.run(0.5);
  g.setCamera([ex, ey, ez], [cx, cy + 0.45, cz], 38);
  g.run(0.8);
  return {
    id,
    spawned: !!cr,
    // enough to tell "the frame is empty because the species id was wrong" apart from
    // "the frame is empty because the creature is black"
    species: cr?.species ?? null,
    pos: cr ? [+cr.position.x.toFixed(2), +cr.position.y.toFixed(2), +cr.position.z.toFixed(2)] : null,
    size: cr?.def?.size ?? null,
    anim: cr?.intent?.anim ?? null,
  };
};

/**
 * A SIDE-ON PLATE, which the graded set does not have for anything.
 *
 * Earned the hard way: shalehound's back plate was sized off the field-journal icon,
 * which is drawn head-on, and the front-only portrait was happy to show a broad pale
 * mass behind an upright skull without ever revealing that in profile it is a slab. A
 * creature whose identity lives along its length cannot be signed off from the front.
 *
 * Distance scales with `def.size` so a 1.44 mosshorn and a 0.88 emberfox both fill about
 * the same fraction of frame; this is a comparison plate, not a graded one.
 */
const PROFILE = (id) => {
  const g = window.__game;
  g.setTimeOfDay(0.63);
  g.setCamera(null);
  g.run(0.3);
  const s = g.state();
  const [px, , pz] = s.player.pos;
  const cx = px + 3, cz = pz + 3;
  const cy = g.groundAt(cx, cz);
  const cr = g.spawnCreature(id, cx, cz);
  g.run(0.8);
  const k = cr?.def?.size ?? 1;
  // MEASURED: placing this camera from a fixed offset produced another front view. At
  // conversational range a creature TURNS TO PRESENT ITSELF to the camera — see the
  // attention block in creatures/index.js, `viewBias`/`attend`, reference #12 — so a side
  // view cannot be arranged by camera placement alone. Read the yaw the creature actually
  // settled at, stand perpendicular to THAT, and give it only 0.02 s to react.
  const yaw = (cr?.root?.rotation?.y ?? 0) + (cr?.pose?.rotation?.y ?? 0);
  // Both flanks are a profile. Take the one on the same side of the subject as the
  // portrait's camera (+x/+z at this time of day): the other one is straight into the sun
  // and the first attempt came back as a black cutout against a bright meadow.
  let rx = Math.cos(yaw), rz = -Math.sin(yaw);
  if (rx * 0.70 + rz * 0.71 < 0) { rx = -rx; rz = -rz; }
  // 15 m and a 7.5-degree lens, not 3.4 m and 40 degrees. At conversational range the
  // creature simply turns and faces whatever camera you build — attention is full inside
  // 6 m and only falls to zero past 14 m (creatures/index.js). Two earlier versions of
  // this shot, one of them re-aimed from the creature's settled yaw, both came back as
  // front views. The only way to photograph a flank is to stand outside the attention
  // radius and use a long lens.
  const d = 15.0;
  const ex = cx + rx * d, ez = cz + rz * d;
  const ey = g.groundAt(ex, ez) + 1.60;
  g.setCamera([ex, ey, ez], [cx, cy + 0.50 * k, cz], 7.5);
  // depth of field and exposure are temporal: at 0.02 s the plate came back focused on
  // the far hillside with the subject a blur.
  g.run(0.6);
  return { id, spawned: !!cr, size: k, yaw: +yaw.toFixed(3) };
};

const report = { round: ROUND, seed: SEED, width: W, height: H, ids: IDS, shots: [] };

for (const id of IDS) {
  for (const [view, fn] of [['portrait', PORTRAIT], ['profile', PROFILE]]) {
    // a fresh page per plate: spawn() appends to the live list, so reusing one page would
    // leave the previous subject standing in the next frame
    await page.goto(`http://127.0.0.1:${port}/?capture=1&seed=${SEED}`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });
    const info = await page.evaluate(fn, id);
    const file = path.join(OUT, `${view}_${id}.png`);
    await page.screenshot({ path: file });
    report.shots.push({ view, ...info, file });
    console.log(`${view} ${id}: ${JSON.stringify(info)}`);
  }
}

report.errors = errs;
await writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
if (errs.length) console.log(`\n${errs.length} page error(s):\n  ${errs.slice(0, 8).join('\n  ')}`);
console.log(`\nwrote ${report.shots.length} plate(s) to ${OUT}`);

await browser.close();
await server.close();
