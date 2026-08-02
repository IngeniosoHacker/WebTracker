const express = require('express');
const router = express.Router();
const redis = require('../config/redis');
const pool = require('../config/db');
const geo = require('../lib/geo');
const detect = require('../lib/detect');

const REQUIRE_KNOWN_SITE = String(process.env.REQUIRE_KNOWN_SITE || 'false') === 'true';
const INGEST_KEY = process.env.INGEST_KEY || '';
const STORE_RAW_IP = String(process.env.STORE_RAW_IP || 'true') === 'true';

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
    const userAgent = req.get('user-agent') || '';
    const clientIp = req.ip;
    const geoInfo = geo.lookup(clientIp);

    // Classify using the landing referrer when this batch includes a session_start
    // (most accurate point to know where the visit came from). Falls back to null
    // (still correctly classifies pure bot user-agents regardless of referrer).
    const sessionStartBeacon = body.batch.find((b) => b && b.type === 'session_start');
    const referrerForClassification = sessionStartBeacon && sessionStartBeacon.landing
      ? sessionStartBeacon.landing.referrer
      : null;
    const classification = detect.classify(userAgent, referrerForClassification);

    const pipeline = redis.pipeline();

    for (const beacon of body.batch.slice(0, 50)) {
      const enriched = {
        ...beacon,
        siteId,
        sessionId,
        visitorId: body.visitorId,
        userAgent,
        ipHash: hashIp(clientIp),
        ip: STORE_RAW_IP ? clientIp : null,
        country: geoInfo.country,
        city: geoInfo.city,
        trafficSourceType: classification.trafficSourceType,
        botName: classification.botName,
        searchEngine: classification.searchEngine,
        searchKeywords: classification.searchKeywords,
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

// Receives raw request info from the optional server-side middleware
// (public/server-agent.js) running on the CLIENT's own backend. This is how
// we catch AI/search crawlers that never execute JavaScript and therefore
// never hit POST /collect above. Only bot-classified traffic is persisted;
// everything else is dropped (tracker.js already covers real visitors).
router.post('/collect/server', express.json({ limit: '64kb' }), async (req, res) => {
  try {
    const body = req.body || {};
    const { siteId, url, referrer, userAgent, ip } = body;
    if (!siteId || !userAgent) return res.status(204).end();

    const allowed = await siteIsAllowed(siteId, req.get('origin'));
    if (!allowed) return res.status(204).end();

    const classification = detect.classify(userAgent, referrer || null);
    if (classification.trafficSourceType !== 'ai_crawler' && classification.trafficSourceType !== 'search_bot') {
      return res.status(204).end(); // not a bot worth recording, drop silently
    }

    const effectiveIp = ip || req.ip;
    const geoInfo = geo.lookup(effectiveIp);
    let path = null;
    try { path = url ? new URL(url, 'http://placeholder').pathname : null; } catch { path = null; }

    await redis.rpush('queue:events', JSON.stringify({
      type: 'bot_hit',
      siteId,
      botName: classification.botName,
      trafficSourceType: classification.trafficSourceType,
      url: url || null,
      path,
      referrer: referrer || null,
      userAgent,
      ip: STORE_RAW_IP ? effectiveIp : null,
      country: geoInfo.country,
      city: geoInfo.city,
      receivedAt: Date.now()
    }));

    res.status(204).end();
  } catch (err) {
    console.error('[collect/server] error:', err);
    res.status(204).end(); // never let this break the reporting caller
  }
});

function hashIp(ip) {
  if (!ip) return null;
  // Lightweight non-reversible hash, avoids storing raw IPs.
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(ip + (process.env.INGEST_KEY || 'salt')).digest('hex').slice(0, 24);
}

module.exports = router;
