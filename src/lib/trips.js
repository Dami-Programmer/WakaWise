// Opt-in trip recorder: while navigating by car, notes how long each road piece (graph edge) took.
// The first and last 500 m are left out so home and destination can't be worked out, and only
// edge ids with seconds are sent: no coordinates, device or trip id.

const SKIP_M = 500;

export const tripsAllowed = () => {
  try {
    return localStorage.getItem('shareTrips') === '1';
  } catch {
    return false;
  }
};

export class TripRecorder {
  /** @param track route Track (cum distances), @param result route ({entries}), @param g graph */
  constructor(g, result, track) {
    // distance along the route where each edge ends: coords = start node + per edge (shape points + end node)
    this.entries = result.entries;
    this.end = new Float64Array(result.entries.length);
    let idx = 0;
    result.entries.forEach((entry, k) => {
      const e = entry >>> 1;
      idx += g.edgeShape[e + 1] - g.edgeShape[e] + 1;
      this.end[k] = track.cum[Math.min(idx, track.cum.length - 1)];
    });
    this.total = track.total;
    this.k = 0; // edge we're on
    this.enterT = null; // when we entered it (null: joined it part-way)
    this.prev = null; // {along, t}
    this.samples = [];
  }

  /** A GPS fix projected onto the route. */
  update(along, t) {
    const prev = this.prev;
    this.prev = { along, t };
    if (!prev) return;
    if (along < prev.along - 20 || t - prev.t > 30000) {
      // went backwards or lost GPS for a while: start timing afresh
      this.enterT = null;
      this.k = this.edgeAt(along);
      return;
    }
    while (this.k < this.end.length && along >= this.end[this.k]) {
      const b = this.end[this.k];
      const tCross = along === prev.along ? t : prev.t + ((b - prev.along) / (along - prev.along)) * (t - prev.t);
      const start = this.k ? this.end[this.k - 1] : 0;
      if (this.enterT != null && start >= SKIP_M && b <= this.total - SKIP_M) {
        const s = (tCross - this.enterT) / 1000;
        if (s > 0 && s < 3600) this.samples.push([this.entries[this.k] >>> 1, +s.toFixed(1)]);
      }
      this.enterT = Math.max(prev.t, tCross);
      this.k++;
    }
  }

  edgeAt(along) {
    let k = 0;
    while (k < this.end.length && this.end[k] <= along) k++;
    return k;
  }
}

/** Hour of the week in Nigeria time: 0-23 weekdays, 24-47 weekends. */
export function bucket(date = new Date()) {
  const lagos = new Date(date.getTime() + 3600e3); // UTC+1, no daylight saving
  const day = lagos.getUTCDay();
  return (day === 0 || day === 6 ? 24 : 0) + lagos.getUTCHours();
}
