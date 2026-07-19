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
  getPityState,
  getUserStats,
  getCommunityGoal,
  resetCommunityGoal,
  getFonts,
  getLatestRelease,
  getReleases,
  getQueueItems,
  removeQueueItem,
  setQueuePaused,
  installUpdate,
  getLogs,
  getSettings,
  getStatsInstallId,
  getTwitchStatus,
  getVersion,
  persistCollectionSnapshot,
  resetCommandUsage,
  saveSettings,
  syncShowcaseReward,
  syncTournamentReward,
  getTournamentState,
  startTournament,
  syncTeamBattleReward,
  startTeamBattle,
  syncTwitchReward,
  testTradeAnimation,
  testGiftAnimation,
  testBattleAnimation,
  triggerDraw
} from "./api.js?v=2.12.2";
import {
  applyTheme,
  boosterMarkup,
  CARD_THEMES,
  cardMarkup,
  cardsForBooster,
  compressImageDataUrl,
  createId,
  customThemeCss,
  DEFAULT_RARITY_COLORS,
  DEFAULT_RARITY_WEIGHTS,
  escapeHtml,
  MAX_BOOSTER_CARDS,
  normalizeSettings,
  OVERLAY_LAYOUT_NATURAL_SIZES,
  overlayLayoutBoxSize,
  pickDefault,
  RARITIES,
  rarityById,
  readFileAsDataUrl,
  setRarityColors,
  setRarityWeights
} from "./render.js?v=2.12.2";

let settings;
let selectedCardId;
let selectedBoosterId;
let previewCardId;
let availableFonts = [];
let autoSaveReady = false;
let collections = {};
const DEFAULT_TWITCH_CLIENT_ID = "klgyxuiixy0mfo7ze7goubj5j16g7u";
// Anonymous usage counter (own VPS server, see tools/stats-server.js). Best-effort only -
// failures here must never affect the app itself, so every call swallows its own errors.
const STATS_ENDPOINT = "https://streamercards.bittersweetscripts.de";
const STATS_SYNC_MIN_INTERVAL_MS = 5 * 60 * 1000;
let lastStatsSyncAt = 0;

async function hashForStats(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let statsLoaded = false;
async function loadCommunityStats(force) {
  if (statsLoaded && !force) return;
  try {
    const res = await fetch(`${STATS_ENDPOINT}/stats`);
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    if ($("#stats-users")) $("#stats-users").textContent = data.users ?? "–";
    if ($("#stats-boosters")) $("#stats-boosters").textContent = data.boosters ?? "–";
    if ($("#stats-cards")) $("#stats-cards").textContent = data.cards ?? "–";
    statsLoaded = true;
  } catch {
    // Best-effort - tiles just keep showing the "–" placeholder.
  }
}

async function reportTwitchConnected(broadcasterId) {
  if (!broadcasterId) return;
  try {
    await fetch(`${STATS_ENDPOINT}/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "connect", id: await hashForStats(broadcasterId) })
    });
  } catch {
    // Anonymous, best-effort - never surface this to the user.
  }
}

// Reports this install's CURRENT card/booster totals (not just newly-created ones), so the
// aggregate stat is always accurate to "how many exist right now" - a repeated call from
// autosave just overwrites the same per-install entry instead of double-counting, and it also
// picks up cards/boosters that already existed before this feature shipped, on the next save.
let cachedStatsInstallId = null;
async function syncCommunityCounts(force) {
  const now = Date.now();
  if (!force && now - lastStatsSyncAt < STATS_SYNC_MIN_INTERVAL_MS) return;
  lastStatsSyncAt = now;
  try {
    // Fetched (and cached for the rest of this session) from the server rather than read off
    // `settings` - see getStatsInstallId in api.js for why it must not live in settings.json.
    if (!cachedStatsInstallId) cachedStatsInstallId = await getStatsInstallId();
    if (!cachedStatsInstallId) return;
    await fetch(`${STATS_ENDPOINT}/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        installId: cachedStatsInstallId,
        cards: settings.deck?.cards?.length || 0,
        boosters: settings.boosters?.length || 0
      })
    });
    if (settings.twitch?.broadcasterId) reportTwitchConnected(settings.twitch.broadcasterId);
    statsLoaded = false;
    loadCommunityStats();
  } catch {
    // Anonymous, best-effort - never surface this to the user.
  }
}
const TWITCH_REQUIRED_SCOPES = "channel:read:redemptions channel:manage:redemptions channel:read:subscriptions bits:read user:read:chat user:write:chat";
const TWITCH_BOT_SCOPES = "user:read:chat user:write:chat";

const I18N = {
  "nav-overview": { de: "Übersicht", en: "Overview",
    fr: "Aperçu",
    es: "Resumen",
    th: "ภาพรวม"
  },
  "nav-trigger": { de: "Verbindung", en: "Connection",
    fr: "Connexion",
    es: "Conexión",
    th: "การเชื่อมต่อ"
  },
  "nav-channelpoints": { de: "Kanalpunkte", en: "Channel points",
    fr: "Points de chaîne",
    es: "Puntos de canal",
    th: "แชนแนลพอยท์"
  },
  "nav-cards": { de: "Karten", en: "Cards",
    fr: "Cartes",
    es: "Cartas",
    th: "การ์ด"
  },
  "nav-booster": { de: "Booster", en: "Boosters",
    fr: "Boosters",
    es: "Sobres",
    th: "บูสเตอร์"
  },
  "nav-users": { de: "User", en: "Users",
    fr: "Utilisateurs",
    es: "Usuarios",
    th: "ผู้ใช้"
  },
  "nav-design": { de: "Einstellungen", en: "Settings",
    fr: "Paramètres",
    es: "Ajustes",
    th: "การตั้งค่า"
  },
  "nav-animations": { de: "Animationen", en: "Animations",
    fr: "Animations",
    es: "Animaciones",
    th: "แอนิเมชัน"
  },
  "nav-update": { de: "Update", en: "Update",
    fr: "Mise à jour",
    es: "Actualización",
    th: "อัปเดต"
  },
  "nav-log": { de: "Log", en: "Log",
    fr: "Journal",
    es: "Registro",
    th: "บันทึก"
  },
  "nav-chatcommands": { de: "Chat Befehle", en: "Chat commands",
    fr: "Commandes de chat",
    es: "Comandos de chat",
    th: "คำสั่งแชท"
  },
  "nav-themes": { de: "Themes", en: "Themes",
    fr: "Thèmes",
    es: "Temas",
    th: "ธีม"
  },
  "themes-eyebrow": { de: "Kartendesign", en: "Card design",
    fr: "Design de carte",
    es: "Diseño de carta",
    th: "ดีไซน์การ์ด"
  },
  "themes-title": { de: "Karten-Themes", en: "Card themes",
    fr: "Thèmes de carte",
    es: "Temas de carta",
    th: "ธีมการ์ด"
  },
  "themes-hint": {
    de: "Wähle das Aussehen aller Karten per Klick. Die Auswahl gilt sofort für Overlay, Sammlung und Vorschauen.",
    en: "Pick the look of all cards with one click. It applies instantly to overlay, collection and previews.",
    fr: "Choisis l'apparence de toutes les cartes en un clic. S'applique immédiatement à l'overlay, la collection et les aperçus.",
    es: "Elige el aspecto de todas las cartas con un clic. Se aplica al instante al overlay, la colección y las vistas previas.",
    th: "เลือกรูปลักษณ์ของการ์ดทั้งหมดด้วยคลิกเดียว มีผลทันทีกับโอเวอร์เลย์ คอลเลกชัน และตัวอย่าง"
  },
  "theme-selected": { de: "Ausgewählt", en: "Selected",
    fr: "Sélectionné",
    es: "Seleccionado",
    th: "เลือกแล้ว"
  },
  "label-theme-preview-card": { de: "Vorschaukarte", en: "Preview card",
    fr: "Carte d'aperçu",
    es: "Carta de vista previa",
    th: "การ์ดตัวอย่าง"
  },
  "imagefit-eyebrow": { de: "Bilder", en: "Images",
    fr: "Images",
    es: "Imágenes",
    th: "รูปภาพ"
  },
  "imagefit-title": { de: "Bild-Anpassung", en: "Image fit",
    fr: "Ajustement d'image",
    es: "Ajuste de imagen",
    th: "การปรับขนาดรูปภาพ"
  },
  "imagefit-hint": {
    de: "Legt fest, wie die hochgeladenen Karten- bzw. Booster-Bilder eingepasst werden.",
    en: "Controls how uploaded card/booster images are fitted.",
    fr: "Détermine comment les images de carte/booster téléchargées sont ajustées.",
    es: "Define cómo se ajustan las imágenes de carta/sobre subidas.",
    th: "กำหนดวิธีการปรับรูปภาพการ์ด/บูสเตอร์ที่อัปโหลด"
  },
  "label-card-image-fit": { de: "Kartenbild", en: "Card image",
    fr: "Image de carte",
    es: "Imagen de carta",
    th: "รูปภาพการ์ด"
  },
  "label-booster-image-fit": { de: "Booster-Bild", en: "Booster image",
    fr: "Image de booster",
    es: "Imagen de sobre",
    th: "รูปภาพบูสเตอร์"
  },
  "opt-fit-frame": { de: "Im Rahmen (bisher)", en: "In frame (previous)",
    fr: "Dans le cadre (précédent)",
    es: "En el marco (anterior)",
    th: "ในกรอบ (แบบเดิม)"
  },
  "opt-fit-full": { de: "Volle Karte", en: "Full card",
    fr: "Carte entière",
    es: "Carta completa",
    th: "เต็มการ์ด"
  },
  "opt-fit-top": { de: "Volle Karte, oben orientiert", en: "Full card, top-anchored",
    fr: "Carte entière, ancrée en haut",
    es: "Carta completa, anclada arriba",
    th: "เต็มการ์ด ยึดด้านบน"
  },
  "opt-fit-bottom": { de: "Volle Karte, unten orientiert", en: "Full card, bottom-anchored",
    fr: "Carte entière, ancrée en bas",
    es: "Carta completa, anclada abajo",
    th: "เต็มการ์ด ยึดด้านล่าง"
  },
  "opt-fit-left": { de: "Volle Karte, links orientiert", en: "Full card, left-anchored",
    fr: "Carte entière, ancrée à gauche",
    es: "Carta completa, anclada a la izquierda",
    th: "เต็มการ์ด ยึดด้านซ้าย"
  },
  "opt-fit-right": { de: "Volle Karte, rechts orientiert", en: "Full card, right-anchored",
    fr: "Carte entière, ancrée à droite",
    es: "Carta completa, anclada a la derecha",
    th: "เต็มการ์ด ยึดด้านขวา"
  },
  "opt-fit-center": { de: "Zentriert (bisher)", en: "Centered (previous)",
    fr: "Centré (précédent)",
    es: "Centrado (anterior)",
    th: "กึ่งกลาง (แบบเดิม)"
  },
  "opt-fit-top-booster": { de: "Oben orientiert", en: "Top-anchored",
    fr: "Ancré en haut",
    es: "Anclado arriba",
    th: "ยึดด้านบน"
  },
  "opt-fit-bottom-booster": { de: "Unten orientiert", en: "Bottom-anchored",
    fr: "Ancré en bas",
    es: "Anclado abajo",
    th: "ยึดด้านล่าง"
  },
  "opt-fit-left-booster": { de: "Links orientiert", en: "Left-anchored",
    fr: "Ancré à gauche",
    es: "Anclado a la izquierda",
    th: "ยึดด้านซ้าย"
  },
  "opt-fit-right-booster": { de: "Rechts orientiert", en: "Right-anchored",
    fr: "Ancré à droite",
    es: "Anclado a la derecha",
    th: "ยึดด้านขวา"
  },
  "theme-default": { de: "Klassik", en: "Classic",
    fr: "Classique",
    es: "Clásico",
    th: "คลาสสิก"
  },
  "theme-onyx": { de: "Onyx", en: "Onyx",
    fr: "Onyx",
    es: "Ónix",
    th: "โอนิกซ์"
  },
  "theme-carbon": { de: "Carbon", en: "Carbon",
    fr: "Carbone",
    es: "Carbono",
    th: "คาร์บอน"
  },
  "theme-midnight": { de: "Mitternacht", en: "Midnight",
    fr: "Minuit",
    es: "Medianoche",
    th: "มิดไนต์"
  },
  "theme-slate": { de: "Schiefer", en: "Slate",
    fr: "Ardoise",
    es: "Pizarra",
    th: "สเลท"
  },
  "theme-prism": { de: "Prisma", en: "Prism",
    fr: "Prisme",
    es: "Prisma",
    th: "ปริซึม"
  },
  "theme-gold": { de: "Gold", en: "Gold",
    fr: "Or",
    es: "Oro",
    th: "ทอง"
  },
  "theme-sunset": { de: "Sunset", en: "Sunset",
    fr: "Coucher de soleil",
    es: "Atardecer",
    th: "พระอาทิตย์ตก"
  },
  "theme-mint": { de: "Mint", en: "Mint",
    fr: "Menthe",
    es: "Menta",
    th: "มินต์"
  },
  "theme-ocean": { de: "Ozean", en: "Ocean",
    fr: "Océan",
    es: "Océano",
    th: "มหาสมุทร"
  },
  "theme-rose": { de: "Rosé", en: "Rose",
    fr: "Rose",
    es: "Rosa",
    th: "กุหลาบ"
  },
  "theme-forest": { de: "Wald", en: "Forest",
    fr: "Forêt",
    es: "Bosque",
    th: "ป่า"
  },
  "theme-custom": { de: "Eigenes", en: "Custom",
    fr: "Personnalisé",
    es: "Personalizado",
    th: "กำหนดเอง"
  },
  "theme-editor-eyebrow": { de: "Eigenes Theme", en: "Custom theme",
    fr: "Thème personnalisé",
    es: "Tema personalizado",
    th: "ธีมกำหนดเอง"
  },
  "theme-editor-title": { de: "Theme-Editor", en: "Theme editor",
    fr: "Éditeur de thème",
    es: "Editor de temas",
    th: "ตัวแก้ไขธีม"
  },
  "theme-editor-hint": {
    de: "Stelle dein eigenes Karten-Theme zusammen. Die Einstellungen wirken sich nur auf die Karte aus.",
    en: "Build your own card theme. These settings only affect the card itself.",
    fr: "Crée ton propre thème de carte. Ces réglages n'affectent que la carte elle-même.",
    es: "Crea tu propio tema de carta. Estos ajustes solo afectan a la carta en sí.",
    th: "สร้างธีมการ์ดของคุณเอง การตั้งค่านี้มีผลกับตัวการ์ดเท่านั้น"
  },
  "label-ct-color1": { de: "Farbe 1", en: "Color 1",
    fr: "Couleur 1",
    es: "Color 1",
    th: "สี 1"
  },
  "label-ct-color2": { de: "Farbe 2", en: "Color 2",
    fr: "Couleur 2",
    es: "Color 2",
    th: "สี 2"
  },
  "label-ct-color3": { de: "Farbe 3", en: "Color 3",
    fr: "Couleur 3",
    es: "Color 3",
    th: "สี 3"
  },
  "label-ct-use-color3": { de: "Dritte Farbe verwenden", en: "Use a third color",
    fr: "Utiliser une troisième couleur",
    es: "Usar un tercer color",
    th: "ใช้สีที่สาม"
  },
  "label-ct-angle": { de: "Verlaufswinkel", en: "Gradient angle",
    fr: "Angle du dégradé",
    es: "Ángulo del degradado",
    th: "มุมไล่ระดับสี"
  },
  "label-ct-sheen": { de: "Glanz", en: "Sheen",
    fr: "Brillance",
    es: "Brillo",
    th: "ความมันวาว"
  },
  "label-ct-art-color": { de: "Bildrahmen-Farbe", en: "Image frame color",
    fr: "Couleur du cadre d'image",
    es: "Color del marco de imagen",
    th: "สีกรอบรูปภาพ"
  },
  "label-ct-art-opacity": { de: "Bildrahmen-Deckkraft", en: "Image frame opacity",
    fr: "Opacité du cadre d'image",
    es: "Opacidad del marco de imagen",
    th: "ความทึบกรอบรูปภาพ"
  },
  "btn-ct-activate": { de: "Eigenes Theme aktivieren", en: "Activate custom theme",
    fr: "Activer le thème personnalisé",
    es: "Activar tema personalizado",
    th: "เปิดใช้ธีมกำหนดเอง"
  },
  "notice-theme-custom-active": { de: "Eigenes Theme aktiviert.", en: "Custom theme activated.",
    fr: "Thème personnalisé activé.",
    es: "Tema personalizado activado.",
    th: "เปิดใช้ธีมกำหนดเองแล้ว"
  },
  "nav-commandusage": { de: "Nutzung Befehle", en: "Command usage",
    fr: "Utilisation des commandes",
    es: "Uso de comandos",
    th: "การใช้งานคำสั่ง"
  },
  "nav-queue": { de: "Queue", en: "Queue",
    fr: "File d'attente",
    es: "Cola",
    th: "คิว"
  },
  "eyebrow-twitch": { de: "Twitch", en: "Twitch", fr: "Twitch", es: "Twitch", th: "Twitch" },
  "eyebrow-obs": { de: "OBS", en: "OBS", fr: "OBS", es: "OBS", th: "OBS" },
  "eyebrow-meld": { de: "Meld Studio", en: "Meld Studio", fr: "Meld Studio", es: "Meld Studio", th: "Meld Studio" },
  "obs-websocket-title": { de: "WebSocket", en: "WebSocket", fr: "WebSocket", es: "WebSocket", th: "WebSocket" },
  "meld-websocket-title": { de: "WebSocket", en: "WebSocket", fr: "WebSocket", es: "WebSocket", th: "WebSocket" },
  "bot-trigger-title": { de: "Bot-Verbindung (Chat)", en: "Bot connection (chat)",
    fr: "Connexion du bot (chat)",
    es: "Conexión del bot (chat)",
    th: "การเชื่อมต่อบอท (แชท)"
  },
  "bot-trigger-hint": {
    de: "Optional: separater Bot-Account zum Lesen und Senden von Chat-Nachrichten. Wenn nicht verbunden, wird die Haupt-Twitch-Verbindung dafür verwendet.",
    en: "Optional: separate bot account for reading and sending chat messages. If not connected, the main Twitch connection is used instead.",
    fr: "Optionnel : compte bot séparé pour lire et envoyer des messages de chat. S'il n'est pas connecté, la connexion Twitch principale est utilisée.",
    es: "Opcional: cuenta de bot independiente para leer y enviar mensajes de chat. Si no está conectada, se usa la conexión principal de Twitch.",
    th: "ตัวเลือกเสริม: บัญชีบอทแยกสำหรับอ่านและส่งข้อความแชท หากไม่ได้เชื่อมต่อ จะใช้การเชื่อมต่อ Twitch หลักแทน"
  },
  "btn-connect-twitch-bot": { de: "Bot mit Twitch anmelden", en: "Sign in bot with Twitch",
    fr: "Connecter le bot avec Twitch",
    es: "Conectar bot con Twitch",
    th: "เชื่อมต่อบอทกับ Twitch"
  },
  "cc-title": { de: "Chat-Befehle verwalten", en: "Manage chat commands",
    fr: "Gérer les commandes de chat",
    es: "Gestionar comandos de chat",
    th: "จัดการคำสั่งแชท"
  },
  "label-cc-command-enabled": { de: "Aktiviert", en: "Enabled",
    fr: "Activé",
    es: "Activado",
    th: "เปิดใช้งาน"
  },
  "cc-reset-hint": {
    de: "Setzt nur die Vorschlagstexte zurück (in der aktuell gewählten Sprache) - Befehlswörter, Limits und Cooldowns bleiben unverändert.",
    en: "Only resets the suggested message texts (in the currently selected language) - command words, limits and cooldowns stay unchanged.",
    fr: "Ne réinitialise que les textes de message suggérés (dans la langue actuellement sélectionnée) - mots de commande, limites et cooldowns restent inchangés.",
    es: "Solo restablece los textos de mensaje sugeridos (en el idioma seleccionado actualmente) - las palabras de comando, límites y cooldowns no cambian.",
    th: "รีเซ็ตเฉพาะข้อความที่แนะนำ (ตามภาษาที่เลือกอยู่ในขณะนี้) - คำสั่ง ขีดจำกัด และคูลดาวน์จะไม่เปลี่ยนแปลง"
  },
  "btn-reset-message-defaults": {
    de: "Alle Texte zurücksetzen",
    en: "Reset all texts",
    fr: "Réinitialiser tous les textes",
    es: "Restablecer todos los textos",
    th: "รีเซ็ตข้อความทั้งหมด"
  },
  "confirm-reset-message-defaults": {
    de: "Wirklich alle Vorschlagstexte in der aktuell gewählten Sprache zurücksetzen? Eigene Anpassungen an diesen Texten gehen dabei verloren.",
    en: "Really reset all suggested texts to the currently selected language? Your own edits to these texts will be lost.",
    fr: "Vraiment réinitialiser tous les textes suggérés dans la langue actuellement sélectionnée ? Tes propres modifications à ces textes seront perdues.",
    es: "¿Restablecer realmente todos los textos sugeridos al idioma seleccionado actualmente? Se perderán tus propias ediciones de estos textos.",
    th: "ต้องการรีเซ็ตข้อความที่แนะนำทั้งหมดเป็นภาษาที่เลือกอยู่จริงหรือไม่? การแก้ไขข้อความเหล่านี้ของคุณจะหายไป"
  },
  "notice-messages-reset": {
    de: "Alle Vorschlagstexte wurden zurückgesetzt.",
    en: "All suggested texts have been reset.",
    fr: "Tous les textes suggérés ont été réinitialisés.",
    es: "Se restablecieron todos los textos sugeridos.",
    th: "รีเซ็ตข้อความที่แนะนำทั้งหมดแล้ว"
  },
  "cc-intro": {
    de: "Lege fest, mit welchen Chat-Befehlen Zuschauer ein Pack ziehen oder ihre Sammlung anzeigen können. Jeder Befehl lässt sich einzeln aktivieren.",
    en: "Define which chat commands let viewers draw a pack or show their collection. Each command can be enabled separately.",
    fr: "Définis les commandes de chat qui permettent aux spectateurs de tirer un pack ou d'afficher leur collection. Chaque commande peut être activée séparément.",
    es: "Define con qué comandos de chat los espectadores pueden abrir un sobre o mostrar su colección. Cada comando se puede activar por separado.",
    th: "กำหนดคำสั่งแชทที่ให้ผู้ชมเปิดแพ็กหรือแสดงคอลเลกชันของตน แต่ละคำสั่งเปิดใช้งานแยกกันได้"
  },
  "cc-group-command": { de: "Befehl", en: "Command",
    fr: "Commande",
    es: "Comando",
    th: "คำสั่ง"
  },
  "cc-group-limits": { de: "Limit & Cooldown", en: "Limit & cooldown",
    fr: "Limite & cooldown",
    es: "Límite y cooldown",
    th: "ขีดจำกัดและคูลดาวน์"
  },
  "cc-group-messages": { de: "Chat-Nachrichten", en: "Chat messages",
    fr: "Messages du chat",
    es: "Mensajes de chat",
    th: "ข้อความแชท"
  },
  "cc-trade-eyebrow": { de: "Tausch", en: "Trade",
    fr: "Échange",
    es: "Intercambio",
    th: "การแลกเปลี่ยน"
  },
  "cc-trade-title": { de: "Tausch-Befehl", en: "Trade command",
    fr: "Commande d'échange",
    es: "Comando de intercambio",
    th: "คำสั่งแลกเปลี่ยน"
  },
  "label-cc-trade-timeout": { de: "Anfrage offen für (Sek.)", en: "Request open for (sec.)",
    fr: "Demande ouverte pendant (sec.)",
    es: "Solicitud abierta durante (seg.)",
    th: "เปิดคำขอไว้ (วินาที)"
  },
  "label-cc-trade-offer": { de: "Angebot an den Tauschpartner", en: "Offer to the trade partner",
    fr: "Offre au partenaire d'échange",
    es: "Oferta al compañero de intercambio",
    th: "ข้อเสนอถึงคู่แลกเปลี่ยน"
  },
  "label-cc-trade-cardnotfound": { de: "Karte nicht gefunden (Vorschlag)", en: "Card not found (suggestion)",
    fr: "Carte introuvable (suggestion)",
    es: "Carta no encontrada (sugerencia)",
    th: "ไม่พบการ์ด (คำแนะนำ)"
  },
  "label-cc-trade-offernotowned": { de: "Anbieter besitzt Karte nicht", en: "Offerer doesn't own the card",
    fr: "L'offrant ne possède pas la carte",
    es: "El oferente no posee la carta",
    th: "ผู้เสนอไม่มีการ์ดใบนี้"
  },
  "label-cc-trade-usernotfound": { de: "Tauschpartner nicht gefunden", en: "Trade partner not found",
    fr: "Partenaire d'échange introuvable",
    es: "Compañero de intercambio no encontrado",
    th: "ไม่พบคู่แลกเปลี่ยน"
  },
  "label-cc-trade-cooldown": { de: "Nachricht bei aktivem Cooldown", en: "Message when cooldown active",
    fr: "Message quand le cooldown est actif",
    es: "Mensaje cuando el cooldown está activo",
    th: "ข้อความเมื่อคูลดาวน์ยังทำงานอยู่"
  },
  "label-cc-trade-limit": { de: "Nachricht bei erreichtem Limit", en: "Message when limit reached",
    fr: "Message quand la limite est atteinte",
    es: "Mensaje cuando se alcanza el límite",
    th: "ข้อความเมื่อถึงขีดจำกัด"
  },
  "label-cc-trade-timeoutmsg": { de: "Nachricht bei Zeitüberschreitung", en: "Message on timeout",
    fr: "Message en cas d'expiration",
    es: "Mensaje al expirar",
    th: "ข้อความเมื่อหมดเวลา"
  },
  "label-cc-trade-busy": { de: "Nachricht bei laufendem Tausch", en: "Message while a trade is running",
    fr: "Message pendant qu'un échange est en cours",
    es: "Mensaje mientras hay un intercambio en curso",
    th: "ข้อความขณะมีการแลกเปลี่ยนอยู่"
  },
  "cc-tradeyes-eyebrow": { de: "Tausch annehmen", en: "Accept trade",
    fr: "Accepter l'échange",
    es: "Aceptar intercambio",
    th: "ยอมรับการแลกเปลี่ยน"
  },
  "cc-tradeyes-title": { de: "Tausch-Annahme-Befehl", en: "Trade accept command",
    fr: "Commande d'acceptation d'échange",
    es: "Comando de aceptar intercambio",
    th: "คำสั่งยอมรับการแลกเปลี่ยน"
  },
  "label-cc-tradeyes-notowned": { de: "Partner besitzt Karte nicht", en: "Partner doesn't own the card",
    fr: "Le partenaire ne possède pas la carte",
    es: "El compañero no posee la carta",
    th: "คู่แลกเปลี่ยนไม่มีการ์ดใบนี้"
  },
  "label-cc-tradeyes-success": { de: "Nachricht bei erfolgreichem Tausch", en: "Message on successful trade",
    fr: "Message en cas d'échange réussi",
    es: "Mensaje en intercambio exitoso",
    th: "ข้อความเมื่อแลกเปลี่ยนสำเร็จ"
  },
  "cc-tradeno-eyebrow": { de: "Tausch ablehnen", en: "Decline trade",
    fr: "Refuser l'échange",
    es: "Rechazar intercambio",
    th: "ปฏิเสธการแลกเปลี่ยน"
  },
  "cc-tradeno-title": { de: "Tausch-Ablehnungs-Befehl", en: "Trade decline command",
    fr: "Commande de refus d'échange",
    es: "Comando de rechazo de intercambio",
    th: "คำสั่งปฏิเสธการแลกเปลี่ยน"
  },
  "label-cc-tradeno-decline": { de: "Nachricht bei Ablehnung", en: "Message on decline",
    fr: "Message en cas de refus",
    es: "Mensaje al rechazar",
    th: "ข้อความเมื่อปฏิเสธ"
  },
  "cc-battle-eyebrow": { de: "Kampf", en: "Battle",
    fr: "Duel",
    es: "Duelo",
    th: "การดวล"
  },
  "cc-battle-title": { de: "Kampf-Befehl", en: "Battle command",
    fr: "Commande de duel",
    es: "Comando de duelo",
    th: "คำสั่งดวล"
  },
  "label-cc-battle-lineupsize": { de: "Karten pro Seite (N)", en: "Cards per side (N)",
    fr: "Cartes par camp (N)",
    es: "Cartas por bando (N)",
    th: "การ์ดต่อฝ่าย (N)"
  },
  "label-cc-battle-timeout": { de: "Anfrage offen für (Sek.)", en: "Request open for (sec.)",
    fr: "Demande ouverte pendant (sec.)",
    es: "Solicitud abierta durante (seg.)",
    th: "เปิดคำขอไว้ (วินาที)"
  },
  "label-cc-battle-offer": { de: "Herausforderung an den Gegner", en: "Challenge to the opponent",
    fr: "Défi à l'adversaire",
    es: "Desafío al oponente",
    th: "คำท้าถึงคู่ต่อสู้"
  },
  "label-cc-battle-usernotfound": { de: "Gegner nicht gefunden", en: "Opponent not found",
    fr: "Adversaire introuvable",
    es: "Oponente no encontrado",
    th: "ไม่พบคู่ต่อสู้"
  },
  "label-cc-battle-selfchallenge": { de: "Sich selbst herausgefordert", en: "Self-challenge",
    fr: "Auto-défi",
    es: "Autodesafío",
    th: "ท้าตัวเอง"
  },
  "label-cc-battle-notenoughcards": { de: "Zu wenige Karten", en: "Not enough cards",
    fr: "Pas assez de cartes",
    es: "No hay suficientes cartas",
    th: "การ์ดไม่พอ"
  },
  "label-cc-battle-cooldown": { de: "Nachricht bei aktivem Cooldown", en: "Message when cooldown active",
    fr: "Message quand le cooldown est actif",
    es: "Mensaje cuando el cooldown está activo",
    th: "ข้อความเมื่อคูลดาวน์ยังทำงานอยู่"
  },
  "label-cc-battle-limit": { de: "Nachricht bei erreichtem Limit", en: "Message when limit reached",
    fr: "Message quand la limite est atteinte",
    es: "Mensaje cuando se alcanza el límite",
    th: "ข้อความเมื่อถึงขีดจำกัด"
  },
  "label-cc-battle-timeoutmsg": { de: "Nachricht bei Zeitüberschreitung", en: "Message on timeout",
    fr: "Message en cas d'expiration",
    es: "Mensaje al expirar",
    th: "ข้อความเมื่อหมดเวลา"
  },
  "label-cc-battle-busy": { de: "Nachricht bei laufendem Kampf", en: "Message while a battle is running",
    fr: "Message pendant qu'un duel est en cours",
    es: "Mensaje mientras hay un duelo en curso",
    th: "ข้อความขณะมีการดวลอยู่"
  },
  "cc-battleyes-eyebrow": { de: "Kampf annehmen", en: "Accept battle",
    fr: "Accepter le duel",
    es: "Aceptar duelo",
    th: "ยอมรับการดวล"
  },
  "cc-battleyes-title": { de: "Kampf-Annahme-Befehl", en: "Battle accept command",
    fr: "Commande d'acceptation de duel",
    es: "Comando de aceptar duelo",
    th: "คำสั่งยอมรับการดวล"
  },
  "label-cc-battleyes-result": { de: "Nachricht bei Ergebnis", en: "Result message",
    fr: "Message de résultat",
    es: "Mensaje de resultado",
    th: "ข้อความผลลัพธ์"
  },
  "cc-battleno-eyebrow": { de: "Kampf ablehnen", en: "Decline battle",
    fr: "Refuser le duel",
    es: "Rechazar duelo",
    th: "ปฏิเสธการดวล"
  },
  "cc-battleno-title": { de: "Kampf-Ablehnungs-Befehl", en: "Battle decline command",
    fr: "Commande de refus de duel",
    es: "Comando de rechazo de duelo",
    th: "คำสั่งปฏิเสธการดวล"
  },
  "label-cc-battleno-decline": { de: "Nachricht bei Ablehnung", en: "Message on decline",
    fr: "Message en cas de refus",
    es: "Mensaje al rechazar",
    th: "ข้อความเมื่อปฏิเสธ"
  },
  "cc-ranking-eyebrow": { de: "Ranking", en: "Ranking",
    fr: "Classement",
    es: "Clasificación",
    th: "อันดับ"
  },
  "cc-ranking-title": { de: "Ranking-Befehl", en: "Ranking command",
    fr: "Commande de classement",
    es: "Comando de clasificación",
    th: "คำสั่งอันดับ"
  },
  "label-cc-ranking-seconds": { de: "Anzeigedauer (Sek.)", en: "Display duration (sec.)",
    fr: "Durée d'affichage (sec.)",
    es: "Duración de visualización (seg.)",
    th: "ระยะเวลาแสดงผล (วินาที)"
  },
  "cc-ranking-hint": {
    de: "Zeigt das Ranking ausschließlich in der eigenen OBS-Quelle (Verbindung → Quellenname Ranking) – es erfolgt bewusst keine Chat-Ausgabe. Bei „battle“ wechselt die Anzeige nacheinander durch: meiste Kämpfe → meiste Siege → meiste Niederlagen → beste Siegquote (je Top 5). Bei „turnier“ wechselt die Anzeige durch: meiste Turniersiege → meiste Turnierteilnahmen (je Top 5). Bei „teamkampf“ wechselt die Anzeige durch: meiste Team-Kampf-Teilnahmen → meiste Siege → meiste Niederlagen (je Top 5). Bei „tausch“ erscheinen die 5 User mit den meisten abgeschlossenen Tauschen. Die Anzeigedauer gilt pro Ansicht.",
    en: "Shows the ranking exclusively in its own OBS source (Connection → Ranking source name) – deliberately no chat output. For “battle” the display cycles through: most fights → most wins → most defeats → best win/loss ratio (top 5 each). For “tournament” the display cycles through: most tournament wins → most tournament participations (top 5 each). For “teamkampf” the display cycles through: most Team Battle participations → most wins → most defeats (top 5 each). For “trade” it shows the 5 users with the most completed trades. The display duration applies per view.",
    fr: "Affiche le classement uniquement dans sa propre source OBS (Connexion → Nom de la source de classement) – volontairement aucune sortie chat. Pour « duel » l'affichage défile : plus de combats → plus de victoires → plus de défaites → meilleur ratio victoires/défaites (top 5 chacun). Pour « turnier » l'affichage défile : plus de victoires en tournoi → plus de participations en tournoi (top 5 chacun). Pour « teamkampf » l'affichage défile : plus de participations au combat d'équipe → plus de victoires → plus de défaites (top 5 chacun). Pour « échange » il montre les 5 utilisateurs avec le plus d'échanges terminés. La durée d'affichage s'applique par vue.",
    es: "Muestra la clasificación exclusivamente en su propia fuente de OBS (Conexión → Nombre de fuente de clasificación) – deliberadamente sin salida en el chat. Para “duelo” la vista rota entre: más combates → más victorias → más derrotas → mejor ratio victorias/derrotas (top 5 cada uno). Para “turnier” la vista rota entre: más victorias en torneo → más participaciones en torneo (top 5 cada uno). Para “teamkampf” la vista rota entre: más participaciones en combate de equipo → más victorias → más derrotas (top 5 cada uno). Para “intercambio” muestra los 5 usuarios con más intercambios completados. La duración de visualización aplica por vista.",
    th: "แสดงอันดับเฉพาะในซอร์ส OBS ของตัวเอง (การเชื่อมต่อ → ชื่อซอร์สอันดับ) โดยตั้งใจไม่ส่งข้อความในแชท สำหรับ \"การดวล\" จะวนแสดง: ต่อสู้มากที่สุด → ชนะมากที่สุด → แพ้มากที่สุด → อัตราส่วนชนะ/แพ้ดีที่สุด (5 อันดับแรกแต่ละหมวด) สำหรับ \"turnier\" จะวนแสดง: ชนะทัวร์นาเมนต์มากที่สุด → เข้าร่วมทัวร์นาเมนต์มากที่สุด (5 อันดับแรกแต่ละหมวด) สำหรับ \"teamkampf\" จะวนแสดง: เข้าร่วมทีมคัมภ์มากที่สุด → ชนะมากที่สุด → แพ้มากที่สุด (5 อันดับแรกแต่ละหมวด) สำหรับ \"การแลกเปลี่ยน\" จะแสดงผู้ใช้ 5 อันดับที่แลกเปลี่ยนสำเร็จมากที่สุด ระยะเวลาแสดงผลใช้ต่อหนึ่งมุมมอง"
  },
  "label-obs-ranking-source": { de: "Quellenname Ranking", en: "Source name ranking",
    fr: "Nom de source classement",
    es: "Nombre de fuente de clasificación",
    th: "ชื่อซอร์สอันดับ"
  },
  "label-obs-communitygoal-source": { de: "Quellenname Community-Ziel", en: "Source name community goal",
    fr: "Nom de source objectif communautaire",
    es: "Nombre de fuente meta comunitaria",
    th: "ชื่อซอร์สเป้าหมายชุมชน"
  },
  "label-meld-communitygoal-source": { de: "Quellenname Community-Ziel", en: "Source name community goal",
    fr: "Nom de source objectif communautaire",
    es: "Nombre de fuente meta comunitaria",
    th: "ชื่อซอร์สเป้าหมายชุมชน"
  },
  "cc-pack-eyebrow": { de: "Kartenpack", en: "Card pack",
    fr: "Pack de cartes",
    es: "Sobre de cartas",
    th: "แพ็กการ์ด"
  },
  "cc-pack-title": { de: "Pack-Befehl", en: "Pack command",
    fr: "Commande de pack",
    es: "Comando de sobre",
    th: "คำสั่งแพ็ก"
  },
  "cc-collection-eyebrow": { de: "Sammlung", en: "Collection",
    fr: "Collection",
    es: "Colección",
    th: "คอลเลกชัน"
  },
  "cc-collection-title": { de: "Sammlung-Befehl", en: "Collection command",
    fr: "Commande de collection",
    es: "Comando de colección",
    th: "คำสั่งคอลเลกชัน"
  },
  "cc-collection-hint": {
    de: "Zeigt die Sammlung als Overlay in OBS. Zusätzlich kann der Befehl die eigenen Kartennamen direkt im Chat auflisten (mit Anzahl bei Mehrfachbesitz) – wird bei Bedarf automatisch auf mehrere Nachrichten aufgeteilt, um Twitchs Zeichenlimit einzuhalten.",
    en: "Shows the collection as an OBS overlay. It can also list the caller's card names directly in chat (with a count when owned more than once) – automatically split across multiple messages if needed to stay under Twitch's character limit.",
    fr: "Affiche la collection en overlay OBS. Peut aussi lister les noms de cartes du demandeur directement dans le chat (avec un décompte si possédées plusieurs fois) – automatiquement scindé en plusieurs messages si besoin pour rester sous la limite de caractères de Twitch.",
    es: "Muestra la colección como overlay de OBS. También puede listar los nombres de las cartas del usuario directamente en el chat (con un contador si posee más de una) – se divide automáticamente en varios mensajes si es necesario para no superar el límite de caracteres de Twitch.",
    th: "แสดงคอลเลกชันเป็นโอเวอร์เลย์ OBS นอกจากนี้ยังสามารถแสดงรายชื่อการ์ดของผู้เรียกในแชทได้โดยตรง (พร้อมจำนวนหากมีมากกว่าหนึ่งใบ) และแบ่งเป็นหลายข้อความอัตโนมัติหากจำเป็นเพื่อไม่ให้เกินขีดจำกัดตัวอักษรของ Twitch"
  },
  "cc-collection-seconds-hint": {
    de: "Gilt für die Sammlungs-Anzeige in OBS, egal ob über Kanalpunkte oder Chat-Befehl ausgelöst – die Einstellung ist an beiden Stellen dieselbe.",
    en: "Applies to the collection display in OBS regardless of whether it's triggered via channel points or a chat command – this is the same setting in both places.",
    fr: "S'applique à l'affichage de la collection dans OBS, que ce soit via les points de chaîne ou une commande de chat – c'est le même réglage aux deux endroits.",
    es: "Se aplica a la visualización de la colección en OBS, ya sea activada por puntos de canal o por un comando de chat – es el mismo ajuste en ambos lugares.",
    th: "มีผลกับการแสดงคอลเลกชันใน OBS ไม่ว่าจะถูกเรียกผ่านแชนแนลพอยท์หรือคำสั่งแชท – เป็นการตั้งค่าเดียวกันทั้งสองที่"
  },
  "label-cc-collection-chatoutput": { de: "Kartennamen zusätzlich im Chat auflisten", en: "Also list card names in chat",
    fr: "Lister aussi les noms de cartes dans le chat",
    es: "Listar también los nombres de cartas en el chat",
    th: "แสดงรายชื่อการ์ดในแชทด้วย"
  },
  "label-cc-cards-header": { de: "Einleitung vor der Kartenliste", en: "Intro before the card list",
    fr: "Intro avant la liste de cartes",
    es: "Intro antes de la lista de cartas",
    th: "ข้อความนำก่อนรายการการ์ด"
  },
  "label-cc-cards-empty": { de: "Nachricht ohne eigene Karten", en: "Message when the user owns no cards",
    fr: "Message quand l'utilisateur ne possède aucune carte",
    es: "Mensaje cuando el usuario no posee cartas",
    th: "ข้อความเมื่อผู้ใช้ไม่มีการ์ดเลย"
  },
  "label-cc-prefix": { de: "Präfix", en: "Prefix",
    fr: "Préfixe",
    es: "Prefijo",
    th: "คำนำหน้า"
  },
  "label-cc-command": { de: "Befehlswort", en: "Command word",
    fr: "Mot de commande",
    es: "Palabra de comando",
    th: "คำสั่ง"
  },
  "label-cc-maxuses": { de: "Max. Nutzungen pro Viewer", en: "Max uses per viewer",
    fr: "Utilisations max. par spectateur",
    es: "Usos máx. por espectador",
    th: "จำนวนใช้สูงสุดต่อผู้ชม"
  },
  "label-cc-cooldown": { de: "Cooldown pro Viewer (Sek.)", en: "Cooldown per viewer (sec.)",
    fr: "Cooldown par spectateur (sec.)",
    es: "Cooldown por espectador (seg.)",
    th: "คูลดาวน์ต่อผู้ชม (วินาที)"
  },
  "label-cc-reset-value": { de: "Auto-Reset alle", en: "Auto-reset every",
    fr: "Réinitialisation auto toutes les",
    es: "Reinicio automático cada",
    th: "รีเซ็ตอัตโนมัติทุก"
  },
  "label-cc-reset-unit": { de: "Einheit", en: "Unit",
    fr: "Unité",
    es: "Unidad",
    th: "หน่วย"
  },
  "opt-minutes": { de: "Minuten", en: "Minutes",
    fr: "Minutes",
    es: "Minutos",
    th: "นาที"
  },
  "opt-hours": { de: "Stunden", en: "Hours",
    fr: "Heures",
    es: "Horas",
    th: "ชั่วโมง"
  },
  "opt-days": { de: "Tage", en: "Days",
    fr: "Jours",
    es: "Días",
    th: "วัน"
  },
  "label-cc-success-message": { de: "Nachricht bei Einlösung", en: "Message on redemption",
    fr: "Message lors de l'utilisation",
    es: "Mensaje al canjear",
    th: "ข้อความเมื่อใช้สำเร็จ"
  },
  "label-cc-limit-message": { de: "Nachricht bei erreichtem Limit", en: "Message when limit reached",
    fr: "Message quand la limite est atteinte",
    es: "Mensaje cuando se alcanza el límite",
    th: "ข้อความเมื่อถึงขีดจำกัด"
  },
  "label-cc-cooldown-message": { de: "Nachricht bei aktivem Cooldown", en: "Message when cooldown active",
    fr: "Message quand le cooldown est actif",
    es: "Mensaje cuando el cooldown está activo",
    th: "ข้อความเมื่อคูลดาวน์ยังทำงานอยู่"
  },
  "cu-eyebrow": { de: "Chat-Befehle", en: "Chat commands",
    fr: "Commandes de chat",
    es: "Comandos de chat",
    th: "คำสั่งแชท"
  },
  "cu-title": { de: "Nutzung Befehle", en: "Command usage",
    fr: "Utilisation des commandes",
    es: "Uso de comandos",
    th: "การใช้งานคำสั่ง"
  },
  "btn-cu-reset-all": { de: "Alle zurücksetzen", en: "Reset all",
    fr: "Tout réinitialiser",
    es: "Reiniciar todo",
    th: "รีเซ็ตทั้งหมด"
  },
  "btn-cu-reset-user": { de: "Zurücksetzen", en: "Reset",
    fr: "Réinitialiser",
    es: "Reiniciar",
    th: "รีเซ็ต"
  },
  "placeholder-cu-search": { de: "Nutzer suchen...", en: "Search user...",
    fr: "Rechercher un utilisateur...",
    es: "Buscar usuario...",
    th: "ค้นหาผู้ใช้..."
  },
  "hint-cu-empty": { de: "Noch keine Nutzungen vorhanden.", en: "No usage yet.",
    fr: "Pas encore d'utilisation.",
    es: "Aún sin uso.",
    th: "ยังไม่มีการใช้งาน"
  },
  "unit-cu-uses": { de: "Nutzungen", en: "uses",
    fr: "utilisations",
    es: "usos",
    th: "ครั้ง"
  },
  "cu-pack-reset": { de: "Pack-Reset", en: "Pack reset",
    fr: "Réinitialisation du pack",
    es: "Reinicio de sobre",
    th: "รีเซ็ตแพ็ก"
  },
  "cu-trade-reset": { de: "Tausch-Reset", en: "Trade reset",
    fr: "Réinitialisation de l'échange",
    es: "Reinicio de intercambio",
    th: "รีเซ็ตการแลกเปลี่ยน"
  },
  "cu-battle-reset": { de: "Kampf-Reset", en: "Battle reset",
    fr: "Réinitialisation du duel",
    es: "Reinicio de duelo",
    th: "รีเซ็ตการดวล"
  },
  "cu-remaining": { de: "übrig", en: "left",
    fr: "restant",
    es: "restante",
    th: "เหลือ"
  },
  "cu-unlimited": { de: "unbegrenzt", en: "unlimited",
    fr: "illimité",
    es: "ilimitado",
    th: "ไม่จำกัด"
  },
  "notice-cu-reset": { de: "Nutzung zurückgesetzt.", en: "Usage reset.",
    fr: "Utilisation réinitialisée.",
    es: "Uso reiniciado.",
    th: "รีเซ็ตการใช้งานแล้ว"
  },
  "notice-cu-reset-all": { de: "Alle Nutzungen zurückgesetzt.", en: "All usage reset.",
    fr: "Toute l'utilisation a été réinitialisée.",
    es: "Se reinició todo el uso.",
    th: "รีเซ็ตการใช้งานทั้งหมดแล้ว"
  },
  "queue-eyebrow": { de: "Verarbeitung", en: "Processing",
    fr: "Traitement",
    es: "Procesamiento",
    th: "การประมวลผล"
  },
  "queue-title": { de: "Warteschlange", en: "Queue",
    fr: "File d'attente",
    es: "Cola",
    th: "คิว"
  },
  "hint-queue": {
    de: "Kanalpunkte-Einlösungen und Chat-Befehle werden hier streng nacheinander verarbeitet (500ms Pause zwischen Einträgen).",
    en: "Channel point redemptions and chat commands are processed strictly in order here (500ms pause between entries).",
    fr: "Les utilisations de points de chaîne et les commandes de chat sont traitées ici strictement dans l'ordre (pause de 500ms entre les entrées).",
    es: "Los canjes de puntos de canal y los comandos de chat se procesan aquí estrictamente en orden (pausa de 500ms entre entradas).",
    th: "การแลกแชนแนลพอยท์และคำสั่งแชทจะถูกประมวลผลตามลำดับอย่างเคร่งครัด (หยุดพัก 500 มิลลิวินาทีระหว่างรายการ)"
  },
  "hint-queue-empty": { de: "Aktuell keine ausstehenden Einträge.", en: "No pending entries right now.",
    fr: "Aucune entrée en attente actuellement.",
    es: "No hay entradas pendientes en este momento.",
    th: "ไม่มีรายการรอดำเนินการในขณะนี้"
  },
  "label-queue-paused": { de: "Queue pausieren", en: "Pause queue",
    fr: "Mettre la file en pause",
    es: "Pausar cola",
    th: "หยุดคิวชั่วคราว"
  },
  "btn-queue-clear": { de: "Alle Einträge löschen", en: "Clear all entries",
    fr: "Effacer toutes les entrées",
    es: "Borrar todas las entradas",
    th: "ล้างรายการทั้งหมด"
  },
  "btn-queue-remove": { de: "Entfernen", en: "Remove",
    fr: "Supprimer",
    es: "Eliminar",
    th: "ลบ"
  },
  "notice-queue-cleared": { de: "Warteschlange geleert.", en: "Queue cleared.",
    fr: "File d'attente vidée.",
    es: "Cola vaciada.",
    th: "ล้างคิวแล้ว"
  },
  "queue-kind-draw": { de: "Kartenpack", en: "Card pack",
    fr: "Pack de cartes",
    es: "Sobre de cartas",
    th: "แพ็กการ์ด"
  },
  "queue-kind-showcollection": { de: "Sammlung zeigen", en: "Show collection",
    fr: "Afficher la collection",
    es: "Mostrar colección",
    th: "แสดงคอลเลกชัน"
  },
  "queue-kind-trade": { de: "Tausch", en: "Trade",
    fr: "Échange",
    es: "Intercambio",
    th: "การแลกเปลี่ยน"
  },
  "queue-source-chat": { de: "Chat", en: "Chat",
    fr: "Chat",
    es: "Chat",
    th: "แชท"
  },
  "queue-source-channelpoints": { de: "Kanalpunkte", en: "Channel points",
    fr: "Points de chaîne",
    es: "Puntos de canal",
    th: "แชนแนลพอยท์"
  },
  "queue-processing": { de: "wird verarbeitet", en: "processing",
    fr: "en traitement",
    es: "procesando",
    th: "กำลังประมวลผล"
  },
  "log-eyebrow": { de: "Verlauf", en: "History",
    fr: "Historique",
    es: "Historial",
    th: "ประวัติ"
  },
  "log-title": { de: "Ereignis-Log", en: "Event log",
    fr: "Journal des événements",
    es: "Registro de eventos",
    th: "บันทึกเหตุการณ์"
  },
  "placeholder-log-search": { de: "Log durchsuchen...", en: "Search log...",
    fr: "Rechercher dans le journal...",
    es: "Buscar en el registro...",
    th: "ค้นหาในบันทึก..."
  },
  "btn-export-logs": { de: "Exportieren", en: "Export",
    fr: "Exporter",
    es: "Exportar",
    th: "ส่งออก"
  },
  "btn-clear-logs": { de: "Log löschen", en: "Clear log",
    fr: "Effacer le journal",
    es: "Borrar registro",
    th: "ล้างบันทึก"
  },
  "hint-log-empty": { de: "Noch keine Ereignisse aufgezeichnet.", en: "No events recorded yet.",
    fr: "Aucun événement enregistré pour l'instant.",
    es: "Aún no se han registrado eventos.",
    th: "ยังไม่มีการบันทึกเหตุการณ์"
  },
  "hint-no-log-found": { de: "Keine Einträge gefunden für", en: "No entries found for",
    fr: "Aucune entrée trouvée pour",
    es: "No se encontraron entradas para",
    th: "ไม่พบรายการสำหรับ"
  },
  "notice-log-cleared": { de: "Log gelöscht.", en: "Log cleared.",
    fr: "Journal effacé.",
    es: "Registro borrado.",
    th: "ล้างบันทึกแล้ว"
  },
  "update-eyebrow": { de: "Wartung", en: "Maintenance",
    fr: "Maintenance",
    es: "Mantenimiento",
    th: "การบำรุงรักษา"
  },
  "update-title": { de: "Update", en: "Update",
    fr: "Mise à jour",
    es: "Actualización",
    th: "อัปเดต"
  },
  "update-current-label": { de: "Installierte Version", en: "Installed version",
    fr: "Version installée",
    es: "Versión instalada",
    th: "เวอร์ชันที่ติดตั้ง"
  },
  "update-date-label": { de: "Veröffentlicht am", en: "Released on",
    fr: "Publiée le",
    es: "Publicado el",
    th: "เผยแพร่เมื่อ"
  },
  "update-status-idle": { de: "Noch nicht geprüft.", en: "Not checked yet.",
    fr: "Pas encore vérifié.",
    es: "Aún no verificado.",
    th: "ยังไม่ได้ตรวจสอบ"
  },
  "update-status-checking": { de: "Prüfe auf Updates...", en: "Checking for updates...",
    fr: "Vérification des mises à jour...",
    es: "Buscando actualizaciones...",
    th: "กำลังตรวจสอบการอัปเดต..."
  },
  "update-status-current": { de: "Du nutzt die aktuelle Version.", en: "You're on the latest version.",
    fr: "Tu es sur la dernière version.",
    es: "Tienes la última versión.",
    th: "คุณใช้เวอร์ชันล่าสุดอยู่แล้ว"
  },
  "update-status-available": { de: "Update verfügbar:", en: "Update available:",
    fr: "Mise à jour disponible :",
    es: "Actualización disponible:",
    th: "มีอัปเดตพร้อมใช้งาน:"
  },
  "update-status-error": { de: "Update-Prüfung fehlgeschlagen:", en: "Update check failed:",
    fr: "Échec de la vérification :",
    es: "Error al buscar actualización:",
    th: "ตรวจสอบการอัปเดตล้มเหลว:"
  },
  "btn-check-update": { de: "Nach Updates suchen", en: "Check for updates",
    fr: "Vérifier les mises à jour",
    es: "Buscar actualizaciones",
    th: "ตรวจสอบการอัปเดต"
  },
  "btn-goto-update": { de: "Zum Update", en: "Go to update",
    fr: "Aller à la mise à jour",
    es: "Ir a la actualización",
    th: "ไปที่การอัปเดต"
  },
  "btn-install-update": { de: "Installieren", en: "Install",
    fr: "Installer",
    es: "Instalar",
    th: "ติดตั้ง"
  },
  "update-changelog-eyebrow": { de: "Änderungen", en: "Changes",
    fr: "Changements",
    es: "Cambios",
    th: "การเปลี่ยนแปลง"
  },
  "update-changelog-title": { de: "Was ist neu seit deiner Version", en: "What's new since your version",
    fr: "Nouveautés depuis ta version",
    es: "Novedades desde tu versión",
    th: "มีอะไรใหม่ตั้งแต่เวอร์ชันของคุณ"
  },
  "btn-show-all-changelog": {
    de: "Alle Versionen anzeigen",
    en: "Show all versions",
    fr: "Afficher toutes les versions",
    es: "Mostrar todas las versiones",
    th: "แสดงทุกเวอร์ชัน"
  },
  "btn-show-recent-changelog": {
    de: "Nur neuere Versionen anzeigen",
    en: "Show only newer versions",
    fr: "Afficher uniquement les versions récentes",
    es: "Mostrar solo versiones más recientes",
    th: "แสดงเฉพาะเวอร์ชันใหม่กว่า"
  },
  "update-changelog-loading": { de: "Wird geladen…", en: "Loading…",
    fr: "Chargement…",
    es: "Cargando…",
    th: "กำลังโหลด…"
  },
  "update-changelog-none": { de: "Du hast bereits die neueste Version.", en: "You're already on the latest version.",
    fr: "Tu es déjà sur la dernière version.",
    es: "Ya tienes la última versión.",
    th: "คุณใช้เวอร์ชันล่าสุดอยู่แล้ว"
  },
  "update-changelog-empty": { de: "Keine Details zu diesem Release verfügbar.", en: "No details available for this release.",
    fr: "Aucun détail disponible pour cette version.",
    es: "No hay detalles disponibles para esta versión.",
    th: "ไม่มีรายละเอียดสำหรับรุ่นนี้"
  },
  "update-changelog-error": { de: "Änderungen konnten nicht geladen werden:", en: "Could not load changes:",
    fr: "Impossible de charger les changements :",
    es: "No se pudieron cargar los cambios:",
    th: "ไม่สามารถโหลดการเปลี่ยนแปลงได้:"
  },
  "confirm-install-update": {
    de: "Update jetzt installieren? Die App startet dabei neu. Deine Einstellungen, Sammlungen und die Twitch/OBS-Verbindung bleiben erhalten.",
    en: "Install the update now? The app will restart. Your settings, collections and Twitch/OBS connection are kept.",
    fr: "Installer la mise à jour maintenant ? L'application va redémarrer. Tes paramètres, collections et connexions Twitch/OBS sont conservés.",
    es: "¿Instalar la actualización ahora? La aplicación se reiniciará. Se conservan tus ajustes, colecciones y conexión Twitch/OBS.",
    th: "ติดตั้งอัปเดตตอนนี้หรือไม่? แอปจะรีสตาร์ท การตั้งค่า คอลเลกชัน และการเชื่อมต่อ Twitch/OBS ของคุณจะยังคงอยู่"
  },
  "update-status-installing": { de: "Installiere Update, App startet neu...", en: "Installing update, app is restarting...",
    fr: "Installation de la mise à jour, l'application redémarre...",
    es: "Instalando actualización, la aplicación se está reiniciando...",
    th: "กำลังติดตั้งอัปเดต แอปกำลังรีสตาร์ท..."
  },
  "update-status-install-failed": { de: "Installation fehlgeschlagen:", en: "Installation failed:",
    fr: "Échec de l'installation :",
    es: "Error en la instalación:",
    th: "การติดตั้งล้มเหลว:"
  },
  "error-no-update-asset": {
    de: "Im Release wurde keine herunterladbare Datei (.zip) gefunden.",
    en: "No downloadable file (.zip) was found in the release.",
    fr: "Aucun fichier téléchargeable (.zip) n'a été trouvé dans la version.",
    es: "No se encontró ningún archivo descargable (.zip) en la versión.",
    th: "ไม่พบไฟล์ที่ดาวน์โหลดได้ (.zip) ในรุ่นนี้"
  },
  "banner-update-available": { de: "Neue Version verfügbar:", en: "New version available:",
    fr: "Nouvelle version disponible :",
    es: "Nueva versión disponible:",
    th: "มีเวอร์ชันใหม่พร้อมใช้งาน:"
  },
  "label-language": { de: "Sprache", en: "Language",
    fr: "Langue",
    es: "Idioma",
    th: "ภาษา"
  },
  "label-theme-mode": { de: "Modus", en: "Mode",
    fr: "Mode",
    es: "Modo",
    th: "โหมด"
  },
  "pill-twitch-default": { de: "Twitch nicht verbunden", en: "Twitch not connected",
    fr: "Twitch non connecté",
    es: "Twitch no conectado",
    th: "Twitch ยังไม่เชื่อมต่อ"
  },
  "pill-obs-default": { de: "OBS nicht verbunden", en: "OBS not connected",
    fr: "OBS non connecté",
    es: "OBS no conectado",
    th: "OBS ยังไม่เชื่อมต่อ"
  },
  "pill-server-unreachable": { de: "Server nicht erreichbar", en: "Server unreachable",
    fr: "Serveur injoignable",
    es: "Servidor inaccesible",
    th: "ไม่สามารถเข้าถึงเซิร์ฟเวอร์ได้"
  },
  "pill-twitch-connected": { de: "Twitch", en: "Twitch",
    fr: "Twitch",
    es: "Twitch",
    th: "Twitch"
  },
  "pill-twitch-connected-fallback": { de: "verbunden", en: "connected",
    fr: "connecté",
    es: "conectado",
    th: "เชื่อมต่อแล้ว"
  },
  "pill-obs-connected": { de: "OBS verbunden", en: "OBS connected",
    fr: "OBS connecté",
    es: "OBS conectado",
    th: "OBS เชื่อมต่อแล้ว"
  },
  "pill-meld-default": { de: "Meld nicht verbunden", en: "Meld not connected",
    fr: "Meld non connecté",
    es: "Meld no conectado",
    th: "Meld ยังไม่เชื่อมต่อ"
  },
  "pill-meld-connected": { de: "Meld verbunden", en: "Meld connected",
    fr: "Meld connecté",
    es: "Meld conectado",
    th: "Meld เชื่อมต่อแล้ว"
  },
  "topbar-eyebrow": { de: "Lokale Verwaltung", en: "Local management",
    fr: "Gestion locale",
    es: "Gestión local",
    th: "การจัดการภายในเครื่อง"
  },
  "topbar-title": { de: "Kartenpacks", en: "Card packs",
    fr: "Packs de cartes",
    es: "Sobres de cartas",
    th: "แพ็กการ์ด"
  },
  "btn-save": { de: "Speichern", en: "Save",
    fr: "Enregistrer",
    es: "Guardar",
    th: "บันทึก"
  },
  "save-indicator-dirty": { de: "Ungespeicherte Änderungen", en: "Unsaved changes",
    fr: "Modifications non enregistrées", es: "Cambios sin guardar", th: "มีการเปลี่ยนแปลงที่ยังไม่ได้บันทึก"
  },
  "save-indicator-saving": { de: "Speichert…", en: "Saving…",
    fr: "Enregistrement…", es: "Guardando…", th: "กำลังบันทึก…"
  },
  "save-indicator-saved": { de: "Gespeichert", en: "Saved",
    fr: "Enregistré", es: "Guardado", th: "บันทึกแล้ว"
  },
  "save-indicator-error": { de: "Speichern fehlgeschlagen", en: "Save failed",
    fr: "Échec de l'enregistrement", es: "Error al guardar", th: "บันทึกล้มเหลว"
  },
  "ov-test-eyebrow": { de: "Testlauf", en: "Test run",
    fr: "Test",
    es: "Prueba",
    th: "ทดสอบ"
  },
  "ov-test-title": { de: "Animation auslösen", en: "Trigger animation",
    fr: "Déclencher l'animation",
    es: "Activar animación",
    th: "เรียกใช้แอนิเมชัน"
  },
  "label-test-name": { de: "Testname", en: "Test name",
    fr: "Nom de test",
    es: "Nombre de prueba",
    th: "ชื่อทดสอบ"
  },
  "label-test-booster": { de: "Booster", en: "Booster",
    fr: "Booster",
    es: "Sobre",
    th: "บูสเตอร์"
  },
  "label-test-card": { de: "Karte", en: "Card",
    fr: "Carte",
    es: "Carta",
    th: "การ์ด"
  },
  "option-random": { de: "Zufällig", en: "Random",
    fr: "Aléatoire",
    es: "Aleatorio",
    th: "สุ่ม"
  },
  "btn-test-random": { de: "Demo zufällig ausführen", en: "Run random demo",
    fr: "Lancer une démo aléatoire",
    es: "Ejecutar demo aleatoria",
    th: "เรียกใช้เดโมแบบสุ่ม"
  },
  "btn-test-selected": { de: "Gewählte Karte öffnen", en: "Open selected card",
    fr: "Ouvrir la carte sélectionnée",
    es: "Abrir carta seleccionada",
    th: "เปิดการ์ดที่เลือก"
  },
  "hint-overlay-required": {
    de: "Das Overlay muss in OBS oder in einem Browser geöffnet sein, damit du die Animation siehst.",
    en: "The overlay must be open in OBS or a browser for you to see the animation.",
    fr: "L'overlay doit être ouvert dans OBS ou un navigateur pour voir l'animation.",
    es: "El overlay debe estar abierto en OBS o un navegador para ver la animación.",
    th: "โอเวอร์เลย์ต้องเปิดอยู่ใน OBS หรือเบราว์เซอร์เพื่อดูแอนิเมชัน"
  },
  "stats-eyebrow": { de: "Community", en: "Community", fr: "Communauté", es: "Comunidad", th: "ชุมชน" },
  "stats-title": { de: "Nutzung insgesamt", en: "Overall usage", fr: "Utilisation globale", es: "Uso general", th: "การใช้งานทั้งหมด" },
  "stats-users-label": { de: "Nutzer der App", en: "App users", fr: "Utilisateurs de l'application", es: "Usuarios de la app", th: "ผู้ใช้แอป" },
  "stats-boosters-label": { de: "Bisher erstellte Booster", en: "Boosters created so far", fr: "Boosters créés jusqu'ici", es: "Sobres creados hasta ahora", th: "บูสเตอร์ที่สร้างแล้ว" },
  "stats-cards-label": { de: "Bisher erstellte Karten", en: "Cards created so far", fr: "Cartes créées jusqu'ici", es: "Cartas creadas hasta ahora", th: "การ์ดที่สร้างแล้ว" },
  "ov-template-eyebrow": { de: "Vorlage", en: "Template",
    fr: "Modèle",
    es: "Plantilla",
    th: "แม่แบบ"
  },
  "ov-template-title": { de: "Blanko-Karte", en: "Blank card",
    fr: "Carte vierge",
    es: "Carta en blanco",
    th: "การ์ดเปล่า"
  },
  "ov-template-hint": {
    de: "Lädt eine transparente PNG-Datei genau in der Form des inneren Kartenbild-Bereichs (mit abgerundeten Ecken) - als Vorlage für Photoshop, Gimp & Co. Einfach bemalen und als Kartenbild wieder hochladen.",
    en: "Downloads a transparent PNG matching the shape of the inner card art area (with rounded corners) - as a template for Photoshop, Gimp & co. Paint it and re-upload it as the card image.",
    fr: "Télécharge un PNG transparent à la forme de la zone d'illustration intérieure de la carte (coins arrondis) - comme modèle pour Photoshop, Gimp & co. Peins-le puis remets-le en ligne comme image de carte.",
    es: "Descarga un PNG transparente con la forma del área interior de ilustración de la carta (esquinas redondeadas) - como plantilla para Photoshop, Gimp y similares. Píntala y vuelve a subirla como imagen de carta.",
    th: "ดาวน์โหลด PNG โปร่งใสตามรูปทรงพื้นที่ภาพด้านในของการ์ด (มุมโค้งมน) เพื่อใช้เป็นแม่แบบสำหรับ Photoshop, Gimp และอื่นๆ วาดแล้วอัปโหลดกลับเป็นรูปการ์ด"
  },
  "btn-download-blank-template": { de: "Blanko-Karte herunterladen (PNG)", en: "Download blank card (PNG)",
    fr: "Télécharger la carte vierge (PNG)",
    es: "Descargar carta en blanco (PNG)",
    th: "ดาวน์โหลดการ์ดเปล่า (PNG)"
  },
  "ov-help-eyebrow": { de: "Hilfe", en: "Help",
    fr: "Aide",
    es: "Ayuda",
    th: "ช่วยเหลือ"
  },
  "ov-help-title": { de: "Fragen?", en: "Questions?",
    fr: "Des questions ?",
    es: "¿Preguntas?",
    th: "มีคำถามไหม?"
  },
  "ov-help-text": {
    de: "Auf GitHub findest du eine kleine Anleitung, falls du Fragen zur Einrichtung oder den Funktionen hast.",
    en: "On GitHub you'll find a short guide in case you have questions about setup or features.",
    fr: "Tu trouveras sur GitHub un petit guide en cas de questions sur la configuration ou les fonctionnalités.",
    es: "En GitHub encontrarás una breve guía por si tienes preguntas sobre la configuración o las funciones.",
    th: "คุณสามารถดูคู่มือสั้นๆ ได้ที่ GitHub หากมีคำถามเกี่ยวกับการตั้งค่าหรือฟีเจอร์"
  },
  "btn-open-guide": { de: "Anleitung auf GitHub öffnen", en: "Open guide on GitHub",
    fr: "Ouvrir le guide sur GitHub",
    es: "Abrir guía en GitHub",
    th: "เปิดคู่มือบน GitHub"
  },
  "cards-eyebrow": { de: "Deck", en: "Deck",
    fr: "Deck",
    es: "Mazo",
    th: "เด็ค"
  },
  "cards-title": { de: "Karten verwalten", en: "Manage cards",
    fr: "Gérer les cartes",
    es: "Gestionar cartas",
    th: "จัดการการ์ด"
  },
  "btn-add-card": { de: "Karte hinzufügen", en: "Add card",
    fr: "Ajouter une carte",
    es: "Añadir carta",
    th: "เพิ่มการ์ด"
  },
  "label-cards-sort": { de: "Sortieren nach", en: "Sort by",
    fr: "Trier par",
    es: "Ordenar por",
    th: "เรียงตาม"
  },
  "option-cards-sort-default": { de: "Reihenfolge", en: "Order",
    fr: "Ordre",
    es: "Orden",
    th: "ลำดับ"
  },
  "option-cards-sort-name": { de: "Name (A-Z)", en: "Name (A-Z)",
    fr: "Nom (A-Z)",
    es: "Nombre (A-Z)",
    th: "ชื่อ (ก-ฮ)"
  },
  "option-cards-sort-rarity": { de: "Seltenheit", en: "Rarity",
    fr: "Rareté",
    es: "Rareza",
    th: "ระดับความหายาก"
  },
  "option-cards-sort-booster": { de: "Booster-Zuordnung", en: "Booster assignment",
    fr: "Affectation au booster",
    es: "Asignación de sobre",
    th: "การกำหนดบูสเตอร์"
  },
  "option-cards-sort-status": { de: "Status (aktiv zuerst)", en: "Status (active first)",
    fr: "Statut (actives en premier)",
    es: "Estado (activas primero)",
    th: "สถานะ (เปิดใช้งานก่อน)"
  },
  "btn-import-card": { de: "Karte importieren", en: "Import card",
    fr: "Importer une carte",
    es: "Importar carta",
    th: "นำเข้าการ์ด"
  },
  "btn-export-card": { de: "Exportieren", en: "Export",
    fr: "Exporter",
    es: "Exportar",
    th: "ส่งออก"
  },
  "btn-import-booster": { de: "Booster importieren", en: "Import booster",
    fr: "Importer un booster",
    es: "Importar sobre",
    th: "นำเข้าบูสเตอร์"
  },
  "btn-export-booster": { de: "Booster exportieren", en: "Export booster",
    fr: "Exporter le booster",
    es: "Exportar sobre",
    th: "ส่งออกบูสเตอร์"
  },
  "notice-card-exported": { de: "Karte als Datei exportiert.", en: "Card exported as a file.",
    fr: "Carte exportée en fichier.",
    es: "Carta exportada como archivo.",
    th: "ส่งออกการ์ดเป็นไฟล์แล้ว"
  },
  "notice-card-imported": { de: "Karte importiert. Bitte einem Booster zuordnen, damit sie gezogen werden kann.", en: "Card imported. Assign it to a booster so it can be drawn.",
    fr: "Carte importée. Assigne-la à un booster pour qu'elle puisse être tirée.",
    es: "Carta importada. Asígnala a un sobre para que pueda salir al abrir.",
    th: "นำเข้าการ์ดแล้ว กำหนดให้กับบูสเตอร์เพื่อให้สามารถสุ่มได้"
  },
  "notice-booster-exported": { de: "Booster inkl. Karten als Datei exportiert.", en: "Booster incl. cards exported as a file.",
    fr: "Booster incl. cartes exporté en fichier.",
    es: "Sobre con cartas exportado como archivo.",
    th: "ส่งออกบูสเตอร์พร้อมการ์ดเป็นไฟล์แล้ว"
  },
  "notice-booster-imported": { de: "Booster inkl. Karten importiert.", en: "Booster incl. cards imported.",
    fr: "Booster incl. cartes importé.",
    es: "Sobre con cartas importado.",
    th: "นำเข้าบูสเตอร์พร้อมการ์ดแล้ว"
  },
  "error-import-invalid": { de: "Die Datei konnte nicht gelesen werden (kein gültiges JSON).", en: "The file could not be read (not valid JSON).",
    fr: "Le fichier n'a pas pu être lu (JSON invalide).",
    es: "No se pudo leer el archivo (JSON no válido).",
    th: "ไม่สามารถอ่านไฟล์ได้ (JSON ไม่ถูกต้อง)"
  },
  "error-import-not-card": { de: "Die Datei ist kein Karten-Export dieser App.", en: "The file is not a card export from this app.",
    fr: "Le fichier n'est pas un export de carte de cette application.",
    es: "El archivo no es una exportación de carta de esta aplicación.",
    th: "ไฟล์นี้ไม่ใช่การส่งออกการ์ดจากแอปนี้"
  },
  "error-import-not-booster": { de: "Die Datei ist kein Booster-Export dieser App.", en: "The file is not a booster export from this app.",
    fr: "Le fichier n'est pas un export de booster de cette application.",
    es: "El archivo no es una exportación de sobre de esta aplicación.",
    th: "ไฟล์นี้ไม่ใช่การส่งออกบูสเตอร์จากแอปนี้"
  },
  "cards-live-preview": { de: "Live Vorschau", en: "Live preview",
    fr: "Aperçu en direct",
    es: "Vista previa en vivo",
    th: "ตัวอย่างสด"
  },
  "cards-live-preview-hint": { de: "Klicke links auf eine Kartenminiatur, um sie hier anzuzeigen.", en: "Click a card thumbnail on the left to show it here.",
    fr: "Clique sur une miniature de carte à gauche pour l'afficher ici.",
    es: "Haz clic en una miniatura de carta a la izquierda para mostrarla aquí.",
    th: "คลิกภาพย่อการ์ดทางซ้ายเพื่อแสดงที่นี่"
  },
  "aria-select-card": { de: "Karte auswählen", en: "Select card",
    fr: "Sélectionner la carte",
    es: "Seleccionar carta",
    th: "เลือกการ์ด"
  },
  "hint-select-card": { de: "Vorschau", en: "Preview",
    fr: "Aperçu",
    es: "Vista previa",
    th: "ตัวอย่าง"
  },
  "label-card-title": { de: "Titel", en: "Title",
    fr: "Titre",
    es: "Título",
    th: "ชื่อ"
  },
  "label-card-rarity": { de: "Rarität", en: "Rarity",
    fr: "Rareté",
    es: "Rareza",
    th: "ระดับความหายาก"
  },
  "label-card-accent": { de: "Akzent", en: "Accent",
    fr: "Accent",
    es: "Acento",
    th: "สีเน้น"
  },
  "label-card-enabled": { de: "Aktiv", en: "Active",
    fr: "Actif",
    es: "Activo",
    th: "ใช้งานอยู่"
  },
  "label-card-image": { de: "Bild", en: "Image",
    fr: "Image",
    es: "Imagen",
    th: "รูปภาพ"
  },
  "btn-duplicate": { de: "Duplizieren", en: "Duplicate",
    fr: "Dupliquer",
    es: "Duplicar",
    th: "ทำสำเนา"
  },
  "btn-remove-image": { de: "Bild entfernen", en: "Remove image",
    fr: "Supprimer l'image",
    es: "Eliminar imagen",
    th: "ลบรูปภาพ"
  },
  "btn-delete": { de: "Löschen", en: "Delete",
    fr: "Supprimer",
    es: "Eliminar",
    th: "ลบ"
  },
  "rarity-common": { de: "Gewöhnlich", en: "Common",
    fr: "Commune",
    es: "Común",
    th: "ธรรมดา"
  },
  "rarity-uncommon": { de: "Ungewöhnlich", en: "Uncommon",
    fr: "Peu commune",
    es: "Poco común",
    th: "ไม่ธรรมดา"
  },
  "rarity-rare": { de: "Selten", en: "Rare",
    fr: "Rare",
    es: "Rara",
    th: "หายาก"
  },
  "rarity-epic": { de: "Episch", en: "Epic",
    fr: "Épique",
    es: "Épica",
    th: "เอพิก"
  },
  "rarity-legendary": { de: "Legendär", en: "Legendary",
    fr: "Légendaire",
    es: "Legendaria",
    th: "ตำนาน"
  },
  "rarity-holo": { de: "Holo", en: "Holo",
    fr: "Holo",
    es: "Holo",
    th: "โฮโล"
  },
  "rarity-colors-eyebrow": { de: "Karten", en: "Cards",
    fr: "Cartes",
    es: "Cartas",
    th: "การ์ด"
  },
  "rarity-colors-title": { de: "Rahmenfarben je Rarität", en: "Border colors per rarity",
    fr: "Couleurs de bordure par rareté",
    es: "Colores de borde por rareza",
    th: "สีขอบตามระดับความหายาก"
  },
  "btn-reset-rarity-colors": { de: "Auf Standard zurücksetzen", en: "Reset to defaults",
    fr: "Réinitialiser",
    es: "Restablecer valores predeterminados",
    th: "รีเซ็ตเป็นค่าเริ่มต้น"
  },
  "notice-rarity-colors-reset": { de: "Rahmenfarben zurückgesetzt.", en: "Border colors reset.",
    fr: "Couleurs de bordure réinitialisées.",
    es: "Colores de borde restablecidos.",
    th: "รีเซ็ตสีขอบแล้ว"
  },
  "rarity-weights-eyebrow": { de: "Karten", en: "Cards",
    fr: "Cartes",
    es: "Cartas",
    th: "การ์ด"
  },
  "rarity-weights-title": { de: "Gewichtung je Rarität", en: "Weight per rarity",
    fr: "Poids par rareté",
    es: "Peso por rareza",
    th: "น้ำหนักตามระดับความหายาก"
  },
  "rarity-weights-hint": { de: "Höhere Werte werden häufiger gezogen.", en: "Higher values are drawn more often.",
    fr: "Des valeurs plus élevées sont tirées plus souvent.",
    es: "Los valores más altos salen con más frecuencia.",
    th: "ค่าที่สูงกว่าจะถูกสุ่มออกบ่อยกว่า"
  },
  "pity-eyebrow": { de: "Karten", en: "Cards",
    fr: "Cartes",
    es: "Cartas",
    th: "การ์ด"
  },
  "pity-title": { de: "Garantie-System", en: "Pity system",
    fr: "Système de pitié",
    es: "Sistema de compensación",
    th: "ระบบการันตี"
  },
  "subrewards-eyebrow": { de: "Karten", en: "Cards", fr: "Cartes", es: "Cartas", th: "การ์ด" },
  "subrewards-title": { de: "Sub-Belohnungen", en: "Sub rewards",
    fr: "Récompenses d'abonnement",
    es: "Recompensas de suscripción",
    th: "รางวัลจากการสมัครสมาชิก"
  },
  "subrewards-hint": {
    de: "Vergibt automatisch Karten aus allen als \"Sub-exklusiv\" markierten Boostern (siehe Booster-Tab) bei neuem Sub, Resub oder verschenkten Subs. Diese Booster sind über Kanalpunkte/\"!pack\" nicht erreichbar.",
    en: "Automatically awards cards from every booster flagged \"sub-exclusive\" (see the Booster tab) on a new sub, resub, or gifted subs. These boosters cannot be reached via channel points/\"!pack\".",
    fr: "Attribue automatiquement des cartes de chaque booster marqué \"exclusif aux abonnés\" (voir l'onglet Booster) lors d'un nouvel abonnement, d'un réabonnement ou d'abonnements offerts. Ces boosters ne sont pas accessibles via les points de chaîne/\"!pack\".",
    es: "Otorga automáticamente cartas de cada booster marcado como \"exclusivo para suscriptores\" (ver la pestaña Booster) al producirse una nueva suscripción, resuscripción o suscripciones regaladas. Estos boosters no son accesibles mediante puntos de canal/\"!pack\".",
    th: "มอบการ์ดจากบูสเตอร์ที่ทำเครื่องหมายว่า \"เฉพาะผู้สมัครสมาชิก\" (ดูแท็บ Booster) โดยอัตโนมัติเมื่อมีการสมัครสมาชิกใหม่ การต่ออายุ หรือการมอบสมาชิก บูสเตอร์เหล่านี้ไม่สามารถเข้าถึงได้ผ่านแชนแนลพอยท์/\"!pack\""
  },
  "label-subrewards-enabled": { de: "Sub-Belohnungen aktiviert", en: "Sub rewards enabled",
    fr: "Récompenses d'abonnement activées",
    es: "Recompensas de suscripción activadas",
    th: "เปิดใช้งานรางวัลจากการสมัครสมาชิก"
  },
  "label-subrewards-cards-per-sub": { de: "Karten je Sub", en: "Cards per sub",
    fr: "Cartes par abonnement",
    es: "Cartas por suscripción",
    th: "การ์ดต่อการสมัครสมาชิก"
  },
  "bits-eyebrow": { de: "Karten", en: "Cards", fr: "Cartes", es: "Cartas", th: "การ์ด" },
  "bits-title": { de: "Bits-Belohnung", en: "Bits reward", fr: "Récompense en bits", es: "Recompensa por bits", th: "รางวัลบิต" },
  "bits-hint": {
    de: "Vergibt automatisch eine Kartenziehung je \"Bits je Ziehung\" gespendeter Bits (Cheers). Übrige Bits unter der Schwelle werden je Zuschauer gespeichert und zählen beim nächsten Cheer weiter - z. B. bei 100 Bits je Ziehung löst ein 250-Bits-Cheer sofort 2 Ziehungen aus und speichert 50 Bits; ein weiterer 50-Bits-Cheer löst dann die dritte Ziehung aus.",
    en: "Automatically awards one card draw per \"bits per draw\" of donated bits (cheers). Leftover bits below the threshold are banked per viewer and carry over to the next cheer - e.g. at 100 bits per draw, a 250-bit cheer immediately earns 2 draws and banks 50 bits; a further 50-bit cheer then earns the third draw.",
    fr: "Attribue automatiquement un tirage de carte par tranche de \"bits par tirage\" de bits donnés (cheers). Les bits restants sous le seuil sont mis en réserve par spectateur et reportés au prochain cheer - p. ex. à 100 bits par tirage, un cheer de 250 bits rapporte immédiatement 2 tirages et met 50 bits en réserve ; un cheer supplémentaire de 50 bits rapporte alors le troisième tirage.",
    es: "Otorga automáticamente una tirada de carta por cada \"bits por tirada\" de bits donados (cheers). Los bits restantes por debajo del umbral se acumulan por espectador y se trasladan al siguiente cheer - p. ej. con 100 bits por tirada, un cheer de 250 bits otorga de inmediato 2 tiradas y acumula 50 bits; un cheer adicional de 50 bits otorga entonces la tercera tirada.",
    th: "มอบการจับสลากการ์ดหนึ่งครั้งโดยอัตโนมัติต่อทุก \"บิตต่อการจับสลาก\" ของบิตที่บริจาค (cheers) บิตส่วนที่เหลือต่ำกว่าเกณฑ์จะถูกเก็บสะสมต่อผู้ชมและยกไปรวมกับ cheer ครั้งถัดไป - เช่น ที่ 100 บิตต่อการจับสลาก การ cheer 250 บิตจะได้รับ 2 การจับสลากทันทีและเก็บสะสม 50 บิต การ cheer เพิ่มอีก 50 บิตจะได้รับการจับสลากครั้งที่สาม"
  },
  "label-bits-enabled": { de: "Bits-Belohnung aktiviert", en: "Bits reward enabled", fr: "Récompense en bits activée", es: "Recompensa por bits activada", th: "เปิดใช้งานรางวัลบิต" },
  "label-bits-per-draw": { de: "Bits je Ziehung", en: "Bits per draw", fr: "Bits par tirage", es: "Bits por tirada", th: "บิตต่อการจับสลาก" },
  "bits-scope-hint": {
    de: "Benötigt die Berechtigung \"bits:read\" - falls die App von einer älteren Version aktualisiert wurde, den Hauptaccount einmal neu unter Verbindung anmelden, damit diese Berechtigung erteilt wird.",
    en: "Requires the \"bits:read\" permission - if the app was updated from an older version, re-log in the main account once under Connection so this permission gets granted.",
    fr: "Nécessite l'autorisation \"bits:read\" - si l'application a été mise à jour depuis une version antérieure, reconnectez une fois le compte principal sous Connexion pour que cette autorisation soit accordée.",
    es: "Requiere el permiso \"bits:read\" - si la app se actualizó desde una versión anterior, vuelve a iniciar sesión una vez con la cuenta principal en Conexión para que se conceda este permiso.",
    th: "ต้องการสิทธิ์ \"bits:read\" - หากอัปเดตแอปจากเวอร์ชันเก่า ให้เข้าสู่ระบบบัญชีหลักใหม่อีกครั้งที่แท็บการเชื่อมต่อเพื่อให้ได้รับสิทธิ์นี้"
  },
  "label-booster-sub-exclusive": { de: "Sub-exklusiv", en: "Sub-exclusive",
    fr: "Exclusif aux abonnés",
    es: "Exclusivo para suscriptores",
    th: "เฉพาะผู้สมัครสมาชิก"
  },
  "booster-sub-exclusive-hint": {
    de: "Karten aus diesem Booster gibt es nur über Sub-Ereignisse (neuer Sub, Resub, Sub verschenkt) – nicht über Kanalpunkte oder den Chat-Befehl \"!pack\".",
    en: "Cards from this booster are only awarded via sub events (new sub, resub, gifted sub) - not through channel points or the \"!pack\" chat command.",
    fr: "Les cartes de ce booster ne sont attribuées que via des événements d'abonnement (nouvel abonnement, réabonnement, abonnement offert) - pas via les points de chaîne ou la commande de chat \"!pack\".",
    es: "Las cartas de este booster solo se otorgan mediante eventos de suscripción (nueva suscripción, resuscripción, suscripción regalada) - no mediante puntos de canal o el comando de chat \"!pack\".",
    th: "การ์ดจากบูสเตอร์นี้จะได้รับเฉพาะผ่านเหตุการณ์การสมัครสมาชิก (สมัครใหม่ ต่ออายุ หรือได้รับเป็นของขวัญ) เท่านั้น - ไม่ใช่ผ่านแชนแนลพอยท์หรือคำสั่งแชท \"!pack\""
  },
  "pity-hint": {
    de: "Garantiert jedem Viewer nach X erfolglosen Ziehungen in Folge (egal ob per Kanalpunkte oder Chat-Befehl) mindestens die gewählte Seltenheit – ändert nichts an der normalen Gewichtung, greift nur als Untergrenze.",
    en: "Guarantees every viewer at least the chosen rarity after X unsuccessful draws in a row (regardless of channel points or chat command) - doesn't change the normal weighting, only acts as a floor.",
    fr: "Garantit à chaque spectateur au moins la rareté choisie après X tirages infructueux d'affilée (que ce soit via les points de chaîne ou une commande de chat) - ne change pas la pondération normale, agit seulement comme un plancher.",
    es: "Garantiza a cada espectador al menos la rareza elegida tras X tiradas fallidas seguidas (ya sea por puntos de canal o comando de chat) - no cambia la ponderación normal, solo actúa como un mínimo garantizado.",
    th: "รับประกันให้ผู้ชมทุกคนได้อย่างน้อยระดับความหายากที่เลือกหลังจากสุ่มไม่สำเร็จติดต่อกัน X ครั้ง (ไม่ว่าจะผ่านแชนแนลพอยท์หรือคำสั่งแชท) - ไม่เปลี่ยนน้ำหนักปกติ เป็นเพียงขั้นต่ำที่รับประกัน"
  },
  "label-pity-enabled": { de: "Garantie-System aktiviert", en: "Pity system enabled",
    fr: "Système de pitié activé",
    es: "Sistema de compensación activado",
    th: "เปิดใช้งานระบบการันตี"
  },
  "label-pity-threshold": { de: "Ziehungen bis Garantie", en: "Draws until guarantee",
    fr: "Tirages avant garantie",
    es: "Tiradas hasta la garantía",
    th: "จำนวนครั้งจนถึงการันตี"
  },
  "label-pity-min-rarity": { de: "Garantierte Mindest-Seltenheit", en: "Guaranteed minimum rarity",
    fr: "Rareté minimale garantie",
    es: "Rareza mínima garantizada",
    th: "ระดับความหายากขั้นต่ำที่การันตี"
  },
  "pity-dust-hint": {
    de: "Punkte, die eine vernichtete Karte je nach Seltenheit für den \"!dust\"-Befehl (Chat Befehle) einbringt.",
    en: "Points a sacrificed card grants depending on rarity for the \"!dust\" command (Chat commands).",
    fr: "Points qu'une carte sacrifiée rapporte selon sa rareté pour la commande « !dust » (Commandes de chat).",
    es: "Puntos que otorga una carta sacrificada según su rareza para el comando \"!dust\" (Comandos de chat).",
    th: "แต้มที่การ์ดที่สังเวยจะได้ตามระดับความหายากสำหรับคำสั่ง \"!dust\" (คำสั่งแชท)"
  },
  "label-pity-streak": { de: "Garantie:", en: "Pity:",
    fr: "Pitié :",
    es: "Compensación:",
    th: "การันตี:"
  },
  "label-pity-bank": { de: "Guthaben:", en: "Bank:",
    fr: "Solde :",
    es: "Saldo:",
    th: "เครดิต:"
  },
  "hint-pity-info": {
    de: "Ziehungen bis zur garantierten Seltenheit / gebanktes Guthaben aus !dust",
    en: "Draws until guaranteed rarity / banked credit from !dust",
    fr: "Tirages avant la rareté garantie / crédit banqué via !dust",
    es: "Tiradas hasta la rareza garantizada / crédito acumulado por !dust",
    th: "จำนวนครั้งจนถึงการันตี / เครดิตที่สะสมจาก !dust"
  },
  "label-bits-banked": { de: "Gespeicherte Bits:", en: "Banked bits:", fr: "Bits en réserve :", es: "Bits acumulados:", th: "บิตที่เก็บสะสม:" },
  "hint-bits-banked": {
    de: "Bits unter der Schwelle für die nächste Kartenziehung, gespeichert bis zum nächsten Cheer",
    en: "Bits below the threshold for the next card draw, banked until the next cheer",
    fr: "Bits sous le seuil du prochain tirage de carte, mis en réserve jusqu'au prochain cheer",
    es: "Bits por debajo del umbral para la próxima tirada de carta, guardados hasta el próximo cheer",
    th: "บิตที่ต่ำกว่าเกณฑ์สำหรับการจับสลากครั้งถัดไป เก็บสะสมไว้จนกว่าจะมี cheer ครั้งต่อไป"
  },
  "label-user-stats-battle": { de: "Kämpfe (S/N, gesamt):", en: "Duels (W/L, total):", fr: "Duels (V/D, total) :", es: "Duelos (V/D, total):", th: "การดวล (ชนะ/แพ้, รวม):" },
  "label-user-stats-tournament": { de: "Turniersiege:", en: "Tournament wins:", fr: "Victoires en tournoi :", es: "Victorias en torneo:", th: "ชัยชนะทัวร์นาเมนต์:" },
  "label-user-stats-teamkampf": { de: "Team-Kampf (S/N, Teiln.):", en: "Team battle (W/L, part.):", fr: "Combat d'équipe (V/D, part.) :", es: "Combate de equipo (V/D, part.):", th: "ทีมคัมภ์ (ชนะ/แพ้, เข้าร่วม):" },
  "hint-user-stats": {
    de: "Kartenduelle (Siege/Niederlagen, Gesamtzahl) · Turniersiege · Team-Kampf (Siege/Niederlagen, Teilnahmen)",
    en: "Card duels (wins/losses, total) · tournament wins · team battle (wins/losses, participations)",
    fr: "Duels de cartes (victoires/défaites, total) · victoires en tournoi · combat d'équipe (victoires/défaites, participations)",
    es: "Duelos de cartas (victorias/derrotas, total) · victorias en torneo · combate de equipo (victorias/derrotas, participaciones)",
    th: "การดวลการ์ด (ชนะ/แพ้, รวม) · ชัยชนะทัวร์นาเมนต์ · ทีมคัมภ์ (ชนะ/แพ้, เข้าร่วม)"
  },
  "communitygoal-eyebrow": { de: "Community", en: "Community",
    fr: "Communauté",
    es: "Comunidad",
    th: "ชุมชน"
  },
  "communitygoal-title": { de: "Community-Ziel", en: "Community goal",
    fr: "Objectif communautaire",
    es: "Meta comunitaria",
    th: "เป้าหมายชุมชน"
  },
  "communitygoal-hint": {
    de: "Ein gemeinsamer Fortschrittsbalken über alle Zuschauer hinweg – jede Ziehung (egal ob per Kanalpunkte oder Chat-Befehl) zählt +1. Wird das Ziel erreicht, postet der Bot eine Feier-Nachricht im Chat, die OBS-Quelle zeigt eine Feier-Animation, und jeder, der mitgezogen hat, bekommt automatisch einen Bonus-Booster.",
    en: "A shared progress bar across every viewer - each draw (channel points or chat command) counts +1. Once the goal is reached, the bot posts a celebration message in chat, the OBS source plays a celebration animation, and everyone who participated automatically gets a bonus booster.",
    fr: "Une barre de progression partagée entre tous les spectateurs - chaque tirage (points de chaîne ou commande de chat) compte +1. Une fois l'objectif atteint, le bot publie un message de célébration dans le chat, la source OBS joue une animation de célébration, et tous les participants reçoivent automatiquement un booster bonus.",
    es: "Una barra de progreso compartida entre todos los espectadores - cada tirada (puntos de canal o comando de chat) cuenta +1. Al alcanzar la meta, el bot publica un mensaje de celebración en el chat, la fuente de OBS reproduce una animación de celebración, y todos los participantes reciben automáticamente un sobre extra.",
    th: "แถบความคืบหน้าที่ใช้ร่วมกันของผู้ชมทุกคน - แต่ละครั้งที่สุ่ม (แชนแนลพอยท์หรือคำสั่งแชท) นับ +1 เมื่อบรรลุเป้าหมาย บอทจะโพสต์ข้อความฉลองในแชท ซอร์ส OBS จะเล่นแอนิเมชันฉลอง และทุกคนที่เข้าร่วมจะได้รับบูสเตอร์โบนัสอัตโนมัติ"
  },
  "label-communitygoal-enabled": { de: "Community-Ziel aktiviert", en: "Community goal enabled",
    fr: "Objectif communautaire activé",
    es: "Meta comunitaria activada",
    th: "เปิดใช้งานเป้าหมายชุมชน"
  },
  "label-communitygoal-target": { de: "Ziel (Anzahl Ziehungen)", en: "Goal (number of draws)",
    fr: "Objectif (nombre de tirages)",
    es: "Meta (número de tiradas)",
    th: "เป้าหมาย (จำนวนครั้ง)"
  },
  "label-communitygoal-message": { de: "Feier-Nachricht im Chat", en: "Celebration message in chat",
    fr: "Message de célébration dans le chat",
    es: "Mensaje de celebración en el chat",
    th: "ข้อความฉลองในแชท"
  },
  "btn-communitygoal-reset": { de: "Fortschritt zurücksetzen", en: "Reset progress",
    fr: "Réinitialiser la progression",
    es: "Reiniciar progreso",
    th: "รีเซ็ตความคืบหน้า"
  },
  "confirm-communitygoal-reset": { de: "Fortschritt wirklich auf 0 zurücksetzen?", en: "Really reset progress to 0?",
    fr: "Vraiment réinitialiser la progression à 0 ?",
    es: "¿Reiniciar de verdad el progreso a 0?",
    th: "ต้องการรีเซ็ตความคืบหน้าเป็น 0 จริงหรือไม่?"
  },
  "notice-communitygoal-reset": { de: "Community-Ziel zurückgesetzt.", en: "Community goal reset.",
    fr: "Objectif communautaire réinitialisé.",
    es: "Meta comunitaria reiniciada.",
    th: "รีเซ็ตเป้าหมายชุมชนแล้ว"
  },
  "label-communitygoal-reached": { de: "Ziel erreicht!", en: "Goal reached!",
    fr: "Objectif atteint !",
    es: "¡Meta alcanzada!",
    th: "บรรลุเป้าหมายแล้ว!"
  },
  "tournament-eyebrow": { de: "Kämpfe", en: "Battles", fr: "Combats", es: "Combates", th: "การดวล" },
  "tournament-title": { de: "Turnier-Modus", en: "Tournament mode", fr: "Mode tournoi", es: "Modo torneo", th: "โหมดทัวร์นาเมนต์" },
  "tournament-hint": {
    de: "Ein Ausscheidungsturnier für Kartenduelle. Zuschauer treten während einer Anmeldephase per Chat-Befehl bei (Befehl unter Chat-Befehle einstellbar); danach werden alle Runden automatisch nacheinander über die normale Kampf-Animation ausgetragen - ohne Risiko für die eigenen Karten. Der Turniersieger bekommt stattdessen eine konfigurierbare Anzahl Kartenpack-Ziehungen. Startbar per Kanalpunkte-Belohnung (unter Kanalpunkte), per Chat-Befehl oder per Knopf hier.",
    en: "A single-elimination tournament for card duels. Viewers join during a signup window via a chat command (configurable under Chat Commands); afterwards every round plays out automatically through the normal battle animation - no risk to anyone's cards. The champion instead gets a configurable number of pack draws. Can be started via a channel-point reward (under Channel Points), a chat command, or the button here.",
    fr: "Un tournoi à élimination directe pour des duels de cartes. Les spectateurs rejoignent pendant une phase d'inscription via une commande de chat (configurable sous Commandes de chat) ; ensuite, chaque tour se déroule automatiquement via l'animation de combat normale - sans risque pour les cartes de quiconque. Le champion reçoit à la place un nombre configurable de tirages de booster. Peut être démarré via une récompense de points de chaîne (sous Points de chaîne), une commande de chat, ou le bouton ci-dessous.",
    es: "Un torneo de eliminación directa para duelos de cartas. Los espectadores se unen durante una ventana de inscripción con un comando de chat (configurable en Comandos de chat); después, cada ronda se desarrolla automáticamente mediante la animación de combate normal, sin riesgo para las cartas de nadie. El campeón recibe en su lugar un número configurable de tiradas de sobre. Se puede iniciar mediante una recompensa de puntos de canal (en Puntos de canal), un comando de chat o el botón de aquí.",
    th: "ทัวร์นาเมนต์แบบแพ้คัดออกสำหรับการดวลการ์ด ผู้ชมเข้าร่วมระหว่างช่วงสมัครด้วยคำสั่งแชท (ตั้งค่าได้ที่คำสั่งแชท) จากนั้นทุกรอบจะเล่นอัตโนมัติผ่านแอนิเมชันการดวลปกติ - ไม่มีความเสี่ยงต่อการ์ดของใคร แชมป์จะได้รับจำนวนการจับสลากแพ็กที่ตั้งค่าได้แทน เริ่มได้ผ่านรางวัลแชนแนลพอยท์ (ที่แชนแนลพอยท์) คำสั่งแชท หรือปุ่มด้านล่างนี้"
  },
  "tournament-layout-hint": {
    de: "Der Turnierbaum wird in derselben OBS-Quelle wie die Kampf-Animation angezeigt – diese Position/Skalierung gilt für beide gemeinsam.",
    en: "The tournament bracket is shown in the same OBS source as the battle animation - this position/scale applies to both.",
    fr: "L'arbre du tournoi s'affiche dans la même source OBS que l'animation de combat - cette position/échelle s'applique aux deux.",
    es: "El cuadro del torneo se muestra en la misma fuente de OBS que la animación de combate; esta posición/escala se aplica a ambas.",
    th: "สายการแข่งขันจะแสดงในแหล่ง OBS เดียวกับแอนิเมชันการดวล - ตำแหน่ง/ขนาดนี้ใช้ร่วมกันทั้งสองอย่าง"
  },
  "liveticker-eyebrow": { de: "Community", en: "Community", fr: "Communauté", es: "Comunidad", th: "คอมมูนิตี้" },
  "liveticker-title": { de: "Live-Ticker", en: "Live ticker", fr: "Fil d'actualité en direct", es: "Ticker en vivo", th: "ตัวแสดงผลสด" },
  "liveticker-hint": {
    de: "Ein durchlaufendes Laufschrift-Banner (wie ein Newsticker), das die letzten Ziehungen aller Zuschauer in einer Endlosschleife von rechts nach links zeigt – unabhängig von der Kartenpack-Animation, läuft also nicht gedrosselt durch deren Warteschlange.",
    en: "A scrolling news-ticker banner that loops the most recent draws from all viewers from right to left - independent of the pack animation, so it isn't throttled by its queue.",
    fr: "Un bandeau défilant façon ticker d'actualités qui fait défiler en boucle les derniers tirages de tous les spectateurs de droite à gauche - indépendant de l'animation du booster, donc non ralenti par sa file d'attente.",
    es: "Un banner de noticias desplazable que muestra en bucle las tiradas más recientes de todos los espectadores de derecha a izquierda - independiente de la animación del sobre, por lo que no se ralentiza por su cola.",
    th: "แบนเนอร์ข่าววิ่งที่วนลูปการจับสลากล่าสุดของผู้ชมทุกคนจากขวาไปซ้าย - ไม่ขึ้นกับแอนิเมชันแพ็ก จึงไม่ถูกจำกัดด้วยคิวของมัน"
  },
  "label-liveticker-enabled": { de: "Live-Ticker aktiviert", en: "Live ticker enabled", fr: "Fil d'actualité en direct activé", es: "Ticker en vivo activado", th: "เปิดใช้งานตัวแสดงผลสด" },
  "label-liveticker-max-entries": { de: "Einträge im Umlauf", en: "Entries in rotation", fr: "Entrées en rotation", es: "Entradas en rotación", th: "รายการที่หมุนเวียน" },
  "label-liveticker-speed": { de: "Geschwindigkeit (Px/Sek.)", en: "Speed (px/sec.)", fr: "Vitesse (px/sec.)", es: "Velocidad (px/seg.)", th: "ความเร็ว (พิกเซล/วิ)" },
  "liveticker-group-messages": { de: "Texte", en: "Texts", fr: "Textes", es: "Textos", th: "ข้อความ" },
  "label-liveticker-draw-message": { de: "Text bei Kartenziehung", en: "Text on card draw", fr: "Texte lors du tirage d'une carte", es: "Texto al sacar una carta", th: "ข้อความเมื่อจับการ์ด" },
  "label-liveticker-battle-message": { de: "Text bei Kartenduell", en: "Text on card duel", fr: "Texte lors d'un duel de cartes", es: "Texto en duelo de cartas", th: "ข้อความเมื่อดวลการ์ด" },
  "label-liveticker-tournament-message": { de: "Text bei Turniersieg", en: "Text on tournament win", fr: "Texte lors d'une victoire au tournoi", es: "Texto al ganar el torneo", th: "ข้อความเมื่อชนะทัวร์นาเมนต์" },
  "label-liveticker-teambattle-message": { de: "Text bei Team-Kampf-Ergebnis", en: "Text on team battle result", fr: "Texte lors du résultat du combat d'équipe", es: "Texto en resultado de combate de equipo", th: "ข้อความเมื่อผลการต่อสู้ทีม" },
  "label-tournament-enabled": { de: "Turnier-Modus aktiviert", en: "Tournament mode enabled", fr: "Mode tournoi activé", es: "Modo torneo activado", th: "เปิดใช้งานโหมดทัวร์นาเมนต์" },
  "label-tournament-min-participants": { de: "Mindestteilnehmer", en: "Minimum participants", fr: "Participants minimum", es: "Participantes mínimos", th: "ผู้เข้าร่วมขั้นต่ำ" },
  "label-tournament-signup-seconds": { de: "Anmeldezeit (Sek.)", en: "Signup time (sec.)", fr: "Temps d'inscription (sec.)", es: "Tiempo de inscripción (seg.)", th: "เวลาสมัคร (วินาที)" },
  "label-tournament-lineup-size": { de: "Kartenanzahl pro Duell", en: "Cards per duel", fr: "Cartes par duel", es: "Cartas por duelo", th: "จำนวนการ์ดต่อการดวล" },
  "label-tournament-winner-draws": { de: "Ziehungen für den Sieger", en: "Draws for the champion", fr: "Tirages pour le champion", es: "Tiradas para el campeón", th: "จำนวนการจับสลากสำหรับแชมป์" },
  "label-tournament-announce-joins": { de: "Beitritte im Chat ankündigen", en: "Announce joins in chat", fr: "Annoncer les inscriptions dans le chat", es: "Anunciar inscripciones en el chat", th: "ประกาศการเข้าร่วมในแชท" },
  "label-tournament-perround-enabled": { de: "Jeder Rundensieger zieht sofort eine Karte", en: "Every round's winner draws a card immediately", fr: "Le vainqueur de chaque manche tire une carte immédiatement", es: "El ganador de cada ronda saca una carta de inmediato", th: "ผู้ชนะแต่ละรอบจับการ์ดทันที" },
  "label-tournament-champion-draws-enabled": { de: "Turniersieger erhält zusätzliche Ziehungen (siehe oben)", en: "Champion gets extra draws (see above)", fr: "Le champion reçoit des tirages supplémentaires (voir ci-dessus)", es: "El campeón recibe tiradas adicionales (ver arriba)", th: "แชมป์ได้รับการจับสลากเพิ่มเติม (ดูด้านบน)" },
  "btn-tournament-start-now": { de: "Turnier jetzt starten", en: "Start tournament now", fr: "Démarrer le tournoi maintenant", es: "Iniciar torneo ahora", th: "เริ่มทัวร์นาเมนต์ตอนนี้" },
  "label-tournament-state-idle": { de: "Kein Turnier aktiv", en: "No tournament active", fr: "Aucun tournoi actif", es: "Ningún torneo activo", th: "ไม่มีทัวร์นาเมนต์ที่ใช้งานอยู่" },
  "label-tournament-state-signup": { de: "Anmeldephase läuft", en: "Signup in progress", fr: "Inscription en cours", es: "Inscripción en curso", th: "กำลังรับสมัคร" },
  "label-tournament-state-running": { de: "Turnier läuft", en: "Tournament running", fr: "Tournoi en cours", es: "Torneo en curso", th: "ทัวร์นาเมนต์กำลังดำเนินอยู่" },
  "ranking-anim-eyebrow": { de: "Ranking", en: "Ranking", fr: "Classement", es: "Clasificación", th: "การจัดอันดับ" },
  "ranking-anim-title": { de: "Ranking-Anzeige", en: "Ranking display", fr: "Affichage du classement", es: "Visualización de clasificación", th: "การแสดงการจัดอันดับ" },
  "pack-anim-eyebrow": { de: "Kartenpack", en: "Card pack", fr: "Booster de cartes", es: "Sobre de cartas", th: "แพ็กการ์ด" },
  "pack-anim-title": { de: "Pack-Animation", en: "Pack animation", fr: "Animation du booster", es: "Animación del sobre", th: "แอนิเมชันแพ็ก" },
  "ranking-anim-hint": { de: "Position und Größe der Ranking-Anzeige (ranking.html) im Overlay-Bild.", en: "Position and size of the ranking display (ranking.html) in the overlay image.", fr: "Position et taille de l'affichage du classement (ranking.html) dans l'image de superposition.", es: "Posición y tamaño de la visualización de clasificación (ranking.html) en la imagen de superposición.", th: "ตำแหน่งและขนาดของการแสดงการจัดอันดับ (ranking.html) ในภาพโอเวอร์เลย์" },
  "label-oly-top": { de: "Abstand oben", en: "Top margin", fr: "Marge supérieure", es: "Margen superior", th: "ระยะขอบบน" },
  "label-oly-right": { de: "Abstand rechts", en: "Right margin", fr: "Marge droite", es: "Margen derecho", th: "ระยะขอบขวา" },
  "label-oly-bottom": { de: "Abstand unten", en: "Bottom margin", fr: "Marge inférieure", es: "Margen inferior", th: "ระยะขอบล่าง" },
  "label-oly-left": { de: "Abstand links", en: "Left margin", fr: "Marge gauche", es: "Margen izquierdo", th: "ระยะขอบซ้าย" },
  "label-oly-scale": { de: "Skalierung", en: "Scale", fr: "Échelle", es: "Escala", th: "ขนาด" },
  "btn-oly-center": { de: "Zentrieren", en: "Center", fr: "Centrer", es: "Centrar", th: "จัดกึ่งกลาง" },
  "hint-oly-drag": { de: "Roten Punkt in der Vorschau ziehen, um die Position zu setzen (Basis: 1920×1080).", en: "Drag the red dot in the preview to set the position (based on 1920×1080).", fr: "Faites glisser le point rouge dans l'aperçu pour définir la position (base : 1920×1080).", es: "Arrastra el punto rojo en la vista previa para establecer la posición (base: 1920×1080).", th: "ลากจุดสีแดงในตัวอย่างเพื่อกำหนดตำแหน่ง (พื้นฐาน: 1920×1080)" },
  "label-tournament-participants": { de: "Teilnehmer", en: "participants", fr: "participants", es: "participantes", th: "ผู้เข้าร่วม" },
  "notice-tournament-started": { de: "Turnier-Anmeldung gestartet.", en: "Tournament signup started.", fr: "Inscription au tournoi démarrée.", es: "Inscripción al torneo iniciada.", th: "เริ่มการสมัครทัวร์นาเมนต์แล้ว" },
  "notice-tournament-already-running": { de: "Es läuft bereits ein Turnier oder eine Anmeldephase.", en: "A tournament or signup phase is already running.", fr: "Un tournoi ou une phase d'inscription est déjà en cours.", es: "Ya hay un torneo o una fase de inscripción en curso.", th: "มีทัวร์นาเมนต์หรือช่วงสมัครที่กำลังดำเนินอยู่แล้ว" },
  "notice-tournament-disabled": { de: "Turnier-Modus ist nicht aktiviert.", en: "Tournament mode is not enabled.", fr: "Le mode tournoi n'est pas activé.", es: "El modo torneo no está activado.", th: "โหมดทัวร์นาเมนต์ไม่ได้เปิดใช้งาน" },
  "tournament-reward-eyebrow": { de: "Turnier", en: "Tournament", fr: "Tournoi", es: "Torneo", th: "ทัวร์นาเมนต์" },
  "tournament-reward-title": { de: "Turnier-Belohnung", en: "Tournament reward", fr: "Récompense de tournoi", es: "Recompensa de torneo", th: "รางวัลทัวร์นาเมนต์" },
  "tournament-reward-info-text": {
    de: "Löst ein Zuschauer diese Belohnung ein, startet die Turnier-Anmeldephase (siehe Einstellungen → Turnier-Modus für Regeln wie Mindestteilnehmerzahl und Anmeldezeit).",
    en: "When a viewer redeems this reward, it starts the tournament signup phase (see Settings → Tournament mode for rules like minimum participants and signup time).",
    fr: "Lorsqu'un spectateur échange cette récompense, cela démarre la phase d'inscription au tournoi (voir Paramètres → Mode tournoi pour les règles comme le nombre minimum de participants et le temps d'inscription).",
    es: "Cuando un espectador canjea esta recompensa, se inicia la fase de inscripción del torneo (ver Configuración → Modo torneo para reglas como participantes mínimos y tiempo de inscripción).",
    th: "เมื่อผู้ชมแลกรางวัลนี้ จะเริ่มช่วงสมัครทัวร์นาเมนต์ (ดูการตั้งค่า → โหมดทัวร์นาเมนต์สำหรับกฎ เช่น จำนวนผู้เข้าร่วมขั้นต่ำและเวลาสมัคร)"
  },
  "cc-tournamentjoin-eyebrow": { de: "Turnier", en: "Tournament", fr: "Tournoi", es: "Torneo", th: "ทัวร์นาเมนต์" },
  "cc-tournamentjoin-title": { de: "Turnier-Beitritt", en: "Tournament join", fr: "Inscription au tournoi", es: "Unirse al torneo", th: "เข้าร่วมทัวร์นาเมนต์" },
  "cc-tournamentjoin-hint": {
    de: "Mit diesem Befehl treten Zuschauer während einer laufenden Anmeldephase dem Turnier bei. Wer nicht genug verschiedene Karten besitzt (siehe Einstellungen → Turnier-Modus), bekommt eine Hinweis-Nachricht statt beizutreten.",
    en: "Viewers use this command to join the tournament during an active signup phase. Anyone without enough different cards (see Settings → Tournament mode) gets a notice message instead of joining.",
    fr: "Les spectateurs utilisent cette commande pour rejoindre le tournoi pendant une phase d'inscription active. Quiconque n'a pas assez de cartes différentes (voir Paramètres → Mode tournoi) reçoit un message au lieu de rejoindre.",
    es: "Los espectadores usan este comando para unirse al torneo durante una fase de inscripción activa. Quien no tenga suficientes cartas diferentes (ver Configuración → Modo torneo) recibe un mensaje en vez de unirse.",
    th: "ผู้ชมใช้คำสั่งนี้เพื่อเข้าร่วมทัวร์นาเมนต์ระหว่างช่วงสมัครที่ใช้งานอยู่ ผู้ที่มีการ์ดต่างกันไม่พอ (ดูการตั้งค่า → โหมดทัวร์นาเมนต์) จะได้รับข้อความแจ้งเตือนแทนการเข้าร่วม"
  },
  "cc-teamkampfjoin-eyebrow": { de: "Team-Kampf", en: "Team battle", fr: "Combat d'équipe", es: "Combate de equipo", th: "การต่อสู้ทีม" },
  "cc-teamkampfjoin-title": { de: "Team-Kampf-Beitritt", en: "Team battle join", fr: "Rejoindre le combat d'équipe", es: "Unirse al combate de equipo", th: "เข้าร่วมการต่อสู้ทีม" },
  "cc-teamkampfjoin-hint": {
    de: "Mit diesem Befehl treten Zuschauer während der Anmeldezeit eines laufenden Team-Kampfes bei. Jeder Teilnehmer bekommt automatisch eine zufällige Karte aus der eigenen Sammlung zugeteilt (siehe Einstellungen → Team-Kampf).",
    en: "Viewers use this command to join an active team battle during its signup window. Each participant is automatically assigned a random card from their own collection (see Settings → Team battle).",
    fr: "Les spectateurs utilisent cette commande pour rejoindre un combat d'équipe actif pendant sa fenêtre d'inscription. Chaque participant reçoit automatiquement une carte aléatoire de sa propre collection (voir Paramètres → Combat d'équipe).",
    es: "Los espectadores usan este comando para unirse a un combate de equipo activo durante su ventana de inscripción. Cada participante recibe automáticamente una carta aleatoria de su propia colección (ver Configuración → Combate de equipo).",
    th: "ผู้ชมใช้คำสั่งนี้เพื่อเข้าร่วมการต่อสู้ทีมที่กำลังดำเนินอยู่ในช่วงเวลาสมัคร ผู้เข้าร่วมแต่ละคนจะได้รับการ์ดสุ่มจากคอลเลกชันของตนเองโดยอัตโนมัติ (ดูการตั้งค่า → การต่อสู้ทีม)"
  },
  "teamkampf-eyebrow": { de: "Kämpfe", en: "Battles", fr: "Combats", es: "Combates", th: "การดวล" },
  "teamkampf-title": { de: "Team-Kampf", en: "Team battle", fr: "Combat d'équipe", es: "Combate de equipo", th: "การต่อสู้ทีม" },
  "teamkampf-hint": {
    de: "Alle gegen den Streamer: bei Einlösung der Kanalpunkte-Belohnung (unter Kanalpunkte) stellt der Streamer per Zufall ein Karten-Team zusammen (aus allen Boostern, auch Sub-exklusiven) und zeigt es im Overlay. Zuschauer treten während der Anmeldezeit per Chat-Befehl bei (unter Chat-Befehle einstellbar) - der Einlösende automatisch. Jeder Teilnehmer bekommt eine zufällige Karte aus der eigenen Sammlung. Nach Ablauf der Zeit kämpft im HP-Leisten-Duell-Stil Karte gegen Karte, in Anmeldereihenfolge - eine Karte bleibt im Kampf, bis sie besiegt ist, dann kommt die nächste (auf beiden Seiten).",
    en: "Everyone vs. the streamer: redeeming the channel-point reward (under Channel points) randomly assembles the streamer's card team (from every booster, including sub-exclusive ones) and shows it in the overlay. Viewers join during the signup window with a chat command (configurable under Chat commands) - the redeemer joins automatically. Each participant gets a random card from their own collection. Once the window closes, cards fight one another HP-Leisten-Duell style, in signup order - a card stays in the fight until defeated, then the next one steps up (on both sides).",
    fr: "Tout le monde contre le streamer : l'utilisation de la récompense de points de chaîne (sous Points de chaîne) assemble aléatoirement l'équipe de cartes du streamer (de tous les boosters, y compris les exclusifs aux abonnés) et l'affiche dans l'overlay. Les spectateurs rejoignent pendant la fenêtre d'inscription avec une commande de chat (configurable sous Commandes de chat) - la personne qui a échangé les points rejoint automatiquement. Chaque participant reçoit une carte aléatoire de sa propre collection. Une fois la fenêtre fermée, les cartes se battent les unes contre les autres façon duel à barres de vie, dans l'ordre d'inscription.",
    es: "Todos contra el streamer: canjear la recompensa de puntos de canal (en Puntos de canal) reúne aleatoriamente el equipo de cartas del streamer (de todos los sobres, incluidos los exclusivos para suscriptores) y lo muestra en el overlay. Los espectadores se unen durante la ventana de inscripción con un comando de chat (configurable en Comandos de chat) - quien canjeó se une automáticamente. Cada participante recibe una carta aleatoria de su propia colección. Al cerrarse la ventana, las cartas luchan entre sí al estilo duelo de barras de vida, en orden de inscripción.",
    th: "ทุกคนปะทะสตรีมเมอร์: การแลกรางวัลแชนแนลพอยท์ (ใต้แชนแนลพอยท์) จะสุ่มรวบรวมทีมการ์ดของสตรีมเมอร์ (จากบูสเตอร์ทั้งหมด รวมถึงแบบเฉพาะผู้สมัครสมาชิก) และแสดงในโอเวอร์เลย์ ผู้ชมเข้าร่วมระหว่างช่วงสมัครด้วยคำสั่งแชท (ตั้งค่าได้ใต้คำสั่งแชท) - ผู้แลกรางวัลจะเข้าร่วมโดยอัตโนมัติ ผู้เข้าร่วมแต่ละคนได้รับการ์ดสุ่มจากคอลเลกชันของตนเอง เมื่อหมดเวลา การ์ดจะต่อสู้กันแบบดวลแถบเลือด ตามลำดับการสมัคร"
  },
  "label-teamkampf-enabled": { de: "Team-Kampf aktiviert", en: "Team battle enabled", fr: "Combat d'équipe activé", es: "Combate de equipo activado", th: "เปิดใช้งานการต่อสู้ทีม" },
  "label-teamkampf-card-count": { de: "Mindest-Kartenanzahl Streamer-Team (tatsächliche Anzahl ist zufällig)", en: "Minimum streamer team card count (actual count is randomized)", fr: "Nombre minimum de cartes de l'équipe du streamer (le nombre réel est aléatoire)", es: "Número mínimo de cartas del equipo del streamer (el número real es aleatorio)", th: "จำนวนการ์ดขั้นต่ำของทีมสตรีมเมอร์ (จำนวนจริงเป็นแบบสุ่ม)" },
  "label-teamkampf-signup-seconds": { de: "Anmeldezeit (Sek.)", en: "Signup time (sec.)", fr: "Temps d'inscription (sec.)", es: "Tiempo de inscripción (seg.)", th: "เวลาสมัคร (วินาที)" },
  "label-teamkampf-rewards-enabled": { de: "Bei Sieg der Community bekommt jeder Teilnehmer Karten", en: "On a community win, every participant gets cards", fr: "En cas de victoire de la communauté, chaque participant reçoit des cartes", es: "Si gana la comunidad, cada participante recibe cartas", th: "เมื่อชุมชนชนะ ผู้เข้าร่วมทุกคนจะได้รับการ์ด" },
  "label-teamkampf-draws-per-participant": { de: "Ziehungen je Teilnehmer", en: "Draws per participant", fr: "Tirages par participant", es: "Tiradas por participante", th: "จำนวนการจับสลากต่อผู้เข้าร่วม" },
  "label-teamkampf-finisher-bonus-enabled": { de: "Wer die letzte Streamer-Karte besiegt, bekommt zusätzliche Ziehungen", en: "Whoever defeats the streamer's last card gets extra draws", fr: "Celui qui bat la dernière carte du streamer reçoit des tirages supplémentaires", es: "Quien derrote la última carta del streamer recibe tiradas adicionales", th: "ผู้ที่เอาชนะการ์ดใบสุดท้ายของสตรีมเมอร์จะได้รับการจับสลากเพิ่มเติม" },
  "label-teamkampf-finisher-bonus-draws": { de: "Bonus-Ziehungen für den Finisher", en: "Bonus draws for the finisher", fr: "Tirages bonus pour le finisseur", es: "Tiradas de bonificación para quien remata", th: "การจับสลากโบนัสสำหรับผู้พิชิต" },
  "label-teamkampf-lose-card-enabled": { de: "Bei Niederlage verliert jeder Teilnehmer die eingesetzte Karte", en: "On defeat, every participant loses their staked card", fr: "En cas de défaite, chaque participant perd sa carte engagée", es: "En caso de derrota, cada participante pierde la carta apostada", th: "เมื่อพ่ายแพ้ ผู้เข้าร่วมทุกคนจะเสียการ์ดที่วางเดิมพัน" },
  "label-teamkampf-lost-card-announce-enabled": { de: "Chat-Nachricht bei Kartenverlust", en: "Chat message on card loss", fr: "Message dans le chat en cas de perte de carte", es: "Mensaje en el chat al perder una carta", th: "ข้อความแชทเมื่อเสียการ์ด" },
  "label-teamkampf-lost-card-message": { de: "Nachricht bei Kartenverlust", en: "Message on card loss", fr: "Message en cas de perte de carte", es: "Mensaje al perder una carta", th: "ข้อความเมื่อเสียการ์ด" },
  "btn-teamkampf-start-now": { de: "Team-Kampf jetzt starten", en: "Start team battle now", fr: "Démarrer le combat d'équipe maintenant", es: "Iniciar combate de equipo ahora", th: "เริ่มการต่อสู้ทีมตอนนี้" },
  "teamkampf-layout-hint": {
    de: "Der Team-Kampf läuft in derselben OBS-Quelle wie die Kampf-Animation an – diese Position/Skalierung gilt für beide gemeinsam.",
    en: "The team battle plays in the same OBS source as the battle animation - that position/scale setting applies to both.",
    fr: "Le combat d'équipe se joue dans la même source OBS que l'animation de combat - ce réglage de position/échelle s'applique aux deux.",
    es: "El combate de equipo se reproduce en la misma fuente de OBS que la animación de combate - ese ajuste de posición/escala se aplica a ambos.",
    th: "การต่อสู้ทีมเล่นในซอร์ส OBS เดียวกับแอนิเมชันการต่อสู้ - การตั้งค่าตำแหน่ง/ขนาดนี้ใช้กับทั้งสองอย่าง"
  },
  "teamkampf-reward-eyebrow": { de: "Team-Kampf", en: "Team battle", fr: "Combat d'équipe", es: "Combate de equipo", th: "การต่อสู้ทีม" },
  "teamkampf-reward-title": { de: "Team-Kampf-Belohnung", en: "Team battle reward", fr: "Récompense de combat d'équipe", es: "Recompensa de combate de equipo", th: "รางวัลการต่อสู้ทีม" },
  "teamkampf-reward-info-text": {
    de: "Löst ein Zuschauer diese Belohnung ein, stellt der Streamer sein Karten-Team zusammen und die Anmeldephase beginnt (siehe Einstellungen → Team-Kampf für Regeln wie Kartenanzahl und Anmeldezeit).",
    en: "When a viewer redeems this reward, the streamer assembles their card team and the signup phase begins (see Settings → Team battle for rules like card count and signup time).",
    fr: "Lorsqu'un spectateur échange cette récompense, le streamer assemble son équipe de cartes et la phase d'inscription commence (voir Paramètres → Combat d'équipe pour des règles comme le nombre de cartes et le temps d'inscription).",
    es: "Cuando un espectador canjea esta recompensa, el streamer arma su equipo de cartas y comienza la fase de inscripción (ver Configuración → Combate de equipo para reglas como el número de cartas y el tiempo de inscripción).",
    th: "เมื่อผู้ชมแลกรางวัลนี้ สตรีมเมอร์จะรวบรวมทีมการ์ดของตนและช่วงสมัครจะเริ่มต้น (ดูการตั้งค่า → การต่อสู้ทีม สำหรับกฎ เช่น จำนวนการ์ดและเวลาสมัคร)"
  },
  "notice-teamkampf-reward-saved": { de: "Team-Kampf-Belohnung gespeichert.", en: "Team battle reward saved.", fr: "Récompense de combat d'équipe enregistrée.", es: "Recompensa de combate de equipo guardada.", th: "บันทึกรางวัลการต่อสู้ทีมแล้ว" },
  "notice-teamkampf-started": { de: "Team-Kampf-Anmeldung gestartet.", en: "Team battle signup started.", fr: "Inscription au combat d'équipe démarrée.", es: "Inscripción al combate de equipo iniciada.", th: "เริ่มการสมัครการต่อสู้ทีมแล้ว" },
  "notice-teamkampf-already-running": { de: "Es läuft bereits ein Team-Kampf.", en: "A team battle is already running.", fr: "Un combat d'équipe est déjà en cours.", es: "Ya hay un combate de equipo en curso.", th: "มีการต่อสู้ทีมที่กำลังดำเนินอยู่แล้ว" },
  "notice-teamkampf-disabled": { de: "Team-Kampf ist nicht aktiviert.", en: "Team battle is not enabled.", fr: "Le combat d'équipe n'est pas activé.", es: "El combate de equipo no está activado.", th: "การต่อสู้ทีมไม่ได้เปิดใช้งาน" },
  "notice-teamkampf-no-cards": { de: "Team-Kampf konnte nicht gestartet werden: keine Karten verfügbar.", en: "Team battle couldn't start: no cards available.", fr: "Le combat d'équipe n'a pas pu démarrer : aucune carte disponible.", es: "No se pudo iniciar el combate de equipo: no hay cartas disponibles.", th: "ไม่สามารถเริ่มการต่อสู้ทีมได้: ไม่มีการ์ดที่ใช้งานได้" },
  "cc-tournamentstart-eyebrow": { de: "Turnier", en: "Tournament", fr: "Tournoi", es: "Torneo", th: "ทัวร์นาเมนต์" },
  "cc-tournamentstart-title": { de: "Turnier-Start (Chat)", en: "Tournament start (chat)", fr: "Démarrage du tournoi (chat)", es: "Inicio de torneo (chat)", th: "เริ่มทัวร์นาเมนต์ (แชท)" },
  "cc-tournamentstart-hint": {
    de: "Optionaler Chat-Befehl, um die Turnier-Anmeldephase zu starten - zusätzlich zur Kanalpunkte-Belohnung und dem Start-Button im Admin-Panel.",
    en: "Optional chat command to start the tournament signup phase - in addition to the channel-point reward and the admin panel's start button.",
    fr: "Commande de chat optionnelle pour démarrer la phase d'inscription au tournoi - en plus de la récompense de points de chaîne et du bouton de démarrage du panneau d'administration.",
    es: "Comando de chat opcional para iniciar la fase de inscripción del torneo, además de la recompensa de puntos de canal y el botón de inicio del panel de administración.",
    th: "คำสั่งแชทเสริมสำหรับเริ่มช่วงสมัครทัวร์นาเมนต์ - นอกเหนือจากรางวัลแชนแนลพอยท์และปุ่มเริ่มในแผงผู้ดูแลระบบ"
  },
  "cc-dust-eyebrow": { de: "Garantie", en: "Pity",
    fr: "Pitié",
    es: "Compensación",
    th: "การันตี"
  },
  "cc-dust-title": { de: "Dust-Befehl", en: "Dust command",
    fr: "Commande de sacrifice",
    es: "Comando de sacrificio",
    th: "คำสั่งสังเวย"
  },
  "cc-dust-hint": {
    de: "Verwandelt doppelt besessene Karten in Garantie-Punkte: \"!dust Kartenname Anzahl\". Wie viele Punkte eine Karte je nach Seltenheit bringt, legst du unter Einstellungen → Garantie-System fest. Mindestens 1 Exemplar bleibt dem Viewer immer erhalten.",
    en: "Converts duplicate cards into pity points: \"!dust card name count\". How many points a card grants depending on rarity is set under Settings → Pity system. The viewer always keeps at least 1 copy.",
    fr: "Convertit les cartes en double en points de pitié : « !dust nom de la carte nombre ». Le nombre de points accordés par rareté se règle sous Paramètres → Système de pitié. Le spectateur garde toujours au moins 1 exemplaire.",
    es: "Convierte cartas duplicadas en puntos de compensación: \"!dust nombre de la carta cantidad\". Cuántos puntos otorga una carta según la rareza se define en Ajustes → Sistema de compensación. El espectador siempre conserva al menos 1 copia.",
    th: "แปลงการ์ดที่ซ้ำเป็นแต้มการันตี: \"!dust ชื่อการ์ด จำนวน\" กำหนดแต้มตามระดับความหายากได้ที่การตั้งค่า → ระบบการันตี ผู้ชมจะเหลือการ์ดอย่างน้อย 1 ใบเสมอ"
  },
  "label-cc-dust-usage": { de: "Nachricht bei falscher Nutzung", en: "Message on incorrect usage",
    fr: "Message en cas d'utilisation incorrecte",
    es: "Mensaje por uso incorrecto",
    th: "ข้อความเมื่อใช้งานผิดวิธี"
  },
  "label-cc-dust-notfound": { de: "Nachricht bei unbekannter Karte", en: "Message on unknown card",
    fr: "Message pour carte inconnue",
    es: "Mensaje por carta desconocida",
    th: "ข้อความเมื่อไม่พบการ์ด"
  },
  "label-cc-dust-notenough": { de: "Nachricht bei zu wenig Duplikaten", en: "Message on not enough duplicates",
    fr: "Message si pas assez de doublons",
    es: "Mensaje por duplicados insuficientes",
    th: "ข้อความเมื่อการ์ดซ้ำไม่พอ"
  },
  "label-cc-dust-success": { de: "Nachricht bei Erfolg", en: "Message on success",
    fr: "Message de réussite",
    es: "Mensaje de éxito",
    th: "ข้อความเมื่อสำเร็จ"
  },
  "btn-reset-rarity-weights": { de: "Auf Standard zurücksetzen", en: "Reset to defaults",
    fr: "Réinitialiser",
    es: "Restablecer valores predeterminados",
    th: "รีเซ็ตเป็นค่าเริ่มต้น"
  },
  "notice-rarity-weights-reset": { de: "Gewichtung zurückgesetzt.", en: "Weights reset.",
    fr: "Poids réinitialisés.",
    es: "Pesos restablecidos.",
    th: "รีเซ็ตน้ำหนักแล้ว"
  },
  "booster-eyebrow": { de: "Packs", en: "Packs",
    fr: "Packs",
    es: "Sobres",
    th: "แพ็ก"
  },
  "booster-title": { de: "Booster verwalten", en: "Manage boosters",
    fr: "Gérer les boosters",
    es: "Gestionar sobres",
    th: "จัดการบูสเตอร์"
  },
  "btn-add-booster": { de: "Booster hinzufügen", en: "Add booster",
    fr: "Ajouter un booster",
    es: "Añadir sobre",
    th: "เพิ่มบูสเตอร์"
  },
  "booster-pack-eyebrow": { de: "Pack", en: "Pack",
    fr: "Pack",
    es: "Sobre",
    th: "แพ็ก"
  },
  "booster-design-title": { de: "Booster gestalten", en: "Design booster",
    fr: "Concevoir le booster",
    es: "Diseñar sobre",
    th: "ออกแบบบูสเตอร์"
  },
  "label-booster-enabled": { de: "Booster aktiv", en: "Booster active",
    fr: "Booster actif",
    es: "Sobre activo",
    th: "บูสเตอร์ใช้งานอยู่"
  },
  "label-booster-disabled-tag": { de: "deaktiviert", en: "disabled",
    fr: "désactivé",
    es: "desactivado",
    th: "ปิดใช้งาน"
  },
  "label-booster-title": { de: "Titel", en: "Title",
    fr: "Titre",
    es: "Título",
    th: "ชื่อ"
  },
  "label-booster-subtitle": { de: "Untertitel", en: "Subtitle",
    fr: "Sous-titre",
    es: "Subtítulo",
    th: "คำบรรยาย"
  },
  "label-booster-score": { de: "Booster-Score", en: "Booster score",
    fr: "Score du booster",
    es: "Puntuación del sobre",
    th: "คะแนนบูสเตอร์"
  },
  "label-booster-accent": { de: "Akzentfarbe", en: "Accent color",
    fr: "Couleur d'accent",
    es: "Color de acento",
    th: "สีเน้น"
  },
  "label-booster-image": { de: "Booster-Bild", en: "Booster image",
    fr: "Image du booster",
    es: "Imagen del sobre",
    th: "รูปภาพบูสเตอร์"
  },
  "btn-remove-booster-image": { de: "Booster-Bild entfernen", en: "Remove booster image",
    fr: "Supprimer l'image du booster",
    es: "Eliminar imagen del sobre",
    th: "ลบรูปภาพบูสเตอร์"
  },
  "btn-delete-booster": { de: "Booster löschen", en: "Delete booster",
    fr: "Supprimer le booster",
    es: "Eliminar sobre",
    th: "ลบบูสเตอร์"
  },
  "confirm-delete-booster": {
    de: "Booster wirklich löschen? Zugewiesene Karten werden frei für andere Booster.",
    en: "Really delete this booster? Assigned cards become available for other boosters again.",
    fr: "Vraiment supprimer ce booster ? Les cartes assignées redeviennent disponibles pour d'autres boosters.",
    es: "¿Eliminar realmente este sobre? Las cartas asignadas vuelven a estar disponibles para otros sobres.",
    th: "ต้องการลบบูสเตอร์นี้จริงหรือไม่? การ์ดที่กำหนดไว้จะกลับมาใช้ได้กับบูสเตอร์อื่น"
  },
  "error-delete-last-booster": { de: "Der letzte Booster kann nicht gelöscht werden.", en: "The last booster can't be deleted.",
    fr: "Le dernier booster ne peut pas être supprimé.",
    es: "No se puede eliminar el último sobre.",
    th: "ไม่สามารถลบบูสเตอร์สุดท้ายได้"
  },
  "notice-booster-deleted": { de: "Booster gelöscht.", en: "Booster deleted.",
    fr: "Booster supprimé.",
    es: "Sobre eliminado.",
    th: "ลบบูสเตอร์แล้ว"
  },
  "label-assigned-cards": { de: "Zugewiesene Karten", en: "Assigned cards",
    fr: "Cartes assignées",
    es: "Cartas asignadas",
    th: "การ์ดที่กำหนดไว้"
  },
  "warn-max-cards": { de: `Maximal ${MAX_BOOSTER_CARDS} Karten pro Booster.`, en: `Maximum ${MAX_BOOSTER_CARDS} cards per booster.`,
    fr: "Maximum 100 cartes par booster.",
    es: "Máximo 100 cartas por sobre.",
    th: "สูงสุด 100 การ์ดต่อบูสเตอร์"
  },
  "twitch-title": { de: "Verbindung", en: "Connection",
    fr: "Connexion",
    es: "Conexión",
    th: "การเชื่อมต่อ"
  },
  "status-not-connected": { de: "Nicht verbunden", en: "Not connected",
    fr: "Non connecté",
    es: "No conectado",
    th: "ยังไม่เชื่อมต่อ"
  },
  "status-connected-as": { de: "Verbunden als", en: "Connected as",
    fr: "Connecté en tant que",
    es: "Conectado como",
    th: "เชื่อมต่อในชื่อ"
  },
  "status-error": { de: "Statusfehler:", en: "Status error:",
    fr: "Erreur de statut :",
    es: "Error de estado:",
    th: "ข้อผิดพลาดสถานะ:"
  },
  "error-missing-client-id": { de: "Bitte Twitch App Client-ID eintragen.", en: "Please enter a Twitch app client ID.",
    fr: "Merci de saisir un ID client d'application Twitch.",
    es: "Introduce un ID de cliente de la app de Twitch.",
    th: "กรุณากรอก Client ID ของแอป Twitch"
  },
  "status-login-opened": {
    de: "Twitch-Anmeldung im Browser geöffnet. Nach der Freigabe hier Status prüfen.",
    en: "Twitch sign-in opened in your browser. Check the status here once you've approved it.",
    fr: "La connexion Twitch s'est ouverte dans ton navigateur. Vérifie le statut ici une fois approuvée.",
    es: "El inicio de sesión de Twitch se abrió en tu navegador. Comprueba el estado aquí una vez aprobado.",
    th: "เปิดหน้าล็อกอิน Twitch ในเบราว์เซอร์แล้ว ตรวจสอบสถานะที่นี่หลังจากอนุมัติ"
  },
  "error-login-failed": { de: "Twitch Login konnte nicht gestartet werden:", en: "Could not start Twitch sign-in:",
    fr: "Impossible de démarrer la connexion Twitch :",
    es: "No se pudo iniciar el inicio de sesión de Twitch:",
    th: "ไม่สามารถเริ่มการล็อกอิน Twitch ได้:"
  },
  "notice-twitch-connected": { de: "Twitch verbunden.", en: "Twitch connected.",
    fr: "Twitch connecté.",
    es: "Twitch conectado.",
    th: "เชื่อมต่อ Twitch แล้ว"
  },
  "notice-twitch-disconnected": {
    de: "Twitch abgemeldet. Das lokale OAuth-Token wurde gelöscht.",
    en: "Signed out of Twitch. The local OAuth token was deleted.",
    fr: "Déconnecté de Twitch. Le jeton OAuth local a été supprimé.",
    es: "Sesión de Twitch cerrada. Se eliminó el token OAuth local.",
    th: "ออกจากระบบ Twitch แล้ว โทเคน OAuth ในเครื่องถูกลบแล้ว"
  },
  "btn-connect-twitch": { de: "Mit Twitch anmelden", en: "Sign in with Twitch",
    fr: "Se connecter avec Twitch",
    es: "Iniciar sesión con Twitch",
    th: "เข้าสู่ระบบด้วย Twitch"
  },
  "btn-refresh-twitch-status": { de: "Status prüfen", en: "Check status",
    fr: "Vérifier le statut",
    es: "Comprobar estado",
    th: "ตรวจสอบสถานะ"
  },
  "btn-disconnect-twitch": { de: "Abmelden", en: "Sign out",
    fr: "Se déconnecter",
    es: "Cerrar sesión",
    th: "ออกจากระบบ"
  },
  "cp-title": { de: "Belohnungen verwalten", en: "Manage rewards",
    fr: "Gérer les récompenses",
    es: "Gestionar recompensas",
    th: "จัดการรางวัล"
  },
  "draw-reward-eyebrow": { de: "Kartenpack", en: "Card pack",
    fr: "Pack de cartes",
    es: "Sobre de cartas",
    th: "แพ็กการ์ด"
  },
  "draw-reward-title": { de: "Kartenpack-Belohnung", en: "Card pack reward",
    fr: "Récompense pack de cartes",
    es: "Recompensa de sobre de cartas",
    th: "รางวัลแพ็กการ์ด"
  },
  "confirm-delete-reward": { de: "Diese Belohnung wirklich löschen?", en: "Really delete this reward?",
    fr: "Vraiment supprimer cette récompense ?",
    es: "¿Eliminar realmente esta recompensa?",
    th: "ต้องการลบรางวัลนี้จริงหรือไม่?"
  },
  "label-reward-title": { de: "Reward-Titel", en: "Reward title",
    fr: "Titre de la récompense",
    es: "Título de la recompensa",
    th: "ชื่อรางวัล"
  },
  "label-reward-cost": { de: "Kosten", en: "Cost",
    fr: "Coût",
    es: "Costo",
    th: "ค่าใช้จ่าย"
  },
  "label-reward-prompt": { de: "Beschreibung", en: "Description",
    fr: "Description",
    es: "Descripción",
    th: "คำอธิบาย"
  },
  "label-reward-post-enabled": { de: "Chat-Nachricht nach dem Ziehen senden", en: "Send chat message after the draw",
    fr: "Envoyer un message de chat après le tirage",
    es: "Enviar mensaje de chat después de abrir",
    th: "ส่งข้อความแชทหลังจากสุ่ม"
  },
  "label-reward-post-message": { de: "Nachricht nach der Animation", en: "Message after the animation",
    fr: "Message après l'animation",
    es: "Mensaje después de la animación",
    th: "ข้อความหลังแอนิเมชัน"
  },
  "label-reward-bg-color": { de: "Hintergrundfarbe", en: "Background color",
    fr: "Couleur de fond",
    es: "Color de fondo",
    th: "สีพื้นหลัง"
  },
  "label-reward-cooldown": { de: "Globaler Cooldown (Sek.)", en: "Global cooldown (sec.)",
    fr: "Cooldown global (sec.)",
    es: "Cooldown global (seg.)",
    th: "คูลดาวน์รวม (วินาที)"
  },
  "label-reward-max-stream": { de: "Max pro Stream", en: "Max per stream",
    fr: "Max par stream",
    es: "Máx. por transmisión",
    th: "สูงสุดต่อสตรีม"
  },
  "label-reward-max-user": { de: "Max pro Nutzer/Stream", en: "Max per user/stream",
    fr: "Max par utilisateur/stream",
    es: "Máx. por usuario/transmisión",
    th: "สูงสุดต่อผู้ใช้/สตรีม"
  },
  "label-reward-enabled": { de: "Aktiviert", en: "Enabled",
    fr: "Activé",
    es: "Activado",
    th: "เปิดใช้งาน"
  },
  "label-reward-paused": { de: "Pausiert", en: "Paused",
    fr: "En pause",
    es: "Pausado",
    th: "หยุดชั่วคราว"
  },
  "btn-sync-reward": { de: "Speichern / aktualisieren", en: "Save / update",
    fr: "Enregistrer / actualiser",
    es: "Guardar / actualizar",
    th: "บันทึก/อัปเดต"
  },
  "btn-delete-reward": { de: "Löschen", en: "Delete",
    fr: "Supprimer",
    es: "Eliminar",
    th: "ลบ"
  },
  "status-saving-reward": { de: "Speichere Channelpoint...", en: "Saving channel point...",
    fr: "Enregistrement du point de chaîne...",
    es: "Guardando punto de canal...",
    th: "กำลังบันทึกแชนแนลพอยท์..."
  },
  "notice-reward-saved": {
    de: "Channelpoint wurde gespeichert und dem Booster zugeordnet.",
    en: "Channel point was saved and assigned to the booster.",
    fr: "Le point de chaîne a été enregistré et assigné au booster.",
    es: "El punto de canal se guardó y se asignó al sobre.",
    th: "บันทึกแชนแนลพอยท์และกำหนดให้บูสเตอร์แล้ว"
  },
  "status-deleting-reward": { de: "Lösche Channelpoint...", en: "Deleting channel point...",
    fr: "Suppression du point de chaîne...",
    es: "Eliminando punto de canal...",
    th: "กำลังลบแชนแนลพอยท์..."
  },
  "notice-reward-deleted": { de: "Channelpoint gelöscht.", en: "Channel point deleted.",
    fr: "Point de chaîne supprimé.",
    es: "Punto de canal eliminado.",
    th: "ลบแชนแนลพอยท์แล้ว"
  },
  "status-not-tested": { de: "Nicht getestet", en: "Not tested",
    fr: "Non testé",
    es: "No probado",
    th: "ยังไม่ได้ทดสอบ"
  },
  "status-testing-obs": { de: "Teste OBS...", en: "Testing OBS...",
    fr: "Test d'OBS...",
    es: "Probando OBS...",
    th: "กำลังทดสอบ OBS..."
  },
  "error-obs-not-connected": { de: "OBS nicht verbunden:", en: "OBS not connected:",
    fr: "OBS non connecté :",
    es: "OBS no conectado:",
    th: "OBS ยังไม่เชื่อมต่อ:"
  },
  "status-setting-up-obs": { de: "Richte OBS ein...", en: "Setting up OBS...",
    fr: "Configuration d'OBS...",
    es: "Configurando OBS...",
    th: "กำลังตั้งค่า OBS..."
  },
  "status-obs-updated": { de: "OBS aktualisiert:", en: "OBS updated:",
    fr: "OBS mis à jour :",
    es: "OBS actualizado:",
    th: "อัปเดต OBS แล้ว:"
  },
  "error-obs-setup-failed": { de: "OBS Setup fehlgeschlagen:", en: "OBS setup failed:",
    fr: "Échec de la configuration d'OBS :",
    es: "Error al configurar OBS:",
    th: "ตั้งค่า OBS ล้มเหลว:"
  },
  "notice-obs-scene-updated": {
    de: "OBS Szene und Browserquelle wurden erstellt oder aktualisiert.",
    en: "OBS scene and browser source were created or updated.",
    fr: "La scène OBS et la source navigateur ont été créées ou mises à jour.",
    es: "La escena de OBS y la fuente de navegador se crearon o actualizaron.",
    th: "สร้างหรืออัปเดตฉาก OBS และซอร์สเบราว์เซอร์แล้ว"
  },
  "status-testing-meld": { de: "Teste Meld Studio...", en: "Testing Meld Studio...",
    fr: "Test de Meld Studio...",
    es: "Probando Meld Studio...",
    th: "กำลังทดสอบ Meld Studio..."
  },
  "error-meld-not-connected": { de: "Meld Studio nicht verbunden:", en: "Meld Studio not connected:",
    fr: "Meld Studio non connecté :",
    es: "Meld Studio no conectado:",
    th: "Meld Studio ยังไม่เชื่อมต่อ:"
  },
  "status-setting-up-meld": { de: "Aktualisiere Meld Studio...", en: "Updating Meld Studio...",
    fr: "Mise à jour de Meld Studio...",
    es: "Actualizando Meld Studio...",
    th: "กำลังอัปเดต Meld Studio..."
  },
  "status-meld-updated": { de: "Meld Studio aktualisiert:", en: "Meld Studio updated:",
    fr: "Meld Studio mis à jour :",
    es: "Meld Studio actualizado:",
    th: "อัปเดต Meld Studio แล้ว:"
  },
  "error-meld-setup-failed": { de: "Meld Studio Update fehlgeschlagen:", en: "Meld Studio update failed:",
    fr: "Échec de la mise à jour de Meld Studio :",
    es: "Error al actualizar Meld Studio:",
    th: "อัปเดต Meld Studio ล้มเหลว:"
  },
  "error-meld-scene-missing": { de: "Szene nicht in Meld Studio gefunden:", en: "Scene not found in Meld Studio:",
    fr: "Scène introuvable dans Meld Studio :",
    es: "Escena no encontrada en Meld Studio:",
    th: "ไม่พบฉากใน Meld Studio:"
  },
  "error-meld-source-missing": { de: "Quelle nicht in Meld Studio gefunden:", en: "Source not found in Meld Studio:",
    fr: "Source introuvable dans Meld Studio :",
    es: "Fuente no encontrada en Meld Studio:",
    th: "ไม่พบซอร์สใน Meld Studio:"
  },
  "notice-meld-scene-updated": {
    de: "Meld Studio Szene und Quellen wurden aktualisiert.",
    en: "Meld Studio scene and sources were updated.",
    fr: "La scène et les sources Meld Studio ont été mises à jour.",
    es: "La escena y las fuentes de Meld Studio se actualizaron.",
    th: "อัปเดตฉากและซอร์สของ Meld Studio แล้ว"
  },
  "label-obs-check": { de: "OBS WebSocket Verbindung prüfen", en: "Check OBS WebSocket connection",
    fr: "Vérifier la connexion WebSocket OBS",
    es: "Comprobar conexión WebSocket de OBS",
    th: "ตรวจสอบการเชื่อมต่อ WebSocket ของ OBS"
  },
  "label-obs-password": { de: "Passwort", en: "Password",
    fr: "Mot de passe",
    es: "Contraseña",
    th: "รหัสผ่าน"
  },
  "label-meld-check": { de: "Meld Studio WebSocket Verbindung prüfen", en: "Check Meld Studio WebSocket connection",
    fr: "Vérifier la connexion WebSocket Meld Studio",
    es: "Comprobar conexión WebSocket de Meld Studio",
    th: "ตรวจสอบการเชื่อมต่อ WebSocket ของ Meld Studio"
  },
  "btn-obs-info": { de: "Hilfe anzeigen", en: "Show help",
    fr: "Afficher l'aide",
    es: "Mostrar ayuda",
    th: "แสดงวิธีใช้"
  },
  "btn-obs-info-hide": { de: "Hilfe ausblenden", en: "Hide help",
    fr: "Masquer l'aide",
    es: "Ocultar ayuda",
    th: "ซ่อนวิธีใช้"
  },
  "btn-meld-info": { de: "Hilfe anzeigen", en: "Show help",
    fr: "Afficher l'aide",
    es: "Mostrar ayuda",
    th: "แสดงวิธีใช้"
  },
  "btn-meld-info-hide": { de: "Hilfe ausblenden", en: "Hide help",
    fr: "Masquer l'aide",
    es: "Ocultar ayuda",
    th: "ซ่อนวิธีใช้"
  },
  "btn-test-meld": { de: "Meld testen", en: "Test Meld",
    fr: "Tester Meld",
    es: "Probar Meld",
    th: "ทดสอบ Meld"
  },
  "btn-setup-meld": { de: "Meld Szene / Quellen aktualisieren", en: "Update Meld scene & sources",
    fr: "Mettre à jour la scène et sources Meld",
    es: "Actualizar escena y fuentes de Meld",
    th: "อัปเดตฉากและซอร์สของ Meld"
  },
  "meld-info-text": {
    de: "Öffne in Meld Studio die Einstellungen → „Erweitert“ und aktiviere den WebSocket-Server (Standard-Port 13376). Lege Szene und Quellen mit den Namen aus dem Abschnitt „Szene & Quellen“ unten einmalig manuell in Meld Studio an — diese Namen werden hier zum Zuordnen verwendet. Meld Studio kann Szenen/Quellen nicht per API erstellen, nur bereits vorhandene aktualisieren.",
    en: "In Meld Studio open Settings → “Advanced” and enable the WebSocket server (default port 13376). Create the scene and sources with the names from the “Scene & sources” section below once, manually, in Meld Studio — those names are used here to match them up. Meld Studio's API cannot create scenes/sources, only update existing ones.",
    fr: "Dans Meld Studio, ouvre Paramètres → « Avancé » et active le serveur WebSocket (port par défaut 13376). Crée une fois, manuellement, la scène et les sources avec les noms de la section « Scène & sources » ci-dessous dans Meld Studio — ces noms sont utilisés ici pour la correspondance. L'API de Meld Studio ne peut pas créer de scènes/sources, seulement mettre à jour celles existantes.",
    es: "En Meld Studio abre Configuración → “Avanzado” y activa el servidor WebSocket (puerto predeterminado 13376). Crea una vez, manualmente, la escena y las fuentes con los nombres de la sección “Escena y fuentes” de abajo en Meld Studio — esos nombres se usan aquí para asociarlos. La API de Meld Studio no puede crear escenas/fuentes, solo actualizar las existentes.",
    th: "ใน Meld Studio เปิดการตั้งค่า → \"ขั้นสูง\" แล้วเปิดใช้งานเซิร์ฟเวอร์ WebSocket (พอร์ตเริ่มต้น 13376) สร้างฉากและซอร์สด้วยชื่อจากส่วน \"ฉากและซอร์ส\" ด้านล่างด้วยตนเองใน Meld Studio หนึ่งครั้ง — ชื่อเหล่านี้จะใช้จับคู่ที่นี่ API ของ Meld Studio ไม่สามารถสร้างฉาก/ซอร์สได้ อัปเดตได้เฉพาะที่มีอยู่แล้ว"
  },
  "obs-info-text": {
    de: "Öffne in OBS das Menü „Werkzeuge“ → „WebSocket-Servereinstellungen“. Aktiviere dort „WebSocket-Server aktivieren“. Den Port (Standard 4455) und das Passwort findest du über „Verbindungsinformationen anzeigen“. Trage Host (meist 127.0.0.1), Port und Passwort dann hier ein.",
    en: "In OBS open the “Tools” menu → “WebSocket Server Settings”. Enable “Enable WebSocket server”. You'll find the port (default 4455) and password via “Show Connect Info”. Then enter host (usually 127.0.0.1), port and password here.",
    fr: "Dans OBS, ouvre le menu « Outils » → « Paramètres du serveur WebSocket ». Active « Activer le serveur WebSocket ». Tu trouveras le port (par défaut 4455) et le mot de passe via « Afficher les infos de connexion ». Entre ensuite l'hôte (généralement 127.0.0.1), le port et le mot de passe ici.",
    es: "En OBS abre el menú “Herramientas” → “Configuración del servidor WebSocket”. Activa “Activar servidor WebSocket”. Encontrarás el puerto (predeterminado 4455) y la contraseña mediante “Mostrar información de conexión”. Luego introduce aquí host (normalmente 127.0.0.1), puerto y contraseña.",
    th: "ใน OBS เปิดเมนู \"เครื่องมือ\" → \"การตั้งค่าเซิร์ฟเวอร์ WebSocket\" เปิดใช้งาน \"เปิดใช้งานเซิร์ฟเวอร์ WebSocket\" คุณจะพบพอร์ต (ค่าเริ่มต้น 4455) และรหัสผ่านผ่าน \"แสดงข้อมูลการเชื่อมต่อ\" จากนั้นกรอกโฮสต์ (โดยปกติ 127.0.0.1) พอร์ต และรหัสผ่านที่นี่"
  },
  "obs-scenes-title": { de: "Szene & Quellen", en: "Scene & sources",
    fr: "Scène & sources",
    es: "Escena y fuentes",
    th: "ฉากและซอร์ส"
  },
  "label-obs-scene": { de: "Szenenname", en: "Scene name",
    fr: "Nom de la scène",
    es: "Nombre de la escena",
    th: "ชื่อฉาก"
  },
  "label-obs-combined-source": { de: "Quellenname (alle Animationen)", en: "Source name (all animations)",
    fr: "Nom de la source (toutes les animations)", es: "Nombre de la fuente (todas las animaciones)", th: "ชื่อแหล่งที่มา (แอนิเมชันทั้งหมด)" },
  "label-meld-combined-source": { de: "Quellenname (alle Animationen)", en: "Source name (all animations)",
    fr: "Nom de la source (toutes les animations)", es: "Nombre de la fuente (todas las animaciones)", th: "ชื่อแหล่งที่มา (แอนิเมชันทั้งหมด)" },
  "label-obs-source": { de: "Quellenname Booster", en: "Source name booster",
    fr: "Nom de source booster",
    es: "Nombre de fuente del sobre",
    th: "ชื่อซอร์สบูสเตอร์"
  },
  "label-obs-collection-source": { de: "Quellenname Kartensammlung", en: "Source name card collection",
    fr: "Nom de source collection de cartes",
    es: "Nombre de fuente de colección de cartas",
    th: "ชื่อซอร์สคอลเลกชันการ์ด"
  },
  "meld-scenes-title": { de: "Szene & Quellen", en: "Scene & sources",
    fr: "Scène & sources",
    es: "Escena y fuentes",
    th: "ฉากและซอร์ส"
  },
  "meld-scenes-hint": {
    de: "Unabhängig von OBS: lege hier die Szenen- und Quellennamen fest, die in Meld Studio verwendet werden.",
    en: "Independent of OBS: set the scene and source names used in Meld Studio here.",
    fr: "Indépendant d'OBS : définis ici les noms de scène et de sources utilisés dans Meld Studio.",
    es: "Independiente de OBS: define aquí los nombres de escena y fuentes usados en Meld Studio.",
    th: "แยกจาก OBS: กำหนดชื่อฉากและซอร์สที่ใช้ใน Meld Studio ที่นี่"
  },
  "label-meld-scene": { de: "Szenenname", en: "Scene name",
    fr: "Nom de la scène",
    es: "Nombre de la escena",
    th: "ชื่อฉาก"
  },
  "label-meld-source": { de: "Quellenname Booster", en: "Source name booster",
    fr: "Nom de source booster",
    es: "Nombre de fuente del sobre",
    th: "ชื่อซอร์สบูสเตอร์"
  },
  "label-meld-collection-source": { de: "Quellenname Kartensammlung", en: "Source name card collection",
    fr: "Nom de source collection de cartes",
    es: "Nombre de fuente de colección de cartas",
    th: "ชื่อซอร์สคอลเลกชันการ์ด"
  },
  "label-meld-trade-source": { de: "Quellenname Tausch-Animation", en: "Source name trade animation",
    fr: "Nom de source animation d'échange",
    es: "Nombre de fuente de animación de intercambio",
    th: "ชื่อซอร์สแอนิเมชันแลกเปลี่ยน"
  },
  "label-meld-battle-source": { de: "Quellenname Kampf-Animation", en: "Source name battle animation",
    fr: "Nom de source animation de duel",
    es: "Nombre de fuente de animación de duelo",
    th: "ชื่อซอร์สแอนิเมชันดวล"
  },
  "label-meld-ranking-source": { de: "Quellenname Ranking", en: "Source name ranking",
    fr: "Nom de source classement",
    es: "Nombre de fuente de clasificación",
    th: "ชื่อซอร์สอันดับ"
  },
  "btn-test-obs": { de: "OBS testen", en: "Test OBS",
    fr: "Tester OBS",
    es: "Probar OBS",
    th: "ทดสอบ OBS"
  },
  "btn-setup-obs": { de: "OBS Szene / Quellen erstellen / aktualisieren", en: "Create / update OBS scene & sources",
    fr: "Créer / mettre à jour la scène et sources OBS",
    es: "Crear / actualizar escena y fuentes de OBS",
    th: "สร้าง/อัปเดตฉากและซอร์ส OBS"
  },
  "users-eyebrow": { de: "Sammlung", en: "Collection",
    fr: "Collection",
    es: "Colección",
    th: "คอลเลกชัน"
  },
  "users-title": { de: "Nutzer verwalten", en: "Manage users",
    fr: "Gérer les utilisateurs",
    es: "Gestionar usuarios",
    th: "จัดการผู้ใช้"
  },
  "placeholder-user-search": { de: "Nutzer suchen...", en: "Search users...",
    fr: "Rechercher des utilisateurs...",
    es: "Buscar usuarios...",
    th: "ค้นหาผู้ใช้..."
  },
  "hint-users-empty": {
    de: "Noch keine Sammlungen vorhanden. Sobald Nutzer Karten ziehen, erscheinen sie hier.",
    en: "No collections yet. As soon as users draw cards, they'll show up here.",
    fr: "Pas encore de collections. Dès que des utilisateurs tirent des cartes, ils apparaîtront ici.",
    es: "Aún no hay colecciones. En cuanto los usuarios saquen cartas, aparecerán aquí.",
    th: "ยังไม่มีคอลเลกชัน เมื่อผู้ใช้สุ่มการ์ด จะปรากฏที่นี่"
  },
  "hint-no-users-found": { de: "Keine Nutzer gefunden für", en: "No users found for",
    fr: "Aucun utilisateur trouvé pour",
    es: "No se encontraron usuarios para",
    th: "ไม่พบผู้ใช้สำหรับ"
  },
  "hint-no-cards-drawn": { de: "Keine Karten gezogen.", en: "No cards drawn.",
    fr: "Aucune carte tirée.",
    es: "No se han sacado cartas.",
    th: "ยังไม่มีการสุ่มการ์ด"
  },
  "unit-cards": { de: "Karten", en: "cards",
    fr: "cartes",
    es: "cartas",
    th: "การ์ด"
  },
  "btn-delete-user": { de: "Nutzer löschen", en: "Delete user",
    fr: "Supprimer l'utilisateur",
    es: "Eliminar usuario",
    th: "ลบผู้ใช้"
  },
  "notice-user-deleted": { de: "Nutzer gelöscht.", en: "User deleted.",
    fr: "Utilisateur supprimé.",
    es: "Usuario eliminado.",
    th: "ลบผู้ใช้แล้ว"
  },
  "label-unknown-booster": { de: "Unbekannter Booster", en: "Unknown booster",
    fr: "Booster inconnu",
    es: "Sobre desconocido",
    th: "บูสเตอร์ที่ไม่รู้จัก"
  },
  "option-assign-booster": { de: "Booster zuordnen…", en: "Assign booster…",
    fr: "Assigner un booster…",
    es: "Asignar sobre…",
    th: "กำหนดบูสเตอร์…"
  },
  "notice-group-reassigned": { de: "Karten dem Booster zugeordnet.", en: "Cards reassigned to booster.",
    fr: "Cartes réassignées au booster.",
    es: "Cartas reasignadas al sobre.",
    th: "กำหนดการ์ดใหม่ให้บูสเตอร์แล้ว"
  },
  "design-look-title": { de: "Farben und Anzeige", en: "Colors and display",
    fr: "Couleurs et affichage",
    es: "Colores y visualización",
    th: "สีและการแสดงผล"
  },
  "label-font": { de: "Schrift", en: "Font",
    fr: "Police",
    es: "Fuente",
    th: "แบบอักษร"
  },
  "label-accent": { de: "Akzent", en: "Accent",
    fr: "Accent",
    es: "Acento",
    th: "สีเน้น"
  },
  "label-volume": { de: "Lautstärke", en: "Volume",
    fr: "Volume",
    es: "Volumen",
    th: "ระดับเสียง"
  },
  "label-preview-eyebrow": { de: "Vorschau", en: "Preview",
    fr: "Aperçu",
    es: "Vista previa",
    th: "ตัวอย่าง"
  },
  "label-show-collection": { de: "Sammlungsleiste anzeigen", en: "Show collection bar",
    fr: "Afficher la barre de collection",
    es: "Mostrar barra de colección",
    th: "แสดงแถบคอลเลกชัน"
  },
  "label-card-borders": { de: "Kartenrahmen anzeigen", en: "Show card borders",
    fr: "Afficher les bordures de carte",
    es: "Mostrar bordes de carta",
    th: "แสดงขอบการ์ด"
  },
  "label-card-pattern-enabled": { de: "Kartenmuster anzeigen", en: "Show card pattern",
    fr: "Afficher le motif de carte",
    es: "Mostrar patrón de carta",
    th: "แสดงลวดลายการ์ด"
  },
  "label-booster-pattern-enabled": { de: "Booster-Muster anzeigen", en: "Show booster pattern",
    fr: "Afficher le motif de booster",
    es: "Mostrar patrón de sobre",
    th: "แสดงลวดลายบูสเตอร์"
  },
  "pattern-eyebrow": { de: "Muster", en: "Pattern",
    fr: "Motif",
    es: "Patrón",
    th: "ลวดลาย"
  },
  "pattern-title": { de: "Eigene Muster", en: "Custom patterns",
    fr: "Motifs personnalisés",
    es: "Patrones personalizados",
    th: "ลวดลายกำหนดเอง"
  },
  "pattern-hint": {
    de: "Lade eine kleine, kachelbare Bilddatei hoch (z.B. PNG mit Transparenz) - sie wird wiederholt über die Karte bzw. den Booster gelegt. Ohne eigenes Bild bleibt das Standardmuster (Punkte/Streifen).",
    en: "Upload a small, tileable image file (e.g. a PNG with transparency) - it's repeated across the card or booster. Without an upload, the built-in pattern (dots/stripes) is used.",
    fr: "Télécharge une petite image carrelable (par ex. un PNG avec transparence) - elle sera répétée sur la carte ou le booster. Sans téléchargement, le motif intégré (points/rayures) est utilisé.",
    es: "Sube una imagen pequeña y repetible (p. ej. un PNG con transparencia) - se repetirá sobre la carta o el sobre. Sin subida, se usa el patrón integrado (puntos/rayas).",
    th: "อัปโหลดรูปภาพขนาดเล็กที่ปูซ้ำได้ (เช่น PNG แบบโปร่งใส) - จะถูกวนซ้ำบนการ์ดหรือบูสเตอร์ หากไม่อัปโหลด จะใช้ลวดลายเริ่มต้น (จุด/ลาย)"
  },
  "label-card-pattern-image": { de: "Eigenes Kartenmuster", en: "Custom card pattern",
    fr: "Motif de carte personnalisé",
    es: "Patrón de carta personalizado",
    th: "ลวดลายการ์ดกำหนดเอง"
  },
  "label-card-pattern-size": { de: "Musterkachel-Größe (px)", en: "Pattern tile size (px)",
    fr: "Taille du motif (px)",
    es: "Tamaño del patrón (px)",
    th: "ขนาดลวดลาย (px)"
  },
  "btn-remove-card-pattern-image": { de: "Eigenes Kartenmuster entfernen", en: "Remove custom card pattern",
    fr: "Supprimer le motif de carte personnalisé",
    es: "Eliminar patrón de carta personalizado",
    th: "ลบลวดลายการ์ดกำหนดเอง"
  },
  "label-booster-pattern-image": { de: "Eigenes Booster-Muster", en: "Custom booster pattern",
    fr: "Motif de booster personnalisé",
    es: "Patrón de sobre personalizado",
    th: "ลวดลายบูสเตอร์กำหนดเอง"
  },
  "label-booster-pattern-size": { de: "Musterkachel-Größe (px)", en: "Pattern tile size (px)",
    fr: "Taille du motif (px)",
    es: "Tamaño del patrón (px)",
    th: "ขนาดลวดลาย (px)"
  },
  "btn-remove-booster-pattern-image": { de: "Eigenes Booster-Muster entfernen", en: "Remove custom booster pattern",
    fr: "Supprimer le motif de booster personnalisé",
    es: "Eliminar patrón de sobre personalizado",
    th: "ลบลวดลายบูสเตอร์กำหนดเอง"
  },
  "label-name-position": { de: "Position Einlöser-Name", en: "Redeemer name position",
    fr: "Position du nom du gagnant",
    es: "Posición del nombre del ganador",
    th: "ตำแหน่งชื่อผู้แลก"
  },
  "option-name-bottom": { de: "Unten", en: "Bottom",
    fr: "Bas",
    es: "Abajo",
    th: "ด้านล่าง"
  },
  "option-name-top": { de: "Oben", en: "Top",
    fr: "Haut",
    es: "Arriba",
    th: "ด้านบน"
  },
  "label-preview-card": { de: "Vorschaukarte", en: "Preview card",
    fr: "Carte d'aperçu",
    es: "Carta de vista previa",
    th: "การ์ดตัวอย่าง"
  },
  "label-reveal-seconds": { de: "Karte sichtbar in Sekunden", en: "Card visible (seconds)",
    fr: "Carte visible (secondes)",
    es: "Carta visible (segundos)",
    th: "การ์ดแสดงผล (วินาที)"
  },
  "label-cooldown-seconds": { de: "Cooldown in Sekunden", en: "Cooldown (seconds)",
    fr: "Cooldown (secondes)",
    es: "Cooldown (segundos)",
    th: "คูลดาวน์ (วินาที)"
  },
  "label-backs-before-reveal": { de: "Verdeckte Karten vor Reveal", en: "Face-down cards before reveal",
    fr: "Cartes face cachée avant révélation",
    es: "Cartas boca abajo antes de revelar",
    th: "การ์ดคว่ำก่อนเปิดเผย"
  },
  "showcase-eyebrow": { de: "Sammlung", en: "Collection",
    fr: "Collection",
    es: "Colección",
    th: "คอลเลกชัน"
  },
  "showcase-title": { de: "Sammlungs-Showcase", en: "Collection showcase",
    fr: "Vitrine de collection",
    es: "Vitrina de colección",
    th: "โชว์เคสคอลเลกชัน"
  },
  "btn-showcase-info": { de: "Hilfe anzeigen", en: "Show help",
    fr: "Afficher l'aide",
    es: "Mostrar ayuda",
    th: "แสดงวิธีใช้"
  },
  "btn-showcase-info-hide": { de: "Hilfe ausblenden", en: "Hide help",
    fr: "Masquer l'aide",
    es: "Ocultar ayuda",
    th: "ซ่อนวิธีใช้"
  },
  "showcase-info-text": {
    de: "Löst ein Zuschauer die Belohnung „Sammlung zeigen“ über Kanalpunkte ein, sliden im OBS-Overlay nacheinander alle aktiven Booster mit den Karten dieses Zuschauers durch (gezogen = sichtbar, noch nicht gezogen = unbekannt). Richte dafür einmal die separate OBS-Quelle ein. Den globalen Cooldown legst du direkt an der Belohnung fest.",
    en: "When a viewer redeems the “Show collection” channel-point reward, the OBS overlay slides through every active booster showing that viewer's cards (drawn = visible, not yet drawn = unknown). Set up the separate OBS source once. The global cooldown is set on the reward itself.",
    fr: "Quand un spectateur utilise la récompense « Afficher la collection », l'overlay OBS défile parmi tous les boosters actifs en montrant les cartes de ce spectateur (tirées = visibles, pas encore tirées = inconnues). Configure la source OBS séparée une fois. Le cooldown global se règle sur la récompense elle-même.",
    es: "Cuando un espectador canjea la recompensa “Mostrar colección”, el overlay de OBS recorre todos los sobres activos mostrando las cartas de ese espectador (sacadas = visibles, aún no sacadas = desconocidas). Configura la fuente de OBS separada una vez. El cooldown global se define en la propia recompensa.",
    th: "เมื่อผู้ชมแลกรางวัล \"แสดงคอลเลกชัน\" โอเวอร์เลย์ OBS จะเลื่อนแสดงบูสเตอร์ที่ใช้งานทั้งหมด แสดงการ์ดของผู้ชมคนนั้น (สุ่มแล้ว = มองเห็น ยังไม่สุ่ม = ไม่ทราบ) ตั้งค่าซอร์ส OBS แยกต่างหากเพียงครั้งเดียว คูลดาวน์รวมตั้งค่าที่ตัวรางวัลเอง"
  },
  "label-showcase-reward-title": { de: "Reward-Titel", en: "Reward title",
    fr: "Titre de la récompense",
    es: "Título de la recompensa",
    th: "ชื่อรางวัล"
  },
  "label-showcase-reward-cost": { de: "Kosten", en: "Cost",
    fr: "Coût",
    es: "Costo",
    th: "ค่าใช้จ่าย"
  },
  "label-showcase-cooldown": { de: "Globaler Cooldown (Sek.)", en: "Global cooldown (sec.)",
    fr: "Cooldown global (sec.)",
    es: "Cooldown global (seg.)",
    th: "คูลดาวน์รวม (วินาที)"
  },
  "label-showcase-bg-color": { de: "Hintergrundfarbe", en: "Background color",
    fr: "Couleur de fond",
    es: "Color de fondo",
    th: "สีพื้นหลัง"
  },
  "label-showcase-seconds": { de: "Sekunden pro Seite (Umblättern)", en: "Seconds per page (page-flip)",
    fr: "Secondes par page (défilement)",
    es: "Segundos por página (paso de página)",
    th: "วินาทีต่อหน้า (พลิกหน้า)"
  },
  "status-showcase-saving": { de: "Showcase-Belohnung wird gespeichert...", en: "Saving showcase reward...",
    fr: "Enregistrement de la récompense vitrine...",
    es: "Guardando recompensa de vitrina...",
    th: "กำลังบันทึกรางวัลโชว์เคส..."
  },
  "notice-tournament-reward-saved": { de: "Turnier-Belohnung gespeichert.", en: "Tournament reward saved.",
    fr: "Récompense de tournoi enregistrée.",
    es: "Recompensa de torneo guardada.",
    th: "บันทึกรางวัลทัวร์นาเมนต์แล้ว"
  },
  "notice-showcase-saved": { de: "Showcase-Belohnung gespeichert.", en: "Showcase reward saved.",
    fr: "Récompense vitrine enregistrée.",
    es: "Recompensa de vitrina guardada.",
    th: "บันทึกรางวัลโชว์เคสแล้ว"
  },
  "label-sound-open": { de: "Öffnen-Sound", en: "Open sound",
    fr: "Son d'ouverture",
    es: "Sonido de apertura",
    th: "เสียงเปิด"
  },
  "label-sound-reveal": { de: "Reveal-Sound", en: "Reveal sound",
    fr: "Son de révélation",
    es: "Sonido de revelación",
    th: "เสียงเปิดเผย"
  },
  "label-sound-trade": { de: "Tausch-Sound", en: "Trade sound",
    fr: "Son d'échange",
    es: "Sonido de intercambio",
    th: "เสียงแลกเปลี่ยน"
  },
  "status-no-sound": { de: "Kein Sound ausgewählt", en: "No sound selected",
    fr: "Aucun son sélectionné",
    es: "Ningún sonido seleccionado",
    th: "ยังไม่ได้เลือกเสียง"
  },
  "status-default-sound": { de: "Kein eigener Sound – eingebauter Standard-Klang aktiv", en: "No custom sound – built-in default plays",
    fr: "Aucun son personnalisé – le son par défaut est joué",
    es: "Sin sonido personalizado – se reproduce el predeterminado",
    th: "ไม่มีเสียงกำหนดเอง – ใช้เสียงเริ่มต้น"
  },
  "status-sound-set": { de: "Sound gespeichert", en: "Sound saved",
    fr: "Son enregistré",
    es: "Sonido guardado",
    th: "บันทึกเสียงแล้ว"
  },
  "btn-play": { de: "▶ Abspielen", en: "▶ Play",
    fr: "▶ Lire",
    es: "▶ Reproducir",
    th: "▶ เล่น"
  },
  "btn-choose-file": { de: "Auswählen", en: "Choose file",
    fr: "Choisir un fichier",
    es: "Elegir archivo",
    th: "เลือกไฟล์"
  },
  "btn-remove": { de: "Entfernen", en: "Remove",
    fr: "Supprimer",
    es: "Eliminar",
    th: "ลบ"
  },
  "notice-sound-open-saved": { de: "Öffnen-Sound gespeichert.", en: "Open sound saved.",
    fr: "Son d'ouverture enregistré.",
    es: "Sonido de apertura guardado.",
    th: "บันทึกเสียงเปิดแล้ว"
  },
  "notice-sound-reveal-saved": { de: "Reveal-Sound gespeichert.", en: "Reveal sound saved.",
    fr: "Son de révélation enregistré.",
    es: "Sonido de revelación guardado.",
    th: "บันทึกเสียงเปิดเผยแล้ว"
  },
  "notice-sound-open-removed": { de: "Öffnen-Sound entfernt.", en: "Open sound removed.",
    fr: "Son d'ouverture supprimé.",
    es: "Sonido de apertura eliminado.",
    th: "ลบเสียงเปิดแล้ว"
  },
  "notice-sound-reveal-removed": { de: "Reveal-Sound entfernt.", en: "Reveal sound removed.",
    fr: "Son de révélation supprimé.",
    es: "Sonido de revelación eliminado.",
    th: "ลบเสียงเปิดเผยแล้ว"
  },
  "notice-sound-trade-saved": { de: "Tausch-Sound gespeichert.", en: "Trade sound saved.",
    fr: "Son d'échange enregistré.",
    es: "Sonido de intercambio guardado.",
    th: "บันทึกเสียงแลกเปลี่ยนแล้ว"
  },
  "notice-sound-trade-removed": { de: "Tausch-Sound entfernt.", en: "Trade sound removed.",
    fr: "Son d'échange supprimé.",
    es: "Sonido de intercambio eliminado.",
    th: "ลบเสียงแลกเปลี่ยนแล้ว"
  },
  "label-obs-trade-source": { de: "Quellenname Tausch-Animation", en: "Source name trade animation",
    fr: "Nom de source animation d'échange",
    es: "Nombre de fuente de animación de intercambio",
    th: "ชื่อซอร์สแอนิเมชันแลกเปลี่ยน"
  },
  "trade-anim-eyebrow": { de: "Tausch", en: "Trade",
    fr: "Échange",
    es: "Intercambio",
    th: "การแลกเปลี่ยน"
  },
  "trade-anim-title": { de: "Tausch-Animation", en: "Trade animation",
    fr: "Animation d'échange",
    es: "Animación de intercambio",
    th: "แอนิเมชันแลกเปลี่ยน"
  },
  "trade-anim-hint": {
    de: "Bei einem erfolgreichen Tausch (!tradeyes) wird eine Animation in einer eigenen OBS-Quelle (trade.html) abgespielt. Quellenname & Einrichtung findest du unter „Verbindung“.",
    en: "On a successful trade (!tradeyes) an animation plays in its own OBS source (trade.html). Source name & setup are under “Connection”.",
    fr: "Lors d'un échange réussi (!tradeyes), une animation se joue dans sa propre source OBS (trade.html). Nom de source et configuration sous « Connexion ».",
    es: "Al completar un intercambio (!tradeyes) se reproduce una animación en su propia fuente de OBS (trade.html). El nombre de fuente y la configuración están en “Conexión”.",
    th: "เมื่อแลกเปลี่ยนสำเร็จ (!tradeyes) จะเล่นแอนิเมชันในซอร์ส OBS ของตัวเอง (trade.html) ชื่อซอร์สและการตั้งค่าอยู่ที่ \"การเชื่อมต่อ\""
  },
  "label-trade-anim-enabled": { de: "Tausch-Animation aktiviert", en: "Trade animation enabled",
    fr: "Animation d'échange activée",
    es: "Animación de intercambio activada",
    th: "เปิดใช้แอนิเมชันแลกเปลี่ยน"
  },
  "label-trade-anim-sendchat": { de: "Erfolgsmeldung zusätzlich im Chat senden", en: "Also send success message in chat",
    fr: "Envoyer aussi le message de succès dans le chat",
    es: "Enviar también mensaje de éxito en el chat",
    th: "ส่งข้อความสำเร็จในแชทด้วย"
  },
  "btn-trade-anim-test": { de: "Test starten", en: "Run test",
    fr: "Lancer le test",
    es: "Ejecutar prueba",
    th: "เรียกใช้การทดสอบ"
  },
  "trade-anim-test-hint": {
    de: "Spielt die Animation einmal in OBS ab – mit zwei zufälligen Namen und Karten. Funktioniert auch, wenn die Animation noch nicht aktiviert ist.",
    en: "Plays the animation once in OBS – with two random names and cards. Works even if the animation isn't enabled yet.",
    fr: "Joue l'animation une fois dans OBS – avec deux noms et cartes aléatoires. Fonctionne même si l'animation n'est pas encore activée.",
    es: "Reproduce la animación una vez en OBS – con dos nombres y cartas aleatorios. Funciona aunque la animación aún no esté activada.",
    th: "เล่นแอนิเมชันหนึ่งครั้งใน OBS – ด้วยชื่อและการ์ดสุ่มสองชุด ใช้งานได้แม้ยังไม่ได้เปิดใช้แอนิเมชัน"
  },
  "notice-trade-test-started": { de: "Test-Animation in OBS gestartet.", en: "Test animation started in OBS.",
    fr: "Animation de test démarrée dans OBS.",
    es: "Animación de prueba iniciada en OBS.",
    th: "เริ่มแอนิเมชันทดสอบใน OBS แล้ว"
  },
  "notice-trade-test-no-cards": { de: "Keine aktiven Karten in einem Booster gefunden.", en: "No active cards found in any booster.",
    fr: "Aucune carte active trouvée dans un booster.",
    es: "No se encontraron cartas activas en ningún sobre.",
    th: "ไม่พบการ์ดที่ใช้งานอยู่ในบูสเตอร์ใดเลย"
  },
  "gift-anim-eyebrow": { de: "Geschenk", en: "Gift", fr: "Cadeau", es: "Regalo", th: "ของขวัญ" },
  "gift-anim-title": { de: "Geschenk-Animation", en: "Gift animation",
    fr: "Animation de cadeau",
    es: "Animación de regalo",
    th: "แอนิเมชันของขวัญ"
  },
  "gift-anim-hint": {
    de: "Wird abgespielt, wenn \"!gift\" erfolgreich eine Karte verschenkt (siehe Chat-Befehle → Geschenk-Befehl). Läuft über dieselbe Queue wie alle anderen Animationen, damit sich nichts überlagert.",
    en: "Plays when \"!gift\" successfully gives away a card (see Chat commands → Gift command). Runs through the same queue as every other animation so nothing overlaps.",
    fr: "Se joue lorsque \"!gift\" offre une carte avec succès (voir Commandes de chat → Commande de cadeau). Passe par la même file d'attente que toutes les autres animations pour éviter les chevauchements.",
    es: "Se reproduce cuando \"!gift\" regala una carta con éxito (ver Comandos de chat → Comando de regalo). Pasa por la misma cola que el resto de animaciones para que nada se superponga.",
    th: "เล่นเมื่อ \"!gift\" มอบการ์ดสำเร็จ (ดู คำสั่งแชท → คำสั่งของขวัญ) ทำงานผ่านคิวเดียวกับแอนิเมชันอื่น ๆ เพื่อไม่ให้ซ้อนทับกัน"
  },
  "label-gift-anim-enabled": { de: "Geschenk-Animation aktiviert", en: "Gift animation enabled",
    fr: "Animation de cadeau activée",
    es: "Animación de regalo activada",
    th: "เปิดใช้แอนิเมชันของขวัญ"
  },
  "label-gift-anim-style": { de: "Animationsstil", en: "Animation style",
    fr: "Style d'animation",
    es: "Estilo de animación",
    th: "สไตล์แอนิเมชัน"
  },
  "opt-gift-style-handover": { de: "Übergabe", en: "Handover", fr: "Remise", es: "Entrega", th: "การส่งมอบ" },
  "opt-gift-style-spin": { de: "Spin-Reveal", en: "Spin reveal", fr: "Révélation tournante", es: "Revelación giratoria", th: "เผยโฉมแบบหมุน" },
  "opt-gift-style-pixelate": { de: "Pixel-Reveal", en: "Pixelate reveal", fr: "Révélation pixelisée", es: "Revelación pixelada", th: "เผยโฉมแบบพิกเซล" },
  "btn-gift-anim-test": { de: "Test starten", en: "Run test",
    fr: "Lancer le test",
    es: "Ejecutar prueba",
    th: "เรียกใช้การทดสอบ"
  },
  "gift-anim-test-hint": {
    de: "Spielt die Animation einmal in OBS ab – mit zwei zufälligen Namen und einer zufälligen Karte. Funktioniert auch, wenn die Animation noch nicht aktiviert ist.",
    en: "Plays the animation once in OBS – with two random names and a random card. Works even if the animation isn't enabled yet.",
    fr: "Joue l'animation une fois dans OBS – avec deux noms aléatoires et une carte aléatoire. Fonctionne même si l'animation n'est pas encore activée.",
    es: "Reproduce la animación una vez en OBS – con dos nombres aleatorios y una carta aleatoria. Funciona aunque la animación aún no esté activada.",
    th: "เล่นแอนิเมชันหนึ่งครั้งใน OBS – ด้วยชื่อสุ่มสองชื่อและการ์ดสุ่มหนึ่งใบ ใช้งานได้แม้ยังไม่ได้เปิดใช้แอนิเมชัน"
  },
  "cc-gift-eyebrow": { de: "Geschenk", en: "Gift", fr: "Cadeau", es: "Regalo", th: "ของขวัญ" },
  "cc-gift-title": { de: "Geschenk-Befehl", en: "Gift command",
    fr: "Commande de cadeau",
    es: "Comando de regalo",
    th: "คำสั่งของขวัญ"
  },
  "cc-gift-hint": {
    de: "Verschenkt eine Karte einseitig an einen anderen Zuschauer: \"!gift @Empfänger Kartenname\". Die Karte wird direkt aus der eigenen Sammlung entfernt, keine Bestätigung durch den Empfänger nötig.",
    en: "Gives a card away to another viewer, one-sided: \"!gift @recipient cardName\". The card is removed from the giver's collection immediately, no confirmation from the recipient needed.",
    fr: "Offre une carte à un autre spectateur, à sens unique : \"!gift @destinataire nomDeLaCarte\". La carte est immédiatement retirée de la collection du donateur, aucune confirmation du destinataire n'est nécessaire.",
    es: "Regala una carta a otro espectador, de forma unilateral: \"!gift @destinatario nombreDeLaCarta\". La carta se elimina inmediatamente de la colección del donante, no se necesita confirmación del destinatario.",
    th: "มอบการ์ดให้ผู้ชมคนอื่นแบบทางเดียว: \"!gift @ผู้รับ ชื่อการ์ด\" การ์ดจะถูกนำออกจากคอลเลกชันของผู้ให้ทันที ไม่ต้องรอการยืนยันจากผู้รับ"
  },
  "label-cc-gift-chatoutput-enabled": { de: "Erfolgsmeldung im Chat senden", en: "Send success message in chat",
    fr: "Envoyer le message de succès dans le chat",
    es: "Enviar mensaje de éxito en el chat",
    th: "ส่งข้อความสำเร็จในแชท"
  },
  "label-cc-gift-usage": { de: "Nachricht bei falscher Nutzung", en: "Message for incorrect usage",
    fr: "Message en cas d'utilisation incorrecte",
    es: "Mensaje por uso incorrecto",
    th: "ข้อความเมื่อใช้งานผิด"
  },
  "label-cc-gift-usernotfound": { de: "Nachricht bei unbekanntem Empfänger", en: "Message for unknown recipient",
    fr: "Message pour destinataire inconnu",
    es: "Mensaje para destinatario desconocido",
    th: "ข้อความเมื่อไม่รู้จักผู้รับ"
  },
  "label-cc-gift-notfound": { de: "Nachricht bei unbekannter Karte", en: "Message for unknown card",
    fr: "Message pour carte inconnue",
    es: "Mensaje para carta desconocida",
    th: "ข้อความเมื่อไม่รู้จักการ์ด"
  },
  "label-cc-gift-notowned": { de: "Nachricht wenn Karte nicht besessen", en: "Message when the card isn't owned",
    fr: "Message si la carte n'est pas possédée",
    es: "Mensaje si la carta no se posee",
    th: "ข้อความเมื่อไม่ได้เป็นเจ้าของการ์ด"
  },
  "label-cc-gift-self": { de: "Nachricht bei Selbst-Geschenk", en: "Message for gifting yourself",
    fr: "Message pour un cadeau à soi-même",
    es: "Mensaje al regalarse a uno mismo",
    th: "ข้อความเมื่อให้ของขวัญตัวเอง"
  },
  "label-cc-gift-success": { de: "Nachricht bei Erfolg", en: "Message on success",
    fr: "Message en cas de succès",
    es: "Mensaje de éxito",
    th: "ข้อความเมื่อสำเร็จ"
  },
  "label-cc-helptext": { de: "Kurzbeschreibung (für Auto-Hilfe-Nachricht)", en: "Short description (for auto-help message)",
    fr: "Brève description (pour le message d'aide automatique)",
    es: "Descripción breve (para el mensaje de ayuda automático)",
    th: "คำอธิบายสั้น ๆ (สำหรับข้อความช่วยเหลืออัตโนมัติ)"
  },
  "cc-autohelp-eyebrow": { de: "Hilfe", en: "Help",
    fr: "Aide",
    es: "Ayuda",
    th: "ช่วยเหลือ"
  },
  "cc-autohelp-title": { de: "Automatische Hilfe-Nachricht", en: "Automatic help message",
    fr: "Message d'aide automatique",
    es: "Mensaje de ayuda automático",
    th: "ข้อความช่วยเหลืออัตโนมัติ"
  },
  "cc-autohelp-hint": {
    de: "Postet in regelmäßigen Abständen eine Übersicht aller aktivierten Befehle im Chat, damit Zuschauer wissen, was sie nutzen können. Beide Intervalle können gleichzeitig aktiv sein - was zuerst eintritt, löst die Nachricht aus (0 = deaktiviert).",
    en: "Posts an overview of all enabled commands in chat at regular intervals, so viewers know what they can use. Both intervals can be active at once - whichever comes first triggers the message (0 = disabled).",
    fr: "Publie régulièrement un aperçu de toutes les commandes activées dans le chat, pour que les spectateurs sachent ce qu'ils peuvent utiliser. Les deux intervalles peuvent être actifs en même temps - celui qui survient en premier déclenche le message (0 = désactivé).",
    es: "Publica periódicamente en el chat un resumen de todos los comandos activados, para que los espectadores sepan qué pueden usar. Ambos intervalos pueden estar activos a la vez - el que se cumpla primero dispara el mensaje (0 = desactivado).",
    th: "โพสต์ภาพรวมคำสั่งที่เปิดใช้งานทั้งหมดในแชทเป็นระยะ เพื่อให้ผู้ชมรู้ว่าใช้อะไรได้บ้าง ทั้งสองช่วงเวลาทำงานพร้อมกันได้ - อันไหนถึงก่อนจะส่งข้อความ (0 = ปิดใช้งาน)"
  },
  "cc-autohelp-list-hint": {
    de: "[Befehle] wird automatisch durch die Liste aller aktivierten Befehle mit ihrer Kurzbeschreibung ersetzt (z.B. \"!pack - zieht ein zufälliges Kartenpack | !collection - zeigt deine Kartensammlung\").",
    en: "[Befehle] is automatically replaced with the list of all enabled commands and their short description (e.g. \"!pack - draws a random card pack | !collection - shows your card collection\").",
    fr: "[Befehle] est automatiquement remplacé par la liste de toutes les commandes activées avec leur brève description (par ex. « !pack - tire un booster de cartes aléatoire | !collection - affiche ta collection de cartes »).",
    es: "[Befehle] se sustituye automáticamente por la lista de todos los comandos activados con su descripción breve (p. ej. \"!pack - saca un sobre de cartas al azar | !collection - muestra tu colección de cartas\").",
    th: "[Befehle] จะถูกแทนที่ด้วยรายการคำสั่งที่เปิดใช้งานทั้งหมดพร้อมคำอธิบายสั้น ๆ โดยอัตโนมัติ (เช่น \"!pack - สุ่มเปิดบูสเตอร์การ์ด | !collection - แสดงคอลเลกชันการ์ดของคุณ\")"
  },
  "label-autohelp-minutes": { de: "Nach X Minuten", en: "After X minutes",
    fr: "Après X minutes",
    es: "Después de X minutos",
    th: "หลังจาก X นาที"
  },
  "label-autohelp-messages": { de: "Nach X Chat-Nachrichten", en: "After X chat messages",
    fr: "Après X messages de chat",
    es: "Después de X mensajes de chat",
    th: "หลังจาก X ข้อความแชท"
  },
  "label-autohelp-message": { de: "Nachrichtentext", en: "Message text",
    fr: "Texte du message",
    es: "Texto del mensaje",
    th: "ข้อความ"
  },
  "collection-anim-eyebrow": { de: "Sammlung", en: "Collection",
    fr: "Collection",
    es: "Colección",
    th: "คอลเลกชัน"
  },
  "collection-anim-title": { de: "Sammlung-Animation", en: "Collection animation",
    fr: "Animation de collection",
    es: "Animación de colección",
    th: "แอนิเมชันคอลเลกชัน"
  },
  "collection-anim-hint": {
    de: "Legt fest, wie die Sammlungs-Anzeige (Kanalpunkte-Belohnung oder Chat-Befehl \"!collection\") in OBS aussieht.",
    en: "Sets how the collection display (channel-points reward or \"!collection\" chat command) looks in OBS.",
    fr: "Définit l'apparence de l'affichage de la collection (récompense en points de chaîne ou commande de chat « !collection ») dans OBS.",
    es: "Define cómo se ve la visualización de la colección (recompensa de puntos de canal o comando de chat \"!collection\") en OBS.",
    th: "กำหนดรูปแบบการแสดงคอลเลกชัน (รางวัลแชนแนลพอยท์หรือคำสั่งแชท \"!collection\") ใน OBS"
  },
  "label-collection-anim-enabled": {
    de: "Sammlung-Animation aktiviert", en: "Collection animation enabled",
    fr: "Animation de collection activée", es: "Animación de colección activada", th: "เปิดใช้งานแอนิเมชันคอลเลกชัน"
  },
  "collection-anim-disabled-hint": {
    de: "Bei ausgeschalteter Animation läuft weder Kanalpunkte- noch !collection-Auslösung über OBS – die Kartenlisten-Chat-Ausgabe (unter Chat Befehle → Sammlung-Befehl) läuft trotzdem unabhängig davon weiter, falls dort aktiviert.",
    en: "With the animation switched off, neither the channel-points nor the !collection trigger runs anything through OBS - the card-list chat output (under Chat Commands → collection command) still runs independently of this, if enabled there.",
    fr: "Lorsque l'animation est désactivée, ni le déclenchement par points de chaîne ni !collection ne passe par OBS - la liste de cartes envoyée dans le chat (sous Commandes de chat → commande collection) continue de fonctionner indépendamment, si elle y est activée.",
    es: "Con la animación desactivada, ni la recompensa de puntos de canal ni !collection pasan por OBS - la salida de chat con la lista de cartas (en Comandos de chat → comando de colección) sigue funcionando de forma independiente, si está activada allí.",
    th: "เมื่อปิดแอนิเมชัน ทั้งแชนแนลพอยท์และคำสั่ง !collection จะไม่ทำงานผ่าน OBS - การแสดงรายการการ์ดในแชท (ที่คำสั่งแชท → คำสั่งคอลเลกชัน) ยังคงทำงานแยกต่างหาก หากเปิดใช้งานไว้ที่นั่น"
  },
  "label-collection-anim-style": { de: "Anzeigestil", en: "Display style",
    fr: "Style d'affichage",
    es: "Estilo de visualización",
    th: "รูปแบบการแสดงผล"
  },
  "opt-collection-style-detailed": { de: "Detailliert (alle Karten)", en: "Detailed (all cards)",
    fr: "Détaillé (toutes les cartes)",
    es: "Detallado (todas las cartas)",
    th: "รายละเอียด (การ์ดทั้งหมด)"
  },
  "opt-collection-style-compact": { de: "Kompakt (nur Anzahl je Seltenheit)", en: "Compact (count per rarity only)",
    fr: "Compact (nombre par rareté uniquement)",
    es: "Compacto (solo cantidad por rareza)",
    th: "กะทัดรัด (แสดงจำนวนตามระดับความหายากเท่านั้น)"
  },
  "label-trade-anim-style": { de: "Animationsstil", en: "Animation style",
    fr: "Style d'animation",
    es: "Estilo de animación",
    th: "สไตล์แอนิเมชัน"
  },
  "label-trade-anim-duration": { de: "Dauer", en: "Duration",
    fr: "Durée",
    es: "Duración",
    th: "ระยะเวลา"
  },
  "opt-trade-style-swap": { de: "Karten-Swap (Kreuzung)", en: "Card swap (cross over)",
    fr: "Échange de cartes (croisement)",
    es: "Intercambio de cartas (cruce)",
    th: "สลับการ์ด (ไขว้)"
  },
  "opt-trade-style-arc": { de: "Übergabe-Bogen", en: "Hand-off arc",
    fr: "Arc de passation",
    es: "Arco de entrega",
    th: "ส่งผ่านโค้ง"
  },
  "opt-trade-style-flip": { de: "Versus-Flip", en: "Versus flip",
    fr: "Retournement versus",
    es: "Volteo versus",
    th: "พลิกแบบเวอร์ซัส"
  },
  "opt-trade-dur-short": { de: "Kurz (~4s)", en: "Short (~4s)",
    fr: "Courte (~4s)",
    es: "Corta (~4s)",
    th: "สั้น (~4 วิ)"
  },
  "opt-trade-dur-medium": { de: "Mittel (~6-7s)", en: "Medium (~6-7s)",
    fr: "Moyenne (~6-7s)",
    es: "Media (~6-7s)",
    th: "ปานกลาง (~6-7 วิ)"
  },
  "opt-trade-dur-long": { de: "Länger (~9s)", en: "Longer (~9s)",
    fr: "Longue (~9s)",
    es: "Larga (~9s)",
    th: "ยาว (~9 วิ)"
  },
  "label-sound-battle": { de: "Kampf-Sound", en: "Battle sound",
    fr: "Son de duel",
    es: "Sonido de duelo",
    th: "เสียงดวล"
  },
  "notice-sound-battle-saved": { de: "Kampf-Sound gespeichert.", en: "Battle sound saved.",
    fr: "Son de duel enregistré.",
    es: "Sonido de duelo guardado.",
    th: "บันทึกเสียงดวลแล้ว"
  },
  "notice-sound-battle-removed": { de: "Kampf-Sound entfernt.", en: "Battle sound removed.",
    fr: "Son de duel supprimé.",
    es: "Sonido de duelo eliminado.",
    th: "ลบเสียงดวลแล้ว"
  },
  "label-obs-battle-source": { de: "Quellenname Kampf-Animation", en: "Source name battle animation",
    fr: "Nom de source animation de duel",
    es: "Nombre de fuente de animación de duelo",
    th: "ชื่อซอร์สแอนิเมชันดวล"
  },
  "battle-anim-eyebrow": { de: "Kampf", en: "Battle",
    fr: "Duel",
    es: "Duelo",
    th: "การดวล"
  },
  "battle-anim-title": { de: "Kampf-Animation", en: "Battle animation",
    fr: "Animation de duel",
    es: "Animación de duelo",
    th: "แอนิเมชันดวล"
  },
  "battle-anim-hint": {
    de: "Bei einem Kartenduell (!battleyes) wird eine Animation in einer eigenen OBS-Quelle (battle.html) abgespielt. Quellenname & Einrichtung findest du unter „Verbindung“.",
    en: "On a card battle (!battleyes) an animation plays in its own OBS source (battle.html). Source name & setup are under “Connection”.",
    fr: "Lors d'un duel de cartes (!battleyes), une animation se joue dans sa propre source OBS (battle.html). Nom de source et configuration sous « Connexion ».",
    es: "Al ganar un duelo de cartas (!battleyes) se reproduce una animación en su propia fuente de OBS (battle.html). El nombre de fuente y la configuración están en “Conexión”.",
    th: "เมื่อดวลการ์ด (!battleyes) จะเล่นแอนิเมชันในซอร์ส OBS ของตัวเอง (battle.html) ชื่อซอร์สและการตั้งค่าอยู่ที่ \"การเชื่อมต่อ\""
  },
  "label-battle-anim-enabled": { de: "Kampf-Animation aktiviert", en: "Battle animation enabled",
    fr: "Animation de duel activée",
    es: "Animación de duelo activada",
    th: "เปิดใช้แอนิเมชันดวล"
  },
  "label-battle-anim-sendchat": { de: "Ergebnis-Nachricht zusätzlich im Chat senden", en: "Also send result message in chat",
    fr: "Envoyer aussi le message de résultat dans le chat",
    es: "Enviar también mensaje de resultado en el chat",
    th: "ส่งข้อความผลลัพธ์ในแชทด้วย"
  },
  "btn-battle-anim-test": { de: "Test starten", en: "Run test",
    fr: "Lancer le test",
    es: "Ejecutar prueba",
    th: "เรียกใช้การทดสอบ"
  },
  "battle-anim-test-hint": {
    de: "Spielt die Animation einmal in OBS ab – mit zwei zufälligen Namen und Karten. Funktioniert auch, wenn die Animation noch nicht aktiviert ist.",
    en: "Plays the animation once in OBS – with two random names and cards. Works even if the animation isn't enabled yet.",
    fr: "Joue l'animation une fois dans OBS – avec deux noms et cartes aléatoires. Fonctionne même si l'animation n'est pas encore activée.",
    es: "Reproduce la animación una vez en OBS – con dos nombres y cartas aleatorios. Funciona aunque la animación aún no esté activada.",
    th: "เล่นแอนิเมชันหนึ่งครั้งใน OBS – ด้วยชื่อและการ์ดสุ่มสองชุด ใช้งานได้แม้ยังไม่ได้เปิดใช้แอนิเมชัน"
  },
  "notice-battle-test-started": { de: "Test-Animation in OBS gestartet.", en: "Test animation started in OBS.",
    fr: "Animation de test démarrée dans OBS.",
    es: "Animación de prueba iniciada en OBS.",
    th: "เริ่มแอนิเมชันทดสอบใน OBS แล้ว"
  },
  "label-battle-anim-style": { de: "Kampfstil", en: "Combat style",
    fr: "Style de combat",
    es: "Estilo de combate",
    th: "สไตล์การต่อสู้"
  },
  "label-battle-anim-duration": { de: "Dauer", en: "Duration",
    fr: "Durée",
    es: "Duración",
    th: "ระยะเวลา"
  },
  "opt-battle-style-clash": { de: "Nahkampf-Clash", en: "Melee clash",
    fr: "Affrontement au corps à corps",
    es: "Choque cuerpo a cuerpo",
    th: "ปะทะระยะประชิด"
  },
  "opt-battle-style-ranged": { de: "Fernkampf-Projektile", en: "Ranged projectiles",
    fr: "Projectiles à distance",
    es: "Proyectiles a distancia",
    th: "โจมตีระยะไกล"
  },
  "opt-battle-style-hp": { de: "HP-Leisten-Duell", en: "HP bar duel",
    fr: "Duel en barre de PV",
    es: "Duelo con barra de HP",
    th: "ดวลด้วยแถบพลังชีวิต"
  },
  "opt-battle-dur-short": { de: "Kurz (~5s)", en: "Short (~5s)",
    fr: "Courte (~5s)",
    es: "Corta (~5s)",
    th: "สั้น (~5 วิ)"
  },
  "opt-battle-dur-medium": { de: "Mittel (~8s)", en: "Medium (~8s)",
    fr: "Moyenne (~8s)",
    es: "Media (~8s)",
    th: "ปานกลาง (~8 วิ)"
  },
  "opt-battle-dur-long": { de: "Länger (~12s)", en: "Longer (~12s)",
    fr: "Longue (~12s)",
    es: "Larga (~12s)",
    th: "ยาว (~12 วิ)"
  },
  "battle-strength-eyebrow": { de: "Kampf", en: "Battle",
    fr: "Duel",
    es: "Duelo",
    th: "การดวล"
  },
  "battle-strength-title": { de: "Kampfstärke je Seltenheit", en: "Battle strength per rarity",
    fr: "Force de combat par rareté",
    es: "Fuerza de combate por rareza",
    th: "พลังต่อสู้ตามระดับความหายาก"
  },
  "battle-strength-hint": {
    de: "Bestimmt, wie stark eine Karte im Kartenduell ist (unabhängig von den Ziehungs-Gewichten). Höherer Wert = stärker.",
    en: "Determines how strong a card is in a card battle (independent of draw weights). Higher value = stronger.",
    fr: "Détermine la force d'une carte en duel (indépendant des poids de tirage). Valeur plus élevée = plus forte.",
    es: "Determina la fuerza de una carta en un duelo (independiente de los pesos de sorteo). Valor más alto = más fuerte.",
    th: "กำหนดความแข็งแกร่งของการ์ดในการดวล (แยกจากน้ำหนักการสุ่ม) ค่าสูงกว่า = แข็งแกร่งกว่า"
  },
  "label-battle-strength-common": { de: "Gewöhnlich", en: "Common",
    fr: "Commune",
    es: "Común",
    th: "ธรรมดา"
  },
  "label-battle-strength-uncommon": { de: "Ungewöhnlich", en: "Uncommon",
    fr: "Peu commune",
    es: "Poco común",
    th: "ไม่ธรรมดา"
  },
  "label-battle-strength-rare": { de: "Selten", en: "Rare",
    fr: "Rare",
    es: "Rara",
    th: "หายาก"
  },
  "label-battle-strength-epic": { de: "Episch", en: "Epic",
    fr: "Épique",
    es: "Épica",
    th: "เอพิก"
  },
  "label-battle-strength-legendary": { de: "Legendär", en: "Legendary",
    fr: "Légendaire",
    es: "Legendaria",
    th: "ตำนาน"
  },
  "label-battle-strength-holo": { de: "Holo", en: "Holo",
    fr: "Holo",
    es: "Holo",
    th: "โฮโล"
  },
  "label-battle-strength-variance": { de: "Zufalls-Varianz", en: "Random variance",
    fr: "Variance aléatoire",
    es: "Varianza aleatoria",
    th: "ความแปรผันสุ่ม"
  },
  "label-battle-strength-hpfactor": { de: "HP-Faktor (nur HP-Leisten-Duell)", en: "HP factor (HP bar duel only)",
    fr: "Facteur de PV (duel en barre de PV uniquement)",
    es: "Factor de HP (solo duelo con barra de HP)",
    th: "ค่าคูณพลังชีวิต (เฉพาะดวลด้วยแถบพลังชีวิต)"
  },
  "error-sound-play-failed": { de: "Sound konnte nicht abgespielt werden:", en: "Sound could not be played:",
    fr: "Le son n'a pas pu être joué :",
    es: "No se pudo reproducir el sonido:",
    th: "ไม่สามารถเล่นเสียงได้:"
  },
  "notice-saved": {
    de: "Gespeichert. Das Overlay aktualisiert sich automatisch.",
    en: "Saved. The overlay updates automatically.",
    fr: "Enregistré. L'overlay se met à jour automatiquement.",
    es: "Guardado. El overlay se actualiza automáticamente.",
    th: "บันทึกแล้ว โอเวอร์เลย์จะอัปเดตอัตโนมัติ"
  },
  "notice-images-resized": {
    de: "Bestehende Karten-/Booster-Bilder wurden auf 500×700px verkleinert.",
    en: "Existing card/booster images were resized to 500×700px.",
    fr: "Les images de cartes/boosters existantes ont été redimensionnées en 500×700px.",
    es: "Las imágenes de cartas/sobres existentes se redimensionaron a 500×700px.",
    th: "รูปการ์ด/บูสเตอร์ที่มีอยู่ถูกปรับขนาดเป็น 500×700px"
  }
};

const SUPPORTED_LANGUAGES = ["de", "en", "fr", "es", "th"];

function currentLang() {
  return SUPPORTED_LANGUAGES.includes(settings?.language) ? settings.language : "de";
}

function t(key) {
  const lang = currentLang();
  return I18N[key]?.[lang] ?? I18N[key]?.en ?? I18N[key]?.de ?? key;
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

let autoSaveInFlight = false;
let autoSaveQueued = false;

let saveIndicatorHideTimer = null;

// Visible feedback for the autosave cycle: without this, the ~650ms debounce plus however long
// the actual request takes made it look like edits weren't being saved at all, especially once
// settings.json grows large with many card images.
function setSaveIndicator(state) {
  const el = $("#save-indicator");
  if (!el) return;
  clearTimeout(saveIndicatorHideTimer);
  if (!state) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.dataset.state = state;
  el.textContent = state === "saving" ? t("save-indicator-saving")
    : state === "error" ? t("save-indicator-error")
    : state === "dirty" ? t("save-indicator-dirty")
    : t("save-indicator-saved");
  // "dirty"/"saving" both persist until something else happens (a save completing, or another
  // edit) - only the terminal "saved"/"error" states auto-hide after a moment.
  if (state === "saved" || state === "error") {
    saveIndicatorHideTimer = setTimeout(() => { el.hidden = true; }, 2500);
  }
}

// Saving now only actually happens on an explicit trigger - a manual "Speichern" click, or
// switching to a different nav tab while there are unsaved changes - not on every keystroke or
// click. Constantly re-saving the full settings (worst case several MB with many card images) on
// every single edit made the app feel laggy and the save indicator flicker non-stop; there is
// also no need to persist mid-edit if the user is still on the same tab. scheduleAutoSave() is
// still called from every field listener throughout this file (dozens of call sites) - instead of
// debouncing an imminent save, it now only raises the "dirty" flag; saveIfDirty() performs the
// actual save and is called from the tab-switch handler and the manual save button.
let workspaceDirty = false;

function scheduleAutoSave() {
  if (!autoSaveReady || !settings) return;
  workspaceDirty = true;
  setSaveIndicator("dirty");
}

async function saveIfDirty() {
  if (!workspaceDirty) return;
  workspaceDirty = false;
  await runAutoSave();
}

// scheduleAutoSave() no longer starts a save itself, so the only remaining source of overlapping
// saves is the queued-retry path below (a change arriving while a save is already in flight) -
// autoSaveInFlight/autoSaveQueued still guard against that, same rationale as before: settings
// can serialize to several MB, and two overlapping in-flight copies of that string is what once
// ballooned the WebView2 heap to multiple GB.
async function runAutoSave() {
  if (autoSaveInFlight) {
    autoSaveQueued = true;
    return;
  }
  autoSaveInFlight = true;
  setSaveIndicator("saving");
  try {
    await saveSettings(settings);
    syncCommunityCounts();
    loadCommunityStats(true);
    if (!autoSaveQueued) setSaveIndicator("saved");
  } catch (error) {
    setSaveIndicator("error");
    showNotice(error.message, "error");
  } finally {
    autoSaveInFlight = false;
    if (autoSaveQueued) {
      autoSaveQueued = false;
      runAutoSave();
    }
  }
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

// ---- Card/booster export & import (plain JSON files incl. base64 images) ----

function downloadJson(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  // The anchor must be attached to the document - some engines (incl. the embedded WebView)
  // ignore programmatic clicks on detached elements.
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function exportFilename(prefix, title) {
  const safe = String(title || "export").replace(/[^\p{L}\p{N} _-]/gu, "").trim().replaceAll(" ", "-") || "export";
  return `${prefix}-${safe}.json`;
}

// Only data: image URLs survive an import - anything else (external URLs, scripts) is dropped.
function safeImportImage(value) {
  return typeof value === "string" && value.startsWith("data:image/") ? value : "";
}

function importedCardFromData(card) {
  return {
    id: createId("card"),
    title: typeof card.title === "string" && card.title.trim() ? card.title : "Importierte Karte",
    subtitle: typeof card.subtitle === "string" ? card.subtitle : "Stream Card",
    rarity: RARITIES.some((rarity) => rarity.id === card.rarity) ? card.rarity : "common",
    accent: typeof card.accent === "string" ? card.accent : "#ff78bb",
    enabled: card.enabled !== false,
    image: safeImportImage(card.image),
    // Booster assignment is deliberately NOT imported - card exports are meant to move a
    // single card between installations; the importer assigns it to a booster manually.
    boosterIds: []
  };
}

function exportCard(card) {
  const { id, boosterIds, ...portable } = card;
  downloadJson(exportFilename("karte", card.title), { type: "streamercard-card", version: 1, card: portable });
  showNotice(t("notice-card-exported"));
}

async function importCardFromFile(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { showNotice(t("error-import-invalid"), "error"); return; }
  if (data?.type !== "streamercard-card" || !data.card || typeof data.card !== "object") {
    showNotice(t("error-import-not-card"), "error");
    return;
  }
  const imported = importedCardFromData(data.card);
  settings.deck.cards.push(imported);
  selectedCardId = imported.id;
  renderCards();
  scheduleAutoSave();
  showNotice(t("notice-card-imported"));
}

function exportSelectedBooster() {
  const booster = selectedBooster();
  if (!booster) return;
  const assigned = new Set(booster.cardIds || []);
  // Card ids stay in the file so the booster->card mapping survives; they are remapped to
  // fresh ids on import. Twitch reward ids/custom events are channel-specific and stripped.
  const cards = settings.deck.cards
    .filter((card) => assigned.has(card.id))
    .map(({ boosterIds, ...portable }) => portable);
  const { rewardIds, customEvents, ...portableBooster } = booster;
  const nameParts = [booster.title, booster.subtitle].filter((part) => typeof part === "string" && part.trim());
  downloadJson(exportFilename("booster", nameParts.join("_")), { type: "streamercard-booster", version: 1, booster: portableBooster, cards });
  showNotice(t("notice-booster-exported"));
}

async function importBoosterFromFile(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { showNotice(t("error-import-invalid"), "error"); return; }
  if (data?.type !== "streamercard-booster" || !data.booster || typeof data.booster !== "object") {
    showNotice(t("error-import-not-booster"), "error");
    return;
  }
  const idMap = new Map();
  for (const card of Array.isArray(data.cards) ? data.cards : []) {
    if (!card || typeof card !== "object") continue;
    const imported = importedCardFromData(card);
    idMap.set(card.id, imported.id);
    settings.deck.cards.push(imported);
  }
  const source = data.booster;
  const booster = {
    id: createId("booster"),
    title: typeof source.title === "string" && source.title.trim() ? source.title : "Importierter Booster",
    subtitle: typeof source.subtitle === "string" ? source.subtitle : "Pack",
    image: safeImportImage(source.image),
    accent: typeof source.accent === "string" ? source.accent : "#ff78bb",
    score: Number(source.score) > 0 ? Number(source.score) : 100,
    rewardNames: Array.isArray(source.rewardNames) ? source.rewardNames.filter((name) => typeof name === "string") : [],
    rewardIds: [],
    customEvents: [],
    cardIds: (Array.isArray(source.cardIds) ? source.cardIds : []).map((id) => idMap.get(id)).filter(Boolean).slice(0, MAX_BOOSTER_CARDS)
  };
  settings.boosters.push(booster);
  selectedBoosterId = booster.id;
  hydrateBooster();
  renderCards();
  renderOverview();
  scheduleAutoSave();
  showNotice(t("notice-booster-imported"));
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

// Release notes can carry up to 5 languages in one body, delimited by invisible HTML comments
// ("<!-- DE -->", "<!-- EN -->", "<!-- FR -->", "<!-- ES -->", "<!-- TH -->" each on their own
// line) - GitHub renders those as nothing, so the release page still reads fine without the
// markers cluttering it. Picks the block matching the given language, falling back to EN then
// DE if that language's block isn't present in this particular release. Releases without any
// markers (all pre-bilingual ones) are treated as a single German block and shown as-is
// regardless of the requested language.
function extractLanguageBody(body, lang) {
  const text = String(body || "");
  const markers = ["DE", "EN", "FR", "ES", "TH"];
  const positions = markers
    .map((code) => ({ code, index: text.indexOf(`<!-- ${code} -->`) }))
    .filter((entry) => entry.index !== -1)
    .sort((a, b) => a.index - b.index);
  if (!positions.length) return text;

  const blocks = {};
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].index + `<!-- ${positions[i].code} -->`.length;
    const end = i + 1 < positions.length ? positions[i + 1].index : text.length;
    blocks[positions[i].code.toLowerCase()] = text.slice(start, end);
  }

  const wanted = String(lang || "de").toLowerCase();
  return blocks[wanted] ?? blocks.en ?? blocks.de ?? text;
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

// Cached so a later language switch (or the "show all versions" toggle) can re-render the
// changelog without hitting the GitHub API again (releases don't change while the app is open).
let cachedNewerReleases = null;
let cachedAllReleases = null;
let showingFullChangelogHistory = false;

function currentChangelogList() {
  return showingFullChangelogHistory ? cachedAllReleases : cachedNewerReleases;
}

function renderChangelog(newer) {
  const container = $("#update-changelog");
  if (!container) return;
  if (!newer.length) {
    container.innerHTML = `<p class="hint">${t("update-changelog-none")}</p>`;
    return;
  }
  container.innerHTML = newer.map((release) => {
      const groups = parseReleaseBullets(extractLanguageBody(release.body, settings.language));
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
}

async function loadChangelog() {
  const container = $("#update-changelog");
  if (!container || !appVersionInfo) return;
  container.innerHTML = `<p class="hint">${t("update-changelog-loading")}</p>`;
  try {
    const releases = await getReleases(appVersionInfo.repo);
    const all = releases
      .filter((release) => !release.draft)
      .map((release) => ({ ...release, versionNumber: String(release.tag_name || "").replace(/^v/i, "") }))
      .sort((a, b) => compareVersions(b.versionNumber, a.versionNumber));
    const newer = all.filter((release) => compareVersions(release.versionNumber, appVersionInfo.version) > 0);
    // Nothing newer than the installed version: keep showing the latest release's own
    // changelog instead of an empty "you're up to date" placeholder, so there's always
    // something to read until an actual update appears.
    cachedNewerReleases = newer.length ? newer : all.slice(0, 1);
    cachedAllReleases = all;
    renderChangelog(currentChangelogList());
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
  $("#toggle-changelog-history").addEventListener("click", () => {
    showingFullChangelogHistory = !showingFullChangelogHistory;
    $("#toggle-changelog-history").textContent = t(showingFullChangelogHistory ? "btn-show-recent-changelog" : "btn-show-all-changelog");
    if (currentChangelogList()) renderChangelog(currentChangelogList());
  });
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
      // Leaving a tab is the trigger point for persisting whatever was changed on it - see
      // scheduleAutoSave(). Only actually hits the network if something is dirty; switching tabs
      // with no pending edits is a no-op here.
      await saveIfDirty();
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
      if (button.dataset.tab === "booster" && boostersDirty) {
        boostersDirty = false;
        renderBoosters();
      }
      if (button.dataset.tab === "overview" && overviewDirty) {
        overviewDirty = false;
        renderOverview();
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
        reportTwitchConnected(result.status.broadcasterId);
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

// OBS/Meld both cache the overlay page hard, often ignoring Cache-Control and even an explicit
// "refresh cache" command (OBS) or a same-value property set (Meld, which may not re-navigate at
// all if the url string is unchanged). The one thing that reliably defeats ANY cache, regardless
// of how the browser source's engine behaves, is a URL that actually differs - so every source
// URL configured here is tagged with the installed app version. Reopening this dialog after an
// update always produces a brand-new URL, forcing a genuinely fresh load every time.
async function sourceUrl(pathname) {
  if (!appVersionInfo) {
    try { appVersionInfo = await getVersion(); } catch { appVersionInfo = null; }
  }
  const url = new URL(currentOriginUrl(pathname));
  if (appVersionInfo?.version) url.searchParams.set("v", appVersionInfo.version);
  return url.toString();
}

async function setupObsOverlay() {
  setStatus("#obs-status", t("status-setting-up-obs"), "neutral");
  let ws;
  try {
    await saveSettings(settings);
    ws = await connectObs();
    const sceneName = settings.obs?.sceneName || "Streamer Card Overlay";
    const combinedSourceName = settings.obs?.combinedSourceName || "Streamer Card Overlays";
    // ONE combined browser source hosts all animations (overlays.html). Never go back to one
    // source per animation: OBS's shared browser context allows only 6 concurrent connections
    // per host, and six sources each holding an event stream saturated that pool and stalled
    // every other request (2026-07-16).
    await applyObsBrowserSource(ws, sceneName, combinedSourceName, await sourceUrl("/overlays.html"));

    // Clean up the legacy per-animation sources (pre-combined setups); their names come from
    // the settings they were created with. Non-fatal if they're already gone.
    const legacySourceNames = [
      settings.obs?.sourceName || "Streamer Card Widget",
      settings.showcase?.sourceName || "Streamer Card Sammlung",
      settings.tradeAnimation?.sourceName || "Streamer Card Tausch",
      settings.battleAnimation?.sourceName || "Streamer Card Kampf",
      settings.ranking?.sourceName || "Streamer Card Ranking",
      settings.communityGoal?.sourceName || "Streamer Card Community-Ziel"
    ];
    for (const legacyName of legacySourceNames) {
      if (legacyName === combinedSourceName) continue;
      try { await obsRequest(ws, "RemoveInput", { inputName: legacyName }); } catch {}
    }

    setStatus("#obs-status", `${t("status-obs-updated")} ${sceneName} / ${combinedSourceName}`, "ok");
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
  // reroute_audio = "Control audio via OBS" - must be on so sound effects (pack open/reveal
  // etc.) get mixed through OBS's own audio pipeline instead of playing on the host's default
  // output device, which OBS/the stream can't capture.
  const inputSettings = { url, width: 1920, height: 1080, fps: 60, shutdown: false, restart_when_active: true, reroute_audio: true };
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
  // OBS's embedded browser caches the overlay page hard regardless of Cache-Control - without
  // this, every JS/CSS change requires the user to manually right-click the source in OBS and
  // pick "Refresh cache of current page". PressInputPropertiesButton triggers that exact button
  // remotely via obs-websocket, so clicking "erstellen/aktualisieren" here does it automatically.
  // Non-fatal: older OBS/browser-source builds may not expose this property, don't fail the sync.
  try {
    await obsRequest(ws, "PressInputPropertiesButton", { inputName: sourceName, propertyName: "refreshnocache" });
  } catch {
    // ignored - the source was still created/updated correctly above
  }
}

// ---- Meld Studio integration ----
// Meld Studio exposes a Qt QWebChannel WebSocket API (default ws://127.0.0.1:13376) that can
// only READ the current session and UPDATE existing scenes/sources - it has no "create scene"
// or "create source" call. So unlike OBS, the user must create the scene and browser sources
// once manually in Meld Studio; this just finds them by name and updates their URL, and
// switches to the configured scene.

function openMeldSocket(timeoutMs = 2800) {
  return new Promise((resolve, reject) => {
    const meld = settings.meld || {};
    const ws = new WebSocket(`ws://${meld.host || "127.0.0.1"}:${meld.port || 13376}`);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error("Timeout bei Meld Studio."));
    }, timeoutMs);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Meld Studio WebSocket nicht erreichbar."));
    });
  });
}

function connectMeld(timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    openMeldSocket().then((ws) => {
      const transport = { send: (data) => ws.send(data) };
      ws.addEventListener("message", (event) => transport.onmessage?.({ data: event.data }));
      ws.addEventListener("close", () => reject(new Error("Meld Studio hat die Verbindung geschlossen.")));
      const timer = setTimeout(() => reject(new Error("Meld Studio hat nicht rechtzeitig geantwortet.")), timeoutMs);
      // eslint-disable-next-line no-undef
      new QWebChannel(transport, (channel) => {
        clearTimeout(timer);
        if (!channel.objects.meld) {
          reject(new Error("Meld Studio API-Objekt nicht gefunden."));
          return;
        }
        resolve({ ws, meld: channel.objects.meld });
      });
    }).catch(reject);
  });
}

function findMeldItem(meld, type, name) {
  const items = meld.session?.items || {};
  for (const id of Object.keys(items)) {
    const item = items[id];
    if (item?.type === type && item?.name === name) return { id, item };
  }
  return null;
}

let lastMeldConnected = null;

async function testMeldConnection() {
  setStatus("#meld-status", t("status-testing-meld"), "neutral");
  let ws;
  try {
    const connection = await connectMeld();
    ws = connection.ws;
  } catch (error) {
    setStatus("#meld-status", `${t("error-meld-not-connected")} ${error.message}`, "error");
    setPill("#meld-pill", t("pill-meld-default"), false);
    if (lastMeldConnected !== false) addLog("meld", "error", `Meld Studio Verbindung fehlgeschlagen: ${error.message}`);
    lastMeldConnected = false;
    try { ws?.close(); } catch {}
    return;
  }
  setStatus("#meld-status", t("pill-meld-connected"), "ok");
  setPill("#meld-pill", t("pill-meld-connected"), true);
  if (lastMeldConnected !== true) addLog("meld", "info", "Meld Studio verbunden.");
  lastMeldConnected = true;
  try { ws?.close(); } catch {}
  if (settings.meld?.enabled !== true) {
    settings.meld ||= {};
    settings.meld.enabled = true;
    try {
      await saveSettings(settings);
    } catch (saveError) {
      addLog("meld", "error", `Meld-Status "aktiviert" konnte nicht gespeichert werden: ${saveError.message}`);
    }
  }
}

async function setupMeldOverlay() {
  setStatus("#meld-status", t("status-setting-up-meld"), "neutral");
  let ws;
  try {
    await saveSettings(settings);
    const connection = await connectMeld();
    ws = connection.ws;
    const meld = connection.meld;

    const sceneName = settings.meld?.sceneName || "Streamer Card Overlay";
    // ONE combined browser source hosts all animations (overlays.html) - same rationale as OBS:
    // one page = one event-stream connection, regardless of how many animation types exist.
    // Meld's API can only update existing scenes/sources, so the user creates the single
    // browser source manually once; legacy per-animation sources can simply be deleted by hand.
    const combinedSourceName = settings.meld?.combinedSourceName || "Streamer Card Overlays";

    const scene = findMeldItem(meld, "scene", sceneName);
    if (!scene) throw new Error(`${t("error-meld-scene-missing")} "${sceneName}"`);

    const layer = findMeldItem(meld, "layer", combinedSourceName);
    if (!layer) throw new Error(`${t("error-meld-source-missing")} "${combinedSourceName}"`);
    meld.setProperty(layer.id, "url", await sourceUrl("/overlays.html"));
    meld.showScene(scene.id);

    setStatus("#meld-status", `${t("status-meld-updated")} ${sceneName} / ${combinedSourceName}`, "ok");
    setPill("#meld-pill", t("pill-meld-connected"), true);
    settings.meld ||= {};
    settings.meld.enabled = true;
    await saveSettings(settings);
    showNotice(t("notice-meld-scene-updated"));
  } catch (error) {
    setStatus("#meld-status", `${t("error-meld-setup-failed")} ${error.message}`, "error");
  } finally {
    try { ws?.close(); } catch {}
  }
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
  // "#showcase-seconds" and "#cc-collection-seconds" (Chat Befehle) both read/write the same
  // settings.showcase.secondsPerBooster - keep the other input's displayed value in step.
  $("#showcase-seconds").addEventListener("input", (event) => {
    if ($("#cc-collection-seconds")) $("#cc-collection-seconds").value = event.target.value;
  });
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

async function handleTournamentRewardSync() {
  const statusEl = $("#tournament-reward-status");
  if (statusEl) statusEl.hidden = false;
  setStatus("#tournament-reward-status", t("status-showcase-saving"), "neutral");
  try {
    settings.tournament ||= {};
    await saveSettings(settings);
    const tournament = settings.tournament;
    const result = await syncTournamentReward({
      rewardId: tournament.rewardIds?.[0] || "",
      title: $("#tournament-reward-title").value || "Turnier starten",
      cost: Number($("#tournament-reward-cost").value || 1000),
      prompt: $("#tournament-reward-prompt").value || "",
      backgroundColor: $("#tournament-reward-bg-color").value || "#9147ff",
      isEnabled: $("#tournament-reward-enabled").checked,
      isPaused: $("#tournament-reward-paused").checked,
      globalCooldown: Math.max(0, Number($("#tournament-reward-cooldown").value || 0))
    });
    settings = normalizeSettings(result.settings || await getSettings());
    hydrateTrigger();
    setStatus("#tournament-reward-status", t("notice-tournament-reward-saved"), "ok");
    showNotice(t("notice-tournament-reward-saved"));
  } catch (error) {
    setStatus("#tournament-reward-status", error.message, "error");
  }
}

async function handleTournamentRewardDelete() {
  const rewardId = settings.tournament?.rewardIds?.[0];
  if (!rewardId) return;
  if (!window.confirm(t("confirm-delete-reward"))) return;
  $("#tournament-reward-status").hidden = false;
  setStatus("#tournament-reward-status", t("status-deleting-reward"), "neutral");
  try {
    const result = await deleteTwitchReward({ rewardId });
    settings = normalizeSettings(result.settings || await getSettings());
    hydrateTrigger();
    setStatus("#tournament-reward-status", t("notice-reward-deleted"), "ok");
    showNotice(t("notice-reward-deleted"));
  } catch (error) {
    setStatus("#tournament-reward-status", error.message, "error");
  }
}

function bindTournamentReward() {
  $("#tournament-reward-sync").addEventListener("click", handleTournamentRewardSync);
  $("#tournament-reward-delete").addEventListener("click", handleTournamentRewardDelete);
}

async function handleTeamBattleRewardSync() {
  const statusEl = $("#teamkampf-reward-status");
  if (statusEl) statusEl.hidden = false;
  setStatus("#teamkampf-reward-status", t("status-showcase-saving"), "neutral");
  try {
    settings.teamBattle ||= {};
    await saveSettings(settings);
    const teamBattle = settings.teamBattle;
    const result = await syncTeamBattleReward({
      rewardId: teamBattle.rewardIds?.[0] || "",
      title: $("#teamkampf-reward-title").value || "Team-Kampf starten",
      cost: Number($("#teamkampf-reward-cost").value || 2000),
      prompt: $("#teamkampf-reward-prompt").value || "",
      backgroundColor: $("#teamkampf-reward-bg-color").value || "#9147ff",
      isEnabled: $("#teamkampf-reward-enabled").checked,
      isPaused: $("#teamkampf-reward-paused").checked,
      globalCooldown: Math.max(0, Number($("#teamkampf-reward-cooldown").value || 0))
    });
    settings = normalizeSettings(result.settings || await getSettings());
    hydrateTrigger();
    setStatus("#teamkampf-reward-status", t("notice-teamkampf-reward-saved"), "ok");
    showNotice(t("notice-teamkampf-reward-saved"));
  } catch (error) {
    setStatus("#teamkampf-reward-status", error.message, "error");
  }
}

async function handleTeamBattleRewardDelete() {
  const rewardId = settings.teamBattle?.rewardIds?.[0];
  if (!rewardId) return;
  if (!window.confirm(t("confirm-delete-reward"))) return;
  $("#teamkampf-reward-status").hidden = false;
  setStatus("#teamkampf-reward-status", t("status-deleting-reward"), "neutral");
  try {
    const result = await deleteTwitchReward({ rewardId });
    settings = normalizeSettings(result.settings || await getSettings());
    hydrateTrigger();
    setStatus("#teamkampf-reward-status", t("notice-reward-deleted"), "ok");
    showNotice(t("notice-reward-deleted"));
  } catch (error) {
    setStatus("#teamkampf-reward-status", error.message, "error");
  }
}

function bindTeamBattleReward() {
  $("#teamkampf-reward-sync").addEventListener("click", handleTeamBattleRewardSync);
  $("#teamkampf-reward-delete").addEventListener("click", handleTeamBattleRewardDelete);
}

function renderOverview() {
  const booster = selectedBooster();
  const cards = booster ? cardsForBooster(settings, booster) : [];
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

function cardEditorMarkup(card, index) {
  const active = card.id === selectedCardId ? " is-selected" : "";
  return `
    <article class="card-editor${active}" data-card-id="${card.id}">
      <button class="select-card" type="button" aria-label="${t("aria-select-card")}" title="${t("aria-select-card")}" data-hint="${t("hint-select-card")}">${cardMarkup(card, { compact: true })}</button>
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
          <label class="upload-button file-label">${t("label-card-image")}<input data-action="image" type="file" accept="image/*"></label>
            <button class="ghost-button" data-action="duplicate" type="button">${t("btn-duplicate")}</button>
            <button class="ghost-button" data-action="export" type="button">${t("btn-export-card")}</button>
            <button class="danger-button" data-action="clear-image" type="button">${t("btn-remove-image")}</button>
            <button class="danger-button" data-action="delete" type="button" ${settings.deck.cards.length <= 1 ? "disabled" : ""}>${t("btn-delete")}</button>
        </div>
      </div>
      <span class="order-badge">${index + 1}</span>
    </article>
  `;
}

let cardsSortMode = "default";

// Display-only ordering - never reorders settings.deck.cards itself, so nothing that indexes
// cards by array position (insertCardEditor's "prepend new card at top" assumption, exports,
// etc.) is affected. Only the rendered order changes.
function sortedCards() {
  const cards = settings.deck.cards;
  if (cardsSortMode === "default") return cards;
  const copy = cards.slice();
  if (cardsSortMode === "name") {
    copy.sort((a, b) => (a.title || "").localeCompare(b.title || "", undefined, { sensitivity: "base" }));
  } else if (cardsSortMode === "rarity") {
    const rank = RARITIES.map((rarity) => rarity.id);
    copy.sort((a, b) => rank.indexOf(a.rarity || "common") - rank.indexOf(b.rarity || "common"));
  } else if (cardsSortMode === "booster") {
    const owner = ownerBoosterByCardId();
    copy.sort((a, b) => {
      const titleA = owner.get(a.id)?.title || "";
      const titleB = owner.get(b.id)?.title || "";
      if (!titleA && titleB) return 1;
      if (titleA && !titleB) return -1;
      return titleA.localeCompare(titleB, undefined, { sensitivity: "base" });
    });
  } else if (cardsSortMode === "status") {
    copy.sort((a, b) => Number(b.enabled !== false) - Number(a.enabled !== false));
  }
  return copy;
}

function renderCards() {
  $("#card-list").innerHTML = sortedCards().map((card, index) => cardEditorMarkup(card, index)).join("");
  refreshPreviews();
}

// Inserting a brand-new card via full renderCards() re-decodes every existing card's base64
// image markup again (cardEditorMarkup + refreshPreviews' renderBoosters/renderOverview all
// rebuild image markup for the WHOLE collection). Across ~140 cards, repeatedly clicking
// "Karte hinzufügen" without touching any existing card's DOM was still enough to balloon the
// WebView2 renderer's memory and crash it. Only prepend the new card's own node and patch the
// existing nodes' order-badge/delete-disabled state in place, leaving their <img> nodes intact.
function insertCardEditor(card) {
  // Prepending assumes the new card is displayed first, which is only true in the default
  // (insertion) order - any other sort mode needs the full (still cheap, one-off) rebuild so the
  // card lands in its actual sorted position instead of visually at the top.
  if (cardsSortMode !== "default") {
    renderCards();
    return;
  }
  const list = $("#card-list");
  list.insertAdjacentHTML("afterbegin", cardEditorMarkup(card, 0));
  const editors = list.querySelectorAll(".card-editor");
  editors.forEach((editor, index) => {
    if (index === 0) return;
    const badge = editor.querySelector(".order-badge");
    if (badge) badge.textContent = String(index + 1);
    const deleteButton = editor.querySelector("[data-action='delete']");
    if (deleteButton) deleteButton.disabled = settings.deck.cards.length <= 1;
    editor.classList.toggle("is-selected", editor.dataset.cardId === selectedCardId);
  });
  refreshPreviewsDebounced();
}

// renderBoosters()/renderOverview() rebuild <img> markup with the FULL base64 image data for
// every card/booster in the collection - with ~190 real cards each carrying an actual uploaded
// image, that's tens of MB of string churn on every single call. Rebuilding them while the user
// is busy typing in the (separate) Karten tab, where neither is even visible, was the main driver
// of the WebView2 "Out of Memory" crash: only rebuild whichever of these tabs is currently
// visible, and mark the other one dirty so it rebuilds once when the user actually switches to it.
let boostersDirty = false;
let overviewDirty = false;

function isTabActive(tabName) {
  const panel = $(`.tab-panel[data-panel="${tabName}"]`);
  return Boolean(panel && panel.classList.contains("is-active"));
}

function refreshPreviews() {
  $("#selected-card-preview").innerHTML = selectedCard() ? cardMarkup(selectedCard()) : "";
  if (isTabActive("booster")) renderBoosters();
  else boostersDirty = true;
  if (isTabActive("overview")) renderOverview();
  else overviewDirty = true;
}

let refreshPreviewsTimer = null;
// renderBoosters()/renderOverview() rebuild <img> markup (full base64 data URIs) for every card
// in the collection. Calling that on each keystroke while editing a text field - across ~140
// cards with embedded images - forces the renderer to re-decode all of them repeatedly and can
// balloon memory over a long editing session. Debounce so a burst of keystrokes only triggers
// one rebuild, matching the pattern already used for scheduleAutoSave.
function refreshPreviewsDebounced() {
  clearTimeout(refreshPreviewsTimer);
  refreshPreviewsTimer = setTimeout(refreshPreviews, 300);
}

function updateCard(cardId, field, value, inputType) {
  const card = settings.deck.cards.find((item) => item.id === cardId);
  if (!card) return;
  if (inputType === "checkbox") card[field] = Boolean(value);
  else card[field] = value;
  const editor = $(`.card-editor[data-card-id="${cardId}"]`);
  if (editor) editor.querySelector(".select-card").innerHTML = cardMarkup(card, { compact: true });
  refreshPreviewsDebounced();
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
  if (action === "export") {
    const card = settings.deck.cards.find((item) => item.id === cardId);
    if (card) exportCard(card);
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
    card.image = await compressImageDataUrl(await readFileAsDataUrl(event.target.files[0]));
    event.target.value = "";
    const editorNode = $(`.card-editor[data-card-id="${cardId}"]`);
    if (editorNode) editorNode.querySelector(".select-card").innerHTML = cardMarkup(card, { compact: true });
    refreshPreviews();
    scheduleAutoSave();
  }
}

function renderBoosterList() {
  $("#booster-list").innerHTML = settings.boosters.map((booster) => `
    <button class="booster-list-item ${booster.id === selectedBoosterId ? "is-selected" : ""} ${booster.enabled === false ? "is-disabled" : ""}" data-booster-id="${booster.id}" type="button">
      <span>${escapeHtml(booster.title)}</span>
      ${booster.subtitle ? `<span class="booster-list-subtitle">${escapeHtml(booster.subtitle)}</span>` : ""}
      <small>${(booster.cardIds || []).length}/${MAX_BOOSTER_CARDS} ${t("unit-cards")}${booster.enabled === false ? ` · ${t("label-booster-disabled-tag")}` : ""}${booster.subExclusive === true ? ` · ${t("label-booster-sub-exclusive")}` : ""}</small>
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
  $("#assigned-count").textContent = `${assigned.size}/${MAX_BOOSTER_CARDS}`;
  // Cards already assigned to a different booster are hidden entirely rather than shown
  // disabled - keeps the list short and focused on cards that could actually be picked here.
  $("#assigned-cards").innerHTML = settings.deck.cards
    .filter((card) => {
      const takenBy = owner.get(card.id);
      return !takenBy || takenBy.id === booster.id;
    })
    .map((card) => `
      <label class="assignment-tile">
        <input type="checkbox" data-card-assignment="${card.id}" ${assigned.has(card.id) ? "checked" : ""}>
        ${cardMarkup(card, { compact: true })}
        <span>${escapeHtml(card.title)}</span>
      </label>
    `).join("");
}

function renderBoosters() {
  renderBoosterList();
  renderBoosterCards();
}

function hydrateBooster() {
  const booster = selectedBooster();
  if (!booster) return;
  $("#booster-enabled").checked = booster.enabled !== false;
  $("#booster-sub-exclusive").checked = booster.subExclusive === true;
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
  $("#export-booster").addEventListener("click", exportSelectedBooster);
  $("#import-booster").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) await importBoosterFromFile(file);
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
  $("#assigned-cards").addEventListener("change", async (event) => {
    if (!event.target.matches("[data-card-assignment]")) return;
    const booster = selectedBooster();
    const cardId = event.target.dataset.cardAssignment;
    const card = settings.deck.cards.find((item) => item.id === cardId);
    const ids = new Set(booster.cardIds || []);
    if (event.target.checked) {
      if (ids.size >= MAX_BOOSTER_CARDS && !ids.has(cardId)) {
        event.target.checked = false;
        showNotice(t("warn-max-cards"), "warn");
        return;
      }
      ids.add(cardId);
      card.boosterIds ||= [];
      if (!card.boosterIds.includes(booster.id)) card.boosterIds.push(booster.id);
      // A viewer's already-owned copies of this card are still recorded under whichever
      // booster's collection file it used to belong to - without this, moving a card to a
      // new booster silently orphans everyone's existing ownership of it.
      await moveCardOwnership(cardId, booster.id);
    } else {
      ids.delete(cardId);
      if (card?.boosterIds) card.boosterIds = card.boosterIds.filter((id) => id !== booster.id);
    }
    booster.cardIds = [...ids].slice(0, MAX_BOOSTER_CARDS);
    renderBoosters();
    renderOverview();
  });
  $("#booster-enabled").addEventListener("change", (event) => {
    selectedBooster().enabled = event.target.checked;
    renderBoosterList();
    scheduleAutoSave();
  });
  $("#booster-sub-exclusive").addEventListener("change", (event) => {
    selectedBooster().subExclusive = event.target.checked;
    renderBoosterList();
    scheduleAutoSave();
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
    selectedBooster().image = await compressImageDataUrl(await readFileAsDataUrl(event.target.files[0]));
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

let pityByLogin = {};
let bitsByLogin = {};
let userStatsByLogin = {};

async function loadUsers() {
  collections = await getCollections();
  try {
    const result = await getPityState();
    pityByLogin = result.pity || {};
  } catch {
    // Best-effort - the user cards themselves are more important than the pity info.
    pityByLogin = {};
  }
  try {
    const result = await getUserStats();
    bitsByLogin = result.bits || {};
    userStatsByLogin = result.stats || {};
  } catch {
    bitsByLogin = {};
    userStatsByLogin = {};
  }
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
    const pityEntry = pityByLogin[user.key] || pityByLogin[user.key?.toLowerCase()];
    const pityHtml = settings.pity?.enabled
      ? `<span class="user-pity-info" title="${t("hint-pity-info")}">${t("label-pity-streak")} ${pityEntry?.streak ?? 0}/${settings.pity.threshold} · ${t("label-pity-bank")} ${pityEntry?.bank ?? 0}</span>`
      : "";
    const lowerKey = user.key?.toLowerCase();
    const bankedBits = bitsByLogin[user.key] ?? bitsByLogin[lowerKey];
    const bitsHtml = settings.bits?.enabled && bankedBits != null
      ? `<span class="user-stat-info" title="${t("hint-bits-banked")}">${t("label-bits-banked")} ${bankedBits}</span>`
      : "";
    const statsEntry = userStatsByLogin[user.key] || userStatsByLogin[lowerKey];
    const statsHtml = statsEntry
      ? `<span class="user-stat-info" title="${t("hint-user-stats")}">${t("label-user-stats-battle")} ${statsEntry.battleWins ?? 0}/${statsEntry.battleLosses ?? 0} (${statsEntry.battleFights ?? 0}) · ${t("label-user-stats-tournament")} ${statsEntry.tournamentWins ?? 0} · ${t("label-user-stats-teamkampf")} ${statsEntry.teamkampfWins ?? 0}/${statsEntry.teamkampfLosses ?? 0} (${statsEntry.teamkampfParticipations ?? 0})</span>`
      : "";
    return `
      <div class="user-card" data-user="${escapeHtml(user.key)}">
        <div class="user-card-header">
          <strong>${escapeHtml(user.displayName)}</strong>
          <span>${total} ${t("unit-cards")}</span>
          ${pityHtml}
          ${bitsHtml}
          ${statsHtml}
          <button class="danger-button" type="button" data-action="delete-user" data-user="${escapeHtml(user.key)}">${t("btn-delete-user")}</button>
        </div>
        <div class="user-card-cards">${rows}</div>
      </div>
    `;
  }).join("");
}

async function moveCardOwnership(cardId, newBoosterId) {
  const touchedBoosterIds = new Set();
  for (const [boosterId, collection] of Object.entries(collections || {})) {
    if (boosterId === newBoosterId || !collection?.users) continue;
    for (const [userKey, userData] of Object.entries(collection.users)) {
      const count = Number(userData?.cards?.[cardId]);
      if (!count) continue;
      collections[newBoosterId] ||= { version: collection.version || 1, boosterId: newBoosterId, users: {} };
      const target = collections[newBoosterId];
      target.users[userKey] ||= { displayName: userData.displayName || userKey, cards: {} };
      target.users[userKey].cards[cardId] = (Number(target.users[userKey].cards[cardId]) || 0) + count;
      delete userData.cards[cardId];
      touchedBoosterIds.add(boosterId);
    }
  }
  if (!touchedBoosterIds.size) return;
  touchedBoosterIds.add(newBoosterId);
  for (const boosterId of touchedBoosterIds) await persistBoosterCollection(boosterId);
  renderUsers();
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
  $("#cc-pack-helptext").value = cc.pack.helpText || "";
  $("#cc-collection-prefix").value = cc.collection.prefix || "!";
  $("#cc-collection-command").value = cc.collection.command || "collection";
  $("#cc-collection-chatoutput-enabled").checked = cc.collection.chatOutputEnabled !== false;
  $("#cc-collection-header-message").value = cc.collection.headerMessage || "";
  $("#cc-collection-empty-message").value = cc.collection.emptyMessage || "";
  cc.dust ||= {};
  $("#cc-dust-enabled").checked = cc.dust.enabled === true;
  $("#cc-dust-prefix").value = cc.dust.prefix || "!";
  $("#cc-dust-command").value = cc.dust.command || "dust";
  $("#cc-dust-usage-message").value = cc.dust.usageMessage || "";
  $("#cc-dust-notfound-message").value = cc.dust.cardNotFoundMessage || "";
  $("#cc-dust-notenough-message").value = cc.dust.notEnoughMessage || "";
  $("#cc-dust-success-message").value = cc.dust.successMessage || "";
  $("#cc-dust-helptext").value = cc.dust.helpText || "";
  cc.gift ||= {};
  $("#cc-gift-enabled").checked = cc.gift.enabled === true;
  $("#cc-gift-prefix").value = cc.gift.prefix || "!";
  $("#cc-gift-command").value = cc.gift.command || "gift";
  $("#cc-gift-chatoutput-enabled").checked = cc.gift.chatOutputEnabled !== false;
  $("#cc-gift-usage-message").value = cc.gift.usageMessage || "";
  $("#cc-gift-usernotfound-message").value = cc.gift.userNotFoundMessage || "";
  $("#cc-gift-notfound-message").value = cc.gift.cardNotFoundMessage || "";
  $("#cc-gift-notowned-message").value = cc.gift.notOwnedMessage || "";
  $("#cc-gift-self-message").value = cc.gift.selfGiftMessage || "";
  $("#cc-gift-success-message").value = cc.gift.successMessage || "";
  $("#cc-gift-helptext").value = cc.gift.helpText || "";
  // Same underlying value as "#showcase-seconds" in Kanalpunkte (settings.showcase.secondsPerBooster)
  // - the showcase overlay's page-flip timing is one setting regardless of which trigger (channel
  // point reward or chat command) started it, so both fields must always show/write the same number.
  $("#cc-collection-seconds").value = settings.showcase?.secondsPerBooster || 12;
  $("#cc-collection-helptext").value = cc.collection.helpText || "";

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
  $("#cc-trade-helptext").value = trade.helpText || "";

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
  $("#cc-battle-helptext").value = battle.helpText || "";

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
  $("#cc-ranking-helptext").value = ranking.helpText || "";

  const tournamentJoin = cc.tournamentJoin || {};
  $("#cc-tournamentjoin-enabled").checked = tournamentJoin.enabled !== false;
  $("#cc-tournamentjoin-prefix").value = tournamentJoin.prefix || "!";
  $("#cc-tournamentjoin-command").value = tournamentJoin.command || "turnier";
  $("#cc-tournamentjoin-helptext").value = tournamentJoin.helpText || "";

  const teamBattleJoin = cc.teamBattleJoin || {};
  $("#cc-teamkampfjoin-enabled").checked = teamBattleJoin.enabled !== false;
  $("#cc-teamkampfjoin-prefix").value = teamBattleJoin.prefix || "!";
  $("#cc-teamkampfjoin-command").value = teamBattleJoin.command || "teamkampf";
  $("#cc-teamkampfjoin-helptext").value = teamBattleJoin.helpText || "";

  const tournamentStart = cc.tournamentStart || {};
  $("#cc-tournamentstart-enabled").checked = tournamentStart.enabled !== false;
  $("#cc-tournamentstart-prefix").value = tournamentStart.prefix || "!";
  $("#cc-tournamentstart-command").value = tournamentStart.command || "turnierstart";
  $("#cc-tournamentstart-helptext").value = tournamentStart.helpText || "";

  const autoHelp = settings.autoHelp || {};
  $("#autohelp-enabled").checked = autoHelp.enabled === true;
  $("#autohelp-minutes").value = autoHelp.intervalMinutes ?? 30;
  $("#autohelp-messages").value = autoHelp.intervalMessages ?? 0;
  $("#autohelp-message").value = autoHelp.message || "";
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
  cc.pack.helpText = $("#cc-pack-helptext").value;
  cc.collection.prefix = $("#cc-collection-prefix").value || "!";
  cc.collection.command = $("#cc-collection-command").value.trim() || "collection";
  cc.collection.chatOutputEnabled = $("#cc-collection-chatoutput-enabled").checked;
  cc.collection.headerMessage = $("#cc-collection-header-message").value;
  cc.collection.emptyMessage = $("#cc-collection-empty-message").value;
  cc.collection.helpText = $("#cc-collection-helptext").value;

  cc.dust ||= {};
  cc.dust.enabled = $("#cc-dust-enabled").checked;
  cc.dust.prefix = $("#cc-dust-prefix").value || "!";
  cc.dust.command = $("#cc-dust-command").value.trim() || "dust";
  cc.dust.usageMessage = $("#cc-dust-usage-message").value;
  cc.dust.cardNotFoundMessage = $("#cc-dust-notfound-message").value;
  cc.dust.notEnoughMessage = $("#cc-dust-notenough-message").value;
  cc.dust.successMessage = $("#cc-dust-success-message").value;
  cc.dust.helpText = $("#cc-dust-helptext").value;

  cc.gift ||= {};
  cc.gift.enabled = $("#cc-gift-enabled").checked;
  cc.gift.prefix = $("#cc-gift-prefix").value || "!";
  cc.gift.command = $("#cc-gift-command").value.trim() || "gift";
  cc.gift.chatOutputEnabled = $("#cc-gift-chatoutput-enabled").checked;
  cc.gift.usageMessage = $("#cc-gift-usage-message").value;
  cc.gift.userNotFoundMessage = $("#cc-gift-usernotfound-message").value;
  cc.gift.cardNotFoundMessage = $("#cc-gift-notfound-message").value;
  cc.gift.notOwnedMessage = $("#cc-gift-notowned-message").value;
  cc.gift.selfGiftMessage = $("#cc-gift-self-message").value;
  cc.gift.successMessage = $("#cc-gift-success-message").value;
  cc.gift.helpText = $("#cc-gift-helptext").value;

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
  cc.trade.helpText = $("#cc-trade-helptext").value;

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
  cc.battle.helpText = $("#cc-battle-helptext").value;

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
  cc.ranking.helpText = $("#cc-ranking-helptext").value;

  cc.tournamentJoin ||= {};
  cc.tournamentJoin.enabled = $("#cc-tournamentjoin-enabled").checked;
  cc.tournamentJoin.prefix = $("#cc-tournamentjoin-prefix").value || "!";
  cc.tournamentJoin.command = $("#cc-tournamentjoin-command").value.trim() || "turnier";
  cc.tournamentJoin.helpText = $("#cc-tournamentjoin-helptext").value;

  cc.teamBattleJoin ||= {};
  cc.teamBattleJoin.enabled = $("#cc-teamkampfjoin-enabled").checked;
  cc.teamBattleJoin.prefix = $("#cc-teamkampfjoin-prefix").value || "!";
  cc.teamBattleJoin.command = $("#cc-teamkampfjoin-command").value.trim() || "teamkampf";
  cc.teamBattleJoin.helpText = $("#cc-teamkampfjoin-helptext").value;

  cc.tournamentStart ||= {};
  cc.tournamentStart.enabled = $("#cc-tournamentstart-enabled").checked;
  cc.tournamentStart.prefix = $("#cc-tournamentstart-prefix").value || "!";
  cc.tournamentStart.command = $("#cc-tournamentstart-command").value.trim() || "turnierstart";
  cc.tournamentStart.helpText = $("#cc-tournamentstart-helptext").value;

  settings.autoHelp ||= {};
  settings.autoHelp.enabled = $("#autohelp-enabled").checked;
  settings.autoHelp.intervalMinutes = Math.max(0, Math.round(Number($("#autohelp-minutes").value) || 0));
  settings.autoHelp.intervalMessages = Math.max(0, Math.round(Number($("#autohelp-messages").value) || 0));
  settings.autoHelp.message = $("#autohelp-message").value;
  scheduleAutoSave();
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

// Variable chips always insert the German token (e.g. "[Kartenname]") into the message field -
// the server matches these tokens literally (String.Replace), so they must never change. Only
// the button's visible label is translated, purely as a reading aid for non-German admins.
const VAR_CHIP_LABELS = {
  "@userName": { de: "@userName", en: "@userName", fr: "@userName", es: "@userName", th: "@userName" },
  "@userNameA": { de: "@userNameA", en: "@userNameA", fr: "@userNameA", es: "@userNameA", th: "@userNameA" },
  "@userNameB": { de: "@userNameB", en: "@userNameB", fr: "@userNameB", es: "@userNameB", th: "@userNameB" },
  "[Kartenname]": { de: "[Kartenname]", en: "[Card name]", fr: "[Nom de la carte]", es: "[Nombre de la carta]", th: "[ชื่อการ์ด]" },
  "[Boostername]": { de: "[Boostername]", en: "[Booster name]", fr: "[Nom du booster]", es: "[Nombre del sobre]", th: "[ชื่อบูสเตอร์]" },
  "[Uhrzeit]": { de: "[Uhrzeit]", en: "[Time]", fr: "[Heure]", es: "[Hora]", th: "[เวลา]" },
  "[Restzeit]": { de: "[Restzeit]", en: "[Time left]", fr: "[Temps restant]", es: "[Tiempo restante]", th: "[เวลาที่เหลือ]" },
  "[BefehlAnnehmen]": { de: "[BefehlAnnehmen]", en: "[AcceptCommand]", fr: "[CommandeAccepter]", es: "[ComandoAceptar]", th: "[คำสั่งยอมรับ]" },
  "[BefehlAblehnen]": { de: "[BefehlAblehnen]", en: "[DeclineCommand]", fr: "[CommandeRefuser]", es: "[ComandoRechazar]", th: "[คำสั่งปฏิเสธ]" },
  "[falscherName]": { de: "[falscherName]", en: "[wrong name]", fr: "[nom erroné]", es: "[nombre incorrecto]", th: "[ชื่อผิด]" },
  "[Nutzer]": { de: "[Nutzer]", en: "[User]", fr: "[Utilisateur]", es: "[Usuario]", th: "[ผู้ใช้]" },
  "[Cooldownwert]": { de: "[Cooldownwert]", en: "[Cooldown value]", fr: "[Valeur du cooldown]", es: "[Valor del cooldown]", th: "[ค่าคูลดาวน์]" },
  "[Einheit]": { de: "[Einheit]", en: "[Unit]", fr: "[Unité]", es: "[Unidad]", th: "[หน่วย]" },
  "[Zeit]": { de: "[Zeit]", en: "[Time]", fr: "[Temps]", es: "[Tiempo]", th: "[เวลา]" },
  "[Anzahl]": { de: "[Anzahl]", en: "[Count]", fr: "[Nombre]", es: "[Cantidad]", th: "[จำนวน]" },
  "[KarteA]": { de: "[KarteA]", en: "[CardA]", fr: "[CarteA]", es: "[CartaA]", th: "[การ์ดA]" },
  "[BoosterA]": { de: "[BoosterA]", en: "[BoosterA]", fr: "[BoosterA]", es: "[SobreA]", th: "[บูสเตอร์A]" },
  "[KarteB]": { de: "[KarteB]", en: "[CardB]", fr: "[CarteB]", es: "[CartaB]", th: "[การ์ดB]" },
  "[BoosterB]": { de: "[BoosterB]", en: "[BoosterB]", fr: "[BoosterB]", es: "[SobreB]", th: "[บูสเตอร์B]" },
  "[AnzahlA]": { de: "[AnzahlA]", en: "[CountA]", fr: "[NombreA]", es: "[CantidadA]", th: "[จำนวนA]" },
  "[AnzahlB]": { de: "[AnzahlB]", en: "[CountB]", fr: "[NombreB]", es: "[CantidadB]", th: "[จำนวนB]" },
  "[SiegeA]": { de: "[SiegeA]", en: "[WinsA]", fr: "[VictoiresA]", es: "[VictoriasA]", th: "[ชนะA]" },
  "[SiegeB]": { de: "[SiegeB]", en: "[WinsB]", fr: "[VictoiresB]", es: "[VictoriasB]", th: "[ชนะB]" },
  "[GewonneneKarte]": { de: "[GewonneneKarte]", en: "[Won card]", fr: "[Carte gagnée]", es: "[Carta ganada]", th: "[การ์ดที่ชนะ]" },
  "[BoosterGewonnen]": { de: "[BoosterGewonnen]", en: "[Won booster]", fr: "[Booster gagné]", es: "[Sobre ganado]", th: "[บูสเตอร์ที่ชนะ]" }
};

function translateVarChips() {
  const lang = currentLang();
  document.querySelectorAll(".var-chip[data-insert]").forEach((chip) => {
    const token = chip.dataset.insert;
    const label = VAR_CHIP_LABELS[token]?.[lang] ?? VAR_CHIP_LABELS[token]?.en ?? token;
    chip.textContent = label;
    chip.title = token === label ? "" : token;
  });
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

// Maps each message field back to its DEFAULT_MESSAGES key (render.js) so "reset all texts"
// can regenerate every suggested text in the currently selected language without touching
// command words, limits or cooldowns.
const MESSAGE_DEFAULT_MAP = [
  ["draw", "postMessage", "drawPost"],
  ["chatCommands.pack", "limitMessage", "packLimit"],
  ["chatCommands.pack", "cooldownMessage", "packCooldown"],
  ["chatCommands.pack", "successMessage", "drawPost"],
  ["chatCommands.collection", "headerMessage", "collectionHeader"],
  ["chatCommands.collection", "emptyMessage", "collectionEmpty"],
  ["chatCommands.trade", "cardNotFoundMessage", "tradeCardNotFound"],
  ["chatCommands.trade", "offerNotOwnedMessage", "tradeOfferNotOwned"],
  ["chatCommands.trade", "userNotFoundMessage", "tradeUserNotFound"],
  ["chatCommands.trade", "offerMessage", "tradeOffer"],
  ["chatCommands.trade", "timeoutMessage", "tradeTimeout"],
  ["chatCommands.trade", "cooldownMessage", "tradeCooldown"],
  ["chatCommands.trade", "limitMessage", "tradeLimit"],
  ["chatCommands.trade", "busyMessage", "tradeBusy"],
  ["chatCommands.tradeyes", "notOwnedMessage", "tradeyesNotOwned"],
  ["chatCommands.tradeyes", "successMessage", "tradeyesSuccess"],
  ["chatCommands.tradeno", "declineMessage", "tradenoDecline"],
  ["chatCommands.battle", "userNotFoundMessage", "battleUserNotFound"],
  ["chatCommands.battle", "selfChallengeMessage", "battleSelfChallenge"],
  ["chatCommands.battle", "notEnoughCardsMessage", "battleNotEnoughCards"],
  ["chatCommands.battle", "offerMessage", "battleOffer"],
  ["chatCommands.battle", "timeoutMessage", "battleTimeout"],
  ["chatCommands.battle", "cooldownMessage", "battleCooldown"],
  ["chatCommands.battle", "limitMessage", "battleLimit"],
  ["chatCommands.battle", "busyMessage", "battleBusy"],
  ["chatCommands.battleyes", "resultMessage", "battleyesResult"],
  ["chatCommands.battleno", "declineMessage", "battlenoDecline"]
];

function resetAllMessageDefaults() {
  const lang = currentLang();
  for (const [path, field, defaultKey] of MESSAGE_DEFAULT_MAP) {
    const target = path.split(".").reduce((obj, key) => (obj[key] ||= {}), settings);
    target[field] = pickDefault(lang, defaultKey);
  }
  renderAll();
  refreshSettingsPreview();
  scheduleAutoSave();
  showNotice(t("notice-messages-reset"));
}

// Highlights the jump-nav link for whichever command-card section is currently most visible,
// so it's clear where you are while scrolling a long tab instead of the nav just sitting static.
// Generic jump-nav binder: highlights whichever section is currently most visible so it's clear
// where you are while scrolling a long tab. Binds every ".cc-jump-nav" found within `root`
// independently (a tab can have more than one, e.g. Verbindung nests it inside a sub-layout).
function bindJumpNav(root) {
  for (const nav of root.querySelectorAll(".cc-jump-nav")) {
    const links = [...nav.querySelectorAll("a[href^='#']")];
    const sections = links
      .map((link) => document.getElementById(link.getAttribute("href").slice(1)))
      .filter(Boolean);
    if (!sections.length) continue;

    const setActive = (id) => {
      for (const link of links) link.classList.toggle("is-active", link.getAttribute("href") === `#${id}`);
    };

    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio);
      if (visible[0]) setActive(visible[0].target.id);
    }, { rootMargin: "-100px 0px -60% 0px", threshold: [0, .25, .5, .75, 1] });

    for (const section of sections) observer.observe(section);
    setActive(sections[0].id);
  }
}

function bindChatCommands() {
  const panel = document.querySelector('[data-panel="chatcommands"]');
  panel.addEventListener("input", readChatCommandsFromForm);
  panel.addEventListener("change", readChatCommandsFromForm);
  bindJumpNav(panel);
  $("#reset-message-defaults").addEventListener("click", () => {
    if (!window.confirm(t("confirm-reset-message-defaults"))) return;
    resetAllMessageDefaults();
  });
  // Same underlying settings.showcase.secondsPerBooster as "#showcase-seconds" in Kanalpunkte -
  // keep that field's displayed value in step.
  $("#cc-collection-seconds").addEventListener("input", (event) => {
    settings.showcase ||= {};
    settings.showcase.secondsPerBooster = Number(event.target.value);
    if ($("#showcase-seconds")) $("#showcase-seconds").value = event.target.value;
  });
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
  const tournament = settings.tournament || {};
  $("#tournament-reward-enabled").checked = tournament.rewardEnabled !== false;
  $("#tournament-reward-paused").checked = tournament.rewardPaused === true;
  $("#tournament-reward-title").value = tournament.rewardName || "Turnier starten";
  $("#tournament-reward-cost").value = tournament.rewardCost || 1000;
  $("#tournament-reward-prompt").value = tournament.rewardPrompt || "";
  $("#tournament-reward-cooldown").value = tournament.rewardGlobalCooldown || 0;
  $("#tournament-reward-bg-color").value = tournament.rewardBackgroundColor || "#9147ff";
  const teamBattle = settings.teamBattle || {};
  $("#teamkampf-reward-enabled").checked = teamBattle.rewardEnabled !== false;
  $("#teamkampf-reward-paused").checked = teamBattle.rewardPaused === true;
  $("#teamkampf-reward-title").value = teamBattle.rewardName || "Team-Kampf starten";
  $("#teamkampf-reward-cost").value = teamBattle.rewardCost || 2000;
  $("#teamkampf-reward-prompt").value = teamBattle.rewardPrompt || "";
  $("#teamkampf-reward-cooldown").value = teamBattle.rewardGlobalCooldown || 0;
  $("#teamkampf-reward-bg-color").value = teamBattle.rewardBackgroundColor || "#9147ff";
}

function bindTrigger() {
  bindJumpNav(document.querySelector('[data-panel="trigger"]'));
  bindJumpNav(document.querySelector('[data-panel="channelpoints"]'));
  $("#connect-twitch").addEventListener("click", connectTwitch);
  $("#disconnect-twitch").addEventListener("click", handleTwitchDisconnect);
  $("#refresh-twitch-status").addEventListener("click", refreshTwitchStatus);
  $("#connect-twitch-bot").addEventListener("click", connectTwitchBot);
  $("#disconnect-twitch-bot").addEventListener("click", handleBotDisconnect);
  $("#refresh-twitch-bot-status").addEventListener("click", refreshBotStatus);
  bindDrawReward();
  bindShowcase();
  bindTournamentReward();
  bindTeamBattleReward();
}

function hydrateDesign() {
  renderFontSelect();
  $("#font-family").value = settings.style.fontFamily || "";
  setSegToggle("theme-toggle", settings.style.themeMode || "light");
  $("#language-select").value = currentLang();
  $("#style-accent").value = settings.style.accentColor || "#ff78bb";
  $("#volume").value = settings.style.volume ?? 65;
  updateSoundRow("open");
  updateSoundRow("reveal");
  updateSoundRow("trade");
  updateSoundRow("battle");
  $("#show-collection").checked = settings.style.showCollection !== false;
  $("#card-borders").checked = settings.style.cardBorders !== false;
  $("#card-pattern-enabled").checked = settings.style.cardPatternEnabled !== false;
  $("#booster-pattern-enabled").checked = settings.style.boosterPatternEnabled !== false;
  $("#card-pattern-size").value = settings.style.cardPatternSize ?? 40;
  $("#booster-pattern-size").value = settings.style.boosterPatternSize ?? 40;
  $("#remove-card-pattern-image").disabled = !settings.style.cardPatternImage;
  $("#remove-booster-pattern-image").disabled = !settings.style.boosterPatternImage;
  $("#name-position").value = ["bottom", "top"].includes(settings.style.namePosition) ? settings.style.namePosition : "bottom";
  $("#card-image-fit").value = settings.style.cardImageFit || "frame";
  $("#booster-image-fit").value = settings.style.boosterImageFit || "center";
  for (const rarity of RARITIES) {
    const input = $(`#rarity-color-${rarity.id}`);
    if (input) input.value = settings.rarityColors?.[rarity.id] || DEFAULT_RARITY_COLORS[rarity.id];
    const weightInput = $(`#rarity-weight-${rarity.id}`);
    if (weightInput) weightInput.value = settings.rarityWeights?.[rarity.id] ?? DEFAULT_RARITY_WEIGHTS[rarity.id];
  }
  $("#pity-enabled").checked = settings.pity?.enabled === true;
  $("#pity-threshold").value = settings.pity?.threshold ?? 10;
  $("#pity-min-rarity").value = settings.pity?.minRarity || "rare";
  for (const rarity of RARITIES) {
    const dustInput = $(`#pity-dust-${rarity.id}`);
    if (dustInput) dustInput.value = settings.pity?.dustValues?.[rarity.id] ?? 1;
  }
  $("#subrewards-enabled").checked = settings.subRewards?.enabled !== false;
  $("#subrewards-cards-per-sub").value = settings.subRewards?.cardsPerSub ?? 1;
  $("#bits-enabled").checked = settings.bits?.enabled === true;
  $("#bits-per-draw").value = settings.bits?.bitsPerDraw ?? 100;
  $("#communitygoal-enabled").checked = settings.communityGoal?.enabled === true;
  $("#communitygoal-target").value = settings.communityGoal?.target ?? 500;
  $("#communitygoal-message").value = settings.communityGoal?.celebrationMessage || "";
  refreshCommunityGoalProgress();
  $("#tournament-enabled").checked = settings.tournament?.enabled === true;
  $("#tournament-min-participants").value = settings.tournament?.minParticipants ?? 3;
  $("#tournament-signup-seconds").value = settings.tournament?.signupSeconds ?? 90;
  $("#tournament-lineup-size").value = settings.tournament?.lineupSize ?? 3;
  $("#tournament-winner-draws").value = settings.tournament?.winnerDraws ?? 1;
  $("#tournament-announce-joins").checked = settings.tournament?.announceJoins !== false;
  $("#tournament-perround-enabled").checked = settings.tournament?.perRoundWinnerEnabled === true;
  $("#tournament-champion-draws-enabled").checked = settings.tournament?.championDrawsEnabled !== false;
  refreshTournamentStatus();
  $("#teamkampf-enabled").checked = settings.teamBattle?.enabled === true;
  $("#teamkampf-card-count").value = settings.teamBattle?.streamerCardCount ?? 5;
  $("#teamkampf-signup-seconds").value = settings.teamBattle?.signupSeconds ?? 60;
  $("#teamkampf-rewards-enabled").checked = settings.teamBattle?.rewardsEnabled !== false;
  $("#teamkampf-draws-per-participant").value = settings.teamBattle?.drawsPerParticipant ?? 1;
  $("#teamkampf-finisher-bonus-enabled").checked = settings.teamBattle?.finisherBonusEnabled !== false;
  $("#teamkampf-finisher-bonus-draws").value = settings.teamBattle?.finisherBonusDraws ?? 1;
  $("#teamkampf-lose-card-enabled").checked = settings.teamBattle?.loseCardOnDefeat === true;
  $("#teamkampf-lost-card-announce-enabled").checked = settings.teamBattle?.lostCardAnnounceEnabled !== false;
  $("#teamkampf-lost-card-message").value = settings.teamBattle?.lostCardMessage ?? "@userName hat [Kartenname] verloren.";
  $("#liveticker-enabled").checked = settings.liveTicker?.enabled !== false;
  $("#liveticker-max-entries").value = settings.liveTicker?.maxEntries ?? 8;
  $("#liveticker-speed").value = settings.liveTicker?.speed ?? 120;
  $("#liveticker-draw-message").value = settings.liveTicker?.drawMessage ?? "@userName hat [Kartenname] gezogen.";
  $("#liveticker-battle-message").value = settings.liveTicker?.battleMessage ?? "@userNameA hat gegen @userNameB gewonnen.";
  $("#liveticker-tournament-message").value = settings.liveTicker?.tournamentMessage ?? "Turnier: @userName hat gewonnen.";
  $("#liveticker-teambattle-message").value = settings.liveTicker?.teamBattleMessage ?? "Team-Kampf: [Sieger] hat gewonnen.";
  $("#reveal-seconds").value = settings.behavior.revealSeconds ?? 3.2;
  $("#cooldown-seconds").value = settings.behavior.cooldownSeconds ?? 0.8;
  $("#backs-before-reveal").value = settings.behavior.cardBacksBeforeReveal ?? 2;
  $("#obs-enabled").checked = settings.obs?.enabled === true;
  $("#obs-host").value = settings.obs?.host || "127.0.0.1";
  $("#obs-port").value = settings.obs?.port || 4455;
  $("#obs-password").value = settings.obs?.password || "";
  $("#meld-enabled").checked = settings.meld?.enabled === true;
  $("#meld-host").value = settings.meld?.host || "127.0.0.1";
  $("#meld-port").value = settings.meld?.port || 13376;
  $("#obs-scene-name").value = settings.obs?.sceneName || "Streamer Card Overlay";
  $("#obs-combined-source-name").value = settings.obs?.combinedSourceName || "Streamer Card Overlays";
  $("#trade-anim-enabled").checked = settings.tradeAnimation?.enabled === true;
  $("#trade-anim-sendchat").checked = settings.tradeAnimation?.sendChat !== false;
  $("#trade-anim-style").value = ["swap", "arc", "flip"].includes(settings.tradeAnimation?.style) ? settings.tradeAnimation.style : "swap";
  $("#trade-anim-duration").value = ["short", "medium", "long"].includes(settings.tradeAnimation?.duration) ? settings.tradeAnimation.duration : "medium";
  $("#gift-anim-enabled").checked = settings.giftAnimation?.enabled === true;
  $("#gift-anim-style").value = ["handover", "spin", "pixelate"].includes(settings.giftAnimation?.style) ? settings.giftAnimation.style : "handover";
  $("#collection-anim-enabled").checked = settings.showcase?.animationEnabled !== false;
  $("#collection-anim-style").value = settings.showcase?.style === "compact" ? "compact" : "detailed";
  $("#meld-scene-name").value = settings.meld?.sceneName || "Streamer Card Overlay";
  $("#meld-combined-source-name").value = settings.meld?.combinedSourceName || "Streamer Card Overlays";
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
  initOverlayLayoutEditors();
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
    const previewSamples = { de: "Pack Vorschau 123 ÄÖÜ", en: "Pack Preview 123", fr: "Aperçu du pack 123 éèà", es: "Vista previa 123 ñáé", th: "ตัวอย่างแพ็ก 123" };
    $("#font-preview").textContent = previewSamples[currentLang()] || previewSamples.de;
  }
  document.body.dataset.theme = settings.style?.themeMode || "light";
}

async function refreshCommunityGoalProgress() {
  const line = $("#communitygoal-progress-line");
  if (!line) return;
  try {
    const result = await getCommunityGoal();
    const goal = result.goal || {};
    line.textContent = `${goal.current ?? 0} / ${goal.target ?? 0}${goal.reached ? " – " + t("label-communitygoal-reached") : ""}`;
  } catch {
    line.textContent = "";
  }
}

async function refreshTournamentStatus() {
  const line = $("#tournament-status-line");
  if (!line) return;
  try {
    const result = await getTournamentState();
    const state = result.tournament || {};
    if (state.state === "signup") {
      line.textContent = `${t("label-tournament-state-signup")} - ${state.participantCount ?? 0} / ${state.minParticipants ?? 0}`;
    } else if (state.state === "running") {
      line.textContent = `${t("label-tournament-state-running")} (${state.participantCount ?? 0} ${t("label-tournament-participants")})`;
    } else {
      line.textContent = t("label-tournament-state-idle");
    }
  } catch {
    line.textContent = "";
  }
}

const OVERLAY_LAYOUT_CANVAS_W = 1920;
const OVERLAY_LAYOUT_CANVAS_H = 1080;
const OVERLAY_LAYOUT_PREVIEW_W = 384;
const OVERLAY_LAYOUT_PREVIEW_H = 216;

let activeLayoutDrag = null;

// Two widgets can point at the same underlying key (the tournament bracket shares the "battle"
// layout with the Kampf-Animation editor) - this keeps every widget for a key in sync, so editing
// either one immediately redraws the other instead of only updating on the next tab switch/reload.
const overlayLayoutStatesByKey = {};

// The box shown here is the animation's real content footprint (from OVERLAY_LAYOUT_NATURAL_SIZES,
// derived from its actual CSS) scaled by the "Skalierung" field - never derived from the margins
// (lockWidth keys like the live ticker are the exception: their width never scales - see
// overlayLayoutBoxSize in render.js, the single source of truth shared with applyOverlayLayout).
// The four margin fields only describe the box's position: marginLeft/marginTop are authoritative,
// marginRight/marginBottom are always kept as their mirror (canvas - opposite margin - box size) so
// typing into either side of a pair still moves the box while its size stays put.

function overlayLayoutRedrawOne(state) {
  const { key, els } = state;
  const layout = settings.overlayLayout[key] || (settings.overlayLayout[key] = {});
  const scale = Number(layout.scale) > 0 ? layout.scale : 100;
  const { w, h } = overlayLayoutBoxSize(key, scale);

  const marginLeft = Math.min(Math.max(0, layout.marginLeft || 0), Math.max(0, OVERLAY_LAYOUT_CANVAS_W - w));
  const marginTop = Math.min(Math.max(0, layout.marginTop || 0), Math.max(0, OVERLAY_LAYOUT_CANVAS_H - h));
  layout.marginLeft = marginLeft;
  layout.marginTop = marginTop;
  layout.marginRight = Math.max(0, OVERLAY_LAYOUT_CANVAS_W - marginLeft - w);
  layout.marginBottom = Math.max(0, OVERLAY_LAYOUT_CANVAS_H - marginTop - h);
  layout.scale = scale;

  const previewScale = OVERLAY_LAYOUT_PREVIEW_W / OVERLAY_LAYOUT_CANVAS_W;
  els.box.style.width = `${w * previewScale}px`;
  els.box.style.height = `${h * previewScale}px`;
  els.box.style.left = `${marginLeft * previewScale}px`;
  els.box.style.top = `${marginTop * previewScale}px`;
  const centerX = marginLeft + w / 2;
  const centerY = marginTop + h / 2;
  els.dot.style.left = `${centerX * previewScale}px`;
  els.dot.style.top = `${centerY * previewScale}px`;

  // Never stomp the field the user is actively typing into - re-clamping on every keystroke
  // (e.g. the scale field's min:10) used to snap the value back mid-type and make it impossible
  // to type a number like "70" digit by digit.
  const active = document.activeElement;
  if (active !== els.top) els.top.value = Math.round(marginTop);
  if (active !== els.right) els.right.value = Math.round(layout.marginRight);
  if (active !== els.bottom) els.bottom.value = Math.round(layout.marginBottom);
  if (active !== els.left) els.left.value = Math.round(marginLeft);
  if (active !== els.scale) els.scale.value = Math.round(scale);
}

// Redraws the widget that triggered the change, then keeps any other widget bound to the same
// key (e.g. the Turnier-Modus position editor shares "battle" with Kampf-Animation) in sync.
function overlayLayoutRedraw(state) {
  overlayLayoutRedrawOne(state);
  for (const other of overlayLayoutStatesByKey[state.key] || []) {
    if (other !== state) overlayLayoutRedrawOne(other);
  }
}

function overlayLayoutSetCenter(state, centerX, centerY) {
  const { key } = state;
  const layout = settings.overlayLayout[key];
  const { w, h } = overlayLayoutBoxSize(key, layout.scale);
  const clampedX = Math.min(Math.max(centerX, w / 2), OVERLAY_LAYOUT_CANVAS_W - w / 2);
  const clampedY = Math.min(Math.max(centerY, h / 2), OVERLAY_LAYOUT_CANVAS_H - h / 2);
  layout.marginLeft = Math.max(0, clampedX - w / 2);
  layout.marginTop = Math.max(0, clampedY - h / 2);
  overlayLayoutRedraw(state);
  scheduleAutoSave();
}

function handleLayoutDragMove(evt) {
  if (!activeLayoutDrag) return;
  evt.preventDefault();
  const point = evt.touches ? evt.touches[0] : evt;
  const rect = activeLayoutDrag.els.preview.getBoundingClientRect();
  const previewScale = OVERLAY_LAYOUT_PREVIEW_W / OVERLAY_LAYOUT_CANVAS_W;
  const x = (point.clientX - rect.left) / previewScale;
  const y = (point.clientY - rect.top) / previewScale;
  overlayLayoutSetCenter(activeLayoutDrag, x, y);
}

function handleLayoutDragEnd() {
  activeLayoutDrag = null;
}

function bindGlobalLayoutDrag() {
  document.addEventListener("mousemove", handleLayoutDragMove);
  document.addEventListener("mouseup", handleLayoutDragEnd);
  document.addEventListener("touchmove", handleLayoutDragMove, { passive: false });
  document.addEventListener("touchend", handleLayoutDragEnd);
}

function buildOverlayLayoutEditor(container, key) {
  if (!container) return;
  container.classList.add("overlay-layout-editor");
  container.innerHTML = `
    <div class="oly-grid">
      <div class="oly-field oly-top"><label>${t("label-oly-top")}</label><input type="number" min="0" step="1" data-oly="top"></div>
      <div class="oly-row">
        <div class="oly-field oly-left"><label>${t("label-oly-left")}</label><input type="number" min="0" step="1" data-oly="left"></div>
        <div class="oly-preview"><div class="oly-box"></div><div class="oly-dot"></div></div>
        <div class="oly-field oly-right"><label>${t("label-oly-right")}</label><input type="number" min="0" step="1" data-oly="right"></div>
      </div>
      <div class="oly-field oly-bottom"><label>${t("label-oly-bottom")}</label><input type="number" min="0" step="1" data-oly="bottom"></div>
    </div>
    <div class="oly-actions">
      <button type="button" class="update-button" data-oly="center">${t("btn-oly-center")}</button>
      <div class="oly-field oly-scale"><label>${t("label-oly-scale")}</label><input type="number" min="10" max="100" step="1" data-oly="scale">%</div>
    </div>
    <p class="hint">${t("hint-oly-drag")}</p>
  `;

  const els = {
    preview: container.querySelector(".oly-preview"),
    box: container.querySelector(".oly-box"),
    dot: container.querySelector(".oly-dot"),
    top: container.querySelector('[data-oly="top"]'),
    right: container.querySelector('[data-oly="right"]'),
    bottom: container.querySelector('[data-oly="bottom"]'),
    left: container.querySelector('[data-oly="left"]'),
    scale: container.querySelector('[data-oly="scale"]')
  };
  // lockWidth keys (currently just the live ticker) always span the full canvas width, so
  // left/right have nothing to move - disable them instead of leaving inert, confusing fields.
  if (OVERLAY_LAYOUT_NATURAL_SIZES[key]?.lockWidth) {
    els.left.disabled = true;
    els.right.disabled = true;
  }
  const state = { key, els };
  (overlayLayoutStatesByKey[key] ||= []).push(state);

  overlayLayoutRedraw(state);

  els.top.addEventListener("input", () => {
    settings.overlayLayout[key].marginTop = Math.max(0, Number(els.top.value) || 0);
    overlayLayoutRedraw(state);
    scheduleAutoSave();
  });
  els.left.addEventListener("input", () => {
    settings.overlayLayout[key].marginLeft = Math.max(0, Number(els.left.value) || 0);
    overlayLayoutRedraw(state);
    scheduleAutoSave();
  });
  els.right.addEventListener("input", () => {
    const layout = settings.overlayLayout[key];
    const { w } = overlayLayoutBoxSize(key, layout.scale);
    layout.marginLeft = Math.max(0, OVERLAY_LAYOUT_CANVAS_W - (Number(els.right.value) || 0) - w);
    overlayLayoutRedraw(state);
    scheduleAutoSave();
  });
  els.bottom.addEventListener("input", () => {
    const layout = settings.overlayLayout[key];
    const { h } = overlayLayoutBoxSize(key, layout.scale);
    layout.marginTop = Math.max(0, OVERLAY_LAYOUT_CANVAS_H - (Number(els.bottom.value) || 0) - h);
    overlayLayoutRedraw(state);
    scheduleAutoSave();
  });
  els.scale.addEventListener("input", () => {
    // Preserve the box's center when scale changes, so scaling feels natural instead of always
    // shrinking toward the top-left corner.
    const layout = settings.overlayLayout[key];
    const before = overlayLayoutBoxSize(key, layout.scale);
    const centerX = layout.marginLeft + before.w / 2;
    const centerY = layout.marginTop + before.h / 2;
    const value = Number(els.scale.value);
    layout.scale = value > 0 ? Math.min(100, Math.max(10, value)) : 100;
    const after = overlayLayoutBoxSize(key, layout.scale);
    layout.marginLeft = Math.max(0, centerX - after.w / 2);
    layout.marginTop = Math.max(0, centerY - after.h / 2);
    overlayLayoutRedraw(state);
    scheduleAutoSave();
  });

  container.querySelector('[data-oly="center"]').addEventListener("click", () => {
    overlayLayoutSetCenter(state, OVERLAY_LAYOUT_CANVAS_W / 2, OVERLAY_LAYOUT_CANVAS_H / 2);
  });

  els.dot.addEventListener("mousedown", (evt) => { evt.preventDefault(); activeLayoutDrag = state; });
  els.dot.addEventListener("touchstart", (evt) => { evt.preventDefault(); activeLayoutDrag = state; }, { passive: false });
  els.preview.addEventListener("mousedown", (evt) => {
    if (evt.target === els.dot) return;
    const rect = els.preview.getBoundingClientRect();
    const previewScale = OVERLAY_LAYOUT_PREVIEW_W / OVERLAY_LAYOUT_CANVAS_W;
    overlayLayoutSetCenter(state, (evt.clientX - rect.left) / previewScale, (evt.clientY - rect.top) / previewScale);
    activeLayoutDrag = state;
  });
}

let overlayLayoutDragBound = false;

function initOverlayLayoutEditors() {
  if (!overlayLayoutDragBound) {
    bindGlobalLayoutDrag();
    overlayLayoutDragBound = true;
  }
  // hydrateDesign() (and therefore this) can run again on a settings reload - drop any state from
  // a previous build so the registry doesn't accumulate references to DOM nodes that innerHTML
  // just replaced.
  for (const key of Object.keys(overlayLayoutStatesByKey)) delete overlayLayoutStatesByKey[key];
  for (const key of ["draw", "collection", "trade", "battle", "gift", "ranking", "communityGoal", "liveTicker"]) {
    buildOverlayLayoutEditor($(`#overlay-layout-${key}`), key);
  }
  // The tournament bracket renders inside the same OBS source as Kampf-Animation, so it shares
  // that "battle" layout rather than having its own key.
  buildOverlayLayoutEditor($("#overlay-layout-tournament"), "battle");
}

function bindDesign() {
  bindJumpNav(document.querySelector('[data-panel="design"]'));
  bindJumpNav(document.querySelector('[data-panel="animations"]'));
  const styleFields = {
    "#font-family": "fontFamily",
    "#style-accent": "accentColor",
    "#volume": "volume",
    "#show-collection": "showCollection",
    "#card-borders": "cardBorders",
    "#card-pattern-enabled": "cardPatternEnabled",
    "#booster-pattern-enabled": "boosterPatternEnabled",
    "#card-pattern-size": "cardPatternSize",
    "#booster-pattern-size": "boosterPatternSize",
    "#name-position": "namePosition",
    "#card-image-fit": "cardImageFit",
    "#booster-image-fit": "boosterImageFit"
  };
  for (const [selector, field] of Object.entries(styleFields)) {
    $(selector).addEventListener("input", (event) => {
      const target = event.target;
      settings.style[field] = target.type === "checkbox" ? target.checked : target.type === "range" ? Number(target.value) : target.value;
      applyTheme(settings);
      refreshSettingsPreview();
    });
  }
  $("#card-pattern-image").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    settings.style.cardPatternImage = await readFileAsDataUrl(file);
    $("#remove-card-pattern-image").disabled = false;
    applyTheme(settings);
    refreshSettingsPreview();
    scheduleAutoSave();
  });
  $("#remove-card-pattern-image").addEventListener("click", () => {
    settings.style.cardPatternImage = "";
    $("#remove-card-pattern-image").disabled = true;
    applyTheme(settings);
    refreshSettingsPreview();
    scheduleAutoSave();
  });
  $("#booster-pattern-image").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    settings.style.boosterPatternImage = await readFileAsDataUrl(file);
    $("#remove-booster-pattern-image").disabled = false;
    applyTheme(settings);
    refreshSettingsPreview();
    scheduleAutoSave();
  });
  $("#remove-booster-pattern-image").addEventListener("click", () => {
    settings.style.boosterPatternImage = "";
    $("#remove-booster-pattern-image").disabled = true;
    applyTheme(settings);
    refreshSettingsPreview();
    scheduleAutoSave();
  });
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
  $("#subrewards-enabled").addEventListener("change", (event) => {
    settings.subRewards ||= {};
    settings.subRewards.enabled = event.target.checked;
    scheduleAutoSave();
  });
  $("#subrewards-cards-per-sub").addEventListener("input", (event) => {
    settings.subRewards ||= {};
    settings.subRewards.cardsPerSub = Math.max(1, Math.round(Number(event.target.value) || 1));
    scheduleAutoSave();
  });
  $("#bits-enabled").addEventListener("change", (event) => {
    settings.bits ||= {};
    settings.bits.enabled = event.target.checked;
    scheduleAutoSave();
  });
  $("#bits-per-draw").addEventListener("input", (event) => {
    settings.bits ||= {};
    settings.bits.bitsPerDraw = Math.max(1, Math.round(Number(event.target.value) || 1));
    scheduleAutoSave();
  });
  $("#pity-enabled").addEventListener("change", (event) => {
    settings.pity ||= {};
    settings.pity.enabled = event.target.checked;
    scheduleAutoSave();
  });
  $("#pity-threshold").addEventListener("input", (event) => {
    settings.pity ||= {};
    settings.pity.threshold = Math.max(1, Math.round(Number(event.target.value) || 1));
    scheduleAutoSave();
  });
  $("#pity-min-rarity").addEventListener("change", (event) => {
    settings.pity ||= {};
    settings.pity.minRarity = event.target.value;
    scheduleAutoSave();
  });
  $$("[data-pity-dust]").forEach((input) => {
    input.addEventListener("input", (event) => {
      settings.pity ||= {};
      settings.pity.dustValues ||= {};
      settings.pity.dustValues[event.target.dataset.pityDust] = Math.max(0, Number(event.target.value) || 0);
      scheduleAutoSave();
    });
  });
  $("#communitygoal-enabled").addEventListener("change", (event) => {
    settings.communityGoal ||= {};
    settings.communityGoal.enabled = event.target.checked;
    scheduleAutoSave();
  });
  $("#communitygoal-target").addEventListener("input", (event) => {
    settings.communityGoal ||= {};
    settings.communityGoal.target = Math.max(1, Math.round(Number(event.target.value) || 1));
    scheduleAutoSave();
  });
  $("#communitygoal-message").addEventListener("input", (event) => {
    settings.communityGoal ||= {};
    settings.communityGoal.celebrationMessage = event.target.value;
    scheduleAutoSave();
  });
  $("#communitygoal-reset").addEventListener("click", async () => {
    if (!window.confirm(t("confirm-communitygoal-reset"))) return;
    await resetCommunityGoal();
    await refreshCommunityGoalProgress();
    showNotice(t("notice-communitygoal-reset"));
  });
  $("#tournament-enabled").addEventListener("change", (event) => {
    settings.tournament ||= {};
    settings.tournament.enabled = event.target.checked;
    scheduleAutoSave();
  });
  $("#tournament-min-participants").addEventListener("input", (event) => {
    settings.tournament ||= {};
    settings.tournament.minParticipants = Math.max(2, Math.round(Number(event.target.value) || 2));
    scheduleAutoSave();
  });
  $("#tournament-signup-seconds").addEventListener("input", (event) => {
    settings.tournament ||= {};
    settings.tournament.signupSeconds = Math.max(10, Math.round(Number(event.target.value) || 10));
    scheduleAutoSave();
  });
  $("#tournament-lineup-size").addEventListener("input", (event) => {
    settings.tournament ||= {};
    settings.tournament.lineupSize = Math.max(1, Math.round(Number(event.target.value) || 1));
    scheduleAutoSave();
  });
  $("#tournament-winner-draws").addEventListener("input", (event) => {
    settings.tournament ||= {};
    settings.tournament.winnerDraws = Math.max(1, Math.round(Number(event.target.value) || 1));
    scheduleAutoSave();
  });
  $("#tournament-announce-joins").addEventListener("change", (event) => {
    settings.tournament ||= {};
    settings.tournament.announceJoins = event.target.checked;
    scheduleAutoSave();
  });
  $("#tournament-perround-enabled").addEventListener("change", (event) => {
    settings.tournament ||= {};
    settings.tournament.perRoundWinnerEnabled = event.target.checked;
    scheduleAutoSave();
  });
  $("#tournament-champion-draws-enabled").addEventListener("change", (event) => {
    settings.tournament ||= {};
    settings.tournament.championDrawsEnabled = event.target.checked;
    scheduleAutoSave();
  });
  $("#tournament-start-now").addEventListener("click", async () => {
    try {
      const result = await startTournament();
      if (result.result === "already_running") showNotice(t("notice-tournament-already-running"), "error");
      else if (result.result === "disabled") showNotice(t("notice-tournament-disabled"), "error");
      else showNotice(t("notice-tournament-started"));
      await refreshTournamentStatus();
    } catch (error) {
      showNotice(error.message, "error");
    }
  });
  $("#teamkampf-enabled").addEventListener("change", (event) => {
    settings.teamBattle ||= {};
    settings.teamBattle.enabled = event.target.checked;
    scheduleAutoSave();
  });
  $("#teamkampf-card-count").addEventListener("input", (event) => {
    settings.teamBattle ||= {};
    settings.teamBattle.streamerCardCount = Math.max(1, Math.round(Number(event.target.value) || 1));
    scheduleAutoSave();
  });
  $("#teamkampf-signup-seconds").addEventListener("input", (event) => {
    settings.teamBattle ||= {};
    settings.teamBattle.signupSeconds = Math.max(10, Math.round(Number(event.target.value) || 10));
    scheduleAutoSave();
  });
  $("#teamkampf-rewards-enabled").addEventListener("change", (event) => {
    settings.teamBattle ||= {};
    settings.teamBattle.rewardsEnabled = event.target.checked;
    scheduleAutoSave();
  });
  $("#teamkampf-draws-per-participant").addEventListener("input", (event) => {
    settings.teamBattle ||= {};
    settings.teamBattle.drawsPerParticipant = Math.max(0, Math.round(Number(event.target.value) || 0));
    scheduleAutoSave();
  });
  $("#teamkampf-finisher-bonus-enabled").addEventListener("change", (event) => {
    settings.teamBattle ||= {};
    settings.teamBattle.finisherBonusEnabled = event.target.checked;
    scheduleAutoSave();
  });
  $("#teamkampf-finisher-bonus-draws").addEventListener("input", (event) => {
    settings.teamBattle ||= {};
    settings.teamBattle.finisherBonusDraws = Math.max(0, Math.round(Number(event.target.value) || 0));
    scheduleAutoSave();
  });
  $("#teamkampf-lose-card-enabled").addEventListener("change", (event) => {
    settings.teamBattle ||= {};
    settings.teamBattle.loseCardOnDefeat = event.target.checked;
    scheduleAutoSave();
  });
  $("#teamkampf-lost-card-announce-enabled").addEventListener("change", (event) => {
    settings.teamBattle ||= {};
    settings.teamBattle.lostCardAnnounceEnabled = event.target.checked;
    scheduleAutoSave();
  });
  $("#teamkampf-lost-card-message").addEventListener("input", (event) => {
    settings.teamBattle ||= {};
    settings.teamBattle.lostCardMessage = event.target.value;
    scheduleAutoSave();
  });
  $("#teamkampf-start-now").addEventListener("click", async () => {
    try {
      const result = await startTeamBattle();
      if (result.result === "already_running") showNotice(t("notice-teamkampf-already-running"), "error");
      else if (result.result === "disabled") showNotice(t("notice-teamkampf-disabled"), "error");
      else if (result.result === "no_cards") showNotice(t("notice-teamkampf-no-cards"), "error");
      else showNotice(t("notice-teamkampf-started"));
    } catch (error) {
      showNotice(error.message, "error");
    }
  });
  $("#liveticker-enabled").addEventListener("change", (event) => {
    settings.liveTicker ||= {};
    settings.liveTicker.enabled = event.target.checked;
    scheduleAutoSave();
  });
  $("#liveticker-max-entries").addEventListener("input", (event) => {
    settings.liveTicker ||= {};
    settings.liveTicker.maxEntries = Math.min(15, Math.max(2, Math.round(Number(event.target.value) || 2)));
    scheduleAutoSave();
  });
  $("#liveticker-speed").addEventListener("input", (event) => {
    settings.liveTicker ||= {};
    settings.liveTicker.speed = Math.min(400, Math.max(20, Number(event.target.value) || 20));
    scheduleAutoSave();
  });
  $("#liveticker-draw-message").addEventListener("input", (event) => {
    settings.liveTicker ||= {};
    settings.liveTicker.drawMessage = event.target.value;
    scheduleAutoSave();
  });
  $("#liveticker-battle-message").addEventListener("input", (event) => {
    settings.liveTicker ||= {};
    settings.liveTicker.battleMessage = event.target.value;
    scheduleAutoSave();
  });
  $("#liveticker-tournament-message").addEventListener("input", (event) => {
    settings.liveTicker ||= {};
    settings.liveTicker.tournamentMessage = event.target.value;
    scheduleAutoSave();
  });
  $("#liveticker-teambattle-message").addEventListener("input", (event) => {
    settings.liveTicker ||= {};
    settings.liveTicker.teamBattleMessage = event.target.value;
    scheduleAutoSave();
  });
  $("#language-select").addEventListener("change", (event) => {
    settings.language = event.target.value;
    renderAll();
    refreshSettingsPreview();
    scheduleAutoSave();
    if (currentChangelogList()) renderChangelog(currentChangelogList());
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
    "#obs-combined-source-name": ["combinedSourceName"]
  };
  for (const [selector, [field, type]] of Object.entries(obsFields)) {
    $(selector).addEventListener("input", (event) => {
      settings.obs ||= {};
      settings.obs[field] = type === "checkbox" ? event.target.checked : type === "number" ? Number(event.target.value) : event.target.value;
    });
  }
  $("#test-obs").addEventListener("click", testObsConnection);
  $("#setup-obs").addEventListener("click", setupObsOverlay);
  $("#obs-info-toggle").addEventListener("click", () => {
    const box = $("#obs-info");
    const toggle = $("#obs-info-toggle");
    const show = box.hidden;
    box.hidden = !show;
    toggle.textContent = show ? t("btn-obs-info-hide") : t("btn-obs-info");
  });
  // Meld gets its own scene/source name fields, independent of OBS - both tools can be
  // configured and run at the same time, each pointing at its own scene/source setup.
  const meldFields = {
    "#meld-enabled": ["enabled", "checkbox"],
    "#meld-host": ["host"],
    "#meld-port": ["port", "number"],
    "#meld-scene-name": ["sceneName"],
    "#meld-combined-source-name": ["combinedSourceName"]
  };
  for (const [selector, [field, type]] of Object.entries(meldFields)) {
    $(selector).addEventListener("input", (event) => {
      settings.meld ||= {};
      settings.meld[field] = type === "checkbox" ? event.target.checked : type === "number" ? Number(event.target.value) : event.target.value;
    });
  }
  $("#test-meld").addEventListener("click", testMeldConnection);
  $("#setup-meld").addEventListener("click", setupMeldOverlay);
  $("#meld-info-toggle").addEventListener("click", () => {
    const box = $("#meld-info");
    const toggle = $("#meld-info-toggle");
    const show = box.hidden;
    box.hidden = !show;
    toggle.textContent = show ? t("btn-meld-info-hide") : t("btn-meld-info");
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
  $("#gift-anim-enabled").addEventListener("change", (event) => {
    settings.giftAnimation ||= {};
    settings.giftAnimation.enabled = event.target.checked;
    scheduleAutoSave();
  });
  $("#gift-anim-style").addEventListener("change", (event) => {
    settings.giftAnimation ||= {};
    settings.giftAnimation.style = event.target.value;
    scheduleAutoSave();
  });
  $("#collection-anim-enabled").addEventListener("change", (event) => {
    settings.showcase ||= {};
    settings.showcase.animationEnabled = event.target.checked;
    scheduleAutoSave();
  });
  $("#collection-anim-style").addEventListener("change", (event) => {
    settings.showcase ||= {};
    settings.showcase.style = event.target.value;
    scheduleAutoSave();
  });
  $("#trade-anim-duration").addEventListener("change", (event) => {
    settings.tradeAnimation ||= {};
    settings.tradeAnimation.duration = event.target.value;
  });
  $("#trade-anim-test").addEventListener("click", handleTradeAnimTest);
  $("#gift-anim-test").addEventListener("click", handleGiftAnimTest);

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

async function handleGiftAnimTest() {
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
  const pick = pairs[Math.floor(Math.random() * pairs.length)];
  let fromUser = randomUsername();
  let toUser = randomUsername();
  for (let i = 0; i < 5 && toUser === fromUser; i++) toUser = randomUsername();
  try {
    await testGiftAnimation({
      fromUser,
      toUser,
      cardId: pick.card.id,
      boosterId: pick.booster.id,
      style: $("#gift-anim-style").value
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
    settings.deck.cards.unshift(card);
    selectedCardId = card.id;
    insertCardEditor(card);
  });
  $("#cards-sort").addEventListener("change", (event) => {
    cardsSortMode = event.target.value;
    renderCards();
  });
  $("#import-card").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) await importCardFromFile(file);
  });
  $("#save-settings").addEventListener("click", async () => {
    workspaceDirty = false;
    setSaveIndicator("saving");
    try {
      await saveSettings(settings);
      setSaveIndicator("saved");
      showNotice(t("notice-saved"));
      // Community stats sync is a best-effort network round trip to the VPS - don't make the
      // user wait for it before showing the save confirmation.
      syncCommunityCounts(true);
      loadCommunityStats(true);
    } catch (error) {
      setSaveIndicator("error");
      showNotice(error.message, "error");
    }
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
  $("#download-blank-template").addEventListener("click", () => {
    window.location.href = "/api/blank-card-template";
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
  bindJumpNav(document.querySelector('[data-panel="themes"]'));
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

function updateRangeFill(input) {
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  const pct = max > min ? ((Number(input.value) - min) / (max - min)) * 100 : 0;
  input.style.setProperty("--range-progress", `${pct}%`);
}

function refreshRangeFills() {
  document.querySelectorAll('input[type="range"]').forEach(updateRangeFill);
}

function renderAll() {
  // Run each step independently so one failing hydrate (e.g. a missing element after a partial
  // page load) can't abort the whole render and leave the app looking dead.
  const steps = [
    ["applyTheme", () => applyTheme(settings)],
    ["applyTranslations", applyTranslations],
    ["translateVarChips", translateVarChips],
    ["renderCards", renderCards],
    ["hydrateBooster", hydrateBooster],
    ["hydrateTrigger", hydrateTrigger],
    ["hydrateDesign", hydrateDesign],
    ["hydrateChatCommands", hydrateChatCommands],
    ["renderThemes", renderThemes],
    ["hydrateThemeEditor", hydrateThemeEditor],
    ["renderOverview", renderOverview],
    ["renderUsers", renderUsers],
    ["refreshRangeFills", refreshRangeFills]
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

// Downscales every card/booster image already stored in settings to the same 500x700 cap that
// new uploads get, one time after load. Runs in the background so startup isn't blocked; only
// triggers a re-render/save if something actually shrank (a fresh install with already-small
// images is a no-op every time it runs).
async function migrateImageSizes() {
  let changed = false;
  for (const card of settings.deck.cards) {
    if (!card.image) continue;
    const resized = await compressImageDataUrl(card.image);
    if (resized !== card.image) {
      card.image = resized;
      changed = true;
    }
  }
  for (const booster of settings.boosters) {
    if (!booster.image) continue;
    const resized = await compressImageDataUrl(booster.image);
    if (resized !== booster.image) {
      booster.image = resized;
      changed = true;
    }
  }
  if (changed) {
    renderCards();
    renderBoosterList();
    hydrateBooster();
    await saveSettings(settings);
    showNotice(t("notice-images-resized"));
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
    migrateImageSizes();
    await loadUsers();
    renderUsers();
    await hydrateUpdateTab();
    checkForUpdate({ silent: true });
    loadCommunityStats();
    autoSaveReady = true;
    $(".workspace").addEventListener("input", scheduleAutoSave);
    $(".workspace").addEventListener("input", (event) => {
      if (event.target.matches('input[type="range"]')) updateRangeFill(event.target);
    });
    $(".workspace").addEventListener("change", scheduleAutoSave);
    $(".workspace").addEventListener("click", (event) => {
      if (event.target.closest("#add-card,#add-booster,#remove-booster-image,#remove-open-sound,#remove-reveal-sound,[data-action='duplicate'],[data-action='delete'],[data-action='clear-image']")) {
        setTimeout(scheduleAutoSave, 0);
      }
    });
    await refreshTwitchStatus();
    await refreshBotStatus();
    if (settings.obs?.enabled) testObsConnection();
    if (settings.meld?.enabled) testMeldConnection();
    setInterval(refreshTwitchStatus, 20000);
    setInterval(refreshBotStatus, 20000);
    setInterval(() => {
      if (settings.obs?.enabled) testObsConnection();
      if (settings.meld?.enabled) testMeldConnection();
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
