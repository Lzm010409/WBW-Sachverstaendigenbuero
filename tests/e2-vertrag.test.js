/**
 * E2 — Vertragsprüfung gegen ECHTE, gespeicherte Portalantworten.
 * Läuft offline in Sekunden. Bricht, sobald ein Portal sein Format ändert und
 * jemand die Fixtures erneuert, ohne das Mapping nachzuziehen.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SC = path.join(__dirname, "..", "skills", "wbw-vergleichsfahrzeuge", "scripts");
const FIX = path.join(__dirname, "fixtures");
const as24 = require(path.join(SC, "adapters", "autoscout24.js"));
const ka = require(path.join(SC, "adapters", "kleinanzeigen.js"));
const lade = (n) => JSON.parse(fs.readFileSync(path.join(FIX, n), "utf8"));

const anteil = (arr, f) => arr.filter((x) => x[f] != null && x[f] !== "" && !(Array.isArray(x[f]) && !x[f].length)).length / arr.length;

test("AutoScout24 — findeNextData() findet das JSON in echtem HTML", () => {
  const html = fs.readFileSync(path.join(FIX, "autoscout24-huelle.html"), "utf8");
  const next = as24.findeNextData(html);
  assert.ok(next, "__NEXT_DATA__ nicht gefunden");
  assert.equal(as24.findeListings(next).length, 1);
  assert.ok(as24.gesamtTreffer(next) > 0);
});

test("AutoScout24 — Fixture liefert die erwartete Struktur", () => {
  const fx = lade("autoscout24-suchseite.json");
  const ls = as24.findeListings(fx);
  assert.ok(ls.length >= 5, `zu wenige Inserate in der Fixture: ${ls.length}`);
  for (const l of ls) {
    assert.ok(l.id, "jedes Inserat braucht eine id");
    assert.ok(l.price && typeof l.price.priceRaw === "number", "price.priceRaw fehlt — Portal-Format geändert?");
    assert.ok(l.vehicle, "vehicle fehlt");
    assert.ok(Array.isArray(l.vehicleDetails), "vehicleDetails fehlt");
  }
});

test("AutoScout24 — mappe() füllt die Pflichtfelder aus der echten Antwort", () => {
  const ls = as24.findeListings(lade("autoscout24-suchseite.json"));
  const items = ls.map((l) => as24.mappe(l)).filter(Boolean);
  assert.equal(items.length, ls.length);
  assert.equal(anteil(items, "preis"), 1, "Preis muss in der Fixture zu 100 % gefüllt sein");
  assert.equal(anteil(items, "kilometerstand"), 1, "Kilometerstand muss zu 100 % gefüllt sein");
  assert.equal(anteil(items, "erstzulassung"), 1, "Erstzulassung muss zu 100 % gefüllt sein");
  assert.equal(anteil(items, "plz"), 1, "PLZ muss zu 100 % gefüllt sein (Geo-Filter braucht sie)");
  assert.ok(anteil(items, "leistungKw") >= 0.8, "Leistung");
  for (const i of items) {
    assert.match(i.url, /^https:\/\/www\.autoscout24\.de\//, "URL muss absolut sein");
    assert.ok(Number.isFinite(i.preis) && i.preis > 0);
    assert.ok(Number.isFinite(i.kilometerstand) && i.kilometerstand >= 0);
    assert.match(i.erstzulassung, /^(\d{2}\/)?\d{4}$/, `EZ-Format: ${i.erstzulassung}`);
    assert.equal(i.quelle, "autoscout24");
  }
});

test("AutoScout24 — Leistung wird als kW gelesen, nicht als PS", () => {
  const ls = as24.findeListings(lade("autoscout24-suchseite.json"));
  for (const l of ls) {
    const d = (l.vehicleDetails || []).find((x) => x.ariaLabel === "Leistung");
    if (!d) continue;
    const kw = Number(String(d.data).match(/(\d+)\s*kW/i)[1]);
    assert.equal(as24.mappe(l).leistungKw, kw, `aus "${d.data}" muss ${kw} kW werden`);
  }
});

test("AutoScout24 — die Liste enthält bewusst KEINE Koordinaten", () => {
  // Festgehalten als Vertrag: ändert AutoScout24 das, fällt es hier auf und
  // das Geocoding über die PLZ kann entfallen.
  const ls = as24.findeListings(lade("autoscout24-suchseite.json"));
  const s = JSON.stringify(ls);
  for (const t of ["latitude", "longitude", "coordinates"]) {
    assert.ok(!s.includes(t), `unerwartet: ${t} ist jetzt in der Trefferliste`);
  }
  assert.equal(as24.mappe(ls[0]).lat, null);
});

test("Kleinanzeigen — Trefferliste hat die erwarteten Schlüssel", () => {
  const liste = lade("kleinanzeigen-liste.json");
  assert.equal(liste.success, true);
  const items = ka.findeItems(liste);
  assert.ok(items.length > 0);
  for (const i of items) {
    for (const k of ["adid", "url", "title", "price", "location", "description", "published_at"]) {
      assert.ok(k in i, `Schlüssel ${k} fehlt in results[]`);
    }
  }
});

test("Kleinanzeigen — die Trefferliste liefert weder km noch EZ (Detail ist Pflicht)", () => {
  const items = ka.findeItems(lade("kleinanzeigen-liste.json"));
  const s = JSON.stringify(items);
  assert.ok(!s.includes("Kilometerstand"), "unerwartet: km jetzt in der Liste");
  assert.ok(!s.includes("Erstzulassung"), "unerwartet: EZ jetzt in der Liste");
  const nurListe = ka.mappe(items[0], null);
  assert.equal(nurListe.kilometerstand, null);
  assert.equal(nurListe.erstzulassung, null);
});

test("Kleinanzeigen — Detailantwort trägt die erwarteten details-Labels", () => {
  const dets = lade("kleinanzeigen-detail.json");
  assert.ok(dets.length >= 2);
  for (const d of dets) {
    assert.equal(d.success, true);
    const det = d.data.details;
    for (const label of ["Kilometerstand", "Erstzulassung", "Leistung", "Getriebe", "Kraftstoffart", "Fahrzeugtyp"]) {
      assert.ok(label in det, `Label "${label}" fehlt — Kleinanzeigen hat die Detailseite geändert`);
    }
    assert.ok(d.data.price && d.data.price.amount, "price.amount fehlt");
    assert.ok(d.data.location && d.data.location.zip, "location.zip fehlt");
  }
});

test("Kleinanzeigen — mappe() mit Detail füllt alle Pflichtfelder", () => {
  const liste = ka.findeItems(lade("kleinanzeigen-liste.json"));
  const dets = lade("kleinanzeigen-detail.json");
  const items = dets.map((d) => {
    const e = liste.find((x) => String(x.adid) === String(d.data.id)) || { adid: d.data.id, url: d.data.url_requested };
    return ka.mappe(e, d);
  });
  assert.equal(anteil(items, "preis"), 1);
  assert.equal(anteil(items, "kilometerstand"), 1);
  assert.equal(anteil(items, "erstzulassung"), 1);
  assert.equal(anteil(items, "leistungKw"), 1);
  assert.equal(anteil(items, "plz"), 1);
  assert.equal(anteil(items, "fahrzeugtyp"), 1);
  for (const i of items) {
    assert.match(i.erstzulassung, /^\d{2}\/\d{4}$/, `EZ aus deutschem Monatsnamen: ${i.erstzulassung}`);
    assert.ok(i.leistungKw < 400, "Leistung muss kW sein, nicht PS");
    assert.equal(i.lat, null, "Kleinanzeigen liefert keine Koordinaten");
    assert.ok(Array.isArray(i.ausstattung));
  }
});

test("Kleinanzeigen — konkrete Werte aus der echten Antwort", () => {
  const dets = lade("kleinanzeigen-detail.json");
  const up = dets.find((d) => d.data.details["Modell"] === "up!");
  const f = ka.mappe({ adid: up.data.id }, up);
  assert.equal(f.kilometerstand, 42536, 'aus "42.536 km"');
  assert.equal(f.erstzulassung, "10/2022", 'aus "Oktober 2022"');
  assert.equal(f.leistungKw, 48, 'aus "65 PS"');
  assert.equal(f.preis, 10500);
  assert.equal(f.getriebe, "Manuell");
  assert.equal(f.fahrzeugtyp, "Kleinwagen");
  assert.equal(f.tueren, "2/3");
});

test("mobile.de — der Befund ist als Fixture hinterlegt", () => {
  const b = lade("mobilede-akamai-block.json");
  assert.equal(b.schlankerHeadersatz.status, 403);
  assert.equal(b.schlankerHeadersatz.server, "AkamaiGHost");
  assert.ok(b.vollerBrowserHeadersatz.rumpf.includes("Challenge"));
});

test("Fixtures enthalten keine Verkäufer-Klardaten", () => {
  for (const n of fs.readdirSync(FIX)) {
    const s = fs.readFileSync(path.join(FIX, n), "utf8");
    assert.ok(!/\+49\s*\(0\)/.test(s), `Telefonnummer in ${n}`);
    assert.ok(!/"contactName"/.test(s), `contactName in ${n}`);
    assert.ok(!/"companyName"/.test(s), `companyName in ${n}`);
  }
});
