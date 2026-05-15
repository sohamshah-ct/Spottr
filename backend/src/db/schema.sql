-- SPOTTR Database Schema
-- PostgreSQL 15+ (no PostGIS required)

DROP TABLE IF EXISTS device_tokens CASCADE;
DROP TABLE IF EXISTS imagery_log CASCADE;
DROP TABLE IF EXISTS predictions CASCADE;
DROP TABLE IF EXISTS occupancy_snapshots CASCADE;
DROP TABLE IF EXISTS occupancy_events CASCADE;
DROP TABLE IF EXISTS spaces CASCADE;
DROP TABLE IF EXISTS lot_rows CASCADE;
DROP TABLE IF EXISTS lots CASCADE;

CREATE TABLE lots (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  osm_id          BIGINT UNIQUE,
  name            TEXT,
  lot_type        TEXT CHECK (lot_type IN ('surface', 'garage', 'street')),
  address         TEXT,
  city            TEXT,
  state           TEXT,
  country         TEXT DEFAULT 'US',
  lat             FLOAT,
  lng             FLOAT,
  bbox_north      FLOAT,
  bbox_south      FLOAT,
  bbox_east       FLOAT,
  bbox_west       FLOAT,
  geometry_wkt    TEXT,
  total_spaces    INTEGER,
  levels          INTEGER DEFAULT 1,
  hours           JSONB,
  pricing         JSONB,
  restrictions    JSONB,
  source          TEXT,
  last_imaged_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_lots_lat_lng ON lots(lat, lng);
CREATE INDEX idx_lots_city ON lots(city);
CREATE INDEX idx_lots_osm_id ON lots(osm_id);

CREATE TABLE lot_rows (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id           UUID REFERENCES lots(id) ON DELETE CASCADE,
  label            TEXT NOT NULL,
  entrance_lat     FLOAT,
  entrance_lng     FLOAT,
  entrance_bearing FLOAT,
  position_order   INTEGER,
  space_count      INTEGER,
  level            INTEGER DEFAULT 1,
  geometry_wkt     TEXT,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_rows_lot_id ON lot_rows(lot_id);

CREATE TABLE spaces (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id        UUID REFERENCES lots(id) ON DELETE CASCADE,
  row_id        UUID REFERENCES lot_rows(id),
  space_label   TEXT,
  lat           FLOAT,
  lng           FLOAT,
  space_type    TEXT DEFAULT 'standard' CHECK (space_type IN ('standard','handicap','ev','compact')),
  confidence    FLOAT,
  detected_from TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_spaces_lot_id ON spaces(lot_id);
CREATE INDEX idx_spaces_row_id ON spaces(row_id);

CREATE TABLE occupancy_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id      UUID REFERENCES lots(id),
  space_id    UUID REFERENCES spaces(id),
  row_id      UUID REFERENCES lot_rows(id),
  event_type  TEXT CHECK (event_type IN ('arrived', 'departed')),
  source      TEXT CHECK (source IN ('passive_gps','satellite_ai','city_sensor','camera_feed')),
  observed_at TIMESTAMPTZ NOT NULL,
  device_id   TEXT,
  confidence  FLOAT DEFAULT 1.0,
  raw_lat     FLOAT,
  raw_lng     FLOAT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_events_lot_id ON occupancy_events(lot_id);
CREATE INDEX idx_events_observed_at ON occupancy_events(observed_at);
CREATE INDEX idx_events_lot_time ON occupancy_events(lot_id, observed_at);

CREATE TABLE occupancy_snapshots (
  lot_id        UUID PRIMARY KEY REFERENCES lots(id),
  row_snapshots JSONB,
  total_open    INTEGER,
  total_spaces  INTEGER,
  occupancy_pct FLOAT,
  last_updated  TIMESTAMPTZ DEFAULT NOW(),
  data_age_mins INTEGER,
  confidence    TEXT CHECK (confidence IN ('live','recent','predicted','estimated'))
);

CREATE TABLE predictions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id        UUID REFERENCES lots(id),
  predicted_for TIMESTAMPTZ NOT NULL,
  day_of_week   INTEGER,
  occupancy_pct FLOAT,
  open_spaces   INTEGER,
  model_version TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_predictions_lot_time ON predictions(lot_id, predicted_for);

CREATE TABLE imagery_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id          UUID REFERENCES lots(id),
  provider        TEXT,
  captured_at     TIMESTAMPTZ,
  resolution_cm   FLOAT,
  s3_key          TEXT,
  ai_processed    BOOLEAN DEFAULT FALSE,
  spaces_detected INTEGER,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE device_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id  TEXT NOT NULL UNIQUE,
  push_token TEXT,
  platform   TEXT CHECK (platform IN ('ios','android')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_device_tokens_device_id ON device_tokens(device_id);
