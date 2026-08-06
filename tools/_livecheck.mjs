// Deploy smoke test: load the public Vercel URL in a real browser, wait for the
// boot overlay to hide, screenshot. Proves WebGL boot, not just HTTP 200.
import { chromium } from 'playwright';

const URL = process.argv[2];
const OUT = process.argv[3];

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('requestfailed', (r) => errors.push('reqfail: ' + r.url() + ' ' + r.failure()?.errorText));

await page.goto(URL, { waitUntil: 'load', timeout: 60000 });
let booted = true;
try {
  // NOT `#boot?.classList.contains('hidden')` — main.js:69 *removes* the overlay
  // 800 ms after hiding it, so that predicate reads `undefined` forever and the
  // probe reports a boot failure on a page that booted fine. Gone counts as hidden.
  await page.waitForFunction(
    () => {
      const b = document.querySelector('#boot');
      return !b || b.classList.contains('hidden');
    },
    null, { timeout: 90000 },
  );
} catch { booted = false; }
await page.waitForTimeout(3000);
await page.screenshot({ path: OUT });

const bootMsg = await page.textContent('#boot-msg').catch(() => null);
const canvas = await page.evaluate(() => {
  const c = document.querySelector('canvas');
  return c ? { w: c.width, h: c.height } : null;
});
console.log(JSON.stringify({ booted, bootMsg, canvas, errors }, null, 2));
await browser.close();
