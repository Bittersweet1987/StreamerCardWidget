// Streamer Card Widget - anonymer Nutzungszähler (VPS-Variante, ersetzt den Cloudflare Worker)
// Speicher: einfache JSON-Datei (data.json) neben diesem Skript - für die paar hundert
// Installationen dieser App voellig ausreichend, kein Datenbank-Server noetig.
//
// Endpunkte:
//   POST /event  { "type": "connect", "id": "<gehashte Twitch-User-ID>" }
//   POST /sync   { "installId": "<zufällige, pro Installation stabile ID>", "cards": 12, "boosters": 3 }
//   GET  /stats  -> { "users": 3, "boosters": 28, "cards": 370 }

const express = require("express");
const fs = require("fs");
const path = require("path");

const DATA_FILE = path.join(__dirname, "data.json");
const PORT = 3377;

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return { users: {}, installs: {} };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data), "utf8");
}

let data = loadData();

function computeAgg() {
  const users = Object.keys(data.users).length;
  let cards = 0;
  let boosters = 0;
  for (const key in data.installs) {
    cards += data.installs[key].cards || 0;
    boosters += data.installs[key].boosters || 0;
  }
  return { users, cards, boosters };
}

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/stats", (req, res) => {
  res.json(computeAgg());
});

app.post("/event", (req, res) => {
  const body = req.body || {};
  if (body.type !== "connect") return res.status(400).send("Unknown type");
  const id = String(body.id || "").slice(0, 128);
  if (!id) return res.status(400).send("Missing id");
  if (!data.users[id]) {
    data.users[id] = 1;
    saveData(data);
  }
  res.json({ ok: true });
});

app.post("/sync", (req, res) => {
  const body = req.body || {};
  const installId = String(body.installId || "").slice(0, 128);
  if (!installId) return res.status(400).send("Missing installId");
  const cards = Math.max(0, Number(body.cards) || 0);
  const boosters = Math.max(0, Number(body.boosters) || 0);
  const prev = data.installs[installId];
  if (prev && prev.cards === cards && prev.boosters === boosters) {
    prev.lastSeen = new Date().toISOString();
    saveData(data);
    return res.json({ ok: true, unchanged: true });
  }
  data.installs[installId] = { cards, boosters, lastSeen: new Date().toISOString() };
  saveData(data);
  res.json({ ok: true });
});

app.listen(PORT, "127.0.0.1", () => {
  console.log("streamercard-stats listening on 127.0.0.1:" + PORT);
});
