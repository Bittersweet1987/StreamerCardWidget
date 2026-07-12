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
  const pool = boosters.filter((booster) => Number(booster.score ?? 100) > 0);
  const effectivePool = pool.length ? pool : boosters;
  if (!effectivePool.length) return null;
  const total = effectivePool.reduce((sum, booster) => sum + Number(booster.score ?? 100), 0);
  let cursor = Math.random() * total;
  for (const booster of effectivePool) {
    cursor -= Number(booster.score ?? 100);
    if (cursor <= 0) return booster;
  }
  return effectivePool[effectivePool.length - 1];
}

export function normalizeSettings(settings) {
  settings.language ||= "de";
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
  settings.draw.postMessage ||= "@userName hat [Kartenname] aus [Boostername] gezogen.";

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
  settings.chatCommands.pack.limitMessage ||= "@userName, Leider hast du das maximum an Packs aktuell erreicht. Bitte warte bis [Uhrzeit] Uhr. Dann stehen dir neue Packs zur Verfügung.";
  settings.chatCommands.pack.cooldownMessage ||= "@userName, leider musst du noch [Restzeit] Sekunden warten, bis du diesen Befehl erneut ausführen darfst.";
  // The pack success message is now sent AFTER the animation, so it can name the drawn card.
  // Migrate the old "sold/opening" default (which no longer fits) to the new post-draw text.
  if (!settings.chatCommands.pack.successMessage
      || settings.chatCommands.pack.successMessage === "@userName, ein Booster wurde verkauft und wird gleich für dich geöffnet.") {
    settings.chatCommands.pack.successMessage = "@userName hat [Kartenname] aus [Boostername] gezogen.";
  }
  settings.chatCommands.collection ||= {};
  settings.chatCommands.collection.enabled = settings.chatCommands.collection.enabled !== false;
  settings.chatCommands.collection.prefix ||= "!";
  settings.chatCommands.collection.command ||= "collection";
  // Besides the overlay showcase, !collection can also list the caller's card names as chat
  // text (own toggle, on by default).
  settings.chatCommands.collection.chatOutputEnabled = settings.chatCommands.collection.chatOutputEnabled !== false;
  settings.chatCommands.collection.headerMessage ||= "@userName, deine Karten:";
  settings.chatCommands.collection.emptyMessage ||= "@userName, du besitzt noch keine Karten.";

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
  settings.chatCommands.trade.cardNotFoundMessage ||= "@userName, die Karte [falscherName] existiert nicht. Meintest du stattdessen [Kartenname]?";
  settings.chatCommands.trade.offerNotOwnedMessage ||= "@userName, du besitzt die Karte [Kartenname] nicht und kannst sie daher nicht anbieten.";
  settings.chatCommands.trade.userNotFoundMessage ||= "@userName, der Nutzer [Nutzer] wurde nicht gefunden.";
  settings.chatCommands.trade.offerMessage ||= "@userNameB, dir wird ein Tausch von @userNameA der Karte [Kartenname] aus der Sammlung [Boostername] angeboten. Nimm mit [BefehlAnnehmen] \"Kartenname\" an oder lehne mit [BefehlAblehnen] ab.";
  settings.chatCommands.trade.timeoutMessage ||= "@userNameA, leider hat @userNameB nicht rechtzeitig ([Zeit] Sekunden) geantwortet. Daher wurde die Tauschanfrage beendet.";
  settings.chatCommands.trade.cooldownMessage ||= "@userName, leider musst du mit der Tauschanfrage noch bis [Uhrzeit] warten, da der Cooldown von [Cooldownwert] [Einheit] noch aktiv ist.";
  settings.chatCommands.trade.limitMessage ||= "@userName, leider sind deine Tauschanfragen aktuell aufgebraucht. Bitte warte bis [Uhrzeit] Uhr.";
  settings.chatCommands.trade.busyMessage ||= "@userName, es wird bereits gerade getauscht. Bitte warte bis dieser Tausch abgeschlossen wurde.";

  settings.chatCommands.tradeyes ||= {};
  settings.chatCommands.tradeyes.enabled = settings.chatCommands.tradeyes.enabled !== false;
  settings.chatCommands.tradeyes.prefix ||= "!";
  settings.chatCommands.tradeyes.command ||= "tradeyes";
  settings.chatCommands.tradeyes.notOwnedMessage ||= "@userNameB, du besitzt diese Karte leider nicht. Bitte wähle eine andere.";
  settings.chatCommands.tradeyes.successMessage ||= "@userNameA tauschte seine Karte [KarteA] aus [BoosterA] erfolgreich mit @userNameB gegen Karte [KarteB] aus [BoosterB]. Damit hat @userNameA nun [AnzahlA] Karten [KarteB] und @userNameB [AnzahlB] Karten [KarteA].";

  settings.chatCommands.tradeno ||= {};
  settings.chatCommands.tradeno.enabled = settings.chatCommands.tradeno.enabled !== false;
  settings.chatCommands.tradeno.prefix ||= "!";
  settings.chatCommands.tradeno.command ||= "tradeno";
  settings.chatCommands.tradeno.declineMessage ||= "@userNameA, leider hat @userNameB deine Tauschanfrage abgelehnt, damit bleiben dir bis zum [Uhrzeit] noch [Anzahl] Tauschanfragen.";

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
  settings.chatCommands.battle.userNotFoundMessage ||= "@userName, der Nutzer [Nutzer] wurde nicht gefunden.";
  settings.chatCommands.battle.selfChallengeMessage ||= "@userName, du kannst nicht dich selbst herausfordern.";
  settings.chatCommands.battle.notEnoughCardsMessage ||= "@userName, für ein Kartenduell braucht ihr beide mindestens [Anzahl] verschiedene Karten.";
  settings.chatCommands.battle.offerMessage ||= "@userNameB, @userNameA fordert dich zum Kartenduell heraus! Nimm mit [BefehlAnnehmen] an oder lehne mit [BefehlAblehnen] ab.";
  settings.chatCommands.battle.timeoutMessage ||= "@userNameA, leider hat @userNameB nicht rechtzeitig ([Zeit] Sekunden) geantwortet. Daher wurde die Duellanfrage beendet.";
  settings.chatCommands.battle.cooldownMessage ||= "@userName, leider musst du mit der Kampfanfrage noch bis [Uhrzeit] warten, da der Cooldown von [Cooldownwert] [Einheit] noch aktiv ist.";
  settings.chatCommands.battle.limitMessage ||= "@userName, leider sind deine Kampfanfragen aktuell aufgebraucht. Bitte warte bis [Uhrzeit] Uhr.";
  settings.chatCommands.battle.busyMessage ||= "@userName, es läuft bereits ein Kartenduell. Bitte warte bis dieses abgeschlossen wurde.";

  settings.chatCommands.battleyes ||= {};
  settings.chatCommands.battleyes.enabled = settings.chatCommands.battleyes.enabled !== false;
  settings.chatCommands.battleyes.prefix ||= "!";
  settings.chatCommands.battleyes.command ||= "battleyes";
  settings.chatCommands.battleyes.resultMessage ||= "@userNameA gewinnt das Kartenduell gegen @userNameB ([SiegeA]:[SiegeB]) und erhält die Karte [GewonneneKarte]!";

  settings.chatCommands.battleno ||= {};
  settings.chatCommands.battleno.enabled = settings.chatCommands.battleno.enabled !== false;
  settings.chatCommands.battleno.prefix ||= "!";
  settings.chatCommands.battleno.command ||= "battleno";
  settings.chatCommands.battleno.declineMessage ||= "@userNameA, leider hat @userNameB deine Duellanfrage abgelehnt.";

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
    <article class="tcg-card${compact}" data-rarity="${escapeHtml(rarityAttr)}" style="--card-accent:${accent};--rarity-border:${escapeHtml(borderColor)}">
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
    <article class="booster-pack" style="--pack-accent:${booster.accent || "#ff78bb"}">
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
  collectionLabel: { de: "Sammlung", en: "Collection" }
};

export function overlayText(key, language) {
  const lang = language === "en" ? "en" : "de";
  return OVERLAY_STRINGS[key]?.[lang] ?? OVERLAY_STRINGS[key]?.de ?? key;
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
  }
  root.style.setProperty("--accent", style.accentColor || "#ff78bb");
  root.style.setProperty("--panel-text", style.panelTextColor || "#2f2945");
  root.style.setProperty("--font", style.fontFamily || "Inter, Arial, sans-serif");
  root.style.setProperty("--screen-x", `${clamp(style.screenX ?? 50, 0, 100)}vw`);
  root.style.setProperty("--screen-y", `${clamp(style.screenY ?? 52, 0, 100)}vh`);
  root.style.setProperty("--widget-scale", clamp(style.scale ?? 1, 0.45, 1.7));
}
