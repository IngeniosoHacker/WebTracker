const redis = require('../config/redis');
const pool = require('../config/db');

const BATCH_SIZE = parseInt(process.env.FLUSH_BATCH_SIZE || '200', 10);
const INTERVAL_MS = parseInt(process.env.FLUSH_INTERVAL_MS || '2000', 10);
const CONTENT_MAX_CHARS = parseInt(process.env.CONTENT_MAX_CHARS || '8000', 10);

let running = false;

async function popBatch() {
  const pipeline = redis.pipeline();
  for (let i = 0; i < BATCH_SIZE; i++) pipeline.lpop('queue:events');
  const results = await pipeline.exec();
  return results
    .map(([, val]) => val)
    .filter(Boolean)
    .map((v) => {
      try { return JSON.parse(v); } catch { return null; }
    })
    .filter(Boolean);
}

function domainFromUrl(url) {
  try { return new URL(url).hostname; } catch { return null; }
}

async function upsertSessionStart(client, beacon) {
  const l = beacon.landing || {};
  const utm = l.utm || {};
  await client.query(
    `INSERT INTO sessions (
       id, site_id, visitor_id, landing_page, landing_path, referrer, referrer_domain,
       utm_source, utm_medium, utm_campaign, utm_term, utm_content,
       device_type, browser, os, user_agent, ip_hash, ip, country, city,
       search_engine, search_keywords, traffic_source_type, bot_name,
       started_at, last_seen_at, pageview_count
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
       $21,$22,$23,$24,
       to_timestamp($25::double precision / 1000), to_timestamp($26::double precision / 1000), 0
     )
     ON CONFLICT (id) DO UPDATE SET
       last_seen_at = GREATEST(sessions.last_seen_at, EXCLUDED.last_seen_at),
       ip = COALESCE(sessions.ip, EXCLUDED.ip),
       country = COALESCE(sessions.country, EXCLUDED.country),
       city = COALESCE(sessions.city, EXCLUDED.city),
       search_engine = COALESCE(sessions.search_engine, EXCLUDED.search_engine),
       search_keywords = COALESCE(sessions.search_keywords, EXCLUDED.search_keywords),
       bot_name = COALESCE(sessions.bot_name, EXCLUDED.bot_name)`,
    [
      beacon.sessionId, beacon.siteId, beacon.visitorId,
      l.page || null, l.path || null, l.referrer || null, l.referrer ? domainFromUrl(l.referrer) : null,
      utm.source || null, utm.medium || null, utm.campaign || null, utm.term || null, utm.content || null,
      l.deviceType || null, l.browser || null, l.os || null, beacon.userAgent || null, beacon.ipHash || null,
      beacon.ip || null, beacon.country || null, beacon.city || null,
      beacon.searchEngine || null, beacon.searchKeywords || null,
      beacon.trafficSourceType || 'direct', beacon.botName || null,
      beacon.enteredAt || beacon.receivedAt, beacon.receivedAt
    ]
  );
}

// On-page SEO signals from tracker.js (extractSeo): whitelisted keys only,
// strings capped, since anyone can post to /collect.
const SEO_STRINGS = { metaDescription: 400, h1: 300, canonical: 500, lang: 20, robots: 100, ogTitle: 300 };
const SEO_NUMBERS = ['h1Count', 'h2Count', 'imgCount', 'imgNoAlt', 'internalLinks', 'externalLinks', 'titleLength'];
function seoMeta(seo) {
  if (!seo || typeof seo !== 'object') return null;
  const out = {};
  for (const [k, max] of Object.entries(SEO_STRINGS)) {
    if (typeof seo[k] === 'string') out[k] = seo[k].slice(0, max);
  }
  for (const k of SEO_NUMBERS) {
    const n = Number(seo[k]);
    if (Number.isFinite(n) && n >= 0) out[k] = Math.min(Math.round(n), 100000);
  }
  if (Array.isArray(seo.schemaTypes)) out.schemaTypes = seo.schemaTypes.filter((t) => typeof t === 'string').slice(0, 20).map((t) => t.slice(0, 60));
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

async function upsertPageview(client, beacon) {
  const pv = beacon.pageview;
  if (!pv || !pv.id) return;

  const content = pv.content || {};
  const text = content.text ? String(content.text).slice(0, CONTENT_MAX_CHARS) : null;

  // Make sure the parent session exists even if session_start was lost/delayed, so FK doesn't fail.
  // Also fills in geo/traffic-classification fields if session_start hasn't arrived yet.
  await client.query(
    `INSERT INTO sessions (
       id, site_id, visitor_id, ip, country, city, search_engine, search_keywords,
       traffic_source_type, bot_name, user_agent, started_at, last_seen_at, pageview_count
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
             to_timestamp($12::double precision/1000), to_timestamp($12::double precision/1000), 0)
     ON CONFLICT (id) DO UPDATE SET
       ip = COALESCE(sessions.ip, EXCLUDED.ip),
       country = COALESCE(sessions.country, EXCLUDED.country),
       city = COALESCE(sessions.city, EXCLUDED.city),
       search_engine = COALESCE(sessions.search_engine, EXCLUDED.search_engine),
       search_keywords = COALESCE(sessions.search_keywords, EXCLUDED.search_keywords),
       bot_name = COALESCE(sessions.bot_name, EXCLUDED.bot_name)`,
    [
      beacon.sessionId, beacon.siteId, beacon.visitorId,
      beacon.ip || null, beacon.country || null, beacon.city || null,
      beacon.searchEngine || null, beacon.searchKeywords || null,
      beacon.trafficSourceType || 'direct', beacon.botName || null, beacon.userAgent || null,
      pv.enteredAt || beacon.receivedAt
    ]
  );

  const result = await client.query(
    `INSERT INTO pageviews (
       id, session_id, site_id, nav_index, url, path, title, internal_referrer_path,
       entered_at, left_at, duration_ms, max_scroll_percent, content_text, content_word_count, seo_meta
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,
       to_timestamp($9::double precision/1000),
       CASE WHEN $10::double precision IS NULL THEN NULL ELSE to_timestamp($10::double precision/1000) END,
       $11,$12,$13,$14,$15
     )
     ON CONFLICT (id) DO UPDATE SET
       left_at = COALESCE(EXCLUDED.left_at, pageviews.left_at),
       duration_ms = GREATEST(pageviews.duration_ms, EXCLUDED.duration_ms),
       max_scroll_percent = GREATEST(pageviews.max_scroll_percent, EXCLUDED.max_scroll_percent),
       content_text = COALESCE(pageviews.content_text, EXCLUDED.content_text),
       content_word_count = COALESCE(pageviews.content_word_count, EXCLUDED.content_word_count),
       seo_meta = COALESCE(pageviews.seo_meta, EXCLUDED.seo_meta),
       updated_at = now()
     RETURNING (xmax = 0) AS inserted`,
    [
      pv.id, beacon.sessionId, beacon.siteId, pv.navIndex || 0, pv.url, pv.path, pv.title || null,
      pv.internalReferrerPath || null, pv.enteredAt || beacon.receivedAt, pv.leftAt || null,
      pv.durationMs || 0, pv.maxScrollPercent || 0, text, content.wordCount || null, seoMeta(pv.seo)
    ]
  );

  const wasInserted = result.rows[0] && result.rows[0].inserted;
  if (wasInserted) {
    await client.query(
      `UPDATE sessions SET pageview_count = pageview_count + 1, last_seen_at = GREATEST(last_seen_at, to_timestamp($2::double precision/1000)) WHERE id = $1`,
      [beacon.sessionId, pv.enteredAt || beacon.receivedAt]
    );
  } else {
    await client.query(
      `UPDATE sessions SET last_seen_at = GREATEST(last_seen_at, to_timestamp($2::double precision/1000)) WHERE id = $1`,
      [beacon.sessionId, beacon.receivedAt]
    );
  }

  if (Array.isArray(pv.scrollSegments)) {
    for (const seg of pv.scrollSegments) {
      if (typeof seg.bucket !== 'number' || typeof seg.timeMs !== 'number') continue;
      await client.query(
        `INSERT INTO scroll_segments (pageview_id, depth_bucket, time_ms)
         VALUES ($1,$2,$3)
         ON CONFLICT (pageview_id, depth_bucket) DO UPDATE SET time_ms = GREATEST(scroll_segments.time_ms, EXCLUDED.time_ms)`,
        [pv.id, seg.bucket, seg.timeMs]
      );
    }
  }

  if (beacon.isFinal) {
    await client.query(
      `UPDATE sessions SET ended_at = to_timestamp($2::double precision/1000),
              duration_ms = EXTRACT(EPOCH FROM (to_timestamp($2::double precision/1000) - started_at)) * 1000
       WHERE id = $1 AND ended_at IS NULL`,
      [beacon.sessionId, pv.leftAt || beacon.receivedAt]
    );
  }
}

async function upsertEvent(client, beacon) {
  await client.query(
    `INSERT INTO events (site_id, session_id, pageview_id, type, payload, occurred_at)
     VALUES ($1,$2,$3,$4,$5, to_timestamp($6::double precision/1000))`,
    [beacon.siteId, beacon.sessionId, beacon.pageviewId || null, beacon.eventType || 'custom', beacon.payload || {}, beacon.receivedAt]
  );
}

async function upsertBotHit(client, beacon) {
  await client.query(
    `INSERT INTO bot_visits (
       site_id, bot_name, traffic_source_type, url, path, referrer, user_agent, ip, country, city, occurred_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, to_timestamp($11::double precision/1000))`,
    [
      beacon.siteId, beacon.botName, beacon.trafficSourceType, beacon.url || null, beacon.path || null,
      beacon.referrer || null, beacon.userAgent || null, beacon.ip || null, beacon.country || null,
      beacon.city || null, beacon.receivedAt
    ]
  );
}

async function processBeacon(client, beacon) {
  switch (beacon.type) {
    case 'session_start':
      return upsertSessionStart(client, beacon);
    case 'pageview':
      return upsertPageview(client, beacon);
    case 'event':
      return upsertEvent(client, beacon);
    case 'bot_hit':
      return upsertBotHit(client, beacon);
    default:
      return null;
  }
}

async function flushOnce() {
  const beacons = await popBatch();
  if (!beacons.length) return 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const beacon of beacons) {
      try {
        await processBeacon(client, beacon);
      } catch (err) {
        console.error('[flushWorker] failed to process beacon', beacon && beacon.type, err.message);
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[flushWorker] batch failed, requeueing:', err.message);
    // Best-effort requeue so we don't lose data on transient DB errors.
    const pipeline = redis.pipeline();
    beacons.forEach((b) => pipeline.rpush('queue:events', JSON.stringify(b)));
    await pipeline.exec();
  } finally {
    client.release();
  }
  return beacons.length;
}

function start() {
  if (running) return;
  running = true;
  console.log(`[flushWorker] started (interval=${INTERVAL_MS}ms, batch=${BATCH_SIZE})`);

  const loop = async () => {
    try {
      let processed;
      do {
        processed = await flushOnce();
      } while (processed === BATCH_SIZE); // drain quickly if the queue is backed up
    } catch (err) {
      console.error('[flushWorker] loop error:', err);
    } finally {
      setTimeout(loop, INTERVAL_MS);
    }
  };

  loop();
}

module.exports = { start, flushOnce };
