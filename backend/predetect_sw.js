/**
 * Step 8: Pre-detect 5 South Windsor verification lots
 * Calls /api/lots/near for each location to warm the cache.
 * Reports what to check during in-person ground-truth.
 */
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const API_BASE = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : 'http://localhost:3000';

const SW_LOTS = [
  { name: 'Highland Park Market',                  addr: '1240 Sullivan Ave, South Windsor',  lat: 41.8418,  lng: -72.5875 },
  { name: 'Stop & Shop',                           addr: '1320 Sullivan Ave, South Windsor',  lat: 41.8432,  lng: -72.5869 },
  { name: 'South Windsor Town Hall',               addr: '1540 Sullivan Ave, South Windsor',  lat: 41.8527,  lng: -72.5898 },
  { name: 'Evergreen Walk',                        addr: '501 Evergreen Way, South Windsor',  lat: 41.8361,  lng: -72.5705 },
  { name: 'Avery Street Christian Reformed Church',addr: '661 Avery St, South Windsor',       lat: 41.8278,  lng: -72.5971 },
];

async function detectLot(lot) {
  const url = `${API_BASE}/api/lots/near?lat=${lot.lat}&lng=${lot.lng}`;
  console.log(`\n[${lot.name}]`);
  console.log(`  addr:  ${lot.addr}`);
  console.log(`  query: ${url}`);

  const t0 = Date.now();
  const resp = await (await fetch)(url, { timeout: 150000 });
  const elapsed = Date.now() - t0;

  if (!resp.ok) {
    console.log(`  ERROR HTTP ${resp.status}: ${(await resp.text()).slice(0, 100)}`);
    return null;
  }

  const data = await resp.json();
  const lots = data.lots || [];

  if (lots.length === 0) {
    console.log(`  No lots found within 200m — OSM may not have this parking area`);
    return null;
  }

  const nearest = lots[0];
  console.log(`  lot_id:      ${nearest.id}`);
  console.log(`  lot_name:    ${nearest.name || '(unnamed)'}`);
  console.log(`  distance:    ${Math.round(nearest.distance_meters || 0)}m`);
  console.log(`  source:      ${nearest.source}`);
  console.log(`  cached:      ${nearest.cached}`);
  console.log(`  spaces:      ${(nearest.spaces || []).length}`);
  console.log(`  confidence:  ${nearest.confidence}`);
  console.log(`  cars_det:    ${nearest.cars_detected ?? 'n/a'}`);
  console.log(`  age_secs:    ${nearest.detection_age_seconds}`);
  console.log(`  elapsed_ms:  ${elapsed}`);

  return nearest;
}

async function main() {
  console.log('=== SPOTTR V5 — South Windsor Verification Pre-detect ===');
  console.log(`API: ${API_BASE}`);

  const results = [];
  for (const lot of SW_LOTS) {
    const result = await detectLot(lot);
    results.push({ lot, result });
  }

  console.log('\n\n=== SUMMARY ===');
  console.log('Lot'.padEnd(45), 'spaces', 'source'.padEnd(16), 'conf', 'cached');
  console.log('-'.repeat(100));
  for (const { lot, result } of results) {
    if (!result) {
      console.log(lot.name.padEnd(45), 'NOT FOUND');
      continue;
    }
    const spaces = (result.spaces || []).length;
    console.log(
      lot.name.padEnd(45),
      String(spaces).padEnd(7),
      (result.source || '').padEnd(16),
      String(result.confidence || 0).padEnd(5),
      result.cached ? 'yes' : 'no'
    );
  }

  console.log('\n\n=== WHAT TO CHECK IN PERSON ===');
  for (const { lot, result } of results) {
    if (!result) continue;
    const spaces = result.spaces || [];
    const occupied = spaces.filter(s => s.occupied).length;
    const open = spaces.length - occupied;

    console.log(`\n${lot.name}`);
    console.log(`  Address: ${lot.addr}`);
    console.log(`  App shows: ${spaces.length} total spots, ${open} open, ${occupied} occupied`);
    console.log(`  Detection source: ${result.source}`);
    if (result.source === 'grid_fallback') {
      console.log(`  NOTE: Grid fallback — spot positions are geometric estimates, not real stripe detection`);
      console.log(`  Verify: do the rows approximately match the actual parking rows?`);
      console.log(`  Verify: is the spot count roughly correct (within +/-25%)?`);
    } else {
      console.log(`  NOTE: SAM2 real detection — spot positions should map to actual stripe lines`);
      console.log(`  Verify: do the spot lat/lngs navigate to real spots in Apple/Google Maps?`);
      console.log(`  Verify: are obviously-occupied spots flagged correctly?`);
    }
    if (spaces.length > 0) {
      const sample = spaces[0];
      console.log(`  Sample spot[0]: lat=${sample.lat?.toFixed(6)}, lng=${sample.lng?.toFixed(6)}, occupied=${sample.occupied}`);
    }
  }
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
