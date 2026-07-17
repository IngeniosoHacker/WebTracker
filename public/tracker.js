/*!
 * analytics-tracker client (tracker.js)
 * Framework-agnostic. Works as a plain <script> tag on any HTML page
 * (static HTML, WordPress, React/Vue/Angular/Svelte SPAs, etc).
 *
 * Usage:
 *   <script src="https://your-tracker.up.railway.app/tracker.js"
 *           data-site-id="my-site"
 *           defer></script>
 *
 * Optional data-attributes on the same <script> tag:
 *   data-api                -> override API base URL (defaults to the script's own origin)
 *   data-session-timeout    -> minutes of inactivity before a new session starts (default 30)
 *   data-flush-interval     -> ms between heartbeats (default 5000)
 *   data-ingest-key         -> shared secret sent as X-Ingest-Key header, if configured server-side
 *   data-content-selector   -> CSS selector for the "main content" to extract (default: main, article, body)
 */
(function (window, document) {
  'use strict';

  if (window.__ATRK_LOADED__) return;
  window.__ATRK_LOADED__ = true;

  // ---------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------
  var scriptEl = document.currentScript || (function () {
    var scripts = document.getElementsByTagName('script');
    return scripts[scripts.length - 1];
  })();

  var cfg = {
    siteId: scriptEl.getAttribute('data-site-id') || 'default-site',
    apiBase: scriptEl.getAttribute('data-api') || scriptEl.src.replace(/\/tracker\.js.*$/, ''),
    sessionTimeoutMs: (parseInt(scriptEl.getAttribute('data-session-timeout'), 10) || 30) * 60 * 1000,
    flushIntervalMs: parseInt(scriptEl.getAttribute('data-flush-interval'), 10) || 5000,
    ingestKey: scriptEl.getAttribute('data-ingest-key') || '',
    contentSelector: scriptEl.getAttribute('data-content-selector') || 'main, article, [role="main"], body',
    contentMaxChars: 8000
  };

  var COLLECT_URL = cfg.apiBase + '/collect';

  // ---------------------------------------------------------------------
  // Small utils
  // ---------------------------------------------------------------------
  function uuid() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0, v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function now() { return Date.now(); }

  function safeGet(storage, key) {
    try { return storage.getItem(key); } catch (e) { return null; }
  }
  function safeSet(storage, key, val) {
    try { storage.setItem(key, val); } catch (e) { /* ignore quota / private mode errors */ }
  }

  function parseUTM(search) {
    var params = new URLSearchParams(search || '');
    return {
      source: params.get('utm_source') || null,
      medium: params.get('utm_medium') || null,
      campaign: params.get('utm_campaign') || null,
      term: params.get('utm_term') || null,
      content: params.get('utm_content') || null
    };
  }

  function detectDevice(ua) {
    if (/tablet|ipad/i.test(ua)) return 'tablet';
    if (/mobile|android|iphone/i.test(ua)) return 'mobile';
    return 'desktop';
  }
  function detectBrowser(ua) {
    if (/edg\//i.test(ua)) return 'Edge';
    if (/chrome\//i.test(ua) && !/chromium/i.test(ua)) return 'Chrome';
    if (/firefox\//i.test(ua)) return 'Firefox';
    if (/safari\//i.test(ua) && !/chrome/i.test(ua)) return 'Safari';
    return 'Other';
  }
  function detectOS(ua) {
    if (/windows/i.test(ua)) return 'Windows';
    if (/mac os/i.test(ua)) return 'macOS';
    if (/android/i.test(ua)) return 'Android';
    if (/iphone|ipad|ios/i.test(ua)) return 'iOS';
    if (/linux/i.test(ua)) return 'Linux';
    return 'Other';
  }

  function extractContent() {
    try {
      var el = document.querySelector(cfg.contentSelector) || document.body;
      var clone = el.cloneNode(true);
      var stripSelectors = 'script, style, noscript, iframe, nav, header, footer, [aria-hidden="true"]';
      var toRemove = clone.querySelectorAll(stripSelectors);
      for (var i = 0; i < toRemove.length; i++) toRemove[i].parentNode.removeChild(toRemove[i]);
      var text = (clone.textContent || '').replace(/\s+/g, ' ').trim();
      var wordCount = text ? text.split(' ').length : 0;
      return { text: text.slice(0, cfg.contentMaxChars), wordCount: wordCount };
    } catch (e) {
      return { text: null, wordCount: null };
    }
  }

  // ---------------------------------------------------------------------
  // Identity: visitorId (long-lived) + sessionId (inactivity-based)
  // ---------------------------------------------------------------------
  var VID_KEY = '_atrk_vid';
  var SID_KEY = '_atrk_sid';
  var SID_TS_KEY = '_atrk_sid_ts';
  var NAV_KEY = '_atrk_nav_index';
  var LAST_PATH_KEY = '_atrk_last_path';

  var visitorId = safeGet(window.localStorage, VID_KEY);
  if (!visitorId) {
    visitorId = uuid();
    safeSet(window.localStorage, VID_KEY, visitorId);
  }

  var isNewSession = false;
  var sessionId = safeGet(window.sessionStorage, SID_KEY);
  var lastActivity = parseInt(safeGet(window.sessionStorage, SID_TS_KEY), 10);

  if (!sessionId || !lastActivity || (now() - lastActivity) > cfg.sessionTimeoutMs) {
    sessionId = uuid();
    isNewSession = true;
    safeSet(window.sessionStorage, SID_KEY, sessionId);
    safeSet(window.sessionStorage, NAV_KEY, '0');
    safeSet(window.sessionStorage, LAST_PATH_KEY, '');
  }
  safeSet(window.sessionStorage, SID_TS_KEY, String(now()));

  // ---------------------------------------------------------------------
  // Outgoing queue + transport
  // ---------------------------------------------------------------------
  var queue = [];

  function enqueue(beacon) {
    queue.push(beacon);
  }

  function flush(useBeacon) {
    if (!queue.length) return;
    var batch = queue.splice(0, queue.length);
    var payload = JSON.stringify({
      siteId: cfg.siteId,
      visitorId: visitorId,
      sessionId: sessionId,
      batch: batch
    });

    if (useBeacon && navigator.sendBeacon) {
      var blob = new Blob([payload], { type: 'application/json' });
      var ok = navigator.sendBeacon(COLLECT_URL, blob);
      if (ok) return;
      // fall through to fetch if sendBeacon rejected it
    }

    var headers = { 'Content-Type': 'application/json' };
    if (cfg.ingestKey) headers['X-Ingest-Key'] = cfg.ingestKey;

    fetch(COLLECT_URL, {
      method: 'POST',
      headers: headers,
      body: payload,
      keepalive: true,
      mode: 'cors'
    }).catch(function () { /* silently ignore network errors, we don't want to break the host page */ });
  }

  // ---------------------------------------------------------------------
  // Scroll depth tracking (per 10% band) + total time on page
  // ---------------------------------------------------------------------
  function createPageTracker(pageview) {
    var buckets = {}; // depthBucket(0..90) -> accumulated ms
    var maxScrollPercent = 0;
    var currentBucket = 0;
    var lastTick = now();
    var activeDuration = 0;
    var isHidden = document.hidden;
    var ticking = false;

    function currentScrollPercent() {
      var doc = document.documentElement;
      var scrollTop = window.pageYOffset || doc.scrollTop || 0;
      var viewport = window.innerHeight || doc.clientHeight || 0;
      var full = Math.max(doc.scrollHeight, document.body ? document.body.scrollHeight : 0);
      if (full <= viewport) return 100;
      var pct = ((scrollTop + viewport) / full) * 100;
      return Math.max(0, Math.min(100, pct));
    }

    function tick() {
      var t = now();
      var delta = t - lastTick;
      lastTick = t;
      if (!isHidden && delta > 0) {
        activeDuration += delta;
        buckets[currentBucket] = (buckets[currentBucket] || 0) + delta;
      }
    }

    function onScroll() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        tick();
        var pct = currentScrollPercent();
        maxScrollPercent = Math.max(maxScrollPercent, Math.round(pct));
        var bucket = Math.min(90, Math.floor(pct / 10) * 10);
        currentBucket = bucket;
        ticking = false;
      });
    }

    function onVisibilityChange() {
      tick(); // flush time accrued in the previous state first
      isHidden = document.hidden;
      lastTick = now();
    }

    window.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('visibilitychange', onVisibilityChange);

    return {
      snapshot: function () {
        tick();
        var segments = Object.keys(buckets).map(function (b) {
          return { bucket: parseInt(b, 10), timeMs: Math.round(buckets[b]) };
        });
        return {
          durationMs: Math.round(activeDuration),
          maxScrollPercent: maxScrollPercent,
          scrollSegments: segments
        };
      },
      destroy: function () {
        window.removeEventListener('scroll', onScroll);
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    };
  }

  // ---------------------------------------------------------------------
  // Session + pageview lifecycle
  // ---------------------------------------------------------------------
  var ua = navigator.userAgent || '';
  var activePageTracker = null;
  var activePageviewId = null;
  var heartbeatTimer = null;

  function startSessionBeaconIfNeeded() {
    if (!isNewSession) return;
    enqueue({
      type: 'session_start',
      enteredAt: now(),
      landing: {
        page: location.href,
        path: location.pathname,
        referrer: document.referrer || null,
        utm: parseUTM(location.search),
        deviceType: detectDevice(ua),
        browser: detectBrowser(ua),
        os: detectOS(ua)
      }
    });
  }

  function buildPageviewBeacon(isFinal) {
    var snap = activePageTracker ? activePageTracker.snapshot() : { durationMs: 0, maxScrollPercent: 0, scrollSegments: [] };
    return {
      type: 'pageview',
      isFinal: !!isFinal,
      pageview: {
        id: activePageviewId,
        url: location.href,
        path: location.pathname,
        title: document.title,
        navIndex: parseInt(safeGet(window.sessionStorage, NAV_KEY), 10) || 0,
        internalReferrerPath: safeGet(window.sessionStorage, LAST_PATH_KEY) || null,
        enteredAt: activePageviewEnteredAt,
        leftAt: isFinal ? now() : null,
        durationMs: snap.durationMs,
        maxScrollPercent: snap.maxScrollPercent,
        scrollSegments: snap.scrollSegments,
        content: extractContent()
      }
    };
  }

  var activePageviewEnteredAt = null;

  function endCurrentPageview() {
    if (!activePageviewId) return;
    enqueue(buildPageviewBeacon(true));
    if (activePageTracker) activePageTracker.destroy();
    flush(false);
  }

  function startNewPageview() {
    activePageviewId = uuid();
    activePageviewEnteredAt = now();
    activePageTracker = createPageTracker(activePageviewId);

    enqueue(buildPageviewBeacon(false));

    safeSet(window.sessionStorage, LAST_PATH_KEY, location.pathname);
    var nextIndex = (parseInt(safeGet(window.sessionStorage, NAV_KEY), 10) || 0) + 1;
    safeSet(window.sessionStorage, NAV_KEY, String(nextIndex));

    flush(false);
  }

  function heartbeat() {
    safeSet(window.sessionStorage, SID_TS_KEY, String(now()));
    if (!activePageviewId) return;
    enqueue(buildPageviewBeacon(false));
    flush(false);
  }

  // ---------------------------------------------------------------------
  // SPA navigation detection (pushState/replaceState/popstate/hashchange)
  // ---------------------------------------------------------------------
  function onRouteChange() {
    endCurrentPageview();
    startNewPageview();
  }

  (function patchHistory() {
    var origPush = history.pushState;
    var origReplace = history.replaceState;
    history.pushState = function () {
      var ret = origPush.apply(this, arguments);
      onRouteChange();
      return ret;
    };
    history.replaceState = function () {
      var ret = origReplace.apply(this, arguments);
      // replaceState usually doesn't mean a full new "visit" of a page,
      // but many SPA routers use it for real navigations, so we treat it the same.
      onRouteChange();
      return ret;
    };
    window.addEventListener('popstate', onRouteChange);
    window.addEventListener('hashchange', onRouteChange);
  })();

  window.addEventListener('pagehide', function () {
    endCurrentPageview();
  });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      // Send a non-final snapshot so we don't lose progress if the user never comes back.
      if (activePageviewId) {
        enqueue(buildPageviewBeacon(false));
        flush(true);
      }
    }
  });

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------
  startSessionBeaconIfNeeded();
  startNewPageview();
  heartbeatTimer = setInterval(heartbeat, cfg.flushIntervalMs);

  // Expose a tiny public API for custom events, e.g. atrk('event', 'signup_click', {plan:'pro'})
  window.atrk = function (type, eventType, payload) {
    if (type !== 'event') return;
    enqueue({
      type: 'event',
      eventType: eventType,
      pageviewId: activePageviewId,
      payload: payload || {}
    });
    flush(false);
  };
})(window, document);
