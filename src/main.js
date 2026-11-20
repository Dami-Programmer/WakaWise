import 'maplibre-gl/dist/maplibre-gl.css';
import './app.css';
import * as maplibregl from 'maplibre-gl';
import mapWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { Protocol, PMTiles } from 'pmtiles';
import { layers, namedFlavor } from '@protomaps/basemaps';
import { loadStates, stateAt, getPosition } from './lib/states.js';
import { Search, km } from './lib/search.js';
import { encode } from './lib/pluscode.js';
import { travelRange, formatRange, formatDistance, formatDuration } from './lib/traffic.js';
import { loadUserPlaces, saveUserPlace } from './lib/userPlaces.js';
import { loadGraph } from './routing/graph.js';
import { route as findRoute, alternatives, routeCoords } from './routing/astar.js';
import { Snapper } from './routing/snap.js';
import { send, flush as flushOutbox } from './lib/outbox.js';
import { tripsAllowed, bucket as tripBucket } from './lib/trips.js';
import { Landmarks, buildSteps } from './routing/instructions.js';
import { Navigator, CONE_SVG, turnSvg } from './nav/navigation.js';
import { compass } from './lib/compass.js';
import { recentPlaces, addRecent, clearRecent, savedPlaces, setSaved } from './lib/places.js';
import { listPacks, loadFiles, downloadPack, applyUpdate, progressOf, removePack, keepStorage, freeSpace } from './lib/packs.js';

// The built app must point MapLibre at its worker file (the dev server finds it by itself).
if (import.meta.env.PROD) maplibregl.setWorkerUrl(mapWorkerUrl);
const protocol = new Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Theme: dark by default; Settings can switch to light or follow the phone.
const themeQuery = matchMedia('(prefers-color-scheme: dark)');
let dark = true;
function applyTheme() {
  const pref = safeGet('theme') || 'dark';
  dark = pref === 'auto' ? themeQuery.matches : pref === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark ? '#0f1012' : '#eef0f2');
}
applyTheme();
themeQuery.addEventListener?.('change', () => {
  if ((safeGet('theme') || 'dark') === 'auto') restyle();
});
/** Redraw the map in the current theme (overlays are re-added on style.load). */
function restyle() {
  applyTheme();
  map.setStyle(baseStyle(app.tilesUrl));
}
const BASE = import.meta.env.BASE_URL;
const NIGERIA = [[2.6, 4.2], [14.7, 13.9]];
const indexedUserPlaces = new Set(); // user-added places already in the search index
// first-visit welcome text: keep it the same as the copy in index.html
const WELCOME = `<h2>Welcome to WakaWise</h2><p class="sub welcome-sub">Maps, search, directions and voice navigation for Nigeria that keep working with no data. Allow location so we can get the map for the state you're in, or choose your state yourself.</p><div class="row"><button class="btn" data-act="pick">Choose state instead</button></div>`;
// creator badge, shown on the welcome sheet and in Settings
const MADE_BY = '<a class="made-by" href="https://davey-portfolio.netlify.app/" target="_blank" rel="noopener"><img class="made-by-mark" src="/made-by.png" alt="" width="24" height="24">Made by <b>Newtz</b></a>';
const ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors · Places © <a href="https://overturemaps.org" target="_blank">Overture Maps</a>';

const app = {
  states: [], state: null, graph: null, docs: null, search: null, snapper: null, landmarks: null,
  me: null, meMarker: null, placeMarker: null, startMarker: null, userMarkers: [],
  dir: null, // {from, to, mode, result, steps}
  pickingStart: false, nav: null, routeChips: [], locMode: 'off', watch: null,
};

const map = new maplibregl.Map({
  container: 'map',
  style: baseStyle(null),
  bounds: NIGERIA,
  attributionControl: false,
});
// OSM/Overture credit: always on screen, just above the "Where to?" bar
map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: ATTRIBUTION }), 'bottom-left');

/* zoom and north buttons (our own, styled like the rest of the controls) */
$('zoom-in').addEventListener('click', () => map.zoomIn());
$('zoom-out').addEventListener('click', () => map.zoomOut());
$('north').addEventListener('click', () => {
  if (app.locMode === 'compass') setLocMode('follow');
  map.easeTo({ bearing: 0, pitch: 0, duration: 400 });
});
function updateNorth() {
  const b = map.getBearing();
  const btn = $('north');
  btn.hidden = Math.abs(b) < 0.5 && map.getPitch() < 1;
  btn.querySelector('svg').style.transform = `rotate(${-b}deg)`;
}
map.on('rotate', updateNorth);
map.on('pitch', updateNorth);

/* ------------------------------------------------------------------ map style */
// Fonts and icons are served by this site (public/fonts, public/sprites) so labels draw offline.
function baseStyle(tilesUrl) {
  const flavor = dark ? 'dark' : 'light';
  const assets = location.origin + BASE;
  const style = {
    version: 8,
    glyphs: `${assets}fonts/{fontstack}/{range}.pbf`,
    sprite: `${assets}sprites/v4/${flavor}`,
    sources: {},
    layers: [{ id: 'bg', type: 'background', paint: { 'background-color': dark ? '#0f1012' : '#e9eef2' } }],
  };
  if (tilesUrl) {
    // Foursquare places (Apache 2.0) are credited when the state's search data includes them
    const fsq = app.docs?.some((d) => d.s === 'f') ? ' · <a href="https://opensource.foursquare.com/os-places/" target="_blank">Foursquare</a>' : '';
    style.sources.protomaps = { type: 'vector', url: tilesUrl, attribution: ATTRIBUTION + fsq };
    style.layers = layers('protomaps', namedFlavor(flavor), { lang: 'en' });
  }
  return style;
}

map.on('style.load', addOverlays);
if (map.isStyleLoaded()) addOverlays(); // an inline style can finish loading before the listener is attached
if (import.meta.env.DEV) {
  window.__map = map;
  window.__app = app;
}
function addOverlays() {
  if (map.getSource('route')) return; // already added for this style
  if (!map.getSource('states')) {
    map.addSource('states', { type: 'geojson', data: '/states.geojson', generateId: true });
    map.addLayer({ id: 'states-line', type: 'line', source: 'states', paint: { 'line-color': dark ? '#8ab4f8' : '#5f6368', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.8, 10, 2], 'line-dasharray': [3, 2], 'line-opacity': 0.7 } });
    if (!app.state) {
      map.addLayer({ id: 'states-fill', type: 'fill', source: 'states', paint: { 'fill-color': '#1a73e8', 'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.25, 0.08] } }, 'states-line');
    }
  }
  const empty = { type: 'FeatureCollection', features: [] };
  map.addSource('route', { type: 'geojson', data: empty, lineMetrics: true }); // lineMetrics: needed for the colour fade
  map.addSource('route-links', { type: 'geojson', data: empty });
  map.addSource('route-alt', { type: 'geojson', data: empty });
  map.addLayer({ id: 'route-alt-casing', type: 'line', source: 'route-alt', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': dark ? '#2a2c30' : '#8d9298', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 7, 16, 14] } });
  map.addLayer({ id: 'route-alt', type: 'line', source: 'route-alt', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': dark ? '#5d6269' : '#bcc1c6', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 4, 16, 9] } });
  map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': dark ? '#0b3d1c' : '#0d6b2c', 'line-opacity': 0.9, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 8, 16, 16] } });
  map.addLayer({ id: 'route-line', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' },
    // yellow-green where you are, fading to green at the destination
    paint: { 'line-gradient': ['interpolate', ['linear'], ['line-progress'], 0, '#dfe83a', 0.35, '#86d443', 1, '#1fae4b'], 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 5, 16, 11] } });
  map.addLayer({ id: 'route-links', type: 'line', source: 'route-links', paint: { 'line-color': '#5f6368', 'line-width': 2, 'line-dasharray': [1, 2] } });
  map.addSource('me-accuracy', { type: 'geojson', data: empty });
  map.addLayer({ id: 'me-accuracy-fill', type: 'fill', source: 'me-accuracy', paint: { 'fill-color': '#2fbf5b', 'fill-opacity': 0.12 } });
  map.addLayer({ id: 'me-accuracy-line', type: 'line', source: 'me-accuracy', paint: { 'line-color': '#2fbf5b', 'line-opacity': 0.45, 'line-width': 1 } });
  if (app.dir?.result) drawRoute();
  drawMe();
}

/* ------------------------------------------------------------------ sheet + toast */
const sheet = $('sheet');
function openSheet(html, { search = false } = {}) {
  setSearchMode(search);
  $('sheet-body').innerHTML = html;
  sheet.hidden = false;
  sheet.scrollTop = 0;
  document.body.classList.add('sheet-open');
  requestAnimationFrame(() => document.body.style.setProperty('--sheet-h', `${sheet.offsetHeight}px`));
}
function closeSheet() {
  setSearchMode(false);
  sheet.hidden = true;
  document.body.classList.remove('sheet-open');
}
let toastTimer;
function toast(msg, ms = 3500) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

/* ------------------------------------------------------------------ states */
// Saved states open straight from the device; downloads only happen when a state isn't saved yet,
// when an interrupted download can carry on, or (in the background) when a newer map is out.
const DATA = `${BASE}data/states/`;
const REFRESH_DAYS = 14;
let installPrompt = null;
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
});

let statesLoaded;
const statesReady = new Promise((r) => (statesLoaded = r));
async function init() {
  const [states, packs] = await Promise.all([loadStates(), listPacks()]);
  app.states = states;
  for (const s of states) {
    const p = packs[s.slug];
    s.saved = !!p?.active;
    s.info ??= p?.active?.info ?? p?.pending?.info; // offline: index.json may be unavailable
  }
  statesLoaded();
  const bySlug = (slug) => app.states.find((s) => s.slug === slug);
  const param = bySlug(new URLSearchParams(location.search).get('state'));
  const remembered = bySlug(safeGet('lastState'));
  app.pendingShare = sharedPlace();
  const shareState = app.pendingShare && stateAt(app.states, app.pendingShare.lon, app.pendingShare.lat);
  const saved = param || (shareState?.saved ? shareState : remembered?.saved ? remembered : app.states.find((s) => s.saved));

  if (app.pendingShare && !shareState) {
    toast('That shared place is outside Nigeria', 5000);
    app.pendingShare = null;
  }
  if (shareState && !shareState.saved && !param) {
    // someone shared a place in a state this phone doesn't have yet: offer that map
    if (saved) await openState(saved, { quiet: true });
    backgroundWork();
    offerState(shareState, false);
    toast(`The shared place is in ${shareState.name}. Download its map to see it.`, 7000);
    return;
  }

  if (saved) {
    // open the saved map at once, then look for the visitor in the background (GPS works offline)
    await openState(saved, { quiet: true });
    getPosition(10000).then((pos) => {
      if (pos.error) return;
      setMe(pos);
      const here = stateAt(app.states, pos.lon, pos.lat);
      if (here && here !== app.state && !here.saved) toast(`You're in ${here.name}. Tap ${app.state.name} at the top to get its map.`, 7000);
    });
    backgroundWork();
    return;
  }

  // First visit: the visitor's position decides which state's map they need.
  // index.html already shows this welcome on a first visit; keep that one (repainting it would delay the page's first-screen timing)
  if (!$('welcome') || sheet.hidden) openSheet(`<div id="welcome">${WELCOME}${MADE_BY}</div>`);
  else document.body.style.setProperty('--sheet-h', `${sheet.offsetHeight}px`);
  const pos = await getPosition(10000);
  const here = pos.error ? null : stateAt(app.states, pos.lon, pos.lat);
  if (!pos.error) setMe(pos);
  // an interrupted download of this state carries on by itself
  if (here?.info && !paused(here.slug) && (await progressOf(here.slug, here.info)) > 0) return downloadState(here.slug);
  backgroundWork();
  if (here) return offerState(here, true);
  if (pos.error) return openStatePicker('Which state are you in?', pos.message);
  openStatePicker("You seem to be outside Nigeria. Which state's map do you want?");
}

const mb = (b) => `${Math.max(1, Math.round(b / 1e6))} MB`;
const paused = (slug) => safeGet(`paused:${slug}`) === '1';
const setPaused = (slug, on) => (on ? safeSet(`paused:${slug}`, '1') : safeRemove(`paused:${slug}`));

async function sizeLine(s) {
  if (s.saved) return `Saved on this device · ${mb(s.info.bytes)}`;
  if (!s.info) return navigator.onLine ? 'Map not built yet' : "You're offline";
  const got = await progressOf(s.slug, s.info);
  return got ? `${mb(got)} of ${mb(s.info.bytes)} downloaded` : mb(s.info.bytes);
}

async function offerState(s, detected) {
  fitState(s);
  if (s.saved) {
    openSheet(`
      <h2>${esc(s.name)}</h2>
      <p class="sub">Saved on this device (${mb(s.info.bytes)}). Works with no data.</p>
      <div class="row">
        <button class="btn primary" data-act="open" data-slug="${s.slug}">Open map</button>
        <button class="btn" data-act="pick">Choose another state</button>
        ${app.state === s ? '' : `<button class="btn" data-act="remove" data-slug="${s.slug}">Remove from device</button>`}
      </div>`);
    return;
  }
  const got = s.info ? await progressOf(s.slug, s.info) : 0;
  const free = await freeSpace();
  const need = s.info ? s.info.bytes - got : 0;
  const lowSpace = free != null && need && free < need * 1.1;
  openSheet(`
    <h2>${esc(s.name)}</h2>
    <p class="sub">${detected ? "You're in this state. " : ''}Download its map once and use search, directions and navigation with no data.</p>
    ${s.info
      ? `<p class="sub">Download size: <b>${mb(s.info.bytes)}</b>${got ? ` (${mb(got)} already downloaded)` : ''}. Use Wi-Fi if you can.</p>`
      : `<p class="sub">${navigator.onLine ? "This state's map isn't ready yet. Please try again later." : "You're offline. Connect to the internet to download this map."}</p>`}
    ${lowSpace ? `<p class="note">Your phone may not have enough free space for this map (about ${mb(free)} free). Free up some space first.</p>` : ''}
    <div class="row">
      ${s.info ? `<button class="btn primary" data-act="download" data-slug="${s.slug}">${got ? 'Resume download' : 'Download map'}</button>` : ''}
      <button class="btn" data-act="pick">Choose another state</button>
    </div>`);
}

async function openStatePicker(title = 'Choose a state', note = '') {
  await statesReady; // the welcome's button can be tapped before the list of states has loaded
  const here = app.me ? stateAt(app.states, app.me.lon, app.me.lat) : null;
  const ordered = [...app.states].sort((a, b) => (b === here) - (a === here) || b.saved - a.saved);
  const lines = await Promise.all(ordered.map(sizeLine));
  const items = ordered
    .map((s, i) => `<li><button data-act="offer" data-slug="${s.slug}"><span class="pin-ico${s.saved ? ' ok' : ''}">${s.saved ? CAT.check : CAT.map}</span><span><div class="title">${esc(s.name)}${s === here ? '<span class="badge">you are here</span>' : ''}</div><div class="meta">${esc(lines[i])}</div></span></button></li>`)
    .join('');
  openSheet(`<h2>${esc(title)}</h2>${note ? `<p class="sub">${esc(note)}</p>` : ''}<ul class="list">${items}</ul>`);
}

function fitState(s) {
  const [w, so, e, n] = s.bbox;
  map.fitBounds([[w, so], [e, n]], { padding: 40, duration: 600 });
}

/** Open a state: from the device if saved, otherwise download it first. */
async function openState(s, opts = {}) {
  if (s.saved) {
    try {
      if (app.state !== s) await applyUpdate(s.slug); // a finished background update replaces the old map now
      return await useState(s, await loadFiles(s.slug), opts);
    } catch (err) {
      console.error(err);
      await removePack(s.slug).catch(() => {});
      s.saved = false;
      toast(`The saved ${s.name} map couldn't be opened, so it will be downloaded again.`, 6000);
    }
  }
  return downloadState(s.slug, opts);
}

let download = null; // {slug, controller} while a download is running in front of the user

async function downloadState(slug) {
  const s = app.states.find((x) => x.slug === slug);
  if (!s.info) return offerState(s, false);
  setPaused(slug, false);
  openSheet(`<h2>Getting the ${esc(s.name)} map…</h2><div class="progress"><div></div></div><p class="note" id="dl-note">Starting…</p>
    <div class="row"><button class="btn" data-act="pause-dl">Pause</button></div>`);
  const bar = sheet.querySelector('.progress').firstElementChild;
  const note = $('dl-note');
  download = { slug, controller: new AbortController() };
  try {
    await downloadPack(slug, s.info, `${DATA}${slug}/`, {
      signal: download.controller.signal,
      onProgress(got, total) {
        bar.style.width = `${Math.min(100, (got / total) * 100)}%`;
        note.textContent = `Downloading… ${(got / 1e6).toFixed(1)} of ${(total / 1e6).toFixed(0)} MB`;
      },
    });
    download = null;
    sheet.querySelector('[data-act="pause-dl"]')?.remove();
    note.textContent = 'Saving…';
    keepStorage();
    await applyUpdate(slug);
    s.saved = true;
    note.textContent = 'Preparing search…';
    let files;
    try {
      files = await loadFiles(slug);
    } catch (err) {
      console.error(err);
      await removePack(slug).catch(() => {}); // so "Try again" downloads a fresh copy
      s.saved = false;
      throw new Error("the map couldn't be saved on this device");
    }
    await useState(s, files, { downloaded: true });
    backgroundWork();
  } catch (err) {
    const wasPaused = err.name === 'AbortError';
    download = null;
    const got = await progressOf(slug, s.info);
    if (!sheet.contains(note)) return; // the user moved on
    if (wasPaused) {
      openSheet(`<h2>Download paused</h2><p class="sub">${mb(got)} of ${mb(s.info.bytes)} saved. It carries on from there when you resume.</p>
        <div class="row"><button class="btn primary" data-act="download" data-slug="${slug}">Resume</button><button class="btn" data-act="pick">Choose another state</button></div>`);
    } else {
      note.textContent = `${navigator.onLine ? `Download stopped: ${err.message}.` : 'You went offline.'} ${got ? `${mb(got)} is saved and the rest continues when you try again.` : ''}`;
      sheet.querySelector('.row').innerHTML = `<button class="btn primary" data-act="download" data-slug="${slug}">Try again</button><button class="btn" data-act="pick">Choose another state</button>`;
    }
  }
}

/** Load a saved state's files into the app: routing graph, search, and tiles straight from storage. */
async function useState(s, files, { quiet = false, downloaded = false } = {}) {
  const { build } = files;
  const text = async (f) => new TextDecoder().decode(await files.read(f));
  const searchText = await text('search.json');
  stopNavigation();
  $('state-chip').innerHTML = `<span class="dot"></span>${esc(s.name)} · Opening…`;
  await new Promise((r) => setTimeout(r, 20)); // let the label paint before the heavy work
  const meta = JSON.parse(await text('graph.json'));
  app.graph = loadGraph(meta, await files.read('graph.bin'));
  app.docs = JSON.parse(searchText);
  app.search?.close();
  app.search = new SearchClient(searchText); // the worker parses its own copy (cheaper than copying objects)
  indexedUserPlaces.clear();
  app.snapper = new Snapper(app.graph);
  app.landmarks = new Landmarks(app.docs);
  app.state = s;
  app.build = String(build);
  app.dir = null;
  app.userMarkers.forEach((m) => m.remove());
  app.userMarkers = [];
  for (const p of loadUserPlaces(s.slug)) addUserPlaceToMap(p);
  safeSet('lastState', s.slug);
  const key = `${s.slug}-${String(build).replace(/\W/g, '')}`;
  if (!protocol.get(key)) protocol.add(new PMTiles(files.source(key)));
  app.tilesUrl = `pmtiles://${key}`;
  map.setStyle(baseStyle(app.tilesUrl));
  renderChip();
  closeSheet();
  if (app.me && stateAt([s], app.me.lon, app.me.lat)) map.jumpTo({ center: [app.me.lon, app.me.lat], zoom: 15 });
  else fitState(s);
  if (showPendingShare()) {
    if (downloaded) toast(`${s.name} is ready to use offline`);
  } else if (downloaded) {
    toast(`${s.name} is ready to use offline`);
    if (!installTip() && app.me && stateAt([s], app.me.lon, app.me.lat)) showMe();
  } else if (!quiet) toast(`${s.name} opened`);
}

let bg = null; // {slug, pct} while a background download runs
function renderChip() {
  if (!app.state) return;
  const other = bg && bg.slug !== app.state.slug ? `${app.states.find((x) => x.slug === bg.slug).name.replace(/ State$/, '')} ` : '';
  const extra = bg ? ` · saving ${other}${bg.pct}%` : '';
  $('state-chip').innerHTML = `${CAT.check}<span>${esc(app.state.name.replace(/ State$/, ''))}</span><span class="chip-meta">Ready offline${extra}</span>`;
}

/**
 * Online housekeeping: carry on interrupted downloads and fetch newer maps every few weeks.
 * Runs one download at a time, quietly.
 */
let bgRunning = false;
async function backgroundWork() {
  if (bgRunning || !navigator.onLine) return;
  flushOutbox(); // reports made while offline
  bgRunning = true;
  try {
    const packs = await listPacks();
    for (const s of app.states) {
      const p = packs[s.slug];
      if (!p || !s.info || download?.slug === s.slug) continue;
      const build = s.info.built || String(s.info.bytes);
      const unfinished = p.pending && !p.pending.complete && p.pending.build === build && !paused(s.slug);
      const old = p.active && p.active.build !== build && !p.pending?.complete && Date.now() - p.active.savedAt > REFRESH_DAYS * 864e5;
      if (!unfinished && !old) continue;
      bg = { slug: s.slug, pct: 0 };
      try {
        await downloadPack(s.slug, s.info, `${DATA}${s.slug}/`, {
          onProgress(got, total) {
            const pct = Math.floor((got / total) * 100);
            if (pct !== bg.pct) {
              bg.pct = pct;
              renderChip();
            }
          },
        });
        keepStorage();
        if (app.state !== s) {
          await applyUpdate(s.slug);
          s.saved = true;
          toast(`${s.name} map ${p.active ? 'updated' : 'downloaded'}`);
        } else toast(`A newer ${s.name} map is saved. It opens next time you load the page.`, 6000);
      } catch (err) {
        console.warn('background download stopped', s.slug, err);
        break; // probably offline; try again later
      } finally {
        bg = null;
        renderChip();
      }
    }
  } finally {
    bgRunning = false;
  }
}
addEventListener('online', () => setTimeout(backgroundWork, 3000));

async function removeState(slug) {
  const s = app.states.find((x) => x.slug === slug);
  await removePack(slug);
  setPaused(slug, false);
  s.saved = false;
  toast(`${s.name} map removed from this device`);
  openStatePicker();
}

/** After the first download: suggest installing, which keeps storage safer (especially on iPhone). */
function installTip() {
  if (safeGet('installTip')) return false;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (standalone) return false;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (!ios && !installPrompt) return false;
  safeSet('installTip', '1');
  openSheet(ios
    ? `<h2>Keep WakaWise on your iPhone</h2><p class="sub">Tap <b>Share</b> <span aria-hidden="true">⎋</span> at the bottom of Safari, then <b>Add to Home Screen</b>. Open WakaWise from that icon. iPhones can clear saved data for websites that aren't on the Home Screen.</p><div class="row"><button class="btn primary" data-act="close">Got it</button></div>`
    : `<h2>Install WakaWise</h2><p class="sub">Add it to your home screen to open it like an app, even with no data.</p><div class="row"><button class="btn primary" data-act="install">Install</button><button class="btn" data-act="close">Not now</button></div>`);
  return true;
}

/* ------------------------------------------------------------------ search */
const input = $('search');
let searchTimer;
input.addEventListener('input', () => {
  $('clear').hidden = !input.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 120);
});
// Tapping "Where to?" moves the bar to the top and shows saved and recent places (or results).
input.addEventListener('focus', () => (input.value ? runSearch() : showHome()));
$('search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await runSearch();
  if (r?.length) showPlace(r[0]);
  input.blur();
});
$('clear').addEventListener('click', () => {
  input.value = '';
  $('clear').hidden = true;
  input.focus();
  showHome();
});
$('search-back').addEventListener('click', () => {
  if (!document.body.classList.contains('search-mode')) return input.focus();
  input.value = '';
  $('clear').hidden = true;
  app.savingAs = null;
  input.placeholder = 'Where to?';
  closeSheet();
  input.blur();
});

const SEARCH_ICON = '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>';
const BACK_ICON = '<path d="M19 12H5M11 6l-6 6 6 6"/>';
function setSearchMode(on) {
  document.body.classList.toggle('search-mode', on);
  $('search-back').querySelector('svg').innerHTML = on ? BACK_ICON : SEARCH_ICON;
  $('search-back').setAttribute('aria-label', on ? 'Back' : 'Search');
}

const ICONS = {
  home: '<svg class="i" viewBox="0 0 24 24"><path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/></svg>',
  work: '<svg class="i" viewBox="0 0 24 24"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 13h18"/></svg>',
  pin: '<svg class="i" viewBox="0 0 24 24"><path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z"/><circle cx="12" cy="10" r="2.2"/></svg>',
  car: '<svg class="i" viewBox="0 0 24 24" style="width:18px;height:18px"><path d="M5 17h14v-5l-2-5H7l-2 5z"/><path d="M5 12h14"/><circle cx="8" cy="17" r="1.6"/><circle cx="16" cy="17" r="1.6"/></svg>',
  walk: '<svg class="i" viewBox="0 0 24 24" style="width:18px;height:18px"><circle cx="13" cy="4.5" r="1.8"/><path d="M10 21l2-6 3 3v3M12 15l-1-5 4 2 2 3M11 10l-3 2-1 3"/></svg>',
  share: '<svg class="i" viewBox="0 0 24 24"><circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="m8.2 10.8 7.6-4.4M8.2 13.2l7.6 4.4"/></svg>',
  bike: '<svg class="i" viewBox="0 0 24 24" style="width:18px;height:18px"><circle cx="6" cy="17" r="3"/><circle cx="18" cy="17" r="3"/><path d="M6 17l4-7h5l3 7M10 10 8.5 6H6M15 10l1-3h2.5"/></svg>',
  turn: '<svg class="i" viewBox="0 0 24 24" style="width:18px;height:18px"><path d="M12 2.8 21.2 12 12 21.2 2.8 12z"/><path d="M9 14v-2.5a1.5 1.5 0 0 1 1.5-1.5H15M13 8l2 2-2 2"/></svg>',
  bookmark: '<svg class="i" viewBox="0 0 24 24"><path d="M6.5 3.5h11v17L12 16.5l-5.5 4z"/></svg>',
  plus: '<svg class="i" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  flag: '<svg class="i" viewBox="0 0 24 24"><path d="M5 21V4M5 4.5h11l-2 4 2 4H5"/></svg>',
  go: '<svg class="i" viewBox="0 0 24 24" style="width:20px;height:20px"><path d="M9 6l6 6-6 6"/></svg>',
};
const stateName = (slug) => app.states.find((x) => x.slug === slug)?.name ?? slug;

/** The "Where to?" panel: Home, Work, places you added, and places opened recently. */
function showHome() {
  const slug = app.state?.slug;
  const saved = savedPlaces();
  const card = (act, i, icon, title, meta) =>
    `<li><button data-act="${act}" data-i="${i}"><span class="pin-ico">${icon}</span><span><div class="title">${esc(title)}</div><div class="meta">${esc(meta)}</div></span><span class="go">${ICONS.go}</span></button></li>`;
  const savedCard = (kind, label) => {
    const p = saved[kind];
    const meta = !p ? `Set your ${label.toLowerCase()} address` : p.slug === slug ? p.n : `${p.n} · ${stateName(p.slug)}`;
    return card('saved', kind, ICONS[kind], label, meta);
  };
  const added = slug ? loadUserPlaces(slug) : [];
  const recent = slug ? recentPlaces(slug) : [];
  openSheet(
    `<div class="section-label">Saved places</div>
    <ul class="cards">${app.state ? card('share-me', 0, ICONS.share, 'Share my location', 'Send where you are on WhatsApp or SMS') : ''}${savedCard('home', 'Home')}${savedCard('work', 'Work')}${added
      .map((p, i) => card('added', i, ICONS.pin, p.n, cap(p.k) || 'Added by you'))
      .join('')}</ul>
    <div class="section-label">Recent places</div>
    ${recent.length
      ? `<ul class="cards">${recent.map((p, i) => card('recent', i, iconFor(p.k), p.n, [cap(p.k), p.a].filter(Boolean).join(' · ') || 'Place')).join('')}</ul>`
      : `<p class="sub">Places you open show up here.</p>`}
    ${app.state ? '' : '<div class="row"><button class="btn primary" data-act="pick">Choose a state map</button></div>'}`,
    { search: true },
  );
}

/** Home / Work buttons: open the place, or start choosing it. */
function openSaved(kind) {
  const p = savedPlaces()[kind];
  if (p && p.slug === app.state?.slug) return showPlace(p);
  if (p) {
    const s = app.states.find((x) => x.slug === p.slug);
    return s ? offerState(s, false) : null;
  }
  app.savingAs = kind;
  input.value = '';
  input.placeholder = `Search for your ${kind === 'home' ? 'home' : 'work'} address`;
  input.focus();
  toast(`Search for it, open it, then tap Save as ${kind === 'home' ? 'Home' : 'Work'}`, 5000);
}

function saveAs(kind) {
  setSaved(kind, app.current, app.state.slug);
  app.savingAs = null;
  input.placeholder = 'Where to?';
  toast(`Saved as ${kind === 'home' ? 'Home' : 'Work'}`);
  showPlace(app.current);
}

function center() {
  const c = map.getCenter();
  return { lat: c.lat, lon: c.lng };
}

/** Search running in a Web Worker; `query` returns a Promise. Falls back to the main thread if workers fail. */
class SearchClient {
  constructor(json) {
    const docs = () => JSON.parse(json);
    this.pending = new Map();
    this.seq = 0;
    try {
      this.worker = new Worker(new URL('./lib/searchWorker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = ({ data: m }) => {
        if (m.type !== 'result') return;
        this.pending.get(m.id)?.(m.results);
        this.pending.delete(m.id);
      };
      this.worker.onerror = () => this.fallback(docs());
      this.worker.postMessage({ type: 'build', json });
    } catch {
      this.fallback(docs());
    }
    this.added = [];
  }
  fallback(docs) {
    if (this.local) return;
    this.worker?.terminate();
    this.worker = null;
    this.local = new Search(docs);
    this.added.forEach((p) => this.local.addUserPlace(p));
    for (const [id, [q, c, done]] of this.waiting ?? []) done(this.local.query(q, c));
    this.pending.clear();
  }
  addUserPlace(p) {
    this.added.push(p);
    if (this.local) this.local.addUserPlace(p);
    else this.worker.postMessage({ type: 'add', place: p });
  }
  query(q, center) {
    if (this.local) return Promise.resolve(this.local.query(q, center));
    const id = ++this.seq;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      (this.waiting ??= new Map()).set(id, [q, center, resolve]);
      this.worker.postMessage({ type: 'query', id, q, center: { lat: center.lat, lon: center.lon } });
    }).finally(() => this.waiting.delete(id));
  }
  close() {
    this.worker?.terminate();
  }
}

let lastResults = [];
let searchSeq = 0;
async function runSearch() {
  const q = input.value.trim();
  if (!q) return showHome();
  if (!app.search) {
    toast('Download a state map first');
    return null;
  }
  const seq = ++searchSeq;
  const results = await app.search.query(q, app.me && app.state && stateAt([app.state], app.me.lon, app.me.lat) ? app.me : center());
  if (seq !== searchSeq || input.value.trim() !== q) return results; // a newer search is on its way
  lastResults = results;
  if (!lastResults.length) {
    openSheet(`<h2>No results</h2><p class="sub">Nothing matching "${esc(q)}" in ${esc(app.state.name)}. Try another spelling, a nearby landmark, or a plus code. Missing? Tap the map where it is and choose <b>Add a missing place</b>.</p>`, { search: true });
    return lastResults;
  }
  const items = lastResults
    .map((r, i) => `<li><button data-act="result" data-i="${i}"><span class="pin-ico">${iconFor(r.k)}</span><span><div class="title">${esc(r.n)}${r.s === 'u' ? '<span class="badge">added by you</span>' : ''}</div><div class="meta">${esc(cap(r.k))}${r.a ? ` · ${esc(r.a)}` : ''}</div></span><span class="dist">${r.distKm != null ? formatDistance(r.distKm * 1000) : ''}</span></button></li>`)
    .join('');
  openSheet(`<ul class="list">${items}</ul>`, { search: true });
  return lastResults;
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');
const svg = (d) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${d}</svg>`;
const CAT = {
  street: svg('<path d="M8 3 5 21M16 3l3 18M12 4v2.5M12 10.5v3M12 17.5V20"/>'),
  bus: svg('<rect x="5" y="3" width="14" height="14" rx="2.5"/><path d="M5 11h14M8 17v3M16 17v3"/><path d="M8.5 14h.01M15.5 14h.01"/>'),
  bank: svg('<path d="M3 9.5 12 4l9 5.5"/><path d="M5.5 10v8M10 10v8M14 10v8M18.5 10v8M3.5 20.5h17"/>'),
  fuel: svg('<path d="M4.5 20.5V5.5a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v15M3.5 20.5h11M4.5 10h9"/><path d="M13.5 8l3 2.5v6a1.5 1.5 0 0 0 3 0V9L17 6"/>'),
  worship: svg('<path d="M12 2.5v4M10.2 4.3h3.6"/><path d="M5.5 20.5v-9L12 7l6.5 4.5v9"/><path d="M10 20.5v-3.5a2 2 0 0 1 4 0v3.5M3.5 20.5h17"/>'),
  health: svg('<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M12 8v8M8 12h8"/>'),
  school: svg('<path d="M2.5 9 12 4.5 21.5 9 12 13.5z"/><path d="M6.5 11v4.5c3 2.2 8 2.2 11 0V11M21.5 9v5"/>'),
  food: svg('<path d="M6.5 3v6a2 2 0 0 0 4 0V3M8.5 3v18"/><path d="M17.5 21V3c-2 1-3 3.5-3 7.5h3"/>'),
  hotel: svg('<path d="M3 19V6M3 15h18v4M21 15v-2.5A2.5 2.5 0 0 0 18.5 10H11v5"/><circle cx="7" cy="12" r="1.8"/>'),
  shop: svg('<path d="M5 8h14l-1.2 12.5H6.2z"/><path d="M9 10V6.5a3 3 0 0 1 6 0V10"/>'),
  area: svg('<path d="M3 20.5h18M5 20.5V10l5-3v13.5M10 20.5V4l9 5v11.5"/>'),
  code: svg('<circle cx="12" cy="12" r="6.5"/><path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4"/>'),
  map: svg('<path d="M9 4 3.5 6v14L9 18l6 2 5.5-2V4L15 6z"/><path d="M9 4v14M15 6v14"/>'),
  check: svg('<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.7 2.7L16 10"/>'),
};
function iconFor(k = '') {
  const rules = [
    [/street|road/, 'street'], [/bus|transport|station|terminal|park/, 'bus'], [/bank|atm|credit union|financ/, 'bank'],
    [/fuel|gas|petrol|filling/, 'fuel'], [/church|chapel|mosque|worship|temple/, 'worship'],
    [/hospital|clinic|health|doctor|pharma|medic|dentist/, 'health'], [/school|college|university|education|learning/, 'school'],
    [/restaurant|food|eat|cafe|bar|bakery|fast/, 'food'], [/hotel|lodg|guest|motel/, 'hotel'],
    [/mall|shop|store|market|supermarket|retail|boutique/, 'shop'],
    [/suburb|neighbourhood|town|city|village|quarter|locality|hamlet|island|district/, 'area'], [/plus code|coordinates/, 'code'],
  ];
  for (const [re, ico] of rules) if (re.test(k)) return CAT[ico];
  return ICONS.pin;
}

/* ------------------------------------------------------------------ place card */
function clearPlace() {
  app.placeMarker?.remove();
  app.placeMarker = null;
}

/** Destination marker: green tile with a pin, name underneath. */
function destMarker(p) {
  const el = document.createElement('div');
  el.className = 'dest';
  el.innerHTML = `<div class="dest-pin">${ICONS.pin}</div><div class="dest-stem"></div><div class="dest-label"></div>`;
  el.querySelector('.dest-label').textContent = p.me ? '' : p.n;
  return new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, 5] });
}

function showPlace(p) {
  clearPlace();
  if (app.state) addRecent(app.state.slug, p);
  input.value = '';
  $('clear').hidden = true;
  app.placeMarker = destMarker(p).setLngLat([p.lon, p.lat]).addTo(map);
  map.flyTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), p.k === 'street' ? 15 : 16.5), duration: 700 });
  app.current = p;
  const code = encode(p.lat, p.lon);
  const dist = app.me ? `${formatDistance(km(app.me.lat, app.me.lon, p.lat, p.lon) * 1000)} away · ` : '';
  openSheet(`
    <h2>${esc(p.n)}</h2>
    <p class="sub">${esc(cap(p.k) || 'Location')}${p.a ? ` · ${esc(p.a)}` : ''}${p.s === 'u' ? ' · added by you' : ''}</p>
    ${p.ad ? `<p class="sub">${esc(p.ad)}</p>` : ''}
    <p class="sub">${dist}Plus code <b>${code}</b></p>
    <div class="row">
      ${app.savingAs ? `<button class="btn primary grow" data-act="save-as" data-kind="${app.savingAs}">Save as ${app.savingAs === 'home' ? 'Home' : 'Work'}</button>` : ''}
      <button class="btn grow${app.savingAs ? '' : ' primary'}" data-act="directions">${ICONS.turn} Directions</button>
    </div>
    <div class="actions">
      <button data-act="save-menu"><span>${ICONS.bookmark}</span>Save</button>
      <button data-act="share"><span>${ICONS.share}</span>Share</button>
      ${p.pin ? `<button data-act="add-place"><span>${ICONS.plus}</span>Add place</button>` : ''}
      <button data-act="report"><span>${ICONS.flag}</span>Report</button>
    </div>`);
}

// Where keke / okada are restricted (shown under keke/okada routes; check local rules)
const BIKE_BANS = {
  lagos: 'Routes here also avoid highways and bridges. Okada and keke are banned on them and in many areas (incl. Ikeja, Eti-Osa, Lagos Island, Apapa, Surulere). Check before you ride.',
  'federal-capital-territory': 'Routes here also avoid highways. Okada are banned in the Abuja city centre and many districts.',
};

/** A WakaWise link that opens this exact spot: /?at=lat,lon&n=name */
function placeLink(p) {
  const q = new URLSearchParams({ at: `${p.lat.toFixed(6)},${p.lon.toFixed(6)}` });
  if (p.n && !p.me) q.set('n', p.n);
  return `${location.origin}/?${q}`;
}

async function sharePlace(p) {
  const code = encode(p.lat, p.lon);
  const name = p.me ? 'My location' : p.n;
  // the plus code works in any map app, even without WakaWise
  const text = [name, `Plus code: ${code}`, `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`].join('\n');
  const url = placeLink(p);
  try {
    if (navigator.share) return await navigator.share({ title: name, text, url });
  } catch (e) {
    if (e?.name === 'AbortError') return; // closed the share sheet
  }
  const all = `${text}\n${url}`;
  try {
    await navigator.clipboard.writeText(all);
    toast('Link copied. Paste it into WhatsApp or SMS');
  } catch {
    open(`https://wa.me/?text=${encodeURIComponent(all)}`, '_blank', 'noopener');
  }
}

async function shareMyLocation() {
  toast('Finding your location…');
  const pos = await getPosition(15000);
  if (pos.error) return toast(pos.message || "Couldn't get your location");
  setMe(pos);
  sharePlace({ n: 'My location', lat: pos.lat, lon: pos.lon, me: true });
}

/** A shared link (?at=lat,lon&n=name): the place to show once its state's map is open. */
function sharedPlace() {
  const q = new URLSearchParams(location.search);
  const m = (q.get('at') || '').match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = +m[1], lon = +m[2];
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { n: (q.get('n') || 'Shared place').slice(0, 120), k: 'shared place', lat, lon, pin: true };
}

/** Show the shared place if the open map covers it. */
function showPendingShare() {
  const p = app.pendingShare;
  if (!p || !app.state || !stateAt([app.state], p.lon, p.lat)) return false;
  app.pendingShare = null;
  history.replaceState(null, '', location.pathname); // a reload shouldn't open it again
  showPlace(p);
  return true;
}

/* ------------------------------------------------------------------ map clicks */
map.on('click', (e) => {
  if (app.nav) return;
  const { lng, lat } = e.lngLat;
  if (!app.state) {
    const s = stateAt(app.states, lng, lat);
    if (s) offerState(s, false);
    return;
  }
  if (app.dir?.routes?.length > 1 && map.getLayer('route-alt')) {
    const box = [[e.point.x - 8, e.point.y - 8], [e.point.x + 8, e.point.y + 8]];
    const f = map.queryRenderedFeatures(box, { layers: ['route-alt', 'route-alt-casing'] })[0];
    if (f) return selectRoute(f.properties.i);
  }
  if (app.pickingStart) {
    app.pickingStart = false;
    app.dir.from = { lat, lon: lng, n: 'Chosen point' };
    computeRoute();
    return;
  }
  showPlace({ n: 'Dropped pin', k: '', lat, lon: lng, pin: true });
});
let hoverId = null;
map.on('mousemove', (e) => {
  if (app.state || !map.getLayer('states-fill')) return;
  const f = map.queryRenderedFeatures(e.point, { layers: ['states-fill'] })[0];
  if (hoverId !== null) map.setFeatureState({ source: 'states', id: hoverId }, { hover: false });
  hoverId = f ? f.id : null;
  if (f && hoverId !== undefined && hoverId !== null) map.setFeatureState({ source: 'states', id: hoverId }, { hover: true });
});

/* ------------------------------------------------------------------ add a place */
const CATEGORIES = ['Shop', 'Restaurant', 'Market', 'Church', 'Mosque', 'School', 'Hospital / clinic', 'Pharmacy', 'Bank', 'Fuel station', 'Hotel', 'Office', 'Bus stop', 'Home / compound', 'Other'];
function addPlaceForm(p) {
  openSheet(`
    <h2>Add a missing place</h2>
    <p class="sub">Plus code ${encode(p.lat, p.lon)}</p>
    <form id="add-form">
      <label class="field">Name<input name="n" required maxlength="80" placeholder="e.g. Mama Tunde Provisions" /></label>
      <label class="field">Type<select name="k">${CATEGORIES.map((c) => `<option>${c}</option>`).join('')}</select></label>
      <label class="field">Street or landmark (optional)<input name="ad" maxlength="120" placeholder="e.g. Opposite First Bank, Allen Avenue" /></label>
      ${p.me ? '' : '<label class="check"><input type="checkbox" name="share" /> Share it with WakaWise so others can find it too (not for homes or private places)</label>'}
      <div class="row"><button class="btn primary" type="submit">Save place</button><button class="btn" type="button" data-act="cancel">Cancel</button></div>
    </form>
    <p class="note">Saved on this phone and searchable straight away. Shared places are checked and added to the map for everyone in a later update.</p>`);
  $('add-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const place = { n: f.get('n').trim(), k: f.get('k').toLowerCase(), ad: f.get('ad').trim(), lat: p.lat, lon: p.lon, a: nearestArea(p.lat, p.lon) };
    const saved = saveUserPlace(app.state.slug, place);
    addUserPlaceToMap(saved);
    if (f.get('share')) send('/api/report', { kind: 'place', slug: app.state.slug, lat: p.lat, lon: p.lon, topic: place.k, name: place.n, detail: place.ad });
    toast(f.get('share') ? `Added "${saved.n}" and shared it. Thank you!` : `Added "${saved.n}". Try searching for it.`);
    showPlace({ ...saved, s: 'u' });
  });
}

const PROBLEMS = [
  ['closed', 'Road is closed or blocked'],
  ['missing-road', 'A road is missing'],
  ['wrong-name', 'Wrong name'],
  ['wrong-place', 'Place is in the wrong spot'],
  ['not-here', "Place doesn't exist / has closed"],
  ['other', 'Something else'],
];
function reportForm(p) {
  openSheet(`
    <h2>Report a problem</h2>
    <p class="sub">${esc(p.n)} · ${encode(p.lat, p.lon)}</p>
    <form id="report-form">
      <label class="field">What's wrong?<select name="topic">${PROBLEMS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
      <label class="field">Details (optional)<textarea name="detail" maxlength="500" rows="3" placeholder="e.g. Bridge closed for repairs since March"></textarea></label>
      <div class="row"><button class="btn primary" type="submit">Send report</button><button class="btn" type="button" data-act="cancel">Cancel</button></div>
    </form>
    <p class="note">Sent to the WakaWise team with this spot on the map. No name or phone number is sent. With no data, it's sent once you're back online.</p>`);
  $('report-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    send('/api/report', { kind: 'problem', slug: app.state.slug, lat: p.lat, lon: p.lon, topic: f.get('topic'), name: p.me ? '' : p.n, detail: f.get('detail') });
    toast(navigator.onLine ? 'Thanks! Report sent.' : "Thanks! It'll be sent when you're back online.", 4000);
    showPlace(p);
  });
}

function nearestArea(lat, lon) {
  let best = '';
  let bestD = 4;
  for (const d of app.docs) {
    if (!/suburb|neighbourhood|quarter|town|village|locality/.test(d.k)) continue;
    const dist = km(lat, lon, d.lat, d.lon);
    if (dist < bestD) {
      best = d.n;
      bestD = dist;
    }
  }
  return best;
}

function addUserPlaceToMap(p) {
  if (app.search && !indexedUserPlaces.has(p.id)) {
    app.search.addUserPlace(p);
    indexedUserPlaces.add(p.id);
  }
  const el = document.createElement('div');
  el.className = 'user-place';
  el.title = p.n;
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    showPlace({ ...p, s: 'u' });
  });
  app.userMarkers.push(new maplibregl.Marker({ element: el }).setLngLat([p.lon, p.lat]).addTo(map));
}

/* ------------------------------------------------------------------ my location */
function circle(lat, lon, radiusM, steps = 64) {
  const pts = [];
  const dLat = radiusM / 111320;
  const dLon = radiusM / (111320 * Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    pts.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [pts] } };
}

function drawMe() {
  const src = map.getSource('me-accuracy');
  if (!src) return;
  src.setData(app.me ? circle(app.me.lat, app.me.lon, Math.max(app.me.accuracy || 0, 15)) : { type: 'FeatureCollection', features: [] });
}

/** Pin the user's position: blue dot (with a beam showing which way the phone faces) plus a circle showing how accurate it is. */
function setMe(pos) {
  app.me = pos;
  if (app.nav) return; // the navigation arrow shows the position instead
  if (!app.meMarker) {
    const el = document.createElement('div');
    el.className = 'me';
    el.title = 'Your location';
    el.innerHTML = `<div class="me-halo"></div>${CONE_SVG}<div class="me-dot"></div>`;
    el.querySelector('.cone').setAttribute('hidden', ''); // an <svg> has no .hidden property
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      showMe();
    });
    app.meMarker = new maplibregl.Marker({ element: el, rotationAlignment: 'map' });
    if (compass.heading != null) showHeading(compass.heading);
  }
  app.meMarker.setLngLat([pos.lon, pos.lat]).addTo(map);
  drawMe();
  if (app.locMode === 'compass') map.jumpTo({ center: [pos.lon, pos.lat] });
  else if (app.locMode === 'follow') map.easeTo({ center: [pos.lon, pos.lat], duration: 500 });
}

/* Which way the phone faces: rotate the beam, and in compass mode the whole map. */
function showHeading(h) {
  if (app.meMarker) {
    // a cone pointing the way you face replaces the plain dot once the compass reports
    const el = app.meMarker.getElement();
    el.querySelector('.cone').removeAttribute('hidden');
    el.querySelector('.me-dot').hidden = true;
    app.meMarker.setRotation(h);
  }
  if (app.locMode === 'compass' && !app.nav) map.jumpTo({ bearing: h });
}
compass.on(showHeading);

const LOC_ICONS = {
  off: '<path d="M12 3 19 20 12 16.5 5 20z"/>',
  follow: '<path d="M12 3 19 20 12 16.5 5 20z" fill="currentColor"/>',
  compass: '<circle cx="12" cy="12" r="10"/><path d="M12 5.5 16.5 17 12 14.8 7.5 17z" fill="currentColor"/>',
};
$('locate').querySelector('svg').innerHTML = LOC_ICONS.off;
/** Locate button modes, like Google Maps: off -> follow me -> follow me + turn the map with the phone. */
function setLocMode(mode) {
  const prev = app.locMode;
  app.locMode = mode;
  const btn = $('locate');
  btn.classList.toggle('on', mode !== 'off');
  btn.querySelector('svg').innerHTML = LOC_ICONS[mode];
  btn.setAttribute('aria-label', mode === 'compass' ? 'Stop turning the map with your phone' : mode === 'follow' ? 'Turn the map with your phone' : 'Show my location');
  if (prev === 'compass' && mode !== 'compass') map.easeTo({ bearing: 0, pitch: 0, duration: 400 });
  if (mode === 'compass') {
    map.jumpTo({ pitch: 45, bearing: compass.heading ?? map.getBearing(), center: app.me ? [app.me.lon, app.me.lat] : undefined });
  }
}
map.on('dragstart', (e) => {
  if (e.originalEvent && app.locMode !== 'off') setLocMode('off');
});

/** Keep the blue dot moving while the page is open. */
function watchMe() {
  if (app.watch != null || !navigator.geolocation) return;
  app.watch = navigator.geolocation.watchPosition(
    (p) => setMe({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy }),
    () => {},
    { enableHighAccuracy: true, maximumAge: 5000 },
  );
}

/** "Your location" card: plus code to share, save it as a place, check the state. */
function showMe() {
  const p = app.me;
  if (!p) return;
  clearPlace();
  app.current = { n: 'Your location', k: '', lat: p.lat, lon: p.lon, pin: true, me: true };
  const here = stateAt(app.states, p.lon, p.lat);
  const acc = p.accuracy ? `Accurate to about ${formatDistance(p.accuracy)}` : '';
  const other = app.state && here && here.slug !== app.state.slug;
  openSheet(`
    <h2>Your location</h2>
    <p class="sub">${here ? esc(here.name) : 'Outside Nigeria'}${p.lat ? ` · ${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}` : ''}</p>
    <p class="sub">Plus code <b>${encode(p.lat, p.lon)}</b>${acc ? ` · ${acc}` : ''}</p>
    ${other ? `<p class="sub">You're in <b>${esc(here.name)}</b>, but the map loaded is ${esc(app.state.name)}.</p>` : ''}
    <div class="row">
      ${other ? `<button class="btn primary" data-act="offer" data-slug="${here.slug}">Get ${esc(here.name)} map</button>` : ''}
      <button class="btn${other ? '' : ' primary'}" data-act="share">Share my location</button>
      <button class="btn" data-act="add-place">＋ Save as a place</button>
    </div>
    ${p.accuracy > 500 ? '<p class="note">Your position is approximate (from Wi-Fi or the network). Turn on GPS or step outside for a precise pin.</p>' : ''}`);
}

async function locate() {
  const btn = $('locate');
  if (app.locMode === 'follow' && app.me) {
    // second tap: turn the map with the phone (asks for compass access on iPhone)
    const ok = await compass.enable();
    if (!ok) return toast("This device doesn't have a compass the browser can use");
    setLocMode('compass');
    if (compass.heading == null) toast('Hold your phone flat and move it in a figure 8 if the direction looks wrong');
    return;
  }
  if (app.locMode === 'compass') return setLocMode('follow');
  compass.enable(); // shows which way you face on the blue dot
  btn.classList.add('busy');
  const pos = await getPosition(15000);
  btn.classList.remove('busy');
  if (pos.error) {
    openSheet(`<h2>Can't find your location</h2><p class="sub">${esc(pos.message)}</p><div class="row"><button class="btn primary" data-act="locate">Try again</button><button class="btn" data-act="pick">Choose state</button></div>`);
    return;
  }
  const first = !app.me;
  setMe(pos);
  watchMe();
  map.flyTo({ center: [pos.lon, pos.lat], zoom: Math.max(map.getZoom(), 16) });
  map.once('moveend', () => setLocMode('follow'));
  if (first || !app.dir) showMe();
}
$('locate').addEventListener('click', locate);

$('state-chip').addEventListener('click', () => openStatePicker());
$('settings').addEventListener('click', showSettings);

function showSettings() {
  const theme = safeGet('theme') || 'dark';
  const muted = safeGet('navMuted') === '1';
  const saved = savedPlaces();
  const opt = (act, v, label, on) => `<button data-act="${act}" data-v="${v}" aria-pressed="${on}">${label}</button>`;
  // a switch sends the value it will change to
  const sw = (act, on, label) => `<button class="switch" role="switch" aria-checked="${on}" aria-label="${label}" data-act="${act}" data-v="${on ? 'off' : 'on'}"><span></span></button>`;
  const sv = (kind, label) =>
    saved[kind] ? `<li><button data-act="clear-saved" data-kind="${kind}"><span class="pin-ico">${ICONS[kind]}</span><span><div class="title">${label}</div><div class="meta">${esc(saved[kind].n)}</div></span><span class="dist">Remove</span></button></li>` : '';
  openSheet(`
    <h2>Settings</h2>
    <h3>Appearance</h3>
    <div class="seg">${opt('theme', 'dark', 'Dark', theme === 'dark')}${opt('theme', 'light', 'Light', theme === 'light')}${opt('theme', 'auto', 'Same as phone', theme === 'auto')}</div>
    <h3>Navigation</h3>
    <div class="settings-group">
      <div class="setting"><span><div class="title">Voice directions</div><div class="meta">Spoken turn-by-turn instructions</div></span>${sw('voice', !muted, 'Voice directions')}</div>
      <div class="setting"><span><div class="title">Help improve travel times</div><div class="meta">When you drive with WakaWise navigation, send how long each road took, so travel times can be based on real traffic. The start and end of each trip (500 m) are left out, and only totals per road are kept: no name, phone number or account.</div></span>${sw('trips', tripsAllowed(), 'Help improve travel times')}</div>
    </div>
    ${saved.home || saved.work ? `<h3>Saved places</h3><ul class="list">${sv('home', 'Home')}${sv('work', 'Work')}</ul>` : ''}
    <h3>Maps on this device</h3>
    <div class="row"><button class="btn" data-act="pick">Manage state maps</button>${app.state ? '<button class="btn" data-act="clear-recent">Clear recent places</button>' : ''}</div>
    <p class="note"><b>WakaWise</b>: maps that work with no data.<br>Map data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a> (ODbL). Places © <a href="https://overturemaps.org" target="_blank" rel="noopener">Overture Maps</a>${app.docs?.some((d) => d.s === 'f') ? ', <a href="https://opensource.foursquare.com/os-places/" target="_blank" rel="noopener">Foursquare</a> (Apache 2.0)' : ''}. Map style © Protomaps. Font: Noto Sans (OFL).</p>
    ${MADE_BY}`);
}

/* ------------------------------------------------------------------ directions */
function startDirections(to) {
  const meInState = app.me && stateAt([app.state], app.me.lon, app.me.lat);
  app.dir = { to, from: meInState ? { ...app.me, n: 'Your location' } : null, mode: app.dir?.mode ?? 'car', result: null, steps: null };
  if (!app.dir.from) {
    app.pickingStart = true;
    renderDirections();
    return;
  }
  computeRoute();
}

function computeRoute() {
  const d = app.dir;
  const g = app.graph;
  const a = app.snapper.nearest(d.from.lat, d.from.lon, d.mode);
  const b = app.snapper.nearest(d.to.lat, d.to.lon, d.mode);
  const t0 = performance.now();
  const best = a >= 0 && b >= 0 ? findRoute(g, a, b, d.mode) : null;
  d.routes = best ? [best, ...alternatives(g, a, b, d.mode, best)].sort((x, y) => x.seconds - y.seconds) : [];
  d.ms = performance.now() - t0;
  d.snap = [a, b];
  app.startMarker?.remove();
  const startEl = document.createElement('div');
  startEl.className = 'start-dot';
  app.startMarker = new maplibregl.Marker({ element: startEl }).setLngLat([d.from.lon, d.from.lat]).addTo(map);
  selectRoute(0);
  if (d.result) {
    const bounds = new maplibregl.LngLatBounds();
    d.routes.forEach((r) => r.coords.forEach((c) => bounds.extend(c)));
    bounds.extend([d.from.lon, d.from.lat]).extend([d.to.lon, d.to.lat]);
    map.fitBounds(bounds, { padding: { top: 140, bottom: innerWidth < 760 ? innerHeight * 0.5 : 60, left: innerWidth < 760 ? 40 : 460, right: 60 }, duration: 700 });
  }
}

/** Choose one of the offered routes (fastest first). */
function selectRoute(i) {
  const d = app.dir;
  d.sel = Math.max(0, Math.min(i, d.routes.length - 1));
  d.result = d.routes[d.sel] ?? null;
  d.steps = d.result ? buildSteps(app.graph, d.result, app.landmarks, d.to.n) : null;
  drawRoute();
  renderDirections();
}

/** Main road of a route, for "via Allen Avenue". */
function viaRoad(r) {
  const g = app.graph;
  const len = new Map();
  for (const x of r.entries) {
    const e = x >>> 1;
    const n = g.edgeName[e] >= 0 ? g.names[g.edgeName[e]] : '';
    if (n) len.set(n, (len.get(n) ?? 0) + g.edgeLen[e]);
  }
  let best = '';
  for (const [n, m] of len) if (!best || m > len.get(best)) best = n;
  return best;
}

/** Candidate points for route `i`'s time label, on the part the other routes don't share (middle first). */
function labelPoints(i) {
  const d = app.dir;
  const g = app.graph;
  const others = new Set();
  d.routes.forEach((r, k) => k !== i && r.entries.forEach((x) => others.add(x >>> 1)));
  const own = d.routes[i].entries.filter((x) => !others.has(x >>> 1));
  const list = own.length ? own : d.routes[i].entries;
  if (!list.length) return [d.routes[i].coords[0]];
  return [0.5, 0.35, 0.65, 0.2, 0.8, 0.1, 0.9].map((f) => {
    const e = list[Math.min(list.length - 1, Math.floor(list.length * f))] >>> 1;
    return [(g.nodeLon[g.edgeFrom[e]] + g.nodeLon[g.edgeTo[e]]) / 2 / g.scale, (g.nodeLat[g.edgeFrom[e]] + g.nodeLat[g.edgeTo[e]]) / 2 / g.scale];
  });
}

/** Put the time labels where they don't cover each other on screen (the selected route's label goes first). */
function placeRouteChips() {
  const chips = app.routeChips;
  if (!chips.length || !app.dir) return;
  const order = chips.map((_, i) => i).sort((x, y) => (y === app.dir.sel) - (x === app.dir.sel));
  const boxes = [];
  const hits = (bx) => boxes.some((o) => bx.x0 < o.x1 && bx.x1 > o.x0 && bx.y0 < o.y1 && bx.y1 > o.y0);
  for (const i of order) {
    const m = chips[i];
    const el = m.getElement();
    const w = (el.offsetWidth || 70) + 8;
    const h = (el.offsetHeight || 30) + 6;
    const box = (p) => {
      const q = map.project(p);
      return { x0: q.x - w / 2, x1: q.x + w / 2, y0: q.y - h, y1: q.y };
    };
    const cands = m._cands;
    const pick = cands.find((p) => !hits(box(p)));
    // no free spot (tiny screen or zoomed far out): hide this label; the list in the panel still shows every time
    el.style.visibility = pick || !boxes.length ? '' : 'hidden';
    m.setLngLat(pick ?? cands[0]);
    if (pick || !boxes.length) boxes.push(box(pick ?? cands[0]));
  }
}

map.on('zoomend', placeRouteChips);
map.on('moveend', placeRouteChips);

function clearRouteChips() {
  app.routeChips.forEach((m) => m.remove());
  app.routeChips = [];
}

function drawRoute() {
  const d = app.dir;
  const g = app.graph;
  const empty = { type: 'FeatureCollection', features: [] };
  if (!map.getSource('route')) return;
  clearRouteChips();
  if (!d?.result) {
    map.getSource('route').setData(empty);
    map.getSource('route-links').setData(empty);
    map.getSource('route-alt')?.setData(empty);
    return;
  }
  map.getSource('route').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: d.result.coords } });
  map.getSource('route-alt')?.setData({
    type: 'FeatureCollection',
    features: d.routes.map((r, i) => ({ type: 'Feature', properties: { i }, geometry: { type: 'LineString', coordinates: r.coords } })).filter((f) => f.properties.i !== d.sel),
  });
  if (d.routes.length > 1 && !app.nav) {
    d.routes.forEach((r, i) => {
      const el = document.createElement('button');
      el.className = `route-chip${i === d.sel ? ' sel' : ''}`;
      const range = travelRange(r.seconds, d.mode, app.state.slug);
      el.textContent = formatDuration((range.min + range.max) / 2);
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        selectRoute(i);
      });
      const m = new maplibregl.Marker({ element: el, anchor: 'bottom' });
      m._cands = labelPoints(i);
      app.routeChips.push(m.setLngLat(m._cands[0]).addTo(map));
    });
    placeRouteChips();
  }
  const [a, b] = d.snap;
  const pt = (n) => [g.nodeLon[n] / g.scale, g.nodeLat[n] / g.scale];
  map.getSource('route-links').setData({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'LineString', coordinates: [[d.from.lon, d.from.lat], pt(a)] } },
      { type: 'Feature', geometry: { type: 'LineString', coordinates: [pt(b), [d.to.lon, d.to.lat]] } },
    ],
  });
}

function renderDirections() {
  const d = app.dir;
  const modeBtn = (m, label) => `<button aria-pressed="${d.mode === m}" data-act="mode" data-mode="${m}">${label}</button>`;
  let body = '';
  if (!d.from) {
    body = `<p class="sub"><b>Tap the map</b> to choose where you're starting from, or use your location.</p><div class="row"><button class="btn" data-act="use-me">Use my location</button></div>`;
  } else if (!d.result) {
    body = `<p class="sub">No ${{ car: 'driving', bike: 'keke or okada', foot: 'walking' }[d.mode]} route found between these points in the downloaded map.</p>`;
  } else {
    const r = d.result;
    const range = travelRange(r.seconds, d.mode, app.state.slug);
    const steps = d.steps
      .map((s, i) => `<li data-act="step" data-i="${i}">${turnSvg(s.type === 'depart' ? 'straight' : s.type, 'step-ico')}<span><div>${esc(s.text)}</div>${s.distance ? `<div class="d">${formatDistance(s.distance)}</div>` : ''}</span></li>`)
      .join('');
    // one card per route (fastest first); the selected one is outlined
    const choices = `<div class="routes">${d.routes
      .map((x, i) => {
        const rr = travelRange(x.seconds, d.mode, app.state.slug);
        const via = viaRoad(x);
        const mid = (q) => (q.min + q.max) / 2;
        const extra = Math.max(1, Math.round((mid(rr) - mid(travelRange(d.routes[0].seconds, d.mode, app.state.slug))) / 60));
        const tag = d.routes.length > 1 ? (i === 0 ? 'Fastest' : `${extra} min slower`) : esc(range.label);
        return `<button class="route" data-act="route" data-i="${i}" aria-pressed="${i === d.sel}"><span class="route-time">${formatRange(rr)}</span><span class="route-tag">${tag}</span><span class="route-meta">${formatDistance(x.meters)}${via ? ` · via ${esc(via)}` : ''}</span></button>`;
      })
      .join('')}</div>`;
    body = `
      ${choices}
      ${d.mode === 'bike' ? `<p class="note">Keke and okada routes avoid expressways.${BIKE_BANS[app.state.slug] ? ` ${BIKE_BANS[app.state.slug]}` : ''} Times are estimates.</p>` : ''}
      ${d.mode === 'car' ? `<p class="note">Estimated for ${esc(range.label)}. No live traffic offline; this range is based on typical ${esc(app.state.name)} traffic at this time of day.</p>` : ''}
      <div class="sheet-actions"><button class="btn primary grow" data-act="navigate"><svg class="i" viewBox="0 0 24 24" style="width:18px;height:18px"><path d="M12 3 19 20 12 16.5 5 20z" fill="currentColor"/></svg> Start</button><button class="btn" data-act="pick-start">Change start</button></div>
      <h3>Steps</h3><ul class="list steps">${steps}</ul>
      <p class="note">Route found offline in ${d.ms.toFixed(0)} ms.</p>`;
  }
  openSheet(`
    <h2>Directions</h2>
    <div class="ends">
      <div class="end"><span class="dot"></span><button data-act="pick-start">${esc(d.from?.n ?? 'Choose start…')}</button></div>
      <div class="end"><span class="dot to"></span><button data-act="back-to-place">${esc(d.to.n)}</button></div>
    </div>
    <div class="seg mode-row">${modeBtn('car', `${ICONS.car} Drive`)}${modeBtn('bike', `${ICONS.bike} Keke`)}${modeBtn('foot', `${ICONS.walk} Walk`)}</div>
    ${body}`);
}

function closeDirections() {
  stopNavigation();
  app.dir = null;
  app.pickingStart = false;
  app.startMarker?.remove();
  drawRoute();
  closeSheet();
}

/* ------------------------------------------------------------------ navigation (GPS + voice) */
function startNavigation({ simulate = false } = {}) {
  const d = app.dir;
  if (!d?.result) return;
  if (!simulate && !navigator.geolocation) return toast('This device has no GPS');
  compass.enable(); // asks for compass access on iPhone; must happen inside the tap
  setTimeout(() => app.snapper.edgeCells(), 1500); // ready the road lookup for rerouting (~0.1-0.5 s, once per state)
  stopNavigation();
  closeSheet();
  clearPlace();
  clearRouteChips();
  map.getSource('route-alt')?.setData({ type: 'FeatureCollection', features: [] });
  setLocMode('off');
  app.meMarker?.remove();
  app.startMarker?.remove();
  map.getSource('me-accuracy')?.setData({ type: 'FeatureCollection', features: [] });
  const first = d.steps[1];
  app.nav = new Navigator({
    map, maplibregl, graph: app.graph, slug: app.state.slug, simulate, compass,
    recordTrips: !simulate && d.mode === 'car' && tripsAllowed(),
    onTrip: (edges) => send('/api/trips', { slug: app.state.slug, build: app.build, bucket: tripBucket(), edges: edges.slice(0, 1500) }),
    dir: d,
    reroute(lat, lon, heading) {
      // start from the road we're on, heading the way we're going (not the nearest junction, which
      // is often the one we just turned off at and would send us back to the old route)
      const g = app.graph;
      const b = d.snap[1];
      const hit = app.snapper.nearestEdge(lat, lon, d.mode, heading);
      let result = null;
      let a;
      if (hit) {
        const rest = hit.node === b ? { seconds: 0, meters: 0, entries: [] } : findRoute(g, hit.node, b, d.mode);
        if (rest) {
          const e = hit.entry >>> 1;
          const entries = [hit.entry, ...rest.entries];
          const kmh = d.mode === 'foot' ? 5 : d.mode === 'bike' ? Math.min(g.edgeSpeed[e], 35) : g.edgeSpeed[e];
          const edgeS = g.edgeLen[e] / (kmh / 3.6);
          a = hit.start;
          result = { mode: d.mode, seconds: rest.seconds + edgeS, meters: rest.meters + g.edgeLen[e], entries, coords: routeCoords(g, a, entries) };
        }
      }
      if (!result) {
        a = app.snapper.nearest(lat, lon, d.mode);
        result = a >= 0 ? findRoute(g, a, b, d.mode) : null;
      }
      if (!result) return null;
      d.snap = [a, b];
      d.from = { lat, lon, n: 'Your location' };
      return { result, steps: buildSteps(app.graph, result, app.landmarks, d.to.n) };
    },
    onExit(reason, err, pos) {
      app.nav = null;
      if (app.me && !simulate) setMe(app.me);
      if (reason === 'silent') return;
      if (pos && !simulate && app.me) setMe({ ...app.me, lat: pos.lat, lon: pos.lon });
      if (reason === 'gps-error') {
        drawRoute();
        openSheet(`<h2>Can't start navigation</h2><p class="sub">${esc(err?.code === 1 ? 'Location is blocked for this page, so the map can’t follow you. Allow location for this site in your browser, then try again.' : 'No GPS signal.')}</p>
          <div class="row"><button class="btn primary" data-act="navigate">Try again</button><button class="btn" data-act="simulate">Preview with a simulated drive</button><button class="btn" data-act="back-dir">Back</button></div>`);
      } else if (reason === 'arrived') {
        drawRoute();
        openSheet(`<h2>You have arrived</h2><p class="sub">${esc(d.to.n)}</p><div class="row"><button class="btn primary" data-act="close-dir">Done</button></div>`);
      } else {
        drawRoute();
        renderDirections();
      }
    },
  });
  const lead = first ? (first.type === 'arrive' ? `Head to ${d.to.n}` : `${d.steps[0].text}, then ${first.text}`) : '';
  app.nav.start(lead);
}

function stopNavigation() {
  app.nav?.exit('silent');
  app.nav = null;
}

/* ------------------------------------------------------------------ one click handler for the sheet */
sheet.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  if (act === 'pick') openStatePicker();
  else if (act === 'offer') offerState(app.states.find((s) => s.slug === el.dataset.slug), false);
  else if (act === 'download') downloadState(el.dataset.slug);
  else if (act === 'open') openState(app.states.find((s) => s.slug === el.dataset.slug));
  else if (act === 'remove') removeState(el.dataset.slug);
  else if (act === 'pause-dl') {
    setPaused(download?.slug, true);
    download?.controller.abort();
  } else if (act === 'install') {
    closeSheet();
    installPrompt?.prompt();
    installPrompt = null;
  } else if (act === 'close') {
    if (app.dir && !app.nav) closeDirections();
    else {
      if (!app.current?.me) clearPlace();
      closeSheet();
    }
  } else if (act === 'saved') openSaved(el.dataset.i);
  else if (act === 'recent') showPlace(recentPlaces(app.state.slug)[+el.dataset.i]);
  else if (act === 'added') showPlace({ ...loadUserPlaces(app.state.slug)[+el.dataset.i], s: 'u' });
  else if (act === 'save-as') saveAs(el.dataset.kind);
  else if (act === 'save-menu') {
    const box = el.closest('.actions, .row');
    box.className = 'row';
    box.innerHTML = `<button class="btn" data-act="save-as" data-kind="home">Set as Home</button><button class="btn" data-act="save-as" data-kind="work">Set as Work</button><button class="btn" data-act="cancel">Cancel</button>`;
  } else if (act === 'theme') {
    safeSet('theme', el.dataset.v);
    restyle();
    showSettings();
  } else if (act === 'trips') {
    if (el.dataset.v === 'on') safeSet('shareTrips', '1');
    else safeRemove('shareTrips');
    showSettings();
  } else if (act === 'voice') {
    safeSet('navMuted', el.dataset.v === 'off' ? '1' : '0');
    showSettings();
  } else if (act === 'clear-saved') {
    setSaved(el.dataset.kind, null);
    showSettings();
  } else if (act === 'clear-recent') {
    clearRecent(app.state.slug);
    toast('Recent places cleared');
    showSettings();
  }
  else if (act === 'result') showPlace(lastResults[+el.dataset.i]);
  else if (act === 'directions') startDirections(app.current);
  else if (act === 'share') sharePlace(app.current);
  else if (act === 'share-me') shareMyLocation();
  else if (act === 'add-place') addPlaceForm(app.current);
  else if (act === 'report') reportForm(app.current);
  else if (act === 'cancel') showPlace(app.current);
  else if (act === 'mode') {
    app.dir.mode = el.dataset.mode;
    if (app.dir.from) computeRoute();
    else renderDirections();
  } else if (act === 'pick-start') {
    app.pickingStart = true;
    toast('Tap the map to choose your starting point');
  } else if (act === 'use-me') {
    const pos = await getPosition(15000);
    if (pos.error) return toast(pos.message, 8000);
    setMe(pos);
    app.pickingStart = false;
    app.dir.from = { ...pos, n: 'Your location' };
    computeRoute();
  } else if (act === 'back-to-place') showPlace(app.dir.to);
  else if (act === 'close-dir') closeDirections();
  else if (act === 'locate') locate();
  else if (act === 'navigate') startNavigation({ simulate: new URLSearchParams(location.search).has('sim') });
  else if (act === 'simulate') startNavigation({ simulate: true });
  else if (act === 'route') selectRoute(+el.dataset.i);
  else if (act === 'back-dir') renderDirections();
  else if (act === 'step') {
    const s = app.dir.steps[+el.dataset.i];
    if (s.lat) map.flyTo({ center: [s.lon, s.lat], zoom: 17 });
  }
});

function safeGet(k) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function safeRemove(k) {
  try {
    localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}
function safeSet(k, v) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}

init();

// The service worker keeps the page itself working offline (built app only; see vite.config.js).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register(`${BASE}sw.js`).catch((err) => console.warn('service worker not registered', err));
}
