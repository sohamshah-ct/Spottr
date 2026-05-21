# API Responses — Frozen Samples

Each file in this directory is a representative response from the Spottr backend API
as it existed in production on Railway (decommissioned May 2026). Values are real or
closely representative of production data from validated lots.

## Files

### lots-near-costco.json
Response from `GET /api/lots/near?lat=41.8419&lng=-72.5786&radius=25000`.
Shows 3 lots sorted by distance from Costco South Windsor: Costco itself (42m),
Target Buckland Hills (731m), Sam's Club Newington (18km). Includes freshness state
labels and live open space counts where a detection has been run.

### lot-detail-costco.json
Response from `GET /api/lots/1` (Costco South Windsor, lot_id=1).
Full lot detail including bbox geometry, 4 parking zones (A–D) with per-zone
open counts, centroid coordinates for navigation, and bbox provenance metadata.

### search-costco.json
Response from `GET /api/search?q=Costco` with location bias near South Windsor CT.
Passes through Google Places API (New) v1 autocomplete. Used to power the Search
screen's typeahead field.

### detection-flow.json
Full pipeline output for a single Modal GPU detection run on Costco South Windsor.
Shows the complete data shape: bbox, tile fetch parameters, YOLOv8-OBB results,
SAM2 mask stats, area filter pass/fail counts, occupancy totals, zone breakdown,
and per-space records (first 2 of 640 shown). This is the payload the Modal
function returns and the backend writes to `occupancy_snapshots`.

---

Base URL (decommissioned): `https://spottr-api-production.up.railway.app`
