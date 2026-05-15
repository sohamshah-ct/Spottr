const express = require('express');
const router = express.Router();
const db = require('../db/queries');
const pool = require('../db/pool');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const HAVERSINE_SQL = (lat, lng, latCol = 'l.lat', lngCol = 'l.lng') => `
  (6371000 * 2 * ASIN(SQRT(
    POWER(SIN((RADIANS(${latCol}) - RADIANS(${lat})) / 2), 2) +
    COS(RADIANS(${lat})) * COS(RADIANS(${latCol})) *
    POWER(SIN((RADIANS(${lngCol}) - RADIANS(${lng})) / 2), 2)
  )))
`;

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = Math.PI * (lat2 - lat1) / 180;
  const dLng = Math.PI * (lng2 - lng1) / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(Math.PI*lat1/180)*Math.cos(Math.PI*lat2/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// GET /api/lots/near - BEFORE /:id to avoid "near" being parsed as a UUID
router.get('/near', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: 'lat and lng are required' });

  try {
    const distance = HAVERSINE_SQL(lat, lng);
    const dbResult = await pool.query(`
      SELECT l.id, l.name, l.lot_type, l.address, l.city, l.state,
             l.lat, l.lng, l.total_spaces, l.region, l.spot_detection_status,
             ${distance} AS distance_meters,
             os.total_open, os.occupancy_pct, os.confidence, os.row_snapshots
      FROM lots l
      LEFT JOIN occupancy_snapshots os ON os.lot_id = l.id
      WHERE l.lat IS NOT NULL AND l.lng IS NOT NULL
        AND l.spot_detection_status = 'complete'
        AND ${distance} <= 200
      ORDER BY distance_meters ASC
      LIMIT 20
    `);

    if (dbResult.rows.length > 0) {
      return res.json({ lots: dbResult.rows, source: 'proprietary_db', count: dbResult.rows.length });
    }

    console.log(`No proprietary lots within 200m of ${lat},${lng} - querying OSM`);
    const osmLots = await fetchOsmParkingNear(lat, lng, 200);
    if (osmLots.length === 0) return res.json({ lots: [], source: 'osm_fallback', count: 0 });

    const insertedIds = [];
    for (const lot of osmLots) {
      const r = await pool.query(`
        INSERT INTO lots (osm_id, name, lot_type, lat, lng,
          bbox_north, bbox_south, bbox_east, bbox_west, geometry_wkt, region, spot_detection_status, source)
        VALUES ($1,$2,'surface',$3,$4,$5,$6,$7,$8,$9,'long_tail','pending','osm')
        ON CONFLICT (osm_id) DO UPDATE SET
          spot_detection_status = CASE WHEN lots.spot_detection_status='complete' THEN 'complete' ELSE 'pending' END
        RETURNING id
      `, [lot.osm_id, lot.name, lot.lat, lot.lng, lot.bbox_north, lot.bbox_south, lot.bbox_east, lot.bbox_west, lot.geometry_wkt]);
      if (r.rows[0]) insertedIds.push({ ...lot, id: r.rows[0].id });
    }

    res.json({
      lots: insertedIds.map(l => ({
        id: l.id, name: l.name || 'Parking Lot', lot_type: 'surface',
        lat: l.lat, lng: l.lng, address: null, total_open: null,
        occupancy_pct: null, spot_detection_status: 'processing',
        distance_meters: haversineMeters(lat, lng, l.lat, l.lng),
      })),
      source: 'osm_fallback', count: insertedIds.length,
      message: 'Lots found via OSM - spot detection queued',
    });
  } catch (err) {
    console.error('GET /lots/near error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/lots/nearby
router.get('/nearby', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  const radius = parseFloat(req.query.radius) || 1000;
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: 'lat and lng are required' });
  try {
    const lots = await db.getLotsNearby({ lat, lng, radius, limit });
    res.json({ lots, count: lots.length, radius_meters: radius });
  } catch (err) {
    console.error('GET /lots/nearby error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/lots/search
router.get('/search', async (req, res) => {
  const { q, lat, lng } = req.query;
  if (!q || q.trim().length < 1) return res.status(400).json({ error: 'q parameter required' });
  try {
    const lots = await db.searchLots({ q: q.trim(), lat: lat ? parseFloat(lat) : null, lng: lng ? parseFloat(lng) : null });
    res.json({ lots, count: lots.length });
  } catch (err) {
    console.error('GET /lots/search error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/lots/frequent
router.get('/frequent', async (req, res) => {
  const { device_id } = req.query;
  if (!device_id) return res.status(400).json({ error: 'device_id required' });
  try {
    const lots = await db.getFrequentLots(device_id);
    res.json({ lots, count: lots.length });
  } catch (err) {
    console.error('GET /lots/frequent error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/lots/:id - parameterized routes AFTER all named routes
router.get('/:id', async (req, res) => {
  try {
    const lot = await db.getLotById(req.params.id);
    if (!lot) return res.status(404).json({ error: 'Lot not found' });
    res.json(lot);
  } catch (err) {
    console.error('GET /lots/:id error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/lots/:id/rows
router.get('/:id/rows', async (req, res) => {
  try {
    const rows = await db.getLotRows(req.params.id);
    res.json({ rows, count: rows.length });
  } catch (err) {
    console.error('GET /lots/:id/rows error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/lots/:id/forecast
router.get('/:id/forecast', async (req, res) => {
  const hours = Math.min(parseInt(req.query.hours) || 6, 168);
  try {
    const forecast = await db.getLotForecast(req.params.id, hours);
    res.json({ forecast, lot_id: req.params.id });
  } catch (err) {
    console.error('GET /lots/:id/forecast error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/lots/:id/satellite
router.get('/:id/satellite', async (req, res) => {
  const provider = req.query.provider || 'live';
  try {
    const info = await db.getSatelliteInfo(req.params.id, provider);
    if (!info) return res.status(404).json({ error: 'Lot not found' });
    res.json(info);
  } catch (err) {
    console.error('GET /lots/:id/satellite error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function fetchOsmParkingNear(lat, lng, radiusM) {
  const query = `[out:json][timeout:15];(way["amenity"="parking"](around:${radiusM},${lat},${lng});relation["amenity"="parking"](around:${radiusM},${lat},${lng}););out body;>;out skel qt;`;
  try {
    const resp = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
    });
    const data = await resp.json();
    const nodeMap = {};
    for (const el of data.elements || []) { if (el.type === 'node') nodeMap[el.id] = el; }
    const lots = [];
    for (const el of data.elements || []) {
      if (el.type !== 'way') continue;
      const coords = (el.nodes || []).map(nid => nodeMap[nid]).filter(Boolean);
      if (coords.length < 3) continue;
      const lats = coords.map(c => c.lat), lngs = coords.map(c => c.lon);
      lots.push({
        osm_id: el.id, name: el.tags?.name || null,
        lat: lats.reduce((a,b)=>a+b,0)/lats.length, lng: lngs.reduce((a,b)=>a+b,0)/lngs.length,
        bbox_north: Math.max(...lats), bbox_south: Math.min(...lats),
        bbox_east: Math.max(...lngs), bbox_west: Math.min(...lngs),
        geometry_wkt: `POLYGON((${coords.map(c=>`${c.lon} ${c.lat}`).join(' ')}))`,
      });
    }
    return lots;
  } catch (e) { console.error('OSM Overpass error:', e.message); return []; }
}

module.exports = router;
