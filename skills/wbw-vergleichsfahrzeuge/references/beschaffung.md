# Datenbeschaffung — Eskalationskette

Die Beschaffung (Schritt 5 des Skills) läuft nicht mehr direkt über Apify, sondern
über `scripts/fetch-portal.js`. Das Skript arbeitet je Portal die Stufen aus
`scripts/providers.json` der Reihe nach ab und nimmt die **erste Stufe, die Treffer
liefert**. Spätere Stufen werden dann nicht mehr aufgerufen — das ist der
Kostensinn der Kette. Ein leeres Ergebnis gilt ausdrücklich **nicht** als Erfolg,
sondern eskaliert.

## Die Stufen

| Stufe | Was                                   | Kosten                          |
| ----- | ------------------------------------- | ------------------------------- |
| L0    | direkter Abruf beim Portal            | keine                           |
| L1    | eigener Dienst auf Büro-Infrastruktur | keine (Serverbetrieb)           |
| L2    | Bright Data Web Unlocker              | Free Tier 5.000 Requests/Monat  |
| L3    | Apify                                 | **kostenpflichtig**             |

## Stand je Portal

### mobile.de → trägt über L3 (Apify)

L0 ist **deaktiviert**, und zwar begründet, nicht aus Bequemlichkeit:

| Versuch                                    | Ergebnis                                              |
| ------------------------------------------ | ----------------------------------------------------- |
| Direktabruf, schlanker Headersatz           | HTTP 403, `server: AkamaiGHost`                       |
| Direktabruf, voller Browser-Headersatz      | HTTP 200, Rumpf = Akamai-Bot-Manager-JS-Challenge     |
| Echter Chromium (Playwright)                | harter HTTP 403                                       |
| Suche nach unauthentifiziertem BFF-Endpunkt | keiner gefunden                                       |

Es wurde bewusst **kein Endpunkt geraten**. Ein falsch geratener Endpunkt ist
schlechter als ein deaktivierter: er liefert stillschweigend nichts oder Falsches,
und das fällt erst im Gutachten auf.

**Wenn der Endpunkt später ermittelt wird:** in `providers.json` unter
`mobile.de → L0 → endpoint` eintragen, in `adapters/mobilede.js` ein `mappe()`
gegen die **dann vorliegende echte Antwort** schreiben, eine Fixture unter
`tests/fixtures/` ablegen und L0 auf `enabled: true` setzen.

### AutoScout24 → trägt über L0 (kostenlos)

Die Trefferliste steht serverseitig gerendert als JSON in
`<script id="__NEXT_DATA__">` unter `props.pageProps.listings[]` (20 je Seite).
Verifizierte Suchparameter: `fregfrom`, `fregto`, `kmfrom`, `kmto`, `zip`, `zipr`,
`page`, `powertype=kw`.

Belastungsprobe: 5 Abrufe in Folge mit 2 s Pause — alle HTTP 200, keine Blockade.
Ein Browser-Headersatz ist Pflicht; ohne ihn antwortet AutoScout24 mit 403.

Die Trefferliste enthält **keine Koordinaten** (auch kein `location.coordinates`).
Der Umkreis kommt deshalb aus dem PLZ-Geocoding in `geocode.js`. Ebenso fehlt die
Karosserieform — `pipeline.js` leitet sie aus dem Korb ab.

### Kleinanzeigen → trägt über L1 (eigener Dienst)

Dienst: `DanielWTE/ebay-kleinanzeigen-api` (MIT), **unverändert**, als offizielles
Upstream-Image auf einen Commit gepinnt. Der direkte Zugriff auf kleinanzeigen.de
aus fremden Netzen wird IP-gesperrt — deshalb läuft der Dienst auf der eigenen
Infrastruktur.

Drei Korrekturen gegenüber den ursprünglichen Annahmen, alle **live** bestätigt:

1. **Es gibt keinen `/health`-Endpunkt** — `GET /health` liefert 404.
   Der Statusendpunkt ist `GET /`; der Docker-HEALTHCHECK des Images prüft `/docs`.
2. **`GET /inserat/{id}` verlangt `batch_id`** als Pflichtparameter, sonst HTTP 422.
3. Der Dienst liest **kein** `HEADLESS` — die einzige Umgebungsvariable im Code ist
   `BROWSER_CDP_URL`.

Arbeitsteilung der Endpunkte:

- `POST /inserate-by-url` liefert `adid`, `url`, `title`, `location`, `description`,
  `published_at` — **aber weder Kilometerstand noch Erstzulassung, und der Preis ist
  regelmäßig leer.**
- `GET /inserat/{adid}?batch_id=…` liefert alles Fachliche unter `data.details`:
  `Kilometerstand` („42.536 km"), `Erstzulassung` (**deutscher Monatsname**, z. B.
  „Oktober 2022"), `Leistung` (**in PS**, wird auf kW umgerechnet), `Getriebe`,
  `Kraftstoffart`, `Fahrzeugtyp`, `Anzahl Türen` („4/5"), dazu `price.amount`,
  `location.{zip,city}`, `features[]` und `media.images.urls[]`.

Der Detailabruf ist deshalb **Pflicht**, nicht optional — und er ist der langsamste
Teil des ganzen Laufs.

**Kleinanzeigen liefert grundsätzlich keine GPS-Koordinaten** (im Quellcode des
Dienstes bestätigt: `get_location()` gibt nur `zip`, `city`, `state` zurück). Die
Fahrzeuge werden über die PLZ geocodiert; was dabei übrig bleibt, weist der Report
separat als „ohne Koordinaten" aus, statt es still zu verwerfen.

### Bright Data (L2) — verdrahtet, nicht aktiv

Der Adapter `adapters/unlocker.js` ist vollständig implementiert und steht auf
`enabled: false`, weil kein Konto existiert. Er ist damit **nicht live verifiziert**.
Zum Aktivieren: Zone `mcp_unlocker` anlegen, `BRIGHTDATA_TOKEN` in die `.env`
(nicht ins Repo), Stufe auf `enabled: true`, dann `npm run test:live`.

Nötig wird L2, sobald AutoScout24 anfängt zu blocken — dann ist es die letzte
kostenlose Stufe vor Apify.

## L3 — Apify

Bleibt bewusst erhalten und funktionsfähig. Die Kette hat nur Sinn, wenn die
unterste Ebene wirklich trägt.

| Portal        | Actor                                    | `maxTotalChargeUsd` |
| ------------- | ---------------------------------------- | ------------------- |
| mobile.de     | `blackfalcondata/mobile-de-scraper`      | 0.5                 |
| AutoScout24   | `blackfalcondata/autoscout24-scraper`    | 0.5                 |
| Kleinanzeigen | `fatihtahta/ebay-kleinanzeigen-scraper`  | 0.5                 |

Alle drei sind **Pay-per-Event**: ohne positives `maxTotalChargeUsd` bricht der
Lauf bei 0 $ ab. Der Wert steht je Stufe in `providers.json`.

**Kostensperre:** `adapters/apify.js` verweigert den Lauf, solange
`WBW_ALLOW_PAID=1` nicht gesetzt ist. `npm test` setzt die Variable nicht — ein
versehentlicher kostenpflichtiger Lauf im normalen Testlauf schlägt fehl, statt
Geld zu kosten. Ein eigener Test prüft genau diese Sperre.

## Umgebungsvariablen

Alle in der `.env` (gitignoriert), Vorlage in `.env.example`:

| Variable                          | Wofür                                    |
| --------------------------------- | ---------------------------------------- |
| `KA_API_BASE`                     | Basis-URL des eigenen Kleinanzeigen-Dienstes |
| `KA_API_USER` / `KA_API_PASS`     | Basic Auth davor                         |
| `BRIGHTDATA_TOKEN` / `..._ZONE`   | L2                                       |
| `APIFY_TOKEN`                     | L3                                       |
| `WBW_ALLOW_PAID=1`                | schaltet L3 bewusst frei                 |
| `WBW_PAUSE_MS`                    | Pause zwischen Abrufen (Default 1800 ms) |

## Pausen

Zwischen Seitenabrufen und zwischen Kleinanzeigen-Detailabrufen liegen mindestens
1,5 s (Default 1,8 s). Das ist **Absicht, kein Optimierungspotenzial**: es hält die
Last bei den Portalen niedrig und die eigene IP unauffällig. Zwei Tests in
`tests/nf-nichtfunktional.test.js` erzwingen die Pausen, damit sie nicht bei einem
späteren Refactor still verschwinden.

## Was beim nächsten Portal-Update kaputtgeht

| Wahrscheinlich       | Woran man es merkt                                        |
| -------------------- | --------------------------------------------------------- |
| AutoScout24 benennt `__NEXT_DATA__`-Felder um | `npm run test:schema` schlägt an; im Live-Lauf sinkt die Feldvollständigkeit |
| AutoScout24 fängt an zu blocken | `fetch-portal.js` meldet HTTP 403 und eskaliert nach L3 (Kosten!) |
| Kleinanzeigen ändert die Labels der Detailseite | E2-Vertragstest bricht, sobald die Fixtures erneuert werden; live: km/EZ leer |
| Der eigene Dienst steht | `fetch-portal.js` meldet den Fehler und eskaliert nach L3 |
| Basic-Auth-Zugangsdaten falsch | HTTP 401 mit klarer Meldung im Protokoll |

`npm run test:schema` ist genau dafür da: **vor** dem nächsten Gutachten prüfen,
ob die Live-Antworten noch zur Fixture-Struktur passen.
