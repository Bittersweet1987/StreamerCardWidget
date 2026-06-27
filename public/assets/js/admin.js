import {
  addLog,
  clearLogs,
  currentOriginUrl,
  deleteTwitchReward,
  disconnectTwitch,
  getCollections,
  getFonts,
  getLatestRelease,
  installUpdate,
  getLogs,
  getSettings,
  getTwitchRewards,
  getTwitchStatus,
  getVersion,
  persistCollectionSnapshot,
  resetCollections,
  resetSettings,
  saveSettings,
  syncTwitchReward,
  triggerDraw
} from "./api.js";
import {
  applyTheme,
  boosterMarkup,
  cardMarkup,
  cardsForBooster,
  createId,
  DEFAULT_RARITY_COLORS,
  escapeHtml,
  normalizeSettings,
  RARITIES,
  rarityWeight,
  readFileAsDataUrl,
  setRarityColors
} from "./render.js";

let settings;
let selectedCardId;
let selectedBoosterId;
let availableRewards = [];
let availableFonts = [];
let autoSaveTimer;
let autoSaveReady = false;
let collections = {};
const DEFAULT_TWITCH_CLIENT_ID = "klgyxuiixy0mfo7ze7goubj5j16g7u";
const TWITCH_REQUIRED_SCOPES = "channel:read:redemptions channel:manage:redemptions";

const I18N = {
  "nav-overview": { de: "Übersicht", en: "Overview" },
  "nav-trigger": { de: "Verbindung", en: "Connection" },
  "nav-cards": { de: "Karten", en: "Cards" },
  "nav-booster": { de: "Booster", en: "Boosters" },
  "nav-users": { de: "User", en: "Users" },
  "nav-design": { de: "Einstellungen", en: "Settings" },
  "nav-update": { de: "Update", en: "Update" },
  "nav-log": { de: "Log", en: "Log" },
  "log-eyebrow": { de: "Verlauf", en: "History" },
  "log-title": { de: "Ereignis-Log", en: "Event log" },
  "placeholder-log-search": { de: "Log durchsuchen...", en: "Search log..." },
  "btn-export-logs": { de: "Exportieren", en: "Export" },
  "btn-clear-logs": { de: "Log löschen", en: "Clear log" },
  "hint-log-empty": { de: "Noch keine Ereignisse aufgezeichnet.", en: "No events recorded yet." },
  "hint-no-log-found": { de: "Keine Einträge gefunden für", en: "No entries found for" },
  "notice-log-cleared": { de: "Log gelöscht.", en: "Log cleared." },
  "update-eyebrow": { de: "Wartung", en: "Maintenance" },
  "update-title": { de: "Update", en: "Update" },
  "update-current-label": { de: "Installierte Version", en: "Installed version" },
  "update-date-label": { de: "Veröffentlicht am", en: "Released on" },
  "update-status-idle": { de: "Noch nicht geprüft.", en: "Not checked yet." },
  "update-status-checking": { de: "Prüfe auf Updates...", en: "Checking for updates..." },
  "update-status-current": { de: "Du nutzt die aktuelle Version.", en: "You're on the latest version." },
  "update-status-available": { de: "Update verfügbar:", en: "Update available:" },
  "update-status-error": { de: "Update-Prüfung fehlgeschlagen:", en: "Update check failed:" },
  "btn-check-update": { de: "Nach Updates suchen", en: "Check for updates" },
  "btn-goto-update": { de: "Zum Update", en: "Go to update" },
  "btn-install-update": { de: "Installieren", en: "Install" },
  "confirm-install-update": {
    de: "Update jetzt installieren? Die App startet dabei neu. Deine Einstellungen, Sammlungen und die Twitch/OBS-Verbindung bleiben erhalten.",
    en: "Install the update now? The app will restart. Your settings, collections and Twitch/OBS connection are kept."
  },
  "update-status-installing": { de: "Installiere Update, App startet neu...", en: "Installing update, app is restarting..." },
  "update-status-install-failed": { de: "Installation fehlgeschlagen:", en: "Installation failed:" },
  "error-no-update-asset": {
    de: "Im Release wurde keine herunterladbare Datei (.zip) gefunden.",
    en: "No downloadable file (.zip) was found in the release."
  },
  "banner-update-available": { de: "Neue Version verfügbar:", en: "New version available:" },
  "label-language": { de: "Sprache", en: "Language" },
  "label-theme-mode": { de: "Modus", en: "Mode" },
  "pill-twitch-default": { de: "Twitch nicht verbunden", en: "Twitch not connected" },
  "pill-obs-default": { de: "OBS nicht verbunden", en: "OBS not connected" },
  "pill-server-unreachable": { de: "Server nicht erreichbar", en: "Server unreachable" },
  "pill-twitch-connected": { de: "Twitch", en: "Twitch" },
  "pill-twitch-connected-fallback": { de: "verbunden", en: "connected" },
  "pill-obs-connected": { de: "OBS verbunden", en: "OBS connected" },
  "topbar-eyebrow": { de: "Lokale Verwaltung", en: "Local management" },
  "topbar-title": { de: "Kartenpacks", en: "Card packs" },
  "btn-save": { de: "Speichern", en: "Save" },
  "ov-test-eyebrow": { de: "Testlauf", en: "Test run" },
  "ov-test-title": { de: "Animation auslösen", en: "Trigger animation" },
  "label-test-name": { de: "Testname", en: "Test name" },
  "label-test-booster": { de: "Booster", en: "Booster" },
  "label-test-card": { de: "Karte", en: "Card" },
  "option-random": { de: "Zufällig", en: "Random" },
  "btn-test-random": { de: "Demo zufällig ausführen", en: "Run random demo" },
  "btn-test-selected": { de: "Gewählte Karte öffnen", en: "Open selected card" },
  "hint-overlay-required": {
    de: "Das Overlay muss in OBS oder in einem Browser geöffnet sein, damit du die Animation siehst.",
    en: "The overlay must be open in OBS or a browser for you to see the animation."
  },
  "ov-status-eyebrow": { de: "Status", en: "Status" },
  "ov-deck-title": { de: "Deck-Übersicht", en: "Deck overview" },
  "metric-cards-label": { de: "Karten", en: "Cards" },
  "metric-enabled-label": { de: "aktiv", en: "active" },
  "btn-reset-collections": { de: "Sammlungen leeren", en: "Clear collections" },
  "btn-reset-settings": { de: "Beispielwerte laden", en: "Load sample values" },
  "cards-eyebrow": { de: "Deck", en: "Deck" },
  "cards-title": { de: "Karten verwalten", en: "Manage cards" },
  "btn-add-card": { de: "Karte hinzufügen", en: "Add card" },
  "cards-live-preview": { de: "Live Vorschau", en: "Live preview" },
  "aria-select-card": { de: "Karte auswählen", en: "Select card" },
  "label-card-title": { de: "Titel", en: "Title" },
  "label-card-rarity": { de: "Rarität", en: "Rarity" },
  "label-card-weight": { de: "Gewichtung", en: "Weight" },
  "label-card-stars": { de: "Sterne", en: "Stars" },
  "label-card-accent": { de: "Akzent", en: "Accent" },
  "label-card-enabled": { de: "Aktiv", en: "Active" },
  "label-card-image": { de: "Bild", en: "Image" },
  "btn-duplicate": { de: "Duplizieren", en: "Duplicate" },
  "btn-remove-image": { de: "Bild entfernen", en: "Remove image" },
  "btn-delete": { de: "Löschen", en: "Delete" },
  "rarity-common": { de: "Gewöhnlich", en: "Common" },
  "rarity-uncommon": { de: "Ungewöhnlich", en: "Uncommon" },
  "rarity-rare": { de: "Selten", en: "Rare" },
  "rarity-epic": { de: "Episch", en: "Epic" },
  "rarity-legendary": { de: "Legendär", en: "Legendary" },
  "rarity-holo": { de: "Holo", en: "Holo" },
  "rarity-colors-eyebrow": { de: "Karten", en: "Cards" },
  "rarity-colors-title": { de: "Rahmenfarben je Rarität", en: "Border colors per rarity" },
  "btn-reset-rarity-colors": { de: "Auf Standard zurücksetzen", en: "Reset to defaults" },
  "notice-rarity-colors-reset": { de: "Rahmenfarben zurückgesetzt.", en: "Border colors reset." },
  "booster-eyebrow": { de: "Packs", en: "Packs" },
  "booster-title": { de: "Booster verwalten", en: "Manage boosters" },
  "btn-add-booster": { de: "Booster hinzufügen", en: "Add booster" },
  "booster-pack-eyebrow": { de: "Pack", en: "Pack" },
  "booster-design-title": { de: "Booster gestalten", en: "Design booster" },
  "label-booster-title": { de: "Titel", en: "Title" },
  "label-booster-subtitle": { de: "Untertitel", en: "Subtitle" },
  "label-booster-score": { de: "Booster-Score", en: "Booster score" },
  "label-booster-accent": { de: "Akzentfarbe", en: "Accent color" },
  "label-booster-image": { de: "Booster-Bild", en: "Booster image" },
  "btn-remove-booster-image": { de: "Booster-Bild entfernen", en: "Remove booster image" },
  "btn-delete-booster": { de: "Booster löschen", en: "Delete booster" },
  "confirm-delete-booster": {
    de: "Booster wirklich löschen? Zugewiesene Karten werden frei für andere Booster.",
    en: "Really delete this booster? Assigned cards become available for other boosters again."
  },
  "error-delete-last-booster": { de: "Der letzte Booster kann nicht gelöscht werden.", en: "The last booster can't be deleted." },
  "notice-booster-deleted": { de: "Booster gelöscht.", en: "Booster deleted." },
  "label-assigned-cards": { de: "Zugewiesene Karten", en: "Assigned cards" },
  "hint-card-taken": { de: "Bereits zugewiesen zu", en: "Already assigned to" },
  "warn-max-cards": { de: "Maximal 9 Karten pro Booster.", en: "Maximum 9 cards per booster." },
  "twitch-title": { de: "Verbindung", en: "Connection" },
  "status-not-connected": { de: "Nicht verbunden", en: "Not connected" },
  "status-connected-as": { de: "Verbunden als", en: "Connected as" },
  "status-error": { de: "Statusfehler:", en: "Status error:" },
  "error-missing-client-id": { de: "Bitte Twitch App Client-ID eintragen.", en: "Please enter a Twitch app client ID." },
  "status-login-opened": {
    de: "Twitch-Anmeldung im Browser geöffnet. Nach der Freigabe hier Status prüfen.",
    en: "Twitch sign-in opened in your browser. Check the status here once you've approved it."
  },
  "error-login-failed": { de: "Twitch Login konnte nicht gestartet werden:", en: "Could not start Twitch sign-in:" },
  "notice-twitch-connected": { de: "Twitch verbunden.", en: "Twitch connected." },
  "notice-twitch-disconnected": {
    de: "Twitch abgemeldet. Das lokale OAuth-Token wurde gelöscht.",
    en: "Signed out of Twitch. The local OAuth token was deleted."
  },
  "btn-connect-twitch": { de: "Mit Twitch anmelden", en: "Sign in with Twitch" },
  "btn-refresh-twitch-status": { de: "Status prüfen", en: "Check status" },
  "btn-disconnect-twitch": { de: "Abmelden", en: "Sign out" },
  "cp-title": { de: "Belohnungen verwalten", en: "Manage rewards" },
  "btn-load-rewards": { de: "Channelpoints laden", en: "Load channel points" },
  "btn-new-reward": { de: "Neu", en: "New" },
  "option-select-reward": { de: "Reward auswählen", en: "Select reward" },
  "label-reward-select": { de: "Vorhandene Belohnung", en: "Existing reward" },
  "label-reward-title": { de: "Reward-Titel", en: "Reward title" },
  "label-reward-cost": { de: "Kosten", en: "Cost" },
  "label-reward-prompt": { de: "Beschreibung", en: "Description" },
  "btn-sync-reward": { de: "Speichern / aktualisieren", en: "Save / update" },
  "btn-delete-reward": { de: "Löschen", en: "Delete" },
  "hint-reward-assign": {
    de: "Die ausgewählte oder neu erstellte Belohnung wird dem aktuell gewählten Booster zugeordnet.",
    en: "The selected or newly created reward is assigned to the currently selected booster."
  },
  "status-loading-rewards": { de: "Lade Channelpoints...", en: "Loading channel points..." },
  "status-rewards-loaded": { de: "Channelpoints geladen", en: "channel points loaded" },
  "error-rewards-load-failed": { de: "Rewards konnten nicht geladen werden:", en: "Could not load rewards:" },
  "status-saving-reward": { de: "Speichere Channelpoint...", en: "Saving channel point..." },
  "notice-reward-saved": {
    de: "Channelpoint wurde gespeichert und dem Booster zugeordnet.",
    en: "Channel point was saved and assigned to the booster."
  },
  "error-select-reward-first": { de: "Bitte zuerst eine Belohnung auswählen.", en: "Please select a reward first." },
  "status-deleting-reward": { de: "Lösche Channelpoint...", en: "Deleting channel point..." },
  "notice-reward-deleted": { de: "Channelpoint gelöscht.", en: "Channel point deleted." },
  "notice-reward-applied": { de: "Reward für diesen Booster übernommen.", en: "Reward applied to this booster." },
  "status-not-tested": { de: "Nicht getestet", en: "Not tested" },
  "status-testing-obs": { de: "Teste OBS...", en: "Testing OBS..." },
  "error-obs-not-connected": { de: "OBS nicht verbunden:", en: "OBS not connected:" },
  "status-setting-up-obs": { de: "Richte OBS ein...", en: "Setting up OBS..." },
  "status-obs-updated": { de: "OBS aktualisiert:", en: "OBS updated:" },
  "error-obs-setup-failed": { de: "OBS Setup fehlgeschlagen:", en: "OBS setup failed:" },
  "notice-obs-scene-updated": {
    de: "OBS Szene und Browserquelle wurden erstellt oder aktualisiert.",
    en: "OBS scene and browser source were created or updated."
  },
  "label-obs-check": { de: "OBS WebSocket Verbindung prüfen", en: "Check OBS WebSocket connection" },
  "label-obs-password": { de: "Passwort", en: "Password" },
  "label-obs-scene": { de: "Szenenname", en: "Scene name" },
  "label-obs-source": { de: "Quellenname", en: "Source name" },
  "btn-test-obs": { de: "OBS testen", en: "Test OBS" },
  "btn-setup-obs": { de: "OBS Szene aktualisieren", en: "Update OBS scene" },
  "users-eyebrow": { de: "Sammlung", en: "Collection" },
  "users-title": { de: "Nutzer verwalten", en: "Manage users" },
  "placeholder-user-search": { de: "Nutzer suchen...", en: "Search users..." },
  "hint-users-empty": {
    de: "Noch keine Sammlungen vorhanden. Sobald Nutzer Karten ziehen, erscheinen sie hier.",
    en: "No collections yet. As soon as users draw cards, they'll show up here."
  },
  "hint-no-users-found": { de: "Keine Nutzer gefunden für", en: "No users found for" },
  "hint-no-cards-drawn": { de: "Keine Karten gezogen.", en: "No cards drawn." },
  "unit-cards": { de: "Karten", en: "cards" },
  "btn-delete-user": { de: "Nutzer löschen", en: "Delete user" },
  "notice-user-deleted": { de: "Nutzer gelöscht.", en: "User deleted." },
  "design-look-title": { de: "Farben und Anzeige", en: "Colors and display" },
  "label-font": { de: "Schrift", en: "Font" },
  "label-accent": { de: "Akzent", en: "Accent" },
  "label-text-color": { de: "Text", en: "Text" },
  "label-secondary-color": { de: "Sekundär", en: "Secondary" },
  "label-volume": { de: "Lautstärke", en: "Volume" },
  "label-preview-eyebrow": { de: "Vorschau", en: "Preview" },
  "label-show-collection": { de: "Sammlungsleiste anzeigen", en: "Show collection bar" },
  "label-card-borders": { de: "Kartenrahmen anzeigen", en: "Show card borders" },
  "label-reveal-seconds": { de: "Karte sichtbar in Sekunden", en: "Card visible (seconds)" },
  "label-cooldown-seconds": { de: "Cooldown in Sekunden", en: "Cooldown (seconds)" },
  "label-backs-before-reveal": { de: "Verdeckte Karten vor Reveal", en: "Face-down cards before reveal" },
  "label-sound-open": { de: "Öffnen-Sound", en: "Open sound" },
  "label-sound-reveal": { de: "Reveal-Sound", en: "Reveal sound" },
  "status-no-sound": { de: "Kein Sound ausgewählt", en: "No sound selected" },
  "status-sound-set": { de: "Sound gespeichert", en: "Sound saved" },
  "btn-play": { de: "▶ Abspielen", en: "▶ Play" },
  "btn-choose-file": { de: "Auswählen", en: "Choose file" },
  "btn-remove": { de: "Entfernen", en: "Remove" },
  "notice-sound-open-saved": { de: "Öffnen-Sound gespeichert.", en: "Open sound saved." },
  "notice-sound-reveal-saved": { de: "Reveal-Sound gespeichert.", en: "Reveal sound saved." },
  "notice-sound-open-removed": { de: "Öffnen-Sound entfernt.", en: "Open sound removed." },
  "notice-sound-reveal-removed": { de: "Reveal-Sound entfernt.", en: "Reveal sound removed." },
  "error-sound-play-failed": { de: "Sound konnte nicht abgespielt werden:", en: "Sound could not be played:" },
  "notice-saved": {
    de: "Gespeichert. Das Overlay aktualisiert sich automatisch.",
    en: "Saved. The overlay updates automatically."
  },
  "notice-collections-cleared": { de: "Sammlungen geleert.", en: "Collections cleared." },
  "notice-samples-loaded": { de: "Beispielwerte geladen.", en: "Sample values loaded." }
};

function t(key) {
  const lang = settings?.language === "en" ? "en" : "de";
  return I18N[key]?.[lang] ?? I18N[key]?.de ?? key;
}

function applyTranslations() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const text = t(el.dataset.i18n);
    const textNode = [...el.childNodes].find((node) => node.nodeType === Node.TEXT_NODE);
    if (textNode) textNode.textContent = text;
    else el.textContent = text;
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
}

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function showNotice(text, tone = "ok") {
  const notice = $("#notice");
  notice.textContent = text;
  notice.dataset.tone = tone;
  notice.hidden = false;
  clearTimeout(showNotice.timer);
  showNotice.timer = setTimeout(() => {
    notice.hidden = true;
  }, 3400);
}

function setStatus(id, text, tone = "neutral") {
  const node = $(id);
  if (!node) return;
  node.textContent = text;
  node.dataset.tone = tone;
}

function setPill(id, text, connected = false) {
  const node = $(id);
  if (!node) return;
  node.textContent = text;
  node.classList.toggle("is-error", !connected);
  node.classList.toggle("is-ok", connected);
}

function scheduleAutoSave() {
  if (!autoSaveReady || !settings) return;
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(async () => {
    try {
      await saveSettings(settings);
    } catch (error) {
      showNotice(error.message, "error");
    }
  }, 650);
}

function selectedCard() {
  return settings.deck.cards.find((card) => card.id === selectedCardId) || settings.deck.cards[0];
}

function selectedBooster() {
  return settings.boosters.find((booster) => booster.id === selectedBoosterId) || settings.boosters[0];
}

function blankCard() {
  const boosterId = selectedBoosterId || settings.boosters?.[0]?.id || "default";
  return {
    id: createId("card"),
    title: "Neue Karte",
    subtitle: "Stream Card",
    rarity: "common",
    stars: 1,
    accent: "#ff78bb",
    enabled: true,
    image: "",
    boosterIds: [boosterId]
  };
}

function blankBooster() {
  const id = createId("booster");
  return {
    id,
    title: "Neuer Booster",
    subtitle: "Pack",
    image: "",
    accent: "#ff78bb",
    score: 100,
    rewardNames: [],
    rewardIds: [],
    customEvents: [],
    cardIds: []
  };
}

function randomUsername() {
  const names = ["Mira", "Nova", "Pixel", "Luna", "Kaito", "Nox", "Juno", "Ari", "Mika", "Echo"];
  return `${names[Math.floor(Math.random() * names.length)]}${Math.floor(100 + Math.random() * 900)}`;
}

let appVersionInfo = null;

function compareVersions(a, b) {
  const partsA = String(a || "0").replace(/^v/i, "").split(".").map(Number);
  const partsB = String(b || "0").replace(/^v/i, "").split(".").map(Number);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const diff = (partsA[i] || 0) - (partsB[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

async function hydrateUpdateTab() {
  appVersionInfo = await getVersion();
  $("#update-current-version").textContent = appVersionInfo.version;
  $("#update-current-date").textContent = appVersionInfo.releaseDate;
}

let pendingUpdateAssetUrl = null;

async function checkForUpdate({ silent = false } = {}) {
  if (!appVersionInfo) appVersionInfo = await getVersion();
  if (!silent) setStatus("#update-status", t("update-status-checking"), "neutral");
  try {
    const release = await getLatestRelease(appVersionInfo.repo);
    const latestVersion = String(release.tag_name || "").replace(/^v/i, "");
    const installButton = $("#install-update");
    const asset = (release.assets || []).find((item) => (item.name || "").toLowerCase().endsWith(".zip"));
    pendingUpdateAssetUrl = asset?.browser_download_url || null;
    if (compareVersions(latestVersion, appVersionInfo.version) > 0) {
      setStatus("#update-status", `${t("update-status-available")} v${latestVersion}`, "warn");
      if (installButton) installButton.hidden = !pendingUpdateAssetUrl;
      showUpdateBanner(latestVersion);
    } else {
      setStatus("#update-status", t("update-status-current"), "ok");
      if (installButton) installButton.hidden = true;
      hideUpdateBanner();
    }
  } catch (error) {
    if (!silent) setStatus("#update-status", `${t("update-status-error")} ${error.message}`, "error");
  }
}

async function installPendingUpdate() {
  if (!pendingUpdateAssetUrl) {
    setStatus("#update-status", t("error-no-update-asset"), "error");
    return;
  }
  if (!window.confirm(t("confirm-install-update"))) return;
  setStatus("#update-status", t("update-status-installing"), "neutral");
  try {
    await installUpdate(pendingUpdateAssetUrl);
  } catch (error) {
    setStatus("#update-status", `${t("update-status-install-failed")} ${error.message}`, "error");
  }
}

function showUpdateBanner(latestVersion) {
  const banner = $("#update-banner");
  if (!banner) return;
  banner.innerHTML = `${t("banner-update-available")} v${latestVersion} — <a href="#" data-action="goto-update">${t("btn-goto-update")}</a>`;
  banner.hidden = false;
}

function hideUpdateBanner() {
  const banner = $("#update-banner");
  if (banner) banner.hidden = true;
}

function bindUpdateTab() {
  $("#check-update").addEventListener("click", () => checkForUpdate());
  $("#install-update").addEventListener("click", installPendingUpdate);
  const banner = $("#update-banner");
  if (banner) {
    banner.addEventListener("click", (event) => {
      const link = event.target.closest("[data-action='goto-update']");
      if (!link) return;
      event.preventDefault();
      $(".nav-button[data-tab='update']")?.click();
    });
  }
}

let logEntries = [];

async function loadLogs() {
  const result = await getLogs();
  logEntries = result.logs || [];
}

function formatLogTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(settings?.language === "en" ? "en-US" : "de-DE");
}

function renderLogs() {
  const list = $("#log-list");
  if (!list) return;
  const filter = ($("#log-search")?.value || "").trim().toLowerCase();
  $("#log-empty-hint").hidden = logEntries.length > 0;
  const filtered = filter
    ? logEntries.filter((entry) => `${entry.category} ${entry.level} ${entry.message}`.toLowerCase().includes(filter))
    : logEntries;
  if (!filtered.length) {
    list.innerHTML = filter ? `<p class="hint">${t("hint-no-log-found")} „${escapeHtml(filter)}“.</p>` : "";
    return;
  }
  list.innerHTML = filtered.slice().reverse().map((entry) => `
    <div class="log-row" data-level="${escapeHtml(entry.level || "info")}">
      <time>${escapeHtml(formatLogTimestamp(entry.timestamp))}</time>
      <span class="log-category">${escapeHtml(entry.category || "")}</span>
      <span class="log-level">${escapeHtml(entry.level || "")}</span>
      <span class="log-message">${escapeHtml(entry.message || "")}</span>
    </div>
  `).join("");
}

function exportLogs() {
  const lines = logEntries.map((entry) => `${entry.timestamp}\t${entry.category}\t${entry.level}\t${entry.message}`);
  const blob = new Blob([lines.join("\n")], { type: "text/plain" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `streamer-card-widget-log-${new Date().toISOString().slice(0, 10)}.txt`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function bindLogTab() {
  $("#log-search").addEventListener("input", renderLogs);
  $("#export-logs").addEventListener("click", exportLogs);
  $("#clear-logs").addEventListener("click", async () => {
    await clearLogs();
    logEntries = [];
    renderLogs();
    showNotice(t("notice-log-cleared"));
  });
}

function bindTabs() {
  $$(".nav-button").forEach((button) => {
    button.addEventListener("click", async () => {
      $$(".nav-button").forEach((item) => item.classList.toggle("is-active", item === button));
      $$(".tab-panel").forEach((panel) => panel.classList.toggle("is-active", panel.dataset.panel === button.dataset.tab));
      if (button.dataset.tab === "users") {
        await loadUsers();
        renderUsers();
      }
      if (button.dataset.tab === "log") {
        await loadLogs();
        renderLogs();
      }
    });
  });
}

function renderRewardSelect() {
  const select = $("#reward-select");
  select.innerHTML = `<option value="">${t("option-select-reward")}</option>${availableRewards.map((reward) => `
    <option value="${escapeHtml(reward.id || "")}" data-title="${escapeHtml(reward.title || "")}" data-cost="${escapeHtml(reward.cost || 1)}" data-prompt="${escapeHtml(reward.prompt || "")}">
      ${escapeHtml(reward.title || reward.id)}
    </option>
  `).join("")}`;
}

async function refreshTwitchStatus() {
  try {
    const result = await getTwitchStatus();
    const status = result.status || {};
    if (status.connected) {
      setStatus("#twitch-status", `${t("status-connected-as")} ${status.displayName || status.login || "Twitch"}`, "ok");
      setPill("#twitch-pill", `${t("pill-twitch-connected")}: ${status.displayName || status.login || t("pill-twitch-connected-fallback")}`, true);
    } else {
      setStatus("#twitch-status", t("status-not-connected"), "neutral");
      setPill("#twitch-pill", t("pill-twitch-default"), false);
    }
  } catch (error) {
    setStatus("#twitch-status", `${t("status-error")} ${error.message}`, "error");
  }
}

async function connectTwitch() {
  settings.twitch ||= {};
  const clientId = String(settings.twitch.clientId || DEFAULT_TWITCH_CLIENT_ID).trim();
  if (!clientId) {
    setStatus("#twitch-status", t("error-missing-client-id"), "error");
    return;
  }
  try {
    settings.twitch.clientId = clientId;
    await saveSettings(settings);
    const state = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    sessionStorage.setItem("cardpack_twitch_state", state);
    const url = new URL("https://id.twitch.tv/oauth2/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", "http://localhost:5377/twitch-callback.html");
    url.searchParams.set("response_type", "token");
    url.searchParams.set("scope", TWITCH_REQUIRED_SCOPES);
    url.searchParams.set("force_verify", "true");
    url.searchParams.set("state", state);
    window.open(url.toString(), "_blank");
    pollTwitchStatusAfterLogin();
    setStatus("#twitch-status", t("status-login-opened"), "neutral");
  } catch (error) {
    setStatus("#twitch-status", `${t("error-login-failed")} ${error.message}`, "error");
  }
}

let twitchPollTimer;
function pollTwitchStatusAfterLogin() {
  clearInterval(twitchPollTimer);
  let attempts = 0;
  twitchPollTimer = setInterval(async () => {
    attempts += 1;
    try {
      const result = await getTwitchStatus();
      if (result?.status?.connected) {
        clearInterval(twitchPollTimer);
        await refreshTwitchStatus();
        showNotice(t("notice-twitch-connected"));
        return;
      }
    } catch {
    }
    if (attempts >= 30) clearInterval(twitchPollTimer);
  }, 2000);
}

async function handleTwitchDisconnect() {
  try {
    await disconnectTwitch();
    settings = normalizeSettings(await getSettings());
    hydrateTrigger();
    await refreshTwitchStatus();
    showNotice(t("notice-twitch-disconnected"));
  } catch (error) {
    setStatus("#twitch-status", error.message, "error");
  }
}

async function loadTwitchRewards() {
  setStatus("#twitch-status", t("status-loading-rewards"), "neutral");
  try {
    const result = await getTwitchRewards();
    availableRewards = (result.rewards || []).map((reward) => ({
      id: String(reward.id || ""),
      title: String(reward.title || reward.name || reward.id || ""),
      cost: Number(reward.cost || 1),
      prompt: String(reward.prompt || "")
    }));
    renderRewardSelect();
    setStatus("#twitch-status", `${availableRewards.length} ${t("status-rewards-loaded")}`, "ok");
  } catch (error) {
    setStatus("#twitch-status", `${t("error-rewards-load-failed")} ${error.message}`, "error");
  }
}

async function handleRewardSync() {
  const booster = selectedBooster();
  if (!booster) return;
  setStatus("#twitch-status", t("status-saving-reward"), "neutral");
  try {
    const rewardId = $("#reward-select").value || "";
    const result = await syncTwitchReward({
      boosterId: booster.id,
      rewardId,
      title: $("#reward-title").value || booster.title || "Kartenpack",
      cost: Number($("#reward-cost").value || 1),
      prompt: $("#reward-prompt").value || ""
    });
    settings = normalizeSettings(result.settings || await getSettings());
    selectedBoosterId = booster.id;
    hydrateTrigger();
    await loadTwitchRewards();
    showNotice(t("notice-reward-saved"));
  } catch (error) {
    setStatus("#twitch-status", error.message, "error");
  }
}

async function handleRewardDelete() {
  const rewardId = $("#reward-select").value || "";
  if (!rewardId) {
    setStatus("#twitch-status", t("error-select-reward-first"), "error");
    return;
  }
  setStatus("#twitch-status", t("status-deleting-reward"), "neutral");
  try {
    const result = await deleteTwitchReward({ rewardId });
    settings = normalizeSettings(result.settings || await getSettings());
    clearRewardForm();
    await loadTwitchRewards();
    showNotice(t("notice-reward-deleted"));
  } catch (error) {
    setStatus("#twitch-status", error.message, "error");
  }
}

function clearRewardForm() {
  $("#reward-select").value = "";
  $("#reward-title").value = selectedBooster()?.title || "Kartenpack";
  $("#reward-cost").value = selectedBooster()?.rewardCost || 1;
  $("#reward-prompt").value = "";
}

async function sha256Base64(value) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  let binary = "";
  new Uint8Array(hash).forEach((byte) => binary += String.fromCharCode(byte));
  return btoa(binary);
}

async function obsAuth(password, salt, challenge) {
  const secret = await sha256Base64(password + salt);
  return sha256Base64(secret + challenge);
}

function openObsSocket(timeoutMs = 2800) {
  return new Promise((resolve, reject) => {
    const obs = settings.obs || {};
    const ws = new WebSocket(`ws://${obs.host || "127.0.0.1"}:${obs.port || 4455}`);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error("Timeout bei OBS."));
    }, timeoutMs);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("OBS WebSocket nicht erreichbar."));
    });
  });
}

function waitForObsMessage(ws, predicate, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", handler);
      reject(new Error("OBS hat nicht rechtzeitig geantwortet."));
    }, timeoutMs);
    const handler = (event) => {
      const message = JSON.parse(event.data);
      if (!predicate(message)) return;
      clearTimeout(timer);
      ws.removeEventListener("message", handler);
      resolve(message);
    };
    ws.addEventListener("message", handler);
  });
}

async function connectObs() {
  const ws = await openObsSocket();
  const hello = await waitForObsMessage(ws, (message) => message.op === 0, 2500);
  const identify = { op: 1, d: { rpcVersion: hello.d?.rpcVersion || 1 } };
  if (hello.d?.authentication) {
    if (!settings.obs?.password) throw new Error("OBS verlangt ein Passwort.");
    identify.d.authentication = await obsAuth(settings.obs.password, hello.d.authentication.salt, hello.d.authentication.challenge);
  }
  ws.send(JSON.stringify(identify));
  const identified = await waitForObsMessage(ws, (message) => message.op === 2, 2500);
  if (identified.op !== 2) throw new Error("OBS hat die Verbindung nicht akzeptiert.");
  return ws;
}

function obsRequest(ws, requestType, requestData = {}, timeoutMs = 4000) {
  const requestId = `obs-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
  return waitForObsMessage(ws, (message) => message.op === 7 && message.d?.requestId === requestId, timeoutMs)
    .then((message) => {
      const status = message.d?.requestStatus || {};
      if (!status.result) throw new Error(status.comment || `${requestType} fehlgeschlagen.`);
      return message.d?.responseData || {};
    });
}

let lastObsConnected = null;

async function testObsConnection() {
  setStatus("#obs-status", t("status-testing-obs"), "neutral");
  let ws;
  try {
    ws = await connectObs();
    setStatus("#obs-status", t("pill-obs-connected"), "ok");
    setPill("#obs-pill", t("pill-obs-connected"), true);
    settings.obs ||= {};
    settings.obs.enabled = true;
    await saveSettings(settings);
    if (lastObsConnected !== true) addLog("obs", "info", "OBS verbunden.");
    lastObsConnected = true;
  } catch (error) {
    setStatus("#obs-status", `${t("error-obs-not-connected")} ${error.message}`, "error");
    setPill("#obs-pill", t("pill-obs-default"), false);
    if (lastObsConnected !== false) addLog("obs", "error", `OBS-Verbindung fehlgeschlagen: ${error.message}`);
    lastObsConnected = false;
  } finally {
    try { ws?.close(); } catch {}
  }
}

async function setupObsOverlay() {
  setStatus("#obs-status", t("status-setting-up-obs"), "neutral");
  let ws;
  try {
    await saveSettings(settings);
    ws = await connectObs();
    const obs = settings.obs || {};
    const sceneName = obs.sceneName || "Streamer Card Overlay";
    const sourceName = obs.sourceName || "Streamer Card Widget";
    const overlayUrl = currentOriginUrl("/overlay.html");

    const scenes = await obsRequest(ws, "GetSceneList");
    if (!(scenes.scenes || []).some((scene) => scene.sceneName === sceneName)) {
      await obsRequest(ws, "CreateScene", { sceneName });
    }

    const inputs = await obsRequest(ws, "GetInputList");
    const sourceExists = (inputs.inputs || []).some((input) => input.inputName === sourceName);
    const inputSettings = {
      url: overlayUrl,
      width: 1920,
      height: 1080,
      fps: 60,
      shutdown: false,
      restart_when_active: true,
      reroute_audio: false
    };

    if (!sourceExists) {
      try {
        await obsRequest(ws, "CreateInput", {
          sceneName,
          inputName: sourceName,
          inputKind: "browser_source",
          inputSettings,
          sceneItemEnabled: true
        });
      } catch {
        await obsRequest(ws, "CreateInput", {
          sceneName,
          inputName: sourceName,
          inputKind: "obs_browser_source",
          inputSettings,
          sceneItemEnabled: true
        });
      }
    } else {
      await obsRequest(ws, "SetInputSettings", {
        inputName: sourceName,
        inputSettings,
        overlay: true
      });
    }

    let item;
    try {
      item = await obsRequest(ws, "GetSceneItemId", { sceneName, sourceName });
    } catch {
      await obsRequest(ws, "CreateSceneItem", { sceneName, sourceName, sceneItemEnabled: true });
      item = await obsRequest(ws, "GetSceneItemId", { sceneName, sourceName });
    }
    await obsRequest(ws, "SetSceneItemTransform", {
      sceneName,
      sceneItemId: item.sceneItemId,
      sceneItemTransform: {
        positionX: 0,
        positionY: 0,
        scaleX: 1,
        scaleY: 1,
        cropTop: 0,
        cropRight: 0,
        cropBottom: 0,
        cropLeft: 0,
        boundsType: "OBS_BOUNDS_STRETCH",
        boundsWidth: 1920,
        boundsHeight: 1080
      }
    });

    setStatus("#obs-status", `${t("status-obs-updated")} ${sceneName} / ${sourceName}`, "ok");
    setPill("#obs-pill", t("pill-obs-connected"), true);
    settings.obs.enabled = true;
    await saveSettings(settings);
    showNotice(t("notice-obs-scene-updated"));
  } catch (error) {
    setStatus("#obs-status", `${t("error-obs-setup-failed")} ${error.message}`, "error");
  } finally {
    try { ws?.close(); } catch {}
  }
}

function renderOverview() {
  const booster = selectedBooster();
  const cards = booster ? cardsForBooster(settings, booster) : [];
  const enabled = cards.filter((card) => card.enabled !== false);
  if ($("#metric-card-count")) $("#metric-card-count").textContent = cards.length;
  if ($("#metric-enabled")) $("#metric-enabled").textContent = enabled.length;
  if ($("#overview-preview")) $("#overview-preview").innerHTML = (selectedCard() || cards[0]) ? cardMarkup(selectedCard() || cards[0]) : "";

  if ($("#test-booster")) {
    $("#test-booster").innerHTML = `<option value="">${t("option-random")}</option>` + settings.boosters
      .map((item) => `<option value="${item.id}" ${item.id === selectedBoosterId ? "selected" : ""}>${escapeHtml(item.title)}</option>`)
      .join("");
  }
  if ($("#test-card")) {
    $("#test-card").innerHTML = `<option value="">${t("option-random")}</option>${cards
      .map((card) => `<option value="${card.id}">${escapeHtml(card.title)}</option>`)
      .join("")}`;
  }
}

function renderCards() {
  $("#card-list").innerHTML = settings.deck.cards.map((card, index) => {
    const active = card.id === selectedCardId ? " is-selected" : "";
    return `
      <article class="card-editor${active}" data-card-id="${card.id}">
        <button class="select-card" type="button" aria-label="${t("aria-select-card")}">${cardMarkup(card, { compact: true })}</button>
        <div class="card-fields">
          <div class="inline-fields">
            <label>${t("label-card-title")}<input data-field="title" type="text" value="${escapeHtml(card.title || "")}"></label>
            <label>${t("label-card-rarity")}<select data-field="rarity">${RARITIES.map((rarity) => `
              <option value="${rarity.id}" ${rarity.id === card.rarity ? "selected" : ""}>${t(`rarity-${rarity.id}`)} (${rarity.weight})</option>
            `).join("")}</select></label>
          </div>
          <div class="inline-fields">
            <label>${t("label-card-weight")}<input type="text" value="${rarityWeight(card)}" readonly></label>
            <label>${t("label-card-stars")}<input data-field="stars" type="number" min="1" max="5" step="1" value="${card.stars || 1}"></label>
            <label>${t("label-card-accent")}<input data-field="accent" type="color" value="${escapeHtml(card.accent || "#ff78bb")}"></label>
          </div>
          <div class="card-actions">
            <label class="switch-row compact-switch"><input data-field="enabled" type="checkbox" ${card.enabled !== false ? "checked" : ""}><span>${t("label-card-enabled")}</span></label>
            <label class="secondary-button file-label">${t("label-card-image")}<input data-action="image" type="file" accept="image/*"></label>
              <button class="ghost-button" data-action="duplicate" type="button">${t("btn-duplicate")}</button>
              <button class="ghost-button" data-action="clear-image" type="button">${t("btn-remove-image")}</button>
              <button class="danger-button" data-action="delete" type="button" ${settings.deck.cards.length <= 1 ? "disabled" : ""}>${t("btn-delete")}</button>
          </div>
        </div>
        <span class="order-badge">${index + 1}</span>
      </article>
    `;
  }).join("");
  refreshPreviews();
}

function refreshPreviews() {
  $("#selected-card-preview").innerHTML = selectedCard() ? cardMarkup(selectedCard()) : "";
  renderBoosters();
  renderOverview();
}

function updateCard(cardId, field, value, inputType) {
  const card = settings.deck.cards.find((item) => item.id === cardId);
  if (!card) return;
  if (inputType === "checkbox") card[field] = Boolean(value);
  else if (["stars"].includes(field)) card[field] = Number(value);
  else card[field] = value;
  const editor = $(`.card-editor[data-card-id="${cardId}"]`);
  if (editor) editor.querySelector(".select-card").innerHTML = cardMarkup(card, { compact: true });
  refreshPreviews();
}

async function handleCardListClick(event) {
  const editor = event.target.closest(".card-editor");
  if (!editor) return;
  const cardId = editor.dataset.cardId;
  const action = event.target.dataset.action;
  if (event.target.closest(".select-card")) {
    selectedCardId = cardId;
    renderCards();
    return;
  }
  if (action === "duplicate") {
    const original = settings.deck.cards.find((card) => card.id === cardId);
    const copy = { ...original, id: createId("card"), title: `${original.title} Kopie` };
    settings.deck.cards.push(copy);
    for (const booster of settings.boosters) {
      if ((original.boosterIds || []).includes(booster.id) && booster.cardIds.length < 9) booster.cardIds.push(copy.id);
    }
    selectedCardId = copy.id;
    renderCards();
  }
  if (action === "delete" && settings.deck.cards.length > 1) {
    settings.deck.cards = settings.deck.cards.filter((card) => card.id !== cardId);
    settings.boosters.forEach((booster) => {
      booster.cardIds = (booster.cardIds || []).filter((id) => id !== cardId);
    });
    selectedCardId = settings.deck.cards[0]?.id;
    renderCards();
  }
  if (action === "clear-image") {
    const card = settings.deck.cards.find((item) => item.id === cardId);
    if (card) {
      card.image = "";
      renderCards();
      scheduleAutoSave();
    }
  }
}

async function handleCardListChange(event) {
  const editor = event.target.closest(".card-editor");
  if (!editor) return;
  const cardId = editor.dataset.cardId;
  const field = event.target.dataset.field;
  const action = event.target.dataset.action;
  if (field) updateCard(cardId, field, event.target.type === "checkbox" ? event.target.checked : event.target.value, event.target.type);
  if (action === "image" && event.target.files?.[0]) {
    const card = settings.deck.cards.find((item) => item.id === cardId);
    card.image = await readFileAsDataUrl(event.target.files[0]);
    event.target.value = "";
    const editorNode = $(`.card-editor[data-card-id="${cardId}"]`);
    if (editorNode) editorNode.querySelector(".select-card").innerHTML = cardMarkup(card, { compact: true });
    refreshPreviews();
    scheduleAutoSave();
  }
}

function renderBoosterList() {
  $("#booster-list").innerHTML = settings.boosters.map((booster) => `
    <button class="booster-list-item ${booster.id === selectedBoosterId ? "is-selected" : ""}" data-booster-id="${booster.id}" type="button">
      <span>${escapeHtml(booster.title)}</span>
      <small>${(booster.cardIds || []).length}/9 ${t("unit-cards")}</small>
    </button>
  `).join("");
}

function ownerBoosterByCardId() {
  const owner = new Map();
  for (const booster of settings.boosters) {
    for (const cardId of booster.cardIds || []) owner.set(cardId, booster);
  }
  return owner;
}

function renderBoosterCards() {
  const booster = selectedBooster();
  const assigned = new Set(booster.cardIds || []);
  const owner = ownerBoosterByCardId();
  $("#assigned-count").textContent = `${assigned.size}/9`;
  $("#assigned-cards").innerHTML = settings.deck.cards.map((card) => {
    const takenBy = owner.get(card.id);
    const lockedByOther = takenBy && takenBy.id !== booster.id;
    return `
      <label class="assignment-tile${lockedByOther ? " is-locked" : ""}" ${lockedByOther ? `title="${escapeHtml(t("hint-card-taken"))} ${escapeHtml(takenBy.title || "")}"` : ""}>
        <input type="checkbox" data-card-assignment="${card.id}" ${assigned.has(card.id) ? "checked" : ""} ${lockedByOther ? "disabled" : ""}>
        ${cardMarkup(card, { compact: true })}
        <span>${escapeHtml(card.title)}</span>
      </label>
    `;
  }).join("");
}

function renderBoosters() {
  renderBoosterList();
  renderBoosterCards();
}

function hydrateBooster() {
  const booster = selectedBooster();
  if (!booster) return;
  $("#booster-title").value = booster.title || "";
  $("#booster-subtitle").value = booster.subtitle || "";
  $("#booster-score").value = booster.score ?? 100;
  $("#booster-accent").value = booster.accent || "#ff78bb";
  $("#booster-preview").innerHTML = boosterMarkup(booster);
  renderBoosters();
  hydrateTrigger();
}

function bindBooster() {
  $("#add-booster").addEventListener("click", () => {
    const booster = blankBooster();
    settings.boosters.push(booster);
    selectedBoosterId = booster.id;
    hydrateBooster();
    renderOverview();
  });
  $("#booster-list").addEventListener("click", (event) => {
    const button = event.target.closest("[data-booster-id]");
    if (!button) return;
    selectedBoosterId = button.dataset.boosterId;
    hydrateBooster();
    renderOverview();
  });
  $("#delete-booster").addEventListener("click", () => {
    if (settings.boosters.length <= 1) {
      showNotice(t("error-delete-last-booster"), "error");
      return;
    }
    const booster = selectedBooster();
    if (!booster) return;
    if (!window.confirm(t("confirm-delete-booster"))) return;
    settings.boosters = settings.boosters.filter((item) => item.id !== booster.id);
    for (const card of settings.deck.cards) {
      if (card.boosterIds) card.boosterIds = card.boosterIds.filter((id) => id !== booster.id);
    }
    selectedBoosterId = settings.boosters[0]?.id;
    hydrateBooster();
    renderOverview();
    scheduleAutoSave();
    showNotice(t("notice-booster-deleted"));
  });
  $("#assigned-cards").addEventListener("change", (event) => {
    if (!event.target.matches("[data-card-assignment]")) return;
    const booster = selectedBooster();
    const cardId = event.target.dataset.cardAssignment;
    const card = settings.deck.cards.find((item) => item.id === cardId);
    const ids = new Set(booster.cardIds || []);
    if (event.target.checked) {
      if (ids.size >= 9 && !ids.has(cardId)) {
        event.target.checked = false;
        showNotice(t("warn-max-cards"), "warn");
        return;
      }
      ids.add(cardId);
      card.boosterIds ||= [];
      if (!card.boosterIds.includes(booster.id)) card.boosterIds.push(booster.id);
    } else {
      ids.delete(cardId);
      if (card?.boosterIds) card.boosterIds = card.boosterIds.filter((id) => id !== booster.id);
    }
    booster.cardIds = [...ids].slice(0, 9);
    renderBoosters();
    renderOverview();
  });
  $("#booster-title").addEventListener("input", (event) => {
    selectedBooster().title = event.target.value;
    hydrateBooster();
  });
  $("#booster-subtitle").addEventListener("input", (event) => {
    selectedBooster().subtitle = event.target.value;
    hydrateBooster();
  });
  $("#booster-score").addEventListener("input", (event) => {
    selectedBooster().score = Number(event.target.value || 1);
  });
  $("#booster-accent").addEventListener("input", (event) => {
    selectedBooster().accent = event.target.value;
    hydrateBooster();
  });
  $("#booster-image").addEventListener("change", async (event) => {
    if (!event.target.files?.[0]) return;
    selectedBooster().image = await readFileAsDataUrl(event.target.files[0]);
    // Re-selecting a file with the same name doesn't change the input's value, so
    // browsers won't fire "change" again next time unless we reset it now.
    event.target.value = "";
    hydrateBooster();
    scheduleAutoSave();
  });
  $("#remove-booster-image").addEventListener("click", () => {
    selectedBooster().image = "";
    hydrateBooster();
    scheduleAutoSave();
  });
}

function cardTitle(cardId) {
  return settings.deck?.cards?.find((card) => card.id === cardId)?.title || cardId;
}

function boosterTitle(boosterId) {
  return settings.boosters?.find((booster) => booster.id === boosterId)?.title || boosterId;
}

function buildUserIndex() {
  const index = new Map();
  for (const [boosterId, collection] of Object.entries(collections || {})) {
    const users = collection?.users || {};
    for (const [userKey, userData] of Object.entries(users)) {
      if (!index.has(userKey)) {
        index.set(userKey, { key: userKey, displayName: userData?.displayName || userKey, entries: [] });
      }
      const entry = index.get(userKey);
      entry.displayName = userData?.displayName || entry.displayName;
      for (const [cardId, count] of Object.entries(userData?.cards || {})) {
        entry.entries.push({ boosterId, cardId, count: Number(count) || 0 });
      }
    }
  }
  return [...index.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

async function loadUsers() {
  collections = await getCollections();
}

function renderUsers() {
  const list = $("#user-list");
  if (!list) return;
  const filter = ($("#user-search")?.value || "").trim().toLowerCase();
  const allUsers = buildUserIndex();
  const users = allUsers.filter((user) => !filter || user.displayName.toLowerCase().includes(filter) || user.key.includes(filter));
  $("#user-empty-hint").hidden = allUsers.length > 0;
  if (!users.length) {
    list.innerHTML = filter
      ? `<p class="hint">${t("hint-no-users-found")} „${escapeHtml(filter)}“.</p>`
      : "";
    return;
  }
  list.innerHTML = users.map((user) => {
    const total = user.entries.reduce((sum, entry) => sum + entry.count, 0);
    const groups = new Map();
    for (const entry of user.entries) {
      if (!groups.has(entry.boosterId)) groups.set(entry.boosterId, []);
      groups.get(entry.boosterId).push(entry);
    }
    const sortedGroups = [...groups.entries()].sort((a, b) => boosterTitle(a[0]).localeCompare(boosterTitle(b[0])));
    const rows = sortedGroups.length
      ? sortedGroups.map(([boosterId, entries]) => {
          const sortedEntries = [...entries].sort((a, b) => cardTitle(a.cardId).localeCompare(cardTitle(b.cardId)));
          const entryRows = sortedEntries.map((entry) => `
            <div class="user-card-row" data-booster="${escapeHtml(entry.boosterId)}" data-card="${escapeHtml(entry.cardId)}">
              <span>${escapeHtml(cardTitle(entry.cardId))}</span>
              <input type="number" min="0" step="1" value="${entry.count}"
                data-action="edit-count" data-user="${escapeHtml(user.key)}"
                data-booster="${escapeHtml(entry.boosterId)}" data-card="${escapeHtml(entry.cardId)}">
            </div>
          `).join("");
          return `
            <div class="user-card-booster-group">
              <p class="user-card-booster-title">${escapeHtml(boosterTitle(boosterId))}</p>
              ${entryRows}
            </div>
          `;
        }).join("")
      : `<p class="hint">${t("hint-no-cards-drawn")}</p>`;
    return `
      <div class="user-card" data-user="${escapeHtml(user.key)}">
        <div class="user-card-header">
          <strong>${escapeHtml(user.displayName)}</strong>
          <span>${total} ${t("unit-cards")}</span>
          <button class="danger-button" type="button" data-action="delete-user" data-user="${escapeHtml(user.key)}">${t("btn-delete-user")}</button>
        </div>
        <div class="user-card-cards">${rows}</div>
      </div>
    `;
  }).join("");
}

async function persistBoosterCollection(boosterId) {
  const collection = collections[boosterId];
  if (!collection) return;
  await persistCollectionSnapshot(collection, boosterId, "");
}

async function handleUserListClick(event) {
  const button = event.target.closest("[data-action='delete-user']");
  if (!button) return;
  const userKey = button.dataset.user;
  const boosterIds = new Set();
  for (const [boosterId, collection] of Object.entries(collections || {})) {
    if (collection?.users && Object.prototype.hasOwnProperty.call(collection.users, userKey)) {
      delete collection.users[userKey];
      boosterIds.add(boosterId);
    }
  }
  for (const boosterId of boosterIds) {
    await persistBoosterCollection(boosterId);
  }
  renderUsers();
  showNotice(t("notice-user-deleted"));
}

async function handleUserListChange(event) {
  const input = event.target.closest("[data-action='edit-count']");
  if (!input) return;
  event.stopPropagation();
  const { user, booster, card } = input.dataset;
  const value = Math.max(0, Math.round(Number(input.value) || 0));
  input.value = value;
  const collection = collections[booster];
  const userData = collection?.users?.[user];
  if (!userData) return;
  userData.cards ||= {};
  if (value === 0) {
    delete userData.cards[card];
  } else {
    userData.cards[card] = value;
  }
  await persistBoosterCollection(booster);
  const header = input.closest(".user-card")?.querySelector(".user-card-header span");
  if (header) {
    const total = Object.values(userData.cards || {}).reduce((sum, count) => sum + Number(count || 0), 0);
    header.textContent = `${total} ${t("unit-cards")}`;
  }
}

function bindUsers() {
  $("#user-search").addEventListener("input", renderUsers);
  $("#user-list").addEventListener("click", handleUserListClick);
  $("#user-list").addEventListener("change", handleUserListChange);
}

function hydrateTrigger() {
  const booster = selectedBooster();
  settings.twitch ||= {};
  settings.twitch.clientId ||= DEFAULT_TWITCH_CLIENT_ID;
  $("#reward-title").value = booster?.rewardNames?.[0] || booster?.title || "Kartenpack";
  $("#reward-cost").value = booster?.rewardCost || 1;
  $("#reward-prompt").value = booster?.rewardPrompt || "";
  renderRewardSelect();
  $("#reward-select").value = booster?.rewardIds?.[0] || "";
}

function bindTrigger() {
  $("#connect-twitch").addEventListener("click", connectTwitch);
  $("#disconnect-twitch").addEventListener("click", handleTwitchDisconnect);
  $("#refresh-twitch-status").addEventListener("click", refreshTwitchStatus);
  $("#load-rewards").addEventListener("click", loadTwitchRewards);
  $("#sync-reward").addEventListener("click", handleRewardSync);
  $("#delete-reward").addEventListener("click", handleRewardDelete);
  $("#new-reward").addEventListener("click", clearRewardForm);
  $("#reward-title").addEventListener("input", (event) => {
    selectedBooster().rewardNames = [event.target.value].filter(Boolean);
  });
  $("#reward-cost").addEventListener("input", (event) => {
    selectedBooster().rewardCost = Number(event.target.value || 1);
  });
  $("#reward-prompt").addEventListener("input", (event) => {
    selectedBooster().rewardPrompt = event.target.value;
  });
  $("#reward-select").addEventListener("change", (event) => {
    const option = event.target.selectedOptions[0];
    if (!option?.value) {
      clearRewardForm();
      return;
    }
    $("#reward-title").value = option.dataset.title || option.textContent.trim();
    $("#reward-cost").value = option.dataset.cost || 1;
    $("#reward-prompt").value = option.dataset.prompt || "";
    selectedBooster().rewardIds = [option.value];
    selectedBooster().rewardNames = [option.dataset.title || option.textContent.trim()];
    selectedBooster().rewardCost = Number(option.dataset.cost || 1);
    selectedBooster().rewardPrompt = option.dataset.prompt || "";
    showNotice(t("notice-reward-applied"));
  });
}

function hydrateDesign() {
  renderFontSelect();
  $("#font-family").value = settings.style.fontFamily || "";
  $("#theme-mode").value = settings.style.themeMode || "light";
  $("#language").value = settings.language || "de";
  $("#style-accent").value = settings.style.accentColor || "#ff78bb";
  $("#style-text").value = settings.style.textColor || "#ffffff";
  $("#style-secondary").value = settings.style.secondaryColor || "#ffffff";
  $("#volume").value = settings.style.volume ?? 65;
  updateSoundRow("open");
  updateSoundRow("reveal");
  $("#show-collection").checked = settings.style.showCollection !== false;
  $("#card-borders").checked = settings.style.cardBorders !== false;
  for (const rarity of RARITIES) {
    const input = $(`#rarity-color-${rarity.id}`);
    if (input) input.value = settings.rarityColors?.[rarity.id] || DEFAULT_RARITY_COLORS[rarity.id];
  }
  $("#reveal-seconds").value = settings.behavior.revealSeconds ?? 3.2;
  $("#cooldown-seconds").value = settings.behavior.cooldownSeconds ?? 0.8;
  $("#backs-before-reveal").value = settings.behavior.cardBacksBeforeReveal ?? 2;
  $("#obs-enabled").checked = settings.obs?.enabled === true;
  $("#obs-host").value = settings.obs?.host || "127.0.0.1";
  $("#obs-port").value = settings.obs?.port || 4455;
  $("#obs-password").value = settings.obs?.password || "";
  $("#obs-scene-name").value = settings.obs?.sceneName || "Streamer Card Overlay";
  $("#obs-source-name").value = settings.obs?.sourceName || "Streamer Card Widget";
  refreshSettingsPreview();
}

function updateSoundRow(kind) {
  const dataUrl = settings.sounds?.[kind] || "";
  const status = $(`#sound-${kind}-status`);
  const playButton = $(`#play-${kind}-sound`);
  const removeButton = $(`#remove-${kind}-sound`);
  if (status) {
    status.textContent = dataUrl ? t("status-sound-set") : t("status-no-sound");
    status.classList.toggle("is-set", Boolean(dataUrl));
  }
  if (playButton) playButton.disabled = !dataUrl;
  if (removeButton) removeButton.disabled = !dataUrl;
}

function renderFontSelect() {
  const select = $("#font-family");
  if (!select || select.options.length) return;
  const current = settings.style?.fontFamily || "Inter, Arial, sans-serif";
  const fonts = availableFonts.length ? availableFonts : ["Inter", "Arial", "Segoe UI", "Montserrat"];
  select.innerHTML = fonts.map((font) => `<option value="${escapeHtml(font)}">${escapeHtml(font)}</option>`).join("");
  if (![...select.options].some((option) => option.value === current)) {
    select.insertAdjacentHTML("afterbegin", `<option value="${escapeHtml(current)}">${escapeHtml(current)}</option>`);
  }
}

function refreshSettingsPreview() {
  const card = selectedCard();
  if ($("#settings-preview-card")) $("#settings-preview-card").innerHTML = card ? cardMarkup(card, { compact: true }) : "";
  if ($("#font-preview")) {
    $("#font-preview").style.fontFamily = settings.style?.fontFamily || "inherit";
    $("#font-preview").textContent = settings.language === "en" ? "Pack Preview 123" : "Pack Vorschau 123 ÄÖÜ";
  }
  document.body.dataset.theme = settings.style?.themeMode || "light";
}

function bindDesign() {
  const styleFields = {
    "#font-family": "fontFamily",
    "#style-accent": "accentColor",
    "#style-text": "textColor",
    "#style-secondary": "secondaryColor",
    "#volume": "volume",
    "#show-collection": "showCollection",
    "#card-borders": "cardBorders"
  };
  for (const [selector, field] of Object.entries(styleFields)) {
    $(selector).addEventListener("input", (event) => {
      const target = event.target;
      settings.style[field] = target.type === "checkbox" ? target.checked : target.type === "range" ? Number(target.value) : target.value;
      applyTheme(settings);
      refreshSettingsPreview();
    });
  }
  $("#theme-mode").addEventListener("input", (event) => {
    settings.style.themeMode = event.target.value;
    refreshSettingsPreview();
  });
  $$("[data-rarity-color]").forEach((input) => {
    input.addEventListener("input", (event) => {
      settings.rarityColors ||= {};
      settings.rarityColors[event.target.dataset.rarityColor] = event.target.value;
      setRarityColors(settings.rarityColors);
      renderCards();
      hydrateBooster();
      refreshSettingsPreview();
    });
  });
  $("#reset-rarity-colors").addEventListener("click", () => {
    settings.rarityColors = { ...DEFAULT_RARITY_COLORS };
    setRarityColors(settings.rarityColors);
    hydrateDesign();
    renderCards();
    hydrateBooster();
    refreshSettingsPreview();
    scheduleAutoSave();
    showNotice(t("notice-rarity-colors-reset"));
  });
  $("#language").addEventListener("input", (event) => {
    settings.language = event.target.value;
    renderAll();
    refreshSettingsPreview();
  });
  const behaviorFields = {
    "#reveal-seconds": "revealSeconds",
    "#cooldown-seconds": "cooldownSeconds",
    "#backs-before-reveal": "cardBacksBeforeReveal"
  };
  for (const [selector, field] of Object.entries(behaviorFields)) {
    $(selector).addEventListener("input", (event) => {
      settings.behavior[field] = Number(event.target.value);
    });
  }
  const obsFields = {
    "#obs-enabled": ["enabled", "checkbox"],
    "#obs-host": ["host"],
    "#obs-port": ["port", "number"],
    "#obs-password": ["password"],
    "#obs-scene-name": ["sceneName"],
    "#obs-source-name": ["sourceName"]
  };
  for (const [selector, [field, type]] of Object.entries(obsFields)) {
    $(selector).addEventListener("input", (event) => {
      settings.obs ||= {};
      settings.obs[field] = type === "checkbox" ? event.target.checked : type === "number" ? Number(event.target.value) : event.target.value;
    });
  }
  $("#test-obs").addEventListener("click", testObsConnection);
  $("#setup-obs").addEventListener("click", setupObsOverlay);
  $("#sound-open").addEventListener("change", async (event) => {
    if (!event.target.files?.[0]) return;
    settings.sounds ||= {};
    settings.sounds.open = await readFileAsDataUrl(event.target.files[0]);
    event.target.value = "";
    updateSoundRow("open");
    scheduleAutoSave();
    showNotice(t("notice-sound-open-saved"));
  });
  $("#sound-reveal").addEventListener("change", async (event) => {
    if (!event.target.files?.[0]) return;
    settings.sounds ||= {};
    settings.sounds.reveal = await readFileAsDataUrl(event.target.files[0]);
    event.target.value = "";
    updateSoundRow("reveal");
    scheduleAutoSave();
    showNotice(t("notice-sound-reveal-saved"));
  });
  $("#remove-open-sound").addEventListener("click", () => {
    settings.sounds ||= {};
    settings.sounds.open = "";
    $("#sound-open").value = "";
    updateSoundRow("open");
    scheduleAutoSave();
    showNotice(t("notice-sound-open-removed"));
  });
  $("#remove-reveal-sound").addEventListener("click", () => {
    settings.sounds ||= {};
    settings.sounds.reveal = "";
    $("#sound-reveal").value = "";
    updateSoundRow("reveal");
    scheduleAutoSave();
    showNotice(t("notice-sound-reveal-removed"));
  });
  $("#play-open-sound").addEventListener("click", () => playSoundPreview("open"));
  $("#play-reveal-sound").addEventListener("click", () => playSoundPreview("reveal"));
}

function playSoundPreview(kind) {
  const dataUrl = settings.sounds?.[kind];
  if (!dataUrl) return;
  const volume = Number(settings.style?.volume ?? 65) / 100;
  const audio = new Audio(dataUrl);
  audio.volume = Math.min(1, Math.max(0, volume));
  audio.play().catch((error) => showNotice(`${t("error-sound-play-failed")} ${error.message}`, "error"));
}

function bindGlobalActions() {
  $("#add-card").addEventListener("click", () => {
    const card = blankCard();
    settings.deck.cards.push(card);
    const booster = selectedBooster();
    if (booster && booster.cardIds.length < 9) booster.cardIds.push(card.id);
    selectedCardId = card.id;
    renderCards();
  });
  $("#save-settings").addEventListener("click", async () => {
    await saveSettings(settings);
    showNotice(t("notice-saved"));
  });
  $("#test-random").addEventListener("click", () => {
    const user = randomUsername();
    $("#test-user").value = user;
    triggerDraw({ user, source: "admin-demo" });
  });
  $("#test-selected").addEventListener("click", () => {
    triggerDraw({
      user: $("#test-user").value,
      boosterId: $("#test-booster").value || null,
      cardId: $("#test-card").value || null,
      source: "admin"
    });
  });
  $("#test-booster").addEventListener("change", (event) => {
    if (!event.target.value) return;
    selectedBoosterId = event.target.value;
    hydrateBooster();
    renderOverview();
  });
  $("#reset-collections").addEventListener("click", async () => {
    await resetCollections();
    showNotice(t("notice-collections-cleared"));
  });
  $("#reset-settings").addEventListener("click", async () => {
    const result = await resetSettings();
    settings = normalizeSettings(result.settings);
    selectedCardId = settings.deck.cards[0]?.id;
    selectedBoosterId = settings.boosters[0]?.id;
    renderAll();
    showNotice(t("notice-samples-loaded"), "warn");
  });
  $("#card-list").addEventListener("click", handleCardListClick);
  $("#card-list").addEventListener("input", handleCardListChange);
  $("#card-list").addEventListener("change", handleCardListChange);
}

function renderAll() {
  applyTheme(settings);
  applyTranslations();
  renderCards();
  hydrateBooster();
  hydrateTrigger();
  hydrateDesign();
  renderOverview();
  renderUsers();
}

async function init() {
  try {
    settings = normalizeSettings(await getSettings());
    availableFonts = (await getFonts()).fonts || [];
    selectedCardId = settings.deck.cards[0]?.id;
    selectedBoosterId = settings.boosters[0]?.id;
    bindTabs();
    bindGlobalActions();
    bindBooster();
    bindTrigger();
    bindDesign();
    bindUsers();
    bindUpdateTab();
    bindLogTab();
    renderAll();
    await loadUsers();
    renderUsers();
    await hydrateUpdateTab();
    checkForUpdate({ silent: true });
    autoSaveReady = true;
    $(".workspace").addEventListener("input", scheduleAutoSave);
    $(".workspace").addEventListener("change", scheduleAutoSave);
    $(".workspace").addEventListener("click", (event) => {
      if (event.target.closest("#add-card,#add-booster,#remove-booster-image,#remove-open-sound,#remove-reveal-sound,[data-action='duplicate'],[data-action='delete'],[data-action='clear-image']")) {
        setTimeout(scheduleAutoSave, 0);
      }
    });
    await refreshTwitchStatus();
    if (settings.obs?.enabled) testObsConnection();
    setInterval(refreshTwitchStatus, 20000);
    setInterval(() => {
      if (settings.obs?.enabled) testObsConnection();
    }, 20000);
  } catch (error) {
    setPill("#twitch-pill", t("pill-server-unreachable"), false);
    showNotice(error.message, "error");
  }
}

window.addEventListener("message", (event) => {
  if (event.origin !== window.location.origin) return;
  if (event.data?.type === "cardpack:twitch-connected") {
    refreshTwitchStatus();
    showNotice(t("notice-twitch-connected"));
  }
});

init();
