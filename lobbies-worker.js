import { LobbyDirectoryDO } from "./functions/_lib/multiplayer-directory.js";
import { LobbyRoomDO } from "./functions/_lib/multiplayer-room.js";
import { json, VERSION } from "./functions/_lib/multiplayer-shared.js";

export { LobbyDirectoryDO, LobbyRoomDO };

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health" || url.pathname === "/") {
      return json(200, {
        ok: true,
        service: "wordshift-lobbies",
        version: VERSION
      });
    }
    return json(404, { ok: false, error: "Not found" });
  }
};
