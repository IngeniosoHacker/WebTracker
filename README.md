# analytics-tracker

A self-hosted, privacy-conscious website analytics tracker. It captures **full visit
context** (landing page, referrer, UTM parameters), the **navigation path** a visitor
takes through a site, **time spent per page and per scroll-depth level**, **scroll
depth**, and **extracted page content** for later content analysis. It ships as:

1. A **backend service** (Node.js/Express) with a hybrid **Redis + PostgreSQL** storage
   layer, deployable on Railway.
2. A tiny **client script** (`tracker.js`) you drop into any website with a single
   `<script>` tag — it works with static HTML, WordPress, PHP, or any frontend
   framework (React, Vue, Angular, Svelte, etc.) because it doesn't depend on any of
   them.

---

## 1. What it tracks

For every **session** (a visit):
- Landing page (the first page the visitor hit) and its path.
- `document.referrer` (where they came from) and the referrer's domain.
- UTM parameters: `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`
  — so you can tell whether traffic came from Google, DuckDuckGo, a newsletter, an ad
  campaign, etc.
- Device type, browser, OS, user agent.
- A hashed IP (never the raw IP) for de-duplication purposes only.
- Session start/end time and total duration.

For every **pageview** inside that session (the path the user followed):
- URL, path, page title.
- `nav_index` — its order within the session (0 = landing page, 1 = next page...).
- `internal_referrer_path` — the previous page inside the site (so you can reconstruct
  the exact click-path/route the visitor took).
- Time spent on that specific page.
- Max scroll depth reached (%).
- **Time spent at each scroll-depth level** (0–10%, 10–20%, ... 90–100% of the page),
  so you know not just *how far* people scrolled but *how long they stayed* at each
  section/depth.
- **Extracted page content** (visible text from `<main>`/`<article>`/body, scripts and
  boilerplate stripped) plus a word count, so the text of the sections people actually
  read is available for downstream content analysis (topic extraction, readability
  scoring, etc.), without you needing to re-crawl the page later.

Optional: custom events via `atrk('event', 'signup_click', {plan: 'pro'})`, exposed by
the tracker for anything else you want to log (clicks, form submits, conversions).

---

## 2. Architecture

```
┌────────────────────┐      1. beacon (batched JSON)      ┌───────────────────────────┐
│   tracker.js        │ ──────────────────────────────────▶│  Express API  /collect     │
│ (runs in the        │      via fetch(keepalive) or        │                            │
│  visitor's browser)  │      navigator.sendBeacon            │  - validates site           │
└────────────────────┘                                       │  - RPUSH raw event → Redis  │
                                                               └─────────────┬─────────────┘
                                                                             │
                                                        Redis LIST "queue:events"
                                                        (fast, durable-enough buffer)
                                                                             │
                                                          ┌──────────────────▼───────────────────┐
                                                          │  flushWorker (background loop)         │
                                                          │  every FLUSH_INTERVAL_MS:               │
                                                          │  - LPOP a batch                          │
                                                          │  - UPSERT sessions/pageviews/            │
                                                          │    scroll_segments/events into Postgres  │
                                                          └──────────────────┬───────────────────┘
                                                                             │
                                                                     PostgreSQL (durable store)
                                                                             │
                                                          ┌──────────────────▼───────────────────┐
                                                          │  sessionSweeper (background loop)      │
                                                          │  closes sessions idle for               │
                                                          │  SESSION_TIMEOUT_MINUTES using a         │
                                                          │  Redis ZSET of "last active" sessions    │
                                                          └───────────────────────────────────────┘
```

### Why Redis **and** Postgres (hybrid), not Redis alone

You asked to prefer Redis for persistence when it's a good fit. Redis is used here as
a **fast, low-latency ingestion buffer** and for real-time session bookkeeping (the
active-sessions set, used to detect idle/abandoned sessions). But the tracked data
itself — sessions, pageviews, navigation paths, scroll segments, extracted content —
is inherently **relational** (a session has many pageviews, a pageview has many scroll
segments, and you'll want to run ad-hoc SQL/aggregation queries like "average time on
page by URL" or "top landing pages by UTM source"). That's exactly what PostgreSQL is
built for, and it gives you durability that a Redis-only setup would not guarantee
under a restart/eviction. So:

- **Redis** = ingestion buffer (`queue:events` list) + live session activity tracking
  (`sessions:active` ZSET) + safety-net metadata (`session:meta:<id>` hash with a TTL).
  Nothing here is the "source of truth" — it's a fast staging area.
- **PostgreSQL** = the source of truth. All durable analytics data lives here and is
  queryable via the included `/api/*` endpoints (or directly with SQL/BI tools).

This also means the write path (`POST /collect`) is extremely cheap (a Redis `RPUSH`,
sub-millisecond) so it never slows down the pages that embed the tracker, while the
Postgres writes happen asynchronously in the background worker.

---

## 3. How the client script (`tracker.js`) works

- **Identity**: a long-lived `visitorId` (UUID, `localStorage`) and a `sessionId`
  (UUID, `sessionStorage`) that resets after `SESSION_TIMEOUT_MINUTES` of inactivity
  (default 30). This is how sessions/visits are delimited.
- **Landing capture**: on a brand-new session, it records `location.href`,
  `document.referrer`, and every `utm_*` query parameter — this is how you know the
  page that "brought" the visitor and whether it was Google, DuckDuckGo, a campaign
  link, etc.
- **Navigation path**: it hooks `history.pushState`/`replaceState`, `popstate`, and
  `hashchange` so it detects route changes in single-page apps (React Router, Vue
  Router, etc.) as well as regular full-page navigations. Each pageview stores the
  path that led to it (`internal_referrer_path`) and its order (`nav_index`), so the
  full route the visitor took through the site can be reconstructed.
- **Time on page**: measured with `requestAnimationFrame` ticks, paused automatically
  while the tab is hidden (`visibilitychange`), so idle background tabs don't inflate
  the numbers.
- **Scroll depth per level**: the page is divided into ten 10%-bands (0–10%, 10–20%,
  ... 90–100%). As the user scrolls, time is accumulated into whichever band is
  currently in view, so you get "time spent at each depth", not just the max depth
  reached.
- **Content extraction**: on each pageview, it grabs the text inside `<main>` /
  `<article>` / `[role="main"]` (configurable via `data-content-selector`), strips
  `<script>`, `<style>`, `<nav>`, `<header>`, `<footer>`, `<iframe>`, and
  `aria-hidden` elements, and sends the plain text (truncated) plus a word count.
- **Delivery**: events are batched client-side and flushed periodically (heartbeat,
  default every 5s) with `fetch(..., {keepalive:true})`, and on tab close/hide with
  `navigator.sendBeacon` so the last snapshot isn't lost.
- **Zero framework dependency**: it's a single vanilla-JS IIFE. Drop it in any HTML
  document — plain static pages, WordPress, Django/Rails templates, or any JS
  framework's `index.html` — and it works the same way.

### Embedding it in a site

```html
<script src="https://YOUR-TRACKER.up.railway.app/tracker.js"
        data-site-id="my-client-site"
        defer></script>
```

Available `data-*` attributes:

| Attribute | Default | Purpose |
|---|---|---|
| `data-site-id` | `default-site` | Identifies which site/tenant this traffic belongs to |
| `data-api` | script's own origin | Override the API base URL |
| `data-session-timeout` | `30` | Minutes of inactivity before a new session starts |
| `data-flush-interval` | `5000` | Milliseconds between heartbeats |
| `data-content-selector` | `main, article, [role="main"], body` | CSS selector for the content block to extract |
| `data-ingest-key` | *(none)* | Sent as `X-Ingest-Key` header if you set `INGEST_KEY` server-side |

Custom events from your own code, anywhere on the page:

```html
<script>
  document.getElementById('buy-btn').addEventListener('click', function () {
    atrk('event', 'checkout_click', { plan: 'pro' });
  });
</script>
```

Because your client sites and this service will live in the **same Railway
environment**, network latency between them is negligible and you don't need a CDN in
front of `tracker.js` for this stage — Railway serves it directly as a static file
from this same service (`GET /tracker.js`).

---

## 4. Data model (PostgreSQL)

| Table | Purpose |
|---|---|
| `sites` | One row per client site/tenant using the tracker |
| `sessions` | One row per visit: landing page, referrer, UTM, device, timing |
| `pageviews` | One row per page viewed in a session: path, order, duration, max scroll, extracted content |
| `scroll_segments` | Time spent (ms) per 10%-depth band, per pageview |
| `events` | Free-form custom events (clicks, conversions, etc.) |

See [`src/db/schema.sql`](src/db/schema.sql) for the full DDL — it's applied
automatically on deploy (see below).

---

## 5. Querying the data

The service also exposes a small read-only JSON API on top of Postgres:

- `GET /api/sites/:siteId/sessions?limit=50&offset=0` — recent sessions for a site.
- `GET /api/sessions/:sessionId` — full detail of one visit: session info + the
  ordered list of pageviews (the navigation path) + scroll segments per pageview.
- `GET /api/sites/:siteId/top-landing-pages` — most common entry pages.
- `GET /api/sites/:siteId/traffic-sources` — sessions grouped by UTM source/medium
  (or referrer domain when there's no UTM, or "direct").
- `GET /api/sites/:siteId/pages` — per-URL aggregates: pageviews, average time on
  page, average max scroll.
- `GET /api/pageviews/:pageviewId/content` — the extracted text/word count for a
  specific pageview, ready to feed into a content-analysis pipeline (NLP, topic
  modeling, readability, etc.).

These endpoints are intentionally simple; you can also connect any BI tool
(Metabase, Grafana, etc.) directly to the Postgres database Railway provisions.

---

## 6. Deployment on Railway

1. **Push this project to a GitHub repo** (or use `railway up` from this folder).
2. In Railway, create a new project and **deploy from this repo**.
3. **Attach a PostgreSQL plugin** to the project — Railway automatically injects
   `DATABASE_URL` into your service.
4. **Attach a Redis plugin** to the project — Railway automatically injects
   `REDIS_URL` into your service.
5. Set the remaining environment variables on the service (see `.env.example`):
   - `ALLOWED_ORIGINS` — comma-separated list of the exact origins of the sites that
     will embed `tracker.js` (e.g. `https://client-a.up.railway.app,https://client-b.up.railway.app`).
   - `REQUIRE_KNOWN_SITE` — `false` to auto-register any `siteId` the first time it's
     seen (convenient while onboarding clients), `true` once you want to lock it down
     to sites you've explicitly created in the `sites` table.
   - `SESSION_TIMEOUT_MINUTES`, `FLUSH_INTERVAL_MS`, `FLUSH_BATCH_SIZE`,
     `SWEEP_INTERVAL_MS`, `CONTENT_MAX_CHARS` — tune as needed; the defaults in
     `.env.example` are sensible starting points.
   - `INGEST_KEY` — optional shared secret if you want a lightweight write-guard on
     `/collect`.
6. Railway will run `npm install` automatically (Nixpacks). The **start command**
   (already set in `railway.json`) runs the migration and then starts the server:
   ```
   node src/db/migrate.js && node src/server.js
   ```
   This means the schema is created/updated automatically on every deploy — no manual
   migration step required.
7. Once deployed, your tracker endpoint is:
   `https://<your-service>.up.railway.app`
   and the embeddable script is:
   `https://<your-service>.up.railway.app/tracker.js`
8. On each client site (deployed in the same Railway environment), add:
   ```html
   <script src="https://<your-service>.up.railway.app/tracker.js"
           data-site-id="<a-slug-for-that-site>" defer></script>
   ```

### Running locally

```bash
cp .env.example .env
# fill DATABASE_URL / REDIS_URL with local or Railway-provided connection strings
npm install
npm run migrate
npm start
# Health check:
curl localhost:3000/health
```

---

## 7. Security & privacy notes

- Raw IP addresses are never stored — only a salted SHA-256 hash (`ip_hash`), useful
  for rough de-duplication but not reversible to the original IP.
- `ALLOWED_ORIGINS` enforces CORS so only your own sites can send data to the
  collector.
- `REQUIRE_KNOWN_SITE=true` + manually inserting rows into `sites` lets you lock down
  which `siteId`s are accepted once you're past the onboarding stage.
- The optional `INGEST_KEY` adds a shared-secret header check on `/collect`; it's a
  light deterrent, not a full auth system — combine it with `ALLOWED_ORIGINS` for
  real protection.
- No third-party scripts or cookies are used by `tracker.js` — identity relies on
  `localStorage`/`sessionStorage` only.

---

## 8. Known limitations / possible next steps

- There's no built-in dashboard UI yet — the `/api/*` endpoints return JSON meant to
  power one (or to plug into an existing BI tool). Building a small dashboard on top
  is a natural next step.
- Geolocation (country/city) is not resolved from IP in this version — it can be
  added by looking up `ip_hash`'s source IP *before* hashing it, against a local
  MaxMind-style database, if needed.
- Bot/crawler filtering is not implemented; add a `robots`/user-agent filter in
  `src/routes/collect.js` if bot traffic pollutes your metrics.
- `replaceState` is currently treated the same as a real navigation for SPA
  compatibility; if a specific frontend uses `replaceState` for non-navigational
  updates, adjust `onRouteChange()` in `public/tracker.js` accordingly.
