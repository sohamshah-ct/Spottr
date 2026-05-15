"""
SPOTTR Pipeline 03 — Parking Space Detection (v2)
Uses aerial imagery (NAIP→S3 or Google Maps Static fallback) + YOLOv8 to detect
individual parking spaces. Writes space records and occupancy_history rows to DB.

Usage:
  python pipeline/03_spot_detection.py --region hartford_downtown --batch-size 10
  python pipeline/03_spot_detection.py --city Hartford --limit 50
  python pipeline/03_spot_detection.py --lot-id <uuid>
"""

import os
import io
import sys
import math
import json
import argparse
import datetime
import requests
import psycopg2
import psycopg2.extras
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '../backend/.env'))

DATABASE_URL = (
    os.environ.get('DATABASE_PUBLIC_URL') or
    os.environ.get('DATABASE_URL', '')
)
if DATABASE_URL and 'railway.internal' in DATABASE_URL:
    raise RuntimeError("Use: railway run python pipeline/03_spot_detection.py")

GOOGLE_MAPS_KEY = os.environ.get('GOOGLE_MAPS_KEY', '')
TILE_SIZE = 640
ZOOM = 20


# ── Imagery ───────────────────────────────────────────────────────────────────

def get_aerial_tile_bytes(lat, lng, cur=None, lot_id=None):
    """
    Try NAIP from S3 first, fall back to Google Maps Static.
    Uses pipeline/utils/imagery.py if available.
    Returns raw image bytes.
    """
    try:
        sys.path.insert(0, os.path.dirname(__file__))
        from utils.imagery import get_aerial_tile
        import io as _io
        img = get_aerial_tile(lat, lng, lot_id=lot_id, cur=cur)
        buf = _io.BytesIO()
        img.save(buf, format='PNG')
        return buf.getvalue(), 'naip_s3_or_google'
    except Exception:
        pass

    # Direct Google Maps Static fallback
    if not GOOGLE_MAPS_KEY:
        return None, None
    url = (
        f"https://maps.googleapis.com/maps/api/staticmap"
        f"?center={lat},{lng}&zoom={ZOOM}&size={TILE_SIZE}x{TILE_SIZE}"
        f"&maptype=satellite&key={GOOGLE_MAPS_KEY}"
    )
    resp = requests.get(url, timeout=15)
    resp.raise_for_status()
    return resp.content, 'google_maps_static'


# ── YOLO ──────────────────────────────────────────────────────────────────────

_yolo_model = None

def get_yolo_model():
    global _yolo_model
    if _yolo_model is None:
        from ultralytics import YOLO
        _yolo_model = YOLO('yolov8x.pt')  # yolov8x for accuracy
    return _yolo_model


def run_yolo_detection(image_bytes):
    """Run YOLOv8x on image bytes. Returns list of detected box dicts."""
    try:
        from PIL import Image
        import numpy as np
        model = get_yolo_model()
        img = Image.open(io.BytesIO(image_bytes))
        results = model(img, verbose=False)
        boxes = []
        for r in results:
            for box in r.boxes:
                cls = int(box.cls[0])
                conf = float(box.conf[0])
                if cls == 2 and conf > 0.3:  # class 2 = car (COCO)
                    x1, y1, x2, y2 = box.xyxy[0].tolist()
                    boxes.append({
                        'cx': (x1 + x2) / 2,
                        'cy': (y1 + y2) / 2,
                        'conf': conf,
                        'occupied': True,
                    })
        return boxes, 'yolov8x'
    except ImportError:
        return [], 'grid_estimate'


# ── Geometry helpers ──────────────────────────────────────────────────────────

def meters_per_pixel(lat, zoom=ZOOM):
    return 156543.03392 * math.cos(math.radians(lat)) / (2 ** zoom)


def pixel_to_latlng(center_lat, center_lng, px, py, mpp):
    dx = (px - TILE_SIZE / 2) * mpp
    dy = (TILE_SIZE / 2 - py) * mpp
    dlat = dy / 111320
    dlng = dx / (111320 * math.cos(math.radians(center_lat)))
    return center_lat + dlat, center_lng + dlng


def haversine_m(lat1, lng1, lat2, lng2):
    R = 6_371_000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    a = (math.sin((phi2 - phi1) / 2) ** 2 +
         math.cos(phi1) * math.cos(phi2) *
         math.sin(math.radians((lng2 - lng1) / 2)) ** 2)
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def estimate_spaces_from_area(lot):
    """Grid-estimate spaces when YOLO unavailable / no detections."""
    if lot.get('bbox_north') is None or lot.get('lat') is None:
        return []
    n, s = lot['bbox_north'], lot['bbox_south']
    e, w = lot['bbox_east'], lot['bbox_west']
    h_m = haversine_m(s, w, n, w)
    wid_m = haversine_m(s, w, s, e)
    cols = max(1, int(wid_m / 2.7))
    rows_count = max(1, int(h_m / 13.0))
    spaces = []
    for ri in range(rows_count):
        label = chr(65 + ri)
        rlat = s + ((ri + 0.5) / rows_count) * (n - s)
        for ci in range(cols):
            slng = w + ((ci + 0.5) / cols) * (e - w)
            spaces.append({
                'row_label': label,
                'space_num': ci + 1,
                'lat': rlat,
                'lng': slng,
                'confidence': 0.4,
                'detected_from': 'grid_estimate',
                'space_type': 'standard',
                'occupied': False,
            })
    return spaces


# ── DB writes ─────────────────────────────────────────────────────────────────

def write_spaces_and_rows(cur, lot_id, spaces, lot):
    """Insert lot_rows + spaces. Returns list of inserted space dicts with IDs."""
    if not spaces:
        return []

    rows_map = {}
    for s in spaces:
        rows_map.setdefault(s['row_label'], []).append(s)

    entrance_lat = lot.get('bbox_south') or lot['lat']
    entrance_lng = lot['lng']

    row_id_map = {}
    for i, (label, row_spaces) in enumerate(sorted(rows_map.items())):
        lats = [s['lat'] for s in row_spaces]
        lngs = [s['lng'] for s in row_spaces]
        row_lat = sum(lats) / len(lats)
        row_lng = sum(lngs) / len(lngs)
        cur.execute("""
            INSERT INTO lot_rows (lot_id, label, entrance_lat, entrance_lng,
                                  position_order, space_count, level)
            VALUES (%s, %s, %s, %s, %s, %s, 1)
            ON CONFLICT DO NOTHING
            RETURNING id, label
        """, (lot_id, label, row_lat, row_lng, i + 1, len(row_spaces)))
        row = cur.fetchone()
        if row:
            row_id_map[row['label']] = row['id']

    # Re-fetch any that already existed
    cur.execute("SELECT id, label FROM lot_rows WHERE lot_id = %s", (lot_id,))
    for row in cur.fetchall():
        row_id_map[row['label']] = row['id']

    inserted_spaces = []
    for s in spaces:
        cur.execute("""
            INSERT INTO spaces (lot_id, row_id, space_label, lat, lng,
                                space_type, confidence, detected_from, data_sources)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)
            ON CONFLICT DO NOTHING
            RETURNING id, lat, lng, confidence
        """, (
            lot_id,
            row_id_map.get(s['row_label']),
            f"{s['row_label']}-{s['space_num']:02d}",
            s['lat'], s['lng'],
            s.get('space_type', 'standard'),
            s.get('confidence', 0.4),
            s.get('detected_from', 'grid_estimate'),
            json.dumps([{'source': s.get('detected_from', 'grid_estimate')}]),
        ))
        row = cur.fetchone()
        if row:
            inserted_spaces.append({
                'id': row['id'],
                'lat': row['lat'],
                'lng': row['lng'],
                'confidence': row['confidence'],
                'occupied': s.get('occupied', False),
            })

    # Update lot total_spaces
    cur.execute("""
        UPDATE lots SET total_spaces = %s, updated_at = NOW()
        WHERE id = %s AND (total_spaces IS NULL OR total_spaces < %s)
    """, (len(spaces), lot_id, len(spaces)))

    return inserted_spaces


def write_occupancy_history(cur, lot_id, spaces_with_ids, imagery_source, model_version):
    """
    Write one occupancy_history row per detected space.
    This is the proprietary moat — every detection writes here.
    """
    now = datetime.datetime.utcnow()
    rows = []
    for s in spaces_with_ids:
        rows.append({
            'space_id': s['id'],
            'lot_id': lot_id,
            'occupied': s.get('occupied', False),
            'confidence': s.get('confidence', 0.4),
            'source': model_version or 'grid_estimate',
            'captured_at': now,
        })
    if rows:
        psycopg2.extras.execute_batch(cur, """
            INSERT INTO occupancy_history
                (space_id, lot_id, occupied, confidence, source, captured_at)
            VALUES
                (%(space_id)s, %(lot_id)s, %(occupied)s, %(confidence)s,
                 %(source)s, %(captured_at)s)
        """, rows)


def update_lot_detection_status(cur, lot_id, status, imagery_source, model_version, error=None):
    """Update lot status and data_sources after detection."""
    now = datetime.datetime.utcnow().isoformat()
    source_entry = json.dumps([{
        'source': model_version or 'grid_estimate',
        'imagery_source': imagery_source or 'unknown',
        'model_version': model_version or 'grid_estimate',
        'ran_at': now,
    }])
    cur.execute("""
        UPDATE lots SET
            spot_detection_status = %s,
            spot_detection_attempts = COALESCE(spot_detection_attempts, 0) + 1,
            last_spot_detection = NOW(),
            spot_detection_last_error = %s,
            data_sources = COALESCE(data_sources, '[]'::jsonb) || %s::jsonb
        WHERE id = %s
    """, (status, error, source_entry, lot_id))


# ── Main detection loop ────────────────────────────────────────────────────────

def process_lot(cur, lot):
    lot_id = str(lot['id'])

    # Skip if already complete
    if lot.get('spot_detection_status') == 'complete':
        return 0, 'skipped'

    # Skip if already has spaces (idempotent)
    cur.execute("SELECT COUNT(*) as cnt FROM spaces WHERE lot_id = %s", (lot_id,))
    if cur.fetchone()['cnt'] > 0:
        update_lot_detection_status(cur, lot_id, 'complete', None, None)
        return 0, 'already_done'

    imagery_source = None
    model_version = 'grid_estimate'
    spaces = []

    # Try satellite imagery + YOLO
    if lot.get('lat') and lot.get('bbox_north'):
        try:
            tile_bytes, imagery_source = get_aerial_tile_bytes(
                lot['lat'], lot['lng'], cur=cur, lot_id=lot_id
            )
            if tile_bytes:
                detected, model_version = run_yolo_detection(tile_bytes)
                if detected:
                    mpp = meters_per_pixel(lot['lat'])
                    for i, box in enumerate(detected):
                        slat, slng = pixel_to_latlng(
                            lot['lat'], lot['lng'], box['cx'], box['cy'], mpp
                        )
                        spaces.append({
                            'row_label': chr(65 + (i // 10)),
                            'space_num': (i % 10) + 1,
                            'lat': slat,
                            'lng': slng,
                            'confidence': box['conf'],
                            'detected_from': 'yolov8x_aerial',
                            'space_type': 'standard',
                            'occupied': box.get('occupied', True),
                        })
        except Exception as e:
            imagery_source = imagery_source or 'error'

    # Fall back to grid estimate
    if not spaces:
        spaces = estimate_spaces_from_area(lot)
        model_version = 'grid_estimate'
        imagery_source = imagery_source or 'none'

    if not spaces:
        update_lot_detection_status(cur, lot_id, 'failed', imagery_source, model_version,
                                    error='no_bbox_or_spaces')
        return 0, 'no_spaces'

    # Write spaces + rows
    inserted = write_spaces_and_rows(cur, lot_id, spaces, lot)

    # Write occupancy_history for every space — the moat
    if inserted:
        write_occupancy_history(cur, lot_id, inserted, imagery_source, model_version)

    # Update lot status
    update_lot_detection_status(cur, lot_id, 'complete', imagery_source, model_version)

    return len(inserted), 'ok'


def run(region=None, city=None, lot_id=None, limit=1000, batch_size=10):
    db_url = DATABASE_URL.replace('sslmode=no-verify', 'sslmode=require')
    conn = psycopg2.connect(db_url)
    conn.autocommit = False
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    if lot_id:
        cur.execute("SELECT * FROM lots WHERE id = %s", (lot_id,))
        lots = cur.fetchall()
    else:
        filters = ["l.lat IS NOT NULL", "l.bbox_north IS NOT NULL",
                   "(l.spot_detection_status IS NULL OR l.spot_detection_status != 'complete')"]
        params = []
        if region:
            filters.append("l.region = %s")
            params.append(region)
        if city:
            filters.append("l.city ILIKE %s")
            params.append(f'%{city}%')
        params.append(limit)
        cur.execute(
            f"SELECT * FROM lots l WHERE {' AND '.join(filters)} "
            f"ORDER BY l.total_spaces DESC NULLS LAST LIMIT %s",
            params,
        )
        lots = cur.fetchall()

    print(f"Processing {len(lots)} lots for spot detection...")
    print(f"  region={region or 'any'}, batch_size={batch_size}")

    total_spaces = 0
    total_ok = 0
    batch_count = 0

    for i, lot in enumerate(lots):
        try:
            count, status = process_lot(cur, dict(lot))
            if status not in ('skipped', 'already_done'):
                total_spaces += count
                total_ok += 1
        except Exception as e:
            lot_id_str = str(lot['id'])
            print(f"  ERR {lot.get('name', lot_id_str)}: {e}")
            try:
                cur.execute("""
                    UPDATE lots SET spot_detection_status='failed',
                    spot_detection_last_error=%s WHERE id=%s
                """, (str(e)[:500], lot_id_str))
            except Exception:
                pass

        # Commit each batch
        if (i + 1) % batch_size == 0:
            conn.commit()
            batch_count += 1
            print(f"  Batch {batch_count} committed — lot {i+1}/{len(lots)}, "
                  f"spaces so far: {total_spaces}")

    conn.commit()
    cur.close()
    conn.close()
    print(f"\nDone. {total_spaces} spaces written across {total_ok} lots.")


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--region', default=None)
    parser.add_argument('--city', default=None)
    parser.add_argument('--lot-id', default=None)
    parser.add_argument('--limit', type=int, default=1000)
    parser.add_argument('--batch-size', type=int, default=10)
    args = parser.parse_args()
    run(
        region=args.region,
        city=args.city,
        lot_id=args.lot_id,
        limit=args.limit,
        batch_size=args.batch_size,
    )
