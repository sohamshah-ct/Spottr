/**
 * SPOTTR Search API
 * GET /search?q=&lat=&lng=   - Places API (New) autocomplete + Place Details
 *
 * Uses the Places API (New) endpoints (places.googleapis.com) — the legacy
 * maps.googleapis.com/maps/api/place/* endpoints are not enabled on this key.
 */
const express = require('express');
const router = express.Router();
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const GOOGLE_PLACES_KEY = process.env.GOOGLE_PLACES_KEY || '';

const AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';
const DETAILS_BASE_URL  = 'https://places.googleapis.com/v1/places';

router.get('/', async (req, res) => {
  const { q, lat, lng } = req.query;
  if (!q || q.trim().length < 2) return res.status(400).json({ error: 'q must be at least 2 characters' });
  if (!GOOGLE_PLACES_KEY) return res.status(503).json({ error: 'Google Places API key not configured' });

  try {
    const body = { input: q.trim() };
    if (lat && lng) {
      body.locationBias = {
        circle: {
          center: { latitude: parseFloat(lat), longitude: parseFloat(lng) },
          radius: 50000,
        },
      };
    }

    const acResp = await fetch(AUTOCOMPLETE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': GOOGLE_PLACES_KEY,
      },
      body: JSON.stringify(body),
      timeout: 8000,
    });
    const acData = await acResp.json();

    if (!acResp.ok) {
      const msg = acData?.error?.message || acResp.statusText;
      return res.status(502).json({ error: `Places API: ${msg}` });
    }

    const predictions = (acData.suggestions || []).slice(0, 8);

    const results = await Promise.all(
      predictions.map(async (suggestion) => {
        const pred = suggestion.placePrediction || {};
        const sf   = pred.structuredFormat || {};
        let predLat = null, predLng = null;

        try {
          const detailResp = await fetch(
            `${DETAILS_BASE_URL}/${pred.placeId}?fields=location&key=${GOOGLE_PLACES_KEY}`,
            { timeout: 5000 }
          );
          const detailData = await detailResp.json();
          if (detailData.location) {
            predLat = detailData.location.latitude;
            predLng = detailData.location.longitude;
          }
        } catch (e) {}

        return {
          place_id:      pred.placeId || '',
          description:   pred.text?.text || '',
          mainText:      sf.mainText?.text || pred.text?.text || '',
          secondaryText: sf.secondaryText?.text || '',
          lat: predLat,
          lng: predLng,
        };
      })
    );

    res.json({ results, count: results.length });
  } catch (err) {
    console.error('GET /search error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
