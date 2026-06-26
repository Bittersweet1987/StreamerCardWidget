# Streamer Card Widget

Lokale Windows-App fuer Twitch Channel-Point Kartenpacks mit OBS Overlay.

## Start

1. Aktuelle `CardPackWidget.exe` von der [Releases-Seite](https://github.com/Bittersweet1987/StreamerCardWidget/releases) herunterladen und starten.
2. Die Verwaltung ist direkt in der App eingebettet.
3. Unter `Verbindung` OBS WebSocket eintragen und `OBS Szene aktualisieren` klicken.
4. Die App erstellt oder aktualisiert die Szene und die Browserquelle direkt in OBS.

## Build aus dem Quellcode

Es gibt kein `.csproj`/`.sln` - `src/CardPackWidgetApp.cs` wird direkt mit `csc.exe` (.NET Framework) compiliert. Benoetigt werden zusaetzlich die WebView2-Redistributable-DLLs (`Microsoft.Web.WebView2.Core.dll`, `Microsoft.Web.WebView2.WinForms.dll`, `Microsoft.Web.WebView2.Wpf.dll`, `WebView2Loader.dll`), z.B. ueber das [Microsoft.Web.WebView2 NuGet-Paket](https://www.nuget.org/packages/Microsoft.Web.WebView2/). `public/`, `data/`, `defaults/` muessen neben der exe liegen.

## Twitch verbinden

1. In `Verbindung` auf `Mit Twitch anmelden` klicken - der Login oeffnet sich im Standardbrowser.
2. Nach der Freigabe wird der Status automatisch aktualisiert.

Es muss keine eigene Twitch Developer App angelegt werden. Die benoetigten Scopes (`channel:manage:redemptions`, `channel:read:redemptions`) werden automatisch angefragt. Channelpoint-Rewards werden direkt per Twitch API geladen, erstellt und aktualisiert.

Mit `Abmelden` wird das lokal gespeicherte OAuth-Token geloescht.

## OBS

Die App spricht direkt mit OBS WebSocket auf Port `4455`. Wenn OBS ein WebSocket-Passwort verlangt, muss es in `Verbindung` eingetragen werden.

Nach einer erfolgreichen OBS-Verbindung merkt sich die App die Einstellung und prueft die Verbindung beim naechsten Start automatisch erneut.

## Daten

- Einstellungen: `data/settings.json`
- Sammlungen: `data/collections.json`

Sammlungen bleiben lokal erhalten, auch wenn OBS den Browser-Cache leert.
