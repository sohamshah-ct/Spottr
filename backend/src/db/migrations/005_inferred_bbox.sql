-- SPOTTR Migration 005: Track 4 — Inferred Bbox Provenance
-- Adds bbox_source column to lots to record how each lot's bbox was computed.
--
-- Values:
--   'osm_union'         Track 3 path — healthy OSM parking-way union
--   'building_inferred' Track 4 Strategy A — inferred from building polygon buffer
--   'landuse_inferred'  Track 4 Strategy B — inferred from landuse polygon
--   'low_osm_coverage'  Both fallback strategies failed; bbox from tiny OSM way (or none)

ALTER TABLE lots ADD COLUMN IF NOT EXISTS bbox_source TEXT;

-- Backfill existing Track 3 union lots so provenance is accurate.
-- Only touches rows that were created via Place-pin union search (source_osm_ids set).
-- Seeded rows (697) and GPS-mode rows stay NULL — they predate bbox_source tracking.
UPDATE lots
  SET bbox_source = 'osm_union'
  WHERE bbox_source IS NULL
    AND source_osm_ids IS NOT NULL
    AND jsonb_array_length(source_osm_ids) > 0;
