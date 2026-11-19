# Project: WakaWise (offline map web page)

## Goal
A web page (not a native app), named **WakaWise** ("waka" is Pidgin for walk or travel), where users can search for a place, get directions and follow turn-by-turn guidance, even with no data or internet.

## Core behaviour
- Coverage: all of Nigeria, split into one package per state (36 states + FCT)
- On the first visit (online), find which state the visitor is in (GPS → point-in-polygon against `public/states.geojson`; offer a state picker if location is denied or they're outside Nigeria) and automatically download that state's package, showing a progress bar and then "Ready offline ✓"
- Let users add more states later (e.g. when travelling)
- After that, the page loads, searches, routes and navigates fully offline
- Warn users about the download size (from `data/states/index.json`, 20–80 MB per state) before it starts
- Resume interrupted downloads on the next visit
- Refresh the map data every few weeks when online

## Features
1. Map display (offline)
2. Search for places and streets (offline)
3. Directions for walking and driving (offline)
4. Turn-by-turn navigation with live GPS (GPS works without data)
5. Voice instructions

## Tech stack
- **Data:** OpenStreetMap. Raw data for state boundaries, search and routing comes from the Geofabrik Nigeria extract
- **Tiles:** extracted from the Protomaps daily planet build with the go-pmtiles CLI (`pmtiles extract --region`), which downloads only each state's tiles. This replaced Planetiler because Java isn't installed and isn't needed
- **Map rendering:** MapLibre GL JS + `@protomaps/basemaps` style; fonts and sprites must be self-hosted for offline use
- **Search:** MiniSearch over `search.json` docs: OSM places, streets, POIs and addresses, plus Overture Maps places (CDLA-Permissive-2.0, merged and de-duplicated in `pipeline/add_places.py`; Foursquare Open Source Places (Apache 2.0) join too once `pipeline/fetch_foursquare.py` has been run with a Hugging Face token). The index is built and queried in a Web Worker (`src/lib/searchWorker.js`, `SearchClient` in main.js) so big states don't freeze the page. Ranking (`src/lib/search.js`) mixes text match, importance `w`, exact-name bonus and distance from the user. Also accepts plus codes (full or short) and coordinates
- **Routing:** custom compact binary graph (`graph.bin` + `graph.json`) built with pyosmium; plain A* in JS (`src/routing/`). Up to 2 alternative routes by re-running A* with the used roads penalised (`alternatives()` in `astar.js`), shown grey with time chips (placed so they don't cover each other, hidden if there's no room: `placeRouteChips`); tap to choose. Modes: car, `bike` (keke/okada: no motorways, trunk roads cost 1.6×, max 35 km/h, ban notes for Lagos/FCT in `BIKE_BANS`) and foot. Car speeds: `CAR_SPEED` in towns, faster `RURAL_SPEED` outside (`URBAN_RADIUS_KM` around city/town/suburb place nodes, judged per edge in `build_osm.py`). Contraction hierarchies or Valhalla-WASM only if A* proves too slow
- **Navigation:** Google-style navigation screen in `src/nav/navigation.js` (green turn banner, "Then" chip, arrow that glides along the route with the map facing the direction of travel, speed, arrival time, overview, mute, rerouting after 3 off-route fixes, screen wake lock). Phone compass (`src/lib/compass.js`) turns the map the way you face when walking or stopped; outside navigation the locate button goes off → follow → compass mode, and the blue dot shows a heading beam. Geolocation API (`watchPosition`); `?sim` (or the button shown when location is blocked) drives a simulated GPS along the route for demos. Turn instructions with landmarks (`src/routing/instructions.js`: "Turn left at First Bank onto Allen Avenue"), Web Speech API for voice
- **Travel times:** no live traffic; `src/lib/traffic.js` shows a range from typical city/time-of-day multipliers (estimates). Opt-in trip times (Settings → Help improve travel times; `src/lib/trips.js`) record seconds per graph edge while driving, skipping the first and last 500 m, and are summed per edge and hour-of-week in D1 (`edge_times`); not used for routing yet
- **Web app:** Vite + vanilla JS (`index.html`, `src/main.js`). The UI is dark-first: a theme setting (dark, light or follow the phone) stored in localStorage `theme` sets `<html data-theme>`, and `src/app.css` uses CSS variables. The design uses floating dark square controls (settings and north at the top right; zoom and locate at the right), a "Where to?" bar at the bottom that moves to the top in search mode (`body.search-mode`) and shows saved Home/Work, places you added and recent places (`src/lib/places.js`), a green-to-yellow gradient route (`lineMetrics` + `line-gradient`), a green tile destination pin, and a white cone with a green halo for "you" (`CONE_SVG` in navigation.js). Navigation uses a blue turn card. MapLibre 6 must be excluded from Vite's dependency pre-bundling (see `vite.config.js`) or its worker fails to load
- **Offline:** state packages are saved in IndexedDB by `src/lib/packs.js` in 4 MB pieces, stored as ArrayBuffers rather than Blobs because Safari on iPhone has bugs with Blobs in IndexedDB. Tiles are read a few pieces at a time through `StoredSource`, a custom pmtiles source. A saved copy from an older storage `FORMAT`, or one missing pieces, is deleted and downloaded again. Downloads resume with HTTP Range, and the Pause button stops auto-resume. A newer build (index.json `built`) downloads in the background every 14+ days next to the old one and replaces it only once complete. `navigator.storage.persist()` is called after a download. Tiles use the pmtiles key `<slug>-<build>`. The page shell uses a hand-written service worker (`sw/sw.js`), not Workbox. The page is cached under `/`, never `/index.html`: Cloudflare Pages redirects /index.html to /, and a cached redirect can't open a page, which broke offline once. `node tools/offline-test.mjs [url] [state]` tests the real deployment end to end with Edge: download, go offline, reopen, map, search. The `offline-shell` plugin in `vite.config.js` turns it into `dist/sw.js` with a precache list of every built file plus common glyph ranges. Other glyph ranges come back empty offline. The service worker only runs in a build (`npm run build` / `npm run preview`). Fonts (Noto Sans, OFL) and sprites are self-hosted in `public/fonts` and `public/sprites`, copied from protomaps/basemaps-assets. In a build, MapLibre needs `setWorkerUrl` (done in main.js). There is a web manifest and icons in `public/icons`, an install prompt after the first download, and an Add to Home Screen tip on iPhone
- **Hosting:** the app runs on Cloudflare Pages and the state packages live in Cloudflare R2. Config is in `wrangler.toml`: project `wakawise`, bucket `offline-map-data` bound as `DATA`, D1 database `wakawise` bound as `DB` (schema in `db/schema.sql`).
  - `functions/api/report.js` (problem reports, places users chose to share) and `functions/api/trips.js` (opt-in trip times) store feedback in D1, rate-limited by a daily-rotating IP hash. The page queues them in localStorage (`src/lib/outbox.js`) and sends them when online. Read them in the Cloudflare dashboard (D1 → wakawise → Console).
  - Shared links: `/?at=lat,lon&n=name` opens that spot (or offers its state's map). "Share my location" is on the Where to? panel.
  - `.github/workflows/refresh-maps.yml` rebuilds and uploads every state weekly; needs repo secrets CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (optional HF_TOKEN).
  - `functions/data/states/[[path]].js` serves `/data/states/...` from R2 at the same paths as the dev server. It handles Range and If-Range, uses `no-cache`, and only serves the four package files plus `index.json`.
  - `src/lib/packs.js` sends If-Range with the stored ETag when resuming. A file that changed on the server then restarts cleanly instead of mixing two versions.
  - `public/_headers` sets the caching and security headers.
  - `npm run cf:upload` (`pipeline/upload.mjs`) uploads only changed files, with `index.json` last; `--local` targets the simulated bucket.
  - `npm run cf:dev` builds and runs everything locally on port 8788 (the launch entry `cloudflare` attaches the browser pane; the pane only allows service workers on servers opened through launch entries).
  - `npm run cf:deploy` builds and publishes.
  - Needs `npx wrangler login` once (the user signs in themselves), plus R2 enabled on the account.

## Constraints and notes
- Do not use Google Maps tiles or data (their terms forbid offline caching)
- No live traffic
- Search only finds places in the downloaded data
- iPhone Safari allows less storage, so prompt users to "Add to Home Screen"
- One state per download keeps it small; packages include ~5 km beyond the state border so routes don't stop dead at the line
- Hardest part is offline routing in the browser, so build it early
- OSM data is ODbL: the map must always show "© OpenStreetMap contributors"; also credit Overture Maps for places
- Goal is to get as close to Google Maps' usefulness as possible with open data. Not done yet: Foursquare data (script ready; needs a Hugging Face token), extra building footprints (needs tile building, e.g. Planetiler/Java), using the collected trip times for routing, reviewing shared places into the map, public transport (OSM has only 2 bus routes in Nigeria, the Ikorodu BRT, and ~330 Lagos bus stops: too thin for transit routing)

## Data pipeline (step 1)
Scripts in `pipeline/`, settings in `pipeline/config.json`. Raw downloads go to `data/raw/`, state packages to `data/states/<slug>/` (both gitignored). Python deps: `py -m pip install -r pipeline/requirements.txt`; Node deps: `npm install`.
1. `py pipeline/fetch_osm.py geofabrik` → `data/raw/nigeria-latest.osm.pbf` (~715 MB, resumable, version-checked)
2. `py pipeline/build_states.py` → state borders (`admin_level=4`) → `data/states/<slug>/region.geojson` (border + 0.05° buffer) and `public/states.geojson` (simplified, for the page). Repairs borders with one small gap (Taraba is missing one way on the Cameroon border)
3. `py pipeline/build_osm.py [--states a,b]` → per state `graph.bin`, `graph.json`, `search.json`. One pass over the Nigeria file for all states (~10 min)
4. `py pipeline/fetch_tiles.py [slug ...]` → per state `tiles.pmtiles` (needs `tools/pmtiles/pmtiles.exe` from github.com/protomaps/go-pmtiles releases). Zoom 15, or 14 if the state's tiles would exceed 60 MB
5. `py pipeline/fetch_places.py` → `data/raw/overture_places.parquet` (Overture places in Nigeria, via DuckDB on S3), then `py pipeline/add_places.py` merges them into every state's `search.json` (re-runnable)
6. `py pipeline/build_index.py` → `data/states/index.json` (name, ISO code, bbox, file sizes per state)
7. `node pipeline/check.mjs [slug ...]` → per-state size vs. 80 MB budget, a sanity route for every state, and named routes and searches for states listed under `checks` in config

**Live (2026-11-19): https://wakawise.pages.dev**: all 37 states in R2, and the app is deployed with `npm run cf:deploy`. Each deploy also gets its own preview address.

**Status (2026-11-18): step 1 done for all 37 states.** 1.38 GB in total; every state is under the 80 MB budget (largest: Oyo 78.9 MB, Lagos 73.4 MB, Bauchi 72.4 MB; Niger and Ogun use zoom-14 tiles). Search has ~217k docs across Nigeria after the Overture merge (Lagos 51k). A* takes milliseconds per route, so contraction hierarchies aren't needed. The MiniSearch index is built on the device from `search.json`; with the Overture places that takes ~2 s for Lagos (51k docs) on a PC; it runs in a Web Worker so the map stays usable meanwhile. The app's ranking (`src/lib/search.js`) puts areas first ("Lekki" → Lekki Phase I); `check.mjs` uses a simpler ranking, so its search output can differ. Known gaps: named multipolygon relations aren't indexed; Bayelsa (79%) and Taraba (73%) have many roads not connected to the main network (islands, unconnected tracks), so taps there snap to the nearest connected road.

Graph format: nodes are junctions only, and in-between points are edge "shape" points. Each edge is stored once; `adj` entries are `edgeId << 1 | reversed`. Edge flags: 1 car forward, 2 car backward, 4 foot, 8 roundabout. Coordinates are Int32 degrees × 1e6. Node flag 1 = main connected network (snap only to these).

## Preview
`npx vite` (or the `preview` entry in `.claude/launch.json`) serves the app on http://localhost:5173 and the state packages straight from `data/states/`. `?state=lagos` opens or downloads that state.
- `npm run preview` (launch entry `built`, port 4173) serves the built app with its service worker. The `serve-data` plugin also serves `data/states/` there, with Range support.
- Stopping that server and reloading tests the real offline behaviour.
- `npm run phone` builds the app and serves it over https on the Wi-Fi at port 5174. `npm run phone:dev` is the dev-server version.
- The certificate comes from `npm run phone:cert` (`tools/lan-cert.mjs`). It makes a local CA in `tools/certs/` with Git's OpenSSL, limited to 192.168.x.x, 10.x.x.x and localhost addresses, and a server certificate for the current Wi-Fi address. Keep `ca.key` on this PC only, and re-run the script if the address changes.
- The phone installs the CA once from `/lan-ca.crt` (`/lan-ca.der.crt` for older Android). After that the service worker registers and the page opens offline.
- Without the certificate files, the server falls back to a self-signed certificate. Chrome then refuses the service worker, so the page won't open offline on the phone.
- The map only draws while the page is visible (MapLibre waits for animation frames).

## Plan for the first version (~4–8 weeks)
1. Data pipeline, one package per state (OSM → PMTiles + search index + routing graph)
2. Map display with MapLibre
3. Offline search
4. Offline routing (walking + driving)
5. GPS navigation + voice
6. Service worker, auto-download and offline storage
7. Test on real Android and iPhone devices with data turned off

## Brand
- Name: WakaWise. A quick web search found no app with that name; Wakanow, a travel company, has a similar prefix, so check the Nigerian trademark register before investing in the brand.
- Logo: a winding road fading from yellow to green, rising into a green map pin, on a dark background (#121417). It matches the route line in the app.
- `py tools/make_icons.py` redraws every icon in `public/icons/` (app 192/512, maskable 512, iPhone 180, favicon).
- Tagline: "Find your way, even when the internet goes dark."
- Link preview: Open Graph and Twitter tags in `index.html`, with two images, both kept out of the offline precache: `public/og-square.jpg` (600x600; og:image, for WhatsApp's compact "WakaWise — tagline" card) and `public/og-image.jpg` (1200x630; twitter:image). To redo it: start the dev server, run `node tools/screenshots.mjs` (drives Edge via playwright-core to take phone screenshots), then `py tools/make_share_image.py`.
