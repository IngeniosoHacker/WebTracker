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
  ip_hash           TEXT,                   -- hashed IP, never store raw IP
  started_at        TIMESTAMPTZ NOT NULL,
  last_seen_at      TIMESTAMPTZ NOT NULL,
  ended_at          TIMESTAMPTZ,
  duration_ms       INTEGER,
  pageview_count    INTEGER NOT NULL DEFAULT 0,
  is_finished       BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sessions_site_started ON sessions (site_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_visitor ON sessions (visitor_id);
CREATE INDEX IF NOT EXISTS idx_sessions_unfinished ON sessions (is_finished, last_seen_at) WHERE is_finished = false;

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
