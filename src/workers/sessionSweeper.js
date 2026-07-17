const redis = require('../config/redis');
const pool = require('../config/db');

const SWEEP_INTERVAL_MS = parseInt(process.env.SWEEP_INTERVAL_MS || '60000', 10);
const SESSION_TIMEOUT_MS = parseInt(process.env.SESSION_TIMEOUT_MINUTES || '30', 10) * 60 * 1000;

async function sweepOnce() {
  const cutoff = Date.now() - SESSION_TIMEOUT_MS;
  const expired = await redis.zrangebyscore('sessions:active', 0, cutoff);
  if (!expired.length) return 0;

  for (const sessionId of expired) {
    try {
      await pool.query(
        `UPDATE sessions
           SET ended_at = COALESCE(ended_at, last_seen_at),
               duration_ms = COALESCE(duration_ms, EXTRACT(EPOCH FROM (last_seen_at - started_at)) * 1000),
               is_finished = true
         WHERE id = $1 AND is_finished = false`,
        [sessionId]
      );
    } catch (err) {
      console.error('[sessionSweeper] failed to close session', sessionId, err.message);
      continue; // don't remove from the set, retry next cycle
    }
    await redis.zrem('sessions:active', sessionId);
    await redis.del(`session:meta:${sessionId}`);
  }
  return expired.length;
}

function start() {
  console.log(`[sessionSweeper] started (interval=${SWEEP_INTERVAL_MS}ms, timeout=${SESSION_TIMEOUT_MS}ms)`);
  setInterval(() => {
    sweepOnce().catch((err) => console.error('[sessionSweeper] error:', err));
  }, SWEEP_INTERVAL_MS);
}

module.exports = { start, sweepOnce };
