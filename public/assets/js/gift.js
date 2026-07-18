// Asset version (BootId) propagated from this module's own URL (set by the page's bootstrap
// loader) into the shared-module imports below, so api.js/render.js are always fetched at the
// same version as this file - OBS/Meld can never mix a fresh page module with stale shared code.
const __v = new URL(import.meta.url).searchParams.get("v") || String(Date.now());
const { addLog, completeQueueItem, connectEventStream, getSettings } = await import(`./api.js?v=${__v}`);
const { applyOverlayLayout, applyTheme, cardMarkup, normalizeSettings } = await import(`./render.js?v=${__v}`);

const stage = document.querySelector("#gift-stage");
const status = document.querySelector("#status");

let settings;
let queue = [];
let running = false;
let audioContext;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DURATION_MS = 5000;
const PIXEL_COLORS = ["#2b214f", "#4a3a8f", "#7a5fd4", "#9147ff", "#c77dff", "#4cc9f0", "#ff78bb", "#665cff"];
const PIXEL_COLS = 8;
const PIXEL_ROWS = 10;

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

function playGiftSound() {
  const volume = Number(settings?.style?.volume || 0) / 100;
  if (volume <= 0) return;
  const uploaded = settings?.sounds?.gift;
  if (uploaded) {
    const audio = new Audio(uploaded);
    audio.volume = Math.min(1, Math.max(0, volume));
    audio.play().catch(() => {});
    return;
  }
  // Built-in default chime (soft two-note bell) when no custom sound is set.
  audioContext ||= new AudioContext();
  const now = audioContext.currentTime;
  const gain = audioContext.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.13 * volume, now + 0.03);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);
  gain.connect(audioContext.destination);
  [660, 990].forEach((freq, index) => {
    const osc = audioContext.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(freq, now + index * 0.1);
    osc.connect(gain);
    osc.start(now + index * 0.1);
    osc.stop(now + 0.58);
  });
}


// A grid of solid-color tiles covering the card, each fading out at its own randomized delay -
// the card underneath is fully rendered from frame one, so revealing it is purely a matter of the
// grid dissolving away. Deliberately plain 2D (position/opacity only, no transforms) since a real
// 3D fold animation attempted earlier for this feature turned out not to render at all in OBS's
// browser source - grid tiles are guaranteed to work everywhere.
function pixelGridMarkup(durationMs) {
  let tiles = "";
  const total = PIXEL_COLS * PIXEL_ROWS;
  for (let i = 0; i < total; i++) {
    const color = PIXEL_COLORS[Math.floor(Math.random() * PIXEL_COLORS.length)];
    // Tiles finish dissolving well before the hold period (60% of duration) so the card is fully
    // visible for a while before the scene fades out.
    const delayMs = Math.round(Math.random() * durationMs * 0.55);
    const durMs = 260 + Math.round(Math.random() * 220);
    tiles += `<span class="gift-pixel-tile" style="background:${color};animation-delay:${delayMs}ms;animation-duration:${durMs}ms"></span>`;
  }
  return tiles;
}

function enqueueGift(event = {}) {
  // A test event always previews (so it can be checked before enabling); real events obey the
  // toggle. Real events are gated by the server-side queue (see runQueue's finally below) - if
  // the animation is off, the event is dropped here but must still be acked immediately,
  // otherwise the queue would sit out the full timeout waiting for an ack that never comes.
  if (event.test !== true && settings?.giftAnimation?.enabled !== true) {
    completeQueueItem(event.eventId);
    return;
  }
  queue.push(event);
  if (!running) runQueue();
}

async function runQueue() {
  running = true;
  while (queue.length) {
    const event = queue.shift();
    try {
      await playGift(event);
    } finally {
      completeQueueItem(event.eventId);
    }
    await delay(400);
  }
  running = false;
}

async function playGift(event = {}) {
  const card = findCard(event.cardId);
  if (!card) return;

  const style = ["handover", "spin", "pixelate"].includes(event.style || settings.giftAnimation?.style)
    ? (event.style || settings.giftAnimation.style)
    : "handover";

  // Pixelate: the real card renders immediately, covered by a grid of solid-color tiles that
  // dissolve away at randomized delays, "resolving" into the finished card piece by piece.
  const cardArt = style === "pixelate"
    ? `<div class="gift-pixel-wrap">
        ${cardMarkup(card)}
        <div class="gift-pixel-grid">${pixelGridMarkup(DURATION_MS)}</div>
      </div>`
    : cardMarkup(card);

  const scene = document.createElement("div");
  scene.className = `gift-scene style-${style}`;
  scene.style.setProperty("--dur", `${DURATION_MS}ms`);
  scene.innerHTML = `
    <div class="gift-slot">
      <div class="gift-anim">
        ${cardArt}
        <div class="gift-label">
          <span>${escapeForOverlay(event.fromUser || "")}</span>
          <span class="gift-arrow">→</span>
          <span>${escapeForOverlay(event.toUser || "")}</span>
        </div>
      </div>
    </div>
  `;
  stage.append(scene);
  playGiftSound();
  addLog("gift", "info", `${event.fromUser} → ${event.toUser}: ${card.title || card.id}`);

  await delay(DURATION_MS + 150);
  scene.remove();
}

async function loadSettings() {
  settings = normalizeSettings(await getSettings());
  applyTheme(settings);
  applyOverlayLayout(stage, settings.overlayLayout?.gift, "gift");
}

function bindServerEvents() {
  connectEventStream({
    gift: (event) => enqueueGift(event),
    settings: () => loadSettings(),
    collections: () => {},
    draw: () => {},
    showcollection: () => {}
  });
}

function bindDebugHooks() {
  window.cardGiftAnimation = { play: enqueueGift, reload: loadSettings };
  const params = new URLSearchParams(window.location.search);
  if (params.get("demo") === "1") {
    const cards = settings.deck?.cards || [];
    if (cards.length >= 1) {
      // Bypass the enabled-gate for a manual preview so the demo always shows something.
      const wasEnabled = settings.giftAnimation?.enabled;
      settings.giftAnimation = settings.giftAnimation || {};
      settings.giftAnimation.enabled = true;
      setTimeout(() => {
        enqueueGift({ fromUser: params.get("from") || "UserA", toUser: params.get("to") || "UserB", cardId: cards[0].id, style: params.get("style") });
        settings.giftAnimation.enabled = wasEnabled;
      }, 600);
    }
  }
}

async function init() {
  await loadSettings();
  bindServerEvents();
  bindDebugHooks();
}

init().catch((error) => setStatus(error.message, true));
