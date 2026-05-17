/**
 * Check SW lot coordinates against OSM with a wider 500m radius.
 * If OSM finds actual parking polygons near our seeded coords, compare centroids.
 * Also try the /lots/near endpoint with radius=500 to see what the backend finds.
 */
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const SW_SEEDED = [
  { name: 'Highland Park Market',   lat: 41.84130, lng: -72.58780 },
  { name: 'Stop & Shop',            lat: 41.84320, lng: -72.58700 },
  { name: 'South Windsor Town Hall',lat: 41.85270, lng: -72.58980 },
  { name: 'Evergreen Walk',         lat: 41.83610, lng: -72.57050 },
  { name: 'Avery St CRC',           lat: 41.82780, lng: -72.59710 },
];

async function osmQuery(lat, lng, radius) {
  const query = `[out:json][timeout:15];(way["amenity"="parking"](around:${radius},${lat},${lng}););out body;>;out skel qt;`;
  const resp = await (await fetch)('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Spottr/1.0 (parking availability app; github.com/spottr)',
    },
    body: `data=${encodeURIComponent(query)}`,
    timeout: 20000,
  });
  return resp.json();
}

function centroid(nodes) {
  const lats = nodes.map(n => n.lat), lngs = nodes.map(n => n.lon);
  return {
    lat: lats.reduce((a,b) => a+b, 0) / lats.length,
    lng: lngs.reduce((a,b) => a+b, 0) / lngs.length,
  };
}

function distM(lat1, lng1, lat2, lng2) {
  const R = 6371000, dLat = Math.PI*(lat2-lat1)/180, dLng = Math.PI*(lng2-lng1)/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(Math.PI*lat1/180)*Math.cos(Math.PI*lat2/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

async function main() {
  console.log('Checking seeded coordinates against OSM (500m radius)\n');

  for (const loc of SW_SEEDED) {
    console.log(`--- ${loc.name} ---`);
    console.log(`  Seeded: ${loc.lat}, ${loc.lng}`);

    try {
      const data = await osmQuery(loc.lat, loc.lng, 500);
      const nodeMap = {};
      for (const el of data.elements || []) { if (el.type === 'node') nodeMap[el.id] = el; }

      const ways = (data.elements || []).filter(e => e.type === 'way');
      if (ways.length === 0) {
        console.log('  OSM: no amenity=parking ways within 500m');
      } else {
        console.log(`  OSM found ${ways.length} parking polygon(s):`);
        for (const way of ways.slice(0, 3)) {
          const nodes = (way.nodes || []).map(id => nodeMap[id]).filter(Boolean);
          if (nodes.length < 3) continue;
          const c = centroid(nodes);
          const dist = distM(loc.lat, loc.lng, c.lat, c.lng);
          const lats = nodes.map(n => n.lat), lngs = nodes.map(n => n.lon);
          const bbox = {
            n: Math.max(...lats).toFixed(6), s: Math.min(...lats).toFixed(6),
            e: Math.max(...lngs).toFixed(6), w: Math.min(...lngs).toFixed(6),
          };
          console.log(`    way ${way.id}: centroid ${c.lat.toFixed(6)},${c.lng.toFixed(6)} (${Math.round(dist)}m from seeded)`);
          console.log(`    bbox: N=${bbox.n} S=${bbox.s} E=${bbox.e} W=${bbox.w}`);
          console.log(`    name: ${way.tags?.name || '(unnamed)'}`);
          if (dist > 100) {
            console.log(`    *** MISMATCH: seeded centroid is ${Math.round(dist)}m from OSM polygon centroid`);
          }
        }
      }
    } catch(e) {
      console.log('  OSM query failed:', e.message);
    }
    console.log();
  }

  // Also print Mapbox tile URLs so you can visually inspect in a browser
  const TOKEN = process.env.MAPBOX_TOKEN;
  console.log('\n=== Mapbox tile preview URLs (open in browser to visually verify) ===');
  for (const loc of SW_SEEDED) {
    const url = `https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/${loc.lng},${loc.lat},19,0/640x640@2x?access_token=${TOKEN}`;
    console.log(`${loc.name}:\n  ${url}\n`);
  }
}
main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
