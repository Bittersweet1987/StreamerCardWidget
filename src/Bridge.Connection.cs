using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.WinForms;

namespace CardPackWidgetApp
{
    public sealed partial class TwitchBridge
    {
private readonly CardPackServer server;

private ClientWebSocket socket;

private CancellationTokenSource cancel;

private bool eventSubConnected;

private string lastError;

// Twitch's EventSub WebSocket has at-least-once delivery: the same notification
        // (e.g. a channel-point redemption) can arrive twice. Without de-duplication, that
        // meant a redemption could get queued and fulfilled - and its chat message sent -
        // twice. Twitch's own recommendation is to de-dupe by metadata.message_id.
        private readonly object seenMessageIdsLock = new object();

private readonly Dictionary<string, DateTime> seenMessageIds = new Dictionary<string, DateTime>();

        // Twitch's own docs say channel.subscribe "does not include resubscribes", but in practice
        // it has been observed firing anyway alongside channel.subscription.message for what is
        // really a single resub action - crediting the viewer with both a "sub" and a "resub" card
        // for one physical event. Same message_id dedup wouldn't catch this since it's two distinct
        // EventSub notifications; dedupe by login within a short window instead, mirroring
        // IsDuplicateEventSubMessage's cleanup pattern.
        private readonly object recentSubEventLock = new object();
        private readonly Dictionary<string, DateTime> recentSubEventAt = new Dictionary<string, DateTime>(StringComparer.OrdinalIgnoreCase);

private bool IsDuplicateEventSubMessage(string messageId)
        {
            if (String.IsNullOrEmpty(messageId)) return false;
            lock (seenMessageIdsLock)
            {
                DateTime cutoff = DateTime.UtcNow.AddMinutes(-10);
                var stale = new List<string>();
                foreach (KeyValuePair<string, DateTime> kv in seenMessageIds)
                {
                    if (kv.Value < cutoff) stale.Add(kv.Key);
                }
                foreach (string id in stale) seenMessageIds.Remove(id);

                if (seenMessageIds.ContainsKey(messageId)) return true;
                seenMessageIds[messageId] = DateTime.UtcNow;
                return false;
            }
        }

private readonly object stateLock = new object();

private ClientWebSocket chatSocket;

private CancellationTokenSource chatCancel;

private bool chatEventSubConnected;

private string chatLastError;

private bool chatRunning;

private string chatConfigSignature;

private readonly object queueLock = new object();

private readonly List<Dictionary<string, object>> actionQueue = new List<Dictionary<string, object>>();

// Items (draws, trades, gifts, showcases, rankings...) that were triggered WHILE a bracket
        // event (tournament / Team-Kampf) was in progress - held here instead of the live queue so
        // they can't play over the signup countdown or interrupt the bracket, then flushed into the
        // real queue the moment the whole bracket event is finished (see Enqueue/FlushDeferredQueue).
        private readonly List<Dictionary<string, object>> deferredQueue = new List<Dictionary<string, object>>();

private Dictionary<string, object> currentQueueItem;

private readonly AutoResetEvent queueSignal = new AutoResetEvent(false);

private readonly AutoResetEvent completionSignal = new AutoResetEvent(false);

private volatile string awaitingEventId;

private volatile bool queueRunning;

private volatile bool queueWorkerStarted;

private volatile bool queuePaused;

private readonly object usageLock = new object();

private Dictionary<string, object> usageData;

// ---- Pity system: guarantees a minimum rarity after N consecutive draws (any trigger)
        // that didn't reach it. Per-login state persisted independently of command-usage.json
        // (which resets on its own schedule) - pity only resets by actually landing the
        // guaranteed rarity, naturally or forced.
        //   streak: consecutive draws (any trigger) that did NOT reach the guaranteed rarity.
        //   bank: leftover "!dust"/"!dustall" points beyond what was needed to fill streak up to
        //     the threshold. Same currency as streak, so a full extra forced-guarantee draw costs
        //     a full "threshold" worth of banked points (not 1 point) - consumed threshold-at-a-
        //     time, independent of the streak/threshold cycle continuing normally.
        private readonly object pityLock = new object();

private Dictionary<string, object> pityState;

// ---- Community goal: a shared progress bar across every viewer's draws (any trigger).
        // Persisted separately from settings.json since it's runtime state, not configuration -
        // "enabled"/"target"/messages/source name live in settings.communityGoal instead.
        //   current: cumulative draws counted so far this run.
        //   reached: true once current >= target - progress freezes here until an admin resets it.
        //   participants: login -> display name of everyone who drew at least once this run, used
        //     to hand out the bonus booster to every contributor once the goal is reached.
        private readonly object communityGoalLock = new object();

private Dictionary<string, object> communityGoalState;

private const string DefaultCommunityGoalMessage = "🎉 Community-Ziel erreicht ([Ziel] Ziehungen)! Alle Teilnehmer bekommen automatisch [Karten] Bonus-Booster.";

// ---- Booster-Treue-Bonus: streak of consecutive days meeting a daily draw minimum ----

        private readonly object loyaltyLock = new object();

private const string DefaultLoyaltyBonusMessage = "@userName, Treue-Bonus! 🔥 [SerienTage] Tage in Folge - [BonusAnzahl] Bonus-Ziehung(en) unterwegs!";

private bool usageLoaded;

private System.Threading.Timer resetTimer;

private volatile bool resetTimerStarted;

private readonly object tradeLock = new object();

private Dictionary<string, object> activeTrade;

private System.Threading.Timer tradeTimeoutTimer;

private readonly object battleLock = new object();

private Dictionary<string, object> activeBattle;

private System.Threading.Timer battleTimeoutTimer;

private static readonly Random BattleRandom = new Random();

// Tournament Mode: a single global bracket (like activeBattle, only one tournament can be
        // signing up or running at a time). Unlike a normal !battle challenge, matches don't need
        // !battleyes/!battleno - joining the tournament IS the consent - so the whole bracket is
        // resolved synchronously once signup closes and its matches are fed into the existing
        // serialized action queue one after another (see ResolveTournamentSignup).
        private readonly object tournamentLock = new object();

private Dictionary<string, object> activeTournament;

private System.Threading.Timer tournamentSignupTimer;

private readonly object teamBattleLock = new object();

private Dictionary<string, object> activeTeamBattle;

private System.Threading.Timer teamBattleSignupTimer;

private const string DefaultLimitMessage = "@userName, Leider hast du das maximum an Packs aktuell erreicht. Bitte warte bis [Uhrzeit] Uhr. Dann stehen dir neue Packs zur Verfügung.";

private const string DefaultCooldownMessage = "@userName, leider musst du noch [Restzeit] Sekunden warten, bis du diesen Befehl erneut ausführen darfst.";

private const string DefaultTradeCardNotFound = "@userName, die Karte [falscherName] existiert nicht. Meintest du stattdessen [Kartenname]?";

private const string DefaultTradeOfferNotOwned = "@userName, du besitzt die Karte [Kartenname] nicht und kannst sie daher nicht anbieten.";

private const string DefaultTradeUserNotFound = "@userName, der Nutzer [Nutzer] wurde nicht gefunden.";

private const string DefaultTradeOffer = "@userNameB, dir wird ein Tausch von @userNameA der Karte [Kartenname] aus der Sammlung [Boostername] angeboten. Nimm mit [BefehlAnnehmen] \"Kartenname\" an oder lehne mit [BefehlAblehnen] ab.";

private const string DefaultTradeTimeout = "@userNameA, leider hat @userNameB nicht rechtzeitig ([Zeit] Sekunden) geantwortet. Daher wurde die Tauschanfrage beendet.";

private const string DefaultTradeCooldown = "@userName, leider musst du mit der Tauschanfrage noch bis [Uhrzeit] warten, da der Cooldown von [Cooldownwert] [Einheit] noch aktiv ist.";

private const string DefaultTradeLimit = "@userName, leider sind deine Tauschanfragen aktuell aufgebraucht. Bitte warte bis [Uhrzeit] Uhr.";

private const string DefaultTradeBusy = "@userName, es wird bereits gerade getauscht. Bitte warte bis dieser Tausch abgeschlossen wurde.";

private const string DefaultTradeDecline = "@userNameA, leider hat @userNameB deine Tauschanfrage abgelehnt, damit bleiben dir bis zum [Uhrzeit] noch [Anzahl] Tauschanfragen.";

private const string DefaultTradeNotOwned = "@userNameB, du besitzt diese Karte leider nicht. Bitte wähle eine andere.";

private const string DefaultTradeSuccess = "@userNameA tauschte seine Karte [KarteA] aus [BoosterA] erfolgreich mit @userNameB gegen Karte [KarteB] aus [BoosterB]. Damit hat @userNameA nun [AnzahlA] Karten [KarteB] und @userNameB [AnzahlB] Karten [KarteA].";

private const string DefaultDustUsage = "@userName, Nutzung: [Befehl] <Kartenname> <Anzahl>";

private const string DefaultDustCardNotFound = "@userName, die Karte [falscherName] existiert nicht. Meintest du stattdessen [Kartenname]?";

private const string DefaultDustNotEnough = "@userName, du hast nicht genug Duplikate von [Kartenname] (du besitzt [Besitz], mindestens 1 muss dir erhalten bleiben).";

private const string DefaultDustSuccess = "@userName hat [Anzahl]x [Kartenname] geopfert (+[Punkte] Garantie-Punkte). [GarantieAnzahl] garantierte Ziehung(en) bereit, noch [GarantieRest] Ziehungen bis zur naechsten.";

private const string DefaultDustSetUsage = "@userName, Nutzung: [BefehlSet] <Seltenheit> (z.B. legendär) - legt fest, bis zu welcher Seltenheit [BefehlAll] automatisch Duplikate opfert.";

private const string DefaultDustSetInvalid = "@userName, \"[Eingabe]\" ist keine bekannte Seltenheit. Gültig: Gewöhnlich, Ungewöhnlich, Selten, Episch, Legendär, Holo.";

private const string DefaultDustSetSuccess = "@userName, [BefehlAll] opfert ab jetzt automatisch alle Duplikate bis einschließlich [Seltenheit].";

private const string DefaultDustAllNothing = "@userName, du hast aktuell keine Duplikate unterhalb von [Seltenheit] zum Opfern.";

private const string DefaultDustAllSuccess = "@userName hat [Gesamtanzahl] doppelte Karten geopfert ([Aufschluesselung]), +[Punkte] Garantie-Punkte. [GarantieAnzahl] garantierte Ziehung(en) bereit, noch [GarantieRest] Ziehungen bis zur naechsten.";

private const string DefaultCompareUsage = "@userName, Nutzung: !vergleich @userNameB";

private const string DefaultCompareUserNotFound = "@userName, der Nutzer [Nutzer] wurde nicht gefunden.";

private const string DefaultCompareSelf = "@userName, du kannst dich nicht mit dir selbst vergleichen.";

private const string DefaultCompareResult = "@userNameA hat [AnzahlA] verschiedene Karten, @userNameB hat [AnzahlB]. Gemeinsam: [Gemeinsam]. Nur bei @userNameA: [ExklusivA]. Nur bei @userNameB: [ExklusivB].";

private const string DefaultGiftUsage = "@userName, Nutzung: !gift @userNameB <Kartenname>";

private const string DefaultGiftUserNotFound = "@userName, den Nutzer [Nutzer] kennt die Sammlung noch nicht.";

private const string DefaultGiftCardNotFound = "@userName, die Karte [falscherName] existiert nicht. Meintest du stattdessen [Kartenname]?";

private const string DefaultGiftNotOwned = "@userName, du besitzt [Kartenname] gar nicht.";

private const string DefaultGiftSelf = "@userName, du kannst dir nicht selbst etwas schenken.";

private const string DefaultGiftSuccess = "@userName hat [Kartenname] an @userNameB verschenkt!";

private const string DefaultSpecificPackUsage = "@userName, Nutzung: [Befehl] <Packname> - zieht eine Karte aus dem angegebenen Pack.";

private const string DefaultSpecificPackNotFound = "@userName, ein Pack namens \"[Eingabe]\" wurde nicht gefunden. Bitte den genauen Packnamen angeben.";

private const string DefaultSpecificPackRedemptionNotFound = "@userName, ein Pack namens \"[Eingabe]\" wurde nicht gefunden - deine Kanalpunkte wurden erstattet. Bitte den genauen Packnamen angeben.";

private const string DefaultShowPackUsage = "@userName, Nutzung: [Befehl] <Packname> - zeigt den Inhalt des angegebenen Packs.";

private const string DefaultShowPackNotFound = "@userName, ein Pack namens \"[Eingabe]\" wurde nicht gefunden. Bitte den genauen Packnamen angeben.";

private const string DefaultShowPackHeader = "@userName, deine Karten aus [Boostername] ([AnzahlBesessen]/[AnzahlGesamt]):";

private const string DefaultShowPackEmpty = "@userName, du besitzt noch keine Karten aus [Boostername] (0/[AnzahlGesamt]).";

private const string DefaultBattleUsage = "@userName, Nutzung: !battle @userNameB";

private const string DefaultBattleUserNotFound = "@userName, der Nutzer [Nutzer] wurde nicht gefunden.";

private const string DefaultBattleSelfChallenge = "@userName, du kannst nicht dich selbst herausfordern.";

private const string DefaultBattleNotEnoughCards = "@userName, für ein Kartenduell braucht ihr beide mindestens [Anzahl] verschiedene Karten.";

private const string DefaultBattleCooldown = "@userName, leider musst du mit der Kampfanfrage noch bis [Uhrzeit] warten, da der Cooldown von [Cooldownwert] [Einheit] noch aktiv ist.";

private const string DefaultBattleLimit = "@userName, leider sind deine Kampfanfragen aktuell aufgebraucht. Bitte warte bis [Uhrzeit] Uhr.";

private const string DefaultBattleBusy = "@userName, es läuft bereits ein Kartenduell. Bitte warte bis dieses abgeschlossen wurde.";

private const string DefaultBattleOffer = "@userNameB, @userNameA fordert dich zum Kartenduell heraus! Nimm mit [BefehlAnnehmen] an oder lehne mit [BefehlAblehnen] ab.";

private const string DefaultBattleTimeout = "@userNameA, leider hat @userNameB nicht rechtzeitig ([Zeit] Sekunden) geantwortet. Daher wurde die Duellanfrage beendet.";

private const string DefaultBattleDecline = "@userNameA, leider hat @userNameB deine Duellanfrage abgelehnt.";

private const string DefaultBattleResult = "@userNameA gewinnt das Kartenduell gegen @userNameB ([SiegeA]:[SiegeB]) und erhält die Karte [GewonneneKarte]!";

private const string DefaultTournamentSignupStart = "🏆 Turnier-Anmeldung gestartet! Tritt mit [Befehl] bei - [Sekunden] Sekunden Zeit, mindestens [Mindestteilnehmer] Teilnehmer nötig.";

private const string DefaultTournamentJoinAck = "@userName ist dem Turnier beigetreten! ([Anzahl] Teilnehmer)";

private const string DefaultTournamentNotEligible = "@userName, für die Turnier-Teilnahme brauchst du mindestens [Anzahl] verschiedene Karten.";

private const string DefaultTournamentAlreadyRunning = "@userName, es läuft bereits ein Turnier oder eine Anmeldephase.";

private const string DefaultTeamBattleBusy = "@userName, es läuft bereits ein Team-Kampf.";

private const string DefaultTeamBattleSignupStart = "Team-Kampf gestartet! Der Streamer stellt [Anzahl] Karten - tritt mit [Befehl] bei, [Sekunden] Sekunden Zeit!";

private const string DefaultTeamBattleNoActive = "@userName, gerade läuft keine Team-Kampf-Anmeldung.";

private const string DefaultTeamBattleJoinAlready = "@userName, du bist bereits angemeldet.";

private const string DefaultTeamBattleJoinNotOwned = "@userName, du besitzt noch keine Karten und kannst deshalb nicht teilnehmen.";

private const string DefaultTeamBattleJoinSuccess = "@userName ist dem Team-Kampf beigetreten! ([Anzahl] Teilnehmer)";

private const string DefaultTeamBattleNoParticipants = "Niemand hat sich für den Team-Kampf angemeldet - @streamerName tritt alleine an... gegen niemanden. Kampf abgesagt.";

private const string DefaultTeamBattleWinMessage = "Die Community hat gewonnen! Alle Teilnehmer erhalten Karten.";

private const string DefaultTeamBattleLoseMessage = "@streamerName hat gewonnen! Die Community verliert diesmal.";

private const string DefaultTeamBattleFinisherMessage = "@userName hat den entscheidenden Schlag gelandet und erhält zusätzlich [Anzahl]x Kartenpack-Ziehung!";

private const string DefaultTeamBattleFinisherMessageNoBonus = "@userName hat den entscheidenden Schlag gelandet!";

private const string DefaultTeamBattleLostCardMessage = "@userName hat [Kartenname] verloren.";

private const string DefaultTeamBattlePerDefeatMessage = "@userName hat [AnzahlBesiegt] gegnerische Karte(n) besiegt und erhält dafür [Anzahl] Kartenpack-Ziehung(en)!";

private const string DefaultTeamBattlePerDefeatAllMessage = "Insgesamt wurden [AnzahlBesiegt] gegnerische Karte(n) besiegt - jeder Teilnehmer erhält dafür [Anzahl] Kartenpack-Ziehung(en)!";

private const string DefaultTournamentCancel = "Das Turnier wurde abgesagt - nur [Anzahl] von mindestens [Mindestteilnehmer] nötigen Teilnehmern haben sich angemeldet.";

private const string DefaultTournamentRoundAnnounce = "🏆 Turnier [Runde]: [SpielerA] vs [SpielerB]!";

private const string DefaultTournamentByeAnnounce = "🏆 Turnier [Runde]: [Spieler] hat ein Freilos und zieht kampflos weiter!";

private const string DefaultTournamentWinnerAnnounce = "🏆 @userName gewinnt das Turnier mit [Teilnehmerzahl] Teilnehmern und erhält [Anzahl]x Kartenpack-Ziehung!";

private const string DefaultLiveTickerDrawMessage = "@userName hat [Kartenname] gezogen.";

private const string DefaultLiveTickerBattleMessage = "@userNameA hat gegen @userNameB gewonnen.";

private const string DefaultLiveTickerTournamentMessage = "Turnier: @userName hat gewonnen.";

private const string DefaultLiveTickerTeamBattleMessage = "Team-Kampf: [Sieger] hat gewonnen.";

private const string DefaultCardsEmpty = "@userName, du besitzt noch keine Karten.";

private const string DefaultCardsHeader = "@userName, deine Karten:";

private const string DefaultPacksHeader = "@userName, verfügbare Booster:";

private const string DefaultPacksEmpty = "@userName, aktuell ist kein Booster verfügbar.";

private const string DefaultPacksSubOnlyLabel = "Sub Only";

private const string DefaultIrlModeOnMessage = "📵 IRL-Modus aktiviert - bis auf das Pack-Öffnen sind alle Befehle, Kanalpunkte und Overlays pausiert.";

private const string DefaultIrlModeOffMessage = "✅ IRL-Modus deaktiviert - alle Funktionen sind wieder aktiv.";

private const double DefaultBattleVariance = 0.6;

public TwitchBridge(CardPackServer server)
        {
            this.server = server;
            liveTickerHistory.AddRange(server.LoadLiveTickerHistory());
        }

public void Start()
        {
            StartQueueWorkerOnce();
            LoadPendingState();
            StartResetTimerOnce();
            StartAutoHelpTimerOnce();
            StartTeamBattleAutoStartTimerOnce();
            // If IRL mode was already on when the app was last closed, make sure the non-pack
            // rewards actually come back up paused on Twitch's side too - lastKnownIrlModeEnabled
            // starts unset, so this always runs once on startup regardless of the stored value.
            SyncIrlRewardPauseIfChanged();
            Dictionary<string, object> twitch = TwitchSettings();
            if (!String.IsNullOrWhiteSpace(GetString(twitch, "accessToken", "")))
            {
                Stop();
                cancel = new CancellationTokenSource();
                Task.Factory.StartNew(delegate { EventSubLoop(cancel.Token); }, TaskCreationOptions.LongRunning);
            }
            RefreshChatCommands();
        }

public void Stop()
        {
            try
            {
                if (cancel != null) cancel.Cancel();
                if (socket != null) socket.Abort();
            }
            catch
            {
            }
            lock (stateLock)
            {
                eventSubConnected = false;
            }
            StopChat();
        }

// ---- Pending-state persistence: snapshots every not-yet-fulfilled action (see
        // Server.Settings.cs's PendingStatePath) so closing/updating/crashing the app mid-Team-Kampf-
        // signup, mid-trade-offer, or with draws still queued for OBS doesn't silently lose them.
        // Called after every meaningful mutation of the fields below (see call sites in
        // Bridge.Queue.cs, Bridge.Trade.cs, Bridge.Battle.cs, Bridge.Tournament.cs) - cheap enough
        // (a handful of small dictionaries/lists, no card images) to just re-write the whole file
        // each time rather than diffing.
        internal void SavePendingState()
        {
            try
            {
                var snapshot = new Dictionary<string, object>();
                lock (queueLock)
                {
                    snapshot["actionQueue"] = actionQueue.ToArray();
                    snapshot["deferredQueue"] = deferredQueue.ToArray();
                }
                lock (tradeLock) { snapshot["activeTrade"] = activeTrade; }
                lock (battleLock) { snapshot["activeBattle"] = activeBattle; }
                lock (tournamentLock) { snapshot["activeTournament"] = activeTournament; }
                lock (teamBattleLock) { snapshot["activeTeamBattle"] = activeTeamBattle; }
                File.WriteAllText(server.PendingStatePath(), server.Serializer.Serialize(snapshot), Encoding.UTF8);
            }
            catch (Exception ex) { server.Log("queue", "warn", "Ausstehender Zustand konnte nicht gespeichert werden: " + ex.Message); }
        }

        // Called once from Start(), after StartQueueWorkerOnce() so a restored non-empty queue has
        // a worker loop ready to drain it. Signup states (trade/battle/tournament/team battle) whose
        // deadline already passed while the app was down are resolved immediately (as if their timer
        // had just fired) instead of being silently dropped or left stuck forever; still-open ones
        // get their timer re-armed for the REMAINING duration. Tournament/team-battle bracket matches
        // that were already mid-playback need no special handling beyond restoring the queue itself -
        // the active-tournament/team-battle object is just bookkeeping the queue completion callbacks
        // consult, not something that drives its own animation.
        internal void LoadPendingState()
        {
            string path = server.PendingStatePath();
            if (!File.Exists(path)) return;
            try
            {
                Dictionary<string, object> snapshot = ParseObject(server.ReadFileText(path, "{}"));
                int restoredQueueItems = 0;

                object queueObj;
                if (snapshot.TryGetValue("actionQueue", out queueObj) && queueObj is object[])
                {
                    lock (queueLock)
                    {
                        foreach (object item in (object[])queueObj)
                        {
                            Dictionary<string, object> dict = item as Dictionary<string, object>;
                            if (dict != null) { actionQueue.Add(dict); restoredQueueItems++; }
                        }
                    }
                }
                object deferredObj;
                if (snapshot.TryGetValue("deferredQueue", out deferredObj) && deferredObj is object[])
                {
                    lock (queueLock)
                    {
                        foreach (object item in (object[])deferredObj)
                        {
                            Dictionary<string, object> dict = item as Dictionary<string, object>;
                            if (dict != null) { deferredQueue.Add(dict); restoredQueueItems++; }
                        }
                    }
                }
                if (restoredQueueItems > 0) queueSignal.Set();

                bool restoredTrade = RestoreExpiringState(snapshot, "activeTrade", "expiresAt",
                    dict => { activeTrade = dict; },
                    (dict, remainingMs) => { tradeTimeoutTimer = new System.Threading.Timer(delegate { TradeTimedOut(); }, null, remainingMs, Timeout.Infinite); },
                    () => TradeTimedOut());
                bool restoredBattle = RestoreExpiringState(snapshot, "activeBattle", "expiresAt",
                    dict => { activeBattle = dict; },
                    (dict, remainingMs) => { battleTimeoutTimer = new System.Threading.Timer(delegate { BattleTimedOut(); }, null, remainingMs, Timeout.Infinite); },
                    () => BattleTimedOut());
                bool restoredTournament = RestoreExpiringState(snapshot, "activeTournament", "deadlineUtc",
                    dict => { activeTournament = dict; },
                    (dict, remainingMs) => { if (GetString(dict, "state", "") == "signup") tournamentSignupTimer = new System.Threading.Timer(delegate { ResolveTournamentSignup(); }, null, remainingMs, System.Threading.Timeout.Infinite); },
                    () => ResolveTournamentSignup());
                bool restoredTeamBattle = RestoreExpiringState(snapshot, "activeTeamBattle", "deadlineUtc",
                    dict => { activeTeamBattle = dict; },
                    (dict, remainingMs) => { teamBattleSignupTimer = new System.Threading.Timer(delegate { ResolveTeamBattleSignup(); }, null, remainingMs, System.Threading.Timeout.Infinite); },
                    () => ResolveTeamBattleSignup());

                if (restoredQueueItems > 0 || restoredTrade || restoredBattle || restoredTournament || restoredTeamBattle)
                {
                    server.Log("queue", "info", "Ausstehender Zustand aus vorherigem Lauf wiederhergestellt (" + restoredQueueItems +
                        " Warteschlangen-Eintrag/e" + (restoredTrade ? ", Tausch" : "") + (restoredBattle ? ", Kampf" : "") +
                        (restoredTournament ? ", Turnier" : "") + (restoredTeamBattle ? ", Team-Kampf" : "") + ").");
                }
            }
            catch (Exception ex) { server.Log("queue", "warn", "Ausstehender Zustand konnte nicht wiederhergestellt werden: " + ex.Message); }
        }

        // Shared restore logic for the four "signup/offer with a deadline" states: restores the
        // dictionary if present, then either re-arms its timer for the remaining time (deadline still
        // ahead) or immediately runs the same resolution the timer would have (deadline already
        // passed while the app was down) - either way the state never gets silently stuck or dropped.
        private bool RestoreExpiringState(Dictionary<string, object> snapshot, string key, string deadlineField,
            Action<Dictionary<string, object>> assign, Action<Dictionary<string, object>, int> rearmTimer, Action resolveNow)
        {
            object stateObj;
            if (!snapshot.TryGetValue(key, out stateObj) || !(stateObj is Dictionary<string, object>)) return false;
            Dictionary<string, object> dict = (Dictionary<string, object>)stateObj;
            assign(dict);

            DateTime deadline;
            string deadlineText = GetString(dict, deadlineField, "");
            if (!DateTime.TryParse(deadlineText, null, System.Globalization.DateTimeStyles.RoundtripKind, out deadline))
            {
                return true; // restored, but no deadline to act on (e.g. a "running" tournament bracket)
            }
            double remainingMs = (deadline - DateTime.UtcNow).TotalMilliseconds;
            if (remainingMs > 0)
            {
                rearmTimer(dict, (int)Math.Min(remainingMs, Int32.MaxValue));
            }
            else
            {
                // Deadline already passed while the app was down - resolve synchronously right now
                // instead of leaving the viewer(s)/signup stuck waiting for a timer that will never
                // fire again for this (already-restored) object.
                resolveNow();
            }
            return true;
        }

public Dictionary<string, object> Status()
        {
            Dictionary<string, object> twitch = TwitchSettings();
            bool connected = !String.IsNullOrWhiteSpace(GetString(twitch, "accessToken", ""));
            lock (stateLock)
            {
                return new Dictionary<string, object>
                {
                    { "connected", connected },
                    { "eventSubConnected", eventSubConnected },
                    { "clientId", GetString(twitch, "clientId", "") },
                    { "login", GetString(twitch, "login", "") },
                    { "displayName", GetString(twitch, "displayName", "") },
                    { "broadcasterId", GetString(twitch, "broadcasterId", "") },
                    { "expiresAt", GetString(twitch, "expiresAt", "") },
                    { "lastError", lastError ?? "" }
                };
            }
        }

public Dictionary<string, object> SaveToken(string bodyJson)
        {
            Dictionary<string, object> body = ParseObject(bodyJson);
            string token = NormalizeAccessToken(GetString(body, "accessToken", ""));
            if (String.IsNullOrWhiteSpace(token)) throw new InvalidOperationException("Twitch Access Token fehlt.");

            Dictionary<string, object> validation = TwitchGet("https://id.twitch.tv/oauth2/validate", "", token);
            string clientId = GetString(validation, "client_id", "");
            string login = GetString(validation, "login", "");
            string broadcasterId = GetString(validation, "user_id", "");
            if (String.IsNullOrWhiteSpace(clientId) || String.IsNullOrWhiteSpace(broadcasterId))
            {
                throw new InvalidOperationException("Twitch Token konnte nicht validiert werden.");
            }
            EnsureRequiredScopes(validation);

            Dictionary<string, object> settings = server.ReadSettingsObject();
            Dictionary<string, object> twitch = EnsureObject(settings, "twitch");
            twitch["clientId"] = clientId;
            twitch["accessToken"] = token;
            twitch["login"] = login;
            twitch["displayName"] = login;
            twitch["broadcasterId"] = broadcasterId;
            twitch["expiresAt"] = DateTime.UtcNow.AddSeconds(GetInt(validation, "expires_in", 0)).ToString("o");
            StripDeckForRewardSave(settings);
            server.WriteSettingsObject(settings);
            Start();
            server.Log("twitch", "info", "Twitch verbunden als " + login + ".");
            return Status();
        }

public void Disconnect()
        {
            Stop();
            server.Log("twitch", "info", "Twitch-Verbindung getrennt.");
            Dictionary<string, object> settings = server.ReadSettingsObject();
            Dictionary<string, object> twitch = EnsureObject(settings, "twitch");
            twitch.Remove("accessToken");
            twitch.Remove("login");
            twitch.Remove("displayName");
            twitch.Remove("broadcasterId");
            twitch.Remove("expiresAt");
            server.WriteSettingsObject(settings, false);
        }

public object[] GetRewards()
        {
            Dictionary<string, object> twitch = RequireTwitch();
            string url = "https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=" +
                Uri.EscapeDataString(GetString(twitch, "broadcasterId", "")) +
                "&only_manageable_rewards=true";
            Dictionary<string, object> result = TwitchGet(url, GetString(twitch, "clientId", ""), GetString(twitch, "accessToken", ""));
            object[] rewards = result.ContainsKey("data") && result["data"] is object[] ? (object[])result["data"] : new object[0];

            HashSet<string> trackedIds = TrackedRewardIds(server.ReadSettingsObject());
            var ownRewards = new List<object>();
            foreach (object item in rewards)
            {
                Dictionary<string, object> reward = item as Dictionary<string, object>;
                if (reward != null && trackedIds.Contains(GetString(reward, "id", ""))) ownRewards.Add(reward);
            }
            return ownRewards.ToArray();
        }

private static HashSet<string> TrackedRewardIds(Dictionary<string, object> settings)
        {
            var ids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (string key in new[] { "draw", "showcase" })
            {
                Dictionary<string, object> holder = Obj(settings, key);
                if (!holder.ContainsKey("rewardIds") || !(holder["rewardIds"] is object[])) continue;
                foreach (object id in (object[])holder["rewardIds"])
                {
                    string text = Convert.ToString(id);
                    if (!String.IsNullOrWhiteSpace(text)) ids.Add(text);
                }
            }
            return ids;
        }

// The reward for opening a pack is a single global reward, not one per booster:
        // PickRandomBoosterId() always draws from ALL eligible boosters regardless of which
        // reward triggered it, so a reward stored per-booster never actually scoped the draw
        // to that booster - it is stored under settings["draw"] instead.
        public Dictionary<string, object> SyncReward(string bodyJson)
        {
            Dictionary<string, object> body = ParseObject(bodyJson);
            Dictionary<string, object> twitch = RequireTwitch();
            Dictionary<string, object> settings = server.ReadSettingsObject();
            Dictionary<string, object> draw = Obj(settings, "draw");
            if (draw.Count == 0) { draw = new Dictionary<string, object>(); settings["draw"] = draw; }

            string title = GetString(body, "title", GetString(draw, "rewardName", "Kartenpack"));
            int cost = Math.Max(1, GetInt(body, "cost", 1));
            string prompt = GetString(body, "prompt", "");
            string backgroundColor = GetString(body, "backgroundColor", "");
            bool isEnabled = GetBool(body, "isEnabled", true);
            bool isPaused = GetBool(body, "isPaused", false);
            int maxPerStream = Math.Max(0, GetInt(body, "maxPerStream", 0));
            int maxPerUserPerStream = Math.Max(0, GetInt(body, "maxPerUserPerStream", 0));
            int globalCooldown = Math.Max(0, GetInt(body, "globalCooldown", 0));
            bool explicitRewardId = body.ContainsKey("rewardId");
            string rewardId = GetString(body, "rewardId", "");
            object[] existingIds = draw.ContainsKey("rewardIds") && draw["rewardIds"] is object[] ? (object[])draw["rewardIds"] : new object[0];
            if (!explicitRewardId && String.IsNullOrWhiteSpace(rewardId)) rewardId = existingIds.Length > 0 ? Convert.ToString(existingIds[0]) : "";

            // Twitch requires the max/cooldown values to be >= 1 even when their setting is disabled.
            var payload = new Dictionary<string, object>
            {
                { "title", title },
                { "cost", cost },
                { "prompt", prompt },
                { "is_enabled", isEnabled },
                { "is_user_input_required", false },
                // Deliberately left in the manual-review queue (NOT auto-skipped) so a redemption
                // can still be refunded from the Twitch dashboard/mobile app if something goes
                // wrong (e.g. a cancelled tournament signup, or a pack drawn in error). This can
                // reportedly crash an OLDER OBS-bundled Chromium's built-in chat dock, which
                // can't render the inline Fulfill/Refund control - if that happens, either update
                // OBS or switch to an external chat client instead of re-enabling the skip.
                { "should_redemptions_skip_request_queue", false },
                { "is_max_per_stream_enabled", maxPerStream > 0 },
                { "max_per_stream", maxPerStream > 0 ? maxPerStream : 1 },
                { "is_max_per_user_per_stream_enabled", maxPerUserPerStream > 0 },
                { "max_per_user_per_stream", maxPerUserPerStream > 0 ? maxPerUserPerStream : 1 },
                { "is_global_cooldown_enabled", globalCooldown > 0 },
                { "global_cooldown_seconds", globalCooldown > 0 ? globalCooldown : 1 }
            };
            if (!String.IsNullOrWhiteSpace(backgroundColor)) payload["background_color"] = backgroundColor.ToUpperInvariant();

            string baseUrl = "https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=" +
                Uri.EscapeDataString(GetString(twitch, "broadcasterId", ""));
            Dictionary<string, object> result;
            if (String.IsNullOrWhiteSpace(rewardId))
            {
                result = CreateOrAdoptReward(twitch, baseUrl, title, payload, isPaused, ref rewardId);
            }
            else
            {
                try
                {
                    // is_paused is only accepted on update (PATCH), never on create.
                    payload["is_paused"] = isPaused;
                    result = TwitchJson("PATCH", baseUrl + "&id=" + Uri.EscapeDataString(rewardId), GetString(twitch, "clientId", ""), GetString(twitch, "accessToken", ""), payload);
                }
                catch (InvalidOperationException ex)
                {
                    // Reward was deleted on Twitch's side (e.g. manually in the dashboard) but we still
                    // had it tracked locally. Re-create it instead of failing the whole sync.
                    if (ex.Message.IndexOf("was not found", StringComparison.OrdinalIgnoreCase) < 0) throw;
                    payload.Remove("is_paused");
                    result = CreateOrAdoptReward(twitch, baseUrl, title, payload, isPaused, ref rewardId);
                }
            }

            object[] rewards = result.ContainsKey("data") && result["data"] is object[] ? (object[])result["data"] : new object[0];
            Dictionary<string, object> reward = rewards.Length > 0 && rewards[0] is Dictionary<string, object>
                ? (Dictionary<string, object>)rewards[0]
                : new Dictionary<string, object>();

            string savedId = GetString(reward, "id", rewardId);
            // Diagnostic: Twitch may silently ignore should_redemptions_skip_request_queue on
            // PATCH (it could be create-only) - log what Twitch actually echoes back so a stuck
            // chat-dock-crash report can be confirmed/ruled out without guessing.
            server.Log("twitch", "info", "Kartenpack-Belohnung gespeichert. Twitch-Antwort: " + server.Serializer.Serialize(reward));
            draw["rewardIds"] = new object[] { savedId };
            draw["rewardName"] = title;
            draw["rewardCost"] = cost;
            draw["rewardPrompt"] = prompt;
            draw["rewardBackgroundColor"] = backgroundColor;
            draw["rewardEnabled"] = isEnabled;
            draw["rewardPaused"] = isPaused;
            draw["rewardMaxPerStream"] = maxPerStream;
            draw["rewardMaxPerUserPerStream"] = maxPerUserPerStream;
            draw["rewardGlobalCooldown"] = globalCooldown;
            StripDeckForRewardSave(settings);
            server.WriteSettingsObject(settings);
            RestartQuietly();
            return settings;
        }

public Dictionary<string, object> DeleteReward(string bodyJson)
        {
            Dictionary<string, object> body = ParseObject(bodyJson);
            Dictionary<string, object> twitch = RequireTwitch();
            string rewardId = GetString(body, "rewardId", "");
            if (String.IsNullOrWhiteSpace(rewardId)) throw new InvalidOperationException("Bitte zuerst einen Channelpoint auswählen.");

            string url = "https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=" +
                Uri.EscapeDataString(GetString(twitch, "broadcasterId", "")) +
                "&id=" + Uri.EscapeDataString(rewardId);
            try
            {
                TwitchRaw("DELETE", url, GetString(twitch, "clientId", ""), GetString(twitch, "accessToken", ""), null);
            }
            catch (InvalidOperationException ex)
            {
                // Already gone on Twitch's side (e.g. deleted manually in the dashboard) - that is
                // effectively success for us. Without this, a stale id could never be cleared from
                // the app: every delete attempt would keep failing with the same "not found" error.
                if (ex.Message.IndexOf("was not found", StringComparison.OrdinalIgnoreCase) < 0) throw;
            }

            Dictionary<string, object> settings = server.ReadSettingsObject();
            RemoveRewardId(Obj(settings, "draw"), rewardId);
            RemoveRewardId(Obj(settings, "showcase"), rewardId);
            RemoveRewardId(Obj(settings, "tournament"), rewardId);
            RemoveRewardId(Obj(settings, "teamBattle"), rewardId);
            RemoveRewardId(Obj(settings, "specificPackDraw"), rewardId);
            StripDeckForRewardSave(settings);
            server.WriteSettingsObject(settings);
            RestartQuietly();
            return settings;
        }

private static void RemoveRewardId(Dictionary<string, object> holder, string rewardId)
        {
            if (holder == null) return;
            object[] ids = holder.ContainsKey("rewardIds") && holder["rewardIds"] is object[] ? (object[])holder["rewardIds"] : new object[0];
            var kept = new List<object>();
            foreach (object id in ids)
            {
                if (!String.Equals(Convert.ToString(id), rewardId, StringComparison.OrdinalIgnoreCase)) kept.Add(id);
            }
            holder["rewardIds"] = kept.ToArray();
        }

private void EventSubLoop(CancellationToken token)
        {
            while (!token.IsCancellationRequested)
            {
                try
                {
                    lock (stateLock)
                    {
                        eventSubConnected = false;
                        lastError = "";
                    }
                    using (socket = new ClientWebSocket())
                    {
                        socket.ConnectAsync(new Uri("wss://eventsub.wss.twitch.tv/ws"), token).Wait(token);
                        ReadEventSubMessages(token).Wait(token);
                    }
                }
                catch (Exception ex)
                {
                    string message = ex.GetBaseException().Message;
                    lock (stateLock)
                    {
                        eventSubConnected = false;
                        lastError = message;
                    }
                    if (!token.IsCancellationRequested)
                    {
                        server.Log("twitch", "error", "EventSub-Verbindung verloren: " + message);
                        Thread.Sleep(5000);
                    }
                }
            }
        }

private async Task ReadEventSubMessages(CancellationToken token)
        {
            byte[] buffer = new byte[32768];
            while (!token.IsCancellationRequested && socket.State == WebSocketState.Open)
            {
                var bytes = new List<byte>();
                WebSocketReceiveResult result;
                do
                {
                    result = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), token);
                    if (result.MessageType == WebSocketMessageType.Close) return;
                    for (int i = 0; i < result.Count; i++) bytes.Add(buffer[i]);
                } while (!result.EndOfMessage);

                string text = Encoding.UTF8.GetString(bytes.ToArray());
                // Same ordered dispatch as the chat socket (see DispatchEventSubWork): keeps this
                // receive loop free to read the next frame while a redemption is being processed.
                DispatchEventSubWork(delegate { HandleEventSubMessage(text); });
            }
        }

private void HandleEventSubMessage(string text)
        {
            Dictionary<string, object> message = ParseObject(text);
            Dictionary<string, object> metadata = Obj(message, "metadata");
            string type = GetString(metadata, "message_type", "");
            Dictionary<string, object> payload = Obj(message, "payload");

            if (type == "session_welcome")
            {
                string sessionId = GetString(Obj(payload, "session"), "id", "");
                CreateEventSubSubscription(sessionId);
                lock (stateLock) eventSubConnected = true;
                server.Log("twitch", "info", "EventSub verbunden.");
                return;
            }

            if (type != "notification") return;
            // Twitch guarantees at-least-once delivery - the same message_id can arrive more than
            // once (e.g. after a brief disconnect/reconnect). Drop repeats before they can queue
            // a second draw/showcase or send a duplicate chat message.
            string messageId = GetString(metadata, "message_id", "");
            if (IsDuplicateEventSubMessage(messageId))
            {
                server.Log("twitch", "info", "Doppelte EventSub-Nachricht ignoriert (message_id " + messageId + ").");
                return;
            }
            Dictionary<string, object> subscription = Obj(payload, "subscription");
            string subType = GetString(subscription, "type", "");
            if (subType == "channel.subscribe" || subType == "channel.subscription.message" || subType == "channel.subscription.gift")
            {
                HandleSubscriptionEvent(subType, Obj(payload, "event"));
                return;
            }
            if (subType == "channel.cheer")
            {
                HandleCheerEvent(Obj(payload, "event"));
                return;
            }
            if (subType != "channel.channel_points_custom_reward_redemption.add") return;
            Dictionary<string, object> ev = Obj(payload, "event");
            string rewardId = GetString(Obj(ev, "reward"), "id", "");
            string rewardTitle = GetString(Obj(ev, "reward"), "title", "");
            string user = GetString(ev, "user_name", GetString(ev, "user_login", "Viewer"));
            string login = GetString(ev, "user_login", user);

            // Read settings ONCE for this whole redemption and hand it to every
            // ReconcileTrackedReward check below, instead of each check calling
            // ReadSettingsObject() itself - that re-parses the ENTIRE settings chain from disk on
            // every call, including cards.json (tens of MB once a collection has many custom card
            // images). A redemption that doesn't match the first checks (showcase/tournament/
            // teamBattle) paid that full-file-reload cost up to four times in a row before the
            // draw was even logged/enqueued - exactly why redemptions showed up in the log several
            // seconds after actually being redeemed.
            Dictionary<string, object> settings = server.ReadSettingsObject();

            // IRL mode: only the pack/draw reward may still trigger anything - every other
            // redemption (showcase, tournament, team battle, specific-pack) is ignored outright.
            if (IsIrlModeActive(settings) && !StringArrayContains(Obj(settings, "draw"), "rewardIds", rewardId))
            {
                return;
            }

            // Collection showcase reward: not a pack opening - tell the collection overlay to
            // slide through every active booster for this viewer. Routed through the action
            // queue (like every other redemption/chat command) so concurrent triggers are
            // always processed strictly one after another with a pause in between.
            if (ReconcileTrackedReward(settings, "showcase", rewardId, rewardTitle))
            {
                // The animation can be switched off entirely (settings.showcase.animationEnabled)
                // while still wanting the chat card list - in that case there's nothing to queue
                // or animate, so send the chat text directly instead of going through the overlay
                // queue at all.
                if (GetBool(Obj(settings, "showcase"), "animationEnabled", true))
                    Enqueue("showcollection", login, user, "channelpoints");
                else
                    SendCollectionChatText(login, user, settings);
                return;
            }

            if (ReconcileTrackedReward(settings, "tournament", rewardId, rewardTitle))
            {
                StartTournamentSignup(login, user, "channelpoints");
                return;
            }

            if (ReconcileTrackedReward(settings, "teamBattle", rewardId, rewardTitle))
            {
                StartTeamBattleSignup(login, user, "channelpoints");
                return;
            }

            // "Pick your own pack" reward - requires the viewer to type the exact pack name into
            // the reward's (required) text input; refunds the points and explains via chat if that
            // name doesn't match any enabled booster. See HandleSpecificPackRedemption.
            if (ReconcileTrackedReward(settings, "specificPackDraw", rewardId, rewardTitle))
            {
                HandleSpecificPackRedemption(login, user, GetString(ev, "user_input", ""), rewardId, GetString(ev, "id", ""), settings);
                return;
            }

            if (!ReconcileTrackedReward(settings, "draw", rewardId, rewardTitle))
            {
                // Helps diagnose "nothing happened" reports: a redemption came in but matched
                // neither the draw reward nor the showcase reward (stale/mismatched reward id).
                server.Log("draw", "info", "Belohnung \"" + rewardTitle + "\" (ID " + rewardId + ") eingeloest, aber weder als Kartenpack- noch als Sammlung-Belohnung hinterlegt - ignoriert.");
                return;
            }

            // Diagnostic: if a duplicate chat message is reported again, compare this redemption
            // id / message_id against the other occurrence's log line - same ids would mean our
            // de-dup missed a case, different ids would mean Twitch genuinely sent two distinct
            // redemption events (e.g. the reward button was pressed twice).
            server.Log("draw", "info", "Draw-Redemption: redemptionId=" + GetString(ev, "id", "") + ", message_id=" + messageId + ", user=" + user + ".");

            Enqueue("draw", login, user, "channelpoints");
        }

// Sub/Resub/Gifted-Sub reward: draws "cardsPerSub" card(s) - multiplied by the number of
        // subs for a gift/bomb event - exclusively from boosters flagged "subExclusive", via the
        // normal action queue (same as any other draw, so it's serialized with everything else).
        // Mirrors PickRandomBoosterId(subOnly:true)'s eligibility check (enabled, subExclusive,
        // has at least one enabled card) without actually picking one - used up front by
        // HandleSubscriptionEvent to decide whether to fall back to the normal pool instead of
        // silently enqueueing draws that would find nothing.
        private bool HasEligibleSubExclusiveBooster(Dictionary<string, object> settings)
        {
            object boostersObj;
            if (!settings.TryGetValue("boosters", out boostersObj) || !(boostersObj is object[])) return false;
            foreach (object item in (object[])boostersObj)
            {
                Dictionary<string, object> booster = item as Dictionary<string, object>;
                if (booster == null) continue;
                if (!GetBool(booster, "enabled", true)) continue;
                if (!GetBool(booster, "subExclusive", false)) continue;
                object[] cardIds = booster.ContainsKey("cardIds") && booster["cardIds"] is object[] ? (object[])booster["cardIds"] : new object[0];
                if (cardIds.Length == 0) continue;
                if (!BoosterHasEnabledCard(settings, cardIds)) continue;
                return true;
            }
            return false;
        }

private bool IsDuplicateSubOrResubEvent(string login)
        {
            DateTime now = DateTime.UtcNow;
            lock (recentSubEventLock)
            {
                DateTime cutoff = now.AddMinutes(-1);
                var stale = new List<string>();
                foreach (KeyValuePair<string, DateTime> kv in recentSubEventAt)
                {
                    if (kv.Value < cutoff) stale.Add(kv.Key);
                }
                foreach (string key in stale) recentSubEventAt.Remove(key);

                DateTime last;
                if (recentSubEventAt.TryGetValue(login, out last) && (now - last).TotalSeconds < 15) return true;
                recentSubEventAt[login] = now;
                return false;
            }
        }

        private void HandleSubscriptionEvent(string subType, Dictionary<string, object> ev)
        {
            Dictionary<string, object> settings = server.ReadSettingsObject();
            Dictionary<string, object> subCfg = Obj(settings, "subRewards");
            if (!GetBool(subCfg, "enabled", true)) return;
            int cardsPerSub = Math.Max(1, GetInt(subCfg, "cardsPerSub", 1));

            string login;
            string displayName;
            int count;
            string source;

            if (subType == "channel.subscribe")
            {
                // Gifted subs are reported twice: once here (the recipient, is_gift=true) and once
                // via channel.subscription.gift (the gifter, with the total gifted count). Only the
                // gifter is rewarded, so the recipient's half is skipped to avoid double-counting.
                if (GetBool(ev, "is_gift", false)) return;
                login = GetString(ev, "user_login", "");
                displayName = GetString(ev, "user_name", login);
                count = 1;
                source = "sub";
            }
            else if (subType == "channel.subscription.message")
            {
                login = GetString(ev, "user_login", "");
                displayName = GetString(ev, "user_name", login);
                count = 1;
                source = "resub";
            }
            else if (subType == "channel.subscription.gift")
            {
                // Anonymous gifts carry no user to credit.
                if (GetBool(ev, "is_anonymous", false)) return;
                login = GetString(ev, "user_login", "");
                displayName = GetString(ev, "user_name", login);
                count = Math.Max(1, GetInt(ev, "total", 1));
                source = "giftsub";
            }
            else
            {
                return;
            }

            if (String.IsNullOrWhiteSpace(login)) return;

            // Only sub/resub (not gift) are affected by Twitch's observed subscribe+resub double-fire
            // for one physical event - gift subs are a structurally separate mechanism (see the
            // is_gift/is_anonymous checks above) and shouldn't be coalesced with a coincidental
            // regular resub from the same user around the same time.
            if ((subType == "channel.subscribe" || subType == "channel.subscription.message") && IsDuplicateSubOrResubEvent(login))
            {
                server.Log("draw", "info", displayName + ": Sub/Resub-Event innerhalb kurzer Zeit erneut gemeldet (" + subType + ") - als Duplikat ignoriert.");
                return;
            }

            // Fallback: if no booster is actually marked "Sub-exklusiv" (or none has cards), the
            // sub-exclusive pool is empty and the queued draws would previously just silently do
            // nothing (see ProcessQueueItem's PickRandomBoosterId warning). With the fallback
            // enabled, draw from the NORMAL pool instead, using its own separately configurable
            // card count - so a sub always grants something even before a sub-exclusive booster
            // has been set up.
            bool useSubExclusive = HasEligibleSubExclusiveBooster(settings);
            int cardsPerEvent = useSubExclusive ? cardsPerSub : Math.Max(1, GetInt(subCfg, "fallbackCardsPerSub", 1));
            if (!useSubExclusive && !GetBool(subCfg, "fallbackEnabled", false))
            {
                server.Log("draw", "warn", displayName + " hat eine Sub-Belohnung ausgeloest (" + source +
                    "), aber es ist kein Sub-exklusiver Booster verfuegbar und der Fallback ist deaktiviert.");
                return;
            }

            int totalCards = cardsPerEvent * count;
            server.Log("draw", "info", displayName + " hat " + totalCards + " Sub-Belohnungskarte(n) ausgeloest (" + source +
                (useSubExclusive ? "" : ", Fallback auf normalen Pool") + ").");
            var extra = useSubExclusive ? new Dictionary<string, object> { { "boosterPool", "subExclusive" } } : null;
            for (int i = 0; i < totalCards; i++) Enqueue("draw", login, displayName, source, extra);
        }

// Bits/Cheers: every "bitsPerDraw" bits (config-defined threshold) earns one card draw.
        // Leftover bits below the threshold are banked per user (data/command-usage.json, "bits"
        // section) and carry over to the NEXT cheer - e.g. bitsPerDraw=100, a 250-bit cheer earns
        // 2 draws immediately and banks 50; a later 50-bit cheer from the same user then earns the
        // 3rd draw and empties the bank. Anonymous cheers carry no user to credit and are skipped.
        private void HandleCheerEvent(Dictionary<string, object> ev)
        {
            Dictionary<string, object> settings = server.ReadSettingsObject();
            Dictionary<string, object> bitsCfg = Obj(settings, "bits");
            if (!GetBool(bitsCfg, "enabled", false)) return;
            int bitsPerDraw = Math.Max(1, GetInt(bitsCfg, "bitsPerDraw", 100));

            if (GetBool(ev, "is_anonymous", false)) return;
            string login = GetString(ev, "user_login", "");
            string displayName = GetString(ev, "user_name", login);
            int bits = Math.Max(0, GetInt(ev, "bits", 0));
            if (String.IsNullOrWhiteSpace(login) || bits <= 0) return;

            int totalDraws;
            int remainder;
            lock (usageLock)
            {
                Dictionary<string, object> entry = GetOrCreateBitsEntry(login, displayName);
                int banked = GetInt(entry, "banked", 0) + bits;
                totalDraws = banked / bitsPerDraw;
                remainder = banked % bitsPerDraw;
                entry["banked"] = remainder;
                SaveUsage();
            }

            server.Log("draw", "info", displayName + " hat " + bits + " Bits gespendet - " + totalDraws +
                " Kartenziehung(en) ausgeloest, " + remainder + " Bits verbleiben bis zur naechsten.");
            for (int i = 0; i < totalDraws; i++) Enqueue("draw", login, displayName, "bits");
        }

// ---- Bits usage tracking (separate namespace inside command-usage.json) ----

        private Dictionary<string, object> BitsSection()
        {
            EnsureUsageLoaded();
            object obj;
            if (usageData.TryGetValue("bits", out obj) && obj is Dictionary<string, object>) return (Dictionary<string, object>)obj;
            Dictionary<string, object> section = new Dictionary<string, object> { { "users", new Dictionary<string, object>() } };
            usageData["bits"] = section;
            return section;
        }

private Dictionary<string, object> GetOrCreateBitsEntry(string login, string displayName)
        {
            Dictionary<string, object> section = BitsSection();
            Dictionary<string, object> users = section["users"] as Dictionary<string, object>;
            if (users == null) { users = new Dictionary<string, object>(); section["users"] = users; }
            string key = login.Trim().ToLowerInvariant();
            Dictionary<string, object> entry;
            if (users.ContainsKey(key) && users[key] is Dictionary<string, object>) entry = (Dictionary<string, object>)users[key];
            else { entry = new Dictionary<string, object> { { "banked", 0 } }; users[key] = entry; }
            if (!String.IsNullOrWhiteSpace(displayName)) entry["displayName"] = displayName;
            return entry;
        }

// Exposes every viewer's currently banked (not-yet-a-draw) bits, for display in the
        // admin User tab. Includes displayName (not just the raw banked number) so the admin UI
        // can list a viewer who has banked bits but hasn't drawn a card yet (e.g. their cheer was
        // below the bits-per-draw threshold) - previously such viewers were invisible in the User
        // tab entirely, since it was built solely from card ownership in collections.json.
        public Dictionary<string, object> GetBitsState()
        {
            lock (usageLock)
            {
                Dictionary<string, object> section = BitsSection();
                Dictionary<string, object> users = section["users"] as Dictionary<string, object>;
                var result = new Dictionary<string, object>();
                if (users != null)
                {
                    foreach (KeyValuePair<string, object> kv in users)
                    {
                        Dictionary<string, object> entry = kv.Value as Dictionary<string, object>;
                        if (entry != null)
                        {
                            result[kv.Key] = new Dictionary<string, object>
                            {
                                { "banked", GetInt(entry, "banked", 0) },
                                { "displayName", GetString(entry, "displayName", kv.Key) }
                            };
                        }
                    }
                }
                return result;
            }
        }

private static readonly Random RandomSource = new Random();

private static readonly Dictionary<string, double> DefaultRarityWeights = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase)
        {
            { "common", 100 }, { "uncommon", 60 }, { "rare", 30 }, { "epic", 12 }, { "legendary", 4 }, { "holo", 1 }
        };

// Called by the overlay (POST /api/queue/announce) the instant a drawn card is fully
        // revealed - the same moment the collection panel appears next to it - so the post-draw
        // chat message and live-ticker entry go out right then instead of after the whole
        // animation finishes playing.
        // If more than one overlay page is showing the same source at once (e.g. the pack source
        // open in both OBS AND Meld Studio simultaneously), each one independently plays the
        // animation and independently posts /api/queue/announce for the same eventId. Without this
        // guard, every extra call would re-send the post-draw chat message, duplicating it.
        private readonly object announceLock = new object();

private string lastAnnouncedEventId;

// Persisted to disk (see CardPackServer.SaveLiveTickerHistory/LoadLiveTickerHistory) so a
        // freshly (re)loaded overlay/browser source shows the last few events immediately even
        // right after an app restart, instead of sitting empty until the next one happens. Loaded
        // once in the constructor below. See GET /api/liveticker/recent.
        private const int LiveTickerHistoryCap = 8;

private readonly object liveTickerHistoryLock = new object();

private readonly List<Dictionary<string, object>> liveTickerHistory = new List<Dictionary<string, object>>();

public bool QueuePaused { get { return queuePaused; } }

private readonly object queueWorkerStartLock = new object();

// ---- Twitch Chat: reads chat via EventSub (channel.chat.message) using the bot
        // account if connected, otherwise falling back to the main/broadcaster account, and
        // matches messages against the two configurable prefix+command pairs. ----

        public Dictionary<string, object> BotStatus()
        {
            Dictionary<string, object> bot = BotSettings();
            bool connected = !String.IsNullOrWhiteSpace(GetString(bot, "accessToken", ""));
            lock (stateLock)
            {
                return new Dictionary<string, object>
                {
                    { "connected", connected },
                    { "chatEventSubConnected", chatEventSubConnected },
                    { "clientId", GetString(bot, "clientId", "") },
                    { "login", GetString(bot, "login", "") },
                    { "displayName", GetString(bot, "displayName", "") },
                    { "broadcasterId", GetString(bot, "broadcasterId", "") },
                    { "expiresAt", GetString(bot, "expiresAt", "") },
                    { "lastError", chatLastError ?? "" }
                };
            }
        }

private Dictionary<string, object> BotSettings()
        {
            return EnsureObject(server.ReadSettingsObject(), "twitchBot");
        }

public Dictionary<string, object> SaveBotToken(string bodyJson)
        {
            Dictionary<string, object> body = ParseObject(bodyJson);
            string token = NormalizeAccessToken(GetString(body, "accessToken", ""));
            if (String.IsNullOrWhiteSpace(token)) throw new InvalidOperationException("Twitch Access Token fehlt.");

            Dictionary<string, object> validation = TwitchGet("https://id.twitch.tv/oauth2/validate", "", token);
            string clientId = GetString(validation, "client_id", "");
            string login = GetString(validation, "login", "");
            string userId = GetString(validation, "user_id", "");
            if (String.IsNullOrWhiteSpace(clientId) || String.IsNullOrWhiteSpace(userId))
            {
                throw new InvalidOperationException("Twitch Token konnte nicht validiert werden.");
            }
            EnsureChatScopes(validation);

            Dictionary<string, object> settings = server.ReadSettingsObject();
            Dictionary<string, object> bot = EnsureObject(settings, "twitchBot");
            bot["clientId"] = clientId;
            bot["accessToken"] = token;
            bot["login"] = login;
            bot["displayName"] = login;
            bot["broadcasterId"] = userId;
            bot["expiresAt"] = DateTime.UtcNow.AddSeconds(GetInt(validation, "expires_in", 0)).ToString("o");
            StripDeckForRewardSave(settings);
            server.WriteSettingsObject(settings);
            server.Log("twitch", "info", "Twitch-Bot verbunden als " + login + ".");
            RefreshChatCommands();
            return BotStatus();
        }

public void DisconnectBot()
        {
            server.Log("twitch", "info", "Twitch-Bot-Verbindung getrennt.");
            Dictionary<string, object> settings = server.ReadSettingsObject();
            Dictionary<string, object> bot = EnsureObject(settings, "twitchBot");
            bot.Remove("accessToken");
            bot.Remove("login");
            bot.Remove("displayName");
            bot.Remove("broadcasterId");
            bot.Remove("expiresAt");
            server.WriteSettingsObject(settings, false);
            RefreshChatCommands();
        }

// The chat-reading/sending identity: the bot account if one is connected, otherwise
        // the main/broadcaster account as the documented fallback.
        private Dictionary<string, object> ChatCredential()
        {
            Dictionary<string, object> settings = server.ReadSettingsObject();
            Dictionary<string, object> bot = Obj(settings, "twitchBot");
            if (!String.IsNullOrWhiteSpace(GetString(bot, "accessToken", ""))) return bot;
            return Obj(settings, "twitch");
        }

public void RefreshChatCommands()
        {
            Dictionary<string, object> settings = server.ReadSettingsObject();
            Dictionary<string, object> cc = Obj(settings, "chatCommands");
            // Each command is toggled individually now (no separate master switch). The chat
            // EventSub subscription is the same regardless of command words/messages - it only
            // depends on which account reads chat and whether any command is active at all.
            bool anyEnabled =
                GetBool(Obj(cc, "pack"), "enabled", true) ||
                GetBool(Obj(cc, "packs"), "enabled", true) ||
                GetBool(Obj(cc, "collection"), "enabled", true) ||
                GetBool(Obj(cc, "trade"), "enabled", true) ||
                GetBool(Obj(cc, "tradeyes"), "enabled", true) ||
                GetBool(Obj(cc, "tradeno"), "enabled", true) ||
                GetBool(Obj(cc, "tournamentStart"), "enabled", true) ||
                GetBool(Obj(cc, "tournamentJoin"), "enabled", true) ||
                GetBool(Obj(cc, "teamBattleStart"), "enabled", true) ||
                GetBool(Obj(cc, "teamBattleJoin"), "enabled", true);

            Dictionary<string, object> chat = ChatCredential();
            string token = GetString(chat, "accessToken", "");

            // Only (re)connect when the thing that actually affects the connection changed - the
            // reading account's token, or whether chat is needed at all. This stops every unrelated
            // settings save (editing a command word or message) from tearing down and rebuilding the
            // chat socket, which previously spammed the log with "Chat-Verbindung aufgebaut.".
            string signature = anyEnabled ? token : "";
            if (chatRunning && signature == chatConfigSignature) return;

            StopChat();
            chatConfigSignature = signature;
            if (!anyEnabled) return;

            bool usingBot = !String.IsNullOrWhiteSpace(GetString(Obj(settings, "twitchBot"), "accessToken", ""));
            string who = usingBot ? "Bot-Account" : "Haupt-Account";
            if (String.IsNullOrWhiteSpace(token))
            {
                server.Log("twitch", "warn", "Chat-Befehle sind aktiv, aber es ist kein Twitch-Account verbunden. Bitte unter \"Verbindung\" anmelden.");
                return;
            }

            // channel.chat.message's condition ALWAYS needs the broadcaster's user id (see
            // CreateChatEventSubSubscription), even when a bot account does the actual reading -
            // it's still that bot listening to the BROADCASTER's channel, not its own. A bot-only
            // setup where the main/broadcaster account was never connected under "Verbindung" left
            // this empty, so Twitch rejected the subscription with a raw, unhelpful field-validation
            // error ("broadcaster_user_id ... required") instead of the actionable message below.
            if (String.IsNullOrWhiteSpace(GetString(Obj(settings, "twitch"), "broadcasterId", "")))
            {
                server.Log("twitch", "warn", "Chat-Befehle sind aktiv, aber der Haupt-Account (Streamer-Kanal) ist nicht verbunden. Bitte unter \"Verbindung\" den Haupt-Account anmelden - der Bot-Account allein reicht dafuer nicht aus.");
                return;
            }

            // The chat reader needs user:read:chat / user:write:chat. A token connected before
            // these scopes existed (typically the main account) silently fails to subscribe, so we
            // check up front and log an actionable message instead of leaving the user guessing.
            try
            {
                Dictionary<string, object> validation = TwitchGet("https://id.twitch.tv/oauth2/validate", "", token);
                var scopes = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                object scopesObj;
                if (validation.TryGetValue("scopes", out scopesObj) && scopesObj is object[])
                {
                    foreach (object scope in (object[])scopesObj) scopes.Add(Convert.ToString(scope));
                }
                if (!scopes.Contains("user:read:chat") || !scopes.Contains("user:write:chat"))
                {
                    server.Log("twitch", "error", "Dem " + who + " fehlen die Chat-Rechte (user:read:chat / user:write:chat). Bitte unter \"Verbindung\" den " + who + " neu anmelden, damit die Chat-Befehle funktionieren.");
                    return;
                }
            }
            catch (Exception ex)
            {
                server.Log("twitch", "warn", "Chat-Rechte des " + who + " konnten nicht geprueft werden: " + ex.GetBaseException().Message);
            }

            chatRunning = true;
            chatCancel = new CancellationTokenSource();
            Task.Factory.StartNew(delegate { ChatEventSubLoop(chatCancel.Token); }, TaskCreationOptions.LongRunning);
        }

private void StopChat()
        {
            chatRunning = false;
            try
            {
                if (chatCancel != null) chatCancel.Cancel();
                if (chatSocket != null) chatSocket.Abort();
            }
            catch
            {
            }
            lock (stateLock)
            {
                chatEventSubConnected = false;
            }
        }

private void ChatEventSubLoop(CancellationToken token)
        {
            while (!token.IsCancellationRequested)
            {
                try
                {
                    lock (stateLock)
                    {
                        chatEventSubConnected = false;
                        chatLastError = "";
                    }
                    using (chatSocket = new ClientWebSocket())
                    {
                        chatSocket.ConnectAsync(new Uri("wss://eventsub.wss.twitch.tv/ws"), token).Wait(token);
                        ReadChatEventSubMessages(token).Wait(token);
                    }
                }
                catch (Exception ex)
                {
                    string message = ex.GetBaseException().Message;
                    lock (stateLock)
                    {
                        chatEventSubConnected = false;
                        chatLastError = message;
                    }
                    if (!token.IsCancellationRequested)
                    {
                        server.Log("twitch", "error", "Chat-Verbindung verloren: " + message);
                        Thread.Sleep(5000);
                    }
                }
            }
        }

private async Task ReadChatEventSubMessages(CancellationToken token)
        {
            byte[] buffer = new byte[32768];
            while (!token.IsCancellationRequested && chatSocket.State == WebSocketState.Open)
            {
                var bytes = new List<byte>();
                WebSocketReceiveResult result;
                do
                {
                    result = await chatSocket.ReceiveAsync(new ArraySegment<byte>(buffer), token);
                    if (result.MessageType == WebSocketMessageType.Close) return;
                    for (int i = 0; i < result.Count; i++) bytes.Add(buffer[i]);
                } while (!result.EndOfMessage);

                string text = Encoding.UTF8.GetString(bytes.ToArray());
                // Handed to the ordered dispatch worker instead of processed inline: this loop
                // must get back to ReceiveAsync immediately so the NEXT frame is read right away
                // (HandleChatEventSubMessage does synchronous work - settings parse, Twitch API
                // calls for replies - that would otherwise stall the socket read). A single
                // ordered worker (not one Task per message, which an earlier fix tried) so
                // messages are still processed strictly in arrival order - !trade before
                // !tradeyes - and a burst of messages can't fan out into a dozen concurrent
                // handlers all contending for the settings lock at once.
                DispatchEventSubWork(delegate { HandleChatEventSubMessage(text); });
            }
        }

// Single ordered background worker both EventSub sockets (chat + channel points) hand
        // their notifications to. Keeps the receive loops permanently ready to read the next
        // frame while guaranteeing first-in-first-out processing across all Twitch events.
        private readonly object eventDispatchLock = new object();

private readonly Queue<Action> eventDispatchQueue = new Queue<Action>();

private bool eventDispatchWorkerRunning;

private void DispatchEventSubWork(Action work)
        {
            lock (eventDispatchLock)
            {
                eventDispatchQueue.Enqueue(work);
                if (eventDispatchWorkerRunning) return;
                eventDispatchWorkerRunning = true;
            }
            Task.Factory.StartNew(EventDispatchLoop);
        }

private void EventDispatchLoop()
        {
            while (true)
            {
                Action work;
                lock (eventDispatchLock)
                {
                    if (eventDispatchQueue.Count == 0) { eventDispatchWorkerRunning = false; return; }
                    work = eventDispatchQueue.Dequeue();
                }
                try { work(); }
                catch (Exception ex) { server.Log("twitch", "error", "EventSub-Verarbeitung fehlgeschlagen: " + ex.Message); }
            }
        }

private void HandleChatEventSubMessage(string text)
        {
            Dictionary<string, object> message = ParseObject(text);
            Dictionary<string, object> metadata = Obj(message, "metadata");
            string type = GetString(metadata, "message_type", "");
            Dictionary<string, object> payload = Obj(message, "payload");

            if (type == "session_welcome")
            {
                string sessionId = GetString(Obj(payload, "session"), "id", "");
                try { CreateChatEventSubSubscription(sessionId); }
                catch (Exception ex) { server.Log("twitch", "error", "Chat-Abonnement fehlgeschlagen: " + ex.Message); }
                lock (stateLock) chatEventSubConnected = true;
                server.Log("twitch", "info", "Chat-Verbindung aufgebaut.");
                return;
            }

            if (type != "notification") return;
            // Same at-least-once delivery caveat as the redemption socket (see
            // IsDuplicateEventSubMessage) - without this, a redelivered chat message could run
            // !pack/!tradeyes/etc. twice.
            string messageId = GetString(metadata, "message_id", "");
            if (IsDuplicateEventSubMessage(messageId))
            {
                server.Log("twitch", "info", "Doppelte Chat-EventSub-Nachricht ignoriert (message_id " + messageId + ").");
                return;
            }
            Dictionary<string, object> subscription = Obj(payload, "subscription");
            if (GetString(subscription, "type", "") != "channel.chat.message") return;
            Dictionary<string, object> ev = Obj(payload, "event");
            string login = GetString(ev, "chatter_user_login", "");
            string displayName = GetString(ev, "chatter_user_name", login);
            string chatText = GetString(Obj(ev, "message"), "text", "");
            if (String.IsNullOrWhiteSpace(login) || String.IsNullOrWhiteSpace(chatText)) return;
            ProcessChatMessage(login, displayName, chatText, IsModeratorOrBroadcaster(ev));
        }

// Twitch's channel.chat.message payload carries the chatter's badges as
        // event.badges[].set_id ("moderator"/"broadcaster"/...) rather than a plain boolean -
        // used to gate mod-only commands (currently just the IRL-mode toggle).
        internal static bool IsModeratorOrBroadcaster(Dictionary<string, object> ev)
        {
            object badgesObj;
            if (!ev.TryGetValue("badges", out badgesObj) || !(badgesObj is object[])) return false;
            foreach (object entry in (object[])badgesObj)
            {
                var badge = entry as Dictionary<string, object>;
                if (badge == null) continue;
                string setId = GetString(badge, "set_id", "");
                if (String.Equals(setId, "moderator", StringComparison.OrdinalIgnoreCase) ||
                    String.Equals(setId, "broadcaster", StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

private void CreateChatEventSubSubscription(string sessionId)
        {
            Dictionary<string, object> chat = ChatCredential();
            Dictionary<string, object> twitch = TwitchSettings();
            string broadcasterId = GetString(twitch, "broadcasterId", "");
            string userId = GetString(chat, "broadcasterId", broadcasterId);
            var body = new Dictionary<string, object>
            {
                { "type", "channel.chat.message" },
                { "version", "1" },
                { "condition", new Dictionary<string, object> { { "broadcaster_user_id", broadcasterId }, { "user_id", userId } } },
                { "transport", new Dictionary<string, object> { { "method", "websocket" }, { "session_id", sessionId } } }
            };
            TwitchJson("POST", "https://api.twitch.tv/helix/eventsub/subscriptions", GetString(chat, "clientId", ""), GetString(chat, "accessToken", ""), body);
        }

private static void EnsureChatScopes(Dictionary<string, object> validation)
        {
            var scopes = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            object scopesObj;
            if (validation.TryGetValue("scopes", out scopesObj) && scopesObj is object[])
            {
                foreach (object scope in (object[])scopesObj) scopes.Add(Convert.ToString(scope));
            }
            var missing = new List<string>();
            if (!scopes.Contains("user:read:chat")) missing.Add("user:read:chat");
            if (!scopes.Contains("user:write:chat")) missing.Add("user:write:chat");
            if (missing.Count > 0)
            {
                throw new InvalidOperationException(
                    "Token ist gueltig, aber fuer den Chat fehlen Scopes: " + String.Join(", ", missing.ToArray()) +
                    ". Bitte einen Token mit diesen Rechten generieren.");
            }
        }

// Twitch chat messages are capped at 500 characters; stay comfortably under that so the
        // per-chunk header/index prefix never pushes a message over the real limit.
        private const int MaxChatMessageLength = 450;

// ---- Outbound queue: every chat send / whisper / avatar-enriched overlay broadcast is
        // a synchronous Twitch API round-trip (~200-500ms each). Doing that inline on the event
        // dispatch worker (see DispatchEventSubWork) meant a burst of commands - e.g. several
        // viewers joining !teamkampf/!turnier back to back - serialized all those network calls
        // BEFORE later viewers' commands were even parsed, so their chat replies arrived seconds
        // late. This second ordered FIFO worker takes all outbound network I/O off the event
        // worker: command processing itself is now pure local work (milliseconds), and replies
        // still go out strictly in order because a single worker drains this queue too. ----
        private readonly object outboundLock = new object();

private readonly Queue<Action> outboundQueue = new Queue<Action>();

private bool outboundWorkerRunning;

// ---- Automatic "which commands are available" help message: fires after N minutes
        // and/or N chat messages since the last time it was sent (whichever is enabled/reached
        // first), listing every currently-enabled command with its short description. ----
        private readonly object autoHelpLock = new object();

private int autoHelpMessageCounter;

private DateTime autoHelpLastSentAt = DateTime.UtcNow;

private bool autoHelpTimerStarted;

private System.Threading.Timer autoHelpTimer;

private const string DefaultAutoHelpMessage = "📋 Verfügbare Befehle: [Befehle]";

// Global (not per-user) cooldown for chat commands that start a shared/community event
        // (tournament, team battle) - mirrors the "Globaler Cooldown" already used for these same
        // actions' channel-point rewards, so a Nicht-Affiliate/Partner using the chat command
        // instead gets the same spam protection. Returns true (and sends the cooldown message) if
        // still blocked; otherwise marks the cooldown as started and returns false.
        private readonly object commandCooldownLock = new object();

private readonly Dictionary<string, DateTime> commandCooldownUntil = new Dictionary<string, DateTime>();

// Rarity name aliases accepted by "!dustset", one set per supported UI language (see
        // admin.js's "rarity-*" i18n keys - kept in sync with those exact translations) plus their
        // ASCII/no-diacritics form so a viewer typing without special characters (e.g. "legendaer"
        // instead of "legendär") still matches. Canonical English rarity id -> list of accepted
        // spoken words across de/en/fr/es/th.
        private static readonly Dictionary<string, string[]> DustSetRarityAliases = new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase)
        {
            { "common", new[] { "common", "gewöhnlich", "gewoehnlich", "commune", "commun", "común", "comun", "ธรรมดา" } },
            { "uncommon", new[] { "uncommon", "ungewöhnlich", "ungewoehnlich", "peu commune", "peu commun", "poco común", "poco comun", "ไม่ธรรมดา" } },
            { "rare", new[] { "rare", "selten", "rara", "หายาก" } },
            { "epic", new[] { "epic", "episch", "épique", "epique", "épica", "epica", "เอพิก" } },
            { "legendary", new[] { "legendary", "legendär", "legendaer", "légendaire", "legendaire", "legendaria", "ตำนาน" } },
            { "holo", new[] { "holo", "โฮโล" } }
        };

// ---- Ranking command: !ranking battle / !ranking <Kartenname> ----

        private const string DefaultRankingCardNotFound = "@userName, die Karte [falscherName] existiert nicht. Meintest du stattdessen [Kartenname]?";

private const string DefaultRankingNoOwners = "@userName, die Karte [Kartenname] wurde bisher von niemandem gezogen - es gibt noch kein Ranking dafuer.";

private void CreateEventSubSubscription(string sessionId)
        {
            Dictionary<string, object> twitch = RequireTwitch();
            var body = new Dictionary<string, object>
            {
                { "type", "channel.channel_points_custom_reward_redemption.add" },
                { "version", "1" },
                { "condition", new Dictionary<string, object> { { "broadcaster_user_id", GetString(twitch, "broadcasterId", "") } } },
                { "transport", new Dictionary<string, object> { { "method", "websocket" }, { "session_id", sessionId } } }
            };
            TwitchJson("POST", "https://api.twitch.tv/helix/eventsub/subscriptions", GetString(twitch, "clientId", ""), GetString(twitch, "accessToken", ""), body);

            // Sub-Belohnungen (channel:read:subscriptions): optional on top of the redemption
            // subscription above - wrapped individually so a token still missing this scope
            // doesn't prevent channel points from working.
            foreach (string subEventType in new[] { "channel.subscribe", "channel.subscription.message", "channel.subscription.gift", "channel.cheer" })
            {
                try
                {
                    var subBody = new Dictionary<string, object>
                    {
                        { "type", subEventType },
                        { "version", "1" },
                        { "condition", new Dictionary<string, object> { { "broadcaster_user_id", GetString(twitch, "broadcasterId", "") } } },
                        { "transport", new Dictionary<string, object> { { "method", "websocket" }, { "session_id", sessionId } } }
                    };
                    TwitchJson("POST", "https://api.twitch.tv/helix/eventsub/subscriptions", GetString(twitch, "clientId", ""), GetString(twitch, "accessToken", ""), subBody);
                }
                catch (Exception ex)
                {
                    server.Log("twitch", "warn", "Sub-Ereignis-Abonnement (" + subEventType + ") fehlgeschlagen: " + ex.Message);
                }
            }
        }

// Matches an incoming redemption against settings.draw or settings.showcase. If the id
        // doesn't match but the (normalized) title still does, the reward was evidently deleted
        // and recreated on Twitch's side under the same name - the live id from this event is
        // adopted automatically so the stale id stops causing "nothing happened"/"not found"
        // failures on every future redemption and on the next manual save/delete.
        private bool ReconcileTrackedReward(Dictionary<string, object> settings, string holderKey, string rewardId, string rewardTitle)
        {
            Dictionary<string, object> holder = Obj(settings, holderKey);
            if (holder.Count == 0) return false;
            if (StringArrayContains(holder, "rewardIds", rewardId)) return true;

            string name = GetString(holder, "rewardName", "");
            if (String.IsNullOrWhiteSpace(name) || Normalize(name) != Normalize(rewardTitle)) return false;

            holder["rewardIds"] = new object[] { rewardId };
            StripDeckForRewardSave(settings);
            server.WriteSettingsObject(settings);
            server.Log("twitch", "info", "Belohnung \"" + rewardTitle + "\" hatte eine veraltete ID - automatisch aktualisiert.");
            return true;
        }

public Dictionary<string, object> SyncShowcaseReward(string bodyJson)
        {
            Dictionary<string, object> body = ParseObject(bodyJson);
            Dictionary<string, object> twitch = RequireTwitch();
            Dictionary<string, object> settings = server.ReadSettingsObject();
            Dictionary<string, object> showcase = Obj(settings, "showcase");
            if (showcase.Count == 0) { showcase = new Dictionary<string, object>(); settings["showcase"] = showcase; }

            string title = GetString(body, "title", GetString(showcase, "rewardName", "Sammlung zeigen"));
            int cost = Math.Max(1, GetInt(body, "cost", 500));
            string prompt = GetString(body, "prompt", "");
            string backgroundColor = GetString(body, "backgroundColor", "");
            bool isEnabled = GetBool(body, "isEnabled", true);
            bool isPaused = GetBool(body, "isPaused", false);
            int globalCooldown = Math.Max(0, GetInt(body, "globalCooldown", 0));
            bool explicitRewardId = body.ContainsKey("rewardId");
            string rewardId = GetString(body, "rewardId", "");
            object[] existingIds = showcase.ContainsKey("rewardIds") && showcase["rewardIds"] is object[] ? (object[])showcase["rewardIds"] : new object[0];
            if (!explicitRewardId && String.IsNullOrWhiteSpace(rewardId)) rewardId = existingIds.Length > 0 ? Convert.ToString(existingIds[0]) : "";

            var payload = new Dictionary<string, object>
            {
                { "title", title },
                { "cost", cost },
                { "prompt", prompt },
                { "is_enabled", isEnabled },
                { "is_user_input_required", false },
                // See SyncReward for why this is deliberately false (refundable from Twitch's
                // dashboard/app, at the cost of a documented older-OBS chat-dock crash risk).
                { "should_redemptions_skip_request_queue", false },
                { "is_global_cooldown_enabled", globalCooldown > 0 },
                { "global_cooldown_seconds", globalCooldown > 0 ? globalCooldown : 1 }
            };
            if (!String.IsNullOrWhiteSpace(backgroundColor)) payload["background_color"] = backgroundColor.ToUpperInvariant();

            string baseUrl = "https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=" +
                Uri.EscapeDataString(GetString(twitch, "broadcasterId", ""));
            Dictionary<string, object> result;
            if (String.IsNullOrWhiteSpace(rewardId))
            {
                result = CreateOrAdoptReward(twitch, baseUrl, title, payload, isPaused, ref rewardId);
            }
            else
            {
                try
                {
                    // is_paused is only accepted on update (PATCH), never on create.
                    payload["is_paused"] = isPaused;
                    result = TwitchJson("PATCH", baseUrl + "&id=" + Uri.EscapeDataString(rewardId), GetString(twitch, "clientId", ""), GetString(twitch, "accessToken", ""), payload);
                }
                catch (InvalidOperationException ex)
                {
                    if (ex.Message.IndexOf("was not found", StringComparison.OrdinalIgnoreCase) < 0) throw;
                    payload.Remove("is_paused");
                    result = CreateOrAdoptReward(twitch, baseUrl, title, payload, isPaused, ref rewardId);
                }
            }

            object[] rewards = result.ContainsKey("data") && result["data"] is object[] ? (object[])result["data"] : new object[0];
            Dictionary<string, object> reward = rewards.Length > 0 && rewards[0] is Dictionary<string, object>
                ? (Dictionary<string, object>)rewards[0]
                : new Dictionary<string, object>();
            string savedId = GetString(reward, "id", rewardId);
            server.Log("twitch", "info", "Showcase-Belohnung gespeichert. Twitch-Antwort: " + server.Serializer.Serialize(reward));

            showcase["rewardIds"] = new object[] { savedId };
            showcase["rewardName"] = title;
            showcase["rewardCost"] = cost;
            showcase["rewardPrompt"] = prompt;
            showcase["rewardBackgroundColor"] = backgroundColor;
            showcase["rewardEnabled"] = isEnabled;
            showcase["rewardPaused"] = isPaused;
            showcase["rewardGlobalCooldown"] = globalCooldown;
            StripDeckForRewardSave(settings);
            server.WriteSettingsObject(settings);
            return settings;
        }

public Dictionary<string, object> SyncTournamentReward(string bodyJson)
        {
            Dictionary<string, object> body = ParseObject(bodyJson);
            Dictionary<string, object> twitch = RequireTwitch();
            Dictionary<string, object> settings = server.ReadSettingsObject();
            Dictionary<string, object> tournament = Obj(settings, "tournament");
            if (tournament.Count == 0) { tournament = new Dictionary<string, object>(); settings["tournament"] = tournament; }

            string title = GetString(body, "title", GetString(tournament, "rewardName", "Turnier starten"));
            int cost = Math.Max(1, GetInt(body, "cost", 1000));
            string prompt = GetString(body, "prompt", "");
            string backgroundColor = GetString(body, "backgroundColor", "");
            bool isEnabled = GetBool(body, "isEnabled", true);
            bool isPaused = GetBool(body, "isPaused", false);
            int globalCooldown = Math.Max(0, GetInt(body, "globalCooldown", 0));
            bool explicitRewardId = body.ContainsKey("rewardId");
            string rewardId = GetString(body, "rewardId", "");
            object[] existingIds = tournament.ContainsKey("rewardIds") && tournament["rewardIds"] is object[] ? (object[])tournament["rewardIds"] : new object[0];
            if (!explicitRewardId && String.IsNullOrWhiteSpace(rewardId)) rewardId = existingIds.Length > 0 ? Convert.ToString(existingIds[0]) : "";

            var payload = new Dictionary<string, object>
            {
                { "title", title },
                { "cost", cost },
                { "prompt", prompt },
                { "is_enabled", isEnabled },
                { "is_user_input_required", false },
                // See SyncReward for why this is deliberately false (refundable).
                { "should_redemptions_skip_request_queue", false },
                { "is_global_cooldown_enabled", globalCooldown > 0 },
                { "global_cooldown_seconds", globalCooldown > 0 ? globalCooldown : 1 }
            };
            if (!String.IsNullOrWhiteSpace(backgroundColor)) payload["background_color"] = backgroundColor.ToUpperInvariant();

            string baseUrl = "https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=" +
                Uri.EscapeDataString(GetString(twitch, "broadcasterId", ""));
            Dictionary<string, object> result;
            if (String.IsNullOrWhiteSpace(rewardId))
            {
                result = CreateOrAdoptReward(twitch, baseUrl, title, payload, isPaused, ref rewardId);
            }
            else
            {
                try
                {
                    payload["is_paused"] = isPaused;
                    result = TwitchJson("PATCH", baseUrl + "&id=" + Uri.EscapeDataString(rewardId), GetString(twitch, "clientId", ""), GetString(twitch, "accessToken", ""), payload);
                }
                catch (InvalidOperationException ex)
                {
                    if (ex.Message.IndexOf("was not found", StringComparison.OrdinalIgnoreCase) < 0) throw;
                    payload.Remove("is_paused");
                    result = CreateOrAdoptReward(twitch, baseUrl, title, payload, isPaused, ref rewardId);
                }
            }

            object[] rewards = result.ContainsKey("data") && result["data"] is object[] ? (object[])result["data"] : new object[0];
            Dictionary<string, object> reward = rewards.Length > 0 && rewards[0] is Dictionary<string, object>
                ? (Dictionary<string, object>)rewards[0]
                : new Dictionary<string, object>();
            string savedId = GetString(reward, "id", rewardId);
            server.Log("twitch", "info", "Turnier-Belohnung gespeichert. Twitch-Antwort: " + server.Serializer.Serialize(reward));

            tournament["rewardIds"] = new object[] { savedId };
            tournament["rewardName"] = title;
            tournament["rewardCost"] = cost;
            tournament["rewardPrompt"] = prompt;
            tournament["rewardBackgroundColor"] = backgroundColor;
            tournament["rewardEnabled"] = isEnabled;
            tournament["rewardPaused"] = isPaused;
            tournament["rewardGlobalCooldown"] = globalCooldown;
            StripDeckForRewardSave(settings);
            server.WriteSettingsObject(settings);
            return settings;
        }

public Dictionary<string, object> SyncTeamBattleReward(string bodyJson)
        {
            Dictionary<string, object> body = ParseObject(bodyJson);
            Dictionary<string, object> twitch = RequireTwitch();
            Dictionary<string, object> settings = server.ReadSettingsObject();
            Dictionary<string, object> teamBattle = Obj(settings, "teamBattle");
            if (teamBattle.Count == 0) { teamBattle = new Dictionary<string, object>(); settings["teamBattle"] = teamBattle; }

            string title = GetString(body, "title", GetString(teamBattle, "rewardName", "Team-Kampf starten"));
            int cost = Math.Max(1, GetInt(body, "cost", 2000));
            string prompt = GetString(body, "prompt", "");
            string backgroundColor = GetString(body, "backgroundColor", "");
            bool isEnabled = GetBool(body, "isEnabled", true);
            bool isPaused = GetBool(body, "isPaused", false);
            int globalCooldown = Math.Max(0, GetInt(body, "globalCooldown", 0));
            bool explicitRewardId = body.ContainsKey("rewardId");
            string rewardId = GetString(body, "rewardId", "");
            object[] existingIds = teamBattle.ContainsKey("rewardIds") && teamBattle["rewardIds"] is object[] ? (object[])teamBattle["rewardIds"] : new object[0];
            if (!explicitRewardId && String.IsNullOrWhiteSpace(rewardId)) rewardId = existingIds.Length > 0 ? Convert.ToString(existingIds[0]) : "";

            var payload = new Dictionary<string, object>
            {
                { "title", title },
                { "cost", cost },
                { "prompt", prompt },
                { "is_enabled", isEnabled },
                { "is_user_input_required", false },
                { "should_redemptions_skip_request_queue", false },
                { "is_global_cooldown_enabled", globalCooldown > 0 },
                { "global_cooldown_seconds", globalCooldown > 0 ? globalCooldown : 1 }
            };
            if (!String.IsNullOrWhiteSpace(backgroundColor)) payload["background_color"] = backgroundColor.ToUpperInvariant();

            string baseUrl = "https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=" +
                Uri.EscapeDataString(GetString(twitch, "broadcasterId", ""));
            Dictionary<string, object> result;
            if (String.IsNullOrWhiteSpace(rewardId))
            {
                result = CreateOrAdoptReward(twitch, baseUrl, title, payload, isPaused, ref rewardId);
            }
            else
            {
                try
                {
                    payload["is_paused"] = isPaused;
                    result = TwitchJson("PATCH", baseUrl + "&id=" + Uri.EscapeDataString(rewardId), GetString(twitch, "clientId", ""), GetString(twitch, "accessToken", ""), payload);
                }
                catch (InvalidOperationException ex)
                {
                    if (ex.Message.IndexOf("was not found", StringComparison.OrdinalIgnoreCase) < 0) throw;
                    payload.Remove("is_paused");
                    result = CreateOrAdoptReward(twitch, baseUrl, title, payload, isPaused, ref rewardId);
                }
            }

            object[] rewards = result.ContainsKey("data") && result["data"] is object[] ? (object[])result["data"] : new object[0];
            Dictionary<string, object> reward = rewards.Length > 0 && rewards[0] is Dictionary<string, object>
                ? (Dictionary<string, object>)rewards[0]
                : new Dictionary<string, object>();
            string savedId = GetString(reward, "id", rewardId);
            server.Log("twitch", "info", "Team-Kampf-Belohnung gespeichert. Twitch-Antwort: " + server.Serializer.Serialize(reward));

            teamBattle["rewardIds"] = new object[] { savedId };
            teamBattle["rewardName"] = title;
            teamBattle["rewardCost"] = cost;
            teamBattle["rewardPrompt"] = prompt;
            teamBattle["rewardBackgroundColor"] = backgroundColor;
            teamBattle["rewardEnabled"] = isEnabled;
            teamBattle["rewardPaused"] = isPaused;
            teamBattle["rewardGlobalCooldown"] = globalCooldown;
            StripDeckForRewardSave(settings);
            server.WriteSettingsObject(settings);
            return settings;
        }

// "Pick your own pack" reward - the ONE reward in this app where is_user_input_required is
        // deliberately true: the viewer must type the exact pack name for HandleSpecificPackRedemption
        // to have anything to look up. Everything else about the sync mirrors SyncTeamBattleReward.
        public Dictionary<string, object> SyncSpecificPackReward(string bodyJson)
        {
            Dictionary<string, object> body = ParseObject(bodyJson);
            Dictionary<string, object> twitch = RequireTwitch();
            Dictionary<string, object> settings = server.ReadSettingsObject();
            Dictionary<string, object> specificPack = Obj(settings, "specificPackDraw");
            if (specificPack.Count == 0) { specificPack = new Dictionary<string, object>(); settings["specificPackDraw"] = specificPack; }

            string title = GetString(body, "title", GetString(specificPack, "rewardName", "Wähle dein Pack"));
            int cost = Math.Max(1, GetInt(body, "cost", 500));
            string prompt = GetString(body, "prompt", "");
            string backgroundColor = GetString(body, "backgroundColor", "");
            bool isEnabled = GetBool(body, "isEnabled", true);
            bool isPaused = GetBool(body, "isPaused", false);
            int globalCooldown = Math.Max(0, GetInt(body, "globalCooldown", 0));
            bool explicitRewardId = body.ContainsKey("rewardId");
            string rewardId = GetString(body, "rewardId", "");
            object[] existingIds = specificPack.ContainsKey("rewardIds") && specificPack["rewardIds"] is object[] ? (object[])specificPack["rewardIds"] : new object[0];
            if (!explicitRewardId && String.IsNullOrWhiteSpace(rewardId)) rewardId = existingIds.Length > 0 ? Convert.ToString(existingIds[0]) : "";

            var payload = new Dictionary<string, object>
            {
                { "title", title },
                { "cost", cost },
                { "prompt", prompt },
                { "is_enabled", isEnabled },
                { "is_user_input_required", true },
                { "should_redemptions_skip_request_queue", false },
                { "is_global_cooldown_enabled", globalCooldown > 0 },
                { "global_cooldown_seconds", globalCooldown > 0 ? globalCooldown : 1 }
            };
            if (!String.IsNullOrWhiteSpace(backgroundColor)) payload["background_color"] = backgroundColor.ToUpperInvariant();

            string baseUrl = "https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=" +
                Uri.EscapeDataString(GetString(twitch, "broadcasterId", ""));
            Dictionary<string, object> result;
            if (String.IsNullOrWhiteSpace(rewardId))
            {
                result = CreateOrAdoptReward(twitch, baseUrl, title, payload, isPaused, ref rewardId);
            }
            else
            {
                try
                {
                    payload["is_paused"] = isPaused;
                    result = TwitchJson("PATCH", baseUrl + "&id=" + Uri.EscapeDataString(rewardId), GetString(twitch, "clientId", ""), GetString(twitch, "accessToken", ""), payload);
                }
                catch (InvalidOperationException ex)
                {
                    if (ex.Message.IndexOf("was not found", StringComparison.OrdinalIgnoreCase) < 0) throw;
                    payload.Remove("is_paused");
                    result = CreateOrAdoptReward(twitch, baseUrl, title, payload, isPaused, ref rewardId);
                }
            }

            object[] rewards = result.ContainsKey("data") && result["data"] is object[] ? (object[])result["data"] : new object[0];
            Dictionary<string, object> reward = rewards.Length > 0 && rewards[0] is Dictionary<string, object>
                ? (Dictionary<string, object>)rewards[0]
                : new Dictionary<string, object>();
            string savedId = GetString(reward, "id", rewardId);
            server.Log("twitch", "info", "Pack-Auswahl-Belohnung gespeichert. Twitch-Antwort: " + server.Serializer.Serialize(reward));

            specificPack["rewardIds"] = new object[] { savedId };
            specificPack["rewardName"] = title;
            specificPack["rewardCost"] = cost;
            specificPack["rewardPrompt"] = prompt;
            specificPack["rewardBackgroundColor"] = backgroundColor;
            specificPack["rewardEnabled"] = isEnabled;
            specificPack["rewardPaused"] = isPaused;
            specificPack["rewardGlobalCooldown"] = globalCooldown;
            StripDeckForRewardSave(settings);
            server.WriteSettingsObject(settings);
            return settings;
        }

private void RestartQuietly()
        {
            try { Start(); } catch { }
        }

// Reward syncs/deletes only ever touch their own holder section (draw/showcase/...), never
        // cards or boosters - yet the settings dict obtained via ReadSettingsObject carries both.
        // Passing it to WriteSettingsObject as-is re-serialized and rewrote cards.json/boosters.json
        // (multi-MB with real card images) on every reward save, and returning it to the client
        // serialized those same megabytes into the HTTP response. Dropping the keys before the write
        // skips both: WriteSettingsObject leaves absent sections' files untouched, and the response
        // shrinks to the actual settings. Safe to remove here because the deck was never modified;
        // the removed keys only lived in this per-call dict, the files on disk keep their content.
        private static void StripDeckForRewardSave(Dictionary<string, object> settings)
        {
            settings.Remove("boosters");
            if (settings.ContainsKey("deck") && settings["deck"] is Dictionary<string, object>)
            {
                ((Dictionary<string, object>)settings["deck"]).Remove("cards");
            }
        }

private Dictionary<string, object> RequireTwitch()
        {
            Dictionary<string, object> twitch = TwitchSettings();
            if (String.IsNullOrWhiteSpace(GetString(twitch, "clientId", "")) ||
                String.IsNullOrWhiteSpace(GetString(twitch, "accessToken", "")) ||
                String.IsNullOrWhiteSpace(GetString(twitch, "broadcasterId", "")))
            {
                throw new InvalidOperationException("Bitte zuerst Twitch verbinden.");
            }
            return twitch;
        }

private Dictionary<string, object> TwitchSettings()
        {
            return EnsureObject(server.ReadSettingsObject(), "twitch");
        }

// Attempts to create a reward; if Twitch rejects it with CREATE_CUSTOM_REWARD_DUPLICATE_REWARD
        // (a same-titled reward already exists - e.g. after a settings reset or reinstall that lost
        // track of the reward id), adopts the existing manageable reward via PATCH instead of failing.
        // outRewardId is updated to the adopted id so the caller persists the right one.
        private Dictionary<string, object> CreateOrAdoptReward(Dictionary<string, object> twitch, string baseUrl, string title,
            Dictionary<string, object> payload, bool isPaused, ref string outRewardId)
        {
            try
            {
                return TwitchJson("POST", baseUrl, GetString(twitch, "clientId", ""), GetString(twitch, "accessToken", ""), payload);
            }
            catch (InvalidOperationException ex)
            {
                if (ex.Message.IndexOf("CREATE_CUSTOM_REWARD_DUPLICATE_REWARD", StringComparison.OrdinalIgnoreCase) < 0) throw;
                string existingId = FindManageableRewardIdByTitle(twitch, title);
                if (String.IsNullOrWhiteSpace(existingId))
                {
                    throw new InvalidOperationException(
                        "Twitch meldet bereits eine Belohnung mit dem Titel \"" + title + "\", die von dieser App nicht verwaltet " +
                        "werden kann (z. B. von einer anderen Anwendung angelegt). Bitte im Twitch-Dashboard umbenennen/löschen " +
                        "oder hier einen anderen Titel wählen.", ex);
                }
                payload["is_paused"] = isPaused;
                Dictionary<string, object> result = TwitchJson("PATCH", baseUrl + "&id=" + Uri.EscapeDataString(existingId),
                    GetString(twitch, "clientId", ""), GetString(twitch, "accessToken", ""), payload);
                outRewardId = existingId;
                return result;
            }
        }

// Twitch profile picture for the live ticker (see CompleteQueueItem's "liveticker"
        // broadcast) - cached per login since it almost never changes and every draw would
        // otherwise cost an extra Helix round-trip. Empty string (never cached as failure-cached
        // forever) just means the ticker falls back to no avatar for that entry.
        private readonly object avatarCacheLock = new object();

private readonly Dictionary<string, string> avatarCache = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

private string GetUserAvatarUrl(string login)
        {
            if (String.IsNullOrWhiteSpace(login)) return "";
            lock (avatarCacheLock)
            {
                string cached;
                if (avatarCache.TryGetValue(login, out cached)) return cached;
            }
            try
            {
                Dictionary<string, object> twitch = Obj(server.ReadSettingsObject(), "twitch");
                if (String.IsNullOrWhiteSpace(GetString(twitch, "clientId", "")) || String.IsNullOrWhiteSpace(GetString(twitch, "accessToken", "")))
                    return "";
                Dictionary<string, object> result = TwitchGet(
                    "https://api.twitch.tv/helix/users?login=" + Uri.EscapeDataString(login),
                    GetString(twitch, "clientId", ""), GetString(twitch, "accessToken", ""));
                object[] data = result.ContainsKey("data") && result["data"] is object[] ? (object[])result["data"] : new object[0];
                string url = "";
                if (data.Length > 0)
                {
                    Dictionary<string, object> user = data[0] as Dictionary<string, object>;
                    if (user != null) url = GetString(user, "profile_image_url", "");
                }
                lock (avatarCacheLock) { avatarCache[login] = url; }
                return url;
            }
            catch { return ""; }
        }

// Looks up a reward we can still manage (created by this or another app using the same
        // client id) by its exact title - used to self-heal CREATE_CUSTOM_REWARD_DUPLICATE_REWARD
        // when Twitch already has a same-titled reward we lost track of locally. Returns null if
        // no manageable reward has that title (e.g. it belongs to a different, unrelated app).
        private string FindManageableRewardIdByTitle(Dictionary<string, object> twitch, string title)
        {
            string url = "https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=" +
                Uri.EscapeDataString(GetString(twitch, "broadcasterId", "")) +
                "&only_manageable_rewards=true";
            Dictionary<string, object> result = TwitchGet(url, GetString(twitch, "clientId", ""), GetString(twitch, "accessToken", ""));
            object[] rewards = result.ContainsKey("data") && result["data"] is object[] ? (object[])result["data"] : new object[0];
            foreach (object item in rewards)
            {
                Dictionary<string, object> reward = item as Dictionary<string, object>;
                if (reward != null && String.Equals(GetString(reward, "title", ""), title, StringComparison.OrdinalIgnoreCase))
                    return GetString(reward, "id", "");
            }
            return null;
        }

// Plain WebClient has no exposed Timeout property and defaults to the underlying
        // HttpWebRequest's ~100s timeout - a single stalled Twitch API call (network hiccup, rate
        // limiting) could otherwise hang for well over a minute. Now that avatar/chat calls run
        // outside the tournament/Team-Kampf locks (see StartTournamentSignup etc.), a stuck request
        // no longer blocks the fight from starting, but it should still fail fast rather than tie
        // up a thread-pool thread for a minute-plus.
        private sealed class TimedWebClient : WebClient
        {
            protected override WebRequest GetWebRequest(Uri address)
            {
                WebRequest request = base.GetWebRequest(address);
                request.Timeout = 15000;
                return request;
            }
        }

private Dictionary<string, object> TwitchGet(string url, string clientId, string token)
        {
            using (var client = new TimedWebClient())
            {
                client.Encoding = Encoding.UTF8;
                if (!String.IsNullOrWhiteSpace(clientId)) client.Headers["Client-Id"] = clientId;
                if (!String.IsNullOrWhiteSpace(token)) client.Headers[HttpRequestHeader.Authorization] = "Bearer " + token;
                try
                {
                    string response = client.DownloadString(url);
                    return ParseObject(response);
                }
                catch (WebException ex)
                {
                    throw new InvalidOperationException(DescribeTwitchError(ex), ex);
                }
            }
        }

private Dictionary<string, object> TwitchJson(string method, string url, string clientId, string token, Dictionary<string, object> payload)
        {
            string response = TwitchRaw(method, url, clientId, token, server.Serializer.Serialize(payload));
            return ParseObject(response);
        }

private string TwitchRaw(string method, string url, string clientId, string token, string payload)
        {
            using (var client = new TimedWebClient())
            {
                client.Encoding = Encoding.UTF8;
                client.Headers["Client-Id"] = clientId;
                client.Headers[HttpRequestHeader.Authorization] = "Bearer " + token;
                try
                {
                    if (payload != null)
                    {
                        client.Headers[HttpRequestHeader.ContentType] = "application/json";
                        return client.UploadString(url, method, payload);
                    }
                    return client.UploadString(url, method, "");
                }
                catch (WebException ex)
                {
                    throw new InvalidOperationException(DescribeTwitchError(ex), ex);
                }
            }
        }

private string DescribeTwitchError(WebException ex)
        {
            string body = "";
            if (ex.Response != null)
            {
                using (var reader = new StreamReader(ex.Response.GetResponseStream(), Encoding.UTF8))
                {
                    body = reader.ReadToEnd();
                }
            }
            if (String.IsNullOrWhiteSpace(body)) return "Twitch API Fehler: " + ex.Message;
            Dictionary<string, object> parsed = ParseObject(body);
            string message = GetString(parsed, "message", "");
            return String.IsNullOrWhiteSpace(message)
                ? "Twitch API Fehler: " + body
                : "Twitch API Fehler: " + message;
        }

private static bool StringArrayContains(Dictionary<string, object> data, string key, string value, bool normalized = false)
        {
            if (String.IsNullOrWhiteSpace(value) || !data.ContainsKey(key) || !(data[key] is object[])) return false;
            string needle = normalized ? Normalize(value) : value;
            foreach (object item in (object[])data[key])
            {
                string text = Convert.ToString(item);
                if ((normalized ? Normalize(text) : text) == needle) return true;
            }
            return false;
        }

private static Dictionary<string, object> EnsureObject(Dictionary<string, object> parent, string key)
        {
            if (!parent.ContainsKey(key) || !(parent[key] is Dictionary<string, object>))
            {
                parent[key] = new Dictionary<string, object>();
            }
            return (Dictionary<string, object>)parent[key];
        }

private static Dictionary<string, object> Obj(Dictionary<string, object> parent, string key)
        {
            return parent.ContainsKey(key) && parent[key] is Dictionary<string, object>
                ? (Dictionary<string, object>)parent[key]
                : new Dictionary<string, object>();
        }

// IRL mode: while active, only the pack/draw reward+command may do anything - every other
        // channel-point redemption, chat command, chat/whisper output and overlay animation is
        // suppressed (see the call sites in HandleChannelPointRedemption, ProcessChatMessage,
        // SendChatMessageSafe/SendWhisperMessageSafe and the non-"draw" Broadcast calls). The one
        // exception: the pack-draw's own result message still goes out, but forced to a whisper
        // instead of public chat (see SendDrawPostMessage/SendWhisperMessageSafeForced).
        internal static bool IsIrlModeActive(Dictionary<string, object> settings)
        {
            return GetBool(Obj(settings, "irlMode"), "enabled", false);
        }

private bool? lastKnownIrlModeEnabled;

// Called after every settings save (the HTTP settings-save handler and the "!irl" chat toggle
// both call this) - detects an ON/OFF transition of IRL mode and pauses/restores every non-pack
// channel-point reward on Twitch's side accordingly. Ignoring the redemption server-side (see
// HandleChannelPointRedemption) is not enough on its own - the reward stays redeemable and
// viewers can still spend real points on something that visibly does nothing, which is exactly
// the "wasted points" complaint IRL mode is meant to avoid.
internal void SyncIrlRewardPauseIfChanged()
        {
            Dictionary<string, object> settings = server.ReadSettingsObject();
            bool nowEnabled = IsIrlModeActive(settings);
            if (lastKnownIrlModeEnabled.HasValue && lastKnownIrlModeEnabled.Value == nowEnabled) return;
            lastKnownIrlModeEnabled = nowEnabled;
            try { ApplyIrlRewardPause(settings, nowEnabled); }
            catch (Exception ex) { server.Log("twitch", "warn", "IRL-Modus: Kanalpunkte-Belohnungen konnten nicht synchronisiert werden: " + ex.Message); }
        }

private static readonly string[] IrlPausableRewardKeys = { "showcase", "tournament", "teamBattle", "specificPackDraw" };

// Pauses every non-pack reward's rewardIds when IRL mode turns on (remembering whether each was
// already paused by the streamer beforehand, in settings.irlMode.prePauseState), and restores
// each one to its own remembered state when IRL mode turns off - so turning IRL off never
// un-pauses a reward the streamer had deliberately paused for an unrelated reason.
private void ApplyIrlRewardPause(Dictionary<string, object> settings, bool irlOn)
        {
            Dictionary<string, object> twitch = TwitchSettings();
            if (String.IsNullOrWhiteSpace(GetString(twitch, "clientId", "")) ||
                String.IsNullOrWhiteSpace(GetString(twitch, "accessToken", "")) ||
                String.IsNullOrWhiteSpace(GetString(twitch, "broadcasterId", ""))) return;

            Dictionary<string, object> irlMode = EnsureObject(settings, "irlMode");
            Dictionary<string, object> snapshot = irlMode.ContainsKey("prePauseState") && irlMode["prePauseState"] is Dictionary<string, object>
                ? (Dictionary<string, object>)irlMode["prePauseState"]
                : new Dictionary<string, object>();

            bool anyChange = false;
            foreach (string key in IrlPausableRewardKeys)
            {
                Dictionary<string, object> holder = Obj(settings, key);
                object[] rewardIds = holder.ContainsKey("rewardIds") && holder["rewardIds"] is object[] ? (object[])holder["rewardIds"] : new object[0];
                if (rewardIds.Length == 0) continue;

                bool targetPaused;
                if (irlOn)
                {
                    snapshot[key] = GetBool(holder, "rewardPaused", false);
                    targetPaused = true;
                }
                else
                {
                    targetPaused = GetBool(snapshot, key, false);
                    snapshot.Remove(key);
                }

                foreach (object idObj in rewardIds)
                {
                    string rewardId = Convert.ToString(idObj);
                    if (String.IsNullOrWhiteSpace(rewardId)) continue;
                    try { SetRewardPaused(twitch, rewardId, targetPaused); }
                    catch (Exception ex)
                    {
                        server.Log("twitch", "warn", "IRL-Modus: Belohnung " + rewardId + " (" + key + ") konnte nicht " +
                            (targetPaused ? "pausiert" : "reaktiviert") + " werden: " + ex.Message);
                    }
                }
                if (!irlOn) holder["rewardPaused"] = targetPaused;
                anyChange = true;
            }

            if (anyChange)
            {
                irlMode["prePauseState"] = snapshot;
                server.WriteSettingsObject(settings);
            }
        }

private void SetRewardPaused(Dictionary<string, object> twitch, string rewardId, bool paused)
        {
            string url = "https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=" +
                Uri.EscapeDataString(GetString(twitch, "broadcasterId", "")) + "&id=" + Uri.EscapeDataString(rewardId);
            var payload = new Dictionary<string, object> { { "is_paused", paused } };
            TwitchJson("PATCH", url, GetString(twitch, "clientId", ""), GetString(twitch, "accessToken", ""), payload);
        }

private Dictionary<string, object> ParseObject(string text)
        {
            if (String.IsNullOrWhiteSpace(text)) return new Dictionary<string, object>();
            try
            {
                object parsed = server.Serializer.DeserializeObject(text);
                if (parsed is Dictionary<string, object>) return (Dictionary<string, object>)parsed;
            }
            catch
            {
            }
            return new Dictionary<string, object>();
        }

private static string GetString(Dictionary<string, object> data, string key, string fallback)
        {
            if (!data.ContainsKey(key) || data[key] == null) return fallback;
            return Convert.ToString(data[key]);
        }

private static int GetInt(Dictionary<string, object> data, string key, int fallback)
        {
            if (!data.ContainsKey(key) || data[key] == null) return fallback;
            int value;
            return Int32.TryParse(Convert.ToString(data[key]), out value) ? value : fallback;
        }

private static bool GetBool(Dictionary<string, object> data, string key, bool fallback)
        {
            if (!data.ContainsKey(key) || data[key] == null) return fallback;
            bool value;
            return Boolean.TryParse(Convert.ToString(data[key]), out value) ? value : fallback;
        }

private static string Normalize(string value)
        {
            return String.IsNullOrWhiteSpace(value) ? "" : value.Trim().ToLowerInvariant();
        }

private static string NormalizeAccessToken(string value)
        {
            if (String.IsNullOrWhiteSpace(value)) return "";
            string token = value.Trim().Trim('"', '\'');

            int accessTokenIndex = token.IndexOf("access_token=", StringComparison.OrdinalIgnoreCase);
            if (accessTokenIndex >= 0)
            {
                token = token.Substring(accessTokenIndex + "access_token=".Length);
                int end = token.IndexOfAny(new[] { '&', '#', ' ' });
                if (end >= 0) token = token.Substring(0, end);
                token = Uri.UnescapeDataString(token);
            }

            if (token.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
            {
                token = token.Substring("Bearer ".Length).Trim();
            }
            if (token.StartsWith("OAuth ", StringComparison.OrdinalIgnoreCase))
            {
                token = token.Substring("OAuth ".Length).Trim();
            }
            if (token.StartsWith("oauth:", StringComparison.OrdinalIgnoreCase))
            {
                token = token.Substring("oauth:".Length).Trim();
            }
            return token.Trim();
        }

private static void EnsureRequiredScopes(Dictionary<string, object> validation)
        {
            var scopes = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            object scopesObj;
            if (validation.TryGetValue("scopes", out scopesObj) && scopesObj is object[])
            {
                foreach (object scope in (object[])scopesObj)
                {
                    scopes.Add(Convert.ToString(scope));
                }
            }

            var missing = new List<string>();
            // channel:read:subscriptions (Sub-Belohnungen) is intentionally NOT required here -
            // it's optional on top of channel points, and CreateEventSubSubscription already
            // tolerates a token that lacks it (existing connections keep working unchanged).
            if (!scopes.Contains("channel:read:redemptions")) missing.Add("channel:read:redemptions");
            if (!scopes.Contains("channel:manage:redemptions")) missing.Add("channel:manage:redemptions");
            if (missing.Count > 0)
            {
                throw new InvalidOperationException(
                    "Token ist gueltig, aber fuer Channelpoints fehlen Scopes: " +
                    String.Join(", ", missing.ToArray()) +
                    ". Bitte einen Token mit diesen Rechten generieren.");
            }
        }
    }
}
