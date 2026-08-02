/*!
 * analytics-tracker server-agent
 * ------------------------------------------------------------------------
 * Client-side JS (tracker.js) can only see visitors whose browser executes
 * JavaScript. Most AI/LLM crawlers (GPTBot, ClaudeBot, CCBot, PerplexityBot...)
 * do a single plain HTTP GET and never run JS, so tracker.js never sees them.
 *
 * This file runs on YOUR OWN backend (Node/Express, Next.js, Fastify, etc.)
 * and inspects every real incoming request BEFORE any JS is involved. When it
 * looks like an AI/search crawler, it fires a lightweight, non-blocking report
 * to the analytics-tracker service so those hits show up in your AI-visibility
 * metrics.
 *
 * It never blocks or slows down the response to the real request/crawler.
 *
 * ---------------------------------------------------------------------------
 * Express usage:
 *
 *   const { expressServerAgent } = require('./server-agent');
 *   app.use(expressServerAgent({
 *     siteId: 'my-site',
 *     apiBase: 'https://your-tracker.up.railway.app'
 *   }));
 *
 * Generic usage (any Node framework / custom server):
 *
 *   const { reportIfBot } = require('./server-agent');
 *   // inside your request handler, given the raw incoming request:
 *   reportIfBot({
 *     siteId: 'my-site',
 *     apiBase: 'https://your-tracker.up.railway.app',
 *     url: req.url,
 *     userAgent: req.headers['user-agent'],
 *     referrer: req.headers['referer'] || req.headers['referrer'],
 *     ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress
 *   });
 * ---------------------------------------------------------------------------
 */
'use strict';

// A compact, local pre-filter so we don't fire a network call on every single
// human page load (tracker.js already covers those). The tracker server does
// the authoritative classification again on arrival, so false positives here
// are harmless -- this is just a cheap "is it worth reporting?" gate.
const LIKELY_BOT_RE = new RegExp(
  [
    'GPTBot', 'ChatGPT-User', 'OAI-SearchBot',
    'ClaudeBot', 'Claude-User', 'Claude-SearchBot', 'anthropic-ai',
    'PerplexityBot', 'Perplexity-User',
    'Google-Extended', 'GoogleOther', 'Googlebot',
    'Applebot-Extended', 'Bytespider', 'CCBot', 'Diffbot', 'Amazonbot',
    'cohere-ai', 'Meta-ExternalAgent', 'Meta-ExternalFetcher', 'YouBot',
    'Timpibot', 'ImagesiftBot', 'Omgili', 'MistralAI-User', 'DuckAssistBot',
    'AI2Bot', 'GeminiBot', 'bingbot', 'YandexBot', 'Baiduspider',
    'DuckDuckBot', 'Slurp', 'bot', 'crawler', 'spider'
  ].join('|'),
  'i'
);

// Static assets rarely matter for "was my content read by an AI crawler?"
const IGNORED_EXT_RE = /\.(css|js|png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf|map|json)(\?|$)/i;

function reportIfBot(opts) {
  try {
    const { siteId, apiBase, url, userAgent, referrer, ip, timeoutMs } = opts;
    if (!siteId || !apiBase || !userAgent) return;
    if (url && IGNORED_EXT_RE.test(url)) return;
    if (!LIKELY_BOT_RE.test(userAgent)) return;

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs || 2000) : null;

    fetch(apiBase.replace(/\/$/, '') + '/collect/server', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteId, url, referrer: referrer || null, userAgent, ip: ip || null }),
      signal: controller ? controller.signal : undefined
    })
      .catch(() => { /* never let reporting errors affect the real request */ })
      .finally(() => { if (timer) clearTimeout(timer); });
  } catch {
    // swallow everything -- this must never throw in the caller's request path
  }
}

function expressServerAgent(config) {
  return function analyticsServerAgent(req, res, next) {
    reportIfBot({
      siteId: config.siteId,
      apiBase: config.apiBase,
      url: req.originalUrl || req.url,
      userAgent: req.headers['user-agent'],
      referrer: req.headers['referer'] || req.headers['referrer'],
      ip: (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress
    });
    next();
  };
}

module.exports = { reportIfBot, expressServerAgent };
