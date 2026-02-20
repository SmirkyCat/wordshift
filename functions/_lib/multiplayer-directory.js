import {
  VERSION,
  ROOM_IDLE_TIMEOUT_MS,
  MIN_PLAYERS,
  MAX_PLAYERS,
  DEFAULT_MAX_PLAYERS,
  json,
  nowMs,
  clampInt,
  sanitizeRoomId,
  sanitizeRoomName,
  sanitizeMutatorList,
  isIdleExpired,
  parseJsonRequest,
  parseJsonResponse,
  validateCampaignName,
  makeRoomId
} from "./multiplayer-shared.js";

export class LobbyDirectoryDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.registry = { rooms: {} };
    this.ready = this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get("registry_v1");
      if (stored && typeof stored === "object") this.registry = stored;
      if (!this.registry.rooms || typeof this.registry.rooms !== "object") this.registry.rooms = {};
    });
  }

  async save() {
    await this.state.storage.put("registry_v1", this.registry);
  }

  cleanupRegistry() {
    let changed = false;
    const rooms = this.registry.rooms || {};
    for (const roomId of Object.keys(rooms)) {
      const meta = rooms[roomId];
      if (!meta) {
        delete rooms[roomId];
        changed = true;
        continue;
      }
      if (meta.status === "expired" || isIdleExpired(meta.lastActionAt || 0)) {
        delete rooms[roomId];
        changed = true;
      }
    }
    return changed;
  }

  roomStub(roomId) {
    const id = this.env.LOBBY_ROOM.idFromName(`room-${roomId}`);
    return this.env.LOBBY_ROOM.get(id);
  }

  turnstileConfig() {
    const siteKey = String((this.env && this.env.TURNSTILE_SITE_KEY) || "").trim();
    const secretKey = String((this.env && this.env.TURNSTILE_SECRET_KEY) || "").trim();
    return {
      siteKey,
      secretKey,
      enabled: !!(siteKey && secretKey)
    };
  }

  getClientIp(request) {
    const ip = String(
      (request && request.headers && request.headers.get("cf-connecting-ip")) ||
        (request && request.headers && request.headers.get("x-forwarded-for")) ||
        ""
    )
      .split(",")[0]
      .trim();
    return ip || "";
  }

  async verifyTurnstile(request, token) {
    const cfg = this.turnstileConfig();
    if (!cfg.enabled) {
      return {
        ok: false,
        statusCode: 503,
        error: "Human verification is not configured on server.",
        code: "TURNSTILE_NOT_CONFIGURED"
      };
    }

    const responseToken = String(token || "").trim();
    if (!responseToken) {
      return {
        ok: false,
        statusCode: 400,
        error: "Complete human verification before continuing.",
        code: "HUMAN_CHECK_FAILED"
      };
    }

    const form = new URLSearchParams();
    form.set("secret", cfg.secretKey);
    form.set("response", responseToken);
    const ip = this.getClientIp(request);
    if (ip) form.set("remoteip", ip);

    let response = null;
    let payload = null;
    try {
      response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        body: form
      });
      payload = await response.json();
    } catch (_) {
      return {
        ok: false,
        statusCode: 502,
        error: "Could not verify human check token.",
        code: "TURNSTILE_VERIFY_FAILED"
      };
    }

    if (!response.ok || !payload || payload.success !== true) {
      return {
        ok: false,
        statusCode: 400,
        error: "Human verification failed.",
        code: "HUMAN_CHECK_FAILED",
        details: payload && payload["error-codes"] ? payload["error-codes"] : []
      };
    }

    return { ok: true };
  }

  async proxyRoomState(roomId, sessionToken) {
    const stub = this.roomStub(roomId);
    const query = sessionToken ? `?sessionToken=${encodeURIComponent(sessionToken)}` : "";
    const response = await stub.fetch(`https://room.internal/room/state${query}`);
    const data = await parseJsonResponse(response);
    return { response, data };
  }

  async proxyRoomAction(roomId, body) {
    const stub = this.roomStub(roomId);
    const response = await stub.fetch("https://room.internal/room/action", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(body || {})
    });
    const data = await parseJsonResponse(response);
    return { response, data };
  }

  async updateRoomMetaFromPayload(roomId, payload, statusCode) {
    if (
      statusCode === 410 ||
      statusCode === 404 ||
      (payload && (payload.code === "ROOM_EXPIRED" || payload.code === "ROOM_NOT_FOUND"))
    ) {
      delete this.registry.rooms[roomId];
      await this.save();
      return;
    }
    if (payload && payload.roomSummary) {
      this.registry.rooms[roomId] = payload.roomSummary;
      await this.save();
    }
  }

  async handleList() {
    if (this.cleanupRegistry()) await this.save();
    const rooms = Object.values(this.registry.rooms || {})
      .filter(Boolean)
      .sort((a, b) => Number(b.lastActionAt || 0) - Number(a.lastActionAt || 0))
      .slice(0, 200);
    return json(200, { ok: true, version: VERSION, timeoutMs: ROOM_IDLE_TIMEOUT_MS, rooms, now: nowMs() });
  }

  async handleChallenge() {
    const cfg = this.turnstileConfig();
    return json(200, {
      ok: true,
      turnstileEnabled: !!cfg.enabled,
      siteKey: cfg.siteKey || ""
    });
  }

  async handleNameValidate(request) {
    const body = (await parseJsonRequest(request)) || {};
    const check = await validateCampaignName(this.env, body.name);
    return json(200, { ok: true, normalized: check.normalized, valid: check.valid });
  }

  async handleCreate(request) {
    const body = (await parseJsonRequest(request)) || {};
    const human = await this.verifyTurnstile(request, body.turnstileToken);
    if (!human.ok) {
      return json(human.statusCode || 400, {
        ok: false,
        error: human.error,
        code: human.code,
        details: human.details || []
      });
    }

    const mode = String(body.mode || "ranked").toLowerCase() === "custom" ? "custom" : "ranked";
    const maxPlayers = clampInt(body.maxPlayers, MIN_PLAYERS, MAX_PLAYERS, DEFAULT_MAX_PLAYERS);
    const roomId = makeRoomId(this.registry.rooms || {});
    if (!roomId) {
      return json(503, { ok: false, error: "Unable to allocate room id. Retry shortly." });
    }

    const response = await this.roomStub(roomId).fetch("https://room.internal/room/init", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        roomId,
        roomName: sanitizeRoomName(body.roomName, roomId),
        mode,
        maxPlayers,
        mutators: mode === "custom" ? sanitizeMutatorList(body.mutators) : [],
        requestedName: String(body.name || ""),
        hostSpectator: !!body.hostSpectator,
        wordLength: mode === "custom" ? clampInt(body.wordLength, 4, 8, 0) : 0
      })
    });
    const payload = await parseJsonResponse(response);
    if (!response.ok || !payload || !payload.ok) {
      return json(response.status || 500, payload || { ok: false, error: "Failed to create room." });
    }

    if (payload.roomSummary) this.registry.rooms[roomId] = payload.roomSummary;
    await this.save();
    return json(200, { ok: true, roomId, sessionToken: payload.sessionToken, room: payload.room });
  }

  async handleJoin(request) {
    const body = (await parseJsonRequest(request)) || {};
    const human = await this.verifyTurnstile(request, body.turnstileToken);
    if (!human.ok) {
      return json(human.statusCode || 400, {
        ok: false,
        error: human.error,
        code: human.code,
        details: human.details || []
      });
    }

    const roomId = sanitizeRoomId(body.roomId);
    if (!roomId) return json(400, { ok: false, error: "Invalid room id." });

    const response = await this.roomStub(roomId).fetch("https://room.internal/room/join", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        requestedName: String(body.name || ""),
        sessionToken: String(body.sessionToken || "")
      })
    });
    const payload = await parseJsonResponse(response);
    await this.updateRoomMetaFromPayload(roomId, payload, response.status);

    if (!response.ok || !payload || !payload.ok) {
      return json(response.status || 500, payload || { ok: false, error: "Join failed." });
    }
    return json(200, { ok: true, roomId, sessionToken: payload.sessionToken, room: payload.room });
  }

  async handleRoomState(url) {
    const match = /^\/api\/lobbies\/([A-Z0-9]{6})\/state$/.exec(url.pathname);
    if (!match) return json(404, { ok: false, error: "Unknown route" });
    const roomId = match[1];
    const sessionToken = String(url.searchParams.get("sessionToken") || "");
    const proxied = await this.proxyRoomState(roomId, sessionToken);
    await this.updateRoomMetaFromPayload(roomId, proxied.data, proxied.response.status);
    return json(proxied.response.status || 500, proxied.data || { ok: false, error: "Room state unavailable." });
  }

  async handleRoomAction(url, request) {
    const match = /^\/api\/lobbies\/([A-Z0-9]{6})\/action$/.exec(url.pathname);
    if (!match) return json(404, { ok: false, error: "Unknown route" });
    const roomId = match[1];
    const body = (await parseJsonRequest(request)) || {};
    const proxied = await this.proxyRoomAction(roomId, body);
    await this.updateRoomMetaFromPayload(roomId, proxied.data, proxied.response.status);
    return json(proxied.response.status || 500, proxied.data || { ok: false, error: "Room action failed." });
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    const path = url.pathname;
    const method = String(request.method || "GET").toUpperCase();

    if (this.cleanupRegistry()) await this.save();

    if (method === "GET" && path === "/api/lobbies/list") return this.handleList();
    if (method === "POST" && path === "/api/lobbies/challenge") return this.handleChallenge();
    if (method === "POST" && path === "/api/lobbies/name/validate") return this.handleNameValidate(request);
    if (method === "POST" && path === "/api/lobbies/create") return this.handleCreate(request);
    if (method === "POST" && path === "/api/lobbies/join") return this.handleJoin(request);
    if (method === "GET" && /^\/api\/lobbies\/[A-Z0-9]{6}\/state$/.test(path)) {
      return this.handleRoomState(url);
    }
    if ((method === "POST" || method === "PUT") && /^\/api\/lobbies\/[A-Z0-9]{6}\/action$/.test(path)) {
      return this.handleRoomAction(url, request);
    }
    return json(404, { ok: false, error: "Route not found." });
  }
}
