'use strict';

const KEY = 'campaign_words';

function json(statusCode, data) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
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

async function resolveStore(context) {
  // Prefer runtime-provided blobs when available.
  if (context && context.blobs && typeof context.blobs.getStore === 'function') {
    return context.blobs.getStore('wordshift-data');
  }

  // Fallback to SDK import at runtime (not module top-level) so failures return JSON instead of hard 502.
  let mod = null;
  try {
    mod = await import('@netlify/blobs');
  } catch (e) {
    throw new Error('Cannot load @netlify/blobs: ' + String((e && e.message) || e || 'unknown'));
  }

  if (!mod || typeof mod.getStore !== 'function') {
    throw new Error('@netlify/blobs loaded but getStore is unavailable');
  }

  return mod.getStore('wordshift-data');
}

exports.handler = async (event, context) => {
  try {
    if (event.httpMethod === 'OPTIONS') {
      return json(200, { ok: true });
    }

    const store = await resolveStore(context);

    if (event.httpMethod === 'GET') {
      const stored = await store.get(KEY, { type: 'json' });
      const payload = normalizePayload(stored || { approved: [], rejected: [] });
      if (!stored) {
        await store.setJSON(KEY, payload);
      }
      return json(200, payload);
    }

    if (event.httpMethod === 'POST' || event.httpMethod === 'PUT') {
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
      hint: 'Check Netlify function logs and ensure Blobs is available for this site.'
    });
  }
};