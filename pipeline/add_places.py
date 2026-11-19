"""Merge Overture places into each state's search.json.

Run after build_osm.py and fetch_places.py. Safe to re-run: Overture docs from a previous run
(marked "s": "o") are removed first. A place is skipped when OSM already has the same name
within `places.dedupeMeters`, or when Overture lists the same name twice close together.

Usage:  py pipeline/add_places.py [slug ...]     (default: every state)
"""
import json
import math
import re
import sys
from collections import defaultdict
from pathlib import Path

import duckdb
import numpy as np
import shapely
import shapely.geometry

ROOT = Path(__file__).resolve().parent.parent
CFG = json.loads((ROOT / "pipeline" / "config.json").read_text(encoding="utf-8"))
STATES_DIR = ROOT / "data" / "states"
PLACES = ROOT / "data" / "raw" / "overture_places.parquet"
AREA_KINDS = {"suburb", "quarter", "neighbourhood", "village", "town", "hamlet", "island", "locality", "city"}
CELL = 0.002  # ~220 m grid for duplicate checks


def norm(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", name.lower()).strip()


def load_places():
    con = duckdb.connect()
    cols = con.sql(f"SELECT name, category, brand, confidence, street, locality, lon, lat FROM '{PLACES.as_posix()}'").fetchnumpy()
    out = {}
    for k, v in cols.items():
        if np.ma.isMaskedArray(v):
            if v.dtype == object:  # strings: masked (NULL) -> None. filled(None) would give numpy's "?" filler
                mask = np.ma.getmaskarray(v)
                v = np.array([None if m else x for x, m in zip(v.data, mask)], dtype=object)
            else:
                v = v.filled(np.nan)
        out[k] = v
    return out


def merge_state(slug: str, P: dict, dedupe_m: float) -> tuple[int, int]:
    d = STATES_DIR / slug
    region = shapely.geometry.shape(json.loads((d / "region.geojson").read_text(encoding="utf-8"))["features"][0]["geometry"])
    inside = np.nonzero(shapely.contains_xy(region, P["lon"], P["lat"]))[0]

    docs = []
    for doc in json.loads((d / "search.json").read_text(encoding="utf-8")):
        # drop previous Overture merge and junk names like "?" (no letters or digits)
        if doc.get("s") == "o" or not norm(doc["n"]):
            continue
        if not norm(doc["k"]):
            doc["k"] = "place"
        docs.append(doc)
    seen = defaultdict(list)  # (norm name, cell) -> [(lat, lon)]

    def key_cells(name, lat, lon):
        cy, cx = int(lat / CELL), int(lon / CELL)
        return [(name, cy + dy, cx + dx) for dy in (-1, 0, 1) for dx in (-1, 0, 1)]

    def is_dup(name, lat, lon):
        for k in key_cells(name, lat, lon):
            for la, lo in seen.get(k, ()):
                dy = (la - lat) * 111_320
                dx = (lo - lon) * 111_320 * math.cos(math.radians(lat))
                if dx * dx + dy * dy <= dedupe_m * dedupe_m:
                    return True
        return False

    def remember(name, lat, lon):
        seen[(name, int(lat / CELL), int(lon / CELL))].append((lat, lon))

    for doc in docs:
        remember(norm(doc["n"]), doc["lat"], doc["lon"])

    # area context: nearest named area from the OSM places already in search.json
    agrid = defaultdict(list)
    for doc in docs:
        if doc["k"] in AREA_KINDS:
            agrid[(int(doc["lat"] / 0.02), int(doc["lon"] / 0.02))].append(doc)

    def area_of(lat, lon, fallback):
        best, best_d = fallback or "", 0.03 ** 2
        cy, cx = int(lat / 0.02), int(lon / 0.02)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                for a in agrid.get((cy + dy, cx + dx), ()):
                    dd = (a["lat"] - lat) ** 2 + (a["lon"] - lon) ** 2
                    if dd < best_d:
                        best, best_d = a["n"], dd
        return best

    added = 0
    for i in inside:
        name = P["name"][i]
        if not name:
            continue
        lat, lon = float(P["lat"][i]), float(P["lon"][i])
        nn = norm(name)
        if not nn or is_dup(nn, lat, lon):
            continue
        remember(nn, lat, lon)
        cat = (P["category"][i] or "place").replace("_", " ")
        conf = float(P["confidence"][i] or 0)
        doc = {"n": name, "k": cat, "a": area_of(lat, lon, P["locality"][i]), "w": 3 if conf >= 0.8 else 2,
               "lat": round(lat, 6), "lon": round(lon, 6), "s": "o"}
        if P["brand"][i] and P["brand"][i] != name:
            doc["alt"] = P["brand"][i]
        if P["street"][i]:
            doc["ad"] = P["street"][i]
        docs.append(doc)
        added += 1

    for i, doc in enumerate(docs):
        doc["id"] = i
    (d / "search.json").write_text(json.dumps(docs, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return added, len(docs)


def main() -> None:
    if not PLACES.exists():
        sys.exit(f"Missing {PLACES}. Run: py pipeline/fetch_places.py")
    P = load_places()
    print(f"{len(P['name'])} Overture places loaded", flush=True)
    slugs = sys.argv[1:] or sorted(p.name for p in STATES_DIR.iterdir() if (p / "search.json").exists())
    for slug in slugs:
        added, total = merge_state(slug, P, CFG["places"]["dedupeMeters"])
        print(f"  {slug:26} +{added:>7} places  -> {total:>7} search docs", flush=True)


if __name__ == "__main__":
    main()
