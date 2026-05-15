const express = require('express');
const router = express.Router();
const db = require('../db/queries');

router.post('/', async (req, res) => {
  const { lot_id, space_id, row_id, event_type, source, observed_at, device_id, confidence, lat, lng } = req.body;
  if (!lot_id || !event_type) return res.status(400).json({ error: 'lot_id and event_type required' });
  if (!['arrived','departed'].includes(event_type)) return res.status(400).json({ error: 'event_type must be arrived or departed' });
  try {
    const event = await db.insertEvent({ lot_id, space_id, row_id, event_type, source: source||'passive_gps', observed_at, device_id, confidence, raw_lat: lat, raw_lng: lng });
    res.status(201).json({ id: event.id });
  } catch (err) {
    console.error('POST /events error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/batch', async (req, res) => {
  const { events } = req.body;
  if (!Array.isArray(events) || events.length === 0) return res.status(400).json({ error: 'events array required' });
  if (events.length > 500) return res.status(400).json({ error: 'Max 500 events per batch' });
  try {
    const ids = await db.insertEventsBatch(events);
    res.status(201).json({ inserted: ids.length, ids });
  } catch (err) {
    console.error('POST /events/batch error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
