const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const redis = require('../config/redis');

router.get('/health', async (req, res) => {
  const status = { ok: true, postgres: false, redis: false };
  try {
    await pool.query('SELECT 1');
    status.postgres = true;
  } catch (e) {
    status.ok = false;
  }
  try {
    await redis.ping();
    status.redis = true;
  } catch (e) {
    status.ok = false;
  }
  res.status(status.ok ? 200 : 503).json(status);
});

module.exports = router;
