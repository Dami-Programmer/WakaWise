// Turn-by-turn instructions from a route, with landmarks the way people give directions in
// Nigeria: "Turn left at First Bank onto Allen Avenue".

import { FLAG, entryTarget } from './graph.js';

const LANDMARK_RE =
  /\b(bank|fuel|gas station|petrol|filling|church|mosque|hospital|clinic|school|college|university|supermarket|mall|shopping|market|hotel|pharmacy|bus stop|bus station|police|stadium|fast food|restaurant|cinema|park|roundabout|junction|plaza|atm)\b/i;
const LANDMARK_RADIUS_M = 70;
const CELL = 0.002;

/** Grid of searchable docs that make good landmarks (banks, fuel stations, churches, malls…). */
export class Landmarks {
  constructor(docs) {
    this.cells = new Map();
    for (const d of docs) {
      if (!LANDMARK_RE.test(d.k) && !d.alt) continue;
      const key = `${Math.floor(d.lat / CELL)}:${Math.floor(d.lon / CELL)}`;
      let list = this.cells.get(key);
      if (!list) this.cells.set(key, (list = []));
      list.push(d);
    }
  }

  near(lat, lon) {
    const cy = Math.floor(lat / CELL);
    const cx = Math.floor(lon / CELL);
    const k = Math.cos((lat * Math.PI) / 180) * 111320;
    let best = null;
    let bestScore = -Infinity;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        for (const d of this.cells.get(`${cy + dy}:${cx + dx}`) ?? []) {
          const m = Math.hypot((d.lat - lat) * 111320, (d.lon - lon) * k);
          if (m > LANDMARK_RADIUS_M) continue;
          // prefer well-known brands and important places, then closeness
          const score = (d.alt ? 2 : 0) + (d.w ?? 1) - m / 25;
          if (score > bestScore) {
            best = d;
            bestScore = score;
          }
        }
    return best;
  }
}

function bearing(lat1, lon1, lat2, lon2) {
  const toR = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * toR) * Math.cos(lat2 * toR);
  const x = Math.cos(lat1 * toR) * Math.sin(lat2 * toR) - Math.sin(lat1 * toR) * Math.cos(lat2 * toR) * Math.cos((lon2 - lon1) * toR);
  return (Math.atan2(y, x) / toR + 360) % 360;
}

/** Coordinates of one edge in travel direction, as [lat, lon] pairs. */
function edgePoints(g, from, entry) {
  const s = g.scale;
  const e = entry >>> 1;
  const pts = [[g.nodeLat[from] / s, g.nodeLon[from] / s]];
  const a = g.edgeShape[e];
  const b = g.edgeShape[e + 1];
  if (entry & 1) for (let i = b - 1; i >= a; i--) pts.push([g.shapeLat[i] / s, g.shapeLon[i] / s]);
  else for (let i = a; i < b; i++) pts.push([g.shapeLat[i] / s, g.shapeLon[i] / s]);
  const to = entryTarget(g, entry);
  pts.push([g.nodeLat[to] / s, g.nodeLon[to] / s]);
  return pts;
}

function turnWord(delta) {
  const a = Math.abs(delta);
  const side = delta < 0 ? 'left' : 'right';
  if (a < 25) return { type: 'straight', text: 'Continue straight' };
  if (a < 60) return { type: `slight-${side}`, text: `Keep ${side}` };
  if (a < 140) return { type: side, text: `Turn ${side}` };
  return { type: 'uturn', text: 'Make a U-turn' };
}

const roadName = (g, e) => {
  const i = g.edgeName[e];
  return i >= 0 ? g.names[i] : '';
};

/**
 * @returns [{type, text, lat, lon, distance}] where distance is metres to the next step.
 */
export function buildSteps(g, route, landmarks, destinationName = 'your destination') {
  const steps = [];
  const { entries } = route;
  if (!entries.length) return [{ type: 'arrive', text: `You are at ${destinationName}`, distance: 0 }];

  // walk edges, remembering where each starts and its first/last bearing
  let at = entries.length ? startNode(g, entries[0]) : 0;
  const edges = entries.map((entry) => {
    const pts = edgePoints(g, at, entry);
    const e = entry >>> 1;
    const info = {
      entry, e, pts,
      name: roadName(g, e),
      len: g.edgeLen[e],
      roundabout: (g.edgeFlags[e] & FLAG.ROUNDABOUT) !== 0,
      inBearing: bearing(...pts[0], ...pts[1]),
      outBearing: bearing(...pts[pts.length - 2], ...pts[pts.length - 1]),
    };
    at = entryTarget(g, entry);
    return info;
  });

  const first = edges[0];
  steps.push({
    type: 'depart',
    text: `Head ${compass(first.inBearing)}${first.name ? ` on ${first.name}` : ''}`,
    lat: first.pts[0][0],
    lon: first.pts[0][1],
    distance: 0,
    road: first.name,
  });

  let inRoundabout = false;
  for (let i = 0; i < edges.length; i++) {
    const cur = edges[i];
    const prev = edges[i - 1];
    steps[steps.length - 1].distance += cur.len;
    if (!prev) continue;
    const [lat, lon] = cur.pts[0];
    if (cur.roundabout && !prev.roundabout) {
      inRoundabout = true;
      steps[steps.length - 1].distance -= cur.len;
      steps.push({ type: 'roundabout', text: 'Enter the roundabout', lat, lon, distance: cur.len });
      continue;
    }
    if (inRoundabout && !cur.roundabout) {
      inRoundabout = false;
      const s = steps[steps.length - 1];
      s.text = `At the roundabout, exit${cur.name ? ` onto ${cur.name}` : ''}`;
      s.road = cur.name;
      continue;
    }
    if (inRoundabout) continue;
    const delta = ((cur.inBearing - prev.outBearing + 540) % 360) - 180;
    const nameChanged = cur.name !== prev.name;
    if (Math.abs(delta) < 60 && !nameChanged) continue; // same road, gentle bend: nothing to say
    if (Math.abs(delta) < 25 && nameChanged && (!cur.name || !prev.name)) continue; // unnamed bits: don't chatter
    const t = turnWord(delta);
    if (t.type === 'straight' && !cur.name) continue;
    const lm = landmarks?.near(lat, lon);
    const text =
      t.type === 'straight'
        ? `Continue onto ${cur.name}`
        : `${t.text}${lm ? ` at ${lm.alt || lm.n}` : ''}${cur.name ? ` onto ${cur.name}` : ''}`;
    steps[steps.length - 1].distance -= cur.len;
    const lead = t.type === 'straight' ? 'Continue' : `${t.text}${lm ? ` at ${lm.alt || lm.n}` : ''}`;
    steps.push({ type: t.type, text, lead, road: cur.name, lat, lon, distance: cur.len, landmark: lm?.n });
  }
  const last = edges[edges.length - 1].pts;
  steps.push({ type: 'arrive', text: `Arrive at ${destinationName}`, lat: last[last.length - 1][0], lon: last[last.length - 1][1], distance: 0 });
  return steps;
}

function startNode(g, entry) {
  const e = entry >>> 1;
  return entry & 1 ? g.edgeTo[e] : g.edgeFrom[e];
}

function compass(b) {
  return ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'][Math.round(b / 45) % 8];
}
