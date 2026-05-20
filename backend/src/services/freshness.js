'use strict';
/**
 * freshness.js — Lot data freshness state machine
 *
 * States (priority order):
 *   A — BestTime live busyness available (post-V6)
 *   B — BestTime forecast pattern available (post-V6)
 *   C — Modal detection <4 hours old (satellite count, current)
 *   D — Capacity only (no recent detection; total_spaces from DB only)
 *
 * computeFreshness(lot, detectionAgeSec) is async and never throws.
 * Returns { state: 'A'|'B'|'C'|'D', label: string }.
 *
 * label format:
 *   A: "Live"
 *   B: "~<N>min ago" or "<Nh> forecast"
 *   C: "Imaged <N>m ago" | "Imaged <N>h ago"
 *   D: "Capacity only"
 */

const { getLiveStatus, getForecast } = require('./besttime');

const DETECTION_FRESH_SEC = 4 * 60 * 60; // 4 hours

/**
 * @param {object} lot - lot row with optional besttime_venue_id
 * @param {number|null} detectionAgeSec - seconds since last detection, or null
 * @returns {Promise<{ state: string, label: string }>}
 */
async function computeFreshness(lot, detectionAgeSec) {
  try {
    const venueId = lot?.besttime_venue_id || null;

    // State A: BestTime live
    if (venueId) {
      const live = await getLiveStatus(venueId);
      if (live?.busyness_index != null) {
        return { state: 'A', label: 'Live' };
      }
    }

    // State B: BestTime forecast
    if (venueId) {
      const forecast = await getForecast(venueId);
      if (forecast) {
        return { state: 'B', label: 'Forecast' };
      }
    }

    // State C: recent Modal detection
    if (detectionAgeSec != null && detectionAgeSec <= DETECTION_FRESH_SEC) {
      const label = formatDetectionAge(detectionAgeSec);
      return { state: 'C', label };
    }

    // State D: capacity only
    return { state: 'D', label: 'Capacity only' };
  } catch (err) {
    console.warn('[freshness] computeFreshness error:', err.message);
    return { state: 'D', label: 'Capacity only' };
  }
}

function formatDetectionAge(sec) {
  if (sec < 60) return 'Imaged just now';
  if (sec < 3600) {
    const m = Math.round(sec / 60);
    return `Imaged ${m}m ago`;
  }
  const h = Math.round(sec / 3600);
  return `Imaged ${h}h ago`;
}

module.exports = { computeFreshness };
