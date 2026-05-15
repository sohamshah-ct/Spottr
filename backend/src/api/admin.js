const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

router.get('/accumulation-metrics', async (req, res) => {
  try {
    const [totalsRes, growthRes, byRegionRes] = await Promise.all([
      pool.query(`SELECT
        (SELECT COUNT(*) FROM lots)                                            AS lots_total,
        (SELECT COUNT(*) FROM lots WHERE spot_detection_status = 'complete')  AS lots_with_spaces,
        (SELECT COUNT(*) FROM spaces)                                          AS spaces_total,
        (SELECT COUNT(*) FROM occupancy_history)                              AS occupancy_observations_total`),
      pool.query(`SELECT
        (SELECT COUNT(*) FROM lots WHERE first_observed_at > NOW() - INTERVAL '7 days')       AS lots_7d,
        (SELECT COUNT(*) FROM spaces WHERE created_at > NOW() - INTERVAL '7 days')            AS spaces_7d,
        (SELECT COUNT(*) FROM occupancy_history WHERE captured_at > NOW() - INTERVAL '7 days') AS observations_7d`),
      pool.query(`SELECT COALESCE(l.region,'untagged') AS region, COUNT(l.id) AS lots,
        COALESCE(SUM(l.total_spaces),0) AS spaces,
        ROUND(100.0*COUNT(CASE WHEN l.spot_detection_status='complete' THEN 1 END)/NULLIF(COUNT(l.id),0),1) AS complete_pct
        FROM lots l GROUP BY l.region ORDER BY lots DESC`),
    ]);
    const t = totalsRes.rows[0], g = growthRes.rows[0];
    res.json({
      lots_total: parseInt(t.lots_total), lots_with_spaces: parseInt(t.lots_with_spaces),
      spaces_total: parseInt(t.spaces_total), occupancy_observations_total: parseInt(t.occupancy_observations_total),
      growth_last_7_days: { lots: parseInt(g.lots_7d), spaces: parseInt(g.spaces_7d), observations: parseInt(g.observations_7d) },
      by_region: byRegionRes.rows.map(r => ({ region: r.region, lots: parseInt(r.lots), spaces: parseInt(r.spaces), complete_pct: parseFloat(r.complete_pct)||0 })),
    });
  } catch (err) {
    console.error('GET /admin/accumulation-metrics error:', err.message);
    res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
});

module.exports = router;
