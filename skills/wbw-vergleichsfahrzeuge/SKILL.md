---
name: wbw-vergleichsfahrzeuge
description: >
  Ermittelt Wiederbeschaffungswert-Vergleichsfahrzeuge für Kfz-Unfallgutachten.
  Verwenden, wenn der Nutzer "Vergleichsfahrzeuge suchen", "WBW ermitteln",
  "Wiederbeschaffungswert recherchieren", "vergleichbare Fahrzeuge finden" oder
  Ähnliches möchte, ggf. mit Fahrzeugdaten. Sucht auf mobile.de,
  AutoScout24 und Kleinanzeigen über eine Eskalationskette (direkter Portalabruf,
  eigener Dienst, Web Unlocker, Apify als letzte Rückfallebene),
  filtert nach Laufleistung (±25.000 km),
  Erstzulassung (±1 Jahr), Ausstattung und PLZ-Umkreis (±200 km) und exportiert
  einen PDF-Report mit Quellen-Linkliste.
metadata:
  version: "0.2.0"
---

# WBW-Vergleichsfahrzeug-Finder

Recherchiert vergleichbare Fahrzeuge für die Ermittlung des Wiederbeschaffungswerts
(WBW) und liefert einen druckfertigen Report plus Linkliste der verwendeten Inserate.

Alle Scripts liegen unter `${CLAUDE_PLUGIN_ROOT}/skills/wbw-vergleichsfahrzeuge/scripts/`.
Voraussetzungen: Node.js und eine `.env` mit den Zugangsdaten der Beschaffungsstufen
(siehe `.env.example` und `references/beschaffung.md`). Apify wird nur noch als
letzte Rückfallebene gebraucht. Arbeitsdateien in einen frischen Arbeitsordner schreiben,
z. B. `./wbw-<marke>-<modell>-<JJJJ-MM-TT>/`.

## Ablauf

### Schritt 1 — Fahrzeugdaten erfassen (geführte Abfrage)

Die Eckdaten des Subjektfahrzeugs abfragen. Felder, sofern nicht schon genannt:

- **Marke / Modell / Variante** (z. B. „VW Tiguan 2.0 TDI Highline"). Enthält die
  Variante eine **Ausstattungslinie** (Style, R-Line, Life, Highline, …), filtert die
  Pipeline den Korb automatisch auf genau diese Linie (Fallback auf alle nur ohne Linie
  oder ohne Treffer). Zusätzlich filtert die Pipeline auf die **Karosserie/Bauart**
  (SUV, Cabrio, …) — aus dem Input oder, falls dort nicht genannt, aus der häufigsten
  Bauart im Korb abgeleitet.
- **Erstzulassung** (Monat/Jahr, z. B. `07/2021`)
- **Laufleistung** in km
- **Leistung** in kW (optional, verbessert Dedup/Bereinigung)
- **Getriebe** — **explizit abfragen: Automatik oder Manuell** (oder „egal"). Bei
  Automatik/Manuell filtert die Pipeline den Korb auf genau diese Getriebeart (DSG/
  Doppelkupplung/Tiptronic zählen als Automatik). Bei „egal" kein Getriebe-Filter.
  Als `getriebe: "Automatik" | "Manuell"` in die `params.json` schreiben (sonst weglassen).
- **Anzahl Türen** (optional) — ist sie angegeben, filtert die Pipeline auf genau diese
  Türenzahl (Bereichsangaben wie „4/5" gelten als Treffer, wenn die Zahl enthalten ist;
  unbekannte Türenzahl bleibt drin). Als Zahl `tueren: 5` in die `params.json` schreiben.
  Die Actors haben dafür keinen Quell-Filter — die Türenzahl steht aber im Output und
  wird nachgelagert in `pipeline.js` ausgewertet.
- **Soll-Ausstattung** — **als Freitext** abfragen (kein Multiple-Choice): den Nutzer
  die Merkmale frei eingeben lassen, mit Komma getrennt (z. B.
  „Klimaautomatik, Sitzheizung, Panoramadach, Navigation"). Die Eingabe an Kommas (oder
  Zeilenumbrüchen) in einzelne Begriffe zerlegen, leere Einträge verwerfen, und als
  Array `sollAusstattung` in die `params.json` schreiben. Beliebige Formulierungen sind
  erlaubt — der Matcher ordnet sie über Synonyme zu; nicht erkannte Begriffe erscheinen
  im Report unter „unbekannt", ohne den Lauf zu stören.
- **Zentrum-PLZ** des regionalen Markts
- Optional: **Radius** (Default 200 km), **km-Toleranz** (Default 25.000),
  **EZ-Toleranz** (Default 1 Jahr), **Leistungs-Toleranz** (Default ±10 kW; nur wirksam,
  wenn die Leistung des Subjekts angegeben ist)

Für die übrigen Felder kann **AskUserQuestion** genutzt werden; die Soll-Ausstattung
jedoch ausdrücklich als freie Texteingabe behandeln.

### Schritt 2 — PLZ-Zentrum bestimmen

Der Geo-Filter braucht Koordinaten des Suchzentrums. Hinterlegt sind die PLZ-Bereiche
`47` (Krefeld), `41` (Neuss), `40` (Düsseldorf). Liegt die ersten zwei Stellen der PLZ
**nicht** darin: das Stadtzentrum der PLZ geocoden (bekannte lat/lon einsetzen) und als
`zentrum: { lat, lon }` in die `params.json` schreiben — dann wird die PLZ-Tabelle nicht
gebraucht.

### Schritt 3 — `params.json` schreiben

Eine Datei `params.json` im Arbeitsordner anlegen:

```json
{
  "subject": { "marke": "VW", "modell": "Tiguan", "variante": "2.0 TDI Highline",
               "ez": "07/2021", "mileage": 65000, "power": 110 },
  "sollAusstattung": ["Klimaautomatik", "Sitzheizung", "Panoramadach", "Navigation"],
  "plz": "47798",
  "zentrum": null,
  "radiusKm": 200,
  "kmToleranz": 25000,
  "ezToleranzJahre": 1,
  "leistungToleranzKw": 10,
  "getriebe": "Automatik",
  "tueren": 5,
  "maxItemsProPortal": 60,
  "kleinanzeigenLocId": null,
  "wbwOpts": { "eurProKm": 0.10, "eurProEzMonat": 120 }
}
```

- `zentrum` nur setzen, wenn die PLZ nicht in der Geo-Tabelle (47/41/40) steht.
- `kleinanzeigenLocId` optional: Kleinanzeigen-Standort-ID für die Umkreissuche (sonst
  Stichwortsuche). Siehe `references/portal-suche.md`.

### Schritt 4 — Such-Eingaben deterministisch erzeugen

```bash
SC="${CLAUDE_PLUGIN_ROOT}/skills/wbw-vergleichsfahrzeuge/scripts"
node "$SC/build-search-urls.js" params.json search-inputs.json
```

`search-inputs.json` enthält dann **fertige** Actor-Eingaben — nicht selbst raten:

- `mobileDe` — strukturiertes Objekt (`query`, `category`, `yearMin/Max`, `mileageMin/Max`,
  `zipCode` + `radiusKm`, `includeDetails`)
- `autoScout` — strukturiertes Objekt (`make`, `model`, `countries`, `yearFrom/To`,
  `mileageTo`, `includeDetails`)
- `kleinanzeigen` — strukturiertes Objekt (`car_make`/`car_model`, `category`,
  `min/max_first_registration_year`, `min/max_mileage`, `enrich_data`, `limit`)

### Schritt 5 — Beschaffung: DREI explizite Einzelschritte

> **Zwingend & sichtbar:** Alle drei Portale werden nacheinander durchsucht. Kündige
> **jeden** der drei Schritte mit einer **eigenen kurzen Statuszeile** an, bevor du den
> Befehl ausführst (damit die Schrittanzeige kleinteilig ist), z. B.:
> `🔍 1/3 — mobile.de wird durchsucht …`, `🔍 2/3 — AutoScout24 wird durchsucht …`,
> `🔍 3/3 — Kleinanzeigen wird durchsucht …`. Niemals ein Portal stillschweigend weglassen.

```bash
node "$SC/fetch-portal.js" mobile.de     search-inputs.json raw-mobile.json
node "$SC/fetch-portal.js" autoscout24   search-inputs.json raw-autoscout.json
node "$SC/fetch-portal.js" kleinanzeigen search-inputs.json raw-kleinanzeigen.json
```

Jeder Aufruf arbeitet die **Eskalationskette** aus `scripts/providers.json` ab und
nimmt die erste Stufe, die Treffer liefert — spätere Stufen werden dann nicht mehr
aufgerufen. Welche Stufen es gibt, welche aktiv ist und warum, steht in
`references/beschaffung.md`.

Die Ausgabedatei enthält `{ portal, items, beschaffungsprotokoll }`. Das Protokoll
hält fest, über welche Stufe die Daten kamen und wann — Schritt 6 übernimmt das in
den Abschnitt „Nachvollziehbarkeit" des Reports.

**Statuszeile je Portal:** Die Konsolenausgabe nennt die tragende Stufe, z. B.
`autoscout24: 60 Treffer über Stufe L0`. Melde dem Nutzer ausdrücklich, wenn eine
**kostenpflichtige** Stufe (L3/Apify) getragen hat.

Liefert ein Portal **0 Treffer**, endet der Befehl trotzdem mit Exit-Code 0 und
schreibt ein vollständiges Protokoll. Dann: Eingabe prüfen, einmal erneut versuchen;
bleibt es leer, als dokumentierten Leerstand vermerken und mit den übrigen weitermachen.
Exit-Code 2 heißt Bedienfehler (unbekanntes Portal, fehlender Eingabeblock) — dann
nicht wiederholen, sondern die Eingabe korrigieren.

**Nennt das Protokoll fehlende Zugangsdaten** (`KA_API_BASE`, `KA_API_USER`,
`KA_API_PASS`, `APIFY_TOKEN`, `WBW_ALLOW_PAID`), dann melde das nicht einfach als
Leerstand, sondern führe einmal die Umgebungsprüfung aus und gib ihre Ausgabe an den
Nutzer weiter:

```bash
node "$SC/pruefe-umgebung.js" --netz
```

Sie zeigt, welche Datei benutzt wurde, welche Pfade vergeblich geprüft wurden, ob ein
Wert aus der Umgebung oder aus einer Datei stammt und ob der Kleinanzeigen-Dienst
tatsächlich antwortet. Passwörter gibt sie nie aus, nur ihre Länge — die Ausgabe darf
also unverändert weitergereicht werden. Damit sieht der Nutzer sofort, ob die Datei am
falschen Ort liegt, ob der Lauf überhaupt auf seinem Rechner stattfindet oder ob die
Zugangsdaten abgelehnt werden.

> **Tempo:** Kleinanzeigen ist der langsamste Teil, weil je Inserat eine Detailseite
> geholt wird (Kilometerstand und Erstzulassung stehen nur dort) und zwischen den
> Abrufen bewusst pausiert wird. Für zügige Läufe `maxItemsProPortal` moderat halten
> (z. B. 30–40). Die Pausen sind Absicht und dürfen nicht verkürzt werden.

### Schritt 6 — Auswerten & Report in EINEM Schritt

Ein einziger Aufruf macht alles Weitere (normalisieren → geocoden → filtern/bewerten →
**Bilder einbetten** → HTML + Linkliste + `result.json` → **PDF**):

```bash
node "$SC/run-report.js" params.json ./out \
  "mobile.de=raw-mobile.json" \
  "autoscout24=raw-autoscout.json" \
  "kleinanzeigen=raw-kleinanzeigen.json"
```

Nur Portale auflisten, deren Rohdatei wirklich existiert. Die Filterkette in `pipeline.js`:
**Geo** (±Radius) → **Toleranz** (±km, ±EZ, ±kW) → **Dedup** → **Ausstattungslinie** →
**Karosserie** → **Getriebe** → **Ausstattungs-Score** → **WBW-Vorschlag**. Die Bilder
werden als Base64 in die HTML eingebettet (selbsttragend → **jeder** PDF-Konverter zeigt
sie, auch ohne Netz). `run-report.js` erzeugt die PDF automatisch, wenn headless Chrome
vorhanden ist; sonst ist die HTML druckfertig und per Browser-Druck als PDF speicherbar.

### Schritt 7 — Ergebnis präsentieren

Dem Nutzer liefern bzw. zusammenfassen:

- **PDF** (bzw. HTML) des Reports
- **Linkliste** der verwendeten Inserate
- Kurzfazit: WBW-Wertvorschlag, Anzahl Vergleichsfahrzeuge, je Portal gefunden,
  sowie Hinweise aus der Nachvollziehbarkeit (Dubletten, „ohne Koordinaten", Toleranz).

## Wichtige Hinweise

- Der **Wertvorschlag ist unverbindlich** und ersetzt nicht die WBW-Festsetzung durch
  den Sachverständigen. Inseratspreise sind Angebots-, keine Transaktionspreise.
- Fahrzeuge **ohne Koordinaten** werden nicht still verworfen, sondern separat
  ausgewiesen — der SV entscheidet über manuelle Prüfung.
- Passen Feldzuordnungen nach einem echten Lauf nicht (leere Preise/km/Features), die
  Kandidatenlisten in `scripts/normalize.js` ergänzen — siehe `references/datenschema.md`.
- Ändert ein Portal seinen Seitenaufbau, fällt das am schnellsten mit
  `npm run test:schema` auf (vergleicht die Live-Antwort gegen die Fixtures).
  Erst dann das Mapping im betroffenen Adapter nachziehen — siehe `TESTKONZEPT.md`.
