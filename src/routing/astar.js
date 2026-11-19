// A* shortest-time routing over the graph from graph.js.

import { canUse, entryTarget } from './graph.js';

const WALK_MS = 1.4; // walking speed, metres per second
const BIKE_KMH = 35; // keke / okada top speed

/** Metres per second along edge `e`, and an extra cost factor (keke/okada avoid trunk roads). */
function speedOf(g, e, mode) {
  if (mode === 'foot') return WALK_MS;
  if (mode === 'bike') return Math.min(g.edgeSpeed[e], BIKE_KMH) / 3.6;
  return g.edgeSpeed[e] / 3.6;
}
const R = 6371008.8;
const RAD = Math.PI / 180;

function distance(lat1, lon1, lat2, lon2) {
  const x = (lon2 - lon1) * RAD * Math.cos(((lat1 + lat2) / 2) * RAD);
  const y = (lat2 - lat1) * RAD;
  return Math.sqrt(x * x + y * y) * R;
}

class MinHeap {
  constructor() {
    this.items = [];
    this.prio = [];
  }
  get size() {
    return this.items.length;
  }
  push(item, p) {
    const { items, prio } = this;
    let i = items.length;
    items.push(item);
    prio.push(p);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (prio[parent] <= p) break;
      items[i] = items[parent];
      prio[i] = prio[parent];
      i = parent;
    }
    items[i] = item;
    prio[i] = p;
  }
  pop() {
    const { items, prio } = this;
    const top = items[0];
    const lastItem = items.pop();
    const lastPrio = prio.pop();
    const n = items.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const m = r < n && prio[r] < prio[l] ? r : l;
        if (prio[m] >= lastPrio) break;
        items[i] = items[m];
        prio[i] = prio[m];
        i = m;
      }
      items[i] = lastItem;
      prio[i] = lastPrio;
    }
    return top;
  }
}

/**
 * Fastest route between two graph nodes.
 * @returns {{mode, seconds, meters, entries: number[], coords: [lon, lat][], visited}} or null
 */
export function route(g, from, to, mode = 'car', penalty = null) {
  const N = g.nodeCount;
  const s = g.scale;
  const cost = new Float64Array(N).fill(Infinity);
  const via = new Int32Array(N).fill(-1);
  const done = new Uint8Array(N);
  const topSpeed = mode === 'foot' ? WALK_MS : mode === 'bike' ? Math.min(g.meta.maxCarSpeedKmh, BIKE_KMH) / 3.6 : g.meta.maxCarSpeedKmh / 3.6;
  const tLat = g.nodeLat[to] / s;
  const tLon = g.nodeLon[to] / s;
  const h = (n) => distance(g.nodeLat[n] / s, g.nodeLon[n] / s, tLat, tLon) / topSpeed;

  const heap = new MinHeap();
  cost[from] = 0;
  heap.push(from, h(from));
  let visited = 0;
  while (heap.size) {
    const u = heap.pop();
    if (done[u]) continue;
    done[u] = 1;
    visited++;
    if (u === to) break;
    for (let i = g.adjOffset[u]; i < g.adjOffset[u + 1]; i++) {
      const entry = g.adj[i];
      if (!canUse(g, entry, mode)) continue;
      const e = entry >>> 1;
      const v = entryTarget(g, entry);
      if (done[v]) continue;
      const avoid = mode === 'bike' ? g.bikeClass[g.edgeClass[e]] : 1;
      const c = cost[u] + (g.edgeLen[e] / speedOf(g, e, mode)) * avoid * (penalty ? penalty[e] : 1);
      if (c < cost[v]) {
        cost[v] = c;
        via[v] = entry;
        heap.push(v, c + h(v));
      }
    }
  }
  if (!done[to]) return null;

  const entries = [];
  for (let n = to; n !== from; ) {
    const entry = via[n];
    entries.push(entry);
    const e = entry >>> 1;
    n = entry & 1 ? g.edgeTo[e] : g.edgeFrom[e];
  }
  entries.reverse();
  let meters = 0;
  let seconds = 0;
  for (const entry of entries) {
    const e = entry >>> 1;
    meters += g.edgeLen[e];
    seconds += g.edgeLen[e] / speedOf(g, e, mode);
  }
  return { mode, seconds, meters, entries, coords: routeCoords(g, from, entries), visited };
}

/**
 * Up to `max` sensible alternatives to `best` (the way Google offers 2-3 routes): reroute with the
 * roads already used made more "expensive", and keep results that are clearly different and not
 * much slower.
 */
export function alternatives(g, from, to, mode, best, max = 2) {
  const penalty = new Float32Array(g.edgeLen.length).fill(1);
  const found = [best];
  const used = (r) => new Set(r.entries.map((x) => x >>> 1));
  const overlap = (r, set) => {
    let shared = 0;
    for (const x of r.entries) if (set.has(x >>> 1)) shared += g.edgeLen[x >>> 1];
    return r.meters ? shared / r.meters : 1;
  };
  const sets = [used(best)];
  let last = best;
  for (let tries = 0; tries < 6 && found.length <= max; tries++) {
    for (const x of last.entries) penalty[x >>> 1] *= 1.6;
    const r = route(g, from, to, mode, penalty);
    if (!r) break;
    last = r;
    if (r.seconds > best.seconds * 1.45 + 60) continue;
    if (sets.some((set) => overlap(r, set) > 0.7)) continue;
    found.push(r);
    sets.push(used(r));
  }
  return found.slice(1);
}

/** Full route line as [lon, lat] pairs (GeoJSON order), including shape points. */
export function routeCoords(g, from, entries) {
  const s = g.scale;
  const out = [[g.nodeLon[from] / s, g.nodeLat[from] / s]];
  for (const entry of entries) {
    const e = entry >>> 1;
    const a = g.edgeShape[e];
    const b = g.edgeShape[e + 1];
    if (entry & 1) for (let i = b - 1; i >= a; i--) out.push([g.shapeLon[i] / s, g.shapeLat[i] / s]);
    else for (let i = a; i < b; i++) out.push([g.shapeLon[i] / s, g.shapeLat[i] / s]);
    const n = entryTarget(g, entry);
    out.push([g.nodeLon[n] / s, g.nodeLat[n] / s]);
  }
  return out;
}
