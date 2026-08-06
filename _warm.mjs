#!/usr/bin/env node
/**
 * THROWAWAY. Warms vite's DEFAULT dep-optimiser cache (node_modules/.vite) by booting
 * the app once in a real browser.
 *
 * Why this exists: several agents are running vite servers against this same tree, and
 * a cold optimiser finishes AFTER the first navigation has started, then pushes a
 * full-reload down the HMR socket. That aborts the page load capture.mjs is waiting on
 * ("net::ERR_ABORTED" / "Execution context was destroyed"). The harness is not at fault
 * and must not be changed for it; warming the cache first removes the reload entirely.
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';

const server = await createServer({ server: { port: 5422, host: '127.0.0.1', strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
try {
  await page.goto('http://127.0.0.1:5422/?capture=1&seed=20240719', { waitUntil: 'domcontentloaded', timeout: 300000 });
  await page.waitForFunction(() => window.__game?.ready === true || window.__game?.ready === 'failed', null, { timeout: 300000 });
  console.log('warm: ready =', await page.evaluate(() => window.__game.ready));
} catch (e) {
  console.log('warm: ' + e.message.slice(0, 200));
}
await page.waitForTimeout(4000);
await browser.close();
await server.close();
