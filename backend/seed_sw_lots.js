/**
 * Manually seed 5 South Windsor verification lots that aren't in OSM,
 * then trigger Modal detection on each.
 */
const { Pool } = require('pg');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const API_BASE = 'https://spottr-api-production.up.railway.app';

// Approximate bounding boxes for each lot (~100m x 100m typical suburban lot)
const SW_LOTS = [
  {
    name: 'Highland Park Market',
    address: '1240 Sullivan Ave',
    city: 'South Windsor', state: 'CT',
    lat: 41.84130, lng: -72.58780,
    bbox_north: 41.84185, bbox_south: 41.84075, bbox_east: -72.58690, bbox_west: -72.58870,
  },
  {
    name: 'Stop & Shop',
    address: '1320 Sullivan Ave',
    city: 'South Windsor', state: 'CT',
    lat: 41.84320, lng: -72.58700,
    bbox_north: 41.84410, bbox_south: 41.84230, bbox_east: -72.58560, bbox_west: -72.58840,
  },
  {
    name: 'South Windsor Town Hall',
    address: '1540 Sullivan Ave',
    city: 'South Windsor', state: 'CT',
    lat: 41.85270, lng: -72.58980,
    bbox_north: 41.85330, bbox_south: 41.85210, bbox_east: -72.58880, bbox_west: -72.59080,
  },
  {
    name: 'Evergreen Walk',
    address: '501 Evergreen Way',
    city: 'South Windsor', state: 'CT',
    lat: 41.83610, lng: -72.57050,
    bbox_north: 41.83720, bbox_south: 41.83500, bbox_east: -72.56870, bbox_west: -72.57230,
  },
  {
    name: 'Avery Street Christian Reformed Church',
    address: '661 Avery St',
    city: 'South Windsor', state: 'CT',
    lat: 41.82780, lng: -72.59710,
    bbox_north: 41.82830, bbox_south: 41.82730, bbox_east: -72.59640, bbox_west: -72.59780,
  },
];

async function main() {
  console.log('=== Seeding South Windsor verification lots ===\n');

  const lotIds = [];

  for (const lot of SW_LOTS) {
    // Check if lot already exists by name+city, insert if not
    let existing = await pool.query(
      `SELECT id, name FROM lots WHERE name=$1 AND city=$2 LIMIT 1`,
      [lot.name, lot.city]
    );
    let r;
    if (existing.rows.length > 0) {
      // Update bbox/coords
      r = await pool.query(
        `UPDATE lots SET lat=$1, lng=$2, bbox_north=$3, bbox_south=$4, bbox_east=$5, bbox_west=$6,
           spot_detection_status='pending'
         WHERE id=$7 RETURNING id, name`,
        [lot.lat, lot.lng, lot.bbox_north, lot.bbox_south, lot.bbox_east, lot.bbox_west, existing.rows[0].id]
      );
    } else {
      r = await pool.query(`
        INSERT INTO lots (name, address, city, state, lat, lng,
          bbox_north, bbox_south, bbox_east, bbox_west,
          lot_type, region, spot_detection_status, source)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'surface','south_windsor','pending','manual_seed')
        RETURNING id, name
      `, [lot.name, lot.address, lot.city, lot.state, lot.lat, lot.lng,
          lot.bbox_north, lot.bbox_south, lot.bbox_east, lot.bbox_west]);
    }
    const row = r.rows[0];
    console.log(`Upserted: ${row.name} → ${row.id}`);
    lotIds.push({ ...lot, id: row.id });
  }

  console.log('\n=== Triggering Modal detection via /api/lots/:id/rows ===\n');

  for (const lot of lotIds) {
    console.log(`Detecting: ${lot.name}`);
    const t0 = Date.now();
    try {
      const resp = await (await fetch)(`${API_BASE}/api/lots/${lot.id}/rows`, { timeout: 150000 });
      const elapsed = Date.now() - t0;
      if (!resp.ok) {
        console.log(`  ERROR ${resp.status}: ${(await resp.text()).slice(0, 100)}`);
        continue;
      }
      const data = await resp.json();
      console.log(`  source:     ${data.source}`);
      console.log(`  spaces:     ${data.spaces_total}`);
      console.log(`  rows:       ${data.count}`);
      console.log(`  confidence: ${data.confidence}`);
      console.log(`  cached:     ${data.cached}`);
      console.log(`  elapsed_ms: ${elapsed}`);

      if (data.rows && data.rows.length > 0) {
        const r = data.rows[0];
        console.log(`  row[0]:     ${r.label} — ${r.open}/${r.total} open`);
      }
    } catch (e) {
      console.log(`  FAILED: ${e.message}`);
    }
    console.log();
  }

  // Check cache
  const cacheCheck = await pool.query(`
    SELECT l.name, ld.source, ld.overall_confidence, ld.spaces_data->0 AS sample_space,
           jsonb_array_length(ld.spaces_data) AS spaces_count, ld.modal_duration_ms
    FROM lot_detections ld
    JOIN lots l ON l.id = ld.lot_id
    WHERE l.region = 'south_windsor'
    ORDER BY ld.detected_at DESC
  `);

  console.log('\n=== Cache verification ===');
  console.log(`Cached detections: ${cacheCheck.rows.length}`);
  for (const row of cacheCheck.rows) {
    console.log(`  ${row.name}: ${row.spaces_count} spaces, source=${row.source}, conf=${row.overall_confidence}, ${row.modal_duration_ms}ms`);
  }

  console.log('\n=== GROUND-TRUTH CHECKLIST ===');
  console.log('For each lot, when you drive there:');
  console.log('[ ] Row layout matches reality (rows roughly aligned to actual parking rows)');
  console.log('[ ] Spot count within +/-25% of actual count');
  console.log('[ ] Sample spot lat/lng navigates to real spot in Apple/Google Maps');
  console.log('[ ] Occupied spots flagged as occupied (if parked cars visible)');
  console.log('');
  console.log('Log results with:');
  console.log("INSERT INTO verification_log (lot_id, verifier, row_layout_correct, spot_count_accurate, coordinates_navigate_correctly, occupancy_accurate, notes, confidence_at_detection, source_at_detection)");
  console.log("VALUES ('<lot_id>', 'soham', true/false, true/false, true/false, true/false, 'notes', <conf>, '<source>');");

  await pool.end();
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
