import { handleWordReview } from "./_lib/word-review.js";
import { json } from "./_lib/multiplayer-shared.js";

export async function onRequest(context) {
  const request = context.request;
  const env = context.env;
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
        hint: "Bind LOBBY_DIRECTORY and LOBBY_ROOM in Pages settings."
      });
    }
    const directoryId = env.LOBBY_DIRECTORY.idFromName("global-lobby-directory");
    const directoryStub = env.LOBBY_DIRECTORY.get(directoryId);
    return directoryStub.fetch(request);
  }

  return json(404, { ok: false, error: "Route not found." });
}
