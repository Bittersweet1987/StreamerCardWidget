// Asset version (BootId) propagated from this module's own URL (set by the page's bootstrap
// loader) into the shared-module imports below, so api.js/render.js are always fetched at the
// same version as this file - OBS/Meld can never mix a fresh page module with stale shared code.
const __v = new URL(import.meta.url).searchParams.get("v") || String(Date.now());
const { completeQueueItem, connectEventStream, getCollections, getSettings } = await import(`./api.js?v=${__v}`);
const { applyOverlayLayout, applyTheme, cardMarkup, cardsForBooster, normalizeSettings, RARITIES } = await import(`./render.js?v=${__v}`);

const stage = document.querySelector("#showpack-stage");
const status = document.querySelector("#showpack-status");

let settings;
let queue = [];
let running = false;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function setStatus(text, show = false) {
  if (!status) return;
  status.textContent = text;
  status.hidden = !show;
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function userKey(value) {
  return normalize(value || "viewer") || "viewer";
}

function countsFor(collection, user, login) {
  const data = collection?.users?.[userKey(login || user)] || collection?.users?.[userKey(user)] || {};
  return data.cards || {};
}

function sortByRarity(cards) {
  const rank = new Map(RARITIES.map((rarity, index) => [rarity.id, index]));
  return [...cards].sort((a, b) => (rank.get(a.rarity) ?? RARITIES.length) - (rank.get(b.rarity) ?? RARITIES.length));
}

// Unlike !collection's showcase (9 cards per page, cycles through every booster), !show
// <Packtitel> targets exactly one named pack and shows 25 cards per page (5x5 grid) - see the
// matching CARDS_PER_PAGE = 25 in ComputeQueueTimeoutMs's "showpack" case server-side.
const CARDS_PER_PAGE = 25;

function chunk(array, size) {
  const pages = [];
  for (let i = 0; i < array.length; i += size) pages.push(array.slice(i, i + size));
  return pages.length ? pages : [[]];
}

function headerMarkup(boosterTitle, owned, total, user, pageIndex, pageCount) {
  const pageSuffix = pageCount > 1 ? ` · ${pageIndex + 1}/${pageCount}` : "";
  return `
    <header class="showpack-head">
      <span class="showpack-user">${escapeForOverlay(user)}</span>
      <strong class="showpack-booster-title">${escapeForOverlay(boosterTitle || "Booster")}</strong>
      <span class="showpack-progress">${owned} / ${total}${pageSuffix}</span>
    </header>
  `;
}

function gridMarkup(cards, counts) {
  const slots = cards.map((card) => {
    const count = Number(counts[card.id] || 0);
    return `
      <div class="showpack-slot ${count > 0 ? "is-owned" : "is-missing"}">
        ${cardMarkup(card, { compact: true, hidden: count <= 0 })}
        ${count > 0 ? `<span class="count-bubble">x${count}</span>` : ""}
      </div>
    `;
  }).join("");
  // Pad a partial last page with empty slots so the grid keeps a stable 5x5 size across
  // page-flips instead of shrinking/jumping when the final page has fewer cards.
  const padding = Math.max(0, CARDS_PER_PAGE - cards.length);
  return slots + `<div class="showpack-slot showpack-slot-empty"></div>`.repeat(padding);
}

async function runShowPack(request = {}) {
  const boosterId = request.boosterId || "";
  const boosterTitle = request.boosterTitle || "Booster";
  const booster = (settings.boosters || []).find((b) => b.id === boosterId);
  if (!booster) return;
  const user = request.user || request.displayName || "Viewer";
  const login = request.userLogin || request.login || user;
  const collections = await getCollections();
  const secondsPerPage = Math.max(2, Number(settings.showcase?.secondsPerBooster || 12));

  const counts = countsFor(collections?.[boosterId] || {}, user, login);
  const cards = sortByRarity(cardsForBooster(settings, booster));
  const owned = cards.filter((card) => Number(counts[card.id] || 0) > 0).length;
  const pages = chunk(cards, CARDS_PER_PAGE);

  const panel = document.createElement("section");
  panel.className = "showpack-panel";
  panel.style.setProperty("--pack-accent", booster.accent || "#ff78bb");
  panel.innerHTML = `${headerMarkup(boosterTitle, owned, cards.length, user, 0, pages.length)}<div class="showpack-grid">${gridMarkup(pages[0], counts)}</div>`;
  stage.append(panel);

  requestAnimationFrame(() => panel.classList.add("is-in"));

  for (let p = 0; p < pages.length; p++) {
    if (p > 0) {
      const grid = panel.querySelector(".showpack-grid");
      const progress = panel.querySelector(".showpack-progress");
      grid.classList.add("is-flipping");
      await delay(260);
      grid.innerHTML = gridMarkup(pages[p], counts);
      if (progress) progress.textContent = `${owned} / ${cards.length} · ${p + 1}/${pages.length}`;
      await new Promise(requestAnimationFrame);
      grid.classList.remove("is-flipping");
    }
    await delay(secondsPerPage * 1000);
  }

  panel.classList.remove("is-in");
  panel.classList.add("is-out");
  await delay(620);
  panel.remove();
}

function enqueueShowPack(request = {}) {
  queue.push(request);
  if (!running) runQueue();
}

async function runQueue() {
  running = true;
  while (queue.length) {
    const request = queue.shift();
    try {
      await runShowPack(request);
    } finally {
      completeQueueItem(request.eventId);
    }
    await delay(400);
  }
  running = false;
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
  applyOverlayLayout(stage, settings.overlayLayout?.showPack, "showPack");
  document.body.classList.toggle("hide-borders", settings.style?.cardBorders === false);
}

function bindServerEvents() {
  connectEventStream({
    showpack: (event) => enqueueShowPack(event),
    settings: () => loadSettings(),
    collections: () => {},
    draw: () => {}
  });
}

function bindDebugHooks() {
  window.showPackOverlay = { show: enqueueShowPack, reload: loadSettings };
  const params = new URLSearchParams(window.location.search);
  if (params.get("demo") === "1") {
    setTimeout(() => enqueueShowPack({ user: params.get("user") || "Viewer", boosterId: params.get("boosterId") || "", boosterTitle: params.get("boosterTitle") || "Demo-Pack" }), 600);
  }
}

async function init() {
  await loadSettings();
  bindServerEvents();
  bindDebugHooks();
}

init().catch((error) => setStatus(error.message, true));
