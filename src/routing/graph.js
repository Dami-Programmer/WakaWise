// Loads the binary road graph written by pipeline/build_osm.py.
// Works in the browser and in Node: pass graph.json (parsed) and graph.bin (ArrayBuffer).

const TYPES = { Int32: Int32Array, Uint32: Uint32Array, Float32: Float32Array, Uint8: Uint8Array };

export const FLAG = { CAR_FWD: 1, CAR_BWD: 2, FOOT: 4, ROUNDABOUT: 8 };
export const NODE_MAIN = 1;

export function loadGraph(meta, buffer) {
  const g = {
    meta,
    names: meta.names,
    classes: meta.classes,
    scale: meta.coordScale,
    nodeCount: meta.counts.nodes,
    edgeCount: meta.counts.edges,
  };
  for (const s of meta.sections) g[s.name] = new TYPES[s.type](buffer, s.offset, s.length);
  return g;
}

/** Can `mode` ('car' | 'foot') travel along adjacency entry (edgeId << 1 | reversed)? */
export function canUse(g, entry, mode) {
  const f = g.edgeFlags[entry >>> 1];
  if (mode === 'foot') return (f & FLAG.FOOT) !== 0;
  return (f & (entry & 1 ? FLAG.CAR_BWD : FLAG.CAR_FWD)) !== 0;
}

/** Node reached by following adjacency entry. */
export function entryTarget(g, entry) {
  const e = entry >>> 1;
  return entry & 1 ? g.edgeFrom[e] : g.edgeTo[e];
}

/**
 * Nearest node on the main network that `mode` can leave from.
 * Linear scan: fine for tests. The app will use a spatial grid (step 4).
 */
export function nearestNode(g, lat, lon, mode) {
  const s = g.scale;
  const k = Math.cos((lat * Math.PI) / 180);
  let best = -1;
  let bestD = Infinity;
  for (let n = 0; n < g.nodeCount; n++) {
    if (!(g.nodeFlags[n] & NODE_MAIN)) continue;
    const dy = g.nodeLat[n] / s - lat;
    const dx = (g.nodeLon[n] / s - lon) * k;
    const d = dx * dx + dy * dy;
    if (d >= bestD) continue;
    let usable = false;
    for (let i = g.adjOffset[n]; i < g.adjOffset[n + 1] && !usable; i++) usable = canUse(g, g.adj[i], mode);
    if (usable) {
      best = n;
      bestD = d;
    }
  }
  return best;
}
