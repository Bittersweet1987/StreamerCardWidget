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
    public sealed partial class CardPackServer
    {
private string BattleStatsPath()
        {
            return Path.Combine(dataDir, "battle-stats.json");
        }

// Permanently records one finished duel. Deliberately separate from the usage counters in
        // command-usage.json: those exist only for cooldown/limit enforcement and reset periodically,
        // while ranking statistics must accumulate forever.
        internal void RecordBattleResult(string winnerLogin, string winnerDisplay, string loserLogin, string loserDisplay)
        {
            lock (battleStatsLock)
            {
                Dictionary<string, object> stats = ParseObject(ReadFile(BattleStatsPath(), "{}"));
                object usersObj;
                Dictionary<string, object> users;
                if (stats.TryGetValue("users", out usersObj) && usersObj is Dictionary<string, object>) users = (Dictionary<string, object>)usersObj;
                else { users = new Dictionary<string, object>(); stats["users"] = users; }
                BumpBattleStat(users, winnerLogin, winnerDisplay, true);
                BumpBattleStat(users, loserLogin, loserDisplay, false);
                File.WriteAllText(BattleStatsPath(), json.Serialize(stats), Encoding.UTF8);
            }
        }

private static void BumpBattleStat(Dictionary<string, object> users, string login, string display, bool won)
        {
            string key = NormalizeUser(login).ToLowerInvariant();
            object o;
            Dictionary<string, object> entry;
            if (users.TryGetValue(key, out o) && o is Dictionary<string, object>) entry = (Dictionary<string, object>)o;
            else { entry = new Dictionary<string, object>(); users[key] = entry; }
            if (!String.IsNullOrWhiteSpace(display)) entry["displayName"] = display;
            entry["fights"] = GetIntStat(entry, "fights") + 1;
            if (won) entry["wins"] = GetIntStat(entry, "wins") + 1;
            else entry["losses"] = GetIntStat(entry, "losses") + 1;
        }

private static int GetIntStat(Dictionary<string, object> entry, string key)
        {
            object o;
            int v;
            if (entry.TryGetValue(key, out o) && Int32.TryParse(Convert.ToString(o), out v)) return v;
            return 0;
        }

private string LiveTickerHistoryPath()
        {
            return Path.Combine(dataDir, "liveticker-history.json");
        }

internal void SaveLiveTickerHistory(object[] entries)
        {
            lock (liveTickerHistoryFileLock)
            {
                try { File.WriteAllText(LiveTickerHistoryPath(), json.Serialize(entries), Encoding.UTF8); }
                catch { }
            }
        }

internal List<Dictionary<string, object>> LoadLiveTickerHistory()
        {
            lock (liveTickerHistoryFileLock)
            {
                var result = new List<Dictionary<string, object>>();
                try
                {
                    object parsed = json.DeserializeObject(ReadFile(LiveTickerHistoryPath(), "[]"));
                    object[] arr = parsed as object[];
                    if (arr != null)
                    {
                        foreach (object o in arr)
                        {
                            Dictionary<string, object> d = o as Dictionary<string, object>;
                            if (d != null) result.Add(d);
                        }
                    }
                }
                catch { }
                return result;
            }
        }

private string TradeStatsPath()
        {
            return Path.Combine(dataDir, "trade-stats.json");
        }

// Permanently records one completed trade for both participants, for "!ranking tausch".
        // Separate from command-usage.json (which only tracks the resettable cooldown quota).
        internal void RecordTradeCompleted(string loginA, string displayA, string loginB, string displayB)
        {
            lock (battleStatsLock)
            {
                Dictionary<string, object> stats = ParseObject(ReadFile(TradeStatsPath(), "{}"));
                object usersObj;
                Dictionary<string, object> users;
                if (stats.TryGetValue("users", out usersObj) && usersObj is Dictionary<string, object>) users = (Dictionary<string, object>)usersObj;
                else { users = new Dictionary<string, object>(); stats["users"] = users; }
                BumpTradeStat(users, loginA, displayA);
                BumpTradeStat(users, loginB, displayB);
                File.WriteAllText(TradeStatsPath(), json.Serialize(stats), Encoding.UTF8);
            }
        }

private static void BumpTradeStat(Dictionary<string, object> users, string login, string display)
        {
            string key = NormalizeUser(login).ToLowerInvariant();
            object o;
            Dictionary<string, object> entry;
            if (users.TryGetValue(key, out o) && o is Dictionary<string, object>) entry = (Dictionary<string, object>)o;
            else { entry = new Dictionary<string, object>(); users[key] = entry; }
            if (!String.IsNullOrWhiteSpace(display)) entry["displayName"] = display;
            entry["trades"] = GetIntStat(entry, "trades") + 1;
        }

// Permanently records one tournament win. Separate file from battle-stats.json - a
        // tournament win is a distinct achievement from individual duel wins/losses within it.
        internal void RecordTournamentWin(string winnerLogin, string winnerDisplay)
        {
            lock (battleStatsLock)
            {
                Dictionary<string, object> stats = ParseObject(ReadFile(TournamentStatsPath(), "{}"));
                object usersObj;
                Dictionary<string, object> users;
                if (stats.TryGetValue("users", out usersObj) && usersObj is Dictionary<string, object>) users = (Dictionary<string, object>)usersObj;
                else { users = new Dictionary<string, object>(); stats["users"] = users; }
                string key = NormalizeUser(winnerLogin).ToLowerInvariant();
                object o;
                Dictionary<string, object> entry;
                if (users.TryGetValue(key, out o) && o is Dictionary<string, object>) entry = (Dictionary<string, object>)o;
                else { entry = new Dictionary<string, object>(); users[key] = entry; }
                if (!String.IsNullOrWhiteSpace(winnerDisplay)) entry["displayName"] = winnerDisplay;
                entry["wins"] = GetIntStat(entry, "wins") + 1;
                File.WriteAllText(TournamentStatsPath(), json.Serialize(stats), Encoding.UTF8);
            }
        }

// Permanently records one tournament participation (every bracket entrant, win or lose) -
        // called once per participant when a signup window closes and the bracket starts running.
        internal void RecordTournamentParticipation(string login, string displayName)
        {
            lock (battleStatsLock)
            {
                Dictionary<string, object> stats = ParseObject(ReadFile(TournamentStatsPath(), "{}"));
                object usersObj;
                Dictionary<string, object> users;
                if (stats.TryGetValue("users", out usersObj) && usersObj is Dictionary<string, object>) users = (Dictionary<string, object>)usersObj;
                else { users = new Dictionary<string, object>(); stats["users"] = users; }
                string key = NormalizeUser(login).ToLowerInvariant();
                object o;
                Dictionary<string, object> entry;
                if (users.TryGetValue(key, out o) && o is Dictionary<string, object>) entry = (Dictionary<string, object>)o;
                else { entry = new Dictionary<string, object>(); users[key] = entry; }
                if (!String.IsNullOrWhiteSpace(displayName)) entry["displayName"] = displayName;
                entry["participations"] = GetIntStat(entry, "participations") + 1;
                File.WriteAllText(TournamentStatsPath(), json.Serialize(stats), Encoding.UTF8);
            }
        }

private string TournamentStatsPath()
        {
            return Path.Combine(dataDir, "tournament-stats.json");
        }

// Top N users by tournament wins AND by tournament participations, for "!ranking turnier"
        // (mirrors the multi-list shape of BuildBattleRanking).
        internal Dictionary<string, object> BuildTournamentRanking(int limit)
        {
            var entries = new List<Dictionary<string, object>>();
            lock (battleStatsLock)
            {
                Dictionary<string, object> stats = ParseObject(ReadFile(TournamentStatsPath(), "{}"));
                object usersObj;
                if (stats.TryGetValue("users", out usersObj) && usersObj is Dictionary<string, object>)
                {
                    foreach (KeyValuePair<string, object> kv in (Dictionary<string, object>)usersObj)
                    {
                        Dictionary<string, object> e = kv.Value as Dictionary<string, object>;
                        if (e == null) continue;
                        int wins = GetIntStat(e, "wins");
                        int participations = GetIntStat(e, "participations");
                        if (wins < 1 && participations < 1) continue;
                        entries.Add(new Dictionary<string, object>
                        {
                            { "user", GetString(e, "displayName", kv.Key) },
                            { "wins", wins }, { "participations", participations }
                        });
                    }
                }
            }
            return new Dictionary<string, object>
            {
                { "wins", TopByField(entries, "wins", limit) },
                { "participations", TopByField(entries, "participations", limit) }
            };
        }

// ---- Team-Kampf (Community vs. streamer) statistics - separate file from
        // battle-stats.json/tournament-stats.json, a Team-Kampf outcome is its own kind of
        // achievement (won/lost together with the whole community, not a 1v1 duel or bracket). ----

        private string TeamKampfStatsPath()
        {
            return Path.Combine(dataDir, "teamkampf-stats.json");
        }

// Called once per participant when a Team-Kampf signup window closes and the fight
        // actually happens (mirrors RecordTournamentParticipation).
        internal void RecordTeamKampfParticipation(string login, string displayName)
        {
            lock (battleStatsLock)
            {
                Dictionary<string, object> stats = ParseObject(ReadFile(TeamKampfStatsPath(), "{}"));
                object usersObj;
                Dictionary<string, object> users;
                if (stats.TryGetValue("users", out usersObj) && usersObj is Dictionary<string, object>) users = (Dictionary<string, object>)usersObj;
                else { users = new Dictionary<string, object>(); stats["users"] = users; }
                string key = NormalizeUser(login).ToLowerInvariant();
                object o;
                Dictionary<string, object> entry;
                if (users.TryGetValue(key, out o) && o is Dictionary<string, object>) entry = (Dictionary<string, object>)o;
                else { entry = new Dictionary<string, object>(); users[key] = entry; }
                if (!String.IsNullOrWhiteSpace(displayName)) entry["displayName"] = displayName;
                entry["participations"] = GetIntStat(entry, "participations") + 1;
                File.WriteAllText(TeamKampfStatsPath(), json.Serialize(stats), Encoding.UTF8);
            }
        }

// Called once per participant once the fight resolves, crediting a win or a loss
        // depending on whether the community won as a whole.
        internal void RecordTeamKampfResult(string login, string displayName, bool won)
        {
            lock (battleStatsLock)
            {
                Dictionary<string, object> stats = ParseObject(ReadFile(TeamKampfStatsPath(), "{}"));
                object usersObj;
                Dictionary<string, object> users;
                if (stats.TryGetValue("users", out usersObj) && usersObj is Dictionary<string, object>) users = (Dictionary<string, object>)usersObj;
                else { users = new Dictionary<string, object>(); stats["users"] = users; }
                string key = NormalizeUser(login).ToLowerInvariant();
                object o;
                Dictionary<string, object> entry;
                if (users.TryGetValue(key, out o) && o is Dictionary<string, object>) entry = (Dictionary<string, object>)o;
                else { entry = new Dictionary<string, object>(); users[key] = entry; }
                if (!String.IsNullOrWhiteSpace(displayName)) entry["displayName"] = displayName;
                if (won) entry["wins"] = GetIntStat(entry, "wins") + 1;
                else entry["losses"] = GetIntStat(entry, "losses") + 1;
                File.WriteAllText(TeamKampfStatsPath(), json.Serialize(stats), Encoding.UTF8);
            }
        }

// Runtime difficulty rubber-banding: a persistent, never-reset adjustment to the
        // streamer team's lineup size, stored as a top-level "difficultyAdjustment" field in
        // teamkampf-stats.json (a sibling of "users", not a per-user stat - this is about the
        // fight itself, not any one viewer). Every community win grows it by "step", every loss
        // shrinks it by "step" - unlike the old loss-streak version, a win no longer resets it
        // back to zero, so a long win streak keeps making the next fight harder and a long losing
        // streak keeps making it easier. StartTeamBattleSignup clamps the resulting lineup size to
        // at least 1 card - the fight must always have an opponent.
        internal void RecordTeamKampfDifficultyResult(bool communityWon, int step)
        {
            lock (battleStatsLock)
            {
                Dictionary<string, object> stats = ParseObject(ReadFile(TeamKampfStatsPath(), "{}"));
                stats["difficultyAdjustment"] = GetIntStat(stats, "difficultyAdjustment") + (communityWon ? step : -step);
                File.WriteAllText(TeamKampfStatsPath(), json.Serialize(stats), Encoding.UTF8);
            }
        }

internal int GetTeamKampfDifficultyAdjustment()
        {
            lock (battleStatsLock)
            {
                return GetIntStat(ParseObject(ReadFile(TeamKampfStatsPath(), "{}")), "difficultyAdjustment");
            }
        }

// Top N users by Team-Kampf wins, losses AND participations, for "!ranking teamkampf".
        internal Dictionary<string, object> BuildTeamKampfRanking(int limit)
        {
            var entries = new List<Dictionary<string, object>>();
            lock (battleStatsLock)
            {
                Dictionary<string, object> stats = ParseObject(ReadFile(TeamKampfStatsPath(), "{}"));
                object usersObj;
                if (stats.TryGetValue("users", out usersObj) && usersObj is Dictionary<string, object>)
                {
                    foreach (KeyValuePair<string, object> kv in (Dictionary<string, object>)usersObj)
                    {
                        Dictionary<string, object> e = kv.Value as Dictionary<string, object>;
                        if (e == null) continue;
                        int wins = GetIntStat(e, "wins");
                        int losses = GetIntStat(e, "losses");
                        int participations = GetIntStat(e, "participations");
                        if (wins < 1 && losses < 1 && participations < 1) continue;
                        entries.Add(new Dictionary<string, object>
                        {
                            { "user", GetString(e, "displayName", kv.Key) },
                            { "wins", wins }, { "losses", losses }, { "participations", participations }
                        });
                    }
                }
            }
            return new Dictionary<string, object>
            {
                { "participations", TopByField(entries, "participations", limit) },
                { "wins", TopByField(entries, "wins", limit) },
                { "losses", TopByField(entries, "losses", limit) }
            };
        }

// Combined per-user stats snapshot for the admin User tab: battle fights/wins/losses,
        // tournament wins/participations, Team-Kampf participations/wins/losses (bits are read
        // separately via TwitchBridge.GetBitsState, they live in command-usage.json not here).
        // Best-effort - any single stats file failing to parse just leaves that part of the
        // result empty rather than failing the whole overview. Source field names are prefixed
        // per category (battleWins vs. tournamentWins vs. teamkampfWins) so merging three files
        // into one flat per-user dictionary can never have one category silently overwrite another.
        internal Dictionary<string, object> GetUserStatsOverview()
        {
            var result = new Dictionary<string, object>();
            Action<string, string, string[]> merge = delegate(string path, string prefix, string[] fields)
            {
                try
                {
                    Dictionary<string, object> stats = ParseObject(ReadFile(path, "{}"));
                    object usersObj;
                    if (!stats.TryGetValue("users", out usersObj) || !(usersObj is Dictionary<string, object>)) return;
                    foreach (KeyValuePair<string, object> kv in (Dictionary<string, object>)usersObj)
                    {
                        Dictionary<string, object> e = kv.Value as Dictionary<string, object>;
                        if (e == null) continue;
                        Dictionary<string, object> outEntry;
                        object existing;
                        if (result.TryGetValue(kv.Key, out existing) && existing is Dictionary<string, object>) outEntry = (Dictionary<string, object>)existing;
                        else { outEntry = new Dictionary<string, object>(); result[kv.Key] = outEntry; }
                        if (!outEntry.ContainsKey("displayName")) outEntry["displayName"] = GetString(e, "displayName", kv.Key);
                        foreach (string field in fields)
                        {
                            string camelField = field.Length > 0 ? Char.ToUpperInvariant(field[0]) + field.Substring(1) : field;
                            outEntry[prefix + camelField] = GetIntStat(e, field);
                        }
                    }
                }
                catch { }
            };
            lock (battleStatsLock)
            {
                merge(BattleStatsPath(), "battle", new[] { "fights", "wins", "losses" });
                merge(TournamentStatsPath(), "tournament", new[] { "wins", "participations" });
                merge(TeamKampfStatsPath(), "teamkampf", new[] { "wins", "losses", "participations" });
            }
            return result;
        }

// Top N users by completed trade count, for "!ranking tausch".
        internal object[] BuildTradeRanking(int limit)
        {
            var entries = new List<Dictionary<string, object>>();
            lock (battleStatsLock)
            {
                Dictionary<string, object> stats = ParseObject(ReadFile(TradeStatsPath(), "{}"));
                object usersObj;
                if (stats.TryGetValue("users", out usersObj) && usersObj is Dictionary<string, object>)
                {
                    foreach (KeyValuePair<string, object> kv in (Dictionary<string, object>)usersObj)
                    {
                        Dictionary<string, object> e = kv.Value as Dictionary<string, object>;
                        if (e == null) continue;
                        int trades = GetIntStat(e, "trades");
                        if (trades < 1) continue;
                        entries.Add(new Dictionary<string, object> { { "user", GetString(e, "displayName", kv.Key) }, { "trades", trades } });
                    }
                }
            }
            return TopByField(entries, "trades", limit);
        }

// Builds the four ranked top lists for "!ranking battle": most fights, most wins, most
        // losses and best win/loss ratio (wins / max(1, losses), so an undefeated player ranks).
        internal Dictionary<string, object> BuildBattleRanking(int limit)
        {
            var entries = new List<Dictionary<string, object>>();
            lock (battleStatsLock)
            {
                Dictionary<string, object> stats = ParseObject(ReadFile(BattleStatsPath(), "{}"));
                object usersObj;
                if (stats.TryGetValue("users", out usersObj) && usersObj is Dictionary<string, object>)
                {
                    foreach (KeyValuePair<string, object> kv in (Dictionary<string, object>)usersObj)
                    {
                        Dictionary<string, object> e = kv.Value as Dictionary<string, object>;
                        if (e == null) continue;
                        int fights = GetIntStat(e, "fights");
                        if (fights < 1) continue;
                        int wins = GetIntStat(e, "wins");
                        int losses = GetIntStat(e, "losses");
                        entries.Add(new Dictionary<string, object>
                        {
                            { "user", GetString(e, "displayName", kv.Key) },
                            { "fights", fights }, { "wins", wins }, { "losses", losses },
                            { "ratio", Math.Round(wins / (double)Math.Max(1, losses), 2) }
                        });
                    }
                }
            }
            return new Dictionary<string, object>
            {
                { "fights", TopByField(entries, "fights", limit) },
                { "wins", TopByField(entries, "wins", limit) },
                { "losses", TopByField(entries, "losses", limit) },
                { "ratio", TopByField(entries, "ratio", limit) }
            };
        }
    }
}
