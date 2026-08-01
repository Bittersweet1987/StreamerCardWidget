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
private void EnsurePityLoaded()
        {
            if (pityState != null) return;
            pityState = ParseObject(server.ReadFileText(server.PityStatePath(), "{}"));
        }

private Dictionary<string, object> GetPityEntry(string login)
        {
            lock (pityLock)
            {
                EnsurePityLoaded();
                object existing;
                if (pityState.TryGetValue(login, out existing) && existing is Dictionary<string, object>) return (Dictionary<string, object>)existing;
                // Back-compat: earlier versions stored a bare streak integer per login.
                int legacyStreak = existing != null ? GetInt(pityState, login, 0) : 0;
                return new Dictionary<string, object> { { "streak", legacyStreak }, { "bank", 0 } };
            }
        }

private void SavePityEntry(string login, Dictionary<string, object> entry)
        {
            lock (pityLock)
            {
                EnsurePityLoaded();
                pityState[login] = entry;
                try { File.WriteAllText(server.PityStatePath(), server.Serializer.Serialize(pityState), Encoding.UTF8); }
                catch (Exception ex) { server.Log("draw", "error", "Pity-Speicherung fehlgeschlagen: " + ex.Message); }
            }
        }

// "!dustset" per-viewer preference: up to which rarity "!dustall" is allowed to auto-dust
        // duplicates. Stored alongside the streak/bank in the same pity.json entry (it's pity-
        // adjacent state, not worth a separate data file for). Default "uncommon" means "!dustall"
        // only ever touches common duplicates until the viewer actively raises it - effectively a
        // no-op default, so nobody loses cards to auto-dust without opting in first.
        private string GetDustAllRarity(string login)
        {
            Dictionary<string, object> entry = GetPityEntry(login);
            string rarity = GetString(entry, "dustAllRarity", "uncommon");
            return CardPackServer.KnownRarityId(rarity) ? rarity : "uncommon";
        }

private void SetDustAllRarity(string login, string rarityId)
        {
            lock (pityLock)
            {
                Dictionary<string, object> entry = GetPityEntry(login);
                entry["dustAllRarity"] = rarityId;
                SavePityEntry(login, entry);
            }
        }

private void EnsureCommunityGoalLoaded()
        {
            if (communityGoalState != null) return;
            communityGoalState = ParseObject(server.ReadFileText(server.CommunityGoalStatePath(), "{}"));
        }

private void SaveCommunityGoalState()
        {
            try { File.WriteAllText(server.CommunityGoalStatePath(), server.Serializer.Serialize(communityGoalState), Encoding.UTF8); }
            catch (Exception ex) { server.Log("draw", "error", "Community-Ziel-Speicherung fehlgeschlagen: " + ex.Message); }
        }

// Reads every goal stage from settings.communityGoal.stages (each with its own target,
        // bonus-card count and celebration text), sorted ascending by target. Falls back to a
        // single stage built from the pre-multi-stage "target"/"celebrationMessage" fields if no
        // stages array is present yet (older settings.json / first run).
        private List<Dictionary<string, object>> GetGoalStages(Dictionary<string, object> goalCfg)
        {
            var result = new List<Dictionary<string, object>>();
            object stagesObj;
            if (goalCfg.TryGetValue("stages", out stagesObj) && stagesObj is object[])
            {
                foreach (object so in (object[])stagesObj)
                {
                    Dictionary<string, object> stage = so as Dictionary<string, object>;
                    if (stage == null) continue;
                    int target = GetInt(stage, "target", 0);
                    if (target <= 0) continue;
                    int bonusCards = Math.Max(1, GetInt(stage, "bonusCards", 1));
                    string message = GetString(stage, "celebrationMessage", DefaultCommunityGoalMessage);
                    result.Add(new Dictionary<string, object> { { "target", target }, { "bonusCards", bonusCards }, { "celebrationMessage", message } });
                }
            }
            if (result.Count == 0)
            {
                int legacyTarget = Math.Max(1, GetInt(goalCfg, "target", 500));
                string legacyMessage = GetString(goalCfg, "celebrationMessage", DefaultCommunityGoalMessage);
                result.Add(new Dictionary<string, object> { { "target", legacyTarget }, { "bonusCards", 1 }, { "celebrationMessage", legacyMessage } });
            }
            result.Sort(delegate(Dictionary<string, object> a, Dictionary<string, object> b) { return GetInt(a, "target", 0).CompareTo(GetInt(b, "target", 0)); });
            return result;
        }

// Called from the same central "draw" handling as the pity system (see ProcessQueueItem)
        // so every trigger (channel points, chat command or bits) contributes equally.
        private void RegisterCommunityGoalDraw(string login, string displayName)
        {
            Dictionary<string, object> settings = server.ReadSettingsObject();
            Dictionary<string, object> goalCfg = Obj(settings, "communityGoal");
            if (!GetBool(goalCfg, "enabled", false)) return;
            List<Dictionary<string, object>> stages = GetGoalStages(goalCfg);

            int current;
            int reachedCount;
            bool allDone;
            var newlyReached = new List<Dictionary<string, object>>();
            Dictionary<string, object> participantsSnapshot = null;
            lock (communityGoalLock)
            {
                EnsureCommunityGoalLoaded();
                if (GetBool(communityGoalState, "reached", false)) return; // frozen until an admin resets it

                current = GetInt(communityGoalState, "current", 0) + 1;
                communityGoalState["current"] = current;
                object participantsObj;
                if (!communityGoalState.TryGetValue("participants", out participantsObj) || !(participantsObj is Dictionary<string, object>))
                {
                    participantsObj = new Dictionary<string, object>();
                    communityGoalState["participants"] = participantsObj;
                }
                ((Dictionary<string, object>)participantsObj)[login] = displayName;

                reachedCount = GetInt(communityGoalState, "reachedCount", 0);
                // Stages are sorted ascending, so reaching stage i implies every earlier stage is
                // already reached too - walking forward from the last-known reachedCount is
                // enough, no need to recheck stages already marked.
                while (reachedCount < stages.Count && GetInt(stages[reachedCount], "target", 0) <= current)
                {
                    newlyReached.Add(stages[reachedCount]);
                    reachedCount++;
                }
                communityGoalState["reachedCount"] = reachedCount;
                allDone = reachedCount >= stages.Count;
                if (allDone) communityGoalState["reached"] = true;

                if (newlyReached.Count > 0) participantsSnapshot = new Dictionary<string, object>((Dictionary<string, object>)participantsObj);
                SaveCommunityGoalState();
            }

            int nextTarget = GetInt(stages[allDone ? stages.Count - 1 : reachedCount], "target", current);
            if (!IsIrlModeActive(server.ReadSettingsObject()))
            {
                server.Broadcast("communitygoalprogress", server.Serializer.Serialize(new Dictionary<string, object>
                {
                    { "current", current },
                    { "target", nextTarget },
                    { "reached", allDone },
                    { "stageNumber", reachedCount },
                    { "stageCount", stages.Count }
                }));
            }

            if (newlyReached.Count == 0) return;

            // Don't play the celebration or grant bonus draws right here - we're still in the
            // middle of processing the draw THAT reached the stage, whose own animation hasn't
            // even been broadcast yet (that happens further down in ProcessQueueItem). Firing the
            // celebration synchronously made it visually stomp on that draw's animation (and the
            // subsequent bonus draws), since none of this went through the serialized action
            // queue. Enqueueing each reached stage as its own item instead makes it play in its
            // proper turn, after the goal-completing draw's animation finishes.
            foreach (Dictionary<string, object> stage in newlyReached)
            {
                int stageTarget = GetInt(stage, "target", 0);
                int bonusCards = GetInt(stage, "bonusCards", 1);
                string celebrationMessage = GetString(stage, "celebrationMessage", DefaultCommunityGoalMessage)
                    .Replace("[Ziel]", stageTarget.ToString())
                    .Replace("[Karten]", bonusCards.ToString());
                server.Log("draw", "info", "Community-Ziel-Stufe erreicht (" + stageTarget + " Ziehungen) - " + participantsSnapshot.Count + " Teilnehmer erhalten je " + bonusCards + " Bonus-Booster.");
                var participantList = new List<object>();
                foreach (var kvp in participantsSnapshot)
                {
                    participantList.Add(new Dictionary<string, object> { { "login", kvp.Key }, { "displayName", Convert.ToString(kvp.Value) } });
                }
                Enqueue("communitygoalreached", "", "", "system", new Dictionary<string, object>
                {
                    { "target", stageTarget },
                    { "bonusCards", bonusCards },
                    { "celebrationMessage", celebrationMessage },
                    { "participants", participantList.ToArray() }
                });
            }
        }

// Reads settings.loyaltyBonus.tiers (each with its own "days"/"bonusCards"/"minRarity"),
        // sorted ascending by "days" - a streak of N days fires every tier whose "days" evenly
        // divides N (see RegisterLoyaltyDraw), so e.g. a days=5 and a days=10 tier both fire on
        // day 10, stacking their bonus draws.
        private List<Dictionary<string, object>> GetLoyaltyTiers(Dictionary<string, object> loyaltyCfg)
        {
            var result = new List<Dictionary<string, object>>();
            object tiersObj;
            if (loyaltyCfg.TryGetValue("tiers", out tiersObj) && tiersObj is object[])
            {
                foreach (object to in (object[])tiersObj)
                {
                    Dictionary<string, object> tier = to as Dictionary<string, object>;
                    if (tier == null) continue;
                    int days = GetInt(tier, "days", 0);
                    if (days <= 0) continue;
                    int bonusCards = Math.Max(1, GetInt(tier, "bonusCards", 1));
                    string minRarity = GetString(tier, "minRarity", "rare");
                    result.Add(new Dictionary<string, object> { { "days", days }, { "bonusCards", bonusCards }, { "minRarity", minRarity } });
                }
            }
            result.Sort(delegate(Dictionary<string, object> a, Dictionary<string, object> b) { return GetInt(a, "days", 0).CompareTo(GetInt(b, "days", 0)); });
            return result;
        }

// Called from the same central "draw" handling as the pity/community-goal systems (see
        // ProcessQueueItem) so every trigger counts equally - except the loyalty bonus draws
        // THEMSELVES (tagged "loyaltyBonus" on the queue item), which are excluded by the caller
        // to avoid a completed day's reward inflating that same day's already-completed progress.
        // Tracks, per viewer, how many boosters they've opened on the current LOCAL calendar day
        // and how many such days in a row they've hit the configured daily minimum; persisted in
        // the same command-usage.json file as the other usage-tracking sections (see
        // BattleSection/TradeSection for the analogous pattern).
        private void RegisterLoyaltyDraw(string login, string displayName, string boosterId, Dictionary<string, object> settings)
        {
            Dictionary<string, object> loyaltyCfg = Obj(settings, "loyaltyBonus");
            if (!GetBool(loyaltyCfg, "enabled", false)) return;
            int cardsPerDay = Math.Max(1, GetInt(loyaltyCfg, "cardsPerDay", 10));
            List<Dictionary<string, object>> tiers = GetLoyaltyTiers(loyaltyCfg);
            if (tiers.Count == 0) return;

            DateTime localToday = DateTime.UtcNow.ToLocalTime().Date;
            string today = localToday.ToString("yyyy-MM-dd");
            string yesterday = localToday.AddDays(-1).ToString("yyyy-MM-dd");

            int streakDays = 0;
            List<Dictionary<string, object>> grantedTiers = null;

            lock (loyaltyLock)
            {
                EnsureUsageLoaded();
                Dictionary<string, object> section;
                object sectionObj;
                if (usageData.TryGetValue("loyalty", out sectionObj) && sectionObj is Dictionary<string, object>)
                {
                    section = (Dictionary<string, object>)sectionObj;
                }
                else
                {
                    section = new Dictionary<string, object> { { "users", new Dictionary<string, object>() } };
                    usageData["loyalty"] = section;
                }
                Dictionary<string, object> users = section["users"] as Dictionary<string, object>;
                if (users == null) { users = new Dictionary<string, object>(); section["users"] = users; }
                string key = login.Trim().ToLowerInvariant();
                Dictionary<string, object> entry;
                if (users.ContainsKey(key) && users[key] is Dictionary<string, object>)
                {
                    entry = (Dictionary<string, object>)users[key];
                }
                else
                {
                    entry = new Dictionary<string, object> { { "date", "" }, { "countToday", 0 }, { "streakDays", 0 }, { "lastCompletedDate", "" } };
                    users[key] = entry;
                }
                entry["displayName"] = displayName;

                if (GetString(entry, "date", "") != today)
                {
                    entry["date"] = today;
                    entry["countToday"] = 0;
                }
                int countToday = GetInt(entry, "countToday", 0) + 1;
                entry["countToday"] = countToday;

                string lastCompletedDate = GetString(entry, "lastCompletedDate", "");
                if (countToday >= cardsPerDay && lastCompletedDate != today)
                {
                    streakDays = lastCompletedDate == yesterday ? GetInt(entry, "streakDays", 0) + 1 : 1;
                    entry["streakDays"] = streakDays;
                    entry["lastCompletedDate"] = today;

                    grantedTiers = new List<Dictionary<string, object>>();
                    foreach (Dictionary<string, object> tier in tiers)
                    {
                        if (streakDays % GetInt(tier, "days", 0) == 0) grantedTiers.Add(tier);
                    }
                    if (grantedTiers.Count == 0) grantedTiers = null;
                }

                SaveUsage();
            }

            if (grantedTiers == null) return;

            int totalBonusCards = 0;
            var tierPayload = new List<object>();
            foreach (Dictionary<string, object> tier in grantedTiers)
            {
                int bonusCards = GetInt(tier, "bonusCards", 1);
                totalBonusCards += bonusCards;
                tierPayload.Add(new Dictionary<string, object> { { "bonusCards", bonusCards }, { "minRarity", GetString(tier, "minRarity", "rare") } });
            }

            server.Log("draw", "info", displayName + " hat den Treue-Bonus fuer " + streakDays + " Tage in Folge erreicht (" + totalBonusCards + " Bonus-Ziehung(en)).");

            Enqueue("loyaltybonusreached", login, displayName, "system", new Dictionary<string, object>
            {
                { "boosterId", boosterId },
                { "streakDays", streakDays },
                { "bonusCards", totalBonusCards },
                { "tiers", tierPayload.ToArray() }
            });
        }

// Exposes current progress (plus every stage's target/reached state) for the admin panel
        // and the OBS overlay's initial load.
        public Dictionary<string, object> GetCommunityGoalState()
        {
            lock (communityGoalLock)
            {
                EnsureCommunityGoalLoaded();
                Dictionary<string, object> settings = server.ReadSettingsObject();
                Dictionary<string, object> goalCfg = Obj(settings, "communityGoal");
                List<Dictionary<string, object>> stages = GetGoalStages(goalCfg);
                int reachedCount = GetInt(communityGoalState, "reachedCount", 0);
                var stageList = new List<object>();
                for (int i = 0; i < stages.Count; i++)
                {
                    stageList.Add(new Dictionary<string, object>
                    {
                        { "target", GetInt(stages[i], "target", 0) },
                        { "bonusCards", GetInt(stages[i], "bonusCards", 1) },
                        { "reached", i < reachedCount }
                    });
                }
                return new Dictionary<string, object>
                {
                    { "current", GetInt(communityGoalState, "current", 0) },
                    { "stages", stageList.ToArray() },
                    { "reachedCount", reachedCount },
                    { "reached", GetBool(communityGoalState, "reached", false) }
                };
            }
        }

// Manual admin reset - starts a fresh run at 0/first-stage, clearing participants so a
        // past run's contributors don't silently carry over into the next one's bonus payout.
        public void ResetCommunityGoal()
        {
            List<Dictionary<string, object>> stages;
            lock (communityGoalLock)
            {
                communityGoalState = new Dictionary<string, object> { { "current", 0 }, { "reached", false }, { "reachedCount", 0 }, { "participants", new Dictionary<string, object>() } };
                SaveCommunityGoalState();
                stages = GetGoalStages(Obj(server.ReadSettingsObject(), "communityGoal"));
            }
            int firstTarget = stages.Count > 0 ? GetInt(stages[0], "target", 0) : 0;
            server.Broadcast("communitygoalprogress", server.Serializer.Serialize(new Dictionary<string, object>
            {
                { "current", 0 }, { "target", firstTarget }, { "reached", false }, { "stageNumber", 0 }, { "stageCount", stages.Count }
            }));
        }
    }
}
