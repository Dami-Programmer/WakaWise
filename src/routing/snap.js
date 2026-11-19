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
}
