import { chromium } from 'playwright';
import fs from 'fs';

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto('http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded' });

async function stats() {
  // Sample the rendered canvas directly through the WebGL context + a 2D downsample
  return await page.evaluate(() => {
    const c = document.querySelector('canvas');
    if (!c) return { canvas: false };
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return { canvas: true, gl: false };
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    // sample every 8th pixel
    let sum = 0, sumSq = 0, n = 0;
    const buckets = new Array(16).fill(0);
    for (let i = 0; i < buf.length; i += 32) {
      const r = buf[i], g = buf[i + 1], b = buf[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      sum += lum; sumSq += lum * lum; n++;
      buckets[Math.min(15, Math.floor(lum / 16))].push?.() || buckets[Math.min(15, Math.floor(lum / 16))]++;
    }
    const mean = sum / n;
    const std = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
    // colorfulness: avg channel spread
    let spread = 0;
    for (let i = 0; i < buf.length; i += 32) {
      spread += Math.abs(buf[i] - buf[i + 2]);
    }
    spread /= n;
    return {
      canvas: true, gl: true, w, h,
      mean: Math.round(mean * 10) / 10,
      std: Math.round(std * 10) / 10,
      colorSpread: Math.round(spread * 10) / 10,
      buckets,
      top3: buckets.map((v, i) => [i * 16, v]).sort((a, b) => b[1] - a[1]).slice(0, 3),
      boot: !!document.getElementById('boot'),
      bootMsg: document.getElementById('boot-msg')?.textContent,
      ready: window.__game?.ready,
      fps: window.__game?.fps,
    };
  });
}

await page.waitForTimeout(5000);
const s1 = await stats();
await page.screenshot({ path: '/home/xyf/game/RPG/captures/_status_6s.png' });
await page.waitForTimeout(3000);
const s2 = await stats();
await page.screenshot({ path: '/home/xyf/game/RPG/captures/_status_9s.png' });

console.log(JSON.stringify({
  s1, s2,
  errors: errors.slice(0, 10),
}, null, 2));
await browser.close();
