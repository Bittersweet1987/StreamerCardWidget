// Streamer Card Widget - anonymer Nutzungszähler
// Bindung: eine KV-Namespace-Bindung namens STATS wird benötigt (siehe Setup-Anleitung).
//
// Endpunkte:
//   POST /event  { "type": "connect", "id": "<gehashte Twitch-User-ID>" }
//   POST /sync   { "installId": "<zufällige, pro Installation stabile ID>", "cards": 12, "boosters": 3 }
//   GET  /stats  -> { "users": 3, "boosters": 28, "cards": 370 }
//
// /sync wird bei jedem Speichern in der App aufgerufen und meldet den AKTUELLEN Gesamtbestand
// dieser Installation (nicht nur Neuanlagen) - dadurch ist ein wiederholter Aufruf idempotent
// (überschreibt einfach denselben Eintrag) statt bei jedem Speichern erneut hochzuzählen, und
// bereits vor dem Update vorhandene Karten/Booster werden beim ersten Speichern automatisch
// mit erfasst.

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

async function sumInstallTotals(env) {
  let cursor;
  let cards = 0;
  let boosters = 0;
  do {
    const page = await env.STATS.list({ prefix: "install:", cursor });
    for (const key of page.keys) {
      const raw = await env.STATS.get(key.name);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        cards += Number(parsed.cards) || 0;
        boosters += Number(parsed.boosters) || 0;
      } catch {
        // ignore malformed entries
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return { cards, boosters };
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
      const [users, totals] = await Promise.all([countPrefix(env, "user:"), sumInstallTotals(env)]);
      return cors(Response.json({ users, boosters: totals.boosters, cards: totals.cards }));
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
      // Storing the hashed id itself dedupes automatically: re-connecting the same
      // account just overwrites the same key instead of creating a new one.
      await env.STATS.put(`user:${id}`, "1");
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
      await env.STATS.put(`install:${installId}`, JSON.stringify({ cards, boosters }));
      return cors(Response.json({ ok: true }));
    }

    return cors(new Response("Not found", { status: 404 }));
  }
};
