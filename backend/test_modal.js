// Step 6: Test Modal detection on one Hartford lot end-to-end
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function main() {
  // Get a Hartford lot with bounding box
  const lotRes = await pool.query(`
    SELECT id, name, lat, lng, bbox_north, bbox_south, bbox_east, bbox_west
    FROM lots
    WHERE region='hartford_downtown' AND bbox_north IS NOT NULL AND lat IS NOT NULL
    LIMIT 1
  `);

  if (!lotRes.rows[0]) {
    console.error('No Hartford lots found with bbox');
    process.exit(1);
  }

  const lot = lotRes.rows[0];
  console.log('Test lot:', lot.name || lot.id, `(${lot.lat}, ${lot.lng})`);

  const polygon = {
    type: 'Polygon',
    coordinates: [[[lot.bbox_west, lot.bbox_south],[lot.bbox_east, lot.bbox_south],
                   [lot.bbox_east, lot.bbox_north],[lot.bbox_west, lot.bbox_north],
                   [lot.bbox_west, lot.bbox_south]]]
  };

  const MODAL_URL = process.env.MODAL_DETECT_URL;
  console.log('Modal URL:', MODAL_URL);
  console.log('Calling Modal...');

  const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
  const t0 = Date.now();

  const resp = await (await fetch)(MODAL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lot_id: lot.id,
      lot_polygon_geojson: polygon,
      centroid_lat: lot.lat,
      centroid_lng: lot.lng,
    }),
  });

  const elapsed = Date.now() - t0;
  console.log(`Response: HTTP ${resp.status} in ${elapsed}ms`);

  if (!resp.ok) {
    console.error('Error body:', await resp.text());
    process.exit(1);
  }

  const result = await resp.json();
  console.log('\n=== Modal Result ===');
  console.log('source:', result.source);
  console.log('spaces_count:', result.spaces_count);
  console.log('cars_detected:', result.cars_detected);
  console.log('sam2_stripes_found:', result.sam2_stripes_found);
  console.log('overall_confidence:', result.overall_confidence);
  console.log('modal_duration_ms:', result.duration_ms);
  console.log('model_versions:', JSON.stringify(result.model_versions));

  if (result.spaces && result.spaces.length > 0) {
    console.log('\nFirst 3 spaces:');
    result.spaces.slice(0, 3).forEach((s, i) => {
      console.log(`  [${i}] lat=${s.lat?.toFixed(6)}, lng=${s.lng?.toFixed(6)}, occupied=${s.occupied}, conf=${s.confidence}, source=${s.source}`);
    });
  }

  // Check DB cache was written
  const cacheCheck = await pool.query(
    'SELECT id, detected_at, source, spaces_data->0 AS first_space FROM lot_detections WHERE lot_id=$1',
    [lot.id]
  );
  console.log('\nCache row written:', cacheCheck.rows.length > 0 ? 'YES' : 'NO');

  const ohCheck = await pool.query(
    'SELECT COUNT(*) FROM occupancy_history WHERE lot_id=$1', [lot.id]
  );
  console.log('occupancy_history rows:', ohCheck.rows[0].count);

  await pool.end();
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
