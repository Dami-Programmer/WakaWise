"""List every built state package, so the page can show the download size before it starts.

Usage:  py pipeline/build_index.py
Output: data/states/index.json
"""
import json
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATES_DIR = ROOT / "data" / "states"
PACKAGE_FILES = ["tiles.pmtiles", "graph.bin", "graph.json", "search.json"]


def main() -> None:
    states, missing = [], []
    for d in sorted(p for p in STATES_DIR.iterdir() if p.is_dir()):
        region = json.loads((d / "region.geojson").read_text(encoding="utf-8"))["features"][0]["properties"]
        files = {f: (d / f).stat().st_size for f in PACKAGE_FILES if (d / f).exists()}
        # tiles.meta.json is written only after a tile download completes
        if len(files) != len(PACKAGE_FILES) or not (d / "tiles.meta.json").exists():
            missing.append(d.name)
            continue
        graph = json.loads((d / "graph.json").read_text(encoding="utf-8"))
        tiles = json.loads((d / "tiles.meta.json").read_text(encoding="utf-8"))
        states.append({
            "slug": d.name, "name": region["name"], "iso": region["iso"], "bbox": graph["bbox"],
            "files": files, "bytes": sum(files.values()),
            "tilesBuild": tiles["build"], "maxzoom": tiles["maxzoom"], "built": graph["built"],
        })
    index = {"version": 1, "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "states": states}
    (STATES_DIR / "index.json").write_text(json.dumps(index, indent=1), encoding="utf-8")
    total = sum(s["bytes"] for s in states)
    print(f"Indexed {len(states)} states, {total / 1e9:.2f} GB in total")
    if missing:
        print(f"  incomplete (not listed): {', '.join(missing)}")


if __name__ == "__main__":
    main()
