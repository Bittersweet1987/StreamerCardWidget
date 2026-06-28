export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

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
  settings.twitch ||= {};
  settings.twitch.clientId ||= "klgyxuiixy0mfo7ze7goubj5j16g7u";
  settings.style ||= {};
  settings.style.themeMode ||= "light";
  settings.style.namePosition = ["bottom", "middle", "top"].includes(settings.style.namePosition) ? settings.style.namePosition : "bottom";
  settings.sounds ||= {};
  settings.sounds.open ||= "";
  settings.sounds.reveal ||= "";
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

  // Collection showcase: a dedicated channel-point reward that, when redeemed, slides through
  // every active booster showing the redeemer's owned + still-unknown cards in its own OBS source.
  settings.showcase ||= {};
  settings.showcase.enabled = settings.showcase.enabled === true;
  settings.showcase.secondsPerBooster = Number(settings.showcase.secondsPerBooster) > 0 ? Number(settings.showcase.secondsPerBooster) : 12;
  settings.showcase.sourceName ||= "Streamer Card Sammlung";
  settings.showcase.rewardName ||= "Sammlung zeigen";
  settings.showcase.rewardCost = Number(settings.showcase.rewardCost || 500);
  settings.showcase.rewardIds ||= [];
  settings.showcase.rewardBackgroundColor ||= "#9147ff";
  settings.showcase.rewardGlobalCooldown = Number(settings.showcase.rewardGlobalCooldown || 0);

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
      cardIds: settings.deck.cards.slice(0, 9).map((card) => card.id)
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
    booster.cardIds = (booster.cardIds || []).slice(0, 9);
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
  const ids = new Set((booster?.cardIds || []).slice(0, 9));
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

export function applyTheme(settings) {
  const style = settings.style || {};
  const root = document.documentElement;
  if (document.body) document.body.dataset.theme = style.themeMode || "light";
  root.style.setProperty("--accent", style.accentColor || "#ff78bb");
  root.style.setProperty("--panel-text", style.panelTextColor || "#2f2945");
  root.style.setProperty("--font", style.fontFamily || "Inter, Arial, sans-serif");
  root.style.setProperty("--screen-x", `${clamp(style.screenX ?? 50, 0, 100)}vw`);
  root.style.setProperty("--screen-y", `${clamp(style.screenY ?? 52, 0, 100)}vh`);
  root.style.setProperty("--widget-scale", clamp(style.scale ?? 1, 0.45, 1.7));
}
