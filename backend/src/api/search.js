/**
 * SPOTTR Search API
 * GET /search?q=&lat=&lng=          - Google Places Autocomplete
 */
const express = require('express');
const router = express.Router();
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const GOOGLE_PLACES_KEY = process.env.GOOGLE_PLACES_KEY || '';

router.get('/', async (req, res) => {
  const { q, lat, lng } = req.query;
  if (!q || q.trim().length < 2) return res.status(400).json({ error: 'q must be at least 2 characters' });
  if (!GOOGLE_PLACES_KEY) return res.status(503).json({ error: 'Google Places API key not configured' });

  try {
    const params = new URLSearchParams({ input: q.trim(), key: GOOGLE_PLACES_KEY, types: 'establishment|geocode', language: 'en' });
    if (lat && lng) { params.set('location', `${lat},${lng}`); params.set('radius', '50000'); }

    const acResp = await fetch(`https://maps.googleapis.com/maps/api/place/autocomplete/json?${params}`, { timeout: 8000 });
    const acData = await acResp.json();

    if (acData.status !== 'OK' && acData.status !== 'ZERO_RESULTS') {
      return res.status(502).json({ error: `Places API: ${acData.status}` });
    }

    const results = await Promise.all(
      (acData.predictions || []).slice(0, 8).map(async (pred) => {
        let predLat = null, predLng = null;
        try {
          const detailParams = new URLSearchParams({ place_id: pred.place_id, fields: 'geometry', key: GOOGLE_PLACES_KEY });
          const detailData = await (await fetch(`https://maps.googleapis.com/maps/api/place/details/json?${detailParams}`, { timeout: 5000 })).json();
          if (detailData.result?.geometry?.location) {
            predLat = detailData.result.geometry.location.lat;
            predLng = detailData.result.geometry.location.lng;
          }
        } catch (e) {}
        const structured = pred.structured_formatting || {};
        return { place_id: pred.place_id, description: pred.description, mainText: structured.main_text || pred.description, secondaryText: structured.secondary_text || '', lat: predLat, lng: predLng };
      })
    );

    res.json({ results, count: results.length });
  } catch (err) {
    console.error('GET /search error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
