// End-to-end offline test against a real deployment (default: the live site), like a phone would do:
// open the site, download a state, go offline, reload, then check the page, map, search and routing.
// Needs Microsoft Edge. Run: node tools/offline-test.mjs [url] [state]
import { chromium } from 'playwright-core';

const URL_ = process.argv[2] || 'https://wakawise.pages.dev';
const STATE = process.argv[3] || 'abia';
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const step = (msg) => console.log(`- ${msg}`);
let ok = true;
const check = (cond, msg) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${msg}`);
  ok &&= !!cond;
};

step(`online: open ${URL_}/?state=${STATE} and download it`);
await page.goto(`${URL_}/?state=${STATE}`);
await page.waitForFunction(() => document.getElementById('state-chip')?.textContent.includes('Ready'), null, { timeout: 240000 });
await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 60000 }).catch(() => {});
// give the offline script time to finish saving the app's files
await page.waitForTimeout(4000);
check(await page.evaluate(() => !!navigator.serviceWorker.controller), 'offline script is running');

step('go offline, close the tab, open the link again');
await context.setOffline(true);
await page.close();
const p2 = await context.newPage();
p2.on('pageerror', (e) => errors.push(e.message));
let loaded = true;
try {
  await p2.goto(URL_ + '/', { timeout: 30000 });
} catch (e) {
  loaded = false;
  console.log('  page failed to open:', e.message.split('\n')[0]);
}
check(loaded, 'page opens with no connection');
if (loaded) {
  const ready = await p2
    .waitForFunction(() => document.getElementById('state-chip')?.textContent.includes('Ready'), null, { timeout: 60000 })
    .then(() => true, () => false);
  check(ready, `${STATE} map opens from the phone's storage`);
  const title = await p2.title();
  check(title === 'WakaWise', `title is "${title}"`);
  await p2.waitForTimeout(3000);
  const drawn = await p2.evaluate(() => {
    const c = document.querySelector('.maplibregl-canvas');
    return !!c && c.width > 0;
  });
  check(drawn, 'map is drawn');
  // search offline
  await p2.click('#search');
  await p2.fill('#search', 'Aba');
  await p2.waitForTimeout(800);
  const results = await p2.$$eval('#sheet [data-act=result]', (els) => els.length);
  check(results > 0, `search works offline (${results} results for "Aba")`);
}
check(errors.length === 0, `no script errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
await browser.close();
console.log(ok ? 'ALL PASSED' : 'SOMETHING FAILED');
process.exit(ok ? 0 : 1);
