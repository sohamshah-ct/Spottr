"""
SPOTTR Pipeline 02 — Hartford, CT City Open Data Scraper
Source: Hartford GIS open data portal
  - Parking lots: https://data.hartford.gov/resource/tqtu-wb2c.geojson
  - Search: https://data.hartford.gov/search?q=parking

Enriches existing OSM lots with pricing, hours, address data.
Inserts new lots not found in OSM.

Usage:
  python pipeline/02_city_scrapers/hartford.py
"""

import os
import sys
import json
import math
import requests
import psycopg2
import psycopg2.extras
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '../../backend/.env'))

DATABASE_URL = (
    os.environ.get('DATABASE_PUBLIC_URL') or
    os.environ.get('DATABASE_URL', '')
)
if 'railway.internal' in DATABASE_URL:
    raise RuntimeError("Use: railway run python pipeline/02_city_scrapers/hartford.py")

HARTFORD_GEOJSON_URL = "https://data.hartford.gov/resource/tqtu-wb2c.geojson"
HARTFORD_BBOX = (41.74, -72.70, 41.78, -72.67)  # south, west, north, east

HEADERS = {'Accept': '*/*', 'User-Agent': 'SPOTTR/1.0'}


def haversine_meters(lat1, lng1, lat2, lng2):
    """Distance in meters between two lat/lng points."""
    R = 6371000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)
    a = math.sin(dphi/2)**2 + math.cos(phi1)*math.cos(phi2)*math.sin(dlambda/2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def fetch_hartford_lots():
    """Fetch Hartford parking lot GeoJSON with pagination."""
    lots = []
    limit = 1000
    offset = 0
    while True:
        url = f"{HARTFORD_GEOJSON_URL}?$limit={limit}&$offset={offset}"
        resp = requests.get(url, headers=HEADERS, timeout=30)
        if resp.status_code == 404:
            break
        resp.raise_for_status()
        data = resp.json()
        features = data.get('features', [])
        if not features:
            break
        lots.extend(features)
        if len(features) < limit:
            break
        offset += limit
        print(f"  Fetched {len(lots)} features so far...")
    return lots


def extract_centroid(geometry):
    """Extract centroid lat/lng from GeoJSON geometry."""
    if not geometry:
        return None, None
    gtype = geometry.get('type', '')
    coords = geometry.get('coordinates', [])
    if gtype == 'Point':
        return coords[1], coords[0]
    elif gtype == 'Polygon' and coords:
        ring = coords[0]
        lats = [c[1] for c in ring]
        lngs = [c[0] for c in ring]
        return sum(lats)/len(lats), sum(lngs)/len(lngs)
    elif gtype == 'MultiPolygon' and coords:
        ring = coords[0][0]
        lats = [c[1] for c in ring]
        lngs = [c[0] for c in ring]
        return sum(lats)/len(lats), sum(lngs)/len(lngs)
    return None, None


def parse_hartford_feature(feature):
    """Parse a Hartford GeoJSON feature into a lot dict."""
    props = feature.get('properties', {}) or {}
    geometry = feature.get('geometry', {})

    lat, lng = extract_centroid(geometry)

    # Build address
    address_parts = [
        props.get('address') or props.get('street_address') or props.get('location_address'),
    ]
    address = ', '.join(p for p in address_parts if p)

    # Determine lot type
    lot_type_raw = (props.get('lot_type') or props.get('facility_type') or '').lower()
    if 'garage' in lot_type_raw or 'structure' in lot_type_raw:
        lot_type = 'garage'
    elif 'street' in lot_type_raw or 'meter' in lot_type_raw:
        lot_type = 'street'
    else:
        lot_type = 'surface'

    # Capacity
    try:
        total_spaces = int(props.get('capacity') or props.get('spaces') or props.get('total_spaces') or 0) or None
    except (ValueError, TypeError):
        total_spaces = None

    # Pricing
    fee_raw = (props.get('fee') or props.get('rate') or props.get('parking_type') or '').lower()
    if 'free' in fee_raw or fee_raw == 'no':
        pricing = {'type': 'free'}
    elif fee_raw:
        pricing = {'type': 'metered', 'raw': fee_raw}
    else:
        pricing = None

    # Hours
    hours_raw = props.get('hours') or props.get('operating_hours') or props.get('hours_of_operation')
    hours = {'raw': hours_raw} if hours_raw else None

    # Name
    name = (props.get('name') or props.get('facility_name') or
            props.get('lot_name') or props.get('location_name'))

    return {
        'lat': lat,
        'lng': lng,
        'name': name,
        'lot_type': lot_type,
        'address': address or None,
        'city': props.get('city') or 'Hartford',
        'state': props.get('state') or 'CT',
        'country': 'US',
        'total_spaces': total_spaces,
        'pricing': json.dumps(pricing) if pricing else None,
        'hours': json.dumps(hours) if hours else None,
        'source': 'hartford_gis',
    }


def find_matching_osm_lot(cur, lat, lng, radius_meters=75):
    """Find the closest OSM lot within radius_meters using bounding box pre-filter."""
    if lat is None or lng is None:
        return None
    # Rough degree offset for radius
    dlat = radius_meters / 111000
    dlng = radius_meters / (111000 * math.cos(math.radians(lat)))

    cur.execute("""
        SELECT id, lat, lng FROM lots
        WHERE source = 'osm'
          AND lat BETWEEN %s AND %s
          AND lng BETWEEN %s AND %s
    """, (lat - dlat, lat + dlat, lng - dlng, lng + dlng))

    rows = cur.fetchall()
    if not rows:
        return None

    best_id, best_dist = None, float('inf')
    for row_id, row_lat, row_lng in rows:
        if row_lat is None or row_lng is None:
            continue
        dist = haversine_meters(lat, lng, row_lat, row_lng)
        if dist < best_dist:
            best_dist = dist
            best_id = row_id

    return best_id if best_dist <= radius_meters else None


ENRICH_SQL = """
UPDATE lots SET
    name         = COALESCE(lots.name, %(name)s),
    address      = COALESCE(lots.address, %(address)s),
    city         = COALESCE(lots.city, %(city)s),
    state        = COALESCE(lots.state, %(state)s),
    total_spaces = COALESCE(lots.total_spaces, %(total_spaces)s),
    pricing      = COALESCE(lots.pricing, %(pricing)s::jsonb),
    hours        = COALESCE(lots.hours, %(hours)s::jsonb),
    updated_at   = NOW()
WHERE id = %(lot_id)s;
"""

INSERT_SQL = """
INSERT INTO lots (name, lot_type, address, city, state, country,
                  lat, lng, total_spaces, pricing, hours, source)
VALUES (%(name)s, %(lot_type)s, %(address)s, %(city)s, %(state)s, %(country)s,
        %(lat)s, %(lng)s, %(total_spaces)s,
        %(pricing)s::jsonb, %(hours)s::jsonb, %(source)s)
ON CONFLICT DO NOTHING;
"""


def run():
    print("Hartford GIS parking scraper")
    print("Fetching data from Hartford open data portal...")

    try:
        features = fetch_hartford_lots()
        print(f"Fetched {len(features)} features from Hartford GIS.")
    except Exception as e:
        print(f"Hartford GIS fetch failed: {e}")
        print("Trying alternative: querying OSM lots already in DB for Hartford enrichment...")
        features = []

    if not features:
        print("No Hartford GIS data available — OSM data already loaded, skipping enrichment.")
        return

    conn = psycopg2.connect(DATABASE_URL, sslmode='require')
    conn.autocommit = False
    cur = conn.cursor()

    enriched = 0
    inserted = 0
    skipped = 0

    for feature in features:
        lot = parse_hartford_feature(feature)
        if lot['lat'] is None:
            skipped += 1
            continue

        # Check if within Hartford bbox
        slat, wlng, nlat, elng = HARTFORD_BBOX
        if not (slat <= lot['lat'] <= nlat and wlng <= lot['lng'] <= elng):
            skipped += 1
            continue

        match_id = find_matching_osm_lot(cur, lot['lat'], lot['lng'])

        if match_id:
            cur.execute(ENRICH_SQL, {**lot, 'lot_id': match_id})
            enriched += 1
        else:
            cur.execute(INSERT_SQL, lot)
            inserted += 1

    conn.commit()

    cur.execute("SELECT COUNT(*) FROM lots WHERE city = 'Hartford'")
    total = cur.fetchone()[0]

    cur.close()
    conn.close()

    print(f"OK Enriched {enriched} OSM lots with Hartford data")
    print(f"OK Inserted {inserted} new Hartford-only lots")
    print(f"OK Skipped {skipped} (no coords or outside bbox)")
    print(f"OK Total Hartford lots in DB: {total}")


if __name__ == '__main__':
    run()
