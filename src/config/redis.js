const Redis = require('ioredis');

if (!process.env.REDIS_URL) {
  console.warn('[redis] REDIS_URL is not set. The server will fail on first Redis operation.');
}

const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 5,
  enableReadyCheck: true
});

redis.on('error', (err) => {
  console.error('[redis] connection error:', err.message);
});

redis.on('connect', () => {
  console.log('[redis] connected');
});

// Keys / structures used across the app:
// - "queue:events"          -> Redis LIST, raw JSON payloads waiting to be flushed to Postgres (ingestion buffer)
// - "sessions:active"       -> Redis ZSET, member=sessionId, score=lastSeenAt (ms). Used by the sweeper to find idle sessions.
// - "session:meta:<id>"     -> Redis HASH/STRING cache with siteId for quick lookup by the sweeper (short TTL safety net)
module.exports = redis;
