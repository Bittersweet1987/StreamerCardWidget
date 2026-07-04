# Konzept: Karten-Duell (Battle)

Status: **Entwurf zur Abstimmung** – noch nicht implementiert.

Zwei Zuschauer lassen ihre Karten gegeneinander antreten. Jede Seite tritt mit mehreren Karten an,
Runde für Runde entscheidet die Kartenstärke (plus Zufall) über den Rundensieg. Der Gesamtsieger
gewinnt **eine zufällige Karte aus der Aufstellung des Verlierers**. Dazu läuft eine eigene
OBS-Animation.

## Getroffene Entscheidungen
- **Sieger:** Stärke + Zufall, Runde für Runde; Gesamtsieger = meiste gewonnene Runden.
- **Stärke:** aus der Seltenheit abgeleitet (kein neues Feld pro Karte nötig).
- **Aufstellung:** die App zieht automatisch **N zufällige Karten** je Spieler; N ist konfigurierbar.
- **Ablauf:** `!battle @gegner` → Gegner bestätigt mit `!battleyes` (oder `!battleno`), mit Timeout.
- **Zu wenig Karten:** beide brauchen **mindestens N** Karten, sonst startet der Kampf nicht (Hinweis im Chat).
- **Unentschieden:** **Entscheidungsrunde** (Sudden Death) mit je einer weiteren Zufallskarte, bis ein Sieger feststeht.
- **Animation:** Variante (Runde-für-Runde / Kompakt) + Dauer in den Einstellungen wählbar (wie Tausch-Animation).
- **Cooldown/Limit:** Cooldown **und** Nutzungslimit gelten für **beide** Spieler.

## Befehle (Tab „Chat Befehle", je einzeln aktivierbar, Präfix/Befehlswort konfigurierbar)
- **`!battle @gegner`** – fordert heraus. Prüfungen: Gegner existiert (hat schon Karten), nicht man selbst,
  beide besitzen ≥ N Karten, Cooldown/Limit frei. Danach geht ein Angebot an den Gegner (Timeout, Standard 120 s).
- **`!battleyes`** – Gegner nimmt an → Kampf wird ausgetragen (siehe Ablauf), Preis vergeben, Ergebnis ausgegeben.
- **`!battleno`** – Gegner lehnt ab → Kampf beendet, keine Karten wechseln.

Es ist immer nur **ein Kampf gleichzeitig** aktiv (wie beim Tausch). Weitere `!battle` erhalten eine Busy-Meldung.

## Ablauf im Detail
1. **Herausforderung** `!battle @B` durch A.
   - Fehlerfälle mit eigener (anpassbarer) Chat-Meldung: Gegner nicht gefunden · sich selbst herausgefordert ·
     A oder B hat < N Karten · A im Cooldown · A hat Limit erreicht · es läuft bereits ein Kampf.
2. **Bestätigung:** B hat T Sekunden Zeit für `!battleyes`/`!battleno`. Keine Antwort → Timeout-Meldung, kein Verlust.
3. **Aufstellung:** je Spieler N zufällige Karten aus der eigenen Sammlung (siehe „Kartenauswahl").
4. **Kämpfe:** Runde i = Karte A[i] vs Karte B[i]. Pro Karte ein „Wurf" = Stärke × (1 + Zufall). Höherer Wurf
   gewinnt die Runde. Gesamtsieger = mehr Rundensiege. Gleichstand → Sudden-Death-Runde(n) mit je einer
   weiteren Zufallskarte.
5. **Preis:** der Sieger erhält **genau eine** zufällige Karte aus der **Kampf-Aufstellung des Verlierers**
   (Verlierer −1 dieser Karte, Sieger +1). Nur diese eine Karte wechselt den Besitzer.
6. **Abschluss:** beiden Spielern wird eine Kampf-Nutzung abgezogen und der Cooldown gesetzt. Die Animation
   läuft in OBS; danach die Ergebnis-Chat-Nachricht.

## Kartenauswahl (Annahme – bitte bestätigen)
- „N Karten" = **N verschiedene** Karten, die der Spieler besitzt (Anzahl ≥ 1). „Mindestens N" bedeutet also
  **mindestens N verschiedene Kartentypen**. Zufällige Auswahl ohne Wiederholung.
- Alternative wäre, Mehrfach-Besitz als mehrere „Kämpfer" zu zählen – das wurde mit „Duplikate auffüllen"
  bewusst **nicht** gewählt, daher: verschiedene Karten.

## Kartenstärke aus Seltenheit
- Neue, in den Einstellungen anpassbare Tabelle **Kampfstärke je Seltenheit** (unabhängig von den Ziehungs-
  Gewichten, denn dort ist „gewöhnlich" am häufigsten, hier soll „gewöhnlich" am **schwächsten** sein).
- Vorschlag Default: Gewöhnlich 1 · Ungewöhnlich 2 · Selten 3 · Episch 5 · Legendär 8 · Holo 12.
- Rundenwurf: `wurf = stärke × (1 + zufall(0…varianz))`, Varianz z. B. 0,6 → Überraschungen möglich,
  stärkere Karte aber klar im Vorteil. Varianz konfigurierbar.

## Animation (neue OBS-Browserquelle „Streamer Card Kampf")
- Eigener Quellenname unter **Verbindung** (nach „Quellenname Tausch-Animation"), Setup-Button legt sie an.
- Einstellungen (Tab **Einstellungen**, Block „Kampf-Animation"): Aktiviert · Stil (Runde-für-Runde / Kompakt) ·
  Dauer (kurz/mittel/lang) · eigener Kampf-Sound · „Ergebnis im Chat senden" (an/aus) · **Test starten**-Button.
- Inhalt: beide Aufstellungen einblenden; je Runde die beiden Karten gegeneinander + Rundensieger; am Ende
  Sieger hervorheben und die gewonnene Karte „wandern" lassen. Karten im gewählten Karten-Theme gerendert.

## Anpassbare Chat-Nachrichten (mit klickbaren Variablen)
- **Angebot** an B: `@userNameB, @userNameA fordert dich zum Kartenduell heraus! Nimm mit !battleyes an.`
- **Sieg/Ergebnis:** `@userNameA gewinnt das Duell gegen @userNameB ([SiegeA]:[SiegeB]) und erhält [GewonneneKarte]!`
- **Unentschieden→Entscheidungsrunde** ist intern; Ergebnis nennt den finalen Sieger.
- **Ablehnung** (`!battleno`), **Timeout**, **Cooldown**, **Limit erreicht**, **es läuft bereits ein Kampf**,
  **Gegner nicht gefunden**, **zu wenige Karten** – alle einzeln anpassbar.
- Variablen u. a.: `@userNameA`, `@userNameB`, `[SiegeA]`, `[SiegeB]`, `[GewonneneKarte]`, `[BoosterGewonnen]`,
  `[Uhrzeit]`, `[Anzahl]` (verbleibende Kämpfe), `[Cooldownwert]`, `[Einheit]`.

## Nutzung/Reset
- Eigener Zähler + Cooldown je Spieler in `data/command-usage.json` (Abschnitt `battle`), eigener Reset
  (Minuten/Stunden/Tage) wie `!pack`/`!trade`. In „Nutzung Befehle" ergänzen: Spalte `!battle`.

## Grobe Umsetzungsschritte (später)
1. Backend (`CardPackWidgetApp.cs`): Config-Defaults; `!battle`/`!battleyes`/`!battleno` in `ProcessChatMessage`;
   `activeBattle` + Timeout (analog `activeTrade`); Kampf-Auflösung (Aufstellung ziehen, Runden würfeln,
   Sieger, Preis via `ApplyTradeSwap`-artigem Kartenumzug); Broadcast `battle`; Ergebnis-Nachricht; Reset im 15s-Timer.
2. Frontend Overlay: `battle.html` + `battle.js` + `battle.css` (neue OBS-Quelle, 2 Stile), Test-Endpoint.
3. Admin-UI: Chat-Befehl-Karten für `!battle`/`!battleyes`/`!battleno` (Felder + Nachrichten + Chips);
   Einstellungen: Kampfstärke-Tabelle, Kampf-Animation-Block; Verbindung: Quellenname; „Nutzung Befehle" um `!battle`.
4. `render.js`: `normalizeSettings`-Defaults; `battle`-Animationsdaten; ggf. Kampfstärke-Helfer.
5. Doku/README + Release.

## Offene Punkte zum Bestätigen
- Standard-**N** (Karten pro Seite)? Vorschlag **3**.
- „N Karten" = N **verschiedene** Kartentypen (siehe oben) – ok so?
- Default-Kampfstärke-Werte und Varianz ok, oder andere Zahlen?
- Soll der **Gegner** wirklich ebenfalls eine Kampf-Nutzung verlieren, obwohl er herausgefordert wurde?
  (aktuell so gewählt: „Beide voll")
