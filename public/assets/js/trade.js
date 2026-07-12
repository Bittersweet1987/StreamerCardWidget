import { addLog, completeQueueItem, connectEventStream, getSettings } from "./api.js";
import { applyTheme, cardMarkup, normalizeSettings } from "./render.js";

const stage = document.querySelector("#trade-stage");
const status = document.querySelector("#status");

let settings;
let queue = [];
let running = false;
let audioContext;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DURATIONS = { short: 4000, medium: 6500, long: 9000 };

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

function playTradeSound() {
  const volume = Number(settings?.style?.volume || 0) / 100;
  if (volume <= 0) return;
  const uploaded = settings?.sounds?.trade;
  if (uploaded) {
    const audio = new Audio(uploaded);
    audio.volume = Math.min(1, Math.max(0, volume));
    audio.play().catch(() => {});
    return;
  }
  // Built-in default chime (rising three-note sparkle) when no custom sound is set.
  audioContext ||= new AudioContext();
  const now = audioContext.currentTime;
  const gain = audioContext.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.14 * volume, now + 0.03);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.6);
  gain.connect(audioContext.destination);
  [523.25, 659.25, 880].forEach((freq, index) => {
    const osc = audioContext.createOscillator();
    osc.type = index % 2 ? "triangle" : "sine";
    osc.frequency.setValueAtTime(freq, now + index * 0.08);
    osc.connect(gain);
    osc.start(now + index * 0.08);
    osc.stop(now + 0.62);
  });
}

function enqueueTrade(event = {}) {
  // A test event always previews (so it can be checked before enabling); real events obey the
  // toggle. Real events are gated by the server-side queue (see runQueue's finally below) - if
  // the animation is off, the event is dropped here but must still be acked immediately,
  // otherwise the queue would sit out the full timeout waiting for an ack that never comes.
  if (event.test !== true && settings?.tradeAnimation?.enabled !== true) {
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
      await playTrade(event);
    } finally {
      completeQueueItem(event.eventId);
    }
    await delay(400);
  }
  running = false;
}

async function playTrade(event = {}) {
  const cardA = findCard(event.cardAId);
  const cardB = findCard(event.cardBId);
  if (!cardA || !cardB) return;

  const style = ["swap", "arc", "flip"].includes(settings.tradeAnimation?.style) ? settings.tradeAnimation.style : "swap";
  const total = DURATIONS[settings.tradeAnimation?.duration] || DURATIONS.medium;

  const scene = document.createElement("div");
  scene.className = `trade-scene style-${style}`;
  scene.style.setProperty("--dur", `${total}ms`);
  scene.innerHTML = `
    <div class="trade-flash"></div>
    <div class="trade-slot slot-a">
      <div class="trade-anim">
        ${cardMarkup(cardA)}
        <span class="trade-name">${escapeForOverlay(event.userA || "")}</span>
      </div>
    </div>
    <div class="trade-slot slot-b">
      <div class="trade-anim">
        ${cardMarkup(cardB)}
        <span class="trade-name">${escapeForOverlay(event.userB || "")}</span>
      </div>
    </div>
  `;
  stage.append(scene);
  playTradeSound();
  addLog("trade", "info", `${event.userA} ⇄ ${event.userB}: ${cardA.title || cardA.id} / ${cardB.title || cardB.id}`);

  // The cards change hands during the animation: once they have crossed to the other side,
  // each card now belongs to the OTHER viewer, so the name underneath updates to the new owner.
  const nameA = scene.querySelector(".slot-a .trade-name");
  const nameB = scene.querySelector(".slot-b .trade-name");
  const swapAt = Math.round(total * 0.6);
  setTimeout(() => {
    if (nameA) { nameA.textContent = event.userB || ""; nameA.classList.add("is-new-owner"); }
    if (nameB) { nameB.textContent = event.userA || ""; nameB.classList.add("is-new-owner"); }
  }, swapAt);

  await delay(total + 150);
  scene.remove();
}

async function loadSettings() {
  settings = normalizeSettings(await getSettings());
  applyTheme(settings);
}

function bindServerEvents() {
  connectEventStream({
    trade: (event) => enqueueTrade(event),
    settings: () => loadSettings(),
    collections: () => {},
    draw: () => {},
    showcollection: () => {}
  });
}

function bindDebugHooks() {
  window.cardTradeAnimation = { play: enqueueTrade, reload: loadSettings };
  const params = new URLSearchParams(window.location.search);
  if (params.get("demo") === "1") {
    const cards = settings.deck?.cards || [];
    if (cards.length >= 2) {
      // Bypass the enabled-gate for a manual preview so the demo always shows something.
      const wasEnabled = settings.tradeAnimation?.enabled;
      settings.tradeAnimation = settings.tradeAnimation || {};
      settings.tradeAnimation.enabled = true;
      setTimeout(() => {
        enqueueTrade({ userA: params.get("a") || "UserA", userB: params.get("b") || "UserB", cardAId: cards[0].id, cardBId: cards[1].id });
        settings.tradeAnimation.enabled = wasEnabled;
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
