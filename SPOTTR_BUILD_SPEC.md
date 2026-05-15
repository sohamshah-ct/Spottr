# SPOTTR — Technical Build Specification
## For Claude Code Execution

---

## What We're Building

A consumer parking app that uses satellite imagery, AI occupancy detection, and passive GPS crowdsourcing to show drivers exactly which row of any parking lot has open spots — and routes them there with a lat/long deep link to Apple Maps or Google Maps.

The core differentiator is a **proprietary geocoded parking dataset** that doesn't exist anywhere else: every parking lot on earth, broken into individually geocoded spaces, each with a predicted occupancy curve built from public government data.

---

## Accounts & Keys Status

| Service | Status | Notes |
|---|---|---|
| Google Maps Static API | ✅ Key confirmed | Restrict to your domain in Google Cloud Console |
| Mapbox | ✅ Key confirmed | Restrict to app bundle ID in Mapbox dashboard |
| Mapillary | ✅ Key confirmed | Ready to use |
| AWS | ✅ Fully configured | S3 bucket spottr-imagery created + IAM user spottrapp with keys |
| Railway | ✅ Fully configured | Postgres + Redis both Online — connection strings confirmed |
| Expo | ✅ Account confirmed | Project: Scattr / Account: Coder 119 |
| OpenStreetMap | ✅ No key needed | Free public Overpass API |
| Hartford Open Data | ✅ No key needed | Free Socrata API |
| USGS/NAIP | ✅ No key needed | Free bulk download for detection pipeline |
| Nearmap | ⏭ Skipped for MVP | Mapbox satellite replaces this at no cost |
| BlackSky | ⏭ Skipped for MVP | Enterprise feature — revisit post-funding |

**Still needed before build:**
1. Railway: click Deploy Redis+Postgres+Bucket → copy DATABASE_URL and REDIS_URL → add to .env
2. AWS: create S3 bucket  + create IAM user with S3 access → copy keys to .env

---

## Tech Stack

```
Backend:      Node.js (Express) + PostgreSQL with PostGIS extension
ML Pipeline:  Python (YOLOv8, Prophet/LSTM for time-series)
Mobile App:   React Native (iOS + Android from one codebase)
Database:     PostgreSQL 15 + PostGIS 3.4
Cache:        Redis (real-time occupancy state)
Storage:      S3 (satellite imagery tiles, model weights)
Hosting:      Railway or Render for MVP (easy Postgres + Redis)
Maps:         Mapbox GL for in-app map, deep links to Apple/Google Maps
Satellite:    Nearmap API + BlackSky API (toggle between AI overlay and raw imagery)
```

---

## Repository Structure

```
spottr/
├── backend/
│   ├── src/
│   │   ├── api/           # Express routes
│   │   ├── db/            # PostGIS queries
│   │   ├── services/      # Business logic
│   │   └── workers/       # Background jobs
│   ├── package.json
│   └── .env.example
├── pipeline/
│   ├── 01_osm_ingest.py       # OpenStreetMap lot ingestion
│   ├── 02_city_scrapers/      # One file per city open data source
│   ├── 03_spot_detection.py   # YOLOv8 aerial imagery → geocoded spots
│   ├── 04_mapillary.py        # Sign/restriction extraction
│   ├── 05_occupancy_model.py  # Time-series prediction model
│   └── requirements.txt
├── mobile/
│   ├── src/
│   │   ├── screens/       # One file per screen
│   │   ├── components/    # Shared UI
│   │   ├── services/      # API calls, GPS, Maps deep links
│   │   └── store/         # State (Zustand)
│   └── package.json
└── README.md
```

---

## Database Schema

Build this first. Everything else writes to or reads from these tables.

```sql
-- Enable PostGIS
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS postgis_topology;

-- ── LOTS ──────────────────────────────────────────────────────
-- Every parking lot and garage on earth
CREATE TABLE lots (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  osm_id          BIGINT UNIQUE,              -- OpenStreetMap ID
  name            TEXT,
  lot_type        TEXT CHECK (lot_type IN ('surface', 'garage', 'street')),
  address         TEXT,
  city            TEXT,
  state           TEXT,
  country         TEXT DEFAULT 'US',
  geometry        GEOMETRY(POLYGON, 4326),    -- PostGIS polygon boundary
  centroid        GEOMETRY(POINT, 4326),      -- Computed center
  total_spaces    INTEGER,
  levels          INTEGER DEFAULT 1,          -- For garages
  hours           JSONB,                      -- {"mon": "6am-10pm", ...}
  pricing         JSONB,                      -- {"type": "free"|"metered"|"paid", "rate": 2.00}
  restrictions    JSONB,                      -- {"max_hours": 2, "permit_required": false}
  source          TEXT,                       -- 'osm' | 'nyc_open_data' | 'sfmta' | etc
  last_imaged_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_lots_geometry ON lots USING GIST(geometry);
CREATE INDEX idx_lots_centroid ON lots USING GIST(centroid);
CREATE INDEX idx_lots_city ON lots(city);

-- ── ROWS ──────────────────────────────────────────────────────
-- Named rows or levels within a lot (Row A, Level 2, etc.)
CREATE TABLE lot_rows (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id          UUID REFERENCES lots(id) ON DELETE CASCADE,
  label           TEXT NOT NULL,              -- 'A', 'B', 'Level 1', etc.
  entrance_point  GEOMETRY(POINT, 4326),      -- Exact lat/lng to route to
  entrance_bearing FLOAT,                     -- Direction to enter (degrees)
  position_order  INTEGER,                    -- 1 = closest to entrance
  space_count     INTEGER,
  level           INTEGER DEFAULT 1,          -- For garages
  geometry        GEOMETRY(LINESTRING, 4326), -- The row itself
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_rows_lot_id ON lot_rows(lot_id);
CREATE INDEX idx_rows_entrance ON lot_rows USING GIST(entrance_point);

-- ── SPACES ────────────────────────────────────────────────────
-- Individual geocoded parking spaces — the core proprietary asset
CREATE TABLE spaces (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id          UUID REFERENCES lots(id) ON DELETE CASCADE,
  row_id          UUID REFERENCES lot_rows(id),
  space_label     TEXT,                       -- 'A-02', 'B-14', etc.
  position        GEOMETRY(POINT, 4326),      -- Exact GPS coordinate of space
  space_type      TEXT DEFAULT 'standard',    -- 'standard'|'handicap'|'ev'|'compact'
  confidence      FLOAT,                      -- 0-1, how certain we are this is a space
  detected_from   TEXT,                       -- 'yolov8_aerial'|'manual'|'osm'
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_spaces_lot_id ON spaces(lot_id);
CREATE INDEX idx_spaces_row_id ON spaces(row_id);
CREATE INDEX idx_spaces_position ON spaces USING GIST(position);

-- ── OCCUPANCY EVENTS ──────────────────────────────────────────
-- Every observed parking/departure event — builds the dataset
CREATE TABLE occupancy_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id          UUID REFERENCES lots(id),
  space_id        UUID REFERENCES spaces(id), -- NULL if we only know the lot
  row_id          UUID REFERENCES lot_rows(id),
  event_type      TEXT CHECK (event_type IN ('arrived', 'departed')),
  source          TEXT CHECK (source IN (
                    'passive_gps',     -- From user's phone
                    'satellite_ai',    -- From image analysis
                    'city_sensor',     -- From govt sensor data
                    'camera_feed'      -- From lot operator camera
                  )),
  observed_at     TIMESTAMPTZ NOT NULL,
  device_id       TEXT,                       -- Anonymized device ID
  confidence      FLOAT DEFAULT 1.0,
  raw_lat         FLOAT,
  raw_lng         FLOAT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_events_lot_id ON occupancy_events(lot_id);
CREATE INDEX idx_events_observed_at ON occupancy_events(observed_at);
CREATE INDEX idx_events_lot_time ON occupancy_events(lot_id, observed_at);

-- ── OCCUPANCY SNAPSHOTS ───────────────────────────────────────
-- Materialized current state per lot — updated by workers
CREATE TABLE occupancy_snapshots (
  lot_id          UUID PRIMARY KEY REFERENCES lots(id),
  row_snapshots   JSONB,   -- {"A": {"open": 8, "total": 12, "confidence": "high"}, ...}
  total_open      INTEGER,
  total_spaces    INTEGER,
  occupancy_pct   FLOAT,
  last_updated    TIMESTAMPTZ DEFAULT NOW(),
  data_age_mins   INTEGER,  -- How old is the freshest data point
  confidence      TEXT CHECK (confidence IN ('live', 'recent', 'predicted', 'estimated'))
);

-- ── PREDICTIONS ───────────────────────────────────────────────
-- Hourly occupancy predictions per lot, pre-computed
CREATE TABLE predictions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id          UUID REFERENCES lots(id),
  predicted_for   TIMESTAMPTZ NOT NULL,       -- The hour this predicts
  day_of_week     INTEGER,                    -- 0=Mon, 6=Sun
  occupancy_pct   FLOAT,                      -- 0.0 to 1.0
  open_spaces     INTEGER,
  model_version   TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_predictions_lot_time ON predictions(lot_id, predicted_for);

-- ── SATELLITE IMAGERY LOG ─────────────────────────────────────
CREATE TABLE imagery_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id          UUID REFERENCES lots(id),
  provider        TEXT,                       -- 'nearmap' | 'blacksky' | 'google_static'
  captured_at     TIMESTAMPTZ,
  resolution_cm   FLOAT,
  s3_key          TEXT,                       -- Where the image is stored
  ai_processed    BOOLEAN DEFAULT FALSE,
  spaces_detected INTEGER,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
```

---

## Pipeline 01 — OSM Ingest

**File:** `pipeline/01_osm_ingest.py`

**Source:** OpenStreetMap Overpass API — free, no auth needed

**What it does:** Pulls every parking lot and garage globally as GeoJSON polygons, inserts into PostGIS lots table.

```python
# Overpass query to run
OVERPASS_QUERY = """
[out:json][timeout:300];
(
  way["amenity"="parking"];
  relation["amenity"="parking"];
  way["amenity"="parking_space"];
  way["building"="parking"];
  way["parking"="multi-storey"];
  way["parking"="surface"];
);
out geom;
"""

OVERPASS_URL = "https://overpass-api.de/api/interpreter"

# For US only (faster for MVP), add bounding box:
# [bbox:24.396308,-125.000000,49.384358,-66.934570]

# Parse response, extract:
# - osm_id: element['id']
# - name: element['tags'].get('name')
# - lot_type: 'garage' if tags.get('parking') == 'multi-storey' else 'surface'
# - geometry: build from element['geometry'] nodes
# - total_spaces: int(tags.get('capacity', 0))
# - levels: int(tags.get('parking:levels', 1))
# Upsert into lots table using osm_id as unique key
```

**Run with:** `python pipeline/01_osm_ingest.py --country US`

Expected output: ~800,000 US parking lots in PostGIS within a few hours.

---

## Pipeline 02 — City Open Data Scrapers

**Directory:** `pipeline/02_city_scrapers/`

One Python file per city. Each normalizes to the same schema and upserts into the lots table by geographic intersection with OSM polygons.

### Cities to build scrapers for (all free):

**START HERE: Hartford, CT is the MVP demo city. Builder is based in South Windsor, CT (~10 min drive). This allows real-world verification by physically driving to lots.**

```
hartford.py  https://data.hartford.gov/datasets/hartfordgis::parking-lots
             Hartford GIS parking lot boundaries + coordinates
             GeoJSON: https://data.hartford.gov/resource/tqtu-wb2c.geojson
             No auth required. OSM bbox for downtown only: 41.74,-72.70,41.78,-72.67
             Also: https://data.hartford.gov/search?q=parking for transaction data

nyc.py       https://data.cityofnewyork.us/resource/7pce-bset.json
             NYC parking lot planimetric data, full coordinates

la.py        https://data.lacity.org/resource/s49e-q6j2.json
             LA ExpressParks meter locations + transaction history
             Transaction archive: https://data.lacity.org/resource/e7h6-4a3e.json

seattle.py   https://data.seattle.gov/resource/xphu-jsvr.json
             Off-street parking facilities with capacity

sf.py        https://data.sfgov.org/resource/uupn-yfaw.json
             SFMTA parking facilities

chicago.py   https://data.cityofchicago.org/resource/wrvz-psew.json
             Parking meter locations and rates

austin.py    https://data.austintexas.gov/resource/234d-3d2a.json
             Parking garage locations

pittsburgh.py  https://data.wprdc.org/dataset/parking-transactions
               Meter transaction data in 10-min bins — best historical dataset
```

Each scraper should:
1. Fetch paginated JSON from the Socrata API (all use the same format: `?$limit=50000&$offset=0`)
2. Match to existing OSM lots via PostGIS `ST_Contains` or `ST_DWithin` (50 meter tolerance)
3. Enrich matched lots with pricing, hours, restrictions
4. Insert unmatched records as new lots with source = city name

---

## Pipeline 03 — Spot Detection (YOLOv8)

**File:** `pipeline/03_spot_detection.py`

**What it does:** For each lot in the database, pulls aerial imagery tiles, runs YOLOv8 vehicle detection, infers empty spaces from grid geometry, writes individual space records with lat/lng.

```python
# Dependencies
# pip install ultralytics opencv-python pillow requests shapely

from ultralytics import YOLO
import requests
from shapely.geometry import Point, Polygon

# Model options (in order of preference):
# 1. Pre-trained on parking: download from ArcGIS "Parking Spot Detection USA" model
#    https://www.arcgis.com/home/item.html?id=a149d20ec39943699acee9d6a0dbfa0b
# 2. YOLOv8x trained on PKLot dataset (best open-source parking dataset)
#    Dataset: https://public.roboflow.com/object-detection/pklot
# 3. YOLOv8n for speed, YOLOv8x for accuracy

model = YOLO('yolov8x.pt')  # or path to parking-specific weights

# Imagery source: Google Maps Static API
# Free tier: 28,000 requests/month
# $2 per 1,000 after that
GOOGLE_MAPS_KEY = os.environ['GOOGLE_MAPS_KEY']

def get_aerial_tile(lat, lng, zoom=20):
    """Fetch 640x640 satellite tile centered on coordinates."""
    url = (
        f"https://maps.googleapis.com/maps/api/staticmap"
        f"?center={lat},{lng}&zoom={zoom}&size=640x640"
        f"&maptype=satellite&key={GOOGLE_MAPS_KEY}"
    )
    return requests.get(url).content

def detect_spaces(lot):
    """Run detection on a lot, write spaces to DB."""
    # 1. Calculate tile grid to cover entire lot polygon
    # 2. Fetch each tile
    # 3. Run YOLO detection → get bounding boxes of vehicles
    # 4. Infer empty spaces: lot area - detected vehicles = candidate empty spaces
    # 5. Assign row labels based on proximity to row geometry
    # 6. Compute entrance point for each row (closest point to lot entrance)
    # 7. Write to spaces table with confidence score
    pass

# Run for top 50 US cities first, ~$400 in API costs
# python pipeline/03_spot_detection.py --city "New York" --limit 1000
```

---

## Pipeline 04 — Mapillary Sign Extraction

**File:** `pipeline/04_mapillary.py`

**Source:** Mapillary API (Meta-owned, free for commercial use)
**Auth:** `https://www.mapillary.com/developer` — create app, get client token

```python
MAPILLARY_TOKEN = os.environ['MAPILLARY_TOKEN']

# For each lot, fetch nearby Mapillary images (within 50m of entrance)
# API endpoint:
# GET https://graph.mapillary.com/images
#   ?fields=id,thumb_1024_url,captured_at,computed_geometry,detections
#   &bbox={west},{south},{east},{north}
#   &access_token={MAPILLARY_TOKEN}

# Detections already include sign text via their computer vision
# detection_type values that matter:
#   "regulatory--no-parking--g1"
#   "regulatory--maximum-speed--g1"
#   "information--parking--g1"
#   "regulatory--time-limited-parking--g1"

# Extract from detections:
#   - Hours of operation
#   - Time limits (2hr, 4hr)
#   - Pricing info
#   - Restrictions (permit, handicap only)

# Update lots.restrictions and lots.hours in DB
```

---

## Pipeline 05 — Occupancy Prediction Model

**File:** `pipeline/05_occupancy_model.py`

**Source data:** City meter transaction archives (already pulled in step 02)

Pittsburgh is the best starting dataset — it has timestamped transactions in 10-minute bins by meter location going back years.

```python
# pip install prophet pandas sqlalchemy psycopg2

from prophet import Prophet
import pandas as pd

def train_lot_model(lot_id):
    """
    Train a Prophet time-series model for a single lot.
    Prophet handles seasonality, holidays, weekly patterns automatically.
    """
    # Pull all occupancy events for this lot from DB
    # Format: ds (datetime), y (occupancy 0.0-1.0)
    df = query_events_for_lot(lot_id)

    model = Prophet(
        yearly_seasonality=True,
        weekly_seasonality=True,
        daily_seasonality=True,
        holidays=us_holidays_df  # Add US holidays
    )
    model.fit(df)

    # Generate predictions for next 7 days, hourly
    future = model.make_future_dataframe(periods=168, freq='H')
    forecast = model.predict(future)

    # Write to predictions table
    # forecast columns we use: ds, yhat (predicted occupancy), yhat_lower, yhat_upper
    write_predictions(lot_id, forecast)

# Run for all lots that have historical data
# python pipeline/05_occupancy_model.py --retrain-all
# Schedule: retrain weekly via cron
```

---

## Backend API

**File:** `backend/src/api/`

### Endpoints Claude Code needs to build:

```
GET  /api/lots/nearby
     ?lat=37.77&lng=-122.41&radius=1000&limit=20
     Returns: lots with current occupancy snapshot, sorted by distance
     Uses: PostGIS ST_DWithin for efficient spatial query

GET  /api/lots/:id
     Returns: full lot detail, rows with occupancy, spaces, forecast

GET  /api/lots/:id/rows
     Returns: rows with live occupancy, confidence, entrance coordinates
     This is what powers the row-selector screen

GET  /api/lots/:id/forecast
     Returns: hourly predictions for next 6 hours

GET  /api/lots/:id/satellite
     ?provider=ai|blacksky|nearmap
     Returns: signed S3 URL for satellite imagery tile
     Or: real-time fetch from Nearmap/BlackSky API

POST /api/events
     Body: { lot_id, event_type, lat, lng, device_id, timestamp }
     The passive GPS data collection endpoint
     Called silently from the mobile app

POST /api/events/batch
     Body: array of events
     For batching GPS events to reduce API calls

GET  /api/lots/search
     ?q=costco&lat=37.77&lng=-122.41
     Full-text search on lot names + nearby filter

GET  /api/lots/frequent
     ?device_id=anon_abc123
     Returns user's most visited lots with current occupancy
```

### Key PostGIS query for nearby lots:

```sql
SELECT
  l.id,
  l.name,
  l.lot_type,
  l.address,
  ST_Distance(
    l.centroid::geography,
    ST_MakePoint($lng, $lat)::geography
  ) AS distance_meters,
  os.total_open,
  os.total_spaces,
  os.occupancy_pct,
  os.confidence,
  os.last_updated,
  os.row_snapshots
FROM lots l
LEFT JOIN occupancy_snapshots os ON os.lot_id = l.id
WHERE ST_DWithin(
  l.centroid::geography,
  ST_MakePoint($lng, $lat)::geography,
  $radius_meters
)
ORDER BY distance_meters ASC
LIMIT $limit;
```

---

## Mobile App

**Stack:** React Native + Expo (easiest for single codebase iOS/Android)

**State management:** Zustand (simple, no Redux boilerplate)

**Navigation:** React Navigation v6

### Screen files to build:

```
screens/
  SplashScreen.tsx         # App load, check auth
  OnboardingScreen.tsx     # 3-step carousel
  PermissionsScreen.tsx    # Location + notifications ask
  HomeScreen.tsx           # Frequent lots + nearby list + mini map
  SearchScreen.tsx         # Full-text + filter search
  LotDetailScreen.tsx      # Satellite toggle + row selector + forecast
  DrivingScreen.tsx        # En-route monitoring + ETA
  RerouteScreen.tsx        # Alert when row fills
  ParkedScreen.tsx         # Success state + reminder

components/
  MapView.tsx              # Mapbox GL map with lot pins
  SatelliteToggle.tsx      # AI Map / Live Sat switcher
  RowCard.tsx              # Individual row with confidence + Maps button
  ConfidenceBadge.tsx      # High / Med / Est indicator
  ForecastChart.tsx        # 6-hour occupancy bars
  FrequentLotCard.tsx      # Home screen lot cards
```

### Passive GPS collection service:

```typescript
// services/PassiveGPS.ts

import * as Location from 'expo-location';
import { isInsideLot } from './GeoUtils';

// Called once at app start after permissions granted
export async function startPassiveCollection(deviceId: string) {
  await Location.startLocationUpdatesAsync('background-location', {
    accuracy: Location.Accuracy.High,
    timeInterval: 60_000,        // Check every 60 seconds
    distanceInterval: 20,        // Or every 20 meters moved
    showsBackgroundLocationIndicator: false,
    foregroundService: {
      notificationTitle: 'SPOTTR',
      notificationBody: 'Improving parking predictions',
    },
  });
}

// In the background task handler:
TaskManager.defineTask('background-location', async ({ data }) => {
  const { locations } = data;
  const loc = locations[locations.length - 1];

  // Check if inside a known lot boundary using local cache of nearby lots
  const lot = isInsideLot(loc.coords.latitude, loc.coords.longitude);
  if (!lot) return;

  // Determine if arrived or still parked
  const isStationary = loc.coords.speed < 0.5; // meters/second
  if (!isStationary) return;

  // Batch and send
  await queueEvent({
    lot_id: lot.id,
    event_type: 'arrived',
    lat: loc.coords.latitude,
    lng: loc.coords.longitude,
    device_id: deviceId,
    timestamp: new Date(loc.timestamp).toISOString(),
  });
});
```

### Maps deep link service:

```typescript
// services/MapsDeepLink.ts
import { Linking, Platform } from 'react-native';

export async function openMapsToCoordinate(
  lat: number,
  lng: number,
  label: string
) {
  const googleUrl = `https://maps.google.com/?q=${lat},${lng}&mode=driving`;
  const appleUrl  = `maps://maps.apple.com/?daddr=${lat},${lng}&dirflg=d`;

  if (Platform.OS === 'ios') {
    // Try Apple Maps first, fall back to Google
    const canOpenApple = await Linking.canOpenURL(appleUrl);
    if (canOpenApple) {
      await Linking.openURL(appleUrl);
    } else {
      await Linking.openURL(googleUrl);
    }
  } else {
    await Linking.openURL(googleUrl);
  }
}
```

### Real-time monitoring during drive:

```typescript
// services/RouteMonitor.ts

// Called when user taps "Take Me to Row A"
export function startMonitoring(lotId: string, rowId: string, onFilled: (newRow) => void) {
  const interval = setInterval(async () => {
    const snapshot = await api.getLotRows(lotId);
    const targetRow = snapshot.rows.find(r => r.id === rowId);

    if (targetRow.open === 0) {
      // Find next best row
      const alternative = snapshot.rows
        .filter(r => r.id !== rowId && r.open > 0)
        .sort((a, b) => b.open - a.open)[0];

      if (alternative) {
        clearInterval(interval);
        onFilled(alternative);  // Triggers reroute alert screen
        sendPushNotification(`Row ${targetRow.label} just filled — Row ${alternative.label} has ${alternative.open} spots`);
      }
    }
  }, 30_000); // Poll every 30 seconds while driving

  return () => clearInterval(interval);
}
```

---

## Push Notifications

**Service:** Expo Push Notifications (simplest for React Native)

```typescript
// On app load, register device token
import * as Notifications from 'expo-notifications';

const token = await Notifications.getExpoPushTokenAsync();
await api.registerDevice(deviceId, token.data);

// Backend sends via Expo Push API when row fills:
// POST https://exp.host/--/api/v2/push/send
// {
//   "to": "<expo-push-token>",
//   "title": "⚠️ Row A just filled",
//   "body": "Row B still has 6 spots — tap to reroute",
//   "data": { "lotId": "...", "newRowId": "...", "screen": "reroute" }
// }
```

---

## Garage-Specific Logic

When `lot.lot_type === 'garage'` or `lot.levels > 1`:

- Row cards become level cards: "Level 1", "Level 2", "Level P3"
- Satellite view shows garage footprint from above with entrance arrow (no spot grid visible)
- Data sources prioritize: city garage sensor feeds → operator camera API → historical patterns
- Passive GPS uses barometric pressure change (via device sensors) to detect floor transitions — log occupancy per level, not just per lot
- Maps deep link routes to garage entrance coordinate, instruction says "Enter garage, head to Level X"
- Confidence label always shows source: "From SFMTA sensor" / "Estimated from patterns"

```typescript
// Detect level change via barometer
import { Barometer } from 'expo-sensors';

// Pressure delta of ~0.12 hPa ≈ 1 meter elevation change
// Typical garage level = 3-4 meters = ~0.4 hPa change
Barometer.addListener(({ pressure }) => {
  const delta = pressure - lastPressure;
  if (Math.abs(delta) > 0.35 && isInsideGarage) {
    const direction = delta > 0 ? 'descended' : 'ascended';
    logLevelChange(currentLot, direction);
  }
});
```

---

## What Happens When Everything Is Full

Three states the app handles:

### State 1: Lot filling (>80% full)
- Row cards show warning colors
- Best-time banner updates: "This lot will likely be full by the time you arrive"
- Suggest alternative lots inline: "Plaza Underground (0.7mi) has 31 open"

### State 2: Lot full, en route
- Reroute alert fires immediately
- If all rows full: alert shows nearest alternative lot, not a different row
- Same reroute UI — before/after comparison — but different lot as destination

### State 3: All nearby lots full (event scenario)
```typescript
// When radius query returns 0 lots with open spaces:
// Show "High demand" state
{
  state: 'high_demand',
  message: 'All nearby lots are full',
  nearest_available: { lot, distance_meters: 1800 },
  opens_at: '6:00 PM',   // From prediction model
  reason: 'Giants game ending nearby'  // From event calendar API if integrated
}
```

---

## Satellite Integration

### MVP Satellite Strategy — Mapbox (FREE, already have key)

Nearmap (k+) and BlackSky (enterprise) are NOT needed for MVP.
Mapbox satellite tiles are sufficient and already included in the confirmed token.

```
Mapbox Satellite Tiles:
  Style URL: mapbox://styles/mapbox/satellite-v9
  Token: pk.eyJ1Ijoic29oYW05ODk... (confirmed)
  Resolution: 50cm standard globally, higher in US urban areas
  Nearmap imagery already integrated into Mapbox over US cities
  Cost: Included in free tier (50k map loads/month)
  Currently using: 16 of 50,000 free loads (per account screenshot)
```

For the YOLOv8 detection pipeline (aerial tile source):
```
NAIP (National Agriculture Imagery Program) via USGS — FREE
  URL: https://earthexplorer.usgs.gov/
  Coverage: Entire continental US
  Resolution: 1 meter per pixel (sharp enough to detect individual cars)
  Update frequency: Annually
  Cost: /bin/sh
  No API key needed — bulk download via EarthExplorer account (free signup)
  
Google Maps Static API — for individual lot tile fetching in pipeline
  Key: REDACTED_GOOGLE_KEY_1 (confirmed)
  Cost: ~00-800 for top 50 US cities (well within 00/mo free credit initially)
```

### In-app satellite toggle logic (Mapbox implementation):
```typescript
async function getSatelliteImage(lotId: string, mode: 'ai' | 'live') {
  if (mode === 'ai') {
    // Return AI-processed overlay from S3: lot boundary + open/taken spot markers
    return api.getProcessedImage(lotId);
  }

  if (mode === 'live') {
    // Use Mapbox satellite tile at lot coordinates
    // This shows real aerial imagery from Mapbox (which already includes Nearmap data over US)
    const lot = await api.getLot(lotId);
    return {
      mapboxStyle: 'mapbox://styles/mapbox/satellite-v9',
      center: [lot.lng, lot.lat],
      zoom: 19,  // ~50cm resolution at zoom 19
      provider: 'Mapbox Satellite',
      // Timestamp not available for Mapbox tiles — show 'Recent imagery'
      capturedAt: 'Recent',
    };
  }
}
```

### Future satellite upgrades (post-funding):
- Nearmap API: ~k/year, 4-7cm resolution, 3x/year refresh — add when revenue positive
- BlackSky: On-demand tasking, 35cm, 60min turnaround — add for premium tier feature

---

## Environment Variables

```bash
# backend/.env
# ⚠️  SECURITY: Restrict Google Maps key to your domain/IP in Google Cloud Console
# ⚠️  SECURITY: Restrict Mapbox token to your app bundle ID in Mapbox dashboard
# ⚠️  Never commit this file to GitHub — it is in .gitignore

DATABASE_URL=postgresql://postgres:REDACTED_DB_PASSWORD@postgres-tbl.railway.internal:5432/railway
REDIS_URL=redis://default:REDACTED_REDIS_PASSWORD@redis-vfmt.railway.internal:6379

# ── CONFIRMED KEYS (ready to use) ─────────────────────────────
GOOGLE_MAPS_KEY=REDACTED_GOOGLE_KEY_1
# Used for: aerial tile fetching in YOLOv8 pipeline + Google Maps fallback deep link

MAPBOX_TOKEN=REDACTED_MAPBOX_TOKEN
# Used for: in-app map display (lot pins, route overlay)
# Also used for: Live Sat toggle — Mapbox satellite tiles replace Nearmap for MVP
# Mapbox satellite resolution over US urban areas: 50cm standard, sub-50cm in dense cities
# This means Nearmap and BlackSky are NOT needed for MVP

MAPILLARY_TOKEN=REDACTED_MAPILLARY_TOKEN
# Used for: street-level sign/restriction extraction pipeline (pipeline/04_mapillary.py)

# ── AWS (account confirmed, complete setup below) ──────────────
S3_BUCKET=spottr-imagery
# ACTION NEEDED: Go to AWS Console → S3 → Create bucket named spottr-imagery → us-east-1
AWS_ACCESS_KEY_ID=REDACTED_AWS_KEY_ID_2
AWS_SECRET_ACCESS_KEY=jusckzsnLyB14Xi4kZPl8X3UtI4ZO7c3e33BI35D
AWS_REGION=us-east-1

# ── PENDING (needed before launch, not before MVP build) ───────
EXPO_PUSH_TOKEN=...
# Expo account: confirmed ✅ (project name: Scattr, account: Coder 119)
# Token generated automatically when user runs app on device — Claude Code handles this
# Run in terminal after Claude Code sets up mobile app: expo login

RAILWAY_DATABASE_URL=...
# Railway account: confirmed ✅
# ACTION NEEDED RIGHT NOW:
#   1. Go to railway.app → New Project
#   2. Click "Deploy Redis, Postgres, and a Bucket" (one click, gets everything)
#   3. After deploy → click PostgreSQL service → copy connection string (postgresql://...)
#   4. Paste that string here as DATABASE_URL and RAILWAY_DATABASE_URL
#   5. Click Redis service → copy connection string → paste as REDIS_URL
# Railway free tier: 30 days / $5 credit (shown in screenshot) — sufficient for full MVP build

# ── SKIPPED FOR MVP (revisit after funding/traction) ──────────
# NEARMAP_API_KEY=...       Replaced by Mapbox satellite tiles — free and sufficient for MVP
# BLACKSKY_API_KEY=...      On-demand satellite tasking — enterprise feature, not MVP
# Contact these after Series A or first investor meeting, not during build
```

---

## Build Order for Claude Code

Execute these in sequence. Each step is independently testable.

```
Step 0:  AWS setup (before anything else)
         - Go to AWS Console → S3 → Create bucket: spottr-imagery, region us-east-1
         - Go to IAM → Users → Create user: spottr-app
         - Attach policy: AmazonS3FullAccess
         - Create access key → copy to .env as AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY
         - Go to Expo (expo.dev) → sign up → run: npm install -g expo-cli && expo login
         - Go to Railway (railway.app) → sign up → New Project → PostgreSQL → copy DATABASE_URL

Step 1:  Create PostgreSQL + PostGIS database, run schema migrations
Step 2:  Run 01_osm_ingest.py for US bounding box — verify lot count in DB
Step 3:  Run 02_city_scrapers/ for NYC first — verify enrichment in DB
Step 4:  Run 03_spot_detection.py for Manhattan lots — verify space records
Step 5:  Run 04_mapillary.py for NYC — verify restriction data populated
Step 6:  Run 05_occupancy_model.py on Pittsburgh data — verify predictions table
Step 7:  Build backend API — test /api/lots/nearby returns correct data
Step 8:  Build React Native app screens — connect to local backend
Step 9:  Implement passive GPS collection — test on real device
Step 10: Implement route monitoring + reroute push notification
Step 11: Add satellite image fetching (Nearmap first, BlackSky second)
Step 12: Connect Mapbox map in app — verify lot pins render correctly
```

---

## MVP Definition (What to Demo to Investors)

A working app that:
- Shows nearby lots with live/predicted occupancy on a map
- Taps into one lot showing row-level breakdown with confidence scores
- Satellite toggle switches between AI overlay and raw Nearmap imagery
- "Take Me to Row A" fires a Maps deep link to the entrance coordinate
- Driving screen shows live monitoring with 30-second polling
- Reroute alert fires correctly when a row fills
- Backend serves data from real PostGIS database with real OSM + city open data

**Target city for demo:** Hartford, CT (10 min from South Windsor where builder is based — verify accuracy by driving to real lots)

**Timeline with Claude Code:** 3-5 days of focused sessions
```
Day 1: DB schema + OSM ingest + Hartford city scraper + spot detection for Hartford downtown (bbox: 41.74,-72.70,41.78,-72.67)
Day 2: Backend API + all endpoints tested with real data
Day 3: React Native app — all screens connected to live backend
Day 4: GPS collection + route monitoring + push notifications
Day 5: Satellite integration + polish + demo prep
```

---

*This document is the complete source of truth for the SPOTTR build. Hand it to Claude Code and start at Step 1.*
