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
        public const string Version = "2.13.26";
        public const string ReleaseDate = "2026-08-01";
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
        private static void Main(string[] args)
        {
            if (args != null)
            {
                foreach (string arg in args)
                {
                    if (String.Equals(arg, "--self-test", StringComparison.OrdinalIgnoreCase))
                    {
                        int failures = SelfTests.RunAll();
                        Environment.Exit(failures);
                        return;
                    }
                }
            }
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
