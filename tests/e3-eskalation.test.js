/**
 * E3 — Eskalationslogik mit Fehlerinjektion.
 * Testet den Dispatcher gegen ERFUNDENE Adapter, nicht gegen echte Portale:
 * schnell, deterministisch, kostenlos.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const SC = path.join(__dirname, "..", "skills", "wbw-vergleichsfahrzeuge", "scripts");
const { beschaffe } = require(path.join(SC, "fetch-portal.js"));

const EINGABEN = { testInput: { marke: "VW" } };

/** Baut eine providers-Konfiguration mit frei wählbaren Stufen. */
function konf(stufen) {
  return { portale: { testportal: { inputKey: "testInput", stufen } } };
}

/** Erfundener Adapter mit Aufrufzähler. */
function fake(verhalten) {
  const zaehler = { aufrufe: 0 };
  const mod = {
    async holen() {
      zaehler.aufrufe++;
      if (typeof verhalten === "function") return verhalten();
      return verhalten;
    },
  };
  return { lader: () => mod, zaehler };
}

test("L0 wirft -> L1 übernimmt, Protokoll zeigt beide", async () => {
  const a = fake(() => { throw new Error("L0 kaputt"); });
  const b = fake({ items: [{ id: "1" }], protokoll: {} });
  const r = await beschaffe("testportal", EINGABEN, {
    providers: konf([{ id: "L0", adapter: "a", enabled: true }, { id: "L1", adapter: "b", enabled: true }]),
    adapterMap: { a: a.lader, b: b.lader },
  });
  assert.equal(r.items.length, 1);
  assert.equal(r.beschaffungsprotokoll.getrageneStufe, "L1");
  const v = r.beschaffungsprotokoll.versuche;
  assert.equal(v.length, 2, "beide Stufen müssen im Protokoll stehen");
  assert.equal(v[0].ergebnis, "fehler");
  assert.match(v[0].fehler, /L0 kaputt/);
  assert.equal(v[1].ergebnis, "erfolg");
});

test("L0 liefert leeres Array -> nächste Stufe wird versucht (leer ist kein Erfolg)", async () => {
  const a = fake({ items: [], protokoll: {} });
  const b = fake({ items: [{ id: "1" }, { id: "2" }], protokoll: {} });
  const r = await beschaffe("testportal", EINGABEN, {
    providers: konf([{ id: "L0", adapter: "a", enabled: true }, { id: "L3", adapter: "b", enabled: true }]),
    adapterMap: { a: a.lader, b: b.lader },
  });
  assert.equal(a.zaehler.aufrufe, 1);
  assert.equal(b.zaehler.aufrufe, 1, "leeres Ergebnis muss eskalieren");
  assert.equal(r.beschaffungsprotokoll.getrageneStufe, "L3");
  assert.equal(r.beschaffungsprotokoll.versuche[0].ergebnis, "leer");
});

test("L0 liefert Treffer -> spätere Stufen werden NICHT aufgerufen (Kosten!)", async () => {
  const a = fake({ items: [{ id: "1" }], protokoll: {} });
  const teuer = fake(() => { throw new Error("diese Stufe hätte Geld gekostet"); });
  const r = await beschaffe("testportal", EINGABEN, {
    providers: konf([
      { id: "L0", adapter: "a", enabled: true },
      { id: "L3", adapter: "teuer", enabled: true, kostenpflichtig: true },
    ]),
    adapterMap: { a: a.lader, teuer: teuer.lader },
  });
  assert.equal(a.zaehler.aufrufe, 1);
  assert.equal(teuer.zaehler.aufrufe, 0, "die kostenpflichtige Stufe darf nicht angefasst werden");
  assert.equal(r.beschaffungsprotokoll.getrageneStufe, "L0");
  assert.equal(r.beschaffungsprotokoll.versuche.length, 1, "nach Erfolg wird abgebrochen");
});

test("alle Stufen scheitern -> leere items, vollständiges Protokoll, kein Absturz", async () => {
  const a = fake(() => { throw new Error("A weg"); });
  const b = fake(() => { throw new Error("B weg"); });
  const r = await beschaffe("testportal", EINGABEN, {
    providers: konf([{ id: "L0", adapter: "a", enabled: true }, { id: "L3", adapter: "b", enabled: true }]),
    adapterMap: { a: a.lader, b: b.lader },
  });
  assert.deepEqual(r.items, []);
  assert.equal(r.beschaffungsprotokoll.getrageneStufe, null);
  assert.equal(r.beschaffungsprotokoll.versuche.length, 2);
  assert.ok(r.beschaffungsprotokoll.beginn && r.beschaffungsprotokoll.ende);
});

test("enabled:false überspringt sauber und wird protokolliert", async () => {
  const aus = fake({ items: [{ id: "x" }], protokoll: {} });
  const an = fake({ items: [{ id: "y" }], protokoll: {} });
  const r = await beschaffe("testportal", EINGABEN, {
    providers: konf([
      { id: "L0", adapter: "aus", enabled: false, grund: "Portal blockt" },
      { id: "L3", adapter: "an", enabled: true },
    ]),
    adapterMap: { aus: aus.lader, an: an.lader },
  });
  assert.equal(aus.zaehler.aufrufe, 0, "deaktivierte Stufe darf nicht laufen");
  assert.equal(r.beschaffungsprotokoll.versuche[0].ergebnis, "uebersprungen");
  assert.equal(r.beschaffungsprotokoll.versuche[0].grund, "Portal blockt");
  assert.equal(r.items[0].id, "y");
});

test("Zeitgrenze greift und blockiert nicht endlos", async () => {
  const haenger = { lader: () => ({ holen: () => new Promise(() => {}) }) };  // löst nie auf
  const rettung = fake({ items: [{ id: "z" }], protokoll: {} });
  const t0 = Date.now();
  const r = await beschaffe("testportal", EINGABEN, {
    providers: konf([{ id: "L0", adapter: "h", enabled: true }, { id: "L3", adapter: "r", enabled: true }]),
    adapterMap: { h: haenger.lader, r: rettung.lader },
    stufenZeitgrenzeMs: 300,
  });
  const dauer = Date.now() - t0;
  assert.ok(dauer < 5000, `Zeitgrenze hat nicht gegriffen (${dauer} ms)`);
  assert.equal(r.beschaffungsprotokoll.versuche[0].code, "ZEITGRENZE");
  assert.equal(r.items[0].id, "z", "nach Zeitgrenze wird eskaliert");
});

test("unbekanntes Portal -> klare Meldung", async () => {
  await assert.rejects(
    () => beschaffe("gibtsnicht", EINGABEN, { providers: konf([]) }),
    (e) => e.code === "UNBEKANNTES_PORTAL" && /Unbekanntes Portal/.test(e.message)
  );
});

test("fehlender Eingabeblock -> klare Meldung", async () => {
  await assert.rejects(
    () => beschaffe("testportal", {}, { providers: konf([{ id: "L0", adapter: "a", enabled: true }]) }),
    (e) => e.code === "EINGABEBLOCK_FEHLT" && /testInput/.test(e.message)
  );
});

test("unbekannter Adapter scheitert als Stufe, nicht als Absturz", async () => {
  const b = fake({ items: [{ id: "1" }], protokoll: {} });
  const r = await beschaffe("testportal", EINGABEN, {
    providers: konf([{ id: "L0", adapter: "existiert-nicht", enabled: true }, { id: "L3", adapter: "b", enabled: true }]),
    adapterMap: { b: b.lader },
  });
  assert.match(r.beschaffungsprotokoll.versuche[0].fehler, /Unbekannter Adapter/);
  assert.equal(r.beschaffungsprotokoll.getrageneStufe, "L3");
});

test("Protokoll trägt Zeitstempel und Dauer je Stufe", async () => {
  const a = fake({ items: [{ id: "1" }], protokoll: { abrufe: [] } });
  const r = await beschaffe("testportal", EINGABEN, {
    providers: konf([{ id: "L0", adapter: "a", enabled: true }]),
    adapterMap: { a: a.lader },
  });
  const v = r.beschaffungsprotokoll.versuche[0];
  assert.ok(typeof v.ms === "number");
  assert.match(v.zeitpunkt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(r.beschaffungsprotokoll.portal, "testportal");
});
