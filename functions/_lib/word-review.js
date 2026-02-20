const VERSION = "2026-02-20-cf1";
const RATE_LIMIT_STATE = new Map();
const INITED_DBS = new WeakSet();

function safeInt(value, fallback, min) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, n);
}

function rateConfig(env) {
  return {
    windowMs: safeInt(env && env.WORD_REVIEW_RATE_WINDOW_MS, 10000, 1000),
    maxRequests: safeInt(env && env.WORD_REVIEW_RATE_MAX_REQUESTS, 25, 5),
    baseCooldownMs: safeInt(env && env.WORD_REVIEW_RATE_BASE_COOLDOWN_MS, 5000, 1000),
    maxCooldownMs: safeInt(env && env.WORD_REVIEW_RATE_MAX_COOLDOWN_MS, 120000, 1000),
    trackTtlMs: safeInt(env && env.WORD_REVIEW_RATE_TRACK_TTL_MS, 900000, 60000)
  };
}

function json(statusCode, data, extraHeaders) {
  const headers = Object.assign(
    {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Wordshift-Key, X-Admin-Key"
    },
    extraHeaders || {}
  );
  return new Response(JSON.stringify(data), { status: statusCode, headers });
}

function normalizeWord(word) {
  return String(word || "").toUpperCase().replace(/[^A-Z]/g, "");
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

function envPresence(env) {
  return {
    platform: "cloudflare-pages",
    DB: !!(env && env.DB),
    WORD_REVIEW_ADMIN_KEY: !!String((env && env.WORD_REVIEW_ADMIN_KEY) || "").trim(),
    NETLIFY_SITE_ID: false,
    SITE_ID: false,
    BLOBS_SITE_ID: false,
    NETLIFY_AUTH_TOKEN: false,
    BLOBS_TOKEN: false,
    NETLIFY_BLOBS_TOKEN: false
  };
}

function getHeaderValue(request, headerName) {
  const wanted = String(headerName || "").toLowerCase();
  for (const [key, value] of request.headers.entries()) {
    if (String(key || "").toLowerCase() === wanted) {
      return String(value || "");
    }
  }
  return "";
}

function getConfiguredAdminKey(env) {
  return String((env && env.WORD_REVIEW_ADMIN_KEY) || "").trim();
}

function isAdminAuthConfigured(env) {
  return !!getConfiguredAdminKey(env);
}

function getAuthKeyFromRequest(request) {
  const direct = String(
    getHeaderValue(request, "x-wordshift-key") ||
      getHeaderValue(request, "x-admin-key") ||
      ""
  ).trim();
  if (direct) return direct;
  const auth = String(getHeaderValue(request, "authorization") || "").trim();
  if (!auth) return "";
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  return match ? String(match[1] || "").trim() : "";
}

function isAuthorized(request, env) {
  const expected = getConfiguredAdminKey(env);
  if (!expected) return false;
  const provided = getAuthKeyFromRequest(request);
  return !!provided && provided === expected;
}

function getClientFingerprint(request) {
  const ipRaw = String(
    getHeaderValue(request, "cf-connecting-ip") ||
      getHeaderValue(request, "x-forwarded-for") ||
      getHeaderValue(request, "client-ip") ||
      ""
  )
    .split(",")[0]
    .trim();
  const ua = String(getHeaderValue(request, "user-agent") || "").slice(0, 120);
  const authState = getAuthKeyFromRequest(request) ? "auth" : "anon";
  return `${ipRaw || "unknown"}|${ua || "ua-unknown"}|${authState}`;
}

function pruneRateLimitState(now, trackTtlMs) {
  for (const [key, state] of RATE_LIMIT_STATE.entries()) {
    if (!state || now - (state.lastSeen || 0) > trackTtlMs) {
      RATE_LIMIT_STATE.delete(key);
    }
  }
}

function getMethodBudget(method, maxRequests) {
  const m = String(method || "").toUpperCase();
  if (m === "POST" || m === "PUT") return Math.max(3, Math.floor(maxRequests * 0.6));
  if (m === "GET") return maxRequests;
  return Math.max(3, Math.floor(maxRequests * 0.7));
}

function checkRateLimit(request, env) {
  const method = String((request && request.method) || "GET").toUpperCase();
  if (method === "OPTIONS") return { limited: false };

  const cfg = rateConfig(env);
  const now = Date.now();
  pruneRateLimitState(now, cfg.trackTtlMs);

  const clientKey = getClientFingerprint(request);
  const state = RATE_LIMIT_STATE.get(clientKey) || {
    hits: [],
    strikes: 0,
    cooldownUntil: 0,
    lastSeen: now
  };

  state.lastSeen = now;
  state.hits = (state.hits || []).filter((ts) => now - ts <= cfg.windowMs);

  if (state.cooldownUntil > now) {
    state.strikes = Math.min((state.strikes || 0) + 1, 8);
    const escalated = Math.min(
      cfg.maxCooldownMs,
      cfg.baseCooldownMs * 2 ** Math.max(0, state.strikes - 1)
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
  const budget = getMethodBudget(method, cfg.maxRequests);
  if (state.hits.length > budget) {
    state.strikes = Math.min((state.strikes || 0) + 1, 8);
    const cooldown = Math.min(
      cfg.maxCooldownMs,
      cfg.baseCooldownMs * 2 ** Math.max(0, state.strikes - 1)
    );
    state.cooldownUntil = now + cooldown;
    state.hits = [];
    RATE_LIMIT_STATE.set(clientKey, state);
    return { limited: true, retryAfterMs: cooldown, strikes: state.strikes };
  }

  if (state.strikes > 0 && state.hits.length <= Math.floor(budget / 3)) {
    state.strikes = Math.max(0, state.strikes - 1);
  }
  RATE_LIMIT_STATE.set(clientKey, state);
  return { limited: false };
}

async function ensureSchema(db) {
  if (!db) throw new Error("D1 database binding DB is missing");
  if (!INITED_DBS.has(db)) {
    await db.exec(
      "CREATE TABLE IF NOT EXISTS word_review_state (" +
        "id INTEGER PRIMARY KEY CHECK (id = 1)," +
        "approved_json TEXT NOT NULL DEFAULT '[]'," +
        "rejected_json TEXT NOT NULL DEFAULT '[]'," +
        "updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))" +
      ");"
    );
    await db
      .prepare(
        "INSERT OR IGNORE INTO word_review_state (id, approved_json, rejected_json, updated_at) " +
          "VALUES (1, '[]', '[]', CAST(strftime('%s','now') AS INTEGER))"
      )
      .run();
    INITED_DBS.add(db);
  }
}

async function loadPayload(db) {
  const row = await db
    .prepare("SELECT approved_json, rejected_json FROM word_review_state WHERE id = 1")
    .first();
  if (!row) return { approved: [], rejected: [] };
  let raw = { approved: [], rejected: [] };
  try {
    raw = {
      approved: JSON.parse(String(row.approved_json || "[]")),
      rejected: JSON.parse(String(row.rejected_json || "[]"))
    };
  } catch (_) {
    raw = { approved: [], rejected: [] };
  }
  return normalizePayload(raw);
}

async function savePayload(db, payload) {
  await db
    .prepare(
      "INSERT INTO word_review_state (id, approved_json, rejected_json, updated_at) " +
        "VALUES (1, ?, ?, CAST(strftime('%s','now') AS INTEGER)) " +
        "ON CONFLICT(id) DO UPDATE SET " +
        "approved_json = excluded.approved_json, " +
        "rejected_json = excluded.rejected_json, " +
        "updated_at = excluded.updated_at"
    )
    .bind(JSON.stringify(payload.approved), JSON.stringify(payload.rejected))
    .run();
}

function queryFlag(url, names) {
  const params = url.searchParams;
  for (const name of names) {
    const v = String(params.get(name) || "").toLowerCase();
    if (v === "1" || v === "true" || v === "yes") return true;
  }
  return false;
}

export async function handleWordReview(request, env) {
  try {
    const method = String((request && request.method) || "GET").toUpperCase();
    if (method === "OPTIONS") return json(200, { ok: true });

    const rate = checkRateLimit(request, env);
    if (rate.limited) {
      const retrySeconds = Math.max(1, Math.ceil((rate.retryAfterMs || 1000) / 1000));
      return json(
        429,
        {
          ok: false,
          error: "Too many requests. Cooldown active.",
          code: "RATE_LIMITED",
          retryAfterMs: retrySeconds * 1000,
          cooldownLevel: rate.strikes || 1,
          hint: "Slow down and retry after the cooldown period."
        },
        { "Retry-After": String(retrySeconds) }
      );
    }

    const db = env && env.DB;
    if (!db) {
      return json(500, {
        ok: false,
        error: "D1 binding missing",
        hint: "Bind a Cloudflare D1 database to variable DB in Pages settings."
      });
    }
    await ensureSchema(db);

    const url = new URL(request.url);

    if (method === "GET") {
      if (queryFlag(url, ["authCheck", "auth_check", "auth"])) {
        if (!isAdminAuthConfigured(env)) {
          return json(503, {
            ok: false,
            error: "Admin key not configured on server",
            hint: "Set WORD_REVIEW_ADMIN_KEY in Cloudflare Pages environment variables."
          });
        }
        if (!isAuthorized(request, env)) {
          return json(401, { ok: false, error: "Unauthorized" });
        }
        return json(200, { ok: true, authenticated: true, version: VERSION });
      }

      if (queryFlag(url, ["debug"])) {
        return json(200, {
          ok: true,
          version: VERSION,
          env: envPresence(env)
        });
      }

      const payload = await loadPayload(db);
      return json(200, payload);
    }

    if (method === "POST" || method === "PUT") {
      if (!isAdminAuthConfigured(env)) {
        return json(503, {
          ok: false,
          error: "Admin key not configured on server",
          hint: "Set WORD_REVIEW_ADMIN_KEY in Cloudflare Pages environment variables."
        });
      }
      if (!isAuthorized(request, env)) {
        return json(401, { ok: false, error: "Unauthorized" });
      }

      let body = {};
      try {
        body = await request.json();
      } catch (_) {
        return json(400, { error: "Invalid JSON body" });
      }

      const payload = normalizePayload(body || {});
      await savePayload(db, payload);
      return json(200, payload);
    }

    return json(405, { error: "Method not allowed" });
  } catch (error) {
    return json(500, {
      ok: false,
      error: String((error && error.message) || error || "Unknown error"),
      hint: "Configure Cloudflare D1 binding DB and WORD_REVIEW_ADMIN_KEY."
    });
  }
}
