#!/usr/bin/env node
/** THROWAWAY. Renders ONLY the shadow mask (getShadow) so the failure is unambiguous. */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const OUT = path.resolve('captures', '_shadowviz');
await mkdir(OUT, { recursive: true });

const server = await createServer({ server: { port: 0, host: '127.0.0.1', strictPort: false }, logLevel: 'error' });
await server.listen();
const port = server.config.server.port ?? server.httpServer.address().port;
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('  [page err]', m.text().slice(0, 300)); });

const SETUP = (shot) => {
  const g = window.__game;
  if (shot === 'over') {
    g.setTimeOfDay(0.29); g.setCamera(null);
    const s0 = g.state(); g.place(s0.player.pos[0], s0.player.pos[2], 0); g.run(2.2);
  } else {
    g.setTimeOfDay(0.60); g.setCamera(null); g.run(1.5);
    const s = g.state(); const [x, y, z] = s.player.pos;
    g.setCamera([x - 5, y + 1.7, z + 7], [x + 34, y + 3.5, z - 46], 62);
    g.run(0.6);
  }
};

const MASKMODE = (opts) => {
  const T = window.__THREE;
  const g = window.__game.internals;
  const sun = g.game.get('sky').sunLight;
  if (opts.box) {
    sun.shadow.camera.left = -opts.box; sun.shadow.camera.right = opts.box;
    sun.shadow.camera.top = opts.box; sun.shadow.camera.bottom = -opts.box;
    sun.shadow.camera.updateProjectionMatrix();
  }
  if (opts.bias !== undefined) sun.shadow.bias = opts.bias;
  if (opts.normalBias !== undefined) sun.shadow.normalBias = opts.normalBias;
  if (opts.far !== undefined) { sun.shadow.camera.far = opts.far; sun.shadow.camera.updateProjectionMatrix(); }

  if (opts.groundOff) { g.scene.traverse((o) => { if (o.name === 'ground') o.castShadow = false; }); }
  if (opts.frame) { window.__game.render(); return; }
  // debug material: output the shadow mask only
  const m = new T.MeshLambertMaterial({ color: 0xffffff });
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <dithering_fragment>', `#include <dithering_fragment>
      float _sm = 1.0;
      #if defined( USE_SHADOWMAP ) && ( NUM_DIR_LIGHT_SHADOWS > 0 )
        _sm = getShadow( directionalShadowMap[ 0 ], directionalLightShadows[ 0 ].shadowMapSize, directionalLightShadows[ 0 ].shadowIntensity, directionalLightShadows[ 0 ].shadowBias, directionalLightShadows[ 0 ].shadowRadius, vDirectionalShadowCoord[ 0 ] );
      #endif
      gl_FragColor = vec4( vec3( _sm ), 1.0 );
    `);
  };
  m.customProgramCacheKey = () => 'maskdebug';
  g.scene.overrideMaterial = m;
  const post = g.game.get('post');
  if (post) post.render = undefined;              // bypass grading
  g.scene.traverse((o) => { if (o.isMesh && !o.receiveShadow && o.name !== 'ground') o.visible = o.visible; });
  window.__game.render();
};

for (const shot of ['over', 'vista']) {
  for (const [name, opts] of Object.entries({
    base: {},
    bigbias: { bias: -0.006 },
    groundoff: { groundOff: true },
    frame: { frame: true },
  })) {
    await page.goto(`http://127.0.0.1:${port}/?capture=1&seed=20240719`, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 180000 });
    await page.evaluate(`(${SETUP.toString()})(${JSON.stringify(shot)})`);
    await page.evaluate(`(${MASKMODE.toString()})(${JSON.stringify(opts)})`);
    const f = path.join(OUT, `mask_${shot}_${name}.png`);
    await page.screenshot({ path: f });
    // how much of the frame is shadowed?
    const stat = await page.evaluate(() => {
      const cv = document.querySelector('#app canvas');
      const s = document.createElement('canvas'); s.width = 240; s.height = 135;
      const c = s.getContext('2d'); c.drawImage(cv, 0, 0, 240, 135);
      const d = c.getImageData(0, 0, 240, 135).data;
      let dark = 0, n = 0, sum = 0;
      for (let i = 0; i < d.length; i += 4) { if (d[i] < 200) dark++; sum += d[i]; n++; }
      return { pctShadowed: +(100 * dark / n).toFixed(2), meanMask: +(sum / n / 255).toFixed(3) };
    });
    console.log(`${shot.padEnd(6)} ${name.padEnd(8)} shadowed=${String(stat.pctShadowed).padStart(6)}%  meanMask=${stat.meanMask}`);
  }
}

await browser.close();
await server.close();
