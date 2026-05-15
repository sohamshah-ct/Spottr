"""
SPOTTR Pipeline 01 — OpenStreetMap Parking Lot Ingest
Pulls every parking lot from OSM via Overpass API → inserts into lots table.

Usage:
  python pipeline/01_osm_ingest.py --country US
  python pipeline/01_osm_ingest.py --bbox 41.74,-72.70,41.78,-72.67   # Hartford downtown
"""

import os
import sys
import json
import time
import argparse
import requests
import psycopg2
import psycopg2.extras
from dotenv import load_dotenv
from tqdm import tqdm

load_dotenv(os.path.join(os.path.dirname(__file__), '../backend/.env'))

# Railway injects DATABASE_PUBLIC_URL — prefer it over the .env internal URL
DATABASE_URL = (
    os.environ.get('DATABASE_PUBLIC_URL') or
    os.environ.get('DATABASE_URL', '')
)
if 'railway.internal' in DATABASE_URL:
    raise RuntimeError("DATABASE_URL is the internal Railway URL — not reachable locally. "
                       "Run via: railway run python pipeline/01_osm_ingest.py, "
                       "or set DATABASE_PUBLIC_URL in .env")
OVERPASS_URL = "https://overpass-api.de/api/interpreter"

# US bounding box
US_BBOX = "24.396308,-125.000000,49.384358,-66.934570"

# Hartford downtown bbox (MVP demo city)
HARTFORD_BBOX = "41.74,-72.70,41.78,-72.67"


def build_query(bbox=None):
    bbox_filter = f"[bbox:{bbox}]" if bbox else ""
    return f"""
[out:json][timeout:300]{bbox_filter};
(
  way["amenity"="parking"];
  relation["amenity"="parking"];
  way["amenity"="parking_space"];
  way["building"="parking"];
  way["parking"="multi-storey"];
  way["parking"="surface"];
);
out geom;
"""


def fetch_osm(query, retries=3):
    for attempt in range(retries):
        try:
            print(f"Fetching from Overpass API (attempt {attempt + 1})...")
            resp = requests.post(
                OVERPASS_URL,
                data={'data': query},
                headers={'Accept': '*/*', 'User-Agent': 'SPOTTR/1.0'},
                timeout=360
            )
            resp.raise_for_status()
            return resp.json()
        except requests.exceptions.Timeout:
            print("Overpass timed out, retrying in 30s...")
            time.sleep(30)
        except Exception as e:
            print(f"Error: {e}")
            if attempt == retries - 1:
                raise
            time.sleep(10)


def compute_bbox_and_centroid(nodes):
    """Given a list of {lat, lon} nodes, return bbox and centroid."""
    if not nodes:
        return None, None, None, None, None, None
    lats = [n['lat'] for n in nodes]
    lngs = [n['lon'] for n in nodes]
    north, south = max(lats), min(lats)
    east, west = max(lngs), min(lngs)
    centroid_lat = (north + south) / 2
    centroid_lng = (east + west) / 2
    return centroid_lat, centroid_lng, north, south, east, west


def nodes_to_wkt(nodes):
    """Convert node list to WKT POLYGON string."""
    if not nodes or len(nodes) < 3:
        return None
    coords = " ".join(f"{n['lon']} {n['lat']}" for n in nodes)
    # Close the ring if not already closed
    first = f"{nodes[0]['lon']} {nodes[0]['lat']}"
    last = f"{nodes[-1]['lon']} {nodes[-1]['lat']}"
    if first != last:
        coords += f" {first}"
    return f"POLYGON(({coords}))"


def parse_element(el):
    """Parse an OSM way/relation into a lot dict."""
    tags = el.get('tags', {})

    # Determine lot type
    parking_tag = tags.get('parking', '')
    building_tag = tags.get('building', '')
    if parking_tag == 'multi-storey' or building_tag == 'parking':
        lot_type = 'garage'
    elif parking_tag in ('surface', 'lane', 'rooftop'):
        lot_type = 'surface'
    else:
        lot_type = 'surface'  # default

    # Get geometry nodes
    nodes = el.get('geometry', [])
    if not nodes and el.get('type') == 'relation':
        # For relations, try to get member geometries
        members = el.get('members', [])
        for m in members:
            if m.get('geometry'):
                nodes = m['geometry']
                break

    lat, lng, north, south, east, west = compute_bbox_and_centroid(nodes)
    geometry_wkt = nodes_to_wkt(nodes)

    # Parse capacity
    try:
        total_spaces = int(tags.get('capacity', 0)) or None
    except (ValueError, TypeError):
        total_spaces = None

    # Parse levels
    try:
        levels = int(tags.get('parking:levels', tags.get('building:levels', 1)))
    except (ValueError, TypeError):
        levels = 1

    # Parse fee/pricing
    fee = tags.get('fee', '')
    pricing = None
    if fee == 'no':
        pricing = {'type': 'free'}
    elif fee in ('yes', 'interval', 'daily'):
        charge = tags.get('charge', '')
        pricing = {'type': 'metered', 'raw': charge}

    # Parse hours
    opening_hours = tags.get('opening_hours', '')
    hours = {'raw': opening_hours} if opening_hours else None

    # Parse restrictions
    max_stay = tags.get('maxstay', '')
    restrictions = {'raw_maxstay': max_stay} if max_stay else None

    return {
        'osm_id': el['id'],
        'name': tags.get('name'),
        'lot_type': lot_type,
        'address': tags.get('addr:full') or tags.get('addr:street'),
        'city': tags.get('addr:city'),
        'state': tags.get('addr:state'),
        'country': tags.get('addr:country', 'US'),
        'lat': lat,
        'lng': lng,
        'bbox_north': north,
        'bbox_south': south,
        'bbox_east': east,
        'bbox_west': west,
        'geometry_wkt': geometry_wkt,
        'total_spaces': total_spaces,
        'levels': levels,
        'hours': json.dumps(hours) if hours else None,
        'pricing': json.dumps(pricing) if pricing else None,
        'restrictions': json.dumps(restrictions) if restrictions else None,
        'source': 'osm',
    }


UPSERT_SQL = """
INSERT INTO lots (
    osm_id, name, lot_type, address, city, state, country,
    lat, lng, bbox_north, bbox_south, bbox_east, bbox_west,
    geometry_wkt, total_spaces, levels, hours, pricing, restrictions, source
) VALUES (
    %(osm_id)s, %(name)s, %(lot_type)s, %(address)s, %(city)s, %(state)s, %(country)s,
    %(lat)s, %(lng)s, %(bbox_north)s, %(bbox_south)s, %(bbox_east)s, %(bbox_west)s,
    %(geometry_wkt)s, %(total_spaces)s, %(levels)s,
    %(hours)s::jsonb, %(pricing)s::jsonb, %(restrictions)s::jsonb, %(source)s
)
ON CONFLICT (osm_id) DO UPDATE SET
    name          = EXCLUDED.name,
    lot_type      = EXCLUDED.lot_type,
    lat           = EXCLUDED.lat,
    lng           = EXCLUDED.lng,
    bbox_north    = EXCLUDED.bbox_north,
    bbox_south    = EXCLUDED.bbox_south,
    bbox_east     = EXCLUDED.bbox_east,
    bbox_west     = EXCLUDED.bbox_west,
    geometry_wkt  = EXCLUDED.geometry_wkt,
    total_spaces  = EXCLUDED.total_spaces,
    levels        = EXCLUDED.levels,
    hours         = EXCLUDED.hours,
    pricing       = EXCLUDED.pricing,
    restrictions  = EXCLUDED.restrictions,
    updated_at    = NOW();
"""


def ingest(bbox=None, dry_run=False):
    query = build_query(bbox)
    data = fetch_osm(query)
    elements = data.get('elements', [])
    print(f"Fetched {len(elements)} OSM elements.")

    lots = []
    skipped = 0
    for el in elements:
        if el.get('type') not in ('way', 'relation'):
            continue
        try:
            lot = parse_element(el)
            if lot['lat'] is None:
                skipped += 1
                continue
            lots.append(lot)
        except Exception as e:
            skipped += 1

    print(f"Parsed {len(lots)} lots ({skipped} skipped — no geometry).")

    if dry_run:
        print("Dry run — not writing to DB.")
        print("Sample:", json.dumps(lots[:2], indent=2, default=str))
        return

    conn = psycopg2.connect(
        DATABASE_URL,
        sslmode='require' if 'railway.internal' not in DATABASE_URL else 'disable'
    )
    conn.autocommit = False
    cur = conn.cursor()

    inserted = 0
    errors = 0
    batch_size = 500

    for i in tqdm(range(0, len(lots), batch_size), desc="Inserting"):
        batch = lots[i:i + batch_size]
        try:
            psycopg2.extras.execute_batch(cur, UPSERT_SQL, batch, page_size=batch_size)
            conn.commit()
            inserted += len(batch)
        except Exception as e:
            conn.rollback()
            errors += len(batch)
            print(f"Batch error: {e}")

    cur.execute("SELECT COUNT(*) FROM lots WHERE source = 'osm'")
    total = cur.fetchone()[0]

    cur.close()
    conn.close()

    print(f"\nOK Inserted/updated {inserted} lots ({errors} errors)")
    print(f"OK Total OSM lots in DB: {total}")


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Ingest OSM parking lots')
    parser.add_argument('--country', default=None, help='Country code (US adds US bounding box)')
    parser.add_argument('--bbox', default=None, help='Custom bbox: south,west,north,east')
    parser.add_argument('--hartford', action='store_true', help='Hartford downtown only (MVP)')
    parser.add_argument('--dry-run', action='store_true', help='Fetch and parse only, no DB write')
    args = parser.parse_args()

    if args.hartford:
        bbox = HARTFORD_BBOX
        print(f"Running Hartford downtown ingest (bbox: {bbox})")
    elif args.country == 'US':
        bbox = US_BBOX
        print(f"Running US ingest (bbox: {bbox}) — this will take several hours")
    elif args.bbox:
        bbox = args.bbox
        print(f"Running custom bbox ingest: {bbox}")
    else:
        bbox = HARTFORD_BBOX
        print(f"No bbox specified — defaulting to Hartford downtown: {bbox}")

    ingest(bbox=bbox, dry_run=args.dry_run)
