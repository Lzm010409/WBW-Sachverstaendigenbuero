/**
 * E1 — Reine Funktionen, offline. Kein Netz, keine Kosten, unter einer Sekunde.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const SC = path.join(__dirname, "..", "skills", "wbw-vergleichsfahrzeuge", "scripts");
const g = require(path.join(SC, "adapters", "gemeinsam.js"));
const as24 = require(path.join(SC, "adapters", "autoscout24.js"));
const ka = require(path.join(SC, "adapters", "kleinanzeigen.js"));

test("zahl() — deutsche Zahlformate", () => {
  const faelle = [
    ["12.500 €", 12500, "Tausenderpunkt ist kein Dezimaltrenner"],
    ["12.500,50 €", 12500.5, "Komma ist Dezimaltrenner"],
    ["150.000 km", 150000, "Einheit muss weg"],
    ["110 kW (150 PS)", 110, "kW nehmen, nicht PS"],
    ["81 kW (110 PS)", 81, "kW nehmen, nicht PS"],
    ["0", 0, "0 ist ein gültiger Wert, nicht null"],
    [0, 0, "numerische 0 bleibt 0"],
    ["VB", null, "kein Preis"],
    ["Verhandlungsbasis", null, "kein Preis"],
    ["Auf Anfrage", null, "kein Preis"],
    ["Zu verschenken", null, "kein Preis"],
    ["", null, "leer"],
    [null, null, "null"],
    [undefined, null, "undefined"],
    [1250, 1250, "idempotent"],
    ["4,8 l/100 km", 4.8, "Dezimalkomma"],
    ["1.234.567", 1234567, "mehrere Tausendergruppen"],
    ["42.536 km", 42536, "Kleinanzeigen-Kilometerstand"],
  ];
  for (const [ein, soll, warum] of faelle) {
    assert.equal(g.zahl(ein), soll, `${JSON.stringify(ein)} -> erwartet ${soll} (${warum})`);
  }
});

test("zahl() — 0 km darf nicht zu null werden", () => {
  // Ein Neufahrzeug mit 0 km ist ein gültiger Vergleichsdatensatz.
  assert.equal(g.zahl("0 km"), 0);
  assert.notEqual(g.zahl("0 km"), null);
});

test("ez() — Erstzulassungsformate", () => {
  const faelle = [
    ["2019", "2019"],
    ["03/2019", "03/2019"],
    ["2019-03-01", "03/2019"],
    ["2019-03-01T00:00:00Z", "03/2019"],
    ["März 2019", "03/2019"],
    ["Oktober 2022", "10/2022"],
    ["01-2018", "01/2018"],
    ["06.2021", "06/2021"],
    ["", null],
    [null, null],
  ];
  for (const [ein, soll] of faelle) assert.equal(g.ez(ein), soll, JSON.stringify(ein));
});

test("ez() — implausible Jahre werden verworfen UND gemeldet", () => {
  const warn = [];
  assert.equal(g.ez("2049", warn), null, "EZ in der Zukunft verschiebt den WBW");
  assert.equal(warn.length, 1, "Verwerfen muss protokolliert werden");
  assert.equal(g.ez("1823"), null, "vor 1900 implausibel");
});

test("ausstattung() — Freitext und Liste", () => {
  assert.deepEqual(g.ausstattung("Alufelgen, Sitzheizung, Bluetooth"), ["Alufelgen", "Sitzheizung", "Bluetooth"]);
  assert.deepEqual(g.ausstattung(["ABS", "ABS", " ESP "]), ["ABS", "ESP"], "dedupliziert und trimmt");
  assert.deepEqual(g.ausstattung(null), []);
  assert.deepEqual(g.ausstattung(""), []);
});

test("plz() — PLZ aus Freitext", () => {
  assert.equal(g.plz("47179 Walsum"), "47179");
  assert.equal(g.plz("..., 40789 Monheim, DE"), "40789");
  assert.equal(g.plz("ohne Zahl"), null);
  assert.equal(g.plz(null), null);
});

test("dedupe() — über Seitengrenzen", () => {
  const r = g.dedupe([{ id: "a" }, { id: "b" }, { id: "a" }]);
  assert.equal(r.length, 2);
});

test("AutoScout24 bauSuchUrl() — vollständige Eingabe", () => {
  const u = as24.bauSuchUrl({
    autoScout: { make: "volkswagen", model: "golf", yearFrom: 2017, yearTo: 2019, mileageTo: 120000 },
    _abgeleitet: { plz: "47798", radius: 200, kmfrom: 70000 },
  });
  assert.ok(u.startsWith("https://www.autoscout24.de/lst/volkswagen/golf?"), u);
  for (const p of ["fregfrom=2017", "fregto=2019", "kmto=120000", "kmfrom=70000", "zip=47798", "zipr=200", "powertype=kw"]) {
    assert.ok(u.includes(p), `${p} fehlt in ${u}`);
  }
  assert.ok(!u.includes("page="), "Seite 1 ohne Seitenparameter");
  assert.ok(!u.includes("undefined"), "kein undefined in der URL");
});

test("AutoScout24 bauSuchUrl() — Optionalfelder entfallen statt undefined", () => {
  const u = as24.bauSuchUrl({ autoScout: { make: "bmw" }, _abgeleitet: {} });
  assert.ok(!u.includes("undefined"));
  assert.ok(!u.includes("fregfrom"), "fehlendes Jahr darf keinen Parameter erzeugen");
  assert.ok(!u.includes("zip="), "fehlende PLZ darf keinen Umkreis erzeugen");
  assert.equal(u.includes("/lst/bmw?"), true, u);
});

test("AutoScout24 bauSuchUrl() — Sonderzeichen und Paginierung", () => {
  const u = as24.bauSuchUrl({ autoScout: { make: "mercedes-benz", model: "C-Klasse" }, _abgeleitet: {} }, 3);
  assert.ok(u.includes("/lst/mercedes-benz/c-klasse"), u);
  assert.ok(u.includes("page=3"), u);
  const v = as24.bauSuchUrl({ autoScout: { make: "vw", model: "ID.4" }, _abgeleitet: {} });
  assert.ok(v.includes("/lst/vw/id.4"), v);
});

test("AutoScout24 bauSuchUrl() — leere Eingabe meldet klaren Fehler", () => {
  assert.throws(() => as24.bauSuchUrl({}), /keine Marke/i);
  assert.throws(() => as24.bauSuchUrl({ autoScout: {} }), /keine Marke/i);
});

test("AutoScout24 findeNextData()/findeListings() — robust", () => {
  assert.equal(as24.findeNextData("<html>ohne script</html>"), null);
  assert.equal(as24.findeNextData(""), null);
  assert.deepEqual(as24.findeListings(null), []);
  assert.deepEqual(as24.findeListings({}), []);
  assert.deepEqual(as24.findeListings({ props: { pageProps: { listings: "kaputt" } } }), []);
});

test("AutoScout24 mappe() — Kanten", () => {
  assert.equal(as24.mappe(null), null);
  assert.equal(as24.mappe("string statt objekt"), null);
  const leer = as24.mappe({});
  assert.equal(leer.preis, null, "fehlender Preis -> null, Objekt bleibt erhalten");
  assert.equal(leer.kilometerstand, null);
  assert.deepEqual(leer.ausstattung, []);
  assert.equal(leer.quelle, "autoscout24");
});

test("Kleinanzeigen bauSuchUrl() — Filter stehen im Pfad", () => {
  const u = ka.bauSuchUrl({
    kleinanzeigen: { car_make: "volkswagen", car_model: "golf", min_first_registration_year: 2017,
      max_first_registration_year: 2019, min_mileage: 70000, max_mileage: 120000 },
    _abgeleitet: {},
  });
  assert.equal(u, "https://www.kleinanzeigen.de/s-autos/c216+autos.marke_s:volkswagen+autos.model_s:golf+autos.ez_i:2017,2019+autos.km_i:70000,120000");
});

test("Kleinanzeigen bauSuchUrl() — ohne Standort-ID kein geratener Radius", () => {
  const u = ka.bauSuchUrl({ kleinanzeigen: { car_make: "audi" }, _abgeleitet: { radius: 200 } });
  assert.ok(!/l\d+r\d+/.test(u), `kein Radius ohne Standort-ID: ${u}`);
  const v = ka.bauSuchUrl({ kleinanzeigen: { car_make: "audi" }, _abgeleitet: { kleinanzeigenLocId: 3331, radius: 150 } });
  assert.ok(v.includes("c216l3331r150"), v);
});

test("Kleinanzeigen leistungKw() — PS wird umgerechnet, kW nicht", () => {
  assert.equal(ka.leistungKw("65 PS"), 48);
  assert.equal(ka.leistungKw("179 PS"), 132);
  assert.equal(ka.leistungKw("110 kW"), 110);
  assert.equal(ka.leistungKw(null), null);
  assert.equal(ka.leistungKw(""), null);
});

test("Kleinanzeigen findeItems()/mappe() — Kanten", () => {
  assert.deepEqual(ka.findeItems(null), []);
  assert.deepEqual(ka.findeItems({ results: "kaputt" }), []);
  assert.equal(ka.mappe(null, null), null);
  const ohneDetail = ka.mappe({ adid: "1", title: "T", location: "47798 Krefeld" }, null);
  assert.equal(ohneDetail.kilometerstand, null, "ohne Detail bleibt km leer — Eintrag wird NICHT verworfen");
  assert.equal(ohneDetail.plz, "47798", "PLZ aus dem Freitext der Kachel");
  assert.equal(ohneDetail.quelle, "kleinanzeigen");
});

test("Kleinanzeigen mappe() — features als Objekt statt Liste bricht nicht", () => {
  const f = ka.mappe({ adid: "1" }, { data: { features: {}, details: {} } });
  assert.deepEqual(f.ausstattung, []);
  const h = ka.mappe({ adid: "2" }, { data: { features: { a: "ABS", b: "ESP" }, details: {} } });
  assert.deepEqual(h.ausstattung, ["ABS", "ESP"]);
});
