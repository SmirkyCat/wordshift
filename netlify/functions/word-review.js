'use strict';

const KEY = 'campaign_words';
const VERSION = '2026-02-20-rate1';
const RATE_LIMIT_WINDOW_MS = Math.max(1000, Number.parseInt(process.env.WORD_REVIEW_RATE_WINDOW_MS || '10000', 10) || 10000);
const RATE_LIMIT_MAX_REQUESTS = Math.max(5, Number.parseInt(process.env.WORD_REVIEW_RATE_MAX_REQUESTS || '25', 10) || 25);
const RATE_LIMIT_BASE_COOLDOWN_MS = Math.max(1000, Number.parseInt(process.env.WORD_REVIEW_RATE_BASE_COOLDOWN_MS || '5000', 10) || 5000);
const RATE_LIMIT_MAX_COOLDOWN_MS = Math.max(
  RATE_LIMIT_BASE_COOLDOWN_MS,
  Number.parseInt(process.env.WORD_REVIEW_RATE_MAX_COOLDOWN_MS || '120000', 10) || 120000
);
const RATE_LIMIT_TRACK_TTL_MS = Math.max(60000, Number.parseInt(process.env.WORD_REVIEW_RATE_TRACK_TTL_MS || '900000', 10) || 900000);
const RATE_LIMIT_STATE = new Map();

function json(statusCode, data, extraHeaders) {
  const baseHeaders = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Wordshift-Key, X-Admin-Key'
  };
  return {
    statusCode,
    headers: Object.assign(baseHeaders, extraHeaders || {}),
    body: JSON.stringify(data)
  };
}

function normalizeWord(word) {
  return String(word || '').toUpperCase().replace(/[^A-Z]/g, '');
}

function readableWord(word) {
  if (!/^[A-Z]{4,8}$/.test(word)) return false;
  if (!/[AEIOUY]/.test(word)) return false;
  if (/(.)\1\1/.test(word)) return false;
  return true;
}

function normalizePayload(raw) {
  raw = raw || {};
  const approved = {};
  const rejected = {};

  function add(list, into) {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      const w = normalizeWord(item);
      if (!readableWord(w)) continue;
      into[w] = true;
    }
  }

  add(raw.approved, approved);
  add(raw.rejected, rejected);

  for (const w of Object.keys(rejected)) {
    delete approved[w];
  }

  return {
    approved: Object.keys(approved).sort(),
    rejected: Object.keys(rejected).sort()
  };
}

function envPresence() {
  return {
    NETLIFY_SITE_ID: !!process.env.NETLIFY_SITE_ID,
    SITE_ID: !!process.env.SITE_ID,
    BLOBS_SITE_ID: !!process.env.BLOBS_SITE_ID,
    NETLIFY_AUTH_TOKEN: !!process.env.NETLIFY_AUTH_TOKEN,
    BLOBS_TOKEN: !!process.env.BLOBS_TOKEN,
    NETLIFY_BLOBS_TOKEN: !!process.env.NETLIFY_BLOBS_TOKEN,
    WORD_REVIEW_ADMIN_KEY: !!process.env.WORD_REVIEW_ADMIN_KEY
  };
}

function getQueryParam(event, key) {
  if (event && event.queryStringParameters && Object.prototype.hasOwnProperty.call(event.queryStringParameters, key)) {
    return event.queryStringParameters[key];
  }
  return '';
}

function getHeaderValue(event, headerName) {
  if (!event || !event.headers) return '';
  const wanted = String(headerName || '').toLowerCase();
  const keys = Object.keys(event.headers);
  for (const key of keys) {
    if (String(key || '').toLowerCase() === wanted) {
      return String(event.headers[key] || '');
    }
  }
  return '';
}

function getConfiguredAdminKey() {
  return String(process.env.WORD_REVIEW_ADMIN_KEY || '').trim();
}

function isAdminAuthConfigured() {
  return !!getConfiguredAdminKey();
}

function getAuthKeyFromEvent(event) {
  const direct = String(
    getHeaderValue(event, 'x-wordshift-key')
    || getHeaderValue(event, 'x-admin-key')
    || ''
  ).trim();
  if (direct) return direct;
  const auth = String(getHeaderValue(event, 'authorization') || '').trim();
  if (!auth) return '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return '';
  return String(m[1] || '').trim();
}

function isAuthorized(event) {
  const expected = getConfiguredAdminKey();
  if (!expected) return false;
  const provided = getAuthKeyFromEvent(event);
  return !!provided && provided === expected;
}

function getClientFingerprint(event) {
  const ipRaw = String(
    getHeaderValue(event, 'x-nf-client-connection-ip')
    || getHeaderValue(event, 'x-forwarded-for')
    || getHeaderValue(event, 'client-ip')
    || ''
  ).split(',')[0].trim();
  const ua = String(getHeaderValue(event, 'user-agent') || '').slice(0, 120);
  const authState = getAuthKeyFromEvent(event) ? 'auth' : 'anon';
  return `${ipRaw || 'unknown'}|${ua || 'ua-unknown'}|${authState}`;
}

function pruneRateLimitState(now) {
  for (const [key, state] of RATE_LIMIT_STATE.entries()) {
    if (!state || (now - (state.lastSeen || 0)) > RATE_LIMIT_TRACK_TTL_MS) {
      RATE_LIMIT_STATE.delete(key);
    }
  }
}

function getMethodBudget(httpMethod) {
  const m = String(httpMethod || '').toUpperCase();
  if (m === 'POST' || m === 'PUT') {
    return Math.max(3, Math.floor(RATE_LIMIT_MAX_REQUESTS * 0.6));
  }
  if (m === 'GET') {
    return RATE_LIMIT_MAX_REQUESTS;
  }
  return Math.max(3, Math.floor(RATE_LIMIT_MAX_REQUESTS * 0.7));
}

function checkRateLimit(event) {
  const method = String((event && event.httpMethod) || 'GET').toUpperCase();
  if (method === 'OPTIONS') return { limited: false };

  const now = Date.now();
  pruneRateLimitState(now);

  const clientKey = getClientFingerprint(event);
  const state = RATE_LIMIT_STATE.get(clientKey) || {
    hits: [],
    strikes: 0,
    cooldownUntil: 0,
    lastSeen: now
  };
  state.lastSeen = now;
  state.hits = (state.hits || []).filter((ts) => (now - ts) <= RATE_LIMIT_WINDOW_MS);

  if (state.cooldownUntil > now) {
    // Step-off behavior: repeated hammering extends cooldown.
    state.strikes = Math.min((state.strikes || 0) + 1, 8);
    const escalated = Math.min(
      RATE_LIMIT_MAX_COOLDOWN_MS,
      RATE_LIMIT_BASE_COOLDOWN_MS * (2 ** Math.max(0, state.strikes - 1))
    );
    state.cooldownUntil = Math.max(state.cooldownUntil, now + escalated);
    RATE_LIMIT_STATE.set(clientKey, state);
    return {
      limited: true,
      retryAfterMs: Math.max(1000, state.cooldownUntil - now),
      strikes: state.strikes
    };
  }

  state.hits.push(now);
  const budget = getMethodBudget(method);
  if (state.hits.length > budget) {
    state.strikes = Math.min((state.strikes || 0) + 1, 8);
    const cooldown = Math.min(
      RATE_LIMIT_MAX_COOLDOWN_MS,
      RATE_LIMIT_BASE_COOLDOWN_MS * (2 ** Math.max(0, state.strikes - 1))
    );
    state.cooldownUntil = now + cooldown;
    state.hits = [];
    RATE_LIMIT_STATE.set(clientKey, state);
    return { limited: true, retryAfterMs: cooldown, strikes: state.strikes };
  }

  // Cool down penalties over time when request rate is calm.
  if (state.strikes > 0 && state.hits.length <= Math.floor(budget / 3)) {
    state.strikes = Math.max(0, state.strikes - 1);
  }
  RATE_LIMIT_STATE.set(clientKey, state);
  return { limited: false };
}

async function resolveStore(context) {
  // Load SDK at runtime so initialization errors become JSON responses.
  let mod = null;
  try {
    mod = await import('@netlify/blobs');
  } catch (e) {
    throw new Error('Cannot load @netlify/blobs: ' + String((e && e.message) || e || 'unknown'));
  }

  if (!mod || typeof mod.getStore !== 'function') {
    throw new Error('@netlify/blobs loaded but getStore is unavailable');
  }

  const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID || process.env.BLOBS_SITE_ID || '';
  const token = process.env.NETLIFY_AUTH_TOKEN || process.env.BLOBS_TOKEN || process.env.NETLIFY_BLOBS_TOKEN || '';

  // Prefer explicit credentials when provided.
  if (siteID && token) {
    try {
      return mod.getStore({ name: 'wordshift-data', siteID, token });
    } catch (_) {
      try {
        // Compatibility fallback for older SDK signatures.
        return mod.getStore('wordshift-data', { siteID, token });
      } catch (e2) {
        throw new Error('Explicit credential store init failed: ' + String((e2 && e2.message) || e2 || 'unknown'));
      }
    }
  }

  // Next fallback: runtime-provided blobs context.
  if (context && context.blobs && typeof context.blobs.getStore === 'function') {
    try {
      return context.blobs.getStore('wordshift-data');
    } catch (_) {
      // Continue to final SDK default fallback.
    }
  }

  // Final attempt: SDK default runtime resolution.
  try {
    return mod.getStore('wordshift-data');
  } catch (e) {
    throw new Error(
      'Blobs unavailable. Set NETLIFY_SITE_ID and NETLIFY_AUTH_TOKEN (or BLOBS_SITE_ID/BLOBS_TOKEN). Original: '
      + String((e && e.message) || e || 'unknown')
    );
  }
}
exports.handler = async (event, context) => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return json(200, { ok: true });
    }

    const rate = checkRateLimit(event);
    if (rate.limited) {
      const retrySeconds = Math.max(1, Math.ceil((rate.retryAfterMs || 1000) / 1000));
      return json(429, {
        ok: false,
        error: 'Too many requests. Cooldown active.',
        code: 'RATE_LIMITED',
        retryAfterMs: retrySeconds * 1000,
        cooldownLevel: rate.strikes || 1,
        hint: 'Slow down and retry after the cooldown period.'
      }, {
        'Retry-After': String(retrySeconds)
      });
    }

    const store = await resolveStore(context);

    if (event.httpMethod === 'GET') {
      const authCheck = String(
        getQueryParam(event, 'authCheck')
        || getQueryParam(event, 'auth_check')
        || getQueryParam(event, 'auth')
        || ''
      ).toLowerCase();
      if (authCheck === '1' || authCheck === 'true' || authCheck === 'yes') {
        if (!isAdminAuthConfigured()) {
          return json(503, {
            ok: false,
            error: 'Admin key not configured on server',
            hint: 'Set WORD_REVIEW_ADMIN_KEY in Netlify environment variables.'
          });
        }
        if (!isAuthorized(event)) {
          return json(401, { ok: false, error: 'Unauthorized' });
        }
        return json(200, { ok: true, authenticated: true, version: VERSION });
      }

      const debug = String(getQueryParam(event, 'debug') || '').toLowerCase();
      if (debug === '1' || debug === 'true' || debug === 'yes') {
        return json(200, {
          ok: true,
          version: VERSION,
          env: envPresence()
        });
      }

      const stored = await store.get(KEY, { type: 'json' });
      const payload = normalizePayload(stored || { approved: [], rejected: [] });
      if (!stored) {
        await store.setJSON(KEY, payload);
      }
      return json(200, payload);
    }

    if (event.httpMethod === 'POST' || event.httpMethod === 'PUT') {
      if (!isAdminAuthConfigured()) {
        return json(503, {
          ok: false,
          error: 'Admin key not configured on server',
          hint: 'Set WORD_REVIEW_ADMIN_KEY in Netlify environment variables.'
        });
      }
      if (!isAuthorized(event)) {
        return json(401, { ok: false, error: 'Unauthorized' });
      }

      let body = {};
      try {
        body = JSON.parse(event.body || '{}');
      } catch (_) {
        return json(400, { error: 'Invalid JSON body' });
      }

      const payload = normalizePayload(body);
      await store.setJSON(KEY, payload);
      return json(200, payload);
    }

    return json(405, { error: 'Method not allowed' });
  } catch (error) {
    return json(500, {
      error: String((error && error.message) || error || 'Unknown error'),
      hint: 'Configure Blobs with NETLIFY_SITE_ID + NETLIFY_AUTH_TOKEN and set WORD_REVIEW_ADMIN_KEY for private write access.'

    });
  }
};
