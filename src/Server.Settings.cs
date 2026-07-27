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
private void EnsureDataFiles()
        {
            Directory.CreateDirectory(dataDir);
            if (!Directory.Exists(publicDir))
            {
                throw new DirectoryNotFoundException("Der public-Ordner fehlt.");
            }
            if (!File.Exists(SettingsPath()))
            {
                File.Copy(DefaultSettingsPath(), SettingsPath(), true);
            }
            if (!File.Exists(CollectionsPath()))
            {
                string defaultCollections = Path.Combine(defaultsDir, "collections.json");
                if (File.Exists(defaultCollections)) File.Copy(defaultCollections, CollectionsPath(), true);
                else File.WriteAllText(CollectionsPath(), "{}\n", Encoding.UTF8);
            }
            MigrateTwitchAndObsConfig();
            MigrateCardsAndBoosters();
            MigrateBoosterRewardToDraw();
        }

// Twitch/OBS settings used to live inline inside settings.json. They now live in
        // their own files (twitch.json, obs.json) so that app updates - which only ever
        // replace public/+the exe, never data/ - can never clobber a connected account, and
        // so settings.json resets/imports can't accidentally wipe credentials either.
        private void MigrateTwitchAndObsConfig()
        {
            if (!File.Exists(SettingsPath())) return;
            Dictionary<string, object> settings = ParseObject(ReadFile(SettingsPath(), "{}"));
            bool changed = false;

            if (!File.Exists(TwitchConfigPath()) && settings.ContainsKey("twitch") && settings["twitch"] is Dictionary<string, object>)
            {
                File.WriteAllText(TwitchConfigPath(), json.Serialize(settings["twitch"]), Encoding.UTF8);
            }
            if (settings.Remove("twitch")) changed = true;

            if (!File.Exists(ObsConfigPath()) && settings.ContainsKey("obs") && settings["obs"] is Dictionary<string, object>)
            {
                File.WriteAllText(ObsConfigPath(), json.Serialize(settings["obs"]), Encoding.UTF8);
            }
            if (settings.Remove("obs")) changed = true;

            if (changed) File.WriteAllText(SettingsPath(), json.Serialize(settings), Encoding.UTF8);
        }

// Bot-account credentials for Twitch Chat live in their own file (same rationale as
        // twitch.json/obs.json): app updates only ever replace public/+the exe, never data/, so
        // the bot connection survives updates/resets.
        private string TwitchBotConfigPath()
        {
            return Path.Combine(dataDir, "twitch-bot.json");
        }

internal string CommandUsagePath()
        {
            return Path.Combine(dataDir, "command-usage.json");
        }

internal string PityStatePath()
        {
            return Path.Combine(dataDir, "pity.json");
        }

internal string CommunityGoalStatePath()
        {
            return Path.Combine(dataDir, "community-goal.json");
        }

internal string ReadFileText(string path, string fallback)
        {
            return ReadFile(path, fallback);
        }

// Boosters and cards used to live inline in settings.json. They now live in their own
        // files so that app updates and newly added rarities can never overwrite content the
        // user has already created (only public/+exe are replaced on update, never data/).
        private void MigrateCardsAndBoosters()
        {
            if (!File.Exists(SettingsPath())) return;
            Dictionary<string, object> settings = ParseObject(ReadFile(SettingsPath(), "{}"));
            bool changed = false;

            // Inline data in settings.json is the authoritative source during migration: if it is
            // still present, write it out (overwriting any stale/empty external file) and only then
            // strip it from settings.json. Once migrated, settings.json has no inline copy, so the
            // existing external file (the user's live data) is left untouched.
            if (settings.ContainsKey("boosters") && settings["boosters"] is object[])
            {
                File.WriteAllText(BoostersPath(), json.Serialize(settings["boosters"]), Encoding.UTF8);
                settings.Remove("boosters");
                changed = true;
            }

            if (settings.ContainsKey("deck") && settings["deck"] is Dictionary<string, object>)
            {
                Dictionary<string, object> deck = (Dictionary<string, object>)settings["deck"];
                if (deck.ContainsKey("cards") && deck["cards"] is object[])
                {
                    File.WriteAllText(CardsPath(), json.Serialize(deck["cards"]), Encoding.UTF8);
                    deck.Remove("cards");
                    changed = true;
                }
            }

            if (changed)
            {
                File.WriteAllText(SettingsPath(), json.Serialize(settings), Encoding.UTF8);
                InvalidateCardRarityCache();
            }
        }

// The "open a pack" reward used to be stored per-booster (each booster could carry its
        // own Twitch reward). Since PickRandomBoosterId() always draws from ALL eligible
        // boosters regardless of which reward triggered it, a reward scoped to one booster
        // never actually scoped the draw to it - so whichever reward was already linked is
        // carried forward into a single global settings.draw, and the now-unused fields are
        // stripped from boosters.json.
        private void MigrateBoosterRewardToDraw()
        {
            if (!File.Exists(SettingsPath())) return;
            Dictionary<string, object> settings = ParseObject(ReadFile(SettingsPath(), "{}"));
            if (settings.ContainsKey("draw")) return;
            if (!File.Exists(BoostersPath())) return;
            object[] boosters = ParseArray(ReadFile(BoostersPath(), "[]"));
            if (boosters.Length == 0) return;

            Dictionary<string, object> source = null;
            foreach (object item in boosters)
            {
                Dictionary<string, object> booster = item as Dictionary<string, object>;
                if (booster == null) continue;
                if (booster.ContainsKey("rewardIds") && booster["rewardIds"] is object[] && ((object[])booster["rewardIds"]).Length > 0)
                {
                    source = booster;
                    break;
                }
            }

            var draw = new Dictionary<string, object>();
            if (source != null)
            {
                draw["rewardIds"] = source["rewardIds"];
                string name = GetString(source, "title", "Kartenpack");
                if (source.ContainsKey("rewardNames") && source["rewardNames"] is object[] && ((object[])source["rewardNames"]).Length > 0)
                {
                    name = Convert.ToString(((object[])source["rewardNames"])[0]);
                }
                draw["rewardName"] = name;
                foreach (string key in new[] { "rewardCost", "rewardPrompt", "rewardBackgroundColor", "rewardEnabled", "rewardPaused", "rewardMaxPerStream", "rewardMaxPerUserPerStream", "rewardGlobalCooldown" })
                {
                    if (source.ContainsKey(key)) draw[key] = source[key];
                }
            }
            settings["draw"] = draw;
            File.WriteAllText(SettingsPath(), json.Serialize(settings), Encoding.UTF8);

            bool boostersChanged = false;
            foreach (object item in boosters)
            {
                Dictionary<string, object> booster = item as Dictionary<string, object>;
                if (booster == null) continue;
                foreach (string key in new[] { "rewardIds", "rewardNames", "rewardCost", "rewardPrompt", "rewardBackgroundColor", "rewardGlobalCooldown", "rewardMaxPerStream", "rewardMaxPerUserPerStream", "rewardEnabled", "rewardPaused" })
                {
                    if (booster.Remove(key)) boostersChanged = true;
                }
            }
            if (boostersChanged) File.WriteAllText(BoostersPath(), json.Serialize(boosters), Encoding.UTF8);
        }

private Dictionary<string, object> ParseObject(string text)
        {
            if (String.IsNullOrWhiteSpace(text)) return new Dictionary<string, object>();
            try
            {
                object parsed = json.DeserializeObject(text);
                if (parsed is Dictionary<string, object>) return (Dictionary<string, object>)parsed;
            }
            catch
            {
            }
            return new Dictionary<string, object>();
        }

private object[] ParseArray(string text)
        {
            if (String.IsNullOrWhiteSpace(text)) return new object[0];
            try
            {
                object parsed = json.DeserializeObject(text);
                if (parsed is object[]) return (object[])parsed;
            }
            catch
            {
            }
            return new object[0];
        }

private object[] ReadArrayCached(string path)
        {
            string stamp;
            try
            {
                FileInfo info = new FileInfo(path);
                stamp = info.Exists ? info.LastWriteTimeUtc.Ticks.ToString() + ":" + info.Length.ToString() : "missing";
            }
            catch { stamp = "error"; }
            lock (parseCacheLock)
            {
                string cachedStamp;
                object[] cached;
                if (parsedArrayCacheStamp.TryGetValue(path, out cachedStamp) && cachedStamp == stamp
                    && parsedArrayCache.TryGetValue(path, out cached))
                {
                    return cached;
                }
            }
            object[] parsed = ParseArray(ReadFile(path, "[]"));
            lock (parseCacheLock)
            {
                parsedArrayCache[path] = parsed;
                parsedArrayCacheStamp[path] = stamp;
            }
            return parsed;
        }

private void InvalidateParsedArrayCache()
        {
            lock (parseCacheLock)
            {
                parsedArrayCache.Clear();
                parsedArrayCacheStamp.Clear();
            }
        }

internal Dictionary<string, object> ReadSettingsObject()
        {
            lock (settingsWriteLock)
            {
                Dictionary<string, object> settings = ParseObject(ReadFile(SettingsPath(), "{}"));
                settings["twitch"] = ParseObject(ReadFile(TwitchConfigPath(), "{}"));
                settings["twitchBot"] = ParseObject(ReadFile(TwitchBotConfigPath(), "{}"));
                settings["obs"] = ParseObject(ReadFile(ObsConfigPath(), "{}"));
                settings["discord"] = ParseObject(ReadFile(DiscordConfigPath(), "{}"));
                if (File.Exists(BoostersPath()))
                {
                    settings["boosters"] = ReadArrayCached(BoostersPath());
                }
                if (File.Exists(CardsPath()))
                {
                    Dictionary<string, object> deck = settings.ContainsKey("deck") && settings["deck"] is Dictionary<string, object>
                        ? (Dictionary<string, object>)settings["deck"]
                        : new Dictionary<string, object>();
                    deck["cards"] = ReadArrayCached(CardsPath());
                    settings["deck"] = deck;
                }
                return settings;
            }
        }

internal void WriteSettingsObject(Dictionary<string, object> settings)
        {
            WriteSettingsObject(settings, true);
        }

internal void WriteSettingsObject(Dictionary<string, object> settings, bool preserveTwitchSecrets)
        {
            lock (settingsWriteLock)
            {
                // Twitch/OBS now live in their own files (see MigrateTwitchAndObsConfig), so they
                // are written separately and kept out of settings.json entirely. preserveTwitchSecrets
                // still applies to the dedicated twitch.json write: a settings.json save (e.g. a
                // fresh /api/settings POST without a "twitch" key) must not blank out the saved token.
                if (settings.ContainsKey("twitch") && settings["twitch"] is Dictionary<string, object>)
                {
                    Dictionary<string, object> twitch = (Dictionary<string, object>)settings["twitch"];
                    if (preserveTwitchSecrets) PreserveTwitchSecrets(twitch, ParseObject(ReadFile(TwitchConfigPath(), "{}")));
                    File.WriteAllText(TwitchConfigPath(), json.Serialize(twitch), Encoding.UTF8);
                }
                if (settings.ContainsKey("twitchBot") && settings["twitchBot"] is Dictionary<string, object>)
                {
                    Dictionary<string, object> twitchBot = (Dictionary<string, object>)settings["twitchBot"];
                    if (preserveTwitchSecrets) PreserveTwitchSecrets(twitchBot, ParseObject(ReadFile(TwitchBotConfigPath(), "{}")));
                    File.WriteAllText(TwitchBotConfigPath(), json.Serialize(twitchBot), Encoding.UTF8);
                }
                if (settings.ContainsKey("obs") && settings["obs"] is Dictionary<string, object>)
                {
                    File.WriteAllText(ObsConfigPath(), json.Serialize(settings["obs"]), Encoding.UTF8);
                }
                if (settings.ContainsKey("discord") && settings["discord"] is Dictionary<string, object>)
                {
                    File.WriteAllText(DiscordConfigPath(), json.Serialize(settings["discord"]), Encoding.UTF8);
                }
                // Boosters and cards live in their own files so updates / new rarities never
                // overwrite user-created content (same rationale as twitch.json/obs.json).
                if (settings.ContainsKey("boosters") && settings["boosters"] is object[])
                {
                    File.WriteAllText(BoostersPath(), json.Serialize(settings["boosters"]), Encoding.UTF8);
                }
                if (settings.ContainsKey("deck") && settings["deck"] is Dictionary<string, object>)
                {
                    Dictionary<string, object> deck = (Dictionary<string, object>)settings["deck"];
                    if (deck.ContainsKey("cards") && deck["cards"] is object[])
                    {
                        File.WriteAllText(CardsPath(), json.Serialize(deck["cards"]), Encoding.UTF8);
                    }
                }

                // Serialize settings.json from a shallow copy so the externalized sections are kept out
                // of settings.json without mutating the caller's dict (callers may return it to the client).
                Dictionary<string, object> toStore = new Dictionary<string, object>(settings);
                toStore.Remove("twitch");
                toStore.Remove("twitchBot");
                toStore.Remove("obs");
                toStore.Remove("discord");
                toStore.Remove("boosters");
                if (toStore.ContainsKey("deck") && toStore["deck"] is Dictionary<string, object>)
                {
                    Dictionary<string, object> deckCopy = new Dictionary<string, object>((Dictionary<string, object>)toStore["deck"]);
                    deckCopy.Remove("cards");
                    toStore["deck"] = deckCopy;
                }
                toStore["version"] = 1;
                toStore["updatedAt"] = DateTime.UtcNow.ToString("o");
                File.WriteAllText(SettingsPath(), json.Serialize(toStore), Encoding.UTF8);
            }
            InvalidateCardRarityCache();
            InvalidateParsedArrayCache();
            Broadcast("settings", "{\"updatedAt\":\"" + EscapeJson(DateTime.UtcNow.ToString("o")) + "\"}");
        }

private static void PreserveTwitchSecrets(Dictionary<string, object> incomingTwitch, Dictionary<string, object> currentTwitch)
        {
            if (incomingTwitch == null || currentTwitch == null) return;
            string[] keys = { "accessToken", "login", "displayName", "broadcasterId", "expiresAt" };
            foreach (string key in keys)
            {
                if ((!incomingTwitch.ContainsKey(key) || incomingTwitch[key] == null || String.IsNullOrWhiteSpace(Convert.ToString(incomingTwitch[key]))) &&
                    currentTwitch.ContainsKey(key) &&
                    currentTwitch[key] != null &&
                    !String.IsNullOrWhiteSpace(Convert.ToString(currentTwitch[key])))
                {
                    incomingTwitch[key] = currentTwitch[key];
                }
            }
        }

private static string GetString(Dictionary<string, object> data, string key, string fallback)
        {
            if (!data.ContainsKey(key) || data[key] == null) return fallback;
            return Convert.ToString(data[key]);
        }

private static bool GetBool(Dictionary<string, object> data, string key, bool fallback)
        {
            if (!data.ContainsKey(key) || data[key] == null) return fallback;
            if (data[key] is bool) return (bool)data[key];
            bool value;
            return Boolean.TryParse(Convert.ToString(data[key]), out value) ? value : fallback;
        }

private static string NormalizeUser(string value)
        {
            if (String.IsNullOrWhiteSpace(value)) return "viewer";
            value = value.Trim();
            return value.Length > 80 ? value.Substring(0, 80) : value;
        }

private static string EscapeJson(string value)
        {
            return value.Replace("\\", "\\\\").Replace("\"", "\\\"");
        }

private static string ReadFile(string path, string fallback)
        {
            return File.Exists(path) ? File.ReadAllText(path, Encoding.UTF8) : fallback;
        }

private string SettingsPath()
        {
            return Path.Combine(dataDir, "settings.json");
        }

private string CollectionsPath()
        {
            return Path.Combine(dataDir, "collections.json");
        }

private string StatsInstallIdPath()
        {
            return Path.Combine(dataDir, "stats-install-id.txt");
        }

// Deliberately its OWN file, not a field inside settings.json - a settings.json reset
        // (corrupt write, restored-from-defaults, whatever) must never silently mint a new
        // installId, because the anonymous community-stats server (see admin.js
        // syncCommunityCounts / tools/stats-server.js) sums card/booster counts per installId
        // FOREVER and never retires old ones - a fresh installId for the same physical install
        // just adds a permanent duplicate on top of the real total instead of replacing it.
        internal string GetOrCreateStatsInstallId()
        {
            lock (statsInstallIdLock)
            {
                string path = StatsInstallIdPath();
                if (File.Exists(path))
                {
                    string existing = ReadFile(path, "").Trim();
                    if (!String.IsNullOrEmpty(existing)) return existing;
                }
                // One-time migration: if an older settings.json still has a statsInstallId from
                // before this file existed, reuse it instead of minting a brand-new one, so an
                // upgrade doesn't itself create the exact duplicate-entry problem this fixes.
                string migrated = GetString(ReadSettingsObject(), "statsInstallId", "");
                string id = !String.IsNullOrEmpty(migrated) ? migrated : Guid.NewGuid().ToString();
                File.WriteAllText(path, id, Encoding.UTF8);
                return id;
            }
        }

private string CardsPath()
        {
            return Path.Combine(dataDir, "cards.json");
        }

private string BoostersPath()
        {
            return Path.Combine(dataDir, "boosters.json");
        }

private string TwitchConfigPath()
        {
            return Path.Combine(dataDir, "twitch.json");
        }

private string ObsConfigPath()
        {
            return Path.Combine(dataDir, "obs.json");
        }

private string DiscordConfigPath()
        {
            return Path.Combine(dataDir, "discord.json");
        }

private string LogPath()
        {
            return Path.Combine(dataDir, "app-log.json");
        }

private string DefaultSettingsPath()
        {
            return Path.Combine(defaultsDir, "settings.json");
        }

// ---- Blanko-Kartenvorlage (PNG-Zuschnitt des inneren Kartenbild-Bereichs) ----
        // Entspricht genau dem Bereich, den .card-art (components.css) tatsächlich zeigt:
        // inset 13% oben / 10% links+rechts / 18% unten der Kartenfläche, Eckenradius
        // proportional zu --card-art's 16px auf einer 320px-Karte. Transparent außerhalb
        // der abgerundeten Ecken, damit man direkt in der richtigen Form weiterarbeiten kann.
        private static byte[] GenerateBlankCardArtTemplatePng()
        {
            const int width = 800;
            const int height = 966;
            const int radius = 50;
            using (var bmp = new Bitmap(width, height, PixelFormat.Format32bppArgb))
            {
                using (Graphics g = Graphics.FromImage(bmp))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.Clear(Color.Transparent);
                    var rect = new Rectangle(0, 0, width, height);
                    using (GraphicsPath path = RoundedRectPath(rect, radius))
                    using (Brush brush = new SolidBrush(Color.White))
                    {
                        g.FillPath(brush, path);
                    }
                }
                using (var ms = new MemoryStream())
                {
                    bmp.Save(ms, ImageFormat.Png);
                    return ms.ToArray();
                }
            }
        }

private static GraphicsPath RoundedRectPath(Rectangle rect, int radius)
        {
            int d = radius * 2;
            var path = new GraphicsPath();
            path.AddArc(rect.X, rect.Y, d, d, 180, 90);
            path.AddArc(rect.Right - d, rect.Y, d, d, 270, 90);
            path.AddArc(rect.Right - d, rect.Bottom - d, d, d, 0, 90);
            path.AddArc(rect.X, rect.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }
    }
}
