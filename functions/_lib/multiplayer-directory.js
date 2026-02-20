import {
  VERSION,
  ROOM_IDLE_TIMEOUT_MS,
  HUMAN_CHALLENGE_TTL_MS,
  HUMAN_CHALLENGE_LIMIT,
  MIN_PLAYERS,
  MAX_PLAYERS,
  DEFAULT_MAX_PLAYERS,
  json,
  nowMs,
  clampInt,
  randomInt,
  randomToken,
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
    this.registry = { rooms: {}, challenges: {} };
    this.ready = this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get("registry_v1");
      if (stored && typeof stored === "object") this.registry = stored;
      if (!this.registry.rooms || typeof this.registry.rooms !== "object") this.registry.rooms = {};
      if (!this.registry.challenges || typeof this.registry.challenges !== "object") {
        this.registry.challenges = {};
      }
    });
  }

  async save() {
    await this.state.storage.put("registry_v1", this.registry);
  }

  cleanupRegistry() {
    const now = nowMs();
    let changed = false;

    const challenges = this.registry.challenges || {};
    const challengeIds = Object.keys(challenges);
    if (challengeIds.length > HUMAN_CHALLENGE_LIMIT) {
      const ordered = challengeIds
        .map((id) => ({ id, createdAt: Number(challenges[id] && challenges[id].createdAt) || 0 }))
        .sort((a, b) => a.createdAt - b.createdAt);
      const removeCount = ordered.length - HUMAN_CHALLENGE_LIMIT;
      for (let i = 0; i < removeCount; i += 1) {
        delete challenges[ordered[i].id];
        changed = true;
      }
    }
    for (const id of Object.keys(challenges)) {
      const entry = challenges[id];
      if (!entry || now > Number(entry.expiresAt || 0)) {
        delete challenges[id];
        changed = true;
      }
    }

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

  issueChallenge() {
    let left = 0;
    let right = 0;
    let answer = 0;
    let prompt = "";

    if (randomInt(2) === 0) {
      left = randomInt(8) + 2;
      right = randomInt(8) + 1;
      answer = left + right;
      prompt = `${left} + ${right}`;
    } else {
      left = randomInt(8) + 2;
      right = randomInt(left - 1) + 1;
      answer = left - right;
      prompt = `${left} - ${right}`;
    }

    const challengeId = randomToken(18);
    this.registry.challenges[challengeId] = {
      answer: String(answer),
      createdAt: nowMs(),
      expiresAt: nowMs() + HUMAN_CHALLENGE_TTL_MS
    };
    return {
      challengeId,
      prompt: `${prompt} = ?`,
      expiresInMs: HUMAN_CHALLENGE_TTL_MS
    };
  }

  consumeChallenge(challengeId, challengeAnswer) {
    const id = String(challengeId || "").trim();
    const answer = String(challengeAnswer || "").trim();
    if (!id || !answer) return { ok: false, error: "Human verification is required." };
    const entry = this.registry.challenges[id];
    if (!entry) return { ok: false, error: "Verification challenge missing or expired." };
    delete this.registry.challenges[id];
    if (nowMs() > Number(entry.expiresAt || 0)) {
      return { ok: false, error: "Verification challenge expired. Try again." };
    }
    if (answer !== String(entry.answer || "")) {
      return { ok: false, error: "Verification answer is incorrect." };
    }
    return { ok: true };
  }

  roomStub(roomId) {
    const id = this.env.LOBBY_ROOM.idFromName(`room-${roomId}`);
    return this.env.LOBBY_ROOM.get(id);
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

  async handleNameValidate(request) {
    const body = (await parseJsonRequest(request)) || {};
    const check = await validateCampaignName(this.env, body.name);
    return json(200, { ok: true, normalized: check.normalized, valid: check.valid });
  }

  async handleCreate(request) {
    const body = (await parseJsonRequest(request)) || {};
    const challenge = this.consumeChallenge(body.challengeId, body.challengeAnswer);
    if (!challenge.ok) {
      await this.save();
      return json(400, { ok: false, error: challenge.error, code: "HUMAN_CHECK_FAILED" });
    }

    const mode = String(body.mode || "ranked").toLowerCase() === "custom" ? "custom" : "ranked";
    const maxPlayers = clampInt(body.maxPlayers, MIN_PLAYERS, MAX_PLAYERS, DEFAULT_MAX_PLAYERS);
    const roomId = makeRoomId(this.registry.rooms || {});
    if (!roomId) {
      await this.save();
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
      await this.save();
      return json(response.status || 500, payload || { ok: false, error: "Failed to create room." });
    }

    if (payload.roomSummary) this.registry.rooms[roomId] = payload.roomSummary;
    await this.save();
    return json(200, { ok: true, roomId, sessionToken: payload.sessionToken, room: payload.room });
  }

  async handleJoin(request) {
    const body = (await parseJsonRequest(request)) || {};
    const challenge = this.consumeChallenge(body.challengeId, body.challengeAnswer);
    if (!challenge.ok) {
      await this.save();
      return json(400, { ok: false, error: challenge.error, code: "HUMAN_CHECK_FAILED" });
    }

    const roomId = sanitizeRoomId(body.roomId);
    if (!roomId) {
      await this.save();
      return json(400, { ok: false, error: "Invalid room id." });
    }

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
    if (method === "POST" && path === "/api/lobbies/challenge") {
      const challenge = this.issueChallenge();
      await this.save();
      return json(200, { ok: true, ...challenge });
    }
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
