# WBW-Vergleichsfahrzeug-Finder

Cowork-Plugin für Kfz-Sachverständigenbüros: recherchiert vergleichbare Fahrzeuge zur
Ermittlung des **Wiederbeschaffungswerts (WBW)** und exportiert einen druckfertigen
Report (PDF/HTML) plus Quellen-Linkliste.

## Was es tut

Aus den Eckdaten eines Subjektfahrzeugs sucht das Plugin auf **mobile.de**,
**AutoScout24** und **Kleinanzeigen** vergleichbare Inserate und engt sie methodisch
ein. Die Beschaffung läuft über eine **Eskalationskette** — die erste Stufe, die
Treffer liefert, gewinnt; Apify ist nur noch die letzte Rückfallebene:

- Laufleistung **±25.000 km**
- Erstzulassung **±1 Jahr**
- Motorleistung **±10 kW** (trennt Motorvarianten, z. B. 110 kW vs. 81 kW)
- **Getriebe** (Automatik/Manuell): nur bei expliziter Wahl; DSG/Doppelkupplung/
  Tiptronic zählen als Automatik
- **Ausstattungslinie/Trim** (z. B. „Style", „R-Line"): ist beim Subjekt eine Linie
  angegeben, kommen **nur Fahrzeuge dieser Linie** in den Korb — andere Linien werden
  ausgeschlossen. Fallback auf alle Linien nur, wenn keine Linie angegeben ist **oder**
  keine Treffer der Linie gefunden werden.
- **Karosserie/Bauart** (SUV, Cabrio, Kombi, Limousine, …): nur Fahrzeuge der
  Subjekt-Bauart. Steht die Bauart nicht im Input (z. B. „T-Roc Style" sagt nicht „SUV"),
  wird die **häufigste Bauart im Korb** als Referenz genommen und Abweichler (z. B. ein
  einzelnes T-Roc Cabriolet) ausgeschlossen.
- **Ausstattungsabgleich** (Klimaautomatik, Sitzheizung, Panoramadach, …) mit Score
- **PLZ-Umkreis ±200 km** (Luftlinie, Haversine)
- **Dublettenbereinigung** (Inserats-ID + Fingerprint)

Ergebnis: eine Vergleichstabelle, eine Ausstattungsmatrix, ein **unverbindlicher
km-/EZ-bereinigter Wertvorschlag** und eine Linkliste der verwendeten Inserate.

## Komponenten

- **Skill** `wbw-vergleichsfahrzeuge` — führt durch Eingabe → Beschaffung → Filter → Export.
- **Scripts** (Node, **ohne jede externe Abhängigkeit** — kein `npm install` nötig):
  - `fetch-portal.js` + `providers.json` + `adapters/` (Beschaffung, Eskalationskette)
  - `geo-filter.js`, `dedup-fahrzeuge.js`, `ausstattung-matcher.js` (Kernlogik)
  - `build-search-urls.js` (Fahrzeugdaten → deterministische Such-Eingaben)
  - `normalize.js` (Portal-Rohdaten → gemeinsames Schema)
  - `geocode.js` (PLZ → Koordinaten, zwei Quellen)
  - `build-input.js`, `pipeline.js` (Verarbeitung)
  - `wbw-vorschlag.js` (Wertvorschlag), `run-report.js`/`generate-report.js` (HTML, PDF, Linkliste)

### Beschaffungsstufen

| Stufe | Was | Kosten | Stand |
| --- | --- | --- | --- |
| L0 | direkter Portalabruf | keine | trägt **AutoScout24** |
| L1 | eigener Dienst auf Büro-Infrastruktur | keine | trägt **Kleinanzeigen** |
| L2 | Bright Data Web Unlocker | Free Tier | verdrahtet, deaktiviert |
| L3 | Apify | **kostenpflichtig** | trägt **mobile.de** |

Details, Belege und die Begründung jeder deaktivierten Stufe:
`skills/wbw-vergleichsfahrzeuge/references/beschaffung.md`.


## Installation

Als Plugin in Claude Code — zwei Befehle:

```
/plugin marketplace add Lzm010409/WBW-Sachverstaendigenbuero
/plugin install wbw-vergleichsfahrzeug-finder@wbw-gollenstede
```

Danach ist der Skill in **jedem** Arbeitsordner verfügbar, nicht nur in diesem
Repo. Node.js muss vorhanden sein — sonst nichts, es gibt keine Abhängigkeiten.

### Zugangsdaten hinterlegen

Die Zugangsdaten gehören **nicht** in den Plugin-Ordner: der wird bei jedem
Plugin-Update ersetzt und die Datei wäre weg. Stattdessen an den festen Ort im
Benutzerprofil:

```bash
mkdir -p ~/.claude
cat > ~/.claude/wbw-vergleichsfahrzeuge.env <<'EOF'
KA_API_BASE=https://ka-api.gollenstede.app
KA_API_USER=wbw
KA_API_PASS=…
APIFY_TOKEN=apify_api_…
WBW_ALLOW_PAID=1
EOF
chmod 600 ~/.claude/wbw-vergleichsfahrzeuge.env
```

Die Skripte suchen in dieser Reihenfolge und nehmen die **erste** Datei, die sie
finden:

1. `$WBW_ENV_DATEI` — ausdrücklich gesetzter Pfad
2. `.env` im Arbeitsordner, dann aufwärts (für einen einzelnen Vorgang)
3. `~/.claude/wbw-vergleichsfahrzeuge.env` — **der empfohlene Ort**
4. `~/.claude/.env` — funktioniert genauso
5. `~/.claude/wbw.env`, `~/.wbw-vergleichsfahrzeuge.env`
6. `$CLAUDE_PLUGIN_ROOT/.env`
7. `.env` neben den Skripten, aufwärts (Entwicklung aus dem Repo)

Wird **keine** Datei gefunden, nennt die Fehlermeldung jeden geprüften Pfad —
damit die Ursache nicht im Skill gesucht wird, wenn die Datei nur woanders liegt.

#### Ohne Datei: Zugangsdaten in `settings.json`

Wer gar keine Datei anlegen will, trägt die Werte in `~/.claude/settings.json`
unter `env` ein. Claude Code setzt sie dann als Umgebungsvariablen, und die haben
**immer Vorrang** vor jeder `.env`:

```json
{
  "env": {
    "KA_API_BASE": "https://ka-api.gollenstede.app",
    "KA_API_USER": "wbw",
    "KA_API_PASS": "…",
    "APIFY_TOKEN": "apify_api_…",
    "WBW_ALLOW_PAID": "1"
  }
}
```

Nachgemessen: liegt derselbe Schlüssel in einer `.env` **und** in der Umgebung,
gewinnt die Umgebung. Beide Wege lassen sich also mischen — etwa die selten
wechselnden Werte in `settings.json`, ein Passwort für einen einzelnen Vorgang
per `.env` im Arbeitsordner.

Ein Unterschied, der zählt: `settings.json` ist eine Klartextdatei ohne
besondere Rechte, `~/.claude/wbw-vergleichsfahrzeuge.env` lässt sich mit
`chmod 600` absichern. Für Passwörter ist die `.env` deshalb die sauberere Wahl.

Bereits gesetzte Umgebungsvariablen haben immer Vorrang. Beim Sessionstart meldet
das Plugin, welche Datei es benutzt hat und welche Stufen damit nutzbar sind:

```
WBW-Vergleichsfahrzeug-Finder bereit (Node v22.22.2, keine Abhaengigkeiten zu installieren).
  Beschaffungsstufen:
    L0 AutoScout24    : nutzbar (keine Zugangsdaten noetig)
    L1 Kleinanzeigen  : nutzbar
    L2 Bright Data    : deaktiviert (kein Token)
    L3 Apify          : Token vorhanden
  PDF-Erzeugung      : /usr/bin/chromium
  Zugangsdaten aus   : /home/du/.claude/wbw-vergleichsfahrzeuge.env
```

### Wenn es nicht läuft: die Umgebungsprüfung

Der häufigste Fall ist „ich habe die Zugangsdaten doch hinterlegt, trotzdem
0 Treffer". Statt zu raten, wo es klemmt:

```bash
node <plugin>/skills/wbw-vergleichsfahrzeuge/scripts/pruefe-umgebung.js --netz
```

Oder in Claude einfach: *„Führ die Umgebungsprüfung des WBW-Plugins aus."*

Die Ausgabe nennt Betriebssystem und Benutzerordner, welche Datei benutzt wurde und
welche Pfade vergeblich geprüft wurden, für jede Variable ob sie aus der Umgebung
oder aus einer Datei kommt, welche Stufen damit nutzbar sind, ob ein Chrome gefunden
wird — und mit `--netz`, ob der Kleinanzeigen-Dienst wirklich antwortet:

```
Zugangsdaten-Datei
  benutzt: /Users/du/.claude/wbw-vergleichsfahrzeuge.env
Variablen
  KA_API_BASE       https://ka-api.gollenstede.app   Datei /Users/du/.claude/…
  KA_API_PASS       gesetzt (20 Zeichen)             Datei /Users/du/.claude/…
Beschaffungsstufen
  L1 Kleinanzeigen : nutzbar
  L3 Apify         : NICHT nutzbar - APIFY_TOKEN fehlt
Erreichbarkeit des Kleinanzeigen-Dienstes
  https://ka-api.gollenstede.app antwortet mit 200 - Zugangsdaten stimmen
```

Passwörter und Token gibt sie **nie** aus, nur ihre Länge — die Ausgabe darf man
gefahrlos weiterschicken.

Der wichtigste Punkt, den sie klärt: **welcher Rechner** den Skill überhaupt
ausführt. `~/.claude/settings.json` und `~/.claude/wbw-vergleichsfahrzeuge.env`
liegen auf **Ihrem** Rechner. Läuft die Sitzung in einer Cloud-Umgebung
(Claude Code im Browser, Cowork remote), sieht der Skill diese Dateien nicht — die
Zeile „Benutzerordner" in der Prüfung zeigt sofort, wo er tatsächlich läuft.

### Als Datei (Cowork)

Cowork installiert Plugins aus einer `.plugin`-Datei. Bauen:

```bash
./bauen.sh            # oder: npm run paket
# -> wbw-vergleichsfahrzeug-finder.plugin
```

Die Datei enthält nur Laufzeit-Bestandteile: `.claude-plugin/plugin.json`,
`skills/`, `hooks/`, `README.md`, `.env.example`. **Nicht** enthalten sind die
Tests, `.claude/` (das ist Projektkonfiguration dieses Repos) und selbstverständlich
keine `.env`. Ein Sicherheitsnetz im Bauskript bricht ab, falls ein Wert aus der
`.env` doch im Paket landen würde.

Zugangsdaten kommen auch hier aus `~/.claude/wbw-vergleichsfahrzeuge.env` — die
liegt ausserhalb des Plugins und überlebt jedes Update.

### Aus dem Repo statt als Plugin

Zum Weiterentwickeln reicht ein Klon; `.env` im Repo-Wurzelverzeichnis wird dann
gefunden. `npm test` läuft ohne `npm install`.

### Alle Umgebungsvariablen

| Variable | Wofür | Nötig für |
| --- | --- | --- |
| `KA_API_BASE`, `KA_API_USER`, `KA_API_PASS` | eigener Kleinanzeigen-Dienst | **L1 — Kleinanzeigen** |
| `APIFY_TOKEN` | Apify-REST-API | **L3 — produktiv nur mobile.de** |
| `BRIGHTDATA_TOKEN`, `BRIGHTDATA_ZONE` | Web Unlocker | L2 (derzeit deaktiviert) |
| `WBW_ALLOW_PAID=1` | Kostensperre lösen | jeder L3-Lauf — hier dauerhaft gesetzt |
| `WBW_CHROME` | Pfad zu Chrome/Chromium | PDF-Erzeugung, falls nicht im Standardpfad |

**AutoScout24 (L0) braucht keine Zugangsdaten.** Ohne jede Variable ist der Skill
also bereits für ein Portal einsatzfähig.

> **Kosten:** Nur L3 kostet Geld (Pay-per-Event, ~$0,8–1,5 / 1000 Treffer).
> `adapters/apify.js` verweigert den Lauf, solange `WBW_ALLOW_PAID=1` nicht gesetzt
> ist. **In diesem Repo ist die Variable dauerhaft gesetzt** — Details unter
> „Apify-Token einrichten". `npm test` bleibt davon unberührt: die Testskripte
> setzen die Variable nirgends und führen nur Offline-Tests aus.

## Apify-Token einrichten (einmalig, nur für mobile.de)

AutoScout24 und Kleinanzeigen laufen ohne. Nur mobile.de braucht den Token, weil
Akamai dort den direkten Abruf sperrt.

1. Bei [console.apify.com](https://console.apify.com) anmelden.
2. **Settings → API & Integrations → Personal API tokens** → Token kopieren
   (beginnt mit `apify_api_…`).
3. In `~/.claude/wbw-vergleichsfahrzeuge.env` eintragen (siehe Installation):
   ```
   APIFY_TOKEN=apify_api_………
   ```
   Nicht ins Repo — `.env` steht in `.gitignore`, und der globale Ort liegt
   ohnehin ausserhalb.
4. Guthaben prüfen: die drei Actors rechnen **pro Ergebnis** ab
   (~$0,8–1,5 / 1000 Treffer). Bei `maxItemsProPortal: 40` sind das Cent-Beträge
   je Gutachten.

> **Kostensperre — in diesem Repo bewusst gelöst.** `adapters/apify.js` verweigert
> L3-Läufe, solange `WBW_ALLOW_PAID=1` nicht gesetzt ist. Hier ist die Variable
> dauerhaft gesetzt (in `.env` und in `.claude/settings.json`), weil der Betreiber
> die L3-Kosten als unkritisch eingestuft hat. **Folge:** ein Aufruf von
> `fetch-portal.js mobile.de` kostet ab sofort ohne Rückfrage Geld.
>
> Wer das enger haben will: den Wert in beiden Dateien leeren und pro Lauf setzen —
> `WBW_ALLOW_PAID=1 node "$SC/fetch-portal.js" mobile.de …`. Die Sperre selbst
> bleibt im Code und wird von einem eigenen Test abgesichert.

Ohne Token passiert nichts Schlimmes: mobile.de meldet einen dokumentierten
Leerstand, die anderen beiden Portale laufen normal weiter.

## Tests

| Befehl | Umfang | Netz | Kosten |
| --- | --- | --- | --- |
| `npm test` | 75 Tests: Parser, Vertrag gegen echte Fixtures, Eskalation, Report | nein | keine |
| `npm run test:schema` | prüft, ob die Portale ihr Format geändert haben | ja | keine |
| `npm run test:live` | Feldvollständigkeit je Adapter gegen Schwellen | ja | keine |

`npm run test:schema` **vor** einem Gutachten laufen lassen, das gerichtsfest werden
soll — Portale bauen ihre Seiten um, und ein leeres Feld fällt sonst erst im Report auf.



## Nutzung

Starten mit z. B. *„Vergleichsfahrzeuge suchen"*, *„WBW ermitteln"* oder
*„Wiederbeschaffungswert für einen VW Tiguan recherchieren"*. Das Plugin fragt die
Fahrzeugdaten geführt ab.

### Was du angeben solltest

**Pflicht — ohne diese vier wird das Ergebnis beliebig:**

| Angabe | Beispiel | Warum es zählt |
| --- | --- | --- |
| Marke, Modell **und Variante** | `VW Tiguan 2.0 TDI Highline` | Die **Ausstattungslinie** (Highline, R-Line, Style, Life …) filtert den Korb hart auf genau diese Linie. Ohne sie mischt sich Basis mit Vollausstattung — der Median wird wertlos. |
| Erstzulassung | `07/2021` | Monatsgenau, nicht nur das Jahr. Die Alterskorrektur rechnet mit 120 €/Monat. |
| Laufleistung | `65000` | Trägt den ±25.000-km-Filter und die km-Korrektur (0,10 €/km). |
| Zentrum-PLZ | `47798` | Der **regionale** Markt ist für den WBW methodisch maßgeblich. |

**Dringend empfohlen — jede dieser Angaben verengt den Korb spürbar:**

| Angabe | Beispiel | Wirkung |
| --- | --- | --- |
| Leistung in kW | `110` | Trennt Motorvarianten (110 kW vs. 81 kW sind zwei Märkte). Toleranz ±10 kW. |
| Getriebe | `Automatik` / `Manuell` / `egal` | Wird **ausdrücklich abgefragt**. DSG, Doppelkupplung und Tiptronic zählen als Automatik. |
| Soll-Ausstattung | `Klimaautomatik, Sitzheizung, Panoramadach, Navigation` | **Freitext, mit Komma getrennt** — keine Auswahlliste. Der Matcher ordnet über Synonyme zu; was er nicht kennt, erscheint im Report unter „unbekannt", ohne den Lauf zu stören. |
| Anzahl Türen | `5` | Bereichsangaben wie „4/5" gelten als Treffer. |

**Optional, wenn der Korb zu klein oder zu grob wird:**

| Angabe | Default | Wann ändern |
| --- | --- | --- |
| Radius | 200 km | Bei seltenen Fahrzeugen hochsetzen — aber der regionale Bezug leidet. |
| km-Toleranz | ±25.000 | Bei Vielfahrern oder sehr alten Fahrzeugen weiter fassen. |
| EZ-Toleranz | ±1 Jahr | Bei Modellwechsel im Zeitraum enger fassen. |
| Leistungstoleranz | ±10 kW | Enger, wenn zwei Motorvarianten dicht beieinander liegen. |
| Treffer je Portal | 40 | Kleinanzeigen ist der langsamste Teil (Detailseite je Inserat). 60 kostet ~12 Minuten. |

**Faustregel:** Je genauer die Variante und je vollständiger Leistung und Getriebe,
desto belastbarer der Wertvorschlag. Ein Korb aus 20 wirklich vergleichbaren
Fahrzeugen ist mehr wert als einer aus 60 halbwegs passenden.

### Was du zurückbekommst

Alles landet in einem frischen Arbeitsordner, z. B. `./wbw-vw-tiguan-2026-09-05/out/`:

| Datei | Inhalt |
| --- | --- |
| `WBW-Vergleichsfahrzeuge.pdf` | Der druckfertige Report — das Dokument fürs Gutachten |
| `WBW-Vergleichsfahrzeuge.html` | Dasselbe als HTML, Bilder als Base64 eingebettet (funktioniert offline) |
| `Linkliste.md` | Nummerierte Quellenliste: Portal, Fahrzeug, Preis, direkter Inseratslink |
| `result.json` | Alle Rohwerte für eigene Auswertungen |

Der Report hat sieben Abschnitte:

1. **Subjektfahrzeug & Suchparameter** — womit gesucht wurde
2. **Wertvorschlag (unverbindlich)** — Roh-Median, Roh-Mittel, Spanne, und
   km-/EZ-**bereinigter** Median sowie getrimmter Mittelwert
3. **Vergleichsfahrzeuge** — Tabelle mit Portal, Modell, EZ, km, Leistung, Preis,
   **Distanz zum Zentrum**
4. **Einzelergebnisse** — jedes Fahrzeug mit Bild und Eckdaten
5. **Ausstattungsmatrix** — Soll-Ausstattung gegen jedes Vergleichsfahrzeug
6. **Quellen / Linkliste** — jedes verwendete Inserat verlinkt
7. **Nachvollziehbarkeit** — der Filtertrichter in Zahlen (gescrapt → im Umkreis →
   nach Toleranz → Dubletten → im Korb), die **separat ausgewiesenen Fahrzeuge ohne
   Koordinaten**, und das **Beschaffungsprotokoll**: welches Portal über welche Stufe
   kam und wann

Abschnitt 7 ist der gutachterlich wichtigste: Er belegt, dass nichts still
verschwunden ist, und dokumentiert die Herkunft jedes Datensatzes.

> Der **Wertvorschlag ist unverbindlich**. Er ersetzt nicht die WBW-Festsetzung
> durch den Sachverständigen; Inseratspreise sind Angebots-, keine
> Transaktionspreise.

## Verlässlichkeit & Anpassung

- Der **Wertvorschlag ist unverbindlich**; die WBW-Festsetzung trifft der
  Sachverständige. Inseratspreise sind Angebots-, keine Transaktionspreise.
- **Geocoding:** AutoScout24 und der Kleinanzeigen-Dienst liefern keine Koordinaten;
  der Umkreis hängt daher an `geocode.js`. Das fragt zippopotam.us und, wo dessen
  Daten defekt sind (ganze PLZ-Regionen im Rhein-Ruhr-Raum), Nominatim/OSM nach.
  Grober letzter Rückfall: die hinterlegten PLZ-Zentren `47` (Krefeld), `41` (Neuss),
  `40` (Düsseldorf).
- Fahrzeuge **ohne Koordinaten** werden nicht still verworfen, sondern im Report
  separat ausgewiesen — der Sachverständige entscheidet über manuelle Prüfung.
- Stimmen Feldzuordnungen nach einem echten Lauf nicht (leere Preise/km/Features),
  Kandidatenlisten in `scripts/normalize.js` ergänzen — siehe
  `skills/wbw-vergleichsfahrzeuge/references/datenschema.md`.
