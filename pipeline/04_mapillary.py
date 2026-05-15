"""
SPOTTR Pipeline 04 — Mapillary Sign Extraction
For each lot, fetches nearby Mapillary street-level images and extracts
parking sign detections (hours, time limits, restrictions).
Updates lots.restrictions and lots.hours in DB.

Usage:
  python pipeline/04_mapillary.py --city Hartford
"""

import os
import sys
import json
import math
import requests
import psycopg2
import psycopg2.extras
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '../backend/.env'))

DATABASE_URL = (
    os.environ.get('DATABASE_PUBLIC_URL') or
    os.environ.get('DATABASE_URL', '')
)
if 'railway.internal' in DATABASE_URL:
    raise RuntimeError("Use: railway run python pipeline/04_mapillary.py")

MAPILLARY_TOKEN = os.environ.get('MAPILLARY_TOKEN', '')
MAPILLARY_API = "https://graph.mapillary.com"

# Detection types that matter for parking
PARKING_SIGN_TYPES = {
    'regulatory--no-parking--g1': {'restriction': 'no_parking'},
    'regulatory--no-parking-or-no-standing--g1': {'restriction': 'no_parking'},
    'regulatory--time-limited-parking--g1': {'restriction': 'time_limited'},
    'information--parking--g1': {'restriction': None},  # Parking allowed
    'regulatory--maximum-speed--g1': None,  # Ignore speed signs
    'regulatory--parking-restrictions--g1': {'restriction': 'restricted'},
}


def haversine_meters(lat1, lng1, lat2, lng2):
    R = 6371000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)
    a = math.sin(dphi/2)**2 + math.cos(phi1)*math.cos(phi2)*math.sin(dlambda/2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def fetch_images_near_lot(lot, radius_m=50):
    """Fetch Mapillary images within radius_m of lot centroid."""
    if not MAPILLARY_TOKEN or not lot['lat']:
        return []

    lat, lng = lot['lat'], lot['lng']
    # Bounding box
    dlat = radius_m / 111000
    dlng = radius_m / (111000 * math.cos(math.radians(lat)))
    west = lng - dlng
    south = lat - dlat
    east = lng + dlng
    north = lat + dlat

    url = f"{MAPILLARY_API}/images"
    params = {
        'fields': 'id,thumb_256_url,captured_at,computed_geometry,detections',
        'bbox': f"{west},{south},{east},{north}",
        'access_token': MAPILLARY_TOKEN,
        'limit': 20,
    }

    try:
        resp = requests.get(url, params=params, timeout=15,
                           headers={'User-Agent': 'SPOTTR/1.0'})
        resp.raise_for_status()
        return resp.json().get('data', [])
    except Exception as e:
        return []


def fetch_image_detections(image_id):
    """Fetch sign detections for a specific image."""
    url = f"{MAPILLARY_API}/{image_id}/detections"
    params = {
        'fields': 'value,score,geometry',
        'access_token': MAPILLARY_TOKEN,
    }
    try:
        resp = requests.get(url, params=params, timeout=15,
                           headers={'User-Agent': 'SPOTTR/1.0'})
        resp.raise_for_status()
        return resp.json().get('data', [])
    except Exception:
        return []


def parse_sign_detections(images):
    """
    Extract parking-relevant sign information from a list of images.
    Returns a dict with hours, restrictions, time_limit_hours.
    """
    result = {
        'no_parking': False,
        'time_limited': False,
        'time_limit_hours': None,
        'permit_required': False,
        'sign_sources': [],
    }

    for image in images:
        image_id = image.get('id')
        if not image_id:
            continue

        detections = image.get('detections', {}).get('data', [])
        if not detections:
            detections = fetch_image_detections(image_id)

        for det in detections:
            det_type = det.get('value', '')
            score = float(det.get('score', 0))

            if score < 0.6:
                continue

            if det_type in PARKING_SIGN_TYPES:
                info = PARKING_SIGN_TYPES[det_type]
                if info is None:
                    continue
                restriction = info.get('restriction')
                if restriction == 'no_parking':
                    result['no_parking'] = True
                elif restriction == 'time_limited':
                    result['time_limited'] = True
                result['sign_sources'].append(det_type)

    return result


def build_restrictions_json(sign_data, existing_restrictions):
    """Merge sign-extracted data with existing restrictions."""
    existing = {}
    if existing_restrictions:
        try:
            existing = json.loads(existing_restrictions) if isinstance(existing_restrictions, str) else existing_restrictions
        except Exception:
            existing = {}

    updated = dict(existing)

    if sign_data['no_parking']:
        updated['no_parking'] = True
    if sign_data['time_limited']:
        updated['time_limited'] = True
    if sign_data['time_limit_hours']:
        updated['max_hours'] = sign_data['time_limit_hours']
    if sign_data['sign_sources']:
        updated['mapillary_signs'] = sign_data['sign_sources']

    return json.dumps(updated) if updated else None


def run(city='Hartford', limit=200):
    if not MAPILLARY_TOKEN:
        print("MAPILLARY_TOKEN not set — skipping sign extraction.")
        return

    conn = psycopg2.connect(DATABASE_URL, sslmode='require')
    conn.autocommit = False
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    cur.execute("""
        SELECT id, name, lat, lng, restrictions FROM lots
        WHERE lat IS NOT NULL
          AND city ILIKE %s
        ORDER BY created_at DESC
        LIMIT %s
    """, (f'%{city}%', limit))
    lots = cur.fetchall()

    print(f"Running Mapillary sign extraction for {len(lots)} {city} lots...")

    updated = 0
    no_images = 0

    for lot in lots:
        lot = dict(lot)
        images = fetch_images_near_lot(lot, radius_m=60)

        if not images:
            no_images += 1
            continue

        sign_data = parse_sign_detections(images)

        if not any([sign_data['no_parking'], sign_data['time_limited'],
                    sign_data['sign_sources']]):
            continue

        new_restrictions = build_restrictions_json(sign_data, lot['restrictions'])

        if new_restrictions:
            cur.execute("""
                UPDATE lots SET restrictions = %s::jsonb, updated_at = NOW()
                WHERE id = %s
            """, (new_restrictions, lot['id']))
            updated += 1

    conn.commit()
    cur.close()
    conn.close()

    print(f"OK Sign extraction complete.")
    print(f"  Updated {updated} lots with sign data")
    print(f"  {no_images} lots had no nearby Mapillary images")


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--city', default='Hartford')
    parser.add_argument('--limit', type=int, default=200)
    args = parser.parse_args()
    run(city=args.city, limit=args.limit)
