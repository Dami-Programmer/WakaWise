// Typical-traffic travel time ranges. There is no live traffic offline, so instead of one
// optimistic number we show a range based on the city and time of day.
// Multipliers apply to the free-flow driving time from the router. They are estimates, to be
// replaced by real speeds measured from (opt-in) user trips later.

const PROFILES = {
  lagos: { peak: [1.8, 3.2], day: [1.3, 2.0], night: [1.0, 1.3] },
  'federal-capital-territory': { peak: [1.3, 2.0], day: [1.1, 1.5], night: [1.0, 1.15] },
  rivers: { peak: [1.4, 2.2], day: [1.15, 1.6], night: [1.0, 1.2] },
  kano: { peak: [1.3, 1.9], day: [1.1, 1.5], night: [1.0, 1.15] },
  oyo: { peak: [1.3, 1.9], day: [1.1, 1.5], night: [1.0, 1.15] },
  ogun: { peak: [1.4, 2.4], day: [1.1, 1.6], night: [1.0, 1.15] },
  default: { peak: [1.15, 1.5], day: [1.05, 1.3], night: [1.0, 1.1] },
};

export function period(date = new Date()) {
  const h = date.getHours() + date.getMinutes() / 60;
  const weekend = date.getDay() === 0 || date.getDay() === 6;
  if (h >= 21 || h < 5.5) return 'night';
  if (!weekend && ((h >= 6 && h < 10) || (h >= 16 && h < 21))) return 'peak';
  return 'day';
}

const LABEL = { peak: 'rush hour', day: 'daytime traffic', night: 'light traffic' };

/** {min, max, label} in seconds for the given free-flow time. */
export function travelRange(seconds, mode, slug, date = new Date()) {
  if (mode === 'foot') return { min: seconds, max: seconds * 1.15, label: 'walking' };
  const p = period(date);
  const [lo, hi] = (PROFILES[slug] ?? PROFILES.default)[p];
  return { min: seconds * lo, max: seconds * hi, label: LABEL[p] };
}

export function formatDuration(sec) {
  const m = Math.max(1, Math.round(sec / 60));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60 ? `${m % 60} min` : ''}`.trim();
}

export function formatRange({ min, max }) {
  const a = Math.max(1, Math.round(min / 60));
  const b = Math.max(a, Math.round(max / 60));
  if (b < 60) return a === b ? `${a} min` : `${a}–${b} min`;
  return `${formatDuration(min)} – ${formatDuration(max)}`;
}

export function formatDistance(m) {
  return m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 9500 ? 1 : 0)} km`;
}
