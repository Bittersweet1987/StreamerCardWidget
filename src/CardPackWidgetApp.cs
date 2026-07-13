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
    internal static class AppInfo
    {
        public const string Version = "2.9.1";
        public const string ReleaseDate = "2026-07-13";
        public const string GitHubRepo = "Bittersweet1987/StreamerCardWidget";
    }

    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            AppDomain.CurrentDomain.UnhandledException += delegate (object sender, UnhandledExceptionEventArgs e)
            {
                LogCrash(e.ExceptionObject as Exception);
            };
            Application.ThreadException += delegate (object sender, System.Threading.ThreadExceptionEventArgs e)
            {
                LogCrash(e.Exception);
            };
            try
            {
                if (TryApplyUpdate()) return;
                ServicePointManager.Expect100Continue = false;
                ServicePointManager.SecurityProtocol =
                    (SecurityProtocolType)3072 | // TLS 1.2 for Twitch Helix and OAuth APIs
                    (SecurityProtocolType)768 |
                    SecurityProtocolType.Tls;
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new MainForm());
            }
            catch (Exception ex)
            {
                LogCrash(ex);
            }
        }

        // Self-update relaunches the freshly extracted exe (running from the temp staging dir,
        // NOT the install dir) in this "--apply-update" mode. Because this updater instance does
        // NOT run out of the install dir's CardPackWidget.exe, it can overwrite that exe once the
        // old instance has exited - a running exe can never overwrite itself, which is exactly the
        // "file is in use" failure the old in-place relaunch hit. We copy the new files in, launch
        // the now-updated install-dir exe, and exit without ever showing a window or binding a port.
        private static bool TryApplyUpdate()
        {
            bool apply = false;
            int waitPid = 0;
            string installDir = null;
            string sourceDir = null;
            foreach (string arg in Environment.GetCommandLineArgs())
            {
                if (arg.Equals("--apply-update", StringComparison.OrdinalIgnoreCase)) apply = true;
                else if (arg.StartsWith("--wait-for-pid=", StringComparison.OrdinalIgnoreCase))
                {
                    int pid;
                    if (Int32.TryParse(arg.Substring("--wait-for-pid=".Length), out pid)) waitPid = pid;
                }
                else if (arg.StartsWith("--install-dir=", StringComparison.OrdinalIgnoreCase))
                    installDir = arg.Substring("--install-dir=".Length).Trim('"');
                else if (arg.StartsWith("--source-dir=", StringComparison.OrdinalIgnoreCase))
                    sourceDir = arg.Substring("--source-dir=".Length).Trim('"');
            }
            if (!apply || String.IsNullOrEmpty(installDir) || String.IsNullOrEmpty(sourceDir)) return false;

            try
            {
                if (waitPid != 0)
                {
                    try { Process.GetProcessById(waitPid).WaitForExit(15000); } catch { }
                }
                installDir = installDir.TrimEnd('\\');
                // The old instance's exe handle may linger briefly after exit; retry the copy so a
                // momentary lock on CardPackWidget.exe doesn't abort the whole update.
                Exception lastError = null;
                for (int attempt = 0; attempt < 20; attempt++)
                {
                    try { CopyDirectoryRecursive(sourceDir, installDir); lastError = null; break; }
                    catch (Exception ex) { lastError = ex; Thread.Sleep(500); }
                }
                if (lastError != null) throw lastError;

                Process.Start(new ProcessStartInfo
                {
                    FileName = Path.Combine(installDir, "CardPackWidget.exe"),
                    UseShellExecute = true,
                    WorkingDirectory = installDir
                });
            }
            catch (Exception ex)
            {
                LogCrash(ex);
            }
            return true;
        }

        private static void CopyDirectoryRecursive(string sourceDir, string destDir)
        {
            Directory.CreateDirectory(destDir);
            foreach (string file in Directory.GetFiles(sourceDir))
            {
                File.Copy(file, Path.Combine(destDir, Path.GetFileName(file)), true);
            }
            foreach (string dir in Directory.GetDirectories(sourceDir))
            {
                CopyDirectoryRecursive(dir, Path.Combine(destDir, Path.GetFileName(dir)));
            }
        }

        private static void LogCrash(Exception ex)
        {
            try
            {
                string path = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "crash.log");
                File.AppendAllText(path, DateTime.UtcNow.ToString("o") + " " + (ex == null ? "(unknown)" : ex.ToString()) + Environment.NewLine + Environment.NewLine, Encoding.UTF8);
            }
            catch
            {
            }
        }
    }

    public sealed class MainForm : Form
    {
        private readonly WebView2 adminView;
        private readonly CardPackServer server;
        private string adminUrl;
        private string overlayUrl;

        public MainForm()
        {
            Text = "Streamer Card Widget";
            MinimumSize = new Size(1180, 780);
            Size = new Size(1320, 900);
            StartPosition = FormStartPosition.CenterScreen;
            Font = new Font("Segoe UI", 9F);
            BackColor = Color.FromArgb(245, 243, 248);
            // WinForms doesn't default the title bar/taskbar icon to the exe's own embedded icon
            // (set via /win32icon at compile time) - it has to be assigned explicitly here.
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            server = new CardPackServer(AppDomain.CurrentDomain.BaseDirectory);

            adminView = new WebView2();
            adminView.Dock = DockStyle.Fill;
            Controls.Add(adminView);

            Load += async delegate { await StartAppAsync(); };
            FormClosing += delegate { server.Stop(); };
        }

        private async Task StartAppAsync()
        {
            try
            {
                server.Stop();
                int port = server.Start(5377);
                adminUrl = "http://localhost:" + port + "/admin.html";
                overlayUrl = "http://localhost:" + port + "/overlay.html";
                await adminView.EnsureCoreWebView2Async(null);
                adminView.CoreWebView2.NewWindowRequested += OnNewWindowRequested;
                adminView.CoreWebView2.Navigate(adminUrl);
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "Die App konnte die Verwaltung nicht laden.\n\n" + ex.Message,
                    "Streamer Card Widget",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
            }
        }

        private void OnNewWindowRequested(object sender, Microsoft.Web.WebView2.Core.CoreWebView2NewWindowRequestedEventArgs e)
        {
            // Twitch's login page actively restricts embedded WebView popups (CAPTCHA loops,
            // "this might not be you" blocks). Hand the OAuth URL to the user's real browser instead,
            // where they are likely already logged in to Twitch.
            e.Handled = true;
            try
            {
                Process.Start(new ProcessStartInfo(e.Uri) { UseShellExecute = true });
            }
            catch
            {
            }
        }

    }

    public sealed class CardPackServer
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
                stream = client.GetStream();
                HttpRequest request = ReadRequest(stream);
                if (request == null)
                {
                    return;
                }

                if (request.Path == "/api/events")
                {
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
                // A bare swallow here used to drop the connection with zero response on ANY
                // handler exception (e.g. a bad settings.json write) - from the browser that
                // looks like "Failed to fetch" with no error detail at all. Log it and, if we
                // still have a live stream, try to hand back a real 500 so the client sees why.
                Log("server", "error", "Anfrage fehlgeschlagen: " + ex.Message);
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

            return new HttpRequest
            {
                Method = first[0].ToUpperInvariant(),
                Path = path,
                Body = Encoding.UTF8.GetString(bodyBytes, 0, offset)
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
                    { "repo", AppInfo.GitHubRepo }
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
                string payload = json.Serialize(ReadSettingsObject());
                SendJson(stream, 200, "{\"ok\":true,\"settings\":" + payload + "}");
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

            if (request.Method == "POST" && request.Path == "/api/queue/complete")
            {
                Dictionary<string, object> body = ParseObject(request.Body);
                twitchBridge.CompleteQueueItem(GetString(body, "eventId", ""), GetString(body, "cardTitle", ""), GetString(body, "boosterTitle", ""));
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
            client.Write("event: ready\ndata: {\"ok\":true}\n\n");
        }

        internal void Broadcast(string eventName, string dataJson)
        {
            string payload = "event: " + eventName + "\n" + "data: " + dataJson + "\n\n";
            lock (clientsLock)
            {
                foreach (SseClient client in clients.ToArray())
                {
                    if (!client.Write(payload))
                    {
                        clients.Remove(client);
                        client.Close();
                    }
                }
            }
        }

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

            if (changed) File.WriteAllText(SettingsPath(), json.Serialize(settings), Encoding.UTF8);
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

        private void UpdateCollection(string bodyJson)
        {
            Dictionary<string, object> body = ParseObject(bodyJson);
            string user = NormalizeUser(GetString(body, "user", "viewer")).ToLowerInvariant();
            string cardId = GetString(body, "cardId", "");
            string boosterId = GetString(body, "boosterId", "default");
            string variableName = GetString(body, "variableName", boosterId);
            Dictionary<string, object> collections = ParseObject(ReadFile(CollectionsPath(), "{}"));
            string collectionKey = String.IsNullOrWhiteSpace(boosterId) ? variableName : boosterId;

            if (body.ContainsKey("collection") && body["collection"] is Dictionary<string, object>)
            {
                Dictionary<string, object> snapshot = (Dictionary<string, object>)body["collection"];
                if (!snapshot.ContainsKey("version")) snapshot["version"] = 1;
                if (!snapshot.ContainsKey("boosterId")) snapshot["boosterId"] = boosterId;
                if (snapshot.ContainsKey("globalVariable")) snapshot.Remove("globalVariable");
                if (!snapshot.ContainsKey("users")) snapshot["users"] = new Dictionary<string, object>();
                collections[collectionKey] = snapshot;
                File.WriteAllText(CollectionsPath(), json.Serialize(collections), Encoding.UTF8);
                return;
            }

            if (cardId.Length == 0) return;

            Dictionary<string, object> boosterCollection;
            if (collections.ContainsKey(collectionKey) && collections[collectionKey] is Dictionary<string, object>)
            {
                boosterCollection = (Dictionary<string, object>)collections[collectionKey];
            }
            else
            {
                boosterCollection = new Dictionary<string, object>();
                boosterCollection["version"] = 1;
                boosterCollection["boosterId"] = boosterId;
                boosterCollection["users"] = new Dictionary<string, object>();
                collections[collectionKey] = boosterCollection;
            }

            Dictionary<string, object> users = boosterCollection.ContainsKey("users") && boosterCollection["users"] is Dictionary<string, object>
                ? (Dictionary<string, object>)boosterCollection["users"]
                : new Dictionary<string, object>();
            boosterCollection["users"] = users;

            Dictionary<string, object> userData;
            if (users.ContainsKey(user) && users[user] is Dictionary<string, object>)
            {
                userData = (Dictionary<string, object>)users[user];
            }
            else
            {
                userData = new Dictionary<string, object>();
                userData["displayName"] = GetString(body, "user", "viewer");
                userData["cards"] = new Dictionary<string, object>();
                users[user] = userData;
            }

            Dictionary<string, object> cards;
            if (userData.ContainsKey("cards") && userData["cards"] is Dictionary<string, object>)
            {
                cards = (Dictionary<string, object>)userData["cards"];
            }
            else
            {
                cards = new Dictionary<string, object>();
                userData["cards"] = cards;
            }

            int current = 0;
            if (cards.ContainsKey(cardId))
            {
                Int32.TryParse(Convert.ToString(cards[cardId]), out current);
            }
            cards[cardId] = current + 1;
            File.WriteAllText(CollectionsPath(), json.Serialize(collections), Encoding.UTF8);
        }

        // ---- Trade support: card/booster/collection access used by the chat trade commands. ----

        // Resolves a free-text card name to a concrete card + its booster. On a miss, returns the
        // closest title as a suggestion so the chat command can answer "did you mean ...?".
        internal Dictionary<string, object> ResolveCardByName(string name)
        {
            var result = new Dictionary<string, object>
            {
                { "found", false }, { "suggestion", "" }, { "cardId", "" }, { "cardTitle", "" }, { "boosterId", "" }, { "boosterTitle", "" }
            };
            if (String.IsNullOrWhiteSpace(name)) return result;
            Dictionary<string, object> settings = ReadSettingsObject();
            object[] cards = SettingsCards(settings);
            object[] boosters = settings.ContainsKey("boosters") && settings["boosters"] is object[] ? (object[])settings["boosters"] : new object[0];

            var cardBooster = new Dictionary<string, Dictionary<string, object>>(StringComparer.OrdinalIgnoreCase);
            foreach (object bo in boosters)
            {
                Dictionary<string, object> booster = bo as Dictionary<string, object>;
                if (booster == null) continue;
                object idsObj;
                if (!booster.TryGetValue("cardIds", out idsObj) || !(idsObj is object[])) continue;
                foreach (object cid in (object[])idsObj)
                {
                    string cidStr = Convert.ToString(cid);
                    if (!cardBooster.ContainsKey(cidStr)) cardBooster[cidStr] = booster;
                }
            }

            string target = name.Trim();
            string bestTitle = "";
            int bestDistance = Int32.MaxValue;
            foreach (object co in cards)
            {
                Dictionary<string, object> card = co as Dictionary<string, object>;
                if (card == null) continue;
                string title = GetString(card, "title", "");
                if (String.IsNullOrWhiteSpace(title)) continue;
                if (String.Equals(title.Trim(), target, StringComparison.OrdinalIgnoreCase))
                {
                    string cardId = GetString(card, "id", "");
                    result["found"] = true;
                    result["cardId"] = cardId;
                    result["cardTitle"] = title;
                    Dictionary<string, object> booster;
                    if (cardBooster.TryGetValue(cardId, out booster))
                    {
                        result["boosterId"] = GetString(booster, "id", "");
                        result["boosterTitle"] = GetString(booster, "title", "");
                    }
                    return result;
                }
                int d = LevenshteinDistance(title.Trim().ToLowerInvariant(), target.ToLowerInvariant());
                if (d < bestDistance) { bestDistance = d; bestTitle = title; }
            }
            result["suggestion"] = bestTitle;
            return result;
        }

        internal bool UserExistsInCollections(string login)
        {
            string key = NormalizeUser(login).ToLowerInvariant();
            Dictionary<string, object> collections = ParseObject(ReadFile(CollectionsPath(), "{}"));
            foreach (object value in collections.Values)
            {
                Dictionary<string, object> booster = value as Dictionary<string, object>;
                if (booster == null) continue;
                object usersObj;
                if (booster.TryGetValue("users", out usersObj) && usersObj is Dictionary<string, object>)
                {
                    if (((Dictionary<string, object>)usersObj).ContainsKey(key)) return true;
                }
            }
            return false;
        }

        internal int GetCardCount(string login, string boosterId, string cardId)
        {
            Dictionary<string, object> collections = ParseObject(ReadFile(CollectionsPath(), "{}"));
            Dictionary<string, object> cards = FindUserCards(collections, boosterId, login);
            return cards == null ? 0 : CardCount(cards, cardId);
        }

        // Returns every distinct (boosterId, cardId) type the user owns at least one copy of.
        // Used by the battle system to draw a random, duplicate-free card lineup.
        internal List<Dictionary<string, string>> GetUserOwnedCardTypes(string login)
        {
            var result = new List<Dictionary<string, string>>();
            string key = NormalizeUser(login).ToLowerInvariant();
            Dictionary<string, object> collections = ParseObject(ReadFile(CollectionsPath(), "{}"));
            foreach (KeyValuePair<string, object> kv in collections)
            {
                Dictionary<string, object> booster = kv.Value as Dictionary<string, object>;
                if (booster == null) continue;
                object usersObj;
                if (!booster.TryGetValue("users", out usersObj) || !(usersObj is Dictionary<string, object>)) continue;
                object uObj;
                if (!((Dictionary<string, object>)usersObj).TryGetValue(key, out uObj) || !(uObj is Dictionary<string, object>)) continue;
                object cObj;
                if (!((Dictionary<string, object>)uObj).TryGetValue("cards", out cObj) || !(cObj is Dictionary<string, object>)) continue;
                Dictionary<string, object> cards = (Dictionary<string, object>)cObj;
                foreach (string cardId in cards.Keys)
                {
                    if (CardCount(cards, cardId) < 1) continue;
                    result.Add(new Dictionary<string, string> { { "boosterId", kv.Key }, { "cardId", cardId } });
                }
            }
            return result;
        }

        // Moves exactly one copy of one card type from loginFrom to loginTo. Returns false if
        // loginFrom no longer owns the card (e.g. traded away between lineup draw and prize payout).
        internal bool TransferSingleCard(string boosterId, string cardId, string loginFrom, string displayFrom, string loginTo, string displayTo)
        {
            lock (collectionWriteLock)
            {
                Dictionary<string, object> collections = ParseObject(ReadFile(CollectionsPath(), "{}"));
                Dictionary<string, object> gives = EnsureUserCards(collections, boosterId, loginFrom, displayFrom);
                if (CardCount(gives, cardId) < 1) return false;
                Dictionary<string, object> gets = EnsureUserCards(collections, boosterId, loginTo, displayTo);
                SetCount(gives, cardId, CardCount(gives, cardId) - 1);
                SetCount(gets, cardId, CardCount(gets, cardId) + 1);
                File.WriteAllText(CollectionsPath(), json.Serialize(collections), Encoding.UTF8);
                Broadcast("collections", "{\"updated\":true}");
                return true;
            }
        }

        private static readonly HashSet<string> KnownRarityIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "common", "uncommon", "rare", "epic", "legendary", "holo"
        };

        // Normalizes a rarity value (English id or German label) to its canonical English id.
        // Mirrors TwitchBridge.NormalizeRarityId; kept as a separate copy since that one is
        // private to TwitchBridge and this needs to be usable from CardPackServer.
        private static string NormalizeRarityIdShared(string rarity)
        {
            string r = (rarity ?? "").Trim().ToLowerInvariant();
            if (KnownRarityIds.Contains(r)) return r;
            switch (r)
            {
                case "gewöhnlich": case "gewoehnlich": return "common";
                case "ungewöhnlich": case "ungewoehnlich": return "uncommon";
                case "selten": return "rare";
                case "episch": return "epic";
                case "legendär": case "legendaer": return "legendary";
            }
            return "common";
        }

        // Canonical rarity order (common -> holo), used to sort card lists by rarity.
        private static readonly string[] RarityOrder = { "common", "uncommon", "rare", "epic", "legendary", "holo" };

        internal static int GetRarityRank(string rarity)
        {
            string id = NormalizeRarityIdShared(rarity);
            int index = Array.IndexOf(RarityOrder, id);
            return index < 0 ? RarityOrder.Length : index;
        }

        // ---- Ranking support: persistent battle statistics + top-owner queries ----

        private readonly object battleStatsLock = new object();

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

        private static object[] TopByField(List<Dictionary<string, object>> entries, string field, int limit)
        {
            var sorted = new List<Dictionary<string, object>>(entries);
            sorted.Sort(delegate(Dictionary<string, object> a, Dictionary<string, object> b)
            {
                return Convert.ToDouble(b[field]).CompareTo(Convert.ToDouble(a[field]));
            });
            var top = new List<object>();
            for (int i = 0; i < sorted.Count && i < limit; i++)
            {
                top.Add(new Dictionary<string, object> { { "user", sorted[i]["user"] }, { "value", sorted[i][field] } });
            }
            return top.ToArray();
        }

        // Top owners of one card type for "!ranking <Kartenname>", sorted by copies owned.
        internal object[] GetTopCardOwners(string boosterId, string cardId, int limit)
        {
            var owners = new List<Dictionary<string, object>>();
            Dictionary<string, object> collections = ParseObject(ReadFile(CollectionsPath(), "{}"));
            object bObj;
            if (collections.TryGetValue(boosterId, out bObj) && bObj is Dictionary<string, object>)
            {
                object usersObj;
                if (((Dictionary<string, object>)bObj).TryGetValue("users", out usersObj) && usersObj is Dictionary<string, object>)
                {
                    foreach (KeyValuePair<string, object> kv in (Dictionary<string, object>)usersObj)
                    {
                        Dictionary<string, object> userData = kv.Value as Dictionary<string, object>;
                        if (userData == null) continue;
                        object cObj;
                        if (!userData.TryGetValue("cards", out cObj) || !(cObj is Dictionary<string, object>)) continue;
                        int count = CardCount((Dictionary<string, object>)cObj, cardId);
                        if (count < 1) continue;
                        owners.Add(new Dictionary<string, object> { { "user", GetString(userData, "displayName", kv.Key) }, { "count", count } });
                    }
                }
            }
            owners.Sort(delegate(Dictionary<string, object> a, Dictionary<string, object> b)
            {
                return Convert.ToInt32(b["count"]).CompareTo(Convert.ToInt32(a["count"]));
            });
            if (owners.Count > limit) owners.RemoveRange(limit, owners.Count - limit);
            return owners.ToArray();
        }

        // Looks up a card's rarity id (normalized, e.g. "legendary") for battle-strength lookups.
        internal string CardRarity(string cardId)
        {
            object[] cards = SettingsCards(ReadSettingsObject());
            foreach (object co in cards)
            {
                Dictionary<string, object> card = co as Dictionary<string, object>;
                if (card == null) continue;
                if (GetString(card, "id", "") == cardId) return NormalizeRarityIdShared(GetString(card, "rarity", ""));
            }
            return "common";
        }

        // Looks up a card's title/booster title purely for display purposes (chat messages, animation).
        internal Dictionary<string, string> CardDisplayInfo(string boosterId, string cardId)
        {
            Dictionary<string, object> settings = ReadSettingsObject();
            object[] cards = SettingsCards(settings);
            object[] boosters = settings.ContainsKey("boosters") && settings["boosters"] is object[] ? (object[])settings["boosters"] : new object[0];
            string cardTitle = cardId;
            string boosterTitle = boosterId;
            string rarity = "common";
            foreach (object co in cards)
            {
                Dictionary<string, object> card = co as Dictionary<string, object>;
                if (card == null) continue;
                if (GetString(card, "id", "") == cardId) { cardTitle = GetString(card, "title", cardId); rarity = GetString(card, "rarity", "common"); break; }
            }
            foreach (object bo in boosters)
            {
                Dictionary<string, object> booster = bo as Dictionary<string, object>;
                if (booster == null) continue;
                if (GetString(booster, "id", "") == boosterId) { boosterTitle = GetString(booster, "title", boosterId); break; }
            }
            return new Dictionary<string, string> { { "cardTitle", cardTitle }, { "boosterTitle", boosterTitle }, { "rarity", rarity } };
        }

        // Performs the full two-sided swap atomically and persists once. A gives cardA (boosterA)
        // and receives cardB (boosterB); B gives cardB and receives cardA. Returns the new counts
        // (A's cardB, B's cardA) or null if either side no longer owns the card being given.
        internal Dictionary<string, object> ApplyTradeSwap(string loginA, string displayA, string boosterA, string cardA,
            string loginB, string displayB, string boosterB, string cardB)
        {
            lock (collectionWriteLock)
            {
                Dictionary<string, object> collections = ParseObject(ReadFile(CollectionsPath(), "{}"));
                Dictionary<string, object> aGives = EnsureUserCards(collections, boosterA, loginA, displayA);
                if (CardCount(aGives, cardA) < 1) return null;
                Dictionary<string, object> bGives = EnsureUserCards(collections, boosterB, loginB, displayB);
                if (CardCount(bGives, cardB) < 1) return null;
                Dictionary<string, object> aGets = EnsureUserCards(collections, boosterB, loginA, displayA);
                Dictionary<string, object> bGets = EnsureUserCards(collections, boosterA, loginB, displayB);

                SetCount(aGives, cardA, CardCount(aGives, cardA) - 1);
                int aNewCardB = CardCount(aGets, cardB) + 1; SetCount(aGets, cardB, aNewCardB);
                SetCount(bGives, cardB, CardCount(bGives, cardB) - 1);
                int bNewCardA = CardCount(bGets, cardA) + 1; SetCount(bGets, cardA, bNewCardA);

                File.WriteAllText(CollectionsPath(), json.Serialize(collections), Encoding.UTF8);
                Broadcast("collections", "{\"updated\":true}");
                return new Dictionary<string, object> { { "aNewCardB", aNewCardB }, { "bNewCardA", bNewCardA } };
            }
        }

        private static object[] SettingsCards(Dictionary<string, object> settings)
        {
            object deckObj;
            if (settings.TryGetValue("deck", out deckObj) && deckObj is Dictionary<string, object>)
            {
                object cardsObj;
                if (((Dictionary<string, object>)deckObj).TryGetValue("cards", out cardsObj) && cardsObj is object[]) return (object[])cardsObj;
            }
            return new object[0];
        }

        private static Dictionary<string, object> FindUserCards(Dictionary<string, object> collections, string boosterId, string login)
        {
            string key = NormalizeUser(login).ToLowerInvariant();
            object bObj;
            if (!collections.TryGetValue(boosterId, out bObj) || !(bObj is Dictionary<string, object>)) return null;
            object usersObj;
            if (!((Dictionary<string, object>)bObj).TryGetValue("users", out usersObj) || !(usersObj is Dictionary<string, object>)) return null;
            object uObj;
            if (!((Dictionary<string, object>)usersObj).TryGetValue(key, out uObj) || !(uObj is Dictionary<string, object>)) return null;
            object cObj;
            if (!((Dictionary<string, object>)uObj).TryGetValue("cards", out cObj) || !(cObj is Dictionary<string, object>)) return null;
            return (Dictionary<string, object>)cObj;
        }

        private static Dictionary<string, object> EnsureUserCards(Dictionary<string, object> collections, string boosterId, string login, string displayName)
        {
            object bObj;
            Dictionary<string, object> booster;
            if (collections.TryGetValue(boosterId, out bObj) && bObj is Dictionary<string, object>) booster = (Dictionary<string, object>)bObj;
            else { booster = new Dictionary<string, object> { { "version", 1 }, { "boosterId", boosterId }, { "users", new Dictionary<string, object>() } }; collections[boosterId] = booster; }
            object usersObj;
            Dictionary<string, object> users;
            if (booster.TryGetValue("users", out usersObj) && usersObj is Dictionary<string, object>) users = (Dictionary<string, object>)usersObj;
            else { users = new Dictionary<string, object>(); booster["users"] = users; }
            string key = NormalizeUser(login).ToLowerInvariant();
            object uObj;
            Dictionary<string, object> userData;
            if (users.TryGetValue(key, out uObj) && uObj is Dictionary<string, object>) userData = (Dictionary<string, object>)uObj;
            else { userData = new Dictionary<string, object> { { "displayName", displayName }, { "cards", new Dictionary<string, object>() } }; users[key] = userData; }
            if (!String.IsNullOrWhiteSpace(displayName)) userData["displayName"] = displayName;
            object cObj;
            Dictionary<string, object> cards;
            if (userData.TryGetValue("cards", out cObj) && cObj is Dictionary<string, object>) cards = (Dictionary<string, object>)cObj;
            else { cards = new Dictionary<string, object>(); userData["cards"] = cards; }
            return cards;
        }

        private static int CardCount(Dictionary<string, object> cards, string cardId)
        {
            object o;
            if (!cards.TryGetValue(cardId, out o)) return 0;
            int v;
            return Int32.TryParse(Convert.ToString(o), out v) ? v : 0;
        }

        private static void SetCount(Dictionary<string, object> cards, string cardId, int value)
        {
            if (value <= 0) cards.Remove(cardId);
            else cards[cardId] = value;
        }

        private static int LevenshteinDistance(string a, string b)
        {
            if (a == b) return 0;
            if (a.Length == 0) return b.Length;
            if (b.Length == 0) return a.Length;
            int[] prev = new int[b.Length + 1];
            int[] cur = new int[b.Length + 1];
            for (int j = 0; j <= b.Length; j++) prev[j] = j;
            for (int i = 1; i <= a.Length; i++)
            {
                cur[0] = i;
                for (int j = 1; j <= b.Length; j++)
                {
                    int cost = a[i - 1] == b[j - 1] ? 0 : 1;
                    cur[j] = Math.Min(Math.Min(cur[j - 1] + 1, prev[j] + 1), prev[j - 1] + cost);
                }
                int[] tmp = prev; prev = cur; cur = tmp;
            }
            return prev[b.Length];
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

        internal Dictionary<string, object> ReadSettingsObject()
        {
            lock (settingsWriteLock)
            {
                Dictionary<string, object> settings = ParseObject(ReadFile(SettingsPath(), "{}"));
                settings["twitch"] = ParseObject(ReadFile(TwitchConfigPath(), "{}"));
                settings["twitchBot"] = ParseObject(ReadFile(TwitchBotConfigPath(), "{}"));
                settings["obs"] = ParseObject(ReadFile(ObsConfigPath(), "{}"));
                if (File.Exists(BoostersPath()))
                {
                    settings["boosters"] = ParseArray(ReadFile(BoostersPath(), "[]"));
                }
                if (File.Exists(CardsPath()))
                {
                    Dictionary<string, object> deck = settings.ContainsKey("deck") && settings["deck"] is Dictionary<string, object>
                        ? (Dictionary<string, object>)settings["deck"]
                        : new Dictionary<string, object>();
                    deck["cards"] = ParseArray(ReadFile(CardsPath(), "[]"));
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
            Broadcast("settings", "{\"updatedAt\":\"" + EscapeJson(DateTime.UtcNow.ToString("o")) + "\"}");
        }

        internal JavaScriptSerializer Serializer
        {
            get { return json; }
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
            byte[] headerBytes = Encoding.UTF8.GetBytes(headers);
            stream.Write(headerBytes, 0, headerBytes.Length);
            stream.Write(body, 0, body.Length);
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

    public sealed class TwitchBridge
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
        private Dictionary<string, object> currentQueueItem;
        private readonly AutoResetEvent queueSignal = new AutoResetEvent(false);
        private readonly AutoResetEvent completionSignal = new AutoResetEvent(false);
        private volatile string awaitingEventId;
        private volatile bool queueRunning;
        private volatile bool queueWorkerStarted;
        private volatile bool queuePaused;

        private readonly object usageLock = new object();
        private Dictionary<string, object> usageData;
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

        private const string DefaultCardsEmpty = "@userName, du besitzt noch keine Karten.";
        private const string DefaultCardsHeader = "@userName, deine Karten:";

        private const double DefaultBattleVariance = 0.6;

        public TwitchBridge(CardPackServer server)
        {
            this.server = server;
        }

        public void Start()
        {
            StartQueueWorkerOnce();
            StartResetTimerOnce();
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
                // The app fulfills every redemption itself the instant it arrives, so it must
                // never sit in Twitch's manual review queue. Twitch's web chat renders an
                // interactive Fulfill/Refund control inline for unfulfilled redemptions - a
                // newer UI element that OBS's bundled (older) Chromium can fail to render,
                // crashing the whole chat dock with "There was an error displaying chat."
                // Skipping the queue means the redemption is auto-fulfilled and chat only ever
                // shows the plain "user redeemed X" line, which is what other tools (e.g.
                // StreamerBot) already do by default - matching why their rewards never hit this.
                { "should_redemptions_skip_request_queue", true },
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
                HandleEventSubMessage(text);
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
            if (GetString(subscription, "type", "") != "channel.channel_points_custom_reward_redemption.add") return;
            Dictionary<string, object> ev = Obj(payload, "event");
            string rewardId = GetString(Obj(ev, "reward"), "id", "");
            string rewardTitle = GetString(Obj(ev, "reward"), "title", "");
            string user = GetString(ev, "user_name", GetString(ev, "user_login", "Viewer"));
            string login = GetString(ev, "user_login", user);

            // Collection showcase reward: not a pack opening - tell the collection overlay to
            // slide through every active booster for this viewer. Routed through the action
            // queue (like every other redemption/chat command) so concurrent triggers are
            // always processed strictly one after another with a pause in between.
            if (ReconcileTrackedReward("showcase", rewardId, rewardTitle))
            {
                Enqueue("showcollection", login, user, "channelpoints");
                return;
            }

            if (!ReconcileTrackedReward("draw", rewardId, rewardTitle))
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

        private static readonly Random RandomSource = new Random();

        private string PickRandomBoosterId()
        {
            Dictionary<string, object> settings = server.ReadSettingsObject();
            object boostersObj;
            if (!settings.TryGetValue("boosters", out boostersObj) || !(boostersObj is object[])) return "";
            var eligible = new List<Dictionary<string, object>>();
            foreach (object item in (object[])boostersObj)
            {
                Dictionary<string, object> booster = item as Dictionary<string, object>;
                if (booster == null) continue;
                if (!GetBool(booster, "enabled", true)) continue;
                object[] cardIds = booster.ContainsKey("cardIds") && booster["cardIds"] is object[] ? (object[])booster["cardIds"] : new object[0];
                if (cardIds.Length == 0) continue;
                if (!BoosterHasEnabledCard(settings, cardIds)) continue;
                eligible.Add(booster);
            }
            if (eligible.Count == 0) return "";

            var scored = new List<Dictionary<string, object>>();
            foreach (Dictionary<string, object> booster in eligible)
            {
                if (GetDouble(booster, "score", 100) > 0) scored.Add(booster);
            }
            List<Dictionary<string, object>> pool = scored.Count > 0 ? scored : eligible;

            double total = 0;
            foreach (Dictionary<string, object> booster in pool) total += Math.Max(0, GetDouble(booster, "score", 100));
            if (total <= 0) return GetString(pool[0], "id", "");

            double cursor;
            lock (RandomSource) cursor = RandomSource.NextDouble() * total;
            foreach (Dictionary<string, object> booster in pool)
            {
                cursor -= Math.Max(0, GetDouble(booster, "score", 100));
                if (cursor <= 0) return GetString(booster, "id", "");
            }
            return GetString(pool[pool.Count - 1], "id", "");
        }

        private static readonly Dictionary<string, double> DefaultRarityWeights = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase)
        {
            { "common", 100 }, { "uncommon", 60 }, { "rare", 30 }, { "epic", 12 }, { "legendary", 4 }, { "holo", 1 }
        };

        private static string NormalizeRarityId(string rarity)
        {
            string r = (rarity ?? "").Trim().ToLowerInvariant();
            if (DefaultRarityWeights.ContainsKey(r)) return r;
            switch (r)
            {
                case "gewöhnlich": case "gewoehnlich": return "common";
                case "ungewöhnlich": case "ungewoehnlich": return "uncommon";
                case "selten": return "rare";
                case "episch": return "epic";
                case "legendär": case "legendaer": return "legendary";
            }
            return "common";
        }

        private static double RarityWeight(Dictionary<string, object> card, Dictionary<string, object> weightsOverride)
        {
            string id = NormalizeRarityId(GetString(card, "rarity", ""));
            if (weightsOverride != null && weightsOverride.ContainsKey(id))
            {
                double v;
                if (Double.TryParse(Convert.ToString(weightsOverride[id]), out v) && v > 0) return v;
            }
            return DefaultRarityWeights.ContainsKey(id) ? DefaultRarityWeights[id] : 1;
        }

        private Dictionary<string, object> FindBooster(Dictionary<string, object> settings, string boosterId)
        {
            object boostersObj;
            if (!settings.TryGetValue("boosters", out boostersObj) || !(boostersObj is object[])) return null;
            foreach (object bo in (object[])boostersObj)
            {
                Dictionary<string, object> b = bo as Dictionary<string, object>;
                if (b != null && GetString(b, "id", "") == boosterId) return b;
            }
            return null;
        }

        // Picks one enabled card from the booster, weighted by rarity weight (mirrors the overlay's
        // weightedPick). Returns null only if the booster has no eligible cards.
        private Dictionary<string, object> PickCardFromBooster(Dictionary<string, object> settings, string boosterId)
        {
            Dictionary<string, object> booster = FindBooster(settings, boosterId);
            if (booster == null) return null;
            object idsObj;
            if (!booster.TryGetValue("cardIds", out idsObj) || !(idsObj is object[])) return null;
            var cardIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (object cid in (object[])idsObj) cardIds.Add(Convert.ToString(cid));

            object deckObj;
            if (!settings.TryGetValue("deck", out deckObj) || !(deckObj is Dictionary<string, object>)) return null;
            object cardsObj;
            if (!((Dictionary<string, object>)deckObj).TryGetValue("cards", out cardsObj) || !(cardsObj is object[])) return null;

            Dictionary<string, object> weights = Obj(settings, "rarityWeights");
            var pool = new List<Dictionary<string, object>>();
            var poolWeights = new List<double>();
            double total = 0;
            foreach (object co in (object[])cardsObj)
            {
                Dictionary<string, object> card = co as Dictionary<string, object>;
                if (card == null) continue;
                if (!cardIds.Contains(GetString(card, "id", ""))) continue;
                object en;
                if (card.TryGetValue("enabled", out en) && en is bool && !(bool)en) continue;
                double w = RarityWeight(card, weights);
                if (w <= 0) continue;
                pool.Add(card);
                poolWeights.Add(w);
                total += w;
            }
            if (pool.Count == 0) return null;
            double cursor;
            lock (RandomSource) cursor = RandomSource.NextDouble() * total;
            for (int i = 0; i < pool.Count; i++)
            {
                cursor -= poolWeights[i];
                if (cursor <= 0) return pool[i];
            }
            return pool[pool.Count - 1];
        }

        private static bool BoosterHasEnabledCard(Dictionary<string, object> settings, object[] cardIds)
        {
            object cardsObj;
            if (!settings.TryGetValue("deck", out cardsObj) || !(cardsObj is Dictionary<string, object>)) return false;
            Dictionary<string, object> deck = (Dictionary<string, object>)cardsObj;
            if (!deck.TryGetValue("cards", out cardsObj) || !(cardsObj is object[])) return false;
            var ids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (object id in cardIds) ids.Add(Convert.ToString(id));
            foreach (object item in (object[])cardsObj)
            {
                Dictionary<string, object> card = item as Dictionary<string, object>;
                if (card == null) continue;
                if (!ids.Contains(GetString(card, "id", ""))) continue;
                object enabledObj;
                if (!card.TryGetValue("enabled", out enabledObj) || enabledObj == null || !(enabledObj is bool) || (bool)enabledObj) return true;
            }
            return false;
        }

        private static double GetDouble(Dictionary<string, object> data, string key, double fallback)
        {
            if (!data.ContainsKey(key) || data[key] == null) return fallback;
            double value;
            return Double.TryParse(Convert.ToString(data[key]), out value) ? value : fallback;
        }

        // ---- Action queue: serializes channel-point redemptions and chat commands so that
        // concurrent triggers from multiple viewers are always processed strictly one after
        // another, with a fixed pause between actions. ----

        public void Enqueue(string kind, string login, string displayName, string source)
        {
            Enqueue(kind, login, displayName, source, null);
        }

        // extra: additional payload the item should carry (e.g. the ranking type/lists), merged
        // into the queue item so ProcessQueueItem can broadcast it once this item's turn comes up.
        public void Enqueue(string kind, string login, string displayName, string source, Dictionary<string, object> extra)
        {
            var item = new Dictionary<string, object>
            {
                { "id", Guid.NewGuid().ToString("N") },
                { "kind", kind },
                { "user", displayName },
                { "userLogin", login },
                { "source", source },
                { "triggeredAt", DateTime.UtcNow.ToString("o") }
            };
            if (extra != null)
            {
                foreach (KeyValuePair<string, object> kv in extra) item[kv.Key] = kv.Value;
            }
            lock (queueLock) { actionQueue.Add(item); }
            BroadcastQueue();
            queueSignal.Set();
        }

        public object[] GetQueueItems()
        {
            lock (queueLock)
            {
                var list = new List<object>();
                // An open trade request runs alongside the draw queue (it does not block draws) but
                // is shown first as a processing item until it is accepted, declined or times out.
                Dictionary<string, object> trade = activeTrade;
                if (trade != null)
                {
                    var tcopy = new Dictionary<string, object>(trade);
                    tcopy["processing"] = true;
                    tcopy["user"] = GetString(trade, "fromUser", "");
                    tcopy["userLogin"] = GetString(trade, "fromLogin", "");
                    list.Add(tcopy);
                }
                // The in-flight item is shown next (with a "processing" flag) so the queue tab
                // reflects the event currently being handled, not just those still waiting.
                if (currentQueueItem != null)
                {
                    var copy = new Dictionary<string, object>(currentQueueItem);
                    copy["processing"] = true;
                    list.Add(copy);
                }
                list.AddRange(actionQueue);
                return list.ToArray();
            }
        }

        private void BroadcastQueue()
        {
            server.Broadcast("queue", server.Serializer.Serialize(new Dictionary<string, object> { { "items", GetQueueItems() }, { "paused", queuePaused } }));
        }

        // Called by the overlay (POST /api/queue/complete) once it has finished playing the
        // animation for a given event. Releases the queue worker so it can proceed to the
        // 500ms gap and then the next item.
        // If more than one overlay page is showing the same source at once (e.g. the pack source
        // open in both OBS AND Meld Studio simultaneously), each one independently plays the
        // animation and independently posts /api/queue/complete for the same eventId. Without
        // this guard, every extra ack would re-send the post-draw chat message, duplicating it.
        private readonly object completionLock = new object();
        private string lastCompletedEventId;

        public void CompleteQueueItem(string eventId, string cardTitle, string boosterTitle)
        {
            if (String.IsNullOrEmpty(eventId)) return;
            if (eventId != awaitingEventId) return;
            bool isFirstAck;
            lock (completionLock)
            {
                isFirstAck = lastCompletedEventId != eventId;
                lastCompletedEventId = eventId;
            }
            if (isFirstAck)
            {
                // The animation just finished and the overlay reported which card was drawn, so
                // the post-animation chat message (channel points and/or !pack) can now be sent by name.
                try
                {
                    Dictionary<string, object> item;
                    lock (queueLock) item = currentQueueItem;
                    if (item != null && GetString(item, "kind", "") == "draw") SendDrawPostMessage(item, cardTitle, boosterTitle);
                }
                catch { }
            }
            completionSignal.Set();
        }

        private void SendDrawPostMessage(Dictionary<string, object> item, string cardTitle, string boosterTitle)
        {
            string source = GetString(item, "source", "");
            string user = GetString(item, "user", "Viewer");
            Dictionary<string, object> settings = server.ReadSettingsObject();
            string template = null;
            if (source == "chat")
            {
                // The !pack "Nachricht bei Einloesung" - always sent (no separate toggle).
                template = GetString(Obj(Obj(settings, "chatCommands"), "pack"), "successMessage", "");
            }
            else if (source == "channelpoints")
            {
                Dictionary<string, object> draw = Obj(settings, "draw");
                if (GetBool(draw, "postMessageEnabled", false)) template = GetString(draw, "postMessage", "");
            }
            if (String.IsNullOrWhiteSpace(template)) return;
            // The server picked the card, so its titles (stored on the item) are authoritative;
            // the overlay-reported ones are only a fallback for older cached overlays.
            string cardT = GetString(item, "cardTitle", "");
            if (String.IsNullOrEmpty(cardT)) cardT = cardTitle ?? "";
            string boosterT = GetString(item, "boosterTitle", "");
            if (String.IsNullOrEmpty(boosterT)) boosterT = boosterTitle ?? "";
            string msg = template
                .Replace("@userName", "@" + user)
                .Replace("[Kartenname]", cardT)
                .Replace("[Boostername]", boosterT);
            SendChatMessageSafe(msg);
        }

        public bool QueuePaused { get { return queuePaused; } }

        public void SetQueuePaused(bool paused)
        {
            queuePaused = paused;
            server.Log("queue", "info", paused ? "Warteschlange pausiert - Eintraege werden gesammelt." : "Warteschlange fortgesetzt.");
            if (!paused) queueSignal.Set();
            BroadcastQueue();
        }

        public void RemoveQueueItem(string id)
        {
            if (String.IsNullOrEmpty(id)) return;
            lock (queueLock)
            {
                actionQueue.RemoveAll(delegate(Dictionary<string, object> item) { return GetString(item, "id", "") == id; });
            }
            BroadcastQueue();
        }

        public void ClearQueue()
        {
            lock (queueLock) actionQueue.Clear();
            BroadcastQueue();
        }

        // Safety upper bound for how long to wait on the overlay's completion ack. Generously
        // covers the real animation length so it is effectively never hit when an overlay is
        // connected, but still bounds the wait if no overlay acks (e.g. OBS source closed).
        private int ComputeQueueTimeoutMs(Dictionary<string, object> item)
        {
            string kind = GetString(item, "kind", "");
            if (kind == "showcollection")
            {
                // The showcase overlay "page-flips" through a booster's cards 9 at a time (see
                // collection.js CARDS_PER_PAGE) instead of showing them all at once, so a booster
                // with many cards takes several page-hold intervals, not just one. This must match
                // that client-side page count, or the timeout undercounts and the server gives up
                // waiting for the completion ack while the overlay is still mid page-flip - which
                // then shows as "done" in the Queue tab while the animation keeps playing.
                const int cardsPerPage = 9;
                Dictionary<string, object> settings = server.ReadSettingsObject();
                int totalPages = 0;
                int boosterCount = 0;
                object boostersObj;
                if (settings.TryGetValue("boosters", out boostersObj) && boostersObj is object[])
                {
                    foreach (object bo in (object[])boostersObj)
                    {
                        Dictionary<string, object> booster = bo as Dictionary<string, object>;
                        if (booster == null) continue;
                        int cardCount = 0;
                        object cardIdsObj;
                        if (booster.TryGetValue("cardIds", out cardIdsObj) && cardIdsObj is object[])
                        {
                            cardCount = ((object[])cardIdsObj).Length;
                        }
                        if (cardCount == 0) continue;
                        boosterCount++;
                        totalPages += (int)Math.Ceiling(cardCount / (double)cardsPerPage);
                    }
                }
                if (totalPages == 0) { totalPages = 1; boosterCount = 1; }
                int secondsPerPage = 12;
                object showcaseObj;
                if (settings.TryGetValue("showcase", out showcaseObj) && showcaseObj is Dictionary<string, object>)
                {
                    secondsPerPage = Math.Max(2, GetInt((Dictionary<string, object>)showcaseObj, "secondsPerBooster", 12));
                }
                // Per page: hold time + ~300ms flip transition. Per booster: ~1s slide in/out.
                return totalPages * (secondsPerPage * 1000 + 300) + boosterCount * 1000 + 8000;
            }
            if (kind == "ranking")
            {
                // Battle ranking cycles through up to 4 phases; card/trade ranking show one.
                // GetInt on the item itself: displaySeconds was stored on it by HandleRankingCommand.
                int displaySeconds = Math.Max(2, GetInt(item, "displaySeconds", 8));
                string rankingType = GetString(item, "type", "card");
                int phases = rankingType == "battle" ? 4 : 1;
                return phases * (displaySeconds * 1000 + 500) + 8000;
            }
            if (kind == "trade")
            {
                // Longest configured trade animation duration ("long" ~9s) plus a safety margin.
                return 20000;
            }
            if (kind == "battle")
            {
                // HP-Leisten-Duell is explicitly capped at ~28s client-side (see battle.js
                // maxTotalMs); clash/ranged rounds are shorter. Generous ceiling either way.
                return 40000;
            }
            // Draw animation is a fixed sequence (~7s) plus reveal time; 30s is a safe ceiling.
            return 30000;
        }

        private readonly object queueWorkerStartLock = new object();

        // Start() (and RestartQuietly(), called after every reward sync/delete) can run on
        // multiple concurrent request threads. The previous "if (queueWorkerStarted) return;"
        // check-then-set was not atomic, so two overlapping calls could both pass the check
        // before either flipped the flag, spawning TWO independent QueueLoop threads. Both then
        // shared the same awaitingEventId/completionSignal fields, so one thread's dequeue could
        // stomp the other's - e.g. showcollection waiting for its ack while a second thread
        // immediately dequeued and broadcast the next draw, playing both animations at once.
        // A real lock makes "start the worker" atomic, guaranteeing exactly one QueueLoop ever runs.
        private void StartQueueWorkerOnce()
        {
            lock (queueWorkerStartLock)
            {
                if (queueWorkerStarted) return;
                queueWorkerStarted = true;
                queueRunning = true;
                var worker = new Thread(QueueLoop);
                worker.IsBackground = true;
                worker.Start();
            }
        }

        private void QueueLoop()
        {
            while (queueRunning)
            {
                queueSignal.WaitOne(1000);
                // While paused, keep collecting incoming events but don't process any.
                if (queuePaused) continue;
                Dictionary<string, object> item = null;
                lock (queueLock)
                {
                    if (actionQueue.Count > 0)
                    {
                        item = actionQueue[0];
                        actionQueue.RemoveAt(0);
                        currentQueueItem = item;
                    }
                }
                if (item == null) continue;

                // Arm the completion gate BEFORE firing the event so an ack can never be missed,
                // then broadcast the queue so the in-flight item is visible as "processing".
                string eventId = GetString(item, "id", "");
                awaitingEventId = eventId;
                completionSignal.Reset();
                BroadcastQueue();

                try { ProcessQueueItem(item); }
                catch (Exception ex) { server.Log("queue", "error", "Queue-Verarbeitung fehlgeschlagen: " + ex.Message); }

                // Wait until the overlay reports the animation finished (POST /api/queue/complete),
                // so the NEXT event is only fired once the current one has fully played out. A
                // per-kind safety timeout prevents a permanent stall if no overlay is connected.
                bool acked = completionSignal.WaitOne(ComputeQueueTimeoutMs(item));
                if (!acked)
                {
                    server.Log("queue", "warn", "Keine Abschluss-Rueckmeldung vom Overlay fuer \"" + GetString(item, "kind", "") + "\" - nach Timeout fortgefahren. Ist die passende OBS-Quelle geoeffnet und aktuell?");
                }
                awaitingEventId = null;

                // Only after completion: the mandatory 500ms gap before the next action.
                Thread.Sleep(500);
                lock (queueLock) { currentQueueItem = null; }
                BroadcastQueue();
            }
        }

        private void ProcessQueueItem(Dictionary<string, object> item)
        {
            string kind = GetString(item, "kind", "");
            string user = GetString(item, "user", "Viewer");
            string login = GetString(item, "userLogin", user);
            string source = GetString(item, "source", "");

            if (kind == "ranking")
            {
                var rankingEvent = new Dictionary<string, object>(item);
                rankingEvent["eventId"] = GetString(item, "id", DateTime.UtcNow.Ticks.ToString());
                rankingEvent.Remove("id");
                rankingEvent.Remove("kind");
                rankingEvent.Remove("user");
                rankingEvent.Remove("userLogin");
                rankingEvent.Remove("source");
                rankingEvent.Remove("triggeredAt");
                server.Broadcast("ranking", server.Serializer.Serialize(rankingEvent));
                return;
            }

            if (kind == "showcollection")
            {
                server.Log("draw", "info", user + " hat die Sammlung angefordert.");
                var showEvent = new Dictionary<string, object>
                {
                    { "eventId", GetString(item, "id", DateTime.UtcNow.Ticks.ToString()) },
                    { "user", user },
                    { "userLogin", login },
                    { "source", source }
                };
                server.Broadcast("showcollection", server.Serializer.Serialize(showEvent));
                return;
            }

            if (kind == "trade" || kind == "battle")
            {
                // trade/battle carry their full event payload (cards, users, result...) as "extra"
                // on Enqueue - strip the queue-internal bookkeeping fields and broadcast the rest
                // as-is, same pattern as "ranking" above.
                var animEvent = new Dictionary<string, object>(item);
                animEvent["eventId"] = GetString(item, "id", DateTime.UtcNow.Ticks.ToString());
                animEvent.Remove("id");
                animEvent.Remove("kind");
                animEvent.Remove("user");
                animEvent.Remove("userLogin");
                animEvent.Remove("source");
                animEvent.Remove("triggeredAt");
                server.Broadcast(kind, server.Serializer.Serialize(animEvent));
                return;
            }

            if (kind == "draw")
            {
                // Booster AND card are picked here on the server (weighted by booster score and
                // rarity weight). Broadcasting the concrete cardId means every overlay shows the
                // same card, and - crucially - the server knows the drawn card/booster by name, so
                // the post-animation chat message works regardless of the overlay's cached version.
                string boosterId = PickRandomBoosterId();
                if (String.IsNullOrWhiteSpace(boosterId))
                {
                    server.Log("draw", "error", user + " hat ein Kartenpack ausgeloest, aber kein Booster war verfuegbar.");
                    return;
                }
                Dictionary<string, object> settings = server.ReadSettingsObject();
                Dictionary<string, object> booster = FindBooster(settings, boosterId);
                Dictionary<string, object> card = PickCardFromBooster(settings, boosterId);
                string cardId = card != null ? GetString(card, "id", "") : "";
                string cardTitle = card != null ? GetString(card, "title", "") : "";
                string boosterTitle = booster != null ? GetString(booster, "title", "") : "";
                item["cardTitle"] = cardTitle;
                item["boosterTitle"] = boosterTitle;
                server.Log("draw", "info", user + " hat \"" + cardTitle + "\" aus \"" + boosterTitle + "\" gezogen.");
                var drawEvent = new Dictionary<string, object>
                {
                    { "eventId", GetString(item, "id", DateTime.UtcNow.Ticks.ToString()) },
                    { "user", user },
                    { "userLogin", login },
                    { "boosterId", boosterId },
                    { "cardId", cardId },
                    { "source", source }
                };
                server.Broadcast("draw", server.Serializer.Serialize(drawEvent));
            }
        }

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
                GetBool(Obj(cc, "collection"), "enabled", true) ||
                GetBool(Obj(cc, "trade"), "enabled", true) ||
                GetBool(Obj(cc, "tradeyes"), "enabled", true) ||
                GetBool(Obj(cc, "tradeno"), "enabled", true);

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
                HandleChatEventSubMessage(text);
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
            ProcessChatMessage(login, displayName, chatText);
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

        // Part of !collection's chat output (alongside the overlay showcase) - lists every card
        // the caller owns as plain text, split across multiple messages if needed.
        private void HandleCardsCommand(string login, string displayName, Dictionary<string, object> collectionCfg)
        {
            List<Dictionary<string, string>> owned = server.GetUserOwnedCardTypes(login);
            if (owned.Count == 0)
            {
                SendChatMessageSafe(GetString(collectionCfg, "emptyMessage", DefaultCardsEmpty).Replace("@userName", "@" + displayName));
                return;
            }

            var entries = new List<KeyValuePair<string, string>>();
            foreach (Dictionary<string, string> entry in owned)
            {
                int count = server.GetCardCount(login, entry["boosterId"], entry["cardId"]);
                Dictionary<string, string> info = server.CardDisplayInfo(entry["boosterId"], entry["cardId"]);
                string name = count > 1 ? info["cardTitle"] + " x" + count : info["cardTitle"];
                entries.Add(new KeyValuePair<string, string>(info["cardTitle"], name));
            }
            // Sorted alphabetically by card name (A -> Z).
            entries.Sort(delegate (KeyValuePair<string, string> a, KeyValuePair<string, string> b)
            {
                return StringComparer.OrdinalIgnoreCase.Compare(a.Key, b.Key);
            });
            var names = new List<string>();
            foreach (KeyValuePair<string, string> entry in entries) names.Add(entry.Value);

            string header = GetString(collectionCfg, "headerMessage", DefaultCardsHeader).Replace("@userName", "@" + displayName);
            SendCardListChunked(header, names);
        }

        // Splits the (potentially long) card name list into multiple chat messages that each
        // stay under Twitch's length limit, numbering them "(1/3)" etc. when there's more than one.
        private void SendCardListChunked(string header, List<string> names)
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
                        SendChatMessageSafe(prefix + chunks[i]);
                    }
                }
                catch (Exception ex)
                {
                    server.Log("draw", "error", "SendCardListChunked-Hintergrundtask fehlgeschlagen: " + ex.Message);
                }
            });
        }

        private void SendChatMessageSafe(string message)
        {
            try { SendChatMessage(message); }
            catch (Exception ex) { server.Log("twitch", "error", "Chat-Nachricht konnte nicht gesendet werden: " + ex.Message); }
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

        // ---- Command parsing + per-user usage/cooldown tracking ----

        private void ProcessChatMessage(string login, string displayName, string text)
        {
            Dictionary<string, object> settings = server.ReadSettingsObject();
            Dictionary<string, object> cc = Obj(settings, "chatCommands");
            text = text.Trim();
            if (text.Length == 0) return;

            Dictionary<string, object> pack = Obj(cc, "pack");
            Dictionary<string, object> collection = Obj(cc, "collection");
            Dictionary<string, object> trade = Obj(cc, "trade");
            Dictionary<string, object> tradeYes = Obj(cc, "tradeyes");
            Dictionary<string, object> tradeNo = Obj(cc, "tradeno");
            Dictionary<string, object> battle = Obj(cc, "battle");
            Dictionary<string, object> battleYes = Obj(cc, "battleyes");
            Dictionary<string, object> battleNo = Obj(cc, "battleno");
            Dictionary<string, object> ranking = Obj(cc, "ranking");

            if (MatchesCommand(text, pack))
            {
                if (GetBool(pack, "enabled", true)) HandlePackCommand(login, displayName, pack);
                return;
            }
            if (MatchesCommand(text, collection))
            {
                // No usage limit, no cooldown, no tracking for the collection command. Besides
                // the overlay showcase, it can also list the caller's card names in chat text
                // (own toggle, on by default) - useful when no OBS source is being watched.
                if (GetBool(collection, "enabled", true))
                {
                    Enqueue("showcollection", login, displayName, "chat");
                    if (GetBool(collection, "chatOutputEnabled", true))
                    {
                        try { HandleCardsCommand(login, displayName, collection); }
                        catch (Exception ex) { server.Log("draw", "error", "HandleCardsCommand fehlgeschlagen: " + ex.Message + " | " + ex.StackTrace); }
                    }
                }
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
        }

        private static bool MatchesCommand(string text, Dictionary<string, object> cmd)
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
                    SendChatMessageSafe(message);
                    return;
                }

                int count = GetInt(entry, "count", 0);
                if (maxUses > 0 && count >= maxUses)
                {
                    string resetTimeText = FormatLocalTime(ParseDate(GetString(usageData, "nextGlobalResetAt", "")));
                    string message = GetString(packCfg, "limitMessage", DefaultLimitMessage)
                        .Replace("@userName", "@" + displayName)
                        .Replace("[Uhrzeit]", resetTimeText);
                    SendChatMessageSafe(message);
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

        // ---- Trade system: !trade / !tradeyes / !tradeno ----

        private static string ArgsAfterCommand(string text, Dictionary<string, object> cmd)
        {
            string full = GetString(cmd, "prefix", "") + GetString(cmd, "command", "");
            if (text.Length <= full.Length) return "";
            return text.Substring(full.Length).Trim();
        }

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
        }

        // ---- Battle system: !battle / !battleyes / !battleno ----

        private void HandleBattleCommand(string login, string displayName, string args, Dictionary<string, object> battleCfg)
        {
            string partnerRaw = args.Trim().TrimStart('@');
            if (partnerRaw.Length == 0) return;
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
                    { "winnerUser", winnerUser }, { "loserUser", loserUser }
                };
                // Routed through the same queue as draw/showcollection/ranking so the battle
                // animation never overlaps another - it used to broadcast directly, which let it
                // play at the same time as an in-progress pack-opening or collection showcase.
                Enqueue("battle", fromLogin, fromUser, "chat", battleEvent);
                server.Log("commands", "info", winnerUser + " gewann das Kartenduell gegen " + loserUser + " (" + Math.Max(winsA, winsB) + ":" + Math.Min(winsA, winsB) + ") und erhielt " + prizeInfo["cardTitle"] + ".");

                // The result message is sent AFTER the animation has had time to play out, not
                // immediately - otherwise chat spoils the winner before the OBS animation reveals
                // it. This is a time-based estimate (not an ack from the overlay) so it never
                // blocks this thread from handling the next chat command while a duel animation
                // (up to ~28s for a long HP-Leisten-Duell) is still playing.
                bool animEnabled = GetBool(battleAnimForStyle, "enabled", false);
                bool sendChat = animEnabled ? GetBool(battleAnimForStyle, "sendChat", true) : true;
                if (sendChat)
                {
                    string msg = GetString(yesCfg, "resultMessage", DefaultBattleResult)
                        .Replace("@userNameA", "@" + winnerUser)
                        .Replace("@userNameB", "@" + loserUser)
                        .Replace("[SiegeA]", winnerIsA ? winsA.ToString() : winsB.ToString())
                        .Replace("[SiegeB]", winnerIsA ? winsB.ToString() : winsA.ToString())
                        .Replace("[GewonneneKarte]", prizeInfo["cardTitle"])
                        .Replace("[BoosterGewonnen]", prizeInfo["boosterTitle"]);
                    int delayMs = animEnabled ? EstimateBattleAnimationMs(useHpElimination, battleAnimForStyle, hpResult) : 0;
                    if (delayMs > 0)
                    {
                        string msgToSend = msg;
                        int waitMs = delayMs;
                        Task.Factory.StartNew(delegate { Thread.Sleep(waitMs); SendChatMessageSafe(msgToSend); });
                    }
                    else
                    {
                        SendChatMessageSafe(msg);
                    }
                }

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

        // One round: strength (from rarity, via the configurable table) times a random variance
        // factor decides the winner. Returns true if cardA wins.
        private bool RollRound(Dictionary<string, string> cardA, Dictionary<string, string> cardB, Dictionary<string, object> strengthCfg, double variance)
        {
            double strengthA = CardBattleStrength(cardA["cardId"], strengthCfg);
            double strengthB = CardBattleStrength(cardB["cardId"], strengthCfg);
            double rollA = strengthA * (1 + BattleRandom.NextDouble() * variance);
            double rollB = strengthB * (1 + BattleRandom.NextDouble() * variance);
            return rollA >= rollB;
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
        // at a time, trading hits (damage = attacker strength x variance) until one card's HP
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
                        dmg = strengthA * (1 + BattleRandom.NextDouble() * variance);
                        hpB = Math.Max(0, hpB - dmg);
                        hits.Add(new Dictionary<string, object> { { "attacker", "A" }, { "damage", Math.Round(dmg, 1) }, { "hpAfter", Math.Round(hpB, 1) } });
                        if (hpB <= 0) matchupWinner = "A";
                    }
                    else
                    {
                        dmg = strengthB * (1 + BattleRandom.NextDouble() * variance);
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
        }

        // ---- Ranking command: !ranking battle / !ranking <Kartenname> ----

        // Deliberately silent in chat (by design): the result is shown exclusively in the
        // dedicated OBS ranking overlay. Unknown card names are silently ignored too.
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
            if (!Convert.ToBoolean(card["found"])) return;
            string cardId = GetString(card, "cardId", "");
            string boosterId = GetString(card, "boosterId", "");
            var cardPayload = new Dictionary<string, object>
            {
                { "type", "card" },
                { "displaySeconds", displaySeconds },
                { "cardId", cardId },
                { "boosterId", boosterId },
                { "cardTitle", GetString(card, "cardTitle", "") },
                { "boosterTitle", GetString(card, "boosterTitle", "") },
                { "owners", server.GetTopCardOwners(boosterId, cardId, 5) }
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

        private static DateTime ComputeNextResetAt(Dictionary<string, object> packCfg, DateTime fromUtc)
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
        }

        // Matches an incoming redemption against settings.draw or settings.showcase. If the id
        // doesn't match but the (normalized) title still does, the reward was evidently deleted
        // and recreated on Twitch's side under the same name - the live id from this event is
        // adopted automatically so the stale id stops causing "nothing happened"/"not found"
        // failures on every future redemption and on the next manual save/delete.
        private bool ReconcileTrackedReward(string holderKey, string rewardId, string rewardTitle)
        {
            Dictionary<string, object> settings = server.ReadSettingsObject();
            Dictionary<string, object> holder = Obj(settings, holderKey);
            if (holder.Count == 0) return false;
            if (StringArrayContains(holder, "rewardIds", rewardId)) return true;

            string name = GetString(holder, "rewardName", "");
            if (String.IsNullOrWhiteSpace(name) || Normalize(name) != Normalize(rewardTitle)) return false;

            holder["rewardIds"] = new object[] { rewardId };
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
                // See SyncReward for why this must always be true (auto-fulfilled redemptions
                // avoid the inline Fulfill/Refund UI that crashes OBS's Twitch chat dock).
                { "should_redemptions_skip_request_queue", true },
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
            server.WriteSettingsObject(settings);
            return settings;
        }

        private void RestartQuietly()
        {
            try { Start(); } catch { }
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

        private Dictionary<string, object> TwitchGet(string url, string clientId, string token)
        {
            using (var client = new WebClient())
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
            using (var client = new WebClient())
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

    public sealed class EventLog
    {
        private const int MaxEntries = 1000;
        private readonly string path;
        private readonly JavaScriptSerializer json;
        private readonly object entriesLock = new object();
        private List<Dictionary<string, object>> entries = new List<Dictionary<string, object>>();

        public EventLog(string path, JavaScriptSerializer json)
        {
            this.path = path;
            this.json = json;
            Load();
        }

        private void Load()
        {
            try
            {
                if (!File.Exists(path)) return;
                object parsed = json.DeserializeObject(File.ReadAllText(path, Encoding.UTF8));
                if (parsed is object[])
                {
                    var loaded = new List<Dictionary<string, object>>();
                    foreach (object item in (object[])parsed)
                    {
                        if (item is Dictionary<string, object>) loaded.Add((Dictionary<string, object>)item);
                    }
                    lock (entriesLock) entries = loaded;
                }
            }
            catch
            {
            }
        }

        public void Add(string category, string level, string message)
        {
            var entry = new Dictionary<string, object>
            {
                { "timestamp", DateTime.UtcNow.ToString("o") },
                { "category", category },
                { "level", level },
                { "message", message }
            };
            lock (entriesLock)
            {
                entries.Add(entry);
                while (entries.Count > MaxEntries) entries.RemoveAt(0);
                Persist();
            }
        }

        public object[] GetAll()
        {
            lock (entriesLock) return entries.ToArray();
        }

        public void Clear()
        {
            lock (entriesLock)
            {
                entries.Clear();
                Persist();
            }
        }

        private void Persist()
        {
            try
            {
                File.WriteAllText(path, json.Serialize(entries), Encoding.UTF8);
            }
            catch
            {
            }
        }
    }

    public sealed class SseClient
    {
        private readonly TcpClient client;
        private readonly NetworkStream stream;
        private readonly object writeLock;

        public SseClient(TcpClient client, NetworkStream stream)
        {
            this.client = client;
            this.stream = stream;
            writeLock = new object();
        }

        public bool Write(string text)
        {
            try
            {
                byte[] bytes = Encoding.UTF8.GetBytes(text);
                lock (writeLock)
                {
                    stream.Write(bytes, 0, bytes.Length);
                    stream.Flush();
                }
                return true;
            }
            catch
            {
                return false;
            }
        }

        public void Close()
        {
            try { client.Close(); } catch { }
        }
    }

    public sealed class HttpRequest
    {
        public string Method;
        public string Path;
        public string Body;
    }
}
