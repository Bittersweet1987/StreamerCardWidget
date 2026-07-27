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
private void HandleTradeCommand(string login, string displayName, string args, Dictionary<string, object> tradeCfg)
        {
            // "@partner cardName with spaces" -> partner + free-text card name.
            string rest = args.Trim();
            if (rest.Length == 0) return;
            int sp = rest.IndexOf(' ');
            if (sp < 0) return; // need both a partner and a card name
            string partnerRaw = rest.Substring(0, sp).Trim().TrimStart('@');
            string cardName = rest.Substring(sp + 1).Trim();
            if (partnerRaw.Length == 0 || cardName.Length == 0) return;
            string partnerLogin = partnerRaw.ToLowerInvariant();

            int cooldownSeconds = Math.Max(0, GetInt(tradeCfg, "cooldownSeconds", 0));
            int maxUses = Math.Max(0, GetInt(tradeCfg, "maxUses", 0));
            int timeoutSeconds = Math.Max(10, GetInt(tradeCfg, "requestTimeoutSeconds", 120));
            DateTime now = DateTime.UtcNow;

            lock (tradeLock)
            {
                if (activeTrade != null)
                {
                    SendChatMessageSafe(GetString(tradeCfg, "busyMessage", DefaultTradeBusy).Replace("@userName", "@" + displayName));
                    return;
                }

                lock (usageLock)
                {
                    EnsureUsageLoaded();
                    ApplyTradeResetIfDue(tradeCfg, now);
                    Dictionary<string, object> entry = GetOrCreateTradeEntry(login, displayName);

                    DateTime cooldownUntil = ParseDate(GetString(entry, "cooldownUntil", ""));
                    if (cooldownSeconds > 0 && cooldownUntil > now.AddSeconds(cooldownSeconds)) { cooldownUntil = now.AddSeconds(cooldownSeconds); entry["cooldownUntil"] = cooldownUntil.ToString("o"); }
                    if (cooldownSeconds > 0 && cooldownUntil > now)
                    {
                        string msg = GetString(tradeCfg, "cooldownMessage", DefaultTradeCooldown)
                            .Replace("@userName", "@" + displayName)
                            .Replace("[Uhrzeit]", FormatLocalTime(cooldownUntil))
                            .Replace("[Cooldownwert]", cooldownSeconds.ToString())
                            .Replace("[Einheit]", "Sekunden");
                        SendChatMessageSafe(msg);
                        return;
                    }

                    if (maxUses > 0 && GetInt(entry, "count", 0) >= maxUses)
                    {
                        string msg = GetString(tradeCfg, "limitMessage", DefaultTradeLimit)
                            .Replace("@userName", "@" + displayName)
                            .Replace("[Uhrzeit]", FormatLocalTime(TradeNextReset()));
                        SendChatMessageSafe(msg);
                        return;
                    }
                }

                // Partner must exist (has drawn cards before).
                if (!server.UserExistsInCollections(partnerLogin))
                {
                    SendChatMessageSafe(GetString(tradeCfg, "userNotFoundMessage", DefaultTradeUserNotFound)
                        .Replace("@userName", "@" + displayName)
                        .Replace("[Nutzer]", partnerRaw));
                    return;
                }

                // Resolve the offered card name (no cooldown / quota consumed on a typo).
                Dictionary<string, object> card = server.ResolveCardByName(cardName);
                if (!Convert.ToBoolean(card["found"]))
                {
                    SendChatMessageSafe(GetString(tradeCfg, "cardNotFoundMessage", DefaultTradeCardNotFound)
                        .Replace("@userName", "@" + displayName)
                        .Replace("[falscherName]", cardName)
                        .Replace("[Kartenname]", GetString(card, "suggestion", "")));
                    return;
                }
                string cardId = GetString(card, "cardId", "");
                string cardTitle = GetString(card, "cardTitle", "");
                string boosterId = GetString(card, "boosterId", "");
                string boosterTitle = GetString(card, "boosterTitle", "");

                // The offering user must actually own the card.
                if (server.GetCardCount(login, boosterId, cardId) < 1)
                {
                    SendChatMessageSafe(GetString(tradeCfg, "offerNotOwnedMessage", DefaultTradeOfferNotOwned)
                        .Replace("@userName", "@" + displayName)
                        .Replace("[Kartenname]", cardTitle));
                    return;
                }

                activeTrade = new Dictionary<string, object>
                {
                    { "id", Guid.NewGuid().ToString("N") },
                    { "kind", "trade" },
                    { "source", "chat" },
                    { "triggeredAt", now.ToString("o") },
                    { "fromLogin", login.ToLowerInvariant() },
                    { "fromUser", displayName },
                    { "toLogin", partnerLogin },
                    { "toUser", partnerRaw },
                    { "cardId", cardId },
                    { "cardTitle", cardTitle },
                    { "boosterId", boosterId },
                    { "boosterTitle", boosterTitle },
                    { "expiresAt", now.AddSeconds(timeoutSeconds).ToString("o") }
                };
                if (tradeTimeoutTimer != null) tradeTimeoutTimer.Dispose();
                tradeTimeoutTimer = new System.Threading.Timer(delegate { TradeTimedOut(); }, null, timeoutSeconds * 1000, Timeout.Infinite);

                Dictionary<string, object> ccForOffer = Obj(server.ReadSettingsObject(), "chatCommands");
                Dictionary<string, object> tradeYesCfg = Obj(ccForOffer, "tradeyes");
                Dictionary<string, object> tradeNoCfg = Obj(ccForOffer, "tradeno");
                string befehlAnnehmen = GetString(tradeYesCfg, "prefix", "!") + GetString(tradeYesCfg, "command", "tradeyes");
                string befehlAblehnen = GetString(tradeNoCfg, "prefix", "!") + GetString(tradeNoCfg, "command", "tradeno");

                SendChatMessageSafe(GetString(tradeCfg, "offerMessage", DefaultTradeOffer)
                    .Replace("@userNameB", "@" + partnerRaw)
                    .Replace("@userNameA", "@" + displayName)
                    .Replace("[BefehlAnnehmen]", befehlAnnehmen)
                    .Replace("[BefehlAblehnen]", befehlAblehnen)
                    .Replace("[Kartenname]", cardTitle)
                    .Replace("[Boostername]", boosterTitle));
            }
            BroadcastQueue();
            SavePendingState();
        }

private void HandleTradeYes(string login, string displayName, string args, Dictionary<string, object> cc)
        {
            Dictionary<string, object> tradeCfg = Obj(cc, "trade");
            Dictionary<string, object> yesCfg = Obj(cc, "tradeyes");
            lock (tradeLock)
            {
                if (activeTrade == null) return;
                if (login.ToLowerInvariant() != GetString(activeTrade, "toLogin", "")) return;
                string cardName = args.Trim();
                if (cardName.Length == 0) return;

                Dictionary<string, object> card = server.ResolveCardByName(cardName);
                if (!Convert.ToBoolean(card["found"]))
                {
                    SendChatMessageSafe(GetString(tradeCfg, "cardNotFoundMessage", DefaultTradeCardNotFound)
                        .Replace("@userName", "@" + displayName)
                        .Replace("[falscherName]", cardName)
                        .Replace("[Kartenname]", GetString(card, "suggestion", "")));
                    return; // trade stays open, partner can retry within the timeout
                }
                string cardBId = GetString(card, "cardId", "");
                string cardBTitle = GetString(card, "cardTitle", "");
                string boosterBId = GetString(card, "boosterId", "");
                string boosterBTitle = GetString(card, "boosterTitle", "");

                if (server.GetCardCount(login, boosterBId, cardBId) < 1)
                {
                    SendChatMessageSafe(GetString(yesCfg, "notOwnedMessage", DefaultTradeNotOwned)
                        .Replace("@userNameB", "@" + displayName));
                    return; // trade stays open
                }

                string fromLogin = GetString(activeTrade, "fromLogin", "");
                string fromUser = GetString(activeTrade, "fromUser", "");
                string cardAId = GetString(activeTrade, "cardId", "");
                string cardATitle = GetString(activeTrade, "cardTitle", "");
                string boosterAId = GetString(activeTrade, "boosterId", "");
                string boosterATitle = GetString(activeTrade, "boosterTitle", "");

                Dictionary<string, object> result = server.ApplyTradeSwap(fromLogin, fromUser, boosterAId, cardAId, login, displayName, boosterBId, cardBId);
                if (result == null)
                {
                    SendChatMessageSafe(GetString(yesCfg, "notOwnedMessage", DefaultTradeNotOwned)
                        .Replace("@userNameB", "@" + displayName));
                    return;
                }

                DateTime now = DateTime.UtcNow;
                int cooldownSeconds = Math.Max(0, GetInt(tradeCfg, "cooldownSeconds", 0));
                lock (usageLock)
                {
                    EnsureUsageLoaded();
                    ConsumeTrade(fromLogin, fromUser, cooldownSeconds, now);
                    ConsumeTrade(login, displayName, cooldownSeconds, now);
                    SaveUsage();
                }
                server.RecordTradeCompleted(fromLogin, fromUser, login, displayName);

                // Trade animation (own OBS source) + optional chat message. When the animation is
                // enabled, the streamer can choose whether the chat success message is still sent.
                Dictionary<string, object> tradeAnim = Obj(server.ReadSettingsObject(), "tradeAnimation");
                bool animEnabled = GetBool(tradeAnim, "enabled", false);
                bool sendChat = animEnabled ? GetBool(tradeAnim, "sendChat", true) : true;
                if (sendChat)
                {
                    string msg = GetString(yesCfg, "successMessage", DefaultTradeSuccess)
                        .Replace("@userNameA", "@" + fromUser)
                        .Replace("@userNameB", "@" + displayName)
                        .Replace("[KarteA]", cardATitle)
                        .Replace("[BoosterA]", boosterATitle)
                        .Replace("[KarteB]", cardBTitle)
                        .Replace("[BoosterB]", boosterBTitle)
                        .Replace("[AnzahlA]", Convert.ToString(result["aNewCardB"]))
                        .Replace("[AnzahlB]", Convert.ToString(result["bNewCardA"]));
                    SendChatMessageSafe(msg);
                }

                var tradeEvent = new Dictionary<string, object>
                {
                    { "userA", fromUser },
                    { "userB", displayName },
                    { "cardAId", cardAId },
                    { "boosterAId", boosterAId },
                    { "cardBId", cardBId },
                    { "boosterBId", boosterBId },
                    { "newCountA", result["aNewCardB"] },
                    { "newCountB", result["bNewCardA"] }
                };
                // Routed through the same queue as draw/showcollection/ranking so the trade
                // animation never overlaps another - it used to broadcast directly, which let it
                // play at the same time as an in-progress pack-opening or collection showcase.
                Enqueue("trade", fromLogin, fromUser, "chat", tradeEvent);
                server.Log("commands", "info", fromUser + " tauschte " + cardATitle + " mit " + displayName + " gegen " + cardBTitle + ".");
                ClearActiveTrade();
            }
            BroadcastQueue();
        }

private void HandleTradeNo(string login, string displayName, Dictionary<string, object> cc)
        {
            Dictionary<string, object> tradeCfg = Obj(cc, "trade");
            Dictionary<string, object> noCfg = Obj(cc, "tradeno");
            lock (tradeLock)
            {
                if (activeTrade == null) return;
                if (login.ToLowerInvariant() != GetString(activeTrade, "toLogin", "")) return;

                string fromLogin = GetString(activeTrade, "fromLogin", "");
                string fromUser = GetString(activeTrade, "fromUser", "");
                int cooldownSeconds = Math.Max(0, GetInt(tradeCfg, "cooldownSeconds", 0));
                int maxUses = Math.Max(0, GetInt(tradeCfg, "maxUses", 0));
                DateTime now = DateTime.UtcNow;
                int remaining;
                lock (usageLock)
                {
                    EnsureUsageLoaded();
                    int newCount = ConsumeTrade(fromLogin, fromUser, cooldownSeconds, now);
                    SaveUsage();
                    remaining = maxUses > 0 ? Math.Max(0, maxUses - newCount) : 0;
                }

                SendChatMessageSafe(GetString(noCfg, "declineMessage", DefaultTradeDecline)
                    .Replace("@userNameA", "@" + fromUser)
                    .Replace("@userNameB", "@" + displayName)
                    .Replace("[Uhrzeit]", FormatLocalTime(TradeNextReset()))
                    .Replace("[Anzahl]", remaining.ToString()));
                ClearActiveTrade();
            }
            BroadcastQueue();
        }

private void TradeTimedOut()
        {
            lock (tradeLock)
            {
                if (activeTrade == null) return;
                Dictionary<string, object> settings = server.ReadSettingsObject();
                Dictionary<string, object> tradeCfg = Obj(Obj(settings, "chatCommands"), "trade");
                string fromLogin = GetString(activeTrade, "fromLogin", "");
                string fromUser = GetString(activeTrade, "fromUser", "");
                string toUser = GetString(activeTrade, "toUser", "");
                int cooldownSeconds = Math.Max(0, GetInt(tradeCfg, "cooldownSeconds", 0));
                int timeoutSeconds = Math.Max(10, GetInt(tradeCfg, "requestTimeoutSeconds", 120));
                // Cooldown applies on timeout, but no trade quota is consumed.
                lock (usageLock)
                {
                    EnsureUsageLoaded();
                    if (cooldownSeconds > 0) GetOrCreateTradeEntry(fromLogin, fromUser)["cooldownUntil"] = DateTime.UtcNow.AddSeconds(cooldownSeconds).ToString("o");
                    SaveUsage();
                }
                SendChatMessageSafe(GetString(tradeCfg, "timeoutMessage", DefaultTradeTimeout)
                    .Replace("@userNameA", "@" + fromUser)
                    .Replace("@userNameB", "@" + toUser)
                    .Replace("[Zeit]", timeoutSeconds.ToString()));
                ClearActiveTrade();
            }
            BroadcastQueue();
        }

// Increments the trade-usage counter and (re)sets the per-user cooldown. Returns new count.
        private int ConsumeTrade(string login, string displayName, int cooldownSeconds, DateTime now)
        {
            Dictionary<string, object> entry = GetOrCreateTradeEntry(login, displayName);
            int count = GetInt(entry, "count", 0) + 1;
            entry["count"] = count;
            if (cooldownSeconds > 0) entry["cooldownUntil"] = now.AddSeconds(cooldownSeconds).ToString("o");
            return count;
        }

private void ClearActiveTrade()
        {
            activeTrade = null;
            if (tradeTimeoutTimer != null) { tradeTimeoutTimer.Dispose(); tradeTimeoutTimer = null; }
            // Safe to call while already holding tradeLock (all 3 call sites do) - C#'s lock/Monitor
            // is re-entrant for the owning thread, and SavePendingState only takes OTHER locks
            // (queueLock/battleLock/tournamentLock/teamBattleLock) plus re-entering this same one.
            SavePendingState();
        }

// ---- Trade usage tracking (separate namespace inside command-usage.json) ----

        private Dictionary<string, object> TradeSection()
        {
            EnsureUsageLoaded();
            object obj;
            if (usageData.TryGetValue("trade", out obj) && obj is Dictionary<string, object>) return (Dictionary<string, object>)obj;
            Dictionary<string, object> section = new Dictionary<string, object> { { "users", new Dictionary<string, object>() } };
            usageData["trade"] = section;
            return section;
        }

private Dictionary<string, object> GetOrCreateTradeEntry(string login, string displayName)
        {
            Dictionary<string, object> section = TradeSection();
            Dictionary<string, object> users = section["users"] as Dictionary<string, object>;
            if (users == null) { users = new Dictionary<string, object>(); section["users"] = users; }
            string key = login.Trim().ToLowerInvariant();
            Dictionary<string, object> entry;
            if (users.ContainsKey(key) && users[key] is Dictionary<string, object>) entry = (Dictionary<string, object>)users[key];
            else { entry = new Dictionary<string, object> { { "count", 0 } }; users[key] = entry; }
            entry["displayName"] = displayName;
            return entry;
        }

private void ApplyTradeResetIfDue(Dictionary<string, object> tradeCfg, DateTime nowUtc)
        {
            Dictionary<string, object> section = TradeSection();
            DateTime nextReset = ParseDate(GetString(section, "nextGlobalResetAt", ""));
            DateTime dueLimit = ComputeNextResetAt(tradeCfg, nowUtc);
            if (nextReset != DateTime.MinValue && nextReset > nowUtc && nextReset <= dueLimit) return;
            Dictionary<string, object> users = section["users"] as Dictionary<string, object>;
            if (users != null)
            {
                foreach (object value in users.Values)
                {
                    Dictionary<string, object> entry = value as Dictionary<string, object>;
                    if (entry != null) entry["count"] = 0;
                }
            }
            section["nextGlobalResetAt"] = ComputeNextResetAt(tradeCfg, nowUtc).ToString("o");
            SaveUsage();
        }

private DateTime TradeNextReset()
        {
            return ParseDate(GetString(TradeSection(), "nextGlobalResetAt", ""));
        }
    }
}
