-- SPOTTR Migration 002: Moat Schema
ALTER TABLE lots ADD COLUMN IF NOT EXISTS region VARCHAR(100);
ALTER TABLE lots ADD COLUMN IF NOT EXISTS processing_phase INT DEFAULT 0;
ALTER TABLE lots ADD COLUMN IF NOT EXISTS first_observed_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE lots ADD COLUMN IF NOT EXISTS spot_detection_status VARCHAR(20) DEFAULT 'pending';
ALTER TABLE lots ADD COLUMN IF NOT EXISTS spot_detection_attempts INT DEFAULT 0;
ALTER TABLE lots ADD COLUMN IF NOT EXISTS spot_detection_last_error TEXT;
ALTER TABLE lots ADD COLUMN IF NOT EXISTS last_spot_detection TIMESTAMPTZ;
ALTER TABLE lots ADD COLUMN IF NOT EXISTS google_place_id VARCHAR(255);
ALTER TABLE lots ADD COLUMN IF NOT EXISTS business_name VARCHAR(255);
ALTER TABLE lots ADD COLUMN IF NOT EXISTS data_sources JSONB DEFAULT '[]';

ALTER TABLE spaces ADD COLUMN IF NOT EXISTS data_sources JSONB DEFAULT '[]';

CREATE INDEX IF NOT EXISTS idx_lots_region ON lots(region);
CREATE INDEX IF NOT EXISTS idx_lots_phase ON lots(processing_phase);
CREATE INDEX IF NOT EXISTS idx_lots_place_id ON lots(google_place_id);
CREATE INDEX IF NOT EXISTS idx_lots_status ON lots(spot_detection_status);

CREATE TABLE IF NOT EXISTS occupancy_history (
    id              BIGSERIAL PRIMARY KEY,
    space_id        UUID REFERENCES spaces(id) ON DELETE CASCADE,
    lot_id          UUID REFERENCES lots(id) ON DELETE CASCADE,
    occupied        BOOLEAN NOT NULL,
    confidence      FLOAT,
    source          VARCHAR(20) NOT NULL,
    captured_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    weather_conditions JSONB,
    nearby_events   JSONB,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_occupancy_space_time ON occupancy_history(space_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_occupancy_lot_time ON occupancy_history(lot_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_occupancy_captured ON occupancy_history(captured_at DESC);

UPDATE lots SET region='hartford_downtown', processing_phase=1
WHERE region IS NULL AND lat BETWEEN 41.74 AND 41.78 AND lng BETWEEN -72.70 AND -72.67;

UPDATE lots SET region='south_windsor', processing_phase=1
WHERE region IS NULL AND lat BETWEEN 41.82 AND 41.87 AND lng BETWEEN -72.65 AND -72.55;
