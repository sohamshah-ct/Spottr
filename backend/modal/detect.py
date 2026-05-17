"""
SPOTTR V5 — Live parking spot detection via Modal GPU
Multi-tile: covers the full lot polygon via a grid of zoom-19 @2x tiles.
Models: yolov8x-obb (DOTA-trained, cars) + SAM2 (stripe segmentation)
Fallback: PCA-oriented geometric grid bounded by lot polygon

Deploy: modal deploy backend/modal/detect.py
"""

import modal
from typing import Any, Dict, List, Optional, Tuple

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

hf_secret   = modal.Secret.from_name("huggingface-token")
mapbox_secret = modal.Secret.from_name("mapbox-token")

# ── Constants ─────────────────────────────────────────────────────────────────

CAR_MODEL_NAME = "yolov8x-obb"   # DOTA-trained OBB: classes 9=large vehicle, 10=small vehicle
TILE_ZOOM      = 19
TILE_SIZE      = 640              # requested size; @2x → 1280px rendered
TILE_PX        = TILE_SIZE * 2    # 1280

# SAM2 stripe filter — widened to cover @2x effective resolution (~0.11m/px at lat 41):
#   2.5m×5m stall → 23×45px → ~1035 px², AR 1.96
#   MAX_AREA raised to 8000 (stall hypothesis validated: 130 stall-class masks at 800-8000 px² in diagnostic run)
STRIPE_MIN_AREA = 50
STRIPE_MAX_AREA = 8000
STRIPE_MIN_AR   = 1.3
STRIPE_MAX_AR   = 6.0

MAX_TILES      = 16               # 4×4 hard cap; larger lots fall back to grid
DEDUP_RADIUS_M = 3.0              # stripes within 3m = same stall; keep higher-confidence one
CAR_MATCH_M    = 5.0              # car within 5m of stripe center → mark occupied


# ── Module-level model cache ───────────────────────────────────────────────────
# Persists across warm invocations of the same container.

_yolo_model   = None
_sam2_mask_gen = None


def _get_yolo():
    global _yolo_model
    if _yolo_model is None:
        from ultralytics import YOLO
        _yolo_model = YOLO(f"{CAR_MODEL_NAME}.pt")
    return _yolo_model


def _get_mask_gen():
    global _sam2_mask_gen
    if _sam2_mask_gen is None:
        import torch
        from sam2.automatic_mask_generator import SAM2AutomaticMaskGenerator
        from sam2.build_sam import build_sam2_hf
        device = "cuda" if torch.cuda.is_available() else "cpu"
        model = build_sam2_hf("facebook/sam2.1-hiera-large", device=device)
        _sam2_mask_gen = SAM2AutomaticMaskGenerator(
            model,
            points_per_side=32,
            pred_iou_thresh=0.7,
            stability_score_thresh=0.80,
            min_mask_region_area=STRIPE_MIN_AREA,
        )
    return _sam2_mask_gen


# ── Tile math ─────────────────────────────────────────────────────────────────

def meters_per_pixel(lat: float) -> float:
    import math
    return 156543.03392 * math.cos(math.radians(lat)) / (2 ** TILE_ZOOM) / 2  # /2 for @2x


def tile_ground_m(lat: float) -> float:
    """Side length (meters) of one tile on the ground."""
    return TILE_PX * meters_per_pixel(lat)


def pixel_to_latlng(cx: float, cy: float, tile_lat: float, tile_lng: float, mpp: float):
    import math
    dx = (cx - TILE_PX / 2) * mpp
    dy = (TILE_PX / 2 - cy) * mpp
    dlat = dy / 111320.0
    dlng = dx / (111320.0 * math.cos(math.radians(tile_lat)))
    return tile_lat + dlat, tile_lng + dlng


def dist_m(lat1: float, lng1: float, lat2: float, lng2: float, ref_lat: float) -> float:
    import math
    dlat = (lat1 - lat2) * 111320.0
    dlng = (lng1 - lng2) * 111320.0 * math.cos(math.radians(ref_lat))
    return math.sqrt(dlat ** 2 + dlng ** 2)


# ── Tile grid ─────────────────────────────────────────────────────────────────

def compute_tile_grid(
    lot_polygon_geojson: dict, center_lat: float, center_lng: float
) -> Optional[List[Tuple[float, float]]]:
    """
    Return list of (lat, lng) tile centers whose union covers the polygon bbox.
    Returns None when the polygon needs more than MAX_TILES (caller falls back).
    Single-tile lots return a list of length 1 (the centroid).
    """
    import math

    coords = lot_polygon_geojson.get("coordinates", [[]])[0]
    if not coords:
        return [(center_lat, center_lng)]

    lats = [c[1] for c in coords]
    lngs = [c[0] for c in coords]
    bbox_n, bbox_s = max(lats), min(lats)
    bbox_e, bbox_w = max(lngs), min(lngs)

    tile_m  = tile_ground_m(center_lat)
    cos_lat = math.cos(math.radians(center_lat))

    h_m = (bbox_n - bbox_s) * 111320.0
    w_m = (bbox_e - bbox_w) * 111320.0 * cos_lat

    n_rows = max(1, math.ceil(h_m / tile_m))
    n_cols = max(1, math.ceil(w_m / tile_m))

    if n_rows * n_cols > MAX_TILES:
        return None  # signal to fall back

    bbox_clat = (bbox_n + bbox_s) / 2
    bbox_clng = (bbox_e + bbox_w) / 2

    centers = []
    for ri in range(n_rows):
        for ci in range(n_cols):
            dlat_m = ((n_rows - 1) / 2.0 - ri) * tile_m   # ri=0 → northmost
            dlng_m = (ci - (n_cols - 1) / 2.0) * tile_m   # ci=0 → westmost
            t_lat = bbox_clat + dlat_m / 111320.0
            t_lng = bbox_clng + dlng_m / (111320.0 * cos_lat)
            centers.append((t_lat, t_lng))

    return centers


# ── Tile fetch (I/O-bound → thread pool) ─────────────────────────────────────

def fetch_mapbox_tile(lat: float, lng: float) -> bytes:
    import os, requests
    token = os.environ["MAPBOX_TOKEN"]
    url = (
        f"https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/"
        f"{lng},{lat},{TILE_ZOOM}/{TILE_SIZE}x{TILE_SIZE}@2x"
        f"?access_token={token}"
    )
    r = requests.get(url, timeout=20)
    r.raise_for_status()
    return r.content


def fetch_tiles_parallel(tile_centers: List[Tuple[float, float]]) -> Dict:
    """Fetch all tiles concurrently. Returns {(lat,lng): bytes | Exception}."""
    from concurrent.futures import ThreadPoolExecutor, as_completed
    results: Dict = {}
    with ThreadPoolExecutor(max_workers=min(len(tile_centers), 8)) as ex:
        futures = {ex.submit(fetch_mapbox_tile, lat, lng): (lat, lng)
                   for lat, lng in tile_centers}
        for fut in as_completed(futures):
            key = futures[fut]
            try:
                results[key] = fut.result()
            except Exception as e:
                results[key] = e
    return results


# ── Per-tile YOLO ─────────────────────────────────────────────────────────────

def run_yolo_on_tile(tile_bytes: bytes, tile_lat: float, tile_lng: float) -> List[dict]:
    """Run yolov8x-obb on one tile, return cars with lat/lng."""
    import io
    from PIL import Image
    model = _get_yolo()
    img   = Image.open(io.BytesIO(tile_bytes))
    mpp   = meters_per_pixel(tile_lat)
    cars  = []
    for r in model(img, verbose=False):
        if r.obb is None:
            continue
        for box in r.obb:
            cls  = int(box.cls[0])
            if cls not in {9, 10}:
                continue
            conf = float(box.conf[0])
            if conf < 0.3:
                continue
            cx, cy = float(box.xywhr[0][0]), float(box.xywhr[0][1])
            lat, lng = pixel_to_latlng(cx, cy, tile_lat, tile_lng, mpp)
            cars.append({
                "lat": lat, "lng": lng, "conf": conf,
                "class": "small vehicle" if cls == 10 else "large vehicle",
            })
    return cars


# ── Per-tile SAM2 ─────────────────────────────────────────────────────────────

def run_sam2_on_tile(
    tile_bytes: bytes, tile_lat: float, tile_lng: float
) -> Tuple[List[dict], str]:
    """
    Run SAM2 on one tile.
    Returns (stripes_list, diag_string).
    Each stripe already has lat/lng projected from this tile's center.
    """
    import io
    import numpy as np
    from PIL import Image
    try:
        mask_gen = _get_mask_gen()
        img_np   = np.array(Image.open(io.BytesIO(tile_bytes)).convert("RGB"))
        masks    = mask_gen.generate(img_np)
        total    = len(masks)
        mpp      = meters_per_pixel(tile_lat)

        stripes  = []
        rej_area = rej_ar = 0
        for m in masks:
            area = m["area"]
            if area < STRIPE_MIN_AREA or area > STRIPE_MAX_AREA:
                rej_area += 1
                continue
            x, y, w, h = m["bbox"]
            if w == 0 or h == 0:
                continue
            ar = max(w, h) / min(w, h)
            if ar < STRIPE_MIN_AR or ar > STRIPE_MAX_AR:
                rej_ar += 1
                continue
            cx, cy = x + w / 2, y + h / 2
            lat, lng = pixel_to_latlng(cx, cy, tile_lat, tile_lng, mpp)
            stripes.append({
                "lat": lat, "lng": lng,
                "area_px": area, "aspect_ratio": ar,
                "stability_score": float(m.get("stability_score", 0)),
                "tile_center": (tile_lat, tile_lng),
            })

        diag = f"masks={total}|rej_area={rej_area}|rej_ar={rej_ar}|passed={len(stripes)}"
        return stripes, diag

    except Exception as e:
        return [], f"sam2_error:{str(e)[:80]}"


# ── Deduplication ─────────────────────────────────────────────────────────────

def deduplicate_stripes(all_stripes: List[dict], center_lat: float) -> List[dict]:
    """
    Remove stripes within DEDUP_RADIUS_M of a higher-stability-score stripe.
    Sort descending by stability_score first so the best candidate wins each cluster.
    O(n²) — acceptable for n < ~5000.
    """
    if not all_stripes:
        return []
    sorted_s = sorted(all_stripes, key=lambda s: s.get("stability_score", 0), reverse=True)
    kept: List[dict] = []
    for candidate in sorted_s:
        if not any(
            dist_m(candidate["lat"], candidate["lng"], k["lat"], k["lng"], center_lat) < DEDUP_RADIUS_M
            for k in kept
        ):
            kept.append(candidate)
    return kept


# ── Car → stripe matching (lat/lng, works across tiles) ───────────────────────

def match_cars_to_stripes_latlng(
    stripes: List[dict], cars: List[dict], center_lat: float
) -> List[dict]:
    for stripe in stripes:
        stripe["occupied"] = any(
            dist_m(stripe["lat"], stripe["lng"], car["lat"], car["lng"], center_lat) < CAR_MATCH_M
            for car in cars
        )
    return stripes


# ── PCA grid fallback ─────────────────────────────────────────────────────────

def grid_fallback(lot_polygon_geojson: dict, center_lat: float, center_lng: float,
                  n_spaces_hint: int = None) -> List[dict]:
    import math
    import numpy as np
    from shapely.geometry import Polygon, Point
    from shapely.affinity import rotate
    try:
        coords = lot_polygon_geojson.get("coordinates", [[]])[0]
        if not coords or len(coords) < 3:
            return []

        def to_m(lat, lng):
            return ((lng - center_lng) * 111320.0 * math.cos(math.radians(center_lat)),
                    (lat - center_lat) * 111320.0)

        pts_m    = np.array([to_m(c[1], c[0]) for c in coords[:-1]])
        ev, evec = np.linalg.eig(np.cov(pts_m.T))
        long_ax  = evec[:, np.argsort(-ev)[0]]
        angle    = math.degrees(math.atan2(long_ax[1], long_ax[0]))
        poly_m   = Polygon(pts_m)
        if poly_m.area < 10:
            return []

        n_spaces   = n_spaces_hint or max(4, int(poly_m.area / 25))
        pr         = rotate(poly_m, -angle, origin=(0, 0))
        rx0, ry0, rx1, ry1 = pr.bounds
        row_pitch  = 5.5 + 6.0   # stall depth + aisle
        spaces     = []
        labels     = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"

        for ri in range(max(1, int((ry1 - ry0) / row_pitch))):
            ry_c = ry0 + (ri + 0.5) * row_pitch
            lbl  = labels[ri % len(labels)]
            for ci in range(max(1, int((rx1 - rx0) / 2.7))):
                rx_c = rx0 + (ci + 0.5) * 2.7
                if not pr.buffer(-0.5).contains(Point(rx_c, ry_c)):
                    continue
                a   = math.radians(angle)
                ox  = rx_c * math.cos(a) - ry_c * math.sin(a)
                oy  = rx_c * math.sin(a) + ry_c * math.cos(a)
                spaces.append({
                    "row_label": lbl, "space_num": ci + 1,
                    "lat":  center_lat + oy / 111320.0,
                    "lng":  center_lng + ox / (111320.0 * math.cos(math.radians(center_lat))),
                    "polygon": None, "occupied": False,
                    "confidence": 0.4, "source": "grid_fallback",
                })

        if len(spaces) > n_spaces * 1.5:
            spaces = spaces[:int(n_spaces * 1.5)]
        return spaces
    except Exception:
        return []


# ── Main detection function ───────────────────────────────────────────────────

@app.function(
    image=image,
    gpu="T4",
    timeout=300,             # bumped from 120 for multi-tile lots
    secrets=[hf_secret, mapbox_secret],
    # Scale to zero during dev. Set to 1 when we have real users and cold-start latency matters.
    min_containers=0,
    max_containers=10,
)
def detect_lot_spots(
    lot_id: str,
    lot_polygon_geojson: dict,
    centroid_lat: float,
    centroid_lng: float,
) -> Dict[str, Any]:
    import time, datetime
    t0 = time.time()
    ts = datetime.datetime.utcnow().isoformat() + "Z"

    # ── 1. Compute tile grid ──────────────────────────────────────────────────
    tile_centers = compute_tile_grid(lot_polygon_geojson, centroid_lat, centroid_lng)

    if tile_centers is None:
        # Lot exceeds 4×4 cap — grid fallback immediately
        spaces = grid_fallback(lot_polygon_geojson, centroid_lat, centroid_lng)
        return {
            "lot_id": lot_id, "spaces": spaces, "detection_timestamp": ts,
            "model_versions": {"car_detector": "none", "stripe_detector": "none"},
            "source": "grid_fallback", "overall_confidence": 0.4,
            "cars_detected": 0, "spaces_count": len(spaces), "sam2_stripes_found": 0,
            "tiles_fetched": 0, "tiles_needed": f">{MAX_TILES}",
            "raw_stripes_before_dedup": 0, "stripes_after_dedup": 0, "dedup_ratio": 0,
            "tile_diagnostics": [], "fallback_reason": "exceeds_tile_cap",
            "duration_ms": int((time.time() - t0) * 1000),
        }

    tiles_needed = len(tile_centers)

    # ── 2. Fetch all tiles in parallel (I/O) ─────────────────────────────────
    tile_bytes_map = fetch_tiles_parallel(tile_centers)

    # ── 3. Run YOLO + SAM2 on each tile (GPU, sequential) ────────────────────
    all_cars:        List[dict] = []
    all_raw_stripes: List[dict] = []
    tile_diagnostics:List[dict] = []
    any_sam2_error = False

    for tc in tile_centers:
        raw = tile_bytes_map.get(tc)
        if isinstance(raw, Exception):
            tile_diagnostics.append({"tile": tc, "error": str(raw)[:60]})
            continue

        # YOLO
        try:
            cars = run_yolo_on_tile(raw, *tc)
        except Exception as e:
            cars = []
        all_cars.extend(cars)

        # SAM2
        stripes, sam2_diag = run_sam2_on_tile(raw, *tc)
        if sam2_diag.startswith("sam2_error"):
            any_sam2_error = True
        all_raw_stripes.extend(stripes)

        tile_diagnostics.append({
            "tile": tc,
            "cars": len(cars),
            "raw_stripes": len(stripes),
            "sam2_diag": sam2_diag,
        })

    raw_count = len(all_raw_stripes)

    # ── 4. Deduplicate stripes across tile boundaries ─────────────────────────
    deduped = deduplicate_stripes(all_raw_stripes, centroid_lat)
    dedup_count = len(deduped)
    sam2_ok = dedup_count >= 3 and not any_sam2_error

    # ── 5. Build spaces ───────────────────────────────────────────────────────
    if sam2_ok:
        deduped = match_cars_to_stripes_latlng(deduped, all_cars, centroid_lat)
        spaces = [
            {
                "row_label": chr(65 + i // 10),
                "space_num": (i % 10) + 1,
                "lat": s["lat"], "lng": s["lng"],
                "polygon": None,
                "occupied": s.get("occupied", False),
                "confidence": s.get("stability_score", 0.7),
                "source": "sam2",
            }
            for i, s in enumerate(deduped)
        ]
        source = "sam2_full"
        overall_conf = round(sum(s["confidence"] for s in spaces) / len(spaces), 3) if spaces else 0.4
    else:
        spaces = grid_fallback(lot_polygon_geojson, centroid_lat, centroid_lng)
        import math
        for sp in spaces:
            for car in all_cars:
                if dist_m(sp["lat"], sp["lng"], car["lat"], car["lng"], centroid_lat) < 4.0:
                    sp["occupied"] = True
                    break
        source = "grid_fallback"
        overall_conf = 0.4

    dedup_ratio = round(raw_count / dedup_count, 2) if dedup_count > 0 else 0.0

    return {
        "lot_id": lot_id,
        "spaces": spaces,
        "detection_timestamp": ts,
        "model_versions": {
            "car_detector": CAR_MODEL_NAME,
            "stripe_detector": (
                f"sam2_hiera_large|tiles={len(tile_diagnostics)}"
                f"|raw={raw_count}|dedup={dedup_count}|ratio={dedup_ratio}"
            ),
        },
        "source": source,
        "overall_confidence": overall_conf,
        "cars_detected": len(all_cars),
        "spaces_count": len(spaces),
        "sam2_stripes_found": dedup_count if sam2_ok else 0,
        # ── Multi-tile diagnostics ──
        "tiles_fetched":           len(tile_diagnostics),
        "tiles_needed":            tiles_needed,
        "raw_stripes_before_dedup": raw_count,
        "stripes_after_dedup":     dedup_count,
        "dedup_ratio":             dedup_ratio,
        "tile_diagnostics":        tile_diagnostics,
        "duration_ms":             int((time.time() - t0) * 1000),
    }


# ── HTTP endpoint ─────────────────────────────────────────────────────────────

@app.function(
    image=image,
    gpu="T4",
    timeout=300,
    secrets=[hf_secret, mapbox_secret],
    # Scale to zero during dev. Set to 1 when we have real users and cold-start latency matters.
    min_containers=0,
    max_containers=10,
)
@modal.fastapi_endpoint(method="POST")
def detect_lot_spots_http(body: Dict[str, Any]) -> Dict[str, Any]:
    """HTTP wrapper so Railway backend can invoke via fetch()."""
    return detect_lot_spots.local(
        lot_id=str(body.get("lot_id", "")),
        lot_polygon_geojson=body.get(
            "lot_polygon_geojson", {"type": "Polygon", "coordinates": [[]]}
        ),
        centroid_lat=float(body.get("centroid_lat", 0)),
        centroid_lng=float(body.get("centroid_lng", 0)),
    )
