(function () {
  if (window.__wordshiftMultiplayerBooted) return;
  window.__wordshiftMultiplayerBooted = true;

  var API_BASE = "/api/lobbies";
  var STORE_NAME_KEY = "ws_mp_name_v1";
  var STORE_SESSIONS_KEY = "ws_mp_sessions_v1";
  var LIST_POLL_MS = 6000;
  var ROOM_POLL_MS = 2300;

  var MUTATORS = [
    { key: "fog", label: "Fog" },
    { key: "countdown", label: "Countdown" },
    { key: "copycat", label: "Copycat" },
    { key: "budget", label: "Budget" },
    { key: "minDistance", label: "Min Distance" },
    { key: "doubleVision", label: "Double Vision" },
    { key: "wildcard", label: "Wildcard" },
    { key: "hotPotato", label: "Hot Potato" },
    { key: "hazeWeave", label: "Haze Weave" },
    { key: "staticShock", label: "Static Shock" },
    { key: "noisyArrows", label: "Noisy Arrows" },
    { key: "replaceMode", label: "Replace Mode" },
    { key: "mirror", label: "Mirror" },
    { key: "lifeline", label: "Lifeline" }
  ];

  var ui = {
    screen: null,
    listView: null,
    roomView: null,
    createModal: null
  };

  var state = {
    listTimer: null,
    roomTimer: null,
    roomId: "",
    sessionToken: "",
    roomData: null,
    nameReqId: 0
  };

  function $(id) {
    return document.getElementById(id);
  }

  function notify(msg, ms) {
    if (typeof window.toast === "function") {
      window.toast(String(msg || ""), ms || 2200);
    } else {
      console.log("[multiplayer]", msg);
    }
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function readJsonSafe(text) {
    try {
      return JSON.parse(String(text || ""));
    } catch (_) {
      return {};
    }
  }

  function loadSessions() {
    return readJsonSafe(localStorage.getItem(STORE_SESSIONS_KEY));
  }

  function saveSessions(next) {
    localStorage.setItem(STORE_SESSIONS_KEY, JSON.stringify(next || {}));
  }

  function getSession(roomId) {
    var all = loadSessions();
    return String(all[roomId] || "");
  }

  function setSession(roomId, token) {
    var all = loadSessions();
    if (token) all[roomId] = token;
    else delete all[roomId];
    saveSessions(all);
  }

  function getSavedName() {
    return String(localStorage.getItem(STORE_NAME_KEY) || "").trim().toUpperCase();
  }

  function setSavedName(name) {
    var clean = String(name || "").trim().toUpperCase().replace(/[^A-Z]/g, "");
    if (!clean) localStorage.removeItem(STORE_NAME_KEY);
    else localStorage.setItem(STORE_NAME_KEY, clean);
  }

  async function api(path, options) {
    var init = options || {};
    var headers = Object.assign({ "Content-Type": "application/json; charset=utf-8" }, init.headers || {});
    var res = await fetch(API_BASE + path, Object.assign({}, init, { headers: headers, cache: "no-store" }));
    var data = {};
    try {
      data = await res.json();
    } catch (_) {
      data = { ok: false, error: "Invalid server response." };
    }
    if (!res.ok || !data || data.ok === false) {
      var err = new Error((data && data.error) || ("HTTP " + res.status));
      err.status = res.status;
      err.payload = data;
      throw err;
    }
    return data;
  }

  async function runHumanCheck() {
    var challenge = await api("/challenge", { method: "POST", body: "{}" });
    var answer = window.prompt("Human check: solve this before continuing.\n" + challenge.prompt, "");
    if (answer === null) throw new Error("Cancelled.");
    return {
      challengeId: challenge.challengeId,
      challengeAnswer: String(answer || "").trim()
    };
  }

  function formatAgo(ts) {
    var n = Date.now() - Number(ts || 0);
    if (n < 15000) return "just now";
    var sec = Math.floor(n / 1000);
    if (sec < 60) return sec + "s ago";
    var min = Math.floor(sec / 60);
    if (min < 60) return min + "m ago";
    var hr = Math.floor(min / 60);
    return hr + "h ago";
  }

  function maskToText(mask) {
    var chars = String(mask || "").split("");
    if (!chars.length) return "-";
    return chars
      .map(function (c) {
        if (c === "G") return "G";
        if (c === "Y") return "Y";
        return "-";
      })
      .join(" ");
  }

  function ensureCss() {
    if ($("mpCssLink")) return;
    var link = document.createElement("link");
    link.id = "mpCssLink";
    link.rel = "stylesheet";
    link.href = "./multiplayer.css";
    document.head.appendChild(link);
  }

  function ensureUi() {
    if ($("multiplayerScreen")) {
      cacheUi();
      return;
    }
    var html = [
      '<div id="multiplayerScreen" class="screen mp-screen">',
      '  <div class="mp-shell">',
      '    <div class="mp-pane" id="mpListView">',
      '      <div class="mp-header">',
      '        <button class="menu-btn" id="mpBackBtn" type="button">Back</button>',
      '        <div class="mp-title">Multiplayer Lobbies</div>',
      '        <div class="mp-header-actions">',
      '          <button class="menu-btn" id="mpRefreshBtn" type="button">Refresh</button>',
      '          <button class="menu-btn primary" id="mpCreateBtn" type="button">Create Room</button>',
      "        </div>",
      "      </div>",
      '      <div class="mp-subrow">',
      '        <div class="mp-name-wrap">',
      '          <input id="mpQuickName" type="text" maxlength="8" placeholder="Preferred name (approved campaign word)">',
      '          <div id="mpQuickNameCheck" class="mp-name-check">Blank = random approved name</div>',
      "        </div>",
      '        <button class="menu-btn" id="mpValidateNameBtn" type="button">Validate</button>',
      "      </div>",
      '      <div class="mp-list-status" id="mpListStatus">Loading lobbies...</div>',
      '      <div class="mp-rooms" id="mpRooms"></div>',
      "    </div>",
      '    <div class="mp-pane mp-room-view" id="mpRoomView" hidden>',
      '      <div class="mp-header">',
      '        <button class="menu-btn" id="mpRoomBackBtn" type="button">Lobby List</button>',
      '        <div class="mp-title" id="mpRoomTitle">Room</div>',
      '        <div class="mp-header-actions">',
      '          <button class="menu-btn" id="mpLeaveBtn" type="button">Leave</button>',
      "        </div>",
      "      </div>",
      '      <div class="mp-room-meta-block" id="mpRoomMeta">Waiting for room state...</div>',
      '      <div class="mp-room-actions">',
      '        <button class="menu-btn primary" id="mpStartBtn" type="button">Start Match</button>',
      '        <button class="menu-btn" id="mpHostSpectateBtn" type="button">Host Spectate</button>',
      "      </div>",
      '      <form class="mp-guess-form" id="mpGuessForm">',
      '        <input id="mpGuessInput" type="text" maxlength="8" placeholder="Type guess">',
      '        <button class="menu-btn primary" type="submit">Guess</button>',
      "      </form>",
      '      <div class="mp-guess-feedback" id="mpGuessFeedback"></div>',
      '      <table class="mp-players"><thead><tr><th>Player</th><th>Role</th><th>Guesses</th><th>Mask</th></tr></thead><tbody id="mpPlayersBody"></tbody></table>',
      "    </div>",
      "  </div>",
      "</div>",
      '<div class="mp-modal" id="mpCreateModal">',
      '  <div class="mp-modal-card">',
      '    <div class="mp-title">Create Room</div>',
      '    <div class="mp-row"><label for="mpCreateRoomName">Room Name</label><input id="mpCreateRoomName" type="text" maxlength="36" placeholder="My Wordshift Lobby"></div>',
      '    <div class="mp-row"><label for="mpCreateMode">Mode</label><select id="mpCreateMode"><option value="ranked">Ranked (no mutators)</option><option value="custom">Custom (set mutators)</option></select></div>',
      '    <div class="mp-row"><label for="mpCreateName">Your Name</label><div class="mp-name-wrap"><input id="mpCreateName" type="text" maxlength="8" placeholder="Blank = random"><div id="mpCreateNameCheck" class="mp-name-check">Blank = random approved name</div></div></div>',
      '    <div class="mp-row mp-custom-only"><label for="mpCreateMaxPlayers">Max Players</label><input id="mpCreateMaxPlayers" type="number" min="2" max="24" value="6"></div>',
      '    <div class="mp-row mp-custom-only"><label for="mpCreateWordLength">Word Length (custom)</label><select id="mpCreateWordLength"><option value="">Any (4-8)</option><option value="4">4</option><option value="5">5</option><option value="6">6</option><option value="7">7</option><option value="8">8</option></select></div>',
      '    <div class="mp-row"><label><input id="mpCreateHostSpectate" type="checkbox"> Host spectates instead of playing</label></div>',
      '    <div class="mp-row mp-custom-only"><label>Mutators</label><div id="mpMutatorGrid" class="mp-mut-grid"></div></div>',
      '    <div class="mp-modal-actions"><button class="menu-btn" id="mpCreateCancel" type="button">Cancel</button><button class="menu-btn primary" id="mpCreateSubmit" type="button">Create</button></div>',
      "  </div>",
      "</div>"
    ].join("");
    document.body.insertAdjacentHTML("beforeend", html);
    cacheUi();
    bindUi();
  }

  function cacheUi() {
    ui.screen = $("multiplayerScreen");
    ui.listView = $("mpListView");
    ui.roomView = $("mpRoomView");
    ui.createModal = $("mpCreateModal");
  }

  function ensureMenuButton() {
    var btn = $("btnMultiplayer");
    if (!btn) {
      var actions = document.querySelector("#menuScreen .menu-actions");
      if (!actions) return;
      btn = document.createElement("button");
      btn.className = "menu-btn";
      btn.id = "btnMultiplayer";
      btn.textContent = "Multiplayer";
      var ref = $("btnWordReview");
      if (ref && ref.parentNode === actions) actions.insertBefore(btn, ref);
      else actions.appendChild(btn);
    }
    if (btn.__mpBound) return;
    btn.__mpBound = true;
    btn.addEventListener("click", openMultiplayer);
  }

  function stopListPolling() {
    if (state.listTimer) {
      clearInterval(state.listTimer);
      state.listTimer = null;
    }
  }

  function stopRoomPolling() {
    if (state.roomTimer) {
      clearInterval(state.roomTimer);
      state.roomTimer = null;
    }
  }

  function closeCreateModal() {
    if (!ui.createModal) return;
    ui.createModal.classList.remove("open");
  }

  function openCreateModal() {
    var n = getSavedName();
    if ($("mpCreateName")) $("mpCreateName").value = n;
    if ($("mpCreateRoomName")) $("mpCreateRoomName").value = "";
    if ($("mpCreateMode")) $("mpCreateMode").value = "ranked";
    if ($("mpCreateHostSpectate")) $("mpCreateHostSpectate").checked = false;
    if ($("mpCreateMaxPlayers")) $("mpCreateMaxPlayers").value = "6";
    if ($("mpCreateWordLength")) $("mpCreateWordLength").value = "";
    toggleModeFields();
    if (ui.createModal) ui.createModal.classList.add("open");
    updateNameBadge($("mpCreateName"), $("mpCreateNameCheck"), true);
  }

  function openMultiplayer() {
    ensureCss();
    ensureUi();
    stopRoomPolling();
    stopListPolling();
    closeCreateModal();
    var menu = $("menuScreen");
    var campaign = $("campaignMenuScreen");
    var app = $("app");
    if (menu) menu.classList.remove("active");
    if (campaign) campaign.classList.remove("active");
    if (app) app.classList.remove("active");
    if (typeof window.setBodyMode === "function") window.setBodyMode("menu");
    if (ui.screen) ui.screen.classList.add("active");
    if (ui.listView) ui.listView.hidden = false;
    if (ui.roomView) ui.roomView.hidden = true;
    startListPolling();
  }

  function closeMultiplayer() {
    stopListPolling();
    stopRoomPolling();
    closeCreateModal();
    if (ui.screen) ui.screen.classList.remove("active");
    if (typeof window.showMenu === "function") window.showMenu();
    else if ($("menuScreen")) $("menuScreen").classList.add("active");
  }

  function toggleModeFields() {
    var mode = $("mpCreateMode") ? $("mpCreateMode").value : "ranked";
    var custom = mode === "custom";
    var rows = document.querySelectorAll(".mp-custom-only");
    for (var i = 0; i < rows.length; i += 1) rows[i].style.display = custom ? "" : "none";
  }

  function setListStatus(text) {
    var el = $("mpListStatus");
    if (el) el.textContent = text || "";
  }

  async function updateNameBadge(inputEl, badgeEl, silent) {
    if (!inputEl || !badgeEl) return false;
    var value = String(inputEl.value || "").trim().toUpperCase().replace(/[^A-Z]/g, "");
    inputEl.value = value;
    if (!value) {
      badgeEl.className = "mp-name-check";
      badgeEl.textContent = "Blank = random approved name";
      return true;
    }
    var reqId = ++state.nameReqId;
    badgeEl.className = "mp-name-check";
    badgeEl.textContent = "Checking...";
    try {
      var data = await api("/name/validate", { method: "POST", body: JSON.stringify({ name: value }) });
      if (reqId !== state.nameReqId) return false;
      if (data.valid) {
        badgeEl.className = "mp-name-check valid";
        badgeEl.textContent = "Approved word";
        return true;
      }
      badgeEl.className = "mp-name-check invalid";
      badgeEl.textContent = "Not in approved campaign words";
      if (!silent) notify("Name must be an approved campaign word.");
      return false;
    } catch (err) {
      if (reqId !== state.nameReqId) return false;
      badgeEl.className = "mp-name-check invalid";
      badgeEl.textContent = "Validation failed";
      if (!silent) notify(err.message || "Name validation failed.");
      return false;
    }
  }

  function renderMutatorOptions() {
    var wrap = $("mpMutatorGrid");
    if (!wrap) return;
    var html = MUTATORS.map(function (m) {
      return '<label class="mp-mut-item"><input type="checkbox" data-mut="' + escapeHtml(m.key) + '"> ' + escapeHtml(m.label) + "</label>";
    }).join("");
    wrap.innerHTML = html;
  }

  function selectedMutators() {
    var wrap = $("mpMutatorGrid");
    if (!wrap) return [];
    var checks = wrap.querySelectorAll("input[data-mut]");
    var out = [];
    for (var i = 0; i < checks.length; i += 1) {
      if (!checks[i].checked) continue;
      out.push(String(checks[i].getAttribute("data-mut") || ""));
    }
    return out;
  }

  async function refreshRooms() {
    setListStatus("Loading lobbies...");
    try {
      var data = await api("/list", { method: "GET" });
      renderRooms(data.rooms || []);
      setListStatus((data.rooms || []).length + " lobbies online. Rooms expire after 15m of inactivity.");
    } catch (err) {
      setListStatus("Unable to load lobbies: " + (err.message || "request failed"));
      $("mpRooms").innerHTML = "";
    }
  }

  function renderRooms(rooms) {
    var wrap = $("mpRooms");
    if (!wrap) return;
    if (!rooms || !rooms.length) {
      wrap.innerHTML = '<div class="mp-room-card"><div><div class="mp-room-name">No active rooms</div><div class="mp-room-meta">Create one to start.</div></div></div>';
      return;
    }
    var html = rooms
      .map(function (room) {
        var id = escapeHtml(room.id || "");
        var roomName = escapeHtml(room.roomName || ("Room " + id));
        var status = String(room.status || "waiting").toLowerCase();
        var mode = escapeHtml(String(room.mode || "ranked").toUpperCase());
        var pCount = Number(room.playerCount || 0);
        var maxP = Number(room.maxPlayers || 0);
        var mutText = Number(room.mutatorCount || 0) > 0 ? room.mutatorCount + " mutators" : "No mutators";
        var idText = getSession(room.id) ? "Resume" : "Join";
        return (
          '<div class="mp-room-card">' +
          "<div>" +
          '<div class="mp-room-name">' +
          roomName +
          " [" +
          id +
          "]</div>" +
          '<div class="mp-room-meta">' +
          '<span class="mp-pill ' +
          escapeHtml(status) +
          '">' +
          escapeHtml(status.toUpperCase()) +
          "</span>" +
          '<span class="mp-pill">' +
          mode +
          "</span>" +
          '<span class="mp-pill">' +
          pCount +
          "/" +
          maxP +
          " players</span>" +
          '<span class="mp-pill">' +
          escapeHtml(mutText) +
          "</span>" +
          '<span class="mp-pill">active ' +
          escapeHtml(formatAgo(room.lastActionAt)) +
          "</span>" +
          "</div>" +
          "</div>" +
          '<button class="menu-btn primary" data-join-room="' +
          id +
          '">' +
          escapeHtml(idText) +
          "</button>" +
          "</div>"
        );
      })
      .join("");
    wrap.innerHTML = html;
  }

  function startListPolling() {
    stopRoomPolling();
    stopListPolling();
    refreshRooms();
    state.listTimer = setInterval(refreshRooms, LIST_POLL_MS);
  }

  async function openRoom(roomId, token, roomData) {
    state.roomId = String(roomId || "");
    state.sessionToken = String(token || "");
    state.roomData = roomData || null;
    stopListPolling();
    if (ui.listView) ui.listView.hidden = true;
    if (ui.roomView) ui.roomView.hidden = false;
    renderRoom(roomData || null);
    stopRoomPolling();
    await pollRoomState();
    state.roomTimer = setInterval(pollRoomState, ROOM_POLL_MS);
  }

  function returnToList() {
    state.roomId = "";
    state.sessionToken = "";
    state.roomData = null;
    stopRoomPolling();
    if (ui.listView) ui.listView.hidden = false;
    if (ui.roomView) ui.roomView.hidden = true;
    startListPolling();
  }

  async function pollRoomState() {
    if (!state.roomId) return;
    try {
      var data = await api(
        "/" + encodeURIComponent(state.roomId) + "/state?sessionToken=" + encodeURIComponent(state.sessionToken || ""),
        { method: "GET" }
      );
      state.roomData = data.room || null;
      renderRoom(state.roomData);
    } catch (err) {
      if (err.status === 410 || err.status === 404) {
        notify("Room expired or closed.");
        setSession(state.roomId, "");
        returnToList();
        return;
      }
      $("mpGuessFeedback").textContent = "State update failed: " + (err.message || "request failed");
    }
  }

  function renderRoom(room) {
    if (!room) {
      $("mpRoomTitle").textContent = "Room";
      $("mpRoomMeta").textContent = "Loading room...";
      $("mpPlayersBody").innerHTML = "";
      return;
    }
    $("mpRoomTitle").textContent = (room.roomName || "Room") + " [" + room.id + "]";
    $("mpRoomMeta").textContent =
      String(room.mode || "").toUpperCase() +
      " | " +
      String(room.status || "").toUpperCase() +
      " | " +
      Number(room.playerCount || 0) +
      "/" +
      Number(room.maxPlayers || 0) +
      " players | " +
      Number((room.mutators || []).length) +
      " mutators";

    var you = room.you || null;
    var startBtn = $("mpStartBtn");
    var spectateBtn = $("mpHostSpectateBtn");
    var guessForm = $("mpGuessForm");
    var guessInput = $("mpGuessInput");
    if (startBtn) startBtn.style.display = you && you.isHost && room.status === "waiting" && room.canStart ? "" : "none";
    if (spectateBtn) {
      spectateBtn.style.display = you && you.isHost && room.status === "waiting" ? "" : "none";
      spectateBtn.textContent = room.hostSpectating ? "Host Play Instead" : "Host Spectate";
    }
    if (guessForm) guessForm.style.display = room.status === "live" && you && you.role === "player" ? "grid" : "none";
    if (guessInput) guessInput.maxLength = Number(room.wordLength || 8);

    if (room.status === "finished" && room.winner) {
      $("mpGuessFeedback").textContent =
        "Winner: " + room.winner.name + ". Solution: " + (room.solution || "(hidden)");
    }

    var body = $("mpPlayersBody");
    var players = Array.isArray(room.players) ? room.players : [];
    body.innerHTML = players
      .map(function (p) {
        var role = p.isHost ? (p.role === "spectator" ? "Host Spectator" : "Host Player") : p.role;
        var mark = you && you.id === p.id ? " (You)" : "";
        return (
          "<tr>" +
          "<td>" +
          escapeHtml(p.name + mark) +
          "</td>" +
          "<td>" +
          escapeHtml(role) +
          "</td>" +
          "<td>" +
          escapeHtml(String(p.guessCount || 0)) +
          "</td>" +
          '<td class="mp-masked">' +
          escapeHtml(maskToText(p.lastGuessMask || "")) +
          "</td>" +
          "</tr>"
        );
      })
      .join("");
  }

  async function submitRoomAction(type, payload) {
    if (!state.roomId) return null;
    try {
      var body = Object.assign({ type: type, sessionToken: state.sessionToken }, payload || {});
      var data = await api("/" + encodeURIComponent(state.roomId) + "/action", {
        method: "POST",
        body: JSON.stringify(body)
      });
      if (data.room) {
        state.roomData = data.room;
        renderRoom(state.roomData);
      }
      return data;
    } catch (err) {
      if (err.status === 410 || err.status === 404) {
        notify("Room closed.");
        setSession(state.roomId, "");
        returnToList();
        return null;
      }
      notify(err.message || "Action failed.");
      return null;
    }
  }

  async function joinRoom(roomId) {
    var human = await runHumanCheck();
    var nameInput = $("mpQuickName");
    var name = String(nameInput ? nameInput.value : "").trim().toUpperCase().replace(/[^A-Z]/g, "");
    if (nameInput) nameInput.value = name;
    setSavedName(name);
    var existing = getSession(roomId);
    var data = await api("/join", {
      method: "POST",
      body: JSON.stringify({
        roomId: roomId,
        name: name,
        sessionToken: existing || "",
        challengeId: human.challengeId,
        challengeAnswer: human.challengeAnswer
      })
    });
    setSession(roomId, data.sessionToken || "");
    await openRoom(roomId, data.sessionToken || "", data.room || null);
  }

  async function createRoom() {
    var nameEl = $("mpCreateName");
    var name = String(nameEl ? nameEl.value : "").trim().toUpperCase().replace(/[^A-Z]/g, "");
    if (nameEl) nameEl.value = name;
    setSavedName(name);
    var human = await runHumanCheck();
    var mode = $("mpCreateMode") ? $("mpCreateMode").value : "ranked";
    var body = {
      roomName: $("mpCreateRoomName") ? $("mpCreateRoomName").value : "",
      mode: mode,
      name: name,
      hostSpectator: !!($("mpCreateHostSpectate") && $("mpCreateHostSpectate").checked),
      maxPlayers: Number($("mpCreateMaxPlayers") ? $("mpCreateMaxPlayers").value : 6),
      wordLength: Number($("mpCreateWordLength") ? $("mpCreateWordLength").value : 0) || 0,
      mutators: mode === "custom" ? selectedMutators() : [],
      challengeId: human.challengeId,
      challengeAnswer: human.challengeAnswer
    };
    var data = await api("/create", { method: "POST", body: JSON.stringify(body) });
    closeCreateModal();
    setSession(data.roomId, data.sessionToken || "");
    await openRoom(data.roomId, data.sessionToken || "", data.room || null);
  }

  function bindUi() {
    if ($("mpBackBtn")) $("mpBackBtn").addEventListener("click", closeMultiplayer);
    if ($("mpRefreshBtn")) $("mpRefreshBtn").addEventListener("click", refreshRooms);
    if ($("mpCreateBtn")) $("mpCreateBtn").addEventListener("click", openCreateModal);
    if ($("mpRoomBackBtn")) $("mpRoomBackBtn").addEventListener("click", returnToList);
    if ($("mpLeaveBtn")) {
      $("mpLeaveBtn").addEventListener("click", async function () {
        await submitRoomAction("leave", {});
        setSession(state.roomId, "");
        returnToList();
      });
    }
    if ($("mpStartBtn")) $("mpStartBtn").addEventListener("click", function () { submitRoomAction("start", {}); });
    if ($("mpHostSpectateBtn")) {
      $("mpHostSpectateBtn").addEventListener("click", function () {
        var enabled = !(state.roomData && state.roomData.hostSpectating);
        submitRoomAction("host_spectate", { enabled: enabled });
      });
    }
    if ($("mpGuessForm")) {
      $("mpGuessForm").addEventListener("submit", async function (e) {
        e.preventDefault();
        var guess = String($("mpGuessInput") ? $("mpGuessInput").value : "")
          .trim()
          .toUpperCase()
          .replace(/[^A-Z]/g, "");
        if ($("mpGuessInput")) $("mpGuessInput").value = guess;
        if (!guess) return;
        var data = await submitRoomAction("guess", { guess: guess });
        if (data && data.guessResult) {
          $("mpGuessFeedback").textContent =
            "Guess " + data.guessResult.guess + " -> " + maskToText(data.guessResult.mask || "");
        }
      });
    }

    if ($("mpRooms")) {
      $("mpRooms").addEventListener("click", function (e) {
        var btn = e.target && e.target.closest ? e.target.closest("[data-join-room]") : null;
        if (!btn) return;
        var roomId = String(btn.getAttribute("data-join-room") || "");
        if (!roomId) return;
        joinRoom(roomId).catch(function (err) {
          notify(err.message || "Join failed.");
        });
      });
    }

    if ($("mpCreateMode")) $("mpCreateMode").addEventListener("change", toggleModeFields);
    if ($("mpCreateCancel")) $("mpCreateCancel").addEventListener("click", closeCreateModal);
    if ($("mpCreateSubmit")) {
      $("mpCreateSubmit").addEventListener("click", function () {
        createRoom().catch(function (err) {
          notify(err.message || "Create room failed.");
        });
      });
    }

    if (ui.createModal) {
      ui.createModal.addEventListener("click", function (e) {
        if (e.target === ui.createModal) closeCreateModal();
      });
    }

    var quickName = $("mpQuickName");
    if (quickName) {
      quickName.value = getSavedName();
      var t1 = null;
      quickName.addEventListener("input", function () {
        clearTimeout(t1);
        t1 = setTimeout(function () {
          updateNameBadge(quickName, $("mpQuickNameCheck"), true);
        }, 240);
      });
    }
    if ($("mpValidateNameBtn")) {
      $("mpValidateNameBtn").addEventListener("click", function () {
        updateNameBadge($("mpQuickName"), $("mpQuickNameCheck"), false);
      });
    }

    var createName = $("mpCreateName");
    if (createName) {
      var t2 = null;
      createName.addEventListener("input", function () {
        clearTimeout(t2);
        t2 = setTimeout(function () {
          updateNameBadge(createName, $("mpCreateNameCheck"), true);
        }, 240);
      });
    }
  }

  ensureCss();
  ensureUi();
  renderMutatorOptions();
  toggleModeFields();
  updateNameBadge($("mpQuickName"), $("mpQuickNameCheck"), true);
  ensureMenuButton();
})();
