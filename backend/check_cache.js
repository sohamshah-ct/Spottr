const { Pool } = require('pg');
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
async function main() {
  const r1 = await p.query('SELECT COUNT(*) FROM lot_detections');
  console.log('lot_detections rows:', r1.rows[0].count);
  const r2 = await p.query('SELECT COUNT(*) FROM occupancy_history');
  console.log('occupancy_history rows:', r2.rows[0].count);
  const r3 = await p.query('SELECT id, lot_id, source, overall_confidence, modal_duration_ms, detected_at FROM lot_detections ORDER BY detected_at DESC LIMIT 3');
  console.log('Recent detections:', JSON.stringify(r3.rows, null, 2));
  await p.end();
}
main().catch(e => { console.error(e.message); p.end(); });
