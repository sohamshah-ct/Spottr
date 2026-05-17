-- SPOTTR Migration 004: Polygon Union + Zone Partitioning
-- Adds columns needed for multi-way OSM union lots and spatial zone anchoring.

-- Drop the existing non-unique index on google_place_id so we can replace it
-- with a partial unique index (NULL values are exempt from uniqueness).
DROP INDEX IF EXISTS idx_lots_place_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_lots_google_place_id
  ON lots(google_place_id)
  WHERE google_place_id IS NOT NULL;

-- Store the list of OSM way IDs that were unioned into this lot row.
-- NULL for single-way lots seeded before Track 3.
ALTER TABLE lots ADD COLUMN IF NOT EXISTS source_osm_ids JSONB;

-- Place-pin anchor coordinates (the Google Places lat/lng that triggered the
-- union search).  Used as the "Front" anchor for zone partitioning.
-- NULL for GPS-mode lots that have no Place context.
ALTER TABLE lots ADD COLUMN IF NOT EXISTS place_lat FLOAT;
ALTER TABLE lots ADD COLUMN IF NOT EXISTS place_lng FLOAT;
