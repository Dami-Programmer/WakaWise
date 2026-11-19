"""Download Overture Maps places (businesses, landmarks) inside the country.

Overture Places is openly licensed (CDLA-Permissive-2.0), so it may be stored and used offline.
DuckDB reads Overture's GeoParquet files on S3 and, thanks to the bbox column statistics,
downloads only the parts that overlap the country's bounding box.

Usage:  py pipeline/fetch_places.py
Output: data/raw/overture_places.parquet  (one row per open place, with lon/lat)
"""
import json
import sys
import time
import urllib.request
from pathlib import Path

import duckdb
import shapely
import shapely.geometry

ROOT = Path(__file__).resolve().parent.parent
CFG = json.loads((ROOT / "pipeline" / "config.json").read_text(encoding="utf-8"))
OUT = ROOT / "data" / "raw" / "overture_places.parquet"


def latest_release() -> str:
    req = urllib.request.Request(CFG["places"]["stacCatalog"], headers={"User-Agent": "offline-map-pipeline/0.1"})
    with urllib.request.urlopen(req) as r:
        return json.load(r)["latest"]


def main() -> None:
    states = ROOT / "public" / "states.geojson"
    if not states.exists():
        sys.exit("Missing public/states.geojson. Run: py pipeline/build_states.py")
    feats = json.loads(states.read_text(encoding="utf-8"))["features"]
    w, s, e, n = shapely.total_bounds([shapely.geometry.shape(f["geometry"]) for f in feats])
    pad = CFG["states"]["bufferDeg"]
    w, s, e, n = w - pad, s - pad, e + pad, n + pad
    release = CFG["places"]["release"]
    if release == "latest":
        release = latest_release()
    src = f"s3://overturemaps-us-west-2/release/{release}/theme=places/type=place/*"
    print(f"Overture release {release}; bbox {w:.2f},{s:.2f},{e:.2f},{n:.2f}", flush=True)

    con = duckdb.connect()
    con.sql("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';")
    t0 = time.time()
    con.sql(f"""
        COPY (
          SELECT
            id,
            names."primary"                    AS name,
            coalesce(basic_category, taxonomy."primary") AS category,
            brand.names."primary"              AS brand,
            confidence,
            addresses[1].freeform              AS street,
            addresses[1].locality              AS locality,
            (bbox.xmin + bbox.xmax) / 2        AS lon,
            (bbox.ymin + bbox.ymax) / 2        AS lat
          FROM read_parquet('{src}', hive_partitioning = 1)
          WHERE bbox.xmin BETWEEN {w} AND {e}
            AND bbox.ymin BETWEEN {s} AND {n}
            AND names."primary" IS NOT NULL
            AND coalesce(operating_status, 'open') = 'open'
            AND confidence >= {CFG['places']['minConfidence']}
        ) TO '{OUT.as_posix()}' (FORMAT parquet, COMPRESSION zstd)
    """)
    count = con.sql(f"SELECT count(*) FROM '{OUT.as_posix()}'").fetchall()[0][0]
    print(f"Saved {count} places to {OUT} ({OUT.stat().st_size / 1e6:.1f} MB) in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
