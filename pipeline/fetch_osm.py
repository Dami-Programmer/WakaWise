"""Download the country's raw OpenStreetMap data (state boundaries, roads, places).

Source: Geofabrik country extract (Nigeria, ~715 MB). Resumable: if the connection drops it
retries, and it only resumes a partial file if the server still has the same daily version.

Usage: py pipeline/fetch_osm.py geofabrik
Output: data/raw/nigeria-latest.osm.pbf
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CFG = json.loads((ROOT / "pipeline" / "config.json").read_text(encoding="utf-8"))
RAW = ROOT / "data" / "raw"
UA = {"User-Agent": "offline-map-pipeline/0.1"}


def stream(resp, f, have: int, total: int) -> int:
    done, last = have, 0.0
    while chunk := resp.read(1 << 20):
        f.write(chunk)
        done += len(chunk)
        now = time.time()
        if now - last > 2:
            pct = f"{done / total * 100:5.1f}%" if total else ""
            print(f"  {done / 1e6:8.1f} MB {pct}", flush=True)
            last = now
    return done


def fetch_geofabrik(attempts: int = 20) -> Path:
    """Download with resume. The connection may drop silently, so check the size and retry."""
    url = CFG["osm"]["geofabrik"]
    dest = RAW / url.rsplit("/", 1)[1]
    part = dest.with_suffix(dest.suffix + ".part")
    version_file = dest.with_suffix(dest.suffix + ".part.version")  # Last-Modified of the file being resumed
    for attempt in range(1, attempts + 1):
        have = part.stat().st_size if part.exists() else 0
        version = version_file.read_text().strip() if version_file.exists() else ""
        if have and not version:
            have = 0  # can't prove the partial file matches the server's current version
        headers = dict(UA)
        if have:
            # If-Range: the server sends the rest only if the file is unchanged, else the whole new file
            headers.update({"Range": f"bytes={have}-", "If-Range": version})
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60) as r:
                if have and r.status != 206:
                    have = 0  # file changed upstream (or range ignored); start over
                version_file.write_text(r.headers.get("Last-Modified", ""))
                total = have + int(r.headers.get("Content-Length", 0))
                print(f"Attempt {attempt}: {url} ({total / 1e6:.0f} MB, resuming at {have / 1e6:.0f} MB)", flush=True)
                with open(part, "ab" if have else "wb") as f:
                    done = stream(r, f, have, total)
        except urllib.error.HTTPError as e:
            if e.code == 416 and have:  # range past the end: the .part is already complete
                done = total = have
            else:
                raise
        except (OSError, TimeoutError) as e:
            print(f"  connection dropped ({e}); retrying in 10s", flush=True)
            time.sleep(10)
            continue
        if total and done == total:
            os.replace(part, dest)
            version_file.unlink(missing_ok=True)
            return dest
        print(f"  got {done / 1e6:.0f} of {total / 1e6:.0f} MB; retrying in 10s", flush=True)
        time.sleep(10)
    sys.exit(f"Download incomplete after {attempts} attempts. Run again to resume ({part}).")


def main() -> None:
    src = sys.argv[1] if len(sys.argv) > 1 else ""
    RAW.mkdir(parents=True, exist_ok=True)
    if src != "geofabrik":
        sys.exit("Usage: py pipeline/fetch_osm.py geofabrik")
    out = fetch_geofabrik()
    print(f"Saved {out} ({out.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
