// Phone screenshots of every main screen, for design review: node tools/ui-shots.mjs [outDir] [theme]
// Needs the dev server (npx vite) and Microsoft Edge. Output: tools/shots/ui-<theme>-<screen>.png
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = process.argv[2] || fileURLToPath(new URL('./shots/', import.meta.url));
const THEMES = process.argv[3] ? [process.argv[3]] : ['dark', 'light'];
const BASE = process.env.APP_URL || 'http://localhost:5173';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

for (const theme of THEMES) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, geolocation: { latitude: 6.6018, longitude: 3.3515 }, permissions: ['geolocation'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  const shot = async (name) => {
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${OUT}/ui-${theme}-${name}.png` });
  };
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const idle = () => page.waitForFunction(() => window.__map?.areTilesLoaded(), null, { timeout: 30000 }).catch(() => {});

  // first visit welcome (no saved state remembered)
  await page.goto(`${BASE}/`);
  await ev((t) => { localStorage.clear(); localStorage.setItem('theme', t); }, theme);
  await page.addInitScript(() => { navigator.geolocation.getCurrentPosition = () => {}; });
  await page.goto(`${BASE}/`);
  await shot('01-welcome');

  // state picker
  await page.click('#sheet [data-act=pick]');
  await shot('02-picker');

  // map home
  const p2 = await ctx.newPage();
  await page.close();
  const pg = p2;
  pg.on('pageerror', (e) => console.error('page error:', e.message));
  Object.assign(page, {});
  await pg.goto(`${BASE}/?state=lagos&sim`);
  await pg.evaluate((t) => localStorage.setItem('theme', t), theme);
  await pg.goto(`${BASE}/?state=lagos&sim`);
  await pg.waitForFunction(() => document.getElementById('state-chip')?.textContent.includes('Ready'), null, { timeout: 120000 });
  const s = async (name) => { await pg.waitForTimeout(800); await pg.screenshot({ path: `${OUT}/ui-${theme}-${name}.png` }); };
  await pg.evaluate(() => window.__map.jumpTo({ center: [3.3515, 6.6018], zoom: 15 }));
  await pg.waitForFunction(() => window.__map?.areTilesLoaded(), null, { timeout: 30000 }).catch(() => {});
  await s('03-map');

  // where to? panel
  await pg.focus('#search');
  await s('04-whereto');

  // search results
  await pg.fill('#search', 'bank');
  await pg.waitForSelector('#sheet [data-act=result]');
  await s('05-results');

  // place
  await pg.click('#sheet [data-act=result]');
  await s('06-place');

  // directions with alternatives
  await pg.click('#sheet [data-act=directions]');
  await pg.waitForTimeout(800);
  await pg.evaluate(() => {
    const m = window.__map; const ll = { lng: 3.3515, lat: 6.6018 };
    if (!window.__app.dir.from) m.fire('click', { lngLat: new (m.getCenter().constructor)(ll.lng, ll.lat), point: m.project([ll.lng, ll.lat]), originalEvent: {} });
  });
  await pg.waitForTimeout(1500);
  await s('07-directions');
  await pg.evaluate(() => document.getElementById('sheet').scrollTo(0, 400));
  await s('08-directions-steps');

  // navigation (simulated)
  await pg.evaluate(() => document.querySelector('#sheet [data-act=navigate]').click());
  await pg.waitForTimeout(9000);
  await s('09-nav');
  await pg.evaluate(() => window.__app.nav?.exit('silent'));
  await pg.waitForTimeout(500);

  // settings
  await pg.evaluate(() => document.getElementById('settings').click());
  await s('10-settings');
  await pg.evaluate(() => document.getElementById('sheet').scrollTo(0, 2000));
  await s('11-settings-end');
  await ctx.close();
}
await browser.close();
console.log('saved in', OUT);
