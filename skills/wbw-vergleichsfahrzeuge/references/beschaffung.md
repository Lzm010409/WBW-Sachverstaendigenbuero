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

> **Modellname wird gegen die Portal-Taxonomie geprüft.** AutoScout24 antwortet
> auf einen unbekannten Modellnamen **nicht** mit 404, sondern liefert
> stillschweigend *alle* Modelle der Marke. Real beobachtet: `subject.modell`
> „Golf VII" ergab HTTP 200 und 40 Treffer quer durch Tiguan, Caddy, T6 und
> Touran — nur 11 davon waren ein Golf. Im Gutachten sieht man das dem Korb
> nicht an.
>
> Der Adapter liest deshalb die Modellliste, die AutoScout24 selbst mitliefert
> (`props.pageProps.taxonomy.models`), und prüft den Namen dagegen:
> - Name existiert → unverändert suchen.
> - Name existiert nach Wegfall **einer Generationsangabe** (`VII`, `7`, `Mk7`)
>   und der Rest ist ein **echter** Modellname → damit suchen und die Korrektur
>   als Warnung ins Protokoll und in den Report schreiben.
>   „Golf VII" → „Golf", „Golf VII Variant" → „Golf Variant".
> - Sonst → Abbruch mit den gültigen Modellnamen als Vorschlag. Es wird nichts
>   geraten; Buchstabe-Ziffer-Kombinationen wie „A4", „Mazda 3" oder „500"
>   bleiben unangetastet.
>
> Zusätzlich prüft der Adapter nach dem Abruf, ob wirklich mindestens 60 % der
> Treffer das gesuchte Modell sind — greift der Filter aus einem anderen Grund
> nicht, bricht die Stufe ab, statt Datenmüll zu liefern.

> **Karosserieform:** Die Trefferliste enthält kein Bauart-Feld. Die Bauart wird
> aus dem Titel erkannt (`detectKarosserie` in `ausstattung-matcher.js`), der bei
> AutoScout24 die Modellversion enthält — „Variant" (Kombi), „Lim." (Limousine),
> „Sportsvan" (Van). Ohne diese Begriffe rutschte ein Golf Sportsvan in eine
> Kombi-Suche.


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
Upstream-Image auf Commit `sha-da2fb02` gepinnt. Erreichbar unter
`https://ka-api.gollenstede.app` (Cloudflare terminiert TLS) und zusätzlich unter
`https://ka-api.116.202.21.243.sslip.io` — dieselbe Anwendung, beide Hostnamen im
Traefik-Router, beide durch Basic Auth geschützt.

**Zugriffsschutz:** Basic Auth als Traefik-Middleware über die Custom Labels der
Coolify-Anwendung. Coolifys eingebaute Basic-Auth-Felder (`is_http_basic_auth_enabled`,
`http_basic_auth_password`) sind in Version 4.1.2 **wirkungslos** — das Passwort wird
nicht persistiert und es entsteht keine Middleware; ein Aufruf ohne Zugangsdaten kam
weiterhin durch. Deshalb der eigene Labelsatz. Achtung: gesetzte `custom_labels`
**ersetzen** die von Coolify erzeugten, der Satz muss also vollständig sein (Router,
Service, Ports, TLS). Das HTTP-Router-Ziel leitet bewusst **nicht** auf HTTPS um,
weil Cloudflare je nach SSL-Modus per HTTP zum Ursprung spricht — der Schutz hängt
an der Auth-Middleware, nicht am Schema. Der direkte Zugriff auf kleinanzeigen.de
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

## Geocoding — tragend, und mit einer Fußangel

Weder die AutoScout24-Trefferliste noch der Kleinanzeigen-Dienst liefern
Koordinaten. Der komplette Umkreisbezug hängt damit an `geocode.js`.

**Befund:** `api.zippopotam.us` liefert für ganze PLZ-Regionen **verschobene
Datensätze**: `latitude` enthält dann den Gemeindeschlüssel (z. B. `"05113"` für
Essen), `longitude` die tatsächliche Breite, die Länge fehlt ganz. Betroffen sind
unter anderem **42xxx, 45xxx, 50xxx, 51xxx, 65xxx** — also ausgerechnet der
Rhein-Ruhr-Raum und damit der Heimatmarkt des Büros. Auch `47798` (Krefeld) war
betroffen. Die Plausibilitätsprüfung in `geocode.js` verwirft solche Sätze zu
Recht; in einem Messlauf landeten dadurch **13 von 57 Fahrzeugen (23 %)** in
„ohne Koordinaten" und fielen aus dem Umkreisfilter.

**Behoben** durch eine zweite Quelle: schlägt zippopotam fehl, fragt `geocode.js`
**Nominatim (OpenStreetMap)** — sequenziell, mit ≥ 1 s Abstand und
aussagekräftigem User-Agent (deren Nutzungsregeln). Danach: 57 von 57 verortet.
Als letzter Rückfall bleibt die 2-stellige PLZ-Region aus `geo-filter.js`
(markiert als `_geoApprox`).

Ein Nachbar-PLZ-Suchlauf wurde geprüft und **verworfen**: ganze Regionen sind
betroffen, nicht einzelne PLZ — von 23 Nachbarabfragen war genau eine brauchbar.

## Kleinanzeigen-Umkreis ohne Standort-ID

Ohne Ortsbezug sucht Kleinanzeigen **bundesweit**; im ersten Messlauf blieben
von 28 Treffern nur 2 im 200-km-Umkreis. Der Ortsteil im Pfad
(`/s-autos/krefeld/c216…`) wird **ignoriert** — gegengeprüft: identische Treffer
mit und ohne.

Wirksam sind dagegen die Query-Parameter **`locationStr` + `radius`**, und
`locationStr` nimmt **PLZ oder Ortsname**. An echten Antworten verifiziert: mit
`locationStr=47798&radius=200` verschiebt sich die PLZ-Verteilung der Treffer
deutlich in den Umkreis (50/51/41/56/54 statt 86/29/84/79). `bauSuchUrl()` setzt
die Parameter deshalb automatisch aus `params.plz` und `params.radiusKm`.

Ist zusätzlich `params.kleinanzeigenLocId` gesetzt, wird die genauere Pfadform
`c216l<id>r<radius>` verwendet. Die ID wird **nicht geraten** — sie steht in der
Adresszeile einer Kleinanzeigen-Ortssuche im Browser.

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
`WBW_ALLOW_PAID=1` nicht gesetzt ist. Ein eigener Test prüft genau diese Sperre,
damit sie nicht bei einem späteren Refactor still verschwindet.

**In diesem Repo ist sie bewusst gelöst:** `WBW_ALLOW_PAID=1` steht dauerhaft in
`.env` und in `.claude/settings.json`, weil der Betreiber die L3-Kosten als
unkritisch eingestuft hat. Ein Aufruf von `fetch-portal.js mobile.de` kostet damit
ohne weitere Rückfrage Geld. Die Testskripte in `package.json` setzen die Variable
weiterhin nirgends, und `npm test` führt ausschließlich Offline-Tests aus — ein
Testlauf kann also auch so keinen Actor starten.

## Umgebungsvariablen

Alle in der `.env` (gitignoriert), Vorlage in `.env.example`.
**`fetch-portal.js` liest die Datei selbst** — vom Arbeitsordner aus aufwärts bis
zur Plugin-Wurzel; die erste gefundene gewinnt. Ein Export von Hand ist nicht
nötig. Bereits gesetzte Umgebungsvariablen haben Vorrang, eine Datei überschreibt
also nie eine bewusst gesetzte Variable. Mit `WBW_ENV_DATEI` lässt sich ein
abweichender Pfad erzwingen. Welche Datei benutzt wurde, steht in der Ausgabe.

**Wer liest was — die Zuständigkeit ist strikt getrennt:**

| Variable | gelesen von | wofür |
| --- | --- | --- |
| `KA_API_BASE`, `KA_API_USER`, `KA_API_PASS` | `adapters/kleinanzeigen.js` | **nur** Kleinanzeigen (L1) |
| `APIFY_TOKEN` | `adapters/apify.js` | **nur** L3, also produktiv nur mobile.de |
| `BRIGHTDATA_TOKEN`, `BRIGHTDATA_ZONE` | `adapters/unlocker.js` | L2 (derzeit deaktiviert) |

Der Kleinanzeigen-Adapter berührt `APIFY_TOKEN` an keiner Stelle — er spricht
ausschließlich mit dem eigenen Dienst.


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
