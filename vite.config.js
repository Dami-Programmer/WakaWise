import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

// The dev server serves state packages straight from data/states/ (same paths the hosted
// version will use). Don't watch the big data folders.
//
// `npm run phone` builds the app and serves it over https on the Wi-Fi network so a phone can
// open it with GPS and compass working (they need https). Run `npm run phone:cert` once first and
// install the CA on the phone (see lanHttps below) so the phone trusts it and the offline service
// worker can register.

// Label glyph ranges saved for offline use: Latin, accents and combining marks (Yoruba ẹ ọ ṣ,
// Hausa ƙ ɗ), Cyrillic/Arabic, Latin Extended Additional, punctuation, letterlike symbols.
// Rarer ranges are fetched when online; offline they come back empty (see sw/sw.js).
const GLYPH_RANGES = ['0-255', '256-511', '512-767', '768-1023', '1024-1279', '1536-1791', '7680-7935', '8192-8447', '8448-8703'];

/** Writes dist/sw.js with the list of files to keep for offline use. */
function offlineShell() {
  let outDir;
  return {
    name: 'offline-shell',
    apply: 'build',
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir);
    },
    closeBundle() {
      const files = walk(outDir)
        .map((f) => relative(outDir, f).split(sep).join('/'))
        .filter((f) => !['sw.js', '_headers', '_redirects', 'og-image.jpg', 'og-square.jpg'].includes(f) && !f.endsWith('.map'))
        .filter((f) => !f.startsWith('fonts/') || GLYPH_RANGES.some((r) => f.endsWith(`/${r}.pbf`)))
        .sort();
      const template = readFileSync(resolve('sw/sw.js'), 'utf8');
      const hash = createHash('sha256').update(template);
      for (const f of files) hash.update(f).update(readFileSync(join(outDir, f)));
      const version = hash.digest('hex').slice(0, 12);
      const urls = files.map((f) => f.split('/').map(encodeURIComponent).join('/'));
      const sw = template
        .replace("'__VERSION__'", JSON.stringify(version))
        .replace('const PRECACHE = __PRECACHE__;', `const PRECACHE = ${JSON.stringify(urls)};`);
      writeFileSync(join(outDir, 'sw.js'), sw);
      const kb = files.reduce((a, f) => a + statSync(join(outDir, f)).size, 0) / 1024;
      console.log(`offline-shell: sw.js ${version}, ${files.length} files (${(kb / 1024).toFixed(1)} MB) kept for offline use`);
    },
  };
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));
}

/** `vite preview` serves only dist/, so also serve data/states/ (with Range support, like R2/Netlify). */
function serveData() {
  const root = resolve('data/states');
  return {
    name: 'serve-data',
    configurePreviewServer(server) {
      server.middlewares.use('/data/states', (req, res, next) => {
        const file = resolve(root, '.' + decodeURIComponent(req.url.split('?')[0]));
        if (!file.startsWith(root + sep)) return next();
        let st;
        try {
          st = statSync(file);
        } catch {
          return next();
        }
        if (!st.isFile()) return next();
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', file.endsWith('.json') ? 'application/json' : 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-cache');
        const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
        let start = 0;
        let end = st.size - 1;
        if (m) {
          start = m[1] ? +m[1] : st.size - +m[2];
          end = m[1] && m[2] ? Math.min(+m[2], st.size - 1) : st.size - 1;
          if (start > end || start >= st.size) {
            res.statusCode = 416;
            res.setHeader('Content-Range', `bytes */${st.size}`);
            return res.end();
          }
          res.statusCode = 206;
          res.setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
        }
        res.setHeader('Content-Length', end - start + 1);
        if (req.method === 'HEAD') return res.end();
        createReadStream(file, { start, end }).pipe(res);
      });
    },
  };
}

/**
 * Phone testing: the certificate from `npm run phone:cert` (tools/lan-cert.mjs), which the phone can
 * trust once it installs our local CA from /lan-ca.crt. Without it, fall back to a self-signed one
 * (works, but Chrome then refuses the service worker, so the page won't open offline).
 */
function lanHttps() {
  const dir = resolve('tools/certs');
  const has = ['server.key', 'server.crt', 'ca.crt'].every((f) => existsSync(join(dir, f)));
  if (!has) return { https: undefined, plugins: [basicSsl()] };
  const https = { key: readFileSync(join(dir, 'server.key')), cert: readFileSync(join(dir, 'server.crt')) };
  // (a block body: Vite treats a function returned from these hooks as a post-hook)
  const serveCa = (server) => {
    server.middlewares.use((req, res, next) => {
      const name = { '/lan-ca.crt': 'ca.crt', '/lan-ca.der.crt': 'ca.der.crt' }[req.url.split('?')[0]];
      if (!name) return next();
      res.setHeader('Content-Type', 'application/x-x509-ca-cert');
      res.setHeader('Content-Disposition', `attachment; filename="offline-map-dev-ca${name.endsWith('.der.crt') ? '.der' : ''}.crt"`);
      res.end(readFileSync(join(dir, name)));
    });
  };
  return { https, plugins: [{ name: 'serve-lan-ca', configureServer: serveCa, configurePreviewServer: serveCa }] };
}

export default defineConfig(({ mode }) => {
  const lan = mode === 'lan';
  const tls = lan ? lanHttps() : { https: undefined, plugins: [] };
  return {
    plugins: [...tls.plugins, offlineShell(), serveData()],
    // MapLibre 6 loads its worker from a file next to itself (import.meta.url); pre-bundling
    // moves the library and breaks that path.
    optimizeDeps: { exclude: ['maplibre-gl'] },
    server: {
      port: lan ? 5174 : 5173,
      host: lan ? true : undefined,
      https: tls.https,
      watch: { ignored: ['**/data/**', '**/tools/**'] },
    },
    preview: {
      port: lan ? 5174 : 4173,
      host: lan ? true : undefined,
      https: tls.https,
    },
  };
});
