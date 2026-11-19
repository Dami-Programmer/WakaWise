// Fast "nearest road junction" lookup with a grid index (built once per state graph).

import { canUse, NODE_MAIN } from './graph.js';

const CELL = 0.005; // ~550 m

export class Snapper {
  constructor(g) {
    this.g = g;
    this.cells = new Map();
    const s = g.scale;
    for (let n = 0; n < g.nodeCount; n++) {
      if (!(g.nodeFlags[n] & NODE_MAIN)) continue;
      const key = this.key(Math.floor(g.nodeLat[n] / s / CELL), Math.floor(g.nodeLon[n] / s / CELL));
      let list = this.cells.get(key);
      if (!list) this.cells.set(key, (list = []));
      list.push(n);
    }
  }

  key(cy, cx) {
    return cy * 100000 + cx;
  }

  usable(n, mode) {
    const g = this.g;
    for (let i = g.adjOffset[n]; i < g.adjOffset[n + 1]; i++) if (canUse(g, g.adj[i], mode)) return true;
    return false;
  }

  /** Nearest main-network node `mode` can leave from; searches outward up to ~11 km. */
  nearest(lat, lon, mode) {
    const g = this.g;
    const s = g.scale;
    const k = Math.cos((lat * Math.PI) / 180);
    const cy = Math.floor(lat / CELL);
    const cx = Math.floor(lon / CELL);
    let best = -1;
    let bestD = Infinity;
    for (let r = 0; r <= 20; r++) {
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dy), Math.abs(dx)) !== r) continue;
          for (const n of this.cells.get(this.key(cy + dy, cx + dx)) ?? []) {
            const y = g.nodeLat[n] / s - lat;
            const x = (g.nodeLon[n] / s - lon) * k;
            const d = x * x + y * y;
            if (d < bestD && this.usable(n, mode)) {
              best = n;
              bestD = d;
            }
          }
        }
      // ring r covers at least r*CELL in every direction; stop once that beats the best
      if (best >= 0 && Math.sqrt(bestD) < r * CELL * k) break;
    }
    return best;
  }

  /** Grid of main-network edges by the cells their shape passes through (built on first use). */
  edgeCells() {
    if (this.ecells) return this.ecells;
    const g = this.g;
    const s = g.scale;
    const cells = new Map();
    for (let e = 0; e < g.edgeCount; e++) {
      const a = g.edgeFrom[e];
      const b = g.edgeTo[e];
      if (!(g.nodeFlags[a] & NODE_MAIN) || !(g.nodeFlags[b] & NODE_MAIN)) continue;
      let y0 = Math.min(g.nodeLat[a], g.nodeLat[b]), y1 = Math.max(g.nodeLat[a], g.nodeLat[b]);
      let x0 = Math.min(g.nodeLon[a], g.nodeLon[b]), x1 = Math.max(g.nodeLon[a], g.nodeLon[b]);
      for (let i = g.edgeShape[e]; i < g.edgeShape[e + 1]; i++) {
        y0 = Math.min(y0, g.shapeLat[i]); y1 = Math.max(y1, g.shapeLat[i]);
        x0 = Math.min(x0, g.shapeLon[i]); x1 = Math.max(x1, g.shapeLon[i]);
      }
      for (let cy = Math.floor(y0 / s / CELL); cy <= Math.floor(y1 / s / CELL); cy++)
        for (let cx = Math.floor(x0 / s / CELL); cx <= Math.floor(x1 / s / CELL); cx++) {
          const key = this.key(cy, cx);
          let list = cells.get(key);
          if (!list) cells.set(key, (list = []));
          list.push(e);
        }
    }
    return (this.ecells = cells);
  }

  /**
   * The road you're on: nearest edge within `maxM` metres that `mode` can travel in the direction of
   * `heading` (degrees; null = any direction). Returns {entry, node} where entry = edge << 1 | reversed
   * and node is the junction ahead, or null.
   */
  nearestEdge(lat, lon, mode, heading = null, maxM = 60) {
    const g = this.g;
    const s = g.scale;
    const M = 111320;
    const kx = Math.cos((lat * Math.PI) / 180) * M;
    const cells = this.edgeCells();
    const cy = Math.floor(lat / CELL);
    const cx = Math.floor(lon / CELL);
    let best = null;
    let bestScore = Infinity;
    const seen = new Set();
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        for (const e of cells.get(this.key(cy + dy, cx + dx)) ?? []) {
          if (seen.has(e)) continue;
          seen.add(e);
          // walk the edge's shape: from-node, shape points, to-node (x/y in metres around us)
          const pts = [[g.nodeLon[g.edgeFrom[e]], g.nodeLat[g.edgeFrom[e]]]];
          for (let i = g.edgeShape[e]; i < g.edgeShape[e + 1]; i++) pts.push([g.shapeLon[i], g.shapeLat[i]]);
          pts.push([g.nodeLon[g.edgeTo[e]], g.nodeLat[g.edgeTo[e]]]);
          for (let i = 1; i < pts.length; i++) {
            const x1 = (pts[i - 1][0] / s - lon) * kx, y1 = (pts[i - 1][1] / s - lat) * M;
            const x2 = (pts[i][0] / s - lon) * kx, y2 = (pts[i][1] / s - lat) * M;
            const vx = x2 - x1, vy = y2 - y1;
            const len2 = vx * vx + vy * vy;
            const t = len2 ? Math.max(0, Math.min(1, -(x1 * vx + y1 * vy) / len2)) : 0;
            const d = Math.hypot(x1 + t * vx, y1 + t * vy);
            if (d > maxM) continue;
            const fwd = (Math.atan2(vx, vy) * 180) / Math.PI;
            for (const rev of [0, 1]) {
              const entry = (e << 1) | rev;
              if (!canUse(g, entry, mode)) continue;
              let score = d;
              if (heading != null && len2 > 1) {
                const dir = rev ? fwd + 180 : fwd;
                const diff = Math.abs(((dir - heading + 540) % 360) - 180);
                if (diff > 100) continue; // that way is behind us
                score += diff * 0.4; // 45° off counts like 18 m further away
              }
              if (score < bestScore) {
                bestScore = score;
                best = { entry, node: rev ? g.edgeFrom[e] : g.edgeTo[e], start: rev ? g.edgeTo[e] : g.edgeFrom[e], meters: d };
              }
            }
          }
        }
    return best;
  }
}
