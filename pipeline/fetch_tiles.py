"""Cut each state's vector tiles out of the Protomaps daily planet build.

`pmtiles extract` uses HTTP range requests, so only that state's tiles are downloaded,
not the whole ~140 GB planet file. Each state is cut along data/states/<slug>/region.geojson
(the state border plus a small buffer). A dry run measures the size first: if the state is
over tiles.maxTilesMB at full detail, it is cut one zoom level lower (MapLibre over-zooms).

Needs tools/pmtiles/pmtiles.exe (go-pmtiles release from github.com/protomaps/go-pmtiles).
Usage: py pipeline/fetch_tiles.py [slug ...]        (default: every state)
Output: data/states/<slug>/tiles.pmtiles and tiles.meta.json
"""
import json
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CFG = json.loads((ROOT / "pipeline" / "config.json").read_text(encoding="utf-8"))
STATES_DIR = ROOT / "data" / "states"
PMTILES = ROOT / "tools" / "pmtiles" / ("pmtiles.exe" if sys.platform == "win32" else "pmtiles")
UA = {"User-Agent": "offline-map-pipeline/0.1"}


def latest_build_key() -> str:
    req = urllib.request.Request(CFG["tiles"]["buildsIndex"], headers=UA)
    with urllib.request.urlopen(req) as r:
        return json.load(r)[-1]["key"]


def extract(url: str, region: Path, out: Path, maxzoom: int, dry_run: bool) -> float:
    """Run pmtiles extract; returns the archive size in MB."""
    cmd = [str(PMTILES), "extract", url, str(out), f"--region={region}", f"--maxzoom={maxzoom}"]
    if dry_run:
        cmd.append("--dry-run")
    res = subprocess.run(cmd, capture_output=True, text=True)
    log = res.stdout + res.stderr  # pmtiles writes its log to stdout when not attached to a terminal
    if res.returncode != 0:
        raise RuntimeError(f"pmtiles exited with {res.returncode}:\n{log[-2000:]}")
    m = re.search(r"archive size of ([\d.]+) (\w?B)", log)
    if not m:
        raise RuntimeError("Couldn't read archive size from pmtiles output:\n" + log[-1000:])
    return float(m.group(1)) * {"B": 1e-6, "kB": 1e-3, "MB": 1, "GB": 1e3}[m.group(2)]


def main() -> None:
    if not PMTILES.exists():
        sys.exit(f"Missing {PMTILES}. Download go-pmtiles from https://github.com/protomaps/go-pmtiles/releases")
    t = CFG["tiles"]
    key = latest_build_key() if t["build"] == "latest" else t["build"]
    url = t["buildUrl"].format(key=key)
    slugs = sys.argv[1:] or sorted(d.name for d in STATES_DIR.iterdir() if (d / "region.geojson").exists())
    print(f"Protomaps build {key}; {len(slugs)} state(s)", flush=True)
    for slug in slugs:
        d = STATES_DIR / slug
        region, out = d / "region.geojson", d / "tiles.pmtiles"
        zoom = t["maxzoom"]
        size = extract(url, region, out, zoom, dry_run=True)
        if size > t["maxTilesMB"]:
            zoom -= 1
        size = extract(url, region, out, zoom, dry_run=False)
        meta = {"build": key, "source": url, "maxzoom": zoom, "bytes": out.stat().st_size}
        (d / "tiles.meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
        print(f"  {slug:26} zoom {zoom}  {meta['bytes'] / 1e6:6.1f} MB", flush=True)


if __name__ == "__main__":
    main()
