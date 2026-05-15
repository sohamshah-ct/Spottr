require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const cron = require('node-cron');
const { runBackup } = require('../scripts/backup_db');

const lotsRouter = require('./api/lots');
const eventsRouter = require('./api/events');
const devicesRouter = require('./api/devices');
const searchRouter = require('./api/search');
const adminRouter = require('./api/admin');
const pool = require('./db/pool');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust Railway proxy
app.set('trust proxy', 1);

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Rate limiting - validate.trustProxy:false tells ERL we handle trust proxy ourselves
app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
}));

// Routes - lotsRouter now owns ALL /api/lots/* including /near
app.use('/search', searchRouter);       // GET /search?q=  (Places autocomplete)
app.use('/api/search', searchRouter);   // GET /api/search?q= (alias)
app.use('/api/lots', lotsRouter);       // ALL /api/lots/* - /near, /nearby, /:id, etc.
app.use('/api/events', eventsRouter);
app.use('/api/devices', devicesRouter);
app.use('/admin', adminRouter);

app.get('/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT COUNT(*) FROM lots');
    res.json({ status: 'ok', lots_in_db: parseInt(result.rows[0].count), timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => { console.error(err.stack); res.status(500).json({ error: 'Internal server error' }); });

app.listen(PORT, () => {
  console.log(`SPOTTR API running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
});

// Daily DB backup at 03:00 UTC
cron.schedule('0 3 * * *', () => {
  console.log(`[${new Date().toISOString()}] Running scheduled DB backup...`);
  runBackup().catch(err => console.error('Scheduled backup failed:', err.message));
}, { timezone: 'UTC' });

module.exports = app;
