const express = require('express');
const router = express.Router();
const db = require('../db/queries');
const pool = require('../db/pool');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const MODAL_DETECT_URL = process.env.MODAL_DETECT_URL;
const CACHE_TTL_HOURS = 168; // 7 days — lot layouts and Mapbox imagery don't change in hours

// In-flight deduplication: if two requests arrive for the same lot before the
// cache is populated, only one Modal call is made. All concurrent callers await
// the same promise and receive the same result.
const inFlightDetections = new Map();

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

// ── Track 3: Polygon union + zone partitioning helpers ────────────────────

// Institutional Place types get a wider union radius (300m) so that fragmented
// campus lots (schools, hospitals) are captured in full.  Commercial lots use
// 200m to avoid pulling in neighbouring business parking.
const INSTITUTIONAL_TYPES = new Set([
  'school', 'university', 'hospital', 'airport', 'stadium', 'college', 'library',
]);

function unionRadiusForPlaceType(placeType) {
  if (!placeType) return 400;
  const t = placeType.toLowerCase();
  for (const inst of INSTITUTIONAL_TYPES) { if (t.includes(inst)) return 600; }
  return 400;
}

// Bounding box of the union of all OSM way bboxes.
function computeUnionBbox(osmLots) {
  return {
    bbox_north: Math.max(...osmLots.map(l => l.bbox_north)),
    bbox_south: Math.min(...osmLots.map(l => l.bbox_south)),
    bbox_east:  Math.max(...osmLots.map(l => l.bbox_east)),
    bbox_west:  Math.min(...osmLots.map(l => l.bbox_west)),
  };
}

// Build a MULTIPOLYGON WKT from multiple individual POLYGON WKTs.
// Modal only uses the bbox rectangle, but we store the actual shapes for reference.
function buildMultiPolygonWkt(osmLots) {
  if (osmLots.length === 0) return null;
  if (osmLots.length === 1) return osmLots[0].geometry_wkt;
  const rings = osmLots.map(l => {
    const m = (l.geometry_wkt || '').match(/^POLYGON\s*\(\((.+)\)\)$/i);
    return m ? `((${m[1]}))` : null;
  }).filter(Boolean);
  if (rings.length === 0) return null;
  if (rings.length === 1) return `POLYGON(${rings[0]})`;
  return `MULTIPOLYGON(${rings.join(',')})`;
}

// Return the single OSM name if every unioned way agrees on it; otherwise null.
function resolveOsmCommonName(osmLots) {
  const names = [...new Set(osmLots.map(l => l.name).filter(Boolean))];
  return names.length === 1 ? names[0] : null;
}

// Partition a flat spaces array into K spatial zones ranked by distance from
// the anchor point (Place pin).  Uses percentile-distance bands so every zone
// gets an equal share of stripes — no degenerate 1-1-28 clusters.
// K=3 (Front/Middle/Back) for < 80 stripes; K=4 (Front/Near/Far/Back) for ≥ 80.
function computeZones(spaces, anchorLat, anchorLng) {
  if (!spaces || spaces.length === 0) return [];

  const ZONE_NAMES = {
    3: ['Front', 'Middle', 'Back'],
    4: ['Front', 'Near',   'Far',  'Back'],
  };

  const withCoords = spaces.filter(s => s.lat != null && s.lng != null);

  // If Modal didn't return coordinates, produce positional zones (graceful
  // degradation — each zone still gets a real stripe count, just no centroid).
  if (withCoords.length === 0) {
    const K = spaces.length < 80 ? 3 : 4;
    const names = ZONE_NAMES[K];
    const size = Math.ceil(spaces.length / K);
    return Array.from({ length: K }, (_, i) => {
      const slice = spaces.slice(i * size, (i + 1) * size);
      return {
        name: names[i],
        stripe_count: slice.length,
        open_count: slice.filter(s => !s.occupied).length,
        confidence: null,
        centroid_lat: anchorLat,
        centroid_lng: anchorLng,
      };
    }).filter(z => z.stripe_count > 0);
  }

  // Sort by distance from anchor, ascending (nearest = Front).
  const sorted = withCoords
    .map(s => ({ ...s, _dist: haversineMeters(anchorLat, anchorLng, s.lat, s.lng) }))
    .sort((a, b) => a._dist - b._dist);

  const K = sorted.length < 80 ? 3 : 4;
  const names = ZONE_NAMES[K];
  const size = Math.ceil(sorted.length / K);

  return Array.from({ length: K }, (_, i) => {
    const slice = sorted.slice(i * size, Math.min((i + 1) * size, sorted.length));
    if (slice.length === 0) return null;
    const centLat = slice.reduce((acc, s) => acc + s.lat, 0) / slice.length;
    const centLng = slice.reduce((acc, s) => acc + s.lng, 0) / slice.length;
    const avgConf  = slice.reduce((acc, s) => acc + (s.confidence || 0), 0) / slice.length;
    return {
      name: names[i],
      stripe_count: slice.length,
      open_count: slice.filter(s => !s.occupied).length,
      confidence: Math.round(avgConf * 1000) / 1000,
      centroid_lat: Math.round(centLat * 1e6) / 1e6,
      centroid_lng: Math.round(centLng * 1e6) / 1e6,
    };
  }).filter(Boolean);
}

// Three-step upsert for a Place-pin search:
//   1. Look up by google_place_id (re-search of a known place)
//   2. Look up by proximity within 150m (promotes pre-Track-3 rows, e.g. SWHS)
//   3. INSERT new union lot
// Returns the full lot row ready for getOrDetect().
async function upsertUnionLot({ lat, lng, placeName, googlePlaceId, placeType }) {
  const unionRadius = unionRadiusForPlaceType(placeType);
  // Union path: don't filter access=private — institutional lots (schools, hospitals)
  // are often tagged private in OSM even though they're accessible to visitors.
  const osmLots = await fetchOsmParkingNear(lat, lng, unionRadius, false);

  // Name: place_name always wins over OSM tag.
  const resolvedName = placeName || resolveOsmCommonName(osmLots) || null;

  // Geometry: union bbox drives what Modal images; WKT is stored for reference.
  const bbox         = osmLots.length > 0 ? computeUnionBbox(osmLots) : null;
  const geometryWkt  = osmLots.length > 0 ? buildMultiPolygonWkt(osmLots) : null;
  const sourceOsmIds = osmLots.map(l => l.osm_id);

  // ── Step 1: find by google_place_id ────────────────────────────────────────
  let existingRow = null;
  const byPlaceId = await pool.query(
    'SELECT id, source_osm_ids FROM lots WHERE google_place_id=$1',
    [googlePlaceId],
  );
  if (byPlaceId.rows[0]) existingRow = byPlaceId.rows[0];

  // ── Step 2: find by proximity (handles pre-Track-3 rows, e.g. SWHS) ───────
  if (!existingRow) {
    const distExpr = HAVERSINE_SQL(lat, lng);
    const byProximity = await pool.query(
      `SELECT id, source_osm_ids FROM lots l
       WHERE ${distExpr} < 150 AND l.google_place_id IS NULL
       ORDER BY (${distExpr}) ASC LIMIT 1`,
    );
    if (byProximity.rows[0]) existingRow = byProximity.rows[0];
  }

  // Detect geometry change so we know whether to invalidate the detection cache.
  const newKey = [...sourceOsmIds].sort().join(',');
  const oldKey = ((existingRow?.source_osm_ids) || []).sort().join(',');
  const geometryChanged = osmLots.length > 0 && newKey !== oldKey;

  if (existingRow) {
    // ── UPDATE existing row ──────────────────────────────────────────────────
    // Always apply: name (place_name wins), place anchor, place_id.
    // Apply geometry only when we have fresh OSM data.
    if (bbox) {
      await pool.query(`
        UPDATE lots SET
          name             = $1,
          google_place_id  = $2,
          place_lat        = $3,
          place_lng        = $4,
          lat              = $3,
          lng              = $4,
          bbox_north       = $5,
          bbox_south       = $6,
          bbox_east        = $7,
          bbox_west        = $8,
          geometry_wkt     = $9,
          source_osm_ids   = $10,
          spot_detection_status = CASE WHEN $11 THEN 'pending'
                                       ELSE spot_detection_status END,
          updated_at       = NOW()
        WHERE id = $12
      `, [resolvedName, googlePlaceId, lat, lng,
          bbox.bbox_north, bbox.bbox_south, bbox.bbox_east, bbox.bbox_west,
          geometryWkt, JSON.stringify(sourceOsmIds),
          geometryChanged, existingRow.id]);
    } else {
      // Overpass unavailable — update name and place anchor only, keep geometry.
      await pool.query(`
        UPDATE lots SET
          name            = $1,
          google_place_id = $2,
          place_lat       = $3,
          place_lng       = $4,
          updated_at      = NOW()
        WHERE id = $5
      `, [resolvedName, googlePlaceId, lat, lng, existingRow.id]);
    }

    if (geometryChanged) {
      await pool.query('DELETE FROM lot_detections WHERE lot_id=$1', [existingRow.id]);
    }

    const upd = await pool.query(
      `SELECT id, lat, lng, name, lot_type, spot_detection_status,
              bbox_north, bbox_south, bbox_east, bbox_west, place_lat, place_lng
       FROM lots WHERE id=$1`,
      [existingRow.id],
    );
    return upd.rows[0] || null;
  }

  // ── Step 3: INSERT new union lot ───────────────────────────────────────────
  // Use NULL for osm_id (union lots don't have a single canonical way).
  // ON CONFLICT (google_place_id) is a safety net for concurrent requests.
  if (!bbox) {
    // No OSM data and no existing lot — nothing to return.
    return null;
  }

  const ins = await pool.query(`
    INSERT INTO lots
      (name, lot_type, lat, lng,
       bbox_north, bbox_south, bbox_east, bbox_west, geometry_wkt,
       region, spot_detection_status, source,
       google_place_id, source_osm_ids, place_lat, place_lng)
    VALUES
      ($1,'surface',$2,$3,$4,$5,$6,$7,$8,'long_tail','pending','osm',$9,$10,$11,$12)
    ON CONFLICT (google_place_id) DO UPDATE SET
      name            = EXCLUDED.name,
      lat             = EXCLUDED.lat,
      lng             = EXCLUDED.lng,
      bbox_north      = EXCLUDED.bbox_north,
      bbox_south      = EXCLUDED.bbox_south,
      bbox_east       = EXCLUDED.bbox_east,
      bbox_west       = EXCLUDED.bbox_west,
      geometry_wkt    = EXCLUDED.geometry_wkt,
      source_osm_ids  = EXCLUDED.source_osm_ids,
      place_lat       = EXCLUDED.place_lat,
      place_lng       = EXCLUDED.place_lng,
      spot_detection_status = 'pending',
      updated_at      = NOW()
    RETURNING id
  `, [resolvedName, lat, lng,
      bbox.bbox_north, bbox.bbox_south, bbox.bbox_east, bbox.bbox_west,
      geometryWkt, googlePlaceId, JSON.stringify(sourceOsmIds), lat, lng]);

  const newId = ins.rows[0]?.id;
  if (!newId) return null;

  const sel = await pool.query(
    `SELECT id, lat, lng, name, lot_type, spot_detection_status,
            bbox_north, bbox_south, bbox_east, bbox_west, place_lat, place_lng
     FROM lots WHERE id=$1`,
    [newId],
  );
  return sel.rows[0] || null;
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

  // 2. Cache miss — call Modal, but coalesce concurrent requests for the same lot.
  if (inFlightDetections.has(lot.id)) {
    return inFlightDetections.get(lot.id);
  }

  const detection = (async () => {
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
    } finally {
      inFlightDetections.delete(lot.id);
    }
  })();

  inFlightDetections.set(lot.id, detection);
  return detection;
}

// ── Routes ─────────────────────────────────────────────────────────────────

// GET /api/lots/near — BEFORE /:id
router.get('/near', async (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: 'lat and lng are required' });

  // radius: default 800m for place-pin searches, max 2000m, min 50m
  const radius = Math.min(Math.max(parseFloat(req.query.radius) || 800, 50), 2000);
  // place_name: display name from Places autocomplete — used as lot name when OSM has no tag
  const placeName = typeof req.query.place_name === 'string' ? req.query.place_name.trim() || null : null;
  // place_id / place_type: present when user tapped a Places autocomplete result (Track 3+)
  const googlePlaceId = typeof req.query.place_id === 'string' ? req.query.place_id.trim() || null : null;
  const placeType     = typeof req.query.place_type === 'string' ? req.query.place_type.trim() || null : null;

  try {
    // ── Place-pin mode (Track 3) ─────────────────────────────────────────────
    // Triggered when the caller supplies a Google Place ID — i.e. the user tapped
    // a specific Places autocomplete result rather than browsing GPS-nearby lots.
    // All union / name-resolution / zone logic lives in upsertUnionLot().
    if (googlePlaceId) {
      const lot = await upsertUnionLot({ lat, lng, placeName, googlePlaceId, placeType });
      if (!lot) return res.json({ lots: [], count: 0, source: 'no_osm_data' });
      const detection = await getOrDetect(lot);
      return res.json({ lots: [{ ...lot, ...detection }], count: 1, source: 'place_pin' });
    }

    // ── GPS mode (unchanged from Track 2) ───────────────────────────────────
    const distance = HAVERSINE_SQL(lat, lng);

    // 1. Find existing lots within radius
    let dbResult = await pool.query(`
      SELECT l.id, l.name, l.lot_type, l.address, l.city, l.state,
             l.lat, l.lng, l.total_spaces, l.region, l.spot_detection_status,
             l.bbox_north, l.bbox_south, l.bbox_east, l.bbox_west,
             ${distance} AS distance_meters
      FROM lots l
      WHERE l.lat IS NOT NULL AND l.lng IS NOT NULL
        AND ${distance} <= ${radius}
      ORDER BY distance_meters ASC
      LIMIT 10
    `);

    // 2. No lots in DB — fetch from OSM on demand
    if (dbResult.rows.length === 0) {
      console.log(`No lots within ${radius}m of ${lat},${lng} — querying OSM`);
      const osmLots = await fetchOsmParkingNear(lat, lng, radius);

      for (const lot of osmLots) {
        // Name fallback: place_name from Places autocomplete → OSM tag → null
        const lotName = lot.name || placeName || null;
        await pool.query(`
          INSERT INTO lots (osm_id, name, lot_type, lat, lng,
            bbox_north, bbox_south, bbox_east, bbox_west, geometry_wkt, region, spot_detection_status, source)
          VALUES ($1,$2,'surface',$3,$4,$5,$6,$7,$8,$9,'long_tail','pending','osm')
          ON CONFLICT (osm_id) DO UPDATE SET name = EXCLUDED.name WHERE lots.name IS NULL
        `, [lot.osm_id, lotName, lot.lat, lot.lng,
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
          AND ${distance} <= ${radius}
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
      `SELECT id, lat, lng, bbox_north, bbox_south, bbox_east, bbox_west,
              name, lot_type, spot_detection_status, place_lat, place_lng
       FROM lots WHERE id=$1`,
      [req.params.id],
    );
    if (!lotRes.rows[0]) return res.status(404).json({ error: 'Lot not found' });
    const lot = lotRes.rows[0];

    const detection = await getOrDetect(lot);
    const spaces = detection.spaces || [];

    // ── Legacy row grouping (kept for backward compatibility with mobile < Gate C) ──
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

    // ── Spatial zones (Track 3) ───────────────────────────────────────────────
    // Anchor: place_lat/place_lng if this lot was created via a Place-pin search;
    // fall back to lot centroid for GPS-mode lots.
    const anchorLat = lot.place_lat || lot.lat;
    const anchorLng = lot.place_lng || lot.lng;
    const zones = computeZones(spaces, anchorLat, anchorLng);

    res.json({
      rows,
      zones,
      zone_count: zones.length,
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

async function fetchOsmParkingNear(lat, lng, radiusM, filterPrivate = true) {
  const query = `[out:json][timeout:15];(way["amenity"="parking"](around:${radiusM},${lat},${lng});relation["amenity"="parking"](around:${radiusM},${lat},${lng}););out body;>;out skel qt;`;
  try {
    const resp = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Spottr/1.0 (parking availability app; github.com/spottr)',
      },
      body: `data=${encodeURIComponent(query)}`,
    });
    const data = await resp.json();
    const wayCount = (data.elements || []).filter(e => e.type === 'way').length;
    console.log(`[Overpass] ${wayCount} way(s) returned for (${lat},${lng}) r=${radiusM}m`);
    const nodeMap = {};
    for (const el of data.elements || []) { if (el.type === 'node') nodeMap[el.id] = el; }
    const lots = [];
    for (const el of data.elements || []) {
      if (el.type !== 'way') continue;
      // In GPS mode, skip privately-gated lots (filterPrivate=true).
      // In union mode (place-pin), include them: institutional lots like schools
      // and hospitals are often tagged access=private in OSM even though
      // they're accessible during open hours.
      if (filterPrivate && el.tags?.access === 'private') continue;
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
