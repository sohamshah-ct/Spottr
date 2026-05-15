# SPOTTR — Spec Addendum V5 (Live Detection Architecture)

This addendum **replaces V4's batch pipeline architecture** with on-demand live detection. The synthetic-grid bug Gemini found is fixed as a byproduct of running real computer vision against real imagery.

## Why V5 exists

V1-V4 specified a batch pre-processing pipeline that would build a proprietary dataset by running YOLOv8 across every parking lot in a geographic region overnight. The overnight build in fact ran a synthetic-grid generator instead of real detection — the 71,895 spaces currently in the DB are mathematical placeholders, not real spot coordinates.

Beyond the bug, batch architecture was strategically wrong for SPOTTR. The right architecture is what the user originally imagined: when someone searches a location, the app fetches current satellite imagery of that lot and runs AI on it live. This is more honest (users see what's actually there now, not a stale pre-computed answer), it matches the "Live Sat" toggle in the original mockups, and it builds the moat as a byproduct of serving users rather than requiring a separate batch operation.

V5 implements this. Live detection at request time, aggressive caching, and the historical record (occupancy_history) accumulates from every real detection rather than being a synthetic artifact.

---

## Coverage: this works globally from day one

**V5 is not limited to Hartford or Connecticut.** Any user, anywhere in the world, can search any parking lot and get a live detection. The architecture supports this natively:

- **Mapbox satellite imagery** covers virtually all of Earth's land surface. US urban areas get 30-50cm resolution; other regions vary but are almost always usable.
- **Google Places** indexes every business and addressable location globally.
- **OpenStreetMap Overpass API** has parking lot polygons in most populated areas of the world (and we fetch new ones on demand when a user searches a lot we don't have).
- **Modal GPU functions** are stateless and run identically for any input lat/lng.

### What happens when a user searches outside the existing 692 lots

The existing 692 Hartford-area lots are just a head start, not a coverage limit. When a user in Sydney searches a Westfield mall, the flow is:

1. Google Places returns the mall's coordinates
2. Backend queries the `lots` table — no match
3. Backend queries OpenStreetMap Overpass for `amenity=parking` polygons within 200m of those coordinates
4. The new polygon(s) get inserted into the `lots` table with `region='long_tail'`
5. Modal detection runs on the new lot using Mapbox imagery
6. User sees real spots on real imagery, just like they would in Hartford

The database fills itself organically as users explore. No batch jobs, no pre-computation, no geographic limits.

### What the 5 South Windsor lots in Section 8 actually are

They are a **verification set**, not a coverage target. We pick 5 lots the user can physically drive to (because the user lives 10 minutes from South Windsor) so we can ground-truth whether the AI is detecting spots correctly. After verification confirms it works for those 5 lots, the same code works for every lot on Earth.

If verification passes in South Windsor, V5 is launch-ready globally on the same day.

### Quality caveat

Detection quality correlates with imagery quality, not architecture. Some areas of the world have lower-resolution Mapbox tiles than US urban centers, which means:

- US, EU, Australia, major Asian cities → expect ~90% SAM2-based real detection, ~10% grid fallback
- Smaller cities, less-mapped regions → expect ~60% real detection, ~40% grid fallback
- Very rural or low-imagery areas → mostly grid fallback (still oriented correctly to the lot, just less precise on individual spots)

The grid fallback is geometrically correct (PCA-oriented to the lot polygon, bounded by edges) so even worst-case results are usable for navigation. They're just less precise than the real detection results.

This is a **quality gradient, not a coverage limit**. Every lat/lng on Earth that has a Mapbox tile and an OSM polygon will return some result.

---

## Architecture overview

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  Mobile app  │───▶│  Railway API │───▶│ Modal GPU fn │───▶│  Mapbox tile │
│ (search lot) │    │ (route, ckp) │    │ (real CV)    │    │ (~0.14s img) │
└──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘
                            │                    │
                            ▼                    ▼
                    ┌──────────────┐    ┌──────────────┐
                    │  Railway DB  │    │  HF Models   │
                    │ (cache+hist) │    │ (cars+stripe)│
                    └──────────────┘    └──────────────┘
                            │
                            ▼
                    ┌──────────────┐
                    │ OSM Overpass │ ← fetched on demand for lots not yet in DB
                    │ (any lot)    │
                    └──────────────┘
```

When a user searches:
1. Mobile app calls `/api/lots/near?lat=X&lng=Y` on Railway backend
2. Railway checks Postgres for cached detection (< 4 hours old)
3. If cached: return immediately (~50ms)
4. If not cached: call Modal GPU function with the lot polygon
5. Modal fetches Mapbox satellite tile, runs aerial-trained YOLO for cars + SAM2-derived stripe detection
6. Modal returns {space_id, lat, lng, occupied} for every spot
7. Railway caches the result, writes to occupancy_history, returns to mobile
8. Mobile renders the lot with real spot positions

Total latency for fresh detection: ~1.5-3 seconds (Modal cold) or ~0.8-1.5 seconds (Modal warm).
Total latency for cached: ~50-100ms.

---

## Section 1: Stack additions (V5 vs V4)

### New components

| Component | Purpose | Cost |
|---|---|---|
| Modal GPU function | Run YOLO + stripe detection on demand | $30/mo free credits, $5 cap |
| Hugging Face aerial models | Cars trained on top-down imagery | Free |
| SAM2 (from Meta) | Stripe/space outline segmentation | Free |
| `lot_detections` table | Cache layer | ~$0 storage on Railway |

### Unchanged from V4

Everything else stays. Database schema (with one new table), Railway backend, mobile app, GitHub repo, S3 backups, Mapbox imagery, Google Places search, all 692 lots in Postgres (re-detected though, see Section 6).

### Removed from V4

- `pipeline/03_spot_detection.py` (replaced by Modal function)
- `pipeline/utils/naip_downloader.py` (NAIP not used for V5 — Mapbox sufficient)
- Batch processing infrastructure (no more "process all 692 lots overnight")
- The synthetic grid generator (was the bug)

---

## Section 2: Model selection

Two models running on Modal:

### Model A: Aerial vehicle detection

**Model:** `keremberke/yolov8n-aerial-sheep` *(placeholder — see selection logic below)*

Actually, the correct model needs to be selected by Claude Code from one of these candidates on Hugging Face, validated by running test inference on a known Mapbox satellite tile of a Hartford parking lot:

1. `Ultralytics/YOLOv8` with `xView` fine-tuning weights — military/satellite imagery, includes vehicles
2. `keremberke/yolov8n-aerial-vehicles` — purpose-built for nadir aerial views
3. `microsoft/dior-yolov8` — DIOR dataset trained, includes vehicles in top-down view
4. `arnabdhar/YOLOv8-DOTA-cars` — DOTA dataset (large aerial benchmark), cars class

Claude Code should:
- Download each candidate via Hugging Face token
- Run inference on a fixed test tile: `https://api.mapbox.com/v4/mapbox.satellite/tilequery/-72.6745,41.7637.json?access_token=$MAPBOX_TOKEN` (a known Hartford parking lot)
- Pick the model with the highest car-detection confidence on that tile
- Default to whichever performs best, but log all confidence scores for verification

If none score above 0.5 confidence, fall back to fine-tuning the base YOLOv8n on a tiny synthetic dataset of aerial parking images (skip for now, flag for later).

### Model B: Parking stripe / space outline detection

**Model:** `facebook/sam2-hiera-large` (Segment Anything 2 from Meta)

SAM2 is a foundation model for segmentation — it can identify any visible object boundary in an image without specific training. For parking stripes, we use it in "automatic" mode: it generates masks for every distinguishable region in the tile, and we filter for the rectangular shapes consistent with parking stripes (aspect ratio 2:1 to 3:1, area in expected range for a parking spot at the tile's zoom level).

Fallback when SAM2 fails (faded paint, gravel lots, low contrast): use the *lot's bounding box from OSM* and generate a grid that respects the lot's actual orientation. Specifically:
1. Compute the principal axis of the lot polygon via PCA
2. Generate rows aligned to that axis (not east-west by default)
3. Bound each row by the actual polygon edges (no spots in the street)
4. This is still synthetic but at least geometrically correct and bounded

The output of SAM2 is real spot polygons. The fallback is geometrically-correct synthetic polygons. Both are way better than the current east-west-line bug.

---

## Section 3: Modal function deployment

Deploy a single Modal app called `spottr-detection` containing one function: `detect_lot_spots`.

### File structure

Create `backend/modal/detect.py` (new file). This is Python code that defines the Modal app.

```python
# backend/modal/detect.py

import modal
from typing import List, Dict, Any

# Define the Modal app
app = modal.App("spottr-detection")

# Define the container image with all needed dependencies
image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "ultralytics==8.3.0",
        "torch==2.4.0",
        "torchvision==0.19.0",
        "pillow",
        "numpy",
        "shapely",
        "requests",
        "huggingface_hub",
    )
    .apt_install("libgl1", "libglib2.0-0")  # for OpenCV deps
)

# Mount Hugging Face token from Modal secrets
hf_secret = modal.Secret.from_name("huggingface-token")
mapbox_secret = modal.Secret.from_name("mapbox-token")

@app.function(
    image=image,
    gpu="T4",  # cheapest GPU on Modal, sufficient for YOLO + SAM2
    timeout=120,
    secrets=[hf_secret, mapbox_secret],
    # Keep container warm for 5 min after last call (reduces cold start)
    keep_warm=1,
    container_idle_timeout=300,
)
def detect_lot_spots(
    lot_id: int,
    lot_polygon_geojson: dict,
    centroid_lat: float,
    centroid_lng: float,
) -> Dict[str, Any]:
    """
    Run live detection on a parking lot.
    
    Returns:
        {
            "lot_id": int,
            "spaces": [
                {
                    "lat": float,
                    "lng": float,
                    "polygon": [[lat,lng], ...],  # 4 corners
                    "occupied": bool,
                    "confidence": float,
                    "source": "sam2" | "grid_fallback"
                },
                ...
            ],
            "imagery_timestamp": "Mapbox doesn't expose, use 'recent'",
            "detection_timestamp": iso8601,
            "model_versions": {"car_detector": "...", "stripe_detector": "..."}
        }
    """
    # [Claude Code implements this — see Section 4 for the algorithm]
    pass
```

### Modal secrets

Before deploying, Claude Code creates two Modal secrets:

```bash
modal secret create huggingface-token HF_TOKEN=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
modal secret create mapbox-token MAPBOX_TOKEN=REDACTED_MAPBOX_TOKEN
```

### Deployment

From the project root:

```bash
modal deploy backend/modal/detect.py
```

After deployment, Modal returns a callable URL. Claude Code should capture this URL and store it as `MODAL_DETECT_URL` in Railway env vars so the backend can invoke it.

---

## Section 4: Detection algorithm (inside Modal function)

Pseudocode for what `detect_lot_spots` does:

```
1. Compute the Mapbox tile that contains the lot centroid at zoom 19
   - Mapbox URL: https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/{lng},{lat},19/640x640@2x?access_token=...
   - Result: 1280x1280 pixel image of the area

2. Crop the image to the lot's polygon bounding box (add 10% padding)

3. Run aerial-trained YOLO on the cropped image
   - Detect class: vehicles
   - Get bounding boxes for every car visible
   - Convert pixel coordinates back to lat/lng using Mapbox tile math

4. Run SAM2 in automatic-mask-generation mode on the same cropped image
   - Filter masks: aspect ratio 2:1 to 3:1, area 100-500 pixels²
   - These are parking stripe candidates
   - If we get > 5 stripe candidates, use them as the real spot polygons
   - If we get < 5, fall back to geometric grid generation (Section 4b)

5. Match cars to stripes
   - For each detected car, find the stripe polygon it most overlaps with
   - If overlap > 40%, mark that stripe as occupied
   - Stripes with no overlapping car = empty

6. Return all stripes with their occupied/empty status

4b. Geometric grid fallback (when SAM2 fails):
   - Compute principal axis of the lot polygon via PCA on its vertices
   - Determine row direction (perpendicular to access aisle, parallel to long edge)
   - Estimate total_spaces from lot area (1 spot per ~25 m²)
   - Generate rows aligned to principal axis, bounded by polygon edges
   - For each generated stripe, check if any detected car overlaps
   - Return with source="grid_fallback" so we know data quality is lower
```

### Why this works

The synthetic grid bug happened because the original pipeline never looked at imagery at all — it just generated a grid based on lot area. V5 actually fetches imagery, actually runs vision models, and only falls back to geometric grids when vision fails. Even the fallback is geometrically correct (oriented to the lot, bounded by the polygon).

For verification, every detection includes `confidence` and `source` fields. Lots with low confidence or grid_fallback source are flagged for manual review or model improvement later.

---

## Section 5: Backend integration

### New database table

```sql
-- Detection cache layer
CREATE TABLE IF NOT EXISTS lot_detections (
    id BIGSERIAL PRIMARY KEY,
    lot_id INT NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
    detected_at TIMESTAMP NOT NULL DEFAULT NOW(),
    spaces_data JSONB NOT NULL,  -- array of {lat, lng, polygon, occupied, confidence, source}
    car_detector_model VARCHAR(100),
    stripe_detector_model VARCHAR(100),
    overall_confidence FLOAT,
    source VARCHAR(20) NOT NULL,  -- 'sam2_full' | 'grid_fallback' | 'mixed'
    modal_duration_ms INT,  -- track Modal latency
    expires_at TIMESTAMP NOT NULL  -- detected_at + 4 hours
);

CREATE INDEX idx_lot_detections_lot_fresh ON lot_detections(lot_id, expires_at DESC);
CREATE INDEX idx_lot_detections_expires ON lot_detections(expires_at);
```

### Update `/api/lots/near` route

The existing route in `backend/src/api/lots.js` needs to be modified to support two flows: existing lots in the DB, and on-the-fly OSM lookup for lots anywhere on Earth.

```javascript
// Pseudocode for backend/src/api/lots.js

router.get('/near', async (req, res) => {
  const { lat, lng, radius_m = 200 } = req.query;
  
  // 1. Find lots within radius from existing DB (existing logic)
  let nearbyLots = await db.query(`
    SELECT * FROM lots
    WHERE ST_DWithin(geometry::geography, ST_MakePoint($1, $2)::geography, $3)
    ORDER BY ST_Distance(geometry::geography, ST_MakePoint($1, $2)::geography)
    LIMIT 10
  `, [lng, lat, radius_m]);
  
  // 2. If no lots found in DB, this is a long-tail location — fetch from OSM live
  if (nearbyLots.rows.length === 0) {
    const osmLots = await fetchOSMParkingNear(lat, lng, radius_m);
    
    // Insert any new lots into DB with region='long_tail'
    for (const osmLot of osmLots) {
      await db.query(`
        INSERT INTO lots (osm_id, name, geometry, lat, lng, region, processing_phase, spot_detection_status, first_observed_at)
        VALUES ($1, $2, ST_GeomFromGeoJSON($3), $4, $5, 'long_tail', 0, 'pending', NOW())
        ON CONFLICT (osm_id) DO NOTHING
      `, [osmLot.id, osmLot.name, osmLot.geometry, osmLot.lat, osmLot.lng]);
    }
    
    // Re-query DB to get the just-inserted lots with their new IDs
    nearbyLots = await db.query(`
      SELECT * FROM lots
      WHERE ST_DWithin(geometry::geography, ST_MakePoint($1, $2)::geography, $3)
      ORDER BY ST_Distance(geometry::geography, ST_MakePoint($1, $2)::geography)
      LIMIT 10
    `, [lng, lat, radius_m]);
  }
  
  // 3. For each lot, check cache or trigger live detection (unchanged from V5 original)
  const lotsWithDetections = await Promise.all(nearbyLots.rows.map(async (lot) => {
    // Check cache
    const cached = await db.query(`
      SELECT spaces_data, detected_at, source, overall_confidence
      FROM lot_detections
      WHERE lot_id = $1 AND expires_at > NOW()
      ORDER BY detected_at DESC
      LIMIT 1
    `, [lot.id]);
    
    if (cached.rows.length > 0) {
      return {
        ...lot,
        spaces: cached.rows[0].spaces_data,
        detection_age_seconds: Math.floor((Date.now() - cached.rows[0].detected_at) / 1000),
        source: cached.rows[0].source,
        confidence: cached.rows[0].overall_confidence,
        cached: true,
      };
    }
    
    // Cache miss — trigger Modal detection
    try {
      const detectionResult = await invokeModalDetection(lot);
      
      // Write to cache
      await db.query(`
        INSERT INTO lot_detections (lot_id, spaces_data, car_detector_model, stripe_detector_model, overall_confidence, source, modal_duration_ms, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + INTERVAL '4 hours')
      `, [lot.id, JSON.stringify(detectionResult.spaces), detectionResult.car_model, detectionResult.stripe_model, detectionResult.confidence, detectionResult.source, detectionResult.duration_ms]);
      
      // Write to occupancy_history (every spot, occupied or empty)
      for (const space of detectionResult.spaces) {
        await db.query(`
          INSERT INTO occupancy_history (lot_id, occupied, confidence, source, captured_at)
          VALUES ($1, $2, $3, $4, NOW())
        `, [lot.id, space.occupied, space.confidence, detectionResult.source]);
      }
      
      return {
        ...lot,
        spaces: detectionResult.spaces,
        detection_age_seconds: 0,
        source: detectionResult.source,
        confidence: detectionResult.confidence,
        cached: false,
      };
    } catch (err) {
      console.error(`Modal detection failed for lot ${lot.id}:`, err);
      return {
        ...lot,
        spaces: [],
        detection_age_seconds: null,
        source: 'modal_failed',
        confidence: 0,
        cached: false,
        error: 'Detection temporarily unavailable',
      };
    }
  }));
  
  res.json({ lots: lotsWithDetections });
});

// Helper: fetch parking polygons from OSM for a given location
async function fetchOSMParkingNear(lat, lng, radius_m) {
  const overpassQuery = `
    [out:json][timeout:25];
    (
      way["amenity"="parking"](around:${radius_m},${lat},${lng});
      relation["amenity"="parking"](around:${radius_m},${lat},${lng});
    );
    out geom;
  `;
  
  const response = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: 'data=' + encodeURIComponent(overpassQuery),
  });
  const data = await response.json();
  
  return data.elements.map(el => ({
    id: el.id,
    name: el.tags?.name || el.tags?.['addr:housename'] || 'Unnamed parking',
    geometry: convertOsmToGeoJson(el),
    lat: el.center?.lat ?? el.lat,
    lng: el.center?.lon ?? el.lon,
  }));
}

// Helper to invoke Modal
async function invokeModalDetection(lot) {
  const modalUrl = process.env.MODAL_DETECT_URL;
  const response = await fetch(modalUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lot_id: lot.id,
      lot_polygon_geojson: lot.geometry,
      centroid_lat: lot.lat,
      centroid_lng: lot.lng,
    }),
  });
  if (!response.ok) throw new Error(`Modal returned ${response.status}`);
  return await response.json();
}
```

This means **any search anywhere on Earth** triggers either a cached-DB hit, a fresh-detection on an existing lot, or a fresh OSM-fetch + detection for lots we've never seen before. The DB grows organically.

### Update the `/api/lots/:id/rows` route

Similar pattern — check cache, trigger Modal if stale, return spaces structured as rows.

### New env vars on Railway

```
MODAL_DETECT_URL=https://spottr--spottr-detection-detect-lot-spots.modal.run
# Claude Code captures this from `modal deploy` output and adds to Railway
```

---

## Section 6: Data migration plan

The current 71,895 spaces in the DB are synthetic and unusable. They need to be removed without losing the lot polygons (which are real, from OSM) or the schema infrastructure.

### Migration steps

```sql
-- Migration: 003_v5_live_detection.sql

BEGIN;

-- Preserve the lot polygons but drop synthetic spaces
DELETE FROM occupancy_history WHERE source = 'yolo';  -- the synthetic occupancy data
DELETE FROM spaces;  -- the synthetic spot grid

-- Reset detection status so lots will trigger fresh detection
UPDATE lots SET 
  spot_detection_status = 'pending',
  spot_detection_attempts = 0,
  last_spot_detection = NULL;

-- Create the new cache table (from Section 5)
CREATE TABLE IF NOT EXISTS lot_detections (
  -- (full schema from Section 5)
);

COMMIT;
```

After migration:
- 692 lots remain in DB with their OSM polygons intact
- 0 spaces (will be repopulated by Modal on demand)
- 0 occupancy_history rows (will accumulate from real detections)
- `lot_detections` cache ready

**This is intentionally destructive of the synthetic data.** The "moat" was always going to start accumulating from the first real detection — that hasn't happened yet, so we're not losing anything real.

---

## Section 7: Mobile UX changes

### Loading state for fresh detections

Current behavior: app fetches lot data, renders immediately or shows "Row data not yet available."

New behavior: when a lot's data is fresh from cache, render immediately. When it's a cache miss, show an "Analyzing parking lot..." loading state for 1-3 seconds while Modal runs.

### Implementation in `mobile/src/screens/LotDetail.tsx`

Pseudocode:

```typescript
const [lot, setLot] = useState<Lot | null>(null);
const [loading, setLoading] = useState<'cached' | 'fresh' | 'done'>('fresh');

useEffect(() => {
  const fetchLot = async () => {
    const response = await api.get(`/api/lots/near?lat=${searchLat}&lng=${searchLng}`);
    const lotData = response.data.lots[0];
    
    // If cached: show immediately
    if (lotData.cached) {
      setLoading('done');
      setLot(lotData);
    } else {
      // Modal ran fresh — already 1-3 seconds elapsed
      setLoading('done');
      setLot(lotData);
    }
  };
  fetchLot();
}, [searchLat, searchLng]);

return loading === 'fresh' ? (
  <View>
    <ActivityIndicator size="large" color="#00FF85" />
    <Text>Analyzing parking lot from satellite...</Text>
    <Text style={{fontSize: 12, opacity: 0.6}}>
      ~3 seconds — checking real-time availability
    </Text>
  </View>
) : (
  <LotDetailView lot={lot} />
);
```

### Show data freshness

In the lot detail view, display when the data was captured:

```typescript
{lot.detection_age_seconds < 60 && <Badge>Just now</Badge>}
{lot.detection_age_seconds >= 60 && lot.detection_age_seconds < 3600 && (
  <Badge>{Math.floor(lot.detection_age_seconds / 60)}m ago</Badge>
)}
{lot.detection_age_seconds >= 3600 && (
  <Badge>{Math.floor(lot.detection_age_seconds / 3600)}h ago</Badge>
)}
```

### Show confidence indicator

If confidence < 0.5 or source === 'grid_fallback', show a small warning:

```typescript
{lot.confidence < 0.5 && (
  <Text style={{color: 'orange', fontSize: 12}}>
    ⚠️ Lower confidence detection — spot positions may be approximate
  </Text>
)}
```

---

## Section 8: Verification plan

Before declaring V5 complete, we ground-truth on 5 South Windsor lots that the user can physically drive to and inspect.

### Test lots (chosen near user's location in South Windsor, CT 06074)

| Lot | Address | Expected characteristics |
|---|---|---|
| 1 | Highland Park Market, 1240 Sullivan Ave, South Windsor | Large striped lot, easy case |
| 2 | Stop & Shop, 1320 Sullivan Ave, South Windsor | Large with multiple rows, medium difficulty |
| 3 | South Windsor Town Hall lot, 1540 Sullivan Ave | Smaller, government building |
| 4 | Evergreen Walk lots, 501 Evergreen Way | Modern striping, varied angles |
| 5 | Avery Street Christian Reformed Church, 661 Avery St | Small/medium, irregular shape (this is where Gemini found the bug originally) |

### Verification protocol

For each test lot:

1. Open the SPOTTR mobile app
2. Search the address
3. Tap the lot
4. Wait for Modal detection to complete (~3 seconds)
5. Observe the displayed row data and spot positions
6. **Drive to the lot in person**
7. Compare:
   - Does the row layout match reality?
   - Are the spot count approximately correct (within ±10%)?
   - Do the lat/lng coordinates of an "open" spot actually take you to a real spot when used in Apple/Google Maps?
   - Are obviously-occupied spots flagged as occupied?
8. Log results in a `verification_log` table

### Verification table

```sql
CREATE TABLE IF NOT EXISTS verification_log (
    id SERIAL PRIMARY KEY,
    lot_id INT REFERENCES lots(id),
    verified_at TIMESTAMP DEFAULT NOW(),
    verifier VARCHAR(100),  -- 'soham' for now
    row_layout_correct BOOLEAN,
    spot_count_accurate BOOLEAN,
    coordinates_navigate_correctly BOOLEAN,
    occupancy_accurate BOOLEAN,
    notes TEXT,
    confidence_at_detection FLOAT,
    source_at_detection VARCHAR(20)
);
```

### Success criteria for V5

V5 is considered successful when:
- 4 of 5 test lots return correct row layouts
- 4 of 5 test lots have spot counts within ±10% of actual
- 4 of 5 test lots have coordinates that navigate to real spots in Maps
- No catastrophic failures (lots showing zero spaces, lots with grids in streets)

Failing any of these → diagnose the specific model or algorithm issue and iterate.

---

## Section 9: Cost projection

### Per-request costs

| Component | Cost |
|---|---|
| Mapbox tile fetch | $0 (within 50k/mo free tier) |
| Modal T4 GPU @ ~1.5s warm inference | ~$0.0005 per detection |
| Postgres write (cache + history) | $0 (within Railway plan) |
| **Total per fresh detection** | **~$0.0005** |
| **Total per cached request** | **~$0** |

### Monthly projections at different traffic levels

| Daily searches | Fresh % (assuming 50%) | Monthly Modal cost |
|---|---|---|
| 100 | 50 fresh | ~$0.75 |
| 1,000 | 500 fresh | ~$7.50 |
| 10,000 | 5,000 fresh | ~$75 |
| 100,000 | 50,000 fresh | ~$750 |

For MVP traffic (< 1,000/day), monthly cost stays within Modal's $30 free credits with comfortable headroom. The $5 cap won't trigger.

If/when SPOTTR hits 10k/day, you've validated the product enough to justify either upgrading Modal's plan or optimizing (longer cache windows, request batching).

### One-time costs

- Modal CLI: $0 (already done)
- Hugging Face: $0
- Initial model downloads: $0
- Modal cold start (first invocation after deploy): ~$0.01 one-time

---

## Section 10: Execution order for Claude Code

Tell Claude Code to do these in order. Do not skip steps.

```
Step 1: Database migration
  - Create migration 003_v5_live_detection.sql per Section 6
  - Run it against Railway Postgres
  - Verify: spaces table has 0 rows, occupancy_history has 0 rows where source='yolo'
  - Verify: lot_detections table exists, all 692 lots have spot_detection_status='pending'

Step 2: Modal secrets
  - Set up Modal secrets with the HF and Mapbox tokens (commands in Section 3)
  - Verify: `modal secret list` shows both secrets

Step 3: Create the Modal function
  - Create backend/modal/detect.py per Section 3 skeleton
  - Implement detect_lot_spots() per Section 4 algorithm
  - Critical: implement model selection logic (Section 2) — test all 4 candidate aerial YOLO models on a known Hartford tile, log confidence scores, pick the winner
  - Critical: implement SAM2 automatic-mask-generation with the filtering criteria
  - Critical: implement the geometric-grid fallback (Section 4b) — PCA on lot polygon for orientation, bounded by edges
  - Deploy with: modal deploy backend/modal/detect.py
  - Capture the deployment URL

Step 4: Add MODAL_DETECT_URL to Railway env vars

Step 5: Update backend routes
  - Modify backend/src/api/lots.js per Section 5 to call Modal on cache miss
  - Add the invokeModalDetection helper
  - Make sure occupancy_history writes happen on every detection (every spot, occupied or empty)
  - Add error handling: if Modal fails, return lot with empty spaces and error flag

Step 6: Test on one Hartford lot
  - Pick a known Hartford lot ID from the existing 692
  - Manually invoke the Modal function with that lot's polygon
  - Verify the response has real (not synthetic) spot positions
  - Check that a row was written to lot_detections and occupancy_history

Step 7: Mobile UX updates
  - Update mobile/src/screens/LotDetail.tsx per Section 7
  - Add the loading state, freshness badge, confidence indicator
  - Build and test on the Expo dev client

Step 8: Verification on 5 South Windsor lots
  - Create the verification_log table per Section 8
  - Pre-detect all 5 test lots so they're cached
  - Print the lot detail screen state for each
  - Tell me what to physically check when I drive to each lot

Step 9: Report back with:
  - Modal deployment URL (already in Railway env)
  - Which aerial YOLO model was picked and why (confidence scores for all 4 candidates)
  - Sample detection result for one Hartford lot (JSON)
  - 5 South Windsor lots ready for ground-truthing
  - Estimated cost per detection based on actual Modal timings
  - Any failures or warnings encountered
```

---

## Strategic summary

V5 is the architecture you described from the start: live AI on satellite imagery at request time. The previous specs (V1-V4) were over-engineered for a problem you didn't actually have — they assumed you needed a pre-built moat to compete, but the real moat is the historical record that accumulates as users search, combined with the schema work that unifies fragmented data sources.

V5 makes that explicit:
- Users get an honest live view of any lot they search
- The historical record grows organically as a byproduct of serving users
- The synthetic-grid bug dies because we actually run real CV
- Costs stay within free tier through MVP
- The product feels like what you originally imagined — search → see real cars on real satellite imagery → navigate to a real spot

When SPOTTR has real users and accumulated occupancy_history reaches 6+ months, **that** data is the moat. Not the pre-computed grid that V4 specified.

This is the right architecture. Build it.
