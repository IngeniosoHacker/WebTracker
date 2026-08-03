const express = require('express');
const router = express.Router();
const pool = require('../config/db');

// GET /api/sites/:siteId/sessions?limit=50&offset=0
router.get('/sites/:siteId/sessions', async (req, res) => {
  const { siteId } = req.params;
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  const offset = parseInt(req.query.offset || '0', 10);
  const { rows } = await pool.query(
    `SELECT id, visitor_id, landing_page, referrer, referrer_domain,
            utm_source, utm_medium, utm_campaign, utm_term, utm_content,
            device_type, browser, os, ip, country, city,
            search_engine, search_keywords, traffic_source_type, bot_name,
            started_at, ended_at, duration_ms,
            pageview_count, is_finished
     FROM sessions WHERE site_id = $1
     ORDER BY started_at DESC LIMIT $2 OFFSET $3`,
    [siteId, limit, offset]
  );
  res.json({ sessions: rows });
});

// GET /api/sessions/:sessionId  -> full detail: session + ordered pageviews (the navigation path) + scroll segments
router.get('/sessions/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const session = await pool.query('SELECT * FROM sessions WHERE id = $1', [sessionId]);
  if (!session.rows.length) return res.status(404).json({ error: 'not found' });

  const pageviews = await pool.query(
    `SELECT * FROM pageviews WHERE session_id = $1 ORDER BY nav_index ASC`,
    [sessionId]
  );

  const pageviewIds = pageviews.rows.map((p) => p.id);
  let scrollByPageview = {};
  if (pageviewIds.length) {
    const segments = await pool.query(
      `SELECT * FROM scroll_segments WHERE pageview_id = ANY($1) ORDER BY depth_bucket ASC`,
      [pageviewIds]
    );
    scrollByPageview = segments.rows.reduce((acc, seg) => {
      (acc[seg.pageview_id] ||= []).push({ depthBucket: seg.depth_bucket, timeMs: seg.time_ms });
      return acc;
    }, {});
  }

  res.json({
    session: session.rows[0],
    path: pageviews.rows.map((p) => ({
      ...p,
      scrollSegments: scrollByPageview[p.id] || []
    }))
  });
});

// GET /api/sites/:siteId/top-landing-pages
router.get('/sites/:siteId/top-landing-pages', async (req, res) => {
  const { siteId } = req.params;
  const { rows } = await pool.query(
    `SELECT landing_path, COUNT(*) AS sessions
     FROM sessions WHERE site_id = $1 AND landing_path IS NOT NULL
     GROUP BY landing_path ORDER BY sessions DESC LIMIT 25`,
    [siteId]
  );
  res.json({ topLandingPages: rows });
});

// GET /api/sites/:siteId/traffic-sources
router.get('/sites/:siteId/traffic-sources', async (req, res) => {
  const { siteId } = req.params;
  const { rows } = await pool.query(
    `SELECT
       COALESCE(utm_source, referrer_domain, 'direct') AS source,
       COALESCE(utm_medium, 'none') AS medium,
       COUNT(*) AS sessions
     FROM sessions WHERE site_id = $1
     GROUP BY 1,2 ORDER BY sessions DESC LIMIT 25`,
    [siteId]
  );
  res.json({ trafficSources: rows });
});

// GET /api/sites/:siteId/pages -> aggregated per-URL stats (avg time, avg scroll)
router.get('/sites/:siteId/pages', async (req, res) => {
  const { siteId } = req.params;
  const { rows } = await pool.query(
    `SELECT path,
            COUNT(*) AS pageviews,
            ROUND(AVG(duration_ms)) AS avg_duration_ms,
            ROUND(AVG(max_scroll_percent)) AS avg_max_scroll_percent
     FROM pageviews WHERE site_id = $1
     GROUP BY path ORDER BY pageviews DESC LIMIT 50`,
    [siteId]
  );
  res.json({ pages: rows });
});

// GET /api/pageviews/:pageviewId/content -> extracted content for NLP/content analysis
router.get('/pageviews/:pageviewId/content', async (req, res) => {
  const { pageviewId } = req.params;
  const { rows } = await pool.query(
    `SELECT id, url, path, title, content_text, content_word_count FROM pageviews WHERE id = $1`,
    [pageviewId]
  );
  if (!rows.length) return res.status(404).json({ error: 'not found' });
  res.json(rows[0]);
});

// GET /api/sites/:siteId/geo -> sessions grouped by country/city
router.get('/sites/:siteId/geo', async (req, res) => {
  const { siteId } = req.params;
  const { rows } = await pool.query(
    `SELECT COALESCE(country, 'unknown') AS country, COALESCE(city, 'unknown') AS city, COUNT(*) AS sessions
     FROM sessions WHERE site_id = $1
     GROUP BY 1,2 ORDER BY sessions DESC LIMIT 50`,
    [siteId]
  );
  res.json({ geo: rows });
});

// GET /api/sites/:siteId/search-keywords -> top keywords that brought visitors in from organic search
// Note: most modern search engines (Google, Bing, DuckDuckGo) no longer pass the
// query in the referrer for regular organic results ("(not provided)"), so this
// will mostly be populated by engines/contexts that still do, or by paid clicks
// where utm_term was set. It's included for completeness and future-proofing.
router.get('/sites/:siteId/search-keywords', async (req, res) => {
  const { siteId } = req.params;
  const { rows } = await pool.query(
    `SELECT COALESCE(search_engine, 'unknown') AS search_engine,
            COALESCE(search_keywords, utm_term, '(not provided)') AS keywords,
            COUNT(*) AS sessions
     FROM sessions
     WHERE site_id = $1 AND traffic_source_type = 'organic_search'
     GROUP BY 1,2 ORDER BY sessions DESC LIMIT 50`,
    [siteId]
  );
  res.json({ keywords: rows });
});

// GET /api/sites/:siteId/ai-visibility?month=YYYY-MM
// The core "is AI reading my site" dashboard: AI crawler hits (bots that never
// run JS, reported via /collect/server) + ai_crawler sessions (agentic browsers
// that DO run JS) + ai_referral sessions (real humans arriving from an AI chat
// product), broken down by bot/product, plus progress against a monthly goal.
router.get('/sites/:siteId/ai-visibility', async (req, res) => {
  const { siteId } = req.params;
  const month = req.query.month || new Date().toISOString().slice(0, 7); // 'YYYY-MM'
  const monthStart = `${month}-01`;

  const [crawlerHits, crawlerSessions, referralSessions, goal, dailyTrend] = await Promise.all([
   pool.query(
  `SELECT bot_name, COUNT(*) AS hits FROM bot_visits
   WHERE site_id = $1 AND traffic_source_type = 'ai_crawler'
     AND occurred_at >= $2::date AND occurred_at < ($2::date + interval '1 month')
   GROUP BY bot_name ORDER BY hits DESC`,
  [siteId, monthStart]
),
    pool.query(
      `SELECT bot_name, COUNT(*) AS hits
       FROM sessions
       WHERE site_id = $1 AND traffic_source_type = 'ai_crawler'
         AND started_at >= $2::date AND started_at < ($2::date + interval '1 month')
       GROUP BY bot_name ORDER BY hits DESC`,
      [siteId, monthStart]
    ),
    pool.query(
      `SELECT bot_name AS ai_product, COUNT(*) AS sessions
       FROM sessions
       WHERE site_id = $1 AND traffic_source_type = 'ai_referral'
         AND started_at >= $2::date AND started_at < ($2::date + interval '1 month')
       GROUP BY bot_name ORDER BY sessions DESC`,
      [siteId, monthStart]
    ),
    pool.query(`SELECT target_visits FROM ai_visibility_goals WHERE site_id = $1 AND month = $2`, [siteId, month]),
    pool.query(
  `SELECT day::date AS day, COUNT(*) AS hits FROM (
     SELECT occurred_at AS day FROM bot_visits
       WHERE site_id = $1 AND traffic_source_type = 'ai_crawler'
         AND occurred_at >= $2::date AND occurred_at < ($2::date + interval '1 month')
     UNION ALL
         SELECT started_at AS day FROM sessions
           WHERE site_id = $1 AND traffic_source_type = 'ai_crawler'
             AND started_at >= $2::date AND started_at < ($2::date + interval '1 month')
       ) t GROUP BY 1 ORDER BY 1`,
      [siteId, monthStart]
    )
  ]);

  const totalCrawlerHits = crawlerHits.rows.reduce((sum, r) => sum + Number(r.hits), 0)
    + crawlerSessions.rows.reduce((sum, r) => sum + Number(r.hits), 0);
  const totalReferralSessions = referralSessions.rows.reduce((sum, r) => sum + Number(r.sessions), 0);
  const target = goal.rows[0] ? goal.rows[0].target_visits : null;

  res.json({
    month,
    aiCrawlerHits: {
      total: totalCrawlerHits,
      byBot: mergeBotCounts(crawlerHits.rows, crawlerSessions.rows)
    },
    aiReferralTraffic: {
      total: totalReferralSessions,
      byProduct: referralSessions.rows
    },
    dailyTrend: dailyTrend.rows,
    goal: target
      ? { targetVisits: target, achieved: totalCrawlerHits, progressPercent: Math.round((totalCrawlerHits / target) * 100) }
      : null
  });
});

function mergeBotCounts(a, b) {
  const map = new Map();
  for (const r of [...a, ...b]) {
    const key = r.bot_name || 'unknown';
    map.set(key, (map.get(key) || 0) + Number(r.hits));
  }
  return Array.from(map.entries()).map(([botName, hits]) => ({ botName, hits })).sort((x, y) => y.hits - x.hits);
}

// GET /api/sites/:siteId/ai-goal?month=YYYY-MM -> read the configured monthly goal
router.get('/sites/:siteId/ai-goal', async (req, res) => {
  const { siteId } = req.params;
  const month = req.query.month || new Date().toISOString().slice(0, 7);
  const { rows } = await pool.query(
    `SELECT month, target_visits FROM ai_visibility_goals WHERE site_id = $1 AND month = $2`,
    [siteId, month]
  );
  res.json(rows[0] || { month, target_visits: null });
});

// POST /api/sites/:siteId/ai-goal  { month: 'YYYY-MM', targetVisits: 500 }
router.post('/sites/:siteId/ai-goal', express.json(), async (req, res) => {
  const { siteId } = req.params;
  const { month, targetVisits } = req.body || {};
  if (!month || !Number.isFinite(targetVisits)) {
    return res.status(400).json({ error: 'month (YYYY-MM) and targetVisits (number) are required' });
  }
  await pool.query(
    `INSERT INTO ai_visibility_goals (site_id, month, target_visits)
     VALUES ($1,$2,$3)
     ON CONFLICT (site_id, month) DO UPDATE SET target_visits = EXCLUDED.target_visits`,
    [siteId, month, targetVisits]
  );
  res.status(204).end();
});

module.exports = router;
