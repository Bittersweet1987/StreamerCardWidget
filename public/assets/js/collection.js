import { completeQueueItem, connectEventStream, getCollections, getSettings } from "./api.js";
import { applyTheme, cardMarkup, cardsForBooster, normalizeSettings, overlayText, RARITIES } from "./render.js";

const stage = document.querySelector("#showcase-stage");
const status = document.querySelector("#status");

let settings;
let queue = [];
let running = false;

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

function activeBoosters() {
  return (settings.boosters || []).filter((booster) =>
    cardsForBooster(settings, booster).some((card) => card.enabled !== false));
}

function countsFor(collection, user, login) {
  const data = collection?.users?.[userKey(login || user)] || collection?.users?.[userKey(user)] || {};
  return data.cards || {};
}

function sortByRarity(cards) {
  const rank = new Map(RARITIES.map((rarity, index) => [rarity.id, index]));
  return [...cards].sort((a, b) => (rank.get(a.rarity) ?? RARITIES.length) - (rank.get(b.rarity) ?? RARITIES.length));
}

// The overlay can't be scrolled (it's a passive OBS/Meld source, not interactive), so a booster
// with more cards than fit on one page "flips" through pages instead - like turning a book page.
const CARDS_PER_PAGE = 9;

function chunk(array, size) {
  const pages = [];
  for (let i = 0; i < array.length; i += size) pages.push(array.slice(i, i + size));
  return pages.length ? pages : [[]];
}

function headerMarkup(booster, owned, total, user, pageIndex, pageCount) {
  const pageSuffix = pageCount > 1 ? ` · ${pageIndex + 1}/${pageCount}` : "";
  return `
    <header class="showcase-head">
      <span class="showcase-user">${escapeForOverlay(user)}</span>
      <strong class="showcase-booster-title">${escapeForOverlay(booster.title || "Booster")}</strong>
      <span class="showcase-progress">${owned} / ${total}${pageSuffix}</span>
    </header>
  `;
}

function gridMarkup(cards, counts) {
  const slots = cards.map((card) => {
    const count = Number(counts[card.id] || 0);
    return `
      <div class="showcase-slot ${count > 0 ? "is-owned" : "is-missing"}">
        ${cardMarkup(card, { compact: true, hidden: count <= 0 })}
        ${count > 0 ? `<span class="count-bubble">x${count}</span>` : ""}
      </div>
    `;
  }).join("");
  // Pad a partial last page with empty slots so the grid keeps a stable 3x3 size across
  // page-flips instead of shrinking/jumping when the final page has fewer cards.
  const padding = Math.max(0, CARDS_PER_PAGE - cards.length);
  return slots + `<div class="showcase-slot showcase-slot-empty"></div>`.repeat(padding);
}

async function runShowcase(request = {}) {
  const boosters = activeBoosters();
  if (!boosters.length) return;
  const user = request.user || request.displayName || "Viewer";
  const login = request.userLogin || request.login || user;
  const collections = await getCollections();
  // Seconds per page (not per booster) - a booster with several pages simply takes
  // proportionally longer in total, one page-flip at a time.
  const secondsPerPage = Math.max(2, Number(settings.showcase?.secondsPerBooster || 12));

  for (let i = 0; i < boosters.length; i++) {
    const booster = boosters[i];
    const counts = countsFor(collections?.[booster.id] || {}, user, login);
    const cards = sortByRarity(cardsForBooster(settings, booster));
    const owned = cards.filter((card) => Number(counts[card.id] || 0) > 0).length;
    const pages = chunk(cards, CARDS_PER_PAGE);

    const panel = document.createElement("section");
    panel.className = "showcase-panel";
    panel.style.setProperty("--pack-accent", booster.accent || "#ff78bb");
    panel.innerHTML = `${headerMarkup(booster, owned, cards.length, user, 0, pages.length)}<div class="showcase-grid">${gridMarkup(pages[0], counts)}</div>`;
    stage.append(panel);

    // Slide in from the right.
    requestAnimationFrame(() => panel.classList.add("is-in"));

    for (let p = 0; p < pages.length; p++) {
      if (p > 0) {
        const grid = panel.querySelector(".showcase-grid");
        const progress = panel.querySelector(".showcase-progress");
        grid.classList.add("is-flipping");
        await delay(260);
        grid.innerHTML = gridMarkup(pages[p], counts);
        if (progress) progress.textContent = `${owned} / ${cards.length} · ${p + 1}/${pages.length}`;
        // Let the browser paint the new content while still faded out, otherwise the
        // fade-back-in transition below can get coalesced away with the class add above.
        await new Promise(requestAnimationFrame);
        grid.classList.remove("is-flipping");
      }
      await delay(secondsPerPage * 1000);
    }

    // Slide out to the left (the next panel slides in over this same gap).
    panel.classList.remove("is-in");
    panel.classList.add("is-out");
    await delay(620);
    panel.remove();
  }
}

function enqueueShowcase(request = {}) {
  queue.push(request);
  if (!running) runQueue();
}

async function runQueue() {
  running = true;
  while (queue.length) {
    const request = queue.shift();
    try {
      await runShowcase(request);
    } finally {
      // Release the server queue once the whole showcase slideshow has played out.
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
  document.body.classList.toggle("hide-borders", settings.style?.cardBorders === false);
  // Keep the collection label string referenced for parity with the main overlay.
  void overlayText("collectionLabel", settings.language);
}

function bindServerEvents() {
  connectEventStream({
    showcollection: (event) => enqueueShowcase(event),
    settings: () => loadSettings(),
    collections: () => {},
    draw: () => {}
  });
}

function bindDebugHooks() {
  window.cardCollectionShowcase = { show: enqueueShowcase, reload: loadSettings };
  const params = new URLSearchParams(window.location.search);
  if (params.get("demo") === "1") {
    setTimeout(() => enqueueShowcase({ user: params.get("user") || "Viewer", source: "demo" }), 600);
  }
}

async function init() {
  await loadSettings();
  bindServerEvents();
  bindDebugHooks();
}

init().catch((error) => setStatus(error.message, true));
