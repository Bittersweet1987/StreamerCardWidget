// Streamer Card Widget - anonymer Nutzungszähler
// Bindung: eine KV-Namespace-Bindung namens STATS wird benötigt (siehe Setup-Anleitung).
//
// Endpunkte:
//   POST /event  { "type": "connect", "id": "<gehashte Twitch-User-ID>" }
//   POST /sync   { "installId": "<zufällige, pro Installation stabile ID>", "cards": 12, "boosters": 3 }
//   GET  /stats  -> { "users": 3, "boosters": 28, "cards": 370 }
//
// Wichtig fürs Cloudflare-KV-Freikontingent (100k Reads, aber nur 1.000 Writes UND 1.000
// List-Operationen pro Tag): /stats liest ausschließlich einen einzigen, gepflegten
// Aggregat-Eintrag ("agg") - kein list()/get()-pro-Key mehr über alle Installationen. /sync
// und /event aktualisieren dieses Aggregat per Differenz (Delta), nicht durch Neu-Aufsummieren.

async function readAgg(env) {
  const raw = await env.STATS.get("agg");
  if (!raw) return { users: 0, cards: 0, boosters: 0 };
  try {
    const parsed = JSON.parse(raw);
    return {
      users: Number(parsed.users) || 0,
      cards: Number(parsed.cards) || 0,
      boosters: Number(parsed.boosters) || 0
    };
  } catch {
    return { users: 0, cards: 0, boosters: 0 };
  }
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
      const agg = await readAgg(env);
      return cors(Response.json(agg));
    }

    if (request.method === "POST" && url.pathname === "/event") {
      let body;
      try {
        body = await request.json();
      } catch {
        return cors(new Response("Bad JSON", { status: 400 }));
      }
      if (body?.type !== "connect") {
        return cors(new Response("Unknown type", { status: 400 }));
      }
      const id = String(body.id || "").slice(0, 128);
      if (!id) return cors(new Response("Missing id", { status: 400 }));

      // Only counts (and only writes) the FIRST time a given hashed id is seen - a
      // reconnect of the same account is a no-op, so this can be called often for free.
      const existing = await env.STATS.get(`user:${id}`);
      if (!existing) {
        const agg = await readAgg(env);
        agg.users += 1;
        await env.STATS.put(`user:${id}`, "1");
        await env.STATS.put("agg", JSON.stringify(agg));
      }
      return cors(Response.json({ ok: true }));
    }

    if (request.method === "POST" && url.pathname === "/sync") {
      let body;
      try {
        body = await request.json();
      } catch {
        return cors(new Response("Bad JSON", { status: 400 }));
      }
      const installId = String(body?.installId || "").slice(0, 128);
      if (!installId) return cors(new Response("Missing installId", { status: 400 }));
      const cards = Math.max(0, Number(body.cards) || 0);
      const boosters = Math.max(0, Number(body.boosters) || 0);

      const installKey = `install:${installId}`;
      const prevRaw = await env.STATS.get(installKey);
      let prevCards = 0;
      let prevBoosters = 0;
      if (prevRaw) {
        try {
          const prev = JSON.parse(prevRaw);
          prevCards = Number(prev.cards) || 0;
          prevBoosters = Number(prev.boosters) || 0;
        } catch {
          // treat as 0/0
        }
      }

      // No change since last sync for this install - skip both writes entirely.
      if (prevCards === cards && prevBoosters === boosters) {
        return cors(Response.json({ ok: true, unchanged: true }));
      }

      const agg = await readAgg(env);
      agg.cards += cards - prevCards;
      agg.boosters += boosters - prevBoosters;
      await env.STATS.put(installKey, JSON.stringify({ cards, boosters }));
      await env.STATS.put("agg", JSON.stringify(agg));
      return cors(Response.json({ ok: true }));
    }

    return cors(new Response("Not found", { status: 404 }));
  }
};
