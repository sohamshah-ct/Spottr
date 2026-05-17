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
  if (!placeType) return 200;
  const t = placeType.toLowerCase();
  for (const inst of INSTITUTIONAL_TYPES) { if (t.includes(inst)) return 300; }
  return 200;
}

// Minimum union bbox area we'll accept before flagging low_osm_coverage: ~80m × 80m.
const BBOX_FLOOR_DEG2 = (80 / 111320) ** 2;

function bboxAreaDeg2({ bbox_north, bbox_south, bbox_east, bbox_west }) {
  return (bbox_north - bbox_south) * (bbox_east - bbox_west);
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

// ── Track 4: Building / landuse-anchored OSM coverage fallback ────────────

// Per-type minimum bbox area (in deg²) below which the inferred-bbox fallback
// fires.  Large-lot Place types (warehouse stores, hospitals) have higher bars
// because a 6,400m² union result is clearly wrong for those contexts.
// Kept in the same deg² unit as BBOX_FLOOR_DEG2 / bboxAreaDeg2() for consistency.
function bboxFloorDeg2ForPlaceType(placeType) {
  const t = (placeType || '').toLowerCase();
  if (t.includes('university') || t.includes('college'))  return (200 / 111320) ** 2; // 40,000 m²
  if (t.includes('hospital'))                              return (150 / 111320) ** 2; // 22,500 m²
  if (t.includes('school'))                               return (100 / 111320) ** 2; // 10,000 m²
  if (t.includes('warehouse_store'))                      return (150 / 111320) ** 2; // 22,500 m²
  if (t.includes('department_store') || t.includes('shopping_mall')) return (120 / 111320) ** 2; // 14,400 m²
  return BBOX_FLOOR_DEG2; // 6,400 m² global default
}

// Buffer added to the anchor building's bbox to produce the inferred parking bbox
// (Strategy A, commercial types).  Parking typically surrounds the building on
// 3 sides; 80–130m covers most big-box lot depths.
function buildingBufferMeters(placeType) {
  const t = (placeType || '').toLowerCase();
  if (t.includes('warehouse_store'))                       return 130;
  if (t.includes('department_store') || t.includes('shopping_mall')) return 100;
  return 80; // grocery_store, supermarket, default commercial
}

// Max bbox area caps (deg²) — prevents imaging a 2km² area when OSM has an
// oversized building or landuse polygon.
const MAX_INFERRED_DEG2_COMMERCIAL    = (400 / 111320) ** 2; // 160,000 m²
const MAX_INFERRED_DEG2_INSTITUTIONAL = (500 / 111320) ** 2; // 250,000 m²

// Shrink bbox symmetrically toward anchorLat/Lng until area ≤ maxAreaDeg2.
function clampBboxToArea(bbox, maxAreaDeg2, anchorLat, anchorLng) {
  const areaH = bbox.bbox_north - bbox.bbox_south;
  const areaW = bbox.bbox_east  - bbox.bbox_west;
  if (areaH * areaW <= maxAreaDeg2) return bbox;
  const scale  = Math.sqrt(maxAreaDeg2 / (areaH * areaW));
  const newH   = areaH * scale;
  const newW   = areaW * scale;
  console.log(`[inferred-bbox] bbox clamped: ${(areaH*111320).toFixed(0)}x${(areaW*111320*Math.cos(anchorLat*Math.PI/180)).toFixed(0)}m → ${(newH*111320).toFixed(0)}x${(newW*111320*Math.cos(anchorLat*Math.PI/180)).toFixed(0)}m`);
  return {
    bbox_north: anchorLat  + newH / 2,
    bbox_south: anchorLat  - newH / 2,
    bbox_east:  anchorLng  + newW / 2,
    bbox_west:  anchorLng  - newW / 2,
  };
}

// Strategy A — building-anchored inference (commercial primary, institutional fallback).
//
// Selection and centering rules (three cases):
//
//   warehouse_store:  Search radius 500m (Places pin lands at lot entrance, 300-400m
//                     from the actual warehouse building — empirically verified for
//                     Costco South Windsor: DB pin is 345m from the building).
//                     Select LARGEST building ≥ 5,000m² (filters entrance kiosks).
//                     Bbox centered on BUILDING CENTROID (pin is outside parking area).
//
//   other commercial: Search radius 250m.  Nearest building, name-match priority.
//   (dept_store,      Bbox centered on PLACE PIN (pin and building are close —
//    grocery, mall)   confirmed: Target pin is 11m from building).
//
//   institutional:    Search radius 300m.  Largest building by footprint (correct for
//                     multi-building campuses — SWHS nearest is 68×10m breezeway at
//                     94m; main building is 116×89m at 240m).
//                     Bbox centered on PLACE PIN via Strategy B landuse polygon
//                     (Strategy A is institutional fallback only).
async function tryStrategyA(lat, lng, placeType, placeName, isInstitutional) {
  const isWarehouseStore = (placeType || '').toLowerCase().includes('warehouse_store');

  // Search radius: warehouse stores need wider net — Places pin is at lot entrance.
  const searchRadius = isInstitutional ? 300 : (isWarehouseStore ? 500 : 250);
  const query = `[out:json][timeout:15];way["building"](around:${searchRadius},${lat},${lng});out body;>;out skel qt;`;
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
    const nodes = {};
    for (const el of data.elements || []) { if (el.type === 'node') nodes[el.id] = el; }

    // Exclude clearly domestic/residential building tags.
    const EXCLUDE_BUILDING = new Set(['residential', 'house', 'apartments', 'detached', 'semi', 'terrace', 'cabin', 'bungalow']);
    const candidates = (data.elements || [])
      .filter(e => e.type === 'way' && !EXCLUDE_BUILDING.has(e.tags?.building))
      .map(w => {
        const coords = (w.nodes || []).map(id => nodes[id]).filter(Boolean);
        if (coords.length < 3) return null;
        const lats = coords.map(c => c.lat), lngs = coords.map(c => c.lon);
        const N = Math.max(...lats), S = Math.min(...lats);
        const E = Math.max(...lngs), W = Math.min(...lngs);
        const hM = (N - S) * 111320;
        const wM = (E - W) * 111320 * Math.cos(lat * Math.PI / 180);
        const areaM2 = hM * wM;
        const cLat = lats.reduce((a, b) => a + b, 0) / lats.length;
        const cLng = lngs.reduce((a, b) => a + b, 0) / lngs.length;
        const dist = haversineMeters(lat, lng, cLat, cLng);
        // Name match: first token of placeName (e.g. "Costco" from "Costco Wholesale")
        const firstToken = (placeName || '').toLowerCase().split(/\s+/)[0];
        const nameMatch = firstToken.length > 2 && (w.tags?.name || '').toLowerCase().includes(firstToken);
        return { w, N, S, E, W, hM, wM, areaM2, dist, cLat, cLng, nameMatch };
      })
      .filter(Boolean);

    if (candidates.length === 0) {
      console.log(`[inferred-bbox] strategy-A: no non-residential buildings within ${searchRadius}m`);
      return null;
    }

    // Select anchor building per type-specific rule.
    let anchor;
    if (isInstitutional) {
      // Institutional: largest footprint (correct for multi-building campuses).
      anchor = candidates.sort((a, b) => b.areaM2 - a.areaM2)[0];
    } else if (isWarehouseStore) {
      // Warehouse stores: largest building above 5,000m² floor.
      // Filters out entrance kiosks (≪1,000m²) in favour of the warehouse itself.
      const large = candidates.filter(b => b.areaM2 >= 5000);
      anchor = (large.length > 0 ? large : candidates).sort((a, b) => b.areaM2 - a.areaM2)[0];
    } else {
      // Other commercial: name-match candidates first, then nearest.
      const nameMatches = candidates.filter(b => b.nameMatch);
      anchor = nameMatches.length > 0
        ? nameMatches.sort((a, b) => a.dist - b.dist)[0]
        : candidates.sort((a, b) => a.dist - b.dist)[0];
    }

    const bufM    = buildingBufferMeters(placeType);
    const bufLat  = bufM / 111320;
    const bufLng  = bufM / (111320 * Math.cos(lat * Math.PI / 180));
    let bbox = {
      bbox_north: anchor.N + bufLat,
      bbox_south: anchor.S - bufLat,
      bbox_east:  anchor.E + bufLng,
      bbox_west:  anchor.W - bufLng,
    };

    // Pin containment assertion — applies to other-commercial and institutional only.
    // warehouse_store is exempt: the Place pin is intentionally outside the bbox
    // (it sits at the lot entrance while the bbox is centred on the warehouse building).
    if (!isWarehouseStore) {
      if (lat < bbox.bbox_south || lat > bbox.bbox_north ||
          lng < bbox.bbox_west  || lng > bbox.bbox_east) {
        console.log(`[inferred-bbox] strategy-A: pin (${lat},${lng}) outside inferred bbox — anchor too far, skipping`);
        return null;
      }
    }

    // Centering rules for clampBboxToArea:
    //   warehouse_store  → building centroid (Places pin is at lot entrance, not lot centre)
    //   other commercial → Place pin (pin and building are close)
    //   institutional    → Place pin (Strategy A is fallback; Strategy B uses polygon centroid)
    const clampLat = isWarehouseStore ? anchor.cLat : lat;
    const clampLng = isWarehouseStore ? anchor.cLng : lng;

    const maxArea = isInstitutional ? MAX_INFERRED_DEG2_INSTITUTIONAL : MAX_INFERRED_DEG2_COMMERCIAL;
    bbox = clampBboxToArea(bbox, maxArea, clampLat, clampLng);

    console.log(`[inferred-bbox] strategy-A OK: way${anchor.w.id} "${anchor.w.tags?.name || ''}" ${anchor.hM.toFixed(0)}x${anchor.wM.toFixed(0)}m +${bufM}m → ${((bbox.bbox_north - bbox.bbox_south) * 111320).toFixed(0)}x${((bbox.bbox_east - bbox.bbox_west) * 111320 * Math.cos(lat * Math.PI / 180)).toFixed(0)}m (centred on ${isWarehouseStore ? 'building' : 'pin'})`);
    return { bbox, bboxSource: 'building_inferred' };
  } catch (e) {
    console.error('[inferred-bbox] strategy-A error:', e.message);
    return null;
  }
}

// Strategy B — landuse-anchored inference (institutional primary, commercial fallback).
// Finds the relevant landuse polygon containing the Place pin and uses its bbox
// as the candidate parking area.  Note: landuse=hospital has 0 ways in all of CT
// (empirically verified 2026-05-17) — Strategy B will silently fail for hospital
// types and fall through to Strategy A.
async function tryStrategyB(lat, lng, placeType) {
  const t = (placeType || '').toLowerCase();
  let targetValues;
  if (t.includes('school') || t.includes('university') || t.includes('college')) {
    targetValues = ['education'];
  } else if (t.includes('hospital')) {
    targetValues = ['hospital'];
  } else if (t.includes('store') || t.includes('mall') || t.includes('retail')) {
    targetValues = ['retail', 'commercial'];
  } else {
    return null; // no landuse type mapped for this Place type
  }

  const query = `[out:json][timeout:15];way["landuse"](around:600,${lat},${lng});out body;>;out skel qt;`;
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
    const nodes = {};
    for (const el of data.elements || []) { if (el.type === 'node') nodes[el.id] = el; }

    const polygons = (data.elements || [])
      .filter(e => e.type === 'way' && targetValues.includes(e.tags?.landuse))
      .map(w => {
        const coords = (w.nodes || []).map(id => nodes[id]).filter(Boolean);
        if (coords.length < 3) return null;
        const lats = coords.map(c => c.lat), lngs = coords.map(c => c.lon);
        const N = Math.max(...lats), S = Math.min(...lats);
        const E = Math.max(...lngs), W = Math.min(...lngs);
        const hM = (N - S) * 111320;
        const wM = (E - W) * 111320 * Math.cos(lat * Math.PI / 180);
        const areaM2 = hM * wM;
        const pinInside = lat >= S && lat <= N && lng >= W && lng <= E;
        const cLat = lats.reduce((a, b) => a + b, 0) / lats.length;
        const cLng = lngs.reduce((a, b) => a + b, 0) / lngs.length;
        return { w, N, S, E, W, hM, wM, areaM2, pinInside, cLat, cLng };
      })
      .filter(Boolean);

    if (polygons.length === 0) {
      console.log(`[inferred-bbox] strategy-B: no landuse=${targetValues.join('/')} within 600m`);
      return null;
    }

    // Prefer smallest containing polygon (most specific scope).
    // Fall back to nearest by centroid when no polygon contains the pin.
    const containing = polygons.filter(p => p.pinInside).sort((a, b) => a.areaM2 - b.areaM2);
    const candidate  = containing.length > 0
      ? containing[0]
      : polygons.sort((a, b) => haversineMeters(lat, lng, a.cLat, a.cLng) - haversineMeters(lat, lng, b.cLat, b.cLng))[0];

    const margin    = 20 / 111320;
    const marginLng = 20 / (111320 * Math.cos(lat * Math.PI / 180));
    let bbox = {
      bbox_north: candidate.N + margin,
      bbox_south: candidate.S - margin,
      bbox_east:  candidate.E + marginLng,
      bbox_west:  candidate.W - marginLng,
    };

    // Pin containment assertion.
    if (lat < bbox.bbox_south || lat > bbox.bbox_north ||
        lng < bbox.bbox_west  || lng > bbox.bbox_east) {
      console.log(`[inferred-bbox] strategy-B: pin outside landuse polygon bbox — skipping`);
      return null;
    }

    bbox = clampBboxToArea(bbox, MAX_INFERRED_DEG2_INSTITUTIONAL, lat, lng);

    console.log(`[inferred-bbox] strategy-B OK: landuse=${candidate.w.tags?.landuse} way${candidate.w.id} ${candidate.hM.toFixed(0)}x${candidate.wM.toFixed(0)}m → ${((bbox.bbox_north - bbox.bbox_south) * 111320).toFixed(0)}x${((bbox.bbox_east - bbox.bbox_west) * 111320 * Math.cos(lat * Math.PI / 180)).toFixed(0)}m`);
    return { bbox, bboxSource: 'landuse_inferred' };
  } catch (e) {
    console.error('[inferred-bbox] strategy-B error:', e.message);
    return null;
  }
}

// Top-level fallback dispatcher.
// Commercial types: Strategy A → B.  Institutional types: B → A.
async function fetchInferredBbox(lat, lng, placeType, placeName) {
  const isInstitutional = placeType
    ? [...INSTITUTIONAL_TYPES].some(t => placeType.toLowerCase().includes(t))
    : false;
  const strategies = isInstitutional ? ['B', 'A'] : ['A', 'B'];
  for (const s of strategies) {
    const result = s === 'A'
      ? await tryStrategyA(lat, lng, placeType, placeName, isInstitutional)
      : await tryStrategyB(lat, lng, placeType);
    if (result) return result;
    console.log(`[inferred-bbox] strategy-${s} failed — trying next`);
  }
  console.log(`[inferred-bbox] both strategies failed for placeType=${placeType}`);
  return null;
}

// Three-step upsert for a Place-pin search:
//   1. Look up by google_place_id (re-search of a known place)
//   2. Look up by proximity within 150m (promotes pre-Track-3 rows, e.g. SWHS)
//   3. INSERT new union lot
// Returns the full lot row ready for getOrDetect().
async function upsertUnionLot({ lat, lng, placeName, googlePlaceId, placeType }) {
  const unionRadius = unionRadiusForPlaceType(placeType);
  // Institutional lots (schools, hospitals, etc.) often tag their ways access=private
  // in OSM even though they're accessible to visitors — include them.
  // Commercial lots (supermarkets, big-box) should keep the private filter so we
  // don't accidentally absorb adjacent restricted lots.
  const isInstitutional = placeType
    ? [...INSTITUTIONAL_TYPES].some(t => placeType.toLowerCase().includes(t))
    : false;
  const allOsmLots = await fetchOsmParkingNear(lat, lng, unionRadius, !isInstitutional);

  // Limit union to the MAX_UNION_WAYS ways whose centroids are closest to the
  // place pin. This prevents over-union at densely-mapped sites (e.g. hospitals
  // where every parking row is a separate OSM way) while still merging multi-
  // section lots like SWHS (2 sections both within ~250m of the school centroid).
  const MAX_UNION_WAYS = 8;
  const osmLots = allOsmLots
    .map(l => ({ ...l, _d: Math.hypot(l.lat - lat, l.lng - lng) }))
    .sort((a, b) => a._d - b._d)
    .slice(0, MAX_UNION_WAYS);

  // Name: place_name always wins over OSM tag.
  const resolvedName = placeName || resolveOsmCommonName(osmLots) || null;

  // Geometry: union bbox drives what Modal images; WKT is stored for reference.
  let bbox           = osmLots.length > 0 ? computeUnionBbox(osmLots) : null;
  const geometryWkt  = osmLots.length > 0 ? buildMultiPolygonWkt(osmLots) : null;
  const sourceOsmIds = osmLots.map(l => l.osm_id);

  // ── Step 1: find by google_place_id ────────────────────────────────────────
  let existingRow = null;
  const byPlaceId = await pool.query(
    'SELECT id, source_osm_ids, bbox_north, bbox_south, bbox_east, bbox_west FROM lots WHERE google_place_id=$1',
    [googlePlaceId],
  );
  if (byPlaceId.rows[0]) existingRow = byPlaceId.rows[0];

  // ── Step 2: find by proximity (handles pre-Track-3 rows, e.g. SWHS) ───────
  if (!existingRow) {
    const distExpr = HAVERSINE_SQL(lat, lng);
    const byProximity = await pool.query(
      `SELECT id, source_osm_ids, bbox_north, bbox_south, bbox_east, bbox_west FROM lots l
       WHERE ${distExpr} < 150 AND l.google_place_id IS NULL
       ORDER BY (${distExpr}) ASC LIMIT 1`,
    );
    if (byProximity.rows[0]) existingRow = byProximity.rows[0];
  }

  // ── Bbox-area regression guard ─────────────────────────────────────────────
  // Protect existing geometry when the new union bbox is a significant regression
  // from a HEALTHY existing bbox (above the per-type floor).
  // Sub-floor existing bboxes (e.g. Costco at 45×43m) are NOT protected — the
  // Track 4 fallback path needs to be able to replace them with better coverage.
  let bboxOverridden = false;
  if (bbox && existingRow?.bbox_north != null) {
    const newArea  = bboxAreaDeg2(bbox);
    const oldArea  = bboxAreaDeg2(existingRow);
    const typeFloor = bboxFloorDeg2ForPlaceType(placeType);
    // Guard fires only when existing is healthy AND new is a meaningful regression.
    if (oldArea >= typeFloor && newArea < oldArea * 0.5) {
      console.log(`[upsertUnionLot] bbox-regression-guard: new=${(newArea * 1e10).toFixed(1)} old=${(oldArea * 1e10).toFixed(1)} — keeping existing geometry`);
      bbox = null;
      bboxOverridden = true;
    }
  }

  // Detect geometry change so we know whether to invalidate the detection cache.
  // bboxOverridden means we kept existing geometry — treat as no change so cache survives.
  const newKey = [...sourceOsmIds].sort().join(',');
  const oldKey = ((existingRow?.source_osm_ids) || []).sort().join(',');
  let geometryChanged = !bboxOverridden && osmLots.length > 0 && newKey !== oldKey;

  // ── Track 4: inferred-bbox fallback ──────────────────────────────────────────
  // Fire when OSM parking ways don't produce an adequate bbox for the Place type.
  // Two triggers: (a) no OSM ways returned → bbox is null; (b) union bbox below
  // the per-type floor (too small to be the real lot).
  // Skipped when bboxOverridden=true — existing healthy geometry is being kept.
  const typeFloor = bboxFloorDeg2ForPlaceType(placeType);
  let bboxSource = 'osm_union';

  if (!bboxOverridden) {
    const needsFallback = !bbox || bboxAreaDeg2(bbox) < typeFloor;
    if (needsFallback) {
      if (!bbox) {
        console.log(`[upsertUnionLot] no_osm_data: no parking ways returned — trying inferred-bbox fallback`);
      } else {
        console.log(`[upsertUnionLot] low_osm_coverage: area=${(bboxAreaDeg2(bbox) * 1e10).toFixed(1)} below type-floor=${(typeFloor * 1e10).toFixed(1)} — trying inferred-bbox fallback`);
      }
      const fallback = await fetchInferredBbox(lat, lng, placeType, placeName);
      if (fallback) {
        bbox          = fallback.bbox;
        bboxSource    = fallback.bboxSource;
        geometryChanged = true; // inferred bbox always invalidates the detection cache
      } else {
        bboxSource = bbox ? 'low_osm_coverage' : null;
      }
    }
  }

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
          bbox_source      = $11,
          spot_detection_status = CASE WHEN $12 THEN 'pending'
                                       ELSE spot_detection_status END,
          updated_at       = NOW()
        WHERE id = $13
      `, [resolvedName, googlePlaceId, lat, lng,
          bbox.bbox_north, bbox.bbox_south, bbox.bbox_east, bbox.bbox_west,
          geometryWkt, JSON.stringify(sourceOsmIds),
          bboxSource, geometryChanged, existingRow.id]);
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
              bbox_north, bbox_south, bbox_east, bbox_west, place_lat, place_lng, bbox_source
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
       google_place_id, source_osm_ids, place_lat, place_lng, bbox_source)
    VALUES
      ($1,'surface',$2,$3,$4,$5,$6,$7,$8,'long_tail','pending','osm',$9,$10,$11,$12,$13)
    ON CONFLICT (google_place_id) WHERE google_place_id IS NOT NULL DO UPDATE SET
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
      bbox_source     = EXCLUDED.bbox_source,
      spot_detection_status = 'pending',
      updated_at      = NOW()
    RETURNING id
  `, [resolvedName, lat, lng,
      bbox.bbox_north, bbox.bbox_south, bbox.bbox_east, bbox.bbox_west,
      geometryWkt, googlePlaceId, JSON.stringify(sourceOsmIds), lat, lng, bboxSource]);

  const newId = ins.rows[0]?.id;
  if (!newId) return null;

  const sel = await pool.query(
    `SELECT id, lat, lng, name, lot_type, spot_detection_status,
            bbox_north, bbox_south, bbox_east, bbox_west, place_lat, place_lng, bbox_source
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
              name, lot_type, spot_detection_status, place_lat, place_lng, bbox_source
       FROM lots WHERE id=$1`,
      [req.params.id],
    );
    if (!lotRes.rows[0]) return res.status(404).json({ error: 'Lot not found' });
    const lot = lotRes.rows[0];

    const detection = await getOrDetect(lot);
    const spaces = detection.spaces || [];

    // ── Row grouping: K-bucket partitioning (K=3 for <80 stripes, K=4 for ≥80) ──
    // We ignore detect.py's raw row_label (which assigns one letter per 10 stripes
    // and can produce 30+ zones) and re-bucket into at most 4 zones here.
    // This also applies to cached detections, fixing prior over-labeled results.
    const K = spaces.length < 80 ? 3 : 4;
    const rowMap = {};
    spaces.forEach((s, i) => {
      const label = String.fromCharCode(65 + Math.floor(i * K / Math.max(spaces.length, 1)));
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
  // Query only ways, not relations. Parking relations expand into their member ways
  // which inflates the result pool and creates over-sized union bboxes.
  // Multi-section lots (e.g. SWHS) are already covered by individual way geometries.
  const query = `[out:json][timeout:15];way["amenity"="parking"](around:${radiusM},${lat},${lng});out body;>;out skel qt;`;
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
