/**
 * E1 — Modellauflösung und Bauart-/Linienerkennung.
 *
 * Hintergrund: AutoScout24 antwortet auf einen unbekannten Modellnamen NICHT mit
 * 404, sondern liefert stillschweigend alle Modelle der Marke. "Golf VII" ergab
 * so 40 Treffer quer durch Tiguan, Caddy und T6 — ein Vergleichskorb, der im
 * Gutachten nichts taugt und dem man das nicht ansieht.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SC = path.join(__dirname, "..", "skills", "wbw-vergleichsfahrzeuge", "scripts");
const as24 = require(path.join(SC, "adapters", "autoscout24.js"));
const { detectKarosserie, detectLinie } = require(path.join(SC, "ausstattung-matcher.js"));
const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "autoscout24-suchseite.json"), "utf8"));

test("findeModelle() liest die Modellliste des Portals aus der echten Antwort", () => {
  const m = as24.findeModelle(FIX);
  assert.ok(m.length > 50, `zu wenige Modelle: ${m.length}`);
  for (const erwartet of ["Golf", "Golf Variant", "Golf Sportsvan", "Passat", "Tiguan"]) {
    assert.ok(m.includes(erwartet), `"${erwartet}" fehlt in der Modellliste`);
  }
  assert.deepEqual(as24.findeModelle(null), []);
  assert.deepEqual(as24.findeModelle({}), []);
});

test("aufloeseModell() erkennt gültige Modelle unverändert", () => {
  const m = as24.findeModelle(FIX);
  for (const n of ["Golf", "Golf Variant", "Golf Sportsvan", "Passat Variant"]) {
    const r = as24.aufloeseModell(n, m);
    assert.ok(r, `${n} sollte auflösen`);
    assert.equal(r.label, n);
    assert.equal(r.korrigiert, false, `${n} darf nicht "korrigiert" heissen`);
  }
  assert.equal(as24.aufloeseModell("golf", m).label, "Golf", "Gross-/Kleinschreibung egal");
  assert.equal(as24.aufloeseModell("GOLF VARIANT", m).label, "Golf Variant");
});

test("aufloeseModell() schneidet NUR eine Generationsangabe ab — und nur bei echtem Treffer", () => {
  const m = as24.findeModelle(FIX);
  for (const [ein, soll] of [["Golf VII", "Golf"], ["Golf 7", "Golf"], ["Golf Mk7", "Golf"],
                             ["Golf VII Variant", "Golf Variant"]]) {
    const r = as24.aufloeseModell(ein, m);
    assert.ok(r, `${ein} sollte auflösen`);
    assert.equal(r.label, soll);
    assert.equal(r.korrigiert, true, "die Korrektur muss als solche gemeldet werden");
  }
  // Nichts erfinden, wenn der bereinigte Name kein echtes Modell ist.
  assert.equal(as24.aufloeseModell("Quatschmodell", m), null);
  assert.equal(as24.aufloeseModell("Passat B8", m), null, "B8 ist keine erkannte Generationsangabe");
  assert.equal(as24.aufloeseModell("", m), null);
  assert.equal(as24.aufloeseModell("Golf", []), null, "ohne Modellliste keine Auflösung");
});

test("aufloeseModell() zerstört keine Modellnamen, die auf eine Zahl enden", () => {
  // "A4", "Mazda 3", "500" sind Modellnamen, keine Generationsangaben.
  const modelle = ["A4", "A4 Avant", "3", "500", "500X", "911"];
  for (const n of modelle) {
    const r = as24.aufloeseModell(n, modelle);
    assert.ok(r && r.label === n && !r.korrigiert, `${n} muss unverändert auflösen`);
  }
});

test("modellVorschlaege() nennt die passenden echten Modellnamen", () => {
  const m = as24.findeModelle(FIX);
  const v = as24.modellVorschlaege("Golf VII", m);
  assert.ok(v.includes("Golf"));
  assert.ok(v.includes("Golf Variant"));
  assert.ok(!v.includes("Passat"), "nur Vorschläge zum gesuchten Modell");
  assert.deepEqual(as24.modellVorschlaege("Quatsch", m), []);
});

test("modellAnteil() misst, ob der Modellfilter überhaupt gegriffen hat", () => {
  const ls = (...modelle) => modelle.map((model) => ({ vehicle: { model } }));
  assert.equal(as24.modellAnteil(ls("Golf", "Golf", "Golf"), "Golf"), 1);
  assert.equal(as24.modellAnteil(ls("Golf", "Tiguan", "Caddy", "T6"), "Golf"), 0.25);
  assert.equal(as24.modellAnteil(ls("Golf Variant", "Golf Variant"), "Golf"), 1, "Untermodelle zählen mit");
  assert.equal(as24.modellAnteil([], "Golf"), 1, "ohne Treffer keine Aussage");
  assert.equal(as24.modellAnteil(ls("Golf"), ""), 1, "ohne Modellwunsch keine Prüfung");
});

test("Bauart wird auch ohne Bauart-Feld aus dem Titel erkannt", () => {
  // AutoScout24 liefert KEIN Bauart-Feld. Ohne diese Begriffe rutschte ein
  // Golf Sportsvan in eine Kombi-Suche.
  const faelle = [
    ["Volkswagen Golf Variant 1.0 TSI Navi", "Kombi"],
    ["Volkswagen Golf VII Lim. Trendline BMT", "Limousine"],
    ["Volkswagen Golf Sportsvan Sound BMT", "Van"],
    ["Skoda Octavia Combi", "Kombi"],
    ["Mercedes C 220 T-Modell", "Kombi"],
    ["Opel Astra Sports Tourer", "Kombi"],
    ["Audi A4 Avant", "Kombi"],
    ["BMW 320d Touring", "Kombi"],
    ["Fiat Tipo Kombi Diesel", "Kombi"],
    ["VW Touran Comfortline", "Van"],
  ];
  for (const [titel, soll] of faelle) {
    assert.equal(detectKarosserie(titel), soll, `"${titel}" -> erwartet ${soll}`);
  }
});

test("Bekannte Ausstattungslinien werden erkannt", () => {
  for (const [titel, soll] of [
    ["Fiat Tipo 1.6 MultiJet LOUNGE DCT", "Lounge"],
    ["Fiat Tipo City Cross", "City Cross"],
    ["Golf Highline", "Highline"],
    ["Tiguan R-Line", "R-Line"],
    ["Golf 1.5 TSI Life", "Life"],
  ]) {
    assert.equal(detectLinie(titel), soll, `"${titel}" -> erwartet ${soll}`);
  }
});
