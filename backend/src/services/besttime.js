'use strict';
/**
 * besttime.js — BestTime.app API wrapper
 *
 * Controlled by BESTTIME_ENABLED env var (default: disabled for Iteration A).
 * When disabled, all exported functions return null immediately so callers
 * can safely import this module without BestTime being configured.
 *
 * Cache: in-memory Map with 15-minute TTL for live data, 24-hour for forecasts.
 * This is intentionally simple — a Redis cache is a V6 upgrade if needed.
 *
 * V6 setup checklist:
 *   1. Sign up at besttime.app (free tier ~10 min)
 *   2. Run `node backend/scripts/besttime_seed.js` to resolve venue IDs for
 *      each flagship lot and store them in lots.besttime_venue_id
 *   3. Set BESTTIME_ENABLED=true and BESTTIME_API_KEY in Railway env vars
 */

const ENABLED = process.env.BESTTIME_ENABLED === 'true';
const API_KEY = process.env.BESTTIME_API_KEY || '';
const BASE_URL = 'https://besttime.app/api/v1';

// { key -> { data, expiresAt } }
const cache = new Map();

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { cache.delete(key); return null; }
  return entry.data;
}

function setCached(key, data, ttlMs) {
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

const TTL_LIVE_MS     = 15 * 60 * 1000;  // 15 minutes
const TTL_FORECAST_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * getForecast(venueId) → { busyness_pattern, peak_hours, ... } | null
 *
 * Returns the weekly forecast for a venue. Stable for days/weeks; cached 24h.
 * Returns null if BestTime is disabled, venueId is missing, or request fails.
 */
async function getForecast(venueId) {
  if (!ENABLED || !venueId) return null;
  const cacheKey = `forecast:${venueId}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const url = `${BASE_URL}/forecasts?api_key_public=${encodeURIComponent(API_KEY)}&venue_id=${encodeURIComponent(venueId)}`;
    const res = await fetch(url, { timeout: 10000 });
    if (!res.ok) {
      console.warn(`[besttime] getForecast ${venueId}: HTTP ${res.status}`);
      return null;
    }
    const json = await res.json();
    const data = json?.analysis || null;
    if (data) setCached(cacheKey, data, TTL_FORECAST_MS);
    return data;
  } catch (err) {
    console.warn(`[besttime] getForecast ${venueId}: ${err.message}`);
    return null;
  }
}

/**
 * getLiveStatus(venueId) → { busyness_index: 0-100, ... } | null
 *
 * Returns live busyness (0–100, relative to venue's weekly peak). Cached 15min.
 * Returns null if BestTime is disabled, venueId is missing, live data unavailable,
 * or request fails.
 */
async function getLiveStatus(venueId) {
  if (!ENABLED || !venueId) return null;
  const cacheKey = `live:${venueId}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const url = `${BASE_URL}/forecasts/live?api_key_public=${encodeURIComponent(API_KEY)}&venue_id=${encodeURIComponent(venueId)}`;
    const res = await fetch(url, { timeout: 10000 });
    if (!res.ok) {
      console.warn(`[besttime] getLiveStatus ${venueId}: HTTP ${res.status}`);
      return null;
    }
    const json = await res.json();
    const data = json?.analysis?.venue_live_busyness != null
      ? { busyness_index: json.analysis.venue_live_busyness }
      : null;
    if (data) setCached(cacheKey, data, TTL_LIVE_MS);
    return data;
  } catch (err) {
    console.warn(`[besttime] getLiveStatus ${venueId}: ${err.message}`);
    return null;
  }
}

module.exports = { getForecast, getLiveStatus, isEnabled: () => ENABLED };
