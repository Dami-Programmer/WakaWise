// Offline search: places, streets, businesses, plus codes and coordinates.
// Ranking mixes text match, how important a place is (w), exact-name matches and distance
// from where the user is looking, so "Lekki" finds Lekki before a cinema called "... Lekki".

import MiniSearch from 'minisearch';
import { parsePlusCode, encode } from './pluscode.js';

const R = 6371;
export function km(lat1, lon1, lat2, lon2) {
  const x = ((lon2 - lon1) * Math.PI) / 180 * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  const y = ((lat2 - lat1) * Math.PI) / 180;
  return Math.sqrt(x * x + y * y) * R;
}

const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

export class Search {
  constructor(docs) {
    this.ms = new MiniSearch({
      fields: ['n', 'alt', 'k', 'a'],
      storeFields: ['n', 'alt', 'k', 'a', 'w', 'lat', 'lon', 'ad', 's'],
      processTerm: (t) => norm(t) || null,
      searchOptions: {
        boost: { n: 4, alt: 2.5, k: 1.2, a: 0.6 },
        prefix: (t) => t.length >= 2,
        fuzzy: (t) => (t.length >= 5 ? 0.2 : t.length >= 4 ? 1 : 0),
      },
    });
    this.ms.addAll(docs);
    this.docs = docs;
  }

  addUserPlace(p) {
    this.ms.add({ ...p, id: p.id, w: 4, s: 'u' });
  }

  /** @returns array of results {n, k, a, lat, lon, ...} best first */
  query(text, center, limit = 12) {
    const q = text.trim();
    if (!q) return [];
    const out = [];

    // coordinates "6.45, 3.39"
    const m = q.match(/^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
    if (m) {
      const lat = +m[1], lon = +m[2];
      if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180)
        out.push({ n: `${lat.toFixed(5)}, ${lon.toFixed(5)}`, k: 'coordinates', a: encode(lat, lon), lat, lon, special: true });
    }
    // plus code "JHG6+QR" (short codes use the map centre as reference)
    const pc = parsePlusCode(q, center.lat, center.lon);
    if (pc) out.push({ n: pc.code, k: 'plus code', a: '', lat: pc.lat, lon: pc.lng, special: true });

    let hits = this.ms.search(q, { combineWith: 'AND' });
    if (hits.length < 3) hits = hits.concat(this.ms.search(q, { combineWith: 'OR' }).filter((h) => !hits.some((x) => x.id === h.id)));
    const nq = norm(q);
    const ranked = hits.slice(0, 300).map((h) => {
      const nn = norm(h.n);
      let score = h.score * (1 + (h.w ?? 1) / 4);
      if (nn === nq) score *= 2.2;
      else if (nn.startsWith(nq)) score *= 1.6;
      const d = km(center.lat, center.lon, h.lat, h.lon);
      score *= 1 + 0.8 * Math.exp(-d / 8);
      return { ...h, distKm: d, rank: score };
    });
    ranked.sort((a, b) => b.rank - a.rank);
    return out.concat(ranked.slice(0, limit));
  }
}
