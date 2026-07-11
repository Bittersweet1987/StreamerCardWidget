import {
  addLog,
  clearLogs,
  connectEventStream,
  currentOriginUrl,
  deleteTwitchReward,
  disconnectBot,
  disconnectTwitch,
  getBotStatus,
  getCollections,
  clearQueue,
  getCommandUsage,
  getFonts,
  getLatestRelease,
  getReleases,
  getQueueItems,
  removeQueueItem,
  setQueuePaused,
  installUpdate,
  getLogs,
  getSettings,
  getTwitchStatus,
  getVersion,
  persistCollectionSnapshot,
  resetCollections,
  resetCommandUsage,
  resetSettings,
  saveSettings,
  syncShowcaseReward,
  syncTwitchReward,
  testTradeAnimation,
  testBattleAnimation,
  triggerDraw
} from "./api.js";
import {
  applyTheme,
  boosterMarkup,
  CARD_THEMES,
  cardMarkup,
  cardsForBooster,
  createId,
  customThemeCss,
  DEFAULT_RARITY_COLORS,
  DEFAULT_RARITY_WEIGHTS,
  escapeHtml,
  normalizeSettings,
  RARITIES,
  rarityById,
  readFileAsDataUrl,
  setRarityColors,
  setRarityWeights
} from "./render.js";

let settings;
let selectedCardId;
let selectedBoosterId;
let previewCardId;
let availableFonts = [];
let autoSaveTimer;
let autoSaveReady = false;
let collections = {};
const DEFAULT_TWITCH_CLIENT_ID = "klgyxuiixy0mfo7ze7goubj5j16g7u";
const TWITCH_REQUIRED_SCOPES = "channel:read:redemptions channel:manage:redemptions user:read:chat user:write:chat";
const TWITCH_BOT_SCOPES = "user:read:chat user:write:chat";

const I18N = {
  "nav-overview": { de: "Übersicht", en: "Overview" },
  "nav-trigger": { de: "Verbindung", en: "Connection" },
  "nav-channelpoints": { de: "Kanalpunkte", en: "Channel points" },
  "nav-cards": { de: "Karten", en: "Cards" },
  "nav-booster": { de: "Booster", en: "Boosters" },
  "nav-users": { de: "User", en: "Users" },
  "nav-design": { de: "Einstellungen", en: "Settings" },
  "nav-update": { de: "Update", en: "Update" },
  "nav-log": { de: "Log", en: "Log" },
  "nav-chatcommands": { de: "Chat Befehle", en: "Chat commands" },
  "nav-themes": { de: "Themes", en: "Themes" },
  "themes-eyebrow": { de: "Kartendesign", en: "Card design" },
  "themes-title": { de: "Karten-Themes", en: "Card themes" },
  "themes-hint": {
    de: "Wähle das Aussehen aller Karten per Klick. Die Auswahl gilt sofort für Overlay, Sammlung und Vorschauen.",
    en: "Pick the look of all cards with one click. It applies instantly to overlay, collection and previews."
  },
  "theme-selected": { de: "Ausgewählt", en: "Selected" },
  "label-theme-preview-card": { de: "Vorschaukarte", en: "Preview card" },
  "theme-default": { de: "Klassik", en: "Classic" },
  "theme-onyx": { de: "Onyx", en: "Onyx" },
  "theme-carbon": { de: "Carbon", en: "Carbon" },
  "theme-midnight": { de: "Mitternacht", en: "Midnight" },
  "theme-slate": { de: "Schiefer", en: "Slate" },
  "theme-prism": { de: "Prisma", en: "Prism" },
  "theme-gold": { de: "Gold", en: "Gold" },
  "theme-sunset": { de: "Sunset", en: "Sunset" },
  "theme-mint": { de: "Mint", en: "Mint" },
  "theme-ocean": { de: "Ozean", en: "Ocean" },
  "theme-rose": { de: "Rosé", en: "Rose" },
  "theme-forest": { de: "Wald", en: "Forest" },
  "theme-custom": { de: "Eigenes", en: "Custom" },
  "theme-editor-eyebrow": { de: "Eigenes Theme", en: "Custom theme" },
  "theme-editor-title": { de: "Theme-Editor", en: "Theme editor" },
  "theme-editor-hint": {
    de: "Stelle dein eigenes Karten-Theme zusammen. Die Einstellungen wirken sich nur auf die Karte aus.",
    en: "Build your own card theme. These settings only affect the card itself."
  },
  "label-ct-color1": { de: "Farbe 1", en: "Color 1" },
  "label-ct-color2": { de: "Farbe 2", en: "Color 2" },
  "label-ct-color3": { de: "Farbe 3", en: "Color 3" },
  "label-ct-use-color3": { de: "Dritte Farbe verwenden", en: "Use a third color" },
  "label-ct-angle": { de: "Verlaufswinkel", en: "Gradient angle" },
  "label-ct-sheen": { de: "Glanz", en: "Sheen" },
  "label-ct-art-color": { de: "Bildrahmen-Farbe", en: "Image frame color" },
  "label-ct-art-opacity": { de: "Bildrahmen-Deckkraft", en: "Image frame opacity" },
  "btn-ct-activate": { de: "Eigenes Theme aktivieren", en: "Activate custom theme" },
  "notice-theme-custom-active": { de: "Eigenes Theme aktiviert.", en: "Custom theme activated." },
  "nav-commandusage": { de: "Nutzung Befehle", en: "Command usage" },
  "nav-queue": { de: "Queue", en: "Queue" },
  "bot-trigger-title": { de: "Bot-Verbindung (Chat)", en: "Bot connection (chat)" },
  "bot-trigger-hint": {
    de: "Optional: separater Bot-Account zum Lesen und Senden von Chat-Nachrichten. Wenn nicht verbunden, wird die Haupt-Twitch-Verbindung dafür verwendet.",
    en: "Optional: separate bot account for reading and sending chat messages. If not connected, the main Twitch connection is used instead."
  },
  "btn-connect-twitch-bot": { de: "Bot mit Twitch anmelden", en: "Sign in bot with Twitch" },
  "cc-title": { de: "Chat-Befehle verwalten", en: "Manage chat commands" },
  "label-cc-command-enabled": { de: "Aktiviert", en: "Enabled" },
  "cc-intro": {
    de: "Lege fest, mit welchen Chat-Befehlen Zuschauer ein Pack ziehen oder ihre Sammlung anzeigen können. Jeder Befehl lässt sich einzeln aktivieren.",
    en: "Define which chat commands let viewers draw a pack or show their collection. Each command can be enabled separately."
  },
  "cc-group-command": { de: "Befehl", en: "Command" },
  "cc-group-limits": { de: "Limit & Cooldown", en: "Limit & cooldown" },
  "cc-group-messages": { de: "Chat-Nachrichten", en: "Chat messages" },
  "cc-trade-eyebrow": { de: "Tausch", en: "Trade" },
  "cc-trade-title": { de: "Tausch-Befehl", en: "Trade command" },
  "label-cc-trade-timeout": { de: "Anfrage offen für (Sek.)", en: "Request open for (sec.)" },
  "label-cc-trade-offer": { de: "Angebot an den Tauschpartner", en: "Offer to the trade partner" },
  "label-cc-trade-cardnotfound": { de: "Karte nicht gefunden (Vorschlag)", en: "Card not found (suggestion)" },
  "label-cc-trade-offernotowned": { de: "Anbieter besitzt Karte nicht", en: "Offerer doesn't own the card" },
  "label-cc-trade-usernotfound": { de: "Tauschpartner nicht gefunden", en: "Trade partner not found" },
  "label-cc-trade-cooldown": { de: "Nachricht bei aktivem Cooldown", en: "Message when cooldown active" },
  "label-cc-trade-limit": { de: "Nachricht bei erreichtem Limit", en: "Message when limit reached" },
  "label-cc-trade-timeoutmsg": { de: "Nachricht bei Zeitüberschreitung", en: "Message on timeout" },
  "label-cc-trade-busy": { de: "Nachricht bei laufendem Tausch", en: "Message while a trade is running" },
  "cc-tradeyes-eyebrow": { de: "Tausch annehmen", en: "Accept trade" },
  "cc-tradeyes-title": { de: "Tausch-Annahme-Befehl", en: "Trade accept command" },
  "label-cc-tradeyes-notowned": { de: "Partner besitzt Karte nicht", en: "Partner doesn't own the card" },
  "label-cc-tradeyes-success": { de: "Nachricht bei erfolgreichem Tausch", en: "Message on successful trade" },
  "cc-tradeno-eyebrow": { de: "Tausch ablehnen", en: "Decline trade" },
  "cc-tradeno-title": { de: "Tausch-Ablehnungs-Befehl", en: "Trade decline command" },
  "label-cc-tradeno-decline": { de: "Nachricht bei Ablehnung", en: "Message on decline" },
  "cc-battle-eyebrow": { de: "Kampf", en: "Battle" },
  "cc-battle-title": { de: "Kampf-Befehl", en: "Battle command" },
  "label-cc-battle-lineupsize": { de: "Karten pro Seite (N)", en: "Cards per side (N)" },
  "label-cc-battle-timeout": { de: "Anfrage offen für (Sek.)", en: "Request open for (sec.)" },
  "label-cc-battle-offer": { de: "Herausforderung an den Gegner", en: "Challenge to the opponent" },
  "label-cc-battle-usernotfound": { de: "Gegner nicht gefunden", en: "Opponent not found" },
  "label-cc-battle-selfchallenge": { de: "Sich selbst herausgefordert", en: "Self-challenge" },
  "label-cc-battle-notenoughcards": { de: "Zu wenige Karten", en: "Not enough cards" },
  "label-cc-battle-cooldown": { de: "Nachricht bei aktivem Cooldown", en: "Message when cooldown active" },
  "label-cc-battle-limit": { de: "Nachricht bei erreichtem Limit", en: "Message when limit reached" },
  "label-cc-battle-timeoutmsg": { de: "Nachricht bei Zeitüberschreitung", en: "Message on timeout" },
  "label-cc-battle-busy": { de: "Nachricht bei laufendem Kampf", en: "Message while a battle is running" },
  "cc-battleyes-eyebrow": { de: "Kampf annehmen", en: "Accept battle" },
  "cc-battleyes-title": { de: "Kampf-Annahme-Befehl", en: "Battle accept command" },
  "label-cc-battleyes-result": { de: "Nachricht bei Ergebnis", en: "Result message" },
  "cc-battleno-eyebrow": { de: "Kampf ablehnen", en: "Decline battle" },
  "cc-battleno-title": { de: "Kampf-Ablehnungs-Befehl", en: "Battle decline command" },
  "label-cc-battleno-decline": { de: "Nachricht bei Ablehnung", en: "Message on decline" },
  "cc-ranking-eyebrow": { de: "Ranking", en: "Ranking" },
  "cc-ranking-title": { de: "Ranking-Befehl", en: "Ranking command" },
  "label-cc-ranking-seconds": { de: "Anzeigedauer (Sek.)", en: "Display duration (sec.)" },
  "cc-ranking-hint": {
    de: "Zeigt das Ranking ausschließlich in der eigenen OBS-Quelle (Verbindung → Quellenname Ranking) – es erfolgt bewusst keine Chat-Ausgabe. Bei „battle“ wechselt die Anzeige nacheinander durch: meiste Kämpfe → meiste Siege → meiste Niederlagen → beste Siegquote (je Top 5). Bei „tausch“ erscheinen die 5 User mit den meisten abgeschlossenen Tauschen. Die Anzeigedauer gilt pro Ansicht.",
    en: "Shows the ranking exclusively in its own OBS source (Connection → Ranking source name) – deliberately no chat output. For “battle” the display cycles through: most fights → most wins → most defeats → best win/loss ratio (top 5 each). For “trade” it shows the 5 users with the most completed trades. The display duration applies per view."
  },
  "label-obs-ranking-source": { de: "Quellenname Ranking", en: "Source name ranking" },
  "cc-pack-eyebrow": { de: "Kartenpack", en: "Card pack" },
  "cc-pack-title": { de: "Pack-Befehl", en: "Pack command" },
  "cc-collection-eyebrow": { de: "Sammlung", en: "Collection" },
  "cc-collection-title": { de: "Sammlung-Befehl", en: "Collection command" },
  "cc-collection-hint": {
    de: "Zeigt die Sammlung als Overlay in OBS. Zusätzlich kann der Befehl die eigenen Kartennamen direkt im Chat auflisten (mit Anzahl bei Mehrfachbesitz) – wird bei Bedarf automatisch auf mehrere Nachrichten aufgeteilt, um Twitchs Zeichenlimit einzuhalten.",
    en: "Shows the collection as an OBS overlay. It can also list the caller's card names directly in chat (with a count when owned more than once) – automatically split across multiple messages if needed to stay under Twitch's character limit."
  },
  "label-cc-collection-chatoutput": { de: "Kartennamen zusätzlich im Chat auflisten", en: "Also list card names in chat" },
  "label-cc-cards-header": { de: "Einleitung vor der Kartenliste", en: "Intro before the card list" },
  "label-cc-cards-empty": { de: "Nachricht ohne eigene Karten", en: "Message when the user owns no cards" },
  "label-cc-prefix": { de: "Präfix", en: "Prefix" },
  "label-cc-command": { de: "Befehlswort", en: "Command word" },
  "label-cc-maxuses": { de: "Max. Nutzungen pro Viewer", en: "Max uses per viewer" },
  "label-cc-cooldown": { de: "Cooldown pro Viewer (Sek.)", en: "Cooldown per viewer (sec.)" },
  "label-cc-reset-value": { de: "Auto-Reset alle", en: "Auto-reset every" },
  "label-cc-reset-unit": { de: "Einheit", en: "Unit" },
  "opt-minutes": { de: "Minuten", en: "Minutes" },
  "opt-hours": { de: "Stunden", en: "Hours" },
  "opt-days": { de: "Tage", en: "Days" },
  "label-cc-success-message": { de: "Nachricht bei Einlösung", en: "Message on redemption" },
  "label-cc-limit-message": { de: "Nachricht bei erreichtem Limit", en: "Message when limit reached" },
  "label-cc-cooldown-message": { de: "Nachricht bei aktivem Cooldown", en: "Message when cooldown active" },
  "cu-eyebrow": { de: "Chat-Befehle", en: "Chat commands" },
  "cu-title": { de: "Nutzung Befehle", en: "Command usage" },
  "btn-cu-reset-all": { de: "Alle zurücksetzen", en: "Reset all" },
  "btn-cu-reset-user": { de: "Zurücksetzen", en: "Reset" },
  "placeholder-cu-search": { de: "Nutzer suchen...", en: "Search user..." },
  "hint-cu-empty": { de: "Noch keine Nutzungen vorhanden.", en: "No usage yet." },
  "unit-cu-uses": { de: "Nutzungen", en: "uses" },
  "cu-pack-reset": { de: "Pack-Reset", en: "Pack reset" },
  "cu-trade-reset": { de: "Tausch-Reset", en: "Trade reset" },
  "cu-battle-reset": { de: "Kampf-Reset", en: "Battle reset" },
  "cu-remaining": { de: "übrig", en: "left" },
  "cu-unlimited": { de: "unbegrenzt", en: "unlimited" },
  "notice-cu-reset": { de: "Nutzung zurückgesetzt.", en: "Usage reset." },
  "notice-cu-reset-all": { de: "Alle Nutzungen zurückgesetzt.", en: "All usage reset." },
  "queue-eyebrow": { de: "Verarbeitung", en: "Processing" },
  "queue-title": { de: "Warteschlange", en: "Queue" },
  "hint-queue": {
    de: "Kanalpunkte-Einlösungen und Chat-Befehle werden hier streng nacheinander verarbeitet (500ms Pause zwischen Einträgen).",
    en: "Channel point redemptions and chat commands are processed strictly in order here (500ms pause between entries)."
  },
  "hint-queue-empty": { de: "Aktuell keine ausstehenden Einträge.", en: "No pending entries right now." },
  "label-queue-paused": { de: "Queue pausieren", en: "Pause queue" },
  "btn-queue-clear": { de: "Alle Einträge löschen", en: "Clear all entries" },
  "btn-queue-remove": { de: "Entfernen", en: "Remove" },
  "notice-queue-cleared": { de: "Warteschlange geleert.", en: "Queue cleared." },
  "queue-kind-draw": { de: "Kartenpack", en: "Card pack" },
  "queue-kind-showcollection": { de: "Sammlung zeigen", en: "Show collection" },
  "queue-kind-trade": { de: "Tausch", en: "Trade" },
  "queue-source-chat": { de: "Chat", en: "Chat" },
  "queue-source-channelpoints": { de: "Kanalpunkte", en: "Channel points" },
  "queue-processing": { de: "wird verarbeitet", en: "processing" },
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
  "update-changelog-eyebrow": { de: "Änderungen", en: "Changes" },
  "update-changelog-title": { de: "Was ist neu seit deiner Version", en: "What's new since your version" },
  "update-changelog-loading": { de: "Wird geladen…", en: "Loading…" },
  "update-changelog-none": { de: "Du hast bereits die neueste Version.", en: "You're already on the latest version." },
  "update-changelog-empty": { de: "Keine Details zu diesem Release verfügbar.", en: "No details available for this release." },
  "update-changelog-error": { de: "Änderungen konnten nicht geladen werden:", en: "Could not load changes:" },
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
  "ov-help-eyebrow": { de: "Hilfe", en: "Help" },
  "ov-help-title": { de: "Fragen?", en: "Questions?" },
  "ov-help-text": {
    de: "Auf GitHub findest du eine kleine Anleitung, falls du Fragen zur Einrichtung oder den Funktionen hast.",
    en: "On GitHub you'll find a short guide in case you have questions about setup or features."
  },
  "btn-open-guide": { de: "Anleitung auf GitHub öffnen", en: "Open guide on GitHub" },
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
  "rarity-weights-eyebrow": { de: "Karten", en: "Cards" },
  "rarity-weights-title": { de: "Gewichtung je Rarität", en: "Weight per rarity" },
  "rarity-weights-hint": { de: "Höhere Werte werden häufiger gezogen.", en: "Higher values are drawn more often." },
  "btn-reset-rarity-weights": { de: "Auf Standard zurücksetzen", en: "Reset to defaults" },
  "notice-rarity-weights-reset": { de: "Gewichtung zurückgesetzt.", en: "Weights reset." },
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
  "draw-reward-eyebrow": { de: "Kartenpack", en: "Card pack" },
  "draw-reward-title": { de: "Kartenpack-Belohnung", en: "Card pack reward" },
  "confirm-delete-reward": { de: "Diese Belohnung wirklich löschen?", en: "Really delete this reward?" },
  "label-reward-title": { de: "Reward-Titel", en: "Reward title" },
  "label-reward-cost": { de: "Kosten", en: "Cost" },
  "label-reward-prompt": { de: "Beschreibung", en: "Description" },
  "label-reward-post-enabled": { de: "Chat-Nachricht nach dem Ziehen senden", en: "Send chat message after the draw" },
  "label-reward-post-message": { de: "Nachricht nach der Animation", en: "Message after the animation" },
  "label-reward-bg-color": { de: "Hintergrundfarbe", en: "Background color" },
  "label-reward-cooldown": { de: "Globaler Cooldown (Sek.)", en: "Global cooldown (sec.)" },
  "label-reward-max-stream": { de: "Max pro Stream", en: "Max per stream" },
  "label-reward-max-user": { de: "Max pro Nutzer/Stream", en: "Max per user/stream" },
  "label-reward-enabled": { de: "Aktiviert", en: "Enabled" },
  "label-reward-paused": { de: "Pausiert", en: "Paused" },
  "btn-sync-reward": { de: "Speichern / aktualisieren", en: "Save / update" },
  "btn-delete-reward": { de: "Löschen", en: "Delete" },
  "status-saving-reward": { de: "Speichere Channelpoint...", en: "Saving channel point..." },
  "notice-reward-saved": {
    de: "Channelpoint wurde gespeichert und dem Booster zugeordnet.",
    en: "Channel point was saved and assigned to the booster."
  },
  "status-deleting-reward": { de: "Lösche Channelpoint...", en: "Deleting channel point..." },
  "notice-reward-deleted": { de: "Channelpoint gelöscht.", en: "Channel point deleted." },
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
  "btn-obs-info": { de: "Hilfe anzeigen", en: "Show help" },
  "btn-obs-info-hide": { de: "Hilfe ausblenden", en: "Hide help" },
  "obs-info-text": {
    de: "Öffne in OBS das Menü „Werkzeuge“ → „WebSocket-Servereinstellungen“. Aktiviere dort „WebSocket-Server aktivieren“. Den Port (Standard 4455) und das Passwort findest du über „Verbindungsinformationen anzeigen“. Trage Host (meist 127.0.0.1), Port und Passwort dann hier ein.",
    en: "In OBS open the “Tools” menu → “WebSocket Server Settings”. Enable “Enable WebSocket server”. You'll find the port (default 4455) and password via “Show Connect Info”. Then enter host (usually 127.0.0.1), port and password here."
  },
  "label-obs-scene": { de: "Szenenname", en: "Scene name" },
  "label-obs-source": { de: "Quellenname Booster", en: "Source name booster" },
  "label-obs-collection-source": { de: "Quellenname Kartensammlung", en: "Source name card collection" },
  "btn-test-obs": { de: "OBS testen", en: "Test OBS" },
  "btn-setup-obs": { de: "OBS Szene / Quellen erstellen / aktualisieren", en: "Create / update OBS scene & sources" },
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
  "label-unknown-booster": { de: "Unbekannter Booster", en: "Unknown booster" },
  "option-assign-booster": { de: "Booster zuordnen…", en: "Assign booster…" },
  "notice-group-reassigned": { de: "Karten dem Booster zugeordnet.", en: "Cards reassigned to booster." },
  "design-look-title": { de: "Farben und Anzeige", en: "Colors and display" },
  "label-font": { de: "Schrift", en: "Font" },
  "label-accent": { de: "Akzent", en: "Accent" },
  "label-volume": { de: "Lautstärke", en: "Volume" },
  "label-preview-eyebrow": { de: "Vorschau", en: "Preview" },
  "label-show-collection": { de: "Sammlungsleiste anzeigen", en: "Show collection bar" },
  "label-card-borders": { de: "Kartenrahmen anzeigen", en: "Show card borders" },
  "label-name-position": { de: "Position Einlöser-Name", en: "Redeemer name position" },
  "option-name-bottom": { de: "Unten", en: "Bottom" },
  "option-name-middle": { de: "Mitte", en: "Middle" },
  "option-name-top": { de: "Oben", en: "Top" },
  "label-preview-card": { de: "Vorschaukarte", en: "Preview card" },
  "label-reveal-seconds": { de: "Karte sichtbar in Sekunden", en: "Card visible (seconds)" },
  "label-cooldown-seconds": { de: "Cooldown in Sekunden", en: "Cooldown (seconds)" },
  "label-backs-before-reveal": { de: "Verdeckte Karten vor Reveal", en: "Face-down cards before reveal" },
  "showcase-eyebrow": { de: "Sammlung", en: "Collection" },
  "showcase-title": { de: "Sammlungs-Showcase", en: "Collection showcase" },
  "btn-showcase-info": { de: "Hilfe anzeigen", en: "Show help" },
  "btn-showcase-info-hide": { de: "Hilfe ausblenden", en: "Hide help" },
  "showcase-info-text": {
    de: "Löst ein Zuschauer die Belohnung „Sammlung zeigen“ über Kanalpunkte ein, sliden im OBS-Overlay nacheinander alle aktiven Booster mit den Karten dieses Zuschauers durch (gezogen = sichtbar, noch nicht gezogen = unbekannt). Richte dafür einmal die separate OBS-Quelle ein. Den globalen Cooldown legst du direkt an der Belohnung fest.",
    en: "When a viewer redeems the “Show collection” channel-point reward, the OBS overlay slides through every active booster showing that viewer's cards (drawn = visible, not yet drawn = unknown). Set up the separate OBS source once. The global cooldown is set on the reward itself."
  },
  "label-showcase-reward-title": { de: "Reward-Titel", en: "Reward title" },
  "label-showcase-reward-cost": { de: "Kosten", en: "Cost" },
  "label-showcase-cooldown": { de: "Globaler Cooldown (Sek.)", en: "Global cooldown (sec.)" },
  "label-showcase-bg-color": { de: "Hintergrundfarbe", en: "Background color" },
  "label-showcase-seconds": { de: "Sekunden pro Booster", en: "Seconds per booster" },
  "status-showcase-saving": { de: "Showcase-Belohnung wird gespeichert...", en: "Saving showcase reward..." },
  "notice-showcase-saved": { de: "Showcase-Belohnung gespeichert.", en: "Showcase reward saved." },
  "label-sound-open": { de: "Öffnen-Sound", en: "Open sound" },
  "label-sound-reveal": { de: "Reveal-Sound", en: "Reveal sound" },
  "label-sound-trade": { de: "Tausch-Sound", en: "Trade sound" },
  "status-no-sound": { de: "Kein Sound ausgewählt", en: "No sound selected" },
  "status-default-sound": { de: "Kein eigener Sound – eingebauter Standard-Klang aktiv", en: "No custom sound – built-in default plays" },
  "status-sound-set": { de: "Sound gespeichert", en: "Sound saved" },
  "btn-play": { de: "▶ Abspielen", en: "▶ Play" },
  "btn-choose-file": { de: "Auswählen", en: "Choose file" },
  "btn-remove": { de: "Entfernen", en: "Remove" },
  "notice-sound-open-saved": { de: "Öffnen-Sound gespeichert.", en: "Open sound saved." },
  "notice-sound-reveal-saved": { de: "Reveal-Sound gespeichert.", en: "Reveal sound saved." },
  "notice-sound-open-removed": { de: "Öffnen-Sound entfernt.", en: "Open sound removed." },
  "notice-sound-reveal-removed": { de: "Reveal-Sound entfernt.", en: "Reveal sound removed." },
  "notice-sound-trade-saved": { de: "Tausch-Sound gespeichert.", en: "Trade sound saved." },
  "notice-sound-trade-removed": { de: "Tausch-Sound entfernt.", en: "Trade sound removed." },
  "label-obs-trade-source": { de: "Quellenname Tausch-Animation", en: "Source name trade animation" },
  "trade-anim-eyebrow": { de: "Tausch", en: "Trade" },
  "trade-anim-title": { de: "Tausch-Animation", en: "Trade animation" },
  "trade-anim-hint": {
    de: "Bei einem erfolgreichen Tausch (!tradeyes) wird eine Animation in einer eigenen OBS-Quelle (trade.html) abgespielt. Quellenname & Einrichtung findest du unter „Verbindung“.",
    en: "On a successful trade (!tradeyes) an animation plays in its own OBS source (trade.html). Source name & setup are under “Connection”."
  },
  "label-trade-anim-enabled": { de: "Tausch-Animation aktiviert", en: "Trade animation enabled" },
  "label-trade-anim-sendchat": { de: "Erfolgsmeldung zusätzlich im Chat senden", en: "Also send success message in chat" },
  "btn-trade-anim-test": { de: "Test starten", en: "Run test" },
  "trade-anim-test-hint": {
    de: "Spielt die Animation einmal in OBS ab – mit zwei zufälligen Namen und Karten. Funktioniert auch, wenn die Animation noch nicht aktiviert ist.",
    en: "Plays the animation once in OBS – with two random names and cards. Works even if the animation isn't enabled yet."
  },
  "notice-trade-test-started": { de: "Test-Animation in OBS gestartet.", en: "Test animation started in OBS." },
  "notice-trade-test-no-cards": { de: "Keine aktiven Karten in einem Booster gefunden.", en: "No active cards found in any booster." },
  "label-trade-anim-style": { de: "Animationsstil", en: "Animation style" },
  "label-trade-anim-duration": { de: "Dauer", en: "Duration" },
  "opt-trade-style-swap": { de: "Karten-Swap (Kreuzung)", en: "Card swap (cross over)" },
  "opt-trade-style-arc": { de: "Übergabe-Bogen", en: "Hand-off arc" },
  "opt-trade-style-flip": { de: "Versus-Flip", en: "Versus flip" },
  "opt-trade-dur-short": { de: "Kurz (~4s)", en: "Short (~4s)" },
  "opt-trade-dur-medium": { de: "Mittel (~6-7s)", en: "Medium (~6-7s)" },
  "opt-trade-dur-long": { de: "Länger (~9s)", en: "Longer (~9s)" },
  "label-sound-battle": { de: "Kampf-Sound", en: "Battle sound" },
  "notice-sound-battle-saved": { de: "Kampf-Sound gespeichert.", en: "Battle sound saved." },
  "notice-sound-battle-removed": { de: "Kampf-Sound entfernt.", en: "Battle sound removed." },
  "label-obs-battle-source": { de: "Quellenname Kampf-Animation", en: "Source name battle animation" },
  "battle-anim-eyebrow": { de: "Kampf", en: "Battle" },
  "battle-anim-title": { de: "Kampf-Animation", en: "Battle animation" },
  "battle-anim-hint": {
    de: "Bei einem Kartenduell (!battleyes) wird eine Animation in einer eigenen OBS-Quelle (battle.html) abgespielt. Quellenname & Einrichtung findest du unter „Verbindung“.",
    en: "On a card battle (!battleyes) an animation plays in its own OBS source (battle.html). Source name & setup are under “Connection”."
  },
  "label-battle-anim-enabled": { de: "Kampf-Animation aktiviert", en: "Battle animation enabled" },
  "label-battle-anim-sendchat": { de: "Ergebnis-Nachricht zusätzlich im Chat senden", en: "Also send result message in chat" },
  "btn-battle-anim-test": { de: "Test starten", en: "Run test" },
  "battle-anim-test-hint": {
    de: "Spielt die Animation einmal in OBS ab – mit zwei zufälligen Namen und Karten. Funktioniert auch, wenn die Animation noch nicht aktiviert ist.",
    en: "Plays the animation once in OBS – with two random names and cards. Works even if the animation isn't enabled yet."
  },
  "notice-battle-test-started": { de: "Test-Animation in OBS gestartet.", en: "Test animation started in OBS." },
  "label-battle-anim-style": { de: "Kampfstil", en: "Combat style" },
  "label-battle-anim-duration": { de: "Dauer", en: "Duration" },
  "opt-battle-style-clash": { de: "Nahkampf-Clash", en: "Melee clash" },
  "opt-battle-style-ranged": { de: "Fernkampf-Projektile", en: "Ranged projectiles" },
  "opt-battle-style-hp": { de: "HP-Leisten-Duell", en: "HP bar duel" },
  "opt-battle-dur-short": { de: "Kurz (~5s)", en: "Short (~5s)" },
  "opt-battle-dur-medium": { de: "Mittel (~8s)", en: "Medium (~8s)" },
  "opt-battle-dur-long": { de: "Länger (~12s)", en: "Longer (~12s)" },
  "battle-strength-eyebrow": { de: "Kampf", en: "Battle" },
  "battle-strength-title": { de: "Kampfstärke je Seltenheit", en: "Battle strength per rarity" },
  "battle-strength-hint": {
    de: "Bestimmt, wie stark eine Karte im Kartenduell ist (unabhängig von den Ziehungs-Gewichten). Höherer Wert = stärker.",
    en: "Determines how strong a card is in a card battle (independent of draw weights). Higher value = stronger."
  },
  "label-battle-strength-common": { de: "Gewöhnlich", en: "Common" },
  "label-battle-strength-uncommon": { de: "Ungewöhnlich", en: "Uncommon" },
  "label-battle-strength-rare": { de: "Selten", en: "Rare" },
  "label-battle-strength-epic": { de: "Episch", en: "Epic" },
  "label-battle-strength-legendary": { de: "Legendär", en: "Legendary" },
  "label-battle-strength-holo": { de: "Holo", en: "Holo" },
  "label-battle-strength-variance": { de: "Zufalls-Varianz", en: "Random variance" },
  "label-battle-strength-hpfactor": { de: "HP-Faktor (nur HP-Leisten-Duell)", en: "HP factor (HP bar duel only)" },
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

// Two-option segmented toggle (e.g. DE/EN, light/dark). data-active drives the sliding indicator.
function setSegToggle(id, value) {
  const toggle = $(`#${id}`);
  if (!toggle) return;
  const options = $$(".seg-option", toggle);
  let activeIndex = 0;
  options.forEach((opt, index) => {
    const on = opt.dataset.value === value;
    opt.classList.toggle("is-active", on);
    opt.setAttribute("aria-checked", on ? "true" : "false");
    if (on) activeIndex = index;
  });
  toggle.dataset.active = String(activeIndex);
}

function bindSegToggle(id, onChange) {
  const toggle = $(`#${id}`);
  if (!toggle) return;
  toggle.addEventListener("click", (event) => {
    const opt = event.target.closest(".seg-option");
    if (!opt || !toggle.contains(opt)) return;
    setSegToggle(id, opt.dataset.value);
    onChange(opt.dataset.value);
  });
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
  // New cards start with no booster assignment - the user assigns them manually.
  return {
    id: createId("card"),
    title: "Neue Karte",
    subtitle: "Stream Card",
    rarity: "common",
    accent: "#ff78bb",
    enabled: true,
    image: "",
    boosterIds: []
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
  if (!silent) setStatus("#update-status", t("update-status-checking"), "neutral");
  // getVersion must live inside the try: the silent startup call is not awaited by
  // anyone, so a transient fetch failure here would surface as an unhandled rejection.
  try {
    if (!appVersionInfo) appVersionInfo = await getVersion();
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
  // Independent of whether an update is available: show what changed in every release newer
  // than the installed version, so a user several versions behind sees the full picture.
  loadChangelog();
}

// Pulls "- bullet" lines out of a release's markdown body, grouped under whichever "## Heading"
// (if any) precedes them - our release notes are always written as short bullet lists under
// optional section headings, so this stays readable without a full markdown renderer.
function parseReleaseBullets(body) {
  const lines = String(body || "").split(/\r?\n/);
  const groups = [];
  let current = { heading: "", items: [] };
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith("## ")) {
      if (current.items.length) groups.push(current);
      current = { heading: line.replace(/^##\s*/, ""), items: [] };
    } else if (line.startsWith("- ")) {
      current.items.push(line.slice(2).trim());
    }
  }
  if (current.items.length) groups.push(current);
  return groups;
}

// Strips the light markdown used in our release notes (bold, inline code) down to plain text
// with minimal HTML, since this is rendered outside a full markdown pipeline.
function renderReleaseNoteText(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`(.+?)`/g, "<code>$1</code>");
}

async function loadChangelog() {
  const container = $("#update-changelog");
  if (!container || !appVersionInfo) return;
  container.innerHTML = `<p class="hint">${t("update-changelog-loading")}</p>`;
  try {
    const releases = await getReleases(appVersionInfo.repo);
    const newer = releases
      .filter((release) => !release.draft)
      .map((release) => ({ ...release, versionNumber: String(release.tag_name || "").replace(/^v/i, "") }))
      .filter((release) => compareVersions(release.versionNumber, appVersionInfo.version) > 0)
      .sort((a, b) => compareVersions(b.versionNumber, a.versionNumber));

    if (!newer.length) {
      container.innerHTML = `<p class="hint">${t("update-changelog-none")}</p>`;
      return;
    }

    container.innerHTML = newer.map((release) => {
      const groups = parseReleaseBullets(release.body);
      const date = release.published_at ? new Date(release.published_at).toLocaleDateString() : "";
      const body = groups.length
        ? groups.map((group) => `
            ${group.heading ? `<p class="changelog-group-title">${escapeHtml(group.heading)}</p>` : ""}
            <ul class="changelog-list">${group.items.map((item) => `<li>${renderReleaseNoteText(item)}</li>`).join("")}</ul>
          `).join("")
        : `<p class="hint">${t("update-changelog-empty")}</p>`;
      return `
        <div class="changelog-entry">
          <div class="changelog-entry-head">
            <strong>v${escapeHtml(release.versionNumber)}</strong>
            ${date ? `<span class="changelog-date">${escapeHtml(date)}</span>` : ""}
          </div>
          ${body}
        </div>
      `;
    }).join("");
  } catch (error) {
    container.innerHTML = `<p class="hint">${t("update-changelog-error")} ${escapeHtml(error.message)}</p>`;
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
      if (button.dataset.tab === "commandusage") {
        await loadCommandUsage();
        renderCommandUsage();
      }
      if (button.dataset.tab === "queue") {
        startQueuePolling();
      } else {
        clearInterval(queuePollTimer);
      }
    });
  });
}

function hydrateDrawReward() {
  const draw = settings.draw || {};
  $("#reward-title").value = draw.rewardName || "Kartenpack";
  $("#reward-cost").value = draw.rewardCost || 1;
  $("#reward-prompt").value = draw.rewardPrompt || "";
  $("#reward-bg-color").value = draw.rewardBackgroundColor || "#9147ff";
  $("#reward-enabled").checked = draw.rewardEnabled !== false;
  $("#reward-paused").checked = draw.rewardPaused === true;
  $("#reward-max-stream").value = draw.rewardMaxPerStream || 0;
  $("#reward-max-user").value = draw.rewardMaxPerUserPerStream || 0;
  $("#reward-cooldown").value = draw.rewardGlobalCooldown || 0;
  $("#reward-post-enabled").checked = draw.postMessageEnabled === true;
  $("#reward-post-message").value = draw.postMessage || "@userName hat [Kartenname] aus [Boostername] gezogen.";
}

function bindDrawReward() {
  const fields = {
    "#reward-title": ["rewardName"],
    "#reward-cost": ["rewardCost", "number"],
    "#reward-prompt": ["rewardPrompt"],
    "#reward-bg-color": ["rewardBackgroundColor"],
    "#reward-enabled": ["rewardEnabled", "checkbox"],
    "#reward-paused": ["rewardPaused", "checkbox"],
    "#reward-max-stream": ["rewardMaxPerStream", "number"],
    "#reward-max-user": ["rewardMaxPerUserPerStream", "number"],
    "#reward-cooldown": ["rewardGlobalCooldown", "number"],
    "#reward-post-enabled": ["postMessageEnabled", "checkbox"],
    "#reward-post-message": ["postMessage"]
  };
  for (const [selector, [field, type]] of Object.entries(fields)) {
    $(selector).addEventListener("input", (event) => {
      settings.draw ||= {};
      const target = event.target;
      settings.draw[field] = type === "checkbox" ? target.checked : type === "number" ? Math.max(0, Number(target.value || 0)) : target.value;
    });
  }
  $("#sync-reward").addEventListener("click", handleDrawRewardSync);
  $("#delete-reward").addEventListener("click", handleDrawRewardDelete);
}

async function handleDrawRewardSync() {
  settings.draw ||= {};
  setStatus("#reward-status", t("status-saving-reward"), "neutral");
  $("#reward-status").hidden = false;
  try {
    const draw = settings.draw;
    const result = await syncTwitchReward({
      rewardId: draw.rewardIds?.[0] || "",
      title: draw.rewardName || "Kartenpack",
      cost: Number(draw.rewardCost || 1),
      prompt: draw.rewardPrompt || "",
      backgroundColor: draw.rewardBackgroundColor || "#9147ff",
      isEnabled: draw.rewardEnabled !== false,
      isPaused: draw.rewardPaused === true,
      maxPerStream: Math.max(0, Number(draw.rewardMaxPerStream || 0)),
      maxPerUserPerStream: Math.max(0, Number(draw.rewardMaxPerUserPerStream || 0)),
      globalCooldown: Math.max(0, Number(draw.rewardGlobalCooldown || 0))
    });
    settings = normalizeSettings(result.settings || await getSettings());
    hydrateDrawReward();
    setStatus("#reward-status", t("notice-reward-saved"), "ok");
    showNotice(t("notice-reward-saved"));
  } catch (error) {
    setStatus("#reward-status", error.message, "error");
  }
}

async function handleDrawRewardDelete() {
  const rewardId = settings.draw?.rewardIds?.[0];
  if (!rewardId) return;
  if (!window.confirm(t("confirm-delete-reward"))) return;
  $("#reward-status").hidden = false;
  setStatus("#reward-status", t("status-deleting-reward"), "neutral");
  try {
    const result = await deleteTwitchReward({ rewardId });
    settings = normalizeSettings(result.settings || await getSettings());
    hydrateDrawReward();
    setStatus("#reward-status", t("notice-reward-deleted"), "ok");
    showNotice(t("notice-reward-deleted"));
  } catch (error) {
    setStatus("#reward-status", error.message, "error");
  }
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

async function refreshBotStatus() {
  try {
    const result = await getBotStatus();
    const status = result.status || {};
    if (status.connected) {
      setStatus("#twitch-bot-status", `${t("status-connected-as")} ${status.displayName || status.login || "Twitch"}`, "ok");
    } else {
      setStatus("#twitch-bot-status", t("status-not-connected"), "neutral");
    }
  } catch (error) {
    setStatus("#twitch-bot-status", `${t("status-error")} ${error.message}`, "error");
  }
}

async function connectTwitchBot() {
  settings.twitch ||= {};
  const clientId = String(settings.twitch.clientId || DEFAULT_TWITCH_CLIENT_ID).trim();
  if (!clientId) {
    setStatus("#twitch-bot-status", t("error-missing-client-id"), "error");
    return;
  }
  try {
    const state = `bot-${crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`}`;
    sessionStorage.setItem("cardpack_twitch_bot_state", state);
    const url = new URL("https://id.twitch.tv/oauth2/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", "http://localhost:5377/twitch-callback.html");
    url.searchParams.set("response_type", "token");
    url.searchParams.set("scope", TWITCH_BOT_SCOPES);
    url.searchParams.set("force_verify", "true");
    url.searchParams.set("state", state);
    window.open(url.toString(), "_blank");
    pollBotStatusAfterLogin();
    setStatus("#twitch-bot-status", t("status-login-opened"), "neutral");
  } catch (error) {
    setStatus("#twitch-bot-status", `${t("error-login-failed")} ${error.message}`, "error");
  }
}

let botPollTimer;
function pollBotStatusAfterLogin() {
  clearInterval(botPollTimer);
  let attempts = 0;
  botPollTimer = setInterval(async () => {
    attempts += 1;
    try {
      const result = await getBotStatus();
      if (result?.status?.connected) {
        clearInterval(botPollTimer);
        await refreshBotStatus();
        showNotice(t("notice-twitch-connected"));
        return;
      }
    } catch {
    }
    if (attempts >= 30) clearInterval(botPollTimer);
  }, 2000);
}

async function handleBotDisconnect() {
  try {
    await disconnectBot();
    settings = normalizeSettings(await getSettings());
    await refreshBotStatus();
    showNotice(t("notice-twitch-disconnected"));
  } catch (error) {
    setStatus("#twitch-bot-status", error.message, "error");
  }
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
  } catch (error) {
    setStatus("#obs-status", `${t("error-obs-not-connected")} ${error.message}`, "error");
    setPill("#obs-pill", t("pill-obs-default"), false);
    if (lastObsConnected !== false) addLog("obs", "error", `OBS-Verbindung fehlgeschlagen: ${error.message}`);
    lastObsConnected = false;
    try { ws?.close(); } catch {}
    return;
  }
  // The actual OBS connection succeeded - everything below is bookkeeping (persisting
  // settings.obs.enabled, closing the socket) and must NOT be able to turn a successful
  // connection into a reported failure if it hiccups (e.g. a transient fetch error saving
  // settings previously made this whole check falsely report "OBS not connected").
  setStatus("#obs-status", t("pill-obs-connected"), "ok");
  setPill("#obs-pill", t("pill-obs-connected"), true);
  if (lastObsConnected !== true) addLog("obs", "info", "OBS verbunden.");
  lastObsConnected = true;
  try { ws?.close(); } catch {}
  if (settings.obs?.enabled !== true) {
    settings.obs ||= {};
    settings.obs.enabled = true;
    try {
      await saveSettings(settings);
    } catch (saveError) {
      addLog("obs", "error", `OBS-Status "aktiviert" konnte nicht gespeichert werden: ${saveError.message}`);
    }
  }
}

async function setupObsOverlay() {
  setStatus("#obs-status", t("status-setting-up-obs"), "neutral");
  let ws;
  try {
    await saveSettings(settings);
    ws = await connectObs();
    const sceneName = settings.obs?.sceneName || "Streamer Card Overlay";
    const packSourceName = settings.obs?.sourceName || "Streamer Card Widget";
    const collectionSourceName = settings.showcase?.sourceName || "Streamer Card Sammlung";
    const tradeSourceName = settings.tradeAnimation?.sourceName || "Streamer Card Tausch";
    const battleSourceName = settings.battleAnimation?.sourceName || "Streamer Card Kampf";
    const rankingSourceName = settings.ranking?.sourceName || "Streamer Card Ranking";
    await applyObsBrowserSource(ws, sceneName, packSourceName, currentOriginUrl("/overlay.html"));
    await applyObsBrowserSource(ws, sceneName, collectionSourceName, currentOriginUrl("/collection.html"));
    await applyObsBrowserSource(ws, sceneName, tradeSourceName, currentOriginUrl("/trade.html"));
    await applyObsBrowserSource(ws, sceneName, battleSourceName, currentOriginUrl("/battle.html"));
    await applyObsBrowserSource(ws, sceneName, rankingSourceName, currentOriginUrl("/ranking.html"));

    setStatus("#obs-status", `${t("status-obs-updated")} ${sceneName} / ${packSourceName} + ${collectionSourceName} + ${tradeSourceName} + ${battleSourceName} + ${rankingSourceName}`, "ok");
    setPill("#obs-pill", t("pill-obs-connected"), true);
    settings.obs ||= {};
    settings.obs.enabled = true;
    await saveSettings(settings);
    showNotice(t("notice-obs-scene-updated"));
  } catch (error) {
    setStatus("#obs-status", `${t("error-obs-setup-failed")} ${error.message}`, "error");
  } finally {
    try { ws?.close(); } catch {}
  }
}

async function applyObsBrowserSource(ws, sceneName, sourceName, url) {
  const scenes = await obsRequest(ws, "GetSceneList");
  if (!(scenes.scenes || []).some((scene) => scene.sceneName === sceneName)) {
    await obsRequest(ws, "CreateScene", { sceneName });
  }
  const inputs = await obsRequest(ws, "GetInputList");
  const exists = (inputs.inputs || []).some((input) => input.inputName === sourceName);
  const inputSettings = { url, width: 1920, height: 1080, fps: 60, shutdown: false, restart_when_active: true, reroute_audio: false };
  if (!exists) {
    try {
      await obsRequest(ws, "CreateInput", { sceneName, inputName: sourceName, inputKind: "browser_source", inputSettings, sceneItemEnabled: true });
    } catch {
      await obsRequest(ws, "CreateInput", { sceneName, inputName: sourceName, inputKind: "obs_browser_source", inputSettings, sceneItemEnabled: true });
    }
  } else {
    await obsRequest(ws, "SetInputSettings", { inputName: sourceName, inputSettings, overlay: true });
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
      positionX: 0, positionY: 0, scaleX: 1, scaleY: 1,
      cropTop: 0, cropRight: 0, cropBottom: 0, cropLeft: 0,
      boundsType: "OBS_BOUNDS_STRETCH", boundsWidth: 1920, boundsHeight: 1080
    }
  });
}

async function handleShowcaseSync() {
  const statusEl = $("#showcase-status");
  if (statusEl) statusEl.hidden = false;
  setStatus("#showcase-status", t("status-showcase-saving"), "neutral");
  try {
    settings.showcase ||= {};
    await saveSettings(settings);
    const showcase = settings.showcase;
    const result = await syncShowcaseReward({
      rewardId: showcase.rewardIds?.[0] || "",
      title: $("#showcase-reward-title").value || "Sammlung zeigen",
      cost: Number($("#showcase-reward-cost").value || 500),
      prompt: $("#showcase-prompt").value || "",
      backgroundColor: $("#showcase-bg-color").value || "#9147ff",
      isEnabled: $("#showcase-enabled").checked,
      isPaused: $("#showcase-paused").checked,
      globalCooldown: Math.max(0, Number($("#showcase-cooldown").value || 0))
    });
    settings = normalizeSettings(result.settings || await getSettings());
    hydrateTrigger();
    setStatus("#showcase-status", t("notice-showcase-saved"), "ok");
    showNotice(t("notice-showcase-saved"));
  } catch (error) {
    setStatus("#showcase-status", error.message, "error");
  }
}

async function handleShowcaseDelete() {
  const rewardId = settings.showcase?.rewardIds?.[0];
  if (!rewardId) return;
  if (!window.confirm(t("confirm-delete-reward"))) return;
  $("#showcase-status").hidden = false;
  setStatus("#showcase-status", t("status-deleting-reward"), "neutral");
  try {
    const result = await deleteTwitchReward({ rewardId });
    settings = normalizeSettings(result.settings || await getSettings());
    hydrateTrigger();
    setStatus("#showcase-status", t("notice-reward-deleted"), "ok");
    showNotice(t("notice-reward-deleted"));
  } catch (error) {
    setStatus("#showcase-status", error.message, "error");
  }
}

function bindShowcase() {
  const fields = {
    "#showcase-seconds": ["secondsPerBooster", "number"]
  };
  for (const [selector, [field, type]] of Object.entries(fields)) {
    $(selector).addEventListener("input", (event) => {
      settings.showcase ||= {};
      settings.showcase[field] = type === "checkbox" ? event.target.checked : type === "number" ? Number(event.target.value) : event.target.value;
    });
  }
  $("#showcase-info-toggle").addEventListener("click", () => {
    const box = $("#showcase-info");
    const toggle = $("#showcase-info-toggle");
    const show = box.hidden;
    box.hidden = !show;
    toggle.textContent = show ? t("btn-showcase-info-hide") : t("btn-showcase-info");
  });
  $("#showcase-sync-reward").addEventListener("click", handleShowcaseSync);
  $("#showcase-delete-reward").addEventListener("click", handleShowcaseDelete);
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
              <option value="${rarity.id}" ${rarity.id === card.rarity ? "selected" : ""}>${t(`rarity-${rarity.id}`)}</option>
            `).join("")}</select></label>
          </div>
          <div class="inline-fields">
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
    // A copy loses the booster association - it must be assigned manually like a new card.
    const copy = { ...original, id: createId("card"), title: `${original.title} Kopie`, boosterIds: [] };
    settings.deck.cards.push(copy);
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

function boosterExists(boosterId) {
  return Boolean(settings.boosters?.some((booster) => booster.id === boosterId));
}

function boosterGroupLabel(boosterId) {
  if (boosterExists(boosterId)) return boosterTitle(boosterId);
  return t("label-unknown-booster");
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
    const sortedGroups = [...groups.entries()].sort((a, b) => boosterGroupLabel(a[0]).localeCompare(boosterGroupLabel(b[0])));
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
          const titleHtml = boosterExists(boosterId)
            ? `<p class="user-card-booster-title">${escapeHtml(boosterTitle(boosterId))}</p>`
            : `<div class="user-card-booster-title is-orphan">
                 <span>${t("label-unknown-booster")}</span>
                 <select data-action="reassign-group" data-old-booster="${escapeHtml(boosterId)}">
                   <option value="">${t("option-assign-booster")}</option>
                   ${(settings.boosters || []).map((b) => `<option value="${escapeHtml(b.id)}">${escapeHtml(b.title)}</option>`).join("")}
                 </select>
               </div>`;
          return `
            <div class="user-card-booster-group">
              ${titleHtml}
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

async function reassignOrphanGroup(oldBoosterId, newBoosterId) {
  const source = collections[oldBoosterId];
  if (!source || !newBoosterId || oldBoosterId === newBoosterId) return;
  collections[newBoosterId] ||= { version: source.version || 1, boosterId: newBoosterId, users: {} };
  const target = collections[newBoosterId];
  target.users ||= {};
  for (const [userKey, userData] of Object.entries(source.users || {})) {
    target.users[userKey] ||= { displayName: userData?.displayName || userKey, cards: {} };
    target.users[userKey].displayName = userData?.displayName || target.users[userKey].displayName;
    target.users[userKey].cards ||= {};
    for (const [cardId, count] of Object.entries(userData?.cards || {})) {
      target.users[userKey].cards[cardId] = (Number(target.users[userKey].cards[cardId]) || 0) + (Number(count) || 0);
    }
  }
  source.users = {};
  await persistCollectionSnapshot(target, newBoosterId, "");
  await persistCollectionSnapshot(source, oldBoosterId, "");
  renderUsers();
  showNotice(t("notice-group-reassigned"));
}

async function handleUserListChange(event) {
  const reassign = event.target.closest("[data-action='reassign-group']");
  if (reassign) {
    event.stopPropagation();
    const newBoosterId = reassign.value;
    if (newBoosterId) await reassignOrphanGroup(reassign.dataset.oldBooster, newBoosterId);
    return;
  }
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

let commandUsage = { users: [], pack: {}, trade: {}, battle: {} };

async function loadCommandUsage() {
  try {
    const result = await getCommandUsage();
    commandUsage = result.usage || { users: [], pack: {}, trade: {}, battle: {} };
  } catch {
    commandUsage = { users: [], pack: {}, trade: {}, battle: {} };
  }
}

function formatResetTime(iso) {
  if (!iso) return "–";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "–" : date.toLocaleString();
}

function remainingLabel(value) {
  return value == null ? t("cu-unlimited") : `${value} ${t("cu-remaining")}`;
}

function renderCommandUsage() {
  const list = $("#cu-list");
  if (!list) return;
  const info = $("#cu-reset-info");
  if (info) {
    info.textContent = `${t("cu-pack-reset")}: ${formatResetTime(commandUsage.pack?.nextResetAt)} · ${t("cu-trade-reset")}: ${formatResetTime(commandUsage.trade?.nextResetAt)} · ${t("cu-battle-reset")}: ${formatResetTime(commandUsage.battle?.nextResetAt)}`;
  }
  const filter = ($("#cu-search")?.value || "").trim().toLowerCase();
  const allUsers = [...(commandUsage.users || [])].sort((a, b) => (a.displayName || a.login).localeCompare(b.displayName || b.login));
  const users = allUsers.filter((user) => !filter || (user.displayName || "").toLowerCase().includes(filter) || (user.login || "").includes(filter));
  $("#cu-empty-hint").hidden = allUsers.length > 0;
  if (!users.length) {
    list.innerHTML = filter
      ? `<p class="hint">${t("hint-no-users-found")} „${escapeHtml(filter)}“.</p>`
      : "";
    return;
  }
  list.innerHTML = users.map((user) => `
    <div class="user-card" data-user="${escapeHtml(user.login)}">
      <div class="user-card-header">
        <strong>${escapeHtml(user.displayName || user.login)}</strong>
        <span class="cu-stats">!pack: <b>${user.packCount || 0}</b> (${escapeHtml(remainingLabel(user.packRemaining))}) · !trade: <b>${user.tradeCount || 0}</b> (${escapeHtml(remainingLabel(user.tradeRemaining))}) · !battle: <b>${user.battleCount || 0}</b> (${escapeHtml(remainingLabel(user.battleRemaining))})</span>
        <button class="danger-button" type="button" data-action="cu-reset-user" data-user="${escapeHtml(user.login)}">${t("btn-cu-reset-user")}</button>
      </div>
    </div>
  `).join("");
}

async function handleCommandUsageClick(event) {
  const button = event.target.closest("[data-action='cu-reset-user']");
  if (!button) return;
  await resetCommandUsage(button.dataset.user);
  await loadCommandUsage();
  renderCommandUsage();
  showNotice(t("notice-cu-reset"));
}

async function handleCommandUsageResetAll() {
  await resetCommandUsage("");
  await loadCommandUsage();
  renderCommandUsage();
  showNotice(t("notice-cu-reset-all"));
}

function bindCommandUsage() {
  $("#cu-search").addEventListener("input", renderCommandUsage);
  $("#cu-list").addEventListener("click", handleCommandUsageClick);
  $("#cu-reset-all").addEventListener("click", handleCommandUsageResetAll);
}

let queuePollTimer;

function renderQueueItems(items) {
  const list = $("#queue-list");
  if (!list) return;
  const hint = $("#queue-empty-hint");
  if (hint) hint.hidden = items.length > 0;
  list.innerHTML = items.map((item) => {
    const kindLabel = item.kind === "draw" ? t("queue-kind-draw") : item.kind === "showcollection" ? t("queue-kind-showcollection") : item.kind === "trade" ? t("queue-kind-trade") : (item.kind || "");
    const sourceLabel = item.source === "chat" ? t("queue-source-chat") : item.source === "channelpoints" ? t("queue-source-channelpoints") : (item.source || "");
    const badge = item.processing ? `<span class="queue-processing">${t("queue-processing")}</span>` : "";
    // The in-flight item can't be removed (it's already playing); only waiting items get a delete button.
    const remove = item.processing
      ? ""
      : `<button class="ghost-button queue-remove" type="button" data-action="queue-remove" data-id="${escapeHtml(item.id || "")}">${t("btn-queue-remove")}</button>`;
    return `
      <div class="user-card${item.processing ? " is-processing" : ""}">
        <div class="user-card-header">
          <strong>${escapeHtml(item.user || item.userLogin || "?")}</strong>
          <span class="queue-meta">${escapeHtml(kindLabel)} · ${escapeHtml(sourceLabel)} ${badge}</span>
          <span class="queue-time">${escapeHtml(item.triggeredAt ? new Date(item.triggeredAt).toLocaleTimeString() : "")}</span>
          ${remove}
        </div>
      </div>
    `;
  }).join("");
}

function applyQueueState(result) {
  renderQueueItems(result.items || []);
  const pausedBox = $("#queue-paused");
  if (pausedBox) pausedBox.checked = result.paused === true;
}

async function refreshQueue() {
  try {
    applyQueueState(await getQueueItems());
  } catch {
  }
}

function startQueuePolling() {
  clearInterval(queuePollTimer);
  refreshQueue();
  queuePollTimer = setInterval(refreshQueue, 1500);
}

async function handleQueueListClick(event) {
  const button = event.target.closest("[data-action='queue-remove']");
  if (!button) return;
  try {
    await removeQueueItem(button.dataset.id);
    await refreshQueue();
  } catch (error) {
    showNotice(error.message, "error");
  }
}

async function handleQueuePauseToggle(event) {
  try {
    await setQueuePaused(event.target.checked);
  } catch (error) {
    showNotice(error.message, "error");
    event.target.checked = !event.target.checked;
  }
}

async function handleQueueClear() {
  try {
    await clearQueue();
    await refreshQueue();
    showNotice(t("notice-queue-cleared"));
  } catch (error) {
    showNotice(error.message, "error");
  }
}

function bindQueue() {
  $("#queue-list").addEventListener("click", handleQueueListClick);
  $("#queue-paused").addEventListener("change", handleQueuePauseToggle);
  $("#queue-clear").addEventListener("click", handleQueueClear);
}

function isQueueTabActive() {
  return document.querySelector('[data-panel="queue"]')?.classList.contains("is-active");
}

function hydrateChatCommands() {
  settings.chatCommands ||= {};
  const cc = settings.chatCommands;
  cc.pack ||= {};
  cc.collection ||= {};
  $("#cc-pack-enabled").checked = cc.pack.enabled !== false;
  $("#cc-collection-enabled").checked = cc.collection.enabled !== false;
  $("#cc-pack-prefix").value = cc.pack.prefix || "!";
  $("#cc-pack-command").value = cc.pack.command || "pack";
  $("#cc-pack-maxuses").value = cc.pack.maxUses ?? 0;
  $("#cc-pack-cooldown").value = cc.pack.cooldownSeconds ?? 0;
  $("#cc-pack-reset-value").value = cc.pack.resetValue ?? 1;
  $("#cc-pack-reset-unit").value = cc.pack.resetUnit || "days";
  $("#cc-pack-success-message").value = cc.pack.successMessage || "@userName, ein Booster wurde verkauft und wird gleich für dich geöffnet.";
  $("#cc-pack-limit-message").value = cc.pack.limitMessage || "@userName, Leider hast du das maximum an Packs aktuell erreicht. Bitte warte bis [Uhrzeit] Uhr. Dann stehen dir neue Packs zur Verfügung.";
  $("#cc-pack-cooldown-message").value = cc.pack.cooldownMessage || "@userName, leider musst du noch [Restzeit] Sekunden warten, bis du diesen Befehl erneut ausführen darfst.";
  $("#cc-collection-prefix").value = cc.collection.prefix || "!";
  $("#cc-collection-command").value = cc.collection.command || "collection";
  $("#cc-collection-chatoutput-enabled").checked = cc.collection.chatOutputEnabled !== false;
  $("#cc-collection-header-message").value = cc.collection.headerMessage || "";
  $("#cc-collection-empty-message").value = cc.collection.emptyMessage || "";

  const trade = cc.trade || {};
  $("#cc-trade-enabled").checked = trade.enabled !== false;
  $("#cc-trade-prefix").value = trade.prefix || "!";
  $("#cc-trade-command").value = trade.command || "trade";
  $("#cc-trade-maxuses").value = trade.maxUses ?? 5;
  $("#cc-trade-cooldown").value = trade.cooldownSeconds ?? 60;
  $("#cc-trade-reset-value").value = trade.resetValue ?? 8;
  $("#cc-trade-reset-unit").value = trade.resetUnit || "hours";
  $("#cc-trade-timeout").value = trade.requestTimeoutSeconds ?? 120;
  $("#cc-trade-offer-message").value = trade.offerMessage || "";
  $("#cc-trade-cardnotfound-message").value = trade.cardNotFoundMessage || "";
  $("#cc-trade-offernotowned-message").value = trade.offerNotOwnedMessage || "";
  $("#cc-trade-usernotfound-message").value = trade.userNotFoundMessage || "";
  $("#cc-trade-cooldown-message").value = trade.cooldownMessage || "";
  $("#cc-trade-limit-message").value = trade.limitMessage || "";
  $("#cc-trade-timeout-message").value = trade.timeoutMessage || "";
  $("#cc-trade-busy-message").value = trade.busyMessage || "";

  const tradeyes = cc.tradeyes || {};
  $("#cc-tradeyes-enabled").checked = tradeyes.enabled !== false;
  $("#cc-tradeyes-prefix").value = tradeyes.prefix || "!";
  $("#cc-tradeyes-command").value = tradeyes.command || "tradeyes";
  $("#cc-tradeyes-notowned-message").value = tradeyes.notOwnedMessage || "";
  $("#cc-tradeyes-success-message").value = tradeyes.successMessage || "";

  const tradeno = cc.tradeno || {};
  $("#cc-tradeno-enabled").checked = tradeno.enabled !== false;
  $("#cc-tradeno-prefix").value = tradeno.prefix || "!";
  $("#cc-tradeno-command").value = tradeno.command || "tradeno";
  $("#cc-tradeno-decline-message").value = tradeno.declineMessage || "";

  const battle = cc.battle || {};
  $("#cc-battle-enabled").checked = battle.enabled !== false;
  $("#cc-battle-prefix").value = battle.prefix || "!";
  $("#cc-battle-command").value = battle.command || "battle";
  $("#cc-battle-lineupsize").value = battle.lineupSize ?? 3;
  $("#cc-battle-maxuses").value = battle.maxUses ?? 5;
  $("#cc-battle-cooldown").value = battle.cooldownSeconds ?? 60;
  $("#cc-battle-reset-value").value = battle.resetValue ?? 8;
  $("#cc-battle-reset-unit").value = battle.resetUnit || "hours";
  $("#cc-battle-timeout").value = battle.requestTimeoutSeconds ?? 120;
  $("#cc-battle-offer-message").value = battle.offerMessage || "";
  $("#cc-battle-usernotfound-message").value = battle.userNotFoundMessage || "";
  $("#cc-battle-selfchallenge-message").value = battle.selfChallengeMessage || "";
  $("#cc-battle-notenoughcards-message").value = battle.notEnoughCardsMessage || "";
  $("#cc-battle-cooldown-message").value = battle.cooldownMessage || "";
  $("#cc-battle-limit-message").value = battle.limitMessage || "";
  $("#cc-battle-timeout-message").value = battle.timeoutMessage || "";
  $("#cc-battle-busy-message").value = battle.busyMessage || "";

  const battleyes = cc.battleyes || {};
  $("#cc-battleyes-enabled").checked = battleyes.enabled !== false;
  $("#cc-battleyes-prefix").value = battleyes.prefix || "!";
  $("#cc-battleyes-command").value = battleyes.command || "battleyes";
  $("#cc-battleyes-result-message").value = battleyes.resultMessage || "";

  const battleno = cc.battleno || {};
  $("#cc-battleno-enabled").checked = battleno.enabled !== false;
  $("#cc-battleno-prefix").value = battleno.prefix || "!";
  $("#cc-battleno-command").value = battleno.command || "battleno";
  $("#cc-battleno-decline-message").value = battleno.declineMessage || "";

  const ranking = cc.ranking || {};
  $("#cc-ranking-enabled").checked = ranking.enabled !== false;
  $("#cc-ranking-prefix").value = ranking.prefix || "!";
  $("#cc-ranking-command").value = ranking.command || "ranking";
  $("#cc-ranking-seconds").value = ranking.displaySeconds ?? 8;
}

function readChatCommandsFromForm() {
  settings.chatCommands ||= {};
  const cc = settings.chatCommands;
  cc.pack ||= {};
  cc.collection ||= {};
  cc.enabled = true;
  cc.pack.enabled = $("#cc-pack-enabled").checked;
  cc.collection.enabled = $("#cc-collection-enabled").checked;
  cc.pack.prefix = $("#cc-pack-prefix").value || "!";
  cc.pack.command = $("#cc-pack-command").value.trim() || "pack";
  cc.pack.maxUses = Math.max(0, Math.round(Number($("#cc-pack-maxuses").value) || 0));
  cc.pack.cooldownSeconds = Math.max(0, Math.round(Number($("#cc-pack-cooldown").value) || 0));
  cc.pack.resetValue = Math.max(1, Math.round(Number($("#cc-pack-reset-value").value) || 1));
  cc.pack.resetUnit = $("#cc-pack-reset-unit").value || "days";
  cc.pack.successMessage = $("#cc-pack-success-message").value;
  cc.pack.limitMessage = $("#cc-pack-limit-message").value;
  cc.pack.cooldownMessage = $("#cc-pack-cooldown-message").value;
  cc.collection.prefix = $("#cc-collection-prefix").value || "!";
  cc.collection.command = $("#cc-collection-command").value.trim() || "collection";
  cc.collection.chatOutputEnabled = $("#cc-collection-chatoutput-enabled").checked;
  cc.collection.headerMessage = $("#cc-collection-header-message").value;
  cc.collection.emptyMessage = $("#cc-collection-empty-message").value;

  cc.trade ||= {};
  cc.trade.enabled = $("#cc-trade-enabled").checked;
  cc.trade.prefix = $("#cc-trade-prefix").value || "!";
  cc.trade.command = $("#cc-trade-command").value.trim() || "trade";
  cc.trade.maxUses = Math.max(0, Math.round(Number($("#cc-trade-maxuses").value) || 0));
  cc.trade.cooldownSeconds = Math.max(0, Math.round(Number($("#cc-trade-cooldown").value) || 0));
  cc.trade.resetValue = Math.max(1, Math.round(Number($("#cc-trade-reset-value").value) || 1));
  cc.trade.resetUnit = $("#cc-trade-reset-unit").value || "hours";
  cc.trade.requestTimeoutSeconds = Math.max(10, Math.round(Number($("#cc-trade-timeout").value) || 120));
  cc.trade.offerMessage = $("#cc-trade-offer-message").value;
  cc.trade.cardNotFoundMessage = $("#cc-trade-cardnotfound-message").value;
  cc.trade.offerNotOwnedMessage = $("#cc-trade-offernotowned-message").value;
  cc.trade.userNotFoundMessage = $("#cc-trade-usernotfound-message").value;
  cc.trade.cooldownMessage = $("#cc-trade-cooldown-message").value;
  cc.trade.limitMessage = $("#cc-trade-limit-message").value;
  cc.trade.timeoutMessage = $("#cc-trade-timeout-message").value;
  cc.trade.busyMessage = $("#cc-trade-busy-message").value;

  cc.tradeyes ||= {};
  cc.tradeyes.enabled = $("#cc-tradeyes-enabled").checked;
  cc.tradeyes.prefix = $("#cc-tradeyes-prefix").value || "!";
  cc.tradeyes.command = $("#cc-tradeyes-command").value.trim() || "tradeyes";
  cc.tradeyes.notOwnedMessage = $("#cc-tradeyes-notowned-message").value;
  cc.tradeyes.successMessage = $("#cc-tradeyes-success-message").value;

  cc.tradeno ||= {};
  cc.tradeno.enabled = $("#cc-tradeno-enabled").checked;
  cc.tradeno.prefix = $("#cc-tradeno-prefix").value || "!";
  cc.tradeno.command = $("#cc-tradeno-command").value.trim() || "tradeno";
  cc.tradeno.declineMessage = $("#cc-tradeno-decline-message").value;

  cc.battle ||= {};
  cc.battle.enabled = $("#cc-battle-enabled").checked;
  cc.battle.prefix = $("#cc-battle-prefix").value || "!";
  cc.battle.command = $("#cc-battle-command").value.trim() || "battle";
  cc.battle.lineupSize = Math.max(1, Math.round(Number($("#cc-battle-lineupsize").value) || 3));
  cc.battle.maxUses = Math.max(0, Math.round(Number($("#cc-battle-maxuses").value) || 0));
  cc.battle.cooldownSeconds = Math.max(0, Math.round(Number($("#cc-battle-cooldown").value) || 0));
  cc.battle.resetValue = Math.max(1, Math.round(Number($("#cc-battle-reset-value").value) || 1));
  cc.battle.resetUnit = $("#cc-battle-reset-unit").value || "hours";
  cc.battle.requestTimeoutSeconds = Math.max(10, Math.round(Number($("#cc-battle-timeout").value) || 120));
  cc.battle.offerMessage = $("#cc-battle-offer-message").value;
  cc.battle.userNotFoundMessage = $("#cc-battle-usernotfound-message").value;
  cc.battle.selfChallengeMessage = $("#cc-battle-selfchallenge-message").value;
  cc.battle.notEnoughCardsMessage = $("#cc-battle-notenoughcards-message").value;
  cc.battle.cooldownMessage = $("#cc-battle-cooldown-message").value;
  cc.battle.limitMessage = $("#cc-battle-limit-message").value;
  cc.battle.timeoutMessage = $("#cc-battle-timeout-message").value;
  cc.battle.busyMessage = $("#cc-battle-busy-message").value;

  cc.battleyes ||= {};
  cc.battleyes.enabled = $("#cc-battleyes-enabled").checked;
  cc.battleyes.prefix = $("#cc-battleyes-prefix").value || "!";
  cc.battleyes.command = $("#cc-battleyes-command").value.trim() || "battleyes";
  cc.battleyes.resultMessage = $("#cc-battleyes-result-message").value;

  cc.battleno ||= {};
  cc.battleno.enabled = $("#cc-battleno-enabled").checked;
  cc.battleno.prefix = $("#cc-battleno-prefix").value || "!";
  cc.battleno.command = $("#cc-battleno-command").value.trim() || "battleno";
  cc.battleno.declineMessage = $("#cc-battleno-decline-message").value;

  cc.ranking ||= {};
  cc.ranking.enabled = $("#cc-ranking-enabled").checked;
  cc.ranking.prefix = $("#cc-ranking-prefix").value || "!";
  cc.ranking.command = $("#cc-ranking-command").value.trim() || "ranking";
  cc.ranking.displaySeconds = Math.max(2, Math.round(Number($("#cc-ranking-seconds").value) || 8));
}

function insertVariableIntoField(fieldId, variable) {
  const field = $(`#${fieldId}`);
  if (!field) return;
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? field.value.length;
  field.value = `${field.value.slice(0, start)}${variable}${field.value.slice(end)}`;
  field.focus();
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

function bindVariableChips() {
  // One document-wide handler for every variable chip (chat commands AND the draw reward):
  // insert into the textarea named by the chip container's data-target.
  document.addEventListener("click", (event) => {
    const button = event.target.closest(".var-chips [data-insert]");
    if (!button) return;
    const target = button.closest(".var-chips")?.dataset.target;
    if (target) insertVariableIntoField(target, button.dataset.insert);
  });
}

function bindChatCommands() {
  const panel = document.querySelector('[data-panel="chatcommands"]');
  panel.addEventListener("input", readChatCommandsFromForm);
  panel.addEventListener("change", readChatCommandsFromForm);
}

function hydrateTrigger() {
  settings.twitch ||= {};
  settings.twitch.clientId ||= DEFAULT_TWITCH_CLIENT_ID;
  hydrateDrawReward();
  const showcase = settings.showcase || {};
  $("#showcase-enabled").checked = showcase.rewardEnabled !== false;
  $("#showcase-paused").checked = showcase.rewardPaused === true;
  $("#showcase-reward-title").value = showcase.rewardName || "Sammlung zeigen";
  $("#showcase-reward-cost").value = showcase.rewardCost || 500;
  $("#showcase-prompt").value = showcase.rewardPrompt || "";
  $("#showcase-cooldown").value = showcase.rewardGlobalCooldown || 0;
  $("#showcase-bg-color").value = showcase.rewardBackgroundColor || "#9147ff";
  $("#showcase-seconds").value = showcase.secondsPerBooster || 12;
}

function bindTrigger() {
  $("#connect-twitch").addEventListener("click", connectTwitch);
  $("#disconnect-twitch").addEventListener("click", handleTwitchDisconnect);
  $("#refresh-twitch-status").addEventListener("click", refreshTwitchStatus);
  $("#connect-twitch-bot").addEventListener("click", connectTwitchBot);
  $("#disconnect-twitch-bot").addEventListener("click", handleBotDisconnect);
  $("#refresh-twitch-bot-status").addEventListener("click", refreshBotStatus);
  bindDrawReward();
  bindShowcase();
}

function hydrateDesign() {
  renderFontSelect();
  $("#font-family").value = settings.style.fontFamily || "";
  setSegToggle("theme-toggle", settings.style.themeMode || "light");
  setSegToggle("language-toggle", settings.language || "de");
  $("#style-accent").value = settings.style.accentColor || "#ff78bb";
  $("#volume").value = settings.style.volume ?? 65;
  updateSoundRow("open");
  updateSoundRow("reveal");
  updateSoundRow("trade");
  updateSoundRow("battle");
  $("#show-collection").checked = settings.style.showCollection !== false;
  $("#card-borders").checked = settings.style.cardBorders !== false;
  $("#name-position").value = ["bottom", "middle", "top"].includes(settings.style.namePosition) ? settings.style.namePosition : "bottom";
  for (const rarity of RARITIES) {
    const input = $(`#rarity-color-${rarity.id}`);
    if (input) input.value = settings.rarityColors?.[rarity.id] || DEFAULT_RARITY_COLORS[rarity.id];
    const weightInput = $(`#rarity-weight-${rarity.id}`);
    if (weightInput) weightInput.value = settings.rarityWeights?.[rarity.id] ?? DEFAULT_RARITY_WEIGHTS[rarity.id];
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
  $("#obs-collection-source-name").value = settings.showcase?.sourceName || "Streamer Card Sammlung";
  $("#obs-trade-source-name").value = settings.tradeAnimation?.sourceName || "Streamer Card Tausch";
  $("#trade-anim-enabled").checked = settings.tradeAnimation?.enabled === true;
  $("#trade-anim-sendchat").checked = settings.tradeAnimation?.sendChat !== false;
  $("#trade-anim-style").value = ["swap", "arc", "flip"].includes(settings.tradeAnimation?.style) ? settings.tradeAnimation.style : "swap";
  $("#trade-anim-duration").value = ["short", "medium", "long"].includes(settings.tradeAnimation?.duration) ? settings.tradeAnimation.duration : "medium";
  $("#obs-battle-source-name").value = settings.battleAnimation?.sourceName || "Streamer Card Kampf";
  $("#obs-ranking-source-name").value = settings.ranking?.sourceName || "Streamer Card Ranking";
  $("#battle-anim-enabled").checked = settings.battleAnimation?.enabled === true;
  $("#battle-anim-sendchat").checked = settings.battleAnimation?.sendChat !== false;
  $("#battle-anim-style").value = ["clash", "ranged", "hp"].includes(settings.battleAnimation?.style) ? settings.battleAnimation.style : "clash";
  $("#battle-anim-duration").value = ["short", "medium", "long"].includes(settings.battleAnimation?.duration) ? settings.battleAnimation.duration : "medium";
  const strength = settings.battleStrength || {};
  for (const rarity of RARITIES) {
    const input = $(`#battle-strength-${rarity.id}`);
    if (input) input.value = strength[rarity.id] ?? "";
  }
  $("#battle-strength-variance").value = strength.variance ?? 0.6;
  $("#battle-strength-hpfactor").value = strength.hpFactor ?? 10;
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
  if (status && !dataUrl) status.textContent = t("status-default-sound");
  if (playButton) playButton.disabled = false;
  if (removeButton) removeButton.disabled = !dataUrl;
}

let previewAudioContext;

// Mirrors the built-in fallback tones each overlay plays when no custom sound is uploaded
// (see playSound() in overlay.js, playTradeSound() in trade.js, playBattleSound() in
// battle.js), so "Abspielen" previews exactly what viewers actually hear.
function playDefaultSoundPreview(kind, volume) {
  previewAudioContext ||= new AudioContext();
  const ctx = previewAudioContext;
  const now = ctx.currentTime;
  const gain = ctx.createGain();
  gain.connect(ctx.destination);
  const presets = {
    open: { freqs: [220, 330], peak: 0.12, dur: 0.44, types: ["sine", "triangle"] },
    reveal: { freqs: [523.25, 659.25, 783.99], peak: 0.12, dur: 0.44, types: ["sine", "triangle"] },
    trade: { freqs: [523.25, 659.25, 880], peak: 0.14, dur: 0.6, types: ["sine", "triangle"] },
    battle: { freqs: [220, 174.6], peak: 0.1, dur: 0.5, types: ["sawtooth", "sawtooth"] }
  };
  const preset = presets[kind] || presets.open;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(preset.peak * volume, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + preset.dur);
  preset.freqs.forEach((freq, index) => {
    const osc = ctx.createOscillator();
    osc.type = preset.types[index % preset.types.length];
    osc.frequency.setValueAtTime(freq, now + index * 0.07);
    osc.connect(gain);
    osc.start(now + index * 0.07);
    osc.stop(now + preset.dur + index * 0.04);
  });
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

function previewCard() {
  const cards = settings.deck?.cards || [];
  return cards.find((card) => card.id === previewCardId) || selectedCard() || cards[0];
}

function renderPreviewCardSelect() {
  const select = $("#preview-card-select");
  if (!select) return;
  const cards = settings.deck?.cards || [];
  const current = previewCard();
  previewCardId = current?.id;
  select.innerHTML = cards
    .map((card) => `<option value="${escapeHtml(card.id)}" ${card.id === previewCardId ? "selected" : ""}>${escapeHtml(card.title || card.id)}</option>`)
    .join("");
}

function refreshSettingsPreview() {
  renderPreviewCardSelect();
  const card = previewCard();
  if ($("#settings-preview-card")) $("#settings-preview-card").innerHTML = card ? cardMarkup(card) : "";
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
    "#volume": "volume",
    "#show-collection": "showCollection",
    "#card-borders": "cardBorders",
    "#name-position": "namePosition"
  };
  for (const [selector, field] of Object.entries(styleFields)) {
    $(selector).addEventListener("input", (event) => {
      const target = event.target;
      settings.style[field] = target.type === "checkbox" ? target.checked : target.type === "range" ? Number(target.value) : target.value;
      applyTheme(settings);
      refreshSettingsPreview();
    });
  }
  bindSegToggle("theme-toggle", (value) => {
    settings.style.themeMode = value;
    applyTheme(settings);
    refreshSettingsPreview();
    scheduleAutoSave();
  });
  $("#preview-card-select").addEventListener("change", (event) => {
    previewCardId = event.target.value;
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
  $$("[data-rarity-weight]").forEach((input) => {
    input.addEventListener("input", (event) => {
      settings.rarityWeights ||= {};
      const value = Number(event.target.value);
      settings.rarityWeights[event.target.dataset.rarityWeight] = Number.isFinite(value) && value > 0 ? value : 0;
      setRarityWeights(settings.rarityWeights);
      scheduleAutoSave();
    });
  });
  $("#reset-rarity-weights").addEventListener("click", () => {
    settings.rarityWeights = { ...DEFAULT_RARITY_WEIGHTS };
    setRarityWeights(settings.rarityWeights);
    hydrateDesign();
    scheduleAutoSave();
    showNotice(t("notice-rarity-weights-reset"));
  });
  bindSegToggle("language-toggle", (value) => {
    settings.language = value;
    renderAll();
    refreshSettingsPreview();
    scheduleAutoSave();
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
  $("#obs-collection-source-name").addEventListener("input", (event) => {
    settings.showcase ||= {};
    settings.showcase.sourceName = event.target.value;
  });
  $("#test-obs").addEventListener("click", testObsConnection);
  $("#setup-obs").addEventListener("click", setupObsOverlay);
  $("#obs-info-toggle").addEventListener("click", () => {
    const box = $("#obs-info");
    const toggle = $("#obs-info-toggle");
    const show = box.hidden;
    box.hidden = !show;
    toggle.textContent = show ? t("btn-obs-info-hide") : t("btn-obs-info");
  });
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
  $("#sound-trade").addEventListener("change", async (event) => {
    if (!event.target.files?.[0]) return;
    settings.sounds ||= {};
    settings.sounds.trade = await readFileAsDataUrl(event.target.files[0]);
    event.target.value = "";
    updateSoundRow("trade");
    scheduleAutoSave();
    showNotice(t("notice-sound-trade-saved"));
  });
  $("#remove-trade-sound").addEventListener("click", () => {
    settings.sounds ||= {};
    settings.sounds.trade = "";
    $("#sound-trade").value = "";
    updateSoundRow("trade");
    scheduleAutoSave();
    showNotice(t("notice-sound-trade-removed"));
  });
  $("#sound-battle").addEventListener("change", async (event) => {
    if (!event.target.files?.[0]) return;
    settings.sounds ||= {};
    settings.sounds.battle = await readFileAsDataUrl(event.target.files[0]);
    event.target.value = "";
    updateSoundRow("battle");
    scheduleAutoSave();
    showNotice(t("notice-sound-battle-saved"));
  });
  $("#remove-battle-sound").addEventListener("click", () => {
    settings.sounds ||= {};
    settings.sounds.battle = "";
    $("#sound-battle").value = "";
    updateSoundRow("battle");
    scheduleAutoSave();
    showNotice(t("notice-sound-battle-removed"));
  });
  $("#play-open-sound").addEventListener("click", () => playSoundPreview("open"));
  $("#play-reveal-sound").addEventListener("click", () => playSoundPreview("reveal"));
  $("#play-trade-sound").addEventListener("click", () => playSoundPreview("trade"));
  $("#play-battle-sound").addEventListener("click", () => playSoundPreview("battle"));

  $("#obs-trade-source-name").addEventListener("input", (event) => {
    settings.tradeAnimation ||= {};
    settings.tradeAnimation.sourceName = event.target.value;
  });
  $("#trade-anim-enabled").addEventListener("change", (event) => {
    settings.tradeAnimation ||= {};
    settings.tradeAnimation.enabled = event.target.checked;
  });
  $("#trade-anim-sendchat").addEventListener("change", (event) => {
    settings.tradeAnimation ||= {};
    settings.tradeAnimation.sendChat = event.target.checked;
  });
  $("#trade-anim-style").addEventListener("change", (event) => {
    settings.tradeAnimation ||= {};
    settings.tradeAnimation.style = event.target.value;
  });
  $("#trade-anim-duration").addEventListener("change", (event) => {
    settings.tradeAnimation ||= {};
    settings.tradeAnimation.duration = event.target.value;
  });
  $("#trade-anim-test").addEventListener("click", handleTradeAnimTest);

  $("#obs-battle-source-name").addEventListener("input", (event) => {
    settings.battleAnimation ||= {};
    settings.battleAnimation.sourceName = event.target.value;
  });
  $("#obs-ranking-source-name").addEventListener("input", (event) => {
    settings.ranking ||= {};
    settings.ranking.sourceName = event.target.value;
  });
  $("#battle-anim-enabled").addEventListener("change", (event) => {
    settings.battleAnimation ||= {};
    settings.battleAnimation.enabled = event.target.checked;
  });
  $("#battle-anim-sendchat").addEventListener("change", (event) => {
    settings.battleAnimation ||= {};
    settings.battleAnimation.sendChat = event.target.checked;
  });
  $("#battle-anim-style").addEventListener("change", (event) => {
    settings.battleAnimation ||= {};
    settings.battleAnimation.style = event.target.value;
  });
  $("#battle-anim-duration").addEventListener("change", (event) => {
    settings.battleAnimation ||= {};
    settings.battleAnimation.duration = event.target.value;
  });
  $("#battle-anim-test").addEventListener("click", handleBattleAnimTest);

  for (const rarity of RARITIES) {
    const input = $(`#battle-strength-${rarity.id}`);
    if (input) input.addEventListener("input", (event) => {
      settings.battleStrength ||= {};
      settings.battleStrength[rarity.id] = Number(event.target.value) || 1;
    });
  }
  $("#battle-strength-variance").addEventListener("input", (event) => {
    settings.battleStrength ||= {};
    settings.battleStrength.variance = Math.max(0, Number(event.target.value) || 0);
  });
  $("#battle-strength-hpfactor").addEventListener("input", (event) => {
    settings.battleStrength ||= {};
    settings.battleStrength.hpFactor = Math.max(1, Number(event.target.value) || 10);
  });
}

async function handleTradeAnimTest() {
  // Collect cards that actually belong to a booster - the animation needs a booster id per card.
  const pairs = [];
  for (const booster of settings.boosters || []) {
    for (const card of cardsForBooster(settings, booster)) {
      if (card.enabled !== false) pairs.push({ card, booster });
    }
  }
  if (!pairs.length) {
    showNotice(t("notice-trade-test-no-cards"), "error");
    return;
  }
  const pick = () => pairs[Math.floor(Math.random() * pairs.length)];
  const a = pick();
  let b = pick();
  for (let i = 0; i < 10 && pairs.length > 1 && b === a; i++) b = pick();
  let userA = randomUsername();
  let userB = randomUsername();
  for (let i = 0; i < 5 && userB === userA; i++) userB = randomUsername();
  try {
    await testTradeAnimation({
      userA,
      userB,
      cardAId: a.card.id,
      boosterAId: a.booster.id,
      cardBId: b.card.id,
      boosterBId: b.booster.id,
      newCountA: 1 + Math.floor(Math.random() * 9),
      newCountB: 1 + Math.floor(Math.random() * 9)
    });
    showNotice(t("notice-trade-test-started"));
  } catch (error) {
    showNotice(error.message, "error");
  }
}

function battleStrengthOf(card) {
  const strengthDefaults = { common: 1, uncommon: 2, rare: 3, epic: 5, legendary: 8, holo: 12 };
  const rarity = rarityById(card?.rarity).id;
  const v = Number(settings.battleStrength?.[rarity]);
  return Number.isFinite(v) && v > 0 ? v : strengthDefaults[rarity] || 1;
}

// Simulates the same Pokemon-style elimination the server runs for the HP-Leisten-Duell style,
// so the test button previews a realistic sequence of matchups/hits instead of a single round.
function simulateHpElimination(lineupA, lineupB, cardsById) {
  const variance = Number(settings.battleStrength?.variance ?? 0.6);
  const hpFactor = Number(settings.battleStrength?.hpFactor ?? 10);
  let idxA = 0, idxB = 0;
  let hpA = battleStrengthOf(cardsById.get(lineupA[0].cardId)) * hpFactor;
  let hpB = battleStrengthOf(cardsById.get(lineupB[0].cardId)) * hpFactor;
  let maxHpA = hpA, maxHpB = hpB;
  const matchups = [];
  let cardsLostA = 0, cardsLostB = 0;

  while (idxA < lineupA.length && idxB < lineupB.length) {
    const strengthA = battleStrengthOf(cardsById.get(lineupA[idxA].cardId));
    const strengthB = battleStrengthOf(cardsById.get(lineupB[idxB].cardId));
    let attackerIsA = Math.random() < strengthA / (strengthA + strengthB);
    const hits = [];
    let winner = null;
    for (let safety = 0; safety < 1000 && !winner; safety++) {
      if (attackerIsA) {
        const dmg = strengthA * (1 + Math.random() * variance);
        hpB = Math.max(0, hpB - dmg);
        hits.push({ attacker: "A", damage: Math.round(dmg * 10) / 10, hpAfter: Math.round(hpB * 10) / 10 });
        if (hpB <= 0) winner = "A";
      } else {
        const dmg = strengthB * (1 + Math.random() * variance);
        hpA = Math.max(0, hpA - dmg);
        hits.push({ attacker: "B", damage: Math.round(dmg * 10) / 10, hpAfter: Math.round(hpA * 10) / 10 });
        if (hpA <= 0) winner = "B";
      }
      attackerIsA = !attackerIsA;
    }
    matchups.push({ cardA: lineupA[idxA], cardB: lineupB[idxB], maxHpA, maxHpB, hits, winner });
    if (winner === "A") {
      cardsLostB++; idxB++;
      if (idxB < lineupB.length) { hpB = battleStrengthOf(cardsById.get(lineupB[idxB].cardId)) * hpFactor; maxHpB = hpB; }
    } else {
      cardsLostA++; idxA++;
      if (idxA < lineupA.length) { hpA = battleStrengthOf(cardsById.get(lineupA[idxA].cardId)) * hpFactor; maxHpA = hpA; }
    }
  }
  return { matchups, winnerIsA: idxB >= lineupB.length, cardsLostA, cardsLostB };
}

async function handleBattleAnimTest() {
  const cards = (settings.deck?.cards || []).filter((card) => card.enabled !== false);
  const lineupSize = Math.max(1, Math.min(3, Math.floor(cards.length / 2)));
  if (cards.length < lineupSize * 2) {
    showNotice(t("notice-trade-test-no-cards"), "error");
    return;
  }
  const pool = [...cards].sort(() => Math.random() - 0.5);
  const lineupA = pool.slice(0, lineupSize).map((card) => ({ cardId: card.id }));
  const lineupB = pool.slice(lineupSize, lineupSize * 2).map((card) => ({ cardId: card.id }));
  let userA = randomUsername();
  let userB = randomUsername();
  for (let i = 0; i < 5 && userB === userA; i++) userB = randomUsername();

  const isHpMode = settings.battleAnimation?.style === "hp";
  let payload;
  if (isHpMode) {
    const cardsById = new Map(cards.map((card) => [card.id, card]));
    const { matchups, winnerIsA, cardsLostA, cardsLostB } = simulateHpElimination(lineupA, lineupB, cardsById);
    const winsA = cardsLostB, winsB = cardsLostA;
    const loserLineup = winnerIsA ? lineupB : lineupA;
    const prizeCard = loserLineup[Math.floor(Math.random() * loserLineup.length)];
    const prizeCardData = cards.find((card) => card.id === prizeCard.cardId);
    payload = {
      userA, userB, lineupA, lineupB, mode: "hp", hpMatchups: matchups, rounds: [],
      winner: winnerIsA ? "A" : "B", winsA, winsB,
      winnerUser: winnerIsA ? userA : userB, loserUser: winnerIsA ? userB : userA,
      prizeCardId: prizeCard.cardId, prizeCardTitle: prizeCardData?.title || ""
    };
  } else {
    const rounds = lineupA.map((cardA, i) => ({
      cardA, cardB: lineupB[i], winner: Math.random() < 0.5 ? "A" : "B"
    }));
    const winsA = rounds.filter((round) => round.winner === "A").length;
    const winsB = rounds.length - winsA;
    const winnerIsA = winsA >= winsB;
    const prizeCard = winnerIsA ? lineupB[Math.floor(Math.random() * lineupB.length)] : lineupA[Math.floor(Math.random() * lineupA.length)];
    const prizeCardData = cards.find((card) => card.id === prizeCard.cardId);
    payload = {
      userA, userB, lineupA, lineupB, mode: "rounds", rounds,
      winner: winnerIsA ? "A" : "B", winsA, winsB,
      winnerUser: winnerIsA ? userA : userB, loserUser: winnerIsA ? userB : userA,
      prizeCardId: prizeCard.cardId, prizeCardTitle: prizeCardData?.title || ""
    };
  }

  try {
    await testBattleAnimation(payload);
    showNotice(t("notice-battle-test-started"));
  } catch (error) {
    showNotice(error.message, "error");
  }
}

function playSoundPreview(kind) {
  const volume = Number(settings.style?.volume ?? 65) / 100;
  const dataUrl = settings.sounds?.[kind];
  if (!dataUrl) {
    playDefaultSoundPreview(kind, volume);
    return;
  }
  const audio = new Audio(dataUrl);
  audio.volume = Math.min(1, Math.max(0, volume));
  audio.play().catch((error) => showNotice(`${t("error-sound-play-failed")} ${error.message}`, "error"));
}

function bindGlobalActions() {
  $("#add-card").addEventListener("click", () => {
    const card = blankCard();
    settings.deck.cards.push(card);
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

let themePreviewCardId;

function themeSampleCard() {
  const accent = settings.style?.accentColor || "#ff78bb";
  const cards = settings.deck?.cards || [];
  // Use the card picked in the preview dropdown (or the first one); fall back to a synthetic sample.
  const base = cards.find((card) => card.id === themePreviewCardId) || cards[0];
  return base ? { ...base } : { title: "Sample", rarity: "epic", accent };
}

function renderThemePreviewPicker() {
  const select = $("#theme-preview-card");
  if (!select) return;
  const cards = settings.deck?.cards || [];
  if (!cards.some((card) => card.id === themePreviewCardId)) themePreviewCardId = cards[0]?.id;
  select.innerHTML = cards.map((card) => `<option value="${escapeHtml(card.id)}">${escapeHtml(card.title || card.id)}</option>`).join("");
  if (themePreviewCardId) select.value = themePreviewCardId;
  select.disabled = cards.length === 0;
}

function renderThemes() {
  const grid = $("#themes-grid");
  if (!grid) return;
  renderThemePreviewPicker();
  const current = settings.style?.cardTheme || "default";
  const sample = themeSampleCard();
  grid.innerHTML = CARD_THEMES.map((id) => {
    // The custom tile carries its vars inline (they're dynamic); built-ins use the static CSS.
    const previewStyle = id === "custom" ? ` style="${customThemeCss(settings.style?.customTheme)}"` : "";
    return `
    <button type="button" class="theme-tile${id === current ? " is-selected" : ""}" data-theme="${escapeHtml(id)}" aria-pressed="${id === current}" title="${t(`theme-${id}`)}">
      <span class="theme-check" aria-label="${t("theme-selected")}">✓</span>
      <div class="theme-card-preview" data-card-theme="${escapeHtml(id)}"${previewStyle}>${cardMarkup(sample)}</div>
      <span class="theme-name">${t(`theme-${id}`)}</span>
    </button>`;
  }).join("");
}

function hydrateThemeEditor() {
  const ct = settings.style?.customTheme;
  if (!ct || !$("#ct-color1")) return;
  $("#ct-color1").value = ct.color1 || "#6a5cff";
  $("#ct-color2").value = ct.color2 || "#22d3ee";
  $("#ct-color3").value = ct.color3 || "#ff7ad9";
  $("#ct-use-color3").checked = ct.useColor3 === true;
  $("#ct-angle").value = ct.angle ?? 155;
  $("#ct-sheen").value = ct.sheen ?? 30;
  $("#ct-art-color").value = ct.artColor || "#ffffff";
  $("#ct-art-opacity").value = ct.artOpacity ?? 45;
  const color3Field = $("#ct-color3-field");
  if (color3Field) color3Field.hidden = ct.useColor3 !== true;
  updateThemeEditorPreview();
}

function updateThemeEditorPreview() {
  const preview = $("#ct-preview");
  if (!preview) return;
  preview.setAttribute("style", customThemeCss(settings.style?.customTheme));
  preview.innerHTML = cardMarkup(themeSampleCard());
}

function readThemeEditor() {
  settings.style ||= {};
  settings.style.customTheme = {
    color1: $("#ct-color1").value,
    color2: $("#ct-color2").value,
    color3: $("#ct-color3").value,
    useColor3: $("#ct-use-color3").checked,
    angle: Number($("#ct-angle").value),
    sheen: Number($("#ct-sheen").value),
    artColor: $("#ct-art-color").value,
    artOpacity: Number($("#ct-art-opacity").value)
  };
  const color3Field = $("#ct-color3-field");
  if (color3Field) color3Field.hidden = settings.style.customTheme.useColor3 !== true;
  updateThemeEditorPreview();
  // Keep the custom tile in the grid in sync with the editor.
  const customPreview = $('#themes-grid .theme-tile[data-theme="custom"] .theme-card-preview');
  if (customPreview) customPreview.setAttribute("style", customThemeCss(settings.style.customTheme));
  // If the custom theme is the active one, update the live look everywhere immediately.
  if (settings.style.cardTheme === "custom") applyTheme(settings);
  scheduleAutoSave();
}

function bindThemes() {
  const grid = $("#themes-grid");
  if (grid) {
    grid.addEventListener("click", (event) => {
      const tile = event.target.closest(".theme-tile");
      if (!tile) return;
      settings.style ||= {};
      settings.style.cardTheme = tile.dataset.theme;
      applyTheme(settings);
      renderThemes();
      refreshSettingsPreview();
      scheduleAutoSave();
    });
  }
  const picker = $("#theme-preview-card");
  if (picker) {
    picker.addEventListener("change", (event) => {
      themePreviewCardId = event.target.value;
      renderThemes();
      updateThemeEditorPreview();
    });
  }
  const editor = $("#theme-editor");
  if (editor) {
    editor.addEventListener("input", readThemeEditor);
    editor.addEventListener("change", readThemeEditor);
  }
  const activate = $("#ct-activate");
  if (activate) {
    activate.addEventListener("click", () => {
      settings.style ||= {};
      settings.style.cardTheme = "custom";
      applyTheme(settings);
      renderThemes();
      refreshSettingsPreview();
      scheduleAutoSave();
      showNotice(t("notice-theme-custom-active"));
    });
  }
}

function renderAll() {
  // Run each step independently so one failing hydrate (e.g. a missing element after a partial
  // page load) can't abort the whole render and leave the app looking dead.
  const steps = [
    ["applyTheme", () => applyTheme(settings)],
    ["applyTranslations", applyTranslations],
    ["renderCards", renderCards],
    ["hydrateBooster", hydrateBooster],
    ["hydrateTrigger", hydrateTrigger],
    ["hydrateDesign", hydrateDesign],
    ["hydrateChatCommands", hydrateChatCommands],
    ["renderThemes", renderThemes],
    ["hydrateThemeEditor", hydrateThemeEditor],
    ["renderOverview", renderOverview],
    ["renderUsers", renderUsers]
  ];
  for (const [name, fn] of steps) {
    try {
      fn();
    } catch (error) {
      console.error(`renderAll:${name}`, error);
      try { addLog("ui", "error", `renderAll:${name} ${error.message}`); } catch {}
    }
  }
}

async function init() {
  // Bind the navigation and controls FIRST, before any data loading. This way the UI (tab
  // switching, buttons) always works even if loading/normalizing the settings later fails -
  // otherwise a single load error would leave the whole window dead and unclickable.
  try {
    bindTabs();
    bindGlobalActions();
    bindBooster();
    bindTrigger();
    bindDesign();
    bindUsers();
    bindChatCommands();
    bindVariableChips();
    bindCommandUsage();
    bindThemes();
    bindQueue();
    bindUpdateTab();
    bindLogTab();
  } catch (error) {
    console.error("Bind-Fehler:", error);
  }

  try {
    settings = normalizeSettings(await getSettings());
    availableFonts = (await getFonts()).fonts || [];
    selectedCardId = settings.deck.cards[0]?.id;
    selectedBoosterId = settings.boosters[0]?.id;
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
    await refreshBotStatus();
    if (settings.obs?.enabled) testObsConnection();
    setInterval(refreshTwitchStatus, 20000);
    setInterval(refreshBotStatus, 20000);
    setInterval(() => {
      if (settings.obs?.enabled) testObsConnection();
    }, 20000);
    connectEventStream({
      queue: (data) => {
        if (isQueueTabActive()) applyQueueState(data);
      }
    });
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
  if (event.data?.type === "cardpack:twitch-bot-connected") {
    refreshBotStatus();
    showNotice(t("notice-twitch-connected"));
  }
});

// Surface uncaught client-side errors in the server log so they can be diagnosed without a
// dev console (the embedded WebView has none).
window.addEventListener("error", (event) => {
  try { addLog("ui", "error", `${event.message} @ ${event.filename}:${event.lineno}:${event.colno}`); } catch {}
});
window.addEventListener("unhandledrejection", (event) => {
  try { addLog("ui", "error", `Promise: ${event.reason?.message || event.reason}`); } catch {}
});

init();
