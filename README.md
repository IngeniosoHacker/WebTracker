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
- **IP address, country, and city** (resolved offline from the IP, no external API
  calls — see [§3](#3-geolocation-ip-country-city) for precision notes and privacy
  considerations).
- **Search keywords**, when the search engine still passes them in the referrer (see
  the caveat in [§5](#5-search-keywords-what-you-can-and-cant-get)).
- **Traffic source type** — one of `direct`, `referral`, `organic_search`,
  `ai_referral` (a human arrived via a link from ChatGPT/Perplexity/Gemini/etc.), or
  `ai_crawler` (an AI agent browsing with a real JS-executing browser, e.g. an
  "Operator"-style agent) — see [§6](#6-ai-visibility-tracking-ai-crawlers-and-ai-referral-traffic).
- Device type, browser, OS, user agent.
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
┌────────────────────┐   1. JS beacon (batched)   ┌───────────────────────────┐
│   tracker.js         │ ──────────────────────────▶│  Express API  /collect     │
│ (runs in a browser   │  fetch(keepalive) /          │  - validates site           │
│  that executes JS)    │  navigator.sendBeacon         │  - classifies traffic type   │
└────────────────────┘                                │    (human/ai_referral/...)    │
                                                        │  - resolves IP → geo           │
┌────────────────────┐   2. raw request info      │  - RPUSH raw event → Redis       │
│  server-agent.js     │ ──────────────────────────▶│                                    │
│ (runs on YOUR OWN     │  POST /collect/server        └─────────────┬─────────────────┘
│  backend, sees EVERY   │  (only when UA looks like                 │
│  request incl. bots   │   a bot -- see §6)                Redis LIST "queue:events"
│  that never run JS)   │                                    (fast, durable-enough buffer)
└────────────────────┘                                                │
                                                          ┌──────────────────▼───────────────────┐
                                                          │  flushWorker (background loop)         │
                                                          │  every FLUSH_INTERVAL_MS:               │
                                                          │  - LPOP a batch                          │
                                                          │  - UPSERT sessions/pageviews/            │
                                                          │    scroll_segments/events/bot_visits     │
                                                          │    into Postgres                          │
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

## 3. Geolocation (IP, country, city)

Every session stores the visitor's IP plus `country` and `city`, resolved **offline**
via [`geoip-lite`](https://www.npmjs.com/package/geoip-lite) — no external API calls,
no API key, no added latency. Trade-offs to know about:

- Country-level accuracy is good. City-level accuracy is best-effort: the free
  bundled database sometimes returns an empty city, or the nearest large city
  rather than the exact one, especially for mobile/carrier IPs.
- If you need block-level precision, swap `src/lib/geo.js` for the MaxMind
  GeoLite2-City database with a (free) license key — it's a small, self-contained
  change since `geo.lookup(ip)` is the only function the rest of the app calls.
- Localhost/private IPs resolve to `null` (there's nothing to geolocate).

**Privacy note:** raw IPs are now stored (`sessions.ip`, `bot_visits.ip`) as requested,
in addition to the existing salted hash (`ip_hash`) kept for backward-compatible
de-duplication. Raw IPs are personal data in many jurisdictions (e.g. under GDPR-style
regimes) — if any of your clients' visitors are outside the country you mentioned, or
you're unsure, consider setting `STORE_RAW_IP=false` (country/city are still resolved
and stored either way; only the raw address itself is dropped) and/or documenting this
in your clients' privacy policies.

---

## 4. Detecting AI crawlers with no JavaScript execution (`server-agent.js`)

This is the important nuance: **most AI/LLM crawlers never run JavaScript.** GPTBot,
ClaudeBot, CCBot, PerplexityBot, Bytespider, etc. do a single plain HTTP `GET` of the
page and move on — they don't execute `tracker.js`, so the browser-based tracker alone
will never see them, no matter how it's configured.

To catch these, add the small `server-agent.js` file to **your own site's backend**
(the Node/Express/Next.js app that actually serves the HTML — not this analytics
service). It inspects the raw incoming request (User-Agent, referrer, IP) *before* any
JS is involved, and — only when the User-Agent looks like a bot — fires a
non-blocking report to this service's `POST /collect/server` endpoint. Regular human
traffic is never reported this way (it's already fully covered by `tracker.js`), so
this adds effectively zero overhead to normal page loads.

```bash
curl -O https://YOUR-TRACKER.up.railway.app/server-agent.js
```

Express usage:

```js
const { expressServerAgent } = require('./server-agent');

app.use(expressServerAgent({
  siteId: 'my-client-site',
  apiBase: 'https://YOUR-TRACKER.up.railway.app'
}));
```

Any other Node-based framework (Next.js middleware, Fastify hook, plain `http`
server): call `reportIfBot({ siteId, apiBase, url, userAgent, referrer, ip })` with
values read from the raw request inside your own request handler — see the
comment block at the top of `public/server-agent.js` for a generic example.

If a client's site isn't backed by a Node server you control (fully static hosting,
a proxy/CDN you don't control, etc.), this particular mechanism can't be installed —
in that case the honest answer is that this system will only see AI traffic that
*does* run a real browser (agentic "browsing" AI products) or that clicks through
from an AI chat product as a normal visitor (`ai_referral`, see §6); pure silent
crawler visits won't be captured without some form of server-side/log-level
visibility into that site's requests.

---

## 5. Search keywords: what you can (and can't) get

`search_keywords` is populated by parsing the query parameter search engines put in
the referrer URL (`q=` for Google/Bing/DuckDuckGo, `p=` for Yahoo, `text=` for Yandex,
`wd=` for Baidu). Be aware of a well-known industry-wide limitation, not specific to
this tool: **since around 2011, Google (and most major engines) stopped passing
the search query in the referrer for regular organic results** for logged-in/HTTPS
traffic — Google Analytics famously calls this bucket "(not provided)". In practice:

- **Paid search / ads** often still carry the term via `utm_term` — already captured.
- **Some other engines/contexts** (certain regional engines, some in-app search
  browsers) still pass the query — `search_keywords` will be populated when they do.
- **Organic Google/Bing traffic will mostly show `search_keywords = null`.** This is
  expected and not a bug in the tracker; `GET /api/sites/:siteId/search-keywords`
  falls back to `utm_term` and then to `(not provided)` for transparency, mirroring
  how GA has always reported this.

---

## 6. AI-visibility tracking (AI crawlers and AI-referral traffic)

We're in a period where AI answer engines (ChatGPT, Perplexity, Gemini, Copilot...)
both **crawl** websites to build their knowledge/retrieval indexes and **cite/link**
to them in conversations with real users. This tracker treats "being visited/read by
AI" as a metric you actively want to **grow**, not filter out — the opposite instinct
from traditional bot-blocking analytics.

Every visit gets classified into a `traffic_source_type`:

| Type | Meaning | How it's captured |
|---|---|---|
| `ai_crawler` | A known AI/LLM crawler (GPTBot, ClaudeBot, PerplexityBot, CCBot, Google-Extended, Bytespider, etc.) fetched a page to read/train/index it | `server-agent.js` on your backend (§4) for non-JS bots, or the JS beacon if the "bot" is actually an agentic browser that runs JS |
| `ai_referral` | A real human clicked a link from an AI chat product (chatgpt.com, perplexity.ai, gemini.google.com, claude.ai, copilot, poe.com, you.com, character.ai, meta.ai) | `tracker.js`, via `document.referrer` |
| `search_bot` | A traditional (non-AI) search engine crawler (Googlebot, Bingbot...) | same as `ai_crawler` |
| `organic_search` | A human arrived from a search engine's results page | `tracker.js` |
| `direct` / `referral` | No referrer, or referrer is some other regular website | `tracker.js` |

The full list of recognized bots/products lives in [`src/lib/detect.js`](src/lib/detect.js)
— it's a plain list of regexes/domains, easy to extend as new crawlers show up (this
space moves fast; expect to add names over time).

### Dashboard endpoint + monthly goal

```
GET /api/sites/:siteId/ai-visibility?month=2026-07
```

Returns, for the given month: total AI-crawler hits broken down by bot name, total
AI-referral sessions broken down by product (ChatGPT, Perplexity...), a daily trend,
and progress against a monthly goal if you've set one:

```json
{
  "month": "2026-07",
  "aiCrawlerHits": { "total": 128, "byBot": [{ "botName": "GPTBot", "hits": 64 }, ...] },
  "aiReferralTraffic": { "total": 12, "byProduct": [{ "ai_product": "chatgpt", "sessions": 9 }, ...] },
  "dailyTrend": [{ "day": "2026-07-01", "hits": 4 }, ...],
  "goal": { "targetVisits": 500, "achieved": 128, "progressPercent": 26 }
}
```

Set a monthly target ("get at least N legitimate AI-crawler hits this month" — a
reasonable proxy KPI for "is our content visible to answer engines"):

```
POST /api/sites/:siteId/ai-goal
{ "month": "2026-07", "targetVisits": 500 }
```

```
GET /api/sites/:siteId/ai-goal?month=2026-07
```

---

## 7. How the client script (`tracker.js`) works

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

## 8. Data model (PostgreSQL)

| Table | Purpose |
|---|---|
| `sites` | One row per client site/tenant using the tracker |
| `sessions` | One row per visit: landing page, referrer, UTM, IP/geo, search keywords, AI traffic classification, device, timing |
| `pageviews` | One row per page viewed in a session: path, order, duration, max scroll, extracted content |
| `scroll_segments` | Time spent (ms) per 10%-depth band, per pageview |
| `events` | Free-form custom events (clicks, conversions, etc.) |
| `bot_visits` | Raw hits from AI/search crawlers reported by `server-agent.js` (bots that never run JS) |
| `ai_visibility_goals` | Optional monthly target for AI-crawler hits per site |

See [`src/db/schema.sql`](src/db/schema.sql) for the full DDL — it's applied
automatically on deploy (see below).

---

## 9. Querying the data

The service also exposes a small read-only JSON API on top of Postgres:

- `GET /api/sites/:siteId/sessions?limit=50&offset=0` — recent sessions for a site
  (now includes IP, country, city, search engine/keywords, traffic source type, bot name).
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
- `GET /api/sites/:siteId/geo` — sessions grouped by country/city.
- `GET /api/sites/:siteId/search-keywords` — top organic search keywords (see §5 for
  the "(not provided)" caveat).
- `GET /api/sites/:siteId/ai-visibility?month=YYYY-MM` — AI-crawler and AI-referral
  metrics plus goal progress (see §6).
- `GET` / `POST /api/sites/:siteId/ai-goal` — read/set the monthly AI-crawler target.

These endpoints are intentionally simple; you can also connect any BI tool
(Metabase, Grafana, etc.) directly to the Postgres database Railway provisions.

---

## 10. Deployment on Railway

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
   - `STORE_RAW_IP` — `true` by default; set `false` to keep only the salted hash
     (country/city are resolved and stored regardless of this setting).
6. Railway will run `npm install` automatically (Nixpacks). The **start command**
   (already set in `railway.json`) runs the migration and then starts the server:
   ```
   node src/db/migrate.js && node src/server.js
   ```
   This means the schema is created/updated automatically on every deploy (including
   picking up new columns/tables when you update this project) — no manual migration
   step required.
7. Once deployed, your tracker endpoint is:
   `https://<your-service>.up.railway.app`
   with two embeddable pieces:
   - Browser tracker: `https://<your-service>.up.railway.app/tracker.js`
   - Server-side AI-crawler agent: `https://<your-service>.up.railway.app/server-agent.js`
8. On each client site (deployed in the same Railway environment), add the browser
   tracker:
   ```html
   <script src="https://<your-service>.up.railway.app/tracker.js"
           data-site-id="<a-slug-for-that-site>" defer></script>
   ```
   and, if that client's site has a Node backend you control, also add the
   server-agent middleware (see §4) so AI crawlers that never run JS are captured
   too.

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

## 11. Security & privacy notes

- Raw IP addresses **are** stored (`STORE_RAW_IP=true` by default), alongside a salted
  SHA-256 hash (`ip_hash`) kept for backward-compatible de-duplication. See §3 for the
  privacy considerations of storing raw IPs and how to disable it.
- `ALLOWED_ORIGINS` enforces CORS so only your own sites can send data to the
  collector.
- `REQUIRE_KNOWN_SITE=true` + manually inserting rows into `sites` lets you lock down
  which `siteId`s are accepted once you're past the onboarding stage.
- The optional `INGEST_KEY` adds a shared-secret header check on `/collect`; it's a
  light deterrent, not a full auth system — combine it with `ALLOWED_ORIGINS` for
  real protection.
- No third-party scripts or cookies are used by `tracker.js` — identity relies on
  `localStorage`/`sessionStorage` only.
- The `/api/*` read endpoints and `/api/sites/:siteId/ai-goal` POST are not
  authenticated in this version — they're meant to be called from a trusted internal
  dashboard/BI tool. Put them behind your own auth layer (or Railway private
  networking) before exposing them publicly.

---

## 12. Known limitations / possible next steps

- There's no built-in dashboard UI yet — the `/api/*` endpoints return JSON meant to
  power one (or to plug into an existing BI tool). Building a small dashboard on top
  is a natural next step (the `/ai-visibility` endpoint in particular is designed to
  drive a "goal progress" widget).
- City-level geolocation precision is limited with the free offline database (see §3).
- The recognized AI-crawler/bot list (`src/lib/detect.js`) is a snapshot in time —
  new AI crawlers appear regularly, so plan to revisit and extend that list
  periodically.
- `server-agent.js` (§4) requires a Node backend you control on the client's site; it
  can't be installed on fully static hosting with no controllable server layer.
- `replaceState` is currently treated the same as a real navigation for SPA
  compatibility; if a specific frontend uses `replaceState` for non-navigational
  updates, adjust `onRouteChange()` in `public/tracker.js` accordingly.
