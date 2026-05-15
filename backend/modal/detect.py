"""
SPOTTR V5 — Live parking spot detection via Modal GPU
Model: yolov8x-obb (DOTA-trained, 'small vehicle' + 'large vehicle' classes)
Stripe detection: SAM2 automatic mask generation -> parking space polygons
Fallback: PCA-oriented geometric grid bounded by lot polygon

Deploy:  modal deploy backend/modal/detect.py
Invoke:  POST https://spottr--spottr-detection-detect-lot-spots.modal.run
"""

import modal
from typing import Any, Dict, List

app = modal.App("spottr-detection")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "ultralytics>=8.3.0",
        "torch>=2.5.1",
        "torchvision>=0.20.0",
        "pillow",
        "numpy",
        "shapely>=2.0",
        "requests",
        "huggingface_hub",
        "opencv-python-headless",
        "scikit-learn",
        "fastapi[standard]",
        "sam2==1.1.0",
    )
    .apt_install("libgl1", "libglib2.0-0")
)

hf_secret = modal.Secret.from_name("huggingface-token")
mapbox_secret = modal.Secret.from_name("mapbox-token")

# ── Constants ─────────────────────────────────────────────────────────────────

CAR_MODEL_NAME = "yolov8x-obb"      # DOTA-trained OBB model, classes: small/large vehicle
SAM2_MODEL_ID  = "facebook/sam2-hiera-large"
TILE_ZOOM      = 19                  # ~0.30m/pixel @2x → 1280x1280 covers ~384x384m
TILE_SIZE      = 640                 # @2x → actual pixels = 1280

# Parking space size at zoom 19 @2x: ~8-14 pixels wide, ~16-26 pixels long
STRIPE_MIN_AREA = 80       # px²
STRIPE_MAX_AREA = 800      # px²
STRIPE_MIN_AR   = 1.5      # min aspect ratio (length/width)
STRIPE_MAX_AR   = 5.0      # max aspect ratio


# ── Tile helpers ──────────────────────────────────────────────────────────────

def fetch_mapbox_tile(lat: float, lng: float, zoom: int = TILE_ZOOM) -> bytes:
    import os, requests
    token = os.environ["MAPBOX_TOKEN"]
    url = (
        f"https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/"
        f"{lng},{lat},{zoom}/{TILE_SIZE}x{TILE_SIZE}@2x"
        f"?access_token={token}"
    )
    r = requests.get(url, timeout=20)
    r.raise_for_status()
    return r.content


def tile_pixel_size() -> int:
    """@2x tile is 2x the requested size."""
    return TILE_SIZE * 2  # 1280


def meters_per_pixel(lat: float, zoom: int = TILE_ZOOM) -> float:
    import math
    return 156543.03392 * math.cos(math.radians(lat)) / (2 ** zoom) / 2  # /2 for @2x


def pixel_to_latlng(cx: float, cy: float, center_lat: float, center_lng: float,
                    mpp: float, img_px: int = 1280):
    import math
    dx = (cx - img_px / 2) * mpp
    dy = (img_px / 2 - cy) * mpp
    dlat = dy / 111320.0
    dlng = dx / (111320.0 * math.cos(math.radians(center_lat)))
    return center_lat + dlat, center_lng + dlng


def latlng_to_pixel(lat: float, lng: float, center_lat: float, center_lng: float,
                    mpp: float, img_px: int = 1280):
    import math
    dy = (lat - center_lat) * 111320.0
    dx = (lng - center_lng) * 111320.0 * math.cos(math.radians(center_lat))
    px = img_px / 2 + dx / mpp
    py = img_px / 2 - dy / mpp
    return px, py


# ── Car detection ─────────────────────────────────────────────────────────────

def detect_cars(img_bytes: bytes, center_lat: float, center_lng: float):
    """Run yolov8x-obb on tile. Returns list of car dicts with lat/lng."""
    import io
    from PIL import Image
    from ultralytics import YOLO

    model = YOLO(f"{CAR_MODEL_NAME}.pt")
    img = Image.open(io.BytesIO(img_bytes))
    results = model(img, verbose=False)

    mpp = meters_per_pixel(center_lat)
    img_px = tile_pixel_size()

    # OBB model: small vehicle (10), large vehicle (9)
    vehicle_classes = {9, 10}
    cars = []
    for r in results:
        if r.obb is None:
            continue
        for box in r.obb:
            cls = int(box.cls[0])
            if cls not in vehicle_classes:
                continue
            conf = float(box.conf[0])
            if conf < 0.3:
                continue
            # OBB xywhr: center x, center y, width, height, rotation
            cx, cy = float(box.xywhr[0][0]), float(box.xywhr[0][1])
            lat, lng = pixel_to_latlng(cx, cy, center_lat, center_lng, mpp, img_px)
            cars.append({
                "cx_px": cx, "cy_px": cy,
                "lat": lat, "lng": lng,
                "conf": conf,
                "class": "small vehicle" if cls == 10 else "large vehicle",
            })

    return cars, CAR_MODEL_NAME


# ── SAM2 stripe detection ─────────────────────────────────────────────────────

def detect_stripes_sam2(img_bytes: bytes):
    """
    Run SAM2 automatic mask generation. Filter masks by aspect ratio + area
    to find parking stripe candidates.
    Returns list of stripe mask dicts with pixel bounding boxes.
    """
    import io, os
    import numpy as np
    from PIL import Image

    try:
        import torch
        from sam2.automatic_mask_generator import SAM2AutomaticMaskGenerator
        from sam2.build_sam import build_sam2_hf

        device = "cuda" if torch.cuda.is_available() else "cpu"
        # build_sam2_hf handles config resolution + checkpoint download from HF
        sam2 = build_sam2_hf("facebook/sam2.1-hiera-large", device=device)
        mask_gen = SAM2AutomaticMaskGenerator(
            sam2,
            points_per_side=32,
            pred_iou_thresh=0.7,
            stability_score_thresh=0.85,
            min_mask_region_area=STRIPE_MIN_AREA,
        )
        img = Image.open(io.BytesIO(img_bytes)).convert("RGB")
        img_np = np.array(img)
        masks = mask_gen.generate(img_np)

        stripes = []
        for m in masks:
            area = m["area"]
            if area < STRIPE_MIN_AREA or area > STRIPE_MAX_AREA:
                continue
            x, y, w, h = m["bbox"]  # x,y,w,h
            if w == 0 or h == 0:
                continue
            ar = max(w, h) / min(w, h)
            if ar < STRIPE_MIN_AR or ar > STRIPE_MAX_AR:
                continue
            stripes.append({
                "bbox_px": [x, y, x + w, y + h],
                "cx_px": x + w / 2,
                "cy_px": y + h / 2,
                "area_px": area,
                "aspect_ratio": ar,
                "stability_score": m.get("stability_score", 0),
            })

        return stripes, "sam2_hiera_large"

    except Exception as e:
        # SAM2 not available or failed — return empty, caller uses grid fallback
        return [], f"sam2_error:{str(e)[:60]}"


# ── PCA grid fallback ─────────────────────────────────────────────────────────

def grid_fallback(
    lot_polygon_geojson: dict,
    center_lat: float,
    center_lng: float,
    n_spaces_hint: int = None,
):
    """
    Generate parking spaces from lot polygon using PCA orientation.
    1. Project polygon vertices to local metric space (meters from centroid)
    2. PCA to find principal axes (long edge = row direction)
    3. Generate rows perpendicular to long edge, bounded by polygon
    4. Place spots along each row

    Returns list of space dicts.
    """
    import math
    import numpy as np
    from shapely.geometry import Polygon, Point, MultiPolygon
    from shapely.affinity import rotate

    try:
        coords = lot_polygon_geojson.get("coordinates", [[]])[0]
        if not coords or len(coords) < 3:
            return []

        # Project to local meters
        def to_meters(lat, lng):
            dy = (lat - center_lat) * 111320.0
            dx = (lng - center_lng) * 111320.0 * math.cos(math.radians(center_lat))
            return dx, dy

        pts_m = np.array([to_meters(c[1], c[0]) for c in coords[:-1]])  # drop closing coord

        # PCA for orientation
        cov = np.cov(pts_m.T)
        eigenvalues, eigenvectors = np.linalg.eig(cov)
        # Sort by eigenvalue descending: first vector = long axis
        order = np.argsort(-eigenvalues)
        long_axis = eigenvectors[:, order[0]]   # direction along rows
        short_axis = eigenvectors[:, order[1]]  # direction across rows (aisle direction)

        # Angle of long axis from east (x-axis), in degrees
        angle_deg = math.degrees(math.atan2(long_axis[1], long_axis[0]))

        # Create shapely polygon in meter space
        poly_m = Polygon(pts_m)
        area_m2 = poly_m.area
        if area_m2 < 10:
            return []

        # Estimated spaces from area (1 space per ~25 m² — covers stall + aisle share)
        n_spaces = n_spaces_hint or max(4, int(area_m2 / 25))

        # Rotate polygon so long axis aligns with x-axis → easier to grid
        poly_rotated = rotate(poly_m, -angle_deg, origin=(0, 0), use_radians=False)
        rx_min, ry_min, rx_max, ry_max = poly_rotated.bounds

        width_m  = rx_max - rx_min  # along long axis
        height_m = ry_max - ry_min  # across rows

        # Standard parking: stall 2.7m wide, 5.5m deep; aisle 6m
        stall_w = 2.7
        stall_d = 5.5
        aisle_w = 6.0
        row_pitch = stall_d + aisle_w  # center-to-center of parallel rows = 11.5m

        n_cols = max(1, int(width_m / stall_w))
        n_rows = max(1, int(height_m / row_pitch))

        spaces = []
        row_labels = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"

        for ri in range(n_rows):
            ry_center = ry_min + (ri + 0.5) * row_pitch
            label = row_labels[ri % len(row_labels)]

            for ci in range(n_cols):
                rx_center = rx_min + (ci + 0.5) * stall_w

                # Check if center is inside rotated polygon (with small buffer)
                pt = Point(rx_center, ry_center)
                if not poly_rotated.buffer(-0.5).contains(pt):
                    continue

                # Back-rotate point to original meter space
                angle_rad = math.radians(angle_deg)
                ox = rx_center * math.cos(angle_rad) - ry_center * math.sin(angle_rad)
                oy = rx_center * math.sin(angle_rad) + ry_center * math.cos(angle_rad)

                # Convert back to lat/lng
                dlat = oy / 111320.0
                dlng = ox / (111320.0 * math.cos(math.radians(center_lat)))
                slat = center_lat + dlat
                slng = center_lng + dlng

                spaces.append({
                    "row_label": label,
                    "space_num": ci + 1,
                    "lat": slat,
                    "lng": slng,
                    "polygon": None,  # no polygon for grid fallback
                    "occupied": False,
                    "confidence": 0.4,
                    "source": "grid_fallback",
                })

        # Trim to estimated space count if way over
        if len(spaces) > n_spaces * 1.5:
            spaces = spaces[:int(n_spaces * 1.5)]

        return spaces

    except Exception as e:
        return []


# ── Car-to-stripe matching ────────────────────────────────────────────────────

def match_cars_to_stripes(stripes, cars, center_lat, center_lng):
    """
    Mark stripes as occupied if a detected car center falls within the stripe bbox.
    Returns updated stripes with 'occupied' field.
    """
    mpp = meters_per_pixel(center_lat)
    img_px = tile_pixel_size()

    car_pixels = []
    for c in cars:
        px, py = latlng_to_pixel(c["lat"], c["lng"], center_lat, center_lng, mpp, img_px)
        car_pixels.append((px, py))

    for stripe in stripes:
        x1, y1, x2, y2 = stripe["bbox_px"]
        occupied = False
        for (px, py) in car_pixels:
            if x1 <= px <= x2 and y1 <= py <= y2:
                occupied = True
                break
        stripe["occupied"] = occupied

    return stripes


def stripes_to_spaces(stripes, center_lat, center_lng):
    """Convert SAM2 stripe bbox pixels → space dicts with lat/lng."""
    mpp = meters_per_pixel(center_lat)
    img_px = tile_pixel_size()

    spaces = []
    for i, s in enumerate(stripes):
        cx, cy = s["cx_px"], s["cy_px"]
        lat, lng = pixel_to_latlng(cx, cy, center_lat, center_lng, mpp, img_px)
        spaces.append({
            "lat": lat,
            "lng": lng,
            "polygon": None,
            "occupied": s.get("occupied", False),
            "confidence": float(s.get("stability_score", 0.7)),
            "source": "sam2",
        })
    return spaces


# ── Main Modal function ───────────────────────────────────────────────────────

@app.function(
    image=image,
    gpu="T4",
    timeout=120,
    secrets=[hf_secret, mapbox_secret],
    min_containers=1,
    max_containers=10,
)
def detect_lot_spots(
    lot_id: str,
    lot_polygon_geojson: dict,
    centroid_lat: float,
    centroid_lng: float,
) -> Dict[str, Any]:
    """
    Live parking spot detection for a single lot.
    Returns spaces with lat/lng, occupied status, confidence, and source.
    """
    import time, datetime

    t_start = time.time()
    timestamp = datetime.datetime.utcnow().isoformat() + "Z"

    # 1. Fetch Mapbox tile
    try:
        tile_bytes = fetch_mapbox_tile(centroid_lat, centroid_lng)
    except Exception as e:
        return {
            "lot_id": lot_id,
            "spaces": [],
            "error": f"tile_fetch_failed: {e}",
            "detection_timestamp": timestamp,
            "model_versions": {},
            "source": "modal_error",
            "overall_confidence": 0.0,
            "duration_ms": int((time.time() - t_start) * 1000),
        }

    # 2. Detect cars
    try:
        cars, car_model = detect_cars(tile_bytes, centroid_lat, centroid_lng)
    except Exception as e:
        cars, car_model = [], f"car_error:{str(e)[:60]}"

    # 3. Try SAM2 stripe detection
    stripes, stripe_model = detect_stripes_sam2(tile_bytes)
    sam2_succeeded = len(stripes) >= 5

    if sam2_succeeded:
        # Match cars → stripes, convert to spaces
        stripes = match_cars_to_stripes(stripes, cars, centroid_lat, centroid_lng)
        spaces = stripes_to_spaces(stripes, centroid_lat, centroid_lng)
        source = "sam2_full"
        overall_conf = sum(s["confidence"] for s in spaces) / len(spaces) if spaces else 0.4
    else:
        # Grid fallback with PCA orientation
        spaces = grid_fallback(lot_polygon_geojson, centroid_lat, centroid_lng)
        # Still mark occupied based on car positions
        if cars and spaces:
            mpp = meters_per_pixel(centroid_lat)
            import math
            for space in spaces:
                for car in cars:
                    dist = math.sqrt((space["lat"]-car["lat"])**2 + (space["lng"]-car["lng"])**2) * 111320
                    if dist < 4.0:  # within 4m
                        space["occupied"] = True
                        break
        source = "grid_fallback" if not sam2_succeeded else "mixed"
        overall_conf = 0.4

    # Assign row labels / space indices for spaces from grid fallback
    if source in ("sam2_full", "sam2"):
        row_label = "A"
        for i, s in enumerate(spaces):
            s["row_label"] = chr(65 + i // 10)
            s["space_num"] = (i % 10) + 1

    duration_ms = int((time.time() - t_start) * 1000)

    return {
        "lot_id": lot_id,
        "spaces": spaces,
        "imagery_timestamp": "recent",
        "detection_timestamp": timestamp,
        "model_versions": {
            "car_detector": car_model,
            "stripe_detector": stripe_model,
        },
        "source": source,
        "overall_confidence": round(overall_conf, 3),
        "cars_detected": len(cars),
        "spaces_count": len(spaces),
        "sam2_stripes_found": len(stripes) if sam2_succeeded else 0,
        "duration_ms": duration_ms,
    }


# ── Web endpoint (callable via HTTP POST) ────────────────────────────────────

@app.function(
    image=image,
    gpu="T4",
    timeout=120,
    secrets=[hf_secret, mapbox_secret],
    min_containers=1,
    max_containers=10,
)
@modal.fastapi_endpoint(method="POST")
def detect_lot_spots_http(body: Dict[str, Any]) -> Dict[str, Any]:
    """HTTP wrapper so Railway backend can call via fetch()."""
    return detect_lot_spots.local(
        lot_id=str(body.get("lot_id", "")),
        lot_polygon_geojson=body.get("lot_polygon_geojson", {"type": "Polygon", "coordinates": [[]]}),
        centroid_lat=float(body.get("centroid_lat", 0)),
        centroid_lng=float(body.get("centroid_lng", 0)),
    )
