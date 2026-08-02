import { chromium } from 'playwright';
import { createServer } from 'vite';

// Runtime diagnostic: what is the integrated build actually doing in capture mode?
// Checks post chain status, shadow config, light intensities — the root causes
// behind the forensic "blown out, zero shadow structure" verdict.

const server = await createServer({ server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const port = server.config.server.port ?? server.httpServer.address().port;

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`.slice(0, 300)));

await page.goto(`http://127.0.0.1:${port}/?capture=1&seed=20240719`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__game?.ready === true || window.__game?.ready === 'failed', null, { timeout: 60000 });

const diag = await page.evaluate(() => {
  const g = window.__game;
  const out = { ready: g.ready, errors: g.errors, quality: g.stats().quality };
  // post chain
  const post = g.state().post;
  out.post = post;
  // sky lighting
  const sky = g.state().sky;
  out.sky = sky;
  // world/shadow info via scene introspection
  const scene = window.__THREE ? null : null;
  out.rendererInfo = g.stats();
  // camera
  const cam = g.state().player?.camera;
  out.playerCamera = cam;
  return out;
});

// also probe shadowmap: walk the scene graph
const sceneProbe = await page.evaluate(() => {
  const r = window.__game.state();
  return {
    keys: Object.keys(r),
    player: r.player,
    world: r.world,
    creatures: r.creatures,
  };
});

console.log(JSON.stringify({ diag, sceneProbe, errs: errs.slice(0, 8) }, null, 2));
await browser.close();
await server.close();
