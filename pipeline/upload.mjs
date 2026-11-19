// Upload the state packages to the Cloudflare R2 bucket the hosted app reads from.
//
//   node pipeline/upload.mjs            upload changed files to the real bucket (needs `npx wrangler login`)
//   node pipeline/upload.mjs --local    upload to the local simulated bucket used by `npm run cf:dev`
//   node pipeline/upload.mjs abia lagos only these states (index.json is always uploaded last)
//
// Only files that changed since the last upload are sent (remembered in data/states/.uploaded-*.json).
// index.json goes last, so phones never see a new list before its files are there.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const statesDir = join(root, 'data', 'states');
const BUCKET = /bucket_name\s*=\s*"([^"]+)"/.exec(readFileSync(join(root, 'wrangler.toml'), 'utf8'))[1];
const FILES = ['graph.json', 'search.json', 'graph.bin', 'tiles.pmtiles'];
const TYPES = { json: 'application/json', pmtiles: 'application/vnd.pmtiles', bin: 'application/octet-stream' };

const args = process.argv.slice(2);
const local = args.includes('--local');
const only = args.filter((a) => !a.startsWith('--'));
const target = local ? 'local' : 'remote';
const memoFile = join(statesDir, `.uploaded-${target}.json`);
const memo = existsSync(memoFile) ? JSON.parse(readFileSync(memoFile, 'utf8')) : {};

const index = JSON.parse(readFileSync(join(statesDir, 'index.json'), 'utf8'));
const slugs = index.states.map((s) => s.slug).filter((s) => !only.length || only.includes(s));
if (only.length && slugs.length !== only.length) throw new Error(`Unknown state(s): ${only.filter((s) => !slugs.includes(s)).join(', ')}`);

const jobs = [];
for (const slug of slugs) {
  for (const f of FILES) {
    const path = join(statesDir, slug, f);
    const st = statSync(path);
    const key = `${slug}/${f}`;
    const stamp = `${st.size}:${Math.round(st.mtimeMs)}`;
    if (memo[key] !== stamp) jobs.push({ key, path, stamp, size: st.size });
  }
}

const wrangler = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
function put(key, path) {
  const type = TYPES[key.split('.').pop()];
  return new Promise((resolveP, reject) => {
    const p = spawn(process.execPath, [wrangler, 'r2', 'object', 'put', `${BUCKET}/${key}`, '--file', path, '--content-type', type, local ? '--local' : '--remote'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.stdout.on('data', () => {});
    p.on('close', (code) => (code === 0 ? resolveP() : reject(new Error(`${key}: wrangler exited ${code}\n${err.slice(-2000)}`))));
  });
}

const total = jobs.reduce((a, j) => a + j.size, 0);
console.log(`${target}: ${jobs.length} file(s) to upload, ${(total / 1e6).toFixed(1)} MB${jobs.length ? '' : ' (everything is up to date)'}`);
let done = 0;
const t0 = Date.now();
const queue = [...jobs];
async function worker() {
  for (let j; (j = queue.shift()); ) {
    await put(j.key, j.path);
    memo[j.key] = j.stamp;
    writeFileSync(memoFile, JSON.stringify(memo, null, 1)); // progress survives an interrupted run
    done += j.size;
    const s = (Date.now() - t0) / 1000;
    console.log(`  ${j.key}  (${((done / total) * 100).toFixed(0)}%, ${(done / 1e6 / s).toFixed(1)} MB/s)`);
  }
}
// the local simulated bucket doesn't like parallel writers
await Promise.all(Array.from({ length: local ? 1 : 3 }, worker));
await put('index.json', join(statesDir, 'index.json'));
console.log('  index.json');
console.log('Upload finished.');
