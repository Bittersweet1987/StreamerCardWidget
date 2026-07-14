export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

// Safety cap against runaway/corrupt data, not a design limit — raise here if ever needed.
export const MAX_BOOSTER_CARDS = 100;

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
  // Random, stable per-install id for the anonymous community stats counter - unrelated to
  // Twitch identity, just lets the stats server tell "this install's current card/booster
  // count" apart from another install's without knowing who anyone is.
  settings.statsInstallId ||= (crypto.randomUUID ? crypto.randomUUID() : `install-${Date.now()}-${Math.random()}`);
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
  settings.chatCommands.pack ||= {};
  settings.chatCommands.pack.enabled = settings.chatCommands.pack.enabled !== false;
  settings.chatCommands.pack.prefix ||= "!";
  settings.chatCommands.pack.command ||= "pack";
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
  settings.chatCommands.collection ||= {};
  settings.chatCommands.collection.enabled = settings.chatCommands.collection.enabled !== false;
  settings.chatCommands.collection.prefix ||= "!";
  settings.chatCommands.collection.command ||= "collection";
  // Besides the overlay showcase, !collection can also list the caller's card names as chat
  // text (own toggle, on by default).
  settings.chatCommands.collection.chatOutputEnabled = settings.chatCommands.collection.chatOutputEnabled !== false;
  settings.chatCommands.collection.headerMessage ||= pickDefault(settings.language, "collectionHeader");
  settings.chatCommands.collection.emptyMessage ||= pickDefault(settings.language, "collectionEmpty");

  // Trade system: !trade (offer), !tradeyes (accept), !tradeno (decline).
  settings.chatCommands.trade ||= {};
  settings.chatCommands.trade.enabled = settings.chatCommands.trade.enabled !== false;
  settings.chatCommands.trade.prefix ||= "!";
  settings.chatCommands.trade.command ||= "trade";
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
  settings.chatCommands.battle.lineupSize = Number(settings.chatCommands.battle.lineupSize) > 0 ? Number(settings.chatCommands.battle.lineupSize) : 3;
  settings.chatCommands.battle.cooldownSeconds = Number(settings.chatCommands.battle.cooldownSeconds) >= 0 ? Number(settings.chatCommands.battle.cooldownSeconds) : 60;
  settings.chatCommands.battle.maxUses = Number(settings.chatCommands.battle.maxUses) >= 0 ? Number(settings.chatCommands.battle.maxUses) : 5;
  settings.chatCommands.battle.resetUnit = ["minutes", "hours", "days"].includes(settings.chatCommands.battle.resetUnit) ? settings.chatCommands.battle.resetUnit : "hours";
  settings.chatCommands.battle.resetValue = Number(settings.chatCommands.battle.resetValue) > 0 ? Number(settings.chatCommands.battle.resetValue) : 8;
  settings.chatCommands.battle.requestTimeoutSeconds = Number(settings.chatCommands.battle.requestTimeoutSeconds) > 0 ? Number(settings.chatCommands.battle.requestTimeoutSeconds) : 120;
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

  settings.ranking ||= {};
  settings.ranking.sourceName ||= "Streamer Card Ranking";


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
  const image = card?.image
    ? `<img src="${escapeHtml(card.image)}" alt="">`
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
  const image = booster.image
    ? `<img src="${escapeHtml(booster.image)}" alt="">`
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
