-- SPOTTR Migration 007: BestTime.app venue ID
-- Adds besttime_venue_id column to lots for V6 live busyness integration.
-- Controlled by BESTTIME_ENABLED env var; column is populated but not queried
-- until V6 is enabled.

ALTER TABLE lots
  ADD COLUMN IF NOT EXISTS besttime_venue_id TEXT DEFAULT NULL;

-- Seed Costco South Windsor (flagship lot) with its BestTime venue ID once
-- obtained from the BestTime.app venue-search endpoint. Placeholder value
-- is NULL until populated via the BestTime venue-search script.
DO $$
DECLARE
  matched_count INT;
BEGIN
  SELECT COUNT(*) INTO matched_count
  FROM lots
  WHERE name ILIKE '%Costco%' AND city = 'South Windsor';

  IF matched_count = 0 THEN
    RAISE WARNING 'Migration 007: No Costco South Windsor row found — besttime_venue_id seed skipped. Run after lot hydration.';
  END IF;
  -- besttime_venue_id intentionally left NULL here; populated by besttime_seed.js
  -- once a BestTime account is created and venue IDs are resolved.
END;
$$;
