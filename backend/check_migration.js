const { Client } = require('pg');
const fs = require('fs');

async function run() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  await client.connect();

  // Check if migration already applied
  const tables = await client.query(`
    SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename
  `);
  console.log('Tables:', tables.rows.map(r => r.tablename).join(', '));

  const counts = await client.query(`
    SELECT
      (SELECT COUNT(*) FROM spaces) AS spaces,
      (SELECT COUNT(*) FROM occupancy_history) AS occupancy_history,
      (SELECT COUNT(*) FROM lots) AS lots_total,
      (SELECT COUNT(*) FROM lots WHERE spot_detection_status='pending') AS lots_pending,
      (SELECT COUNT(*) FROM lots WHERE spot_detection_status='complete') AS lots_complete,
      (SELECT COUNT(*) FROM lots WHERE spot_detection_status IS NULL) AS lots_null
  `);
  console.log('Counts:', JSON.stringify(counts.rows[0], null, 2));

  // Check if lot_detections exists
  const ldExists = await client.query(`
    SELECT EXISTS (SELECT FROM pg_tables WHERE schemaname='public' AND tablename='lot_detections') AS exists
  `);
  console.log('lot_detections exists:', ldExists.rows[0].exists);

  const vlExists = await client.query(`
    SELECT EXISTS (SELECT FROM pg_tables WHERE schemaname='public' AND tablename='verification_log') AS exists
  `);
  console.log('verification_log exists:', vlExists.rows[0].exists);

  // If migration not fully applied, run it now
  if (!ldExists.rows[0].exists) {
    console.log('\nRunning migration 003...');
    const sql = fs.readFileSync('src/db/migrations/003_v5_live_detection.sql', 'utf8');
    await client.query(sql);
    console.log('Migration 003 applied successfully.');
  } else {
    console.log('\nMigration 003 already applied.');
  }

  // Final state
  const final = await client.query(`
    SELECT
      (SELECT COUNT(*) FROM spaces) AS spaces,
      (SELECT COUNT(*) FROM occupancy_history) AS occupancy_history,
      (SELECT COUNT(*) FROM lots WHERE spot_detection_status='pending') AS lots_pending,
      (SELECT COUNT(*) FROM lot_detections) AS lot_detections_rows,
      (SELECT COUNT(*) FROM verification_log) AS verification_log_rows
  `);
  console.log('\nFinal state:', JSON.stringify(final.rows[0], null, 2));

  await client.end();
}

run().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
