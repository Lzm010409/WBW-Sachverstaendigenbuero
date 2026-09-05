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

## Nutzung

Starten mit z. B. *„Vergleichsfahrzeuge suchen"* oder *„WBW für einen VW Tiguan
ermitteln"*. Das Plugin fragt die Fahrzeugdaten geführt ab und liefert am Ende den
Report und die Linkliste.

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
