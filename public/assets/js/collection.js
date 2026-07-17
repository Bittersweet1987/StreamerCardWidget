// Asset version (BootId) propagated from this module's own URL (set by the page's bootstrap
// loader) into the shared-module imports below, so api.js/render.js are always fetched at the
// same version as this file - OBS/Meld can never mix a fresh page module with stale shared code.
const __v = new URL(import.meta.url).searchParams.get("v") || String(Date.now());
const { completeQueueItem, connectEventStream, getCollections, getSettings } = await import(`./api.js?v=${__v}`);
const { applyOverlayLayout, applyTheme, cardMarkup, cardsForBooster, normalizeSettings, overlayText, RARITIES } = await import(`./render.js?v=${__v}`);

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

// ---- Compact style: instead of one page-flipping panel per booster showing every card,
// group several boosters' summaries (owned/total per rarity, no per-card art) onto shared pages -
// much faster to read through since there's no card-by-card grid to flip through per booster.
const BOOSTERS_PER_PAGE = 3;

function summarizeBooster(booster, counts) {
  const cards = cardsForBooster(settings, booster);
  const byRarity = new Map();
  for (const card of cards) {
    const rarityId = card.rarity || "common";
    if (!byRarity.has(rarityId)) byRarity.set(rarityId, { total: 0, owned: 0 });
    const bucket = byRarity.get(rarityId);
    bucket.total += 1;
    if (Number(counts[card.id] || 0) > 0) bucket.owned += 1;
  }
  const ownedUnique = cards.filter((card) => Number(counts[card.id] || 0) > 0).length;
  return { booster, byRarity, ownedUnique, total: cards.length };
}

function compactHeaderMarkup(user, overallOwned, overallTotal, pageIndex, pageCount) {
  const pageSuffix = pageCount > 1 ? ` · ${pageIndex + 1}/${pageCount}` : "";
  return `
    <header class="showcase-head">
      <span class="showcase-user">${escapeForOverlay(user)}</span>
      <strong class="showcase-booster-title">${escapeForOverlay(overlayText("collectionLabel", settings.language))}</strong>
      <span class="showcase-progress">${overallOwned} / ${overallTotal}${pageSuffix}</span>
    </header>
  `;
}

function compactGridMarkup(boosterPage) {
  const cards = boosterPage.map(({ booster, byRarity, ownedUnique, total }) => {
    const rows = RARITIES
      .filter((rarity) => byRarity.has(rarity.id))
      .map((rarity) => {
        const bucket = byRarity.get(rarity.id);
        return `
          <div class="compact-rarity-row">
            <span class="compact-rarity-label">${escapeForOverlay(rarity.label)}</span>
            <span class="compact-rarity-count">${bucket.owned} / ${bucket.total}</span>
          </div>
        `;
      }).join("");
    return `
      <article class="compact-booster-card" style="--pack-accent:${booster.accent || "#ff78bb"}">
        <header class="compact-booster-head">
          <strong>${escapeForOverlay(booster.title || "Booster")}</strong>
          <span>${ownedUnique} / ${total}</span>
        </header>
        <div class="compact-rarity-list">${rows}</div>
      </article>
    `;
  }).join("");
  // Pad a partial last page so the layout doesn't jump between page-flips.
  const padding = Math.max(0, BOOSTERS_PER_PAGE - boosterPage.length);
  return cards + `<div class="compact-booster-card compact-booster-card-empty"></div>`.repeat(padding);
}

async function runCompactShowcase(request = {}) {
  const boosters = activeBoosters();
  if (!boosters.length) return;
  const user = request.user || request.displayName || "Viewer";
  const login = request.userLogin || request.login || user;
  const collections = await getCollections();
  const secondsPerPage = Math.max(2, Number(settings.showcase?.secondsPerBooster || 12));

  let overallOwned = 0;
  let overallTotal = 0;
  const summaries = boosters.map((booster) => {
    const counts = countsFor(collections?.[booster.id] || {}, user, login);
    const summary = summarizeBooster(booster, counts);
    overallOwned += summary.ownedUnique;
    overallTotal += summary.total;
    return summary;
  });
  const pages = chunk(summaries, BOOSTERS_PER_PAGE);

  const panel = document.createElement("section");
  panel.className = "showcase-panel showcase-panel-compact";
  panel.innerHTML = `${compactHeaderMarkup(user, overallOwned, overallTotal, 0, pages.length)}<div class="showcase-compact-grid">${compactGridMarkup(pages[0])}</div>`;
  stage.append(panel);

  requestAnimationFrame(() => panel.classList.add("is-in"));

  for (let p = 0; p < pages.length; p++) {
    if (p > 0) {
      const grid = panel.querySelector(".showcase-compact-grid");
      const progress = panel.querySelector(".showcase-progress");
      grid.classList.add("is-flipping");
      await delay(260);
      grid.innerHTML = compactGridMarkup(pages[p]);
      if (progress) progress.textContent = `${overallOwned} / ${overallTotal} · ${p + 1}/${pages.length}`;
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

async function runShowcase(request = {}) {
  if (settings.showcase?.style === "compact") {
    await runCompactShowcase(request);
    return;
  }
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
  applyOverlayLayout(stage, settings.overlayLayout?.collection, "collection");
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
