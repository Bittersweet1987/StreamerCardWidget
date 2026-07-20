// Asset version (BootId) propagated from this module's own URL (set by the page's bootstrap
// loader) into the shared-module imports below, so api.js/render.js are always fetched at the
// same version as this file - OBS/Meld can never mix a fresh page module with stale shared code.
const __v = new URL(import.meta.url).searchParams.get("v") || String(Date.now());
const { connectEventStream, getSettings } = await import(`./api.js?v=${__v}`);
const { applyOverlayLayout, applyTheme, normalizeSettings } = await import(`./render.js?v=${__v}`);

const stage = document.querySelector("#commandshelp-stage");
const status = document.querySelector("#status");

let settings;
let cycleToken = 0; // bumped whenever the loop must restart (settings changed) - the running
                     // loop checks this after every await and bails out if it no longer matches.

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setStatus(text, show = false) {
  if (!status) return;
  status.textContent = text;
  status.hidden = !show;
}

function escapeForOverlay(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const STRINGS = {
  de: {
    chatEyebrow: "Chat-Befehl",
    pointsEyebrow: "Kanalpunkte",
    exampleLabel: "Beispiel",
    sampleUser: "@Zuschauer",
    sampleCard: "Kartenname",
    packDesc: "Löst einen zufälligen Kartenpack aus.",
    packsDesc: "Listet alle verfügbaren Booster mit ihrer Ziehchance auf.",
    collectionDesc: "Zeigt die eigene Kartensammlung im Overlay und/oder im Chat.",
    dustDesc: "Opfert doppelt besessene Karten gegen Garantie-Punkte.",
    dustSetDesc: "Legt fest, bis zu welcher Seltenheit \"Alle Duplikate opfern\" automatisch greift.",
    dustAllDesc: "Opfert automatisch alle doppelten Karten bis zur eingestellten Seltenheit.",
    giftDesc: "Verschenkt eine eigene Karte an eine andere Person im Chat.",
    tradeDesc: "Bietet einer anderen Person einen Kartentausch an.",
    battleDesc: "Fordert eine andere Person zu einem Kartenduell heraus.",
    rankingDesc: "Zeigt die Bestenliste zu einer Karte oder zu Kämpfen/Turnieren/Team-Kämpfen.",
    tournamentJoinDesc: "Tritt einer laufenden Turnier-Anmeldung bei.",
    tournamentStartDesc: "Startet die Anmeldephase für ein neues Turnier.",
    teamBattleJoinDesc: "Tritt einem laufenden Team-Kampf bei.",
    teamBattleStartDesc: "Startet die Anmeldephase für einen neuen Team-Kampf.",
    pointsRedeem: (cost) => `Für ${cost} Kanalpunkte einlösen.`
  },
  en: {
    chatEyebrow: "Chat command",
    pointsEyebrow: "Channel points",
    exampleLabel: "Example",
    sampleUser: "@viewer",
    sampleCard: "card name",
    packDesc: "Draws a random card pack.",
    packsDesc: "Lists every available booster with its draw chance.",
    collectionDesc: "Shows your own card collection in the overlay and/or chat.",
    dustDesc: "Sacrifices duplicate cards for pity points.",
    dustSetDesc: "Sets up to which rarity \"sacrifice all duplicates\" applies automatically.",
    dustAllDesc: "Automatically sacrifices all duplicate cards up to the set rarity.",
    giftDesc: "Gives one of your own cards to another person in chat.",
    tradeDesc: "Offers another person a card trade.",
    battleDesc: "Challenges another person to a card duel.",
    rankingDesc: "Shows the leaderboard for a card or for battles/tournaments/team battles.",
    tournamentJoinDesc: "Joins an ongoing tournament signup.",
    tournamentStartDesc: "Starts the signup phase for a new tournament.",
    teamBattleJoinDesc: "Joins an ongoing team battle.",
    teamBattleStartDesc: "Starts the signup phase for a new team battle.",
    pointsRedeem: (cost) => `Redeem for ${cost} channel points.`
  },
  fr: {
    chatEyebrow: "Commande de chat",
    pointsEyebrow: "Points de chaîne",
    exampleLabel: "Exemple",
    sampleUser: "@spectateur",
    sampleCard: "nom de la carte",
    packDesc: "Tire un booster de cartes aléatoire.",
    packsDesc: "Liste tous les boosters disponibles avec leur chance de tirage.",
    collectionDesc: "Affiche ta collection de cartes dans l'overlay et/ou le chat.",
    dustDesc: "Sacrifie des cartes en double contre des points de pitié.",
    dustSetDesc: "Définit jusqu'à quelle rareté \"sacrifier tous les doublons\" s'applique automatiquement.",
    dustAllDesc: "Sacrifie automatiquement tous les doublons jusqu'à la rareté définie.",
    giftDesc: "Offre une de tes cartes à une autre personne dans le chat.",
    tradeDesc: "Propose un échange de cartes à une autre personne.",
    battleDesc: "Défie une autre personne en duel de cartes.",
    rankingDesc: "Affiche le classement d'une carte ou des combats/tournois/combats d'équipe.",
    tournamentJoinDesc: "Rejoint une inscription au tournoi en cours.",
    tournamentStartDesc: "Démarre la phase d'inscription pour un nouveau tournoi.",
    teamBattleJoinDesc: "Rejoint un combat d'équipe en cours.",
    teamBattleStartDesc: "Démarre la phase d'inscription pour un nouveau combat d'équipe.",
    pointsRedeem: (cost) => `À échanger contre ${cost} points de chaîne.`
  },
  es: {
    chatEyebrow: "Comando de chat",
    pointsEyebrow: "Puntos de canal",
    exampleLabel: "Ejemplo",
    sampleUser: "@espectador",
    sampleCard: "nombre de la carta",
    packDesc: "Saca un sobre de cartas al azar.",
    packsDesc: "Lista todos los sobres disponibles con su probabilidad de tirada.",
    collectionDesc: "Muestra tu colección de cartas en el overlay y/o el chat.",
    dustDesc: "Sacrifica cartas duplicadas a cambio de puntos de compensación.",
    dustSetDesc: "Define hasta qué rareza se aplica automáticamente \"sacrificar todos los duplicados\".",
    dustAllDesc: "Sacrifica automáticamente todos los duplicados hasta la rareza definida.",
    giftDesc: "Regala una de tus cartas a otra persona en el chat.",
    tradeDesc: "Ofrece un intercambio de cartas a otra persona.",
    battleDesc: "Reta a otra persona a un duelo de cartas.",
    rankingDesc: "Muestra la clasificación de una carta o de combates/torneos/combates de equipo.",
    tournamentJoinDesc: "Se une a una inscripción de torneo en curso.",
    tournamentStartDesc: "Inicia la fase de inscripción de un nuevo torneo.",
    teamBattleJoinDesc: "Se une a un combate de equipo en curso.",
    teamBattleStartDesc: "Inicia la fase de inscripción de un nuevo combate de equipo.",
    pointsRedeem: (cost) => `Canjear por ${cost} puntos de canal.`
  },
  th: {
    chatEyebrow: "คำสั่งแชท",
    pointsEyebrow: "แชนแนลพอยท์",
    exampleLabel: "ตัวอย่าง",
    sampleUser: "@ผู้ชม",
    sampleCard: "ชื่อการ์ด",
    packDesc: "สุ่มเปิดบูสเตอร์การ์ด",
    packsDesc: "แสดงรายการบูสเตอร์ที่ใช้งานได้ทั้งหมดพร้อมโอกาสสุ่ม",
    collectionDesc: "แสดงคอลเลกชันการ์ดของคุณในโอเวอร์เลย์และ/หรือแชท",
    dustDesc: "สังเวยการ์ดที่มีซ้ำเพื่อแลกแต้มการันตี",
    dustSetDesc: "กำหนดว่า \"สังเวยการ์ดซ้ำทั้งหมด\" จะมีผลอัตโนมัติถึงระดับความหายากใด",
    dustAllDesc: "สังเวยการ์ดซ้ำทั้งหมดโดยอัตโนมัติสูงสุดถึงระดับความหายากที่ตั้งไว้",
    giftDesc: "มอบการ์ดของคุณให้กับผู้อื่นในแชท",
    tradeDesc: "เสนอแลกเปลี่ยนการ์ดกับผู้อื่น",
    battleDesc: "ท้าดวลการ์ดกับผู้อื่น",
    rankingDesc: "แสดงอันดับของการ์ดหรือของการต่อสู้/ทัวร์นาเมนต์/การต่อสู้ทีม",
    tournamentJoinDesc: "เข้าร่วมการสมัครทัวร์นาเมนต์ที่กำลังเปิดอยู่",
    tournamentStartDesc: "เริ่มช่วงสมัครสำหรับทัวร์นาเมนต์ใหม่",
    teamBattleJoinDesc: "เข้าร่วมการต่อสู้ทีมที่กำลังเปิดอยู่",
    teamBattleStartDesc: "เริ่มช่วงสมัครสำหรับการต่อสู้ทีมใหม่",
    pointsRedeem: (cost) => `แลกด้วย ${cost} แชนแนลพอยท์`
  }
};

function strings() {
  return STRINGS[settings?.language] || STRINGS.de;
}

function sampleCardTitle() {
  const cards = (settings?.deck?.cards || []).filter((card) => card.enabled !== false && card.title);
  return cards[0]?.title || strings().sampleCard;
}

// Builds the list of currently active items to cycle through - every enabled chat command and
// every enabled (and unpaused) channel-points reward, each with a category, a title, a
// description (the streamer's own configured helpText when set, otherwise a sensible built-in
// default) and a concrete, ready-to-copy usage example using a real card title when possible.
function buildItems() {
  const s = strings();
  const cc = settings?.chatCommands || {};
  const cmdText = (cfg) => `${cfg?.prefix || "!"}${cfg?.command || ""}`;
  const items = [];

  const addChat = (key, exampleSuffix, fallbackDesc) => {
    const cfg = cc[key];
    if (!cfg || cfg.enabled === false) return;
    items.push({
      category: "chat",
      title: cmdText(cfg),
      description: (cfg.helpText || "").trim() || fallbackDesc,
      example: `${cmdText(cfg)}${exampleSuffix ? " " + exampleSuffix : ""}`
    });
  };

  addChat("pack", "", s.packDesc);
  addChat("packs", "", s.packsDesc);
  addChat("collection", "", s.collectionDesc);
  if (cc.dust?.enabled) {
    addChat("dust", `${sampleCardTitle()} 1`, s.dustDesc);
    // dustSet/dustAll are sub-commands of !dust: no prefix/enabled of their own, they always
    // use dust's prefix and only fire while dust itself is enabled (see server-side dispatch).
    const dustPrefix = cc.dust?.prefix || "!";
    if (cc.dustSet?.command) {
      items.push({
        category: "chat",
        title: `${dustPrefix}${cc.dustSet.command}`,
        description: (cc.dustSet.helpText || "").trim() || s.dustSetDesc,
        example: `${dustPrefix}${cc.dustSet.command} legendär`
      });
    }
    if (cc.dustAll?.command) {
      items.push({
        category: "chat",
        title: `${dustPrefix}${cc.dustAll.command}`,
        description: (cc.dustAll.helpText || "").trim() || s.dustAllDesc,
        example: `${dustPrefix}${cc.dustAll.command}`
      });
    }
  }
  addChat("gift", `${s.sampleUser} ${sampleCardTitle()}`, s.giftDesc);
  addChat("trade", `${s.sampleUser} ${sampleCardTitle()}`, s.tradeDesc);
  addChat("battle", s.sampleUser, s.battleDesc);
  addChat("ranking", sampleCardTitle(), s.rankingDesc);
  if (settings?.tournament?.enabled) {
    addChat("tournamentJoin", "", s.tournamentJoinDesc);
    addChat("tournamentStart", "", s.tournamentStartDesc);
  }
  if (settings?.teamBattle?.enabled) {
    addChat("teamBattleJoin", "", s.teamBattleJoinDesc);
    addChat("teamBattleStart", "", s.teamBattleStartDesc);
  }

  const addReward = (cfg, gate = true) => {
    if (!cfg || !gate || cfg.rewardEnabled === false || cfg.rewardPaused === true) return;
    items.push({
      category: "points",
      title: cfg.rewardName || "",
      description: (cfg.rewardPrompt || "").trim() || s.pointsRedeem(cfg.rewardCost ?? 0),
      example: s.pointsRedeem(cfg.rewardCost ?? 0)
    });
  };
  addReward(settings?.draw);
  addReward(settings?.showcase);
  addReward(settings?.tournament, settings?.tournament?.enabled);
  addReward(settings?.teamBattle, settings?.teamBattle?.enabled);

  return items;
}

function renderItem(scene, item) {
  const s = strings();
  scene.innerHTML = `
    <div class="commandshelp-panel">
      <span class="commandshelp-eyebrow">${item.category === "points" ? escapeForOverlay(s.pointsEyebrow) : escapeForOverlay(s.chatEyebrow)}</span>
      <h2 class="commandshelp-title">${escapeForOverlay(item.title)}</h2>
      <p class="commandshelp-description">${escapeForOverlay(item.description)}</p>
      <div class="commandshelp-example">
        <span class="commandshelp-example-label">${escapeForOverlay(s.exampleLabel)}</span>
        <span class="commandshelp-example-text">${escapeForOverlay(item.example)}</span>
      </div>
    </div>
  `;
}

async function runCycle(token) {
  const items = buildItems();
  stage.innerHTML = "";
  if (!settings?.commandsHelp?.enabled || items.length === 0) return;

  const seconds = Math.max(2, Number(settings.commandsHelp.secondsPerItem) || 6);
  const scene = document.createElement("div");
  scene.className = "commandshelp-scene";
  stage.append(scene);

  let index = 0;
  while (token === cycleToken) {
    renderItem(scene, items[index]);
    await delay(seconds * 1000);
    if (token !== cycleToken) return;
    index = (index + 1) % items.length;
  }
}

async function loadSettings() {
  settings = normalizeSettings(await getSettings());
  applyTheme(settings);
  applyOverlayLayout(stage, settings.overlayLayout?.commandsHelp, "commandsHelp");
  cycleToken += 1;
  runCycle(cycleToken);
}

function bindServerEvents() {
  connectEventStream({
    settings: () => loadSettings(),
    collections: () => {},
    draw: () => {},
    trade: () => {},
    battle: () => {},
    showcollection: () => {}
  });
}

function bindDebugHooks() {
  window.commandsHelpOverlay = { reload: loadSettings };
}

async function init() {
  await loadSettings();
  bindServerEvents();
  bindDebugHooks();
}

init().catch((error) => setStatus(error.message, true));
