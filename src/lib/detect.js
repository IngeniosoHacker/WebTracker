'use strict';

/**
 * Classifies incoming traffic into a `trafficSourceType` plus extra detail
 * (bot name, search engine, search keywords). Used both by:
 *  - POST /collect        (browser-executed JS beacons; catches AI agents that
 *                           DO run a real browser, e.g. "ChatGPT-User" browsing
 *                           actions, Perplexity's browser, computer-use agents)
 *  - POST /collect/server  (raw server-side request logging; catches crawlers
 *                           that fetch HTML only and never run JavaScript,
 *                           e.g. GPTBot, CCBot, ClaudeBot)
 *
 * trafficSourceType values:
 *   ai_crawler      -> a known AI/LLM crawler fetched the page (no human involved)
 *   ai_referral     -> a real visitor arrived by clicking a link from an AI
 *                      answer engine / chat product (ChatGPT, Perplexity, Gemini...)
 *   search_bot      -> a traditional (non-AI) search engine crawler (Googlebot, Bingbot)
 *   organic_search   -> a real visitor arrived from a traditional search engine SERP
 *   direct          -> no referrer at all
 *   referral        -> a real visitor arrived from some other website
 */

// --- Known AI / LLM crawlers -------------------------------------------------
// These fetch pages to train models or to answer a live user question via RAG.
// This is the metric you want to track and grow ("AI visibility").
const AI_CRAWLERS = [
  { name: 'GPTBot', re: /GPTBot/i },
  { name: 'ChatGPT-User', re: /ChatGPT-User/i },
  { name: 'OAI-SearchBot', re: /OAI-SearchBot/i },
  { name: 'ClaudeBot', re: /ClaudeBot/i },
  { name: 'Claude-User', re: /Claude-User|Claude-SearchBot/i },
  { name: 'anthropic-ai', re: /anthropic-ai/i },
  { name: 'PerplexityBot', re: /PerplexityBot/i },
  { name: 'Perplexity-User', re: /Perplexity-User/i },
  { name: 'Google-Extended', re: /Google-Extended/i },
  { name: 'GoogleOther', re: /GoogleOther/i },
  { name: 'Applebot-Extended', re: /Applebot-Extended/i },
  { name: 'Bytespider', re: /Bytespider/i },            // ByteDance/TikTok LLM crawler
  { name: 'CCBot', re: /CCBot/i },                       // Common Crawl (feeds many LLMs)
  { name: 'Diffbot', re: /Diffbot/i },
  { name: 'Amazonbot', re: /Amazonbot/i },
  { name: 'cohere-ai', re: /cohere-ai|cohere-training-data-crawler/i },
  { name: 'Meta-ExternalAgent', re: /Meta-ExternalAgent|Meta-ExternalFetcher/i },
  { name: 'YouBot', re: /YouBot/i },
  { name: 'Timpibot', re: /Timpibot/i },
  { name: 'ImagesiftBot', re: /ImagesiftBot/i },
  { name: 'Omgilibot', re: /Omgili|Omgilibot/i },
  { name: 'Mistral-User', re: /MistralAI-User|Mistral-User/i },
  { name: 'DuckAssistBot', re: /DuckAssistBot/i },
  { name: 'AI2Bot', re: /AI2Bot/i },
  { name: 'Bard/Gemini', re: /Google-Bard|GeminiBot/i }
];

// --- Traditional (non-AI) search engine crawlers -----------------------------
const SEARCH_BOTS = [
  { name: 'Googlebot', re: /Googlebot(?!-)/i }, // excludes GoogleOther/Google-Extended handled above
  { name: 'Bingbot', re: /bingbot/i },
  { name: 'YandexBot', re: /YandexBot/i },
  { name: 'Baiduspider', re: /Baiduspider/i },
  { name: 'DuckDuckBot', re: /DuckDuckBot/i },
  { name: 'Slurp', re: /Slurp/i } // Yahoo
];

// --- Generic bot fallback (rate-limits/analytics hygiene, not "AI" or "search") ---
const GENERIC_BOT_RE = /bot|crawler|spider|crawling|slurp|facebookexternalhit|preview|monitor|uptime|headlesschrome/i;

// --- AI answer-engine domains: a human clicked through from one of these -----
const AI_REFERRAL_DOMAINS = [
  { name: 'chatgpt', hosts: ['chat.openai.com', 'chatgpt.com'] },
  { name: 'perplexity', hosts: ['perplexity.ai', 'www.perplexity.ai'] },
  { name: 'gemini', hosts: ['gemini.google.com'] },
  { name: 'copilot', hosts: ['copilot.microsoft.com', 'bing.com'] }, // bing.com/chat
  { name: 'claude', hosts: ['claude.ai'] },
  { name: 'poe', hosts: ['poe.com'] },
  { name: 'you.com', hosts: ['you.com'] },
  { name: 'character.ai', hosts: ['character.ai'] },
  { name: 'meta-ai', hosts: ['meta.ai'] }
];

// --- Traditional search engines (for organic_search + keyword extraction) ----
const SEARCH_ENGINES = [
  { name: 'google', hosts: ['google.'], param: 'q' },
  { name: 'bing', hosts: ['bing.com'], param: 'q' },
  { name: 'yahoo', hosts: ['search.yahoo.com'], param: 'p' },
  { name: 'duckduckgo', hosts: ['duckduckgo.com'], param: 'q' },
  { name: 'yandex', hosts: ['yandex.'], param: 'text' },
  { name: 'baidu', hosts: ['baidu.com'], param: 'wd' }
];

function hostMatches(hostname, hostFragments) {
  return hostFragments.some((frag) => hostname === frag || hostname.endsWith('.' + frag) || hostname.includes(frag));
}

function safeHostname(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

/**
 * @param {string} userAgent
 * @param {string|null} referrer - full referrer URL, if any
 * @returns {{trafficSourceType:string, botName:string|null, searchEngine:string|null, searchKeywords:string|null}}
 */
function classify(userAgent, referrer) {
  const ua = userAgent || '';

  for (const bot of AI_CRAWLERS) {
    if (bot.re.test(ua)) {
      return { trafficSourceType: 'ai_crawler', botName: bot.name, searchEngine: null, searchKeywords: null };
    }
  }

  for (const bot of SEARCH_BOTS) {
    if (bot.re.test(ua)) {
      return { trafficSourceType: 'search_bot', botName: bot.name, searchEngine: null, searchKeywords: null };
    }
  }

  if (GENERIC_BOT_RE.test(ua)) {
    return { trafficSourceType: 'search_bot', botName: 'unclassified-bot', searchEngine: null, searchKeywords: null };
  }

  const refHost = referrer ? safeHostname(referrer) : null;

  if (refHost) {
    const aiRef = AI_REFERRAL_DOMAINS.find((d) => hostMatches(refHost, d.hosts));
    if (aiRef) {
      return { trafficSourceType: 'ai_referral', botName: aiRef.name, searchEngine: null, searchKeywords: null };
    }

    const engine = SEARCH_ENGINES.find((e) => hostMatches(refHost, e.hosts));
    if (engine) {
      let keywords = null;
      try {
        keywords = new URL(referrer).searchParams.get(engine.param) || null;
      } catch { /* ignore */ }
      return { trafficSourceType: 'organic_search', botName: null, searchEngine: engine.name, searchKeywords: keywords };
    }

    return { trafficSourceType: 'referral', botName: null, searchEngine: null, searchKeywords: null };
  }

  return { trafficSourceType: 'direct', botName: null, searchEngine: null, searchKeywords: null };
}

module.exports = { classify, AI_CRAWLERS, SEARCH_BOTS, AI_REFERRAL_DOMAINS, SEARCH_ENGINES };
