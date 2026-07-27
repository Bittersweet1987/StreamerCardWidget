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
// ---- Battle system: !battle / !battleyes / !battleno ----

        private void HandleBattleCommand(string login, string displayName, string args, Dictionary<string, object> battleCfg)
        {
            string partnerRaw = args.Trim().TrimStart('@');
            if (partnerRaw.Length == 0)
            {
                SendChatMessageSafe(GetString(battleCfg, "usageMessage", DefaultBattleUsage).Replace("@userName", "@" + displayName));
                return;
            }
            string partnerLogin = partnerRaw.ToLowerInvariant();

            int lineupSize = Math.Max(1, GetInt(battleCfg, "lineupSize", 3));
            int cooldownSeconds = Math.Max(0, GetInt(battleCfg, "cooldownSeconds", 0));
            int maxUses = Math.Max(0, GetInt(battleCfg, "maxUses", 0));
            int timeoutSeconds = Math.Max(10, GetInt(battleCfg, "requestTimeoutSeconds", 120));
            DateTime now = DateTime.UtcNow;

            lock (battleLock)
            {
                if (activeBattle != null)
                {
                    SendChatMessageSafe(GetString(battleCfg, "busyMessage", DefaultBattleBusy).Replace("@userName", "@" + displayName));
                    return;
                }

                if (partnerLogin == login.ToLowerInvariant())
                {
                    SendChatMessageSafe(GetString(battleCfg, "selfChallengeMessage", DefaultBattleSelfChallenge).Replace("@userName", "@" + displayName));
                    return;
                }

                lock (usageLock)
                {
                    EnsureUsageLoaded();
                    ApplyBattleResetIfDue(battleCfg, now);
                    Dictionary<string, object> entry = GetOrCreateBattleEntry(login, displayName);

                    DateTime cooldownUntil = ParseDate(GetString(entry, "cooldownUntil", ""));
                    if (cooldownSeconds > 0 && cooldownUntil > now.AddSeconds(cooldownSeconds)) { cooldownUntil = now.AddSeconds(cooldownSeconds); entry["cooldownUntil"] = cooldownUntil.ToString("o"); }
                    if (cooldownSeconds > 0 && cooldownUntil > now)
                    {
                        string msg = GetString(battleCfg, "cooldownMessage", DefaultBattleCooldown)
                            .Replace("@userName", "@" + displayName)
                            .Replace("[Uhrzeit]", FormatLocalTime(cooldownUntil))
                            .Replace("[Cooldownwert]", cooldownSeconds.ToString())
                            .Replace("[Einheit]", "Sekunden");
                        SendChatMessageSafe(msg);
                        return;
                    }

                    if (maxUses > 0 && GetInt(entry, "count", 0) >= maxUses)
                    {
                        string msg = GetString(battleCfg, "limitMessage", DefaultBattleLimit)
                            .Replace("@userName", "@" + displayName)
                            .Replace("[Uhrzeit]", FormatLocalTime(BattleNextReset()));
                        SendChatMessageSafe(msg);
                        return;
                    }
                }

                if (!server.UserExistsInCollections(partnerLogin))
                {
                    SendChatMessageSafe(GetString(battleCfg, "userNotFoundMessage", DefaultBattleUserNotFound)
                        .Replace("@userName", "@" + displayName)
                        .Replace("[Nutzer]", partnerRaw));
                    return;
                }

                List<Dictionary<string, string>> ownedA = server.GetUserOwnedCardTypes(login);
                List<Dictionary<string, string>> ownedB = server.GetUserOwnedCardTypes(partnerLogin);
                if (ownedA.Count < lineupSize || ownedB.Count < lineupSize)
                {
                    SendChatMessageSafe(GetString(battleCfg, "notEnoughCardsMessage", DefaultBattleNotEnoughCards)
                        .Replace("@userName", "@" + displayName)
                        .Replace("[Anzahl]", lineupSize.ToString()));
                    return;
                }

                activeBattle = new Dictionary<string, object>
                {
                    { "id", Guid.NewGuid().ToString("N") },
                    { "fromLogin", login.ToLowerInvariant() },
                    { "fromUser", displayName },
                    { "toLogin", partnerLogin },
                    { "toUser", partnerRaw },
                    { "lineupSize", lineupSize },
                    { "expiresAt", now.AddSeconds(timeoutSeconds).ToString("o") }
                };
                if (battleTimeoutTimer != null) battleTimeoutTimer.Dispose();
                battleTimeoutTimer = new System.Threading.Timer(delegate { BattleTimedOut(); }, null, timeoutSeconds * 1000, Timeout.Infinite);

                Dictionary<string, object> ccForOffer = Obj(server.ReadSettingsObject(), "chatCommands");
                Dictionary<string, object> battleYesCfg = Obj(ccForOffer, "battleyes");
                Dictionary<string, object> battleNoCfg = Obj(ccForOffer, "battleno");
                string befehlAnnehmen = GetString(battleYesCfg, "prefix", "!") + GetString(battleYesCfg, "command", "battleyes");
                string befehlAblehnen = GetString(battleNoCfg, "prefix", "!") + GetString(battleNoCfg, "command", "battleno");

                SendChatMessageSafe(GetString(battleCfg, "offerMessage", DefaultBattleOffer)
                    .Replace("@userNameB", "@" + partnerRaw)
                    .Replace("@userNameA", "@" + displayName)
                    .Replace("[BefehlAnnehmen]", befehlAnnehmen)
                    .Replace("[BefehlAblehnen]", befehlAblehnen));
                SavePendingState();
            }
        }

private void HandleBattleYes(string login, string displayName, Dictionary<string, object> cc)
        {
            Dictionary<string, object> battleCfg = Obj(cc, "battle");
            Dictionary<string, object> yesCfg = Obj(cc, "battleyes");
            lock (battleLock)
            {
                if (activeBattle == null) return;
                if (login.ToLowerInvariant() != GetString(activeBattle, "toLogin", "")) return;

                string fromLogin = GetString(activeBattle, "fromLogin", "");
                string fromUser = GetString(activeBattle, "fromUser", "");
                int lineupSize = GetInt(activeBattle, "lineupSize", 3);

                List<Dictionary<string, string>> ownedA = server.GetUserOwnedCardTypes(fromLogin);
                List<Dictionary<string, string>> ownedB = server.GetUserOwnedCardTypes(login);
                if (ownedA.Count < lineupSize || ownedB.Count < lineupSize)
                {
                    // A card type may have been traded away since the challenge was issued.
                    SendChatMessageSafe(GetString(battleCfg, "notEnoughCardsMessage", DefaultBattleNotEnoughCards)
                        .Replace("@userName", "@" + displayName)
                        .Replace("[Anzahl]", lineupSize.ToString()));
                    ClearActiveBattle();
                    return;
                }

                List<Dictionary<string, string>> lineupA = DrawRandomLineup(ownedA, lineupSize);
                List<Dictionary<string, string>> lineupB = DrawRandomLineup(ownedB, lineupSize);

                Dictionary<string, object> settings = server.ReadSettingsObject();
                Dictionary<string, object> strengthCfg = Obj(settings, "battleStrength");
                double variance = GetDouble(strengthCfg, "variance", DefaultBattleVariance);

                // The HP-Leisten-Duell animation uses a different resolution mechanic (sequential
                // Pokemon-style elimination with persisting HP) instead of N independent round
                // pairs; the other animation styles keep the original "most round wins" mechanic.
                Dictionary<string, object> battleAnimForStyle = Obj(settings, "battleAnimation");
                bool useHpElimination = GetString(battleAnimForStyle, "style", "clash") == "hp";

                int winsA = 0, winsB = 0;
                var rounds = new List<object>();
                Dictionary<string, object> hpResult = null;

                if (useHpElimination)
                {
                    hpResult = ResolveHpElimination(lineupA, lineupB, strengthCfg, variance);
                    winsA = GetInt(hpResult, "cardsLostB", 0);
                    winsB = GetInt(hpResult, "cardsLostA", 0);
                }
                else
                {
                    for (int i = 0; i < lineupSize; i++)
                    {
                        bool aWins = RollRound(lineupA[i], lineupB[i], strengthCfg, variance);
                        if (aWins) winsA++; else winsB++;
                        rounds.Add(new Dictionary<string, object>
                        {
                            { "cardA", lineupA[i] }, { "cardB", lineupB[i] }, { "winner", aWins ? "A" : "B" }
                        });
                    }

                    // Sudden death: one more random card each until the tie breaks. Must not reuse
                    // a card already fielded earlier in this same battle (main lineup or a prior
                    // sudden-death round) while an unused one is still available - otherwise a
                    // single-copy card could appear to fight more than once in one duel.
                    var usedIdsA = new HashSet<string>();
                    foreach (Dictionary<string, string> c in lineupA) usedIdsA.Add(c["cardId"]);
                    var usedIdsB = new HashSet<string>();
                    foreach (Dictionary<string, string> c in lineupB) usedIdsB.Add(c["cardId"]);

                    int suddenDeathRounds = 0;
                    while (winsA == winsB && suddenDeathRounds < 20)
                    {
                        List<Dictionary<string, string>> poolA = UnusedCardPool(ownedA, usedIdsA);
                        List<Dictionary<string, string>> poolB = UnusedCardPool(ownedB, usedIdsB);
                        List<Dictionary<string, string>> sdA = DrawRandomLineup(poolA, 1);
                        List<Dictionary<string, string>> sdB = DrawRandomLineup(poolB, 1);
                        usedIdsA.Add(sdA[0]["cardId"]);
                        usedIdsB.Add(sdB[0]["cardId"]);
                        bool aWins = RollRound(sdA[0], sdB[0], strengthCfg, variance);
                        if (aWins) winsA++; else winsB++;
                        rounds.Add(new Dictionary<string, object>
                        {
                            { "cardA", sdA[0] }, { "cardB", sdB[0] }, { "winner", aWins ? "A" : "B" }, { "suddenDeath", true }
                        });
                        suddenDeathRounds++;
                    }
                }

                bool winnerIsA = useHpElimination ? GetBool(hpResult, "winnerIsA", winsA >= winsB) : winsA > winsB;
                string winnerLogin = winnerIsA ? fromLogin : login;
                string winnerUser = winnerIsA ? fromUser : displayName;
                string loserLogin = winnerIsA ? login : fromLogin;
                string loserUser = winnerIsA ? displayName : fromUser;
                List<Dictionary<string, string>> loserLineup = winnerIsA ? lineupB : lineupA;

                // Prize: one random card from the loser's lineup (the one that was actually used).
                Dictionary<string, string> prizeCard = loserLineup[BattleRandom.Next(loserLineup.Count)];
                server.TransferSingleCard(prizeCard["boosterId"], prizeCard["cardId"], loserLogin, loserUser, winnerLogin, winnerUser);
                Dictionary<string, string> prizeInfo = server.CardDisplayInfo(prizeCard["boosterId"], prizeCard["cardId"]);
                server.RecordBattleResult(winnerLogin, winnerUser, loserLogin, loserUser);

                int cooldownSeconds = Math.Max(0, GetInt(battleCfg, "cooldownSeconds", 0));
                DateTime now = DateTime.UtcNow;
                lock (usageLock)
                {
                    EnsureUsageLoaded();
                    ConsumeBattle(fromLogin, fromUser, cooldownSeconds, now);
                    ConsumeBattle(login, displayName, cooldownSeconds, now);
                    SaveUsage();
                }

                var battleEvent = new Dictionary<string, object>
                {
                    { "userA", fromUser }, { "userB", displayName },
                    { "lineupA", lineupA }, { "lineupB", lineupB },
                    { "mode", useHpElimination ? "hp" : "rounds" },
                    { "rounds", rounds },
                    { "hpMatchups", useHpElimination ? hpResult["matchups"] : new object[0] },
                    { "winner", winnerIsA ? "A" : "B" },
                    { "winsA", winsA }, { "winsB", winsB },
                    { "prizeCardId", prizeCard["cardId"] }, { "prizeBoosterId", prizeCard["boosterId"] },
                    { "prizeCardTitle", prizeInfo["cardTitle"] }, { "prizeBoosterTitle", prizeInfo["boosterTitle"] },
                    { "winnerUser", winnerUser }, { "loserUser", loserUser }, { "winnerLogin", winnerLogin }
                };
                // The result message must NOT be shown before the OBS animation reveals the winner -
                // it's attached to the queue item as "completionChat" and sent by QueueLoop only
                // once this duel's animation has actually finished playing (or its safety timeout
                // elapsed), NOT on a time estimate from enqueue time. The old estimate started
                // counting the moment the duel was enqueued, so anything already in the queue ahead
                // of it (another duel, a pack draw) pushed the real animation later while the chat
                // still fired on the original schedule - spoiling the winner mid-animation.
                bool animEnabled = GetBool(battleAnimForStyle, "enabled", false);
                bool sendChat = animEnabled ? GetBool(battleAnimForStyle, "sendChat", true) : true;
                if (sendChat)
                {
                    battleEvent["completionChat"] = GetString(yesCfg, "resultMessage", DefaultBattleResult)
                        .Replace("@userNameA", "@" + winnerUser)
                        .Replace("@userNameB", "@" + loserUser)
                        .Replace("[SiegeA]", winnerIsA ? winsA.ToString() : winsB.ToString())
                        .Replace("[SiegeB]", winnerIsA ? winsB.ToString() : winsA.ToString())
                        .Replace("[GewonneneKarte]", prizeInfo["cardTitle"])
                        .Replace("[BoosterGewonnen]", prizeInfo["boosterTitle"]);
                }
                // Routed through the same queue as draw/showcollection/ranking so the battle
                // animation never overlaps another - it used to broadcast directly, which let it
                // play at the same time as an in-progress pack-opening or collection showcase.
                Enqueue("battle", fromLogin, fromUser, "chat", battleEvent);
                server.Log("commands", "info", winnerUser + " gewann das Kartenduell gegen " + loserUser + " (" + Math.Max(winsA, winsB) + ":" + Math.Min(winsA, winsB) + ") und erhielt " + prizeInfo["cardTitle"] + ".");

                ClearActiveBattle();
            }
        }

private void HandleBattleNo(string login, string displayName, Dictionary<string, object> cc)
        {
            Dictionary<string, object> noCfg = Obj(cc, "battleno");
            lock (battleLock)
            {
                if (activeBattle == null) return;
                if (login.ToLowerInvariant() != GetString(activeBattle, "toLogin", "")) return;

                string fromUser = GetString(activeBattle, "fromUser", "");
                SendChatMessageSafe(GetString(noCfg, "declineMessage", DefaultBattleDecline)
                    .Replace("@userNameA", "@" + fromUser)
                    .Replace("@userNameB", "@" + displayName));
                ClearActiveBattle();
            }
        }

private void BattleTimedOut()
        {
            lock (battleLock)
            {
                if (activeBattle == null) return;
                Dictionary<string, object> settings = server.ReadSettingsObject();
                Dictionary<string, object> battleCfg = Obj(Obj(settings, "chatCommands"), "battle");
                string fromUser = GetString(activeBattle, "fromUser", "");
                string toUser = GetString(activeBattle, "toUser", "");
                int timeoutSeconds = Math.Max(10, GetInt(battleCfg, "requestTimeoutSeconds", 120));
                SendChatMessageSafe(GetString(battleCfg, "timeoutMessage", DefaultBattleTimeout)
                    .Replace("@userNameA", "@" + fromUser)
                    .Replace("@userNameB", "@" + toUser)
                    .Replace("[Zeit]", timeoutSeconds.ToString()));
                ClearActiveBattle();
            }
        }

// Cards from `owned` not yet used in this battle; falls back to the full pool only if
        // every owned card type has already fought (so sudden death can still proceed).
        private static List<Dictionary<string, string>> UnusedCardPool(List<Dictionary<string, string>> owned, HashSet<string> usedIds)
        {
            var pool = new List<Dictionary<string, string>>();
            foreach (Dictionary<string, string> c in owned)
            {
                if (!usedIds.Contains(c["cardId"])) pool.Add(c);
            }
            return pool.Count > 0 ? pool : owned;
        }

// Draws `count` distinct random card types from `owned` (no replacement within one draw).
        private static List<Dictionary<string, string>> DrawRandomLineup(List<Dictionary<string, string>> owned, int count)
        {
            var pool = new List<Dictionary<string, string>>(owned);
            var result = new List<Dictionary<string, string>>();
            for (int i = 0; i < count && pool.Count > 0; i++)
            {
                int idx = BattleRandom.Next(pool.Count);
                result.Add(pool[idx]);
                pool.RemoveAt(idx);
            }
            return result;
        }

// The WEAKER side of a matchup rolls the full variance - the stronger (or equal) side rolls a
        // damped fraction of it, never zero. Applying variance to both sides equally (the old
        // behavior) drowned the strength gap in noise: with the default variance of 8, even a Holo
        // (12) could swing anywhere from 12 to 108 damage, which made its rarity all but irrelevant.
        // With the underdog rolling the full amount, the upset ceiling is a fixed multiple of ITS
        // OWN strength - so how big a gap that ceiling can actually close shrinks automatically as
        // the gap widens, without any special-casing: adjacent rarities (small base-strength gap)
        // stay genuinely contestable, while a Common vs. Holo gap stays effectively hopeless unless
        // the variance setting is cranked up disproportionately. The stronger/equal side used to get
        // NO variance at all, which made two same-rarity cards fight a fully deterministic (and
        // tie-biased) match every time - StrongSideVarianceFactor keeps that side noticeably calmer
        // than a genuine underdog while still making every single hit random.
        private const double StrongSideVarianceFactor = 0.3;

        internal double RollDamage(double attackerStrength, double opponentStrength, double variance)
        {
            double effectiveVariance = attackerStrength >= opponentStrength ? variance * StrongSideVarianceFactor : variance;
            return attackerStrength * (1 + BattleRandom.NextDouble() * effectiveVariance);
        }

// One round: strength (from rarity, via the configurable table), with variance only for
        // whichever card is weaker in this matchup (see RollDamage). Best-of-3 independent attacks
        // (each with its OWN variance roll) rather than a single roll - a single roll only ever
        // gives variance one chance to matter for the whole matchup, which barely shows against a
        // real strength gap. Rolling three separate "attacks" and taking the majority lets variance
        // compound (or cancel out) attack to attack, the way it already visibly does in HP-Duell
        // mode (ResolveHpElimination re-rolls variance per hit too).
        private bool RollRound(Dictionary<string, string> cardA, Dictionary<string, string> cardB, Dictionary<string, object> strengthCfg, double variance)
        {
            double strengthA = CardBattleStrength(cardA["cardId"], strengthCfg);
            double strengthB = CardBattleStrength(cardB["cardId"], strengthCfg);
            const int attacks = 3;
            int winsA = 0, winsB = 0;
            for (int i = 0; i < attacks; i++)
            {
                double rollA = RollDamage(strengthA, strengthB, variance);
                double rollB = RollDamage(strengthB, strengthA, variance);
                if (rollA >= rollB) winsA++; else winsB++;
            }
            return winsA >= winsB;
        }

private double CardBattleStrength(string cardId, Dictionary<string, object> strengthCfg)
        {
            string rarity = server.CardRarity(cardId);
            if (strengthCfg != null && strengthCfg.ContainsKey(rarity))
            {
                double v;
                if (Double.TryParse(Convert.ToString(strengthCfg[rarity]), out v) && v > 0) return v;
            }
            switch (rarity)
            {
                case "uncommon": return 2;
                case "rare": return 3;
                case "epic": return 5;
                case "legendary": return 8;
                case "holo": return 12;
                default: return 1;
            }
        }

// Pokemon-style elimination for the "HP-Leisten-Duell" animation: cards fight one matchup
        // at a time, trading hits (damage = attacker strength with variance - full variance if the
        // attacker is the weaker of the two, damped otherwise - see RollDamage) until one card's HP
        // reaches zero; the surviving card keeps its remaining HP into the next matchup against
        // the opponent's next bench card. Overall winner = the side that still has a card standing
        // once the other side runs out. HP per card = battle strength x a configurable factor.
        // Rough estimate of how long the client-side battle animation will take, so the chat
        // result message can be delayed until after it (mirrors the duration/hit-timing tables
        // in battle.js; doesn't need to be exact, just generous enough not to arrive early).
        private int EstimateBattleAnimationMs(bool useHpElimination, Dictionary<string, object> battleAnimCfg, Dictionary<string, object> hpResult)
        {
            string duration = GetString(battleAnimCfg, "duration", "medium");
            if (useHpElimination)
            {
                int hitMs = duration == "short" ? 450 : (duration == "long" ? 900 : 650);
                int totalHits = 0;
                if (hpResult != null)
                {
                    object matchupsObj;
                    if (hpResult.TryGetValue("matchups", out matchupsObj) && matchupsObj is object[])
                    {
                        foreach (object m in (object[])matchupsObj)
                        {
                            Dictionary<string, object> matchup = m as Dictionary<string, object>;
                            if (matchup == null) continue;
                            object hitsObj;
                            if (matchup.TryGetValue("hits", out hitsObj) && hitsObj is object[]) totalHits += ((object[])hitsObj).Length;
                        }
                    }
                }
                int total = hitMs * Math.Max(1, totalHits);
                if (total > 28000) total = 28000;
                return total + 3000;
            }
            int roundsMs = duration == "short" ? 5000 : (duration == "long" ? 12000 : 8000);
            return roundsMs + 2500;
        }

private Dictionary<string, object> ResolveHpElimination(List<Dictionary<string, string>> lineupA, List<Dictionary<string, string>> lineupB, Dictionary<string, object> strengthCfg, double variance)
        {
            double hpFactor = GetDouble(strengthCfg, "hpFactor", 10);
            int idxA = 0, idxB = 0;
            double hpA = CardBattleStrength(lineupA[idxA]["cardId"], strengthCfg) * hpFactor;
            double hpB = CardBattleStrength(lineupB[idxB]["cardId"], strengthCfg) * hpFactor;
            double maxHpA = hpA, maxHpB = hpB;
            var matchups = new List<object>();
            int cardsLostA = 0, cardsLostB = 0;

            while (idxA < lineupA.Count && idxB < lineupB.Count)
            {
                double strengthA = CardBattleStrength(lineupA[idxA]["cardId"], strengthCfg);
                double strengthB = CardBattleStrength(lineupB[idxB]["cardId"], strengthCfg);
                bool attackerIsA = BattleRandom.NextDouble() < (strengthA / (strengthA + strengthB));
                var hits = new List<object>();
                string matchupWinner = null;

                for (int safety = 0; safety < 1000 && matchupWinner == null; safety++)
                {
                    double dmg;
                    if (attackerIsA)
                    {
                        dmg = RollDamage(strengthA, strengthB, variance);
                        hpB = Math.Max(0, hpB - dmg);
                        hits.Add(new Dictionary<string, object> { { "attacker", "A" }, { "damage", Math.Round(dmg, 1) }, { "hpAfter", Math.Round(hpB, 1) } });
                        if (hpB <= 0) matchupWinner = "A";
                    }
                    else
                    {
                        dmg = RollDamage(strengthB, strengthA, variance);
                        hpA = Math.Max(0, hpA - dmg);
                        hits.Add(new Dictionary<string, object> { { "attacker", "B" }, { "damage", Math.Round(dmg, 1) }, { "hpAfter", Math.Round(hpA, 1) } });
                        if (hpA <= 0) matchupWinner = "B";
                    }
                    attackerIsA = !attackerIsA;
                }
                if (matchupWinner == null) matchupWinner = hpA >= hpB ? "A" : "B"; // safety-cap fallback, practically unreachable

                matchups.Add(new Dictionary<string, object>
                {
                    { "cardA", lineupA[idxA] }, { "cardB", lineupB[idxB] },
                    { "maxHpA", Math.Round(maxHpA, 1) }, { "maxHpB", Math.Round(maxHpB, 1) },
                    { "hits", hits.ToArray() }, { "winner", matchupWinner }
                });

                if (matchupWinner == "A")
                {
                    cardsLostB++;
                    idxB++;
                    if (idxB < lineupB.Count) { hpB = CardBattleStrength(lineupB[idxB]["cardId"], strengthCfg) * hpFactor; maxHpB = hpB; }
                }
                else
                {
                    cardsLostA++;
                    idxA++;
                    if (idxA < lineupA.Count) { hpA = CardBattleStrength(lineupA[idxA]["cardId"], strengthCfg) * hpFactor; maxHpA = hpA; }
                }
            }

            return new Dictionary<string, object>
            {
                { "matchups", matchups.ToArray() },
                { "winnerIsA", idxB >= lineupB.Count },
                { "cardsLostA", cardsLostA }, { "cardsLostB", cardsLostB }
            };
        }

// Increments the battle-usage counter and (re)sets the per-user cooldown.
        private void ConsumeBattle(string login, string displayName, int cooldownSeconds, DateTime now)
        {
            Dictionary<string, object> entry = GetOrCreateBattleEntry(login, displayName);
            entry["count"] = GetInt(entry, "count", 0) + 1;
            if (cooldownSeconds > 0) entry["cooldownUntil"] = now.AddSeconds(cooldownSeconds).ToString("o");
        }

private void ClearActiveBattle()
        {
            activeBattle = null;
            if (battleTimeoutTimer != null) { battleTimeoutTimer.Dispose(); battleTimeoutTimer = null; }
            // Safe while already holding battleLock (every call site does) - lock/Monitor is
            // re-entrant for the owning thread, and SavePendingState only takes OTHER locks plus
            // re-entering this same one.
            SavePendingState();
        }

// Deliberately silent in chat for the SUCCESS case (by design): the result is shown
        // exclusively in the dedicated OBS ranking overlay. The two dead-end cases below (unknown
        // card name, or a real card nobody owns yet) get a chat message though - without one,
        // "!ranking <Karte>" would look like the bot never even saw the command, since there is no
        // overlay animation to fall back on either (playCardRanking bails out with zero owners).
        private void HandleRankingCommand(string login, string displayName, string args, Dictionary<string, object> rankingCfg)
        {
            string arg = args.Trim();
            if (arg.Length == 0) return;
            int displaySeconds = Math.Max(2, GetInt(rankingCfg, "displaySeconds", 8));
            string lower = arg.ToLowerInvariant();

            if (lower == "battle" || lower == "kampf" || lower == "battles")
            {
                Dictionary<string, object> lists = server.BuildBattleRanking(5);
                var battlePayload = new Dictionary<string, object>
                {
                    { "type", "battle" },
                    { "displaySeconds", displaySeconds },
                    { "lists", lists }
                };
                Enqueue("ranking", login, displayName, "chat", battlePayload);
                server.Log("commands", "info", displayName + " hat das Kampf-Ranking angefordert.");
                return;
            }

            if (lower == "turnier" || lower == "tournament" || lower == "turniere")
            {
                Dictionary<string, object> lists = server.BuildTournamentRanking(5);
                var tournamentPayload = new Dictionary<string, object>
                {
                    { "type", "tournament" },
                    { "displaySeconds", displaySeconds },
                    { "lists", lists }
                };
                Enqueue("ranking", login, displayName, "chat", tournamentPayload);
                server.Log("commands", "info", displayName + " hat das Turnier-Ranking angefordert.");
                return;
            }

            if (lower == "teamkampf" || lower == "team" || lower == "teambattle")
            {
                Dictionary<string, object> lists = server.BuildTeamKampfRanking(5);
                var teamKampfPayload = new Dictionary<string, object>
                {
                    { "type", "teamkampf" },
                    { "displaySeconds", displaySeconds },
                    { "lists", lists }
                };
                Enqueue("ranking", login, displayName, "chat", teamKampfPayload);
                server.Log("commands", "info", displayName + " hat das Team-Kampf-Ranking angefordert.");
                return;
            }

            if (lower == "tausch" || lower == "trade" || lower == "trades")
            {
                object[] top = server.BuildTradeRanking(5);
                var tradePayload = new Dictionary<string, object>
                {
                    { "type", "trade" },
                    { "displaySeconds", displaySeconds },
                    { "entries", top }
                };
                Enqueue("ranking", login, displayName, "chat", tradePayload);
                server.Log("commands", "info", displayName + " hat das Tausch-Ranking angefordert.");
                return;
            }

            Dictionary<string, object> card = server.ResolveCardByName(arg);
            if (!Convert.ToBoolean(card["found"]))
            {
                SendCommandOutput(login, rankingCfg, GetString(rankingCfg, "cardNotFoundMessage", DefaultRankingCardNotFound)
                    .Replace("@userName", "@" + displayName)
                    .Replace("[falscherName]", arg)
                    .Replace("[Kartenname]", GetString(card, "suggestion", "")));
                return;
            }
            string cardId = GetString(card, "cardId", "");
            string boosterId = GetString(card, "boosterId", "");
            object[] owners = server.GetTopCardOwners(boosterId, cardId, 5);
            if (owners.Length == 0)
            {
                SendCommandOutput(login, rankingCfg, GetString(rankingCfg, "noOwnersMessage", DefaultRankingNoOwners)
                    .Replace("@userName", "@" + displayName)
                    .Replace("[Kartenname]", GetString(card, "cardTitle", "")));
                return;
            }
            var cardPayload = new Dictionary<string, object>
            {
                { "type", "card" },
                { "displaySeconds", displaySeconds },
                { "cardId", cardId },
                { "boosterId", boosterId },
                { "cardTitle", GetString(card, "cardTitle", "") },
                { "boosterTitle", GetString(card, "boosterTitle", "") },
                { "owners", owners }
            };
            Enqueue("ranking", login, displayName, "chat", cardPayload);
            server.Log("commands", "info", displayName + " hat das Ranking fuer Karte \"" + GetString(card, "cardTitle", "") + "\" angefordert.");
        }

// ---- Battle usage tracking (separate namespace inside command-usage.json) ----

        private Dictionary<string, object> BattleSection()
        {
            EnsureUsageLoaded();
            object obj;
            if (usageData.TryGetValue("battle", out obj) && obj is Dictionary<string, object>) return (Dictionary<string, object>)obj;
            Dictionary<string, object> section = new Dictionary<string, object> { { "users", new Dictionary<string, object>() } };
            usageData["battle"] = section;
            return section;
        }

private Dictionary<string, object> GetOrCreateBattleEntry(string login, string displayName)
        {
            Dictionary<string, object> section = BattleSection();
            Dictionary<string, object> users = section["users"] as Dictionary<string, object>;
            if (users == null) { users = new Dictionary<string, object>(); section["users"] = users; }
            string key = login.Trim().ToLowerInvariant();
            Dictionary<string, object> entry;
            if (users.ContainsKey(key) && users[key] is Dictionary<string, object>) entry = (Dictionary<string, object>)users[key];
            else { entry = new Dictionary<string, object> { { "count", 0 } }; users[key] = entry; }
            entry["displayName"] = displayName;
            return entry;
        }

private void ApplyBattleResetIfDue(Dictionary<string, object> battleCfg, DateTime nowUtc)
        {
            Dictionary<string, object> section = BattleSection();
            DateTime nextReset = ParseDate(GetString(section, "nextGlobalResetAt", ""));
            DateTime dueLimit = ComputeNextResetAt(battleCfg, nowUtc);
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
            section["nextGlobalResetAt"] = ComputeNextResetAt(battleCfg, nowUtc).ToString("o");
            SaveUsage();
        }

private DateTime BattleNextReset()
        {
            return ParseDate(GetString(BattleSection(), "nextGlobalResetAt", ""));
        }
    }
}
