"""
pipeline/06_enrich_lots.py
Reverse-geocode every lot centroid with Mapbox to get:
  - Real street address
  - Nearby business name (if a named POI is within 100 m)
Run via:  railway run python pipeline/06_enrich_lots.py
"""
import math
import os
import time

import psycopg2
import psycopg2.extras
import requests
from tqdm import tqdm

MAPBOX_TOKEN = os.environ.get(
    "MAPBOX_TOKEN",
    "REDACTED_MAPBOX_TOKEN",
)

DB_URL = (
    os.environ.get("DATABASE_URL")
    or os.environ.get("DATABASE_PUBLIC_URL")
    or os.environ.get("RAILWAY_DATABASE_URL")
)

SESSION = requests.Session()
SESSION.headers["User-Agent"] = "SPOTTR/1.0"


# ── helpers ──────────────────────────────────────────────────────────────────

def haversine_m(lat1, lng1, lat2, lng2):
    R = 6_371_000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def mapbox_get(lng, lat, types, limit=3):
    url = f"https://api.mapbox.com/geocoding/v5/mapbox.places/{lng},{lat}.json"
    r = SESSION.get(url, params={"access_token": MAPBOX_TOKEN, "types": types, "limit": limit}, timeout=10)
    r.raise_for_status()
    return r.json().get("features", [])


def enrich_one(lat, lng):
    """Return (name, address) for the given coordinate."""
    # ── 1. street address ────────────────────────────────────────────────────
    address = None
    try:
        feats = mapbox_get(lng, lat, "address", limit=1)
        if feats:
            # place_name looks like "123 Main St, Hartford, Connecticut 06103, United States"
            # We want just the street portion
            place = feats[0].get("place_name", "")
            address = place.split(",")[0].strip() if place else None
    except Exception:
        pass

    # ── 2. nearby POI (business within 100 m) ────────────────────────────────
    poi_name = None
    try:
        feats = mapbox_get(lng, lat, "poi", limit=5)
        for f in feats:
            flng, flat = f["geometry"]["coordinates"]
            dist = haversine_m(lat, lng, flat, flng)
            if dist <= 100:
                poi_name = f.get("text") or f.get("place_name", "").split(",")[0]
                break
    except Exception:
        pass

    name = poi_name or address or "Parking Lot"
    return name, address


# ── main ─────────────────────────────────────────────────────────────────────

def main():
    if not DB_URL:
        raise RuntimeError("No DATABASE_URL found in environment")

    # psycopg2 doesn't accept sslmode=no-verify; map to require
    clean_url = DB_URL.replace("sslmode=no-verify", "sslmode=require")
    conn = psycopg2.connect(clean_url)
    cur = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)

    cur.execute(
        """
        SELECT id, lat, lng, name, address
        FROM   lots
        WHERE  lat IS NOT NULL AND lng IS NOT NULL
        ORDER  BY id
        """
    )
    rows = cur.fetchall()

    to_enrich = [r for r in rows if r["name"] is None or r["address"] is None]
    print(f"Total lots: {len(rows)}  |  Need enrichment: {len(to_enrich)}")

    ok = 0
    err = 0
    upd_cur = conn.cursor()

    for row in tqdm(to_enrich, unit="lot"):
        try:
            name, address = enrich_one(row["lat"], row["lng"])

            upd_cur.execute(
                """
                UPDATE lots
                SET    name    = COALESCE(name, %s),
                       address = COALESCE(address, %s)
                WHERE  id = %s
                """,
                (name, address, row["id"]),
            )
            conn.commit()
            ok += 1
        except Exception as exc:
            print(f"\n  ERR {row['id']}: {exc}")
            conn.rollback()
            err += 1

        time.sleep(0.06)   # ~16 req/s — well within Mapbox free-tier limits

    conn.close()
    print(f"\nDone — updated {ok} lots ({err} errors)")


if __name__ == "__main__":
    main()
