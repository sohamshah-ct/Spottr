"""
SAM2 diagnostic for Highland Park Market — center tile analysis.
Runs SAM2 with ALL filters disabled to see raw mask distribution.
Saves 3 images + text report to this directory.

Usage:
  MAPBOX_TOKEN=<token> python run_sam2_diag.py
  or via: railway run python diagnostics/run_sam2_diag.py  (from backend dir)
"""

import os, sys, io, json
import numpy as np
import requests
import matplotlib
matplotlib.use('Agg')  # headless
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from PIL import Image

OUT_DIR = os.path.dirname(os.path.abspath(__file__))

# Tile with most raw masks from the 6-tile run:
# (41.84004,-72.55528): masks=102, rej_area=73, rej_ar=16, passed=13
# This is the most information-dense tile for HLP.
TILE_LAT = 41.84004
TILE_LNG = -72.55528
TILE_ZOOM = 19
TILE_SIZE = 640   # @2x → 1280px rendered
TILE_PX   = 1280

# Current production filter bounds (for reference labels)
PROD_MIN_AREA = 50
PROD_MAX_AREA = 2000
PROD_MIN_AR   = 1.3
PROD_MAX_AR   = 6.0
PROD_STABILITY = 0.80

# Stall hypothesis: at zoom 19 @2x, mpp≈0.111m/px
# 2.7m wide × 5.5m deep → ~24 × 50 px → area≈1200 px², AR≈2.1
STALL_AREA_MIN = 800
STALL_AREA_MAX = 8000
STALL_AR_MIN   = 1.5
STALL_AR_MAX   = 3.5


def fetch_tile():
    token = os.environ.get("MAPBOX_TOKEN")
    if not token:
        sys.exit("MAPBOX_TOKEN not set")
    url = (
        f"https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/"
        f"{TILE_LNG},{TILE_LAT},{TILE_ZOOM}/{TILE_SIZE}x{TILE_SIZE}@2x"
        f"?access_token={token}"
    )
    print(f"Fetching tile {TILE_LAT},{TILE_LNG} zoom {TILE_ZOOM} @2x ...")
    r = requests.get(url, timeout=20)
    r.raise_for_status()
    print(f"  Tile size: {len(r.content)//1024} KB")
    return r.content


def run_sam2_unfiltered(img_np):
    """Run SAM2 with all filters off. Return raw masks list."""
    import torch
    from sam2.automatic_mask_generator import SAM2AutomaticMaskGenerator
    from sam2.build_sam import build_sam2_hf

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"  SAM2 device: {device}")
    print("  Loading SAM2 model (may take a moment)...")
    model = build_sam2_hf("facebook/sam2.1-hiera-large", device=device)

    mask_gen = SAM2AutomaticMaskGenerator(
        model,
        points_per_side=32,
        pred_iou_thresh=0.0,       # OFF
        stability_score_thresh=0.0, # OFF
        min_mask_region_area=0,     # OFF
    )
    print("  Generating masks (no filters)...")
    masks = mask_gen.generate(img_np)
    print(f"  Raw masks: {len(masks)}")
    return masks


def classify_mask(m):
    """
    Classify a mask dict into one of:
      'stall'     — rectangular, stall-AR at expected area
      'stripe'    — thin line-like (old filter range)
      'large'     — too large (landscape, building, pavement)
      'small'     — too small (noise, artifact)
      'squat'     — area ok but too square (car, shrub, roof segment)
    """
    area = m["area"]
    x, y, w, h = m["bbox"]
    if w == 0 or h == 0:
        return "noise"
    ar = max(w, h) / min(w, h)
    stab = m.get("stability_score", 0)

    if area < 20:
        return "noise"
    if area < PROD_MIN_AREA:
        return "noise"
    if area > 20000:
        return "large_background"
    if ar < 1.2:
        return "squat"           # square-ish: car top, roof section, bush

    # Stripe-range (old production): 50-2000 px², AR 1.3-6.0
    in_stripe_area = PROD_MIN_AREA <= area <= PROD_MAX_AREA
    in_stripe_ar   = PROD_MIN_AR <= ar <= PROD_MAX_AR

    # Stall hypothesis: 800-8000 px², AR 1.5-3.5
    in_stall_area  = STALL_AREA_MIN <= area <= STALL_AREA_MAX
    in_stall_ar    = STALL_AR_MIN <= ar <= STALL_AR_MAX

    if in_stall_area and in_stall_ar:
        return "stall"
    if in_stripe_area and in_stripe_ar:
        return "stripe"
    if area > PROD_MAX_AREA:
        return "large_blob"      # too big for stripe, could be stall if we raise cap
    return "other"


def mask_to_rgba(m, img_shape):
    """Convert SAM2 mask dict to full-resolution boolean array."""
    seg = m["segmentation"]  # already 1280×1280 bool
    return seg


COLOR_MAP = {
    "stall":            (0.0, 1.0, 0.0, 0.45),   # green  — stall hypothesis match
    "stripe":           (0.0, 0.5, 1.0, 0.45),   # blue   — old filter match
    "large_blob":       (1.0, 0.4, 0.0, 0.30),   # orange — too big for stripe
    "large_background": (0.5, 0.0, 0.0, 0.20),   # dark red — background/landscape
    "squat":            (1.0, 1.0, 0.0, 0.35),   # yellow — square: car/bush/roof
    "noise":            (0.5, 0.5, 0.5, 0.20),   # grey
    "other":            (1.0, 0.0, 1.0, 0.30),   # magenta
}


def save_image_1(img_np, path):
    """Image 1: Raw tile."""
    Image.fromarray(img_np).save(path, quality=92)
    print(f"  Saved: {path}")


def save_image_2(img_np, masks, path):
    """Image 2: All masks overlaid, color-coded by class."""
    fig, ax = plt.subplots(1, 1, figsize=(14, 14), dpi=100)
    ax.imshow(img_np)

    overlay = np.zeros((*img_np.shape[:2], 4), dtype=float)

    counts = {}
    for m in masks:
        cls = classify_mask(m)
        counts[cls] = counts.get(cls, 0) + 1
        color = COLOR_MAP.get(cls, (1,0,1,0.3))
        seg = m["segmentation"]
        for c in range(3):
            overlay[:, :, c] += seg * color[c]
        overlay[:, :, 3] = np.minimum(1.0, overlay[:, :, 3] + seg * color[3])

    overlay[:, :, :3] /= np.maximum(1.0, overlay[:, :, :3].max())
    ax.imshow(overlay)

    # Legend
    patches = [mpatches.Patch(color=v[:3], alpha=0.8,
                               label=f"{k}: {counts.get(k,0)}")
               for k, v in COLOR_MAP.items()]
    ax.legend(handles=patches, loc='upper right', fontsize=10,
              facecolor='black', labelcolor='white')

    ax.set_title(
        f"All {len(masks)} raw masks — Highland Park Market\n"
        f"Tile ({TILE_LAT},{TILE_LNG}) zoom {TILE_ZOOM} @2x, no filters applied",
        fontsize=12, color='white', pad=8
    )
    ax.axis('off')
    fig.patch.set_facecolor('black')
    ax.set_facecolor('black')
    plt.tight_layout(pad=0.5)
    fig.savefig(path, dpi=100, bbox_inches='tight', facecolor='black')
    plt.close(fig)
    print(f"  Saved: {path}")
    return counts


def save_image_3(img_np, masks, path):
    """Image 3: Only rej_area masks (area outside prod stripe range)."""
    rej_masks = [m for m in masks
                 if not (PROD_MIN_AREA <= m["area"] <= PROD_MAX_AREA)]
    large_masks = [m for m in rej_masks if m["area"] > PROD_MAX_AREA]
    small_masks = [m for m in rej_masks if m["area"] < PROD_MIN_AREA]

    fig, axes = plt.subplots(1, 2, figsize=(22, 11), dpi=100)

    for ax, subset, title_suffix, base_color in [
        (axes[0], large_masks, f"Too LARGE (area > {PROD_MAX_AREA} px²): {len(large_masks)} masks", (1.0, 0.3, 0.0)),
        (axes[1], small_masks, f"Too SMALL (area < {PROD_MIN_AREA} px²): {len(small_masks)} masks", (0.2, 0.8, 1.0)),
    ]:
        ax.imshow(img_np)
        overlay = np.zeros((*img_np.shape[:2], 4), dtype=float)
        for m in subset:
            seg = m["segmentation"]
            overlay[:,:,0] += seg * base_color[0]
            overlay[:,:,1] += seg * base_color[1]
            overlay[:,:,2] += seg * base_color[2]
            overlay[:,:,3] = np.minimum(1.0, overlay[:,:,3] + seg * 0.5)
        overlay[:,:,:3] /= np.maximum(1.0, overlay[:,:,:3].max())
        ax.imshow(overlay)

        # Annotate each mask with its area
        for m in sorted(subset, key=lambda x: -x["area"])[:30]:
            bx, by, bw, bh = m["bbox"]
            area = m["area"]
            ar = max(bw,bh)/min(bw,bh) if min(bw,bh)>0 else 0
            ax.text(bx + bw/2, by + bh/2, f"{area}\nAR{ar:.1f}",
                    ha='center', va='center', fontsize=6,
                    color='white', fontweight='bold',
                    bbox=dict(boxstyle='round,pad=0.1', fc='black', alpha=0.5))

        ax.set_title(title_suffix, fontsize=11, color='white')
        ax.axis('off')
        ax.set_facecolor('black')

    fig.suptitle(
        f"Area-rejected masks — Highland Park Market tile ({TILE_LAT},{TILE_LNG})\n"
        f"Production filter: area {PROD_MIN_AREA}–{PROD_MAX_AREA} px²",
        fontsize=12, color='white', y=1.01
    )
    fig.patch.set_facecolor('black')
    plt.tight_layout()
    fig.savefig(path, dpi=100, bbox_inches='tight', facecolor='black')
    plt.close(fig)
    print(f"  Saved: {path}")
    return len(large_masks), len(small_masks)


def print_report(masks, counts):
    print("\n=== MASK CLASSIFICATION REPORT ===\n")
    total = len(masks)
    print(f"Total raw masks (no filters): {total}")
    print(f"Tile: ({TILE_LAT},{TILE_LNG}) zoom {TILE_ZOOM} @2x = {TILE_PX}px")
    print(f"mpp at lat {TILE_LAT}: {156543.03392 * np.cos(np.radians(TILE_LAT)) / (2**TILE_ZOOM) / 2:.4f} m/px")
    print(f"Expected stall footprint: ~24×50 px → area ~1200 px², AR ~2.1")
    print()

    for cls, n in sorted(counts.items(), key=lambda x: -x[1]):
        pct = 100 * n / total if total else 0
        print(f"  {cls:<20} {n:>4}  ({pct:5.1f}%)")

    print()

    # Detailed area histogram for stall-range masks
    stall_masks = [m for m in masks
                   if STALL_AREA_MIN <= m["area"] <= STALL_AREA_MAX
                   and STALL_AR_MIN <= max(m["bbox"][2],m["bbox"][3]) / max(min(m["bbox"][2],m["bbox"][3]),1) <= STALL_AR_MAX]
    print(f"Masks passing STALL hypothesis filter ({STALL_AREA_MIN}-{STALL_AREA_MAX} px², AR {STALL_AR_MIN}-{STALL_AR_MAX}): {len(stall_masks)}")

    prod_masks = [m for m in masks
                  if PROD_MIN_AREA <= m["area"] <= PROD_MAX_AREA
                  and PROD_MIN_AR <= max(m["bbox"][2],m["bbox"][3]) / max(min(m["bbox"][2],m["bbox"][3]),1) <= PROD_MAX_AR]
    print(f"Masks passing PRODUCTION filter ({PROD_MIN_AREA}-{PROD_MAX_AREA} px², AR {PROD_MIN_AR}-{PROD_MAX_AR}): {len(prod_masks)}")

    print()
    print("Area distribution of 'large_blob' class (area > 2000, potential stalls):")
    large = sorted([m for m in masks if m["area"] > PROD_MAX_AREA and m["area"] < 20000],
                   key=lambda m: m["area"])
    bins = [(2000,4000),(4000,6000),(6000,8000),(8000,12000),(12000,20000)]
    for lo, hi in bins:
        n = sum(1 for m in large if lo <= m["area"] < hi)
        x, y, w, h = (0,0,0,0)
        examples = [(m["area"], round(max(m["bbox"][2],m["bbox"][3])/max(min(m["bbox"][2],m["bbox"][3]),1),1))
                    for m in large if lo <= m["area"] < hi][:3]
        ex_str = " ".join(f"[{a}px²,AR{r}]" for a,r in examples)
        print(f"  {lo:>6}-{hi:<6} px²: {n:>3}  e.g. {ex_str}")

    print()
    print("Sample 'stall' class masks (area 800-8000, AR 1.5-3.5):")
    for m in sorted(stall_masks, key=lambda m: -m["area"])[:10]:
        x,y,w,h = m["bbox"]
        ar = max(w,h)/min(w,h) if min(w,h)>0 else 0
        print(f"  area={m['area']:5d} px²  bbox={w}×{h}px  AR={ar:.2f}  stab={m.get('stability_score',0):.3f}")


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    # Fetch tile
    tile_bytes = fetch_tile()
    img = Image.open(io.BytesIO(tile_bytes)).convert("RGB")
    img_np = np.array(img)
    print(f"  Image shape: {img_np.shape}")

    # Save image 1: raw tile
    p1 = os.path.join(OUT_DIR, "1_raw_tile.jpg")
    save_image_1(img_np, p1)

    # Run SAM2 unfiltered
    print("\nRunning SAM2 (unfiltered)...")
    masks = run_sam2_unfiltered(img_np)

    # Save image 2: all masks colored
    print("\nGenerating image 2 (all masks)...")
    p2 = os.path.join(OUT_DIR, "2_all_masks.png")
    counts = save_image_2(img_np, masks, p2)

    # Save image 3: area-rejected masks only
    print("Generating image 3 (area-rejected masks)...")
    p3 = os.path.join(OUT_DIR, "3_area_rejected.png")
    n_large, n_small = save_image_3(img_np, masks, p3)

    # Save raw mask stats as JSON
    mask_stats = [{
        "area": m["area"],
        "bbox": m["bbox"],
        "stability_score": float(m.get("stability_score", 0)),
        "predicted_iou": float(m.get("predicted_iou", 0)),
        "class": classify_mask(m),
    } for m in masks]
    with open(os.path.join(OUT_DIR, "mask_stats.json"), "w") as f:
        json.dump(mask_stats, f, indent=2)
    print(f"  Saved: {os.path.join(OUT_DIR, 'mask_stats.json')}")

    # Print report
    print_report(masks, counts)

    print("\nFiles written to:", OUT_DIR)
    print("  1_raw_tile.jpg          — raw satellite tile")
    print("  2_all_masks.png         — all masks, color-coded by classification")
    print("  3_area_rejected.png     — only area-rejected masks (too large / too small)")
    print("  mask_stats.json         — all mask data for further analysis")


if __name__ == "__main__":
    main()
