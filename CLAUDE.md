# SPOTTR — Claude Code Project Notes

## Known limitations / calibration scope

### Track 4.1 / Option 4 — warehouse_store 220m buffer calibration scope

The 220m symmetric buffer for `warehouse_store` (lots.js `buildingBufferMeters`) is
calibrated for **building-on-parcel-edge** geometry — where the warehouse building
occupies one edge of the parcel and the customer parking lot extends in one primary
direction (empirically validated for Costco South Windsor, Sam's Club Newington,
BJ's Manchester CT).

For warehouse_store lots with the building near the parcel centre and parking
distributed on multiple sides, Option 4 may over-buffer in directions that contain
irrelevant area (adjacent buildings, roads, other businesses). Such lots should be
flagged for Track 5 Option 5 treatment.

---

## Roadmap / deferred items

### Track 5+ / Option 5 — directional buffer for warehouse_store

If Option 4 contamination exceeds estimates at production scale, or if
`warehouse_store` expansion reaches lots with non-edge-aligned buildings, implement
Option 5: directional buffer using road-proximity Overpass query at hydration time.
Detect nearest major road east of building within 350m; extend east edge to road +
margin; use 80m buffer W/N/S.

Pre-clamp area ~1.64e-5 deg² requires `MAX_INFERRED_DEG2_WAREHOUSE` at `(460/111320)²`
or the same 710m-equivalent constant already in place. Produces ~326m N-S × ~464m E-W
bbox for Costco South Windsor geometry — 55% smaller than Option 4 with equivalent
east coverage. Not blocking MVP.

---

## Gating process rules

### Gate 1 tile-budget check (MANDATORY for any track touching bbox dimensions)

Gate 1 plans that modify bbox dimensions or area caps **MUST** verify the planned bbox
fits within `detect.py`'s `MAX_TILES` budget before approval. At z19 with 1280px tiles:

```
mpp            = 156543 * cos(lat) / 2^19 / 2      # meters per pixel
tile_ground_m  = 1280 * mpp                         # meters per tile side
tiles_per_side = ceil(bbox_side_meters / tile_ground_m)
total_tiles    = tiles_per_side ^ 2  must be <= MAX_TILES
```

For warehouse_store at Hartford latitude (~41.8°N): `MAX_TILES = 25` (5×5) supports
bboxes up to ~710m per side.

If the planned bbox exceeds `MAX_TILES`, raise the constant in `detect.py` and redeploy
Modal **before Gate 2 implementation**, not discovered during Gate 3. The Track 4.1
Gate 3 run surfaced this failure mode after the lot.js commit was already merged and
deployed — the tile budget check must be part of Gate 1 approval to prevent recurrence.
