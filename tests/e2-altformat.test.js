/**
 * E2b — Regression: die Apify-ROHFORMATE müssen weiterhin fehlerfrei
 * normalisieren. Die Adapterschicht hat Kandidatenlisten nur ERGÄNZT;
 * dieser Test hält fest, dass dabei nichts kaputtgegangen ist.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SC = path.join(__dirname, "..", "skills", "wbw-vergleichsfahrzeuge", "scripts");
const { normalizeAll } = require(path.join(SC, "normalize.js"));
const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "apify-altformat.json"), "utf8")).daten;

test("Apify-Altformat mobile.de normalisiert unverändert", () => {
  const [f] = normalizeAll({ "mobile.de": FIX["mobile.de"] });
  assert.equal(f.source, "mobile.de");
  assert.equal(f.price.total.amount, 18900);
  assert.equal(f.attributes.Mileage, 95000, '"95.000 km" -> 95000');
  assert.equal(f.attributes["First Registration"], "06/2018");
  assert.equal(f._ezYear, 2018 + 5 / 12);
  assert.equal(f.power, 110, '"110 kW (150 PS)" -> 110, nicht 150');
  assert.equal(f.zip, "47798");
  assert.equal(f.dealerDetails.location.latitude, 51.33);
  assert.equal(f.getriebe, "Automatik");
  assert.equal(f.bodyType, "Limousine");
  assert.equal(f.tueren, 5);
  assert.deepEqual(f.features, ["Navigationssystem", "Sitzheizung"]);
  assert.match(f.images[0], /^https:\/\/img\.classistatic\.de\//, "yams-proxy muss aufgelöst werden");
});

test("Apify-Altformat AutoScout24 normalisiert unverändert", () => {
  const [f] = normalizeAll({ autoscout24: FIX.autoscout24 });
  assert.equal(f.price.total.amount, 16490);
  assert.equal(f.attributes.Mileage, 78500);
  assert.equal(f.attributes["First Registration"], "2019-04-01");
  assert.equal(f.power, 96);
  assert.equal(f.zip, "40213");
  assert.equal(f.dealerDetails.location.longitude, 6.77);
  assert.match(f.images[0], /\.jpg$/, "webp muss auf jpg umgeschrieben werden");
});

test("Apify-Altformat Kleinanzeigen normalisiert unverändert", () => {
  const [f] = normalizeAll({ kleinanzeigen: FIX.kleinanzeigen });
  assert.equal(f.price.total.amount, 18900);
  assert.equal(f.attributes.Mileage, 99132);
  assert.equal(f.attributes["First Registration"], "Juni 2017");
  assert.equal(f._ezYear, 2017 + 5 / 12, "deutscher Monatsname muss erkannt werden");
  assert.equal(f.power, 132, '"179 PS" -> 132 kW');
  assert.equal(f.zip, "82383");
  assert.equal(f.dealerDetails.location.latitude, null, "Kleinanzeigen liefert kein GPS");
  assert.equal(f.bodyType, "SUV/Geländewagen");
  assert.equal(f.tueren, "4/5");
});

test("Kanonische Adapter-Feldnamen normalisieren ebenfalls", () => {
  const adapterSatz = {
    id: "x1", quelle: "autoscout24", url: "https://www.autoscout24.de/angebote/x",
    titel: "VW Golf", variante: "Life", preis: 12450, kilometerstand: 71655,
    erstzulassung: "04/2019", leistungKw: 85, getriebe: "Schaltgetriebe",
    kraftstoff: "Benzin", fahrzeugtyp: null, tueren: null, plz: "49477", ort: "Ibbenbüren",
    lat: null, lon: null, ausstattung: ["Sitzheizung"], bilder: ["https://x/y.jpg"],
    beschreibung: "Text",
  };
  const [f] = normalizeAll({ autoscout24: [adapterSatz] });
  assert.equal(f.price.total.amount, 12450);
  assert.equal(f.attributes.Mileage, 71655);
  assert.equal(f.attributes["First Registration"], "04/2019");
  assert.equal(f.power, 85);
  assert.equal(f.zip, "49477");
  assert.equal(f.title, "VW Golf");
  assert.deepEqual(f.features, ["Sitzheizung"]);
  assert.equal(f.images.length, 1);
});

test("Alt- und Neuformat dürfen sich nicht gegenseitig stören", () => {
  // Beides im selben Lauf: die Reihenfolge der Kandidatenlisten muss halten.
  const gemischt = normalizeAll({
    "mobile.de": FIX["mobile.de"],
    autoscout24: [{ id: "neu", preis: 9999, kilometerstand: 12345, erstzulassung: "01/2020" }],
  });
  assert.equal(gemischt.length, 2);
  assert.equal(gemischt[0].price.total.amount, 18900);
  assert.equal(gemischt[1].price.total.amount, 9999);
});
