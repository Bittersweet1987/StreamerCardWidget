using System;
using System.Collections.Generic;
using System.IO;

namespace CardPackWidgetApp
{
    internal static class SelfTests
    {
        private static int passed;
        private static int failed;

        private static void Check(string label, bool condition)
        {
            if (condition)
            {
                passed++;
            }
            else
            {
                failed++;
                Console.WriteLine("FAIL: " + label);
            }
        }

        internal static int RunAll()
        {
            passed = 0;
            failed = 0;

            // CardPackServer.GetRarityRank / KnownRarityId (Server.Collections.cs)
            Check("GetRarityRank(common)==0", CardPackServer.GetRarityRank("common") == 0);
            Check("GetRarityRank(holo)==5", CardPackServer.GetRarityRank("holo") == 5);
            Check("GetRarityRank(unknown)==0 (falls back to common)", CardPackServer.GetRarityRank("unknown") == 0);
            Check("KnownRarityId(rare)==true", CardPackServer.KnownRarityId("rare") == true);
            Check("KnownRarityId(bogus)==false", CardPackServer.KnownRarityId("bogus") == false);

            // CardPackServer.LevenshteinDistance / TitleSimilarity (Server.Collections.cs)
            Check("Levenshtein(kitten,sitting)==3", CardPackServer.LevenshteinDistance("kitten", "sitting") == 3);
            Check("Levenshtein(same,same)==0", CardPackServer.LevenshteinDistance("same", "same") == 0);
            Check("TitleSimilarity(exact)==1", Math.Abs(CardPackServer.TitleSimilarity("Feuerdrache", "Feuerdrache") - 1.0) < 0.0001);
            Check("TitleSimilarity(different)<1", CardPackServer.TitleSimilarity("Feuerdrache", "Wasserelfe") < 1.0);

            // TwitchBridge.NormalizeRarityId (Bridge.Queue.cs)
            Check("NormalizeRarityId(common)==common", TwitchBridge.NormalizeRarityId("common") == "common");
            Check("NormalizeRarityId(selten)==rare", TwitchBridge.NormalizeRarityId("selten") == "rare");
            Check("NormalizeRarityId(legendaer)==legendary", TwitchBridge.NormalizeRarityId("legendaer") == "legendary");
            Check("NormalizeRarityId(unknown)==common (fallback)", TwitchBridge.NormalizeRarityId("totally-unknown") == "common");

            // TwitchBridge.RarityWeight (Bridge.Queue.cs)
            Dictionary<string, object> commonCard = new Dictionary<string, object> { { "rarity", "common" } };
            Dictionary<string, object> holoCard = new Dictionary<string, object> { { "rarity", "holo" } };
            Check("RarityWeight(common) > RarityWeight(holo)", TwitchBridge.RarityWeight(commonCard, null) > TwitchBridge.RarityWeight(holoCard, null));
            Dictionary<string, object> overrideWeights = new Dictionary<string, object> { { "common", 5.0 } };
            Check("RarityWeight honors override", Math.Abs(TwitchBridge.RarityWeight(commonCard, overrideWeights) - 5.0) < 0.0001);

            // TwitchBridge.MatchesCommand (Bridge.ChatCore.cs)
            Dictionary<string, object> packsCmd = new Dictionary<string, object> { { "prefix", "!" }, { "command", "pack" } };
            Check("MatchesCommand('!pack')==true", TwitchBridge.MatchesCommand("!pack", packsCmd) == true);
            Check("MatchesCommand('!pack foo')==true", TwitchBridge.MatchesCommand("!pack foo", packsCmd) == true);
            Check("MatchesCommand('!packs') doesn't match !pack (word boundary)", TwitchBridge.MatchesCommand("!packs", packsCmd) == false);
            Check("MatchesCommand('!other')==false", TwitchBridge.MatchesCommand("!other", packsCmd) == false);

            // TwitchBridge.IsIrlModeActive / IsModeratorOrBroadcaster (Bridge.Connection.cs)
            Check("IsIrlModeActive(missing)==false", TwitchBridge.IsIrlModeActive(new Dictionary<string, object>()) == false);
            Dictionary<string, object> irlOnSettings = new Dictionary<string, object> { { "irlMode", new Dictionary<string, object> { { "enabled", true } } } };
            Check("IsIrlModeActive(enabled)==true", TwitchBridge.IsIrlModeActive(irlOnSettings) == true);
            Dictionary<string, object> modEvent = new Dictionary<string, object> { { "badges", new object[] { new Dictionary<string, object> { { "set_id", "moderator" } } } } };
            Check("IsModeratorOrBroadcaster(moderator badge)==true", TwitchBridge.IsModeratorOrBroadcaster(modEvent) == true);
            Dictionary<string, object> viewerEvent = new Dictionary<string, object> { { "badges", new object[] { new Dictionary<string, object> { { "set_id", "subscriber" } } } } };
            Check("IsModeratorOrBroadcaster(subscriber badge)==false", TwitchBridge.IsModeratorOrBroadcaster(viewerEvent) == false);

            // TwitchBridge.ComputeNextResetAt (Bridge.PackCommands.cs)
            DateTime nowUtc = new DateTime(2026, 7, 27, 10, 0, 0, DateTimeKind.Utc);
            Dictionary<string, object> hoursCfg = new Dictionary<string, object> { { "resetUnit", "hours" }, { "resetValue", 24 } };
            Check("ComputeNextResetAt(hours) adds 24h", CardPackServer_ComputeNextResetAtHours(nowUtc, hoursCfg));
            Dictionary<string, object> minutesCfg = new Dictionary<string, object> { { "resetUnit", "minutes" }, { "resetValue", 30 } };
            DateTime plus30 = TwitchBridge.ComputeNextResetAt(minutesCfg, nowUtc);
            Check("ComputeNextResetAt(minutes) adds 30m", plus30 == nowUtc.AddMinutes(30));

            // TwitchBridge.ParseDustSetRarity (Bridge.PackCommands.cs)
            Check("ParseDustSetRarity(common)==common", TwitchBridge.ParseDustSetRarity("common") == "common");
            Check("ParseDustSetRarity(empty)==null", TwitchBridge.ParseDustSetRarity("") == null);
            Check("ParseDustSetRarity(garbage)==null", TwitchBridge.ParseDustSetRarity("xyzzy-not-a-rarity") == null);

            // TwitchBridge.ComputePityProgress (Bridge.PackCommands.cs)
            int readyGuarantees, drawsUntilNext;
            TwitchBridge.ComputePityProgress(streak: 7, bank: 0, threshold: 10, readyGuarantees: out readyGuarantees, drawsUntilNext: out drawsUntilNext);
            Check("ComputePityProgress(7,0,10) readyGuarantees==0", readyGuarantees == 0);
            Check("ComputePityProgress(7,0,10) drawsUntilNext==3", drawsUntilNext == 3);
            TwitchBridge.ComputePityProgress(streak: 10, bank: 0, threshold: 10, readyGuarantees: out readyGuarantees, drawsUntilNext: out drawsUntilNext);
            Check("ComputePityProgress(10,0,10) readyGuarantees==1", readyGuarantees == 1);
            Check("ComputePityProgress(10,0,10) drawsUntilNext==10", drawsUntilNext == 10);

            // TwitchBridge.RollDamage (Bridge.Battle.cs) - equal/same-rarity fights used to be fully
            // deterministic (zero variance for the "stronger or equal" side); StrongSideVarianceFactor
            // gives that side a damped-but-real variance instead so same-rarity duels aren't boring.
            try
            {
                string tempRoot = Path.Combine(Path.GetTempPath(), "streamercard-selftest-" + Guid.NewGuid());
                TwitchBridge bridge = new TwitchBridge(new CardPackServer(tempRoot));
                bool sawVarianceAtEqualStrength = false;
                double maxEqualRoll = 0;
                for (int i = 0; i < 200; i++)
                {
                    double roll = bridge.RollDamage(10, 10, 0.6);
                    if (roll > 10.0001) sawVarianceAtEqualStrength = true;
                    if (roll > maxEqualRoll) maxEqualRoll = roll;
                }
                Check("RollDamage(equal strength) now has variance (not always exactly attackerStrength)", sawVarianceAtEqualStrength);
                Check("RollDamage(equal strength) stays damped, well under the full-variance ceiling", maxEqualRoll < 10 * 1.6);
                double weakerRoll = bridge.RollDamage(5, 10, 0.6);
                Check("RollDamage(weaker side) can still reach the FULL variance ceiling", weakerRoll <= 5 * 1.6 + 0.0001);
            }
            catch (Exception ex)
            {
                Check("RollDamage equal-strength variance test ran without throwing: " + ex.Message, false);
            }

            // TwitchBridge.SavePendingState / LoadPendingState (Bridge.Connection.cs) - a pending
            // queue item must survive a "restart" (new TwitchBridge instance reading the same data
            // dir), so app close/update/crash never silently drops a not-yet-fulfilled action.
            try
            {
                string tempRoot = Path.Combine(Path.GetTempPath(), "streamercard-selftest-" + Guid.NewGuid());
                Directory.CreateDirectory(Path.Combine(tempRoot, "data"));
                TwitchBridge bridgeA = new TwitchBridge(new CardPackServer(tempRoot));
                bridgeA.Enqueue("draw", "testuser", "TestUser", "chat");
                object[] beforeRestart = bridgeA.GetQueueItems();
                Check("Enqueue put exactly 1 item in the live queue", beforeRestart.Length == 1);

                // Simulate a restart: a brand-new instance pointed at the same data directory should
                // pick up the item SavePendingState wrote to disk, with nothing else running yet.
                TwitchBridge bridgeB = new TwitchBridge(new CardPackServer(tempRoot));
                bridgeB.LoadPendingState();
                object[] afterRestart = bridgeB.GetQueueItems();
                Check("LoadPendingState restores the queued item after a simulated restart", afterRestart.Length == 1);
                if (afterRestart.Length == 1)
                {
                    Dictionary<string, object> restoredItem = afterRestart[0] as Dictionary<string, object>;
                    Check("Restored item kept its kind (draw)", restoredItem != null && Convert.ToString(restoredItem["kind"]) == "draw");
                    Check("Restored item kept its user (testuser)", restoredItem != null && Convert.ToString(restoredItem["userLogin"]) == "testuser");
                }
            }
            catch (Exception ex)
            {
                Check("Pending-state save/load round-trip ran without throwing: " + ex.Message, false);
            }

            // TwitchBridge.ResolveCardsPerDraw (Bridge.Queue.cs) - "Karten pro Pack": a booster's own
            // override wins over the global default; 0/absent on the booster means "inherit global";
            // both are clamped into [1, MaxCardsPerDraw].
            Dictionary<string, object> settingsNoOverride = new Dictionary<string, object> { { "pack", new Dictionary<string, object> { { "cardsPerDraw", 3 } } } };
            Dictionary<string, object> boosterNoOverride = new Dictionary<string, object> { { "cardsPerDraw", 0 } };
            Check("ResolveCardsPerDraw falls back to the global default when booster override is 0", TwitchBridge.ResolveCardsPerDraw(settingsNoOverride, boosterNoOverride) == 3);
            Dictionary<string, object> boosterWithOverride = new Dictionary<string, object> { { "cardsPerDraw", 5 } };
            Check("ResolveCardsPerDraw prefers the booster's own override over the global default", TwitchBridge.ResolveCardsPerDraw(settingsNoOverride, boosterWithOverride) == 5);
            Check("ResolveCardsPerDraw handles a null booster (falls back to global default)", TwitchBridge.ResolveCardsPerDraw(settingsNoOverride, null) == 3);
            Dictionary<string, object> settingsNoPackSection = new Dictionary<string, object>();
            Check("ResolveCardsPerDraw defaults to 1 when settings.pack is entirely absent", TwitchBridge.ResolveCardsPerDraw(settingsNoPackSection, null) == 1);
            Dictionary<string, object> boosterHugeOverride = new Dictionary<string, object> { { "cardsPerDraw", 999 } };
            Check("ResolveCardsPerDraw clamps an absurd booster override to the sane upper bound", TwitchBridge.ResolveCardsPerDraw(settingsNoOverride, boosterHugeOverride) == 10);

            Console.WriteLine("SELFTEST: " + passed + " passed, " + failed + " failed");
            return failed;
        }

        private static bool CardPackServer_ComputeNextResetAtHours(DateTime nowUtc, Dictionary<string, object> hoursCfg)
        {
            DateTime result = TwitchBridge.ComputeNextResetAt(hoursCfg, nowUtc);
            return result == nowUtc.AddHours(24);
        }
    }
}
