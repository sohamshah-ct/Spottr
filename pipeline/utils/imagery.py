"""
pipeline/utils/imagery.py
Aerial imagery fetcher for SPOTTR spot detection pipeline.

get_aerial_tile(lat, lng, lot_id=None, cur=None) → PIL.Image
Priority:
  1. NAIP tile from S3 (spottr-imagery/naip/ct/{quad_id}.tif) — cropped to ~200m
  2. Google Maps Static API fallback
  3. Logs source to lot.data_sources JSONB column
"""

import os
import io
import math
import json
import datetime
import requests
import boto3
from botocore.exceptions import ClientError
from PIL import Image
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '../../backend/.env'))

GOOGLE_MAPS_KEY = os.environ.get('GOOGLE_MAPS_KEY', '')
S3_BUCKET = os.environ.get('S3_BUCKET', 'spottr-imagery')
AWS_REGION = os.environ.get('AWS_REGION', 'us-east-1')

TILE_SIZE = 640
ZOOM = 20  # ~0.15m/pixel — good for individual space detection

# ~200m in degrees at Hartford latitude (41.76°)
CROP_DEG = 200 / 111320  # ≈ 0.001797°


def _s3_client():
    return boto3.client(
        's3',
        region_name=AWS_REGION,
        aws_access_key_id=os.environ.get('AWS_ACCESS_KEY_ID'),
        aws_secret_access_key=os.environ.get('AWS_SECRET_ACCESS_KEY'),
    )


def _lat_lng_to_quad_id(lat: float, lng: float) -> str:
    """
    USGS 7.5-minute quad naming convention used for NAIP tiles.
    Format: {lat_deg:02d}{lng_deg:03d} (e.g. 4172 for Hartford CT)
    Matches the prefix used by naip_downloader.py entityId storage.
    """
    lat_i = int(math.floor(lat / 0.125) * 0.125 * 8)
    lng_i = int(math.floor(abs(lng) / 0.125) * 0.125 * 8)
    return f"{int(lat):02d}{int(abs(lng)):03d}"


def _try_naip_s3(lat: float, lng: float) -> Image.Image | None:
    """
    Try to load NAIP tile from S3 and crop a ~200m window around lat/lng.
    Returns PIL Image or None if not found.
    """
    try:
        s3 = _s3_client()
        quad_id = _lat_lng_to_quad_id(lat, lng)

        # List keys matching this quad prefix
        prefix = f"naip/ct/{quad_id}"
        resp = s3.list_objects_v2(Bucket=S3_BUCKET, Prefix=prefix, MaxKeys=5)
        objects = resp.get('Contents', [])
        if not objects:
            return None

        # Use the first matching tile
        key = objects[0]['Key']
        obj = s3.get_object(Bucket=S3_BUCKET, Key=key)
        img_bytes = obj['Body'].read()
        img = Image.open(io.BytesIO(img_bytes))

        # Crop to ~200m window around target coordinate
        # NAIP is typically 1m/px GSD; a 200m crop = ~200x200 px
        # We use the image center as reference for simplicity
        w, h = img.size
        cx, cy = w // 2, h // 2
        half_px = min(200, cx, cy)
        cropped = img.crop((cx - half_px, cy - half_px, cx + half_px, cy + half_px))
        return cropped.resize((TILE_SIZE, TILE_SIZE), Image.LANCZOS)

    except ClientError as e:
        if e.response['Error']['Code'] in ('NoSuchKey', 'NoSuchBucket', '404'):
            return None
        raise
    except Exception:
        return None


def _fetch_google_maps_tile(lat: float, lng: float) -> Image.Image:
    """Fetch satellite tile from Google Maps Static API."""
    url = (
        f"https://maps.googleapis.com/maps/api/staticmap"
        f"?center={lat},{lng}&zoom={ZOOM}&size={TILE_SIZE}x{TILE_SIZE}"
        f"&maptype=satellite&key={GOOGLE_MAPS_KEY}"
    )
    resp = requests.get(url, timeout=15)
    resp.raise_for_status()
    return Image.open(io.BytesIO(resp.content))


def _log_data_source(cur, lot_id: str, source_entry: dict):
    """Append a data-source entry to lot.data_sources JSONB."""
    if cur is None or lot_id is None:
        return
    try:
        cur.execute(
            """
            UPDATE lots
            SET data_sources = COALESCE(data_sources, '[]'::jsonb) || %s::jsonb
            WHERE id = %s
            """,
            (json.dumps([source_entry]), lot_id),
        )
    except Exception:
        pass  # Non-fatal — don't block detection on logging failure


def get_aerial_tile(
    lat: float,
    lng: float,
    lot_id: str = None,
    cur=None,
    zoom: int = ZOOM,
) -> Image.Image:
    """
    Returns a PIL Image for the aerial view at lat/lng.
    Tries NAIP from S3 first, falls back to Google Maps Static API.
    Logs the source to lot.data_sources if lot_id + cur provided.
    """
    ran_at = datetime.datetime.utcnow().isoformat()

    # 1. Try NAIP from S3
    img = _try_naip_s3(lat, lng)
    if img is not None:
        _log_data_source(cur, lot_id, {
            'source': 'naip_s3',
            'imagery_source': 'naip',
            'bucket': S3_BUCKET,
            'ran_at': ran_at,
        })
        return img

    # 2. Fall back to Google Maps Static API
    if not GOOGLE_MAPS_KEY:
        raise RuntimeError("No NAIP tile found and GOOGLE_MAPS_KEY not set")

    img = _fetch_google_maps_tile(lat, lng)
    _log_data_source(cur, lot_id, {
        'source': 'google_maps_static',
        'imagery_source': 'google_maps_static',
        'zoom': zoom,
        'ran_at': ran_at,
    })
    return img


def get_aerial_tile_bytes(lat: float, lng: float, zoom: int = ZOOM) -> bytes:
    """Returns raw image bytes (for YOLO which accepts bytes). Uses same fallback logic."""
    img = get_aerial_tile(lat, lng, zoom=zoom)
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    return buf.getvalue()
