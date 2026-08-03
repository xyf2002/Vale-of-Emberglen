#!/usr/bin/env node
/** THROWAWAY. How much of the lit image does the KEY actually contribute vs the fill? */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ server: { port: 0, host: '127.0.0.1', strictPort: false }, logLevel: 'error' });
await server.listen();
const port = server.config.server.port ?? server.httpServer.address().port;
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
await page.goto(`http://127.0.0.1:${port}/?capture=1&seed=20240719`, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });
await page.evaluate(() => {
  const g = window.__game;
  g.setTimeOfDay(0.29); g.setCamera(null);
  const s0 = g.state(); g.place(s0.player.pos[0], s0.player.pos[2], 0); g.run(2.2);
});

const RUN = () => {
  const g = window.__game;
  const post = g.internals.game.get('post'); if (post) post.render = undefined;
  const cv = document.querySelector('#app canvas');
  const meas = () => {
    const s = document.createElement('canvas'); s.width = 320; s.height = 180;
    const c = s.getContext('2d'); c.drawImage(cv, 0, 0, 320, 180);
    const d = c.getImageData(0, 0, 320, 180).data;
    // bottom third == near-field meadow, which is what the shadow has to act on
    let sum = 0, n = 0;
    for (let y = 120; y < 180; y++) for (let x = 0; x < 320; x++) {
      const i = (y * 320 + x) * 4;
      sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; n++;
    }
    return +(sum / n).toFixed(1);
  };
  const sky = g.internals.game.get('sky');
  const sun = sky.sunLight;
  const lights = [];
  g.internals.scene.traverse((o) => { if (o.isHemisphereLight || o.isAmbientLight) lights.push([o, o.intensity]); });
  const envI = g.internals.scene.environmentIntensity;
  const keep = sun.intensity;

  g.render(); const all = meas();
  sun.intensity = 0; g.render(); const noKey = meas();
  sun.intensity = keep;
  for (const [o] of lights) o.intensity = 0;
  g.internals.scene.environmentIntensity = 0;
  g.render(); const keyOnly = meas();
  sun.intensity = 0; g.render(); const nothing = meas();

  return {
    nearFieldLum: { all, noKey, keyOnly, nothing },
    keyShare: +((all - noKey) / Math.max(1, all)).toFixed(3),
    fillShare: +((all - keyOnly) / Math.max(1, all)).toFixed(3),
    lights: { sun: +keep.toFixed(3), fills: lights.map(([o, i]) => `${o.type}=${i.toFixed(3)}`), envIntensity: envI },
    sunElevDeg: +sky.sunElevationDeg.toFixed(1),
  };
};
console.log(JSON.stringify(await page.evaluate(`(${RUN.toString()})()`), null, 1));
await browser.close();
await server.close();
