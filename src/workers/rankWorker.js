// Rank tracking: every RANK_INTERVAL_MS, checks the Google position of each
// tracked keyword (seo_keywords.tracked) whose last check is older than
// RANK_CHECK_EVERY_HOURS — so a keyword added in the dashboard gets its first
// position within one interval, and then one check a day. Results go to
// seo_rank_checks (the history the dashboard charts and the R models read).
//
// Off unless DataForSEO is configured. Each check is one SERP call
// (~US$0.002) and counts against the site's monthly budget (lib/dataforseo).
'use strict';

const pool = require('../config/db');
const dfs = require('../lib/dataforseo');

const INTERVAL_MS = parseInt(process.env.RANK_INTERVAL_MS || String(15 * 60 * 1000), 10);
const EVERY_HOURS = parseInt(process.env.RANK_CHECK_EVERY_HOURS || '24', 10);
const BATCH = parseInt(process.env.RANK_BATCH_SIZE || '50', 10);

let running = false;

async function dueKeywords() {
  const { rows } = await pool.query(
    `SELECT k.site_id, k.keyword, s.domain, s.location_code, s.language_code, s.device
     FROM seo_keywords k
     JOIN seo_settings s ON s.site_id = k.site_id
     LEFT JOIN LATERAL (
       SELECT checked_at FROM seo_rank_checks c
       WHERE c.site_id = k.site_id AND c.keyword = k.keyword
       ORDER BY checked_at DESC LIMIT 1
     ) last ON true
     WHERE k.tracked AND (last.checked_at IS NULL OR last.checked_at < now() - make_interval(hours => $1))
     ORDER BY last.checked_at NULLS FIRST
     LIMIT $2`,
    [EVERY_HOURS, BATCH]
  );
  return rows;
}

async function checkOne(k) {
  const market = { locationCode: k.location_code, languageCode: k.language_code };
  try {
    const r = await dfs.rankCheck(market, k.keyword, k.domain, k.device, { pool, siteId: k.site_id });
    await pool.query(
      `INSERT INTO seo_rank_checks (site_id, keyword, device, position, url, serp_features) VALUES ($1,$2,$3,$4,$5,$6)`,
      [k.site_id, k.keyword, k.device, r.position, r.url, r.serpFeatures]
    );
  } catch (err) {
    // Out of budget: skip quietly, the site gets checked again next month.
    if (err.code === 'budget') return 'budget';
    await pool.query(
      `INSERT INTO seo_rank_checks (site_id, keyword, device, error) VALUES ($1,$2,$3,$4)`,
      [k.site_id, k.keyword, k.device, String(err.message).slice(0, 300)]
    );
  }
  return 'ok';
}

async function runOnce() {
  const due = await dueKeywords();
  const outOfBudget = new Set();
  for (const k of due) {
    if (outOfBudget.has(k.site_id)) continue;
    if ((await checkOne(k)) === 'budget') outOfBudget.add(k.site_id);
  }
  return due.length;
}

function start() {
  if (running) return;
  if (!dfs.isConfigured()) {
    console.log('[rankWorker] DataForSEO not configured (DATAFORSEO_API_KEY) — rank tracking off');
    return;
  }
  running = true;
  console.log(`[rankWorker] started (interval=${INTERVAL_MS}ms, every=${EVERY_HOURS}h, batch=${BATCH})`);
  const loop = async () => {
    try { await runOnce(); } catch (err) { console.error('[rankWorker] error:', err.message); }
    finally { setTimeout(loop, INTERVAL_MS); }
  };
  setTimeout(loop, 10000);
}

module.exports = { start, runOnce };
