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

export async function saveSettings(settings) {
  const response = await fetch("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(settings)
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

export async function completeQueueItem(eventId) {
  if (!eventId) return;
  try {
    await fetch("/api/queue/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventId })
    });
  } catch {
  }
}

export function connectEventStream(handlers) {
  const source = new EventSource("/api/events");
  for (const [event, handler] of Object.entries(handlers)) {
    source.addEventListener(event, (message) => {
      try {
        handler(JSON.parse(message.data));
      } catch {
        handler({});
      }
    });
  }
  return source;
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
