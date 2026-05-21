# CV Pipeline — Step-by-Step

These three images represent a single lot detection run against Highland Park Market,
Manchester CT (a ~150-space commercial lot). Each step is a real debug output from
the production pipeline.

## step1-input-tile.jpg — Satellite tile input

A z19 Mapbox/Maxar satellite tile stitched from multiple sub-tiles covering the lot
bounding box. At z19, ground resolution is ~0.3 m/pixel — enough to resolve
individual car widths and painted stripe edges. Up to 25 tiles (5×5 grid) are fetched
and stitched per lot before YOLOv8-OBB runs stripe orientation detection.

## step2-sam2-segmentation.png — SAM2 raw segment output

All segment classes returned by SAM2 automatic-mask-generation before filtering.
Color coding: `mat` (asphalt/road surface), `stripe` (white lane markings),
`large_bldg` (building footprint), `small_background` (roadside fixtures, landscaping),
`noise` (sub-pixel artefacts). This lot produced ~436 raw segments. Only `stripe` and
`mat` class segments proceed to the area filter.

## step3-area-filter.png — Area rejection step

Left panel: segments rejected because they are too large (>2 000 px², likely a
building or full lot surface) or too small (<50 px², noise). Right panel: the
remaining candidate parking-space segments overlaid on the satellite tile. These
survivors pass to occupancy classification (pixel intensity + stripe overlap → open
vs occupied) and spatial clustering into zones A–D.

---

The production pipeline runs on Modal serverless GPU (A10G). Cold start ~60–120s,
warm inference ~3s per lot. Results are cached for 7 days since parking lot layouts
change rarely.
