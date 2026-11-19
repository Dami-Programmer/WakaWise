// Find which state a position is in, using the small simplified borders file (works offline).

export async function loadStates() {
  const [shapes, index] = await Promise.all([
    fetch('/states.geojson').then((r) => r.json()),
    fetch('/data/states/index.json').then((r) => (r.ok ? r.json() : { states: [] })).catch(() => ({ states: [] })),
  ]);
  const sizes = Object.fromEntries(index.states.map((s) => [s.slug, s]));
  return shapes.features
    .map((f) => ({ ...f.properties, geometry: f.geometry, bbox: bboxOf(f.geometry), info: sizes[f.properties.slug] }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function bboxOf(geom) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  for (const poly of polys)
    for (const [x, y] of poly[0]) {
      if (x < w) w = x;
      if (x > e) e = x;
      if (y < s) s = y;
      if (y > n) n = y;
    }
  return [w, s, e, n];
}

function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function stateAt(states, lon, lat) {
  for (const s of states) {
    const [w, so, e, n] = s.bbox;
    if (lon < w || lon > e || lat < so || lat > n) continue;
    const polys = s.geometry.type === 'Polygon' ? [s.geometry.coordinates] : s.geometry.coordinates;
    for (const poly of polys) {
      if (inRing(lon, lat, poly[0]) && !poly.slice(1).some((hole) => inRing(lon, lat, hole))) return s;
    }
  }
  return null;
}

const LOCATION_ERRORS = {
  denied: 'Location is blocked for this site. Allow location for this page in your browser (tap the lock or ⓘ icon next to the address), then try again.',
  unavailable: "Your device couldn't find its position. Turn on Location (GPS) in your phone or Windows settings, then try again.",
  timeout: 'Finding your position took too long. Move near a window or outdoors and try again.',
  unsupported: "This browser can't share your location.",
  insecure: 'Location only works on a secure (https) page.',
};

/**
 * Current position. Resolves {lat, lon, accuracy} on success, or {error, message} explaining
 * why it failed, so the page can tell people how to fix it.
 */
export function getPosition(timeout = 10000) {
  return new Promise((resolve) => {
    const fail = (error) => resolve({ error, message: LOCATION_ERRORS[error] });
    if (!window.isSecureContext) return fail('insecure');
    if (!navigator.geolocation) return fail('unsupported');
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => fail(e.code === 1 ? 'denied' : e.code === 3 ? 'timeout' : 'unavailable'),
      { enableHighAccuracy: true, timeout, maximumAge: 30000 },
    );
  });
}
