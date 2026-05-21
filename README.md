# Spottr

**Satellite AI that counts open parking spots before you leave home.**

Spottr uses computer vision on satellite imagery to detect and count individual
parking spaces in any surface lot — no sensors, no operator partnerships, no
crowdsourcing. Open the app, see exactly how many spaces are available in each
zone of your target lot, and navigate directly to the highest-availability zone.

---

## The Problem

Drivers spend an average of 17 minutes per trip searching for parking. Existing
solutions require either expensive per-lot sensor hardware (ParkWhiz, SpotHero)
or depend on crowdsourced data that goes stale immediately. Neither works for the
suburban surface lots where most Americans actually park.

## The Solution

Spottr runs YOLOv8 + SAM2 on satellite imagery to detect every striped parking
space in a lot, classify it as occupied or empty, and return zone-level open counts
via API — once per lot, refreshed when the imagery ages. No hardware. No operators.
No crowdsourcing.

```
Satellite tile → YOLOv8-OBB stripe detection → SAM2 space segmentation
→ occupied / open classification → zone counts → mobile app
```

At Costco South Windsor (a 640-space warehouse lot), Spottr detects all four zones
with sub-5% error against a manual ground-truth count.

---

## What's Built

| Layer | Status | Detail |
|-------|--------|--------|
| CV Pipeline | ✅ Live | YOLOv8-OBB + SAM2 on Modal GPU · ~36s per lot · 640 spaces detected at Costco |
| Lot Database | ✅ Live | Railway PostgreSQL · ~970 CT lots · OSM + building-inferred bbox geometry |
| Backend API | ✅ Live | Node.js/Express on Railway · Places name resolution · freshness state machine |
| Mobile App | ✅ Built | React Native (Expo 54) · iOS + Android · full parking navigation loop |
| AI Map | ✅ Built | Detected spots overlaid on CTECO 7.6 cm/px imagery (CT) or Mapbox z20 |
| Parking Flow | ✅ Built | GPS dwell detection · zone routing · Find My Car deeplink |

---

## How It Works

### 1. Lot geometry
Each lot gets a bounding box from one of three strategies:

- **OSM union** (highest confidence) — union of all OSM parking ways within radius,
  verified against building footprint
- **Building-inferred** (warehouse format) — 220m symmetric buffer around building
  centroid, capped per lot type; calibrated for Costco / Sam's Club / BJ's geometry
- **Low OSM coverage** — flagged; falls back to radius buffer

### 2. Detection
`POST /api/lots/:id/detect` triggers the Modal serverless GPU function:

1. Fetch z19 Mapbox satellite tiles covering the bbox (up to 5×5 = 25 tiles)
2. YOLOv8-OBB detects parking stripe orientations across the tile grid
3. SAM2 segments individual spaces from stripe masks
4. Occupied/open classification from pixel intensity + stripe overlap
5. Spaces grouped into zones (A → D) by spatial clustering
6. Result cached with `last_spot_detection` timestamp; freshness state A/B/C/D
   computed from detection age

### 3. Freshness state machine

| State | Condition | Display |
|-------|-----------|---------|
| A | BestTime live + detection < 4h | Live · N min ago |
| B | Detection < 24h | Scanned N h ago |
| C | Detection 24–72h | Scanned N days ago |
| D | Detection > 72h or never | Capacity only |

### 4. Mobile navigation loop

```
Home (map + lot list)
  → Search (Places autocomplete)
  → Lot Detail (AI Map + open count + zone rows)
      → "Take me there" → external Maps + DrivingScreen
          → DrivingScreen (GPS dwell detection · 30s availability poll)
              → lot full → Reroute (alternate lot search)
              → dwell detected → Parked (Find My Car · Done)
```

---

## Stack

| Component | Technology |
|-----------|------------|
| CV pipeline | Python · YOLOv8-OBB · SAM2 · Modal (serverless GPU) |
| Backend | Node.js · Express · PostgreSQL · Redis (Railway) |
| Mobile | React Native · Expo SDK 54 · TypeScript |
| Maps | Mapbox satellite tiles · CTECO 2023 orthophoto (CT) · Apple/Google Maps deeplinks |
| State | Zustand 5 + AsyncStorage (parking flow only) |
| Places | Google Places API (New) v1 |

---

## Verified Lots

| Lot | Type | Spaces | Bbox | Source |
|-----|------|--------|------|--------|
| Costco South Windsor CT | warehouse_store | 640 | 606×605m | building_inferred |
| Sam's Club Newington CT | warehouse_store | 477 | 593×563m | building_inferred |
| Target Buckland Hills CT | commercial | 351 | 310×477m | osm_union |
| SWHS (high school) | institutional | 139 | 170×261m | osm_union |

---

## Running Locally

### Backend
```bash
cd backend
npm install
# Set DATABASE_URL, GOOGLE_PLACES_KEY, MODAL_TOKEN_ID, MODAL_TOKEN_SECRET in .env
npm run dev          # http://localhost:8080
```

### Mobile
```bash
cd mobile
npm install
# Set EXPO_PUBLIC_API_URL, EXPO_PUBLIC_GOOGLE_MAPS_KEY in mobile/.env
npx expo start       # scan QR with Expo Go
```

### Trigger a detection
```bash
# Via Railway (uses internal DATABASE_URL)
railway run node backend/scripts/detect_lot.js <lot_id>
```

---

## API

Base URL: `https://spottr-api-production.up.railway.app`

| Endpoint | Description |
|----------|-------------|
| `GET /api/lots/near?lat=&lng=&radius=` | Lots near a coordinate with freshness |
| `GET /api/lots/:id` | Lot detail with freshness label |
| `GET /api/lots/:id/rows` | Zone rows with open/total counts and centroids |
| `GET /api/search?q=` | Places autocomplete (Google Places New API) |
| `GET /health` | DB status |

---

## Repository Layout

```
spottr/
├── backend/
│   ├── modal/detect.py          YOLOv8-OBB + SAM2 GPU function
│   ├── src/
│   │   ├── api/lots.js          Core lot API + bbox geometry + name resolution
│   │   ├── api/search.js        Places autocomplete proxy
│   │   └── services/freshness.js Freshness state machine
│   └── scripts/                 One-time backfill + diagnostic scripts
└── mobile/
    ├── src/
    │   ├── screens/             Home · Search · LotDetail · Driving · Reroute · Parked
    │   ├── components/          LotCard · BigNumberCount · ZoneThumbnail · ConfidencePill · …
    │   └── services/
    │       ├── api.ts           Typed API client
    │       └── parkingStateMachine.ts  Zustand store · GPS watcher · dwell detection
    └── App.tsx                  Navigation stack
```

---

## Roadmap

**V6 — Static geometry × live busyness**
Multiply satellite space count (static denominator) by BestTime.app busyness index
(live numerator) → probabilistic real-time availability without fresh imagery.
`open_spaces ≈ total_spaces × (1 − busyness_index)` ± 15%.

**V6.5 — Direct measurement partners**
TomTom / Parkopedia direct occupancy data as override where available.
Commercial inquiry sent to Parkopedia 2026-05-18.

**V7 — Spot-level live occupancy**
Connected-vehicle telemetry (Wejo / INRIX) spatial-joined to SAM2 stall polygons.
Per-stall open/occupied → tap to navigate to specific coordinate.

---

## License

Private — all rights reserved.
