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

## Setup

1. **Node.js** muss verfügbar sein. Sonst nichts — es gibt keine Abhängigkeiten.
2. `.env.example` nach `.env` kopieren und ausfüllen. `fetch-portal.js` liest die
   Datei selbst (vom Arbeitsordner aufwärts); ein Export von Hand ist nicht nötig.
   Bereits gesetzte Umgebungsvariablen haben Vorrang.

| Variable | Wofür | Nötig für |
| --- | --- | --- |
| `KA_API_BASE`, `KA_API_USER`, `KA_API_PASS` | eigener Kleinanzeigen-Dienst | **L1 — Kleinanzeigen** |
| `APIFY_TOKEN` | Apify-REST-API | **L3 — produktiv nur mobile.de** |
| `BRIGHTDATA_TOKEN`, `BRIGHTDATA_ZONE` | Web Unlocker | L2 (derzeit deaktiviert) |
| `WBW_ALLOW_PAID=1` | Kostensperre lösen | jeder L3-Lauf, **bewusst pro Aufruf** |
| `WBW_CHROME` | Pfad zu Chrome/Chromium | PDF-Erzeugung, falls nicht im Standardpfad |

**AutoScout24 (L0) braucht keine Zugangsdaten.** Ohne jede Variable ist der Skill
also bereits für ein Portal einsatzfähig.

> **Kosten:** Nur L3 kostet Geld (Pay-per-Event, ~$0,8–1,5 / 1000 Treffer).
> `adapters/apify.js` verweigert den Lauf, solange `WBW_ALLOW_PAID=1` nicht gesetzt
> ist — `npm test` setzt die Variable nicht, ein versehentlicher kostenpflichtiger
> Lauf schlägt also fehl, statt Geld zu kosten. Deshalb gehört `WBW_ALLOW_PAID`
> **nicht dauerhaft in die `.env`**.

## Tests

| Befehl | Umfang | Netz | Kosten |
| --- | --- | --- | --- |
| `npm test` | 71 Tests: Parser, Vertrag gegen echte Fixtures, Eskalation, Report | nein | keine |
| `npm run test:schema` | prüft, ob die Portale ihr Format geändert haben | ja | keine |
| `npm run test:live` | Feldvollständigkeit je Adapter gegen Schwellen | ja | keine |

`npm run test:schema` **vor** einem Gutachten laufen lassen, das gerichtsfest werden
soll — Portale bauen ihre Seiten um, und ein leeres Feld fällt sonst erst im Report auf.

## Apify-Token einrichten (einmalig, nur für mobile.de)

AutoScout24 und Kleinanzeigen laufen ohne. Nur mobile.de braucht den Token, weil
Akamai dort den direkten Abruf sperrt.

1. Bei [console.apify.com](https://console.apify.com) anmelden.
2. **Settings → API & Integrations → Personal API tokens** → Token kopieren
   (beginnt mit `apify_api_…`).
3. In die `.env` im Plugin-Ordner eintragen:
   ```
   APIFY_TOKEN=apify_api_………
   ```
   Nicht ins Repo — `.env` steht in `.gitignore`.
4. Guthaben prüfen: die drei Actors rechnen **pro Ergebnis** ab
   (~$0,8–1,5 / 1000 Treffer). Bei `maxItemsProPortal: 40` sind das Cent-Beträge
   je Gutachten.

> **`WBW_ALLOW_PAID` gehört NICHT in die `.env`.** Der Token allein löst noch
> keinen kostenpflichtigen Lauf aus — `adapters/apify.js` verweigert ihn, solange
> `WBW_ALLOW_PAID=1` nicht gesetzt ist. Das ist die Bremse gegen versehentliche
> Kosten. Wenn du mobile.de mitlaufen lassen willst, sag das im Gespräch; dann
> wird die Variable **für diesen einen Lauf** gesetzt.

Ohne Token passiert nichts Schlimmes: mobile.de meldet einen dokumentierten
Leerstand, die anderen beiden Portale laufen normal weiter.

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
