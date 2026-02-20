import { handleWordReview } from "./_lib/word-review.js";
import { json } from "./_lib/multiplayer-shared.js";
import { LobbyDirectoryDO } from "./_lib/multiplayer-directory.js";
import { LobbyRoomDO } from "./_lib/multiplayer-room.js";

export { LobbyDirectoryDO, LobbyRoomDO };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/word-review" || path === "/.netlify/functions/word-review") {
      return handleWordReview(request, env);
    }

    if (path.startsWith("/api/lobbies")) {
      if (!(env && env.LOBBY_DIRECTORY && env.LOBBY_ROOM)) {
        return json(500, {
          ok: false,
          error: "Multiplayer Durable Objects are not configured.",
          hint: "Bind LOBBY_DIRECTORY and LOBBY_ROOM in wrangler.jsonc and redeploy."
        });
      }
      const directoryId = env.LOBBY_DIRECTORY.idFromName("global-lobby-directory");
      const directoryStub = env.LOBBY_DIRECTORY.get(directoryId);
      return directoryStub.fetch(request);
    }

    if (env && env.ASSETS && typeof env.ASSETS.fetch === "function") {
      return env.ASSETS.fetch(request);
    }
    return new Response("Not found", { status: 404 });
  }
};
