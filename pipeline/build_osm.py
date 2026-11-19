"""Build the offline search docs and the routing graph for one city from raw OSM data.

Usage:  py pipeline/build_osm.py [--input PATH]
        (default input: data/raw/nigeria-latest.osm.pbf, else data/raw/<city>-overpass.osm)
Output: data/<city>/search.json   search documents (MiniSearch builds its index from these)
        data/<city>/graph.bin     road graph, typed arrays (layout described in graph.json)
        data/<city>/graph.json    graph metadata: sections, counts, road classes, street names

Graph layout
  Nodes are road junctions and dead ends only. The points in between are kept as edge
  "shape" points for drawing the route, which keeps the graph small and A* fast.
  Every edge is stored once (from -> to). adj[] lists, per node, the edges touching it as
  (edgeId << 1 | reversed); reversed = 1 means travelling the edge from `to` back to `from`.
  Coordinates are Int32 degrees * coordScale (1e6, ~11 cm).
"""
import argparse
import json
import math
import sys
import time
from array import array
from collections import defaultdict
from pathlib import Path

import numpy as np
import osmium
import shapely
import shapely.geometry

ROOT = Path(__file__).resolve().parent.parent
CFG = json.loads((ROOT / "pipeline" / "config.json").read_text(encoding="utf-8"))
STATES_DIR = ROOT / "data" / "states"
SCALE = 1_000_000

# ---------------------------------------------------------------- routing rules
# Typical driving speeds (km/h) per road class in towns and cities. Deliberately low: Lagos
# traffic, no live data. Out of town (see URBAN_RADIUS_KM) the faster RURAL_SPEED table is used.
CAR_SPEED = {
    "motorway": 80, "motorway_link": 50, "trunk": 60, "trunk_link": 40,
    "primary": 45, "primary_link": 35, "secondary": 40, "secondary_link": 30,
    "tertiary": 35, "tertiary_link": 25, "unclassified": 25, "residential": 20,
    "living_street": 10, "service": 15, "road": 20,
}
RURAL_SPEED = {
    "motorway": 100, "motorway_link": 60, "trunk": 85, "trunk_link": 50,
    "primary": 75, "primary_link": 45, "secondary": 60, "secondary_link": 40,
    "tertiary": 50, "tertiary_link": 35, "unclassified": 40, "residential": 30,
    "living_street": 10, "service": 20, "road": 35,
}
# A road counts as "in town" within this distance of a place node of that kind.
URBAN_RADIUS_KM = {"city": 12, "town": 5, "suburb": 2.5, "quarter": 1.5, "neighbourhood": 1.2}
FOOT_TYPES = (set(CAR_SPEED) - {"motorway", "motorway_link"}) | {
    "footway", "pedestrian", "path", "steps", "cycleway", "track", "bridleway", "corridor",
}
ROUTABLE = set(CAR_SPEED) | FOOT_TYPES
CLASSES = sorted(ROUTABLE)
CLASS_INDEX = {c: i for i, c in enumerate(CLASSES)}
NO = {"no", "private", "use_sidepath"}
YES = {"yes", "designated", "permissive", "destination", "customers", "delivery", "official"}
F_CAR_FWD, F_CAR_BWD, F_FOOT, F_ROUNDABOUT = 1, 2, 4, 8
NODE_MAIN = 1  # node belongs to the largest connected network (snap only to these)

# ---------------------------------------------------------------- search rules
KIND_KEYS = [
    "place", "amenity", "shop", "tourism", "leisure", "healthcare", "office", "craft",
    "railway", "aeroway", "public_transport", "historic", "emergency", "sport", "club",
    "man_made", "natural", "landuse", "building",
]
PLACE_WEIGHT = {"city": 10, "town": 9, "suburb": 8, "quarter": 7, "neighbourhood": 6,
                "village": 6, "island": 6, "hamlet": 4, "locality": 4}
AREA_PLACES = {"suburb", "quarter", "neighbourhood", "village", "town", "hamlet", "island", "locality"}
STREET_WEIGHT = {"motorway": 5, "trunk": 5, "primary": 5, "secondary": 4, "tertiary": 4}
KEY_WEIGHT = {"natural": 2, "landuse": 2, "building": 2, "man_made": 2}
ALT_KEYS = ("alt_name", "old_name", "official_name", "short_name", "loc_name")


def haversine(lat1, lon1, lat2, lon2) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2
    return 2 * 6371008.8 * math.asin(math.sqrt(a))


def access(tags: dict, keys, default: bool) -> bool:
    """Apply access tags from most general to most specific key."""
    ok = default
    for k in keys:
        v = tags.get(k)
        if v in NO:
            ok = False
        elif v in YES:
            ok = True
    return ok


def parse_maxspeed(v):
    if not v:
        return None
    v = v.strip().lower()
    try:
        return float(v[:-3]) * 1.609 if v.endswith("mph") else float(v.split()[0])
    except (ValueError, IndexError):
        return None


def kind_of(tags: dict):
    """(kind label, weight) for a named feature, or None if it isn't searchable."""
    hw = tags.get("highway")
    if hw == "bus_stop":
        return "bus stop", 3
    if hw == "motorway_junction":
        return "junction", 3
    pt = tags.get("public_transport")
    if pt == "stop_position":
        return None
    if pt == "platform":
        return "bus stop", 3
    for key in KIND_KEYS:
        v = tags.get(key)
        if not v or v == "no":
            continue
        if key == "place":
            return v.replace("_", " "), PLACE_WEIGHT.get(v, 4)
        label = key if v == "yes" else v.replace("_", " ")
        return label, KEY_WEIGHT.get(key, 3)
    return None


class UnionFind:
    def __init__(self, n=0):
        self.p = list(range(n))

    def add(self) -> int:
        self.p.append(len(self.p))
        return len(self.p) - 1

    def find(self, x: int) -> int:
        p = self.p
        while p[x] != x:
            p[x] = p[p[x]]
            x = p[x]
        return x

    def union(self, a: int, b: int) -> None:
        a, b = self.find(a), self.find(b)
        if a != b:
            self.p[b] = a


class Collector:
    def __init__(self):
        # roads: per way attributes + slice into the flat node arrays
        self.road_ids = array("q")
        self.road_lat = array("i")
        self.road_lon = array("i")
        self.roads = []  # (flags, speed, class, name_idx, offset, count, maxspeed)
        self.names = {}
        self.max_speed = 0
        # search
        self.features = []  # dicts: n, alt, k, w, lat, lon, place
        self.streets = []   # (name, alt, weight, node_ids, lats, lons)

    def name_idx(self, name):
        if not name:
            return -1
        if name not in self.names:
            self.names[name] = len(self.names)
        return self.names[name]

    # -------------------------------------------------------------- roads
    def add_road(self, tags, pts):
        hw = tags["highway"]
        car = hw in CAR_SPEED and access(tags, ("access", "vehicle", "motor_vehicle", "motorcar"), True)
        foot = access(tags, ("access", "foot"), hw in FOOT_TYPES)
        if not (car or foot):
            return
        flags = F_FOOT if foot else 0
        roundabout = tags.get("junction") in ("roundabout", "circular")
        if roundabout:
            flags |= F_ROUNDABOUT
        if car:
            ow = tags.get("oneway")
            if ow in ("yes", "1", "true"):
                flags |= F_CAR_FWD
            elif ow == "-1":
                flags |= F_CAR_BWD
            elif ow != "no" and (roundabout or hw in ("motorway", "motorway_link")):
                flags |= F_CAR_FWD
            else:
                flags |= F_CAR_FWD | F_CAR_BWD
        speed = CAR_SPEED.get(hw, 0)
        ms = parse_maxspeed(tags.get("maxspeed")) if car else None
        if ms:
            speed = max(5, min(speed, int(ms)))
        name = tags.get("name") or tags.get("ref")
        self.roads.append((flags, speed, CLASS_INDEX[hw], self.name_idx(name), len(self.road_ids), len(pts), int(ms) if ms else 0))
        for nid, lat, lon in pts:
            self.road_ids.append(nid)
            self.road_lat.append(round(lat * SCALE))
            self.road_lon.append(round(lon * SCALE))

    # -------------------------------------------------------------- search
    def add_feature(self, tags, lat, lon):
        name = tags.get("name")
        if name:
            kind = kind_of(tags)
            if kind:
                place = tags.get("place")
                alt = "; ".join(tags[k] for k in ALT_KEYS if tags.get(k))
                self.features.append({"n": name, "alt": alt, "k": kind[0], "w": kind[1],
                                      "lat": lat, "lon": lon, "place": place})
                return
        hn, street = tags.get("addr:housenumber"), tags.get("addr:street")
        if hn and street:
            self.features.append({"n": f"{hn} {street}", "alt": "", "k": "address", "w": 1,
                                  "lat": lat, "lon": lon, "place": None})

    def add_street(self, tags, pts):
        hw = tags["highway"]
        alt = "; ".join(tags[k] for k in ALT_KEYS if tags.get(k))
        self.streets.append((tags["name"], alt, STREET_WEIGHT.get(hw.replace("_link", ""), 3),
                             [p[0] for p in pts], [p[1] for p in pts], [p[2] for p in pts]))


# ---------------------------------------------------------------- regions
class Regions:
    """Which state regions (state polygon + buffer) contain a point.

    A coarse grid answers most lookups without geometry tests: a cell lying fully inside
    exactly the same regions needs no test; only cells crossing a region edge do exact checks.
    """

    def __init__(self, regions, cell=0.05):
        self.slugs = [s for s, _ in regions]
        self.geoms = [g for _, g in regions]
        for g in self.geoms:
            shapely.prepare(g)
        self.cell = cell
        minx, miny, maxx, maxy = shapely.total_bounds(self.geoms)
        self.x0, self.y0 = minx, miny
        tree = shapely.STRtree(self.geoms)
        self.cells = {}
        for ix in range(int((maxx - minx) / cell) + 1):
            for iy in range(int((maxy - miny) / cell) + 1):
                box = shapely.box(minx + ix * cell, miny + iy * cell, minx + (ix + 1) * cell, miny + (iy + 1) * cell)
                cand = tree.query(box, predicate="intersects")
                if len(cand) == 0:
                    continue
                full = tuple(int(i) for i in cand if self.geoms[i].contains(box))
                partial = tuple(int(i) for i in cand if int(i) not in full)
                self.cells[(ix, iy)] = (full, partial)
        self.bounds = (minx, miny, maxx, maxy)

    def lookup(self, lon, lat):
        hit = self.cells.get((int((lon - self.x0) / self.cell), int((lat - self.y0) / self.cell)))
        if hit is None:
            return ()
        full, partial = hit
        if not partial:
            return full
        return full + tuple(i for i in partial if shapely.contains_xy(self.geoms[i], lon, lat))


def dispatch(obj, regions: Regions, cols: list, stats: dict):
    """Send one OSM object to the collector of every region it falls in."""
    if obj.is_node():
        loc = obj.location
        if loc.valid():
            hits = regions.lookup(loc.lon, loc.lat)
            if hits:
                tags = {t.k: t.v for t in obj.tags}
                for r in hits:
                    cols[r].add_feature(tags, loc.lat, loc.lon)
        return
    if not obj.is_way():
        return
    pts = []
    for nr in obj.nodes:
        if not nr.location.valid():
            stats["skipped_ways"] += 1
            return
        pts.append((nr.ref, nr.location.lat, nr.location.lon))
    if len(pts) < 2:
        return
    tags = {t.k: t.v for t in obj.tags}
    hw = tags.get("highway")
    if hw in ROUTABLE and tags.get("area") != "yes":
        hits = set()
        for _, la, lo in pts:
            hits.update(regions.lookup(lo, la))
        for r in hits:
            cols[r].add_road(tags, pts)
            if tags.get("name"):
                cols[r].add_street(tags, pts)
    elif pts[0][0] == pts[-1][0] and len(pts) >= 4:
        ring = pts[:-1]
        lat = sum(p[1] for p in ring) / len(ring)
        lon = sum(p[2] for p in ring) / len(ring)
        for r in regions.lookup(lon, lat):
            cols[r].add_feature(tags, lat, lon)


# ---------------------------------------------------------------- graph build
def build_graph(c: Collector, out_dir: Path, info: dict) -> dict:
    # A point becomes a graph node if more than one road uses it (or a road passes it twice).
    ids_np = np.frombuffer(c.road_ids, dtype=np.int64)
    _, inverse, counts = np.unique(ids_np, return_inverse=True, return_counts=True)
    junction = (counts[inverse] > 1).tolist()
    del inverse, counts
    node_of = {}
    n_lat, n_lon = array("i"), array("i")
    e_from, e_to, e_len, e_shape = array("I"), array("I"), array("f"), array("I")
    e_name, e_flags, e_speed, e_class = array("i"), array("B"), array("B"), array("B")
    s_lat, s_lon = array("i"), array("i")
    ids, lats, lons = c.road_ids, c.road_lat, c.road_lon

    def node(i):
        osm = ids[i]
        n = node_of.get(osm)
        if n is None:
            n = node_of[osm] = len(n_lat)
            n_lat.append(lats[i])
            n_lon.append(lons[i])
        return n

    # Out-of-town roads get faster speeds: find built-up areas from city/town/suburb place nodes.
    cell = 0.05
    towns = defaultdict(list)
    for f in c.features:
        r = URBAN_RADIUS_KM.get(f["place"])
        if r:
            towns[(int(f["lat"] // cell), int(f["lon"] // cell))].append((f["lat"], f["lon"], r))
    reach = int(max(URBAN_RADIUS_KM.values()) / 111 / cell) + 1

    town_memo = {}

    def in_town(lat, lon):
        key = (round(lat * 200), round(lon * 200))  # ~500 m cells: plenty for this
        hit = town_memo.get(key)
        if hit is None:
            hit = town_memo[key] = in_town_exact(lat, lon)
        return hit

    def in_town_exact(lat, lon):
        cy, cx = int(lat // cell), int(lon // cell)
        for dy in range(-reach, reach + 1):
            for dx in range(-reach, reach + 1):
                for tlat, tlon, r in towns.get((cy + dy, cx + dx), ()):
                    if haversine(lat, lon, tlat, tlon) <= r * 1000:
                        return True
        return False

    def edge_speed(attrs, a, b):
        """Town speed, or the faster out-of-town speed, judged at the middle of this edge."""
        flags, speed, cls, _, _, _, ms = attrs
        if not flags & (F_CAR_FWD | F_CAR_BWD):
            return speed
        mid = (a + b) // 2
        if in_town(lats[mid] / SCALE, lons[mid] / SCALE):
            return speed
        fast = RURAL_SPEED.get(CLASSES[cls], speed)
        return max(5, min(fast, ms)) if ms else fast

    def emit(a, b, attrs):
        speed = edge_speed(attrs, a, b)
        flags, _, cls, name = attrs[:4]
        length = 0.0
        for i in range(a, b):
            length += haversine(lats[i] / SCALE, lons[i] / SCALE, lats[i + 1] / SCALE, lons[i + 1] / SCALE)
        e_from.append(node(a))
        e_to.append(node(b))
        e_len.append(length)
        e_shape.append(len(s_lat))
        s_lat.extend(lats[a + 1:b])
        s_lon.extend(lons[a + 1:b])
        e_name.append(name)
        e_flags.append(flags)
        e_speed.append(speed)
        e_class.append(cls)

    for attrs in c.roads:
        off, cnt = attrs[4], attrs[5]
        start = off
        for i in range(off + 1, off + cnt):
            if i == off + cnt - 1 or junction[i]:
                if ids[start] == ids[i]:  # closed loop: split in two so it isn't a self-loop
                    if i - start >= 2:
                        mid = (start + i) // 2
                        emit(start, mid, attrs)
                        emit(mid, i, attrs)
                else:
                    emit(start, i, attrs)
                start = i
    e_shape.append(len(s_lat))

    n, m = len(n_lat), len(e_from)
    # adjacency (CSR): each edge listed at both ends; the router checks direction flags
    deg = [0] * (n + 1)
    for e in range(m):
        deg[e_from[e] + 1] += 1
        deg[e_to[e] + 1] += 1
    for i in range(n):
        deg[i + 1] += deg[i]
    adj_off = array("I", deg)
    adj = array("I", bytes(4 * 2 * m))
    fill = list(deg[:n])
    for e in range(m):
        u, v = e_from[e], e_to[e]
        adj[fill[u]] = e << 1
        fill[u] += 1
        adj[fill[v]] = (e << 1) | 1
        fill[v] += 1

    # connected components: flag the largest network so taps never snap to an island
    uf = UnionFind(n)
    for e in range(m):
        uf.union(e_from[e], e_to[e])
    sizes = defaultdict(int)
    for i in range(n):
        sizes[uf.find(i)] += 1
    main = max(sizes, key=sizes.get) if sizes else -1
    n_flags = array("B", (NODE_MAIN if uf.find(i) == main else 0 for i in range(n)))

    blob = bytearray()
    sections = []
    type_names = {"i": "Int32", "I": "Uint32", "f": "Float32", "B": "Uint8"}

    def add(name, arr):
        while len(blob) % 4:
            blob.append(0)
        sections.append({"name": name, "type": type_names[arr.typecode], "offset": len(blob), "length": len(arr)})
        blob.extend(arr.tobytes())

    for name, arr in [("nodeLat", n_lat), ("nodeLon", n_lon), ("nodeFlags", n_flags),
                      ("adjOffset", adj_off), ("adj", adj),
                      ("edgeFrom", e_from), ("edgeTo", e_to), ("edgeLen", e_len), ("edgeShape", e_shape),
                      ("edgeName", e_name), ("edgeFlags", e_flags), ("edgeSpeed", e_speed), ("edgeClass", e_class),
                      ("shapeLat", s_lat), ("shapeLon", s_lon)]:
        add(name, arr)
    (out_dir / "graph.bin").write_bytes(blob)

    names = [None] * len(c.names)
    for k, i in c.names.items():
        names[i] = k
    meta = {
        "version": 1, "state": info["name"], "slug": info["slug"], "bbox": info["bbox"], "built": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "coordScale": SCALE, "maxCarSpeedKmh": max(e_speed, default=0),
        "counts": {"nodes": n, "edges": m, "shapePoints": len(s_lat), "mainNodes": sizes.get(main, 0)},
        "flags": {"CAR_FWD": F_CAR_FWD, "CAR_BWD": F_CAR_BWD, "FOOT": F_FOOT, "ROUNDABOUT": F_ROUNDABOUT, "NODE_MAIN": NODE_MAIN},
        "classes": CLASSES, "sections": sections, "names": names,
    }
    (out_dir / "graph.json").write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return meta


# ---------------------------------------------------------------- search build
def build_search(c: Collector, out_dir: Path) -> int:
    # Streets: join same-name ways that share a node, then merge pieces that sit close together
    # (dual carriageways). Same-name streets in different areas stay separate docs.
    uf = UnionFind(len(c.streets))
    first = {}
    for i, (name, _, _, nids, _, _) in enumerate(c.streets):
        for nid in nids:
            key = (name, nid)
            if key in first:
                uf.union(first[key], i)
            else:
                first[key] = i
    groups = defaultdict(list)
    for i in range(len(c.streets)):
        groups[uf.find(i)].append(i)
    by_name = defaultdict(list)
    for members in groups.values():
        lats = [la for i in members for la in c.streets[i][4]]
        lons = [lo for i in members for lo in c.streets[i][5]]
        by_name[c.streets[members[0]][0]].append({"m": members, "lats": lats, "lons": lons,
                                                   "bb": (min(lats), min(lons), max(lats), max(lons))})
    pad = 0.0015  # ~165 m
    street_docs = []
    for name, gs in by_name.items():
        guf = UnionFind(len(gs))
        for a in range(len(gs)):
            for b in range(a + 1, len(gs)):
                A, B = gs[a]["bb"], gs[b]["bb"]
                if A[0] - pad <= B[2] and B[0] - pad <= A[2] and A[1] - pad <= B[3] and B[1] - pad <= A[3]:
                    guf.union(a, b)
        merged = defaultdict(list)
        for a in range(len(gs)):
            merged[guf.find(a)].append(gs[a])
        for parts in merged.values():
            lats = [la for g in parts for la in g["lats"]]
            lons = [lo for g in parts for lo in g["lons"]]
            mlat, mlon = sum(lats) / len(lats), sum(lons) / len(lons)
            j = min(range(len(lats)), key=lambda k: (lats[k] - mlat) ** 2 + (lons[k] - mlon) ** 2)
            members = [i for g in parts for i in g["m"]]
            alt = "; ".join(sorted({c.streets[i][1] for i in members if c.streets[i][1]}))
            weight = max(c.streets[i][2] for i in members)
            street_docs.append({"n": name, "alt": alt, "k": "street", "w": weight,
                                "lat": lats[j], "lon": lons[j], "place": None})

    # POIs/places/addresses: drop duplicates (same name + kind within ~110 m)
    seen, docs = set(), []
    for f in c.features + street_docs:
        key = (f["n"].lower(), f["k"], round(f["lat"], 3), round(f["lon"], 3))
        if key not in seen:
            seen.add(key)
            docs.append(f)

    # Area context ("Adeola Street, Surulere"): nearest named place within ~3 km
    cell = 0.02
    grid = defaultdict(list)
    for f in docs:
        if f["place"] in AREA_PLACES:
            grid[(int(f["lat"] / cell), int(f["lon"] / cell))].append(f)
    out = []
    for i, f in enumerate(docs):
        cy, cx = int(f["lat"] / cell), int(f["lon"] / cell)
        best, best_d = "", 0.03 ** 2
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                for p in grid.get((cy + dy, cx + dx), ()):
                    if p is f or p["n"] == f["n"]:
                        continue
                    d = (p["lat"] - f["lat"]) ** 2 + (p["lon"] - f["lon"]) ** 2
                    if d < best_d:
                        best, best_d = p["n"], d
        doc = {"id": i, "n": f["n"], "k": f["k"], "a": best, "w": f["w"],
               "lat": round(f["lat"], 6), "lon": round(f["lon"], 6)}
        if f["alt"]:
            doc["alt"] = f["alt"]
        out.append(doc)
    (out_dir / "search.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return len(out)


def load_regions(only):
    regions = []
    for d in sorted(STATES_DIR.iterdir()):
        f = d / "region.geojson"
        if not f.exists() or (only and d.name not in only):
            continue
        feat = json.loads(f.read_text(encoding="utf-8"))["features"][0]
        geom = shapely.geometry.shape(feat["geometry"])
        regions.append((d.name, geom, feat["properties"]))
    return regions


def main() -> None:
    assert sys.byteorder == "little", "graph.bin is written little-endian"
    assert array("i").itemsize == 4 and array("I").itemsize == 4
    ap = argparse.ArgumentParser()
    ap.add_argument("--input")
    ap.add_argument("--states", help="comma-separated state slugs (default: all)")
    args = ap.parse_args()
    inp = Path(args.input) if args.input else ROOT / "data" / "raw" / Path(CFG["osm"]["geofabrik"]).name
    if not inp.exists():
        sys.exit(f"Missing {inp}. Run: py pipeline/fetch_osm.py geofabrik")
    only = set(args.states.split(",")) if args.states else None
    loaded = load_regions(only)
    if not loaded:
        sys.exit("No state regions found. Run: py pipeline/build_states.py")

    t0 = time.time()
    regions = Regions([(slug, geom) for slug, geom, _ in loaded])
    print(f"{len(loaded)} state regions indexed in {time.time() - t0:.0f}s", flush=True)
    cols = [Collector() for _ in loaded]
    stats = {"skipped_ways": 0}
    print(f"Reading {inp} ({inp.stat().st_size / 1e6:.0f} MB) ...", flush=True)
    # The location handler sees every node before the key filter drops untagged ones,
    # so way geometries are complete while Python only touches relevant objects.
    fp = (osmium.FileProcessor(str(inp))
          .with_locations()
          .with_filter(osmium.filter.KeyFilter("highway", "name", "addr:housenumber", "place")))
    for obj in fp:
        dispatch(obj, regions, cols, stats)
    print(f"  read in {time.time() - t0:.0f}s ({stats['skipped_ways']} ways skipped: missing nodes)", flush=True)

    for i, (slug, geom, props) in enumerate(loaded):
        c, cols[i] = cols[i], None  # free each state's raw data once it's written
        t1 = time.time()
        out_dir = STATES_DIR / slug
        if not c.roads:
            print(f"  {slug}: no roads found, skipped")
            continue
        info = {"name": props["name"], "slug": slug, "bbox": [round(v, 4) for v in geom.bounds]}
        k = build_graph(c, out_dir, info)["counts"]
        n_docs = build_search(c, out_dir)
        print(f"  {slug:22} {k['nodes']:>8} nodes {k['edges']:>8} edges  main {k['mainNodes'] / max(k['nodes'], 1):6.1%}"
              f"  {n_docs:>7} search docs  ({time.time() - t1:.0f}s)", flush=True)
    print(f"Done in {time.time() - t0:.0f}s -> {STATES_DIR}")


if __name__ == "__main__":
    main()
