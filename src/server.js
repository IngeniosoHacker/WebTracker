require('dotenv').config();
const path = require('path');
const express = require('express');
const helmet = require('helmet');

const corsMiddleware = require('./middleware/cors');
const healthRoutes = require('./routes/health');
const collectRoutes = require('./routes/collect');
const statsRoutes = require('./routes/stats');
const flushWorker = require('./workers/flushWorker');
const sessionSweeper = require('./workers/sessionSweeper');

const app = express();
const PORT = process.env.PORT || 3000;

app.disable('x-powered-by');
app.set('trust proxy', true); // required so req.ip is the real visitor IP behind Railway's proxy
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(corsMiddleware);

// Serve the client tracker script (the "plugin" sites embed) and any static demo assets.
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '5m' }));

app.use(healthRoutes);
app.use(collectRoutes);
app.use('/api', statsRoutes);

app.get('/', (req, res) => {
  res.json({
    name: 'analytics-tracker',
    status: 'ok',
    tracker: '/tracker.js',
    docs: 'See README.md'
  });
});

app.use((err, req, res, next) => {
  if (err && err.message && err.message.includes('CORS')) {
    return res.status(403).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

app.listen(PORT, () => {
  console.log(`[server] listening on port ${PORT}`);
  flushWorker.start();
  sessionSweeper.start();
});
