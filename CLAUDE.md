# CLAUDE.md — Streamer Card Widget

Diese Datei ist die Projekt-Landkarte für Claude. Sie soll unnötige Exploration sparen: erst
hier nachsehen, dann gezielt greifen. Bei strukturellen Änderungen bitte aktuell halten.

## Was das ist
Lokale Windows-App (C# WinForms + WebView2) für Twitch-Sammelkarten. Ein **einzelner** C#-Server
(`src/CardPackWidgetApp.cs`) serviert `public/` per handgeschriebenem HTTP über TCP und pusht Live-
Events per **SSE** (`Broadcast(event, jsonData)`). Kein Framework, kein `.csproj`. Overlays laufen als
OBS-Browserquellen; die Verwaltung ist eine WebView2-Admin-Seite. Läuft auf **Port 5377**.

## Build (kein Projektfile — direkt mit csc.exe)
```
"C:\WINDOWS\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe
  /win32icon:"src\app.ico"
  /out:"<ziel>\CardPackWidget.exe"
  /r:System.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll
  /r:System.Web.Extensions.dll /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll
  /r:"CardPackWidget-TestApp\Microsoft.Web.WebView2.Core.dll"
  /r:"CardPackWidget-TestApp\Microsoft.Web.WebView2.WinForms.dll"
  src\CardPackWidgetApp.cs
```
C# = **C# 5** (alter Compiler): kein `?.`, kein `$"..."`, kein Ausdruckskörper-Member; Dictionary-
Zugriff mit `TryGetValue`/`ContainsKey`. Kompiliert die App läuft → EXE ist **gesperrt**; dann nur
`dist` bauen und den TestApp-Build überspringen (User schließt die App).

## Drei kanonische Standorte (immer synchron halten)
- `public/`, `src/` — Quelle (nur die sind versioniert; `CardPackWidget-TestApp/` und `dist/` sind gitignored).
- `CardPackWidget-TestApp/` — lokale Testinstanz (EXE + `public/` + `data/` + WebView2-DLLs).
- `dist/CardPackWidgetApp/` — Vorlage fürs Release (EXE + `public/` + `defaults/` + DLLs + README).

## Deploy-Checkliste für JEDE Änderung
1. C# geändert? → beide EXEs bauen (`CardPackWidget-TestApp\` und `dist\CardPackWidgetApp\`).
2. `public/` in beide App-Ordner spiegeln:
   `robocopy "public" "CardPackWidget-TestApp\public" /MIR /NFL /NDL /NJH /NJS /NP` (Exit 1 = OK, nicht Fehler)
   und dasselbe für `dist\CardPackWidgetApp\public`.
3. Overlay-Caching ist seit 2026-07-16 **automatisch** gelöst (BootId-Mechanismus, kein manuelles
   Cache-Busting mehr): Die Overlay-Seiten haben KEINE statischen `<link>`/`<script>`-Tags mehr,
   sondern einen Inline-Bootstrap-Loader, der `/api/version` (mit Unique-Timestamp) abruft und alle
   CSS/JS mit `?v=<BootId>` lädt; die Entry-Module (`overlay.js` usw.) reichen die BootId per
   dynamischem `await import("./api.js?v=…")` an die Shared-Module weiter. `AppInfo.BootId` ändert
   sich bei jedem App-Start; `connectEventStream` (api.js) lauscht auf das SSE-`ready`-Event und
   lädt die Seite bei geänderter BootId selbst neu (`location.replace` mit neuer `?v=`) — App-Neustart
   genügt also, damit OBS/Meld-Quellen sich selbst aktualisieren. **Wichtig:** Beim Ändern der
   Overlay-HTMLs keine statischen Asset-Tags wieder einführen; neue CSS-Dateien in die Loader-Liste
   der jeweiligen Seite eintragen. `admin.html` (WebView2) nutzt weiterhin statische `?v=`-Tags →
   bei Admin-Änderungen `node tools/bump-cache-buster.js <wert>` laufen lassen (fasst die
   Runtime-Versionen `?v=${__v}` nicht an).
4. Verifizieren: `node public/assets/js/admin.js 2>&1 | grep -i syntaxerror` (echter ESM-Fehler; `node --check`
   ist zu nachsichtig und übersieht z. B. ein falsches ASCII-`"` in i18n-Strings). CSS-Klammern: `{` vs `}` zählen.
5. Commit **nur mit `-F <datei>`** (siehe Gotchas), auf `main` pushen — nur wenn der User es will.

## Release-Workflow
- Version + `ReleaseDate` in `src/CardPackWidgetApp.cs` (ganz oben, ~Zeile 22–23) setzen; `GitHubRepo` = `Bittersweet1987/StreamerCardWidget`.
- ZIP aus `dist/CardPackWidgetApp` packen, **ohne `data/`**, mit **Forward-Slash**-Einträgen (WebView/Update-
  Installer erwartet das). Standard-Skript: PowerShell `System.IO.Compression.ZipArchive`, jeden Entry mit
  `.Replace('\\','/')` anlegen.
- `gh release create vX.Y.Z <zip> --title … --notes-file … --target main`.
- Der In-App-Updater (`InstallUpdate`) lädt das `.zip`-Asset des neuesten Releases, entpackt es und kopiert
  ALLES rekursiv über das Install-Verzeichnis → deshalb kein `data/` im ZIP.

## Code-Landkarte
### Backend — `src/CardPackWidgetApp.cs` (~3900 Zeilen, eine Datei)
- `class MainForm` / Startup / `--apply-update`-Selbstupdate ganz oben.
- `class CardPackServer` — HTTP: `HandleApi(...)` (langer if-Baum für `/api/...`), `ServeStatic` (setzt
  `Cache-Control: no-store` für .html/.js/.css), `ReadSettingsObject`/`WriteSettingsObject`, `Broadcast`,
  SSE-`clients`. Datenzugriff-Helfer für Karten/Booster/Sammlungen (`ResolveCardByName`, `GetCardCount`,
  `ApplyTradeSwap`, `PickCardFromBooster`, `FindBooster`, Rarity-Gewichte).
- `class TwitchBridge` — zwei EventSub-Sockets: Kanalpunkte (`channel...redemption.add`) und Chat
  (`channel.chat.message`). Chat-Befehle: `ProcessChatMessage` → `HandlePackCommand`/Sammlung/`HandleTrade*`.
  Aktion-**Queue**: `Enqueue`/`QueueLoop`/`ProcessQueueItem`/`CompleteQueueItem` — streng sequentiell, wartet
  je Item auf Overlay-Abschluss-Ack (`/api/queue/complete`) + 500ms. `SendDrawPostMessage` sendet die Chat-
  Nachricht **nach** der Animation (Server wählt Karte → kennt `[Kartenname]`/`[Boostername]`).
  Nutzung/Cooldown/Reset (pro User) in `data/command-usage.json`; DST-korrekter Tages-Reset um 00:01.
- `class EventLog` — Ereignis-Log (`data/app-log.json`), wird bei jedem Start geleert.
- Secrets liegen getrennt: `data/twitch.json`, `data/twitch-bot.json`, `data/obs.json` (werden bei
  `ReadSettingsObject` reingemerged, bei `WriteSettingsObject` wieder rausgesplittet). `saveSettings` im
  Frontend strippt `twitch`/`twitchBot` komplett, damit sie nie überschrieben werden.

### Frontend — `public/`
- `admin.html` + `assets/js/admin.js` (~2500 Z.) — die Verwaltung. Muster: `I18N`-Objekt (de/en) + `t(key)`
  + `data-i18n`; `hydrateX()`/`bindX()` pro Tab; `renderAll()` läuft je Stufe in try/catch; Tabs über
  `bindTabs`. Variablen-Chips (`.var-chips[data-target]` + `[data-insert]`) über einen dokumentweiten Handler.
  Frühes Inline-Fehler-Skript im `<head>` meldet Modul-Ladefehler ins Log (rote Leiste).
- `assets/js/render.js` — geteilt (Overlay + Admin): `normalizeSettings` (alle Defaults!), `cardMarkup`,
  `applyTheme`, `CARD_THEMES` + `customThemeCss`, Rarity-Gewichte (`weightedPick`).
- `overlay.html`/`overlay.js` — Pack-Animation. `collection.html`/`collection.js` — Sammlungs-Showcase.
  `trade.html`/`trade.js` — Tausch-Animation (3 Stile). `battle.html`/`battle.js` — Kampf-Animation
  (3 Kampfstile). `ranking.html`/`ranking.js` — Ranking-Overlay (`!ranking <Karte>`/`!ranking battle`,
  keine Chat-Ausgabe; Kampf-Statistik persistent in `data/battle-stats.json`). Alle lauschen per
  `connectEventStream`.
- `assets/css/components.css` — Karten-Look inkl. **Karten-Themes** (`[data-card-theme="…"]` setzt `--card-*`
  Variablen; Default = Fallback). `admin.css`, `overlay.css`, `collection.css`, `trade.css`.

## Wichtige Konventionen / Muster
- **Karten-Themes**: über CSS-Variablen `--card-bg`/`--card-pattern`/`--card-pattern-opacity`/`--card-art-bg`.
  `default` setzt sie auf `initial` (sonst erbt die Klassik-Vorschau ein aktives Theme). „custom" setzt sie inline.
- **Chat-Variablen** in Nachrichten: `@userName`, `[Kartenname]`, `[Boostername]`, `[Uhrzeit]`, `[Restzeit]`,
  Tausch-spezifische `[KarteA]`/`[BoosterA]`/… — serverseitig per `String.Replace` ersetzt.
- **Queue-Abschluss**: Overlays müssen nach der Animation `completeQueueItem(eventId, cardTitle, boosterTitle)`
  posten, sonst blockiert der nächste Eintrag bis zum Timeout.

## Gotchas (häufige Stolperfallen)
- **PowerShell-Commit**: `git commit -m "…"` bricht an eingebetteten `"`/deutschen Quotes. **Immer**
  Commit-Message in eine Datei schreiben und `git commit -F <datei>` nutzen. Commit-Footer:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **`data/settings.json` NICHT lesen** — ~10 MB (Kartenbilder als Base64). Fürs Debuggen nur gezielt Felder
  über `/api/settings` ziehen oder `boosters.json`/`cards.json` ansehen.
- **OBS cacht Overlays hart**: seit dem BootId-Loader (siehe Deploy-Checkliste Punkt 3) lösen sich
  Overlays nach App-Neustart selbst — kein manueller Cache-Refresh mehr nötig.
- **Chromium-Verbindungslimit (6 pro Host!)**: OBS hostet ALLE Browserquellen in EINEM Browser-Kontext.
  Deshalb: alle Animationen laufen in EINER kombinierten Quelle (`overlays.html`), und `connectEventStream`
  (api.js) hält pro Browser nur EINE SSE-Verbindung (Web-Locks-Leader + BroadcastChannel-Relay).
  NIE wieder eine eigene OBS-Quelle pro Animation anlegen — sechs SSE-Verbindungen haben am 2026-07-16
  den Pool exakt gesättigt und alle Animationen lautlos gekillt. Neue Overlays = neue Ebene in
  `overlays.html` + Entry-Modul in dessen Loader-Liste. Server sendet SSE-`ping` alle 20s; Clients
  reconnecten per Watchdog nach 65s Stille.
- **`node --check` reicht nicht**: kompiliert nur die Einzeldatei. Für echte Modul-/Zeichenfehler die Datei
  mit `node <file>` ausführen (fängt SyntaxError im ESM-Graph).
- robocopy-Exit **1** bedeutet „Dateien kopiert" = Erfolg, nicht Fehler.
- Git warnt „LF will be replaced by CRLF" — harmlos.
- Branch ist `main`; Releases hängen am `main`-Target.
