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
            device_type, browser, os, started_at, ended_at, duration_ms,
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

module.exports = router;
