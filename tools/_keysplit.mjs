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
  // r13: the key is split across two cascades. Zeroing sky.sunLight alone leaves 35% of
  // it burning and the probe reports a key share that is a third too small.
  const keys = sky.keyLights ?? [sky.sunLight];
  const lights = [];
  g.internals.scene.traverse((o) => { if (o.isHemisphereLight || o.isAmbientLight) lights.push([o, o.intensity]); });
  const envI = g.internals.scene.environmentIntensity;
  const keep = keys.map((k) => k.intensity);
  const keepFill = lights.map(([, i]) => i);
  const setKey = (on) => keys.forEach((k, i) => { k.intensity = on ? keep[i] : 0; });
  const setFill = (on) => lights.forEach(([o], i) => { o.intensity = on ? keepFill[i] : 0; });

  g.render(); const all = meas();
  setKey(false); g.render(); const noKey = meas();
  setKey(true);
  // The PMREM environment is an UNSHADOWED source that no light-intensity tally sees,
  // so it gets its own line: it is part of the ceiling on what a shadow can remove.
  g.internals.scene.environmentIntensity = 0; g.render(); const noEnv = meas();
  g.internals.scene.environmentIntensity = envI;
  setFill(false); g.render(); const noAnalyticFill = meas();
  setFill(true);
  setFill(false); g.internals.scene.environmentIntensity = 0;
  g.render(); const keyOnly = meas();
  setKey(false); g.render(); const nothing = meas();

  return {
    nearFieldLum: { all, noKey, noEnv, noAnalyticFill, keyOnly, nothing },
    keyShare: +((all - noKey) / Math.max(1, all)).toFixed(3),
    envShare: +((all - noEnv) / Math.max(1, all)).toFixed(3),
    analyticFillShare: +((all - noAnalyticFill) / Math.max(1, all)).toFixed(3),
    fillShare: +((all - keyOnly) / Math.max(1, all)).toFixed(3),
    lights: {
      key: keep.map((k) => +k.toFixed(3)),
      fills: lights.map(([o], i) => `${o.type}=${keepFill[i].toFixed(3)}`),
      envIntensity: envI,
    },
    sunElevDeg: +sky.sunElevationDeg.toFixed(1),
  };
};
console.log(JSON.stringify(await page.evaluate(`(${RUN.toString()})()`), null, 1));
await browser.close();
await server.close();
