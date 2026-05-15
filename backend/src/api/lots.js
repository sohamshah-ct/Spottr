const express = require('express');
const router = express.Router();
const db = require('../db/queries');
const pool = require('../db/pool');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const MODAL_DETECT_URL = process.env.MODAL_DETECT_URL;
const CACHE_TTL_HOURS = 4;

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

// ── Modal detection helpers ────────────────────────────────────────────────

async function getCachedDetection(lotId) {
  const r = await pool.query(
    `SELECT spaces_data, detected_at, source, overall_confidence, modal_duration_ms
     FROM lot_detections
     WHERE lot_id = $1 AND expires_at > NOW()
     ORDER BY detected_at DESC LIMIT 1`,
    [lotId]
  );
  return r.rows[0] || null;
}

async function invokeModal(lot) {
  if (!MODAL_DETECT_URL) throw new Error('MODAL_DETECT_URL not configured');

  // Build GeoJSON polygon from lot geometry_wkt if available, else bounding box
  let polygon = { type: 'Polygon', coordinates: [[]] };
  if (lot.bbox_north && lot.bbox_south && lot.bbox_east && lot.bbox_west) {
    const n = lot.bbox_north, s = lot.bbox_south, e = lot.bbox_east, w = lot.bbox_west;
    polygon.coordinates = [[[w,s],[e,s],[e,n],[w,n],[w,s]]];
  }

  const t0 = Date.now();
  const resp = await fetch(MODAL_DETECT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lot_id: lot.id,
      lot_polygon_geojson: polygon,
      centroid_lat: lot.lat,
      centroid_lng: lot.lng,
    }),
    timeout: 130000,
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Modal HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }

  const result = await resp.json();
  result.duration_ms = result.duration_ms || (Date.now() - t0);
  return result;
}

async function saveDetectionCache(lot, result) {
  await pool.query(
    `INSERT INTO lot_detections
       (lot_id, spaces_data, car_detector_model, stripe_detector_model,
        overall_confidence, source, modal_duration_ms, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + INTERVAL '${CACHE_TTL_HOURS} hours')`,
    [
      lot.id,
      JSON.stringify(result.spaces || []),
      result.model_versions?.car_detector || null,
      result.model_versions?.stripe_detector || null,
      result.overall_confidence || 0,
      result.source || 'modal_error',
      result.duration_ms || null,
    ]
  );

  // Write occupancy_history for every space (the moat)
  const spaces = result.spaces || [];
  if (spaces.length > 0) {
    const rows = spaces.map(s => [
      lot.id, s.occupied || false, s.confidence || 0.4, result.source || 'modal_error',
    ]);
    const values = rows.map((_, i) => `($${i*4+1},$${i*4+2},$${i*4+3},$${i*4+4},NOW())`).join(',');
    await pool.query(
      `INSERT INTO occupancy_history (lot_id, occupied, confidence, source, captured_at) VALUES ${values}`,
      rows.flat()
    );
  }

  // Update lot status
  await pool.query(
    `UPDATE lots SET spot_detection_status='complete', last_spot_detection=NOW() WHERE id=$1`,
    [lot.id]
  );
}

async function getOrDetect(lot) {
  // 1. Check cache
  const cached = await getCachedDetection(lot.id);
  if (cached) {
    const ageSecs = Math.floor((Date.now() - new Date(cached.detected_at)) / 1000);
    return {
      spaces: cached.spaces_data,
      detection_age_seconds: ageSecs,
      source: cached.source,
      confidence: cached.overall_confidence,
      cached: true,
      modal_duration_ms: cached.modal_duration_ms,
    };
  }

  // 2. Cache miss — call Modal
  try {
    const result = await invokeModal(lot);
    await saveDetectionCache(lot, result);
    return {
      spaces: result.spaces || [],
      detection_age_seconds: 0,
      source: result.source,
      confidence: result.overall_confidence,
      cached: false,
      modal_duration_ms: result.duration_ms,
      cars_detected: result.cars_detected,
      sam2_stripes_found: result.sam2_stripes_found,
    };
  } catch (err) {
    console.error(`Modal detection failed for lot ${lot.id}:`, err.message);
    return {
      spaces: [],
      detection_age_seconds: null,
      source: 'modal_failed',
      confidence: 0,
      cached: false,
      error: 'Detection temporarily unavailable',
    };
  }
}

// ── Routes ─────────────────────────────────────────────────────────────────

// GET /api/lots/near — BEFORE /:id
router.get('/near', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: 'lat and lng are required' });

  try {
    const distance = HAVERSINE_SQL(lat, lng);

    // 1. Find existing lots within 200m
    let dbResult = await pool.query(`
      SELECT l.id, l.name, l.lot_type, l.address, l.city, l.state,
             l.lat, l.lng, l.total_spaces, l.region, l.spot_detection_status,
             l.bbox_north, l.bbox_south, l.bbox_east, l.bbox_west,
             ${distance} AS distance_meters
      FROM lots l
      WHERE l.lat IS NOT NULL AND l.lng IS NOT NULL
        AND ${distance} <= 200
      ORDER BY distance_meters ASC
      LIMIT 10
    `);

    // 2. No lots in DB — fetch from OSM on demand
    if (dbResult.rows.length === 0) {
      console.log(`No lots within 200m of ${lat},${lng} — querying OSM`);
      const osmLots = await fetchOsmParkingNear(lat, lng, 200);

      for (const lot of osmLots) {
        await pool.query(`
          INSERT INTO lots (osm_id, name, lot_type, lat, lng,
            bbox_north, bbox_south, bbox_east, bbox_west, geometry_wkt, region, spot_detection_status, source)
          VALUES ($1,$2,'surface',$3,$4,$5,$6,$7,$8,$9,'long_tail','pending','osm')
          ON CONFLICT (osm_id) DO NOTHING
        `, [lot.osm_id, lot.name, lot.lat, lot.lng,
            lot.bbox_north, lot.bbox_south, lot.bbox_east, lot.bbox_west, lot.geometry_wkt]);
      }

      // Re-query to get their IDs
      dbResult = await pool.query(`
        SELECT l.id, l.name, l.lot_type, l.address, l.city, l.state,
               l.lat, l.lng, l.total_spaces, l.region, l.spot_detection_status,
               l.bbox_north, l.bbox_south, l.bbox_east, l.bbox_west,
               ${distance} AS distance_meters
        FROM lots l
        WHERE l.lat IS NOT NULL AND l.lng IS NOT NULL
          AND ${distance} <= 200
        ORDER BY distance_meters ASC
        LIMIT 10
      `);

      if (dbResult.rows.length === 0) {
        return res.json({ lots: [], source: 'no_lots_found', count: 0 });
      }
    }

    // 3. For each lot, get detection (cached or fresh from Modal)
    const lotsWithDetections = await Promise.all(
      dbResult.rows.map(async (lot) => {
        const detection = await getOrDetect(lot);
        return { ...lot, ...detection };
      })
    );

    res.json({ lots: lotsWithDetections, count: lotsWithDetections.length });
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

// GET /api/lots/:id — parameterized AFTER named routes
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

// GET /api/lots/:id/rows — with Modal detection
router.get('/:id/rows', async (req, res) => {
  try {
    const lotRes = await pool.query(
      'SELECT id, lat, lng, bbox_north, bbox_south, bbox_east, bbox_west, name, lot_type, spot_detection_status FROM lots WHERE id=$1',
      [req.params.id]
    );
    if (!lotRes.rows[0]) return res.status(404).json({ error: 'Lot not found' });
    const lot = lotRes.rows[0];

    const detection = await getOrDetect(lot);
    const spaces = detection.spaces || [];

    // Group spaces into rows
    const rowMap = {};
    spaces.forEach((s, i) => {
      const label = s.row_label || String.fromCharCode(65 + Math.floor(i / 10));
      if (!rowMap[label]) rowMap[label] = { label, spaces: [], open: 0, total: 0 };
      rowMap[label].spaces.push(s);
      rowMap[label].total++;
      if (!s.occupied) rowMap[label].open++;
    });

    const rows = Object.values(rowMap).map(r => ({
      ...r,
      occupancy_pct: r.total > 0 ? (r.total - r.open) / r.total : null,
      confidence: detection.source,
    }));

    res.json({
      rows,
      count: rows.length,
      spaces_total: spaces.length,
      detection_age_seconds: detection.detection_age_seconds,
      source: detection.source,
      confidence: detection.confidence,
      cached: detection.cached,
      modal_duration_ms: detection.modal_duration_ms,
    });
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

// ── OSM fallback ────────────────────────────────────────────────────────────

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
