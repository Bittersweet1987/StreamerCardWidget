// Streamer Card Widget - Aufräum-Tool für den anonymen Nutzungszähler (VPS-Variante).
//
// Hintergrund: Jede App-Installation bekommt eine zufällige, pro Installation stabile
// "installId" (siehe GetOrCreateStatsInstallId in src/CardPackWidgetApp.cs). Bis vor kurzem lag
// diese ID in settings.json - ein Reset dieser Datei (z.B. durch einen fehlerhaften Admin-Save)
// hat dann beim nächsten Sync eine NEUE ID erzeugt, unter der die App ihre Karten-/Boosterzahl
// erneut gemeldet hat. Der Server summiert aber ALLE jemals gesehenen IDs für immer auf (siehe
// stats-server.js computeAgg) - die alte ID bleibt als "Karteileiche" für immer mitgezählt, auch
// wenn es sich um dieselbe physische Installation handelt. Seit dem Fix (installId liegt jetzt in
// einer eigenen Datei, siehe data/stats-install-id.txt) kann das nicht mehr neu passieren, aber
// bereits entstandene Karteileichen in data.json bleiben bestehen, bis sie manuell entfernt werden.
//
// Dieses Skript kann das NICHT automatisch/zuverlässig erkennen (es gibt keine Verknüpfung
// zwischen einer alten und einer neuen ID für dieselbe Installation) - es hilft nur beim
// AUFFINDEN wahrscheinlicher Kandidaten (auffällig alte "lastSeen"-Zeitstempel, siehe unten) und
// beim sicheren ENTFERNEN einzelner Einträge nach manueller Prüfung.
//
// Läuft auf dem VPS, wo data.json liegt (neben stats-server.js) - NICHT lokal auf diesem Rechner.
//
// Verwendung:
//   node stats-cleanup.js                          - Übersicht aller Installationen, neueste zuerst
//   node stats-cleanup.js --stale-days=30           - markiert Einträge, die seit >30 Tagen nicht
//                                                      mehr synchronisiert wurden (Default: 90)
//   node stats-cleanup.js --remove=<id1>,<id2>,...  - entfernt die angegebenen installId(s), legt
//                                                      vorher ein Backup an (data.json.bak-<timestamp>)
//   node stats-cleanup.js --path=/pfad/zu/data.json - falls data.json nicht im selben Ordner liegt

const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = { staleDays: 90, remove: null, path: null };
  for (const raw of argv.slice(2)) {
    if (raw.startsWith("--stale-days=")) args.staleDays = Number(raw.slice("--stale-days=".length)) || 90;
    else if (raw.startsWith("--remove=")) args.remove = raw.slice("--remove=".length).split(",").map((s) => s.trim()).filter(Boolean);
    else if (raw.startsWith("--path=")) args.path = raw.slice("--path=".length);
  }
  return args;
}

function loadData(dataFile) {
  const raw = fs.readFileSync(dataFile, "utf8");
  const data = JSON.parse(raw);
  if (!data.users) data.users = {};
  if (!data.installs) data.installs = {};
  return data;
}

function saveData(dataFile, data) {
  fs.writeFileSync(dataFile, JSON.stringify(data), "utf8");
}

function daysAgo(isoString) {
  if (!isoString) return null;
  const ms = Date.now() - new Date(isoString).getTime();
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

function computeAgg(data) {
  const users = Object.keys(data.users).length;
  let cards = 0;
  let boosters = 0;
  for (const key in data.installs) {
    cards += data.installs[key].cards || 0;
    boosters += data.installs[key].boosters || 0;
  }
  return { users, cards, boosters };
}

function printOverview(data, staleDays) {
  const agg = computeAgg(data);
  console.log(`Aktuell gemeldet: ${agg.users} Nutzer, ${agg.boosters} Booster, ${agg.cards} Karten (Summe über ${Object.keys(data.installs).length} Installationen)\n`);

  const rows = Object.entries(data.installs).map(([id, entry]) => {
    const age = daysAgo(entry.lastSeen);
    return { id, cards: entry.cards || 0, boosters: entry.boosters || 0, age };
  });
  // Kein lastSeen (Einträge von vor dem Zeitstempel-Fix) zuerst - das sind die wahrscheinlichsten
  // Karteileichen, weil sie aus der Zeit VOR diesem Cleanup-Tool stammen. Danach älteste zuerst.
  rows.sort((a, b) => {
    if (a.age === null && b.age === null) return 0;
    if (a.age === null) return -1;
    if (b.age === null) return 1;
    return b.age - a.age;
  });

  console.log("installId                              Karten  Booster  zuletzt gesehen");
  console.log("--------------------------------------------------------------------------");
  for (const row of rows) {
    const ageLabel = row.age === null ? "unbekannt (vor Zeitstempel-Fix)" : `vor ${row.age} Tagen`;
    const flag = row.age === null || row.age > staleDays ? "  <- Kandidat, pruefen" : "";
    console.log(`${row.id.padEnd(38)} ${String(row.cards).padStart(6)}  ${String(row.boosters).padStart(7)}  ${ageLabel}${flag}`);
  }
  console.log(`\n"Kandidat" heisst nur: auffaellig, seit >${staleDays} Tagen (oder nie protokolliert) nicht mehr synchronisiert.`);
  console.log("Das kann ein echter Karteileichen-Eintrag sein - oder einfach eine App, die seitdem nicht mehr lief.");
  console.log("Vor dem Entfernen daher pruefen, nicht blind loeschen. Zum Entfernen: --remove=<installId>[,<installId>...]");
}

function removeInstalls(dataFile, data, ids) {
  const missing = ids.filter((id) => !(id in data.installs));
  if (missing.length) {
    console.error(`Diese installId(s) existieren nicht in data.json: ${missing.join(", ")}`);
    process.exit(1);
  }

  const backupPath = `${dataFile}.bak-${Date.now()}`;
  fs.copyFileSync(dataFile, backupPath);
  console.log(`Backup angelegt: ${backupPath}`);

  const before = computeAgg(data);
  for (const id of ids) delete data.installs[id];
  saveData(dataFile, data);
  const after = computeAgg(data);

  console.log(`${ids.length} Eintrag/Einträge entfernt.`);
  console.log(`Vorher:  ${before.boosters} Booster, ${before.cards} Karten`);
  console.log(`Nachher: ${after.boosters} Booster, ${after.cards} Karten`);
}

function main() {
  const args = parseArgs(process.argv);
  const dataFile = args.path || path.join(__dirname, "data.json");
  if (!fs.existsSync(dataFile)) {
    console.error(`data.json nicht gefunden unter: ${dataFile}`);
    console.error("Dieses Skript muss auf dem VPS laufen, wo stats-server.js seine data.json ablegt (oder --path=... angeben).");
    process.exit(1);
  }

  const data = loadData(dataFile);

  if (args.remove) {
    removeInstalls(dataFile, data, args.remove);
  } else {
    printOverview(data, args.staleDays);
  }
}

main();
