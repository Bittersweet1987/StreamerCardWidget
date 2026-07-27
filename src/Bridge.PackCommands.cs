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
private void HandlePacksCommand(string login, string displayName, Dictionary<string, object> packsCfg, Dictionary<string, object> settingsIn = null)
        {
            Dictionary<string, object> settings = settingsIn != null ? settingsIn : server.ReadSettingsObject();
            object boostersObj;
            var normalPool = new List<Dictionary<string, object>>();
            var subOnlyList = new List<Dictionary<string, object>>();
            if (settings.TryGetValue("boosters", out boostersObj) && boostersObj is object[])
            {
                foreach (object bo in (object[])boostersObj)
                {
                    Dictionary<string, object> booster = bo as Dictionary<string, object>;
                    if (booster == null) continue;
                    if (!GetBool(booster, "enabled", true)) continue;
                    object[] cardIds = booster.ContainsKey("cardIds") && booster["cardIds"] is object[] ? (object[])booster["cardIds"] : new object[0];
                    if (cardIds.Length == 0) continue;
                    if (!BoosterHasEnabledCard(settings, cardIds)) continue;
                    if (GetBool(booster, "subExclusive", false)) subOnlyList.Add(booster);
                    else normalPool.Add(booster);
                }
            }

            string packsMode = GetString(packsCfg, "outputMode", "chat");
            if (normalPool.Count == 0 && subOnlyList.Count == 0)
            {
                SendCollectionOutput(login, packsMode, GetString(packsCfg, "emptyMessage", DefaultPacksEmpty).Replace("@userName", "@" + displayName));
                return;
            }

            // Same weighting as PickRandomBoosterId(subOnly:false): boosters with score <= 0 are
            // excluded from the weighted pool unless ALL of them are <= 0 (even-split fallback).
            var scored = new List<Dictionary<string, object>>();
            foreach (Dictionary<string, object> booster in normalPool)
            {
                if (GetDouble(booster, "score", 100) > 0) scored.Add(booster);
            }
            List<Dictionary<string, object>> pool = scored.Count > 0 ? scored : normalPool;
            double total = 0;
            foreach (Dictionary<string, object> booster in pool) total += Math.Max(0, GetDouble(booster, "score", 100));

            var names = new List<string>();
            foreach (Dictionary<string, object> booster in normalPool)
            {
                double score = Math.Max(0, GetDouble(booster, "score", 100));
                double odd = total > 0 ? score / total * 100 : (pool.Count > 0 ? 100.0 / pool.Count : 0);
                string pct = odd > 0 && odd < 1 ? "<1" : Math.Round(odd).ToString();
                names.Add(BoosterDisplayName(booster) + " · " + pct + "%");
            }
            string subOnlyLabel = GetString(packsCfg, "subOnlyLabel", DefaultPacksSubOnlyLabel);
            foreach (Dictionary<string, object> booster in subOnlyList)
            {
                names.Add(BoosterDisplayName(booster) + " (" + subOnlyLabel + ")");
            }

            string header = GetString(packsCfg, "headerMessage", DefaultPacksHeader).Replace("@userName", "@" + displayName);
            SendCardListChunked(login, packsMode, header, names);
        }

private void HandlePackCommand(string login, string displayName, Dictionary<string, object> packCfg)
        {
            int maxUses = Math.Max(0, GetInt(packCfg, "maxUses", 0));
            int cooldownSeconds = Math.Max(0, GetInt(packCfg, "cooldownSeconds", 0));
            DateTime now = DateTime.UtcNow;

            lock (usageLock)
            {
                EnsureUsageLoaded();
                ApplyResetIfDue(packCfg, now);
                Dictionary<string, object> entry = GetOrCreateUsageEntry(login, displayName);

                DateTime cooldownUntil = ParseDate(GetString(entry, "cooldownUntil", ""));
                // Clamp a stale cooldown to the current setting: cooldownUntil is stored as an
                // absolute timestamp (last use + old cooldownSeconds), so lowering the cooldown
                // later would otherwise keep a viewer blocked for the old, longer duration. Capping
                // it at now + current cooldownSeconds makes a shortened cooldown take effect at once.
                if (cooldownSeconds > 0 && cooldownUntil > now.AddSeconds(cooldownSeconds))
                {
                    cooldownUntil = now.AddSeconds(cooldownSeconds);
                    entry["cooldownUntil"] = cooldownUntil.ToString("o");
                }
                if (cooldownSeconds > 0 && cooldownUntil > now)
                {
                    int remaining = (int)Math.Ceiling((cooldownUntil - now).TotalSeconds);
                    string message = GetString(packCfg, "cooldownMessage", DefaultCooldownMessage)
                        .Replace("@userName", "@" + displayName)
                        .Replace("[Restzeit]", remaining.ToString());
                    SendCommandOutput(login, packCfg, message);
                    return;
                }

                int count = GetInt(entry, "count", 0);
                if (maxUses > 0 && count >= maxUses)
                {
                    string resetTimeText = FormatLocalTime(ParseDate(GetString(usageData, "nextGlobalResetAt", "")));
                    string message = GetString(packCfg, "limitMessage", DefaultLimitMessage)
                        .Replace("@userName", "@" + displayName)
                        .Replace("[Uhrzeit]", resetTimeText);
                    SendCommandOutput(login, packCfg, message);
                    return;
                }

                entry["count"] = count + 1;
                if (cooldownSeconds > 0) entry["cooldownUntil"] = now.AddSeconds(cooldownSeconds).ToString("o");
                SaveUsage();
            }

            // The "Nachricht bei Einloesung" is sent AFTER the animation finishes (see
            // SendDrawPostMessage), so it can include the actual drawn card and booster name.
            Enqueue("draw", login, displayName, "chat");
        }

// ---- "!<command> <Packname>" - draws exactly one card from the NAMED pack (matched by
        // exact, case-insensitive title - see FindBoosterByTitle), instead of a random booster.
        // Shares its own cooldown-only usage namespace inside command-usage.json (own section, same
        // file as !pack/!battle - see SpecificPackSection) - deliberately no max-uses/reset-period
        // complexity, just a per-user cooldown, since "wähle dein eigenes Pack" is a lighter-weight
        // action than the main !pack draw. The actual draw (pity, rarity weighting within that one
        // booster) is completely unchanged - see the "forcedBoosterId" override in ProcessQueueItem's
        // "draw" handling; this command only resolves and validates which booster to force. ----
        private Dictionary<string, object> SpecificPackSection()
        {
            EnsureUsageLoaded();
            object obj;
            if (usageData.TryGetValue("specificPackDraw", out obj) && obj is Dictionary<string, object>) return (Dictionary<string, object>)obj;
            Dictionary<string, object> section = new Dictionary<string, object> { { "users", new Dictionary<string, object>() } };
            usageData["specificPackDraw"] = section;
            return section;
        }

private Dictionary<string, object> GetOrCreateSpecificPackEntry(string login, string displayName)
        {
            Dictionary<string, object> section = SpecificPackSection();
            Dictionary<string, object> users = section["users"] as Dictionary<string, object>;
            if (users == null) { users = new Dictionary<string, object>(); section["users"] = users; }
            string key = login.Trim().ToLowerInvariant();
            Dictionary<string, object> entry;
            if (users.ContainsKey(key) && users[key] is Dictionary<string, object>) entry = (Dictionary<string, object>)users[key];
            else { entry = new Dictionary<string, object>(); users[key] = entry; }
            entry["displayName"] = displayName;
            return entry;
        }

private void HandleSpecificPackDrawCommand(string login, string displayName, string args, Dictionary<string, object> cmdCfg, Dictionary<string, object> settingsIn = null)
        {
            Dictionary<string, object> settings = settingsIn != null ? settingsIn : server.ReadSettingsObject();
            string packTitle = (args ?? "").Trim();
            Dictionary<string, object> joinCfg = cmdCfg;
            string commandText = GetString(joinCfg, "prefix", "!") + GetString(joinCfg, "command", "packziehen");
            if (packTitle.Length == 0)
            {
                SendCommandOutput(login, cmdCfg, GetString(cmdCfg, "usageMessage", DefaultSpecificPackUsage)
                    .Replace("@userName", "@" + displayName)
                    .Replace("[Befehl]", commandText));
                return;
            }

            int cooldownSeconds = Math.Max(0, GetInt(cmdCfg, "cooldownSeconds", 0));
            DateTime now = DateTime.UtcNow;
            lock (usageLock)
            {
                Dictionary<string, object> entry = GetOrCreateSpecificPackEntry(login, displayName);
                DateTime cooldownUntil = ParseDate(GetString(entry, "cooldownUntil", ""));
                if (cooldownSeconds > 0 && cooldownUntil > now.AddSeconds(cooldownSeconds)) cooldownUntil = now.AddSeconds(cooldownSeconds);
                if (cooldownSeconds > 0 && cooldownUntil > now)
                {
                    int remaining = (int)Math.Ceiling((cooldownUntil - now).TotalSeconds);
                    SendCommandOutput(login, cmdCfg, GetString(cmdCfg, "cooldownMessage", DefaultCooldownMessage)
                        .Replace("@userName", "@" + displayName)
                        .Replace("[Restzeit]", remaining.ToString()));
                    return;
                }
                if (cooldownSeconds > 0) entry["cooldownUntil"] = now.AddSeconds(cooldownSeconds).ToString("o");
                SaveUsage();
            }

            Dictionary<string, object> booster = FindBoosterByTitle(settings, packTitle);
            if (booster == null)
            {
                SendCommandOutput(login, cmdCfg, GetString(cmdCfg, "notFoundMessage", DefaultSpecificPackNotFound)
                    .Replace("@userName", "@" + displayName)
                    .Replace("[Eingabe]", packTitle));
                return;
            }
            Enqueue("draw", login, displayName, "specificpack", new Dictionary<string, object> { { "forcedBoosterId", GetString(booster, "id", "") } });
        }

// Cancels a channel-points redemption, refunding the viewer's points - used when "!<pack
        // command>"'s channel-points reward is redeemed with a pack name that doesn't match any
        // enabled booster (see HandleSpecificPackRedemption). Best-effort: a failure here (e.g. the
        // access token expired) only gets logged, never thrown further - the viewer already got a
        // chat message explaining the pack wasn't found either way.
        private void RefundRedemption(string rewardId, string redemptionId)
        {
            try
            {
                Dictionary<string, object> twitch = TwitchSettings();
                if (String.IsNullOrWhiteSpace(GetString(twitch, "accessToken", ""))) return;
                string url = "https://api.twitch.tv/helix/channel_points/custom_rewards/redemptions?broadcaster_id=" +
                    Uri.EscapeDataString(GetString(twitch, "broadcasterId", "")) +
                    "&reward_id=" + Uri.EscapeDataString(rewardId) +
                    "&id=" + Uri.EscapeDataString(redemptionId);
                TwitchJson("PATCH", url, GetString(twitch, "clientId", ""), GetString(twitch, "accessToken", ""),
                    new Dictionary<string, object> { { "status", "CANCELED" } });
            }
            catch (Exception ex)
            {
                server.Log("draw", "error", "Erstattung der Kanalpunkte fehlgeschlagen: " + ex.Message);
            }
        }

// Channel-points counterpart to HandleSpecificPackDrawCommand - called from the redemption
        // handler once the "specificPackDraw" reward is matched. user_input is the pack name the
        // viewer typed into the reward's (required) text box.
        private void HandleSpecificPackRedemption(string login, string displayName, string userInput, string rewardId, string redemptionId, Dictionary<string, object> settings)
        {
            Dictionary<string, object> spCfg = Obj(settings, "specificPackDraw");
            string packTitle = (userInput ?? "").Trim();
            Dictionary<string, object> booster = FindBoosterByTitle(settings, packTitle);
            if (booster == null)
            {
                RefundRedemption(rewardId, redemptionId);
                SendChatMessageSafe(GetString(spCfg, "notFoundMessage", DefaultSpecificPackRedemptionNotFound)
                    .Replace("@userName", "@" + displayName)
                    .Replace("[Eingabe]", packTitle));
                return;
            }
            Enqueue("draw", login, displayName, "specificpack", new Dictionary<string, object> { { "forcedBoosterId", GetString(booster, "id", "") } });
        }

// ---- "!show <Packtitel>" - shows one pack's contents (owned cards revealed, everything
        // else hidden as "?" in the overlay, same concept as !collection's detailed view but
        // scoped to a single booster and rendered 5x5=25 per page instead of !collection's 9).
        // Shares its own cooldown-only usage namespace, same pattern as SpecificPackSection. ----
        private Dictionary<string, object> ShowPackSection()
        {
            EnsureUsageLoaded();
            object obj;
            if (usageData.TryGetValue("showPack", out obj) && obj is Dictionary<string, object>) return (Dictionary<string, object>)obj;
            Dictionary<string, object> section = new Dictionary<string, object> { { "users", new Dictionary<string, object>() } };
            usageData["showPack"] = section;
            return section;
        }

private Dictionary<string, object> GetOrCreateShowPackEntry(string login, string displayName)
        {
            Dictionary<string, object> section = ShowPackSection();
            Dictionary<string, object> users = section["users"] as Dictionary<string, object>;
            if (users == null) { users = new Dictionary<string, object>(); section["users"] = users; }
            string key = login.Trim().ToLowerInvariant();
            Dictionary<string, object> entry;
            if (users.ContainsKey(key) && users[key] is Dictionary<string, object>) entry = (Dictionary<string, object>)users[key];
            else { entry = new Dictionary<string, object>(); users[key] = entry; }
            entry["displayName"] = displayName;
            return entry;
        }

private void HandleShowPackCommand(string login, string displayName, string args, Dictionary<string, object> cmdCfg, Dictionary<string, object> settingsIn = null)
        {
            Dictionary<string, object> settings = settingsIn != null ? settingsIn : server.ReadSettingsObject();
            string packTitle = (args ?? "").Trim();
            string commandText = GetString(cmdCfg, "prefix", "!") + GetString(cmdCfg, "command", "show");
            if (packTitle.Length == 0)
            {
                SendChatMessageSafe(GetString(cmdCfg, "usageMessage", DefaultShowPackUsage)
                    .Replace("@userName", "@" + displayName)
                    .Replace("[Befehl]", commandText));
                return;
            }

            int cooldownSeconds = Math.Max(0, GetInt(cmdCfg, "cooldownSeconds", 0));
            DateTime now = DateTime.UtcNow;
            lock (usageLock)
            {
                Dictionary<string, object> entry = GetOrCreateShowPackEntry(login, displayName);
                DateTime cooldownUntil = ParseDate(GetString(entry, "cooldownUntil", ""));
                if (cooldownSeconds > 0 && cooldownUntil > now.AddSeconds(cooldownSeconds)) cooldownUntil = now.AddSeconds(cooldownSeconds);
                if (cooldownSeconds > 0 && cooldownUntil > now)
                {
                    int remaining = (int)Math.Ceiling((cooldownUntil - now).TotalSeconds);
                    SendChatMessageSafe(GetString(cmdCfg, "cooldownMessage", DefaultCooldownMessage)
                        .Replace("@userName", "@" + displayName)
                        .Replace("[Restzeit]", remaining.ToString()));
                    return;
                }
                if (cooldownSeconds > 0) entry["cooldownUntil"] = now.AddSeconds(cooldownSeconds).ToString("o");
                SaveUsage();
            }

            Dictionary<string, object> booster = FindBoosterByTitle(settings, packTitle);
            if (booster == null)
            {
                SendChatMessageSafe(GetString(cmdCfg, "notFoundMessage", DefaultShowPackNotFound)
                    .Replace("@userName", "@" + displayName)
                    .Replace("[Eingabe]", packTitle));
                return;
            }
            string boosterId = GetString(booster, "id", "");
            string boosterTitle = GetString(booster, "title", packTitle);
            Enqueue("showpack", login, displayName, "chat", new Dictionary<string, object> { { "boosterId", boosterId }, { "boosterTitle", boosterTitle } });
        }

// Part of !show's chat output (alongside the overlay reveal) - lists only the cards the
        // caller owns from THIS ONE booster (unlike !collection's chat text, which lists every
        // owned card across all boosters). Own toggle/outputMode, independent of !collection's.
        private void SendShowPackChatText(string login, string displayName, string boosterId, string boosterTitle, Dictionary<string, object> settingsIn = null)
        {
            Dictionary<string, object> settings = settingsIn != null ? settingsIn : server.ReadSettingsObject();
            Dictionary<string, object> cmdCfg = Obj(Obj(settings, "chatCommands"), "showPack");
            if (!GetBool(cmdCfg, "chatOutputEnabled", true)) return;
            try
            {
                string mode = GetString(cmdCfg, "outputMode", "chat");
                // Total card count of the pack (same "owned/total" idea as the overlay's own
                // header - see showpack.js's headerMarkup), so the chat text can show e.g. "7/20"
                // instead of just listing card names with no sense of overall pack progress.
                Dictionary<string, object> booster = FindBooster(settings, boosterId);
                int totalCount = 0;
                if (booster != null)
                {
                    object cardIdsObj;
                    if (booster.TryGetValue("cardIds", out cardIdsObj) && cardIdsObj is object[]) totalCount = ((object[])cardIdsObj).Length;
                }
                List<Dictionary<string, string>> owned = server.GetUserOwnedCardsWithInfo(login);
                var inPack = owned.FindAll(delegate (Dictionary<string, string> entry) { return entry["boosterId"] == boosterId; });
                if (inPack.Count == 0)
                {
                    SendCollectionOutput(login, mode, GetString(cmdCfg, "emptyMessage", DefaultShowPackEmpty)
                        .Replace("@userName", "@" + displayName)
                        .Replace("[Boostername]", boosterTitle)
                        .Replace("[AnzahlBesessen]", "0")
                        .Replace("[AnzahlGesamt]", totalCount.ToString()));
                    return;
                }
                inPack.Sort(delegate (Dictionary<string, string> a, Dictionary<string, string> b)
                {
                    int cmp = CardPackServer.GetRarityRank(a["rarity"]).CompareTo(CardPackServer.GetRarityRank(b["rarity"]));
                    return cmp != 0 ? cmp : StringComparer.OrdinalIgnoreCase.Compare(a["cardTitle"], b["cardTitle"]);
                });
                var names = new List<string>();
                foreach (Dictionary<string, string> entry in inPack)
                {
                    int count = Int32.Parse(entry["count"]);
                    names.Add(count > 1 ? entry["cardTitle"] + " x" + count : entry["cardTitle"]);
                }
                string header = GetString(cmdCfg, "headerMessage", DefaultShowPackHeader)
                    .Replace("@userName", "@" + displayName)
                    .Replace("[Boostername]", boosterTitle)
                    .Replace("[AnzahlBesessen]", inPack.Count.ToString())
                    .Replace("[AnzahlGesamt]", totalCount.ToString());
                SendCardListChunked(login, mode, header, names);
            }
            catch (Exception ex)
            {
                server.Log("draw", "error", "SendShowPackChatText fehlgeschlagen: " + ex.Message + " | " + ex.StackTrace);
            }
        }

// ---- Dust: "!dust <Kartenname> <Anzahl>" sacrifices owned duplicates of a card to
        // reduce a viewer's pity streak (see ProcessQueueItem's "draw" handling), with leftover
        // points banked as extra guaranteed draws. No cooldown/usage-limit tracking - the natural
        // cost (giving up owned duplicates) is the limiting factor. ----
        private void HandleDustCommand(string login, string displayName, string args, Dictionary<string, object> dustCfg, Dictionary<string, object> settingsIn = null)
        {
            // The default (and any un-customized) usage message references this command's own
            // name via [Befehl] - always the ACTUAL configured prefix+command, never a hardcoded
            // "!dust", so a renamed command still shows its real trigger to the viewer.
            string commandText = GetString(dustCfg, "prefix", "!") + GetString(dustCfg, "command", "dust");
            string rest = args.Trim();
            int lastSpace = rest.LastIndexOf(' ');
            if (lastSpace < 0)
            {
                SendCommandOutput(login, dustCfg, GetString(dustCfg, "usageMessage", DefaultDustUsage).Replace("@userName", "@" + displayName).Replace("[Befehl]", commandText));
                return;
            }
            string cardName = rest.Substring(0, lastSpace).Trim();
            string countText = rest.Substring(lastSpace + 1).Trim();
            int count;
            if (cardName.Length == 0 || !Int32.TryParse(countText, out count) || count < 1)
            {
                SendCommandOutput(login, dustCfg, GetString(dustCfg, "usageMessage", DefaultDustUsage).Replace("@userName", "@" + displayName).Replace("[Befehl]", commandText));
                return;
            }

            Dictionary<string, object> card = server.ResolveCardByName(cardName);
            if (!Convert.ToBoolean(card["found"]))
            {
                SendCommandOutput(login, dustCfg, GetString(dustCfg, "cardNotFoundMessage", DefaultDustCardNotFound)
                    .Replace("@userName", "@" + displayName)
                    .Replace("[falscherName]", cardName)
                    .Replace("[Kartenname]", GetString(card, "suggestion", "")));
                return;
            }
            string cardId = GetString(card, "cardId", "");
            string cardTitle = GetString(card, "cardTitle", "");
            string boosterId = GetString(card, "boosterId", "");

            int owned = server.GetCardCount(login, boosterId, cardId);
            if (owned - count < 1)
            {
                SendCommandOutput(login, dustCfg, GetString(dustCfg, "notEnoughMessage", DefaultDustNotEnough)
                    .Replace("@userName", "@" + displayName)
                    .Replace("[Kartenname]", cardTitle)
                    .Replace("[Besitz]", owned.ToString()));
                return;
            }

            if (!server.RemoveCardCopies(login, displayName, boosterId, cardId, count))
            {
                // Lost a race against a trade/draw between the check above and here - safe to
                // just ask the viewer to retry rather than silently drop their points.
                SendCommandOutput(login, dustCfg, GetString(dustCfg, "notEnoughMessage", DefaultDustNotEnough)
                    .Replace("@userName", "@" + displayName)
                    .Replace("[Kartenname]", cardTitle)
                    .Replace("[Besitz]", owned.ToString()));
                return;
            }

            Dictionary<string, object> settings = settingsIn != null ? settingsIn : server.ReadSettingsObject();
            Dictionary<string, object> pityCfg = Obj(settings, "pity");
            int pityThreshold = Math.Max(1, GetInt(pityCfg, "threshold", 10));
            Dictionary<string, object> dustValues = Obj(pityCfg, "dustValues");
            string rarity = server.CardRarity(cardId);
            double perCard = GetDouble(dustValues, rarity, 1);
            int points = Math.Max(0, (int)Math.Round(perCard * count));

            int pityReady, pityRest;
            lock (pityLock)
            {
                Dictionary<string, object> entry = GetPityEntry(login);
                int streak = GetInt(entry, "streak", 0);
                int bank = GetInt(entry, "bank", 0) + points;
                entry["bank"] = bank;
                SavePityEntry(login, entry);
                ComputePityProgress(streak, bank, pityThreshold, out pityReady, out pityRest);
            }

            SendCommandOutput(login, dustCfg, GetString(dustCfg, "successMessage", DefaultDustSuccess)
                .Replace("@userName", "@" + displayName)
                .Replace("[Kartenname]", cardTitle)
                .Replace("[Anzahl]", count.ToString())
                .Replace("[Punkte]", points.ToString())
                .Replace("[GarantieAnzahl]", pityReady.ToString())
                .Replace("[GarantieRest]", pityRest.ToString()));
        }

// Combined streak+bank pity pool (see ProcessQueueItem's pity handling for why they're the
        // same currency): readyGuarantees is how many full guaranteed draws are already banked and
        // will fire on the next eligible draws; drawsUntilNext is how many more non-hit draws are
        // needed to complete the guarantee AFTER those (always in [1, threshold], even exactly on
        // a multiple - "ready" credit is already counted separately in readyGuarantees).
        internal static void ComputePityProgress(int streak, int bank, int threshold, out int readyGuarantees, out int drawsUntilNext)
        {
            int total = streak + bank;
            readyGuarantees = total / threshold;
            drawsUntilNext = threshold - (total % threshold);
        }

// Parses a "!dustset <rarity>" argument (the whole remainder of the message, since some
        // language's rarity names contain a space, e.g. French "peu commune") against every
        // supported language's rarity name. Returns null if nothing matches.
        internal static string ParseDustSetRarity(string input)
        {
            string normalized = (input ?? "").Trim().ToLowerInvariant();
            if (normalized.Length == 0) return null;
            foreach (KeyValuePair<string, string[]> kv in DustSetRarityAliases)
            {
                foreach (string alias in kv.Value)
                {
                    if (String.Equals(normalized, alias, StringComparison.OrdinalIgnoreCase)) return kv.Key;
                }
            }
            return null;
        }

// ---- "!dustset <Seltenheit>" - per-viewer preference for "!dustall" (see
        // GetDustAllRarity/SetDustAllRarity). Accepts the rarity name in any of the app's 5
        // supported languages (see ParseDustSetRarity/DustSetRarityAliases). ----
        private void HandleDustSetCommand(string login, string displayName, string args, Dictionary<string, object> dustCfg, Dictionary<string, object> dustSetCfg, Dictionary<string, object> settingsIn = null)
        {
            Dictionary<string, object> settings = settingsIn != null ? settingsIn : server.ReadSettingsObject();
            // The messages below reference both this command's own name AND its sibling "!dustall"
            // command by name - both are independently renameable (see the "!dustset"/"!dustall"
            // command-matching comment in ProcessChatMessage), so the actual configured command
            // text (prefix + word) must always be substituted in, never hardcoded.
            Dictionary<string, object> dustAllCfg = Obj(Obj(settings, "chatCommands"), "dustAll");
            string prefix = GetString(dustCfg, "prefix", "!");
            string setCommandText = prefix + GetString(dustSetCfg, "command", "dustset");
            string allCommandText = prefix + GetString(dustAllCfg, "command", "dustall");

            string arg = (args ?? "").Trim();
            if (arg.Length == 0)
            {
                SendChatMessageSafe(GetString(dustSetCfg, "usageMessage", DefaultDustSetUsage)
                    .Replace("@userName", "@" + displayName)
                    .Replace("[BefehlSet]", setCommandText)
                    .Replace("[BefehlAll]", allCommandText));
                return;
            }
            string rarity = ParseDustSetRarity(arg);
            if (rarity == null)
            {
                SendChatMessageSafe(GetString(dustSetCfg, "invalidMessage", DefaultDustSetInvalid)
                    .Replace("@userName", "@" + displayName)
                    .Replace("[Eingabe]", arg));
                return;
            }
            SetDustAllRarity(login, rarity);
            SendChatMessageSafe(GetString(dustSetCfg, "successMessage", DefaultDustSetSuccess)
                .Replace("@userName", "@" + displayName)
                .Replace("[BefehlAll]", allCommandText)
                .Replace("[Seltenheit]", RarityLabel(rarity, RarityOutputLanguage(settings))));
        }

// ---- "!dustall" - dusts EVERY owned duplicate (keeping exactly 1 of each) up to the
        // viewer's own "!dustset" threshold in one shot, converting them all into pity points at
        // once. No cooldown/usage tracking, same reasoning as "!dust" - the natural cost (giving
        // up every spare duplicate up to that rarity) is the limiting factor. ----
        private void HandleDustAllCommand(string login, string displayName, Dictionary<string, object> dustCfg, Dictionary<string, object> dustAllCfg, Dictionary<string, object> settingsIn = null)
        {
            Dictionary<string, object> settings = settingsIn != null ? settingsIn : server.ReadSettingsObject();
            string thresholdRarity = GetDustAllRarity(login);
            int maxRarityRank = CardPackServer.GetRarityRank(thresholdRarity);
            string rarityLanguage = RarityOutputLanguage(settings);

            List<Dictionary<string, string>> dusted = server.DustAllDuplicates(login, displayName, maxRarityRank);
            if (dusted.Count == 0)
            {
                SendCommandOutput(login, dustAllCfg, GetString(dustAllCfg, "nothingMessage", DefaultDustAllNothing)
                    .Replace("@userName", "@" + displayName)
                    .Replace("[Seltenheit]", RarityLabel(thresholdRarity, rarityLanguage)));
                return;
            }

            Dictionary<string, object> pityCfg = Obj(settings, "pity");
            int pityThreshold = Math.Max(1, GetInt(pityCfg, "threshold", 10));
            Dictionary<string, object> dustValues = Obj(pityCfg, "dustValues");

            var perRarityCount = new Dictionary<string, int>();
            int totalCards = 0;
            int totalPoints = 0;
            foreach (Dictionary<string, string> entry in dusted)
            {
                string rarity = entry["rarity"];
                int removed = Int32.Parse(entry["removedCount"]);
                double perCard = GetDouble(dustValues, rarity, 1);
                totalPoints += Math.Max(0, (int)Math.Round(perCard * removed));
                totalCards += removed;
                int existing;
                perRarityCount[rarity] = (perRarityCount.TryGetValue(rarity, out existing) ? existing : 0) + removed;
            }

            var breakdownParts = new List<string>();
            foreach (string rarityId in new[] { "common", "uncommon", "rare", "epic", "legendary", "holo" })
            {
                int c;
                if (perRarityCount.TryGetValue(rarityId, out c) && c > 0) breakdownParts.Add(c + "x " + RarityLabel(rarityId, rarityLanguage));
            }
            string breakdown = String.Join(", ", breakdownParts.ToArray());

            int pityReady, pityRest;
            lock (pityLock)
            {
                Dictionary<string, object> entry = GetPityEntry(login);
                int streak = GetInt(entry, "streak", 0);
                int bank = GetInt(entry, "bank", 0) + totalPoints;
                entry["bank"] = bank;
                SavePityEntry(login, entry);
                ComputePityProgress(streak, bank, pityThreshold, out pityReady, out pityRest);
            }

            SendCommandOutput(login, dustAllCfg, GetString(dustAllCfg, "successMessage", DefaultDustAllSuccess)
                .Replace("@userName", "@" + displayName)
                .Replace("[Aufschluesselung]", breakdown)
                .Replace("[Gesamtanzahl]", totalCards.ToString())
                .Replace("[Punkte]", totalPoints.ToString())
                .Replace("[GarantieAnzahl]", pityReady.ToString())
                .Replace("[GarantieRest]", pityRest.ToString()));
        }

// ---- Gift: "!gift @recipient <Kartenname>" - one-sided, immediate, no accept/decline
        // needed (unlike !trade). Transfers exactly one copy of the named card away from the
        // sender's collection. ----
        private void HandleGiftCommand(string login, string displayName, string args, Dictionary<string, object> giftCfg)
        {
            // "@recipient cardName with spaces" - same split as !trade's offer parsing.
            string rest = args.Trim();
            if (rest.Length == 0) return;
            int sp = rest.IndexOf(' ');
            if (sp < 0)
            {
                SendChatMessageSafe(GetString(giftCfg, "usageMessage", DefaultGiftUsage).Replace("@userName", "@" + displayName));
                return;
            }
            string recipientRaw = rest.Substring(0, sp).Trim().TrimStart('@');
            string cardName = rest.Substring(sp + 1).Trim();
            if (recipientRaw.Length == 0 || cardName.Length == 0)
            {
                SendChatMessageSafe(GetString(giftCfg, "usageMessage", DefaultGiftUsage).Replace("@userName", "@" + displayName));
                return;
            }
            string recipientLogin = recipientRaw.ToLowerInvariant();

            if (recipientLogin == login.ToLowerInvariant())
            {
                SendChatMessageSafe(GetString(giftCfg, "selfGiftMessage", DefaultGiftSelf).Replace("@userName", "@" + displayName));
                return;
            }

            if (!server.UserExistsInCollections(recipientLogin))
            {
                SendChatMessageSafe(GetString(giftCfg, "userNotFoundMessage", DefaultGiftUserNotFound)
                    .Replace("@userName", "@" + displayName)
                    .Replace("[Nutzer]", recipientRaw));
                return;
            }

            Dictionary<string, object> card = server.ResolveCardByName(cardName);
            if (!Convert.ToBoolean(card["found"]))
            {
                SendChatMessageSafe(GetString(giftCfg, "cardNotFoundMessage", DefaultGiftCardNotFound)
                    .Replace("@userName", "@" + displayName)
                    .Replace("[falscherName]", cardName)
                    .Replace("[Kartenname]", GetString(card, "suggestion", "")));
                return;
            }
            string cardId = GetString(card, "cardId", "");
            string cardTitle = GetString(card, "cardTitle", "");
            string boosterId = GetString(card, "boosterId", "");
            string boosterTitle = GetString(card, "boosterTitle", "");

            if (server.GetCardCount(login, boosterId, cardId) < 1)
            {
                SendChatMessageSafe(GetString(giftCfg, "notOwnedMessage", DefaultGiftNotOwned)
                    .Replace("@userName", "@" + displayName)
                    .Replace("[Kartenname]", cardTitle));
                return;
            }

            if (!server.ApplyGiftTransfer(login, displayName, recipientLogin, recipientRaw, boosterId, cardId))
            {
                // Lost a race against a trade/dust/gift between the check above and here.
                SendChatMessageSafe(GetString(giftCfg, "notOwnedMessage", DefaultGiftNotOwned)
                    .Replace("@userName", "@" + displayName)
                    .Replace("[Kartenname]", cardTitle));
                return;
            }

            server.Log("commands", "info", displayName + " hat \"" + cardTitle + "\" an " + recipientRaw + " verschenkt.");

            if (GetBool(giftCfg, "chatOutputEnabled", true))
            {
                // "@userNameB" must be replaced BEFORE the bare "@userName" - String.Replace is a
                // plain substring replace, and "@userName" is itself a prefix of "@userNameB". In
                // the old order, replacing "@userName" first also ate the "@userName" part of
                // every "@userNameB" occurrence, leaving a stray "...B" glued onto the SENDER'S
                // name instead of the recipient ever being substituted - e.g. "@giver" became
                // "@giverB" while the real recipient name silently vanished from the message.
                SendChatMessageSafe(GetString(giftCfg, "successMessage", DefaultGiftSuccess)
                    .Replace("@userNameB", "@" + recipientRaw)
                    .Replace("@userName", "@" + displayName)
                    .Replace("[Kartenname]", cardTitle));
            }

            Dictionary<string, object> giftAnimCfg = Obj(server.ReadSettingsObject(), "giftAnimation");
            if (GetBool(giftAnimCfg, "enabled", false))
            {
                var giftEvent = new Dictionary<string, object>
                {
                    { "kind", "gift" },
                    { "style", GetString(giftAnimCfg, "style", "handover") },
                    { "fromLogin", login.ToLowerInvariant() },
                    { "fromUser", displayName },
                    { "toLogin", recipientLogin },
                    { "toUser", recipientRaw },
                    { "cardId", cardId },
                    { "cardTitle", cardTitle },
                    { "boosterId", boosterId },
                    { "boosterTitle", boosterTitle }
                };
                // Routed through the action queue (like every other animation) so it never plays
                // at the same time as an in-progress pack-opening/trade/battle/etc.
                Enqueue("gift", login, displayName, "chat", giftEvent);
            }
        }

// ---- Sammlungs-Vergleich: !vergleich @userB ----

        private void HandleCompareCommand(string login, string displayName, string args, Dictionary<string, object> compareCfg)
        {
            string partnerRaw = args.Trim().TrimStart('@');
            if (partnerRaw.Length == 0)
            {
                SendCommandOutput(login, compareCfg, GetString(compareCfg, "usageMessage", DefaultCompareUsage).Replace("@userName", "@" + displayName));
                return;
            }
            string partnerLogin = partnerRaw.ToLowerInvariant();
            if (partnerLogin == login.ToLowerInvariant())
            {
                SendCommandOutput(login, compareCfg, GetString(compareCfg, "selfMessage", DefaultCompareSelf).Replace("@userName", "@" + displayName));
                return;
            }
            if (!server.UserExistsInCollections(partnerLogin))
            {
                SendCommandOutput(login, compareCfg, GetString(compareCfg, "userNotFoundMessage", DefaultCompareUserNotFound)
                    .Replace("@userName", "@" + displayName)
                    .Replace("[Nutzer]", partnerRaw));
                return;
            }

            List<Dictionary<string, string>> ownedA = server.GetUserOwnedCardTypes(login);
            List<Dictionary<string, string>> ownedB = server.GetUserOwnedCardTypes(partnerLogin);
            HashSet<string> setA = new HashSet<string>();
            foreach (Dictionary<string, string> entry in ownedA) setA.Add(entry["boosterId"] + "|" + entry["cardId"]);
            HashSet<string> setB = new HashSet<string>();
            foreach (Dictionary<string, string> entry in ownedB) setB.Add(entry["boosterId"] + "|" + entry["cardId"]);

            int shared = 0;
            foreach (string key in setA) if (setB.Contains(key)) shared++;
            int exclusiveA = setA.Count - shared;
            int exclusiveB = setB.Count - shared;

            SendCommandOutput(login, compareCfg, GetString(compareCfg, "resultMessage", DefaultCompareResult)
                .Replace("@userNameB", "@" + partnerRaw)
                .Replace("@userNameA", "@" + displayName)
                .Replace("@userName", "@" + displayName)
                .Replace("[AnzahlA]", setA.Count.ToString())
                .Replace("[AnzahlB]", setB.Count.ToString())
                .Replace("[Gemeinsam]", shared.ToString())
                .Replace("[ExklusivA]", exclusiveA.ToString())
                .Replace("[ExklusivB]", exclusiveB.ToString()));

            server.Log("commands", "info", displayName + " hat seine Sammlung mit " + partnerRaw + " verglichen.");
        }

private void EnsureUsageLoaded()
        {
            if (usageLoaded) return;
            usageData = ParseObject(server.ReadFileText(server.CommandUsagePath(), "{}"));
            if (!usageData.ContainsKey("users") || !(usageData["users"] is Dictionary<string, object>))
            {
                usageData["users"] = new Dictionary<string, object>();
            }
            usageLoaded = true;
        }

private Dictionary<string, object> GetOrCreateUsageEntry(string login, string displayName)
        {
            string key = login.Trim().ToLowerInvariant();
            Dictionary<string, object> users = (Dictionary<string, object>)usageData["users"];
            Dictionary<string, object> entry;
            if (users.ContainsKey(key) && users[key] is Dictionary<string, object>)
            {
                entry = (Dictionary<string, object>)users[key];
            }
            else
            {
                entry = new Dictionary<string, object> { { "count", 0 } };
                users[key] = entry;
            }
            entry["displayName"] = displayName;
            return entry;
        }

// Applies the periodic reset to every viewer's pack-usage counter once the configured
        // interval has elapsed. "Tage" always resets at local 00:01 - computing the next
        // occurrence from the calendar date (rather than adding a fixed 24h span) means the
        // wall-clock target is always correct across a daylight-saving transition.
        private void ApplyResetIfDue(Dictionary<string, object> packCfg, DateTime nowUtc)
        {
            DateTime nextReset = ParseDate(GetString(usageData, "nextGlobalResetAt", ""));
            // Not yet due AND still consistent with the current interval. The upper bound clamp
            // (nextReset <= dueLimit) ensures that if the interval was shortened after this value
            // was computed (e.g. from "Tage" down to "5 Minuten"), the now-too-distant stale value
            // is treated as due and recomputed, instead of blocking all resets until the old time.
            DateTime dueLimit = ComputeNextResetAt(packCfg, nowUtc);
            if (nextReset != DateTime.MinValue && nextReset > nowUtc && nextReset <= dueLimit) return;

            Dictionary<string, object> users = (Dictionary<string, object>)usageData["users"];
            bool hadUsers = users.Count > 0;
            foreach (object value in users.Values)
            {
                Dictionary<string, object> entry = value as Dictionary<string, object>;
                if (entry != null) entry["count"] = 0;
            }
            usageData["nextGlobalResetAt"] = ComputeNextResetAt(packCfg, nowUtc).ToString("o");
            SaveUsage();
            if (hadUsers) server.Log("commands", "info", "Automatischer Reset der Pack-Nutzung durchgefuehrt.");
        }

internal static DateTime ComputeNextResetAt(Dictionary<string, object> packCfg, DateTime fromUtc)
        {
            string unit = GetString(packCfg, "resetUnit", "hours");
            int value = Math.Max(1, GetInt(packCfg, "resetValue", 24));

            if (unit == "days")
            {
                DateTime localNow = fromUtc.ToLocalTime();
                DateTime candidate = localNow.Date.AddMinutes(1); // today 00:01 local
                if (candidate <= localNow) candidate = candidate.AddDays(1);
                return TimeZoneInfo.ConvertTimeToUtc(DateTime.SpecifyKind(candidate, DateTimeKind.Unspecified), TimeZoneInfo.Local);
            }
            if (unit == "minutes") return fromUtc.AddMinutes(value);
            return fromUtc.AddHours(value);
        }

private void SaveUsage()
        {
            try { File.WriteAllText(server.CommandUsagePath(), server.Serializer.Serialize(usageData), Encoding.UTF8); }
            catch { }
        }

// Exposes each viewer's current pity streak/bank (see ProcessQueueItem/HandleDustCommand)
        // for display in the admin User tab.
        public Dictionary<string, object> GetPityState()
        {
            lock (pityLock)
            {
                EnsurePityLoaded();
                var result = new Dictionary<string, object>();
                foreach (var kvp in pityState)
                {
                    Dictionary<string, object> entry = kvp.Value as Dictionary<string, object>;
                    if (entry != null)
                    {
                        result[kvp.Key] = new Dictionary<string, object> {
                            { "streak", GetInt(entry, "streak", 0) }, { "bank", GetInt(entry, "bank", 0) },
                            { "dustAllRarity", GetString(entry, "dustAllRarity", "uncommon") }
                        };
                    }
                    else
                    {
                        // Back-compat: legacy bare-integer streak entries (see GetPityEntry).
                        int legacyStreak;
                        Int32.TryParse(Convert.ToString(kvp.Value), out legacyStreak);
                        result[kvp.Key] = new Dictionary<string, object> { { "streak", legacyStreak }, { "bank", 0 } };
                    }
                }
                return result;
            }
        }

public Dictionary<string, object> GetCommandUsage()
        {
            Dictionary<string, object> settings = server.ReadSettingsObject();
            Dictionary<string, object> cc = Obj(settings, "chatCommands");
            int packMax = Math.Max(0, GetInt(Obj(cc, "pack"), "maxUses", 0));
            int tradeMax = Math.Max(0, GetInt(Obj(cc, "trade"), "maxUses", 0));
            int battleMax = Math.Max(0, GetInt(Obj(cc, "battle"), "maxUses", 0));
            lock (usageLock)
            {
                EnsureUsageLoaded();
                Dictionary<string, object> packUsers = usageData["users"] as Dictionary<string, object> ?? new Dictionary<string, object>();
                Dictionary<string, object> tradeSection = TradeSection();
                Dictionary<string, object> tradeUsers = tradeSection["users"] as Dictionary<string, object> ?? new Dictionary<string, object>();
                Dictionary<string, object> battleSection = BattleSection();
                Dictionary<string, object> battleUsers = battleSection["users"] as Dictionary<string, object> ?? new Dictionary<string, object>();

                var keys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (string k in packUsers.Keys) keys.Add(k);
                foreach (string k in tradeUsers.Keys) keys.Add(k);
                foreach (string k in battleUsers.Keys) keys.Add(k);

                var list = new List<object>();
                foreach (string key in keys)
                {
                    Dictionary<string, object> p = packUsers.ContainsKey(key) ? packUsers[key] as Dictionary<string, object> : null;
                    Dictionary<string, object> tr = tradeUsers.ContainsKey(key) ? tradeUsers[key] as Dictionary<string, object> : null;
                    Dictionary<string, object> bt = battleUsers.ContainsKey(key) ? battleUsers[key] as Dictionary<string, object> : null;
                    int packCount = p != null ? GetInt(p, "count", 0) : 0;
                    int tradeCount = tr != null ? GetInt(tr, "count", 0) : 0;
                    int battleCount = bt != null ? GetInt(bt, "count", 0) : 0;
                    string display = p != null ? GetString(p, "displayName", key) : (tr != null ? GetString(tr, "displayName", key) : (bt != null ? GetString(bt, "displayName", key) : key));
                    list.Add(new Dictionary<string, object>
                    {
                        { "login", key },
                        { "displayName", display },
                        { "packCount", packCount },
                        { "tradeCount", tradeCount },
                        { "battleCount", battleCount },
                        { "packRemaining", packMax > 0 ? (object)Math.Max(0, packMax - packCount) : null },
                        { "tradeRemaining", tradeMax > 0 ? (object)Math.Max(0, tradeMax - tradeCount) : null },
                        { "battleRemaining", battleMax > 0 ? (object)Math.Max(0, battleMax - battleCount) : null }
                    });
                }

                return new Dictionary<string, object>
                {
                    { "pack", new Dictionary<string, object> { { "maxUses", packMax }, { "nextResetAt", GetString(usageData, "nextGlobalResetAt", "") } } },
                    { "trade", new Dictionary<string, object> { { "maxUses", tradeMax }, { "nextResetAt", GetString(tradeSection, "nextGlobalResetAt", "") } } },
                    { "battle", new Dictionary<string, object> { { "maxUses", battleMax }, { "nextResetAt", GetString(battleSection, "nextGlobalResetAt", "") } } },
                    { "users", list.ToArray() }
                };
            }
        }

public void ResetCommandUsage(string login)
        {
            lock (usageLock)
            {
                EnsureUsageLoaded();
                Dictionary<string, object> packUsers = (Dictionary<string, object>)usageData["users"];
                Dictionary<string, object> tradeUsers = TradeSection()["users"] as Dictionary<string, object>;
                Dictionary<string, object> battleUsers = BattleSection()["users"] as Dictionary<string, object>;
                if (String.IsNullOrWhiteSpace(login))
                {
                    ZeroAllCounts(packUsers);
                    ZeroAllCounts(tradeUsers);
                    ZeroAllCounts(battleUsers);
                    server.Log("commands", "info", "Nutzung (Pack, Tausch & Kampf) aller User zurueckgesetzt.");
                }
                else
                {
                    string key = login.Trim().ToLowerInvariant();
                    ZeroCount(packUsers, key);
                    ZeroCount(tradeUsers, key);
                    ZeroCount(battleUsers, key);
                    server.Log("commands", "info", "Nutzung (Pack, Tausch & Kampf) von " + login + " zurueckgesetzt.");
                }
                SaveUsage();
            }
        }

private static void ZeroAllCounts(Dictionary<string, object> users)
        {
            if (users == null) return;
            foreach (object value in users.Values)
            {
                Dictionary<string, object> entry = value as Dictionary<string, object>;
                if (entry != null) entry["count"] = 0;
            }
        }

private static void ZeroCount(Dictionary<string, object> users, string key)
        {
            if (users == null) return;
            if (users.ContainsKey(key) && users[key] is Dictionary<string, object>) ((Dictionary<string, object>)users[key])["count"] = 0;
        }

private void StartResetTimerOnce()
        {
            if (resetTimerStarted) return;
            resetTimerStarted = true;
            resetTimer = new System.Threading.Timer(delegate
            {
                try
                {
                    Dictionary<string, object> settings = server.ReadSettingsObject();
                    Dictionary<string, object> cc = Obj(settings, "chatCommands");
                    lock (usageLock)
                    {
                        EnsureUsageLoaded();
                        ApplyResetIfDue(Obj(cc, "pack"), DateTime.UtcNow);
                        ApplyTradeResetIfDue(Obj(cc, "trade"), DateTime.UtcNow);
                    }
                }
                catch
                {
                }
            // Fire shortly after start too, so any reset that became due while the app was closed
            // is applied right away (cooldowns are absolute timestamps and are honored on demand).
            }, null, 2000, 15000);
        }

private static DateTime ParseDate(string text)
        {
            DateTime value;
            return DateTime.TryParse(text, null, System.Globalization.DateTimeStyles.RoundtripKind, out value) ? value.ToUniversalTime() : DateTime.MinValue;
        }

private static string FormatLocalTime(DateTime utc)
        {
            if (utc == DateTime.MinValue) return "?";
            return utc.ToLocalTime().ToString("HH:mm");
        }
    }
}
