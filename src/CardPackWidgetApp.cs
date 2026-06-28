using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
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
        public const string Version = "1.4.11";
        public const string ReleaseDate = "2026-06-28";
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
            try
            {
                client.ReceiveTimeout = 10000;
                client.SendTimeout = 10000;
                NetworkStream stream = client.GetStream();
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
            catch
            {
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
            Dictionary<string, object> settings = ParseObject(ReadFile(SettingsPath(), "{}"));
            settings["twitch"] = ParseObject(ReadFile(TwitchConfigPath(), "{}"));
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

        internal void WriteSettingsObject(Dictionary<string, object> settings)
        {
            WriteSettingsObject(settings, true);
        }

        internal void WriteSettingsObject(Dictionary<string, object> settings, bool preserveTwitchSecrets)
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
            string statusText = StatusText(status);
            string headers =
                "HTTP/1.1 " + status + " " + statusText + "\r\n" +
                "Content-Type: " + contentType + "\r\n" +
                "Content-Length: " + body.Length + "\r\n" +
                "Cache-Control: " + cacheControl + "\r\n" +
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
        private readonly object stateLock = new object();

        public TwitchBridge(CardPackServer server)
        {
            this.server = server;
        }

        public void Start()
        {
            Dictionary<string, object> twitch = TwitchSettings();
            if (String.IsNullOrWhiteSpace(GetString(twitch, "accessToken", ""))) return;
            Stop();
            cancel = new CancellationTokenSource();
            Task.Factory.StartNew(delegate { EventSubLoop(cancel.Token); }, TaskCreationOptions.LongRunning);
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
                result = TwitchJson("POST", baseUrl, GetString(twitch, "clientId", ""), GetString(twitch, "accessToken", ""), payload);
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
                    result = TwitchJson("POST", baseUrl, GetString(twitch, "clientId", ""), GetString(twitch, "accessToken", ""), payload);
                }
            }

            object[] rewards = result.ContainsKey("data") && result["data"] is object[] ? (object[])result["data"] : new object[0];
            Dictionary<string, object> reward = rewards.Length > 0 && rewards[0] is Dictionary<string, object>
                ? (Dictionary<string, object>)rewards[0]
                : new Dictionary<string, object>();

            string savedId = GetString(reward, "id", rewardId);
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
            Dictionary<string, object> subscription = Obj(payload, "subscription");
            if (GetString(subscription, "type", "") != "channel.channel_points_custom_reward_redemption.add") return;
            Dictionary<string, object> ev = Obj(payload, "event");
            string rewardId = GetString(Obj(ev, "reward"), "id", "");
            string rewardTitle = GetString(Obj(ev, "reward"), "title", "");
            string user = GetString(ev, "user_name", GetString(ev, "user_login", "Viewer"));
            string login = GetString(ev, "user_login", user);

            // Collection showcase reward: not a pack opening - tell the collection overlay to
            // slide through every active booster for this viewer.
            if (IsShowcaseReward(rewardId, rewardTitle))
            {
                server.Log("draw", "info", user + " hat die Sammlung angefordert.");
                var showEvent = new Dictionary<string, object>
                {
                    { "eventId", GetString(ev, "id", DateTime.UtcNow.Ticks.ToString()) },
                    { "user", user },
                    { "userLogin", login },
                    { "source", "twitch" }
                };
                server.Broadcast("showcollection", server.Serializer.Serialize(showEvent));
                return;
            }

            if (!IsTrackedReward(rewardId, rewardTitle))
            {
                // Helps diagnose "nothing happened" reports: a redemption came in but matched
                // neither the draw reward nor the showcase reward (stale/mismatched reward id).
                server.Log("draw", "info", "Belohnung \"" + rewardTitle + "\" (ID " + rewardId + ") eingeloest, aber weder als Kartenpack- noch als Sammlung-Belohnung hinterlegt - ignoriert.");
                return;
            }

            // The booster must be picked exactly once per redemption, here on the server.
            // It used to be picked client-side in the overlay, which meant every connected
            // overlay instance (and every duplicate EventSub delivery) rolled its own random
            // booster independently - so a single redemption could visibly open different
            // packs at once. Resolving it here and broadcasting the concrete boosterId keeps
            // every listener in sync with a single random draw, weighted by booster score.
            string boosterId = PickRandomBoosterId();
            if (String.IsNullOrWhiteSpace(boosterId))
            {
                server.Log("draw", "error", user + " hat \"" + rewardTitle + "\" eingeloest, aber kein Booster war verfuegbar.");
                return;
            }
            server.Log("draw", "info", user + " hat \"" + rewardTitle + "\" eingeloest.");

            var drawEvent = new Dictionary<string, object>
            {
                { "eventId", GetString(ev, "id", DateTime.UtcNow.Ticks.ToString()) },
                { "user", user },
                { "userLogin", login },
                { "boosterId", boosterId },
                { "source", "twitch" }
            };
            server.Broadcast("draw", server.Serializer.Serialize(drawEvent));
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

        private bool IsShowcaseReward(string rewardId, string rewardTitle)
        {
            Dictionary<string, object> settings = server.ReadSettingsObject();
            Dictionary<string, object> showcase = Obj(settings, "showcase");
            if (showcase.Count == 0) return false;
            if (StringArrayContains(showcase, "rewardIds", rewardId)) return true;
            string name = GetString(showcase, "rewardName", "");
            return !String.IsNullOrWhiteSpace(name) && Normalize(name) == Normalize(rewardTitle);
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
                { "is_global_cooldown_enabled", globalCooldown > 0 },
                { "global_cooldown_seconds", globalCooldown > 0 ? globalCooldown : 1 }
            };
            if (!String.IsNullOrWhiteSpace(backgroundColor)) payload["background_color"] = backgroundColor.ToUpperInvariant();

            string baseUrl = "https://api.twitch.tv/helix/channel_points/custom_rewards?broadcaster_id=" +
                Uri.EscapeDataString(GetString(twitch, "broadcasterId", ""));
            Dictionary<string, object> result;
            if (String.IsNullOrWhiteSpace(rewardId))
            {
                result = TwitchJson("POST", baseUrl, GetString(twitch, "clientId", ""), GetString(twitch, "accessToken", ""), payload);
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
                    result = TwitchJson("POST", baseUrl, GetString(twitch, "clientId", ""), GetString(twitch, "accessToken", ""), payload);
                }
            }

            object[] rewards = result.ContainsKey("data") && result["data"] is object[] ? (object[])result["data"] : new object[0];
            Dictionary<string, object> reward = rewards.Length > 0 && rewards[0] is Dictionary<string, object>
                ? (Dictionary<string, object>)rewards[0]
                : new Dictionary<string, object>();
            string savedId = GetString(reward, "id", rewardId);

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

        private bool IsTrackedReward(string rewardId, string rewardTitle)
        {
            Dictionary<string, object> settings = server.ReadSettingsObject();
            Dictionary<string, object> draw = Obj(settings, "draw");
            if (draw.Count == 0) return false;
            if (StringArrayContains(draw, "rewardIds", rewardId)) return true;
            string name = GetString(draw, "rewardName", "");
            return !String.IsNullOrWhiteSpace(name) && Normalize(name) == Normalize(rewardTitle);
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
