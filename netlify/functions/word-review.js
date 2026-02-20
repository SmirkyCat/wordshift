'use strict';

const KEY = 'campaign_words';
const VERSION = '2026-02-20-auth1';

function json(statusCode, data) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Wordshift-Key, X-Admin-Key'
    },
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
