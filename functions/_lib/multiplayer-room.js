import {
  VERSION,
  MIN_PLAYERS,
  MAX_PLAYERS,
  DEFAULT_MAX_PLAYERS,
  json,
  nowMs,
  clampInt,
  normalizeWord,
  sanitizeRoomId,
  sanitizeRoomName,
  sanitizeMutatorList,
  scoreGuess,
  randomToken,
  makeUniqueName,
  roomSummaryFromState,
  roomPublicState,
  isIdleExpired,
  parseJsonRequest,
  loadApprovedPool,
  validateCampaignName,
  pickRandomCampaignName,
  pickTargetWord
} from "./multiplayer-shared.js";

export class LobbyRoomDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.room = null;
    this.ready = this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get("room_v1");
      if (stored && typeof stored === "object") this.room = stored;
    });
  }

  async save() {
    if (!this.room) return;
    await this.state.storage.put("room_v1", this.room);
  }

  findPlayerBySession(sessionToken) {
    if (!this.room || !Array.isArray(this.room.players)) return null;
    return this.room.players.find((p) => p && p.sessionToken === sessionToken) || null;
  }

  usedNamesSet() {
    const used = new Set();
    if (!this.room || !Array.isArray(this.room.players)) return used;
    for (const player of this.room.players) {
      if (!player || !player.name) continue;
      used.add(String(player.name).toUpperCase());
    }
    return used;
  }

  activePlayerCount() {
    if (!this.room || !Array.isArray(this.room.players)) return 0;
    return this.room.players.filter((p) => p && p.role === "player").length;
  }

  async expireIfIdle() {
    if (!this.room) return false;
    if (this.room.status === "expired") return true;
    if (!isIdleExpired(this.room.lastActionAt || 0)) return false;
    this.room.status = "expired";
    this.room.finishedAt = this.room.finishedAt || nowMs();
    await this.save();
    return true;
  }

  touch() {
    if (!this.room) return;
    this.room.lastActionAt = nowMs();
  }

  buildOkResponse(sessionToken, extra) {
    return {
      ok: true,
      version: VERSION,
      room: roomPublicState(this.room, sessionToken),
      roomSummary: roomSummaryFromState(this.room),
      ...(extra || {})
    };
  }

  async resolveName(requestedName) {
    const used = this.usedNamesSet();
    const requested = normalizeWord(requestedName);
    if (requested) {
      const check = await validateCampaignName(this.env, requested);
      if (!check.valid) {
        return {
          ok: false,
          error: "Name must be an approved campaign word (4-8 letters)."
        };
      }
      return { ok: true, name: makeUniqueName(check.normalized, used) };
    }
    const generated = await pickRandomCampaignName(this.env, used);
    return { ok: true, name: generated };
  }

  async handleInit(request) {
    if (this.room) return json(409, { ok: false, error: "Room already initialized." });

    const body = (await parseJsonRequest(request)) || {};
    const roomId = sanitizeRoomId(body.roomId);
    if (!roomId) return json(400, { ok: false, error: "Invalid room id." });

    const mode = String(body.mode || "ranked").toLowerCase() === "custom" ? "custom" : "ranked";
    const maxPlayers = clampInt(body.maxPlayers, MIN_PLAYERS, MAX_PLAYERS, DEFAULT_MAX_PLAYERS);
    const hostSpectator = !!body.hostSpectator;
    const mutators = mode === "custom" ? sanitizeMutatorList(body.mutators) : [];
    const wordLength = mode === "custom" ? clampInt(body.wordLength, 4, 8, 0) : 0;

    const nameResult = await this.resolveName(body.requestedName);
    if (!nameResult.ok) return json(400, { ok: false, error: nameResult.error });

    const sessionToken = randomToken(28);
    const hostPlayer = {
      id: randomToken(12),
      sessionToken,
      name: nameResult.name,
      role: hostSpectator ? "spectator" : "player",
      isHost: true,
      joinedAt: nowMs(),
      lastActionAt: nowMs(),
      guessCount: 0,
      lastGuessMask: "",
      solvedAt: 0
    };

    this.room = {
      id: roomId,
      roomName: sanitizeRoomName(body.roomName, roomId),
      mode,
      maxPlayers,
      mutators,
      wordLength,
      status: "waiting",
      targetWord: "",
      winnerPlayerId: "",
      createdAt: nowMs(),
      lastActionAt: nowMs(),
      startedAt: 0,
      finishedAt: 0,
      players: [hostPlayer]
    };

    await this.save();
    return json(200, { ...this.buildOkResponse(sessionToken), sessionToken });
  }

  async handleJoin(request) {
    if (!this.room) return json(404, { ok: false, error: "Room not found.", code: "ROOM_NOT_FOUND" });
    if (await this.expireIfIdle()) {
      return json(410, { ok: false, error: "Room expired due to inactivity.", code: "ROOM_EXPIRED" });
    }

    const body = (await parseJsonRequest(request)) || {};
    const existingToken = String(body.sessionToken || "").trim();
    if (existingToken) {
      const existing = this.findPlayerBySession(existingToken);
      if (existing) return json(200, { ...this.buildOkResponse(existingToken), sessionToken: existingToken });
    }

    if (this.activePlayerCount() >= this.room.maxPlayers) {
      return json(409, { ok: false, error: "Room is full.", code: "ROOM_FULL" });
    }

    const nameResult = await this.resolveName(body.requestedName);
    if (!nameResult.ok) return json(400, { ok: false, error: nameResult.error });

    const sessionToken = randomToken(28);
    const player = {
      id: randomToken(12),
      sessionToken,
      name: nameResult.name,
      role: "player",
      isHost: false,
      joinedAt: nowMs(),
      lastActionAt: nowMs(),
      guessCount: 0,
      lastGuessMask: "",
      solvedAt: 0
    };

    this.room.players.push(player);
    this.touch();
    await this.save();
    return json(200, { ...this.buildOkResponse(sessionToken), sessionToken });
  }

  async handleState(url) {
    if (!this.room) return json(404, { ok: false, error: "Room not found.", code: "ROOM_NOT_FOUND" });
    if (await this.expireIfIdle()) {
      return json(410, { ok: false, error: "Room expired due to inactivity.", code: "ROOM_EXPIRED" });
    }
    const sessionToken = String(url.searchParams.get("sessionToken") || "");
    return json(200, this.buildOkResponse(sessionToken));
  }

  async handleAction(request) {
    if (!this.room) return json(404, { ok: false, error: "Room not found.", code: "ROOM_NOT_FOUND" });
    if (await this.expireIfIdle()) {
      return json(410, { ok: false, error: "Room expired due to inactivity.", code: "ROOM_EXPIRED" });
    }

    const body = (await parseJsonRequest(request)) || {};
    const actionType = String(body.type || "").trim().toLowerCase();
    const sessionToken = String(body.sessionToken || "").trim();
    const player = this.findPlayerBySession(sessionToken);
    if (!actionType) return json(400, { ok: false, error: "Missing action type." });

    if (actionType === "leave") {
      if (!player) return json(200, { ok: true, roomSummary: roomSummaryFromState(this.room) });
      if (player.isHost) {
        this.room.status = "expired";
        this.touch();
        await this.save();
        return json(410, {
          ok: false,
          error: "Host left. Room closed.",
          code: "ROOM_EXPIRED",
          roomSummary: roomSummaryFromState(this.room)
        });
      }
      this.room.players = this.room.players.filter((p) => p.sessionToken !== sessionToken);
      if (!this.room.players.length) {
        this.room.status = "expired";
        this.touch();
        await this.save();
        return json(410, {
          ok: false,
          error: "Room closed.",
          code: "ROOM_EXPIRED",
          roomSummary: roomSummaryFromState(this.room)
        });
      }
      this.touch();
      await this.save();
      return json(200, this.buildOkResponse(""));
    }

    if (!player) return json(401, { ok: false, error: "Join the room first." });

    if (actionType === "heartbeat") {
      player.lastActionAt = nowMs();
      this.touch();
      await this.save();
      return json(200, this.buildOkResponse(sessionToken));
    }

    if (actionType === "start") {
      if (!player.isHost) return json(403, { ok: false, error: "Only host can start." });
      if (this.room.status !== "waiting") return json(409, { ok: false, error: "Match already started." });
      if (!this.room.players.some((p) => p.role === "player")) {
        return json(409, { ok: false, error: "Need at least one active player." });
      }
      const targetWord = await pickTargetWord(this.env, this.room.wordLength || 0);
      this.room.targetWord = targetWord;
      this.room.wordLength = targetWord.length;
      this.room.status = "live";
      this.room.startedAt = nowMs();
      this.room.finishedAt = 0;
      this.room.winnerPlayerId = "";
      for (const p of this.room.players) {
        p.guessCount = 0;
        p.lastGuessMask = "";
        p.solvedAt = 0;
      }
      this.touch();
      await this.save();
      return json(200, this.buildOkResponse(sessionToken));
    }

    if (actionType === "host_spectate") {
      if (!player.isHost) return json(403, { ok: false, error: "Only host can toggle this." });
      if (this.room.status !== "waiting") {
        return json(409, { ok: false, error: "Can only change host role before start." });
      }
      const enabled = !!body.enabled;
      if (enabled && player.role !== "spectator") player.role = "spectator";
      else if (!enabled && player.role !== "player") {
        if (this.activePlayerCount() >= this.room.maxPlayers) {
          return json(409, { ok: false, error: "Room is full for active players." });
        }
        player.role = "player";
      }
      this.touch();
      await this.save();
      return json(200, this.buildOkResponse(sessionToken));
    }

    if (actionType === "guess") {
      if (player.role !== "player") return json(409, { ok: false, error: "Spectators cannot submit guesses." });
      if (this.room.status !== "live") return json(409, { ok: false, error: "Match is not active." });
      const guess = normalizeWord(body.guess);
      if (!guess || guess.length !== this.room.wordLength) {
        return json(400, { ok: false, error: `Guess must be ${this.room.wordLength} letters.` });
      }
      const pool = await loadApprovedPool(this.env);
      if (!pool.set.has(guess)) {
        return json(400, { ok: false, error: "Guess must be an approved campaign word." });
      }
      const mask = scoreGuess(guess, this.room.targetWord || "");
      player.guessCount = (player.guessCount || 0) + 1;
      player.lastGuessMask = mask;
      player.lastActionAt = nowMs();
      let correct = false;
      if (guess === this.room.targetWord && this.room.status === "live") {
        correct = true;
        player.solvedAt = nowMs();
        this.room.winnerPlayerId = player.id;
        this.room.status = "finished";
        this.room.finishedAt = nowMs();
      }
      this.touch();
      await this.save();
      return json(200, this.buildOkResponse(sessionToken, { guessResult: { guess, mask, correct } }));
    }

    return json(400, { ok: false, error: "Unknown action type." });
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    const path = url.pathname;
    const method = String(request.method || "GET").toUpperCase();
    if (path === "/room/init" && method === "POST") return this.handleInit(request);
    if (path === "/room/join" && method === "POST") return this.handleJoin(request);
    if (path === "/room/state" && method === "GET") return this.handleState(url);
    if (path === "/room/action" && (method === "POST" || method === "PUT")) {
      return this.handleAction(request);
    }
    return json(404, { ok: false, error: "Room route not found." });
  }
}
