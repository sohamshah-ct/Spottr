-- SPOTTR Migration 003: V5 Live Detection Architecture
-- Removes synthetic grid data, adds lot_detections cache + verification_log
-- Preserves: 692 lot polygons, schema, all non-synthetic occupancy_history rows

BEGIN;

-- 1. Drop synthetic spaces (71,895 grid-generated rows)
DELETE FROM spaces;

-- 2. Drop occupancy_history rows written by batch pipeline (all of them —
--    source values used were 'grid_estimate', 'yolov8x', 'yolo', 'yolov8x_aerial')
DELETE FROM occupancy_history;

-- 3. Reset lot detection status so Modal triggers fresh detection on next request
UPDATE lots SET
  spot_detection_status = 'pending',
  spot_detection_attempts = 0,
  last_spot_detection = NULL,
  spot_detection_last_error = NULL;

-- 4. Create detection cache table
CREATE TABLE IF NOT EXISTS lot_detections (
  id                    BIGSERIAL PRIMARY KEY,
  lot_id                UUID NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  detected_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  spaces_data           JSONB NOT NULL,
  car_detector_model    VARCHAR(100),
  stripe_detector_model VARCHAR(100),
  overall_confidence    FLOAT,
  source                VARCHAR(20) NOT NULL CHECK (source IN ('sam2_full','grid_fallback','mixed','modal_error')),
  modal_duration_ms     INT,
  expires_at            TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lot_detections_lot_fresh ON lot_detections(lot_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_lot_detections_expires ON lot_detections(expires_at);

-- 5. Create verification log table
CREATE TABLE IF NOT EXISTS verification_log (
  id                           SERIAL PRIMARY KEY,
  lot_id                       UUID REFERENCES lots(id),
  verified_at                  TIMESTAMPTZ DEFAULT NOW(),
  verifier                     VARCHAR(100),
  row_layout_correct           BOOLEAN,
  spot_count_accurate          BOOLEAN,
  coordinates_navigate_correctly BOOLEAN,
  occupancy_accurate           BOOLEAN,
  notes                        TEXT,
  confidence_at_detection      FLOAT,
  source_at_detection          VARCHAR(20)
);

COMMIT;
