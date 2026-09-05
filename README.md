# WBW-Vergleichsfahrzeug-Finder

Cowork-Plugin für Kfz-Sachverständigenbüros: recherchiert vergleichbare Fahrzeuge zur
Ermittlung des **Wiederbeschaffungswerts (WBW)** und exportiert einen druckfertigen
Report (PDF/HTML) plus Quellen-Linkliste.

## Was es tut

Aus den Eckdaten eines Subjektfahrzeugs sucht das Plugin über **Apify** auf
**mobile.de**, **AutoScout24** und **Kleinanzeigen** vergleichbare Inserate und engt
sie methodisch ein:

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

- **Skill** `wbw-vergleichsfahrzeuge` — führt durch Eingabe → Scrape → Filter → Export.
- **MCP-Server** `apify` — bindet die Scraper-Actors an.
- **Scripts** (Node, ohne externe Abhängigkeiten):
  - `geo-filter.js`, `dedup-fahrzeuge.js`, `ausstattung-matcher.js` (Kernlogik)
  - `build-search-urls.js` (Fahrzeugdaten → deterministische Actor-Eingaben/Such-URLs)
  - `normalize.js` (Portal-Rohdaten → gemeinsames Schema)
  - `build-input.js`, `pipeline.js` (Verarbeitung)
  - `wbw-vorschlag.js` (Wertvorschlag), `generate-report.js` (HTML + Linkliste)

## Setup

1. **Node.js** muss verfügbar sein.
2. **Apify-MCP-Server**: ist in `.mcp.json` als `https://mcp.apify.com` mit den drei
   Actors vorkonfiguriert (`blackfalcondata/mobile-de-scraper`,
   `blackfalcondata/autoscout24-scraper`, `fatihtahta/ebay-kleinanzeigen-scraper`).
   Alle drei liefern strukturierte Felder inkl. km/EZ/Leistung und **GPS-Koordinaten**;
   mobile.de zusätzlich nativen **PLZ-Umkreis**. So tragen alle drei Portale zum
   Vergleichskorb bei.
3. **Umgebungsvariable** `APIFY_TOKEN` mit einem gültigen Apify-API-Token setzen.

> Hinweis: Alle Actors rechnen **pro Ergebnis** ab (Pay-per-Event, ~$0,8–1,5 / 1000
> Treffer). Ergebnislimit je Portal moderat halten (z. B. 30–50); `includeDetails`
> liefert Ausstattung/GPS, ist aber langsamer.

## Nutzung

Starten mit z. B. *„Vergleichsfahrzeuge suchen"* oder *„WBW für einen VW Tiguan
ermitteln"*. Das Plugin fragt die Fahrzeugdaten geführt ab und liefert am Ende den
Report und die Linkliste.

## Verlässlichkeit & Anpassung

- Der **Wertvorschlag ist unverbindlich**; die WBW-Festsetzung trifft der
  Sachverständige. Inseratspreise sind Angebots-, keine Transaktionspreise.
- Hinterlegte PLZ-Zentren: `47` (Krefeld), `41` (Neuss), `40` (Düsseldorf). Für andere
  PLZ wird das Zentrum zur Laufzeit geocoded.
- Stimmen Feldzuordnungen nach einem echten Lauf nicht (leere Preise/km/Features),
  Kandidatenlisten in `scripts/normalize.js` ergänzen — siehe
  `skills/wbw-vergleichsfahrzeuge/references/datenschema.md`.
