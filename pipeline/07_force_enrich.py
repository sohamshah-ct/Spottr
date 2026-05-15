"""
pipeline/07_force_enrich.py
Force re-enrich ALL 692 lots with:
  - Real Mapbox reverse-geocoded street address
  - City + State from Mapbox context
  - POI name within 100m (Target, BJ's, Costco, etc.) — takes priority as lot name
  - Falls back to street address if no named POI found

Run: python pipeline/07_force_enrich.py
Requires: pip install psycopg2-binary requests tqdm
"""
import math
import os
import time

import psycopg2
import psycopg2.extras
import requests
from tqdm import tqdm

MAPBOX_TOKEN = (
    os.environ.get("MAPBOX_TOKEN")
    or "REDACTED_MAPBOX_TOKEN"
)

DB_URL = (
    os.environ.get("DATABASE_URL")
    or os.environ.get("DATABASE_PUBLIC_URL")
    or os.environ.get("RAILWAY_DATABASE_URL")
    or "postgresql://postgres:REDACTED_DB_PASSWORD@yamabiko.proxy.rlwy.net:38603/railway?sslmode=no-verify"
)

SESSION = requests.Session()
SESSION.headers["User-Agent"] = "SPOTTR/1.0"


def haversine_m(lat1, lng1, lat2, lng2):
    R = 6_371_000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def mapbox_get(lng, lat, types, limit=5):
    url = f"https://api.mapbox.com/geocoding/v5/mapbox.places/{lng},{lat}.json"
    r = SESSION.get(
        url,
        params={"access_token": MAPBOX_TOKEN, "types": types, "limit": limit},
        timeout=12,
    )
    r.raise_for_status()
    return r.json().get("features", [])


def extract_city_state(context):
    """Pull city and state from a Mapbox context array."""
    city = None
    state = None
    for item in (context or []):
        id_type = item.get("id", "")
        if id_type.startswith("place."):
            city = item.get("text")
        elif id_type.startswith("region."):
            # e.g. "Connecticut" — shorten to abbreviation if known
            full = item.get("text", "")
            abbr = item.get("short_code", "")  # "US-CT" → we want "CT"
            if abbr and "-" in abbr:
                state = abbr.split("-")[-1]
            else:
                state = full
    return city, state


def enrich_one(lat, lng):
    """Return (name, address, city, state) for the given coordinate."""
    address = None
    city = None
    state = None
    poi_name = None

    # ── 1. reverse-geocode for street address + city/state ───────
    try:
        feats = mapbox_get(lng, lat, "address", limit=1)
        if feats:
            f = feats[0]
            place = f.get("place_name", "")
            # "123 Main St, South Windsor, Connecticut 06074, United States"
            address = place.split(",")[0].strip() if place else None
            city, state = extract_city_state(f.get("context", []))
    except Exception:
        pass

    # ── 2. POI within 100 m ───────────────────────────────────────
    try:
        feats = mapbox_get(lng, lat, "poi", limit=8)
        for f in feats:
            flng, flat = f["geometry"]["coordinates"]
            dist = haversine_m(lat, lng, flat, flng)
            if dist <= 100:
                candidate = f.get("text") or f.get("place_name", "").split(",")[0]
                if candidate:
                    poi_name = candidate
                    # Also grab city/state from this feature if not already set
                    if not city:
                        city, state = extract_city_state(f.get("context", []))
                    break
    except Exception:
        pass

    name = poi_name or address or "Parking Lot"
    return name, address, city, state


def main():
    clean_url = DB_URL.replace("sslmode=no-verify", "sslmode=require")
    conn = psycopg2.connect(clean_url)
    cur = conn.cursor(cursor_factory=psycopg2.extras.DictCursor)

    cur.execute(
        "SELECT id, lat, lng, name, address FROM lots WHERE lat IS NOT NULL AND lng IS NOT NULL ORDER BY id"
    )
    rows = cur.fetchall()
    print(f"Total lots to enrich: {len(rows)}")

    ok = 0
    err = 0
    upd = conn.cursor()

    for row in tqdm(rows, unit="lot"):
        try:
            name, address, city, state = enrich_one(row["lat"], row["lng"])
            upd.execute(
                """
                UPDATE lots
                SET    name    = %s,
                       address = COALESCE(%s, address),
                       city    = COALESCE(%s, city),
                       state   = COALESCE(%s, state)
                WHERE  id = %s
                """,
                (name, address, city, state, row["id"]),
            )
            conn.commit()
            ok += 1
        except Exception as exc:
            print(f"\n  ERR {row['id']}: {exc}")
            conn.rollback()
            err += 1

        time.sleep(0.07)  # ~14 req/s — within Mapbox free-tier

    conn.close()
    print(f"\nDone — updated {ok} lots ({err} errors)")


if __name__ == "__main__":
    main()
