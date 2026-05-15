const express = require('express');
const router = express.Router();
const db = require('../db/queries');

router.post('/register', async (req, res) => {
  const { device_id, push_token, platform } = req.body;
  if (!device_id) return res.status(400).json({ error: 'device_id required' });
  try {
    const result = await db.registerDevice({ device_id, push_token, platform });
    res.status(201).json({ id: result.id });
  } catch (err) {
    console.error('POST /devices/register error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
