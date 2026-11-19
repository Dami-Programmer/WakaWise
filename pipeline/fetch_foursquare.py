"""Download Foursquare Open Source Places in Nigeria (Apache 2.0): more shops, businesses and
landmarks to search, on top of OpenStreetMap and Overture.

The dataset is free but "gated" on Hugging Face, so it needs a (free) Hugging Face account:
  1. Sign in at https://huggingface.co and accept the terms on
     https://huggingface.co/datasets/foursquare/fsq-os-places
  2. Create a "Read" token at https://huggingface.co/settings/tokens, then either set the
     HF_TOKEN environment variable or save the token in %USERPROFILE%/.cache/huggingface/token
Then: py pipeline/fetch_foursquare.py   -> data/raw/foursquare_places.parquet
and   py pipeline/add_places.py         (merges Overture and Foursquare into search.json)
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "raw" / "foursquare_places.parquet"
DATASET = "foursquare/fsq-os-places"


def token() -> str:
    t = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    if t:
        return t.strip()
    homes = [Path.home() / ".cache" / "huggingface"]
    if os.environ.get("HF_HOME"):
        homes.insert(0, Path(os.environ["HF_HOME"]))
    for h in homes:
        if (h / "token").is_file():
            return (h / "token").read_text().strip()
    sys.exit(__doc__ + "\nNo Hugging Face token found.")


def latest_release(tok: str) -> str:
    url = f"https://huggingface.co/api/datasets/{DATASET}/tree/main/release"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {tok}", "User-Agent": "wakawise-pipeline"})
    try:
        with urllib.request.urlopen(req) as r:
            dirs = [x["path"].split("/")[-1] for x in json.load(r) if x["type"] == "directory"]
    except urllib.error.HTTPError as e:
        sys.exit(f"Hugging Face said {e.code}. Did you accept the dataset terms on https://huggingface.co/datasets/{DATASET} ?")
    return max(d for d in dirs if d.startswith("dt="))


def main() -> None:
    tok = token()
    release = latest_release(tok)
    src = f"hf://datasets/{DATASET}/release/{release}/places/parquet/*.parquet"
    print(f"Foursquare release {release}", flush=True)
    con = duckdb.connect()
    con.sql("INSTALL httpfs; LOAD httpfs;")
    con.execute(f"CREATE SECRET hf (TYPE HUGGINGFACE, TOKEN '{tok}')")
    t0 = time.time()
    # same columns as overture_places.parquet, so add_places.py can merge both
    con.sql(f"""
        COPY (
          SELECT
            fsq_place_id                                               AS id,
            name,
            lower(regexp_replace(fsq_category_labels[1], '^.*> ', '')) AS category,
            NULL::VARCHAR                                              AS brand,
            CASE WHEN date_refreshed >= '2024-01-01' THEN 0.85 ELSE 0.7 END AS confidence,
            address                                                    AS street,
            locality,
            longitude                                                  AS lon,
            latitude                                                   AS lat
          FROM read_parquet('{src}')
          WHERE country = 'NG'
            AND name IS NOT NULL
            AND date_closed IS NULL
            AND latitude IS NOT NULL
            AND coalesce(date_refreshed, date_created) >= '2021-01-01'
        ) TO '{OUT.as_posix()}' (FORMAT parquet, COMPRESSION zstd)
    """)
    count = con.sql(f"SELECT count(*) FROM '{OUT.as_posix()}'").fetchall()[0][0]
    print(f"Saved {count} places to {OUT} ({OUT.stat().st_size / 1e6:.1f} MB) in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
