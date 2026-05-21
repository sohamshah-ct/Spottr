# Spottr — State Machines

Rendered with Mermaid. Paste into https://mermaid.live to view as diagrams.

---

## 1. Parking Navigation State Machine (mobile)

Lives in `mobile/src/services/parkingStateMachine.ts` (Zustand store).

```mermaid
stateDiagram-v2
    [*] --> idle

    idle --> searching : user opens Search\nor taps lot pin

    searching --> navigating : user taps "Take me there"\n→ opens Apple/Google Maps deeplink\n→ DrivingScreen activates

    navigating --> approaching : GPS dwell detected\n(≥30s within 100m of lot centroid)

    navigating --> rerouting : availability poll shows lot full\n(30s interval, open_spaces == 0)

    rerouting --> navigating : user selects alternate lot

    approaching --> parked : dwell confirmed\n(≥60s within 80m)

    parked --> idle : user taps "Done"\nor app backgrounds

    navigating --> idle : user cancels\nor navigates back

    note right of navigating
        DrivingScreen polls /api/lots/:id
        every 30s for live open count.
        Zone centroid shown on map.
    end note

    note right of parked
        ParkedScreen stores\nlot centroid in AsyncStorage.
        "Find My Car" deeplink opens
        Apple Maps / Google Maps
        to stored coordinate.
    end note
```

---

## 2. Lot Freshness State Machine (backend)

Lives in `backend/src/services/freshness.js`. Computed at query time from
`last_spot_detection` age and BestTime availability. Never stored — derived fresh
each API call.

```mermaid
stateDiagram-v2
    [*] --> D : lot has no detection yet

    D --> C : Modal detection runs\n(POST /api/lots/:id/detect)

    C --> B : detection age < 24h

    B --> A : BestTime live data available\nAND detection age < 4h

    A --> B : BestTime live unavailable\nOR detection age > 4h

    B --> C : detection age 24–72h

    C --> D : detection age > 72h

    note right of A
        Display: "Live · N min ago"
        BestTime live busyness × satellite count
        (BestTime disabled for MVP — BESTTIME_ENABLED=false)
    end note

    note right of B
        Display: "Scanned N h ago"
        Satellite count only, fresh
    end note

    note right of C
        Display: "Scanned N days ago"
        Satellite count, aging
    end note

    note right of D
        Display: "Capacity only"
        Total spaces known, no occupancy data
    end note
```

---

## 3. Bbox Provenance Decision Tree (backend)

Lives in `backend/src/api/lots.js`. Runs at lot hydration time via OSM Overpass.

```mermaid
flowchart TD
    A[Lot hydration triggered] --> B{OSM Overpass:\nany amenity=parking ways\nwithin union radius?}

    B -->|Yes| C{Union bbox area\n> BBOX_FLOOR_DEG2\n~80m × 80m?}

    C -->|Yes| D[bbox_source = osm_union\ngreen confidence pill]

    C -->|No| E{lot_type =\nwarehouse_store?}

    B -->|No| E

    E -->|Yes| F[220m symmetric buffer\naround building centroid\ncapped at MAX_INFERRED_DEG2_WAREHOUSE\nbbox_source = building_inferred\namber confidence pill]

    E -->|No| G[Radius buffer fallback\nbbox_source = low_osm_coverage\nlower confidence pill]
```
