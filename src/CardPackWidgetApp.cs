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
        public const string Version = "2.12.22";
        public const string ReleaseDate = "2026-07-22";
        public const string GitHubRepo = "Bittersweet1987/StreamerCardWidget";

        // Changes on every app start. The overlay pages use this as the cache-buster for ALL
        // their assets (CSS + JS, fetched at runtime via /api/version) and reload themselves when
        // an SSE reconnect delivers a different BootId. Files on disk can only change while the
        // app is stopped (update/redeploy), so "new BootId" == "assets may have changed" - this is
        // what makes OBS/Meld browser sources pick up updates without any manual cache refresh.
        public static readonly string BootId = DateTime.UtcNow.Ticks.ToString();
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
                // Echoing the full settings back (cards/boosters with base64 images, easily
                // 10MB+) doubled every save's cost for a response no caller actually reads -
                // every admin.js call site does "await saveSettings(settings)" and discards the
                // result. A plain ack makes autosave noticeably faster, especially with many cards.
                SendJson(stream, 200, "{\"ok\":true}");
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
            string targetLower = target.ToLowerInvariant();
            string bestTitle = "";
            double bestScore = 0;
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
                double score = TitleSimilarity(title.Trim().ToLowerInvariant(), targetLower);
                if (score > bestScore) { bestScore = score; bestTitle = title; }
            }
            // Only offer a suggestion once it's a plausible typo/partial match - a raw "closest of
            // all cards" (the old behavior) happily proposed a totally unrelated short title just
            // because it needed fewer character edits than a long, otherwise-very-close title.
            result["suggestion"] = bestScore >= 0.45 ? bestTitle : "";
            return result;
        }

        // Used by the live-ticker broadcast (see CompleteQueueItem) to attach the drawn card's
        // rarity for color-coding, without duplicating the whole ResolveCardByName lookup.
        internal string GetCardRarityByTitle(string title)
        {
            if (String.IsNullOrWhiteSpace(title)) return "common";
            Dictionary<string, object> settings = ReadSettingsObject();
            foreach (object co in SettingsCards(settings))
            {
                Dictionary<string, object> card = co as Dictionary<string, object>;
                if (card == null) continue;
                if (String.Equals(GetString(card, "title", "").Trim(), title.Trim(), StringComparison.OrdinalIgnoreCase))
                    return GetString(card, "rarity", "common");
            }
            return "common";
        }

        // Similarity in [0,1], 1 = identical. Plain Levenshtein distance is unnormalized (a typo
        // in a long title scores "worse" than an unrelated but short title) and ignores that users
        // often type only part of a card's name - both of which made "did you mean" suggestions
        // feel essentially random. This normalizes by length and gives a straight substring match
        // (typing part of the real name) a strong boost over an edit-distance-only comparison.
        private static double TitleSimilarity(string title, string target)
        {
            if (title.Length == 0 || target.Length == 0) return 0;
            if (title.Contains(target) || target.Contains(title))
            {
                double coverage = (double)Math.Min(title.Length, target.Length) / Math.Max(title.Length, target.Length);
                return 0.75 + 0.25 * coverage;
            }
            int distance = LevenshteinDistance(title, target);
            int maxLen = Math.Max(title.Length, target.Length);
            return 1.0 - (double)distance / maxLen;
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

        // Same result as calling GetUserOwnedCardTypes + GetCardCount + CardDisplayInfo per card,
        // but reads collections.json and settings.json exactly once each regardless of how many
        // card types the user owns - the per-card versions each independently re-read and
        // re-parsed the whole file, including settings.json's several-MB of base64 card images;
        // with dozens of owned card types (see !collection's chat listing) that turned a
        // near-instant lookup into a multi-second-to-multi-minute one.
        internal List<Dictionary<string, string>> GetUserOwnedCardsWithInfo(string login)
        {
            var result = new List<Dictionary<string, string>>();
            string key = NormalizeUser(login).ToLowerInvariant();
            Dictionary<string, object> collections = ParseObject(ReadFile(CollectionsPath(), "{}"));
            Dictionary<string, object> settings = ReadSettingsObject();
            object[] cardsArr = SettingsCards(settings);
            object[] boostersArr = settings.ContainsKey("boosters") && settings["boosters"] is object[] ? (object[])settings["boosters"] : new object[0];

            var cardInfoById = new Dictionary<string, Dictionary<string, string>>();
            foreach (object co in cardsArr)
            {
                Dictionary<string, object> card = co as Dictionary<string, object>;
                if (card == null) continue;
                string id = GetString(card, "id", "");
                if (String.IsNullOrEmpty(id)) continue;
                cardInfoById[id] = new Dictionary<string, string> { { "title", GetString(card, "title", id) }, { "rarity", GetString(card, "rarity", "common") } };
            }
            var boosterTitleById = new Dictionary<string, string>();
            foreach (object bo in boostersArr)
            {
                Dictionary<string, object> booster = bo as Dictionary<string, object>;
                if (booster == null) continue;
                string id = GetString(booster, "id", "");
                if (String.IsNullOrEmpty(id)) continue;
                boosterTitleById[id] = GetString(booster, "title", id);
            }

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
                    int count = CardCount(cards, cardId);
                    if (count < 1) continue;
                    string cardTitle = cardId;
                    string rarity = "common";
                    Dictionary<string, string> info;
                    if (cardInfoById.TryGetValue(cardId, out info)) { cardTitle = info["title"]; rarity = info["rarity"]; }
                    string boosterTitle;
                    if (!boosterTitleById.TryGetValue(kv.Key, out boosterTitle)) boosterTitle = kv.Key;
                    result.Add(new Dictionary<string, string>
                    {
                        { "boosterId", kv.Key }, { "cardId", cardId }, { "cardTitle", cardTitle },
                        { "boosterTitle", boosterTitle }, { "rarity", rarity }, { "count", count.ToString() }
                    });
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

        internal static bool KnownRarityId(string rarity)
        {
            return !String.IsNullOrEmpty(rarity) && KnownRarityIds.Contains(rarity);
        }

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

        // ---- Live-ticker persistence: last few entries survive an app restart ----

        private readonly object liveTickerHistoryFileLock = new object();

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

        internal string CardRarity(string cardId)
        {
            lock (cardRarityCacheLock)
            {
                if (cardRarityCache == null)
                {
                    cardRarityCache = new Dictionary<string, string>();
                    object[] cards = SettingsCards(ReadSettingsObject());
                    foreach (object co in cards)
                    {
                        Dictionary<string, object> card = co as Dictionary<string, object>;
                        if (card == null) continue;
                        string id = GetString(card, "id", "");
                        if (String.IsNullOrEmpty(id)) continue;
                        cardRarityCache[id] = NormalizeRarityIdShared(GetString(card, "rarity", ""));
                    }
                }
                string rarity;
                return cardRarityCache.TryGetValue(cardId, out rarity) ? rarity : "common";
            }
        }

        private void InvalidateCardRarityCache()
        {
            lock (cardRarityCacheLock) { cardRarityCache = null; }
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

        // Bulk version of RemoveCardCopies for "!dustall" - dusts EVERY duplicate (keeping exactly
        // 1) of every card type the viewer owns whose rarity rank is STRICTLY BELOW maxRarityRank
        // (see TwitchBridge.GetRarityRank / the dustAllRarity per-user setting), in one single
        // collections.json read+write instead of one file round-trip per card type (see CLAUDE.md's
        // "Batch-Loading statt Pro-Item-Reads" - this can otherwise touch dozens of card types).
        // Returns one entry per card type that was actually reduced.
        internal List<Dictionary<string, string>> DustAllDuplicates(string login, string displayName, int maxRarityRank)
        {
            var result = new List<Dictionary<string, string>>();
            string key = NormalizeUser(login).ToLowerInvariant();
            lock (collectionWriteLock)
            {
                Dictionary<string, object> collections = ParseObject(ReadFile(CollectionsPath(), "{}"));
                Dictionary<string, object> settings = ReadSettingsObject();
                object[] cardsArr = SettingsCards(settings);
                var cardInfoById = new Dictionary<string, Dictionary<string, string>>();
                foreach (object co in cardsArr)
                {
                    Dictionary<string, object> card = co as Dictionary<string, object>;
                    if (card == null) continue;
                    string id = GetString(card, "id", "");
                    if (String.IsNullOrEmpty(id)) continue;
                    cardInfoById[id] = new Dictionary<string, string> { { "title", GetString(card, "title", id) }, { "rarity", GetString(card, "rarity", "common") } };
                }

                bool changed = false;
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
                    foreach (string cardId in new List<string>(cards.Keys))
                    {
                        int count = CardCount(cards, cardId);
                        if (count < 2) continue;
                        string cardTitle = cardId;
                        string rarity = "common";
                        Dictionary<string, string> info;
                        if (cardInfoById.TryGetValue(cardId, out info)) { cardTitle = info["title"]; rarity = info["rarity"]; }
                        if (GetRarityRank(rarity) > maxRarityRank) continue;
                        int removed = count - 1;
                        SetCount(cards, cardId, 1);
                        changed = true;
                        result.Add(new Dictionary<string, string>
                        {
                            { "boosterId", kv.Key }, { "cardId", cardId }, { "cardTitle", cardTitle },
                            { "rarity", rarity }, { "removedCount", removed.ToString() }
                        });
                    }
                }
                if (changed)
                {
                    File.WriteAllText(CollectionsPath(), json.Serialize(collections), Encoding.UTF8);
                    Broadcast("collections", "{\"updated\":true}");
                }
                return result;
            }
        }

        // Removes "count" copies of a card from a viewer's collection (used by "!dust") - always
        // keeps at least 1 copy; returns false without changing anything if the viewer doesn't
        // have enough duplicates to spare.
        internal bool RemoveCardCopies(string login, string displayName, string boosterId, string cardId, int count)
        {
            lock (collectionWriteLock)
            {
                Dictionary<string, object> collections = ParseObject(ReadFile(CollectionsPath(), "{}"));
                Dictionary<string, object> cards = EnsureUserCards(collections, boosterId, login, displayName);
                int current = CardCount(cards, cardId);
                if (current - count < 1) return false;
                SetCount(cards, cardId, current - count);
                File.WriteAllText(CollectionsPath(), json.Serialize(collections), Encoding.UTF8);
                Broadcast("collections", "{\"updated\":true}");
                return true;
            }
        }

        // Removes exactly one copy of a card, allowed to reach 0 (unlike RemoveCardCopies, which
        // always keeps at least 1 for "!dust"). Used by Team-Kampf: a participant's staked card is
        // a real wager - losing it can mean losing the viewer's only copy.
        internal bool RemoveSingleCardAllowZero(string login, string displayName, string boosterId, string cardId)
        {
            lock (collectionWriteLock)
            {
                Dictionary<string, object> collections = ParseObject(ReadFile(CollectionsPath(), "{}"));
                Dictionary<string, object> cards = EnsureUserCards(collections, boosterId, login, displayName);
                int current = CardCount(cards, cardId);
                if (current < 1) return false;
                SetCount(cards, cardId, current - 1);
                File.WriteAllText(CollectionsPath(), json.Serialize(collections), Encoding.UTF8);
                Broadcast("collections", "{\"updated\":true}");
                return true;
            }
        }

        // One-sided gift ("!gift"): moves exactly one copy of a card from the giver's collection
        // to the recipient's, within the same booster. Unlike RemoveCardCopies (used by "!dust"),
        // this allows giving away the giver's last copy - it's an intentional full transfer, not
        // a "spend a spare duplicate" action.
        internal bool ApplyGiftTransfer(string fromLogin, string fromDisplay, string toLogin, string toDisplay, string boosterId, string cardId)
        {
            lock (collectionWriteLock)
            {
                Dictionary<string, object> collections = ParseObject(ReadFile(CollectionsPath(), "{}"));
                Dictionary<string, object> giverCards = EnsureUserCards(collections, boosterId, fromLogin, fromDisplay);
                if (CardCount(giverCards, cardId) < 1) return false;
                Dictionary<string, object> receiverCards = EnsureUserCards(collections, boosterId, toLogin, toDisplay);

                SetCount(giverCards, cardId, CardCount(giverCards, cardId) - 1);
                SetCount(receiverCards, cardId, CardCount(receiverCards, cardId) + 1);

                File.WriteAllText(CollectionsPath(), json.Serialize(collections), Encoding.UTF8);
                Broadcast("collections", "{\"updated\":true}");
                return true;
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
            InvalidateCardRarityCache();
            InvalidateParsedArrayCache();
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

        private readonly object statsInstallIdLock = new object();

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
        // Items (draws, trades, gifts, showcases, rankings...) that were triggered WHILE a bracket
        // event (tournament / Team-Kampf) was in progress - held here instead of the live queue so
        // they can't play over the signup countdown or interrupt the bracket, then flushed into the
        // real queue the moment the whole bracket event is finished (see Enqueue/FlushDeferredQueue).
        private readonly List<Dictionary<string, object>> deferredQueue = new List<Dictionary<string, object>>();
        private Dictionary<string, object> currentQueueItem;
        private readonly AutoResetEvent queueSignal = new AutoResetEvent(false);
        private readonly AutoResetEvent completionSignal = new AutoResetEvent(false);
        private volatile string awaitingEventId;
        private volatile bool queueRunning;
        private volatile bool queueWorkerStarted;
        private volatile bool queuePaused;

        private readonly object usageLock = new object();
        private Dictionary<string, object> usageData;

        // ---- Pity system: guarantees a minimum rarity after N consecutive draws (any trigger)
        // that didn't reach it. Per-login state persisted independently of command-usage.json
        // (which resets on its own schedule) - pity only resets by actually landing the
        // guaranteed rarity, naturally or forced.
        //   streak: consecutive draws (any trigger) that did NOT reach the guaranteed rarity.
        //   bank: leftover "!dust"/"!dustall" points beyond what was needed to fill streak up to
        //     the threshold. Same currency as streak, so a full extra forced-guarantee draw costs
        //     a full "threshold" worth of banked points (not 1 point) - consumed threshold-at-a-
        //     time, independent of the streak/threshold cycle continuing normally.
        private readonly object pityLock = new object();
        private Dictionary<string, object> pityState;

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

        // ---- Community goal: a shared progress bar across every viewer's draws (any trigger).
        // Persisted separately from settings.json since it's runtime state, not configuration -
        // "enabled"/"target"/messages/source name live in settings.communityGoal instead.
        //   current: cumulative draws counted so far this run.
        //   reached: true once current >= target - progress freezes here until an admin resets it.
        //   participants: login -> display name of everyone who drew at least once this run, used
        //     to hand out the bonus booster to every contributor once the goal is reached.
        private readonly object communityGoalLock = new object();
        private Dictionary<string, object> communityGoalState;

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

        // Reads up to 5 goal stages from settings.communityGoal.stages (each with its own target,
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
                    if (result.Count >= 5) break;
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
            server.Broadcast("communitygoalprogress", server.Serializer.Serialize(new Dictionary<string, object>
            {
                { "current", current },
                { "target", nextTarget },
                { "reached", allDone },
                { "stageNumber", reachedCount },
                { "stageCount", stages.Count }
            }));

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

        private const string DefaultCommunityGoalMessage = "🎉 Community-Ziel erreicht ([Ziel] Ziehungen)! Alle Teilnehmer bekommen automatisch [Karten] Bonus-Booster.";

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

        // Tournament Mode: a single global bracket (like activeBattle, only one tournament can be
        // signing up or running at a time). Unlike a normal !battle challenge, matches don't need
        // !battleyes/!battleno - joining the tournament IS the consent - so the whole bracket is
        // resolved synchronously once signup closes and its matches are fed into the existing
        // serialized action queue one after another (see ResolveTournamentSignup).
        private readonly object tournamentLock = new object();
        private Dictionary<string, object> activeTournament;
        private System.Threading.Timer tournamentSignupTimer;

        private readonly object teamBattleLock = new object();
        private Dictionary<string, object> activeTeamBattle;
        private System.Threading.Timer teamBattleSignupTimer;

        // True while a tournament OR Team-Kampf is either taking signups OR still playing out its
        // (front-loaded) matches in the action queue. A tournament resolves its WHOLE bracket
        // synchronously the instant signup closes and dumps every match at the FRONT of the queue
        // (see ResolveTournamentSignup/EnqueueBatchAtFront), so `activeTournament` goes null long
        // before those matches have finished animating - which is why checking the active-object
        // alone isn't enough: a Team-Kampf started during that playback would inject its own fight
        // right into the middle of the still-running bracket. Both start paths consult this so only
        // one big bracket event can be in flight (signup + playback) at a time. Cheap linear scan -
        // the queue is at most a few dozen items even for a large tournament.
        private bool IsBracketEventBusy()
        {
            lock (tournamentLock) { if (activeTournament != null) return true; }
            lock (teamBattleLock) { if (activeTeamBattle != null) return true; }
            return IsBracketPlaybackBusy();
        }

        // Narrower than IsBracketEventBusy: true ONLY while a bracket's matches are actually being
        // played back in the queue (front-loaded there the instant signup closes - see
        // ResolveTournamentSignup/EnqueueBatchAtFront) - NOT during the signup window itself. Other
        // animations (draws, gifts, trades...) are only held back (see Enqueue/
        // FlushDeferredQueueIfIdle) once playback is actually under way; during signup they're
        // still allowed to play normally over the countdown.
        private bool IsBracketPlaybackBusy()
        {
            lock (queueLock)
            {
                if (currentQueueItem != null && IsBracketSource(GetString(currentQueueItem, "source", ""))) return true;
                foreach (Dictionary<string, object> queued in actionQueue)
                {
                    if (IsBracketSource(GetString(queued, "source", ""))) return true;
                }
            }
            return false;
        }

        private static bool IsBracketSource(string source)
        {
            return source == "tournament" || source == "teamkampf";
        }

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
        private const string DefaultDustUsage = "@userName, Nutzung: !dust <Kartenname> <Anzahl>";
        private const string DefaultDustCardNotFound = "@userName, die Karte [falscherName] existiert nicht. Meintest du stattdessen [Kartenname]?";
        private const string DefaultDustNotEnough = "@userName, du hast nicht genug Duplikate von [Kartenname] (du besitzt [Besitz], mindestens 1 muss dir erhalten bleiben).";
        private const string DefaultDustSuccess = "@userName hat [Anzahl]x [Kartenname] geopfert (+[Punkte] Garantie-Punkte). [GarantieAnzahl] garantierte Ziehung(en) bereit, noch [GarantieRest] Ziehungen bis zur naechsten.";
        private const string DefaultDustSetUsage = "@userName, Nutzung: [BefehlSet] <Seltenheit> (z.B. legendär) - legt fest, bis zu welcher Seltenheit [BefehlAll] automatisch Duplikate opfert.";
        private const string DefaultDustSetInvalid = "@userName, \"[Eingabe]\" ist keine bekannte Seltenheit. Gültig: Gewöhnlich, Ungewöhnlich, Selten, Episch, Legendär, Holo.";
        private const string DefaultDustSetSuccess = "@userName, [BefehlAll] opfert ab jetzt automatisch alle Duplikate bis einschließlich [Seltenheit].";
        private const string DefaultDustAllNothing = "@userName, du hast aktuell keine Duplikate unterhalb von [Seltenheit] zum Opfern.";
        private const string DefaultDustAllSuccess = "@userName hat [Gesamtanzahl] doppelte Karten geopfert ([Aufschluesselung]), +[Punkte] Garantie-Punkte. [GarantieAnzahl] garantierte Ziehung(en) bereit, noch [GarantieRest] Ziehungen bis zur naechsten.";

        private const string DefaultGiftUsage = "@userName, Nutzung: !gift @userNameB <Kartenname>";
        private const string DefaultGiftUserNotFound = "@userName, den Nutzer [Nutzer] kennt die Sammlung noch nicht.";
        private const string DefaultGiftCardNotFound = "@userName, die Karte [falscherName] existiert nicht. Meintest du stattdessen [Kartenname]?";
        private const string DefaultGiftNotOwned = "@userName, du besitzt [Kartenname] gar nicht.";
        private const string DefaultGiftSelf = "@userName, du kannst dir nicht selbst etwas schenken.";
        private const string DefaultGiftSuccess = "@userName hat [Kartenname] an @userNameB verschenkt!";
        private const string DefaultSpecificPackUsage = "@userName, Nutzung: [Befehl] <Packname> - zieht eine Karte aus dem angegebenen Pack.";
        private const string DefaultSpecificPackNotFound = "@userName, ein Pack namens \"[Eingabe]\" wurde nicht gefunden. Bitte den genauen Packnamen angeben.";
        private const string DefaultSpecificPackRedemptionNotFound = "@userName, ein Pack namens \"[Eingabe]\" wurde nicht gefunden - deine Kanalpunkte wurden erstattet. Bitte den genauen Packnamen angeben.";
        private const string DefaultShowPackUsage = "@userName, Nutzung: [Befehl] <Packname> - zeigt den Inhalt des angegebenen Packs.";
        private const string DefaultShowPackNotFound = "@userName, ein Pack namens \"[Eingabe]\" wurde nicht gefunden. Bitte den genauen Packnamen angeben.";
        private const string DefaultShowPackHeader = "@userName, deine Karten aus [Boostername]:";
        private const string DefaultShowPackEmpty = "@userName, du besitzt noch keine Karten aus [Boostername].";

        private const string DefaultBattleUsage = "@userName, Nutzung: !battle @userNameB";
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

        private const string DefaultTournamentSignupStart = "🏆 Turnier-Anmeldung gestartet! Tritt mit [Befehl] bei - [Sekunden] Sekunden Zeit, mindestens [Mindestteilnehmer] Teilnehmer nötig.";
        private const string DefaultTournamentJoinAck = "@userName ist dem Turnier beigetreten! ([Anzahl] Teilnehmer)";
        private const string DefaultTournamentNotEligible = "@userName, für die Turnier-Teilnahme brauchst du mindestens [Anzahl] verschiedene Karten.";
        private const string DefaultTournamentAlreadyRunning = "@userName, es läuft bereits ein Turnier oder eine Anmeldephase.";

        private const string DefaultTeamBattleBusy = "@userName, es läuft bereits ein Team-Kampf.";
        private const string DefaultTeamBattleSignupStart = "Team-Kampf gestartet! Der Streamer stellt [Anzahl] Karten - tritt mit [Befehl] bei, [Sekunden] Sekunden Zeit!";
        private const string DefaultTeamBattleNoActive = "@userName, gerade läuft keine Team-Kampf-Anmeldung.";
        private const string DefaultTeamBattleJoinAlready = "@userName, du bist bereits angemeldet.";
        private const string DefaultTeamBattleJoinNotOwned = "@userName, du besitzt noch keine Karten und kannst deshalb nicht teilnehmen.";
        private const string DefaultTeamBattleJoinSuccess = "@userName ist dem Team-Kampf beigetreten! ([Anzahl] Teilnehmer)";
        private const string DefaultTeamBattleNoParticipants = "Niemand hat sich für den Team-Kampf angemeldet - @streamerName tritt alleine an... gegen niemanden. Kampf abgesagt.";
        private const string DefaultTeamBattleWinMessage = "Die Community hat gewonnen! Alle Teilnehmer erhalten Karten.";
        private const string DefaultTeamBattleLoseMessage = "@streamerName hat gewonnen! Die Community verliert diesmal.";
        private const string DefaultTeamBattleFinisherMessage = "@userName hat den entscheidenden Schlag gelandet und erhält zusätzlich [Anzahl]x Kartenpack-Ziehung!";
        private const string DefaultTeamBattleFinisherMessageNoBonus = "@userName hat den entscheidenden Schlag gelandet!";
        private const string DefaultTeamBattleLostCardMessage = "@userName hat [Kartenname] verloren.";
        private const string DefaultTeamBattlePerDefeatMessage = "@userName hat [AnzahlBesiegt] gegnerische Karte(n) besiegt und erhält dafür [Anzahl] Kartenpack-Ziehung(en)!";
        private const string DefaultTournamentCancel = "Das Turnier wurde abgesagt - nur [Anzahl] von mindestens [Mindestteilnehmer] nötigen Teilnehmern haben sich angemeldet.";
        private const string DefaultTournamentRoundAnnounce = "🏆 Turnier [Runde]: [SpielerA] vs [SpielerB]!";
        private const string DefaultTournamentByeAnnounce = "🏆 Turnier [Runde]: [Spieler] hat ein Freilos und zieht kampflos weiter!";
        private const string DefaultTournamentWinnerAnnounce = "🏆 @userName gewinnt das Turnier mit [Teilnehmerzahl] Teilnehmern und erhält [Anzahl]x Kartenpack-Ziehung!";

        private const string DefaultLiveTickerDrawMessage = "@userName hat [Kartenname] gezogen.";
        private const string DefaultLiveTickerBattleMessage = "@userNameA hat gegen @userNameB gewonnen.";
        private const string DefaultLiveTickerTournamentMessage = "Turnier: @userName hat gewonnen.";
        private const string DefaultLiveTickerTeamBattleMessage = "Team-Kampf: [Sieger] hat gewonnen.";

        private const string DefaultCardsEmpty = "@userName, du besitzt noch keine Karten.";
        private const string DefaultCardsHeader = "@userName, deine Karten:";
        private const string DefaultPacksHeader = "@userName, verfügbare Booster:";
        private const string DefaultPacksEmpty = "@userName, aktuell ist kein Booster verfügbar.";
        private const string DefaultPacksSubOnlyLabel = "Sub Only";

        private const double DefaultBattleVariance = 0.6;

        public TwitchBridge(CardPackServer server)
        {
            this.server = server;
            liveTickerHistory.AddRange(server.LoadLiveTickerHistory());
        }

        public void Start()
        {
            StartQueueWorkerOnce();
            StartResetTimerOnce();
            StartAutoHelpTimerOnce();
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
                // Deliberately left in the manual-review queue (NOT auto-skipped) so a redemption
                // can still be refunded from the Twitch dashboard/mobile app if something goes
                // wrong (e.g. a cancelled tournament signup, or a pack drawn in error). This can
                // reportedly crash an OLDER OBS-bundled Chromium's built-in chat dock, which
                // can't render the inline Fulfill/Refund control - if that happens, either update
                // OBS or switch to an external chat client instead of re-enabling the skip.
                { "should_redemptions_skip_request_queue", false },
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
            RemoveRewardId(Obj(settings, "tournament"), rewardId);
            RemoveRewardId(Obj(settings, "teamBattle"), rewardId);
            RemoveRewardId(Obj(settings, "specificPackDraw"), rewardId);
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
                // Same ordered dispatch as the chat socket (see DispatchEventSubWork): keeps this
                // receive loop free to read the next frame while a redemption is being processed.
                DispatchEventSubWork(delegate { HandleEventSubMessage(text); });
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
            string subType = GetString(subscription, "type", "");
            if (subType == "channel.subscribe" || subType == "channel.subscription.message" || subType == "channel.subscription.gift")
            {
                HandleSubscriptionEvent(subType, Obj(payload, "event"));
                return;
            }
            if (subType == "channel.cheer")
            {
                HandleCheerEvent(Obj(payload, "event"));
                return;
            }
            if (subType != "channel.channel_points_custom_reward_redemption.add") return;
            Dictionary<string, object> ev = Obj(payload, "event");
            string rewardId = GetString(Obj(ev, "reward"), "id", "");
            string rewardTitle = GetString(Obj(ev, "reward"), "title", "");
            string user = GetString(ev, "user_name", GetString(ev, "user_login", "Viewer"));
            string login = GetString(ev, "user_login", user);

            // Read settings ONCE for this whole redemption and hand it to every
            // ReconcileTrackedReward check below, instead of each check calling
            // ReadSettingsObject() itself - that re-parses the ENTIRE settings chain from disk on
            // every call, including cards.json (tens of MB once a collection has many custom card
            // images). A redemption that doesn't match the first checks (showcase/tournament/
            // teamBattle) paid that full-file-reload cost up to four times in a row before the
            // draw was even logged/enqueued - exactly why redemptions showed up in the log several
            // seconds after actually being redeemed.
            Dictionary<string, object> settings = server.ReadSettingsObject();

            // Collection showcase reward: not a pack opening - tell the collection overlay to
            // slide through every active booster for this viewer. Routed through the action
            // queue (like every other redemption/chat command) so concurrent triggers are
            // always processed strictly one after another with a pause in between.
            if (ReconcileTrackedReward(settings, "showcase", rewardId, rewardTitle))
            {
                // The animation can be switched off entirely (settings.showcase.animationEnabled)
                // while still wanting the chat card list - in that case there's nothing to queue
                // or animate, so send the chat text directly instead of going through the overlay
                // queue at all.
                if (GetBool(Obj(settings, "showcase"), "animationEnabled", true))
                    Enqueue("showcollection", login, user, "channelpoints");
                else
                    SendCollectionChatText(login, user, settings);
                return;
            }

            if (ReconcileTrackedReward(settings, "tournament", rewardId, rewardTitle))
            {
                StartTournamentSignup(login, user, "channelpoints");
                return;
            }

            if (ReconcileTrackedReward(settings, "teamBattle", rewardId, rewardTitle))
            {
                StartTeamBattleSignup(login, user, "channelpoints");
                return;
            }

            // "Pick your own pack" reward - requires the viewer to type the exact pack name into
            // the reward's (required) text input; refunds the points and explains via chat if that
            // name doesn't match any enabled booster. See HandleSpecificPackRedemption.
            if (ReconcileTrackedReward(settings, "specificPackDraw", rewardId, rewardTitle))
            {
                HandleSpecificPackRedemption(login, user, GetString(ev, "user_input", ""), rewardId, GetString(ev, "id", ""), settings);
                return;
            }

            if (!ReconcileTrackedReward(settings, "draw", rewardId, rewardTitle))
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

        // Sub/Resub/Gifted-Sub reward: draws "cardsPerSub" card(s) - multiplied by the number of
        // subs for a gift/bomb event - exclusively from boosters flagged "subExclusive", via the
        // normal action queue (same as any other draw, so it's serialized with everything else).
        // Mirrors PickRandomBoosterId(subOnly:true)'s eligibility check (enabled, subExclusive,
        // has at least one enabled card) without actually picking one - used up front by
        // HandleSubscriptionEvent to decide whether to fall back to the normal pool instead of
        // silently enqueueing draws that would find nothing.
        private bool HasEligibleSubExclusiveBooster(Dictionary<string, object> settings)
        {
            object boostersObj;
            if (!settings.TryGetValue("boosters", out boostersObj) || !(boostersObj is object[])) return false;
            foreach (object item in (object[])boostersObj)
            {
                Dictionary<string, object> booster = item as Dictionary<string, object>;
                if (booster == null) continue;
                if (!GetBool(booster, "enabled", true)) continue;
                if (!GetBool(booster, "subExclusive", false)) continue;
                object[] cardIds = booster.ContainsKey("cardIds") && booster["cardIds"] is object[] ? (object[])booster["cardIds"] : new object[0];
                if (cardIds.Length == 0) continue;
                if (!BoosterHasEnabledCard(settings, cardIds)) continue;
                return true;
            }
            return false;
        }

        private void HandleSubscriptionEvent(string subType, Dictionary<string, object> ev)
        {
            Dictionary<string, object> settings = server.ReadSettingsObject();
            Dictionary<string, object> subCfg = Obj(settings, "subRewards");
            if (!GetBool(subCfg, "enabled", true)) return;
            int cardsPerSub = Math.Max(1, GetInt(subCfg, "cardsPerSub", 1));

            string login;
            string displayName;
            int count;
            string source;

            if (subType == "channel.subscribe")
            {
                // Gifted subs are reported twice: once here (the recipient, is_gift=true) and once
                // via channel.subscription.gift (the gifter, with the total gifted count). Only the
                // gifter is rewarded, so the recipient's half is skipped to avoid double-counting.
                if (GetBool(ev, "is_gift", false)) return;
                login = GetString(ev, "user_login", "");
                displayName = GetString(ev, "user_name", login);
                count = 1;
                source = "sub";
            }
            else if (subType == "channel.subscription.message")
            {
                login = GetString(ev, "user_login", "");
                displayName = GetString(ev, "user_name", login);
                count = 1;
                source = "resub";
            }
            else if (subType == "channel.subscription.gift")
            {
                // Anonymous gifts carry no user to credit.
                if (GetBool(ev, "is_anonymous", false)) return;
                login = GetString(ev, "user_login", "");
                displayName = GetString(ev, "user_name", login);
                count = Math.Max(1, GetInt(ev, "total", 1));
                source = "giftsub";
            }
            else
            {
                return;
            }

            if (String.IsNullOrWhiteSpace(login)) return;

            // Fallback: if no booster is actually marked "Sub-exklusiv" (or none has cards), the
            // sub-exclusive pool is empty and the queued draws would previously just silently do
            // nothing (see ProcessQueueItem's PickRandomBoosterId warning). With the fallback
            // enabled, draw from the NORMAL pool instead, using its own separately configurable
            // card count - so a sub always grants something even before a sub-exclusive booster
            // has been set up.
            bool useSubExclusive = HasEligibleSubExclusiveBooster(settings);
            int cardsPerEvent = useSubExclusive ? cardsPerSub : Math.Max(1, GetInt(subCfg, "fallbackCardsPerSub", 1));
            if (!useSubExclusive && !GetBool(subCfg, "fallbackEnabled", false))
            {
                server.Log("draw", "warn", displayName + " hat eine Sub-Belohnung ausgeloest (" + source +
                    "), aber es ist kein Sub-exklusiver Booster verfuegbar und der Fallback ist deaktiviert.");
                return;
            }

            int totalCards = cardsPerEvent * count;
            server.Log("draw", "info", displayName + " hat " + totalCards + " Sub-Belohnungskarte(n) ausgeloest (" + source +
                (useSubExclusive ? "" : ", Fallback auf normalen Pool") + ").");
            var extra = useSubExclusive ? new Dictionary<string, object> { { "boosterPool", "subExclusive" } } : null;
            for (int i = 0; i < totalCards; i++) Enqueue("draw", login, displayName, source, extra);
        }

        // Bits/Cheers: every "bitsPerDraw" bits (config-defined threshold) earns one card draw.
        // Leftover bits below the threshold are banked per user (data/command-usage.json, "bits"
        // section) and carry over to the NEXT cheer - e.g. bitsPerDraw=100, a 250-bit cheer earns
        // 2 draws immediately and banks 50; a later 50-bit cheer from the same user then earns the
        // 3rd draw and empties the bank. Anonymous cheers carry no user to credit and are skipped.
        private void HandleCheerEvent(Dictionary<string, object> ev)
        {
            Dictionary<string, object> settings = server.ReadSettingsObject();
            Dictionary<string, object> bitsCfg = Obj(settings, "bits");
            if (!GetBool(bitsCfg, "enabled", false)) return;
            int bitsPerDraw = Math.Max(1, GetInt(bitsCfg, "bitsPerDraw", 100));

            if (GetBool(ev, "is_anonymous", false)) return;
            string login = GetString(ev, "user_login", "");
            string displayName = GetString(ev, "user_name", login);
            int bits = Math.Max(0, GetInt(ev, "bits", 0));
            if (String.IsNullOrWhiteSpace(login) || bits <= 0) return;

            int totalDraws;
            int remainder;
            lock (usageLock)
            {
                Dictionary<string, object> entry = GetOrCreateBitsEntry(login, displayName);
                int banked = GetInt(entry, "banked", 0) + bits;
                totalDraws = banked / bitsPerDraw;
                remainder = banked % bitsPerDraw;
                entry["banked"] = remainder;
                SaveUsage();
            }

            server.Log("draw", "info", displayName + " hat " + bits + " Bits gespendet - " + totalDraws +
                " Kartenziehung(en) ausgeloest, " + remainder + " Bits verbleiben bis zur naechsten.");
            for (int i = 0; i < totalDraws; i++) Enqueue("draw", login, displayName, "bits");
        }

        // ---- Bits usage tracking (separate namespace inside command-usage.json) ----

        private Dictionary<string, object> BitsSection()
        {
            EnsureUsageLoaded();
            object obj;
            if (usageData.TryGetValue("bits", out obj) && obj is Dictionary<string, object>) return (Dictionary<string, object>)obj;
            Dictionary<string, object> section = new Dictionary<string, object> { { "users", new Dictionary<string, object>() } };
            usageData["bits"] = section;
            return section;
        }

        private Dictionary<string, object> GetOrCreateBitsEntry(string login, string displayName)
        {
            Dictionary<string, object> section = BitsSection();
            Dictionary<string, object> users = section["users"] as Dictionary<string, object>;
            if (users == null) { users = new Dictionary<string, object>(); section["users"] = users; }
            string key = login.Trim().ToLowerInvariant();
            Dictionary<string, object> entry;
            if (users.ContainsKey(key) && users[key] is Dictionary<string, object>) entry = (Dictionary<string, object>)users[key];
            else { entry = new Dictionary<string, object> { { "banked", 0 } }; users[key] = entry; }
            if (!String.IsNullOrWhiteSpace(displayName)) entry["displayName"] = displayName;
            return entry;
        }

        // Exposes every viewer's currently banked (not-yet-a-draw) bits, for display in the
        // admin User tab. Includes displayName (not just the raw banked number) so the admin UI
        // can list a viewer who has banked bits but hasn't drawn a card yet (e.g. their cheer was
        // below the bits-per-draw threshold) - previously such viewers were invisible in the User
        // tab entirely, since it was built solely from card ownership in collections.json.
        public Dictionary<string, object> GetBitsState()
        {
            lock (usageLock)
            {
                Dictionary<string, object> section = BitsSection();
                Dictionary<string, object> users = section["users"] as Dictionary<string, object>;
                var result = new Dictionary<string, object>();
                if (users != null)
                {
                    foreach (KeyValuePair<string, object> kv in users)
                    {
                        Dictionary<string, object> entry = kv.Value as Dictionary<string, object>;
                        if (entry != null)
                        {
                            result[kv.Key] = new Dictionary<string, object>
                            {
                                { "banked", GetInt(entry, "banked", 0) },
                                { "displayName", GetString(entry, "displayName", kv.Key) }
                            };
                        }
                    }
                }
                return result;
            }
        }

        private static readonly Random RandomSource = new Random();

        // subOnly=false (normal packs, channel points, "!pack") skips boosters flagged
        // "subExclusive" entirely; subOnly=true (sub/resub/giftsub rewards) picks ONLY among
        // them - the two pools never overlap.
        // subOnly=false: normal boosters only (excludes subExclusive). subOnly=true: subExclusive
        // only. subOnly=null: no filter at all - any enabled booster regardless of the flag (used
        // by Team-Kampf, which draws the streamer's lineup from the whole card pool).
        private string PickRandomBoosterId(bool? subOnly = false)
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
                if (subOnly.HasValue && GetBool(booster, "subExclusive", false) != subOnly.Value) continue;
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

        // ---- "!packs" - lists every currently available booster (title + subtitle as one
        // continuous name, same convention as the draw chat message) together with its actual
        // draw probability - mirrors PickRandomBoosterId(subOnly:false)'s exact eligibility and
        // score-weighting so the percentages shown always match real draw odds. Sub-exclusive
        // boosters are listed too (they're real and available, just not via !pack/Kanalpunkte) but
        // marked with a configurable "(Sub Only)" label instead of a percentage, since they aren't
        // part of the normal weighted pool at all. ----
        private static string BoosterDisplayName(Dictionary<string, object> booster)
        {
            string title = GetString(booster, "title", "Booster");
            string subtitle = GetString(booster, "subtitle", "");
            return String.IsNullOrEmpty(subtitle) ? title : title + " " + subtitle;
        }

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

            if (normalPool.Count == 0 && subOnlyList.Count == 0)
            {
                SendChatMessageSafe(GetString(packsCfg, "emptyMessage", DefaultPacksEmpty).Replace("@userName", "@" + displayName));
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
            SendCardListChunked(login, "chat", header, names);
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

        // Case-insensitive, trimmed exact match on a booster's title - used by the "pick your own
        // pack" channel-points reward and its matching chat command (see HandleSpecificPackDraw),
        // where the viewer types the pack's name themselves. Only enabled boosters are eligible -
        // a disabled one must behave the same as "not found" (refund/usage message), not silently
        // draw from a pack the streamer turned off.
        private Dictionary<string, object> FindBoosterByTitle(Dictionary<string, object> settings, string titleQuery)
        {
            if (String.IsNullOrWhiteSpace(titleQuery)) return null;
            string needle = titleQuery.Trim();
            object boostersObj;
            if (!settings.TryGetValue("boosters", out boostersObj) || !(boostersObj is object[])) return null;
            foreach (object bo in (object[])boostersObj)
            {
                Dictionary<string, object> b = bo as Dictionary<string, object>;
                if (b == null) continue;
                if (!GetBool(b, "enabled", true)) continue;
                if (String.Equals(GetString(b, "title", ""), needle, StringComparison.OrdinalIgnoreCase)) return b;
            }
            return null;
        }

        // Picks one enabled card from the booster, weighted by rarity weight (mirrors the overlay's
        // weightedPick). Returns null only if the booster has no eligible cards.
        // minRarityFilter (used by the pity system, see ProcessQueueItem): when set, restricts the
        // pool to cards at or above that rarity first - falls back to the unrestricted pool if the
        // booster happens to have no card that rare, so a pity-guaranteed draw never comes up empty.
        private Dictionary<string, object> PickCardFromBooster(Dictionary<string, object> settings, string boosterId, string minRarityFilter = null)
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

            if (!String.IsNullOrEmpty(minRarityFilter))
            {
                int minRank = CardPackServer.GetRarityRank(minRarityFilter);
                var filteredPool = new List<Dictionary<string, object>>();
                var filteredWeights = new List<double>();
                double filteredTotal = 0;
                for (int i = 0; i < pool.Count; i++)
                {
                    if (CardPackServer.GetRarityRank(GetString(pool[i], "rarity", "common")) < minRank) continue;
                    filteredPool.Add(pool[i]);
                    filteredWeights.Add(poolWeights[i]);
                    filteredTotal += poolWeights[i];
                }
                if (filteredPool.Count > 0)
                {
                    pool = filteredPool;
                    poolWeights = filteredWeights;
                    total = filteredTotal;
                }
            }

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
            var item = BuildQueueItem(kind, login, displayName, source, extra);
            // Anything triggered WHILE a bracket's matches are actually playing back (NOT during
            // its signup window - other animations are still allowed to play over that countdown)
            // is held back instead of joining the live queue, so it can't get interleaved between
            // bracket matches. The bracket's OWN items (per-round/champion draws, all enqueued with
            // source "tournament"/"teamkampf") are the one exception - those must never be
            // deferred, or the bracket would end up waiting on itself. Flushed back into the real
            // queue once playback is over - see FlushDeferredQueueIfIdle.
            if (!IsBracketSource(source) && IsBracketPlaybackBusy())
            {
                lock (queueLock) { deferredQueue.Add(item); }
            }
            else
            {
                lock (queueLock) { actionQueue.Add(item); }
            }
            BroadcastQueue();
            queueSignal.Set();
        }

        // Moves every held-back item (see Enqueue) back into the live queue, in the same order
        // they originally arrived, the moment no bracket event is active anymore. Called from
        // QueueLoop on every wake-up, so the flush happens within ~1s of the bracket actually
        // finishing (or immediately, since every Enqueue/queue-completion also signals the loop).
        private void FlushDeferredQueueIfIdle()
        {
            if (IsBracketPlaybackBusy()) return;
            List<Dictionary<string, object>> toFlush = null;
            lock (queueLock)
            {
                if (deferredQueue.Count == 0) return;
                toFlush = new List<Dictionary<string, object>>(deferredQueue);
                deferredQueue.Clear();
                actionQueue.AddRange(toFlush);
            }
            server.Log("queue", "info", toFlush.Count + " zurueckgehaltene Aktion(en) nach Turnier/Team-Kampf-Ende in die Warteschlange eingereiht.");
            BroadcastQueue();
            queueSignal.Set();
        }

        private static Dictionary<string, object> BuildQueueItem(string kind, string login, string displayName, string source, Dictionary<string, object> extra)
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
            return item;
        }

        // Atomically inserts a whole batch of already-built items at the FRONT of the queue -
        // ahead of anything already waiting - in a single locked operation, so nothing else can
        // get interleaved between them and pack draws already queued during the signup window
        // don't delay the start. Used by tournament/Team-Kampf resolution (see
        // ResolveTournamentSignup/ResolveTeamBattleSignup) so the bracket/team fight begins the
        // instant signup closes and plays start-to-finish without anything landing in the middle.
        private void EnqueueBatchAtFront(List<Dictionary<string, object>> items)
        {
            if (items == null || items.Count == 0) return;
            lock (queueLock) { actionQueue.InsertRange(0, items); }
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
                // Shown last, tagged "deferred" so the admin Queue tab can visibly distinguish
                // "waiting its turn" from "waiting for the current tournament/Team-Kampf to end
                // entirely" - see Enqueue/FlushDeferredQueueIfIdle.
                foreach (Dictionary<string, object> deferred in deferredQueue)
                {
                    var dcopy = new Dictionary<string, object>(deferred);
                    dcopy["deferred"] = true;
                    list.Add(dcopy);
                }
                return list.ToArray();
            }
        }

        private void BroadcastQueue()
        {
            server.Broadcast("queue", server.Serializer.Serialize(new Dictionary<string, object> { { "items", GetQueueItems() }, { "paused", queuePaused } }));
        }

        // Called by the overlay (POST /api/queue/complete) once it has finished playing the
        // animation for a given event. Releases the queue worker so it can proceed to the
        // 500ms gap and then the next item. The post-draw chat message and live-ticker entry are
        // NOT sent from here (see AnnounceDraw below) - they need to go out the moment the card is
        // actually revealed, well before the whole animation (backs-before-reveal, slide, hold
        // time) has finished playing.
        public void CompleteQueueItem(string eventId, string cardTitle, string boosterTitle)
        {
            if (String.IsNullOrEmpty(eventId)) return;
            if (eventId != awaitingEventId) return;
            completionSignal.Set();
        }

        // Called by the overlay (POST /api/queue/announce) the instant a drawn card is fully
        // revealed - the same moment the collection panel appears next to it - so the post-draw
        // chat message and live-ticker entry go out right then instead of after the whole
        // animation finishes playing.
        // If more than one overlay page is showing the same source at once (e.g. the pack source
        // open in both OBS AND Meld Studio simultaneously), each one independently plays the
        // animation and independently posts /api/queue/announce for the same eventId. Without this
        // guard, every extra call would re-send the post-draw chat message, duplicating it.
        private readonly object announceLock = new object();
        private string lastAnnouncedEventId;

        // Persisted to disk (see CardPackServer.SaveLiveTickerHistory/LoadLiveTickerHistory) so a
        // freshly (re)loaded overlay/browser source shows the last few events immediately even
        // right after an app restart, instead of sitting empty until the next one happens. Loaded
        // once in the constructor below. See GET /api/liveticker/recent.
        private const int LiveTickerHistoryCap = 8;
        private readonly object liveTickerHistoryLock = new object();
        private readonly List<Dictionary<string, object>> liveTickerHistory = new List<Dictionary<string, object>>();

        public object[] GetLiveTickerHistory()
        {
            lock (liveTickerHistoryLock) return liveTickerHistory.ToArray();
        }

        // Single entry point for every live-ticker event kind (draw/battle/tournament/teamkampf) -
        // the display text is fully pre-formatted here (from an admin-configurable template, see
        // settings.liveTicker.*Message) rather than built client-side from structured fields, so
        // "Texte sollen individuell festlegbar sein" applies uniformly to all four kinds.
        private void PushLiveTickerEntry(string kind, string text, string avatarUrl)
        {
            if (String.IsNullOrEmpty(text)) return;
            var tickerEntry = new Dictionary<string, object>
            {
                { "kind", kind },
                { "text", text },
                { "avatarUrl", avatarUrl }
            };
            lock (liveTickerHistoryLock)
            {
                liveTickerHistory.Add(tickerEntry);
                if (liveTickerHistory.Count > LiveTickerHistoryCap) liveTickerHistory.RemoveAt(0);
                server.SaveLiveTickerHistory(liveTickerHistory.ToArray());
            }
            server.Broadcast("liveticker", server.Serializer.Serialize(tickerEntry));
        }

        public void AnnounceDraw(string eventId, string cardTitle, string boosterTitle)
        {
            if (String.IsNullOrEmpty(eventId) || String.IsNullOrEmpty(cardTitle)) return;
            if (eventId != awaitingEventId) return;
            bool isFirst;
            lock (announceLock)
            {
                isFirst = lastAnnouncedEventId != eventId;
                lastAnnouncedEventId = eventId;
            }
            if (!isFirst) return;
            try
            {
                Dictionary<string, object> item;
                lock (queueLock) item = currentQueueItem;
                if (item == null || GetString(item, "kind", "") != "draw") return;
                // NOTE: the post-draw CHAT message is deliberately NOT sent here at reveal anymore -
                // it goes out only once the whole draw animation has finished (see QueueLoop's
                // post-completion block), so chat timing lines up with the animation ending instead
                // of firing a few seconds early while the card is still on screen. The live-ticker
                // entry below stays at reveal, since it's a passive feed, not a chat announcement.
                string userLogin = GetString(item, "userLogin", "");
                string user = GetString(item, "user", "Viewer");
                string tickerCardTitle = GetString(item, "cardTitle", "");
                if (String.IsNullOrEmpty(tickerCardTitle)) tickerCardTitle = cardTitle;
                // Same "Titel Untertitel" convention as SendDrawPostMessage and "!packs" - the
                // server-picked booster title (on the item) is authoritative, the parameter is
                // only a fallback for older cached overlays that haven't reported it back yet.
                string tickerBoosterTitle = GetString(item, "boosterTitle", "");
                if (String.IsNullOrEmpty(tickerBoosterTitle)) tickerBoosterTitle = boosterTitle ?? "";
                string tickerBoosterSubtitle = GetString(item, "boosterSubtitle", "");
                if (!String.IsNullOrEmpty(tickerBoosterSubtitle)) tickerBoosterTitle = tickerBoosterTitle + " " + tickerBoosterSubtitle;
                Dictionary<string, object> ltCfg = Obj(server.ReadSettingsObject(), "liveTicker");
                string text = GetString(ltCfg, "drawMessage", DefaultLiveTickerDrawMessage)
                    .Replace("@userName", user)
                    .Replace("[Kartenname]", tickerCardTitle)
                    .Replace("[Boostername]", tickerBoosterTitle);
                PushLiveTickerEntry("draw", text, GetUserAvatarUrl(userLogin));
            }
            catch { }
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
            else
            {
                // Every other trigger (channel points, bits, community goal, tournament,
                // Team-Kampf, sub/resub/giftsub) shares the same "Nachricht nach der Animation"
                // toggle/template - [Quelle] (see below) is what lets the streamer distinguish
                // which one actually fired in a given message.
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
            // The booster's subtitle (if any, set via its own "Untertitel" field in the Booster
            // tab) is appended after the booster name, same "Titel Untertitel" convention as
            // "!packs" - so [Boostername] reads as one continuous phrase instead of the subtitle
            // needing its own separate chat variable/placement.
            string boosterSubtitle = GetString(item, "boosterSubtitle", "");
            if (!String.IsNullOrEmpty(boosterSubtitle)) boosterT = boosterT + " " + boosterSubtitle;
            // Count is read AFTER the overlay's own /api/collection persist call (it awaits that
            // before ever calling /api/queue/announce, which is what triggers this), so it already
            // reflects this draw - no off-by-one workaround needed here.
            string login = GetString(item, "userLogin", "");
            string cardId = GetString(item, "cardId", "");
            string boosterId = GetString(item, "boosterId", "");
            string count = "";
            if (!String.IsNullOrEmpty(login) && !String.IsNullOrEmpty(cardId) && !String.IsNullOrEmpty(boosterId))
            {
                count = server.GetCardCount(login, boosterId, cardId).ToString();
            }
            string rarityLang = GetString(Obj(settings, "chatCommands"), "rarityLanguage", "de");
            string rarityLabel = String.IsNullOrEmpty(cardId) ? "" : RarityLabel(server.CardRarity(cardId), rarityLang);
            string sourceLabel = SourceLabel(source, rarityLang);
            string msg = template
                .Replace("@userName", "@" + user)
                .Replace("[Kartenname]", cardT)
                .Replace("[Boostername]", boosterT)
                .Replace("[Besitz]", count)
                .Replace("[Seltenheit]", rarityLabel)
                .Replace("[Quelle]", sourceLabel);
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
                deferredQueue.RemoveAll(delegate(Dictionary<string, object> item) { return GetString(item, "id", "") == id; });
            }
            BroadcastQueue();
        }

        public void ClearQueue()
        {
            lock (queueLock) { actionQueue.Clear(); deferredQueue.Clear(); }
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
            if (kind == "showpack")
            {
                // Same page-flip timing model as "showcollection" above, but scoped to exactly one
                // named booster and a 5x5=25-per-page grid (see showpack.js SHOWPACK_CARDS_PER_PAGE) -
                // must match that client-side page size or the timeout undercounts.
                const int cardsPerPage = 25;
                string boosterId = GetString(item, "boosterId", "");
                Dictionary<string, object> settings = server.ReadSettingsObject();
                int cardCount = 0;
                object boostersObj;
                if (settings.TryGetValue("boosters", out boostersObj) && boostersObj is object[])
                {
                    foreach (object bo in (object[])boostersObj)
                    {
                        Dictionary<string, object> booster = bo as Dictionary<string, object>;
                        if (booster == null || GetString(booster, "id", "") != boosterId) continue;
                        object cardIdsObj;
                        if (booster.TryGetValue("cardIds", out cardIdsObj) && cardIdsObj is object[]) cardCount = ((object[])cardIdsObj).Length;
                        break;
                    }
                }
                if (cardCount == 0) cardCount = 1;
                int totalPages = (int)Math.Ceiling(cardCount / (double)cardsPerPage);
                int secondsPerPage = 12;
                object showcaseObj;
                if (settings.TryGetValue("showcase", out showcaseObj) && showcaseObj is Dictionary<string, object>)
                {
                    secondsPerPage = Math.Max(2, GetInt((Dictionary<string, object>)showcaseObj, "secondsPerBooster", 12));
                }
                return totalPages * (secondsPerPage * 1000 + 300) + 8000;
            }
            if (kind == "ranking")
            {
                // Battle ranking cycles through up to 4 phases, tournament ranking through 2
                // (wins, participations); card/trade ranking show a single list.
                // GetInt on the item itself: displaySeconds was stored on it by HandleRankingCommand.
                int displaySeconds = Math.Max(2, GetInt(item, "displaySeconds", 8));
                string rankingType = GetString(item, "type", "card");
                int phases = rankingType == "battle" ? 4 : rankingType == "tournament" ? 2 : 1;
                return phases * (displaySeconds * 1000 + 500) + 8000;
            }
            if (kind == "trade")
            {
                // Longest configured trade animation duration ("long" ~9s) plus a safety margin.
                return 20000;
            }
            if (kind == "gift")
            {
                // One-shot reveal (envelope/handover/confetti), all well under 10s - generous margin.
                return 15000;
            }
            if (kind == "communitygoalreached")
            {
                // Matches the overlay's fixed 6s celebration display (see communitygoal.js) plus
                // a safety margin.
                return 12000;
            }
            if (kind == "tournamentbye" || kind == "teamkampfresult")
            {
                // No overlay animation is involved (just chat + enqueuing reward draws as separate
                // future items) - nothing will ever send a completion ack for these, so don't make
                // the queue sit out a real timeout. Before this fix, "teamkampfresult" fell through
                // to the generic 30s default (no case matched it here) and genuinely blocked for the
                // full 30 seconds after every single Team-Kampf before any reward draws could start -
                // the actual "battle" animation ahead of it in the queue already blocks correctly on
                // its own real completion ack, so this item needs no timeout of its own at all.
                return 200;
            }
            if (kind == "tournamentwon")
            {
                // Unlike tournamentbye, THIS one does have a real overlay animation - the champion's
                // "zoom out to the completed tree, final branch turns gold" reveal (see
                // playBracketReveal in battle.js) - and it now acks completion via the SAME eventId
                // the item carries (see the "tournamentwon" broadcast above). This is only the
                // fallback for if the overlay never acks (not connected, animation off): long enough
                // to cover the reveal's own ~4-5s runtime plus margin, so the queue doesn't move on to
                // the winner's pack-draw animations while the reveal might still be playing.
                return 8000;
            }
            if (kind == "battle")
            {
                // A normal 1v1/tournament duel's HP-Leisten-Duell is capped at ~28s client-side
                // (see battle.js maxTotalMs); clash/ranged rounds are shorter. A Team-Kampf can
                // have far more matchups than a single duel though (one per eliminated card on
                // either side), so scale the ceiling with how many matchups this item actually
                // carries instead of using the flat 40s that's generous enough for a normal duel
                // but not for a whole team fight.
                object matchupsObj;
                int matchupCount = item.TryGetValue("hpMatchups", out matchupsObj) && matchupsObj is object[] ? ((object[])matchupsObj).Length : 0;
                if (matchupCount > 1) return Math.Min(180000, 10000 + matchupCount * 6000);
                return 40000;
            }
            if (kind == "teamkampfresult")
            {
                // No overlay animation - just chat + the reward/penalty draws it enqueues.
                return 200;
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
                // Runs on every wake-up (a new Enqueue, a completed item, or just the 1s timeout) -
                // catches the moment a bracket event finishes regardless of which code path cleared
                // it, without needing an explicit call at every one of those paths.
                FlushDeferredQueueIfIdle();
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
                string itemKind = GetString(item, "kind", "");
                // tournamentbye/teamkampfresult are chat-only bookkeeping items with no overlay
                // animation at all - nothing will EVER ack them, so warning as if an OBS source
                // might be missing would be actively misleading every single time. tournamentwon
                // DOES have a real animation now (the champion's bracket reveal) and acks like any
                // other - so it's deliberately NOT suppressed here anymore; a missing ack for it is
                // a genuine "is OBS open?" case.
                if (!acked && itemKind != "tournamentbye" && itemKind != "teamkampfresult")
                {
                    server.Log("queue", "warn", "Keine Abschluss-Rueckmeldung vom Overlay fuer \"" + itemKind + "\" - nach Timeout fortgefahren. Ist die passende OBS-Quelle geoeffnet und aktuell?");
                }
                awaitingEventId = null;

                // Post-animation chat: any message that must NOT be shown before the animation has
                // finished playing (a card-draw's "you got X" or a duel's winner reveal) is sent
                // HERE, once the overlay has acked completion (or the safety timeout elapsed) - never
                // when the item was enqueued or mid-animation, so chat can't spoil the outcome. The
                // draw's message is rebuilt from the item's server-picked card titles; other kinds
                // carry a ready-made string in "completionChat".
                try
                {
                    if (itemKind == "draw")
                    {
                        SendDrawPostMessage(item, GetString(item, "cardTitle", ""), GetString(item, "boosterTitle", ""));
                    }
                    string completionChat = GetString(item, "completionChat", "");
                    if (!String.IsNullOrEmpty(completionChat)) SendChatMessageSafe(completionChat);
                }
                catch (Exception ex) { server.Log("queue", "error", "Abschluss-Chatnachricht fehlgeschlagen: " + ex.Message); }

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

            if (kind == "communitygoalreached")
            {
                // Plays as its own serialized queue item (see RegisterCommunityGoalDraw) so it
                // never overlaps the draw that completed the stage. The chat message and bonus
                // draws for every participant are triggered here, once it's this item's turn.
                // Target/bonusCards/celebrationMessage are baked in at enqueue time (rather than
                // re-read from settings.communityGoal.stages by index) so a later admin edit to
                // the stage list can never point this already-queued item at the wrong stage.
                int target = GetInt(item, "target", 0);
                int bonusCards = Math.Max(1, GetInt(item, "bonusCards", 1));
                string celebrationMessage = GetString(item, "celebrationMessage", DefaultCommunityGoalMessage);
                SendChatMessageSafe(celebrationMessage);

                var celebrationEvent = new Dictionary<string, object>
                {
                    { "eventId", GetString(item, "id", DateTime.UtcNow.Ticks.ToString()) },
                    { "target", target },
                    { "bonusCards", bonusCards },
                    { "message", celebrationMessage }
                };
                server.Broadcast("communitygoalreached", server.Serializer.Serialize(celebrationEvent));

                object participantsObj;
                if (item.TryGetValue("participants", out participantsObj) && participantsObj is object[])
                {
                    foreach (object po in (object[])participantsObj)
                    {
                        Dictionary<string, object> participant = po as Dictionary<string, object>;
                        if (participant == null) continue;
                        string pLogin = GetString(participant, "login", "");
                        string pName = GetString(participant, "displayName", pLogin);
                        if (String.IsNullOrEmpty(pLogin)) continue;
                        for (int i = 0; i < bonusCards; i++) Enqueue("draw", pLogin, pName, "communitygoal");
                    }
                }
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
                // Card-name chat text, same for both triggers (channel points and !collection) and
                // fired right as the showcase animation actually starts, not early/late relative to
                // whatever else was ahead of it in the queue.
                SendCollectionChatText(login, user);
                return;
            }

            if (kind == "showpack")
            {
                string boosterId = GetString(item, "boosterId", "");
                string boosterTitle = GetString(item, "boosterTitle", "");
                server.Log("draw", "info", user + " hat das Pack '" + boosterTitle + "' angezeigt.");
                var showPackEvent = new Dictionary<string, object>
                {
                    { "eventId", GetString(item, "id", DateTime.UtcNow.Ticks.ToString()) },
                    { "user", user },
                    { "userLogin", login },
                    { "source", source },
                    { "boosterId", boosterId },
                    { "boosterTitle", boosterTitle }
                };
                server.Broadcast("showpack", server.Serializer.Serialize(showPackEvent));
                // Fired right as the overlay reveal actually starts, same timing rule as
                // SendCollectionChatText above.
                SendShowPackChatText(login, user, boosterId, boosterTitle);
                return;
            }

            if (kind == "trade" || kind == "battle" || kind == "gift")
            {
                // A tournament match's round-announce chat message is sent HERE - when the queue
                // actually reaches this item - rather than when the whole bracket was resolved
                // (all at once, well before earlier matches finish playing). This keeps chat
                // commentary timing aligned with what's actually animating in OBS at that moment,
                // the same fix applied to the community-goal celebration earlier.
                if (kind == "battle" && item.ContainsKey("tournamentRound"))
                {
                    Dictionary<string, object> tCfg = Obj(server.ReadSettingsObject(), "tournament");
                    SendChatMessageSafe(GetString(tCfg, "roundAnnounceMessage", DefaultTournamentRoundAnnounce)
                        .Replace("[Runde]", GetString(item, "tournamentRound", ""))
                        .Replace("[SpielerA]", GetString(item, "userA", ""))
                        .Replace("[SpielerB]", GetString(item, "userB", "")));
                }

                // Live-ticker entry only for a genuine standalone !battle duel, not a tournament
                // round (those already get their own bracket chat commentary above, and their
                // eventual champion gets a "tournamentwon" ticker entry once the whole thing ends).
                if (kind == "battle" && !item.ContainsKey("tournamentRound"))
                {
                    string winnerUser = GetString(item, "winnerUser", "");
                    string loserUser = GetString(item, "loserUser", "");
                    if (!String.IsNullOrEmpty(winnerUser) && !String.IsNullOrEmpty(loserUser))
                    {
                        Dictionary<string, object> ltCfg = Obj(server.ReadSettingsObject(), "liveTicker");
                        string text = GetString(ltCfg, "battleMessage", DefaultLiveTickerBattleMessage)
                            .Replace("@userNameA", winnerUser)
                            .Replace("@userNameB", loserUser);
                        PushLiveTickerEntry("battle", text, GetUserAvatarUrl(GetString(item, "winnerLogin", "")));
                    }
                }

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
                // Never broadcast the post-animation chat text to the overlay - it's server-only
                // (sent by QueueLoop once the animation finishes), and it names the winner.
                animEvent.Remove("completionChat");
                server.Broadcast(kind, server.Serializer.Serialize(animEvent));
                return;
            }

            if (kind == "tournamentbye")
            {
                Dictionary<string, object> tCfg = Obj(server.ReadSettingsObject(), "tournament");
                SendChatMessageSafe(GetString(tCfg, "byeAnnounceMessage", DefaultTournamentByeAnnounce)
                    .Replace("[Runde]", GetString(item, "tournamentRound", ""))
                    .Replace("[Spieler]", user));
                return;
            }

            if (kind == "tournamentwon")
            {
                Dictionary<string, object> tCfg = Obj(server.ReadSettingsObject(), "tournament");
                int totalParticipants = GetInt(item, "totalParticipants", 0);
                // 0 is a deliberate, valid value here (championDrawsEnabled turned off) - not the
                // "field missing" case, so this must not floor to 1 like most other GetInt uses.
                int winnerDraws = Math.Max(0, GetInt(item, "winnerDraws", 0));
                SendChatMessageSafe(GetString(tCfg, "winnerAnnounceMessage", DefaultTournamentWinnerAnnounce)
                    .Replace("@userName", "@" + user)
                    .Replace("[Teilnehmerzahl]", totalParticipants.ToString())
                    .Replace("[Anzahl]", winnerDraws.ToString()));
                server.Log("commands", "info", user + " hat das Turnier mit " + totalParticipants + " Teilnehmern gewonnen.");
                server.RecordTournamentWin(login, user);

                {
                    Dictionary<string, object> ltCfg = Obj(server.ReadSettingsObject(), "liveTicker");
                    string tickerText = GetString(ltCfg, "tournamentMessage", DefaultLiveTickerTournamentMessage)
                        .Replace("@userName", user)
                        .Replace("[Teilnehmerzahl]", totalParticipants.ToString());
                    PushLiveTickerEntry("tournament", tickerText, GetUserAvatarUrl(login));
                }

                // Every round winner's draw (if that setting is enabled) was deliberately held
                // back until now instead of playing right after their own match - see
                // ResolveTournamentSignup - so the bracket isn't interrupted by pack-opening
                // animations mid-tournament. They play here, before the champion's own bonus
                // draws, so the tournament properly ends on the biggest reward.
                object perRoundDrawsObj;
                if (item.TryGetValue("perRoundDraws", out perRoundDrawsObj) && perRoundDrawsObj is object[])
                {
                    foreach (object po in (object[])perRoundDrawsObj)
                    {
                        Dictionary<string, object> p = po as Dictionary<string, object>;
                        if (p == null) continue;
                        string pLogin = GetString(p, "login", "");
                        string pName = GetString(p, "displayName", pLogin);
                        if (String.IsNullOrEmpty(pLogin)) continue;
                        Enqueue("draw", pLogin, pName, "tournament");
                    }
                }

                for (int i = 0; i < winnerDraws; i++) Enqueue("draw", login, user, "tournament");

                // Broadcast the fully-resolved bracket so the overlay can play the same "zoom out
                // to the tree, final branch turns gold, champion's name locked in" reveal every
                // earlier round gets (see playBracketReveal in battle.js) - there's no further
                // match afterwards to trigger that reveal naturally, so it's fired here instead.
                // Carries the SAME eventId as this queue item so the overlay's completion ack (see
                // enqueueTournamentWon/runQueue in battle.js) actually releases the queue once the
                // multi-second reveal animation finishes - without it, the queue moved on after the
                // generic 200ms "no overlay animation" timeout (see ComputeQueueTimeoutMs) while the
                // reveal was still playing, so the winner's first pack-draw animation started
                // visibly overlapping it in the background.
                object championBracketObj;
                if (item.TryGetValue("bracket", out championBracketObj) && championBracketObj is Dictionary<string, object>)
                {
                    server.Broadcast("tournamentwon", server.Serializer.Serialize(new Dictionary<string, object>
                    {
                        { "bracket", championBracketObj },
                        { "eventId", GetString(item, "id", "") }
                    }));
                }
                return;
            }

            if (kind == "teamkampfresult")
            {
                // Fires only once the (single, multi-matchup) "battle" item ahead of it in the
                // queue has actually finished playing in the overlay - same "chat commentary
                // timing tracks real animation playback" reasoning as tournamentwon above.
                Dictionary<string, object> tbCfg = Obj(server.ReadSettingsObject(), "teamBattle");
                bool communityWon = GetBool(item, "communityWon", false);
                string streamerName = GetString(item, "streamerName", "Streamer");

                // NOTE: the difficulty rubber-band adjustment is recorded synchronously in
                // ResolveTeamBattleSignup instead of here, the instant the outcome is known -
                // not here, since this queue item can sit unprocessed for a while (up to the
                // "battle" item ahead of it timing out, ~180s for a big fight) if the overlay is
                // slow to ack or a streamer starts the next signup right away.
                object participantsObj;
                var participants = new List<Dictionary<string, object>>();
                if (item.TryGetValue("participants", out participantsObj) && participantsObj is List<Dictionary<string, object>>)
                {
                    participants = (List<Dictionary<string, object>>)participantsObj;
                }

                foreach (Dictionary<string, object> statParticipant in participants)
                {
                    string statLogin = GetString(statParticipant, "login", "");
                    string statName = GetString(statParticipant, "displayName", statLogin);
                    if (String.IsNullOrEmpty(statLogin)) continue;
                    server.RecordTeamKampfParticipation(statLogin, statName);
                    server.RecordTeamKampfResult(statLogin, statName, communityWon);
                }

                SendChatMessageSafe((communityWon
                        ? GetString(tbCfg, "winMessage", DefaultTeamBattleWinMessage)
                        : GetString(tbCfg, "loseMessage", DefaultTeamBattleLoseMessage))
                    .Replace("@streamerName", streamerName)
                    .Replace("[Teilnehmerzahl]", participants.Count.ToString()));

                {
                    Dictionary<string, object> ltSettings = server.ReadSettingsObject();
                    Dictionary<string, object> ltCfg = Obj(ltSettings, "liveTicker");
                    string siegerName = communityWon
                        ? (GetString(ltSettings, "language", "de") == "en" ? "The community" : "Die Community")
                        : streamerName;
                    string tickerText = GetString(ltCfg, "teamBattleMessage", DefaultLiveTickerTeamBattleMessage)
                        .Replace("[Sieger]", siegerName)
                        .Replace("@streamerName", streamerName);
                    PushLiveTickerEntry("teamkampf", tickerText, null);
                }

                // "Pro besiegter Karte eine Karte" - independent of the overall win/loss (a
                // participant can defeat streamer cards even in a Team-Kampf the community
                // ultimately loses) and independent of the finisher/win rewards below, which is why
                // it's handled here rather than nested inside the communityWon branch. The draws
                // are only ever enqueued once, right here, at the very end of the whole fight - see
                // defeatsByLogin (tallied in ResolveTeamBattleSignup) for why this can only be
                // computed once the whole HP-elimination result is known.
                if (GetBool(tbCfg, "perDefeatEnabled", false))
                {
                    int perDefeatDraws = Math.Max(1, GetInt(tbCfg, "perDefeatDraws", 1));
                    object defeatsObj;
                    if (item.TryGetValue("defeatsByLogin", out defeatsObj) && defeatsObj is Dictionary<string, object>)
                    {
                        Dictionary<string, object> defeatsByLoginMap = (Dictionary<string, object>)defeatsObj;
                        foreach (Dictionary<string, object> p in participants)
                        {
                            string pLogin = GetString(p, "login", "");
                            string pName = GetString(p, "displayName", pLogin);
                            if (String.IsNullOrEmpty(pLogin)) continue;
                            object countObj;
                            int defeatCount = defeatsByLoginMap.TryGetValue(pLogin, out countObj) ? Convert.ToInt32(countObj) : 0;
                            if (defeatCount <= 0) continue;
                            int totalDraws = defeatCount * perDefeatDraws;
                            if (GetBool(tbCfg, "perDefeatAnnounceEnabled", true))
                            {
                                SendChatMessageSafe(GetString(tbCfg, "perDefeatMessage", DefaultTeamBattlePerDefeatMessage)
                                    .Replace("@userName", "@" + pName)
                                    .Replace("[AnzahlBesiegt]", defeatCount.ToString())
                                    .Replace("[Anzahl]", totalDraws.ToString()));
                            }
                            for (int i = 0; i < totalDraws; i++) Enqueue("draw", pLogin, pName, "teamkampf");
                        }
                    }
                }

                if (communityWon)
                {
                    if (GetBool(tbCfg, "rewardsEnabled", true))
                    {
                        int drawsPerParticipant = Math.Max(0, GetInt(tbCfg, "drawsPerParticipant", 1));
                        foreach (Dictionary<string, object> p in participants)
                        {
                            string pLogin = GetString(p, "login", "");
                            string pName = GetString(p, "displayName", pLogin);
                            if (String.IsNullOrEmpty(pLogin)) continue;
                            for (int i = 0; i < drawsPerParticipant; i++) Enqueue("draw", pLogin, pName, "teamkampf");
                        }
                    }

                    // Who landed the finishing blow, announced separately from the general win
                    // message - only relevant when the community actually won (a streamer win has
                    // no "finisher" to credit). The bonus-draw count is only mentioned when that
                    // bonus is actually enabled, via a distinct message template rather than a
                    // token that would otherwise have to disappear conditionally mid-sentence.
                    string finisherLogin = GetString(item, "finisherLogin", "");
                    string finisherDisplayName = GetString(item, "finisherDisplayName", finisherLogin);
                    bool finisherBonusEnabled = GetBool(tbCfg, "finisherBonusEnabled", true);
                    int finisherBonusDraws = Math.Max(0, GetInt(tbCfg, "finisherBonusDraws", 1));
                    if (!String.IsNullOrEmpty(finisherLogin))
                    {
                        SendChatMessageSafe((finisherBonusEnabled
                                ? GetString(tbCfg, "finisherAnnounceMessage", DefaultTeamBattleFinisherMessage)
                                : GetString(tbCfg, "finisherAnnounceMessageNoBonus", DefaultTeamBattleFinisherMessageNoBonus))
                            .Replace("@userName", "@" + finisherDisplayName)
                            .Replace("[Anzahl]", finisherBonusDraws.ToString()));
                        if (finisherBonusEnabled)
                        {
                            for (int i = 0; i < finisherBonusDraws; i++) Enqueue("draw", finisherLogin, finisherDisplayName, "teamkampf");
                        }
                    }
                }
                else if (GetBool(tbCfg, "loseCardOnDefeat", false))
                {
                    bool lostCardAnnounceEnabled = GetBool(tbCfg, "lostCardAnnounceEnabled", true);
                    foreach (Dictionary<string, object> p in participants)
                    {
                        string pLogin = GetString(p, "login", "");
                        string pName = GetString(p, "displayName", pLogin);
                        string boosterId = GetString(p, "boosterId", "");
                        string cardId = GetString(p, "cardId", "");
                        if (String.IsNullOrEmpty(pLogin) || String.IsNullOrEmpty(boosterId) || String.IsNullOrEmpty(cardId)) continue;
                        server.RemoveSingleCardAllowZero(pLogin, pName, boosterId, cardId);
                        if (lostCardAnnounceEnabled)
                        {
                            Dictionary<string, string> lostCardInfo = server.CardDisplayInfo(boosterId, cardId);
                            SendChatMessageSafe(GetString(tbCfg, "lostCardMessage", DefaultTeamBattleLostCardMessage)
                                .Replace("@userName", "@" + pName)
                                .Replace("[Kartenname]", lostCardInfo["cardTitle"])
                                .Replace("[Boostername]", lostCardInfo["boosterTitle"]));
                        }
                    }
                }
                return;
            }

            if (kind == "draw")
            {
                // Booster AND card are picked here on the server (weighted by booster score and
                // rarity weight). Broadcasting the concrete cardId means every overlay shows the
                // same card, and - crucially - the server knows the drawn card/booster by name, so
                // the post-animation chat message works regardless of the overlay's cached version.
                // "Pick your own pack" (channel-points reward + matching chat command, see
                // HandleSpecificPackDraw) already resolved and validated the exact booster the
                // viewer asked for BEFORE this item was ever enqueued - it's carried here as
                // "forcedBoosterId" and takes priority over the normal random pick. Everything else
                // below (pity, rarity weighting within that one booster, etc.) behaves exactly like
                // any other draw.
                string forcedBoosterId = GetString(item, "forcedBoosterId", "");
                bool subExclusivePool = GetString(item, "boosterPool", "") == "subExclusive";
                string boosterId = !String.IsNullOrWhiteSpace(forcedBoosterId) ? forcedBoosterId : PickRandomBoosterId(subExclusivePool);
                if (String.IsNullOrWhiteSpace(boosterId))
                {
                    server.Log("draw", subExclusivePool ? "warn" : "error",
                        user + " hat " + (subExclusivePool ? "eine Sub-Belohnung" : "ein Kartenpack") + " ausgeloest, aber kein " +
                        (subExclusivePool ? "Sub-exklusiver Booster" : "Booster") + " war verfuegbar.");
                    return;
                }
                Dictionary<string, object> settings = server.ReadSettingsObject();
                Dictionary<string, object> booster = FindBooster(settings, boosterId);

                // Pity system: guarantees at least "minRarity" once a viewer has had "threshold"
                // consecutive draws (via either channel points or the chat command - this is the
                // single place both paths funnel through) that didn't reach it, OR immediately if
                // they have banked "!dust" credit left over (see HandleDustCommand).
                Dictionary<string, object> pityCfg = Obj(settings, "pity");
                bool pityEnabled = GetBool(pityCfg, "enabled", false);
                string pityMinRarity = GetString(pityCfg, "minRarity", "rare");
                int pityThreshold = Math.Max(1, GetInt(pityCfg, "threshold", 10));

                Dictionary<string, object> pityEntry = pityEnabled ? GetPityEntry(login) : null;
                int pityStreak = pityEntry != null ? GetInt(pityEntry, "streak", 0) : 0;
                int pityBank = pityEntry != null ? GetInt(pityEntry, "bank", 0) : 0;
                // streak and bank are the SAME currency (both count "!dust"/"!dustall" points and
                // natural non-hit draws in the same units - see HandleDustCommand/
                // HandleDustAllCommand) so they're combined into one pool here rather than checked
                // separately: a leftover bank remainder below one full threshold used to just sit
                // there forever instead of counting toward the streak's own progress. A forced
                // guarantee costs exactly one pityThreshold out of the combined total - if the bank
                // alone already holds several multiples of the threshold, each subsequent eligible
                // draw keeps forcing (and draining threshold worth of pool) until it drops below it.
                int pityTotal = pityStreak + pityBank;
                bool forcePity = pityEnabled && pityTotal >= pityThreshold;

                Dictionary<string, object> card = PickCardFromBooster(settings, boosterId, forcePity ? pityMinRarity : null);

                if (pityEnabled)
                {
                    bool metPity = card != null && CardPackServer.GetRarityRank(GetString(card, "rarity", "common")) >= CardPackServer.GetRarityRank(pityMinRarity);
                    if (metPity)
                    {
                        pityEntry["streak"] = 0;
                        // Only actually drain the pool if THIS draw was the one forcing it - a
                        // naturally lucky hit (rarity RNG landed on pityMinRarity+ on its own,
                        // without needing to be forced) must not eat into banked credit.
                        if (forcePity) pityEntry["bank"] = pityTotal - pityThreshold;
                    }
                    else
                    {
                        pityEntry["streak"] = pityStreak + 1;
                    }
                    SavePityEntry(login, pityEntry);
                }

                // Community goal: every draw (any trigger, including this method's own bonus
                // draws once the goal is reached - RegisterCommunityGoalDraw no-ops while frozen)
                // counts toward the shared progress bar.
                RegisterCommunityGoalDraw(login, user);

                string cardId = card != null ? GetString(card, "id", "") : "";
                string cardTitle = card != null ? GetString(card, "title", "") : "";
                string boosterTitle = booster != null ? GetString(booster, "title", "") : "";
                string boosterSubtitle = booster != null ? GetString(booster, "subtitle", "") : "";
                item["cardTitle"] = cardTitle;
                item["boosterTitle"] = boosterTitle;
                item["boosterSubtitle"] = boosterSubtitle;
                item["cardId"] = cardId;
                item["boosterId"] = boosterId;
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
                GetBool(Obj(cc, "packs"), "enabled", true) ||
                GetBool(Obj(cc, "collection"), "enabled", true) ||
                GetBool(Obj(cc, "trade"), "enabled", true) ||
                GetBool(Obj(cc, "tradeyes"), "enabled", true) ||
                GetBool(Obj(cc, "tradeno"), "enabled", true) ||
                GetBool(Obj(cc, "tournamentStart"), "enabled", true) ||
                GetBool(Obj(cc, "tournamentJoin"), "enabled", true) ||
                GetBool(Obj(cc, "teamBattleStart"), "enabled", true) ||
                GetBool(Obj(cc, "teamBattleJoin"), "enabled", true);

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
                // Handed to the ordered dispatch worker instead of processed inline: this loop
                // must get back to ReceiveAsync immediately so the NEXT frame is read right away
                // (HandleChatEventSubMessage does synchronous work - settings parse, Twitch API
                // calls for replies - that would otherwise stall the socket read). A single
                // ordered worker (not one Task per message, which an earlier fix tried) so
                // messages are still processed strictly in arrival order - !trade before
                // !tradeyes - and a burst of messages can't fan out into a dozen concurrent
                // handlers all contending for the settings lock at once.
                DispatchEventSubWork(delegate { HandleChatEventSubMessage(text); });
            }
        }

        // Single ordered background worker both EventSub sockets (chat + channel points) hand
        // their notifications to. Keeps the receive loops permanently ready to read the next
        // frame while guaranteeing first-in-first-out processing across all Twitch events.
        private readonly object eventDispatchLock = new object();
        private readonly Queue<Action> eventDispatchQueue = new Queue<Action>();
        private bool eventDispatchWorkerRunning;

        private void DispatchEventSubWork(Action work)
        {
            lock (eventDispatchLock)
            {
                eventDispatchQueue.Enqueue(work);
                if (eventDispatchWorkerRunning) return;
                eventDispatchWorkerRunning = true;
            }
            Task.Factory.StartNew(EventDispatchLoop);
        }

        private void EventDispatchLoop()
        {
            while (true)
            {
                Action work;
                lock (eventDispatchLock)
                {
                    if (eventDispatchQueue.Count == 0) { eventDispatchWorkerRunning = false; return; }
                    work = eventDispatchQueue.Dequeue();
                }
                try { work(); }
                catch (Exception ex) { server.Log("twitch", "error", "EventSub-Verarbeitung fehlgeschlagen: " + ex.Message); }
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

        // ---- Outbound queue: every chat send / whisper / avatar-enriched overlay broadcast is
        // a synchronous Twitch API round-trip (~200-500ms each). Doing that inline on the event
        // dispatch worker (see DispatchEventSubWork) meant a burst of commands - e.g. several
        // viewers joining !teamkampf/!turnier back to back - serialized all those network calls
        // BEFORE later viewers' commands were even parsed, so their chat replies arrived seconds
        // late. This second ordered FIFO worker takes all outbound network I/O off the event
        // worker: command processing itself is now pure local work (milliseconds), and replies
        // still go out strictly in order because a single worker drains this queue too. ----
        private readonly object outboundLock = new object();
        private readonly Queue<Action> outboundQueue = new Queue<Action>();
        private bool outboundWorkerRunning;

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

        // ---- Automatic "which commands are available" help message: fires after N minutes
        // and/or N chat messages since the last time it was sent (whichever is enabled/reached
        // first), listing every currently-enabled command with its short description. ----
        private readonly object autoHelpLock = new object();
        private int autoHelpMessageCounter;
        private DateTime autoHelpLastSentAt = DateTime.UtcNow;

        // Called on every incoming chat message - only handles the message-count side (the time
        // side is handled by the independent timer below, since a chat-message-driven check would
        // never fire the time trigger during a quiet chat with 0 chat activity).
        private void CheckAutoHelp(Dictionary<string, object> settings, Dictionary<string, object> cc)
        {
            Dictionary<string, object> autoHelp = Obj(settings, "autoHelp");
            if (!GetBool(autoHelp, "enabled", false)) return;
            int intervalMessages = Math.Max(0, GetInt(autoHelp, "intervalMessages", 0));
            if (intervalMessages <= 0) return;

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

        private bool autoHelpTimerStarted;
        private System.Threading.Timer autoHelpTimer;

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

        private const string DefaultAutoHelpMessage = "📋 Verfügbare Befehle: [Befehle]";

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
                    if (!IsGlobalCommandOnCooldown("tournamentStart", cooldownSeconds, displayName, cooldownMessage))
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
                    if (!IsGlobalCommandOnCooldown("teamBattleStart", cooldownSeconds, displayName, cooldownMessage))
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

        // Global (not per-user) cooldown for chat commands that start a shared/community event
        // (tournament, team battle) - mirrors the "Globaler Cooldown" already used for these same
        // actions' channel-point rewards, so a Nicht-Affiliate/Partner using the chat command
        // instead gets the same spam protection. Returns true (and sends the cooldown message) if
        // still blocked; otherwise marks the cooldown as started and returns false.
        private readonly object commandCooldownLock = new object();
        private readonly Dictionary<string, DateTime> commandCooldownUntil = new Dictionary<string, DateTime>();

        private bool IsGlobalCommandOnCooldown(string key, int cooldownSeconds, string displayName, string cooldownMessageTemplate)
        {
            if (cooldownSeconds <= 0) return false;
            DateTime now = DateTime.UtcNow;
            lock (commandCooldownLock)
            {
                DateTime until;
                if (commandCooldownUntil.TryGetValue(key, out until) && until > now)
                {
                    int remaining = (int)Math.Ceiling((until - now).TotalSeconds);
                    SendChatMessageSafe(cooldownMessageTemplate
                        .Replace("@userName", "@" + displayName)
                        .Replace("[Restzeit]", remaining.ToString()));
                    return true;
                }
                commandCooldownUntil[key] = now.AddSeconds(cooldownSeconds);
                return false;
            }
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
                SendChatMessageSafe(GetString(cmdCfg, "usageMessage", DefaultSpecificPackUsage)
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
                SendChatMessageSafe(GetString(cmdCfg, "notFoundMessage", DefaultSpecificPackNotFound)
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
            Dictionary<string, object> cmdCfg = Obj(Obj(settingsIn != null ? settingsIn : server.ReadSettingsObject(), "chatCommands"), "showPack");
            if (!GetBool(cmdCfg, "chatOutputEnabled", true)) return;
            try
            {
                string mode = GetString(cmdCfg, "outputMode", "chat");
                List<Dictionary<string, string>> owned = server.GetUserOwnedCardsWithInfo(login);
                var inPack = owned.FindAll(delegate (Dictionary<string, string> entry) { return entry["boosterId"] == boosterId; });
                if (inPack.Count == 0)
                {
                    SendCollectionOutput(login, mode, GetString(cmdCfg, "emptyMessage", DefaultShowPackEmpty)
                        .Replace("@userName", "@" + displayName)
                        .Replace("[Boostername]", boosterTitle));
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
                    .Replace("[Boostername]", boosterTitle);
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
            string rest = args.Trim();
            int lastSpace = rest.LastIndexOf(' ');
            if (lastSpace < 0)
            {
                SendChatMessageSafe(GetString(dustCfg, "usageMessage", DefaultDustUsage).Replace("@userName", "@" + displayName));
                return;
            }
            string cardName = rest.Substring(0, lastSpace).Trim();
            string countText = rest.Substring(lastSpace + 1).Trim();
            int count;
            if (cardName.Length == 0 || !Int32.TryParse(countText, out count) || count < 1)
            {
                SendChatMessageSafe(GetString(dustCfg, "usageMessage", DefaultDustUsage).Replace("@userName", "@" + displayName));
                return;
            }

            Dictionary<string, object> card = server.ResolveCardByName(cardName);
            if (!Convert.ToBoolean(card["found"]))
            {
                SendChatMessageSafe(GetString(dustCfg, "cardNotFoundMessage", DefaultDustCardNotFound)
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
                SendChatMessageSafe(GetString(dustCfg, "notEnoughMessage", DefaultDustNotEnough)
                    .Replace("@userName", "@" + displayName)
                    .Replace("[Kartenname]", cardTitle)
                    .Replace("[Besitz]", owned.ToString()));
                return;
            }

            if (!server.RemoveCardCopies(login, displayName, boosterId, cardId, count))
            {
                // Lost a race against a trade/draw between the check above and here - safe to
                // just ask the viewer to retry rather than silently drop their points.
                SendChatMessageSafe(GetString(dustCfg, "notEnoughMessage", DefaultDustNotEnough)
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

            SendChatMessageSafe(GetString(dustCfg, "successMessage", DefaultDustSuccess)
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
        private static void ComputePityProgress(int streak, int bank, int threshold, out int readyGuarantees, out int drawsUntilNext)
        {
            int total = streak + bank;
            readyGuarantees = total / threshold;
            drawsUntilNext = threshold - (total % threshold);
        }

        // Rarity name aliases accepted by "!dustset", one set per supported UI language (see
        // admin.js's "rarity-*" i18n keys - kept in sync with those exact translations) plus their
        // ASCII/no-diacritics form so a viewer typing without special characters (e.g. "legendaer"
        // instead of "legendär") still matches. Canonical English rarity id -> list of accepted
        // spoken words across de/en/fr/es/th.
        private static readonly Dictionary<string, string[]> DustSetRarityAliases = new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase)
        {
            { "common", new[] { "common", "gewöhnlich", "gewoehnlich", "commune", "commun", "común", "comun", "ธรรมดา" } },
            { "uncommon", new[] { "uncommon", "ungewöhnlich", "ungewoehnlich", "peu commune", "peu commun", "poco común", "poco comun", "ไม่ธรรมดา" } },
            { "rare", new[] { "rare", "selten", "rara", "หายาก" } },
            { "epic", new[] { "epic", "episch", "épique", "epique", "épica", "epica", "เอพิก" } },
            { "legendary", new[] { "legendary", "legendär", "legendaer", "légendaire", "legendaire", "legendaria", "ตำนาน" } },
            { "holo", new[] { "holo", "โฮโล" } }
        };

        // Parses a "!dustset <rarity>" argument (the whole remainder of the message, since some
        // language's rarity names contain a space, e.g. French "peu commune") against every
        // supported language's rarity name. Returns null if nothing matches.
        private static string ParseDustSetRarity(string input)
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
                SendChatMessageSafe(GetString(dustAllCfg, "nothingMessage", DefaultDustAllNothing)
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

            SendChatMessageSafe(GetString(dustAllCfg, "successMessage", DefaultDustAllSuccess)
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

        // ---- Tournament Mode ----
        //
        // One bracket at a time, global (like activeBattle). Flow: an admin/channel-point/chat
        // trigger opens a signup window (StartTournamentSignup); viewers join with a chat command
        // (JoinTournament) until the window closes; ResolveTournamentSignup then either cancels
        // (too few participants) or resolves the ENTIRE bracket synchronously (all rounds - match
        // resolution is instant dice-rolling, nothing to wait on) and feeds every match into the
        // existing serialized action queue as ordinary "battle" queue items, so they play out
        // through the normal battle animation one at a time, in bracket order, all by themselves -
        // exactly like the community-goal bonus draws pattern. Chat commentary for each match/bye/
        // the final winner is likewise NOT sent immediately during resolution (which would spam
        // every round's outcome into chat before the corresponding animation has even played and
        // spoil the final winner) - it is sent from ProcessQueueItem only once the queue actually
        // reaches that specific item, so commentary timing always tracks real animation playback.

        // Network I/O (chat messages, avatar lookups) must NEVER happen while tournamentLock is
        // held. ResolveTournamentSignup (fired by the signup timer) needs the very same lock to
        // start the bracket - if a join lands right as the timer elapses and that join is still
        // holding the lock through a slow/hung Twitch API call (WebClient has no explicit timeout,
        // so a stalled request can sit for up to 100s - see TwitchGet), the resolve is blocked
        // behind it, turning "timer ran out" into "wait minutes for a stuck HTTP request". Both
        // methods below only mutate state under the lock, then fire chat/broadcast calls
        // afterward with the lock already released - same fix applied to Team-Kampf.
        public string StartTournamentSignup(string login, string displayName, string source)
        {
            Dictionary<string, object> settings = server.ReadSettingsObject();
            Dictionary<string, object> tCfg = Obj(settings, "tournament");
            if (!GetBool(tCfg, "enabled", false)) return "disabled";

            // Only one bracket event (tournament OR Team-Kampf) may run at a time - a Team-Kampf
            // still playing out its matches would otherwise inject a fight into the middle of this
            // tournament's animations (and vice versa). See IsBracketEventBusy.
            if (IsBracketEventBusy())
            {
                SendChatMessageSafe(GetString(tCfg, "alreadyRunningMessage", DefaultTournamentAlreadyRunning)
                    .Replace("@userName", "@" + (String.IsNullOrEmpty(displayName) ? "Streamer" : displayName)));
                return "already_running";
            }

            bool alreadyRunning = false;
            string startMessage = null;
            string deadlineUtc = null;
            int minParticipantsForBroadcast = 0;
            string joinCommandText = null;

            lock (tournamentLock)
            {
                if (activeTournament != null)
                {
                    alreadyRunning = true;
                }
                else
                {
                    int minParticipants = Math.Max(2, GetInt(tCfg, "minParticipants", 3));
                    int signupSeconds = Math.Max(10, GetInt(tCfg, "signupSeconds", 90));
                    Dictionary<string, object> joinCfg = Obj(Obj(settings, "chatCommands"), "tournamentJoin");
                    joinCommandText = GetString(joinCfg, "prefix", "!") + GetString(joinCfg, "command", "turnier");
                    deadlineUtc = DateTime.UtcNow.AddSeconds(signupSeconds).ToString("o");

                    activeTournament = new Dictionary<string, object>
                    {
                        { "state", "signup" },
                        { "participants", new List<object>() },
                        { "minParticipants", minParticipants },
                        { "lineupSize", Math.Max(1, GetInt(tCfg, "lineupSize", 3)) },
                        { "winnerDraws", Math.Max(1, GetInt(tCfg, "winnerDraws", 1)) },
                        { "deadlineUtc", deadlineUtc },
                        { "startedAt", DateTime.UtcNow.ToString("o") },
                        { "joinCommand", joinCommandText }
                    };

                    startMessage = GetString(tCfg, "signupStartMessage", DefaultTournamentSignupStart)
                        .Replace("[Befehl]", joinCommandText)
                        .Replace("[Sekunden]", signupSeconds.ToString())
                        .Replace("[Mindestteilnehmer]", minParticipants.ToString());
                    minParticipantsForBroadcast = minParticipants;

                    if (tournamentSignupTimer != null) tournamentSignupTimer.Dispose();
                    tournamentSignupTimer = new System.Threading.Timer(delegate { ResolveTournamentSignup(); }, null, signupSeconds * 1000, System.Threading.Timeout.Infinite);
                }
            }

            if (alreadyRunning)
            {
                SendChatMessageSafe(GetString(tCfg, "alreadyRunningMessage", DefaultTournamentAlreadyRunning)
                    .Replace("@userName", "@" + (String.IsNullOrEmpty(displayName) ? "Streamer" : displayName)));
                return "already_running";
            }

            SendChatMessageSafe(startMessage);
            BroadcastTournamentSignupState(new List<object>(), deadlineUtc, minParticipantsForBroadcast, joinCommandText);

            // Whoever spent the channel points to start the tournament obviously wants to play in
            // it - join them automatically instead of making them also type the join command.
            // JoinTournament re-acquires tournamentLock, which is safe here (Monitor locks are
            // reentrant on the same thread) and still applies the normal eligibility check/message.
            if (source == "channelpoints" && !String.IsNullOrEmpty(login))
            {
                JoinTournament(login, displayName);
            }

            return "started";
        }

        // settings: pass the already-loaded settings when the caller has them (ProcessChatMessage
        // does) to skip a redundant re-parse; null falls back to reading them here.
        private void JoinTournament(string login, string displayName, Dictionary<string, object> settingsIn = null)
        {
            string notEligibleMessage = null;
            string joinAckMessage = null;
            List<object> participantsSnapshot = null;
            string deadlineUtc = null;
            int minParticipantsForBroadcast = 0;
            string joinCommandText = null;

            lock (tournamentLock)
            {
                if (activeTournament == null || GetString(activeTournament, "state", "") != "signup") return;
                var participants = (List<object>)activeTournament["participants"];
                string loginKey = login.ToLowerInvariant();
                foreach (object p in participants)
                {
                    Dictionary<string, object> existing = p as Dictionary<string, object>;
                    if (existing != null && GetString(existing, "login", "") == loginKey) return;
                }

                Dictionary<string, object> settings = settingsIn != null ? settingsIn : server.ReadSettingsObject();
                Dictionary<string, object> tCfg = Obj(settings, "tournament");
                int lineupSize = GetInt(activeTournament, "lineupSize", 3);
                List<Dictionary<string, string>> owned = server.GetUserOwnedCardTypes(login);
                if (owned.Count < lineupSize)
                {
                    notEligibleMessage = GetString(tCfg, "notEligibleMessage", DefaultTournamentNotEligible)
                        .Replace("@userName", "@" + displayName)
                        .Replace("[Anzahl]", lineupSize.ToString());
                }
                else
                {
                    participants.Add(new Dictionary<string, object> { { "login", loginKey }, { "displayName", displayName } });
                    if (GetBool(tCfg, "announceJoins", true))
                    {
                        joinAckMessage = GetString(tCfg, "joinAckMessage", DefaultTournamentJoinAck)
                            .Replace("@userName", "@" + displayName)
                            .Replace("[Anzahl]", participants.Count.ToString());
                    }
                    // Snapshot (copy), not the live list reference - BroadcastTournamentSignupState
                    // runs after the lock is released, so it must never iterate the actual
                    // mutable list another thread could be adding to concurrently.
                    participantsSnapshot = new List<object>(participants);
                    deadlineUtc = GetString(activeTournament, "deadlineUtc", "");
                    minParticipantsForBroadcast = GetInt(activeTournament, "minParticipants", 3);
                    joinCommandText = GetString(activeTournament, "joinCommand", "");
                }
            }

            if (notEligibleMessage != null) { SendChatMessageSafe(notEligibleMessage); return; }
            if (joinAckMessage != null) SendChatMessageSafe(joinAckMessage);
            if (participantsSnapshot != null) BroadcastTournamentSignupState(participantsSnapshot, deadlineUtc, minParticipantsForBroadcast, joinCommandText);
        }

        // Broadcasts a SNAPSHOT of the signup state (live participant list with avatars, deadline)
        // - called once at signup start and again after every successful join, so the overlay can
        // show who's already in without waiting for the bracket itself. Takes its data as
        // parameters rather than reading activeTournament directly, since callers now invoke this
        // AFTER releasing tournamentLock (see StartTournamentSignup/JoinTournament) - it must never
        // touch the live mutable state. Always resends the same deadlineUtc (never recomputed), so
        // the client's local countdown never jumps or restarts when a new participant joins
        // mid-countdown. Mirrors BroadcastTeamBattleSignupState - same roster box, same overlay
        // markup (see signup-roster in battle.css/js), just without a revealed lineup row (a
        // tournament bracket has nothing to reveal before it starts).
        private void BroadcastTournamentSignupState(List<object> participants, string deadlineUtc, int minParticipants, string joinCommand)
        {
            // Avatar lookups are one Twitch API call per not-yet-cached participant - routed
            // through the outbound queue so a join's chat processing never waits on them. FIFO
            // ordering in that queue guarantees roster updates still arrive oldest-to-newest.
            DispatchOutboundWork(delegate
            {
                var participantsForBroadcast = new object[participants.Count];
                for (int i = 0; i < participants.Count; i++)
                {
                    Dictionary<string, object> p = participants[i] as Dictionary<string, object>;
                    if (p == null) continue;
                    participantsForBroadcast[i] = new Dictionary<string, object>
                    {
                        { "login", GetString(p, "login", "") },
                        { "displayName", GetString(p, "displayName", "") },
                        { "avatarUrl", GetUserAvatarUrl(GetString(p, "login", "")) }
                    };
                }

                server.Broadcast("tournamentsignup", server.Serializer.Serialize(new Dictionary<string, object>
                {
                    { "active", true },
                    { "deadlineUtc", deadlineUtc },
                    { "minParticipants", minParticipants },
                    { "participants", participantsForBroadcast },
                    { "joinCommand", joinCommand ?? "" }
                }));
            });
        }

        public Dictionary<string, object> GetTournamentState()
        {
            lock (tournamentLock)
            {
                if (activeTournament == null) return new Dictionary<string, object> { { "state", "idle" } };
                var participants = (List<object>)activeTournament["participants"];
                return new Dictionary<string, object>
                {
                    { "state", GetString(activeTournament, "state", "idle") },
                    { "participantCount", participants.Count },
                    { "minParticipants", GetInt(activeTournament, "minParticipants", 3) }
                };
            }
        }

        // Resolves a single 1v1 tournament match (same weighted round/HP-elimination logic as a
        // normal !battle duel) with NO card transfer and NO battle-stats recording - tournament
        // matches only decide bracket advancement, per the "no cards at risk, winner gets pack
        // draws instead" design. Returns the same event shape battle.js already knows how to
        // animate (omitting the prizeCard* fields simply hides the prize line client-side).
        private Dictionary<string, object> ResolveTournamentDuel(
            string userA, List<Dictionary<string, string>> ownedA,
            string userB, List<Dictionary<string, string>> ownedB,
            int lineupSize, Dictionary<string, object> settings)
        {
            List<Dictionary<string, string>> lineupA = DrawRandomLineup(ownedA, lineupSize);
            List<Dictionary<string, string>> lineupB = DrawRandomLineup(ownedB, lineupSize);

            Dictionary<string, object> strengthCfg = Obj(settings, "battleStrength");
            double variance = GetDouble(strengthCfg, "variance", DefaultBattleVariance);
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
                    rounds.Add(new Dictionary<string, object> { { "cardA", lineupA[i] }, { "cardB", lineupB[i] }, { "winner", aWins ? "A" : "B" } });
                }

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
                    rounds.Add(new Dictionary<string, object> { { "cardA", sdA[0] }, { "cardB", sdB[0] }, { "winner", aWins ? "A" : "B" }, { "suddenDeath", true } });
                    suddenDeathRounds++;
                }
            }

            bool winnerIsA = useHpElimination ? GetBool(hpResult, "winnerIsA", winsA >= winsB) : winsA > winsB;

            return new Dictionary<string, object>
            {
                { "userA", userA }, { "userB", userB },
                { "lineupA", lineupA }, { "lineupB", lineupB },
                { "mode", useHpElimination ? "hp" : "rounds" },
                { "rounds", rounds },
                { "hpMatchups", useHpElimination ? hpResult["matchups"] : new object[0] },
                { "winner", winnerIsA ? "A" : "B" },
                { "winsA", winsA }, { "winsB", winsB },
                { "winnerUser", winnerIsA ? userA : userB }, { "loserUser", winnerIsA ? userB : userA }
            };
        }

        // ---- Team-Kampf ("Alle gegen den Streamer") ----
        //
        // One battle at a time, global (like activeTournament). Flow: a channel-points redemption
        // opens a signup window (StartTeamBattleSignup) and draws the streamer's lineup up front
        // (shown in the overlay immediately, so viewers know what they're up against); viewers
        // join with a chat command (JoinTeamBattle), each getting ONE random card from their own
        // collection assigned immediately (in signup order - first come, first in queue); when the
        // window closes, ResolveTeamBattleSignup resolves the WHOLE fight in one shot by handing
        // the streamer's lineup and the community's queue straight to the existing
        // ResolveHpElimination (the same HP-Leisten-Duell math a normal 1v1 !battle uses) - HP
        // already persists across matchups on BOTH sides there, which is exactly "next challenger
        // steps up once the current one is defeated", symmetric for the streamer's team too. The
        // whole multi-card fight is a SINGLE "battle" queue item (battle.js already loops every
        // hpMatchups entry in one event) - just with a per-matchup community member name attached
        // so the overlay shows who's currently fighting instead of a generic "Community" label.

        // Any booster (subOnly:null - no subExclusive filter) since the streamer's own lineup is
        // exempt from the normal "sub-exclusive boosters aren't reachable via packs" restriction.
        private List<Dictionary<string, string>> DrawTeamBattleStreamerLineup(int count)
        {
            Dictionary<string, object> settings = server.ReadSettingsObject();
            var lineup = new List<Dictionary<string, string>>();
            for (int i = 0; i < count; i++)
            {
                string boosterId = PickRandomBoosterId(null);
                if (String.IsNullOrWhiteSpace(boosterId)) continue;
                Dictionary<string, object> card = PickCardFromBooster(settings, boosterId);
                if (card == null) continue;
                Dictionary<string, object> booster = FindBooster(settings, boosterId);
                lineup.Add(new Dictionary<string, string>
                {
                    { "boosterId", boosterId },
                    { "cardId", GetString(card, "id", "") },
                    { "cardTitle", GetString(card, "title", "") },
                    { "boosterTitle", booster != null ? GetString(booster, "title", "") : "" },
                    { "rarity", GetString(card, "rarity", "common") }
                });
            }
            return lineup;
        }

        // Network I/O (chat messages, avatar lookups) must NEVER happen while teamBattleLock is
        // held - see the identical comment on StartTournamentSignup for why: it can block
        // ResolveTeamBattleSignup (which needs the same lock) behind a slow/hung Twitch API call,
        // turning "timer ran out" into "wait minutes for a stuck HTTP request". Both methods below
        // only mutate state under the lock, then fire chat/broadcast calls afterward with the lock
        // already released.
        public string StartTeamBattleSignup(string login, string displayName, string source)
        {
            Dictionary<string, object> settings = server.ReadSettingsObject();
            Dictionary<string, object> tbCfg = Obj(settings, "teamBattle");
            if (!GetBool(tbCfg, "enabled", false)) return "disabled";

            // Only one bracket event (tournament OR Team-Kampf) may run at a time - a tournament
            // still playing out its bracket would otherwise get this Team-Kampf injected into the
            // middle of its animations (and vice versa). See IsBracketEventBusy.
            if (IsBracketEventBusy())
            {
                SendChatMessageSafe(GetString(tbCfg, "busyMessage", DefaultTeamBattleBusy)
                    .Replace("@userName", "@" + (String.IsNullOrEmpty(displayName) ? "Streamer" : displayName)));
                return "already_running";
            }

            bool alreadyRunning = false;
            bool noCards = false;
            string startMessage = null;
            List<Dictionary<string, string>> streamerLineupForBroadcast = null;
            string deadlineUtc = null;
            string joinCommandText = null;

            lock (teamBattleLock)
            {
                if (activeTeamBattle != null)
                {
                    alreadyRunning = true;
                }
                else
                {
                    // "Kartenanzahl Streamer-Team" is only the MINIMUM - the actual lineup size is
                    // randomized (min..min+4) so the streamer's side isn't the exact same size every
                    // single Team-Kampf. Safe to vary freely: ResolveHpElimination handles unequal
                    // streamer/community lineup lengths just fine (HP elimination, not paired rounds).
                    int streamerCardCountMin = Math.Max(1, GetInt(tbCfg, "streamerCardCount", 5));

                    // Difficulty rubber-banding: a persistent adjustment (see
                    // RecordTeamKampfDifficultyResult) grows the streamer's lineup size by one card
                    // per community win and shrinks it by one per loss, carried over indefinitely
                    // (no reset on a win) - floored so the fight can never drop below the
                    // configured minimum, and hard-floored at 1 either way (an opponent lineup of 0
                    // cards is never possible).
                    bool difficultyEnabled = GetBool(tbCfg, "difficultyRubberbandEnabled", true);
                    int streamerCardCount;
                    if (difficultyEnabled)
                    {
                        // Deterministic when the difficulty rubber-band is on: the whole point is
                        // that the community can SEE the lineup grow/shrink by exactly one card per
                        // result, which the min..min+4 random jitter below would otherwise mask
                        // (e.g. a loss shrinking the minimum from 3 to 2 could still roll a bigger
                        // actual lineup than the previous, undefeated-looking, win) - see the report
                        // that "the count still went up after a loss" this was fixed for.
                        int adjustment = server.GetTeamKampfDifficultyAdjustment();
                        int floorCount = Math.Max(1, GetInt(tbCfg, "difficultyMinCardCount", 1));
                        streamerCardCount = Math.Max(floorCount, streamerCardCountMin + adjustment);
                    }
                    else
                    {
                        lock (BattleRandom) { streamerCardCount = streamerCardCountMin + BattleRandom.Next(0, 5); }
                    }
                    int signupSeconds = Math.Max(10, GetInt(tbCfg, "signupSeconds", 60));
                    List<Dictionary<string, string>> streamerLineup = DrawTeamBattleStreamerLineup(streamerCardCount);
                    if (streamerLineup.Count == 0)
                    {
                        noCards = true;
                    }
                    else
                    {
                        Dictionary<string, object> joinCfg = Obj(Obj(settings, "chatCommands"), "teamBattleJoin");
                        joinCommandText = GetString(joinCfg, "prefix", "!") + GetString(joinCfg, "command", "teamkampf");
                        deadlineUtc = DateTime.UtcNow.AddSeconds(signupSeconds).ToString("o");

                        activeTeamBattle = new Dictionary<string, object>
                        {
                            { "state", "signup" },
                            { "participants", new List<object>() },
                            { "streamerLineup", streamerLineup },
                            { "deadlineUtc", deadlineUtc },
                            { "startedAt", DateTime.UtcNow.ToString("o") },
                            { "joinCommand", joinCommandText }
                        };

                        startMessage = GetString(tbCfg, "signupStartMessage", DefaultTeamBattleSignupStart)
                            .Replace("[Befehl]", joinCommandText)
                            .Replace("[Sekunden]", signupSeconds.ToString())
                            .Replace("[Anzahl]", streamerCardCount.ToString());
                        streamerLineupForBroadcast = streamerLineup;

                        if (teamBattleSignupTimer != null) teamBattleSignupTimer.Dispose();
                        teamBattleSignupTimer = new System.Threading.Timer(delegate { ResolveTeamBattleSignup(); }, null, signupSeconds * 1000, System.Threading.Timeout.Infinite);
                    }
                }
            }

            if (alreadyRunning)
            {
                SendChatMessageSafe(GetString(tbCfg, "busyMessage", DefaultTeamBattleBusy)
                    .Replace("@userName", "@" + (String.IsNullOrEmpty(displayName) ? "Streamer" : displayName)));
                return "already_running";
            }
            if (noCards)
            {
                server.Log("battle", "error", "Team-Kampf konnte nicht gestartet werden: keine Karten verfuegbar.");
                return "no_cards";
            }

            SendChatMessageSafe(startMessage);
            BroadcastTeamBattleSignupState(streamerLineupForBroadcast, new List<object>(), deadlineUtc, joinCommandText);

            // Whoever spent the channel points obviously wants their own card in the fight too.
            if (source == "channelpoints" && !String.IsNullOrEmpty(login))
            {
                JoinTeamBattle(login, displayName);
            }

            return "started";
        }

        // Broadcasts a SNAPSHOT of the signup state (streamer lineup, live participant list with
        // avatars, deadline) - called once at signup start and again after every successful join,
        // so the overlay can show who's already in without waiting for the fight itself. Takes its
        // data as parameters rather than reading activeTeamBattle directly, since callers now
        // invoke this AFTER releasing teamBattleLock (see StartTeamBattleSignup/JoinTeamBattle) -
        // it must never touch the live mutable state. Always resends the same deadlineUtc (never
        // recomputed), so the client's local countdown never jumps or restarts when a new
        // participant joins mid-countdown.
        private void BroadcastTeamBattleSignupState(List<Dictionary<string, string>> streamerLineup, List<object> participants, string deadlineUtc, string joinCommand)
        {
            // Avatar lookups off the event worker - same reasoning as BroadcastTournamentSignupState.
            int streamerLineupCount = streamerLineup.Count;
            DispatchOutboundWork(delegate
            {
                var participantsForBroadcast = new object[participants.Count];
                for (int i = 0; i < participants.Count; i++)
                {
                    Dictionary<string, object> p = participants[i] as Dictionary<string, object>;
                    if (p == null) continue;
                    participantsForBroadcast[i] = new Dictionary<string, object>
                    {
                        { "login", GetString(p, "login", "") },
                        { "displayName", GetString(p, "displayName", "") },
                        { "avatarUrl", GetUserAvatarUrl(GetString(p, "login", "")) }
                    };
                }

                // Viewers should only ever learn HOW MANY cards they need to beat, never which ones or
                // how rare they are - sending only the count (not the card identities/rarities
                // themselves) keeps that true even for someone inspecting the raw SSE payload, not
                // just for what's rendered on screen (see cardMarkup(null, {hidden:true}) in battle.js).
                server.Broadcast("teamkampfsignup", server.Serializer.Serialize(new Dictionary<string, object>
                {
                    { "active", true },
                    { "deadlineUtc", deadlineUtc },
                    { "streamerLineupCount", streamerLineupCount },
                    { "participants", participantsForBroadcast },
                    { "joinCommand", joinCommand ?? "" }
                }));
            });
        }

        // settingsIn: same pattern as JoinTournament - reuse the caller's already-loaded settings.
        private void JoinTeamBattle(string login, string displayName, Dictionary<string, object> settingsIn = null)
        {
            string noActiveMessage = null;
            string alreadyMessage = null;
            string notOwnedMessage = null;
            string successMessage = null;
            List<Dictionary<string, string>> streamerLineupForBroadcast = null;
            List<object> participantsSnapshot = null;
            string deadlineUtc = null;
            string joinCommandText = null;

            lock (teamBattleLock)
            {
                if (activeTeamBattle == null || GetString(activeTeamBattle, "state", "") != "signup")
                {
                    Dictionary<string, object> tbCfgIdle = Obj(settingsIn != null ? settingsIn : server.ReadSettingsObject(), "teamBattle");
                    noActiveMessage = GetString(tbCfgIdle, "noActiveMessage", DefaultTeamBattleNoActive).Replace("@userName", "@" + displayName);
                }
                else
                {
                    var participants = (List<object>)activeTeamBattle["participants"];
                    string loginKey = login.ToLowerInvariant();
                    Dictionary<string, object> settings = settingsIn != null ? settingsIn : server.ReadSettingsObject();
                    Dictionary<string, object> tbCfg = Obj(settings, "teamBattle");
                    bool alreadyIn = false;
                    foreach (object p in participants)
                    {
                        Dictionary<string, object> existing = p as Dictionary<string, object>;
                        if (existing != null && GetString(existing, "login", "") == loginKey) { alreadyIn = true; break; }
                    }

                    if (alreadyIn)
                    {
                        alreadyMessage = GetString(tbCfg, "joinAlreadyMessage", DefaultTeamBattleJoinAlready).Replace("@userName", "@" + displayName);
                    }
                    else
                    {
                        List<Dictionary<string, string>> owned = server.GetUserOwnedCardTypes(login);
                        if (owned.Count == 0)
                        {
                            notOwnedMessage = GetString(tbCfg, "joinNotOwnedMessage", DefaultTeamBattleJoinNotOwned).Replace("@userName", "@" + displayName);
                        }
                        else
                        {
                            Dictionary<string, string> card = DrawRandomLineup(owned, 1)[0];
                            participants.Add(new Dictionary<string, object>
                            {
                                { "login", loginKey }, { "displayName", displayName },
                                { "boosterId", card["boosterId"] }, { "cardId", card["cardId"] }
                            });

                            successMessage = GetString(tbCfg, "joinSuccessMessage", DefaultTeamBattleJoinSuccess)
                                .Replace("@userName", "@" + displayName)
                                .Replace("[Anzahl]", participants.Count.ToString());
                            streamerLineupForBroadcast = (List<Dictionary<string, string>>)activeTeamBattle["streamerLineup"];
                            // Snapshot (copy), not the live list reference - the broadcast runs
                            // after the lock is released, so it must never iterate the actual
                            // mutable list another thread could be adding to concurrently.
                            participantsSnapshot = new List<object>(participants);
                            deadlineUtc = GetString(activeTeamBattle, "deadlineUtc", "");
                            joinCommandText = GetString(activeTeamBattle, "joinCommand", "");
                        }
                    }
                }
            }

            if (noActiveMessage != null) { SendChatMessageSafe(noActiveMessage); return; }
            if (alreadyMessage != null) { SendChatMessageSafe(alreadyMessage); return; }
            if (notOwnedMessage != null) { SendChatMessageSafe(notOwnedMessage); return; }
            SendChatMessageSafe(successMessage);
            BroadcastTeamBattleSignupState(streamerLineupForBroadcast, participantsSnapshot, deadlineUtc, joinCommandText);
        }

        // Timer callback once the signup window closes - runs off the chat/HTTP threads, so it is
        // free to resolve the whole fight synchronously (the HP-elimination math is instant dice
        // rolling, same as a normal 1v1 duel) before touching the queue.
        private void ResolveTeamBattleSignup()
        {
            List<Dictionary<string, object>> participants;
            List<Dictionary<string, string>> streamerLineup;
            lock (teamBattleLock)
            {
                if (activeTeamBattle == null) return;
                var rawParticipants = (List<object>)activeTeamBattle["participants"];
                participants = new List<Dictionary<string, object>>();
                foreach (object p in rawParticipants) if (p is Dictionary<string, object>) participants.Add((Dictionary<string, object>)p);
                streamerLineup = (List<Dictionary<string, string>>)activeTeamBattle["streamerLineup"];
                activeTeamBattle = null;
            }

            server.Broadcast("teamkampfsignup", server.Serializer.Serialize(new Dictionary<string, object> { { "active", false } }));

            Dictionary<string, object> settings = server.ReadSettingsObject();
            Dictionary<string, object> tbCfg = Obj(settings, "teamBattle");
            string streamerName = GetString(TwitchSettings(), "displayName", GetString(TwitchSettings(), "login", "Streamer"));

            if (participants.Count == 0)
            {
                SendChatMessageSafe(GetString(tbCfg, "noParticipantsMessage", DefaultTeamBattleNoParticipants).Replace("@streamerName", streamerName));
                return;
            }

            var communityLineup = new List<Dictionary<string, string>>();
            foreach (Dictionary<string, object> p in participants)
            {
                communityLineup.Add(new Dictionary<string, string> { { "boosterId", GetString(p, "boosterId", "") }, { "cardId", GetString(p, "cardId", "") } });
            }

            Dictionary<string, object> strengthCfg = Obj(settings, "battleStrength");
            double variance = GetDouble(strengthCfg, "variance", DefaultBattleVariance);
            Dictionary<string, object> hpResult = ResolveHpElimination(streamerLineup, communityLineup, strengthCfg, variance);
            object[] matchups = (object[])hpResult["matchups"];
            bool communityWon = !GetBool(hpResult, "winnerIsA", true);

            // Recorded HERE, synchronously, the instant the outcome is known - not later when the
            // "teamkampfresult" queue item is dequeued (see ProcessQueueItem). That item only runs
            // once the "battle" item ahead of it has been acked by the overlay (or timed out after
            // up to ~180s for a big fight - see EstimatedProcessingMs), so if a streamer starts the
            // next Team-Kampf again quickly, the adjustment from the PREVIOUS fight might still be
            // sitting unrecorded in the queue - the report that "a win/loss doesn't seem to change
            // the next fight's size" if you retry fast was exactly this delay, not the ±1 math
            // itself being wrong (see StartTeamBattleSignup).
            int difficultyStep = Math.Max(1, GetInt(tbCfg, "difficultyStepDown", 1));
            server.RecordTeamKampfDifficultyResult(communityWon, difficultyStep);

            // Walks the matchups in order, tracking which community-lineup slot ("B" side) is
            // fighting at each point, so the overlay can show that specific viewer's name instead
            // of a generic team label. bIndex only advances when B's card was the one eliminated
            // (winner == "A") - the same "next challenger steps up" logic ResolveHpElimination
            // itself uses internally, just re-derived here from its output.
            int bIndex = 0;
            string finisherLogin = null, finisherDisplayName = null;
            // Tallies, per participant, how many streamer cards THEY PERSONALLY defeated - a
            // participant whose card wins a round keeps fighting the streamer's next card (bIndex
            // doesn't advance), so a single participant can rack up several defeats in one Team-
            // Kampf even if their own card is eventually eliminated. Feeds the optional "per
            // defeated card" bonus draw below - independent of the overall win/loss, since an
            // individual can defeat cards even in a Team-Kampf the community ultimately loses.
            var defeatsByLogin = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            for (int i = 0; i < matchups.Length; i++)
            {
                Dictionary<string, object> matchup = (Dictionary<string, object>)matchups[i];
                Dictionary<string, object> participant = participants[Math.Min(bIndex, participants.Count - 1)];
                matchup["nameA"] = streamerName;
                matchup["nameB"] = GetString(participant, "displayName", "Viewer");
                string matchupWinner = GetString(matchup, "winner", "");
                if (matchupWinner == "B")
                {
                    string pLogin = GetString(participant, "login", "");
                    if (!String.IsNullOrEmpty(pLogin))
                    {
                        int existing;
                        defeatsByLogin[pLogin] = (defeatsByLogin.TryGetValue(pLogin, out existing) ? existing : 0) + 1;
                    }
                }
                if (i == matchups.Length - 1 && communityWon)
                {
                    finisherLogin = GetString(participant, "login", "");
                    finisherDisplayName = GetString(participant, "displayName", "Viewer");
                }
                if (matchupWinner == "A") bIndex++;
            }

            server.Log("battle", "info", streamerName + " (Team-Kampf) vs. " + participants.Count + " Zuschauer: " + (communityWon ? "Community gewinnt" : "Streamer gewinnt") + ".");

            var battleEvent = new Dictionary<string, object>
            {
                { "userA", streamerName }, { "userB", GetString(tbCfg, "communityLabel", "Community") },
                { "lineupA", streamerLineup }, { "lineupB", communityLineup },
                { "mode", "hp" }, { "rounds", new object[0] }, { "hpMatchups", matchups },
                { "winner", communityWon ? "B" : "A" },
                { "winsA", GetInt(hpResult, "cardsLostB", 0) }, { "winsB", GetInt(hpResult, "cardsLostA", 0) },
                { "winnerUser", communityWon ? "Community" : streamerName }, { "loserUser", communityWon ? streamerName : "Community" },
                { "teamBattle", true }
            };

            var defeatsForItem = new Dictionary<string, object>();
            foreach (KeyValuePair<string, int> kv in defeatsByLogin) defeatsForItem[kv.Key] = kv.Value;
            var resultExtra = new Dictionary<string, object>
            {
                { "communityWon", communityWon },
                { "participants", participants },
                { "finisherLogin", finisherLogin }, { "finisherDisplayName", finisherDisplayName },
                { "streamerName", streamerName },
                { "defeatsByLogin", defeatsForItem }
            };
            // Built and flushed as one atomic batch at the FRONT of the queue (see
            // EnqueueBatchAtFront) so the Team-Kampf starts the instant signup closes - ahead of
            // any pack draws already waiting - and nothing else can land between the fight
            // animation and its result/reward item.
            EnqueueBatchAtFront(new List<Dictionary<string, object>>
            {
                BuildQueueItem("battle", "", streamerName, "teamkampf", battleEvent),
                BuildQueueItem("teamkampfresult", "", streamerName, "teamkampf", resultExtra)
            });
        }

        // Timer callback once the signup window closes. Runs entirely off the chat/HTTP threads,
        // so it is free to take its time resolving every round synchronously before touching the
        // queue - nothing here blocks command handling.
        private void ResolveTournamentSignup()
        {
            List<Dictionary<string, object>> participants;
            int minParticipants;
            int lineupSize;
            int winnerDraws;
            bool perRoundWinnerEnabled;
            bool championDrawsEnabled;
            Dictionary<string, object> tCfg;
            Dictionary<string, object> settings;

            lock (tournamentLock)
            {
                if (activeTournament == null) return;
                var rawParticipants = (List<object>)activeTournament["participants"];
                participants = new List<Dictionary<string, object>>();
                foreach (object p in rawParticipants)
                {
                    Dictionary<string, object> d = p as Dictionary<string, object>;
                    if (d != null) participants.Add(d);
                }
                minParticipants = GetInt(activeTournament, "minParticipants", 3);
                lineupSize = GetInt(activeTournament, "lineupSize", 3);
                winnerDraws = GetInt(activeTournament, "winnerDraws", 1);
                settings = server.ReadSettingsObject();
                tCfg = Obj(settings, "tournament");
                perRoundWinnerEnabled = GetBool(tCfg, "perRoundWinnerEnabled", false);
                championDrawsEnabled = GetBool(tCfg, "championDrawsEnabled", true);

                if (participants.Count < minParticipants)
                {
                    SendChatMessageSafe(GetString(tCfg, "cancelMessage", DefaultTournamentCancel)
                        .Replace("[Anzahl]", participants.Count.ToString())
                        .Replace("[Mindestteilnehmer]", minParticipants.ToString()));
                    activeTournament = null;
                    server.Broadcast("tournamentsignup", "{\"active\":false}");
                    return;
                }

                activeTournament["state"] = "running";
                server.Broadcast("tournamentsignup", "{\"active\":false}");
            }

            foreach (Dictionary<string, object> participant in participants)
            {
                server.RecordTournamentParticipation(GetString(participant, "login", ""), GetString(participant, "displayName", ""));
            }

            var shuffled = new List<Dictionary<string, object>>(participants);
            lock (BattleRandom)
            {
                for (int i = shuffled.Count - 1; i > 0; i--)
                {
                    int j = BattleRandom.Next(i + 1);
                    Dictionary<string, object> tmp = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = tmp;
                }
            }

            int totalParticipants = shuffled.Count;
            List<Dictionary<string, object>> round = shuffled;
            int roundNumber = 1;

            // Grows one round at a time as the bracket is resolved. Every match/bye item gets a
            // DEEP-CLONED snapshot of this (see CloneBracketRounds) taken at the exact moment it
            // is enqueued - never a live reference - because the whole bracket (all rounds) is
            // actually resolved synchronously in this one pass, well before any of it has played
            // out on screen. Without cloning, every match's bracket view would already show every
            // future round's winner, spoiling the whole tournament the instant the first match's
            // animation starts. Each snapshot only ever reveals: earlier rounds (already played),
            // this round's matchups (paired, but only already-played ones show a winner), and
            // nothing beyond the current round at all.
            var bracketRounds = new List<Dictionary<string, object>>();
            // Every round winner's pack draw (if enabled) is deliberately NOT played right after
            // their own match - collected here and only played once the whole tournament has
            // concluded, back to back with the champion's bonus draws, so the ongoing bracket
            // isn't interrupted by pack-opening animations mid-tournament.
            var perRoundWinners = new List<object>();
            // Every match/bye/champion item is BUILT here but not yet added to the live queue -
            // see the EnqueueBatchAtFront call at the end of this method for why.
            var priorityItems = new List<Dictionary<string, object>>();

            while (round.Count > 1)
            {
                string roundLabel = round.Count <= 2 ? "Finale" : (round.Count <= 4 ? "Halbfinale" : ("Runde " + roundNumber));
                var winners = new List<Dictionary<string, object>>();
                var roundMatches = new List<object>();
                var roundData = new Dictionary<string, object> { { "label", roundLabel }, { "matches", roundMatches } };
                bracketRounds.Add(roundData);
                int currentRoundIndex = bracketRounds.Count - 1;

                for (int i = 0; i + 1 < round.Count; i += 2)
                {
                    Dictionary<string, object> a = round[i];
                    Dictionary<string, object> b = round[i + 1];
                    string loginA = GetString(a, "login", "");
                    string userA = GetString(a, "displayName", loginA);
                    string loginB = GetString(b, "login", "");
                    string userB = GetString(b, "displayName", loginB);

                    var matchData = new Dictionary<string, object> { { "a", userA }, { "b", userB }, { "winner", null }, { "bye", false } };
                    roundMatches.Add(matchData);
                    int currentMatchIndex = roundMatches.Count - 1;

                    List<Dictionary<string, string>> ownedA = server.GetUserOwnedCardTypes(loginA);
                    List<Dictionary<string, string>> ownedB = server.GetUserOwnedCardTypes(loginB);
                    // A participant may have traded/dusted away cards since joining - rather than
                    // crash the bracket, whichever side can no longer field a lineup forfeits.
                    if (ownedA.Count < lineupSize && ownedB.Count < lineupSize) { matchData["winner"] = "a"; winners.Add(a); continue; }
                    if (ownedA.Count < lineupSize) { matchData["winner"] = "b"; winners.Add(b); continue; }
                    if (ownedB.Count < lineupSize) { matchData["winner"] = "a"; winners.Add(a); continue; }

                    Dictionary<string, object> duelEvent = ResolveTournamentDuel(userA, ownedA, userB, ownedB, lineupSize, settings);
                    duelEvent["tournamentRound"] = roundLabel;
                    duelEvent["bracket"] = new Dictionary<string, object>
                    {
                        { "rounds", CloneBracketRounds(bracketRounds) },
                        { "currentRoundIndex", currentRoundIndex },
                        { "currentMatchIndex", currentMatchIndex },
                        // Lets the overlay compute the FULL bracket skeleton (every future round's
                        // match-box count) up front, even though bracketRounds itself only ever
                        // contains rounds resolved so far - see playBracketTree in battle.js.
                        { "totalParticipants", totalParticipants }
                    };
                    priorityItems.Add(BuildQueueItem("battle", loginA, userA, "tournament", duelEvent));

                    bool winnerIsA = GetString(duelEvent, "winner", "A") == "A";
                    matchData["winner"] = winnerIsA ? "a" : "b";
                    Dictionary<string, object> roundWinner = winnerIsA ? a : b;
                    winners.Add(roundWinner);

                    if (perRoundWinnerEnabled)
                    {
                        perRoundWinners.Add(new Dictionary<string, object>
                        {
                            { "login", GetString(roundWinner, "login", "") },
                            { "displayName", GetString(roundWinner, "displayName", "") }
                        });
                    }
                }

                if (round.Count % 2 == 1)
                {
                    Dictionary<string, object> byeUser = round[round.Count - 1];
                    winners.Add(byeUser);
                    var byeMatchData = new Dictionary<string, object>
                    {
                        { "a", GetString(byeUser, "displayName", GetString(byeUser, "login", "")) },
                        { "b", null }, { "winner", "a" }, { "bye", true }
                    };
                    roundMatches.Add(byeMatchData);
                    priorityItems.Add(BuildQueueItem("tournamentbye", GetString(byeUser, "login", ""), GetString(byeUser, "displayName", ""), "tournament",
                        new Dictionary<string, object>
                        {
                            { "tournamentRound", roundLabel },
                            { "bracket", new Dictionary<string, object>
                                {
                                    { "rounds", CloneBracketRounds(bracketRounds) },
                                    { "currentRoundIndex", currentRoundIndex },
                                    { "currentMatchIndex", roundMatches.Count - 1 },
                                    { "totalParticipants", totalParticipants }
                                }
                            }
                        }));
                }

                round = winners;
                roundNumber++;
            }

            lock (tournamentLock) { activeTournament = null; }
            if (round.Count == 0) { EnqueueBatchAtFront(priorityItems); return; }

            Dictionary<string, object> championEntry = round[0];
            string championLogin = GetString(championEntry, "login", "");
            string championUser = GetString(championEntry, "displayName", championLogin);

            priorityItems.Add(BuildQueueItem("tournamentwon", championLogin, championUser, "tournament", new Dictionary<string, object>
            {
                { "totalParticipants", totalParticipants },
                { "winnerDraws", championDrawsEnabled ? winnerDraws : 0 },
                { "perRoundDraws", perRoundWinners.ToArray() },
                // Lets the overlay do one final "zoom out to the completed tree, final branch
                // turns gold" reveal for the champion - there's no further match afterwards to
                // trigger that reveal the way every earlier round's does (see playBracketTree/
                // playBracketReveal in battle.js), so this item carries the FULLY resolved bracket
                // itself, pointing at the final as the "just decided" match.
                { "bracket", new Dictionary<string, object>
                    {
                        { "rounds", CloneBracketRounds(bracketRounds) },
                        { "currentRoundIndex", bracketRounds.Count - 1 },
                        { "currentMatchIndex", 0 },
                        { "totalParticipants", totalParticipants },
                        { "isChampion", true }
                    }
                }
            }));

            // Every match/bye/champion item is flushed into the live queue in one atomic batch,
            // inserted at the FRONT, only now that the whole bracket has been fully resolved -
            // see EnqueueBatchAtFront's comment for why: this is what makes the tournament start
            // the instant signup closes (ahead of any pack draws already waiting) and play
            // straight through without another draw landing in the middle of it.
            EnqueueBatchAtFront(priorityItems);
        }

        // Deep-clones the bracket-so-far into plain Dictionary/List primitives suitable for
        // JSON serialization, independent of any further in-place mutation by the caller.
        private static List<object> CloneBracketRounds(List<Dictionary<string, object>> rounds)
        {
            var clone = new List<object>();
            foreach (Dictionary<string, object> round in rounds)
            {
                var clonedMatches = new List<object>();
                foreach (object mo in (List<object>)round["matches"])
                {
                    clonedMatches.Add(new Dictionary<string, object>((Dictionary<string, object>)mo));
                }
                clone.Add(new Dictionary<string, object> { { "label", round["label"] }, { "matches", clonedMatches } });
            }
            return clone;
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
        // factor decides the winner. Best-of-3 independent attacks (each with its OWN variance
        // roll) rather than a single roll - a single roll only ever gives variance one chance to
        // matter for the whole matchup, which barely shows against a real strength gap. Rolling
        // three separate "attacks" and taking the majority lets variance compound (or cancel out)
        // attack to attack, the way it already visibly does in HP-Duell mode (ResolveHpElimination
        // re-rolls variance per hit too).
        private bool RollRound(Dictionary<string, string> cardA, Dictionary<string, string> cardB, Dictionary<string, object> strengthCfg, double variance)
        {
            double strengthA = CardBattleStrength(cardA["cardId"], strengthCfg);
            double strengthB = CardBattleStrength(cardB["cardId"], strengthCfg);
            const int attacks = 3;
            int winsA = 0, winsB = 0;
            for (int i = 0; i < attacks; i++)
            {
                double rollA = strengthA * (1 + BattleRandom.NextDouble() * variance);
                double rollB = strengthB * (1 + BattleRandom.NextDouble() * variance);
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

        private const string DefaultRankingCardNotFound = "@userName, die Karte [falscherName] existiert nicht. Meintest du stattdessen [Kartenname]?";
        private const string DefaultRankingNoOwners = "@userName, die Karte [Kartenname] wurde bisher von niemandem gezogen - es gibt noch kein Ranking dafuer.";

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
                SendChatMessageSafe(GetString(rankingCfg, "cardNotFoundMessage", DefaultRankingCardNotFound)
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
                SendChatMessageSafe(GetString(rankingCfg, "noOwnersMessage", DefaultRankingNoOwners)
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

            // Sub-Belohnungen (channel:read:subscriptions): optional on top of the redemption
            // subscription above - wrapped individually so a token still missing this scope
            // doesn't prevent channel points from working.
            foreach (string subEventType in new[] { "channel.subscribe", "channel.subscription.message", "channel.subscription.gift", "channel.cheer" })
            {
                try
                {
                    var subBody = new Dictionary<string, object>
                    {
                        { "type", subEventType },
                        { "version", "1" },
                        { "condition", new Dictionary<string, object> { { "broadcaster_user_id", GetString(twitch, "broadcasterId", "") } } },
                        { "transport", new Dictionary<string, object> { { "method", "websocket" }, { "session_id", sessionId } } }
                    };
                    TwitchJson("POST", "https://api.twitch.tv/helix/eventsub/subscriptions", GetString(twitch, "clientId", ""), GetString(twitch, "accessToken", ""), subBody);
                }
                catch (Exception ex)
                {
                    server.Log("twitch", "warn", "Sub-Ereignis-Abonnement (" + subEventType + ") fehlgeschlagen: " + ex.Message);
                }
            }
        }

        // Matches an incoming redemption against settings.draw or settings.showcase. If the id
        // doesn't match but the (normalized) title still does, the reward was evidently deleted
        // and recreated on Twitch's side under the same name - the live id from this event is
        // adopted automatically so the stale id stops causing "nothing happened"/"not found"
        // failures on every future redemption and on the next manual save/delete.
        private bool ReconcileTrackedReward(Dictionary<string, object> settings, string holderKey, string rewardId, string rewardTitle)
        {
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
                // See SyncReward for why this is deliberately false (refundable from Twitch's
                // dashboard/app, at the cost of a documented older-OBS chat-dock crash risk).
                { "should_redemptions_skip_request_queue", false },
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

        public Dictionary<string, object> SyncTournamentReward(string bodyJson)
        {
            Dictionary<string, object> body = ParseObject(bodyJson);
            Dictionary<string, object> twitch = RequireTwitch();
            Dictionary<string, object> settings = server.ReadSettingsObject();
            Dictionary<string, object> tournament = Obj(settings, "tournament");
            if (tournament.Count == 0) { tournament = new Dictionary<string, object>(); settings["tournament"] = tournament; }

            string title = GetString(body, "title", GetString(tournament, "rewardName", "Turnier starten"));
            int cost = Math.Max(1, GetInt(body, "cost", 1000));
            string prompt = GetString(body, "prompt", "");
            string backgroundColor = GetString(body, "backgroundColor", "");
            bool isEnabled = GetBool(body, "isEnabled", true);
            bool isPaused = GetBool(body, "isPaused", false);
            int globalCooldown = Math.Max(0, GetInt(body, "globalCooldown", 0));
            bool explicitRewardId = body.ContainsKey("rewardId");
            string rewardId = GetString(body, "rewardId", "");
            object[] existingIds = tournament.ContainsKey("rewardIds") && tournament["rewardIds"] is object[] ? (object[])tournament["rewardIds"] : new object[0];
            if (!explicitRewardId && String.IsNullOrWhiteSpace(rewardId)) rewardId = existingIds.Length > 0 ? Convert.ToString(existingIds[0]) : "";

            var payload = new Dictionary<string, object>
            {
                { "title", title },
                { "cost", cost },
                { "prompt", prompt },
                { "is_enabled", isEnabled },
                { "is_user_input_required", false },
                // See SyncReward for why this is deliberately false (refundable).
                { "should_redemptions_skip_request_queue", false },
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
            server.Log("twitch", "info", "Turnier-Belohnung gespeichert. Twitch-Antwort: " + server.Serializer.Serialize(reward));

            tournament["rewardIds"] = new object[] { savedId };
            tournament["rewardName"] = title;
            tournament["rewardCost"] = cost;
            tournament["rewardPrompt"] = prompt;
            tournament["rewardBackgroundColor"] = backgroundColor;
            tournament["rewardEnabled"] = isEnabled;
            tournament["rewardPaused"] = isPaused;
            tournament["rewardGlobalCooldown"] = globalCooldown;
            server.WriteSettingsObject(settings);
            return settings;
        }

        public Dictionary<string, object> SyncTeamBattleReward(string bodyJson)
        {
            Dictionary<string, object> body = ParseObject(bodyJson);
            Dictionary<string, object> twitch = RequireTwitch();
            Dictionary<string, object> settings = server.ReadSettingsObject();
            Dictionary<string, object> teamBattle = Obj(settings, "teamBattle");
            if (teamBattle.Count == 0) { teamBattle = new Dictionary<string, object>(); settings["teamBattle"] = teamBattle; }

            string title = GetString(body, "title", GetString(teamBattle, "rewardName", "Team-Kampf starten"));
            int cost = Math.Max(1, GetInt(body, "cost", 2000));
            string prompt = GetString(body, "prompt", "");
            string backgroundColor = GetString(body, "backgroundColor", "");
            bool isEnabled = GetBool(body, "isEnabled", true);
            bool isPaused = GetBool(body, "isPaused", false);
            int globalCooldown = Math.Max(0, GetInt(body, "globalCooldown", 0));
            bool explicitRewardId = body.ContainsKey("rewardId");
            string rewardId = GetString(body, "rewardId", "");
            object[] existingIds = teamBattle.ContainsKey("rewardIds") && teamBattle["rewardIds"] is object[] ? (object[])teamBattle["rewardIds"] : new object[0];
            if (!explicitRewardId && String.IsNullOrWhiteSpace(rewardId)) rewardId = existingIds.Length > 0 ? Convert.ToString(existingIds[0]) : "";

            var payload = new Dictionary<string, object>
            {
                { "title", title },
                { "cost", cost },
                { "prompt", prompt },
                { "is_enabled", isEnabled },
                { "is_user_input_required", false },
                { "should_redemptions_skip_request_queue", false },
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
            server.Log("twitch", "info", "Team-Kampf-Belohnung gespeichert. Twitch-Antwort: " + server.Serializer.Serialize(reward));

            teamBattle["rewardIds"] = new object[] { savedId };
            teamBattle["rewardName"] = title;
            teamBattle["rewardCost"] = cost;
            teamBattle["rewardPrompt"] = prompt;
            teamBattle["rewardBackgroundColor"] = backgroundColor;
            teamBattle["rewardEnabled"] = isEnabled;
            teamBattle["rewardPaused"] = isPaused;
            teamBattle["rewardGlobalCooldown"] = globalCooldown;
            server.WriteSettingsObject(settings);
            return settings;
        }

        // "Pick your own pack" reward - the ONE reward in this app where is_user_input_required is
        // deliberately true: the viewer must type the exact pack name for HandleSpecificPackRedemption
        // to have anything to look up. Everything else about the sync mirrors SyncTeamBattleReward.
        public Dictionary<string, object> SyncSpecificPackReward(string bodyJson)
        {
            Dictionary<string, object> body = ParseObject(bodyJson);
            Dictionary<string, object> twitch = RequireTwitch();
            Dictionary<string, object> settings = server.ReadSettingsObject();
            Dictionary<string, object> specificPack = Obj(settings, "specificPackDraw");
            if (specificPack.Count == 0) { specificPack = new Dictionary<string, object>(); settings["specificPackDraw"] = specificPack; }

            string title = GetString(body, "title", GetString(specificPack, "rewardName", "Wähle dein Pack"));
            int cost = Math.Max(1, GetInt(body, "cost", 500));
            string prompt = GetString(body, "prompt", "");
            string backgroundColor = GetString(body, "backgroundColor", "");
            bool isEnabled = GetBool(body, "isEnabled", true);
            bool isPaused = GetBool(body, "isPaused", false);
            int globalCooldown = Math.Max(0, GetInt(body, "globalCooldown", 0));
            bool explicitRewardId = body.ContainsKey("rewardId");
            string rewardId = GetString(body, "rewardId", "");
            object[] existingIds = specificPack.ContainsKey("rewardIds") && specificPack["rewardIds"] is object[] ? (object[])specificPack["rewardIds"] : new object[0];
            if (!explicitRewardId && String.IsNullOrWhiteSpace(rewardId)) rewardId = existingIds.Length > 0 ? Convert.ToString(existingIds[0]) : "";

            var payload = new Dictionary<string, object>
            {
                { "title", title },
                { "cost", cost },
                { "prompt", prompt },
                { "is_enabled", isEnabled },
                { "is_user_input_required", true },
                { "should_redemptions_skip_request_queue", false },
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
            server.Log("twitch", "info", "Pack-Auswahl-Belohnung gespeichert. Twitch-Antwort: " + server.Serializer.Serialize(reward));

            specificPack["rewardIds"] = new object[] { savedId };
            specificPack["rewardName"] = title;
            specificPack["rewardCost"] = cost;
            specificPack["rewardPrompt"] = prompt;
            specificPack["rewardBackgroundColor"] = backgroundColor;
            specificPack["rewardEnabled"] = isEnabled;
            specificPack["rewardPaused"] = isPaused;
            specificPack["rewardGlobalCooldown"] = globalCooldown;
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

        // Twitch profile picture for the live ticker (see CompleteQueueItem's "liveticker"
        // broadcast) - cached per login since it almost never changes and every draw would
        // otherwise cost an extra Helix round-trip. Empty string (never cached as failure-cached
        // forever) just means the ticker falls back to no avatar for that entry.
        private readonly object avatarCacheLock = new object();
        private readonly Dictionary<string, string> avatarCache = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        private string GetUserAvatarUrl(string login)
        {
            if (String.IsNullOrWhiteSpace(login)) return "";
            lock (avatarCacheLock)
            {
                string cached;
                if (avatarCache.TryGetValue(login, out cached)) return cached;
            }
            try
            {
                Dictionary<string, object> twitch = Obj(server.ReadSettingsObject(), "twitch");
                if (String.IsNullOrWhiteSpace(GetString(twitch, "clientId", "")) || String.IsNullOrWhiteSpace(GetString(twitch, "accessToken", "")))
                    return "";
                Dictionary<string, object> result = TwitchGet(
                    "https://api.twitch.tv/helix/users?login=" + Uri.EscapeDataString(login),
                    GetString(twitch, "clientId", ""), GetString(twitch, "accessToken", ""));
                object[] data = result.ContainsKey("data") && result["data"] is object[] ? (object[])result["data"] : new object[0];
                string url = "";
                if (data.Length > 0)
                {
                    Dictionary<string, object> user = data[0] as Dictionary<string, object>;
                    if (user != null) url = GetString(user, "profile_image_url", "");
                }
                lock (avatarCacheLock) { avatarCache[login] = url; }
                return url;
            }
            catch { return ""; }
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

        // Plain WebClient has no exposed Timeout property and defaults to the underlying
        // HttpWebRequest's ~100s timeout - a single stalled Twitch API call (network hiccup, rate
        // limiting) could otherwise hang for well over a minute. Now that avatar/chat calls run
        // outside the tournament/Team-Kampf locks (see StartTournamentSignup etc.), a stuck request
        // no longer blocks the fight from starting, but it should still fail fast rather than tie
        // up a thread-pool thread for a minute-plus.
        private sealed class TimedWebClient : WebClient
        {
            protected override WebRequest GetWebRequest(Uri address)
            {
                WebRequest request = base.GetWebRequest(address);
                request.Timeout = 15000;
                return request;
            }
        }

        private Dictionary<string, object> TwitchGet(string url, string clientId, string token)
        {
            using (var client = new TimedWebClient())
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
            using (var client = new TimedWebClient())
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
            // channel:read:subscriptions (Sub-Belohnungen) is intentionally NOT required here -
            // it's optional on top of channel points, and CreateEventSubSubscription already
            // tolerates a token that lacks it (existing connections keep working unchanged).
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

        // Disk writes are debounced: Add() used to serialize and rewrite the WHOLE file (up to
        // 1000 entries, ~100KB) synchronously on every single log line - and the hot paths (each
        // draw, broadcast, queue step) log one to three lines apiece. Now Add() only marks the
        // log dirty and a one-shot timer flushes at most every 2 seconds. The log is diagnostic
        // data; losing the last <2s of lines on a hard crash is an acceptable trade.
        private System.Threading.Timer persistTimer;
        private bool persistScheduled;

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
                if (persistScheduled) return;
                persistScheduled = true;
                if (persistTimer == null) persistTimer = new System.Threading.Timer(delegate { FlushScheduled(); }, null, 2000, System.Threading.Timeout.Infinite);
                else persistTimer.Change(2000, System.Threading.Timeout.Infinite);
            }
        }

        private void FlushScheduled()
        {
            lock (entriesLock)
            {
                persistScheduled = false;
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
        public string Query;
        public string Body;
        public string UserAgent;
    }
}
