# SPOTTR

Satellite-powered parking app. Shows drivers exactly which row of any parking lot has open spots and routes them there with a Maps deep link.

## What's Built

| Layer | Status | Detail |
|-------|--------|--------|
| Database | ✅ Live | Railway PostgreSQL · 8 tables |
| OSM Ingest | ✅ Done | 551 Hartford, CT lots |
| Spot Detection | ✅ Done | 6,098 geocoded spaces · Rows A–E with entrance coords |
| Occupancy Model | ✅ Done | 21,504 predictions · 64 snapshots seeded |
| Backend API | ✅ Done | 8 endpoints · Express + Node.js |
| React Native App | ✅ Done | 8 screens · iOS + Android |

## Stack

- **Backend:** Node.js + Express + PostgreSQL (Railway) + Redis
- **ML Pipeline:** Python (YOLOv8 grid estimation, Prophet-ready)
- **Mobile:** React Native + Expo (iOS + Android)
- **Maps:** Mapbox satellite tiles + Apple/Google Maps deep links
- **Storage:** AWS S3
- **Demo city:** Hartford, CT (bbox: 41.74,-72.70,41.78,-72.67)

## Quick Start

### Backend
```bash
cd backend
cp .env.example .env   # keys already in .env if cloned from source
npm install
npm run dev            # starts on :3000
```

### Mobile
```bash
cd mobile
npm install
npx expo start         # scan QR with Expo Go
```

### Pipeline (re-run anytime)
```bash
cd pipeline
pip install -r requirements.txt

# Ingest Hartford lots from OSM
railway run python 01_osm_ingest.py --hartford

# Detect spaces and create rows
railway run python 03_spot_detection.py --city Hartford --limit 100

# Generate occupancy predictions
railway run python 05_occupancy_model.py --city Hartford

# Extract parking signs from Mapillary
railway run python 04_mapillary.py --city Hartford
```

## API

Base URL: `http://localhost:3000`

| Endpoint | Description |
|----------|-------------|
| `GET /health` | DB status + lot count |
| `GET /api/lots/nearby?lat=&lng=&radius=&limit=` | Lots with occupancy, sorted by distance |
| `GET /api/lots/:id` | Full lot detail |
| `GET /api/lots/:id/rows` | Rows with open/total counts and entrance coords |
| `GET /api/lots/:id/forecast` | Next 6h predictions |
| `GET /api/lots/:id/satellite?provider=ai\|live` | Mapbox tile info or S3 AI overlay |
| `GET /api/lots/search?q=&lat=&lng=` | Text search |
| `GET /api/lots/frequent?device_id=` | User's most visited lots |
| `POST /api/events` | Log a passive GPS event |
| `POST /api/events/batch` | Batch GPS events |
| `POST /api/devices/register` | Register Expo push token |

## Demo (Hartford)

```bash
# Nearby lots — Hartford downtown
curl "http://localhost:3000/api/lots/nearby?lat=41.763&lng=-72.685&radius=500&limit=5"

# Rows for a specific lot
curl "http://localhost:3000/api/lots/<lot_id>/rows"

# 6-hour forecast
curl "http://localhost:3000/api/lots/<lot_id>/forecast"
```

## Project Structure

```
spottr/
├── backend/
│   ├── src/
│   │   ├── api/        lots.js · events.js · devices.js
│   │   ├── db/         pool.js · queries.js · schema.sql · migrate.js
│   │   ├── services/   notifications.js
│   │   └── workers/    snapshotWorker.js
│   ├── .env
│   └── package.json
├── pipeline/
│   ├── 01_osm_ingest.py
│   ├── 02_city_scrapers/hartford.py
│   ├── 03_spot_detection.py
│   ├── 04_mapillary.py
│   ├── 05_occupancy_model.py
│   └── requirements.txt
├── mobile/
│   ├── App.tsx
│   ├── src/
│   │   ├── screens/    Home · Search · LotDetail · Driving · Reroute · Parked · Onboarding · Permissions
│   │   ├── components/ RowCard · ForecastChart · FrequentLotCard · SatelliteToggle · ConfidenceBadge
│   │   ├── services/   api.ts · MapsDeepLink.ts · RouteMonitor.ts · PassiveGPS.ts
│   │   └── store/      useStore.ts (Zustand)
│   └── package.json
└── SPOTTR_BUILD_SPEC.md
```
