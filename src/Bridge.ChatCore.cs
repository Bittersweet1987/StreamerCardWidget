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
// Entry point for the card-name chat listing, independent of whether the overlay showcase
        // animation runs at all (see settings.showcase.animationEnabled) - called both from
        // ProcessQueueItem's "showcollection" handling (animation on: synced with its start) and
        // directly from the channel-points/chat-command handlers (animation off: no queue/overlay
        // involved, so this is the only thing that happens).
        private void SendCollectionChatText(string login, string displayName, Dictionary<string, object> settingsIn = null)
        {
            Dictionary<string, object> collectionCfg = Obj(Obj(settingsIn != null ? settingsIn : server.ReadSettingsObject(), "chatCommands"), "collection");
            if (!GetBool(collectionCfg, "chatOutputEnabled", true)) return;
            try { HandleCardsCommand(login, displayName, collectionCfg); }
            catch (Exception ex) { server.Log("draw", "error", "HandleCardsCommand fehlgeschlagen: " + ex.Message + " | " + ex.StackTrace); }
        }

// Part of !collection's chat output (alongside the overlay showcase) - lists every card
        // the caller owns as plain text, split across multiple messages if needed. Whether that
        // list goes to public chat or as a whisper (private message) to the redeemer/caller is
        // configurable per settings.chatCommands.collection.outputMode ("chat"/"whisper") -
        // purely a display preference, doesn't change what's counted/rewarded.
        private void HandleCardsCommand(string login, string displayName, Dictionary<string, object> collectionCfg)
        {
            string mode = GetString(collectionCfg, "outputMode", "chat");
            List<Dictionary<string, string>> owned = server.GetUserOwnedCardsWithInfo(login);
            if (owned.Count == 0)
            {
                SendCollectionOutput(login, mode, GetString(collectionCfg, "emptyMessage", DefaultCardsEmpty).Replace("@userName", "@" + displayName));
                return;
            }

            // Three-level sort, each level independently configurable (settings.chatCommands.
            // collection.sortLevel1/2/3, one of "booster"/"rarity"/"alphabetical") - so a streamer
            // can pick e.g. "first by pack, then by rarity, then alphabetically" or any other order,
            // instead of the fixed alphabetical-only sort this used to be.
            string sort1 = GetString(collectionCfg, "sortLevel1", "booster");
            string sort2 = GetString(collectionCfg, "sortLevel2", "rarity");
            string sort3 = GetString(collectionCfg, "sortLevel3", "alphabetical");
            owned.Sort(delegate (Dictionary<string, string> a, Dictionary<string, string> b)
            {
                int cmp = CompareCollectionEntries(a, b, sort1);
                if (cmp != 0) return cmp;
                cmp = CompareCollectionEntries(a, b, sort2);
                if (cmp != 0) return cmp;
                return CompareCollectionEntries(a, b, sort3);
            });
            var names = new List<string>();
            foreach (Dictionary<string, string> entry in owned)
            {
                int count = Int32.Parse(entry["count"]);
                names.Add(count > 1 ? entry["cardTitle"] + " x" + count : entry["cardTitle"]);
            }

            string header = GetString(collectionCfg, "headerMessage", DefaultCardsHeader).Replace("@userName", "@" + displayName);
            SendCardListChunked(login, mode, header, names);
        }

// One comparison level for the !collection chat listing's 3-level sort (see
        // HandleCardsCommand) - "booster"/"rarity" compare by title/rarity rank respectively,
        // anything else (including the default "alphabetical") falls back to the card's own title.
        private static int CompareCollectionEntries(Dictionary<string, string> a, Dictionary<string, string> b, string sortKey)
        {
            if (sortKey == "booster") return StringComparer.OrdinalIgnoreCase.Compare(a["boosterTitle"], b["boosterTitle"]);
            if (sortKey == "rarity") return CardPackServer.GetRarityRank(a["rarity"]).CompareTo(CardPackServer.GetRarityRank(b["rarity"]));
            return StringComparer.OrdinalIgnoreCase.Compare(a["cardTitle"], b["cardTitle"]);
        }

// Splits the (potentially long) card name list into multiple chat/whisper messages that
        // each stay under Twitch's length limit, numbering them "(1/3)" etc. when there's more
        // than one.
        private void SendCardListChunked(string login, string mode, string header, List<string> names)
        {
            int budget = Math.Max(50, MaxChatMessageLength - header.Length - 12);
            var chunks = new List<string>();
            string current = "";
            foreach (string name in names)
            {
                string candidate = current.Length == 0 ? name : current + ", " + name;
                if (candidate.Length > budget && current.Length > 0)
                {
                    chunks.Add(current);
                    current = name;
                }
                else
                {
                    current = candidate;
                }
            }
            if (current.Length > 0) chunks.Add(current);

            server.Log("draw", "info", "SendCardListChunked: " + chunks.Count + " Nachricht(en) vorbereitet, budget=" + budget + ".");

            // Chunks are sent from a background thread with a pause in between: Twitch answers
            // 200 even for messages it silently drops (is_sent=false), and firing several chat
            // messages back-to-back reliably triggers that drop for everything after the first.
            Task.Factory.StartNew(delegate
            {
                try
                {
                    for (int i = 0; i < chunks.Count; i++)
                    {
                        if (i > 0) Thread.Sleep(1500);
                        string prefix = chunks.Count > 1 ? header + " (" + (i + 1) + "/" + chunks.Count + ") " : header + " ";
                        server.Log("draw", "info", "SendCardListChunked: sende Teil " + (i + 1) + "/" + chunks.Count + ".");
                        SendCollectionOutput(login, mode, prefix + chunks[i]);
                    }
                }
                catch (Exception ex)
                {
                    server.Log("draw", "error", "SendCardListChunked-Hintergrundtask fehlgeschlagen: " + ex.Message);
                }
            });
        }

// Routes !collection's output to either public chat or a whisper (private message) to
        // the caller, per settings.chatCommands.collection.outputMode - a display preference only,
        // independent from whatever queued/triggered the collection listing in the first place.
        private void SendCollectionOutput(string login, string mode, string message)
        {
            if (String.Equals(mode, "whisper", StringComparison.OrdinalIgnoreCase)) SendWhisperMessageSafe(login, message);
            else SendChatMessageSafe(message);
        }

// Same routing as SendCollectionOutput, but reads outputMode straight off a command's own
        // config dict - used by every chat command whose ENTIRE section (all its messages: usage,
        // cooldown, success, ...) shares one "Versandart" (öffentlich/Flüster) setting, rather than
        // a single list-style message. cmdCfg == null means the section has no outputMode concept
        // (e.g. non-chat trigger sources) - always public chat in that case.
        private void SendCommandOutput(string login, Dictionary<string, object> cmdCfg, string message)
        {
            string mode = cmdCfg != null ? GetString(cmdCfg, "outputMode", "chat") : "chat";
            if (String.Equals(mode, "whisper", StringComparison.OrdinalIgnoreCase)) SendWhisperMessageSafe(login, message);
            else SendChatMessageSafe(message);
        }

private void DispatchOutboundWork(Action work)
        {
            lock (outboundLock)
            {
                outboundQueue.Enqueue(work);
                if (outboundWorkerRunning) return;
                outboundWorkerRunning = true;
            }
            Task.Factory.StartNew(OutboundLoop);
        }

private void OutboundLoop()
        {
            while (true)
            {
                Action work;
                lock (outboundLock)
                {
                    if (outboundQueue.Count == 0) { outboundWorkerRunning = false; return; }
                    work = outboundQueue.Dequeue();
                }
                try { work(); }
                catch (Exception ex) { server.Log("twitch", "error", "Ausgehende Twitch-Anfrage fehlgeschlagen: " + ex.Message); }
            }
        }

private void SendChatMessageSafe(string message)
        {
            DispatchOutboundWork(delegate
            {
                try { SendChatMessage(message); }
                catch (Exception ex) { server.Log("twitch", "error", "Chat-Nachricht konnte nicht gesendet werden: " + ex.Message); }
            });
        }

private void SendChatMessage(string message)
        {
            if (String.IsNullOrWhiteSpace(message)) return;
            Dictionary<string, object> twitch = TwitchSettings();
            Dictionary<string, object> chat = ChatCredential();
            string broadcasterId = GetString(twitch, "broadcasterId", "");
            string senderId = GetString(chat, "broadcasterId", broadcasterId);
            if (String.IsNullOrWhiteSpace(GetString(chat, "accessToken", "")) || String.IsNullOrWhiteSpace(broadcasterId)) return;
            var body = new Dictionary<string, object>
            {
                { "broadcaster_id", broadcasterId },
                { "sender_id", senderId },
                { "message", message }
            };
            Dictionary<string, object> response = TwitchJson("POST", "https://api.twitch.tv/helix/chat/messages", GetString(chat, "clientId", ""), GetString(chat, "accessToken", ""), body);
            // Helix returns 200 even for messages Twitch silently drops (spam/rate filter);
            // whether it actually reached chat is only visible in is_sent/drop_reason.
            object dataObj;
            if (response.TryGetValue("data", out dataObj) && dataObj is object[] && ((object[])dataObj).Length > 0)
            {
                Dictionary<string, object> entry = ((object[])dataObj)[0] as Dictionary<string, object>;
                if (entry != null && !GetBool(entry, "is_sent", true))
                {
                    object dropObj;
                    Dictionary<string, object> drop = entry.TryGetValue("drop_reason", out dropObj) ? dropObj as Dictionary<string, object> : null;
                    string reason = drop != null ? GetString(drop, "code", "") + " " + GetString(drop, "message", "") : "unbekannt";
                    server.Log("twitch", "warn", "Chat-Nachricht von Twitch verworfen (" + reason.Trim() + "): " + (message.Length > 80 ? message.Substring(0, 80) + "..." : message));
                }
            }
        }

private void SendWhisperMessageSafe(string login, string message)
        {
            DispatchOutboundWork(delegate
            {
                try { SendWhisperMessage(login, message); }
                catch (Exception ex) { server.Log("twitch", "error", "Fluester-Nachricht konnte nicht gesendet werden: " + ex.Message); }
            });
        }

// Resolves the recipient's user id on demand (whispers address by id, chat commands only
        // carry the login) and sends via Helix's whisper endpoint. Requires "user:manage:whispers"
        // on whichever account ChatCredential() resolves to (bot if connected, else the main
        // account) - an older connection made before this scope existed needs a one-time
        // reconnect under Verbindung, same as the earlier bits:read case.
        private void SendWhisperMessage(string login, string message)
        {
            if (String.IsNullOrWhiteSpace(message) || String.IsNullOrWhiteSpace(login)) return;
            Dictionary<string, object> chat = ChatCredential();
            string fromId = GetString(chat, "broadcasterId", "");
            string clientId = GetString(chat, "clientId", "");
            string token = GetString(chat, "accessToken", "");
            if (String.IsNullOrWhiteSpace(token) || String.IsNullOrWhiteSpace(fromId)) return;
            string toId = GetTwitchUserId(login, clientId, token);
            if (String.IsNullOrWhiteSpace(toId))
            {
                server.Log("twitch", "warn", "Fluester-Nachricht: Twitch-User-ID fuer '" + login + "' nicht gefunden.");
                return;
            }
            if (toId == fromId) return; // Twitch rejects whispering yourself.
            var body = new Dictionary<string, object> { { "message", message } };
            string url = "https://api.twitch.tv/helix/whispers?from_user_id=" + Uri.EscapeDataString(fromId) + "&to_user_id=" + Uri.EscapeDataString(toId);
            TwitchRaw("POST", url, clientId, token, server.Serializer.Serialize(body));
        }

private string GetTwitchUserId(string login, string clientId, string token)
        {
            Dictionary<string, object> response = TwitchGet("https://api.twitch.tv/helix/users?login=" + Uri.EscapeDataString(login), clientId, token);
            object dataObj;
            if (response.TryGetValue("data", out dataObj) && dataObj is object[] && ((object[])dataObj).Length > 0)
            {
                Dictionary<string, object> entry = ((object[])dataObj)[0] as Dictionary<string, object>;
                if (entry != null) return GetString(entry, "id", "");
            }
            return "";
        }

// Called on every incoming chat message - only handles the message-count side (the time
        // side is handled by the independent timer below, since a chat-message-driven check would
        // never fire the time trigger during a quiet chat with 0 chat activity).
        private void CheckAutoHelp(Dictionary<string, object> settings, Dictionary<string, object> cc)
        {
            Dictionary<string, object> autoHelp = Obj(settings, "autoHelp");
            if (!GetBool(autoHelp, "enabled", false)) return;
            int intervalMessages = Math.Max(0, GetInt(autoHelp, "intervalMessages", 0));
            if (intervalMessages <= 0) return;
            if (GetBool(autoHelp, "onlyWhenLive", false) && !IsStreamLive()) return;

            bool shouldSend;
            lock (autoHelpLock)
            {
                autoHelpMessageCounter++;
                shouldSend = autoHelpMessageCounter >= intervalMessages;
                if (shouldSend)
                {
                    autoHelpMessageCounter = 0;
                    autoHelpLastSentAt = DateTime.UtcNow;
                }
            }
            if (shouldSend) SendAutoHelpMessage(settings, cc, autoHelp);
        }

// Runs on a fixed timer (see StartAutoHelpTimerOnce) independent of chat activity, so the
        // "after X minutes" trigger fires even during a completely quiet chat.
        private void CheckAutoHelpTimer()
        {
            Dictionary<string, object> settings = server.ReadSettingsObject();
            Dictionary<string, object> cc = Obj(settings, "chatCommands");
            Dictionary<string, object> autoHelp = Obj(settings, "autoHelp");
            if (!GetBool(autoHelp, "enabled", false)) return;
            int intervalMinutes = Math.Max(0, GetInt(autoHelp, "intervalMinutes", 0));
            if (intervalMinutes <= 0) return;
            if (GetBool(autoHelp, "onlyWhenLive", false) && !IsStreamLive()) return;

            bool shouldSend;
            lock (autoHelpLock)
            {
                shouldSend = (DateTime.UtcNow - autoHelpLastSentAt).TotalMinutes >= intervalMinutes;
                if (shouldSend)
                {
                    autoHelpMessageCounter = 0;
                    autoHelpLastSentAt = DateTime.UtcNow;
                }
            }
            if (shouldSend) SendAutoHelpMessage(settings, cc, autoHelp);
        }

private void SendAutoHelpMessage(Dictionary<string, object> settings, Dictionary<string, object> cc, Dictionary<string, object> autoHelp)
        {
            string list = BuildAutoHelpCommandList(cc);
            if (String.IsNullOrWhiteSpace(list)) return;
            string message = GetString(autoHelp, "message", DefaultAutoHelpMessage).Replace("[Befehle]", list);
            SendChatMessageSafe(message);
        }

        // Twitch "is the channel currently live" check (Helix GET /streams?user_id=...), cached for
        // 60s - CheckAutoHelp runs on every incoming chat message, so an uncached call here would
        // hit Helix once per chat message whenever "nur bei Live" is enabled during active chat.
        private readonly object streamLiveLock = new object();
        private DateTime streamLiveCacheAt = DateTime.MinValue;
        private bool streamLiveCacheValue;

        private bool IsStreamLive()
        {
            lock (streamLiveLock)
            {
                if ((DateTime.UtcNow - streamLiveCacheAt).TotalSeconds < 60) return streamLiveCacheValue;
            }
            Dictionary<string, object> twitch = TwitchSettings();
            Dictionary<string, object> chat = ChatCredential();
            string broadcasterId = GetString(twitch, "broadcasterId", "");
            string clientId = GetString(chat, "clientId", "");
            string token = GetString(chat, "accessToken", "");
            bool live = false;
            if (!String.IsNullOrWhiteSpace(broadcasterId) && !String.IsNullOrWhiteSpace(token))
            {
                try
                {
                    Dictionary<string, object> response = TwitchGet("https://api.twitch.tv/helix/streams?user_id=" + Uri.EscapeDataString(broadcasterId), clientId, token);
                    object dataObj;
                    live = response.TryGetValue("data", out dataObj) && dataObj is object[] && ((object[])dataObj).Length > 0;
                }
                catch (Exception ex) { server.Log("twitch", "warn", "Live-Status-Abfrage fehlgeschlagen: " + ex.Message); }
            }
            lock (streamLiveLock)
            {
                streamLiveCacheAt = DateTime.UtcNow;
                streamLiveCacheValue = live;
            }
            return live;
        }

private void StartAutoHelpTimerOnce()
        {
            if (autoHelpTimerStarted) return;
            autoHelpTimerStarted = true;
            // autoHelpLastSentAt is initialized to "now" at app start, so the first check 30s in
            // won't immediately fire even with a short configured interval - matches user
            // expectation of "after X minutes [of being enabled]", not "instantly on next tick".
            autoHelpTimer = new System.Threading.Timer(delegate
            {
                try { CheckAutoHelpTimer(); }
                catch (Exception ex) { server.Log("twitch", "error", "Auto-Hilfe-Timer fehlgeschlagen: " + ex.Message); }
            }, null, 30000, 30000);
        }

// Lists every enabled, user-initiated command (not the yes/no follow-up commands, which
        // only make sense once a trade/battle is already pending) with its short description.
        private string BuildAutoHelpCommandList(Dictionary<string, object> cc)
        {
            var parts = new List<string>();
            foreach (string key in new[] { "pack", "packs", "dust", "collection", "trade", "battle", "ranking", "tournamentStart", "teamBattleStart" })
            {
                Dictionary<string, object> command = Obj(cc, key);
                if (!GetBool(command, "enabled", key != "dust")) continue;
                string prefix = GetString(command, "prefix", "!");
                string word = GetString(command, "command", key);
                string helpText = GetString(command, "helpText", "").Trim();
                parts.Add(helpText.Length > 0 ? prefix + word + " - " + helpText : prefix + word);
            }
            return String.Join(" | ", parts);
        }

// ---- Command parsing + per-user usage/cooldown tracking ----

        private void ProcessChatMessage(string login, string displayName, string text)
        {
            Dictionary<string, object> settings = server.ReadSettingsObject();
            Dictionary<string, object> cc = Obj(settings, "chatCommands");
            CheckAutoHelp(settings, cc);
            text = text.Trim();
            if (text.Length == 0) return;

            Dictionary<string, object> pack = Obj(cc, "pack");
            Dictionary<string, object> packs = Obj(cc, "packs");
            Dictionary<string, object> dust = Obj(cc, "dust");
            Dictionary<string, object> dustSet = Obj(cc, "dustSet");
            Dictionary<string, object> dustAll = Obj(cc, "dustAll");
            Dictionary<string, object> gift = Obj(cc, "gift");
            Dictionary<string, object> compare = Obj(cc, "compare");
            Dictionary<string, object> collection = Obj(cc, "collection");
            Dictionary<string, object> trade = Obj(cc, "trade");
            Dictionary<string, object> tradeYes = Obj(cc, "tradeyes");
            Dictionary<string, object> tradeNo = Obj(cc, "tradeno");
            Dictionary<string, object> battle = Obj(cc, "battle");
            Dictionary<string, object> battleYes = Obj(cc, "battleyes");
            Dictionary<string, object> battleNo = Obj(cc, "battleno");
            Dictionary<string, object> ranking = Obj(cc, "ranking");
            Dictionary<string, object> tournamentStart = Obj(cc, "tournamentStart");
            Dictionary<string, object> tournamentJoin = Obj(cc, "tournamentJoin");
            Dictionary<string, object> teamBattleStart = Obj(cc, "teamBattleStart");
            Dictionary<string, object> teamBattleJoin = Obj(cc, "teamBattleJoin");
            Dictionary<string, object> specificPackDraw = Obj(cc, "specificPackDraw");
            Dictionary<string, object> showPack = Obj(cc, "showPack");

            if (MatchesCommand(text, pack))
            {
                if (GetBool(pack, "enabled", true)) HandlePackCommand(login, displayName, pack);
                return;
            }
            if (MatchesCommand(text, specificPackDraw))
            {
                if (GetBool(specificPackDraw, "enabled", false)) HandleSpecificPackDrawCommand(login, displayName, ArgsAfterCommand(text, specificPackDraw), specificPackDraw, settings);
                return;
            }
            if (MatchesCommand(text, packs))
            {
                if (GetBool(packs, "enabled", true)) HandlePacksCommand(login, displayName, packs, settings);
                return;
            }
            if (MatchesCommand(text, dust))
            {
                if (GetBool(dust, "enabled", false)) HandleDustCommand(login, displayName, ArgsAfterCommand(text, dust), dust, settings);
                return;
            }
            // "!dustset"/"!dustall" are sub-commands of "!dust": no prefix field of their own,
            // they always use dust's prefix - only their command WORD is independently
            // renameable. Gated on dust's own "enabled" toggle, same dependency.
            Dictionary<string, object> dustSetMatch = new Dictionary<string, object> { { "prefix", GetString(dust, "prefix", "!") }, { "command", GetString(dustSet, "command", "dustset") } };
            if (MatchesCommand(text, dustSetMatch))
            {
                if (GetBool(dust, "enabled", false)) HandleDustSetCommand(login, displayName, ArgsAfterCommand(text, dustSetMatch), dust, dustSet, settings);
                return;
            }
            Dictionary<string, object> dustAllMatch = new Dictionary<string, object> { { "prefix", GetString(dust, "prefix", "!") }, { "command", GetString(dustAll, "command", "dustall") } };
            if (MatchesCommand(text, dustAllMatch))
            {
                if (GetBool(dust, "enabled", false)) HandleDustAllCommand(login, displayName, dust, dustAll, settings);
                return;
            }
            if (MatchesCommand(text, collection))
            {
                // No usage limit, no cooldown, no tracking for the collection command. When the
                // showcase animation is enabled, the card-name chat text (own toggle, on by
                // default) is sent when the queue actually reaches this item (see
                // ProcessQueueItem's "showcollection" handling), synced with the animation
                // starting. When the animation is switched off entirely, there's nothing to queue
                // or animate, so the chat text goes out directly instead.
                if (GetBool(collection, "enabled", true))
                {
                    if (GetBool(Obj(settings, "showcase"), "animationEnabled", true))
                        Enqueue("showcollection", login, displayName, "chat");
                    else
                        SendCollectionChatText(login, displayName, settings);
                }
                return;
            }
            if (MatchesCommand(text, showPack))
            {
                if (GetBool(showPack, "enabled", false)) HandleShowPackCommand(login, displayName, ArgsAfterCommand(text, showPack), showPack, settings);
                return;
            }
            if (MatchesCommand(text, gift))
            {
                if (GetBool(gift, "enabled", false)) HandleGiftCommand(login, displayName, ArgsAfterCommand(text, gift), gift);
                return;
            }
            if (MatchesCommand(text, compare))
            {
                if (GetBool(compare, "enabled", false)) HandleCompareCommand(login, displayName, ArgsAfterCommand(text, compare), compare);
                return;
            }
            if (MatchesCommand(text, tradeYes))
            {
                if (GetBool(tradeYes, "enabled", true)) HandleTradeYes(login, displayName, ArgsAfterCommand(text, tradeYes), cc);
                return;
            }
            if (MatchesCommand(text, tradeNo))
            {
                if (GetBool(tradeNo, "enabled", true)) HandleTradeNo(login, displayName, cc);
                return;
            }
            if (MatchesCommand(text, trade))
            {
                if (GetBool(trade, "enabled", true)) HandleTradeCommand(login, displayName, ArgsAfterCommand(text, trade), trade);
                return;
            }
            if (MatchesCommand(text, battleYes))
            {
                if (GetBool(battleYes, "enabled", true)) HandleBattleYes(login, displayName, cc);
                return;
            }
            if (MatchesCommand(text, battleNo))
            {
                if (GetBool(battleNo, "enabled", true)) HandleBattleNo(login, displayName, cc);
                return;
            }
            if (MatchesCommand(text, battle))
            {
                if (GetBool(battle, "enabled", true)) HandleBattleCommand(login, displayName, ArgsAfterCommand(text, battle), battle);
                return;
            }
            if (MatchesCommand(text, ranking))
            {
                if (GetBool(ranking, "enabled", true)) HandleRankingCommand(login, displayName, ArgsAfterCommand(text, ranking), ranking);
                return;
            }
            if (MatchesCommand(text, tournamentStart))
            {
                if (GetBool(tournamentStart, "enabled", true))
                {
                    int cooldownSeconds = Math.Max(0, GetInt(tournamentStart, "cooldownSeconds", 0));
                    string cooldownMessage = GetString(tournamentStart, "cooldownMessage", DefaultCooldownMessage);
                    if (!IsGlobalCommandOnCooldown("tournamentStart", cooldownSeconds, login, displayName, cooldownMessage, tournamentStart))
                        StartTournamentSignup(login, displayName, "chat");
                }
                return;
            }
            if (MatchesCommand(text, tournamentJoin))
            {
                if (GetBool(tournamentJoin, "enabled", true)) JoinTournament(login, displayName, settings);
                return;
            }
            if (MatchesCommand(text, teamBattleStart))
            {
                if (GetBool(teamBattleStart, "enabled", true))
                {
                    int cooldownSeconds = Math.Max(0, GetInt(teamBattleStart, "cooldownSeconds", 0));
                    string cooldownMessage = GetString(teamBattleStart, "cooldownMessage", DefaultCooldownMessage);
                    if (!IsGlobalCommandOnCooldown("teamBattleStart", cooldownSeconds, login, displayName, cooldownMessage, teamBattleStart))
                        StartTeamBattleSignup(login, displayName, "chat");
                }
                return;
            }
            if (MatchesCommand(text, teamBattleJoin))
            {
                if (GetBool(teamBattleJoin, "enabled", true)) JoinTeamBattle(login, displayName, settings);
                return;
            }
        }

internal static bool MatchesCommand(string text, Dictionary<string, object> cmd)
        {
            string prefix = GetString(cmd, "prefix", "");
            string word = GetString(cmd, "command", "");
            if (String.IsNullOrEmpty(prefix) || String.IsNullOrWhiteSpace(word)) return false;
            string full = prefix + word;
            if (text.Length < full.Length) return false;
            if (String.Compare(text, 0, full, 0, full.Length, StringComparison.OrdinalIgnoreCase) != 0) return false;
            // Require a word boundary so e.g. "!packs" does not match the "!pack" command.
            return text.Length == full.Length || Char.IsWhiteSpace(text[full.Length]);
        }

private bool IsGlobalCommandOnCooldown(string key, int cooldownSeconds, string login, string displayName, string cooldownMessageTemplate, Dictionary<string, object> cmdCfg)
        {
            if (cooldownSeconds <= 0) return false;
            DateTime now = DateTime.UtcNow;
            lock (commandCooldownLock)
            {
                DateTime until;
                if (commandCooldownUntil.TryGetValue(key, out until) && until > now)
                {
                    int remaining = (int)Math.Ceiling((until - now).TotalSeconds);
                    SendCommandOutput(login, cmdCfg, cooldownMessageTemplate
                        .Replace("@userName", "@" + displayName)
                        .Replace("[Restzeit]", remaining.ToString()));
                    return true;
                }
                commandCooldownUntil[key] = now.AddSeconds(cooldownSeconds);
                return false;
            }
        }

// Which language the [Seltenheit] chat variable is written out in - one app-wide setting
        // (settings.chatCommands.rarityLanguage) rather than per-message, since it's the same
        // rarity vocabulary everywhere (draw messages, !dustset/!dustall). Falls back to German,
        // matching every other hardcoded default string in this file.
        private string RarityOutputLanguage(Dictionary<string, object> settingsIn = null)
        {
            Dictionary<string, object> cc = Obj(settingsIn != null ? settingsIn : server.ReadSettingsObject(), "chatCommands");
            string lang = GetString(cc, "rarityLanguage", "de");
            switch (lang) { case "en": case "fr": case "es": case "th": return lang; default: return "de"; }
        }

// Localized rarity display name for the [Seltenheit] chat variable, in any of the app's 5
        // supported languages - mirrors admin.js's "rarity-*" i18n keys (kept in sync with those
        // exact translations).
        private static string RarityLabel(string rarity, string language)
        {
            switch (language)
            {
                case "en":
                    switch (rarity) { case "uncommon": return "Uncommon"; case "rare": return "Rare"; case "epic": return "Epic"; case "legendary": return "Legendary"; case "holo": return "Holo"; default: return "Common"; }
                case "fr":
                    switch (rarity) { case "uncommon": return "Peu commune"; case "rare": return "Rare"; case "epic": return "Épique"; case "legendary": return "Légendaire"; case "holo": return "Holo"; default: return "Commune"; }
                case "es":
                    switch (rarity) { case "uncommon": return "Poco común"; case "rare": return "Rara"; case "epic": return "Épica"; case "legendary": return "Legendaria"; case "holo": return "Holo"; default: return "Común"; }
                case "th":
                    switch (rarity) { case "uncommon": return "ไม่ธรรมดา"; case "rare": return "หายาก"; case "epic": return "เอพิก"; case "legendary": return "ตำนาน"; case "holo": return "โฮโล"; default: return "ธรรมดา"; }
                default:
                    switch (rarity) { case "uncommon": return "Ungewöhnlich"; case "rare": return "Selten"; case "epic": return "Episch"; case "legendary": return "Legendär"; case "holo": return "Holo"; default: return "Gewöhnlich"; }
            }
        }

// Localized label for the [Quelle] chat variable - describes WHAT triggered a card draw
        // (channel points, a chat command, bits, the community goal, a sub, a Team-Kampf reward,
        // etc.), reusing the same language setting as [Seltenheit] (chatCommands.rarityLanguage).
        // "source" is the same string tagged on every Enqueue("draw", ...) call across the file.
        private static string SourceLabel(string source, string language)
        {
            switch (language)
            {
                case "en":
                    switch (source)
                    {
                        case "channelpoints": return "Channel Points";
                        case "chat": return "chat command";
                        case "bits": return "Bits";
                        case "communitygoal": return "Community Goal";
                        case "tournament": return "Tournament";
                        case "teamkampf": return "Team Battle";
                        case "sub": return "Sub";
                        case "resub": return "Resub";
                        case "giftsub": return "Gifted Sub";
                        case "specificpack": return "chosen pack";
                        default: return source;
                    }
                case "fr":
                    switch (source)
                    {
                        case "channelpoints": return "Points de chaîne";
                        case "chat": return "commande de chat";
                        case "bits": return "Bits";
                        case "communitygoal": return "Objectif communautaire";
                        case "tournament": return "Tournoi";
                        case "teamkampf": return "Combat d'équipe";
                        case "sub": return "Abonnement";
                        case "resub": return "Réabonnement";
                        case "giftsub": return "Abonnement offert";
                        case "specificpack": return "booster choisi";
                        default: return source;
                    }
                case "es":
                    switch (source)
                    {
                        case "channelpoints": return "Puntos de canal";
                        case "chat": return "comando de chat";
                        case "bits": return "Bits";
                        case "communitygoal": return "Meta comunitaria";
                        case "tournament": return "Torneo";
                        case "teamkampf": return "Combate de equipo";
                        case "sub": return "Suscripción";
                        case "resub": return "Resuscripción";
                        case "giftsub": return "Suscripción regalada";
                        case "specificpack": return "sobre elegido";
                        default: return source;
                    }
                case "th":
                    switch (source)
                    {
                        case "channelpoints": return "แชนแนลพอยท์";
                        case "chat": return "คำสั่งแชท";
                        case "bits": return "บิต";
                        case "communitygoal": return "เป้าหมายชุมชน";
                        case "tournament": return "ทัวร์นาเมนต์";
                        case "teamkampf": return "การต่อสู้ทีม";
                        case "sub": return "การสมัครสมาชิก";
                        case "resub": return "การสมัครสมาชิกต่อ";
                        case "giftsub": return "การสมัครสมาชิกที่ได้รับของขวัญ";
                        case "specificpack": return "แพ็กที่เลือก";
                        default: return source;
                    }
                default:
                    switch (source)
                    {
                        case "channelpoints": return "Kanalpunkte";
                        case "chat": return "Chat-Befehl";
                        case "bits": return "Bits";
                        case "communitygoal": return "Community-Ziel";
                        case "tournament": return "Turnier";
                        case "teamkampf": return "Team-Kampf";
                        case "sub": return "Sub";
                        case "resub": return "Resub";
                        case "giftsub": return "Geschenkter Sub";
                        case "specificpack": return "Gewähltes Pack";
                        default: return source;
                    }
            }
        }

// ---- Trade system: !trade / !tradeyes / !tradeno ----

        private static string ArgsAfterCommand(string text, Dictionary<string, object> cmd)
        {
            string full = GetString(cmd, "prefix", "") + GetString(cmd, "command", "");
            if (text.Length <= full.Length) return "";
            return text.Substring(full.Length).Trim();
        }
    }
}
