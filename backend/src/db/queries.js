/**
 * SPOTTR — Core database queries
 */
const pool = require('./pool');

const HAVERSINE_SQL = (latParam, lngParam, latCol = 'l.lat', lngCol = 'l.lng') => `
  (6371000 * 2 * ASIN(SQRT(
    POWER(SIN((RADIANS(${latCol}) - RADIANS(${latParam})) / 2), 2) +
    COS(RADIANS(${latParam})) * COS(RADIANS(${latCol})) *
    POWER(SIN((RADIANS(${lngCol}) - RADIANS(${lngParam})) / 2), 2)
  )))
`;

async function getLotsNearby({ lat, lng, radius = 1000, limit = 20 }) {
  const distance = HAVERSINE_SQL(lat, lng);
  const result = await pool.query(`
    SELECT l.id, l.name, l.lot_type, l.address, l.city, l.state, l.lat, l.lng,
           l.total_spaces, l.levels, l.hours, l.pricing, l.restrictions,
           ${distance} AS distance_meters,
           os.total_open, os.total_spaces AS snapshot_total_spaces, os.occupancy_pct,
           os.confidence, os.last_updated, os.row_snapshots, os.data_age_mins
    FROM lots l
    LEFT JOIN occupancy_snapshots os ON os.lot_id = l.id
    WHERE l.lat IS NOT NULL AND l.lng IS NOT NULL
      AND l.lat BETWEEN $1 - ($3 / 111000.0) AND $1 + ($3 / 111000.0)
      AND l.lng BETWEEN $2 - ($3 / 111000.0) AND $2 + ($3 / 111000.0)
      AND ${distance} <= $3
    ORDER BY distance_meters ASC
    LIMIT $4
  `, [lat, lng, radius, limit]);
  return result.rows;
}

async function getLotById(id) {
  const result = await pool.query(`
    SELECT l.*, os.total_open, os.occupancy_pct, os.confidence, os.last_updated, os.row_snapshots, os.data_age_mins
    FROM lots l
    LEFT JOIN occupancy_snapshots os ON os.lot_id = l.id
    WHERE l.id = $1
  `, [id]);
  return result.rows[0] || null;
}

async function getLotRows(lotId) {
  const result = await pool.query(`
    SELECT r.id, r.label, r.entrance_lat, r.entrance_lng, r.entrance_bearing,
           r.position_order, r.space_count, r.level, COUNT(s.id) AS total_spaces_detected
    FROM lot_rows r
    LEFT JOIN spaces s ON s.row_id = r.id
    WHERE r.lot_id = $1
    GROUP BY r.id
    ORDER BY r.position_order ASC
  `, [lotId]);
  const snapshot = await pool.query('SELECT row_snapshots FROM occupancy_snapshots WHERE lot_id = $1', [lotId]);
  const rowSnapshots = snapshot.rows[0]?.row_snapshots || {};
  return result.rows.map(row => {
    const snap = rowSnapshots[row.label] || {};
    return { ...row, open: snap.open ?? null, total: snap.total ?? row.space_count, confidence: snap.confidence ?? 'estimated', occupancy_pct: snap.total ? (1-(snap.open/snap.total)) : null };
  });
}

async function getLotForecast(lotId, hours = 6) {
  const result = await pool.query(`
    SELECT predicted_for, day_of_week, occupancy_pct, open_spaces, model_version
    FROM predictions
    WHERE lot_id = $1 AND predicted_for >= NOW() AND predicted_for <= NOW() + ($2 || ' hours')::interval
    ORDER BY predicted_for ASC
  `, [lotId, hours]);
  return result.rows;
}

async function insertEvent({ lot_id, space_id, row_id, event_type, source, observed_at, device_id, confidence, raw_lat, raw_lng }) {
  const result = await pool.query(`
    INSERT INTO occupancy_events (lot_id,space_id,row_id,event_type,source,observed_at,device_id,confidence,raw_lat,raw_lng)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id
  `, [lot_id, space_id||null, row_id||null, event_type, source||'passive_gps', observed_at||new Date().toISOString(), device_id, confidence||1.0, raw_lat, raw_lng]);
  return result.rows[0];
}

async function insertEventsBatch(events) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ids = [];
    for (const e of events) {
      const r = await client.query(`
        INSERT INTO occupancy_events (lot_id,space_id,row_id,event_type,source,observed_at,device_id,confidence,raw_lat,raw_lng)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id
      `, [e.lot_id, e.space_id||null, e.row_id||null, e.event_type, e.source||'passive_gps', e.observed_at||new Date().toISOString(), e.device_id, e.confidence||1.0, e.raw_lat, e.raw_lng]);
      ids.push(r.rows[0].id);
    }
    await client.query('COMMIT');
    return ids;
  } catch (err) { await client.query('ROLLBACK'); throw err; }
  finally { client.release(); }
}

async function searchLots({ q, lat, lng, limit = 20 }) {
  const hasLocation = lat != null && lng != null;
  const distance = hasLocation ? HAVERSINE_SQL(lat, lng) : '0';
  const result = await pool.query(`
    SELECT l.id, l.name, l.lot_type, l.address, l.city, l.state, l.lat, l.lng, l.total_spaces,
           ${distance} AS distance_meters, os.total_open, os.occupancy_pct, os.confidence
    FROM lots l LEFT JOIN occupancy_snapshots os ON os.lot_id = l.id
    WHERE (l.name ILIKE $1 OR l.address ILIKE $1 OR l.city ILIKE $1)
    ${hasLocation ? 'AND l.lat IS NOT NULL AND l.lng IS NOT NULL' : ''}
    ORDER BY distance_meters ASC LIMIT $2
  `, [`%${q}%`, limit]);
  return result.rows;
}

async function getFrequentLots(deviceId, limit = 5) {
  const result = await pool.query(`
    SELECT l.id, l.name, l.lot_type, l.address, l.lat, l.lng, COUNT(e.id) AS visit_count,
           MAX(e.observed_at) AS last_visited, os.total_open, os.occupancy_pct, os.confidence
    FROM occupancy_events e JOIN lots l ON l.id=e.lot_id
    LEFT JOIN occupancy_snapshots os ON os.lot_id=l.id
    WHERE e.device_id=$1 AND e.event_type='arrived'
    GROUP BY l.id, os.total_open, os.occupancy_pct, os.confidence
    ORDER BY visit_count DESC, last_visited DESC LIMIT $2
  `, [deviceId, limit]);
  return result.rows;
}

async function getSatelliteInfo(lotId, provider = 'mapbox') {
  const lot = await getLotById(lotId);
  if (!lot) return null;
  if (provider === 'mapbox' || provider === 'live') {
    return { provider: 'Mapbox Satellite', mapbox_style: 'mapbox://styles/mapbox/satellite-v9', center: [lot.lng, lot.lat], zoom: 19, captured_at: 'Recent', lot_id: lotId };
  }
  if (provider === 'ai') {
    const result = await pool.query('SELECT s3_key, captured_at, spaces_detected FROM imagery_log WHERE lot_id=$1 AND ai_processed=true ORDER BY captured_at DESC LIMIT 1', [lotId]);
    if (result.rows[0]) return { provider: 'SPOTTR AI', ...result.rows[0], lot_id: lotId };
  }
  return { provider: 'Mapbox Satellite', mapbox_style: 'mapbox://styles/mapbox/satellite-v9', center: [lot.lng, lot.lat], zoom: 19, captured_at: 'Recent', lot_id: lotId };
}

async function registerDevice({ device_id, push_token, platform }) {
  const result = await pool.query(`
    INSERT INTO device_tokens (device_id, push_token, platform) VALUES ($1,$2,$3)
    ON CONFLICT (device_id) DO UPDATE SET push_token=EXCLUDED.push_token, platform=EXCLUDED.platform, updated_at=NOW()
    RETURNING id
  `, [device_id, push_token, platform]);
  return result.rows[0];
}

module.exports = { getLotsNearby, getLotById, getLotRows, getLotForecast, insertEvent, insertEventsBatch, searchLots, getFrequentLots, getSatelliteInfo, registerDevice };
