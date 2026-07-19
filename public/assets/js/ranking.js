// Asset version (BootId) propagated from this module's own URL (set by the page's bootstrap
// loader) into the shared-module imports below, so api.js/render.js are always fetched at the
// same version as this file - OBS/Meld can never mix a fresh page module with stale shared code.
const __v = new URL(import.meta.url).searchParams.get("v") || String(Date.now());
const { addLog, completeQueueItem, connectEventStream, getSettings } = await import(`./api.js?v=${__v}`);
const { applyOverlayLayout, applyTheme, cardMarkup, normalizeSettings } = await import(`./render.js?v=${__v}`);

const stage = document.querySelector("#ranking-stage");
const status = document.querySelector("#status");

let settings;
let queue = [];
let running = false;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MEDALS = ["🥇", "🥈", "🥉", "4.", "5."];

function setStatus(text, show = false) {
  status.textContent = text;
  status.hidden = !show;
}

function escapeForOverlay(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function findCard(cardId) {
  return (settings.deck?.cards || []).find((card) => card.id === cardId) || null;
}

function phaseTitles() {
  const en = settings?.language === "en";
  return {
    fights: en ? "Most fights" : "Meiste Kämpfe",
    wins: en ? "Most wins" : "Meiste Siege",
    losses: en ? "Most defeats" : "Meiste Niederlagen",
    ratio: en ? "Best win/loss ratio" : "Beste Siegquote"
  };
}

function enqueueRanking(event = {}) {
  queue.push(event);
  if (!running) runQueue();
}

async function runQueue() {
  running = true;
  while (queue.length) {
    const event = queue.shift();
    try {
      if (event.type === "battle") await playBattleRanking(event);
      else if (event.type === "trade") await playTradeRanking(event);
      else if (event.type === "tournament") await playTournamentRanking(event);
      else if (event.type === "teamkampf") await playTeamKampfRanking(event);
      else await playCardRanking(event);
    } catch (error) {
      addLog("ranking", "error", `Ranking-Anzeige fehlgeschlagen: ${error.message}`);
    }
    await delay(400);
  }
  running = false;
}

function listMarkup(entries, valueSuffix = "") {
  const rows = (entries || []).slice(0, 5).map((entry, index) => `
    <li class="ranking-row" style="--row-index:${index}">
      <span class="ranking-medal">${MEDALS[index] || `${index + 1}.`}</span>
      <span class="ranking-user">${escapeForOverlay(entry.user)}</span>
      <span class="ranking-value">${escapeForOverlay(String(entry.value ?? entry.count ?? ""))}${valueSuffix}</span>
    </li>
  `).join("");
  return `<ol class="ranking-list">${rows}</ol>`;
}

async function playCardRanking(event) {
  const card = findCard(event.cardId);
  const owners = Array.isArray(event.owners) ? event.owners : [];
  if (!owners.length) { completeQueueItem(event.eventId); return; } // nobody owns the card yet
  const seconds = Math.max(2, Number(event.displaySeconds) || 8);

  const scene = document.createElement("div");
  scene.className = "ranking-scene is-card";
  scene.innerHTML = `
    <div class="ranking-card-pane">${card ? cardMarkup(card) : `<div class="ranking-card-fallback">${escapeForOverlay(event.cardTitle || "?")}</div>`}</div>
    <div class="ranking-list-pane">
      <div class="ranking-heading">
        <span class="ranking-eyebrow">${settings?.language === "en" ? "Top owners" : "Top-Besitzer"}</span>
        <h2>${escapeForOverlay(event.cardTitle || "")}</h2>
      </div>
      ${listMarkup(owners, "×")}
    </div>
  `;
  stage.append(scene);
  await delay(seconds * 1000);
  scene.classList.add("is-out");
  await delay(450);
  scene.remove();
  completeQueueItem(event.eventId);
}

async function playTradeRanking(event) {
  const entries = Array.isArray(event.entries) ? event.entries : [];
  if (!entries.length) { completeQueueItem(event.eventId); return; } // no completed trades yet
  const seconds = Math.max(2, Number(event.displaySeconds) || 8);

  const scene = document.createElement("div");
  scene.className = "ranking-scene is-trade";
  scene.innerHTML = `
    <div class="ranking-list-pane">
      <div class="ranking-heading">
        <span class="ranking-eyebrow">${settings?.language === "en" ? "Trade ranking" : "Tausch-Ranking"}</span>
        <h2>${settings?.language === "en" ? "Most trades" : "Meiste Tausche"}</h2>
      </div>
      ${listMarkup(entries)}
    </div>
  `;
  stage.append(scene);
  await delay(seconds * 1000);
  scene.classList.add("is-out");
  await delay(450);
  scene.remove();
  completeQueueItem(event.eventId);
}

function tournamentPhaseTitles() {
  const en = settings?.language === "en";
  return {
    wins: en ? "Most tournament wins" : "Meiste Turniersiege",
    participations: en ? "Most tournament participations" : "Meiste Turnierteilnahmen"
  };
}

function teamKampfPhaseTitles() {
  const en = settings?.language === "en";
  return {
    participations: en ? "Most Team Battle participations" : "Meiste Team-Kampf-Teilnahmen",
    wins: en ? "Most Team Battle wins" : "Meiste Team-Kampf-Siege",
    losses: en ? "Most Team Battle defeats" : "Meiste Team-Kampf-Niederlagen"
  };
}

async function playTournamentRanking(event) {
  const lists = event.lists || {};
  const seconds = Math.max(2, Number(event.displaySeconds) || 8);
  const titles = tournamentPhaseTitles();
  const phases = ["participations", "wins"]
    .map((key) => ({ key, title: titles[key], entries: lists[key] || [] }))
    .filter((phase) => phase.entries.length > 0);
  if (!phases.length) { completeQueueItem(event.eventId); return; } // no recorded tournaments yet

  const scene = document.createElement("div");
  scene.className = "ranking-scene is-tournament";
  stage.append(scene);

  for (const phase of phases) {
    scene.innerHTML = `
      <div class="ranking-list-pane">
        <div class="ranking-heading">
          <span class="ranking-eyebrow">${settings?.language === "en" ? "Tournament ranking" : "Turnier-Ranking"}</span>
          <h2>${escapeForOverlay(phase.title)}</h2>
        </div>
        ${listMarkup(phase.entries)}
      </div>
    `;
    await delay(seconds * 1000);
  }
  scene.classList.add("is-out");
  await delay(450);
  scene.remove();
  completeQueueItem(event.eventId);
}

async function playTeamKampfRanking(event) {
  const lists = event.lists || {};
  const seconds = Math.max(2, Number(event.displaySeconds) || 8);
  const titles = teamKampfPhaseTitles();
  const phases = ["participations", "wins", "losses"]
    .map((key) => ({ key, title: titles[key], entries: lists[key] || [] }))
    .filter((phase) => phase.entries.length > 0);
  if (!phases.length) { completeQueueItem(event.eventId); return; } // no recorded Team-Kaempfe yet

  const scene = document.createElement("div");
  scene.className = "ranking-scene is-tournament";
  stage.append(scene);

  for (const phase of phases) {
    scene.innerHTML = `
      <div class="ranking-list-pane">
        <div class="ranking-heading">
          <span class="ranking-eyebrow">${settings?.language === "en" ? "Team battle ranking" : "Team-Kampf-Ranking"}</span>
          <h2>${escapeForOverlay(phase.title)}</h2>
        </div>
        ${listMarkup(phase.entries)}
      </div>
    `;
    await delay(seconds * 1000);
  }
  scene.classList.add("is-out");
  await delay(450);
  scene.remove();
  completeQueueItem(event.eventId);
}

async function playBattleRanking(event) {
  const lists = event.lists || {};
  const seconds = Math.max(2, Number(event.displaySeconds) || 8);
  const titles = phaseTitles();
  const phases = ["fights", "wins", "losses", "ratio"]
    .map((key) => ({ key, title: titles[key], entries: lists[key] || [] }))
    .filter((phase) => phase.entries.length > 0);
  if (!phases.length) { completeQueueItem(event.eventId); return; } // no recorded battles yet

  const scene = document.createElement("div");
  scene.className = "ranking-scene is-battle";
  stage.append(scene);

  for (const phase of phases) {
    scene.innerHTML = `
      <div class="ranking-list-pane">
        <div class="ranking-heading">
          <span class="ranking-eyebrow">${settings?.language === "en" ? "Battle ranking" : "Kampf-Ranking"}</span>
          <h2>${escapeForOverlay(phase.title)}</h2>
        </div>
        ${listMarkup(phase.entries)}
      </div>
    `;
    await delay(seconds * 1000);
  }
  scene.classList.add("is-out");
  await delay(450);
  scene.remove();
  completeQueueItem(event.eventId);
}

async function loadSettings() {
  settings = normalizeSettings(await getSettings());
  applyTheme(settings);
  applyOverlayLayout(stage, settings.overlayLayout?.ranking, "ranking");
}

function bindServerEvents() {
  connectEventStream({
    ranking: (event) => enqueueRanking(event),
    settings: () => loadSettings(),
    collections: () => {},
    draw: () => {},
    trade: () => {},
    battle: () => {},
    showcollection: () => {}
  });
}

function bindDebugHooks() {
  window.cardRankingOverlay = { play: enqueueRanking, reload: loadSettings };
}

async function init() {
  await loadSettings();
  bindServerEvents();
  bindDebugHooks();
}

init().catch((error) => setStatus(error.message, true));
