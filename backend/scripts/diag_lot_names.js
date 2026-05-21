/**
 * diag_lot_names.js — Diagnostic: audit null/generic lot names in DB
 * Run via: railway run node backend/scripts/diag_lot_names.js
 *
 * Reports:
 *   1. Count + sample of lots with NULL/generic names
 *   2. Places Nearby Search result for 5 sample lots
 */
'use strict';

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// Inline pool (avoids require path issues when run from repo root via railway run)
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const GOOGLE_PLACES_KEY = process.env.GOOGLE_PLACES_KEY || '';
const PLACES_NEARBY_URL = 'https://places.googleapis.com/v1/places:searchNearby';

async function placesNearby(lot) {
  try {
    const resp = await fetch(PLACES_NEARBY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': GOOGLE_PLACES_KEY,
        'X-Goog-FieldMask': 'places.displayName',
      },
      body: JSON.stringify({
        locationRestriction: {
          circle: {
            center: { latitude: lot.lat, longitude: lot.lng },
            radius: 50.0,
          },
        },
        excludedTypes: ['parking'],
        maxResultCount: 1,
      }),
      timeout: 5000,
    });
    const data = await resp.json();
    const place = (data.places || [])[0];
    return place?.displayName?.text ?? null;
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
}

async function main() {
  // ── Step 1: count NULL/generic names ─────────────────────────────────────
  const countRes = await pool.query(`
    SELECT COUNT(*) AS total,
           COUNT(*) FILTER (WHERE name IS NULL)                       AS null_count,
           COUNT(*) FILTER (WHERE name ILIKE 'parking lot')           AS parking_lot_count,
           COUNT(*) FILTER (WHERE name ~* '^lot [a-f0-9-]{6,}')       AS hash_count,
           COUNT(*) FILTER (WHERE name ILIKE 'parking')               AS bare_parking_count
    FROM lots
  `);
  const c = countRes.rows[0];
  console.log('\n=== Step 1: Name audit ===');
  console.log(`Total lots:           ${c.total}`);
  console.log(`  name IS NULL:       ${c.null_count}`);
  console.log(`  "Parking Lot":      ${c.parking_lot_count}`);
  console.log(`  "Parking":          ${c.bare_parking_count}`);
  console.log(`  "Lot <hash>":       ${c.hash_count}`);
  console.log(`  Generic total:      ${+c.null_count + +c.parking_lot_count + +c.bare_parking_count + +c.hash_count}`);

  // ── Step 2: sample rows ───────────────────────────────────────────────────
  const sampleRes = await pool.query(`
    SELECT id, name, lat, lng, place_lat, place_lng, city, address
    FROM lots
    WHERE name IS NULL
       OR name ILIKE 'parking lot'
       OR name ~* '^lot [a-f0-9-]{6,}'
       OR name ILIKE 'parking'
    ORDER BY id
    LIMIT 30
  `);
  console.log(`\n=== Step 2: Sample NULL/generic lots (up to 30) ===`);
  console.log(`id                                     | name             | lat        | lng         | city`);
  console.log(`---------------------------------------+------------------+------------+-------------+-----`);
  for (const r of sampleRes.rows) {
    console.log(
      `${r.id.slice(0, 8)} | ${(r.name ?? 'NULL').padEnd(16).slice(0, 16)} | ${String(r.lat).padEnd(10)} | ${String(r.lng).padEnd(11)} | ${r.city ?? ''}`
    );
  }

  // ── Step 3: Places API spot-check on first 5 sample lots ─────────────────
  console.log('\n=== Step 3: Places Nearby spot-check (first 5 lots) ===');
  if (!GOOGLE_PLACES_KEY) {
    console.log('GOOGLE_PLACES_KEY not set — skipping Places check');
  } else {
    const probe = sampleRes.rows.slice(0, 5);
    for (const lot of probe) {
      const result = await placesNearby(lot);
      console.log(`  id=${lot.id.slice(0, 8)}  lat=${lot.lat} lng=${lot.lng}  →  ${result ?? '(no result)'}`);
    }

    // Wider check: test all sample lots, count resolution rate
    console.log(`\n=== Step 3b: Resolution rate across all ${sampleRes.rows.length} sample lots ===`);
    let resolved = 0;
    for (const lot of sampleRes.rows) {
      const result = await placesNearby(lot);
      if (result && !result.startsWith('ERROR')) resolved++;
    }
    const pct = sampleRes.rows.length > 0
      ? Math.round((resolved / sampleRes.rows.length) * 100)
      : 0;
    console.log(`  Resolved: ${resolved}/${sampleRes.rows.length} (${pct}%)`);
    console.log(`  Unresolvable: ${sampleRes.rows.length - resolved}/${sampleRes.rows.length}`);
  }

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
