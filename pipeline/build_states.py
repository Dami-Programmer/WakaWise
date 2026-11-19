"""Extract state boundaries (OSM admin_level=4) from the country extract.

Usage:  py pipeline/build_states.py
Output: data/states/boundaries.geojson   full-detail state polygons (used by the pipeline)
        data/states/<slug>/region.geojson   state polygon + buffer (cut line for tiles/roads/search)
        public/states.geojson            simplified polygons the web page uses to find the
                                          visitor's state from their GPS position (small file)
"""
import json
import math
import re
import sys
from pathlib import Path

import osmium
import shapely
from shapely.geometry import mapping

ROOT = Path(__file__).resolve().parent.parent
CFG = json.loads((ROOT / "pipeline" / "config.json").read_text(encoding="utf-8"))
OUT = ROOT / "data" / "states"
PUBLIC = ROOT / "public"


def slugify(name: str) -> str:
    name = re.sub(r"\bstate\b", "", name, flags=re.I)
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def repair_missing(pbf: Path, want: dict, states: dict) -> None:
    """Rebuild boundaries that osmium couldn't close (e.g. a border way missing from the
    country extract) by merging the member ways and bridging a small gap with a straight line."""
    from shapely.geometry import LineString, Polygon
    from shapely.ops import linemerge, unary_union

    missing = {}
    for r in osmium.FileProcessor(str(pbf), osmium.osm.RELATION).with_filter(
            osmium.filter.TagFilter(("admin_level", want["adminLevel"]))):
        tags = {t.k: t.v for t in r.tags}
        iso = tags.get("ISO3166-2", "")
        if tags.get("boundary") == "administrative" and iso.startswith(want["isoPrefix"]) and iso not in states:
            missing[iso] = (tags.get("name:en") or tags.get("name"), {m.ref for m in r.members if m.type == "w"})
    if not missing:
        return
    all_ways = set().union(*(w for _, w in missing.values()))
    lines = {}
    fp = (osmium.FileProcessor(str(pbf)).with_locations()
          .with_filter(osmium.filter.EntityFilter(osmium.osm.WAY))
          .with_filter(osmium.filter.IdFilter(all_ways)))
    for w in fp:
        if w.is_way() and all(n.location.valid() for n in w.nodes):
            lines[w.id] = LineString([(n.lon, n.lat) for n in w.nodes])
    for iso, (name, ways) in missing.items():
        merged = linemerge(unary_union([lines[i] for i in ways if i in lines]))
        parts = list(merged.geoms) if merged.geom_type == "MultiLineString" else [merged]
        if len(parts) != 1:
            print(f"  {iso:7} {name}: {len(parts)} separate pieces, can't repair automatically")
            continue
        ring = list(parts[0].coords)
        gap = math.dist(ring[0], ring[-1])
        if gap > want["maxRepairGapDeg"]:
            print(f"  {iso:7} {name}: gap {gap:.3f} deg is too large to bridge")
            continue
        poly = Polygon(ring).buffer(0)  # buffer(0) fixes any self-touching left by the bridge
        states[iso] = {"name": name, "iso": iso, "geom": poly}
        print(f"  {iso:7} {name} (repaired: {len(ways) - sum(i in lines for i in ways)} way(s) missing, "
              f"bridged a {gap * 111:.1f} km gap)")


def main() -> None:
    pbf = ROOT / "data" / "raw" / Path(CFG["osm"]["geofabrik"]).name
    if not pbf.exists():
        sys.exit(f"Missing {pbf}. Run: py pipeline/fetch_osm.py geofabrik")
    want = CFG["states"]
    wkb = osmium.geom.WKBFactory()
    states = {}
    print(f"Reading boundaries from {pbf.name} ...", flush=True)
    fp = (osmium.FileProcessor(str(pbf))
          .with_areas(osmium.filter.TagFilter(("boundary", "administrative")))
          .with_filter(osmium.filter.TagFilter(("admin_level", want["adminLevel"]))))
    for obj in fp:
        if not obj.is_area() or obj.from_way():
            continue
        tags = {t.k: t.v for t in obj.tags}
        iso = tags.get("ISO3166-2", "")
        if tags.get("boundary") != "administrative" or not iso.startswith(want["isoPrefix"]):
            continue
        geom = shapely.from_wkb(wkb.create_multipolygon(obj))
        name = tags.get("name:en") or tags.get("name")
        states[iso] = {"name": name, "iso": iso, "geom": geom}
        print(f"  {iso:7} {name}", flush=True)

    repair_missing(pbf, want, states)
    print(f"Found {len(states)} states (expected {want['expectedCount']})")
    if len(states) != want["expectedCount"]:
        print("  WARNING: state count differs; check missing states above.")

    OUT.mkdir(parents=True, exist_ok=True)
    PUBLIC.mkdir(parents=True, exist_ok=True)
    full, simple = [], []
    for iso, s in sorted(states.items(), key=lambda kv: kv[1]["name"]):
        slug = slugify(s["name"])
        props = {"name": s["name"], "iso": iso, "slug": slug}
        full.append({"type": "Feature", "properties": props, "geometry": mapping(s["geom"])})
        # cut line = state + buffer, so routes and the map don't stop dead at the border
        region = shapely.buffer(s["geom"], want["bufferDeg"]).simplify(0.002)
        d = OUT / slug
        d.mkdir(parents=True, exist_ok=True)
        (d / "region.geojson").write_text(json.dumps(
            {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": props, "geometry": mapping(region)}]}),
            encoding="utf-8")
        light = shapely.set_precision(s["geom"].simplify(want["clientSimplifyDeg"]), 0.0001)
        simple.append({"type": "Feature", "properties": props, "geometry": mapping(light)})
    (OUT / "boundaries.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": full}), encoding="utf-8")
    client = json.dumps({"type": "FeatureCollection", "features": simple}, separators=(",", ":"))
    (PUBLIC / "states.geojson").write_text(client, encoding="utf-8")
    print(f"Wrote {len(full)} state regions to {OUT}; public/states.geojson is {len(client) / 1e3:.0f} KB")


if __name__ == "__main__":
    main()
