'use strict';

const geoip = require('geoip-lite');

/**
 * Resolves country + city from an IP using an offline database (no external
 * API calls, no extra latency, no API key). City-level precision is limited
 * with the free bundled database — if you need block-level accuracy, swap
 * this module for the MaxMind GeoLite2-City database with a license key.
 */
function lookup(ip) {
  if (!ip) return { country: null, city: null };
  const clean = ip.replace('::ffff:', ''); // normalize IPv4-mapped IPv6 addresses
  if (clean === '127.0.0.1' || clean === '::1') return { country: null, city: null };

  try {
    const result = geoip.lookup(clean);
    if (!result) return { country: null, city: null };
    return {
      country: result.country || null,
      city: result.city || null
    };
  } catch {
    return { country: null, city: null };
  }
}

module.exports = { lookup };
