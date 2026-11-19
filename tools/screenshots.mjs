// Takes phone-size screenshots of the app for the link-preview image (tools/make_share_image.py).
// Needs the dev server running (npx vite) and Microsoft Edge installed. Run: node tools/screenshots.mjs
// Output: tools/shots/directions.png, tools/shots/nav.png

import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = process.env.APP_URL || 'http://localhost:5173';
const OUT = fileURLToPath(new URL('./shots/', import.meta.url));
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
page.on('pageerror', (e) => console.error('page error:', e.message));

const sleep = (ms) => page.waitForTimeout(ms);
const mapIdle = () =>
  page.waitForFunction(() => window.__map && window.__map.isStyleLoaded() && window.__map.areTilesLoaded(), null, { timeout: 60000 });

await page.goto(`${BASE}/?state=lagos&sim`);
await page.waitForFunction(() => document.getElementById('state-chip')?.textContent.includes('Ready'), null, { timeout: 180000 });
await mapIdle();

// directions: Ikeja -> Ikeja City Mall, with the alternative routes
await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const input = document.getElementById('search');
  input.dispatchEvent(new Event('focus'));
  input.value = 'Ikeja City Mall';
  input.dispatchEvent(new Event('input'));
  await sleep(500);
  document.querySelector('#sheet [data-act=result]').click();
  await sleep(900);
  document.querySelector('#sheet [data-act=directions]').click();
  await sleep(300);
  const m = window.__map;
  const ll = { lng: 3.3515, lat: 6.6018 };
  m.fire('click', { lngLat: new (m.getCenter().constructor)(ll.lng, ll.lat), point: m.project([ll.lng, ll.lat]), originalEvent: {} });
});
await sleep(1500);
await mapIdle();
await sleep(500);
await page.screenshot({ path: OUT + 'directions.png' });

// navigation screen (simulated drive)
await page.evaluate(() => document.querySelector('#sheet [data-act=navigate]').click());
await sleep(12000);
await mapIdle().catch(() => {});
await sleep(800);
await page.screenshot({ path: OUT + 'nav.png' });

await browser.close();
console.log('screenshots saved in tools/shots/');
