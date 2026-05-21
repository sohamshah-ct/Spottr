import json, sys, os

with open(os.path.join(os.path.dirname(__file__), "mask_stats.json")) as f:
    masks = json.load(f)

PROD_MIN_AREA = 50;   PROD_MAX_AREA = 2000
PROD_MIN_AR   = 1.3;  PROD_MAX_AR   = 6.0
STALL_MIN     = 800;  STALL_MAX     = 8000
STALL_AR_MIN  = 1.5;  STALL_AR_MAX  = 3.5

total = len(masks)
print(f"Total raw masks (no filters): {total}")
print(f"Tile: (41.84004,-72.55528) zoom 19 @2x | mpp=0.1112 m/px")
print(f"Expected stall footprint: ~24x50 px -> area ~1200 px2, AR ~2.1")
print()

counts = {}
for m in masks:
    counts[m["class"]] = counts.get(m["class"], 0) + 1

print("Classification breakdown:")
for cls, n in sorted(counts.items(), key=lambda x: -x[1]):
    pct = 100 * n / total
    print(f"  {cls:<22} {n:>4}  ({pct:5.1f}%)")

print()

# Production filter
prod = [m for m in masks
        if PROD_MIN_AREA <= m["area"] <= PROD_MAX_AREA
        and m["bbox"][2] > 0 and m["bbox"][3] > 0
        and PROD_MIN_AR <= max(m["bbox"][2],m["bbox"][3])/min(m["bbox"][2],m["bbox"][3]) <= PROD_MAX_AR]
print(f"Passing PRODUCTION filter (area {PROD_MIN_AREA}-{PROD_MAX_AREA}, AR {PROD_MIN_AR}-{PROD_MAX_AR}): {len(prod)}")

# Stall hypothesis filter
stall = [m for m in masks
         if STALL_MIN <= m["area"] <= STALL_MAX
         and m["bbox"][2] > 0 and m["bbox"][3] > 0
         and STALL_AR_MIN <= max(m["bbox"][2],m["bbox"][3])/min(m["bbox"][2],m["bbox"][3]) <= STALL_AR_MAX]
print(f"Passing STALL hypothesis filter (area {STALL_MIN}-{STALL_MAX}, AR {STALL_AR_MIN}-{STALL_AR_MAX}): {len(stall)}")

# Combined: stall OR stripe
combined = [m for m in masks
            if (PROD_MIN_AREA <= m["area"] <= STALL_MAX)
            and m["bbox"][2] > 0 and m["bbox"][3] > 0
            and PROD_MIN_AR <= max(m["bbox"][2],m["bbox"][3])/min(m["bbox"][2],m["bbox"][3]) <= PROD_MAX_AR]
print(f"Passing COMBINED (area {PROD_MIN_AREA}-{STALL_MAX}, AR {PROD_MIN_AR}-{PROD_MAX_AR}):    {len(combined)}")

print()
print("Area distribution of large_blob class (2000-20000 px2 -- potential stalls):")
large = [m for m in masks if 2000 < m["area"] <= 20000]
bins = [(2000,3000),(3000,5000),(5000,8000),(8000,12000),(12000,20000)]
for lo, hi in bins:
    subset = [m for m in large if lo <= m["area"] < hi]
    examples = []
    for m in sorted(subset, key=lambda x: -x["area"])[:3]:
        w, h = m["bbox"][2], m["bbox"][3]
        ar = max(w,h)/min(w,h) if min(w,h)>0 else 0
        examples.append(f"[{m['area']}px2 AR{ar:.1f}]")
    print(f"  {lo:>6}-{hi:<6}: {len(subset):>3}  e.g. {' '.join(examples)}")

print()
print("Top 15 'stall' class masks by area:")
for m in sorted([m for m in masks if m["class"]=="stall"], key=lambda x: -x["area"])[:15]:
    w, h = m["bbox"][2], m["bbox"][3]
    ar = max(w,h)/min(w,h) if min(w,h)>0 else 0
    print(f"  area={m['area']:5d}  bbox={w}x{h}px  AR={ar:.2f}  stab={m['stability_score']:.3f}  iou={m['predicted_iou']:.3f}")

print()
print("AR distribution of stall-hypothesis masks:")
ar_bins = [(1.5,2.0),(2.0,2.5),(2.5,3.0),(3.0,3.5)]
for lo, hi in ar_bins:
    n = sum(1 for m in stall
            if m["bbox"][2]>0 and m["bbox"][3]>0
            and lo <= max(m["bbox"][2],m["bbox"][3])/min(m["bbox"][2],m["bbox"][3]) < hi)
    print(f"  AR {lo:.1f}-{hi:.1f}: {n}")
