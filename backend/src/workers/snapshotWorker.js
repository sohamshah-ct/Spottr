require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const pool = require('../db/pool');
const INTERVAL_MS = 5 * 60 * 1000;

async function updateSnapshots() {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT e.lot_id,
        COUNT(*) FILTER (WHERE e.event_type='arrived' AND e.observed_at > NOW()-INTERVAL '2 hours') AS recent_arrived,
        COUNT(*) FILTER (WHERE e.event_type='departed' AND e.observed_at > NOW()-INTERVAL '2 hours') AS recent_departed,
        l.total_spaces, os.total_open AS prev_open,
        EXTRACT(EPOCH FROM (NOW()-os.last_updated))/60 AS age_mins
      FROM occupancy_events e
      JOIN lots l ON l.id=e.lot_id
      LEFT JOIN occupancy_snapshots os ON os.lot_id=e.lot_id
      WHERE e.observed_at > NOW()-INTERVAL '2 hours'
      GROUP BY e.lot_id, l.total_spaces, os.total_open, os.last_updated
    `);
    for (const row of result.rows) {
      const total = row.total_spaces || 50;
      const net = parseInt(row.recent_departed) - parseInt(row.recent_arrived);
      const prev_open = row.prev_open ?? Math.floor(total * 0.5);
      const total_open = Math.max(0, Math.min(total, prev_open + net));
      await client.query(`
        INSERT INTO occupancy_snapshots (lot_id,total_open,total_spaces,occupancy_pct,last_updated,data_age_mins,confidence)
        VALUES ($1,$2,$3,$4,NOW(),0,'live')
        ON CONFLICT (lot_id) DO UPDATE SET total_open=EXCLUDED.total_open, total_spaces=EXCLUDED.total_spaces,
          occupancy_pct=EXCLUDED.occupancy_pct, last_updated=NOW(), data_age_mins=0, confidence='live'
      `, [row.lot_id, total_open, total, Math.round((total-total_open)/total*1000)/1000]);
    }
    await client.query(`UPDATE occupancy_snapshots SET
      data_age_mins=EXTRACT(EPOCH FROM (NOW()-last_updated))/60,
      confidence=CASE WHEN EXTRACT(EPOCH FROM (NOW()-last_updated))/60<30 THEN 'recent'
        WHEN EXTRACT(EPOCH FROM (NOW()-last_updated))/60<120 THEN 'predicted' ELSE 'estimated' END
      WHERE last_updated < NOW()-INTERVAL '5 minutes'`);
    console.log(`[${new Date().toISOString()}] Snapshot update: ${result.rows.length} lots refreshed`);
  } catch (err) { console.error('Snapshot worker error:', err.message); }
  finally { client.release(); }
}

updateSnapshots();
setInterval(updateSnapshots, INTERVAL_MS);
console.log(`Snapshot worker started. Updating every ${INTERVAL_MS/1000}s`);
