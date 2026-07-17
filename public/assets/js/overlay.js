// Asset version (BootId) propagated from this module's own URL (set by the page's bootstrap
// loader) into the shared-module imports below, so api.js/render.js are always fetched at the
// same version as this file - OBS/Meld can never mix a fresh page module with stale shared code.
const __v = new URL(import.meta.url).searchParams.get("v") || String(Date.now());
const { addLog, announceDraw, completeQueueItem, connectEventStream, getCollections, getSettings, persistCollectionSnapshot } = await import(`./api.js?v=${__v}`);
const { applyOverlayLayout, applyTheme, cardMarkup, cardsForBooster, normalizeSettings, overlayText, RARITIES, weightedBoosterPick, weightedPick } = await import(`./render.js?v=${__v}`);

const stage = document.querySelector("#stage");
const status = document.querySelector("#status");

let settings;
let queue = [];
let running = false;
let audioContext;
let recentEvents = new Map();

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setStatus(text, show = false) {
  status.textContent = text;
  status.hidden = !show;
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function userKey(value) {
  return normalize(value || "viewer") || "viewer";
}

function eligibleBoosters(boosters = settings.boosters) {
  return boosters.filter((booster) => cardsForBooster(settings, booster).some((card) => card.enabled !== false));
}

function pickBooster(id) {
  if (id) return settings.boosters.find((booster) => booster.id === id) || null;
  return weightedBoosterPick(eligibleBoosters()) || settings.boosters[0] || null;
}

function eventKey(request, boosterId) {
  // Twitch can redeliver the same EventSub notification more than once. eventId alone is
  // already a globally unique identifier for that redemption, so it must NOT be combined
  // with boosterId here: boosterId is picked freshly (random, weighted by score) on every
  // enqueueDraw() call, so two deliveries of the same redemption can resolve to different
  // boosters and produce different keys, defeating de-duplication and opening two cards.
  if (request?.eventId) return `event:${request.eventId}`;
  return `${boosterId}:${request?.userLogin || request?.user || "viewer"}:${request?.createdAt || Date.now()}`;
}

function isDuplicate(key) {
  const now = Date.now();
  for (const [stored, time] of [...recentEvents.entries()]) {
    if (now - time > 30000) recentEvents.delete(stored);
  }
  if (recentEvents.has(key)) return true;
  recentEvents.set(key, now);
  return false;
}

function playSound(kind = "open") {
  const volume = Number(settings?.style?.volume || 0) / 100;
  if (volume <= 0) return;
  const uploaded = settings?.sounds?.[kind];
  if (uploaded) {
    const audio = new Audio(uploaded);
    audio.volume = Math.min(1, Math.max(0, volume));
    audio.play().catch(() => {});
    return;
  }
  audioContext ||= new AudioContext();
  const now = audioContext.currentTime;
  const gain = audioContext.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.12 * volume, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);
  gain.connect(audioContext.destination);
  const tones = kind === "reveal" ? [523.25, 659.25, 783.99] : [220, 330];
  tones.forEach((freq, index) => {
    const osc = audioContext.createOscillator();
    osc.type = index % 2 ? "triangle" : "sine";
    osc.frequency.setValueAtTime(freq, now + index * 0.06);
    osc.connect(gain);
    osc.start(now + index * 0.06);
    osc.stop(now + 0.44 + index * 0.04);
  });
}

function normalizeCollection(value, booster) {
  let data = value;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      data = {};
    }
  }
  if (!data || typeof data !== "object") data = {};
  data.version ||= 1;
  data.boosterId ||= booster.id;
  data.users ||= {};
  return data;
}

async function readCollection(booster) {
  const collections = await getCollections();
  return normalizeCollection(collections?.[booster.id] || {}, booster);
}

function incrementCollection(collection, user, login, cardId) {
  const key = userKey(login || user);
  collection.users[key] ||= { displayName: user, cards: {} };
  collection.users[key].displayName = user;
  collection.users[key].cards ||= {};
  collection.users[key].cards[cardId] = Number(collection.users[key].cards[cardId] || 0) + 1;
  return collection;
}

function collectionCounts(collection, user, login) {
  const userData = collection?.users?.[userKey(login || user)] || collection?.users?.[userKey(user)] || {};
  return userData.cards || {};
}

function createRaritySummary(booster, collection, user, login) {
  if (settings.style?.showCollection === false) return "";
  const cards = cardsForBooster(settings, booster);
  const counts = collectionCounts(collection, user, login);
  const rows = RARITIES.map((rarity) => {
    const rarityCards = cards.filter((card) => (card.rarity || "common") === rarity.id);
    if (!rarityCards.length) return null;
    const owned = rarityCards.filter((card) => Number(counts[card.id] || 0) > 0).length;
    return { label: rarity.label, owned, total: rarityCards.length };
  }).filter(Boolean);
  if (!rows.length) return "";
  return `
    <div class="rarity-summary">
      <span class="collection-label">${overlayText("collectionLabel", settings.language)}</span>
      ${rows.map((row) => `
        <div class="rarity-summary-row">
          <span class="rarity-summary-count">${row.owned}/${row.total}</span>
          <span class="rarity-summary-label">${escapeForOverlay(row.label)}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function pickCard(booster, request = {}) {
  const cards = cardsForBooster(settings, booster);
  if (request.cardId) {
    const forced = cards.find((card) => card.id === request.cardId);
    if (forced) return forced;
  }
  return weightedPick(cards);
}

function enqueueDraw(request = {}) {
  const booster = pickBooster(request.boosterId);
  // If we won't play this event (no booster available, or it's a duplicate redelivery), the
  // server's queue must still be released so it doesn't stall waiting for a completion ack.
  if (!booster) {
    completeQueueItem(request.eventId);
    return;
  }
  const key = eventKey(request, booster.id);
  if (isDuplicate(key)) {
    completeQueueItem(request.eventId);
    return;
  }
  queue.push({ ...request, boosterId: booster.id });
  if (!running) runQueue();
}

async function runQueue() {
  running = true;
  while (queue.length) {
    const request = queue.shift();
    try {
      await runOpening(request);
    } finally {
      // Tell the server this event has finished playing (so it can proceed after its 500ms gap)
      // and report the drawn card/booster so the post-animation chat message can name them.
      completeQueueItem(request.eventId, request.drawnCardTitle, request.drawnBoosterTitle);
    }
    await delay(Number(settings.behavior?.cooldownSeconds || 0.8) * 1000);
  }
  running = false;
}

async function runOpening(request = {}) {
  const booster = pickBooster(request.boosterId);
  const card = booster ? pickCard(booster, request) : null;
  if (!booster || !card) return;
  request.drawnCardTitle = card.title || card.id || "";
  request.drawnBoosterTitle = booster.title || booster.id || "";

  const user = request.user || request.displayName || "Viewer";
  const login = request.userLogin || request.login || user;
  const collection = await readCollection(booster);
  const countBefore = Number(collectionCounts(collection, user, login)[card.id] || 0);
  incrementCollection(collection, user, login, card.id);
  const countAfter = countBefore + 1;
  if (settings.behavior?.persistCollections !== false) {
    await persistCollectionSnapshot(collection, booster.id, "");
  }
  // The server now logs the draw (it picks the card), so no duplicate log entry from here.

  const scene = document.createElement("section");
  const namePos = ["bottom", "top"].includes(settings.style?.namePosition) ? settings.style.namePosition : "bottom";
  scene.className = `opening-scene name-${namePos}`;
  scene.innerHTML = `
    <div class="draw-copy"><span>${escapeForOverlay(user)}</span></div>
    <div class="opening-rig" style="--pack-accent:${booster.accent || "#ff78bb"}">
      <div class="pack-shadow" aria-hidden="true"></div>
      <div class="card-wrap">
        ${cardMarkup(card)}
        <div class="draw-count-bubble"><span class="draw-count-value">${countBefore}</span></div>
      </div>
      <div class="pack-bottom">${packFace(booster)}</div>
      <div class="pack-top">${packFace(booster)}</div>
    </div>
    ${createRaritySummary(booster, collection, user, login)}
  `;

  stage.append(scene);
  requestAnimationFrame(() => scene.classList.add("phase-enter"));
  playSound("open");
  await delay(520);
  // Build anticipation: wobble the still-closed pack once per configured face-down card
  // before it tears open. More backs = longer build-up; 0 = tear open immediately.
  const backs = Math.max(0, Math.min(8, Math.round(Number(settings.behavior?.cardBacksBeforeReveal ?? 2))));
  const rig = scene.querySelector(".opening-rig");
  for (let i = 0; i < backs; i++) {
    rig?.classList.add("is-anticipating");
    await delay(240);
    rig?.classList.remove("is-anticipating");
    await delay(90);
  }
  scene.classList.add("phase-tear");
  await delay(1050);
  scene.classList.add("phase-slide");
  playSound("reveal");
  await delay(2450);
  scene.classList.add("phase-reveal");
  // The card (and its collection panel to the right) is now fully visible - this is the moment
  // the post-draw chat message and live-ticker entry should go out, not several seconds later
  // once the whole animation finishes.
  announceDraw(request.eventId, request.drawnCardTitle, request.drawnBoosterTitle);
  // A beat after the card is fully visible, count up from the pre-draw total to the new one.
  await delay(350);
  const bubble = scene.querySelector(".draw-count-bubble");
  const bubbleValue = scene.querySelector(".draw-count-value");
  if (bubble && bubbleValue && countAfter !== countBefore) {
    bubble.classList.add("is-counting");
    bubbleValue.textContent = countAfter;
    await delay(420);
    bubble.classList.remove("is-counting");
  }
  await delay(Math.max(0, Number(settings.behavior?.revealSeconds || 3.2) * 1000 - 350 - 420));
  scene.classList.add("phase-exit");
  await delay(700);
  scene.remove();
}

function packFace(booster) {
  const image = booster.image
    ? `<img src="${escapeForOverlay(booster.image)}" alt="">`
    : `<div class="fallback-booster">${escapeForOverlay(booster.title || "Pack")}</div>`;
  return `
    <div class="opening-pack-face">
      <div class="pack-body">${image}</div>
      <div class="pack-label"><strong>${escapeForOverlay(booster.title || "Cards")}</strong><span>${escapeForOverlay(booster.subtitle || "Pack")}</span></div>
    </div>
  `;
}

function escapeForOverlay(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function loadSettings() {
  settings = normalizeSettings(await getSettings());
  applyTheme(settings);
  applyOverlayLayout(stage, settings.overlayLayout?.draw, "draw");
  document.body.classList.toggle("hide-borders", settings.style?.cardBorders === false);
}

function bindServerEvents() {
  connectEventStream({
    // The receipt log makes "event arrived but animation died" distinguishable from "event
    // never arrived" when diagnosing a silent OBS browser source via the Log tab.
    draw: (event) => {
      addLog("overlay", "info", "Draw-Event empfangen (eventId=" + (event.eventId || "?") + ")");
      enqueueDraw(event);
    },
    settings: () => loadSettings(),
    collections: () => {}
  });
}

function bindDebugHooks() {
  window.cardPackWidget = {
    draw: enqueueDraw,
    reload: loadSettings
  };
  const params = new URLSearchParams(window.location.search);
  if (params.get("demo") === "1") {
    setTimeout(() => enqueueDraw({
      eventId: `demo:${params.get("user") || "Viewer"}:${params.get("booster") || ""}`,
      user: params.get("user") || "Viewer",
      boosterId: params.get("booster") || "",
      source: "demo"
    }), 700);
  }
}

async function init() {
  await loadSettings();
  bindServerEvents();
  bindDebugHooks();
}

init().catch((error) => {
  setStatus(error.message, true);
});
