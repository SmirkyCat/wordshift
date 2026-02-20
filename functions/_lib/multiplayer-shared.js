export const VERSION = "2026-02-20-mp1";
export const ROOM_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
export const HUMAN_CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const HUMAN_CHALLENGE_LIMIT = 500;
export const ROOM_ID_LEN = 6;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 24;
export const DEFAULT_MAX_PLAYERS = 6;

const APPROVED_CACHE_TTL_MS = 45 * 1000;
const ROOM_ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const FALLBACK_WORDS = [
  "ALPHA",
  "BRAVO",
  "CLOUD",
  "DELTA",
  "EMBER",
  "FLARE",
  "GHOST",
  "HONEY",
  "INPUT",
  "JELLY",
  "KNIFE",
  "LUNAR",
  "MANGO",
  "NERVE",
  "OPERA",
  "PIXEL",
  "QUART",
  "RIVER",
  "SPARK",
  "TRACE",
  "ULTRA",
  "VIVID",
  "WAFER",
  "XENON",
  "YOUNG",
  "ZEBRA"
];

export const ALLOWED_MUTATORS = new Set([
  "fog",
  "countdown",
  "copycat",
  "budget",
  "minDistance",
  "doubleVision",
  "wildcard",
  "hotPotato",
  "hazeWeave",
  "staticShock",
  "noisyArrows",
  "replaceMode",
  "mirror",
  "lifeline"
]);

let approvedPoolCache = {
  at: 0,
  words: FALLBACK_WORDS.slice(),
  set: new Set(FALLBACK_WORDS)
};

export function json(statusCode, data) {
  return new Response(JSON.stringify(data), {
    status: statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

export function nowMs() {
  return Date.now();
}

export function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function normalizeWord(word) {
  return String(word || "").toUpperCase().replace(/[^A-Z]/g, "");
}

export function isCampaignWord(word) {
  return /^[A-Z]{4,8}$/.test(word);
}

export function randomInt(max) {
  return Math.floor(Math.random() * max);
}

export function randomToken(length) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < length; i += 1) out += alphabet[randomInt(alphabet.length)];
  return out;
}

export function chooseRandom(list) {
  if (!Array.isArray(list) || !list.length) return "";
  return list[randomInt(list.length)] || "";
}

export function sanitizeRoomId(rawId) {
  const id = String(rawId || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (id.length !== ROOM_ID_LEN) return "";
  return id;
}

export function sanitizeRoomName(rawName, roomId) {
  const name = String(rawName || "").replace(/\s+/g, " ").trim();
  if (!name) return `Room ${roomId}`;
  return name.slice(0, 36);
}

export function sanitizeMutatorList(rawList) {
  if (!Array.isArray(rawList)) return [];
  const out = [];
  const seen = new Set();
  for (const item of rawList) {
    const key = String(item || "").trim();
    if (!key || seen.has(key) || !ALLOWED_MUTATORS.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= 10) break;
  }
  return out;
}

export function scoreGuess(guess, target) {
  const g = String(guess || "");
  const t = String(target || "");
  if (!g || !t || g.length !== t.length) return "";
  const out = Array(g.length).fill("B");
  const counts = Object.create(null);
  for (let i = 0; i < g.length; i += 1) {
    if (g[i] === t[i]) out[i] = "G";
    else counts[t[i]] = (counts[t[i]] || 0) + 1;
  }
  for (let i = 0; i < g.length; i += 1) {
    if (out[i] === "G") continue;
    const ch = g[i];
    if ((counts[ch] || 0) > 0) {
      out[i] = "Y";
      counts[ch] -= 1;
    }
  }
  return out.join("");
}

export function makeUniqueName(baseName, usedNames) {
  const base = String(baseName || "").toUpperCase().slice(0, 12) || "PLAYER";
  if (!usedNames.has(base)) return base;
  for (let n = 2; n <= 99; n += 1) {
    const suffix = String(n);
    const keep = Math.max(1, 12 - suffix.length);
    const candidate = `${base.slice(0, keep)}${suffix}`;
    if (!usedNames.has(candidate)) return candidate;
  }
  let fallback = `${base.slice(0, 8)}${randomInt(9000) + 1000}`;
  while (usedNames.has(fallback)) fallback = `${base.slice(0, 8)}${randomInt(9000) + 1000}`;
  return fallback;
}

export function roomSummaryFromState(room) {
  if (!room) return null;
  const players = Array.isArray(room.players) ? room.players : [];
  const host = players.find((p) => p && p.isHost) || null;
  const playerCount = players.filter((p) => p && p.role === "player").length;
  const spectatorCount = players.filter((p) => p && p.role === "spectator").length;
  return {
    id: room.id,
    roomName: room.roomName,
    mode: room.mode,
    status: room.status,
    maxPlayers: room.maxPlayers,
    playerCount,
    spectatorCount,
    hostSpectating: !!(host && host.role === "spectator"),
    mutatorCount: Array.isArray(room.mutators) ? room.mutators.length : 0,
    mutators: Array.isArray(room.mutators) ? room.mutators.slice(0, 5) : [],
    wordLength: room.wordLength || 0,
    createdAt: room.createdAt || 0,
    lastActionAt: room.lastActionAt || 0,
    timeoutMs: ROOM_IDLE_TIMEOUT_MS
  };
}

export function roomPublicState(room, sessionToken) {
  if (!room) return null;
  const players = Array.isArray(room.players) ? room.players : [];
  const you = players.find((p) => p && p.sessionToken === sessionToken) || null;
  const host = players.find((p) => p && p.isHost) || null;
  const winner = room.winnerPlayerId
    ? players.find((p) => p && p.id === room.winnerPlayerId) || null
    : null;
  const playerCount = players.filter((p) => p && p.role === "player").length;

  return {
    id: room.id,
    roomName: room.roomName,
    mode: room.mode,
    status: room.status,
    maxPlayers: room.maxPlayers,
    mutators: Array.isArray(room.mutators) ? room.mutators.slice() : [],
    wordLength: room.wordLength || 0,
    createdAt: room.createdAt || 0,
    lastActionAt: room.lastActionAt || 0,
    startedAt: room.startedAt || 0,
    finishedAt: room.finishedAt || 0,
    idleExpiresAt: (room.lastActionAt || 0) + ROOM_IDLE_TIMEOUT_MS,
    timeoutMs: ROOM_IDLE_TIMEOUT_MS,
    playerCount,
    players: players.map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      isHost: !!p.isHost,
      guessCount: p.guessCount || 0,
      lastGuessMask: p.lastGuessMask || "",
      solvedAt: p.solvedAt || 0
    })),
    winner: winner ? { id: winner.id, name: winner.name, at: winner.solvedAt || 0 } : null,
    canStart:
      !!(
        you &&
        you.isHost &&
        room.status === "waiting" &&
        players.some((p) => p && p.role === "player")
      ),
    you: you
      ? {
          id: you.id,
          name: you.name,
          role: you.role,
          isHost: !!you.isHost
        }
      : null,
    hostSpectating: !!(host && host.role === "spectator"),
    solution: room.status === "finished" ? room.targetWord || "" : null
  };
}

export function isIdleExpired(lastActionAt) {
  return !lastActionAt || nowMs() - Number(lastActionAt) > ROOM_IDLE_TIMEOUT_MS;
}

export async function parseJsonRequest(request) {
  try {
    return await request.json();
  } catch (_) {
    return null;
  }
}

export async function parseJsonResponse(response) {
  try {
    return await response.json();
  } catch (_) {
    return null;
  }
}

async function ensureReviewSchema(db) {
  if (!db) return;
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
}

function normalizeWordList(rawList) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(rawList)) return out;
  for (const item of rawList) {
    const word = normalizeWord(item);
    if (!isCampaignWord(word) || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
  }
  return out;
}

export async function loadApprovedPool(env) {
  const now = nowMs();
  if (approvedPoolCache.words.length && now - approvedPoolCache.at < APPROVED_CACHE_TTL_MS) {
    return approvedPoolCache;
  }

  let words = [];
  if (env && env.DB) {
    try {
      await ensureReviewSchema(env.DB);
      const row = await env.DB
        .prepare("SELECT approved_json FROM word_review_state WHERE id = 1")
        .first();
      const parsed = row && row.approved_json ? JSON.parse(String(row.approved_json || "[]")) : [];
      words = normalizeWordList(parsed);
    } catch (_) {
      words = [];
    }
  }

  if (!words.length) words = FALLBACK_WORDS.slice();
  approvedPoolCache = { at: now, words, set: new Set(words) };
  return approvedPoolCache;
}

export async function validateCampaignName(env, rawName) {
  const normalized = normalizeWord(rawName);
  if (!isCampaignWord(normalized)) return { valid: false, normalized };
  const pool = await loadApprovedPool(env);
  return { valid: pool.set.has(normalized), normalized };
}

export async function pickRandomCampaignName(env, usedNames) {
  const pool = await loadApprovedPool(env);
  const candidates = pool.words.filter((word) => !usedNames.has(word));
  const picked =
    chooseRandom(candidates) || chooseRandom(pool.words) || chooseRandom(FALLBACK_WORDS) || "PLAYER";
  return makeUniqueName(picked, usedNames);
}

export async function pickTargetWord(env, preferredLength) {
  const pool = await loadApprovedPool(env);
  const desired = clampInt(preferredLength, 4, 8, 0);
  let candidates = pool.words.filter((word) => word.length >= 4 && word.length <= 8);
  if (desired) {
    const byLen = candidates.filter((word) => word.length === desired);
    if (byLen.length) candidates = byLen;
  }
  if (!candidates.length) candidates = FALLBACK_WORDS.slice();
  return chooseRandom(candidates) || "SPARK";
}

export function makeRoomId(existingRooms) {
  for (let i = 0; i < 80; i += 1) {
    let id = "";
    for (let n = 0; n < ROOM_ID_LEN; n += 1) {
      id += ROOM_ID_ALPHABET[randomInt(ROOM_ID_ALPHABET.length)];
    }
    if (!existingRooms[id]) return id;
  }
  return "";
}
