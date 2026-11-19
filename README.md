# WakaWise

**Find your way, even when the internet goes dark.**

WakaWise is a web app for Nigeria that does maps, search, walking and driving directions, and turn-by-turn voice navigation, all with no data. You download your state's map once, about 20–80 MB. After that everything runs on the phone, and GPS works without data.

Live: https://wakawise.pages.dev

## How it works

- **One package per state** (36 states + FCT): map tiles (PMTiles), a road graph for routing, and a search index. Each is built from OpenStreetMap, with places from Overture Maps.
- **Stored on the device:** packages are saved in IndexedDB in 4 MB pieces, so downloads can resume. A service worker keeps the page itself available offline.
- **Routing:** A* over a compact binary road graph, with up to two alternative routes, for driving, keke/okada and walking.
- **Navigation:** live GPS, a moving arrow that follows the road, rerouting, voice prompts (Web Speech), and a compass mode.
- **Sharing and feedback:** share a place or your location as a link; report map problems; share places you add; opt in to sending trip times to improve travel estimates (Cloudflare Pages Functions + D1).
- **Built with:** Vite + vanilla JS, MapLibre GL, Protomaps basemaps, and MiniSearch.

## Develop

```sh
npm install
npx vite                # http://localhost:5173 (serves state packages from data/states/)
npm run build           # production build in dist/ (with the offline service worker)
npm run preview         # serve the build on http://localhost:4173
```

The state packages aren't in this repository (1.4 GB). Build them with the data pipeline:

```sh
py -m pip install -r pipeline/requirements.txt
py pipeline/fetch_osm.py geofabrik
py pipeline/build_states.py
py pipeline/build_osm.py
py pipeline/fetch_tiles.py        # needs tools/pmtiles/pmtiles.exe
py pipeline/fetch_places.py
py pipeline/fetch_foursquare.py   # optional, needs a Hugging Face token
py pipeline/add_places.py
py pipeline/build_index.py
node pipeline/check.mjs
```

## Deploy (Cloudflare Pages + R2)

```sh
npx wrangler login
npm run cf:upload       # state packages -> R2 bucket (only changed files)
npm run cf:deploy       # build + publish the app
node tools/offline-test.mjs   # end-to-end offline check of the live site
```

The maps can also be rebuilt on GitHub Actions (`.github/workflows/refresh-maps.yml`) once the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets are set.

## Credits

- Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL)
- Places © [Overture Maps Foundation](https://overturemaps.org) (CDLA-Permissive-2.0) and, when merged, [Foursquare Open Source Places](https://opensource.foursquare.com/os-places/) (Apache 2.0)
- Basemap style and fonts: [Protomaps](https://protomaps.com), Noto Sans (SIL OFL)
