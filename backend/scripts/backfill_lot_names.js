/**
 * backfill_lot_names.js — One-time name resolution for all NULL/generic lots
 *
 * Usage: railway run node backend/scripts/backfill_lot_names.js
 *
 * Iterates all lots WHERE name IS NULL (or matches generic patterns),
 * calls Places Nearby Search (New API) for each, and writes results to
 * lots.name. Processes 5 lots in parallel; logs progress every 100.
 */
'use strict';

const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const GOOGLE_PLACES_KEY = process.env.GOOGLE_PLACES_KEY || '';
const PLACES_NEARBY_URL = 'https://places.googleapis.com/v1/places:searchNearby';
const CONCURRENCY        = 5;
const PLACES_TIMEOUT_MS  = 2000;

async function resolveOne(lot) {
  if (!GOOGLE_PLACES_KEY) return null;
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
      timeout: PLACES_TIMEOUT_MS,
    });
    const data = await resp.json();
    const place = (data.places || [])[0];
    if (place?.displayName?.text) return `${place.displayName.text} parking`;
  } catch (e) {
    // timeout or network error — fall through to address fallback
  }
  if (lot.address) return `Parking near ${lot.address}`;
  if (lot.city) return `Parking in ${lot.city}`;
  return null;
}

async function main() {
  if (!GOOGLE_PLACES_KEY) {
    console.error('GOOGLE_PLACES_KEY not set — aborting');
    process.exit(1);
  }

  const res = await pool.query(`
    SELECT id, lat, lng, address, city
    FROM lots
    WHERE name IS NULL
       OR name ILIKE 'parking lot'
       OR name ~* '^lot [a-f0-9-]{6,}'
       OR name ILIKE 'parking'
    ORDER BY id
  `);
  const lots = res.rows;
  console.log(`Found ${lots.length} lots with NULL/generic names. Starting backfill…`);

  let resolved = 0;
  let unresolvable = 0;
  const unresolvableIds = [];

  for (let i = 0; i < lots.length; i += CONCURRENCY) {
    const batch = lots.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (lot) => {
        const name = await resolveOne(lot);
        if (name) {
          await pool.query(
            "UPDATE lots SET name=$1 WHERE id=$2 AND (name IS NULL OR name ~* '^(parking lot|parking)$')",
            [name, lot.id],
          );
          resolved++;
        } else {
          unresolvable++;
          unresolvableIds.push(lot.id);
        }
      })
    );

    const done = Math.min(i + CONCURRENCY, lots.length);
    if (done % 100 === 0 || done === lots.length) {
      console.log(`  ${done}/${lots.length} processed — resolved: ${resolved}, unresolvable so far: ${unresolvable}`);
    }
  }

  console.log('\n=== Backfill complete ===');
  console.log(`Total:        ${lots.length}`);
  console.log(`Resolved:     ${resolved} (${Math.round(resolved / lots.length * 100)}%)`);
  console.log(`Unresolvable: ${unresolvable} (${Math.round(unresolvable / lots.length * 100)}%)`);
  if (unresolvableIds.length > 0) {
    console.log(`\nUnresolvable lot IDs (first 20):`);
    console.log(unresolvableIds.slice(0, 20).join('\n'));
  }

  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
