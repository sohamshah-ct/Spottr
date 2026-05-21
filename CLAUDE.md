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

---

## Architecture / post-MVP

### V6 — Static geometry × live busyness

**Core insight:** satellite CV produces the static denominator (total spaces per lot,
derived once and refreshed only on structural change). Live busyness APIs produce the
dynamic numerator (occupancy percentage, refreshed every 15 minutes). Multiplied
together yields probabilistic real-time availability without requiring fresh imagery
or per-site instrumentation.

**Display formula:** `open_spaces ≈ total_spaces × (1 - busyness_index)`
Display with ±15% uncertainty band.

#### V6 Layer 1.5: BestTime.app integration

- Foot traffic API, venue-based (not lot-based)
- Returns 0–100% busyness relative to venue's own weekly peak
- Two data products: weekly forecast (one-time per venue, stable for weeks) + live
  busyness (refreshed hourly, requires sufficient venue volume for live availability)
- Pricing: ~$29/mo minimum, ~$0.009/credit on Pay-As-You-Grow tier. Estimated Spottr
  cost: ~$30–100/month at MVP scale for 200 active lots polled every 15 min
- Coverage: high confidence for Costco/Target/Whole Foods/hospitals; uncertain for
  civic buildings and low-traffic lots
- Integration architecture:
  - Bootstrap forecast per lot at hydration (stores `besttime_venue_id`,
    `besttime_forecast_data` JSONB, `besttime_has_live` bool)
  - Background poll worker: active lots every 15 min peak / 30 min shoulder / paused
    overnight
  - At query time: `total_spaces × (1 - busyness_index) = estimated_open` with
    confidence indicator
- Estimated 2–4 weeks of engineering work post-MVP
- **Action item before V6 planning is finalized:** sign up at besttime.app (free tier,
  ~10 min), run free forecast query against "Costco Wholesale South Windsor CT" to
  verify live data availability for Hartford-metro flagship lots

---

### V6.5 — Direct measurement partners

For off-street structured parking where partner data exists, direct measurement beats
inferred busyness. Used as override when available; falls back to BestTime when not.

**Priority hierarchy at query time:**
1. TomTom/Parkopedia direct occupancy (when lot is covered)
2. BestTime live busyness × satellite count
3. BestTime forecast pattern × satellite count
4. Satellite count alone with "static" indicator

**Parkopedia:** 90M spaces, 90 countries, includes probability modeling for areas
without parking infrastructure plus direct operator integration where available.
Explicitly serves Mobile Navigation vertical (Spottr's category). Commercial inquiry
sent 2026-05-18 — response pending 1–3 weeks. More likely V6.5 partner than TomTom.

**TomTom Parking Availability API:** gated as automotive-only, not in free or PAYG
tiers, requires enterprise contract. Outreach 2026-05-18 received polite brush-off
pointing to free Developer Portal tier which does NOT include Parking Availability.
Effectively closed — pushed to V7+ contingent on Spottr having revenue or capital for
enterprise contract.

---

### V7 — Spot-level live occupancy

**User-facing promise:** open Spottr at flagship lot, see specific open spot, tap to
navigate to that exact coordinate via Google Maps or Apple Maps deeplink.

**Three required components:**
1. Stall geometry — have today via SAM2 on satellite (each stall has a coordinate)
2. Live per-stall occupancy — V7 work
3. Navigation deeplink to stall coordinate — trivial via `comgooglemaps://` URL scheme

#### V7-A — Connected-vehicle telemetry

Ingest parking-event stream from Wejo, INRIX, HERE, or Veraset. Spatial join against
Spottr's stall polygons. Calibrate against satellite count for completeness (handles
the ~30–40% of vehicles not emitting telemetry). Enterprise contract, estimated
$50K–$250K/year. Timeline: 6–12 months from contract signing. Outreach not yet
started.

#### V7-B — Owned-sensor flagship deployment

Roof-mounted LiDAR or radar hosted by property owners adjacent to flagship lots (not
lot owner — adjacent property owner like Mobil gas station, church, neighboring
retail). Ground-truth precision. Capex $10K–$30K per lot, opex $3K–$6K/year per lot
for hosting fees. Start with Costco South Windsor as pilot deployment. Timeline:
6–9 months for first deployment, year 2 for 10–20 flagship lot fleet.

**Combined architecture:** V7-A provides broad spot-level coverage with calibrated
accuracy. V7-B provides flagship-grade precision at strategic lots. Both feed the same
mobile UI with stall-level visualization and confidence indicators per source.

**Planet Labs (SkySat/Pelican):** supplementary geometric refresh layer, NOT primary
live source. Revisit cadence (60–90 min at best) too slow for spot-level decisions.
Pelican's 30cm resolution (when fully operational ~12–24 months) could contribute as
periodic geometric ground-truth refresh at flagship lots.

---

## External partnerships

Active outreach as of 2026-05-18:

| Partner | Status | What we asked | Response timeline |
|---------|--------|---------------|-------------------|
| Planet Labs Education & Research Basic | Submitted | PlanetScope (3m res) access | 3 weeks |
| UConn Library / Katie Fiducia (MAGIC) | Emailed | Institutional SkySat access (like Stanford/UCSB programs) | Days–weeks |
| Parkopedia | Submitted commercial inquiry | Pricing + sandbox for Hartford metro 100–300 lots | 1–3 weeks |
| TomTom | Closed | Parking Availability API access | N/A — closed |
| BestTime | Not yet done | Free tier signup + Costco forecast test | 10-min action item |

**Notes:**
- Planet Labs Education Basic = PlanetScope 3m resolution. 3m too coarse for
  parking-stall resolution; useful for landuse/parcel context. UConn/Katie Fiducia
  thread is the more important Planet ask (SkySat 50cm).
- TomTom sent gracious closing reply maintaining future channel.

**Next outreach to initiate (V7 prep, no urgency):**
- Wejo, INRIX, HERE for connected-vehicle telemetry feeds
- Velodyne, Ouster, or Quanergy for LiDAR pilot hardware quote

---

## Active work items

### Gate C — open design decisions

The following design decisions must be resolved before Gate C implementation starts:

1. **Bbox source provenance UI** — confidence pill vs info icon vs explicit label.
   Working assumption: clickable confidence pill that expands to "How was this
   counted?" methodology sheet. Pill colors map to `bbox_source` values:
   `osm_union` = green high confidence, `building_inferred` = amber medium,
   `low_osm_coverage` = lower with explicit framing.

2. **State-aware timestamp badge** — thresholds and visual treatment. States:
   "Live · Nm ago" (BestTime live, post-V6), "Imaged \<month year\>"
   (satellite-only, MVP default), and intermediate stale-data treatments. Needs
   Figma mockup before mobile development.

3. **Map view default** — AI Map (polygon overlay green/red showing detected stalls)
   vs traditional satellite with pins vs toggle. Working assumption: AI Map default
   since it's the trust-building centerpiece that differentiates Spottr from generic
   map apps.

4. **Home-screen "Your usual spots" data source for MVP** — geo-proximity (closest
   by location) is the default. Real behavioral personalization is post-MVP.

5. **Home-screen refresh strategy** — cache vs live query on app open. Latency
   targets needed for each path.

---

## Checkpoint 3 polish candidates

### AI Map spot interpretation — marker legibility

User test feedback (2026-05-21): users do not recognise that the green/red dots on
the AI Map are individual parking spaces. The dots are one circle per detected space
(green = open, red = occupied), radius 1.2m at z19, rendered via react-native-maps
`Circle`. They are correct but not self-evident.

**Two candidate fixes for Checkpoint 3** (do not implement before then):
1. Increase Circle radius from 1.2 to 2.0–2.5 so dots are more visible at default
   zoom level.
2. Add a small legend overlay in the map area (bottom-left, above the sheet):
   `• open  • full` with green/red dot indicators. Keep it compact (mono 10pt,
   semi-transparent bg). Alternatively, show a first-load tooltip that dismisses
   on tap (stored in AsyncStorage so it only shows once).

---

## V6 deferred items (flagged during Gate C Gate 1)

### entrance_lat / entrance_lng — per-lot navigation precision

`place_lat` / `place_lng` from the Places API pin is used as the "Take me there"
destination in Gate C (sub-100m accuracy, good enough for MVP). For V6, add
`entrance_lat` / `entrance_lng` columns with manual override per flagship lot for
sub-50m precision (e.g. specific lot entrance, not building centroid).

Migration: `ALTER TABLE lots ADD COLUMN entrance_lat FLOAT, ADD COLUMN entrance_lng FLOAT;`
Seed manually for Costco South Windsor, Sam's Club Newington, BJ's Manchester.
Mobile: prefer `entrance_lat` → `place_lat` → `lat` when constructing Maps deeplink.

---

## Current state summary (as of Gate C close, 2026-05-19)

**MVP backend: COMPLETE.**
**Gate C mobile screens: COMPLETE (7 commits).**

Lot categories covered and validated:
- Institutional (Strategy B / landuse-anchored): SWHS 139 spaces, 170×261m, osm_union
- Standard commercial (Strategy A / building-anchored with OSM union path priority):
  Target Buckland Hills 351 spaces, 310×477m, osm_union
- Warehouse-format retail (Strategy A / building-anchored, 220m buffer,
  MAX_INFERRED_DEG2_WAREHOUSE cap, MAX_TILES=25):
  Costco South Windsor 640 spaces, 606×605m, building_inferred;
  Sam's Club Newington 477 spaces, 593×563m, building_inferred

Gate C delivered:
- Freshness state machine A→B→C→D (backend/src/services/freshness.js)
- BestTime.app service wiring, disabled for Iteration A (BESTTIME_ENABLED=false)
- Migration 007: besttime_venue_id column on lots
- Shared components: FreshnessLabel, LotCard, BigNumberCount, ConfidencePill,
  ZoneThumbnail, SearchBar
- HomeScreen: MapView + BottomSheet 30%/60%/95% + lot pins + nearby/recent lots
- SearchScreen: map strip + Places autocomplete + recent searches
- LotDetailScreen: lot bbox MapView + AI Map (circle markers) + BigNumberCount +
  FreshnessLabel + ZoneThumbnail + "Take me there" + stats row + ConfidencePill
- App.tsx: GestureHandlerRootView at root; lot?: Lot in LotDetail nav params

**Next critical-path work:** npx expo install (install new packages), test on device,
then Gate D (Approach + Parked screens) or BestTime.app free-tier signup.

**Estimated MVP launch:** 3–5 weeks from Gate C close.
