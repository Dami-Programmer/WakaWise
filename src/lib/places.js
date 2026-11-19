// Home, Work and recently opened places, kept on this device (localStorage).

const read = (k, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(k)) ?? fallback;
  } catch {
    return fallback;
  }
};
const write = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* storage full or blocked: keep it for this session only */
  }
};
const slim = (p, slug) => ({ n: p.n, k: p.k || '', a: p.a || '', lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6), slug });
const same = (a, b) => a.n === b.n && Math.abs(a.lat - b.lat) < 1e-4 && Math.abs(a.lon - b.lon) < 1e-4;

/** Places opened recently in this state, newest first. */
export function recentPlaces(slug) {
  return read(`recent:${slug}`, []);
}

export function addRecent(slug, p) {
  if (!p || p.me || p.pin) return; // "your location" and dropped pins aren't worth remembering
  const item = slim(p, slug);
  write(`recent:${slug}`, [item, ...recentPlaces(slug).filter((x) => !same(x, item))].slice(0, 8));
}

export function clearRecent(slug) {
  write(`recent:${slug}`, []);
}

/** {home, work}: each null or a place (with the state it's in). */
export function savedPlaces() {
  return read('saved', { home: null, work: null });
}

export function setSaved(kind, p, slug) {
  write('saved', { ...savedPlaces(), [kind]: p ? slim(p, slug) : null });
}
