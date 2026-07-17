export async function getSettings() {
  const response = await fetch("/api/settings", { cache: "no-store" });
  if (!response.ok) throw new Error("Einstellungen konnten nicht geladen werden.");
  return response.json();
}

export async function getCollections() {
  const response = await fetch("/api/collections", { cache: "no-store" });
  if (!response.ok) return {};
  return response.json();
}

// Last few draws still remembered server-side (cleared on app restart) - lets a freshly (re)loaded
// live-ticker overlay show something immediately instead of sitting empty until the next draw.
export async function getRecentLiveTickerEntries() {
  try {
    const response = await fetch("/api/liveticker/recent", { cache: "no-store" });
    if (!response.ok) return [];
    const result = await response.json();
    return Array.isArray(result.entries) ? result.entries : [];
  } catch {
    return [];
  }
}

export async function saveSettings(settings) {
  // Credentials (twitch / twitchBot) are owned exclusively by the dedicated connect/disconnect
  // endpoints. Never include them in a settings save, otherwise a stale in-memory copy could
  // resurrect a disconnected account or overwrite freshly issued tokens.
  const { twitch, twitchBot, ...safe } = settings || {};
  const response = await fetch("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(safe)
  });
  if (!response.ok) throw new Error("Einstellungen konnten nicht gespeichert werden.");
  return response.json();
}

export async function resetSettings() {
  const response = await fetch("/api/reset-settings", { method: "POST" });
  if (!response.ok) throw new Error("Beispielwerte konnten nicht geladen werden.");
  return response.json();
}

export async function triggerDraw(payload) {
  const response = await fetch("/api/draw", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error("Test-Draw konnte nicht gesendet werden.");
  return response.json();
}

export async function resetCollections() {
  const response = await fetch("/api/reset-collections", { method: "POST" });
  if (!response.ok) throw new Error("Sammlungen konnten nicht geleert werden.");
  return response.json();
}

export async function persistCollection(user, cardId, boosterId = "default", variableName = "") {
  const response = await fetch("/api/collection", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user, cardId, boosterId, variableName })
  });
  if (!response.ok) return null;
  return response.json();
}

export async function persistCollectionSnapshot(collection, boosterId = "default", variableName = "") {
  const response = await fetch("/api/collection", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ collection, boosterId, variableName })
  });
  if (!response.ok) return null;
  return response.json();
}

export async function getTwitchStatus() {
  const response = await fetch("/api/twitch/status", { cache: "no-store" });
  if (!response.ok) throw new Error("Twitch-Status konnte nicht geladen werden.");
  return response.json();
}

export async function saveTwitchToken(payload) {
  const response = await fetch("/api/twitch/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Twitch-Verbindung konnte nicht gespeichert werden.");
  return data;
}

export async function getFonts() {
  const response = await fetch("/api/fonts", { cache: "no-store" });
  if (!response.ok) return { fonts: [] };
  return response.json();
}

export async function disconnectTwitch() {
  const response = await fetch("/api/twitch/disconnect", { method: "POST" });
  if (!response.ok) throw new Error("Twitch konnte nicht getrennt werden.");
  return response.json();
}

export async function getTwitchRewards() {
  const response = await fetch("/api/twitch/rewards", { cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Channelpoints konnten nicht geladen werden.");
  return data;
}

export async function syncTwitchReward(payload) {
  const response = await fetch("/api/twitch/reward", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Channelpoint konnte nicht gespeichert werden.");
  return data;
}

export async function syncShowcaseReward(payload) {
  const response = await fetch("/api/twitch/showcase-reward", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Showcase-Belohnung konnte nicht gespeichert werden.");
  return data;
}

export async function syncTournamentReward(payload) {
  const response = await fetch("/api/twitch/tournament-reward", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Turnier-Belohnung konnte nicht gespeichert werden.");
  return data;
}

export async function getTournamentState() {
  const response = await fetch("/api/tournament", { cache: "no-store" });
  if (!response.ok) throw new Error("Turnier-Status konnte nicht geladen werden.");
  return response.json();
}

export async function startTournament() {
  const response = await fetch("/api/tournament/start", { method: "POST" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Turnier konnte nicht gestartet werden.");
  return data;
}

export async function deleteTwitchReward(payload) {
  const response = await fetch("/api/twitch/reward", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Channelpoint konnte nicht gelöscht werden.");
  return data;
}

export async function testTradeAnimation(payload) {
  const response = await fetch("/api/trade/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error("Test-Animation konnte nicht gestartet werden.");
  return response.json();
}

export async function testBattleAnimation(payload) {
  const response = await fetch("/api/battle/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error("Test-Animation konnte nicht gestartet werden.");
  return response.json();
}

export async function getBotStatus() {
  const response = await fetch("/api/twitch/bot/status", { cache: "no-store" });
  if (!response.ok) throw new Error("Bot-Status konnte nicht geladen werden.");
  return response.json();
}

export async function saveBotToken(payload) {
  const response = await fetch("/api/twitch/bot/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Bot-Verbindung konnte nicht gespeichert werden.");
  return data;
}

export async function disconnectBot() {
  const response = await fetch("/api/twitch/bot/disconnect", { method: "POST" });
  if (!response.ok) throw new Error("Bot-Verbindung konnte nicht getrennt werden.");
  return response.json();
}

export async function getCommandUsage() {
  const response = await fetch("/api/command-usage", { cache: "no-store" });
  if (!response.ok) throw new Error("Nutzungsdaten konnten nicht geladen werden.");
  return response.json();
}

export async function getPityState() {
  const response = await fetch("/api/pity", { cache: "no-store" });
  if (!response.ok) throw new Error("Pity-Daten konnten nicht geladen werden.");
  return response.json();
}

export async function getCommunityGoal() {
  const response = await fetch("/api/community-goal", { cache: "no-store" });
  if (!response.ok) throw new Error("Community-Ziel-Daten konnten nicht geladen werden.");
  return response.json();
}

export async function resetCommunityGoal() {
  const response = await fetch("/api/community-goal/reset", { method: "POST" });
  if (!response.ok) throw new Error("Community-Ziel konnte nicht zurückgesetzt werden.");
  return response.json();
}

export async function resetCommandUsage(login = "") {
  const response = await fetch("/api/command-usage/reset", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ login })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Nutzung konnte nicht zurückgesetzt werden.");
  return data;
}

export async function getQueueItems() {
  const response = await fetch("/api/queue", { cache: "no-store" });
  if (!response.ok) throw new Error("Warteschlange konnte nicht geladen werden.");
  return response.json();
}

export async function setQueuePaused(paused) {
  const response = await fetch("/api/queue/pause", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paused: !!paused })
  });
  if (!response.ok) throw new Error("Warteschlange konnte nicht umgeschaltet werden.");
  return response.json();
}

export async function removeQueueItem(id) {
  const response = await fetch("/api/queue/remove", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id })
  });
  if (!response.ok) throw new Error("Eintrag konnte nicht entfernt werden.");
  return response.json();
}

export async function clearQueue() {
  const response = await fetch("/api/queue/clear", { method: "POST" });
  if (!response.ok) throw new Error("Warteschlange konnte nicht geleert werden.");
  return response.json();
}

export async function completeQueueItem(eventId, cardTitle = "", boosterTitle = "") {
  if (!eventId) return;
  try {
    await fetch("/api/queue/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventId, cardTitle, boosterTitle })
    });
  } catch {
  }
}

// Fired the instant a drawn card is fully revealed (the same moment its collection panel appears
// next to it) - triggers the post-draw chat message and live-ticker entry right then, separate
// from completeQueueItem (which only releases the queue once the whole animation has finished
// playing, several seconds later).
export async function announceDraw(eventId, cardTitle = "", boosterTitle = "") {
  if (!eventId || !cardTitle) return;
  try {
    await fetch("/api/queue/announce", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventId, cardTitle, boosterTitle })
    });
  } catch {
  }
}

// OBS/Meld browser sources are persistent embedded browsers that never re-navigate on their own
// and effectively ignore Cache-Control headers, so a page loaded once would keep running stale
// code forever. The server sends its BootId (changes on every app start) with each SSE "ready"
// event; since the served files can only change while the app is stopped, a changed BootId after
// an EventSource reconnect means "assets may be outdated" and the page replaces itself with the
// new BootId as cache-buster - a never-seen URL, which forces a genuinely fresh fetch of the HTML
// and (via the bootstrap loader in each overlay page) of all CSS/JS. This is the same push-reload
// approach hosted widget platforms use, and removes any need for manual cache refreshes in OBS.
let knownBootId = null;
function handleReadyEvent(data) {
  const bootId = data && data.bootId;
  if (!bootId) return;
  if (knownBootId === null) {
    knownBootId = bootId;
    return;
  }
  if (bootId !== knownBootId) {
    const url = new URL(window.location.href);
    url.searchParams.set("v", bootId);
    window.location.replace(url.toString());
  }
}

// ---- Shared server-event stream (one physical connection per browser) ----
//
// Chromium allows at most 6 concurrent HTTP/1.1 connections per host - and OBS hosts ALL its
// browser sources in ONE shared browser context. With 6 overlay sources each holding its own
// EventSource, that pool was exactly saturated: every further request (queue-complete acks,
// logs, even settings loads) stalled forever, which killed all animations the moment the 6th
// overlay source (Community-Ziel) was added (root-caused 2026-07-16 via OBS remote debugging).
//
// Therefore exactly ONE page per browser - elected via the Web Locks API - owns the physical
// EventSource and relays every event to all other same-origin pages via BroadcastChannel. Total
// standing connections per browser: 1, no matter how many overlay sources exist now or later.

// Every event name the server broadcasts. The leader listens to all of them on behalf of every
// page, because it cannot know which events the other pages' handlers care about.
const SSE_EVENT_NAMES = ["settings", "collections", "draw", "trade", "battle", "showcollection",
  "ranking", "queue", "communitygoalprogress", "communitygoalreached", "tournamentsignup", "liveticker", "ping", "ready"];

// Animation-triggering events get a receipt log so a silent OBS browser source can be diagnosed
// from the Log tab: "written by server but never received" vs. "received but animation failed".
const LOGGED_EVENTS = new Set(["draw", "trade", "battle", "showcollection", "ranking", "communitygoalreached"]);

const streamState = {
  page: (typeof location !== "undefined" && location.pathname.replace(/^\//, "")) || "admin.html",
  handlers: [],        // handler maps registered by this page
  channel: null,       // BroadcastChannel to the sibling pages
  source: null,        // the physical EventSource (leader only)
  isLeader: false,
  lastSeen: Date.now(),
  started: false
};

function dispatchStreamEvent(eventName, data) {
  streamState.lastSeen = Date.now();
  if (eventName === "ready") { handleReadyEvent(data); return; }
  if (eventName === "ping") return;
  if (LOGGED_EVENTS.has(eventName)) {
    addLog("overlay", "info", "Event \"" + eventName + "\" empfangen: " + streamState.page + (streamState.isLeader ? " (direkt)" : " (via Kanal)"));
  }
  for (const handlers of streamState.handlers) {
    const handler = handlers[eventName];
    if (!handler) continue;
    try { handler(data); } catch {}
  }
}

function openLeaderSource() {
  const source = new EventSource("/api/events?page=" + encodeURIComponent(streamState.page));
  streamState.source = source;
  streamState.lastSeen = Date.now();
  source.addEventListener("open", () => { streamState.lastSeen = Date.now(); });
  for (const eventName of SSE_EVENT_NAMES) {
    source.addEventListener(eventName, (message) => {
      let data;
      try { data = JSON.parse(message.data); } catch { data = {}; }
      // Relay to the sibling pages first (BroadcastChannel does not echo to the sender),
      // then dispatch locally.
      if (streamState.channel) {
        try { streamState.channel.postMessage({ event: eventName, data }); } catch {}
      }
      dispatchStreamEvent(eventName, data);
    });
  }
}

function becomeLeader() {
  streamState.isLeader = true;
  openLeaderSource();
  // Leader watchdog: OBS's embedded browser can silently drop the connection WITHOUT firing
  // the error event (readyState stays 1, nothing arrives). The server pings every 20s; 65s of
  // silence is proof of death, so tear down and reconnect (the fresh "ready" also re-checks
  // the BootId for a pending self-reload).
  setInterval(() => {
    if (Date.now() - streamState.lastSeen < 65000) return;
    addLog("overlay", "warn", "SSE-Watchdog: keine Lebenszeichen seit 65s (" + streamState.page + ") - Verbindung wird neu aufgebaut.");
    try { streamState.source.close(); } catch {}
    openLeaderSource();
  }, 15000);
}

function startSharedStream() {
  if (streamState.started) return;
  streamState.started = true;

  const canShare = typeof BroadcastChannel !== "undefined" && typeof navigator !== "undefined" && navigator.locks;
  if (!canShare) {
    // Very old embedded browser: fall back to a direct connection for this page.
    becomeLeader();
    return;
  }

  streamState.channel = new BroadcastChannel("cardpack-sse-v1");
  streamState.channel.onmessage = (message) => {
    const payload = message.data || {};
    if (!payload.event) return;
    // Followers consume relayed events; the leader hears only OTHER leaders here (shouldn't
    // happen - the lock guarantees one) and ignores them.
    if (!streamState.isLeader) dispatchStreamEvent(payload.event, payload.data);
  };

  // Whoever wins this exclusive lock is the browser-wide leader and holds the lock until its
  // page dies (source removed / reload) - then the next waiting page is elected automatically.
  navigator.locks.request("cardpack-sse-leader", () => {
    becomeLeader();
    return new Promise(() => {});
  }).catch(() => {});

  // Follower watchdog: if the leader page got frozen or killed without releasing cleanly and
  // no events arrive for 90s, forcibly steal the leadership (with per-page jitter so exactly
  // one of the starving followers grabs it first).
  setTimeout(() => {
    setInterval(() => {
      if (streamState.isLeader) return;
      if (Date.now() - streamState.lastSeen < 90000) return;
      addLog("overlay", "warn", "SSE-Watchdog: Leader liefert seit 90s nichts (" + streamState.page + ") - übernehme die Verbindung.");
      streamState.lastSeen = Date.now();
      navigator.locks.request("cardpack-sse-leader", { steal: true }, () => {
        if (!streamState.isLeader) becomeLeader();
        return new Promise(() => {});
      }).catch(() => {});
    }, 15000);
  }, Math.floor(Math.random() * 10000));
}

export function connectEventStream(handlers) {
  streamState.handlers.push(handlers);
  startSharedStream();
  return streamState;
}

export function currentOriginUrl(pathname) {
  const url = new URL(pathname, window.location.origin);
  return url.toString();
}

export async function getLogs() {
  const response = await fetch("/api/logs", { cache: "no-store" });
  if (!response.ok) throw new Error("Logs konnten nicht geladen werden.");
  return response.json();
}

// Overlay pages run headless inside OBS/Meld where no devtools are visible - an uncaught error
// would silently kill the animation with no trace. Forward every uncaught error/rejection into
// the app's event log so failures show up in the Log tab instead of vanishing.
if (typeof window !== "undefined" && !window.__overlayErrorHookInstalled) {
  window.__overlayErrorHookInstalled = true;
  window.addEventListener("error", (e) => {
    addLog("overlay", "error", "JS-Fehler auf " + location.pathname + ": " + e.message + " (" + (e.filename || "?") + ":" + (e.lineno || "?") + ")");
  });
  window.addEventListener("unhandledrejection", (e) => {
    addLog("overlay", "error", "Unbehandelter Fehler auf " + location.pathname + ": " + (e.reason && e.reason.message ? e.reason.message : String(e.reason)));
  });
}

export async function addLog(category, level, message) {
  try {
    await fetch("/api/logs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ category, level, message })
    });
  } catch {
  }
}

export async function clearLogs() {
  const response = await fetch("/api/logs/clear", { method: "POST" });
  if (!response.ok) throw new Error("Logs konnten nicht gelöscht werden.");
  return response.json();
}

export async function getVersion() {
  const response = await fetch("/api/version", { cache: "no-store" });
  if (!response.ok) throw new Error("Versionsinfo konnte nicht geladen werden.");
  return response.json();
}

export async function installUpdate(downloadUrl) {
  const response = await fetch("/api/update/install", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ downloadUrl })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Update konnte nicht installiert werden.");
  return data;
}

export async function getLatestRelease(repo) {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { accept: "application/vnd.github+json" }
  });
  if (response.status === 404) throw new Error("Noch kein Release veröffentlicht.");
  if (!response.ok) throw new Error(`GitHub antwortete mit Status ${response.status}.`);
  return response.json();
}

// Up to 100 most recent releases (newest first) - used to build the "everything new since your
// version" changelog. 100 is far more than this project will ever have, so no pagination needed.
export async function getReleases(repo) {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100`, {
    headers: { accept: "application/vnd.github+json" }
  });
  if (!response.ok) throw new Error(`GitHub antwortete mit Status ${response.status}.`);
  return response.json();
}
