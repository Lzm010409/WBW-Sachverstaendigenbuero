# Portal-Suche: Apify-Actors & Such-Eingaben

Die Such-Eingaben werden **deterministisch** von `scripts/build-search-urls.js` aus
`params.json` erzeugt (→ `search-inputs.json`). Claude baut keine URLs „frei Hand".
Diese Datei dokumentiert, wie die Eingaben zustande kommen und was bei Sonderfällen
zu beachten ist.

## Actor-Eingaben im Überblick

| Portal        | Actor                                  | Eingabeart                         |
| ------------- | -------------------------------------- | ---------------------------------- |
| mobile.de     | `blackfalcondata/mobile-de-scraper`    | strukturiert (`query`/`make`/`model`, `yearMin/Max`, `mileageMin/Max`, **`zipCode`+`radiusKm`**, `includeDetails`) |
| AutoScout24   | `blackfalcondata/autoscout24-scraper`  | strukturiert (`make`/`model`-Slug, `countries`, `yearFrom/To`, `mileageTo`, `includeDetails`) |
| Kleinanzeigen | `fatihtahta/ebay-kleinanzeigen-scraper` | strukturiert (`car_make`/`car_model`, `category:"216"`, `min/max_first_registration_year`, `min/max_mileage`, `enrich_data`) |

Alle drei sind **Pay-per-Event**. mobile.de & AutoScout24 (beide `blackfalcondata`)
liefern ein **flaches, numerisches Schema mit GPS-Koordinaten** (`sellerLatitude`/`-Longitude`
bzw. `latitude`/`longitude`), `mileageKm`, `powerKw`, `price`, `equipment`/`features`,
`images` — **kein Geocoding, kein String-Parsing** nötig.

## Filter-Ableitung (für alle Portale)

| Filter      | Ableitung aus `params.json`                       |
| ----------- | ------------------------------------------------- |
| EZ-Jahre    | `Jahr(EZ) − ezToleranzJahre` … `Jahr(EZ) + ezToleranzJahre` (Default ±1) |
| km-Spanne   | `Laufleistung − kmToleranz` … `+ kmToleranz` (Default ±25.000) |
| Umkreis     | `plz` + `radiusKm` (Default 200)                  |
| Marke/Modell| `subject.marke` / `subject.modell`; Variante als Suchbegriff |

Die harten Toleranzen werden in `pipeline.js` **zusätzlich** nachgefiltert — die
Portal-Filter dienen v. a. der Mengen-/Kostenbegrenzung (Pay-per-Result).

## mobile.de — `blackfalcondata/mobile-de-scraper`

Strukturierte Eingabe mit **nativem PLZ-Umkreis** (`zipCode` + `radiusKm`) → die Suche
ist bereits regional eingegrenzt. `query` (Freitext „Marke Modell") + `category:"CAR"` +
`yearMin/Max`, `mileageMin/Max`. **`includeDetails:true`** liefert Ausstattung,
Beschreibung und GPS (`sellerLatitude`/`sellerLongitude`). Echtlauf bestätigt: Treffer
lagen tatsächlich im Umkreis (z. B. Moers ~15 km bei Zentrum 47798).

## AutoScout24 — `blackfalcondata/autoscout24-scraper`

Strukturierte Eingabe: `make`/`model` als URL-Slug (`volkswagen`/`tiguan`),
`countries:["DE"]`, `yearFrom/To`, `mileageTo`, **`includeDetails:true`** (→ Ausstattung +
`latitude`/`longitude`). `MARKEN_SLUG`/`modellSlug` erzeugen die Slugs; **Sonderfälle**
(z. B. „3er", „A-Klasse") ggf. `subject.modell` anpassen.

> **Kein PLZ-Umkreis** an diesem Actor → die Suche ist **bundesweit (DE)**; der Umkreis
> wird über die mitgelieferten GPS-Koordinaten in `pipeline.js` gefiltert. Liegen zu
> wenige Treffer im Umkreis, `maxItemsProPortal` erhöhen (Kosten sind gering).

## Geocoding (`geocode.js`) — meist No-op

Seit der Umstellung liefern mobile.de & AutoScout24 echte Koordinaten, daher ist der
Geocoding-Schritt i. d. R. wirkungslos (0/0). Er bleibt als **Sicherheitsnetz**: füllt
Koordinaten aus einer PLZ nach (zippopotam.us, Plausibilitätscheck + Rückfall auf die
2-stellige PLZ-Region), falls ein Actor doch einmal nur eine PLZ liefert.

## Kleinanzeigen — `fatihtahta/ebay-kleinanzeigen-scraper`

Auto-spezifisch und strukturiert: `car_make` (Enum), `car_model`, `category:"216"`,
`min/max_first_registration_year`, `min/max_mileage`, `enrich_data:true`. Mit
`enrich_data` liefert der Actor km, EZ, Leistung, Fahrzeugtyp, **PLZ + GPS-Koordinaten
(`location.latitude/longitude`)**, Ausstattung und Bilder — damit fließt Kleinanzeigen
wie die anderen Portale in den Korb.

Zwei Formatbesonderheiten (in `normalize.js` behandelt): die EZ kommt als **deutscher
Monatsname** (z. B. „Mai 2024"), die Leistung in **PS** (wird nach kW umgerechnet). Die
verschachtelte Datenstruktur (`product.attributes.*`, `location.*`, `pricing.*`,
`media.*`) wird über Punkt-Pfade gelesen. Kein PLZ-Umkreis am Actor → bundesweit, der
Umkreis kommt über die GPS-Koordinaten im Geo-Filter.

## Datenqualität je Portal

- **Alle drei Portale**: liefern jetzt strukturierte Felder (km, EZ, Leistung,
  Ausstattung) **inkl. GPS-Koordinaten** → tragen alle zum Vergleichskorb bei.
- **Kleinanzeigen**: oft Freitext, häufig ohne Koordinaten/strukturierte Ausstattung
  → Ausstattungsabgleich überwiegend über `description`.
