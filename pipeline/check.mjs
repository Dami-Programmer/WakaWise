// Verifies the built state packages: size vs. the download budget, routing, search.
// Usage: node pipeline/check.mjs [slug ...]     (default: every state in data/states)
//
// Every state gets a sanity route between two random points on its main road network.
// States listed under "checks" in pipeline/config.json also get their named test routes and searches.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import MiniSearch from 'minisearch';
import { loadGraph, nearestNode, NODE_MAIN } from '../src/routing/graph.js';
import { route } from '../src/routing/astar.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(readFileSync(join(ROOT, 'pipeline', 'config.json'), 'utf8'));
const STATES = join(ROOT, 'data', 'states');
const BUDGET_MB = 80;
const FILES = ['tiles.pmtiles', 'graph.bin', 'graph.json', 'search.json'];
const mb = (b) => (b / 1e6).toFixed(1);

const slugs = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(STATES, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();

let problems = 0;
const fail = (msg) => {
  problems++;
  console.log(`    !! ${msg}`);
};

// Small deterministic RNG so sanity routes are the same on every run.
let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

function searchIndex(docs) {
  const ms = new MiniSearch({
    fields: ['n', 'alt', 'a'],
    storeFields: ['n', 'k', 'a', 'w', 'lat', 'lon'],
    searchOptions: {
      boost: { n: 3, alt: 2 },
      prefix: true,
      fuzzy: 0.2,
      boostDocument: (_id, _term, stored) => 1 + (stored?.w ?? 1) / 5,
    },
  });
  ms.addAll(docs);
  return ms;
}

console.log(`${'state'.padEnd(26)} ${'tiles'.padStart(6)} ${'graph'.padStart(6)} ${'search'.padStart(6)} ${'total MB'.padStart(8)}  sanity route (car)`);
for (const slug of slugs) {
  const dir = join(STATES, slug);
  const missing = FILES.filter((f) => !existsSync(join(dir, f)));
  if (missing.length) {
    console.log(`${slug.padEnd(26)} missing: ${missing.join(', ')}`);
    problems++;
    continue;
  }
  const bytes = Object.fromEntries(FILES.map((f) => [f, readFileSync(join(dir, f)).length]));
  const total = Object.values(bytes).reduce((a, b) => a + b, 0);

  const meta = JSON.parse(readFileSync(join(dir, 'graph.json'), 'utf8'));
  const raw = readFileSync(join(dir, 'graph.bin'));
  const g = loadGraph(meta, raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));

  // sanity route: two random main-network nodes
  const main = [];
  for (let n = 0; n < g.nodeCount; n++) if (g.nodeFlags[n] & NODE_MAIN) main.push(n);
  const a = main[Math.floor(rand() * main.length)];
  const b = main[Math.floor(rand() * main.length)];
  const t = performance.now();
  const r = route(g, a, b, 'car') ?? route(g, a, b, 'foot');
  const ms = performance.now() - t;
  const sanity = r ? `${r.mode} ${(r.meters / 1000).toFixed(0)} km in ${ms.toFixed(0)} ms` : 'no route';

  console.log(
    `${slug.padEnd(26)} ${mb(bytes['tiles.pmtiles']).padStart(6)} ${mb(bytes['graph.bin'] + bytes['graph.json']).padStart(6)} ` +
      `${mb(bytes['search.json']).padStart(6)} ${mb(total).padStart(8)}  ${sanity}`,
  );
  if (total / 1e6 > BUDGET_MB) fail(`over the ${BUDGET_MB} MB budget`);
  if (!r) fail('sanity route failed (car and foot)');

  const checks = cfg.checks?.[slug];
  if (!checks) continue;
  for (const rt of checks.routes ?? []) {
    for (const mode of ['car', 'foot']) {
      const res = route(g, nearestNode(g, ...rt.from, mode), nearestNode(g, ...rt.to, mode), mode);
      if (res) console.log(`    ${mode.padEnd(4)} ${rt.name}: ${(res.meters / 1000).toFixed(1)} km, ${Math.round(res.seconds / 60)} min`);
      else fail(`${mode} ${rt.name}: no route`);
    }
  }
  const docs = JSON.parse(readFileSync(join(dir, 'search.json'), 'utf8'));
  const idx = searchIndex(docs);
  for (const q of checks.searches ?? []) {
    const hits = idx.search(q).slice(0, 3).map((h) => `${h.n} (${h.k}${h.a ? ', ' + h.a : ''})`);
    if (hits.length) console.log(`    "${q}" -> ${hits.join(' | ')}`);
    else fail(`search "${q}": no results`);
  }
}
console.log(problems ? `\n${problems} problem(s) found` : '\nAll checks passed');
process.exitCode = problems ? 1 : 0;
