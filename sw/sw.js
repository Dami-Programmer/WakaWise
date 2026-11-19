// Service worker: keeps the page itself working with no connection.
// Built into dist/sw.js by the "offline-shell" plugin in vite.config.js, which fills in
// __VERSION__ and __PRECACHE__ (every built file plus the fonts and icons the map needs).
//
// The state packages (/data/states/<slug>/...) are NOT handled here: the page saves them in
// IndexedDB itself (src/lib/packs.js), with resumable downloads.

const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;
const SHELL = `shell-${VERSION}`;
const RUNTIME = 'runtime';
const BASE = new URL('./', self.location).pathname;
// The page itself is saved under BASE ("/"), not "/index.html": hosts like Cloudflare Pages
// redirect /index.html to /, and browsers refuse to open a page from a saved redirect.
const PAGE = BASE;

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(SHELL)
      .then((c) =>
        Promise.all(
          PRECACHE.map(async (u) => {
            const url = u === 'index.html' ? PAGE : BASE + u;
            const res = await fetch(new Request(url, { cache: 'reload' }));
            if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
            await c.put(url, await unredirect(res));
          }),
        ),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('shell-') && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;

  if (path.startsWith(`${BASE}data/states/`)) {
    // the list of states and their sizes: fresh when online, last copy when offline
    if (path.endsWith('/index.json')) e.respondWith(networkFirst(req, 4000));
    return; // packages: the page stores them itself
  }
  if (req.mode === 'navigate') {
    e.respondWith(networkFirst(req, 3000, PAGE));
    return;
  }
  if (path.startsWith(`${BASE}fonts/`)) {
    e.respondWith(font(req));
    return;
  }
  e.respondWith(cacheFirst(req));
});

/** A copy of the response without the "redirected" mark (a redirected response can't open a page). */
async function unredirect(res) {
  if (!res.redirected) return res;
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers });
}

async function fromCache(req) {
  return (await caches.match(req, { ignoreSearch: true })) || null;
}

async function cacheFirst(req) {
  const hit = await fromCache(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) (await caches.open(RUNTIME)).put(req, res.clone());
  return res;
}

/** Try the network, but don't wait more than `ms` on a poor connection before using the saved copy. */
async function networkFirst(req, ms, fallbackUrl) {
  const net = fetch(req).then(async (res) => {
    if (res.ok) (await caches.open(RUNTIME)).put(fallbackUrl || req, await unredirect(res.clone()));
    return res;
  });
  net.catch(() => {});
  const timeout = new Promise((resolve) => setTimeout(resolve, ms, null));
  try {
    const res = await Promise.race([net, timeout]);
    if (res) return res;
  } catch {
    /* offline */
  }
  const saved = (await fromCache(req)) || (fallbackUrl && (await caches.match(fallbackUrl)));
  if (saved) return saved;
  return net; // nothing saved: wait for the network after all
}

/**
 * Map label glyphs. The common ranges are precached; rarer ones (Chinese, emoji, ...) are fetched
 * when online. Offline, a missing range gets an empty answer so the rest of the label still draws.
 */
async function font(req) {
  const hit = await fromCache(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok) (await caches.open(RUNTIME)).put(req, res.clone());
    return res;
  } catch {
    return new Response(new Uint8Array(0), { headers: { 'Content-Type': 'application/x-protobuf' } });
  }
}
