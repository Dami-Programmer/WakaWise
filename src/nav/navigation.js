// Turn-by-turn navigation screen: blue instruction card, white cone "puck"
// that glides along the route with the map turning to face the direction of travel, speed,
// arrival time, voice prompts and automatic rerouting. Works fully offline (GPS needs no data).

import { TripRecorder } from '../lib/trips.js';
import { formatDistance, formatDuration, travelRange } from '../lib/traffic.js';

const M_PER_DEG = 111320;
const RAD = Math.PI / 180;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/* ------------------------------------------------------------------ arrows */
const ARROW_PATHS = {
  straight: '<path d="M24 42V12"/><path d="M14 22 24 12l10 10"/>',
  right: '<path d="M16 42V26q0-8 8-8h14"/><path d="M30 10l8 8-8 8"/>',
  left: '<path d="M32 42V26q0-8-8-8H10"/><path d="M18 10l-8 8 8 8"/>',
  'slight-right': '<path d="M20 42V30q0-4 3-7l12-12"/><path d="M24 11h11v11"/>',
  'slight-left': '<path d="M28 42V30q0-4-3-7L13 11"/><path d="M24 11H13v11"/>',
  uturn: '<path d="M32 42V20a9 9 0 0 0-18 0v14"/><path d="M7 27l7 8 7-8"/>',
  roundabout: '<circle cx="24" cy="21" r="8"/><path d="M24 42V29"/><path d="M30 15l8-8"/><path d="M30 7h8v8"/>',
  arrive: '<path d="M24 43s-11-12-11-21a11 11 0 0 1 22 0c0 9-11 21-11 21z"/><circle cx="24" cy="22" r="4"/>',
};
/** White cone pointing up (the way you're heading), lit from the left. */
export const CONE_SVG =
  '<svg class="cone" viewBox="0 0 40 48" aria-hidden="true"><path d="M20 2 4.5 38.5A15.5 6.5 0 0 0 20 45z" fill="#ffffff"/><path d="M20 2 35.5 38.5A15.5 6.5 0 0 1 20 45z" fill="#c9ced5"/><ellipse cx="20" cy="38.5" rx="15.5" ry="6.5" fill="none" stroke="#e7eaee" stroke-width="1"/></svg>';

export function turnSvg(type, cls = '') {
  const p = ARROW_PATHS[type] ?? ARROW_PATHS.straight;
  return `<svg class="${cls}" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}
const arrowType = (t) => (t === 'depart' ? 'straight' : t);

/* ------------------------------------------------------------------ route geometry */
/** The route in flat local metres, so positions can be projected onto it quickly. */
class Track {
  constructor(g, result, steps) {
    const c = result.coords;
    this.coords = c;
    this.lat0 = c[0][1];
    this.kx = Math.cos(this.lat0 * RAD) * M_PER_DEG;
    const n = c.length;
    this.x = new Float64Array(n);
    this.y = new Float64Array(n);
    this.cum = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.x[i] = c[i][0] * this.kx;
      this.y[i] = c[i][1] * M_PER_DEG;
      if (i) this.cum[i] = this.cum[i - 1] + Math.hypot(this.x[i] - this.x[i - 1], this.y[i] - this.y[i - 1]);
    }
    this.total = this.cum[n - 1];

    // road name of every segment, from the graph edges the route uses
    this.segRoad = [];
    for (const entry of result.entries) {
      const e = entry >>> 1;
      const name = g.edgeName[e] >= 0 ? g.names[g.edgeName[e]] : '';
      const pieces = g.edgeShape[e + 1] - g.edgeShape[e] + 1;
      for (let k = 0; k < pieces; k++) this.segRoad.push(name);
    }

    // where each step sits along the route (steps are at route vertices, in order)
    let from = 0;
    this.stepAlong = steps.map((s, i) => {
      if (i === 0) return 0;
      if (s.type === 'arrive' || s.lat == null) return this.total;
      const sx = s.lon * this.kx;
      const sy = s.lat * M_PER_DEG;
      let best = from;
      let bestD = Infinity;
      for (let j = from; j < n; j++) {
        const d = Math.hypot(this.x[j] - sx, this.y[j] - sy);
        if (d < bestD) {
          bestD = d;
          best = j;
          if (d < 0.5) break;
        }
      }
      from = best;
      return this.cum[best];
    });
  }

  toXY(lat, lon) {
    return [lon * this.kx, lat * M_PER_DEG];
  }

  /** Nearest point on the route to (x, y), looking near segment `hint` first. */
  project(x, y, hint = 0) {
    const n = this.x.length;
    const scan = (a, b) => {
      let best = null;
      for (let i = Math.max(0, a); i < Math.min(n - 1, b); i++) {
        const x1 = this.x[i], y1 = this.y[i];
        const dx = this.x[i + 1] - x1, dy = this.y[i + 1] - y1;
        const len2 = dx * dx + dy * dy;
        const t = len2 ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len2)) : 0;
        const px = x1 + t * dx, py = y1 + t * dy;
        const d = Math.hypot(x - px, y - py);
        if (!best || d < best.d - 0.01) best = { i, t, d, px, py };
      }
      return best;
    };
    let p = scan(hint - 4, hint + 120);
    if (!p || p.d > 50) {
      const all = scan(0, n);
      if (all && (!p || all.d < p.d)) p = all;
    }
    if (!p) return { i: 0, d: Infinity, along: 0, lat: this.coords[0][1], lon: this.coords[0][0] };
    const segLen = this.cum[p.i + 1] - this.cum[p.i];
    p.along = this.cum[p.i] + p.t * segLen;
    p.lon = p.px / this.kx;
    p.lat = p.py / M_PER_DEG;
    p.bearing = (Math.atan2(this.x[p.i + 1] - this.x[p.i], this.y[p.i + 1] - this.y[p.i]) / RAD + 360) % 360;
    return p;
  }

  /** Position and heading at a distance along the route. */
  pointAt(along) {
    const { cum } = this;
    const n = cum.length;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= along) lo = mid;
      else hi = mid;
    }
    const i = Math.min(lo, n - 2);
    const len = cum[i + 1] - cum[i];
    const t = len ? Math.max(0, Math.min(1, (along - cum[i]) / len)) : 0;
    const x = this.x[i] + (this.x[i + 1] - this.x[i]) * t;
    const y = this.y[i] + (this.y[i + 1] - this.y[i]) * t;
    const bearing = (Math.atan2(this.x[i + 1] - this.x[i], this.y[i + 1] - this.y[i]) / RAD + 360) % 360;
    return { lat: y / M_PER_DEG, lon: x / this.kx, bearing, i };
  }

  /** Route coordinates from distance `along` to the end, for the remaining-route line. */
  remaining(along) {
    const p = this.pointAt(along);
    return [[p.lon, p.lat], ...this.coords.slice(p.i + 1)];
  }
}

/* ------------------------------------------------------------------ helpers */
function spokenDistance(m) {
  if (m >= 950) return `${(Math.round(m / 100) / 10).toString()} kilometres`;
  return `${Math.max(10, Math.round(m / (m > 300 ? 50 : 10)) * (m > 300 ? 50 : 10))} metres`;
}
const angleLerp = (a, b, t) => a + ((((b - a) % 360) + 540) % 360 - 180) * t;
const clock = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/* ------------------------------------------------------------------ simulated GPS */
/** Drives along the route at a steady speed and reports a position every second (demo / testing). */
export class SimulatedGps {
  constructor(coords, mode) {
    this.coords = coords;
    this.speed = mode === 'foot' ? 1.4 : 11; // m/s (about 40 km/h when driving)
    this.dist = 0;
    this.offset = 0; // metres to the side, for testing rerouting
  }
  start(onFix) {
    const c = this.coords;
    const kx = Math.cos(c[0][1] * RAD) * M_PER_DEG;
    const seg = [];
    let total = 0;
    for (let i = 1; i < c.length; i++) {
      const len = Math.hypot((c[i][0] - c[i - 1][0]) * kx, (c[i][1] - c[i - 1][1]) * M_PER_DEG);
      seg.push(len);
      total += len;
    }
    const tick = () => {
      this.dist = Math.min(total, this.dist + this.speed);
      let d = this.dist;
      let i = 0;
      while (i < seg.length - 1 && d > seg[i]) d -= seg[i++];
      const t = seg[i] ? d / seg[i] : 0;
      const [x1, y1] = c[i];
      const [x2, y2] = c[i + 1] ?? c[i];
      const heading = (Math.atan2((x2 - x1) * kx, (y2 - y1) * M_PER_DEG) / RAD + 360) % 360;
      let lon = x1 + (x2 - x1) * t;
      let lat = y1 + (y2 - y1) * t;
      if (this.offset) {
        lon += (Math.cos(heading * RAD) * this.offset) / kx;
        lat -= (Math.sin(heading * RAD) * this.offset) / M_PER_DEG;
      }
      onFix({ lat, lon, speed: this.dist >= total ? 0 : this.speed, heading, accuracy: 5, t: Date.now() });
    };
    tick();
    this.timer = setInterval(tick, 1000);
  }
  stop() {
    clearInterval(this.timer);
  }
}

/** Real GPS through the Geolocation API. */
class RealGps {
  start(onFix, onError) {
    this.id = navigator.geolocation.watchPosition(
      (p) => onFix({ lat: p.coords.latitude, lon: p.coords.longitude, speed: p.coords.speed, heading: p.coords.heading, accuracy: p.coords.accuracy, t: p.timestamp }),
      (e) => onError(e),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 },
    );
  }
  stop() {
    navigator.geolocation.clearWatch(this.id);
  }
}

/* ------------------------------------------------------------------ navigator */
export class Navigator {
  /**
   * @param opts.map, opts.maplibregl, opts.graph, opts.dir ({result, steps, mode, to}), opts.slug
   * @param opts.reroute (lat, lon) => {result, steps} | null
   * @param opts.onExit (reason) => void   reason: 'user' | 'arrived' | 'gps-error'
   * @param opts.simulate  use a simulated drive instead of GPS
   * @param opts.recordTrips  time each road piece (opt-in), passed to opts.onTrip([[edge, seconds]]) at the end
   */
  constructor(opts) {
    Object.assign(this, opts);
    this.muted = safeGet('navMuted') === '1';
    const r = travelRange(1, this.dir.mode, this.slug);
    this.trafficFactor = (r.min + r.max) / 2;
    this.following = true;
    this.overview = false;
    this.setRoute(this.dir.result, this.dir.steps);
  }

  setRoute(result, steps) {
    this.dir.result = result;
    this.dir.steps = steps;
    this.track = new Track(this.graph, result, steps);
    // opt-in travel times: keep what the previous route recorded, then time the new one
    if (this.recorder) (this.tripSamples ??= []).push(...this.recorder.samples);
    this.recorder = this.recordTrips ? new TripRecorder(this.graph, result, this.track) : null;
    this.secPerM = result.meters ? result.seconds / result.meters : 0.1;
    this.hint = 0;
    this.stepIdx = 1;
    this.spoken = new Set();
    this.offCount = 0;
    this.shownAlong = null;
    this.proj = this.track.project(...this.track.toXY(this.track.coords[0][1], this.track.coords[0][0]), 0);
  }

  /* ---------- lifecycle */
  start(firstSpeech) {
    const { map } = this;
    document.body.classList.add('navigating');
    this.buildUi();
    const el = document.createElement('div');
    el.className = 'nav-puck';
    el.innerHTML = `<div class="me-halo"></div>${CONE_SVG}`;
    this.puck = new this.maplibregl.Marker({ element: el, rotationAlignment: 'map', pitchAlignment: 'map' });
    const pill = document.createElement('div');
    pill.className = 'nav-roadpill';
    pill.hidden = true;
    this.pill = new this.maplibregl.Marker({ element: pill, anchor: 'top', offset: [0, 30] });
    this.pillEl = pill;

    const c0 = this.track.coords[0];
    this.pos = { lon: c0[0], lat: c0[1], bearing: this.proj.bearing };
    this.anim = { from: { ...this.pos }, to: { ...this.pos }, t0: performance.now(), dur: 1 };
    this.zoom = this.dir.mode === 'foot' ? 18 : 17.3;
    this.puck.setLngLat([c0[0], c0[1]]).setRotation(this.pos.bearing).addTo(map);
    this.pill.setLngLat([c0[0], c0[1]]).addTo(map);

    this.onUserMove = (e) => {
      if (e.originalEvent && this.following) this.setFollowing(false);
    };
    map.on('dragstart', this.onUserMove);
    map.on('rotatestart', this.onUserMove);
    map.on('pitchstart', this.onUserMove);
    map.on('zoomstart', this.onUserMove);

    // phone compass: faces the map the way you're facing when walking or stopped
    this.compassHeading = this.compass?.heading ?? null;
    this.offCompass = this.compass?.on((h) => (this.compassHeading = h));

    this.updateRouteLine();
    this.updateUi();
    this.loop();
    this.keepAwake();
    if (firstSpeech) this.say(firstSpeech);

    this.gps = this.simulate ? new SimulatedGps(this.track.coords, this.dir.mode) : new RealGps();
    this.gps.start(
      (f) => this.onFix(f),
      (e) => {
        if (e.code === 1) return this.exit('gps-error', e);
        this.ui.lead.textContent = 'Searching for GPS signal…';
      },
    );
  }

  exit(reason = 'user', err) {
    if (this.stopped) return;
    this.stopped = true;
    const { map } = this;
    this.gps?.stop();
    this.offCompass?.();
    cancelAnimationFrame(this.raf);
    map.off('dragstart', this.onUserMove);
    map.off('rotatestart', this.onUserMove);
    map.off('pitchstart', this.onUserMove);
    map.off('zoomstart', this.onUserMove);
    this.puck?.remove();
    this.pill?.remove();
    this.root?.remove();
    document.body.classList.remove('navigating');
    document.removeEventListener('visibilitychange', this.onVisible);
    this.wakeLock?.release().catch(() => {});
    if (reason !== 'arrived' && 'speechSynthesis' in window) speechSynthesis.cancel();
    map.easeTo({ pitch: 0, bearing: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 600 });
    const trip = [...(this.tripSamples ?? []), ...(this.recorder?.samples ?? [])];
    if (trip.length) this.onTrip?.(trip);
    this.onExit?.(reason, err, this.pos);
  }

  async keepAwake() {
    if (!('wakeLock' in navigator)) return;
    const get = async () => {
      try {
        this.wakeLock = await navigator.wakeLock.request('screen');
      } catch {
        /* not allowed (battery saver, hidden tab) */
      }
    };
    this.onVisible = () => document.visibilityState === 'visible' && !this.stopped && get();
    document.addEventListener('visibilitychange', this.onVisible);
    get();
  }

  /* ---------- GPS fixes */
  onFix(f) {
    if (this.stopped) return;
    const tr = this.track;
    const [x, y] = tr.toXY(f.lat, f.lon);
    const p = tr.project(x, y, this.hint);
    const limit = (this.dir.mode === 'foot' ? 25 : 35) + Math.min(f.accuracy || 0, 40) / 2;
    this.offCount = p.d > limit ? this.offCount + 1 : 0;
    this.lastFix = f;

    if (this.offCount >= 3 && (!this.lastReroute || f.t - this.lastReroute > 5000)) {
      this.lastReroute = f.t;
      const next = this.reroute(f.lat, f.lon, this.travelHeading(f));
      if (next) {
        this.setRoute(next.result, next.steps);
        this.say('Rerouting');
        this.ui.lead.textContent = 'Rerouting…';
        return this.onFix(f);
      }
    }

    const onRoute = p.d <= limit;
    if (onRoute) {
      this.hint = p.i;
      this.proj = p;
      this.recorder?.update(p.along, f.t || Date.now());
    }
    const lat = onRoute ? p.lat : f.lat;
    const lon = onRoute ? p.lon : f.lon;

    // which way we're facing: the road when on the route, else the GPS heading / movement
    let bearing = this.pos.bearing;
    const moving = f.speed == null || f.speed > 0.8;
    if (onRoute && moving) bearing = p.bearing;
    else if (f.heading != null && !Number.isNaN(f.heading) && f.speed > 1) bearing = f.heading;
    else if (this.prevFix) {
      const dx = (f.lon - this.prevFix.lon) * tr.kx;
      const dy = (f.lat - this.prevFix.lat) * M_PER_DEG;
      if (Math.hypot(dx, dy) > 4) bearing = (Math.atan2(dx, dy) / RAD + 360) % 360;
    }
    this.prevFix = f;

    const now = performance.now();
    const gap = this.lastFixAt ? now - this.lastFixAt : 1000;
    this.lastFixAt = now;
    const dur = Math.max(300, Math.min(1500, gap));
    // on the route, glide along the road (round corners, not across them); otherwise straight
    const alongAnim = onRoute && this.shownAlong != null && p.along >= this.shownAlong - 5;
    this.anim = alongAnim
      ? { fromAlong: this.shownAlong, toAlong: p.along, t0: now, dur }
      : { from: { ...this.pos }, to: { lat, lon, bearing }, t0: now, dur };
    if (!onRoute) this.shownAlong = null;
    else if (!alongAnim) this.shownAlong = p.along;

    if (f.speed != null) {
      const kmh = f.speed * 3.6;
      this.zoomTarget = this.dir.mode === 'foot' ? 18 : kmh < 20 ? 17.5 : kmh < 55 ? 17 : 16;
    }
    this.speed = f.speed;

    // advance past maneuvers we've reached
    const along = this.proj.along;
    while (this.stepIdx < this.dir.steps.length - 1 && tr.stepAlong[this.stepIdx] - along < 8) this.stepIdx++;

    this.updateRouteLine();
    this.updateUi();
    this.voice();

    const left = tr.total - along;
    if (onRoute && left < (this.dir.mode === 'foot' ? 12 : 25)) {
      this.say(`You have arrived at ${this.dir.to.n}`);
      this.exit('arrived');
    }
  }

  /** Which way we're moving (degrees), from the GPS or from the last fixes; null if unknown. */
  travelHeading(f) {
    if (f.heading != null && !Number.isNaN(f.heading) && f.speed > 1) return f.heading;
    const p = this.prevFix;
    if (p) {
      const dx = (f.lon - p.lon) * this.track.kx;
      const dy = (f.lat - p.lat) * M_PER_DEG;
      if (Math.hypot(dx, dy) > 4) return (Math.atan2(dx, dy) / RAD + 360) % 360;
    }
    return this.dir.mode === 'foot' ? null : this.pos?.bearing ?? null;
  }

  /* ---------- voice */
  say(text) {
    if (this.muted || !('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-NG';
    speechSynthesis.speak(u);
  }

  voice() {
    const s = this.dir.steps[this.stepIdx];
    if (!s) return;
    const dist = this.track.stepAlong[this.stepIdx] - this.proj.along;
    const legLen = this.track.stepAlong[this.stepIdx] - (this.track.stepAlong[this.stepIdx - 1] ?? 0);
    const foot = this.dir.mode === 'foot';
    const stages = foot ? [['near', 60], ['now', 12]] : [['far', 550], ['near', 180], ['now', 35]];
    let stage = null;
    for (const [name, at] of stages) if (dist <= at) stage = [name, at];
    if (!stage) {
      // just finished a turn and the next one is a long way off
      if (!this.spoken.has(`${this.stepIdx}:cont`) && dist > (foot ? 300 : 1500) && this.stepIdx > 1) {
        this.spoken.add(`${this.stepIdx}:cont`);
        const road = this.track.segRoad[this.proj.i];
        this.say(`Continue${road ? ` on ${road}` : ''} for ${spokenDistance(dist)}`);
      }
      return;
    }
    const key = `${this.stepIdx}:${stage[0]}`;
    if (this.spoken.has(key)) return;
    // mark the earlier stages as done too, so a late fix doesn't read them all out
    for (const [name, at] of stages) if (at >= stage[1]) this.spoken.add(`${this.stepIdx}:${name}`);
    if (stage[0] === 'far' && legLen < 700) return; // the previous turn was just before this one
    const text = s.type === 'arrive' ? `${this.dir.to.n} is ahead` : s.text;
    this.say(stage[0] === 'now' ? text : `In ${spokenDistance(dist)}, ${text}`);
  }

  /* ---------- map */
  loop() {
    const frame = () => {
      if (this.stopped) return;
      const a = this.anim;
      const t = Math.min(1, (performance.now() - a.t0) / a.dur);
      let pos;
      if (a.fromAlong != null) {
        this.shownAlong = a.fromAlong + (a.toAlong - a.fromAlong) * t;
        const pt = this.track.pointAt(this.shownAlong);
        const target = this.speed == null || this.speed > 0.8 ? pt.bearing : this.pos.bearing;
        pos = { lat: pt.lat, lon: pt.lon, bearing: (angleLerp(this.pos.bearing, target, 0.1) + 360) % 360 };
      } else {
        pos = {
          lat: a.from.lat + (a.to.lat - a.from.lat) * t,
          lon: a.from.lon + (a.to.lon - a.from.lon) * t,
          bearing: (angleLerp(a.from.bearing, a.to.bearing, Math.min(1, t * 1.5)) + 360) % 360,
        };
      }
      if (this.useCompass()) pos.bearing = (angleLerp(this.pos.bearing, this.compassHeading, 0.15) + 360) % 360;
      this.pos = pos;
      this.puck.setLngLat([pos.lon, pos.lat]).setRotation(pos.bearing);
      this.pill.setLngLat([pos.lon, pos.lat]);
      const now = performance.now();
      if (!this.lineAt || now - this.lineAt > 250) {
        this.lineAt = now;
        this.updateRouteLine();
      }
      if (this.following) {
        if (this.zoomTarget) this.zoom += (this.zoomTarget - this.zoom) * 0.03;
        this.map.jumpTo({ center: [pos.lon, pos.lat], bearing: pos.bearing, zoom: this.zoom, pitch: 55, padding: this.padding() });
      }
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  /** Walking, or standing still in a car: GPS can't tell which way you face, the compass can. */
  useCompass() {
    if (this.compassHeading == null) return false;
    return this.dir.mode === 'foot' || this.speed == null || this.speed < 1.5;
  }

  padding() {
    const h = this.map.getContainer().clientHeight;
    return { top: Math.round(h * 0.42), bottom: 90, left: 0, right: 0 };
  }

  setFollowing(on) {
    this.following = on;
    this.overview = false;
    this.ui.recenter.hidden = on;
    this.ui.overview.setAttribute('aria-pressed', 'false');
  }

  showOverview() {
    const { map } = this;
    this.following = false;
    this.overview = true;
    this.ui.recenter.hidden = false;
    this.ui.overview.setAttribute('aria-pressed', 'true');
    const b = new this.maplibregl.LngLatBounds();
    this.track.remaining(this.shownAlong ?? this.proj.along).forEach((c) => b.extend(c));
    b.extend([this.pos.lon, this.pos.lat]);
    map.fitBounds(b, { padding: { top: this.ui.banner.offsetHeight + 40, bottom: 120, left: 50, right: 50 }, pitch: 0, bearing: 0, duration: 700 });
  }

  updateRouteLine() {
    const src = this.map.getSource('route');
    src?.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: this.track.remaining(this.shownAlong ?? this.proj.along) } });
    this.map.getSource('route-links')?.setData({ type: 'FeatureCollection', features: [] });
  }

  /* ---------- screen */
  buildUi() {
    const root = document.createElement('div');
    root.className = 'nav-ui';
    root.innerHTML = `
      <div class="nav-banner">
        <div class="nav-top">In <span class="nav-dist"></span></div>
        <div class="nav-main">
          <span class="nav-arrow"></span>
          <div class="nav-text"><div class="nav-road"></div><div class="nav-lead"></div></div>
        </div>
      </div>
      <div class="nav-then" hidden>Then <span class="nav-then-arrow"></span></div>
      <div class="nav-side">
        <button class="nav-round" data-nav="mute" aria-label="Mute voice"></button>
      </div>
      <button class="nav-recenter" data-nav="recenter" hidden>${turnSvg('straight')} Re-centre</button>
      <div class="nav-speed"><b>--</b><span>km/h</span></div>
      <div class="nav-steps" hidden></div>
      <div class="nav-bottom">
        <button class="nav-round" data-nav="exit" aria-label="End navigation"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
        <button class="nav-eta" data-nav="steps"><div class="nav-min"></div><div class="nav-sub"></div></button>
        <button class="nav-round" data-nav="overview" aria-label="Route overview" aria-pressed="false"><svg viewBox="0 0 24 24"><path d="M5 19c3-1 4-4 4-7s2-6 6-7M15 5h4v4M19 5l-5 5"/><circle cx="5" cy="19" r="1.5"/></svg></button>
      </div>`;
    document.body.appendChild(root);
    this.root = root;
    const q = (s) => root.querySelector(s);
    this.ui = {
      banner: q('.nav-banner'), arrow: q('.nav-arrow'), dist: q('.nav-dist'), road: q('.nav-road'), lead: q('.nav-lead'),
      then: q('.nav-then'), thenArrow: q('.nav-then-arrow'), mute: q('[data-nav=mute]'), recenter: q('.nav-recenter'),
      speed: q('.nav-speed b'), min: q('.nav-min'), sub: q('.nav-sub'), steps: q('.nav-steps'), overview: q('[data-nav=overview]'),
    };
    this.renderMute();
    root.addEventListener('click', (e) => {
      const act = e.target.closest('[data-nav]')?.dataset.nav;
      if (act === 'exit') this.exit('user');
      else if (act === 'recenter') this.setFollowing(true);
      else if (act === 'overview') (this.overview ? this.setFollowing(true) : this.showOverview());
      else if (act === 'mute') {
        this.muted = !this.muted;
        safeSet('navMuted', this.muted ? '1' : '0');
        if (this.muted && 'speechSynthesis' in window) speechSynthesis.cancel();
        this.renderMute();
      } else if (act === 'steps') this.toggleSteps();
    });
  }

  renderMute() {
    this.ui.mute.innerHTML = this.muted
      ? '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9zM16 9l6 6M22 9l-6 6"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/></svg>';
    this.ui.mute.setAttribute('aria-label', this.muted ? 'Unmute voice' : 'Mute voice');
  }

  toggleSteps() {
    const el = this.ui.steps;
    if (!el.hidden) return (el.hidden = true);
    const steps = this.dir.steps;
    el.innerHTML = `<ul>${steps
      .slice(this.stepIdx)
      .map((s, k) => {
        const i = this.stepIdx + k;
        const d = this.track.stepAlong[i] - this.proj.along;
        return `<li>${turnSvg(arrowType(s.type), 'nav-li-arrow')}<span><div>${esc(s.type === 'arrive' ? `Arrive at ${this.dir.to.n}` : s.text)}</div><div class="d">${formatDistance(Math.max(0, d))}</div></span></li>`;
      })
      .join('')}</ul>`;
    el.hidden = false;
  }

  updateUi() {
    const { ui, track } = this;
    const steps = this.dir.steps;
    const s = steps[this.stepIdx];
    const along = this.proj.along;
    const dist = Math.max(0, track.stepAlong[this.stepIdx] - along);
    ui.arrow.innerHTML = turnSvg(arrowType(s.type));
    ui.dist.textContent = formatDistance(dist);
    if (s.type === 'arrive') {
      ui.road.textContent = this.dir.to.n;
      ui.lead.textContent = 'Destination';
    } else {
      const lead = s.lead ?? s.text.replace(/ onto .*$/, '');
      ui.road.textContent = s.road || lead;
      ui.lead.textContent = s.road ? lead : '';
    }
    const after = steps[this.stepIdx + 1];
    const showThen = after && track.stepAlong[this.stepIdx + 1] - track.stepAlong[this.stepIdx] < 300;
    this.root.style.setProperty('--banner-h', `${ui.banner.offsetHeight}px`);
    ui.then.hidden = !showThen;
    if (showThen) ui.thenArrow.innerHTML = turnSvg(arrowType(after.type));
    this.root.style.setProperty('--then-h', showThen ? `${ui.then.offsetHeight + 8}px` : '0px');

    ui.speed.textContent = this.speed != null ? Math.round(this.speed * 3.6) : '--';
    const left = Math.max(0, track.total - along);
    const secs = left * this.secPerM * this.trafficFactor;
    ui.min.textContent = formatDuration(secs);
    ui.sub.textContent = `${formatDistance(left)} · ${clock(new Date(Date.now() + secs * 1000))}`;

    const road = track.segRoad[this.proj.i];
    this.pillEl.textContent = road;
    this.pillEl.hidden = !road;
    if (!ui.steps.hidden) {
      ui.steps.hidden = true;
      this.toggleSteps();
    }
  }
}

function safeGet(k) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function safeSet(k, v) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}
