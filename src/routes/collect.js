const express = require('express');
const router = express.Router();
const redis = require('../config/redis');
const pool = require('../config/db');

const REQUIRE_KNOWN_SITE = String(process.env.REQUIRE_KNOWN_SITE || 'false') === 'true';
const INGEST_KEY = process.env.INGEST_KEY || '';

const knownSitesCache = new Set();

async function siteIsAllowed(siteId, origin) {
  if (!siteId) return false;
  if (knownSitesCache.has(siteId)) return true;

  const { rows } = await pool.query('SELECT id FROM sites WHERE id = $1', [siteId]);
  if (rows.length) {
    knownSitesCache.add(siteId);
    return true;
  }

  if (REQUIRE_KNOWN_SITE) return false;

  // Auto-register the site the first time we see it (convenient for same-environment deployments).
  await pool.query(
    `INSERT INTO sites (id, name, allowed_origin) VALUES ($1, $1, $2)
     ON CONFLICT (id) DO NOTHING`,
    [siteId, origin || null]
  );
  knownSitesCache.add(siteId);
  return true;
}

router.post('/collect', express.json({ limit: '512kb' }), async (req, res) => {
  try {
    if (INGEST_KEY) {
      const key = req.get('x-ingest-key');
      if (key !== INGEST_KEY) return res.status(401).end();
    }

    const body = req.body;
    if (!body || !Array.isArray(body.batch) || !body.siteId || !body.sessionId) {
      return res.status(400).json({ error: 'invalid payload' });
    }

    const { siteId, sessionId } = body;
    const origin = req.get('origin');

    const allowed = await siteIsAllowed(siteId, origin);
    if (!allowed) return res.status(403).json({ error: 'unknown site' });

    const now = Date.now();
    const pipeline = redis.pipeline();

    for (const beacon of body.batch.slice(0, 50)) {
      const enriched = {
        ...beacon,
        siteId,
        sessionId,
        visitorId: body.visitorId,
        userAgent: req.get('user-agent'),
        ipHash: hashIp(req.ip),
        receivedAt: now
      };
      pipeline.rpush('queue:events', JSON.stringify(enriched));
    }

    // Track session as "active" so the sweeper can find and close it after inactivity.
    pipeline.zadd('sessions:active', now, sessionId);
    pipeline.hset(`session:meta:${sessionId}`, { siteId });
    pipeline.expire(`session:meta:${sessionId}`, 60 * 60 * 6); // 6h safety TTL

    await pipeline.exec();

    res.status(204).end();
  } catch (err) {
    console.error('[collect] error:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

function hashIp(ip) {
  if (!ip) return null;
  // Lightweight non-reversible hash, avoids storing raw IPs.
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(ip + (process.env.INGEST_KEY || 'salt')).digest('hex').slice(0, 24);
}

module.exports = router;
