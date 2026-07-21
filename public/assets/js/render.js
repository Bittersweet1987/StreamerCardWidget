export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

// Safety cap against runaway/corrupt data, not a design limit — raise here if ever needed.
export const MAX_BOOSTER_CARDS = 400;

export function linesToArray(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function arrayToLines(value) {
  return Array.isArray(value) ? value.join("\n") : "";
}

export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Downscales an uploaded image to a sane maximum size before it's stored as base64 in
// settings.json. Card/booster art was previously kept at whatever resolution the user uploaded
// it at (often several MB each as base64) - with ~200 cards that adds up to a settings.json many
// times larger than necessary, which is what makes every save slow and what the WebView2
// renderer has to hold in memory for every card mounted in the admin UI. Stays PNG (not JPEG) so
// transparent card-art cutouts aren't given a solid background.
export function compressImageDataUrl(dataUrl, maxWidth = 500, maxHeight = 700) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxWidth / img.width, maxHeight / img.height);
      if (scale >= 1) {
        resolve(dataUrl);
        return;
      }
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

// Target aspect ratios (width/height) of the card/booster art area - matches the CSS
// (.tcg-card{aspect-ratio:5/7} and .pack-body{aspect-ratio:4/5.25} in components.css). Used to
// auto-pick a sensible object-position anchor for uploaded images that don't naturally match the
// frame's shape (see autoImagePosition below).
export const CARD_ART_RATIO = 5 / 7;
export const BOOSTER_ART_RATIO = 4 / 5.25;

// Reads a data URL's natural pixel dimensions without touching the DOM beyond a throwaway
// Image() - used right after a card/booster image upload to auto-detect the best crop anchor.
export function getImageDimensions(dataUrl) {
  return new Promise((resolve) => {
    if (!dataUrl) { resolve(null); return; }
    const img = new Image();
    img.onload = () => resolve({ width: img.width, height: img.height });
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

// Auto-picks a crop/fit mode for an uploaded image against the card/booster art frame. The art
// area crops to fill its frame by default (object-fit:cover) - two failure modes come from that:
//   - Image proportionally TALLER than the frame: cropping trims top/bottom. Centering that crop
//     is what makes uploaded character/portrait art look "oddly scaled" - a face near the top of
//     the image gets cut off. Anchoring to the top instead keeps it in frame.
//   - Image proportionally WIDER than the frame (including square images going into the
//     portrait 5:7/4:5.25 card/booster frame - e.g. a 500x500 profile picture): cropping trims
//     the LEFT and RIGHT sides instead, and unlike the top-crop case there's no reliable
//     horizontal anchor to auto-detect without real content analysis - centering can still cut
//     off meaningful content on either edge. Switching to object-fit:contain here instead shows
//     the WHOLE image (letterboxed within the frame) rather than guessing which side to crop.
// Close-to-matching ratios fall through to "" (the existing default center crop) since there's
// nothing meaningfully wrong with cropping evenly in that case.
export function autoImagePosition(dimensions, targetRatio) {
  if (!dimensions || !dimensions.width || !dimensions.height) return "";
  const imageRatio = dimensions.width / dimensions.height;
  if (imageRatio < targetRatio * 0.85) return "top";
  if (imageRatio > targetRatio * 1.15) return "contain";
  return "";
}

// Bump whenever autoImagePosition's heuristic changes in a way that should re-run for every
// already-uploaded image, not just new ones - see migrateImageSizes in admin.js, which recomputes
// everything once when settings.style.imageAutoFitVersion is behind this.
export const IMAGE_AUTO_FIT_VERSION = 2;

export function createId(prefix = "card") {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${prefix}-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

export const RARITIES = [
  { id: "common", label: "Gewöhnlich", weight: 100 },
  { id: "uncommon", label: "Ungewöhnlich", weight: 60 },
  { id: "rare", label: "Selten", weight: 30 },
  { id: "epic", label: "Episch", weight: 12 },
  { id: "legendary", label: "Legendär", weight: 4 },
  { id: "holo", label: "Holo", weight: 1 }
];

export const DEFAULT_RARITY_COLORS = {
  common: "#ffffff",
  uncommon: "#2dd4c4",
  rare: "#3b82f6",
  epic: "#3b1f63",
  legendary: "#d4af37",
  holo: "#c9aef9"
};

export const DEFAULT_RARITY_WEIGHTS = RARITIES.reduce((acc, rarity) => {
  acc[rarity.id] = rarity.weight;
  return acc;
}, {});

let activeRarityColors = { ...DEFAULT_RARITY_COLORS };
let activeRarityWeights = { ...DEFAULT_RARITY_WEIGHTS };
let activeCardImageFit = "frame";
let activeBoosterImageFit = "center";

export function setImageFit(cardFit, boosterFit) {
  activeCardImageFit = ["frame", "full", "top", "bottom", "left", "right"].includes(cardFit) ? cardFit : "frame";
  activeBoosterImageFit = ["center", "top", "bottom", "left", "right"].includes(boosterFit) ? boosterFit : "center";
}

export function setRarityColors(colors) {
  activeRarityColors = { ...DEFAULT_RARITY_COLORS, ...(colors || {}) };
}

export function rarityColor(id) {
  const normalized = String(id || "").toLowerCase();
  return activeRarityColors[normalized] || DEFAULT_RARITY_COLORS.common;
}

export function setRarityWeights(weights) {
  activeRarityWeights = { ...DEFAULT_RARITY_WEIGHTS, ...(weights || {}) };
}

export function rarityById(id) {
  const normalized = String(id || "").toLowerCase();
  return RARITIES.find((rarity) => rarity.id === normalized || rarity.label.toLowerCase() === normalized) || RARITIES[0];
}

export function rarityWeight(card) {
  const id = rarityById(card?.rarity).id;
  const value = Number(activeRarityWeights[id]);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_RARITY_WEIGHTS[id];
}

export function weightedPick(cards) {
  const pool = cards.filter((card) => card.enabled !== false);
  if (!pool.length) return cards[0] || null;
  const total = pool.reduce((sum, card) => sum + rarityWeight(card), 0);
  let cursor = Math.random() * total;
  for (const card of pool) {
    cursor -= rarityWeight(card);
    if (cursor <= 0) return card;
  }
  return pool[pool.length - 1];
}

export function weightedBoosterPick(boosters = []) {
  const active = boosters.filter((booster) => booster.enabled !== false);
  const pool = active.filter((booster) => Number(booster.score ?? 100) > 0);
  const effectivePool = pool.length ? pool : active;
  if (!effectivePool.length) return null;
  const total = effectivePool.reduce((sum, booster) => sum + Number(booster.score ?? 100), 0);
  let cursor = Math.random() * total;
  for (const booster of effectivePool) {
    cursor -= Number(booster.score ?? 100);
    if (cursor <= 0) return booster;
  }
  return effectivePool[effectivePool.length - 1];
}

export const SUPPORTED_LANGUAGES = ["de", "en", "fr", "es", "th"];

// Default suggested chat message texts, per language - only ever applied via `||=` the first
// time a field is empty (e.g. a brand-new settings.json), so a user's own edits are never
// overwritten. The bracketed tokens (e.g. [Kartenname]) are matched literally by the C# server
// and must stay in German in every language - only the surrounding sentence is translated.
const DEFAULT_MESSAGES = {
  drawPost: {
    de: "@userName hat [Kartenname] aus [Boostername] gezogen.",
    en: "@userName drew [Kartenname] from [Boostername].",
    fr: "@userName a tiré [Kartenname] de [Boostername].",
    es: "@userName obtuvo [Kartenname] de [Boostername].",
    th: "@userName ได้รับ [Kartenname] จาก [Boostername]"
  },
  packLimit: {
    de: "@userName, Leider hast du das maximum an Packs aktuell erreicht. Bitte warte bis [Uhrzeit] Uhr. Dann stehen dir neue Packs zur Verfügung.",
    en: "@userName, unfortunately you've reached the maximum number of packs for now. Please wait until [Uhrzeit]. New packs will be available then.",
    fr: "@userName, tu as malheureusement atteint le nombre maximum de packs. Merci d'attendre jusqu'à [Uhrzeit]. De nouveaux packs seront alors disponibles.",
    es: "@userName, lamentablemente has alcanzado el máximo de sobres por ahora. Espera hasta las [Uhrzeit]. Entonces tendrás sobres nuevos disponibles.",
    th: "@userName ขออภัย คุณได้รับแพ็กครบจำนวนสูงสุดแล้ว กรุณารอจนถึงเวลา [Uhrzeit] แล้วจะมีแพ็กใหม่ให้คุณ"
  },
  packCooldown: {
    de: "@userName, leider musst du noch [Restzeit] Sekunden warten, bis du diesen Befehl erneut ausführen darfst.",
    en: "@userName, unfortunately you still need to wait [Restzeit] seconds before you can use this command again.",
    fr: "@userName, tu dois encore attendre [Restzeit] secondes avant de pouvoir réutiliser cette commande.",
    es: "@userName, todavía debes esperar [Restzeit] segundos antes de poder usar este comando de nuevo.",
    th: "@userName คุณต้องรออีก [Restzeit] วินาที ก่อนจะใช้คำสั่งนี้ได้อีกครั้ง"
  },
  collectionHeader: {
    de: "@userName, deine Karten:",
    en: "@userName, your cards:",
    fr: "@userName, tes cartes :",
    es: "@userName, tus cartas:",
    th: "@userName การ์ดของคุณ:"
  },
  collectionEmpty: {
    de: "@userName, du besitzt noch keine Karten.",
    en: "@userName, you don't own any cards yet.",
    fr: "@userName, tu ne possèdes encore aucune carte.",
    es: "@userName, todavía no tienes cartas.",
    th: "@userName คุณยังไม่มีการ์ดเลย"
  },
  communityGoalReached: {
    de: "🎉 Community-Ziel erreicht ([Ziel] Ziehungen)! Alle Teilnehmer bekommen automatisch [Karten] Bonus-Booster.",
    en: "🎉 Community goal reached ([Ziel] draws)! Every participant automatically gets [Karten] bonus boosters.",
    fr: "🎉 Objectif communautaire atteint ([Ziel] tirages) ! Tous les participants reçoivent automatiquement [Karten] boosters bonus.",
    es: "🎉 ¡Meta comunitaria alcanzada ([Ziel] tiradas)! Todos los participantes reciben automáticamente [Karten] sobres extra.",
    th: "🎉 บรรลุเป้าหมายชุมชนแล้ว ([Ziel] ครั้ง)! ผู้เข้าร่วมทุกคนจะได้รับบูสเตอร์โบนัสอัตโนมัติ [Karten] ใบ"
  },
  helpPack: {
    de: "zieht ein zufälliges Kartenpack",
    en: "draws a random card pack",
    fr: "tire un booster de cartes aléatoire",
    es: "saca un sobre de cartas al azar",
    th: "สุ่มเปิดบูสเตอร์การ์ด"
  },
  helpPacks: {
    de: "listet alle verfügbaren Booster mit Ziehchance auf",
    en: "lists every available booster with its draw chance",
    fr: "liste tous les boosters disponibles avec leur chance de tirage",
    es: "lista todos los sobres disponibles con su probabilidad",
    th: "แสดงรายการบูสเตอร์ที่ใช้ได้พร้อมโอกาสสุ่ม"
  },
  packsHeader: {
    de: "@userName, verfügbare Booster:",
    en: "@userName, available boosters:",
    fr: "@userName, boosters disponibles :",
    es: "@userName, sobres disponibles:",
    th: "@userName บูสเตอร์ที่ใช้งานได้:"
  },
  packsEmpty: {
    de: "@userName, aktuell ist kein Booster verfügbar.",
    en: "@userName, no booster is currently available.",
    fr: "@userName, aucun booster n'est disponible pour le moment.",
    es: "@userName, actualmente no hay ningún sobre disponible.",
    th: "@userName ตอนนี้ไม่มีบูสเตอร์ที่ใช้งานได้"
  },
  helpDust: {
    de: "verwandelt doppelte Karten in Pity-Punkte",
    en: "converts duplicate cards into pity points",
    fr: "convertit les cartes en double en points de pitié",
    es: "convierte cartas duplicadas en puntos de compensación",
    th: "แปลงการ์ดที่ซ้ำเป็นแต้มการันตี"
  },
  helpDustSet: {
    de: "legt fest, bis zu welcher Seltenheit !dustall opfert",
    en: "sets up to which rarity !dustall sacrifices",
    fr: "définit jusqu'à quelle rareté !dustall sacrifie",
    es: "define hasta qué rareza sacrifica !dustall",
    th: "กำหนดระดับความหายากสูงสุดที่ !dustall จะสังเวย"
  },
  helpDustAll: {
    de: "opfert alle Duplikate bis zur eingestellten Seltenheit",
    en: "sacrifices all duplicates up to the set rarity",
    fr: "sacrifie tous les doublons jusqu'à la rareté définie",
    es: "sacrifica todos los duplicados hasta la rareza definida",
    th: "สังเวยการ์ดซ้ำทั้งหมดจนถึงระดับความหายากที่ตั้งไว้"
  },
  helpGift: {
    de: "verschenkt eine Karte an einen anderen Zuschauer",
    en: "gifts a card to another viewer",
    fr: "offre une carte à un autre spectateur",
    es: "regala una carta a otro espectador",
    th: "มอบการ์ดให้ผู้ชมคนอื่น"
  },
  helpCollection: {
    de: "zeigt deine Kartensammlung",
    en: "shows your card collection",
    fr: "affiche ta collection de cartes",
    es: "muestra tu colección de cartas",
    th: "แสดงคอลเลกชันการ์ดของคุณ"
  },
  helpTrade: {
    de: "bietet einen Kartentausch an",
    en: "offers a card trade",
    fr: "propose un échange de cartes",
    es: "ofrece un intercambio de cartas",
    th: "เสนอแลกเปลี่ยนการ์ด"
  },
  helpBattle: {
    de: "fordert einen Kartenkampf heraus",
    en: "challenges another viewer to a card battle",
    fr: "défie un autre spectateur en duel de cartes",
    es: "desafía a otro espectador a un duelo de cartas",
    th: "ท้าดวลการ์ดกับผู้ชมคนอื่น"
  },
  helpRanking: {
    de: "zeigt eine Bestenliste (Karte oder Kämpfe)",
    en: "shows a leaderboard (card or battles)",
    fr: "affiche un classement (carte ou combats)",
    es: "muestra una clasificación (carta o combates)",
    th: "แสดงอันดับ (การ์ดหรือการดวล)"
  },
  rankingCardNotFound: {
    de: "@userName, die Karte [falscherName] existiert nicht. Meintest du stattdessen [Kartenname]?",
    en: "@userName, the card [falscherName] doesn't exist. Did you mean [Kartenname] instead?",
    fr: "@userName, la carte [falscherName] n'existe pas. Voulais-tu dire [Kartenname] ?",
    es: "@userName, la carta [falscherName] no existe. ¿Quisiste decir [Kartenname]?",
    th: "@userName ไม่มีการ์ด [falscherName] คุณหมายถึง [Kartenname] ใช่ไหม?"
  },
  rankingNoOwners: {
    de: "@userName, die Karte [Kartenname] wurde bisher von niemandem gezogen - es gibt noch kein Ranking dafür.",
    en: "@userName, nobody has drawn the card [Kartenname] yet - there's no ranking for it yet.",
    fr: "@userName, personne n'a encore tiré la carte [Kartenname] - il n'y a pas encore de classement pour elle.",
    es: "@userName, nadie ha sacado todavía la carta [Kartenname] - todavía no hay clasificación para ella.",
    th: "@userName ยังไม่มีใครสุ่มได้การ์ด [Kartenname] เลย - ยังไม่มีอันดับสำหรับการ์ดนี้"
  },
  helpTournamentJoin: {
    de: "tritt dem laufenden Turnier bei",
    en: "joins the current tournament signup",
    fr: "rejoint l'inscription au tournoi en cours",
    es: "se une a la inscripción del torneo actual",
    th: "เข้าร่วมการสมัครทัวร์นาเมนต์ปัจจุบัน"
  },
  helpTournamentStart: {
    de: "startet die Turnier-Anmeldephase",
    en: "starts the tournament signup phase",
    fr: "démarre la phase d'inscription au tournoi",
    es: "inicia la fase de inscripción del torneo",
    th: "เริ่มช่วงเวลาสมัครทัวร์นาเมนต์"
  },
  helpTeamBattleJoin: {
    de: "tritt dem laufenden Team-Kampf bei",
    en: "joins the current team battle signup",
    fr: "rejoint l'inscription au combat d'équipe en cours",
    es: "se une a la inscripción del combate de equipo actual",
    th: "เข้าร่วมการสมัครการต่อสู้ทีมปัจจุบัน"
  },
  helpTeamBattleStart: {
    de: "startet die Team-Kampf-Anmeldephase",
    en: "starts the team battle signup phase",
    fr: "démarre la phase d'inscription au combat d'équipe",
    es: "inicia la fase de inscripción del combate de equipo",
    th: "เริ่มช่วงเวลาสมัครการต่อสู้ทีม"
  },
  tournamentSignupStart: {
    de: "🏆 Turnier-Anmeldung gestartet! Tritt mit [Befehl] bei - [Sekunden] Sekunden Zeit, mindestens [Mindestteilnehmer] Teilnehmer nötig.",
    en: "🏆 Tournament signup started! Join with [Befehl] - [Sekunden] seconds left, at least [Mindestteilnehmer] participants needed.",
    fr: "🏆 Inscription au tournoi ouverte ! Rejoignez avec [Befehl] - [Sekunden] secondes restantes, [Mindestteilnehmer] participants minimum requis.",
    es: "🏆 ¡Inscripción al torneo abierta! Únete con [Befehl] - quedan [Sekunden] segundos, se necesitan al menos [Mindestteilnehmer] participantes.",
    th: "🏆 เปิดรับสมัครทัวร์นาเมนต์แล้ว! เข้าร่วมด้วย [Befehl] - เหลือเวลา [Sekunden] วินาที ต้องการผู้เข้าร่วมอย่างน้อย [Mindestteilnehmer] คน"
  },
  tournamentJoinAck: {
    de: "@userName ist dem Turnier beigetreten! ([Anzahl] Teilnehmer)",
    en: "@userName joined the tournament! ([Anzahl] participants)",
    fr: "@userName a rejoint le tournoi ! ([Anzahl] participants)",
    es: "¡@userName se unió al torneo! ([Anzahl] participantes)",
    th: "@userName เข้าร่วมทัวร์นาเมนต์แล้ว! (ผู้เข้าร่วม [Anzahl] คน)"
  },
  tournamentNotEligible: {
    de: "@userName, für die Turnier-Teilnahme brauchst du mindestens [Anzahl] verschiedene Karten.",
    en: "@userName, you need at least [Anzahl] different cards to join the tournament.",
    fr: "@userName, il te faut au moins [Anzahl] cartes différentes pour participer au tournoi.",
    es: "@userName, necesitas al menos [Anzahl] cartas diferentes para participar en el torneo.",
    th: "@userName คุณต้องมีการ์ดที่แตกต่างกันอย่างน้อย [Anzahl] ใบเพื่อเข้าร่วมทัวร์นาเมนต์"
  },
  tournamentAlreadyRunning: {
    de: "@userName, es läuft bereits ein Turnier oder eine Anmeldephase.",
    en: "@userName, a tournament or signup phase is already running.",
    fr: "@userName, un tournoi ou une phase d'inscription est déjà en cours.",
    es: "@userName, ya hay un torneo o una fase de inscripción en curso.",
    th: "@userName มีทัวร์นาเมนต์หรือช่วงสมัครที่กำลังดำเนินอยู่แล้ว"
  },
  tournamentCancel: {
    de: "Das Turnier wurde abgesagt - nur [Anzahl] von mindestens [Mindestteilnehmer] nötigen Teilnehmern haben sich angemeldet.",
    en: "The tournament was cancelled - only [Anzahl] of the required [Mindestteilnehmer] participants signed up.",
    fr: "Le tournoi a été annulé - seulement [Anzahl] des [Mindestteilnehmer] participants requis se sont inscrits.",
    es: "El torneo fue cancelado - solo se inscribieron [Anzahl] de los [Mindestteilnehmer] participantes necesarios.",
    th: "ทัวร์นาเมนต์ถูกยกเลิก - มีผู้สมัครเพียง [Anzahl] จาก [Mindestteilnehmer] คนที่ต้องการ"
  },
  tournamentRoundAnnounce: {
    de: "🏆 Turnier [Runde]: [SpielerA] vs [SpielerB]!",
    en: "🏆 Tournament [Runde]: [SpielerA] vs [SpielerB]!",
    fr: "🏆 Tournoi [Runde] : [SpielerA] contre [SpielerB] !",
    es: "🏆 Torneo [Runde]: ¡[SpielerA] contra [SpielerB]!",
    th: "🏆 ทัวร์นาเมนต์ [Runde]: [SpielerA] พบ [SpielerB]!"
  },
  tournamentByeAnnounce: {
    de: "🏆 Turnier [Runde]: [Spieler] hat ein Freilos und zieht kampflos weiter!",
    en: "🏆 Tournament [Runde]: [Spieler] gets a bye and advances automatically!",
    fr: "🏆 Tournoi [Runde] : [Spieler] est exempté et avance automatiquement !",
    es: "🏆 Torneo [Runde]: ¡[Spieler] tiene un descanso y avanza automáticamente!",
    th: "🏆 ทัวร์นาเมนต์ [Runde]: [Spieler] ได้บายและผ่านเข้ารอบโดยอัตโนมัติ!"
  },
  tournamentWinnerAnnounce: {
    de: "🏆 @userName gewinnt das Turnier mit [Teilnehmerzahl] Teilnehmern und erhält [Anzahl]x Kartenpack-Ziehung!",
    en: "🏆 @userName wins the tournament with [Teilnehmerzahl] participants and gets [Anzahl]x pack draws!",
    fr: "🏆 @userName remporte le tournoi avec [Teilnehmerzahl] participants et reçoit [Anzahl]x tirages de booster !",
    es: "🏆 ¡@userName gana el torneo con [Teilnehmerzahl] participantes y recibe [Anzahl]x tiradas de sobre!",
    th: "🏆 @userName ชนะทัวร์นาเมนต์ด้วยผู้เข้าร่วม [Teilnehmerzahl] คน และได้รับการจับสลากแพ็ก [Anzahl] ครั้ง!"
  },
  autoHelpMessage: {
    de: "📋 Verfügbare Befehle: [Befehle]",
    en: "📋 Available commands: [Befehle]",
    fr: "📋 Commandes disponibles : [Befehle]",
    es: "📋 Comandos disponibles: [Befehle]",
    th: "📋 คำสั่งที่ใช้ได้: [Befehle]"
  },
  dustUsage: {
    de: "@userName, Nutzung: !dust <Kartenname> <Anzahl>",
    en: "@userName, usage: !dust <card name> <count>",
    fr: "@userName, utilisation : !dust <nom de la carte> <nombre>",
    es: "@userName, uso: !dust <nombre de la carta> <cantidad>",
    th: "@userName วิธีใช้: !dust <ชื่อการ์ด> <จำนวน>"
  },
  dustCardNotFound: {
    de: "@userName, die Karte [falscherName] existiert nicht. Meintest du stattdessen [Kartenname]?",
    en: "@userName, the card [falscherName] doesn't exist. Did you mean [Kartenname] instead?",
    fr: "@userName, la carte [falscherName] n'existe pas. Voulais-tu dire [Kartenname] ?",
    es: "@userName, la carta [falscherName] no existe. ¿Quisiste decir [Kartenname]?",
    th: "@userName ไม่มีการ์ด [falscherName] คุณหมายถึง [Kartenname] ใช่ไหม?"
  },
  dustNotEnough: {
    de: "@userName, du hast nicht genug Duplikate von [Kartenname] (du besitzt [Besitz], mindestens 1 muss dir erhalten bleiben).",
    en: "@userName, you don't have enough duplicates of [Kartenname] (you own [Besitz], at least 1 must remain yours).",
    fr: "@userName, tu n'as pas assez de doublons de [Kartenname] (tu en possèdes [Besitz], il t'en faut garder au moins 1).",
    es: "@userName, no tienes suficientes duplicados de [Kartenname] (posees [Besitz], debes conservar al menos 1).",
    th: "@userName คุณมีการ์ดซ้ำของ [Kartenname] ไม่พอ (คุณมี [Besitz] ใบ ต้องเหลืออย่างน้อย 1 ใบ)"
  },
  dustSuccess: {
    de: "@userName hat [Anzahl]x [Kartenname] geopfert (+[Punkte] Garantie-Punkte). [GarantieAnzahl] garantierte Ziehung(en) bereit, noch [GarantieRest] Ziehungen bis zur nächsten.",
    en: "@userName sacrificed [Anzahl]x [Kartenname] (+[Punkte] pity points). [GarantieAnzahl] guaranteed draw(s) ready, [GarantieRest] more draws until the next one.",
    fr: "@userName a sacrifié [Anzahl]x [Kartenname] (+[Punkte] points de pitié). [GarantieAnzahl] tirage(s) garanti(s) prêt(s), encore [GarantieRest] tirages avant le prochain.",
    es: "@userName sacrificó [Anzahl]x [Kartenname] (+[Punkte] puntos de compensación). [GarantieAnzahl] tirada(s) garantizada(s) lista(s), faltan [GarantieRest] tiradas para la siguiente.",
    th: "@userName สังเวย [Kartenname] จำนวน [Anzahl] ใบ (+[Punkte] แต้มการันตี) มี [GarantieAnzahl] ครั้งการันตีพร้อมใช้ เหลืออีก [GarantieRest] ครั้งจนถึงครั้งถัดไป"
  },
  dustSetUsage: {
    de: "@userName, Nutzung: [BefehlSet] <Seltenheit> (z.B. legendär) - legt fest, bis zu welcher Seltenheit [BefehlAll] automatisch Duplikate opfert.",
    en: "@userName, usage: [BefehlSet] <rarity> (e.g. legendary) - sets up to which rarity [BefehlAll] automatically sacrifices duplicates.",
    fr: "@userName, utilisation : [BefehlSet] <rareté> (ex. légendaire) - définit jusqu'à quelle rareté [BefehlAll] sacrifie automatiquement les doublons.",
    es: "@userName, uso: [BefehlSet] <rareza> (p. ej. legendaria) - define hasta qué rareza [BefehlAll] sacrifica duplicados automáticamente.",
    th: "@userName วิธีใช้: [BefehlSet] <ระดับความหายาก> (เช่น ตำนาน) - กำหนดว่า [BefehlAll] จะสังเวยการ์ดซ้ำอัตโนมัติสูงสุดถึงระดับใด"
  },
  dustSetInvalid: {
    de: "@userName, \"[Eingabe]\" ist keine bekannte Seltenheit. Gültig: Gewöhnlich, Ungewöhnlich, Selten, Episch, Legendär, Holo.",
    en: "@userName, \"[Eingabe]\" isn't a known rarity. Valid: Common, Uncommon, Rare, Epic, Legendary, Holo.",
    fr: "@userName, \"[Eingabe]\" n'est pas une rareté connue. Valides : Commune, Peu commune, Rare, Épique, Légendaire, Holo.",
    es: "@userName, \"[Eingabe]\" no es una rareza conocida. Válidas: Común, Poco común, Rara, Épica, Legendaria, Holo.",
    th: "@userName \"[Eingabe]\" ไม่ใช่ระดับความหายากที่รู้จัก ใช้ได้: ธรรมดา, ไม่ธรรมดา, หายาก, เอพิก, ตำนาน, โฮโล"
  },
  dustSetSuccess: {
    de: "@userName, [BefehlAll] opfert ab jetzt automatisch alle Duplikate bis einschließlich [Seltenheit].",
    en: "@userName, [BefehlAll] will now automatically sacrifice all duplicates up to and including [Seltenheit].",
    fr: "@userName, [BefehlAll] sacrifiera désormais automatiquement tous les doublons jusqu'à [Seltenheit] inclus.",
    es: "@userName, [BefehlAll] ahora sacrificará automáticamente todos los duplicados hasta [Seltenheit] inclusive.",
    th: "@userName ตอนนี้ [BefehlAll] จะสังเวยการ์ดซ้ำทั้งหมดโดยอัตโนมัติจนถึง [Seltenheit]"
  },
  dustAllNothing: {
    de: "@userName, du hast aktuell keine Duplikate unterhalb von [Seltenheit] zum Opfern.",
    en: "@userName, you currently have no duplicates below [Seltenheit] to sacrifice.",
    fr: "@userName, tu n'as actuellement aucun doublon en dessous de [Seltenheit] à sacrifier.",
    es: "@userName, actualmente no tienes duplicados por debajo de [Seltenheit] para sacrificar.",
    th: "@userName ตอนนี้คุณไม่มีการ์ดซ้ำต่ำกว่า [Seltenheit] ให้สังเวย"
  },
  dustAllSuccess: {
    de: "@userName hat [Gesamtanzahl] doppelte Karten geopfert ([Aufschluesselung]), +[Punkte] Garantie-Punkte. [GarantieAnzahl] garantierte Ziehung(en) bereit, noch [GarantieRest] Ziehungen bis zur nächsten.",
    en: "@userName sacrificed [Gesamtanzahl] duplicate cards ([Aufschluesselung]), +[Punkte] pity points. [GarantieAnzahl] guaranteed draw(s) ready, [GarantieRest] more draws until the next one.",
    fr: "@userName a sacrifié [Gesamtanzahl] cartes en double ([Aufschluesselung]), +[Punkte] points de pitié. [GarantieAnzahl] tirage(s) garanti(s) prêt(s), encore [GarantieRest] tirages avant le prochain.",
    es: "@userName sacrificó [Gesamtanzahl] cartas duplicadas ([Aufschluesselung]), +[Punkte] puntos de compensación. [GarantieAnzahl] tirada(s) garantizada(s) lista(s), faltan [GarantieRest] tiradas para la siguiente.",
    th: "@userName สังเวยการ์ดซ้ำ [Gesamtanzahl] ใบ ([Aufschluesselung]) +[Punkte] แต้มการันตี มี [GarantieAnzahl] ครั้งการันตีพร้อมใช้ เหลืออีก [GarantieRest] ครั้งจนถึงครั้งถัดไป"
  },
  giftUsage: {
    de: "@userName, Nutzung: !gift @userNameB <Kartenname>",
    en: "@userName, usage: !gift @userNameB <card name>",
    fr: "@userName, utilisation : !gift @userNameB <nom de la carte>",
    es: "@userName, uso: !gift @userNameB <nombre de la carta>",
    th: "@userName วิธีใช้: !gift @userNameB <ชื่อการ์ด>"
  },
  giftUserNotFound: {
    de: "@userName, den Nutzer [Nutzer] kennt die Sammlung noch nicht.",
    en: "@userName, the collection doesn't know the user [Nutzer] yet.",
    fr: "@userName, la collection ne connaît pas encore l'utilisateur [Nutzer].",
    es: "@userName, la colección aún no conoce al usuario [Nutzer].",
    th: "@userName ยังไม่มีผู้ใช้ [Nutzer] ในคอลเลกชัน"
  },
  giftCardNotFound: {
    de: "@userName, die Karte [falscherName] existiert nicht. Meintest du stattdessen [Kartenname]?",
    en: "@userName, the card [falscherName] doesn't exist. Did you mean [Kartenname] instead?",
    fr: "@userName, la carte [falscherName] n'existe pas. Voulais-tu dire [Kartenname] ?",
    es: "@userName, la carta [falscherName] no existe. ¿Quisiste decir [Kartenname]?",
    th: "@userName ไม่มีการ์ด [falscherName] คุณหมายถึง [Kartenname] ใช่ไหม?"
  },
  giftNotOwned: {
    de: "@userName, du besitzt [Kartenname] gar nicht.",
    en: "@userName, you don't own [Kartenname] at all.",
    fr: "@userName, tu ne possèdes pas du tout [Kartenname].",
    es: "@userName, no posees [Kartenname] en absoluto.",
    th: "@userName คุณไม่มีการ์ด [Kartenname] เลย"
  },
  giftSelf: {
    de: "@userName, du kannst dir nicht selbst etwas schenken.",
    en: "@userName, you can't gift yourself something.",
    fr: "@userName, tu ne peux pas t'offrir un cadeau à toi-même.",
    es: "@userName, no puedes regalarte algo a ti mismo.",
    th: "@userName คุณไม่สามารถให้ของขวัญตัวเองได้"
  },
  giftSuccess: {
    de: "@userName hat [Kartenname] an @userNameB verschenkt!",
    en: "@userName gifted [Kartenname] to @userNameB!",
    fr: "@userName a offert [Kartenname] à @userNameB !",
    es: "¡@userName regaló [Kartenname] a @userNameB!",
    th: "@userName มอบการ์ด [Kartenname] ให้ @userNameB แล้ว!"
  },
  tradeCardNotFound: {
    de: "@userName, die Karte [falscherName] existiert nicht. Meintest du stattdessen [Kartenname]?",
    en: "@userName, the card [falscherName] doesn't exist. Did you mean [Kartenname] instead?",
    fr: "@userName, la carte [falscherName] n'existe pas. Voulais-tu dire [Kartenname] ?",
    es: "@userName, la carta [falscherName] no existe. ¿Quisiste decir [Kartenname]?",
    th: "@userName ไม่มีการ์ด [falscherName] คุณหมายถึง [Kartenname] ใช่ไหม?"
  },
  tradeOfferNotOwned: {
    de: "@userName, du besitzt die Karte [Kartenname] nicht und kannst sie daher nicht anbieten.",
    en: "@userName, you don't own the card [Kartenname], so you can't offer it.",
    fr: "@userName, tu ne possèdes pas la carte [Kartenname], tu ne peux donc pas la proposer.",
    es: "@userName, no posees la carta [Kartenname], por lo que no puedes ofrecerla.",
    th: "@userName คุณไม่มีการ์ด [Kartenname] จึงไม่สามารถเสนอแลกได้"
  },
  tradeUserNotFound: {
    de: "@userName, der Nutzer [Nutzer] wurde nicht gefunden.",
    en: "@userName, the user [Nutzer] was not found.",
    fr: "@userName, l'utilisateur [Nutzer] est introuvable.",
    es: "@userName, no se encontró al usuario [Nutzer].",
    th: "@userName ไม่พบผู้ใช้ [Nutzer]"
  },
  tradeOffer: {
    de: "@userNameB, dir wird ein Tausch von @userNameA der Karte [Kartenname] aus der Sammlung [Boostername] angeboten. Nimm mit [BefehlAnnehmen] \"Kartenname\" an oder lehne mit [BefehlAblehnen] ab.",
    en: "@userNameB, @userNameA is offering you a trade for the card [Kartenname] from the collection [Boostername]. Accept with [BefehlAnnehmen] \"card name\" or decline with [BefehlAblehnen].",
    fr: "@userNameB, @userNameA te propose un échange pour la carte [Kartenname] de la collection [Boostername]. Accepte avec [BefehlAnnehmen] \"nom de la carte\" ou refuse avec [BefehlAblehnen].",
    es: "@userNameB, @userNameA te ofrece un intercambio por la carta [Kartenname] de la colección [Boostername]. Acepta con [BefehlAnnehmen] \"nombre de la carta\" o rechaza con [BefehlAblehnen].",
    th: "@userNameB คุณได้รับข้อเสนอแลกเปลี่ยนจาก @userNameA สำหรับการ์ด [Kartenname] จากคอลเลกชัน [Boostername] ยอมรับด้วย [BefehlAnnehmen] \"ชื่อการ์ด\" หรือปฏิเสธด้วย [BefehlAblehnen]"
  },
  tradeTimeout: {
    de: "@userNameA, leider hat @userNameB nicht rechtzeitig ([Zeit] Sekunden) geantwortet. Daher wurde die Tauschanfrage beendet.",
    en: "@userNameA, unfortunately @userNameB did not respond in time ([Zeit] seconds). The trade request has therefore been cancelled.",
    fr: "@userNameA, @userNameB n'a malheureusement pas répondu à temps ([Zeit] secondes). La demande d'échange a donc été annulée.",
    es: "@userNameA, lamentablemente @userNameB no respondió a tiempo ([Zeit] segundos). Por eso se canceló la solicitud de intercambio.",
    th: "@userNameA @userNameB ไม่ตอบกลับภายในเวลาที่กำหนด ([Zeit] วินาที) คำขอแลกเปลี่ยนจึงถูกยกเลิก"
  },
  tradeCooldown: {
    de: "@userName, leider musst du mit der Tauschanfrage noch bis [Uhrzeit] warten, da der Cooldown von [Cooldownwert] [Einheit] noch aktiv ist.",
    en: "@userName, unfortunately you need to wait until [Uhrzeit] for your trade request, since the [Cooldownwert] [Einheit] cooldown is still active.",
    fr: "@userName, tu dois encore attendre jusqu'à [Uhrzeit] pour ta demande d'échange, le cooldown de [Cooldownwert] [Einheit] est encore actif.",
    es: "@userName, debes esperar hasta las [Uhrzeit] para tu solicitud de intercambio, ya que el cooldown de [Cooldownwert] [Einheit] sigue activo.",
    th: "@userName คุณต้องรอจนถึงเวลา [Uhrzeit] สำหรับคำขอแลกเปลี่ยน เนื่องจากคูลดาวน์ [Cooldownwert] [Einheit] ยังทำงานอยู่"
  },
  tradeLimit: {
    de: "@userName, leider sind deine Tauschanfragen aktuell aufgebraucht. Bitte warte bis [Uhrzeit] Uhr.",
    en: "@userName, unfortunately your trade requests are currently used up. Please wait until [Uhrzeit].",
    fr: "@userName, tes demandes d'échange sont actuellement épuisées. Merci d'attendre jusqu'à [Uhrzeit].",
    es: "@userName, tus solicitudes de intercambio están agotadas por ahora. Espera hasta las [Uhrzeit].",
    th: "@userName คำขอแลกเปลี่ยนของคุณหมดแล้วในตอนนี้ กรุณารอจนถึงเวลา [Uhrzeit]"
  },
  tradeBusy: {
    de: "@userName, es wird bereits gerade getauscht. Bitte warte bis dieser Tausch abgeschlossen wurde.",
    en: "@userName, a trade is already in progress. Please wait until it has finished.",
    fr: "@userName, un échange est déjà en cours. Merci d'attendre qu'il soit terminé.",
    es: "@userName, ya hay un intercambio en curso. Espera a que termine.",
    th: "@userName กำลังมีการแลกเปลี่ยนอยู่แล้ว กรุณารอจนกว่าจะเสร็จสิ้น"
  },
  tradeyesNotOwned: {
    de: "@userNameB, du besitzt diese Karte leider nicht. Bitte wähle eine andere.",
    en: "@userNameB, unfortunately you don't own this card. Please choose another one.",
    fr: "@userNameB, tu ne possèdes malheureusement pas cette carte. Merci d'en choisir une autre.",
    es: "@userNameB, lamentablemente no posees esta carta. Elige otra.",
    th: "@userNameB คุณไม่มีการ์ดใบนี้ กรุณาเลือกใบอื่น"
  },
  tradeyesSuccess: {
    de: "@userNameA tauschte seine Karte [KarteA] aus [BoosterA] erfolgreich mit @userNameB gegen Karte [KarteB] aus [BoosterB]. Damit hat @userNameA nun [AnzahlA] Karten [KarteB] und @userNameB [AnzahlB] Karten [KarteA].",
    en: "@userNameA successfully traded their card [KarteA] from [BoosterA] with @userNameB for card [KarteB] from [BoosterB]. @userNameA now has [AnzahlA] cards [KarteB] and @userNameB has [AnzahlB] cards [KarteA].",
    fr: "@userNameA a échangé avec succès sa carte [KarteA] de [BoosterA] contre la carte [KarteB] de [BoosterB] de @userNameB. @userNameA a maintenant [AnzahlA] cartes [KarteB] et @userNameB [AnzahlB] cartes [KarteA].",
    es: "@userNameA intercambió con éxito su carta [KarteA] de [BoosterA] con @userNameB por la carta [KarteB] de [BoosterB]. Ahora @userNameA tiene [AnzahlA] cartas [KarteB] y @userNameB tiene [AnzahlB] cartas [KarteA].",
    th: "@userNameA แลกเปลี่ยนการ์ด [KarteA] จาก [BoosterA] กับ @userNameB สำเร็จ เพื่อรับการ์ด [KarteB] จาก [BoosterB] ตอนนี้ @userNameA มีการ์ด [KarteB] จำนวน [AnzahlA] ใบ และ @userNameB มีการ์ด [KarteA] จำนวน [AnzahlB] ใบ"
  },
  tradenoDecline: {
    de: "@userNameA, leider hat @userNameB deine Tauschanfrage abgelehnt, damit bleiben dir bis zum [Uhrzeit] noch [Anzahl] Tauschanfragen.",
    en: "@userNameA, unfortunately @userNameB declined your trade request, so you have [Anzahl] trade requests left until [Uhrzeit].",
    fr: "@userNameA, @userNameB a refusé ta demande d'échange, il te reste [Anzahl] demandes d'échange jusqu'à [Uhrzeit].",
    es: "@userNameA, @userNameB rechazó tu solicitud de intercambio, te quedan [Anzahl] solicitudes hasta las [Uhrzeit].",
    th: "@userNameA @userNameB ปฏิเสธคำขอแลกเปลี่ยนของคุณ คุณเหลือคำขอแลกเปลี่ยนอีก [Anzahl] ครั้งจนถึงเวลา [Uhrzeit]"
  },
  battleUsage: {
    de: "@userName, Nutzung: !battle @userNameB",
    en: "@userName, usage: !battle @userNameB",
    fr: "@userName, utilisation : !battle @userNameB",
    es: "@userName, uso: !battle @userNameB",
    th: "@userName วิธีใช้: !battle @userNameB"
  },
  battleUserNotFound: {
    de: "@userName, der Nutzer [Nutzer] wurde nicht gefunden.",
    en: "@userName, the user [Nutzer] was not found.",
    fr: "@userName, l'utilisateur [Nutzer] est introuvable.",
    es: "@userName, no se encontró al usuario [Nutzer].",
    th: "@userName ไม่พบผู้ใช้ [Nutzer]"
  },
  battleSelfChallenge: {
    de: "@userName, du kannst nicht dich selbst herausfordern.",
    en: "@userName, you can't challenge yourself.",
    fr: "@userName, tu ne peux pas te défier toi-même.",
    es: "@userName, no puedes desafiarte a ti mismo.",
    th: "@userName คุณไม่สามารถท้าตัวเองได้"
  },
  battleNotEnoughCards: {
    de: "@userName, für ein Kartenduell braucht ihr beide mindestens [Anzahl] verschiedene Karten.",
    en: "@userName, for a card duel you both need at least [Anzahl] different cards.",
    fr: "@userName, pour un duel de cartes, vous devez tous les deux posséder au moins [Anzahl] cartes différentes.",
    es: "@userName, para un duelo de cartas ambos necesitan al menos [Anzahl] cartas diferentes.",
    th: "@userName สำหรับการดวลการ์ด ทั้งสองฝ่ายต้องมีการ์ดต่างกันอย่างน้อย [Anzahl] ใบ"
  },
  battleOffer: {
    de: "@userNameB, @userNameA fordert dich zum Kartenduell heraus! Nimm mit [BefehlAnnehmen] an oder lehne mit [BefehlAblehnen] ab.",
    en: "@userNameB, @userNameA challenges you to a card duel! Accept with [BefehlAnnehmen] or decline with [BefehlAblehnen].",
    fr: "@userNameB, @userNameA te défie en duel de cartes ! Accepte avec [BefehlAnnehmen] ou refuse avec [BefehlAblehnen].",
    es: "@userNameB, ¡@userNameA te desafía a un duelo de cartas! Acepta con [BefehlAnnehmen] o rechaza con [BefehlAblehnen].",
    th: "@userNameB @userNameA ท้าคุณดวลการ์ด! ยอมรับด้วย [BefehlAnnehmen] หรือปฏิเสธด้วย [BefehlAblehnen]"
  },
  battleTimeout: {
    de: "@userNameA, leider hat @userNameB nicht rechtzeitig ([Zeit] Sekunden) geantwortet. Daher wurde die Duellanfrage beendet.",
    en: "@userNameA, unfortunately @userNameB did not respond in time ([Zeit] seconds). The duel request has therefore been cancelled.",
    fr: "@userNameA, @userNameB n'a malheureusement pas répondu à temps ([Zeit] secondes). La demande de duel a donc été annulée.",
    es: "@userNameA, lamentablemente @userNameB no respondió a tiempo ([Zeit] segundos). Por eso se canceló la solicitud de duelo.",
    th: "@userNameA @userNameB ไม่ตอบกลับภายในเวลาที่กำหนด ([Zeit] วินาที) คำขอดวลจึงถูกยกเลิก"
  },
  battleCooldown: {
    de: "@userName, leider musst du mit der Kampfanfrage noch bis [Uhrzeit] warten, da der Cooldown von [Cooldownwert] [Einheit] noch aktiv ist.",
    en: "@userName, unfortunately you need to wait until [Uhrzeit] for your battle request, since the [Cooldownwert] [Einheit] cooldown is still active.",
    fr: "@userName, tu dois encore attendre jusqu'à [Uhrzeit] pour ta demande de combat, le cooldown de [Cooldownwert] [Einheit] est encore actif.",
    es: "@userName, debes esperar hasta las [Uhrzeit] para tu solicitud de combate, ya que el cooldown de [Cooldownwert] [Einheit] sigue activo.",
    th: "@userName คุณต้องรอจนถึงเวลา [Uhrzeit] สำหรับคำขอต่อสู้ เนื่องจากคูลดาวน์ [Cooldownwert] [Einheit] ยังทำงานอยู่"
  },
  battleLimit: {
    de: "@userName, leider sind deine Kampfanfragen aktuell aufgebraucht. Bitte warte bis [Uhrzeit] Uhr.",
    en: "@userName, unfortunately your battle requests are currently used up. Please wait until [Uhrzeit].",
    fr: "@userName, tes demandes de combat sont actuellement épuisées. Merci d'attendre jusqu'à [Uhrzeit].",
    es: "@userName, tus solicitudes de combate están agotadas por ahora. Espera hasta las [Uhrzeit].",
    th: "@userName คำขอต่อสู้ของคุณหมดแล้วในตอนนี้ กรุณารอจนถึงเวลา [Uhrzeit]"
  },
  battleBusy: {
    de: "@userName, es läuft bereits ein Kartenduell. Bitte warte bis dieses abgeschlossen wurde.",
    en: "@userName, a card duel is already in progress. Please wait until it has finished.",
    fr: "@userName, un duel de cartes est déjà en cours. Merci d'attendre qu'il soit terminé.",
    es: "@userName, ya hay un duelo de cartas en curso. Espera a que termine.",
    th: "@userName กำลังมีการดวลการ์ดอยู่แล้ว กรุณารอจนกว่าจะเสร็จสิ้น"
  },
  battleyesResult: {
    de: "@userNameA gewinnt das Kartenduell gegen @userNameB ([SiegeA]:[SiegeB]) und erhält die Karte [GewonneneKarte]!",
    en: "@userNameA wins the card duel against @userNameB ([SiegeA]:[SiegeB]) and receives the card [GewonneneKarte]!",
    fr: "@userNameA remporte le duel de cartes contre @userNameB ([SiegeA]:[SiegeB]) et reçoit la carte [GewonneneKarte] !",
    es: "¡@userNameA gana el duelo de cartas contra @userNameB ([SiegeA]:[SiegeB]) y recibe la carta [GewonneneKarte]!",
    th: "@userNameA ชนะการดวลการ์ดกับ @userNameB ([SiegeA]:[SiegeB]) และได้รับการ์ด [GewonneneKarte]!"
  },
  battlenoDecline: {
    de: "@userNameA, leider hat @userNameB deine Duellanfrage abgelehnt.",
    en: "@userNameA, unfortunately @userNameB declined your duel request.",
    fr: "@userNameA, @userNameB a refusé ta demande de duel.",
    es: "@userNameA, @userNameB rechazó tu solicitud de duelo.",
    th: "@userNameA @userNameB ปฏิเสธคำขอดวลของคุณ"
  }
};

export function pickDefault(lang, entryKey) {
  const entry = DEFAULT_MESSAGES[entryKey];
  if (!entry) return "";
  return entry[lang] || entry.de;
}

export function normalizeSettings(settings) {
  settings.language = SUPPORTED_LANGUAGES.includes(settings.language) ? settings.language : "de";
  // The per-install id for the anonymous community stats counter now lives server-side in its
  // own file (see GetOrCreateStatsInstallId in CardPackWidgetApp.cs / GET /api/stats-install-id)
  // instead of here - minting it as part of settings.json meant any settings reset silently
  // created a brand-new id, and the stats server sums every id it has ever seen forever, so that
  // just permanently double-counted the same install's cards/boosters on top of the real total.
  // Was previously never defaulted: a settings.json missing this key (e.g. after a partial
  // save) crashed hydrateDesign() on the first line reading it, which silently aborted
  // hydration of everything after it (OBS, trade/battle animation, battle strength fields).
  settings.behavior ||= {};
  settings.behavior.revealSeconds ??= 3.2;
  settings.behavior.cooldownSeconds ??= 0.8;
  settings.behavior.cardBacksBeforeReveal ??= 2;
  settings.behavior.persistCollections ??= true;
  settings.twitch ||= {};
  settings.twitch.clientId ||= "klgyxuiixy0mfo7ze7goubj5j16g7u";
  settings.style ||= {};
  // ??= (not ||=): 0 is a deliberate "muted" choice and must survive normalization. Without
  // this default, a settings.json missing the key silently muted EVERY overlay sound (all
  // overlays read style.volume and skip playback entirely at 0).
  settings.style.volume ??= 65;
  settings.style.themeMode ||= "light";
  settings.style.cardTheme = CARD_THEMES.includes(settings.style.cardTheme) ? settings.style.cardTheme : "default";
  settings.style.customTheme ||= {};
  settings.style.customTheme.color1 ||= "#6a5cff";
  settings.style.customTheme.color2 ||= "#22d3ee";
  settings.style.customTheme.color3 ||= "#ff7ad9";
  settings.style.customTheme.useColor3 = settings.style.customTheme.useColor3 === true;
  settings.style.customTheme.angle = clamp(settings.style.customTheme.angle ?? 155, 0, 360);
  settings.style.customTheme.sheen = clamp(settings.style.customTheme.sheen ?? 30, 0, 70);
  settings.style.customTheme.artColor ||= "#ffffff";
  settings.style.customTheme.artOpacity = clamp(settings.style.customTheme.artOpacity ?? 45, 0, 100);
  settings.style.namePosition = ["bottom", "top"].includes(settings.style.namePosition) ? settings.style.namePosition : "bottom";
  settings.style.cardPatternEnabled = settings.style.cardPatternEnabled !== false;
  settings.style.boosterPatternEnabled = settings.style.boosterPatternEnabled !== false;
  settings.style.cardPatternImage ||= "";
  settings.style.cardPatternSize = clamp(settings.style.cardPatternSize ?? 40, 10, 300);
  settings.style.boosterPatternImage ||= "";
  settings.style.boosterPatternSize = clamp(settings.style.boosterPatternSize ?? 40, 10, 300);
  settings.style.cardImageFit = ["frame", "full", "top", "bottom", "left", "right"].includes(settings.style.cardImageFit) ? settings.style.cardImageFit : "frame";
  settings.style.boosterImageFit = ["center", "top", "bottom", "left", "right"].includes(settings.style.boosterImageFit) ? settings.style.boosterImageFit : "center";
  settings.sounds ||= {};
  settings.sounds.open ||= "";
  settings.sounds.reveal ||= "";
  settings.sounds.trade ||= "";
  settings.sounds.battle ||= "";

  // Trade animation: shown in its own OBS browser source (trade.html) when a !tradeyes swap
  // succeeds. Style and length are picked here; an optional chat message is separate.
  settings.tradeAnimation ||= {};
  settings.tradeAnimation.enabled = settings.tradeAnimation.enabled === true;
  settings.tradeAnimation.style = ["swap", "arc", "flip"].includes(settings.tradeAnimation.style) ? settings.tradeAnimation.style : "swap";
  settings.tradeAnimation.duration = ["short", "medium", "long"].includes(settings.tradeAnimation.duration) ? settings.tradeAnimation.duration : "medium";
  settings.tradeAnimation.sendChat = settings.tradeAnimation.sendChat !== false;
  settings.tradeAnimation.sourceName ||= "Streamer Card Tausch";

  // Battle animation: shown in its own OBS browser source (battle.html) when a !battleyes
  // duel resolves. Style and length are picked here; an optional chat message is separate.
  settings.battleAnimation ||= {};
  settings.battleAnimation.enabled = settings.battleAnimation.enabled === true;
  settings.battleAnimation.style = ["clash", "ranged", "hp"].includes(settings.battleAnimation.style) ? settings.battleAnimation.style : "clash";
  settings.battleAnimation.duration = ["short", "medium", "long"].includes(settings.battleAnimation.duration) ? settings.battleAnimation.duration : "medium";
  settings.battleAnimation.sendChat = settings.battleAnimation.sendChat !== false;
  settings.battleAnimation.sourceName ||= "Streamer Card Kampf";

  // Gift animation: shown in its own OBS browser source (gift.html) when "!gift" successfully
  // transfers a card. Style is picked here; the chat message is a separate toggle (chatOutputEnabled
  // on settings.chatCommands.gift, not here) - same "!command enabled" / "animation enabled" /
  // "chat text enabled" three-way split as the collection showcase.
  settings.giftAnimation ||= {};
  settings.giftAnimation.enabled = settings.giftAnimation.enabled === true;
  settings.giftAnimation.style = ["handover", "spin", "pixelate"].includes(settings.giftAnimation.style) ? settings.giftAnimation.style : "handover";

  // Battle strength: per-rarity power used by the duel round rolls (independent of the draw
  // weights above, since "common" should be weakest here but is drawn most often).
  settings.battleStrength ||= {};
  const BATTLE_STRENGTH_DEFAULTS = { common: 1, uncommon: 2, rare: 3, epic: 5, legendary: 8, holo: 12 };
  for (const rarity of RARITIES) {
    const value = Number(settings.battleStrength[rarity.id]);
    settings.battleStrength[rarity.id] = Number.isFinite(value) && value > 0 ? value : BATTLE_STRENGTH_DEFAULTS[rarity.id];
  }
  settings.battleStrength.variance = Number(settings.battleStrength.variance) >= 0 ? Number(settings.battleStrength.variance) : 0.6;
  // HP for the "HP-Leisten-Duell" elimination style = battle strength x this factor.
  settings.battleStrength.hpFactor = Number(settings.battleStrength.hpFactor) > 0 ? Number(settings.battleStrength.hpFactor) : 10;

  settings.deck ||= {};
  settings.deck.cards ||= [];
  settings.boosters ||= [];
  settings.rarities ||= RARITIES;
  settings.rarityColors ||= {};
  for (const rarity of RARITIES) {
    settings.rarityColors[rarity.id] ||= DEFAULT_RARITY_COLORS[rarity.id];
  }
  setRarityColors(settings.rarityColors);
  settings.rarityWeights ||= {};
  for (const rarity of RARITIES) {
    const value = Number(settings.rarityWeights[rarity.id]);
    settings.rarityWeights[rarity.id] = Number.isFinite(value) && value > 0 ? value : DEFAULT_RARITY_WEIGHTS[rarity.id];
  }
  setRarityWeights(settings.rarityWeights);
  settings.pity ||= {};
  settings.pity.enabled = settings.pity.enabled === true;
  settings.pity.threshold = Number(settings.pity.threshold) > 0 ? Math.round(Number(settings.pity.threshold)) : 10;
  settings.pity.minRarity = RARITIES.some((rarity) => rarity.id === settings.pity.minRarity) ? settings.pity.minRarity : "rare";
  settings.pity.dustValues ||= {};
  for (const [index, rarity] of RARITIES.entries()) {
    const value = Number(settings.pity.dustValues[rarity.id]);
    settings.pity.dustValues[rarity.id] = Number.isFinite(value) && value >= 0 ? value : index + 1;
  }
  settings.subRewards ||= {};
  settings.subRewards.enabled = settings.subRewards.enabled !== false;
  settings.subRewards.cardsPerSub = Number(settings.subRewards.cardsPerSub) > 0 ? Math.round(Number(settings.subRewards.cardsPerSub)) : 1;
  // Fallback when no booster is marked "Sub-exklusiv" (or it has no cards): draw from the
  // normal pool instead of granting nothing, with its own separately configurable card count.
  settings.subRewards.fallbackEnabled = settings.subRewards.fallbackEnabled === true;
  settings.subRewards.fallbackCardsPerSub = Number(settings.subRewards.fallbackCardsPerSub) > 0 ? Math.round(Number(settings.subRewards.fallbackCardsPerSub)) : 1;
  // Bits/Cheers: every "bitsPerDraw" bits earns one card draw, leftover bits bank server-side
  // (data/command-usage.json "bits" section) and carry over to the next cheer from that viewer.
  settings.bits ||= {};
  settings.bits.enabled = settings.bits.enabled === true;
  settings.bits.bitsPerDraw = Number(settings.bits.bitsPerDraw) > 0 ? Math.round(Number(settings.bits.bitsPerDraw)) : 100;
  settings.obs ||= {
    enabled: false,
    host: "127.0.0.1",
    port: 4455,
    password: "",
    sceneName: "Streamer Card Overlay",
    sourceName: "Streamer Card Widget"
  };
  settings.obs.sceneName ||= "Streamer Card Overlay";
  settings.obs.sourceName ||= "Streamer Card Widget";
  // One combined browser source (overlays.html) hosts ALL animations - see setupObsOverlay.
  settings.obs.combinedSourceName ||= "Streamer Card Overlays";
  settings.meld ||= {
    enabled: false,
    host: "127.0.0.1",
    port: 13376
  };
  settings.meld.sceneName ||= settings.obs.sceneName;
  settings.meld.sourceName ||= settings.obs.sourceName;
  settings.meld.collectionSourceName ||= settings.showcase?.sourceName || "Streamer Card Sammlung";
  settings.meld.tradeSourceName ||= settings.tradeAnimation?.sourceName || "Streamer Card Tausch";
  settings.meld.battleSourceName ||= settings.battleAnimation?.sourceName || "Streamer Card Kampf";
  settings.meld.rankingSourceName ||= settings.ranking?.sourceName || "Streamer Card Ranking";
  settings.meld.communityGoalSourceName ||= settings.communityGoal?.sourceName || "Streamer Card Community-Ziel";
  settings.meld.combinedSourceName ||= settings.obs.combinedSourceName || "Streamer Card Overlays";

  // Collection showcase: a dedicated channel-point reward that, when redeemed, slides through
  // every active booster showing the redeemer's owned + still-unknown cards in its own OBS source.
  settings.showcase ||= {};
  settings.showcase.secondsPerBooster = Number(settings.showcase.secondsPerBooster) > 0 ? Number(settings.showcase.secondsPerBooster) : 12;
  settings.showcase.sourceName ||= "Streamer Card Sammlung";
  settings.showcase.rewardName ||= "Sammlung zeigen";
  settings.showcase.rewardCost = Number(settings.showcase.rewardCost || 500);
  settings.showcase.rewardPrompt ||= "";
  settings.showcase.rewardIds ||= [];
  settings.showcase.rewardBackgroundColor ||= "#9147ff";
  settings.showcase.rewardGlobalCooldown = Number(settings.showcase.rewardGlobalCooldown || 0);
  settings.showcase.rewardEnabled = settings.showcase.rewardEnabled !== false;
  settings.showcase.rewardPaused = settings.showcase.rewardPaused === true;
  settings.showcase.style = settings.showcase.style === "compact" ? "compact" : "detailed";
  // Lets the overlay slideshow be switched off entirely (channel points AND !collection) while
  // still sending the chat card-name listing - independent of chatOutputEnabled below, which
  // controls the listing itself regardless of whether the animation runs.
  settings.showcase.animationEnabled = settings.showcase.animationEnabled !== false;

  // Single global "open a pack" reward, decoupled from any one booster: PickRandomBoosterId()
  // (server-side) always draws from ALL eligible boosters regardless of which reward triggered
  // it, so a reward stored per-booster never actually scoped the draw - one shared reward is
  // both simpler and matches how the draw actually behaves.
  settings.draw ||= {};
  settings.draw.rewardName ||= "Kartenpack";
  settings.draw.rewardCost = Number(settings.draw.rewardCost || 1);
  settings.draw.rewardPrompt ||= "";
  settings.draw.rewardIds ||= [];
  settings.draw.rewardBackgroundColor ||= "#9147ff";
  settings.draw.rewardGlobalCooldown = Number(settings.draw.rewardGlobalCooldown || 0);
  settings.draw.rewardMaxPerStream = Number(settings.draw.rewardMaxPerStream || 0);
  settings.draw.rewardMaxPerUserPerStream = Number(settings.draw.rewardMaxPerUserPerStream || 0);
  settings.draw.rewardEnabled = settings.draw.rewardEnabled !== false;
  settings.draw.rewardPaused = settings.draw.rewardPaused === true;
  // Optional chat message sent after the pack animation finishes (channel-point draws).
  settings.draw.postMessageEnabled = settings.draw.postMessageEnabled === true;
  settings.draw.postMessage ||= pickDefault(settings.language, "drawPost");

  // Second Twitch identity (bot account) used for reading/sending chat. Falls back to the
  // main/broadcaster connection when not configured.
  settings.twitchBot ||= {};

  // Chat commands: !pack (usage limit + cooldown, both strictly per-username) and !collection
  // (no limit, no cooldown, no usage tracking) - mirrors the channel-point draw/showcase rewards.
  settings.chatCommands ||= {};
  settings.chatCommands.enabled = settings.chatCommands.enabled === true;
  // Language the [Seltenheit] chat variable is written out in (draw messages, !dustset/!dustall) -
  // independent of the admin UI language.
  settings.chatCommands.rarityLanguage = SUPPORTED_LANGUAGES.includes(settings.chatCommands.rarityLanguage) ? settings.chatCommands.rarityLanguage : "de";
  settings.chatCommands.pack ||= {};
  settings.chatCommands.pack.enabled = settings.chatCommands.pack.enabled !== false;
  settings.chatCommands.pack.prefix ||= "!";
  settings.chatCommands.pack.command ||= "pack";
  settings.chatCommands.pack.helpText ||= pickDefault(settings.language, "helpPack");
  settings.chatCommands.pack.maxUses = Number(settings.chatCommands.pack.maxUses) >= 0 ? Number(settings.chatCommands.pack.maxUses) : 5;
  settings.chatCommands.pack.resetUnit = ["minutes", "hours", "days"].includes(settings.chatCommands.pack.resetUnit) ? settings.chatCommands.pack.resetUnit : "hours";
  settings.chatCommands.pack.resetValue = Number(settings.chatCommands.pack.resetValue) > 0 ? Number(settings.chatCommands.pack.resetValue) : 8;
  settings.chatCommands.pack.cooldownSeconds = Number(settings.chatCommands.pack.cooldownSeconds) >= 0 ? Number(settings.chatCommands.pack.cooldownSeconds) : 300;
  settings.chatCommands.pack.limitMessage ||= pickDefault(settings.language, "packLimit");
  settings.chatCommands.pack.cooldownMessage ||= pickDefault(settings.language, "packCooldown");
  // The pack success message is now sent AFTER the animation, so it can name the drawn card.
  // Migrate the old "sold/opening" default (which no longer fits) to the new post-draw text.
  if (!settings.chatCommands.pack.successMessage
      || settings.chatCommands.pack.successMessage === "@userName, ein Booster wurde verkauft und wird gleich für dich geöffnet.") {
    settings.chatCommands.pack.successMessage = pickDefault(settings.language, "drawPost");
  }
  settings.chatCommands.packs ||= {};
  settings.chatCommands.packs.enabled = settings.chatCommands.packs.enabled !== false;
  settings.chatCommands.packs.prefix ||= "!";
  settings.chatCommands.packs.command ||= "packs";
  settings.chatCommands.packs.helpText ||= pickDefault(settings.language, "helpPacks");
  settings.chatCommands.packs.headerMessage ||= pickDefault(settings.language, "packsHeader");
  settings.chatCommands.packs.emptyMessage ||= pickDefault(settings.language, "packsEmpty");
  settings.chatCommands.packs.subOnlyLabel ||= "Sub Only";

  settings.chatCommands.dust ||= {};
  settings.chatCommands.dust.enabled = settings.chatCommands.dust.enabled === true;
  settings.chatCommands.dust.prefix ||= "!";
  settings.chatCommands.dust.command ||= "dust";
  settings.chatCommands.dust.helpText ||= pickDefault(settings.language, "helpDust");
  settings.chatCommands.dust.usageMessage ||= pickDefault(settings.language, "dustUsage");
  settings.chatCommands.dust.cardNotFoundMessage ||= pickDefault(settings.language, "dustCardNotFound");
  settings.chatCommands.dust.notEnoughMessage ||= pickDefault(settings.language, "dustNotEnough");
  settings.chatCommands.dust.successMessage ||= pickDefault(settings.language, "dustSuccess");

  // "!dustset"/"!dustall" are sub-commands of !dust - no prefix of their own (always uses dust's),
  // only the command word + messages are independently configurable.
  settings.chatCommands.dustSet ||= {};
  settings.chatCommands.dustSet.command ||= "dustset";
  settings.chatCommands.dustSet.helpText ||= pickDefault(settings.language, "helpDustSet");
  // Migrate the pre-[BefehlSet]/[BefehlAll] defaults (which hardcoded "!dustset"/"!dustall"
  // literally, so a renamed command still showed the wrong name in chat) to the new placeholder
  // text - any exact match in any of the 5 languages, since the field could've been auto-filled
  // in a different admin language than the one active now.
  const OLD_DUST_SET_DEFAULTS = {
    usageMessage: [
      "@userName, Nutzung: !dustset <Seltenheit> (z.B. legendär) - legt fest, bis zu welcher Seltenheit !dustall automatisch Duplikate opfert.",
      "@userName, usage: !dustset <rarity> (e.g. legendary) - sets up to which rarity !dustall automatically sacrifices duplicates.",
      "@userName, utilisation : !dustset <rareté> (ex. légendaire) - définit jusqu'à quelle rareté !dustall sacrifie automatiquement les doublons.",
      "@userName, uso: !dustset <rareza> (p. ej. legendaria) - define hasta qué rareza !dustall sacrifica duplicados automáticamente.",
      "@userName วิธีใช้: !dustset <ระดับความหายาก> (เช่น ตำนาน) - กำหนดว่า !dustall จะสังเวยการ์ดซ้ำอัตโนมัติสูงสุดถึงระดับใด"
    ],
    successMessage: [
      "@userName, !dustall opfert ab jetzt automatisch alle Duplikate bis einschließlich [Seltenheit].",
      "@userName, !dustall will now automatically sacrifice all duplicates up to and including [Seltenheit].",
      "@userName, !dustall sacrifiera désormais automatiquement tous les doublons jusqu'à [Seltenheit] inclus.",
      "@userName, !dustall ahora sacrificará automáticamente todos los duplicados hasta [Seltenheit] inclusive.",
      "@userName ตอนนี้ !dustall จะสังเวยการ์ดซ้ำทั้งหมดโดยอัตโนมัติจนถึง [Seltenheit]"
    ]
  };
  if (!settings.chatCommands.dustSet.usageMessage || OLD_DUST_SET_DEFAULTS.usageMessage.includes(settings.chatCommands.dustSet.usageMessage)) {
    settings.chatCommands.dustSet.usageMessage = pickDefault(settings.language, "dustSetUsage");
  }
  settings.chatCommands.dustSet.invalidMessage ||= pickDefault(settings.language, "dustSetInvalid");
  if (!settings.chatCommands.dustSet.successMessage || OLD_DUST_SET_DEFAULTS.successMessage.includes(settings.chatCommands.dustSet.successMessage)) {
    settings.chatCommands.dustSet.successMessage = pickDefault(settings.language, "dustSetSuccess");
  }

  settings.chatCommands.dustAll ||= {};
  settings.chatCommands.dustAll.command ||= "dustall";
  settings.chatCommands.dustAll.helpText ||= pickDefault(settings.language, "helpDustAll");
  settings.chatCommands.dustAll.nothingMessage ||= pickDefault(settings.language, "dustAllNothing");
  settings.chatCommands.dustAll.successMessage ||= pickDefault(settings.language, "dustAllSuccess");
  // "!gift @recipient <card>" - one-sided, no confirmation needed from the recipient (see
  // HandleGiftCommand server-side). Was missing its own normalization block entirely, which left
  // every chat message here as an empty string ("" survives GetString's fallback check on the
  // server, since GetString only falls back when the KEY itself is absent) instead of the
  // intended default text - the bug this block fixes.
  settings.chatCommands.gift ||= {};
  settings.chatCommands.gift.enabled = settings.chatCommands.gift.enabled === true;
  settings.chatCommands.gift.prefix ||= "!";
  settings.chatCommands.gift.command ||= "gift";
  settings.chatCommands.gift.helpText ||= pickDefault(settings.language, "helpGift");
  settings.chatCommands.gift.chatOutputEnabled = settings.chatCommands.gift.chatOutputEnabled !== false;
  settings.chatCommands.gift.usageMessage ||= pickDefault(settings.language, "giftUsage");
  settings.chatCommands.gift.userNotFoundMessage ||= pickDefault(settings.language, "giftUserNotFound");
  settings.chatCommands.gift.cardNotFoundMessage ||= pickDefault(settings.language, "giftCardNotFound");
  settings.chatCommands.gift.notOwnedMessage ||= pickDefault(settings.language, "giftNotOwned");
  settings.chatCommands.gift.selfGiftMessage ||= pickDefault(settings.language, "giftSelf");
  settings.chatCommands.gift.successMessage ||= pickDefault(settings.language, "giftSuccess");
  settings.chatCommands.collection ||= {};
  settings.chatCommands.collection.enabled = settings.chatCommands.collection.enabled !== false;
  settings.chatCommands.collection.prefix ||= "!";
  settings.chatCommands.collection.command ||= "collection";
  settings.chatCommands.collection.helpText ||= pickDefault(settings.language, "helpCollection");
  // Besides the overlay showcase, !collection can also list the caller's card names as chat
  // text (own toggle, on by default).
  settings.chatCommands.collection.chatOutputEnabled = settings.chatCommands.collection.chatOutputEnabled !== false;
  // Whether that chat text goes to public chat or as a whisper (private message) to the caller.
  settings.chatCommands.collection.outputMode = settings.chatCommands.collection.outputMode === "whisper" ? "whisper" : "chat";
  settings.chatCommands.collection.headerMessage ||= pickDefault(settings.language, "collectionHeader");
  settings.chatCommands.collection.emptyMessage ||= pickDefault(settings.language, "collectionEmpty");

  // Trade system: !trade (offer), !tradeyes (accept), !tradeno (decline).
  settings.chatCommands.trade ||= {};
  settings.chatCommands.trade.enabled = settings.chatCommands.trade.enabled !== false;
  settings.chatCommands.trade.prefix ||= "!";
  settings.chatCommands.trade.command ||= "trade";
  settings.chatCommands.trade.helpText ||= pickDefault(settings.language, "helpTrade");
  settings.chatCommands.trade.cooldownSeconds = Number(settings.chatCommands.trade.cooldownSeconds) >= 0 ? Number(settings.chatCommands.trade.cooldownSeconds) : 60;
  settings.chatCommands.trade.maxUses = Number(settings.chatCommands.trade.maxUses) >= 0 ? Number(settings.chatCommands.trade.maxUses) : 5;
  settings.chatCommands.trade.resetUnit = ["minutes", "hours", "days"].includes(settings.chatCommands.trade.resetUnit) ? settings.chatCommands.trade.resetUnit : "hours";
  settings.chatCommands.trade.resetValue = Number(settings.chatCommands.trade.resetValue) > 0 ? Number(settings.chatCommands.trade.resetValue) : 8;
  settings.chatCommands.trade.requestTimeoutSeconds = Number(settings.chatCommands.trade.requestTimeoutSeconds) > 0 ? Number(settings.chatCommands.trade.requestTimeoutSeconds) : 120;
  settings.chatCommands.trade.cardNotFoundMessage ||= pickDefault(settings.language, "tradeCardNotFound");
  settings.chatCommands.trade.offerNotOwnedMessage ||= pickDefault(settings.language, "tradeOfferNotOwned");
  settings.chatCommands.trade.userNotFoundMessage ||= pickDefault(settings.language, "tradeUserNotFound");
  settings.chatCommands.trade.offerMessage ||= pickDefault(settings.language, "tradeOffer");
  settings.chatCommands.trade.timeoutMessage ||= pickDefault(settings.language, "tradeTimeout");
  settings.chatCommands.trade.cooldownMessage ||= pickDefault(settings.language, "tradeCooldown");
  settings.chatCommands.trade.limitMessage ||= pickDefault(settings.language, "tradeLimit");
  settings.chatCommands.trade.busyMessage ||= pickDefault(settings.language, "tradeBusy");

  settings.chatCommands.tradeyes ||= {};
  settings.chatCommands.tradeyes.enabled = settings.chatCommands.tradeyes.enabled !== false;
  settings.chatCommands.tradeyes.prefix ||= "!";
  settings.chatCommands.tradeyes.command ||= "tradeyes";
  settings.chatCommands.tradeyes.notOwnedMessage ||= pickDefault(settings.language, "tradeyesNotOwned");
  settings.chatCommands.tradeyes.successMessage ||= pickDefault(settings.language, "tradeyesSuccess");

  settings.chatCommands.tradeno ||= {};
  settings.chatCommands.tradeno.enabled = settings.chatCommands.tradeno.enabled !== false;
  settings.chatCommands.tradeno.prefix ||= "!";
  settings.chatCommands.tradeno.command ||= "tradeno";
  settings.chatCommands.tradeno.declineMessage ||= pickDefault(settings.language, "tradenoDecline");

  // Battle system: !battle (challenge), !battleyes (accept), !battleno (decline).
  settings.chatCommands.battle ||= {};
  settings.chatCommands.battle.enabled = settings.chatCommands.battle.enabled !== false;
  settings.chatCommands.battle.prefix ||= "!";
  settings.chatCommands.battle.command ||= "battle";
  settings.chatCommands.battle.helpText ||= pickDefault(settings.language, "helpBattle");
  settings.chatCommands.battle.lineupSize = Number(settings.chatCommands.battle.lineupSize) > 0 ? Number(settings.chatCommands.battle.lineupSize) : 3;
  settings.chatCommands.battle.cooldownSeconds = Number(settings.chatCommands.battle.cooldownSeconds) >= 0 ? Number(settings.chatCommands.battle.cooldownSeconds) : 60;
  settings.chatCommands.battle.maxUses = Number(settings.chatCommands.battle.maxUses) >= 0 ? Number(settings.chatCommands.battle.maxUses) : 5;
  settings.chatCommands.battle.resetUnit = ["minutes", "hours", "days"].includes(settings.chatCommands.battle.resetUnit) ? settings.chatCommands.battle.resetUnit : "hours";
  settings.chatCommands.battle.resetValue = Number(settings.chatCommands.battle.resetValue) > 0 ? Number(settings.chatCommands.battle.resetValue) : 8;
  settings.chatCommands.battle.requestTimeoutSeconds = Number(settings.chatCommands.battle.requestTimeoutSeconds) > 0 ? Number(settings.chatCommands.battle.requestTimeoutSeconds) : 120;
  settings.chatCommands.battle.usageMessage ||= pickDefault(settings.language, "battleUsage");
  settings.chatCommands.battle.userNotFoundMessage ||= pickDefault(settings.language, "battleUserNotFound");
  settings.chatCommands.battle.selfChallengeMessage ||= pickDefault(settings.language, "battleSelfChallenge");
  settings.chatCommands.battle.notEnoughCardsMessage ||= pickDefault(settings.language, "battleNotEnoughCards");
  settings.chatCommands.battle.offerMessage ||= pickDefault(settings.language, "battleOffer");
  settings.chatCommands.battle.timeoutMessage ||= pickDefault(settings.language, "battleTimeout");
  settings.chatCommands.battle.cooldownMessage ||= pickDefault(settings.language, "battleCooldown");
  settings.chatCommands.battle.limitMessage ||= pickDefault(settings.language, "battleLimit");
  settings.chatCommands.battle.busyMessage ||= pickDefault(settings.language, "battleBusy");

  settings.chatCommands.battleyes ||= {};
  settings.chatCommands.battleyes.enabled = settings.chatCommands.battleyes.enabled !== false;
  settings.chatCommands.battleyes.prefix ||= "!";
  settings.chatCommands.battleyes.command ||= "battleyes";
  settings.chatCommands.battleyes.resultMessage ||= pickDefault(settings.language, "battleyesResult");

  settings.chatCommands.battleno ||= {};
  settings.chatCommands.battleno.enabled = settings.chatCommands.battleno.enabled !== false;
  settings.chatCommands.battleno.prefix ||= "!";
  settings.chatCommands.battleno.command ||= "battleno";
  settings.chatCommands.battleno.declineMessage ||= pickDefault(settings.language, "battlenoDecline");

  // Ranking: !ranking battle / !ranking <Kartenname>. Silent in chat by design - the result is
  // rendered exclusively in the dedicated OBS ranking overlay (ranking.html).
  settings.chatCommands.ranking ||= {};
  settings.chatCommands.ranking.enabled = settings.chatCommands.ranking.enabled !== false;
  settings.chatCommands.ranking.prefix ||= "!";
  settings.chatCommands.ranking.command ||= "ranking";
  settings.chatCommands.ranking.displaySeconds = Number(settings.chatCommands.ranking.displaySeconds) > 0 ? Number(settings.chatCommands.ranking.displaySeconds) : 8;
  settings.chatCommands.ranking.helpText ||= pickDefault(settings.language, "helpRanking");
  // "!ranking <Kartenname>" stays deliberately silent in chat on success (result shown only in
  // the OBS overlay), but these two dead-end cases (unknown card, or a real card nobody has drawn
  // yet) get a chat message - without one the command looks like it silently failed, since there
  // is no overlay animation to fall back on either.
  settings.chatCommands.ranking.cardNotFoundMessage ||= pickDefault(settings.language, "rankingCardNotFound");
  settings.chatCommands.ranking.noOwnersMessage ||= pickDefault(settings.language, "rankingNoOwners");

  settings.ranking ||= {};
  settings.ranking.sourceName ||= "Streamer Card Ranking";

  // Community goal: shared progress bar across every viewer's draws (any trigger). Runtime
  // progress (current/reached/participants) lives server-side in data/community-goal.json, not
  // here - this is just the admin-configurable part.
  settings.communityGoal ||= {};
  settings.communityGoal.enabled = settings.communityGoal.enabled === true;
  settings.communityGoal.label ||= "";
  settings.communityGoal.sourceName ||= "Streamer Card Community-Ziel";
  // Up to 5 goal stages, each with its own target, bonus-card count and celebration text (shown
  // both in chat and in the overlay). Older settings.json (pre-multi-stage) only had a single
  // "target"/"celebrationMessage" pair - migrate that into a one-stage array once, then drop it.
  if (!Array.isArray(settings.communityGoal.stages) || !settings.communityGoal.stages.length) {
    const legacyTarget = Number(settings.communityGoal.target) > 0 ? Math.round(Number(settings.communityGoal.target)) : 500;
    const legacyMessage = settings.communityGoal.celebrationMessage || pickDefault(settings.language, "communityGoalReached");
    settings.communityGoal.stages = [{ target: legacyTarget, bonusCards: 1, celebrationMessage: legacyMessage }];
  }
  // One-time repair: earlier versions' default celebration text never actually said how many
  // bonus boosters were awarded ("...einen Bonus-Booster" with no [Karten] variable at all) - any
  // stage still carrying that exact old wording (in any supported language, so an untouched stage
  // gets fixed regardless of which language it was created under) is almost certainly unmodified
  // by the streamer, so it's safe to refresh to the current default with [Karten] included.
  const staleCommunityGoalMessages = new Set([
    "🎉 Community-Ziel erreicht ([Ziel] Ziehungen)! Alle Teilnehmer bekommen automatisch einen Bonus-Booster.",
    "🎉 Community goal reached ([Ziel] draws)! Every participant automatically gets a bonus booster.",
    "🎉 Objectif communautaire atteint ([Ziel] tirages) ! Tous les participants reçoivent automatiquement un booster bonus.",
    "🎉 ¡Meta comunitaria alcanzada ([Ziel] tiradas)! Todos los participantes reciben automáticamente un sobre extra.",
    "🎉 บรรลุเป้าหมายชุมชนแล้ว ([Ziel] ครั้ง)! ผู้เข้าร่วมทุกคนจะได้รับบูสเตอร์โบนัสอัตโนมัติ"
  ]);
  settings.communityGoal.stages = settings.communityGoal.stages.slice(0, 5).map((stage) => ({
    target: Number(stage?.target) > 0 ? Math.round(Number(stage.target)) : 500,
    bonusCards: Number(stage?.bonusCards) > 0 ? Math.round(Number(stage.bonusCards)) : 1,
    celebrationMessage: stage?.celebrationMessage && !staleCommunityGoalMessages.has(stage.celebrationMessage)
      ? stage.celebrationMessage
      : pickDefault(settings.language, "communityGoalReached")
  }));
  delete settings.communityGoal.target;
  delete settings.communityGoal.celebrationMessage;

  // Tournament Mode: signup via chat command and/or channel points and/or the admin "Turnier
  // starten" button; a single bracket resolves automatically once the signup window closes (see
  // ResolveTournamentSignup server-side). No cards are at risk between opponents - the champion
  // wins configurable bonus pack draws instead.
  settings.tournament ||= {};
  settings.tournament.enabled = settings.tournament.enabled === true;
  settings.tournament.minParticipants = Number(settings.tournament.minParticipants) >= 2 ? Math.round(Number(settings.tournament.minParticipants)) : 3;
  settings.tournament.signupSeconds = Number(settings.tournament.signupSeconds) > 0 ? Math.round(Number(settings.tournament.signupSeconds)) : 90;
  settings.tournament.lineupSize = Number(settings.tournament.lineupSize) > 0 ? Math.round(Number(settings.tournament.lineupSize)) : 3;
  settings.tournament.winnerDraws = Number(settings.tournament.winnerDraws) > 0 ? Math.round(Number(settings.tournament.winnerDraws)) : 1;
  // Two independent reward layers, combinable: every round's winner can get a pack draw right
  // after their match (perRoundWinnerEnabled), and/or the tournament champion gets winnerDraws
  // extra draws at the very end. With both on, the champion gets a per-round draw for winning
  // the final PLUS the bonus winnerDraws on top.
  settings.tournament.perRoundWinnerEnabled = settings.tournament.perRoundWinnerEnabled === true;
  settings.tournament.championDrawsEnabled = settings.tournament.championDrawsEnabled !== false;
  settings.tournament.announceJoins = settings.tournament.announceJoins !== false;
  settings.tournament.signupStartMessage ||= pickDefault(settings.language, "tournamentSignupStart");
  settings.tournament.joinAckMessage ||= pickDefault(settings.language, "tournamentJoinAck");
  settings.tournament.notEligibleMessage ||= pickDefault(settings.language, "tournamentNotEligible");
  settings.tournament.alreadyRunningMessage ||= pickDefault(settings.language, "tournamentAlreadyRunning");
  settings.tournament.cancelMessage ||= pickDefault(settings.language, "tournamentCancel");
  settings.tournament.roundAnnounceMessage ||= pickDefault(settings.language, "tournamentRoundAnnounce");
  settings.tournament.byeAnnounceMessage ||= pickDefault(settings.language, "tournamentByeAnnounce");
  settings.tournament.winnerAnnounceMessage ||= pickDefault(settings.language, "tournamentWinnerAnnounce");
  settings.tournament.rewardName ||= "Turnier starten";
  settings.tournament.rewardCost = Number(settings.tournament.rewardCost) > 0 ? Number(settings.tournament.rewardCost) : 1000;
  settings.tournament.rewardPrompt ||= "";
  settings.tournament.rewardBackgroundColor ||= "#9147ff";
  settings.tournament.rewardEnabled = settings.tournament.rewardEnabled !== false;
  settings.tournament.rewardPaused = settings.tournament.rewardPaused === true;
  settings.tournament.rewardGlobalCooldown = Number(settings.tournament.rewardGlobalCooldown) >= 0 ? Number(settings.tournament.rewardGlobalCooldown) : 0;
  settings.tournament.rewardIds ||= [];

  // Team-Kampf ("Alle gegen den Streamer"): channel-points-triggered signup window, chat-command
  // join, then a single HP-Leisten-Duell-style fight between the streamer's random lineup and the
  // community's queue (signup order) once the window closes - see ResolveTeamBattleSignup
  // server-side. Chat message texts are intentionally NOT admin-configurable here, same as
  // tournament's round/bye/winner messages - only the numeric/toggle behavior is.
  settings.teamBattle ||= {};
  settings.teamBattle.enabled = settings.teamBattle.enabled === true;
  settings.teamBattle.streamerCardCount = Number(settings.teamBattle.streamerCardCount) > 0 ? Math.round(Number(settings.teamBattle.streamerCardCount)) : 5;
  settings.teamBattle.signupSeconds = Number(settings.teamBattle.signupSeconds) > 0 ? Math.round(Number(settings.teamBattle.signupSeconds)) : 60;
  // Difficulty rubber-banding: every Team-Kampf the community lost in a row shaves this many
  // cards off the streamer's minimum lineup for the NEXT attempt (floored at difficultyMinCard
  // Count), resetting the moment the community wins again - see RecordTeamKampfDifficultyResult/
  // GetTeamKampfCommunityLossStreak server-side.
  settings.teamBattle.difficultyRubberbandEnabled = settings.teamBattle.difficultyRubberbandEnabled !== false;
  settings.teamBattle.difficultyStepDown = Number(settings.teamBattle.difficultyStepDown) >= 1 ? Math.round(Number(settings.teamBattle.difficultyStepDown)) : 1;
  settings.teamBattle.difficultyMinCardCount = Number(settings.teamBattle.difficultyMinCardCount) > 0 ? Math.round(Number(settings.teamBattle.difficultyMinCardCount)) : 1;
  settings.teamBattle.rewardsEnabled = settings.teamBattle.rewardsEnabled !== false;
  settings.teamBattle.drawsPerParticipant = Number(settings.teamBattle.drawsPerParticipant) >= 0 ? Math.round(Number(settings.teamBattle.drawsPerParticipant)) : 1;
  settings.teamBattle.finisherBonusEnabled = settings.teamBattle.finisherBonusEnabled !== false;
  settings.teamBattle.finisherBonusDraws = Number(settings.teamBattle.finisherBonusDraws) >= 0 ? Math.round(Number(settings.teamBattle.finisherBonusDraws)) : 1;
  settings.teamBattle.loseCardOnDefeat = settings.teamBattle.loseCardOnDefeat === true;
  settings.teamBattle.rewardName ||= "Team-Kampf starten";
  settings.teamBattle.rewardCost = Number(settings.teamBattle.rewardCost) > 0 ? Number(settings.teamBattle.rewardCost) : 2000;
  settings.teamBattle.rewardPrompt ||= "";
  settings.teamBattle.rewardBackgroundColor ||= "#9147ff";
  settings.teamBattle.rewardEnabled = settings.teamBattle.rewardEnabled !== false;
  settings.teamBattle.rewardPaused = settings.teamBattle.rewardPaused === true;
  settings.teamBattle.rewardGlobalCooldown = Number(settings.teamBattle.rewardGlobalCooldown) >= 0 ? Number(settings.teamBattle.rewardGlobalCooldown) : 0;
  settings.teamBattle.rewardIds ||= [];

  // Per-animation position/size within the combined overlay canvas (always 1920x1080,
  // regardless of the actual OBS/Meld source resolution - scaling to the real canvas is the
  // browser source's job, same as everything else in overlays.html). marginLeft/marginTop mark
  // the top-left corner of the animation's natural-size content box (OVERLAY_LAYOUT_NATURAL_SIZES
  // x scale%); marginRight/marginBottom are kept as their mirror for display - see
  // applyOverlayLayout below. Default = centered at 100%, i.e. pixel-identical to before this
  // setting existed.
  settings.overlayLayout ||= {};
  for (const key of ["draw", "collection", "trade", "battle", "gift", "ranking", "communityGoal", "liveTicker", "commandsHelp"]) {
    const layout = settings.overlayLayout[key] || {};
    const scale = Number(layout.scale) > 0 ? Math.min(100, Math.max(10, Number(layout.scale))) : 100;
    const { w: boxW, h: boxH } = overlayLayoutBoxSize(key, scale);
    // On first run (no stored margin yet) default to centered, matching how every animation
    // rendered before this setting existed - not the top-left corner marginLeft:0 would imply.
    // The live ticker is the one exception: a full-width banner centered on screen would sit on
    // top of the card animation, so it defaults to horizontally centered along the bottom edge.
    const defaultLeft = Math.max(0, (OVERLAY_LAYOUT_CANVAS_W - boxW) / 2);
    const defaultTop = key === "liveTicker" ? Math.max(0, OVERLAY_LAYOUT_CANVAS_H - boxH - 40) : Math.max(0, (OVERLAY_LAYOUT_CANVAS_H - boxH) / 2);
    // Deliberately NOT clamped to >= 0 here: a negative margin (or one pushing the box past the
    // opposite edge) is a valid, intentional position - it's how a card/animation ends up flush
    // against, or partially past, the canvas edge instead of always keeping at least a sliver of
    // margin. Only the "no stored value yet" default falls back to the centered position.
    const marginLeft = typeof layout.marginLeft === "number" ? layout.marginLeft : defaultLeft;
    const marginTop = typeof layout.marginTop === "number" ? layout.marginTop : defaultTop;
    settings.overlayLayout[key] = {
      marginTop,
      marginLeft,
      marginRight: OVERLAY_LAYOUT_CANVAS_W - marginLeft - boxW,
      marginBottom: OVERLAY_LAYOUT_CANVAS_H - marginTop - boxH,
      scale
    };
  }

  // Live ticker: a scrolling news-ticker banner listing the last few draws across all viewers,
  // independent of the pack-opening queue/animation (so it isn't throttled by the sequential
  // animation gap). speed is px/second the banner scrolls at, not a per-entry display timer.
  settings.liveTicker ||= {};
  settings.liveTicker.enabled = settings.liveTicker.enabled !== false;
  settings.liveTicker.maxEntries = Number(settings.liveTicker.maxEntries) > 0 ? Math.min(15, Math.max(2, Math.round(Number(settings.liveTicker.maxEntries)))) : 8;
  settings.liveTicker.speed = Number(settings.liveTicker.speed) > 0 ? Math.min(400, Math.max(20, Number(settings.liveTicker.speed))) : 120;

  // "Befehls-Übersicht" overlay (commandshelp.js): cycles through every currently active chat
  // command and channel-points reward with a short description + usage example. Off by default -
  // it's a helper widget the streamer opts into, not something that should suddenly appear.
  settings.commandsHelp ||= {};
  settings.commandsHelp.enabled = settings.commandsHelp.enabled === true;
  settings.commandsHelp.secondsPerItem = Number(settings.commandsHelp.secondsPerItem) > 0 ? Math.min(60, Math.max(2, Math.round(Number(settings.commandsHelp.secondsPerItem)))) : 6;

  settings.chatCommands.tournamentJoin ||= {};
  settings.chatCommands.tournamentJoin.enabled = settings.chatCommands.tournamentJoin.enabled !== false;
  settings.chatCommands.tournamentJoin.prefix ||= "!";
  settings.chatCommands.tournamentJoin.command ||= "turnier";
  settings.chatCommands.tournamentJoin.helpText ||= pickDefault(settings.language, "helpTournamentJoin");

  settings.chatCommands.tournamentStart ||= {};
  settings.chatCommands.tournamentStart.enabled = settings.chatCommands.tournamentStart.enabled !== false;
  settings.chatCommands.tournamentStart.prefix ||= "!";
  settings.chatCommands.tournamentStart.command ||= "turnierstart";
  settings.chatCommands.tournamentStart.helpText ||= pickDefault(settings.language, "helpTournamentStart");
  // Global (not per-user) cooldown so chat can't immediately re-spam a new signup right after
  // the previous tournament ends - see IsGlobalCommandOnCooldown server-side.
  settings.chatCommands.tournamentStart.cooldownSeconds = Number(settings.chatCommands.tournamentStart.cooldownSeconds) >= 0 ? Number(settings.chatCommands.tournamentStart.cooldownSeconds) : 0;
  settings.chatCommands.tournamentStart.cooldownMessage ||= pickDefault(settings.language, "packCooldown");

  settings.chatCommands.teamBattleJoin ||= {};
  settings.chatCommands.teamBattleJoin.enabled = settings.chatCommands.teamBattleJoin.enabled !== false;
  settings.chatCommands.teamBattleJoin.prefix ||= "!";
  settings.chatCommands.teamBattleJoin.command ||= "teamkampf";
  settings.chatCommands.teamBattleJoin.helpText ||= pickDefault(settings.language, "helpTeamBattleJoin");

  settings.chatCommands.teamBattleStart ||= {};
  settings.chatCommands.teamBattleStart.enabled = settings.chatCommands.teamBattleStart.enabled !== false;
  settings.chatCommands.teamBattleStart.prefix ||= "!";
  settings.chatCommands.teamBattleStart.command ||= "teamkampfstart";
  settings.chatCommands.teamBattleStart.helpText ||= pickDefault(settings.language, "helpTeamBattleStart");
  settings.chatCommands.teamBattleStart.cooldownSeconds = Number(settings.chatCommands.teamBattleStart.cooldownSeconds) >= 0 ? Number(settings.chatCommands.teamBattleStart.cooldownSeconds) : 0;
  settings.chatCommands.teamBattleStart.cooldownMessage ||= pickDefault(settings.language, "packCooldown");

  // Automatic "which commands are available" chat message - see CheckAutoHelp (server-side) for
  // the trigger logic (fires after N minutes and/or N chat messages, whichever comes first).
  settings.autoHelp ||= {};
  settings.autoHelp.enabled = settings.autoHelp.enabled === true;
  settings.autoHelp.intervalMinutes = Number(settings.autoHelp.intervalMinutes) >= 0 ? Number(settings.autoHelp.intervalMinutes) : 30;
  settings.autoHelp.intervalMessages = Number(settings.autoHelp.intervalMessages) >= 0 ? Number(settings.autoHelp.intervalMessages) : 0;
  settings.autoHelp.message ||= pickDefault(settings.language, "autoHelpMessage");


  if (!settings.boosters.length) {
    const legacy = settings.booster || {};
    settings.boosters = [{
      id: "default",
      title: legacy.title || settings.deck.name || "Kartenpack",
      subtitle: legacy.subtitle || "Pack",
      image: legacy.image || "",
      accent: legacy.accent || settings.style?.accentColor || "#ff78bb",
      rewardNames: settings.trigger?.rewardNames || ["Kartenpack", "Card Pack"],
      rewardIds: settings.trigger?.rewardIds || [],
      customEvents: settings.trigger?.customEvents || [],
      score: 100,
      cardIds: settings.deck.cards.slice(0, MAX_BOOSTER_CARDS).map((card) => card.id)
    }];
  }

  for (const booster of settings.boosters) {
    booster.id ||= createId("booster");
    booster.title ||= "Booster";
    booster.subtitle ||= "Pack";
    booster.accent ||= "#ff78bb";
    booster.rewardNames ||= [];
    booster.rewardIds ||= [];
    booster.customEvents ||= [];
    booster.rewardCost = Number(booster.rewardCost || 1);
    booster.rewardPrompt ||= "";
    booster.score = Number(booster.score ?? 100);
    if (Array.isArray(booster.cardIds) && booster.cardIds.length > MAX_BOOSTER_CARDS) {
      console.warn(`Booster "${booster.title}" hatte mehr als ${MAX_BOOSTER_CARDS} Karten zugewiesen — wurde beim Laden gekuerzt.`);
    }
    booster.cardIds = (booster.cardIds || []).slice(0, MAX_BOOSTER_CARDS);
  }

  for (const card of settings.deck.cards) {
    card.id ||= createId("card");
    card.rarity = rarityById(card.rarity).id;
    // Derive booster membership from booster.cardIds when not already set. Cards with no
    // assignment stay unassigned (no forced fallback to the first booster) so newly created
    // or duplicated cards remain unattached until the user assigns them.
    card.boosterIds ||= settings.boosters
      .filter((booster) => booster.cardIds.includes(card.id))
      .map((booster) => booster.id);
  }
  settings.twitch ||= {};
  return settings;
}

export function cardsForBooster(settings, booster) {
  const ids = new Set((booster?.cardIds || []).slice(0, MAX_BOOSTER_CARDS));
  return (settings.deck?.cards || []).filter((card) => ids.has(card.id));
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// Star count is fixed per rarity (not per card). Holo is special: always exactly one
// (iridescent) star, never 2-5.
export const RARITY_STARS = {
  common: 1,
  uncommon: 2,
  rare: 3,
  epic: 4,
  legendary: 5,
  holo: 1
};

export function rarityStars(rarity) {
  const id = String(rarity || "common").toLowerCase();
  return RARITY_STARS[id] || 1;
}

export function cardStars(rarity = "common") {
  const id = String(rarity).toLowerCase();
  const count = rarityStars(id);
  const holoAttr = id === "holo" ? ' data-holo="true"' : "";
  return Array.from({ length: count }, () => `<span${holoAttr}></span>`).join("");
}

export function cardMarkup(card, options = {}) {
  const hidden = options.hidden ? " is-hidden-card" : "";
  const compact = options.compact ? " is-compact-card" : "";
  // NOTE: do not add loading="lazy" here - it broke card reveal animations in OBS's Browser
  // Source (CEF), which doesn't fire the load in time for the overlay's viewport there.
  const cardPositionAttr = card?.imagePosition ? ` data-position="${escapeHtml(card.imagePosition)}"` : "";
  const image = card?.image
    ? `<img src="${escapeHtml(card.image)}" alt=""${cardPositionAttr}>`
    : `<div class="fallback-art">${escapeHtml((card?.title || "?").slice(0, 1))}</div>`;
  const accent = card?.accent || "#ff78bb";
  const title = card?.title || "Mystery";
  const rarity = card?.rarity || "Common";
  const borderColor = rarityColor(card?.rarity);
  const rarityAttr = String(card?.rarity || "common").toLowerCase();

  if (options.hidden) {
    return `
      <article class="tcg-card${hidden}${compact}" data-rarity="${escapeHtml(rarityAttr)}" style="--card-accent:${accent};--rarity-border:${escapeHtml(borderColor)}">
        <div class="card-back-mark">?</div>
      </article>
    `;
  }

  const holoOverlay = rarityAttr === "holo" ? `<div class="holo-glitter"></div>` : "";
  const starCount = rarityStars(rarityAttr);

  return `
    <article class="tcg-card${compact}" data-rarity="${escapeHtml(rarityAttr)}" data-image-fit="${activeCardImageFit}" style="--card-accent:${accent};--rarity-border:${escapeHtml(borderColor)}">
      <div class="corner top">${escapeHtml(starCount)}</div>
      <div class="card-art">${image}</div>
      <footer class="card-footer">
        <span class="card-title" style="--title-len:${title.length}">${escapeHtml(title)}</span>
        <span class="stars" aria-label="${escapeHtml(rarity)}">${cardStars(rarityAttr)}</span>
      </footer>
      <div class="corner bottom">${escapeHtml(starCount)}</div>
      ${holoOverlay}
    </article>
  `;
}

export function boosterMarkup(booster = {}) {
  const boosterPositionAttr = booster.imagePosition ? ` data-position="${escapeHtml(booster.imagePosition)}"` : "";
  const image = booster.image
    ? `<img src="${escapeHtml(booster.image)}" alt=""${boosterPositionAttr}>`
    : `<div class="fallback-booster">${escapeHtml(booster.title || "Pack")}</div>`;
  return `
    <article class="booster-pack" data-image-fit="${activeBoosterImageFit}" style="--pack-accent:${booster.accent || "#ff78bb"}">
      <div class="pack-teeth top"></div>
      <div class="pack-body">${image}</div>
      <div class="pack-label">
        <strong>${escapeHtml(booster.title || "Cards")}</strong>
        <span>${escapeHtml(booster.subtitle || "Pack")}</span>
      </div>
      <div class="pack-teeth bottom"></div>
    </article>
  `;
}

const OVERLAY_STRINGS = {
  collectionLabel: { de: "Sammlung", en: "Collection", fr: "Collection", es: "Colección", th: "คอลเลกชัน" }
};

export function overlayText(key, language) {
  const lang = SUPPORTED_LANGUAGES.includes(language) ? language : "de";
  return OVERLAY_STRINGS[key]?.[lang] ?? OVERLAY_STRINGS[key]?.en ?? OVERLAY_STRINGS[key]?.de ?? key;
}

export const CARD_THEMES = [
  "default", "onyx", "carbon", "midnight", "slate",
  "prism", "gold", "sunset", "mint", "ocean", "rose", "forest",
  "custom"
];

function hexToRgba(hex, alpha) {
  let h = String(hex || "#ffffff").replace("#", "").trim();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  if (Number.isNaN(n)) return `rgba(255, 255, 255, ${alpha})`;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// Builds the card CSS variables for a user-defined theme. Only ever touches --card-* so a
// custom theme can never affect anything but the card surface itself.
export function customThemeCss(ct = {}) {
  const c1 = ct.color1 || "#6a5cff";
  const c2 = ct.color2 || "#22d3ee";
  const c3 = ct.color3 || "#ff7ad9";
  const angle = clamp(ct.angle ?? 155, 0, 360);
  const colors = ct.useColor3 ? [c1, c2, c3] : [c1, c2];
  const bg = `linear-gradient(${angle}deg, ${colors.join(", ")})`;
  const sheen = clamp(ct.sheen ?? 30, 0, 70) / 100;
  const pattern = sheen > 0
    ? `linear-gradient(145deg, transparent 0 64%, rgba(255, 255, 255, ${sheen}) 64%)`
    : "none";
  const artBg = hexToRgba(ct.artColor || "#ffffff", clamp(ct.artOpacity ?? 45, 0, 100) / 100);
  return `--card-bg:${bg};--card-pattern:${pattern};--card-pattern-opacity:1;--card-art-bg:${artBg};`;
}

const CARD_VARS = ["--card-bg", "--card-pattern", "--card-pattern-opacity", "--card-art-bg"];

// Applies a per-animation position/scale setting (see settings.overlayLayout in
// normalizeSettings) to that animation's own root stage element. The element keeps whatever
// internal centering it already has (flexbox etc.) - shrinking its box via inset margins just
// moves where that centering point ends up, and the scale transform shrinks/grows the whole
// thing around its own center. Called once after every settings load in each overlay page (draw/
// collection/trade/battle/ranking/communitygoal), so a change takes effect on the next "settings"
// SSE broadcast without needing a page reload.
// Approximate on-screen footprint of each animation's actual content at the 1920x1080 reference
// canvas (not the full-bleed stage element, which always spans the whole viewport) - derived from
// the real CSS (card width/aspect-ratio, scene gaps, etc.) so the admin position/scale editor can
// show a box whose size is proportionally honest instead of an arbitrary guess. Purely a display
// aid for the editor; applyOverlayLayout below never stretches to these sizes.
export const OVERLAY_LAYOUT_NATURAL_SIZES = {
  // Card (320px) plus the collection-summary panel to its right (.rarity-summary, ~176px) and
  // the gap between them - not just the bare card, otherwise the editor's box looked far too
  // narrow next to what actually renders.
  draw: { w: 660, h: 460 },
  trade: { w: 720, h: 460 },
  battle: { w: 760, h: 520 },
  gift: { w: 620, h: 440 },
  collection: { w: 1100, h: 780 },
  ranking: { w: 1000, h: 600 },
  communityGoal: { w: 560, h: 100 },
  // A news-ticker banner spanning the full canvas width at all times - lockWidth means "scale"
  // never touches its width, only its height (and, in liveticker.js, font size). See
  // applyOverlayLayout and admin.js's overlayLayoutBoxSize, which both honor this flag.
  liveTicker: { w: 1920, h: 90, lockWidth: true },
  commandsHelp: { w: 500, h: 260 }
};

const OVERLAY_LAYOUT_CANVAS_W = 1920;
const OVERLAY_LAYOUT_CANVAS_H = 1080;

// Shared by applyOverlayLayout below and admin.js's editor so both agree on what a given
// key's box looks like at a given scale - lockWidth keys (currently just liveTicker) keep their
// natural width regardless of scale, only their height shrinks/grows with it.
export function overlayLayoutBoxSize(key, scale) {
  const natural = OVERLAY_LAYOUT_NATURAL_SIZES[key] || { w: 200, h: 200 };
  const s = Number(scale) > 0 ? scale : 100;
  return {
    w: natural.lockWidth ? natural.w : natural.w * (s / 100),
    h: natural.h * (s / 100)
  };
}

// The stage element (#stage etc.) is always position:fixed;inset:0 (full viewport) via its own
// CSS, with the actual animation content centered inside it by flexbox - so resizing/stretching
// the stage itself would never resize the content. Position and scale are applied as a single
// rigid transform instead, computed from the same natural content size and margins the admin
// editor's box-and-dot preview uses: marginLeft/marginTop mark where the content's box should sit
// (its size = natural size x scale), and that box's center becomes the translate target. For
// lockWidth keys (the live ticker), the transform never scales - its actual height and font size
// are set directly by the caller instead, so the banner never gets visually stretched/squished.
export function applyOverlayLayout(el, layout, key) {
  if (!el || !layout) return;
  const scale = Number(layout.scale) > 0 ? layout.scale : 100;
  const natural = OVERLAY_LAYOUT_NATURAL_SIZES[key] || { w: 0, h: 0 };
  const { w: boxW, h: boxH } = overlayLayoutBoxSize(key, scale);
  const centerX = (layout.marginLeft || 0) + boxW / 2;
  const centerY = (layout.marginTop || 0) + boxH / 2;
  const dx = centerX - OVERLAY_LAYOUT_CANVAS_W / 2;
  const dy = centerY - OVERLAY_LAYOUT_CANVAS_H / 2;
  const parts = [];
  if (dx || dy) parts.push(`translate(${dx}px, ${dy}px)`);
  if (!natural.lockWidth && scale !== 100) parts.push(`scale(${scale / 100})`);
  el.style.transform = parts.join(" ");
  el.style.transformOrigin = "center center";
}

export function applyTheme(settings) {
  const style = settings.style || {};
  setImageFit(style.cardImageFit, style.boosterImageFit);
  const root = document.documentElement;
  if (document.body) {
    document.body.dataset.theme = style.themeMode || "light";
    const cardTheme = CARD_THEMES.includes(style.cardTheme) ? style.cardTheme : "default";
    document.body.dataset.cardTheme = cardTheme;
    // For built-in themes the static [data-card-theme] CSS drives the look, so clear any
    // inline card vars. For "custom", apply the user's values inline (they're dynamic).
    if (cardTheme === "custom") {
      for (const decl of customThemeCss(style.customTheme).split(";")) {
        const [prop, value] = decl.split(":");
        if (prop && value) document.body.style.setProperty(prop.trim(), value.trim());
      }
    } else {
      for (const prop of CARD_VARS) document.body.style.removeProperty(prop);
    }
    // Overrides whichever pattern the chosen theme set (including "no theme"'s built-in
    // dot/stripe fallback) - a single always-available switch instead of needing "custom".
    if (style.cardPatternEnabled === false) document.body.style.setProperty("--card-pattern-opacity", "0");
    document.body.classList.toggle("hide-booster-pattern", style.boosterPatternEnabled === false);

    // User-uploaded pattern image: tiled over the card surface, replacing whatever gradient
    // pattern the theme set. --card-pattern-opacity (and the enabled toggle above) still apply,
    // so the same on/off switch hides a custom image just like it hides the built-in pattern.
    if (style.cardPatternImage) {
      const size = clamp(style.cardPatternSize ?? 40, 10, 300);
      document.body.style.setProperty("--card-pattern-image-css", `url(${style.cardPatternImage}) repeat 0 0 / ${size}px ${size}px`);
    } else {
      document.body.style.removeProperty("--card-pattern-image-css");
    }

    // Same idea for the booster pack face - tiled under the accent-color gradient so the pack
    // still reads as belonging to that booster even with a custom pattern applied.
    if (style.boosterPatternImage) {
      const size = clamp(style.boosterPatternSize ?? 40, 10, 300);
      document.body.style.setProperty("--booster-pattern-image", `url(${style.boosterPatternImage})`);
      document.body.style.setProperty("--booster-pattern-size", `${size}px`);
      document.body.classList.add("has-booster-pattern-image");
    } else {
      document.body.style.removeProperty("--booster-pattern-image");
      document.body.style.removeProperty("--booster-pattern-size");
      document.body.classList.remove("has-booster-pattern-image");
    }
  }
  root.style.setProperty("--accent", style.accentColor || "#ff78bb");
  root.style.setProperty("--panel-text", style.panelTextColor || "#2f2945");
  root.style.setProperty("--font", style.fontFamily || "Inter, Arial, sans-serif");
  root.style.setProperty("--screen-x", `${clamp(style.screenX ?? 50, 0, 100)}vw`);
  root.style.setProperty("--screen-y", `${clamp(style.screenY ?? 52, 0, 100)}vh`);
  root.style.setProperty("--widget-scale", clamp(style.scale ?? 1, 0.45, 1.7));
}
