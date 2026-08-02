#!/usr/bin/env node
/**
 * CRITIC PROBE (throwaway, not depended on by anything).
 * Two questions the scripted playtest cannot answer:
 *   A) If a player DOES the right thing — walk up, stand still, feed when prompted —
 *      how many seconds until a creature is tamed? Is it reachable inside 5 minutes?
 *   B) Are emote sprites actually over a creature's head, or floating in empty air?
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const port = server.config.server.port ?? server.httpServer.address().port;
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 200)));
await page.goto(`http://127.0.0.1:${port}/?capture=1&seed=20240719`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__game?.ready !== false, null, { timeout: 180000 });

const out = await page.evaluate(async () => {
  const g = window.__game;
  const game = g.internals.game;
  const creatures = game.get('creatures');
  const inter = game.get('interaction');
  const player = game.get('player');
  const log = [];

  // --- pick a creature and stand 7 m from it, facing it -----------------
  const cr = creatures.list[0];
  const cx = cr.position.x, cz = cr.position.z;
  const px = cx + 7, pz = cz + 7;
  const yaw = (Math.atan2(-(cx - px), -(cz - pz)) * 180) / Math.PI;
  g.place(px, pz, yaw);
  g.run(0.1);

  const emoteChecks = [];
  let tamedAt = null, firstOffer = null;
  const stages = [];

  for (let t = 0; t < 240; t += 0.5) {
    // stand perfectly still; take the prompted action whenever one is offered
    const p = inter.prompt;
    if (p && /Offer the berry|Toss a berry/.test(p.text)) {
      if (firstOffer === null) firstOffer = game.elapsed;
      g.tap('offer');
    }
    g.run(0.5);

    const st = inter.arc; // side effect free
    const s = inter.snapshot();
    if (!stages.length || stages[stages.length - 1].stage !== s.stage) {
      stages.push({ t: +game.elapsed.toFixed(1), stage: s.stage, trust: s.focus?.trust ?? null, berries: s.inventory.berry });
    }
    if (s.tamed > 0 && tamedAt === null) { tamedAt = +game.elapsed.toFixed(1); break; }

    // --- emote anchor audit: any visible Sprite vs nearest creature ------
    if (false) {
      const sprites = [];
      game.scene.traverse((o) => { if (o.isSprite && o.visible && o.material?.opacity > 0.2) sprites.push(o); });
      for (const sp of sprites) {
        const w = sp.getWorldPosition(new window.__THREE.Vector3());
        let bd = Infinity, bc = null;
        for (const c of creatures.list) {
          const d = Math.hypot(c.position.x - w.x, c.position.z - w.z);
          if (d < bd) { bd = d; bc = c; }
        }
        const dPlayer = Math.hypot(player.position.x - w.x, player.position.z - w.z);
        emoteChecks.push({
          t: +game.elapsed.toFixed(1),
          horizOffsetFromNearestCreature: +bd.toFixed(2),
          heightAboveCreature: bc ? +(w.y - bc.position.y).toFixed(2) : null,
          distFromPlayer: +dPlayer.toFixed(1),
          nearest: bc?.species,
        });
      }
    }
  }

  log.push({ tamedAt, firstOffer: firstOffer && +firstOffer.toFixed(1), stages, emoteChecks, finalBerries: inter.inventory.berry, arc: inter.arc.slice(-12) });
  return log[0];
});

console.log(JSON.stringify(out, null, 2));
await browser.close();
await server.close();
