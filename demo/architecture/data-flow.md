# Spottr — Data Flow Architecture

Rendered with Mermaid. Paste into https://mermaid.live to view as a diagram.

```mermaid
flowchart TD
    subgraph Mobile["Mobile App (React Native / Expo 54)"]
        A[HomeScreen\nmap + lot list] --> B[SearchScreen\nPlaces autocomplete]
        B --> C[LotDetailScreen\nAI Map + open count]
        C --> D[DrivingScreen\nGPS dwell detection]
        D --> E[ParkedScreen\nFind My Car]
        D -->|lot fills| F[RerouteScreen\nalternate lot]
    end

    subgraph Backend["Backend API (Node.js / Railway)"]
        G[GET /api/lots/near]
        H[GET /api/lots/:id]
        I[GET /api/lots/:id/rows]
        J[GET /api/search]
        K[POST /api/lots/:id/detect]
    end

    subgraph CV["CV Pipeline (Python / Modal GPU)"]
        L[Tile fetcher\nMapbox z19 tiles]
        M[YOLOv8-OBB\nstripe detection]
        N[SAM2\nspace segmentation]
        O[Area filter\nreject noise + buildings]
        P[Occupancy classifier\npixel intensity]
        Q[Zone partitioner\nspatial clustering A→D]
    end

    subgraph Data["Data Layer (PostgreSQL / Railway)"]
        R[(lots table\n~970 CT lots)]
        S[(occupancy_snapshots\nzone counts + freshness)]
        T[(lot_rows / spaces\nper-stall geometry)]
    end

    subgraph External["External APIs"]
        U[Google Places API v1\nautocomplete + geocode]
        V[Mapbox\nsatellite tiles + basemap]
        W[CT ECO\n7.6cm orthophoto CT]
        X[OSM Overpass\nparcel + building geometry]
    end

    Mobile -->|REST| Backend
    Backend --> Data
    Backend -->|trigger| CV
    CV --> L
    L --> M --> N --> O --> P --> Q
    Q -->|write results| S
    Backend -->|proxy| U
    Mobile -->|tiles| V
    Mobile -->|CT lots AI Map| W
    Backend -->|bbox geometry| X
```

## Key design decisions encoded in this diagram

1. **Modal is triggered on-demand**, not on a schedule. `POST /api/lots/:id/detect`
   is called by the backend when a lot's freshness state falls to C or D. The mobile
   app never calls Modal directly.

2. **CTECO vs Mapbox tile split**: CT lots get the 7.6 cm/px CTECO orthophoto as the
   AI Map base layer. Non-CT lots fall back to Mapbox z20 satellite tiles. Both
   overlays share the same detected-spot circle layer.

3. **Freshness state machine** (A→B→C→D) is computed in `freshness.js` at query time,
   not stored. It depends on `last_spot_detection` age and BestTime live availability.

4. **OSM Overpass** is called once at lot hydration time (not per request) to derive
   bbox geometry via building footprint + parking way union. Results are stored in
   `lots.bbox_*` columns with a `bbox_source` provenance tag.
