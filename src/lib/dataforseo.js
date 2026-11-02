// DataForSEO client: the data source behind keyword research, rank tracking,
// competitors and backlinks. Ported from OpenSEO's TypeScript client
// (github.com/every-app/open-seo, src/server/lib/dataforseo/*, MIT) to plain
// CommonJS, minus its Cloudflare/billing layers, plus what AndRho needs:
//
//   - a monthly spend cap per site (seo_settings.monthly_budget_usd), checked
//     before every call against what seo_api_usage says was spent;
//   - every call's real cost (DataForSEO returns it) logged in seo_api_usage;
//   - cached() to keep responses in seo_api_cache for a TTL.
//
// This file is shipped identically in WebTracker (rank worker) and in
// andrho-tracker-dashboard (research endpoints). Keep both copies in sync.
//
// Credentials: DATAFORSEO_API_KEY (the "Base64" value from DataForSEO's API
// Access page, i.e. base64("login:password")), or DATAFORSEO_LOGIN +
// DATAFORSEO_PASSWORD. DATAFORSEO_BASE_URL overrides the host, e.g.
// https://sandbox.dataforseo.com for free fake data while developing.
'use strict';

const crypto = require('crypto');

const TIMEOUT_MS = 60000;
const MAX_RETRIES = 2;
const OK = 20000;
const NO_RESULTS = 40501;

class SeoError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code; // not_configured | budget | upstream | auth | rate_limited
    this.status = status || 502;
  }
}

function baseUrl() {
  return (process.env.DATAFORSEO_BASE_URL || 'https://api.dataforseo.com').replace(/\/+$/, '');
}

function authHeader() {
  if (process.env.DATAFORSEO_API_KEY) return `Basic ${process.env.DATAFORSEO_API_KEY.trim()}`;
  const { DATAFORSEO_LOGIN: login, DATAFORSEO_PASSWORD: pass } = process.env;
  if (login && pass) return `Basic ${Buffer.from(`${login}:${pass}`).toString('base64')}`;
  return null;
}

function isConfigured() { return Boolean(authHeader()); }

// What the site has spent this calendar month and what it may spend.
async function budgetFor(pool, siteId) {
  const { rows } = await pool.query(
    `SELECT COALESCE((SELECT monthly_budget_usd FROM seo_settings WHERE site_id = $1), 5)::float AS budget,
            COALESCE((SELECT SUM(cost_usd) FROM seo_api_usage
                      WHERE site_id = $1 AND occurred_at >= date_trunc('month', now())), 0)::float AS spent`,
    [siteId]
  );
  return rows[0];
}

/**
 * POSTs one task to a DataForSEO "live" endpoint and returns that task's
 * `result` array. ctx = { pool, siteId } for the budget and usage log.
 */
async function post(path, task, ctx) {
  const auth = authHeader();
  if (!auth) throw new SeoError('not_configured', 'DataForSEO no está configurado (DATAFORSEO_API_KEY).', 503);
  if (ctx && ctx.pool && ctx.siteId) {
    const b = await budgetFor(ctx.pool, ctx.siteId);
    if (b.spent >= b.budget) {
      throw new SeoError('budget', `Se alcanzó el presupuesto SEO del mes (US$${b.budget.toFixed(2)}).`, 429);
    }
  }

  let res;
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(baseUrl() + path, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify([task]),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
    } catch (err) {
      throw new SeoError('upstream', `DataForSEO no respondió (${err.name === 'TimeoutError' ? 'tiempo agotado' : err.message}).`);
    }
    if (res.status >= 500 && attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
      continue;
    }
    break;
  }
  if (res.status === 401 || res.status === 403) throw new SeoError('auth', 'Credenciales de DataForSEO inválidas.', 502);
  if (res.status === 429) throw new SeoError('rate_limited', 'DataForSEO limitó las solicitudes; intenta en un minuto.', 429);
  if (!res.ok) throw new SeoError('upstream', `DataForSEO HTTP ${res.status} en ${path}`);

  const body = await res.json();
  const t = body && Array.isArray(body.tasks) ? body.tasks[0] : null;
  const cost = Number((t && t.cost) || body.cost || 0);
  if (ctx && ctx.pool && cost > 0) {
    await ctx.pool.query('INSERT INTO seo_api_usage (site_id, endpoint, cost_usd) VALUES ($1, $2, $3)',
      [ctx.siteId || null, path, cost]).catch(() => {});
  }
  if (body.status_code !== OK) throw new SeoError('upstream', `DataForSEO: ${body.status_message || body.status_code}`);
  if (!t) throw new SeoError('upstream', 'DataForSEO devolvió una respuesta sin tareas.');
  if (t.status_code === NO_RESULTS) return [];
  if (t.status_code !== OK) {
    if (t.status_code === 40200 || t.status_code === 40210) throw new SeoError('budget', 'La cuenta de DataForSEO no tiene saldo.', 402);
    throw new SeoError('upstream', `DataForSEO: ${t.status_message || t.status_code}`);
  }
  return t.result || [];
}

const firstItems = (result) => (result[0] && result[0].items) || [];

// Keeps a response in seo_api_cache for ttlHours, keyed by name + params.
async function cached(pool, name, params, ttlHours, fn) {
  const key = name + ':' + crypto.createHash('sha1').update(JSON.stringify(params)).digest('hex');
  const { rows } = await pool.query(
    `SELECT payload, fetched_at FROM seo_api_cache WHERE cache_key = $1 AND fetched_at > now() - make_interval(hours => $2)`,
    [key, ttlHours]
  );
  if (rows.length) return { data: rows[0].payload, fetchedAt: rows[0].fetched_at, cached: true };
  const data = await fn();
  await pool.query(
    `INSERT INTO seo_api_cache (cache_key, payload, fetched_at) VALUES ($1, $2, now())
     ON CONFLICT (cache_key) DO UPDATE SET payload = EXCLUDED.payload, fetched_at = now()`,
    [key, JSON.stringify(data)]
  );
  return { data, fetchedAt: new Date(), cached: false };
}

// ---------------------------------------------------------------------------
// Normalizers (the wire nulls any field; the app reads these shapes only)
// ---------------------------------------------------------------------------

function normalizeIntent(raw) {
  const v = String(raw || '').toLowerCase();
  if (v.includes('inform')) return 'informational';
  if (v.includes('commerc')) return 'commercial';
  if (v.includes('transact')) return 'transactional';
  if (v.includes('navig')) return 'navigational';
  return null;
}

const normalizeKeyword = (k) => String(k || '').trim().toLowerCase().replace(/\s+/g, ' ');

function keywordRow(item) {
  if (!item) return null;
  const info = item.keyword_info || {};
  const keyword = normalizeKeyword(item.keyword);
  if (!keyword) return null;
  return {
    keyword,
    searchVolume: info.search_volume ?? null,
    cpc: info.cpc ?? null,
    competition: info.competition ?? null,
    difficulty: (item.keyword_properties && item.keyword_properties.keyword_difficulty) ?? null,
    intent: normalizeIntent(item.search_intent_info && item.search_intent_info.main_intent),
    monthlySearches: (info.monthly_searches || []).map((m) => ({ year: m.year, month: m.month, volume: m.search_volume ?? null }))
  };
}

const market = (s) => ({ location_code: s.locationCode, language_code: s.languageCode });

// ---------------------------------------------------------------------------
// Labs: keyword research
// ---------------------------------------------------------------------------

async function keywordSuggestions(s, keyword, limit, ctx) {
  const r = await post('/v3/dataforseo_labs/google/keyword_suggestions/live', {
    keyword, ...market(s), limit, include_seed_keyword: true, include_serp_info: false, exact_match: false
  }, ctx);
  return firstItems(r).map(keywordRow).filter(Boolean);
}

async function relatedKeywords(s, keyword, limit, ctx) {
  const r = await post('/v3/dataforseo_labs/google/related_keywords/live', {
    keyword, ...market(s), limit, depth: 2, include_serp_info: false
  }, ctx);
  return firstItems(r).map((i) => keywordRow(i.keyword_data)).filter(Boolean);
}

async function keywordIdeas(s, keywords, limit, ctx) {
  const r = await post('/v3/dataforseo_labs/google/keyword_ideas/live', {
    keywords: keywords.slice(0, 200), ...market(s), limit, include_serp_info: false, closely_variants: false
  }, ctx);
  return firstItems(r).map(keywordRow).filter(Boolean);
}

async function keywordOverview(s, keywords, ctx) {
  if (!keywords.length) return [];
  const r = await post('/v3/dataforseo_labs/google/keyword_overview/live', {
    keywords: keywords.slice(0, 700), ...market(s)
  }, ctx);
  return firstItems(r).map(keywordRow).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Labs: domains (what a domain ranks for, its competitors, the gap)
// ---------------------------------------------------------------------------

function rankedRow(item) {
  const kd = item.keyword_data || {};
  const el = item.ranked_serp_element || {};
  const serp = el.serp_item || {};
  const base = keywordRow(kd);
  if (!base) return null;
  return Object.assign(base, {
    position: serp.rank_group ?? serp.rank_absolute ?? el.rank_absolute ?? null,
    url: serp.url || el.url || null,
    path: serp.relative_url || el.relative_url || null,
    etv: serp.etv ?? el.etv ?? null
  });
}

async function rankedKeywords(s, target, limit, ctx) {
  const r = await post('/v3/dataforseo_labs/google/ranked_keywords/live', {
    target, ...market(s), limit, item_types: ['organic'], order_by: ['keyword_data.keyword_info.search_volume,desc']
  }, ctx);
  return { total: (r[0] && r[0].total_count) || 0, items: firstItems(r).map(rankedRow).filter(Boolean) };
}

async function domainOverview(s, target, ctx) {
  const r = await post('/v3/dataforseo_labs/google/domain_rank_overview/live', { target, ...market(s), limit: 1 }, ctx);
  const m = (firstItems(r)[0] || {}).metrics || {};
  const o = m.organic || {};
  return {
    organicKeywords: o.count ?? 0,
    organicTraffic: o.etv ?? 0,
    top3: (o.pos_1 || 0) + (o.pos_2_3 || 0),
    top10: (o.pos_1 || 0) + (o.pos_2_3 || 0) + (o.pos_4_10 || 0),
    top20: (o.pos_1 || 0) + (o.pos_2_3 || 0) + (o.pos_4_10 || 0) + (o.pos_11_20 || 0),
    newKeywords: o.is_new ?? 0,
    lostKeywords: o.is_lost ?? 0,
    upKeywords: o.is_up ?? 0,
    downKeywords: o.is_down ?? 0
  };
}

// Organic competitors of a domain: who ranks for the same keywords.
async function competitorsDomain(s, target, limit, ctx) {
  const r = await post('/v3/dataforseo_labs/google/competitors_domain/live', {
    target, ...market(s), limit: limit + 1, item_types: ['organic'], exclude_top_domains: true
  }, ctx);
  return firstItems(r)
    .filter((i) => i.domain && i.domain !== target)
    .slice(0, limit)
    .map((i) => {
      const o = (i.full_domain_metrics && i.full_domain_metrics.organic) || (i.metrics && i.metrics.organic) || {};
      return {
        domain: i.domain,
        avgPosition: i.avg_position ?? null,
        intersections: i.intersections ?? 0,
        organicKeywords: o.count ?? null,
        organicTraffic: o.etv ?? null
      };
    });
}

// Keywords `competitor` ranks for in the top 20 and `target` doesn't rank for
// at all: the keyword gap.
async function keywordGap(s, target, competitor, limit, ctx) {
  const r = await post('/v3/dataforseo_labs/google/domain_intersection/live', {
    target1: competitor, target2: target, ...market(s), limit,
    intersections: false, item_types: ['organic'],
    filters: [['first_domain_serp_element.rank_group', '<=', 20]],
    order_by: ['keyword_data.keyword_info.search_volume,desc']
  }, ctx);
  return firstItems(r).map((i) => {
    const row = keywordRow(i.keyword_data);
    if (!row) return null;
    const el = i.first_domain_serp_element || {};
    return Object.assign(row, { competitor, competitorPosition: el.rank_group ?? null, competitorUrl: el.url || null });
  }).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Backlinks
// ---------------------------------------------------------------------------

async function backlinksSummary(target, ctx) {
  const r = await post('/v3/backlinks/summary/live', { target, include_subdomains: true }, ctx);
  const d = r[0] || {};
  return {
    rank: d.rank ?? null,
    backlinks: d.backlinks ?? 0,
    referringDomains: d.referring_domains ?? 0,
    referringDomainsNofollow: d.referring_domains_nofollow ?? 0,
    brokenBacklinks: d.broken_backlinks ?? 0,
    spamScore: d.backlinks_spam_score ?? null,
    firstSeen: d.first_seen || null
  };
}

async function referringDomains(target, limit, ctx) {
  const r = await post('/v3/backlinks/referring_domains/live', {
    target, limit, include_subdomains: true, order_by: ['rank,desc'], exclude_internal_backlinks: true
  }, ctx);
  return firstItems(r).map((i) => ({
    domain: i.domain, rank: i.rank ?? null, backlinks: i.backlinks ?? 0,
    firstSeen: i.first_seen || null
  }));
}

// ---------------------------------------------------------------------------
// SERP: where `domain` ranks for `keyword` today (rank tracking)
// ---------------------------------------------------------------------------

async function rankCheck(s, keyword, domain, device, ctx) {
  const target = String(domain).toLowerCase().replace(/^www\./, '');
  const r = await post('/v3/serp/google/organic/live/advanced', {
    keyword, ...market(s), device, os: device === 'desktop' ? 'windows' : 'android', depth: 100,
    stop_crawl_on_match: [{ match_value: target, match_type: 'with_subdomains' }],
    find_targets_in: ['organic']
  }, ctx);
  const items = firstItems(r);
  const match = items.find((i) => {
    if (i.type !== 'organic' || !i.domain) return false;
    const d = i.domain.toLowerCase().replace(/^www\./, '');
    return d === target || d.endsWith('.' + target);
  });
  return {
    // rank_group = position among organic results (what people call "my rank");
    // rank_absolute would count SERP features too (OpenSEO does the same).
    position: match ? (match.rank_group ?? match.rank_absolute ?? null) : null,
    url: match ? match.url : null,
    serpFeatures: [...new Set(items.map((i) => i.type).filter(Boolean))]
  };
}

module.exports = {
  SeoError, isConfigured, budgetFor, post, cached, normalizeKeyword, normalizeIntent,
  keywordSuggestions, relatedKeywords, keywordIdeas, keywordOverview,
  rankedKeywords, domainOverview, competitorsDomain, keywordGap,
  backlinksSummary, referringDomains, rankCheck
};
