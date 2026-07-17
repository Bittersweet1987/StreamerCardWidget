// Asset version (BootId) propagated from this module's own URL (set by the page's bootstrap
// loader) into the shared-module imports below, so api.js/render.js are always fetched at the
// same version as this file - OBS/Meld can never mix a fresh page module with stale shared code.
const __v = new URL(import.meta.url).searchParams.get("v") || String(Date.now());
const { connectEventStream, getRecentLiveTickerEntries, getSettings } = await import(`./api.js?v=${__v}`);
const { applyOverlayLayout, applyTheme, normalizeSettings, OVERLAY_LAYOUT_NATURAL_SIZES } = await import(`./render.js?v=${__v}`);

// Fallback for when a user has no cached Twitch avatar (or it fails to load) - a simplified
// Twitch "glitch mark" glyph, inlined so it never depends on an extra image request.
const TWITCH_ICON_SVG = `<svg class="liveticker-twitch-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path fill="#9147ff" d="M4.29 2 2 6.86v13.14h5.14V22h2.85l2.86-2.86h3.72L23 12.57V2H4.29zm16.85 9.71-3.43 3.43h-3.71L11.14 18h-2v-2.86H4.29V3.71h16.85v8z"/><path fill="#9147ff" d="M14.86 6.29h1.71v4.28h-1.71V6.29zm-4.29 0h1.72v4.28h-1.72V6.29z"/></svg>`;

const stage = document.querySelector("#liveticker-stage");
const banner = document.querySelector("#liveticker-banner");
const viewport = document.querySelector("#liveticker-viewport");
const track = document.querySelector("#liveticker-track");
const status = document.querySelector("#status");

let settings;
// Capped history of past draws, oldest first - new draws are pushed onto the end. The conveyor
// below reads through this list in a cycle, so once it has scrolled through everything it just
// starts again from the oldest entry still remembered (the "loops back to the right" behavior).
let entries = [];
let cyclePos = 0; // next index into `entries` (mod entries.length) to append to the conveyor
let offset = 0; // px scrolled so far; subtracted from the track's translateX
let lastFrameTime = null;
let rafId = null;

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

function buildItem(entry) {
  const el = document.createElement("span");
  el.className = "liveticker-item";
  const boosterHtml = entry.boosterTitle
    ? `<span class="liveticker-booster">(${escapeForOverlay(entry.boosterTitle)})</span>`
    : "";
  el.innerHTML = `
    <span class="liveticker-avatar-slot"></span>
    <span class="liveticker-user">${escapeForOverlay(entry.user)}</span>
    <span class="liveticker-sep">${settings?.language === "en" ? "drew" : "zog"}</span>
    <span class="liveticker-card">${escapeForOverlay(entry.cardTitle)}</span>
    ${boosterHtml}
  `;
  const slot = el.querySelector(".liveticker-avatar-slot");
  if (entry.avatarUrl) {
    const img = document.createElement("img");
    img.className = "liveticker-avatar";
    img.alt = "";
    // The server caches this per login, but a login it has never resolved (or a Twitch outage)
    // still needs a graceful fallback rather than a broken-image icon.
    img.addEventListener("error", () => {
      slot.replaceChildren();
      slot.insertAdjacentHTML("beforeend", TWITCH_ICON_SVG);
    }, { once: true });
    img.src = entry.avatarUrl;
    slot.appendChild(img);
  } else {
    slot.insertAdjacentHTML("beforeend", TWITCH_ICON_SVG);
  }
  return el;
}

// Keeps enough items queued up (already appended, sitting off-screen to the right inside the
// wider-than-the-viewport track) to cover the visible viewport plus a full screen of buffer. This
// is what makes a freshly arrived draw show up "on its next lap" with zero visual disruption: it
// only ever gets appended at the tail, far to the right of anything currently visible, so nothing
// already scrolling on screen ever moves, resizes, or restarts because of it.
function fillBuffer() {
  if (!entries.length) return;
  const viewportWidth = viewport.clientWidth || 0;
  let guard = 0; // entries.length can never make this loop infinite, but a stalled layout could
  while (track.scrollWidth - offset < viewportWidth * 2 + 400 && guard++ < 200) {
    const entry = entries[cyclePos % entries.length];
    cyclePos++;
    track.appendChild(buildItem(entry));
  }
}

function advance(dt) {
  const speed = Math.max(20, Number(settings?.liveTicker?.speed) || 90);
  offset += speed * dt;

  // Once the leading item has fully scrolled past the left edge, drop it and hand its width back
  // to `offset` - every remaining item's on-screen position is unaffected, so there's no jump.
  let first = track.firstElementChild;
  while (first && first.offsetWidth > 0 && offset >= first.offsetWidth) {
    offset -= first.offsetWidth;
    track.removeChild(first);
    first = track.firstElementChild;
  }

  track.style.transform = `translateX(${-offset}px)`;
  fillBuffer();
}

function tick(now) {
  if (lastFrameTime == null) lastFrameTime = now;
  const dt = Math.min(0.25, (now - lastFrameTime) / 1000); // clamp so a stalled/backgrounded tab can't jump
  lastFrameTime = now;
  advance(dt);
  rafId = requestAnimationFrame(tick);
}

function startLoop() {
  if (rafId) return;
  lastFrameTime = null;
  rafId = requestAnimationFrame(tick);
}

function stopLoop() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
}

function resetConveyor() {
  track.innerHTML = "";
  offset = 0;
  cyclePos = 0;
  track.style.transform = "translateX(0px)";
  fillBuffer();
}

function updateVisibility() {
  const shouldShow = settings?.liveTicker?.enabled !== false && entries.length > 0;
  banner.hidden = !shouldShow;
  if (!shouldShow) {
    stopLoop();
    return;
  }
  if (!track.childElementCount) resetConveyor();
  startLoop();
}

// Independent of the pack-opening queue/animation on purpose - the ticker is meant to reflect
// every draw as it actually resolves (server broadcasts this the moment the overlay reports which
// card was drawn), not throttled by the sequential animation playback gap.
function addEntry(event = {}) {
  if (!settings) return;
  if (!event.cardTitle) return;
  entries.push({ user: event.user || "Viewer", cardTitle: event.cardTitle, boosterTitle: event.boosterTitle, rarity: event.rarity, avatarUrl: event.avatarUrl });
  const max = settings.liveTicker?.maxEntries || 8;
  if (entries.length > max) entries.splice(0, entries.length - max);
  updateVisibility();
}

async function loadSettings() {
  settings = normalizeSettings(await getSettings());
  applyTheme(settings);
  applyOverlayLayout(stage, settings.overlayLayout?.liveTicker, "liveTicker");
  // The banner's width is always the full canvas (see OVERLAY_LAYOUT_NATURAL_SIZES.liveTicker's
  // lockWidth flag - applyOverlayLayout above never scales it), so "Skalierung" is applied here
  // directly to height and font size instead of via a CSS transform, which would otherwise
  // squish/stretch the banner non-uniformly or blur the text.
  const scale = Number(settings.overlayLayout?.liveTicker?.scale) > 0 ? settings.overlayLayout.liveTicker.scale : 100;
  const baseHeight = OVERLAY_LAYOUT_NATURAL_SIZES.liveTicker.h;
  banner.style.height = `${baseHeight * (scale / 100)}px`;
  banner.style.setProperty("--liveticker-scale", scale / 100);
  updateVisibility();
}

function bindServerEvents() {
  connectEventStream({
    liveticker: (event) => addEntry(event),
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
  window.liveTickerOverlay = {
    reload: loadSettings,
    add: addEntry,
    getSettings: () => settings,
    getEntries: () => entries,
    // Test/diagnostic only: advances the conveyor by dtSeconds without relying on
    // requestAnimationFrame, which browsers throttle/pause for backgrounded tabs (irrelevant to a
    // real OBS/Meld source, which always renders, but makes automated testing awkward otherwise).
    stepFrame: (dtSeconds) => advance(dtSeconds),
    getOffset: () => offset,
    getTrackHtml: () => track.innerHTML
  };
}

async function init() {
  await loadSettings();
  // Seeds the conveyor with whatever the server still remembers (cleared on app restart) so the
  // ticker shows content right away on a fresh load instead of waiting for the next live draw.
  const recent = await getRecentLiveTickerEntries();
  if (recent.length) {
    entries = recent.map((entry) => ({
      user: entry.user || "Viewer",
      cardTitle: entry.cardTitle,
      boosterTitle: entry.boosterTitle,
      rarity: entry.rarity,
      avatarUrl: entry.avatarUrl
    }));
    updateVisibility();
  }
  bindServerEvents();
  bindDebugHooks();
}

init().catch((error) => setStatus(error.message, true));
