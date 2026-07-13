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
  resetCommandUsage,
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
  MAX_BOOSTER_CARDS,
  normalizeSettings,
  pickDefault,
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
// Anonymous usage counter (Cloudflare Worker + KV, see tools/stats-worker.js). Best-effort only -
// failures here must never affect the app itself, so every call swallows its own errors.
const STATS_ENDPOINT = "https://streamercard-stats.schirmer-marco.workers.dev";

async function hashForStats(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let statsLoaded = false;
async function loadCommunityStats() {
  if (statsLoaded) return;
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
async function syncCommunityCounts() {
  if (!settings?.statsInstallId) return;
  try {
    await fetch(`${STATS_ENDPOINT}/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        installId: settings.statsInstallId,
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
const TWITCH_REQUIRED_SCOPES = "channel:read:redemptions channel:manage:redemptions user:read:chat user:write:chat";
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
    de: "Zeigt das Ranking ausschließlich in der eigenen OBS-Quelle (Verbindung → Quellenname Ranking) – es erfolgt bewusst keine Chat-Ausgabe. Bei „battle“ wechselt die Anzeige nacheinander durch: meiste Kämpfe → meiste Siege → meiste Niederlagen → beste Siegquote (je Top 5). Bei „tausch“ erscheinen die 5 User mit den meisten abgeschlossenen Tauschen. Die Anzeigedauer gilt pro Ansicht.",
    en: "Shows the ranking exclusively in its own OBS source (Connection → Ranking source name) – deliberately no chat output. For “battle” the display cycles through: most fights → most wins → most defeats → best win/loss ratio (top 5 each). For “trade” it shows the 5 users with the most completed trades. The display duration applies per view.",
    fr: "Affiche le classement uniquement dans sa propre source OBS (Connexion → Nom de la source de classement) – volontairement aucune sortie chat. Pour « duel » l'affichage défile : plus de combats → plus de victoires → plus de défaites → meilleur ratio victoires/défaites (top 5 chacun). Pour « échange » il montre les 5 utilisateurs avec le plus d'échanges terminés. La durée d'affichage s'applique par vue.",
    es: "Muestra la clasificación exclusivamente en su propia fuente de OBS (Conexión → Nombre de fuente de clasificación) – deliberadamente sin salida en el chat. Para “duelo” la vista rota entre: más combates → más victorias → más derrotas → mejor ratio victorias/derrotas (top 5 cada uno). Para “intercambio” muestra los 5 usuarios con más intercambios completados. La duración de visualización aplica por vista.",
    th: "แสดงอันดับเฉพาะในซอร์ส OBS ของตัวเอง (การเชื่อมต่อ → ชื่อซอร์สอันดับ) โดยตั้งใจไม่ส่งข้อความในแชท สำหรับ \"การดวล\" จะวนแสดง: ต่อสู้มากที่สุด → ชนะมากที่สุด → แพ้มากที่สุด → อัตราส่วนชนะ/แพ้ดีที่สุด (5 อันดับแรกแต่ละหมวด) สำหรับ \"การแลกเปลี่ยน\" จะแสดงผู้ใช้ 5 อันดับที่แลกเปลี่ยนสำเร็จมากที่สุด ระยะเวลาแสดงผลใช้ต่อหนึ่งมุมมอง"
  },
  "label-obs-ranking-source": { de: "Quellenname Ranking", en: "Source name ranking",
    fr: "Nom de source classement",
    es: "Nombre de fuente de clasificación",
    th: "ชื่อซอร์สอันดับ"
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

function scheduleAutoSave() {
  if (!autoSaveReady || !settings) return;
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(async () => {
    try {
      await saveSettings(settings);
      syncCommunityCounts();
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

// Cached so a later language switch can re-render the changelog in the new language without
// hitting the GitHub API again (releases don't change while the app is open).
let cachedNewerReleases = null;

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
    cachedNewerReleases = releases
      .filter((release) => !release.draft)
      .map((release) => ({ ...release, versionNumber: String(release.tag_name || "").replace(/^v/i, "") }))
      .filter((release) => compareVersions(release.versionNumber, appVersionInfo.version) > 0)
      .sort((a, b) => compareVersions(b.versionNumber, a.versionNumber));
    renderChangelog(cachedNewerReleases);
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
    const packSourceName = settings.obs?.sourceName || "Streamer Card Widget";
    const collectionSourceName = settings.showcase?.sourceName || "Streamer Card Sammlung";
    const tradeSourceName = settings.tradeAnimation?.sourceName || "Streamer Card Tausch";
    const battleSourceName = settings.battleAnimation?.sourceName || "Streamer Card Kampf";
    const rankingSourceName = settings.ranking?.sourceName || "Streamer Card Ranking";
    await applyObsBrowserSource(ws, sceneName, packSourceName, await sourceUrl("/overlay.html"));
    await applyObsBrowserSource(ws, sceneName, collectionSourceName, await sourceUrl("/collection.html"));
    await applyObsBrowserSource(ws, sceneName, tradeSourceName, await sourceUrl("/trade.html"));
    await applyObsBrowserSource(ws, sceneName, battleSourceName, await sourceUrl("/battle.html"));
    await applyObsBrowserSource(ws, sceneName, rankingSourceName, await sourceUrl("/ranking.html"));

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
    const sources = [
      [settings.meld?.sourceName || "Streamer Card Widget", await sourceUrl("/overlay.html")],
      [settings.meld?.collectionSourceName || "Streamer Card Sammlung", await sourceUrl("/collection.html")],
      [settings.meld?.tradeSourceName || "Streamer Card Tausch", await sourceUrl("/trade.html")],
      [settings.meld?.battleSourceName || "Streamer Card Kampf", await sourceUrl("/battle.html")],
      [settings.meld?.rankingSourceName || "Streamer Card Ranking", await sourceUrl("/ranking.html")]
    ];

    const scene = findMeldItem(meld, "scene", sceneName);
    if (!scene) throw new Error(`${t("error-meld-scene-missing")} "${sceneName}"`);

    const updatedNames = [];
    for (const [sourceName, url] of sources) {
      const layer = findMeldItem(meld, "layer", sourceName);
      if (!layer) throw new Error(`${t("error-meld-source-missing")} "${sourceName}"`);
      meld.setProperty(layer.id, "url", url);
      updatedNames.push(sourceName);
    }
    meld.showScene(scene.id);

    setStatus("#meld-status", `${t("status-meld-updated")} ${sceneName} / ${updatedNames.join(" + ")}`, "ok");
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
    <button class="booster-list-item ${booster.id === selectedBoosterId ? "is-selected" : ""} ${booster.enabled === false ? "is-disabled" : ""}" data-booster-id="${booster.id}" type="button">
      <span>${escapeHtml(booster.title)}</span>
      ${booster.subtitle ? `<span class="booster-list-subtitle">${escapeHtml(booster.subtitle)}</span>` : ""}
      <small>${(booster.cardIds || []).length}/${MAX_BOOSTER_CARDS} ${t("unit-cards")}${booster.enabled === false ? ` · ${t("label-booster-disabled-tag")}` : ""}</small>
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

function bindChatCommands() {
  const panel = document.querySelector('[data-panel="chatcommands"]');
  panel.addEventListener("input", readChatCommandsFromForm);
  panel.addEventListener("change", readChatCommandsFromForm);
  $("#reset-message-defaults").addEventListener("click", () => {
    if (!window.confirm(t("confirm-reset-message-defaults"))) return;
    resetAllMessageDefaults();
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
  $("#obs-source-name").value = settings.obs?.sourceName || "Streamer Card Widget";
  $("#obs-collection-source-name").value = settings.showcase?.sourceName || "Streamer Card Sammlung";
  $("#obs-trade-source-name").value = settings.tradeAnimation?.sourceName || "Streamer Card Tausch";
  $("#trade-anim-enabled").checked = settings.tradeAnimation?.enabled === true;
  $("#trade-anim-sendchat").checked = settings.tradeAnimation?.sendChat !== false;
  $("#trade-anim-style").value = ["swap", "arc", "flip"].includes(settings.tradeAnimation?.style) ? settings.tradeAnimation.style : "swap";
  $("#trade-anim-duration").value = ["short", "medium", "long"].includes(settings.tradeAnimation?.duration) ? settings.tradeAnimation.duration : "medium";
  $("#obs-battle-source-name").value = settings.battleAnimation?.sourceName || "Streamer Card Kampf";
  $("#obs-ranking-source-name").value = settings.ranking?.sourceName || "Streamer Card Ranking";
  $("#meld-scene-name").value = settings.meld?.sceneName || "Streamer Card Overlay";
  $("#meld-source-name").value = settings.meld?.sourceName || "Streamer Card Widget";
  $("#meld-collection-source-name").value = settings.meld?.collectionSourceName || "Streamer Card Sammlung";
  $("#meld-trade-source-name").value = settings.meld?.tradeSourceName || "Streamer Card Tausch";
  $("#meld-battle-source-name").value = settings.meld?.battleSourceName || "Streamer Card Kampf";
  $("#meld-ranking-source-name").value = settings.meld?.rankingSourceName || "Streamer Card Ranking";
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
    const previewSamples = { de: "Pack Vorschau 123 ÄÖÜ", en: "Pack Preview 123", fr: "Aperçu du pack 123 éèà", es: "Vista previa 123 ñáé", th: "ตัวอย่างแพ็ก 123" };
    $("#font-preview").textContent = previewSamples[currentLang()] || previewSamples.de;
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
  $("#language-select").addEventListener("change", (event) => {
    settings.language = event.target.value;
    renderAll();
    refreshSettingsPreview();
    scheduleAutoSave();
    if (cachedNewerReleases) renderChangelog(cachedNewerReleases);
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
  // Meld gets its own scene/source name fields, independent of OBS - both tools can be
  // configured and run at the same time, each pointing at its own scene/source setup.
  const meldFields = {
    "#meld-enabled": ["enabled", "checkbox"],
    "#meld-host": ["host"],
    "#meld-port": ["port", "number"],
    "#meld-scene-name": ["sceneName"],
    "#meld-source-name": ["sourceName"],
    "#meld-collection-source-name": ["collectionSourceName"],
    "#meld-trade-source-name": ["tradeSourceName"],
    "#meld-battle-source-name": ["battleSourceName"],
    "#meld-ranking-source-name": ["rankingSourceName"]
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
    settings.deck.cards.unshift(card);
    selectedCardId = card.id;
    renderCards();
  });
  $("#import-card").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) await importCardFromFile(file);
  });
  $("#save-settings").addEventListener("click", async () => {
    await saveSettings(settings);
    syncCommunityCounts();
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
