# Gemeinsames Datenschema & Feld-Mapping

`build-input.js` ruft `normalize.js` auf und bildet die Portal-Rohdaten auf dieses
Schema ab (an mobile.de angelehnt, weil die mitgelieferten Module es so erwarten):

```js
{
  id, source, url, title, model,
  price: { total: { amount: <number> } },
  attributes: {
    Mileage: <number>,
    "First Registration": <"MM/YYYY" | "YYYY">,
    Power: <number kW>,
    Climatisation: <string>          // z.B. "Automatic climatisation, 3 zones"
  },
  mileage, ez, _ezYear, power,        // flache Bequemlichkeitsfelder
  climatisation,
  features: [<string>, ...],          // Ausstattungsliste (DE/EN gemischt möglich)
  description: <string>,              // Freitext
  zip: <string|null>,
  dealerDetails: { location: { latitude: <number|null>, longitude: <number|null> } }
}
```

## Welches Modul liest was

| Modul                  | gelesene Felder                                                        |
| ---------------------- | --------------------------------------------------------------------- |
| `geo-filter.js`        | `dealerDetails.location.{latitude,longitude}`                         |
| `pipeline.js` (Tol.)   | `attributes.Mileage`/`mileage`, `_ezYear`/`ez`                       |
| `dedup-fahrzeuge.js`   | `model`/`title`, `price.total.amount`, `Mileage`, `First Registration`, `Power` |
| `ausstattung-matcher`  | `features[]`, `description`, `attributes.Climatisation`              |
| `wbw-vorschlag.js`     | `price.total.amount`, `Mileage`, `_ezYear`                          |
| `generate-report.js`   | alle obigen + `url`, `source`                                        |

## Mapping anpassen (nach echtem Lauf)

Sind nach einem realen Scrape Preise, km, Features oder Koordinaten leer, stimmen die
Feldnamen des Actors nicht mit den Kandidatenlisten überein. Dann in
`scripts/normalize.js` in `normalizeOne()` die passende `pick([...])`-Liste um den
tatsächlichen Feldnamen **ergänzen** (nichts entfernen — die Listen gelten für alle
drei Portale gemeinsam).

Schnell-Diagnose: einen einzelnen Rohdatensatz ansehen
(`node -e "console.log(Object.keys(require('./raw-mobile.json')[0]))"`) und die
relevanten Schlüssel mit den Kandidatenlisten abgleichen.

## Klimaautomatik (Sonderfall)

Wird **nicht** per Muster im Freitext bestimmt, sondern aus dem strukturierten
`Climatisation`-Feld: enthält es `automat`, `klimaautomatik` oder `zone(s)` (und nicht
`man.`/`manuell`) → vorhanden. Liefert ein Portal kein solches Feld, sondern nur
Freitext, kann „Klimaautomatik" als Soll-Merkmal dort unentdeckt bleiben — im Report
erscheint dann „–" oder „?" in der Matrix.

## EZ-Parsing

`ezToYear()` wandelt `"06/2021"` → `2021.42` (Jahr + (Monat−1)/12). Erkennt
`MM/YYYY`, `MM.YYYY` und reine Jahreszahlen. Liefert ein Portal die EZ in einem
anderen Format, das Format dort ggf. ergänzen.
