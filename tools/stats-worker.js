// Streamer Card Widget - anonymer Nutzungszähler
// Bindung: eine KV-Namespace-Bindung namens STATS wird benötigt (siehe Setup-Anleitung).
//
// Endpunkte:
//   POST /event  { "type": "connect", "id": "<gehashte Twitch-User-ID>" }
//   POST /event  { "type": "connect", "id": "<gehashte Twitch-User-ID>" }
//   POST /event  { "type": "card" }
//   POST /event  { "type": "booster" }
//   GET  /stats  -> { "users": 3, "boosters": 28, "cards": 370 }

const ALLOWED_TYPES = new Set(["connect", "card", "booster"]);

async function incrementCounter(env, key) {
  const current = Number((await env.STATS.get(key)) || "0");
  const next = current + 1;
  await env.STATS.put(key, String(next));
  return next;
}

async function countPrefix(env, prefix) {
  let cursor;
  let total = 0;
  do {
    const page = await env.STATS.list({ prefix, cursor });
    total += page.keys.length;
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return total;
}

function cors(response) {
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return response;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }

    if (request.method === "GET" && url.pathname === "/stats") {
      const [users, boosters, cards] = await Promise.all([
        countPrefix(env, "user:"),
        env.STATS.get("boosters_total"),
        env.STATS.get("cards_total")
      ]);
      return cors(
        Response.json({
          users,
          boosters: Number(boosters || "0"),
          cards: Number(cards || "0")
        })
      );
    }

    if (request.method === "POST" && url.pathname === "/event") {
      let body;
      try {
        body = await request.json();
      } catch {
        return cors(new Response("Bad JSON", { status: 400 }));
      }
      if (!ALLOWED_TYPES.has(body?.type)) {
        return cors(new Response("Unknown type", { status: 400 }));
      }

      if (body.type === "connect") {
        const id = String(body.id || "").slice(0, 128);
        if (!id) return cors(new Response("Missing id", { status: 400 }));
        // Storing the hashed id itself dedupes automatically: re-connecting the same
        // account just overwrites the same key instead of creating a new one.
        await env.STATS.put(`user:${id}`, "1");
      } else if (body.type === "card") {
        await incrementCounter(env, "cards_total");
      } else if (body.type === "booster") {
        await incrementCounter(env, "boosters_total");
      }

      return cors(Response.json({ ok: true }));
    }

    return cors(new Response("Not found", { status: 404 }));
  }
};
