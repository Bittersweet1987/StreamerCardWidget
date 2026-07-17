// Asset version (BootId) propagated from this module's own URL (set by the page's bootstrap
// loader) into the shared-module imports below, so api.js/render.js are always fetched at the
// same version as this file - OBS/Meld can never mix a fresh page module with stale shared code.
const __v = new URL(import.meta.url).searchParams.get("v") || String(Date.now());
const { completeQueueItem, connectEventStream, getCommunityGoal, getSettings } = await import(`./api.js?v=${__v}`);
const { applyOverlayLayout, applyTheme, normalizeSettings } = await import(`./render.js?v=${__v}`);

const overlayRoot = document.querySelector("#communitygoal-overlay");
const barWrap = document.querySelector("#communitygoal-bar-wrap");
const barFill = document.querySelector("#communitygoal-bar-fill");
const label = document.querySelector("#communitygoal-label");
const count = document.querySelector("#communitygoal-count");
const celebration = document.querySelector("#communitygoal-celebration");
const celebrationText = document.querySelector("#communitygoal-celebration-text");
const status = document.querySelector("#status");

let settings;

function setStatus(text, show = false) {
  status.textContent = text;
  status.hidden = !show;
}

function goalLabel() {
  return settings?.language === "en" ? "Community goal" : "Community-Ziel";
}

// Bar is only ever visible while a goal is enabled, has a target, and hasn't been reached yet -
// once reached, the celebration takes over and the bar has nothing left to show until the next
// admin reset (which broadcasts reached:false again).
function renderProgress(current, target, reached) {
  const enabled = settings?.communityGoal?.enabled === true;
  barWrap.hidden = !enabled || !target || reached;
  if (!enabled || !target || reached) return;
  label.textContent = goalLabel();
  count.textContent = `${current} / ${target}`;
  const percent = Math.min(100, Math.round((current / target) * 100));
  barFill.style.width = `${percent}%`;
}

async function loadProgress() {
  try {
    const result = await getCommunityGoal();
    const goal = result.goal || {};
    renderProgress(goal.current || 0, goal.target || 0, goal.reached === true);
  } catch {
    // Best-effort - the bar just stays hidden if this fails.
  }
}

// This plays as its own item in the server's serialized draw queue (see ProcessQueueItem's
// "communitygoalreached" handling) so it never overlaps the draw that completed the goal or the
// bonus draws that follow - completeQueueItem() releases the queue for the next item once this
// animation is done, same as every other overlay's queued animation.
async function playCelebration(target, eventId) {
  const text = settings?.language === "en"
    ? `Goal reached! (${target} draws) Everyone gets a bonus booster.`
    : `Ziel erreicht! (${target} Ziehungen) Alle bekommen einen Bonus-Booster.`;
  celebrationText.textContent = text;
  celebration.hidden = false;
  celebration.classList.add("is-playing");
  await new Promise((resolve) => setTimeout(resolve, 6000));
  celebration.classList.remove("is-playing");
  celebration.hidden = true;
  if (eventId) completeQueueItem(eventId);
}

async function loadSettings() {
  settings = normalizeSettings(await getSettings());
  applyTheme(settings);
  applyOverlayLayout(overlayRoot, settings.overlayLayout?.communityGoal, "communityGoal");
  await loadProgress();
}

function bindServerEvents() {
  connectEventStream({
    communitygoalprogress: (event) => renderProgress(event.current || 0, event.target || 0, event.reached === true),
    communitygoalreached: (event) => playCelebration(event.target || 0, event.eventId),
    settings: () => loadSettings(),
    collections: () => {},
    draw: () => {},
    trade: () => {},
    battle: () => {},
    showcollection: () => {},
    ranking: () => {}
  });
}

function bindDebugHooks() {
  window.communityGoalOverlay = { reload: loadSettings, celebrate: () => playCelebration(settings?.communityGoal?.target || 500) };
}

async function init() {
  await loadSettings();
  bindServerEvents();
  bindDebugHooks();
}

init().catch((error) => setStatus(error.message, true));
