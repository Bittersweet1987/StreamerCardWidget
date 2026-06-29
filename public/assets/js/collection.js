import { completeQueueItem, connectEventStream, getCollections, getSettings } from "./api.js";
import { applyTheme, cardMarkup, cardsForBooster, normalizeSettings, overlayText } from "./render.js";

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

function panelMarkup(booster, counts, user) {
  const cards = cardsForBooster(settings, booster).slice(0, 9);
  const owned = cards.filter((card) => Number(counts[card.id] || 0) > 0).length;
  const slots = cards.map((card) => {
    const count = Number(counts[card.id] || 0);
    return `
      <div class="showcase-slot ${count > 0 ? "is-owned" : "is-missing"}">
        ${cardMarkup(card, { compact: true, hidden: count <= 0 })}
        ${count > 0 ? `<span class="count-bubble">x${count}</span>` : ""}
      </div>
    `;
  }).join("");
  return `
    <header class="showcase-head">
      <span class="showcase-user">${escapeForOverlay(user)}</span>
      <strong class="showcase-booster-title">${escapeForOverlay(booster.title || "Booster")}</strong>
      <span class="showcase-progress">${owned} / ${cards.length}</span>
    </header>
    <div class="showcase-grid">${slots}</div>
  `;
}

async function runShowcase(request = {}) {
  const boosters = activeBoosters();
  if (!boosters.length) return;
  const user = request.user || request.displayName || "Viewer";
  const login = request.userLogin || request.login || user;
  const collections = await getCollections();
  const seconds = Math.max(2, Number(settings.showcase?.secondsPerBooster || 12));

  for (let i = 0; i < boosters.length; i++) {
    const booster = boosters[i];
    const counts = countsFor(collections?.[booster.id] || {}, user, login);
    const panel = document.createElement("section");
    panel.className = "showcase-panel";
    panel.style.setProperty("--pack-accent", booster.accent || "#ff78bb");
    panel.innerHTML = panelMarkup(booster, counts, user);
    stage.append(panel);

    // Slide in from the right.
    requestAnimationFrame(() => panel.classList.add("is-in"));
    await delay(seconds * 1000);

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
