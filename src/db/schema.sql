-- Analytics tracker schema
-- Safe to run multiple times (IF NOT EXISTS everywhere)

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

-- One row per client website using the tracker
CREATE TABLE IF NOT EXISTS sites (
  id            TEXT PRIMARY KEY,          -- siteId chosen by the client (slug), e.g. "acme-shop"
  name          TEXT,
  allowed_origin TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per visit (a "session" = a visitor browsing with < SESSION_TIMEOUT_MINUTES of inactivity)
CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,       -- sessionId generated client-side (uuid)
  site_id           TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  visitor_id        TEXT NOT NULL,          -- long-lived id stored in localStorage
  landing_page      TEXT,                   -- full URL of the first page of the visit
  landing_path      TEXT,                   -- path only
  referrer          TEXT,                   -- document.referrer on landing (external source)
  referrer_domain   TEXT,
  utm_source        TEXT,
  utm_medium        TEXT,
  utm_campaign      TEXT,
  utm_term          TEXT,
  utm_content       TEXT,
  device_type       TEXT,                   -- mobile / tablet / desktop
  browser           TEXT,
  os                TEXT,
  user_agent        TEXT,
  ip_hash           TEXT,                   -- hashed IP, kept for backward-compatible dedup
  ip                TEXT,                   -- raw IP address (see README privacy note before enabling in regulated contexts)
  country           TEXT,                   -- ISO country code, resolved offline from IP
  city              TEXT,                   -- best-effort, offline DB has limited city precision
  search_engine     TEXT,                   -- google / bing / duckduckgo / yahoo / yandex / baidu (from referrer, if organic)
  search_keywords   TEXT,                   -- query the visitor typed in the search engine, when the engine still passes it
  traffic_source_type TEXT NOT NULL DEFAULT 'direct', -- direct | referral | organic_search | ai_referral | ai_crawler | search_bot
  bot_name          TEXT,                   -- e.g. GPTBot, ClaudeBot, PerplexityBot, or AI referral product name (chatgpt, perplexity...)
  started_at        TIMESTAMPTZ NOT NULL,
  last_seen_at      TIMESTAMPTZ NOT NULL,
  ended_at          TIMESTAMPTZ,
  duration_ms       INTEGER,
  pageview_count    INTEGER NOT NULL DEFAULT 0,
  is_finished       BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotent upgrades for deployments created before these columns existed.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ip TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS country TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS search_engine TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS search_keywords TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS traffic_source_type TEXT NOT NULL DEFAULT 'direct';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS bot_name TEXT;

CREATE INDEX IF NOT EXISTS idx_sessions_site_started ON sessions (site_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_visitor ON sessions (visitor_id);
CREATE INDEX IF NOT EXISTS idx_sessions_unfinished ON sessions (is_finished, last_seen_at) WHERE is_finished = false;
CREATE INDEX IF NOT EXISTS idx_sessions_traffic_type ON sessions (site_id, traffic_source_type, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_country ON sessions (site_id, country);

-- One row per page viewed inside a session (the "path" the user followed = order these by nav_index)
CREATE TABLE IF NOT EXISTS pageviews (
  id                TEXT PRIMARY KEY,       -- pageviewId generated client-side (uuid)
  session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  site_id           TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  nav_index         INTEGER NOT NULL,       -- 0 = landing page, 1 = next page, etc.
  url               TEXT NOT NULL,
  path              TEXT NOT NULL,
  title             TEXT,
  internal_referrer_path TEXT,              -- previous page inside the same site (the "step before")
  entered_at        TIMESTAMPTZ NOT NULL,
  left_at           TIMESTAMPTZ,
  duration_ms       INTEGER NOT NULL DEFAULT 0,
  max_scroll_percent INTEGER NOT NULL DEFAULT 0,
  content_text      TEXT,                   -- extracted visible text (truncated), for content analysis
  content_word_count INTEGER,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pageviews_session ON pageviews (session_id, nav_index);
CREATE INDEX IF NOT EXISTS idx_pageviews_site_time ON pageviews (site_id, entered_at DESC);
CREATE INDEX IF NOT EXISTS idx_pageviews_path ON pageviews (site_id, path);

-- Time spent per scroll-depth "level" of a page (0-10%, 10-20% ... 90-100%)
CREATE TABLE IF NOT EXISTS scroll_segments (
  pageview_id   TEXT NOT NULL REFERENCES pageviews(id) ON DELETE CASCADE,
  depth_bucket  INTEGER NOT NULL,   -- 0,10,20,...,90 (start of the 10% band)
  time_ms       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (pageview_id, depth_bucket)
);

-- Generic event table for anything else worth tracking (clicks, form submits, custom events)
CREATE TABLE IF NOT EXISTS events (
  id            BIGSERIAL PRIMARY KEY,
  site_id       TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  pageview_id   TEXT REFERENCES pageviews(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  payload       JSONB,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_site_time ON events (site_id, occurred_at DESC);

-- Raw hits reported by the optional server-side middleware (src/server-agent.js).
-- This is how we catch crawlers that never execute JavaScript (GPTBot, CCBot,
-- ClaudeBot, etc.) -- they will never trigger the browser tracker.js beacon.
CREATE TABLE IF NOT EXISTS bot_visits (
  id            BIGSERIAL PRIMARY KEY,
  site_id       TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  bot_name      TEXT NOT NULL,
  traffic_source_type TEXT NOT NULL DEFAULT 'ai_crawler', -- ai_crawler | search_bot
  url           TEXT,
  path          TEXT,
  referrer      TEXT,
  user_agent    TEXT,
  ip            TEXT,
  country       TEXT,
  city          TEXT,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bot_visits_site_time ON bot_visits (site_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_bot_visits_bot_name ON bot_visits (site_id, bot_name, occurred_at DESC);

-- Optional monthly goal for AI-crawler visibility, e.g. "get at least 500
-- AI-crawler hits this month" -- the more legitimate AI crawlers visit and
-- read your content, the more likely your site is to be cited/used by
-- answer engines (ChatGPT, Perplexity, Gemini, etc).
CREATE TABLE IF NOT EXISTS ai_visibility_goals (
  site_id       TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  month         TEXT NOT NULL, -- 'YYYY-MM'
  target_visits INTEGER NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (site_id, month)
);

-- ---------------------------------------------------------------------------
-- SEO (keyword research, rank tracking, competitors). Feature set ported from
-- OpenSEO (github.com/every-app/open-seo, MIT) onto this database: the data
-- comes from DataForSEO, the dashboard (andrho-tracker-dashboard) reads and
-- writes these tables, and src/workers/rankWorker.js checks positions.
-- ---------------------------------------------------------------------------

-- On-page SEO signals the tracker reads from the DOM on every pageview
-- (meta description, h1, canonical, lang, schema.org types, images without
-- alt, link counts). See extractSeo() in public/tracker.js.
ALTER TABLE pageviews ADD COLUMN IF NOT EXISTS seo_meta JSONB;

-- One row per site: what domain to research and in which market.
CREATE TABLE IF NOT EXISTS seo_settings (
  site_id        TEXT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  domain         TEXT NOT NULL,                 -- bare hostname, e.g. "acme.com.gt"
  location_code  INTEGER NOT NULL DEFAULT 2320, -- DataForSEO location (2320 = Guatemala)
  language_code  TEXT NOT NULL DEFAULT 'es',
  device         TEXT NOT NULL DEFAULT 'mobile', -- rank checks: mobile | desktop
  competitors    TEXT[] NOT NULL DEFAULT '{}',   -- competitor domains chosen by the client
  monthly_budget_usd NUMERIC(8,2) NOT NULL DEFAULT 5, -- DataForSEO spend cap for this site
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Keywords the site follows (rank tracking) and where each came from.
CREATE TABLE IF NOT EXISTS seo_keywords (
  id            BIGSERIAL PRIMARY KEY,
  site_id       TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  keyword       TEXT NOT NULL,                  -- normalized: trimmed, lower-case
  source        TEXT NOT NULL DEFAULT 'manual', -- manual | sugerida | posicionada | rastreador
  target_path   TEXT,                           -- page meant to rank for it, if known
  tracked       BOOLEAN NOT NULL DEFAULT true,  -- false = saved but no daily rank check
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_id, keyword)
);

-- Search metrics per keyword and market (shared across sites: it's public data).
CREATE TABLE IF NOT EXISTS seo_keyword_metrics (
  keyword        TEXT NOT NULL,
  location_code  INTEGER NOT NULL,
  language_code  TEXT NOT NULL,
  search_volume  INTEGER,
  cpc            NUMERIC(10,2),
  competition    NUMERIC(5,4),     -- 0-1 paid competition
  difficulty     INTEGER,          -- 0-100 keyword difficulty
  intent         TEXT,             -- informational | commercial | transactional | navigational
  monthly_searches JSONB,          -- [{year, month, search_volume}]
  fetched_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (keyword, location_code, language_code)
);

-- One row per rank check (history => trend charts and the R models).
CREATE TABLE IF NOT EXISTS seo_rank_checks (
  id            BIGSERIAL PRIMARY KEY,
  site_id       TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  keyword       TEXT NOT NULL,
  device        TEXT NOT NULL,
  position      INTEGER,           -- organic position (rank_group); NULL = not in the top `depth`
  url           TEXT,              -- the site's URL that ranked
  serp_features TEXT[] NOT NULL DEFAULT '{}',
  error         TEXT,
  checked_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_seo_rank_checks_kw ON seo_rank_checks (site_id, keyword, checked_at DESC);

-- Cache of DataForSEO responses (keyword ideas, competitors, backlinks...),
-- so reopening a tab doesn't pay again. Keyed by endpoint + request body.
CREATE TABLE IF NOT EXISTS seo_api_cache (
  cache_key     TEXT PRIMARY KEY,
  payload       JSONB NOT NULL,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every paid DataForSEO call, for the per-site monthly budget.
CREATE TABLE IF NOT EXISTS seo_api_usage (
  id            BIGSERIAL PRIMARY KEY,
  site_id       TEXT REFERENCES sites(id) ON DELETE CASCADE,
  endpoint      TEXT NOT NULL,
  cost_usd      NUMERIC(10,5) NOT NULL DEFAULT 0,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_seo_api_usage_site ON seo_api_usage (site_id, occurred_at DESC);
