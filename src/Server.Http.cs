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
private readonly string rootDir;

private readonly string publicDir;

private readonly string dataDir;

private readonly string defaultsDir;

private readonly JavaScriptSerializer json;

private readonly List<SseClient> clients;

private readonly object clientsLock;

private readonly object collectionWriteLock = new object();

// Guards settings.json/boosters.json/cards.json/twitch.json/obs.json against concurrent
        // read/write from overlapping requests (e.g. a debounced auto-save firing while a manual
        // "Speichern" click is still in flight) - without it, two threads racing File.WriteAllText
        // on the same file throw "being used by another process", which used to abort the whole
        // request silently and now surfaces as a real but confusing save failure to the user.
        private readonly object settingsWriteLock = new object();

private readonly TwitchBridge twitchBridge;

private readonly EventLog eventLog;

private TcpListener listener;

private bool running;

private int port;

// True when this install's own folder is the local dev/test build (see CLAUDE.md:
        // "CardPackWidget-TestApp/ — lokale Testinstanz"), never a real user's install. Used to
        // keep the local TestApp instance's card/booster counts out of the anonymous community
        // stats (syncCommunityCounts in admin.js) - a dev running the TestApp repeatedly for
        // testing must never inflate the aggregate that real installs contribute to.
        internal bool IsTestInstall
        {
            get { return rootDir.IndexOf("TestApp", StringComparison.OrdinalIgnoreCase) >= 0; }
        }

public CardPackServer(string rootDir)
        {
            this.rootDir = rootDir;
            publicDir = Path.Combine(rootDir, "public");
            dataDir = Path.Combine(rootDir, "data");
            defaultsDir = Path.Combine(rootDir, "defaults");
            json = new JavaScriptSerializer();
            json.MaxJsonLength = Int32.MaxValue;
            clients = new List<SseClient>();
            clientsLock = new object();
            twitchBridge = new TwitchBridge(this);
            eventLog = new EventLog(Path.Combine(dataDir, "app-log.json"), json);
        }

public void Log(string category, string level, string message)
        {
            eventLog.Add(category, level, message);
        }

private void InstallUpdate(string downloadUrl)
        {
            string tempRoot = Path.Combine(Path.GetTempPath(), "StreamerCardWidget-update-" + Guid.NewGuid().ToString("N"));
            string zipPath = tempRoot + ".zip";
            string stagingDir = tempRoot;
            Directory.CreateDirectory(stagingDir);

            using (var client = new WebClient())
            {
                client.Headers["User-Agent"] = "StreamerCardWidget-Updater";
                client.DownloadFile(downloadUrl, zipPath);
            }

            ZipFile.ExtractToDirectory(zipPath, stagingDir);
            try { File.Delete(zipPath); } catch { }

            // Some release zips wrap their contents in a single top-level folder. If the exe
            // isn't directly in stagingDir, look one level down so the copy step below works
            // regardless of how the archive was packed.
            string exeSourceDir = stagingDir;
            if (!File.Exists(Path.Combine(stagingDir, "CardPackWidget.exe")))
            {
                foreach (string dir in Directory.GetDirectories(stagingDir))
                {
                    if (File.Exists(Path.Combine(dir, "CardPackWidget.exe")))
                    {
                        exeSourceDir = dir;
                        break;
                    }
                }
            }
            if (!File.Exists(Path.Combine(exeSourceDir, "CardPackWidget.exe")))
            {
                throw new InvalidOperationException("Im Release wurde keine CardPackWidget.exe gefunden.");
            }

            string installDir = rootDir.TrimEnd('\\');
            int currentPid = Process.GetCurrentProcess().Id;

            // Relaunch the freshly extracted exe FROM the staging dir (not the install dir) in
            // --apply-update mode. Running from staging is what lets it overwrite the install-dir
            // exe - a process can never overwrite the exe it is itself running from, which is the
            // "file is in use" error the previous in-place relaunch always hit. The updater waits
            // for this (old) instance to exit, copies the new files into installDir, then starts
            // the updated install-dir exe. Only that final instance shows a window and binds the
            // port; by then both earlier processes are gone, so there is no two-instance race.
            string updaterExe = Path.Combine(exeSourceDir, "CardPackWidget.exe");

            Log("update", "info", "Update wird installiert, App startet neu...");

            Process.Start(new ProcessStartInfo
            {
                FileName = updaterExe,
                Arguments = "--apply-update --wait-for-pid=" + currentPid
                    + " --install-dir=\"" + installDir + "\""
                    + " --source-dir=\"" + exeSourceDir + "\"",
                UseShellExecute = true,
                WorkingDirectory = exeSourceDir
            });

            Task.Run(delegate
            {
                Thread.Sleep(200);
                try { Stop(); } catch { }
                Environment.Exit(0);
            });
        }

public int Start(int preferredPort)
        {
            EnsureDataFiles();
            // The event log is a live diagnostics view, not a persistent history - start every
            // app launch with an empty log.
            eventLog.Clear();
            // Defensive margin only - the actual self-update handover no longer relies on this.
            // A normal "the old window is still closing" moment could still want a brief retry.
            int attempts = 0;
            Exception lastError = null;
            while (attempts < 20)
            {
                try
                {
                    listener = new TcpListener(IPAddress.Loopback, preferredPort);
                    listener.Start();
                    port = preferredPort;
                    running = true;
                    Task.Factory.StartNew(AcceptLoop, TaskCreationOptions.LongRunning);
                    StartSseHeartbeat();
                    twitchBridge.Start();
                    return port;
                }
                catch (Exception ex)
                {
                    lastError = ex;
                    attempts++;
                    Thread.Sleep(500);
                }
            }
            throw new InvalidOperationException("Port " + preferredPort + " ist belegt. Bitte die alte Card-Pack-App schließen und erneut starten.", lastError);
        }

public void Stop()
        {
            running = false;
            try
            {
                if (listener != null) listener.Stop();
            }
            catch
            {
            }

            lock (clientsLock)
            {
                foreach (SseClient client in clients.ToArray())
                {
                    client.Close();
                }
                clients.Clear();
            }
            twitchBridge.Stop();
        }

private void AcceptLoop()
        {
            while (running)
            {
                try
                {
                    TcpClient client = listener.AcceptTcpClient();
                    Task.Factory.StartNew(delegate { HandleClient(client); });
                }
                catch
                {
                    if (!running) return;
                }
            }
        }

private void HandleClient(TcpClient client)
        {
            bool keepOpen = false;
            NetworkStream stream = null;
            try
            {
                // settings.json can be several MB (base64 card/booster images), so give slow
                // machines/loaded systems real headroom instead of the previous 10s, which could
                // trip mid-upload and surface only as an opaque "Failed to fetch" in the browser.
                client.ReceiveTimeout = 30000;
                client.SendTimeout = 30000;
                // Disable Nagle so small writes (SSE event pushes, API acks) always go out
                // immediately instead of potentially waiting on the Nagle/delayed-ACK interaction.
                client.NoDelay = true;
                stream = client.GetStream();
                HttpRequest request = ReadRequest(stream);
                if (request == null)
                {
                    return;
                }

                if (request.Path == "/api/events")
                {
                    // Diagnostic: shows WHICH browser connected (OBS's CEF reports "OBS/x.y" in its
                    // User-Agent) - key evidence when overlays appear dead in OBS but work in a tab.
                    Log("server", "info", "Overlay-Verbindung (SSE) aufgebaut: " + DescribeUserAgent(request.UserAgent) +
                        (String.IsNullOrEmpty(request.Query) ? "" : " [" + Uri.UnescapeDataString(request.Query) + "]"));
                    AddSseClient(client, stream);
                    keepOpen = true;
                    return;
                }

                if (request.Path.StartsWith("/api/", StringComparison.OrdinalIgnoreCase))
                {
                    HandleApi(request, stream);
                }
                else
                {
                    ServeStatic(request, stream);
                }
            }
            catch (Exception ex)
            {
                // A connection that never sent a complete request (idle keep-alive dropped by the
                // OS, a browser's speculative pre-connect, a stray port probe, ...) times out or
                // resets inside ReadRequest's blocking ReadByte() loop above - that's normal TCP
                // noise for a raw listener, not a real application error, and logging it as one
                // just alarms the user in the Log tab for nothing actionable. Real request-handling
                // failures (HandleApi/ServeStatic) still get logged as errors below.
                SocketException socketEx = ex as SocketException ?? ex.InnerException as SocketException;
                bool isBenignConnectionNoise = socketEx != null &&
                    (socketEx.SocketErrorCode == SocketError.TimedOut || socketEx.SocketErrorCode == SocketError.ConnectionReset || socketEx.SocketErrorCode == SocketError.ConnectionAborted);
                if (!isBenignConnectionNoise) Log("server", "error", "Anfrage fehlgeschlagen: " + ex.Message);
                try
                {
                    if (stream != null)
                    {
                        SendJson(stream, 500, json.Serialize(new Dictionary<string, object> { { "ok", false }, { "error", ex.Message } }));
                    }
                }
                catch
                {
                }
            }
            finally
            {
                if (!keepOpen)
                {
                    try { client.Close(); } catch { }
                }
            }
        }

private HttpRequest ReadRequest(NetworkStream stream)
        {
            var bytes = new List<byte>();
            int value;
            while ((value = stream.ReadByte()) >= 0)
            {
                bytes.Add((byte)value);
                int count = bytes.Count;
                if (count >= 4 &&
                    bytes[count - 4] == 13 &&
                    bytes[count - 3] == 10 &&
                    bytes[count - 2] == 13 &&
                    bytes[count - 1] == 10)
                {
                    break;
                }
                if (bytes.Count > 65536) return null;
            }

            if (bytes.Count == 0) return null;

            string headerText = Encoding.ASCII.GetString(bytes.ToArray());
            string[] lines = headerText.Split(new[] { "\r\n" }, StringSplitOptions.None);
            if (lines.Length == 0) return null;

            string[] first = lines[0].Split(' ');
            if (first.Length < 2) return null;

            var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            for (int i = 1; i < lines.Length; i++)
            {
                int colon = lines[i].IndexOf(':');
                if (colon > 0)
                {
                    headers[lines[i].Substring(0, colon).Trim()] = lines[i].Substring(colon + 1).Trim();
                }
            }

            int contentLength = 0;
            if (headers.ContainsKey("Content-Length"))
            {
                Int32.TryParse(headers["Content-Length"], out contentLength);
            }

            byte[] bodyBytes = new byte[contentLength];
            int offset = 0;
            while (offset < contentLength)
            {
                int read = stream.Read(bodyBytes, offset, contentLength - offset);
                if (read <= 0) break;
                offset += read;
            }

            string target = first[1];
            string path = target;
            int question = path.IndexOf('?');
            if (question >= 0) path = path.Substring(0, question);
            path = Uri.UnescapeDataString(path);

            string userAgent;
            headers.TryGetValue("User-Agent", out userAgent);

            return new HttpRequest
            {
                Method = first[0].ToUpperInvariant(),
                Path = path,
                Query = question >= 0 ? target.Substring(question + 1) : "",
                Body = Encoding.UTF8.GetString(bodyBytes, 0, offset),
                UserAgent = userAgent ?? ""
            };
        }

private void HandleApi(HttpRequest request, NetworkStream stream)
        {
            if (request.Method == "GET" && request.Path == "/api/health")
            {
                SendJson(stream, 200, "{\"ok\":true,\"port\":" + port + "}");
                return;
            }

            if (request.Method == "GET" && request.Path == "/api/version")
            {
                SendJson(stream, 200, json.Serialize(new Dictionary<string, object>
                {
                    { "ok", true },
                    { "version", AppInfo.Version },
                    { "releaseDate", AppInfo.ReleaseDate },
                    { "repo", AppInfo.GitHubRepo },
                    { "bootId", AppInfo.BootId },
                    { "isTestInstall", IsTestInstall }
                }));
                return;
            }

            if (request.Method == "GET" && request.Path == "/api/blank-card-template")
            {
                try
                {
                    byte[] png = GenerateBlankCardArtTemplatePng();
                    SendBytes(stream, 200, "image/png", png, "no-store",
                        "attachment; filename=\"Kartenvorlage.png\"");
                }
                catch (Exception ex)
                {
                    Log("template", "error", "Blanko-Kartenvorlage konnte nicht erzeugt werden: " + ex.Message);
                    SendJson(stream, 500, json.Serialize(new Dictionary<string, object>
                    {
                        { "ok", false },
                        { "error", ex.Message }
                    }));
                }
                return;
            }

            if (request.Method == "POST" && request.Path == "/api/update/install")
            {
                try
                {
                    Dictionary<string, object> body = ParseObject(request.Body);
                    string downloadUrl = GetString(body, "downloadUrl", "");
                    if (String.IsNullOrWhiteSpace(downloadUrl)) throw new InvalidOperationException("Keine Download-URL angegeben.");
                    InstallUpdate(downloadUrl);
                    SendJson(stream, 200, "{\"ok\":true}");
                }
                catch (Exception ex)
                {
                    Log("update", "error", "Update-Installation fehlgeschlagen: " + ex.Message);
                    SendJson(stream, 400, json.Serialize(new Dictionary<string, object>
                    {
                        { "ok", false },
                        { "error", ex.Message }
                    }));
                }
                return;
            }

            if (request.Method == "GET" && request.Path == "/api/logs")
            {
                SendJson(stream, 200, json.Serialize(new Dictionary<string, object>
                {
                    { "ok", true },
                    { "logs", eventLog.GetAll() }
                }));
                return;
            }

            if (request.Method == "POST" && request.Path == "/api/logs")
            {
                Dictionary<string, object> body = ParseObject(request.Body);
                eventLog.Add(GetString(body, "category", "app"), GetString(body, "level", "info"), GetString(body, "message", ""));
                SendJson(stream, 200, "{\"ok\":true}");
                return;
            }

            if (request.Method == "POST" && request.Path == "/api/logs/clear")
            {
                eventLog.Clear();
                SendJson(stream, 200, "{\"ok\":true}");
                return;
            }

            if (request.Method == "GET" && request.Path == "/api/settings")
            {
                SendJson(stream, 200, json.Serialize(ReadSettingsObject()));
                return;
            }

            if (request.Method == "GET" && request.Path == "/api/stats-install-id")
            {
                SendJson(stream, 200, json.Serialize(new Dictionary<string, object>
                {
                    { "ok", true },
                    { "installId", GetOrCreateStatsInstallId() }
                }));
                return;
            }

            if (request.Method == "GET" && request.Path == "/api/fonts")
            {
                var names = new List<string>();
                foreach (FontFamily family in FontFamily.Families)
                {
                    names.Add(family.Name);
                }
                names.Sort(StringComparer.CurrentCultureIgnoreCase);
                SendJson(stream, 200, json.Serialize(new Dictionary<string, object>
                {
                    { "ok", true },
                    { "fonts", names.ToArray() }
                }));
                return;
            }

            if (request.Method == "POST" && request.Path == "/api/settings")
            {
                Dictionary<string, object> incoming = ParseObject(request.Body);
                WriteSettingsObject(incoming);
                twitchBridge.RefreshChatCommands();
                twitchBridge.SyncIrlRewardPauseIfChanged();
                // Echoing the full settings back (cards/boosters with base64 images, easily
                // 10MB+) doubled every save's cost for a response no caller actually reads -
                // every admin.js call site does "await saveSettings(settings)" and discards the
                // result. A plain ack makes autosave noticeably faster, especially with many cards.
                SendJson(stream, 200, "{\"ok\":true}");
                return;
            }

            if (request.Method == "POST" && request.Path == "/api/discord/notify-draw")
            {
                Dictionary<string, object> body = ParseObject(request.Body);
                string login = GetString(body, "login", "");
                string displayName = GetString(body, "displayName", login);
                string cardTitle = GetString(body, "cardTitle", "");
                string boosterTitle = GetString(body, "boosterTitle", "");
                string rarity = GetString(body, "rarity", "common");
                bool isTest = GetBool(body, "isTest", false);
                string testAvatarUrl = GetString(body, "testAvatarUrl", "");
                byte[] imageBytes = null;
                try
                {
                    string imageBase64 = GetString(body, "image", "");
                    int comma = imageBase64.IndexOf(',');
                    imageBytes = Convert.FromBase64String(comma >= 0 ? imageBase64.Substring(comma + 1) : imageBase64);
                }
                catch { }
                string discordError = twitchBridge.NotifyDiscordDraw(login, displayName, cardTitle, boosterTitle, rarity, imageBytes, isTest, testAvatarUrl);
                if (isTest && discordError != null) SendJson(stream, 200, "{\"ok\":false,\"error\":" + json.Serialize(discordError) + "}");
                else SendJson(stream, 200, "{\"ok\":true}");
                return;
            }

            if (request.Method == "POST" && request.Path == "/api/reset-settings")
            {
                File.Copy(DefaultSettingsPath(), SettingsPath(), true);
                // Drop the externalized card/booster files so they get re-derived from the fresh
                // defaults; otherwise the old split-out content would override the reset on read.
                try { if (File.Exists(CardsPath())) File.Delete(CardsPath()); } catch { }
                try { if (File.Exists(BoostersPath())) File.Delete(BoostersPath()); } catch { }
                MigrateCardsAndBoosters();
                string settings = json.Serialize(ReadSettingsObject());
                Broadcast("settings", "{\"reset\":true}");
                SendJson(stream, 200, "{\"ok\":true,\"settings\":" + settings + "}");
                return;
            }

            if (request.Method == "POST" && request.Path == "/api/draw")
            {
                Dictionary<string, object> body = ParseObject(request.Body);
                string user = GetString(body, "user", "Viewer");
                string cardId = GetString(body, "cardId", null);
                string boosterId = GetString(body, "boosterId", null);
                string source = GetString(body, "source", "app");
                var ev = new Dictionary<string, object>();
                ev["id"] = DateTime.UtcNow.Ticks.ToString();
                ev["user"] = NormalizeUser(user);
                ev["cardId"] = cardId;
                ev["boosterId"] = boosterId;
                ev["source"] = source;
                string eventJson = json.Serialize(ev);
                Broadcast("draw", eventJson);
                SendJson(stream, 200, "{\"ok\":true,\"event\":" + eventJson + "}");
                return;
            }

            if (request.Method == "POST" && request.Path == "/api/trade/test")
            {
                // Preview the trade animation in OBS: the frontend supplies two random cards/names,
                // we just tag it as a test (so the overlay plays it even if the animation is off)
                // and broadcast it on the same "trade" channel a real swap uses.
                Dictionary<string, object> body = ParseObject(request.Body);
                body["eventId"] = "test-" + DateTime.UtcNow.Ticks.ToString();
                body["test"] = true;
                string tradeJson = json.Serialize(body);
                Broadcast("trade", tradeJson);
                int clientCount;
                lock (clientsLock) clientCount = clients.Count;
                Log("trade", "info", "Test-Animation an Overlays gesendet (" + GetString(body, "userA", "?") + " <-> " + GetString(body, "userB", "?") + "). Verbundene Overlay-Seiten: " + clientCount + ". Falls in OBS nichts passiert: Browserquelle aktualisieren (Cache).");
                SendJson(stream, 200, "{\"ok\":true}");
                return;
            }

            if (request.Method == "POST" && request.Path == "/api/gift/test")
            {
                // Preview the gift animation in OBS: the frontend supplies a random name pair and
                // card, we tag it as a test (so the overlay plays it even if the animation is off)
                // and broadcast it on the same "gift" channel a real gift uses.
                Dictionary<string, object> body = ParseObject(request.Body);
                body["eventId"] = "test-" + DateTime.UtcNow.Ticks.ToString();
                body["test"] = true;
                string giftJson = json.Serialize(body);
                Broadcast("gift", giftJson);
                int giftClientCount;
                lock (clientsLock) giftClientCount = clients.Count;
                Log("gift", "info", "Test-Animation an Overlays gesendet (" + GetString(body, "fromUser", "?") + " -> " + GetString(body, "toUser", "?") + "). Verbundene Overlay-Seiten: " + giftClientCount + ". Falls in OBS nichts passiert: Browserquelle aktualisieren (Cache).");
                SendJson(stream, 200, "{\"ok\":true}");
                return;
            }

            if (request.Method == "POST" && request.Path == "/api/battle/test")
            {
                // Preview the battle animation in OBS: the frontend supplies a synthetic lineup/
                // result, tagged as a test so the overlay plays it even if the animation is off.
                Dictionary<string, object> body = ParseObject(request.Body);
                body["eventId"] = "test-" + DateTime.UtcNow.Ticks.ToString();
                body["test"] = true;
                string battleJson = json.Serialize(body);
                Broadcast("battle", battleJson);
                int clientCount;
                lock (clientsLock) clientCount = clients.Count;
                Log("battle", "info", "Test-Animation an Overlays gesendet (" + GetString(body, "userA", "?") + " vs " + GetString(body, "userB", "?") + "). Verbundene Overlay-Seiten: " + clientCount + ". Falls in OBS nichts passiert: Browserquelle aktualisieren (Cache).");
                SendJson(stream, 200, "{\"ok\":true}");
                return;
            }

            if (request.Method == "GET" && request.Path == "/api/collections")
            {
                SendText(stream, 200, "application/json; charset=utf-8", ReadFile(CollectionsPath(), "{}"), "no-store");
                return;
            }

            if (request.Method == "GET" && request.Path == "/api/twitch/status")
            {
                SendJson(stream, 200, json.Serialize(new Dictionary<string, object>
                {
                    { "ok", true },
                    { "status", twitchBridge.Status() }
                }));
                return;
            }

            if (request.Method == "POST" && request.Path == "/api/twitch/token")
            {
                try
                {
                    Dictionary<string, object> tokenResult = twitchBridge.SaveToken(request.Body);
                    SendJson(stream, 200, json.Serialize(new Dictionary<string, object>
                    {
                        { "ok", true },
                        { "status", tokenResult }
                    }));
                }
                catch (Exception ex)
                {
                    Log("twitch", "error", "Twitch-Verbindung fehlgeschlagen: " + ex.Message);
                    SendJson(stream, 400, json.Serialize(new Dictionary<string, object>
                    {
                        { "ok", false },
                        { "error", ex.Message }
                    }));
                }
                return;
            }

            if (request.Method == "POST" && request.Path == "/api/twitch/disconnect")
            {
                twitchBridge.Disconnect();
                SendJson(stream, 200, "{\"ok\":true}");
                return;
            }

            if (request.Method == "GET" && request.Path == "/api/twitch/bot/status")
            {
                SendJson(stream, 200, json.Serialize(new Dictionary<string, object>
                {
                    { "ok", true },
                    { "status", twitchBridge.BotStatus() }
                }));
                return;
            }

            if (request.Method == "POST" && request.Path == "/api/twitch/bot/token")
            {
                try
                {
                    Dictionary<string, object> tokenResult = twitchBridge.SaveBotToken(request.Body);
                    SendJson(stream, 200, json.Serialize(new Dictionary<string, object>
                    {
                        { "ok", true },
                        { "status", tokenResult }
                    }));
                }
                catch (Exception ex)
                {
                    Log("twitch", "error", "Bot-Verbindung fehlgeschlagen: " + ex.Message);
                    SendJson(stream, 400, json.Serialize(new Dictionary<string, object>
                    {
                        { "ok", false },
                        { "error", ex.Message }
                    }));
                }
                return;
            }

            if (request.Method == "POST" && request.Path == "/api/twitch/bot/disconnect")
            {
                twitchBridge.DisconnectBot();
                SendJson(stream, 200, "{\"ok\":true}");
                return;
            }

            if (request.Method == "GET" && request.Path == "/api/command-usage")
            {
                SendJson(stream, 200, json.Serialize(new Dictionary<string, object>
                {
                    { "ok", true },
                    { "usage", twitchBridge.GetCommandUsage() }
                }));
                return;
            }

            if (request.Method == "GET" && request.Path == "/api/pity")
            {
                SendJson(stream, 200, json.Serialize(new Dictionary<string, object>
                {
                    { "ok", true },
                    { "pity", twitchBridge.GetPityState() }
                }));
                return;
            }

            if (request.Method == "GET" && request.Path == "/api/userstats")
            {
                SendJson(stream, 200, json.Serialize(new Dictionary<string, object>
                {
                    { "ok", true },
                    { "bits", twitchBridge.GetBitsState() },
                    { "stats", GetUserStatsOverview() }
                }));
                return;
            }

            if (request.Method == "GET" && request.Path == "/api/community-goal")
            {
                SendJson(stream, 200, json.Serialize(new Dictionary<string, object>
                {
                    { "ok", true },
                    { "goal", twitchBridge.GetCommunityGoalState() }
                }));
                return;
            }

            if (request.Method == "POST" && request.Path == "/api/community-goal/reset")
            {
                twitchBridge.ResetCommunityGoal();
                SendJson(stream, 200, "{\"ok\":true}");
                return;
            }

            if (request.Method == "POST" && request.Path == "/api/command-usage/reset")
            {
                Dictionary<string, object> body = ParseObject(request.Body);
                string login = GetString(body, "login", "");
                twitchBridge.ResetCommandUsage(login);
                SendJson(stream, 200, json.Serialize(new Dictionary<string, object>
                {
                    { "ok", true },
                    { "usage", twitchBridge.GetCommandUsage() }
                }));
                return;
            }

            if (request.Method == "GET" && request.Path == "/api/queue")
            {
                SendJson(stream, 200, json.Serialize(new Dictionary<string, object>
                {
                    { "ok", true },
                    { "items", twitchBridge.GetQueueItems() },
                    { "paused", twitchBridge.QueuePaused }
                }));
                return;
            }

            // Lets a freshly (re)loaded live-ticker overlay show the last few draws right away
            // instead of sitting empty until the next one happens - see AnnounceDraw's in-memory
            // history (cleared on app restart, same as the event log).
            if (request.Method == "GET" && request.Path == "/api/liveticker/recent")
            {
                SendJson(stream, 200, json.Serialize(new Dictionary<string, object>
                {
                    { "ok", true },
                    { "entries", twitchBridge.GetLiveTickerHistory() }
                }));
                return;
            }

            if (request.Method == "POST" && request.Path == "/api/queue/complete")
            {
                Dictionary<string, object> body = ParseObject(request.Body);
                twitchBridge.CompleteQueueItem(GetString(body, "eventId", ""), GetString(body, "cardTitle", ""), GetString(body, "boosterTitle", ""));
                SendJson(stream, 200, json.Serialize(new Dictionary<string, object> { { "ok", true } }));
                return;
            }

            // Fired by the overlay the moment a drawn card is fully revealed (same instant the
            // collection panel appears next to it) - separate from /api/queue/complete so the
            // post-draw chat message and live-ticker entry go out right then, instead of waiting
            // for the whole multi-second animation (backs-before-reveal, slide, hold time) to finish.
            if (request.Method == "POST" && request.Path == "/api/queue/announce")
            {
                Dictionary<string, object> body = ParseObject(request.Body);
                twitchBridge.AnnounceDraw(GetString(body, "eventId", ""), GetString(body, "cardTitle", ""), GetString(body, "boosterTitle", ""));
                SendJson(stream, 200, json.Serialize(new Dictionary<string, object> { { "ok", true } }));
                return;
            }

            if (request.Method == "POST" && request.Path == "/api/queue/pause")
            {
                Dictionary<string, object> body = ParseObject(request.Body);
                twitchBridge.SetQueuePaused(GetBool(body, "paused", false));
                SendJson(stream, 200, json.Serialize(new Dictionary<string, object> { { "ok", true }, { "paused", twitchBridge.QueuePaused } }));
                return;
            }

            if (request.Method == "POST" && request.Path == "/api/queue/remove")
            {
                Dictionary<string, object> body = ParseObject(request.Body);
                twitchBridge.RemoveQueueItem(GetString(body, "id", ""));
                SendJson(stream, 200, json.Serialize(new Dictionary<string, object> { { "ok", true }, { "items", twitchBridge.GetQueueItems() } }));
                return;
            }

            if (request.Method == "POST" && request.Path == "/api/queue/clear")
            {
                twitchBridge.ClearQueue();
                SendJson(stream, 200, json.Serialize(new Dictionary<string, object> { { "ok", true } }));
                return;
            }

            if (request.Method == "GET" && request.Path == "/api/twitch/rewards")
            {
                try
                {
                    SendJson(stream, 200, json.Serialize(new Dictionary<string, object>
                    {
                        { "ok", true },
                        { "rewards", twitchBridge.GetRewards() }
                    }));
                }
                catch (Exception ex)
                {
                    SendJson(stream, 400, json.Serialize(new Dictionary<string, object>
                    {
                        { "ok", false },
                        { "error", ex.Message }
                    }));
                }
                return;
            }

            if (request.Method == "POST" && request.Path == "/api/twitch/reward")
            {
                try
                {
                    Dictionary<string, object> settings = twitchBridge.SyncReward(request.Body);
                    SendJson(stream, 200, json.Serialize(new Dictionary<string, object>
                    {
                        { "ok", true },
                        { "settings", settings }
                    }));
                }
                catch (Exception ex)
                {
                    SendJson(stream, 400, json.Serialize(new Dictionary<string, object>
                    {
                        { "ok", false },
                        { "error", ex.Message }
                    }));
                }
                return;
            }

            if (request.Method == "POST" && request.Path == "/api/twitch/showcase-reward")
            {
                try
                {
                    Dictionary<string, object> settings = twitchBridge.SyncShowcaseReward(request.Body);
                    SendJson(stream, 200, json.Serialize(new Dictionary<string, object>
                    {
                        { "ok", true },
                        { "settings", settings }
                    }));
                }
                catch (Exception ex)
                {
                    SendJson(stream, 400, json.Serialize(new Dictionary<string, object>
                    {
                        { "ok", false },
                        { "error", ex.Message }
                    }));
                }
                return;
            }

            if (request.Method == "POST" && request.Path == "/api/twitch/tournament-reward")
            {
                try
                {
                    Dictionary<string, object> settings = twitchBridge.SyncTournamentReward(request.Body);
                    SendJson(stream, 200, json.Serialize(new Dictionary<string, object>
                    {
                        { "ok", true },
                        { "settings", settings }
                    }));
                }
                catch (Exception ex)
                {
                    SendJson(stream, 400, json.Serialize(new Dictionary<string, object>
                    {
                        { "ok", false },
                        { "error", ex.Message }
                    }));
                }
                return;
            }

            if (request.Method == "POST" && request.Path == "/api/twitch/teamBattle-reward")
            {
                try
                {
                    Dictionary<string, object> settings = twitchBridge.SyncTeamBattleReward(request.Body);
                    SendJson(stream, 200, json.Serialize(new Dictionary<string, object>
                    {
                        { "ok", true },
                        { "settings", settings }
                    }));
                }
                catch (Exception ex)
                {
                    SendJson(stream, 400, json.Serialize(new Dictionary<string, object>
                    {
                        { "ok", false },
                        { "error", ex.Message }
                    }));
                }
                return;
            }

            if (request.Method == "POST" && request.Path == "/api/twitch/specificPack-reward")
            {
                try
                {
                    Dictionary<string, object> settings = twitchBridge.SyncSpecificPackReward(request.Body);
                    SendJson(stream, 200, json.Serialize(new Dictionary<string, object>
                    {
                        { "ok", true },
                        { "settings", settings }
                    }));
                }
                catch (Exception ex)
                {
                    SendJson(stream, 400, json.Serialize(new Dictionary<string, object>
                    {
                        { "ok", false },
                        { "error", ex.Message }
                    }));
                }
                return;
            }

            if (request.Method == "POST" && request.Path == "/api/teamBattle/start")
            {
                string teamBattleResult = twitchBridge.StartTeamBattleSignup("", "", "app");
                SendJson(stream, 200, json.Serialize(new Dictionary<string, object>
                {
                    { "ok", true },
                    { "result", teamBattleResult }
                }));
                return;
            }

            if (request.Method == "GET" && request.Path == "/api/tournament")
            {
                SendJson(stream, 200, json.Serialize(new Dictionary<string, object>
                {
                    { "ok", true },
                    { "tournament", twitchBridge.GetTournamentState() }
                }));
                return;
            }

            if (request.Method == "POST" && request.Path == "/api/tournament/start")
            {
                string result = twitchBridge.StartTournamentSignup("", "", "app");
                SendJson(stream, 200, json.Serialize(new Dictionary<string, object>
                {
                    { "ok", true },
                    { "result", result }
                }));
                return;
            }


            if (request.Method == "DELETE" && request.Path == "/api/twitch/reward")
            {
                try
                {
                    Dictionary<string, object> settings = twitchBridge.DeleteReward(request.Body);
                    SendJson(stream, 200, json.Serialize(new Dictionary<string, object>
                    {
                        { "ok", true },
                        { "settings", settings }
                    }));
                }
                catch (Exception ex)
                {
                    SendJson(stream, 400, json.Serialize(new Dictionary<string, object>
                    {
                        { "ok", false },
                        { "error", ex.Message }
                    }));
                }
                return;
            }

            if (request.Method == "POST" && request.Path == "/api/collection")
            {
                UpdateCollection(request.Body);
                SendJson(stream, 200, "{\"ok\":true}");
                return;
            }

            if (request.Method == "POST" && request.Path == "/api/reset-collections")
            {
                File.WriteAllText(CollectionsPath(), "{}\n", Encoding.UTF8);
                Broadcast("collections", "{\"reset\":true}");
                SendJson(stream, 200, "{\"ok\":true}");
                return;
            }

            SendJson(stream, 404, "{\"ok\":false,\"error\":\"API route not found.\"}");
        }

// Short, human-readable browser tag for diagnostics ("OBS 31.0", "WebView2", "Chrome", ...).
        private static string DescribeUserAgent(string ua)
        {
            if (String.IsNullOrEmpty(ua)) return "unbekannter Client";
            int obsIdx = ua.IndexOf("OBS/", StringComparison.OrdinalIgnoreCase);
            if (obsIdx >= 0)
            {
                string rest = ua.Substring(obsIdx + 4);
                int space = rest.IndexOf(' ');
                return "OBS " + (space > 0 ? rest.Substring(0, space) : rest);
            }
            if (ua.IndexOf("Edg/", StringComparison.OrdinalIgnoreCase) >= 0) return "WebView2/Edge (Admin)";
            if (ua.IndexOf("Chrome/", StringComparison.OrdinalIgnoreCase) >= 0) return "Chrome/Chromium";
            return ua.Length > 60 ? ua.Substring(0, 60) : ua;
        }

private void ServeStatic(HttpRequest request, NetworkStream stream)
        {
            string relative = request.Path == "/" ? "admin.html" : request.Path.TrimStart('/');
            relative = relative.Replace('/', Path.DirectorySeparatorChar);
            string full = Path.GetFullPath(Path.Combine(publicDir, relative));
            string publicFull = Path.GetFullPath(publicDir);

            if (!full.StartsWith(publicFull, StringComparison.OrdinalIgnoreCase) || !File.Exists(full))
            {
                SendText(stream, 404, "text/plain; charset=utf-8", "Not found", "no-store");
                return;
            }

            // Diagnostic: page + script loads per browser, to verify OBS actually fetches the
            // current files (its embedded browser caching has repeatedly caused "dead" overlays).
            string lowerPath = request.Path.ToLowerInvariant();
            if (lowerPath.EndsWith(".html") || lowerPath.EndsWith(".js"))
            {
                Log("server", "info", "Datei geladen: " + request.Path + " von " + DescribeUserAgent(request.UserAgent));
            }

            byte[] bytes = File.ReadAllBytes(full);
            string contentType = MimeType(Path.GetExtension(full));
            string ext = Path.GetExtension(full).ToLowerInvariant();
            string cache = (ext == ".html" || ext == ".js" || ext == ".css") ? "no-store" : "public, max-age=3600";
            SendBytes(stream, 200, contentType, bytes, cache);
        }

private void AddSseClient(TcpClient tcpClient, NetworkStream stream)
        {
            string headers =
                "HTTP/1.1 200 OK\r\n" +
                "Content-Type: text/event-stream; charset=utf-8\r\n" +
                "Cache-Control: no-cache, no-transform\r\n" +
                "Connection: keep-alive\r\n" +
                "Access-Control-Allow-Origin: *\r\n\r\n";
            byte[] headerBytes = Encoding.UTF8.GetBytes(headers);
            stream.Write(headerBytes, 0, headerBytes.Length);

            var client = new SseClient(tcpClient, stream);
            lock (clientsLock)
            {
                clients.Add(client);
            }
            // bootId lets connected overlays detect an app restart (EventSource auto-reconnects):
            // a changed bootId means the served files may have changed, so the page reloads itself
            // with the new bootId as cache-buster (see connectEventStream in api.js).
            client.Write("event: ready\ndata: {\"ok\":true,\"bootId\":\"" + AppInfo.BootId + "\"}\n\n");
        }

private System.Threading.Timer sseHeartbeatTimer;

// SSE keepalive. Without periodic traffic, OBS's embedded browser (CEF) silently reaps
        // event-stream connections after a few idle minutes: the page still reports readyState=1
        // and the server's TCP writes still "succeed", but nothing arrives anymore - draws then
        // played to nobody (diagnosed 2026-07-16: every failed draw happened >5 min after connect,
        // everything within the first minutes worked). A ping every 20s keeps every hop alive,
        // flushes genuinely dead sockets out of the client list early, and feeds the client-side
        // watchdog in api.js, which force-reconnects if pings stop arriving.
        private void StartSseHeartbeat()
        {
            if (sseHeartbeatTimer != null) return;
            sseHeartbeatTimer = new System.Threading.Timer(delegate
            {
                try { Broadcast("ping", "{\"t\":" + DateTime.UtcNow.Ticks + "}"); }
                catch { }
            }, null, 20000, 20000);
        }

internal void Broadcast(string eventName, string dataJson)
        {
            string payload = "event: " + eventName + "\n" + "data: " + dataJson + "\n\n";
            int delivered = 0;
            int dropped = 0;
            lock (clientsLock)
            {
                foreach (SseClient client in clients.ToArray())
                {
                    if (!client.Write(payload))
                    {
                        clients.Remove(client);
                        client.Close();
                        dropped++;
                    }
                    else
                    {
                        delivered++;
                    }
                }
            }
            // Diagnostic for the animation-triggering events: shows whether a broadcast actually
            // reached any connected overlay (a successful TCP write is no guarantee the page is
            // still alive, but delivered=0 proves nothing could have received it).
            if (eventName == "draw" || eventName == "trade" || eventName == "battle" || eventName == "showcollection" || eventName == "showpack" || eventName == "ranking" || eventName == "communitygoalreached")
            {
                Log("server", "info", "Broadcast \"" + eventName + "\": an " + delivered + " Overlay-Verbindung(en) gesendet" + (dropped > 0 ? ", " + dropped + " tote Verbindung(en) entfernt" : "") + ".");
            }
        }

private static readonly HashSet<string> KnownRarityIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "common", "uncommon", "rare", "epic", "legendary", "holo"
        };

// Canonical rarity order (common -> holo), used to sort card lists by rarity.
        private static readonly string[] RarityOrder = { "common", "uncommon", "rare", "epic", "legendary", "holo" };

// ---- Ranking support: persistent battle statistics + top-owner queries ----

        private readonly object battleStatsLock = new object();

// ---- Live-ticker persistence: last few entries survive an app restart ----

        private readonly object liveTickerHistoryFileLock = new object();

// Looks up a card's rarity id (normalized, e.g. "legendary") for battle-strength lookups.
        // Cached cardId -> rarity lookup. CardRarity used to call ReadSettingsObject() (which
        // re-reads and re-parses settings.json/twitch.json/obs.json/boosters.json/cards.json from
        // disk EVERY call - cards.json in particular holds every card's base64 image, easily
        // several MB) on every single invocation. Battle resolution calls this once or twice per
        // HIT (see CardBattleStrength/ResolveHpElimination), and a Team-Kampf or tournament match
        // can rack up dozens of hits - that turned "resolve one fight" into dozens of full
        // multi-MB file reads happening synchronously inside the signup-timer callback, which is
        // exactly why tournament/Team-Kampf fights took so long to actually start after the signup
        // window closed. Built lazily on first use, invalidated (see InvalidateCardRarityCache)
        // whenever the card list can change - settings.json save or the one-time cards.json
        // migration - so it can never serve a stale rarity for a renamed/re-rarified card.
        private readonly object cardRarityCacheLock = new object();

private Dictionary<string, string> cardRarityCache;

// Parse cache for the two big data files (cards.json can be tens of MB with base64 card
        // images). ReadSettingsObject is called on EVERY chat message and channel-point redemption
        // (often several times per event) - re-parsing cards.json each time made chat commands and
        // redemptions visibly sluggish on real-sized collections. The cache is keyed on the file's
        // last-write timestamp + size, so any write (from this process or an external edit)
        // invalidates it automatically; WriteSettingsObject additionally clears it outright.
        // NOTE: callers receive the SAME cached array instance - by convention nothing mutates
        // card/booster entries obtained via ReadSettingsObject without immediately writing them
        // back via WriteSettingsObject (which invalidates the cache).
        private readonly object parseCacheLock = new object();

private readonly Dictionary<string, object[]> parsedArrayCache = new Dictionary<string, object[]>();

private readonly Dictionary<string, string> parsedArrayCacheStamp = new Dictionary<string, string>();

internal JavaScriptSerializer Serializer
        {
            get { return json; }
        }

private readonly object statsInstallIdLock = new object();

private void SendJson(NetworkStream stream, int status, string jsonText)
        {
            SendText(stream, status, "application/json; charset=utf-8", jsonText, "no-store");
        }

private void SendText(NetworkStream stream, int status, string contentType, string text, string cacheControl)
        {
            SendBytes(stream, status, contentType, Encoding.UTF8.GetBytes(text), cacheControl);
        }

private void SendBytes(NetworkStream stream, int status, string contentType, byte[] body, string cacheControl)
        {
            SendBytes(stream, status, contentType, body, cacheControl, null);
        }

private void SendBytes(NetworkStream stream, int status, string contentType, byte[] body, string cacheControl, string contentDisposition)
        {
            string statusText = StatusText(status);
            string headers =
                "HTTP/1.1 " + status + " " + statusText + "\r\n" +
                "Content-Type: " + contentType + "\r\n" +
                "Content-Length: " + body.Length + "\r\n" +
                "Cache-Control: " + cacheControl + "\r\n" +
                (String.IsNullOrEmpty(contentDisposition) ? "" : "Content-Disposition: " + contentDisposition + "\r\n") +
                "Connection: close\r\n\r\n";
            // Single combined write (headers + body in one buffer) so the response is one TCP
            // segment where possible - avoids Nagle/delayed-ACK stalls between the two writes.
            byte[] headerBytes = Encoding.UTF8.GetBytes(headers);
            byte[] combined = new byte[headerBytes.Length + body.Length];
            Buffer.BlockCopy(headerBytes, 0, combined, 0, headerBytes.Length);
            Buffer.BlockCopy(body, 0, combined, headerBytes.Length, body.Length);
            stream.Write(combined, 0, combined.Length);
        }

private static string StatusText(int status)
        {
            if (status == 200) return "OK";
            if (status == 400) return "Bad Request";
            if (status == 404) return "Not Found";
            if (status == 500) return "Internal Server Error";
            return "OK";
        }

private static string MimeType(string ext)
        {
            ext = ext.ToLowerInvariant();
            if (ext == ".html") return "text/html; charset=utf-8";
            if (ext == ".css") return "text/css; charset=utf-8";
            if (ext == ".js") return "text/javascript; charset=utf-8";
            if (ext == ".json") return "application/json; charset=utf-8";
            if (ext == ".svg") return "image/svg+xml";
            if (ext == ".png") return "image/png";
            if (ext == ".jpg" || ext == ".jpeg") return "image/jpeg";
            if (ext == ".webp") return "image/webp";
            if (ext == ".ico") return "image/x-icon";
            return "application/octet-stream";
        }
    }
}
