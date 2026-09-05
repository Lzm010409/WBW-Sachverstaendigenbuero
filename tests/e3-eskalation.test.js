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

/** Vollständiges Attrappen-Fahrzeug: Preis und Kilometerstand sind gefüllt,
 *  sonst greift die Qualitätsschwelle des Dispatchers (siehe MINDEST_BRAUCHBAR). */
const FZ = (id) => ({ id, preis: 12000, kilometerstand: 80000 });

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
  const b = fake({ items: [FZ("1")], protokoll: {} });
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
  const b = fake({ items: [FZ("1"), FZ("2")], protokoll: {} });
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
  const a = fake({ items: [FZ("1")], protokoll: {} });
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
  const aus = fake({ items: [FZ("x")], protokoll: {} });
  const an = fake({ items: [FZ("y")], protokoll: {} });
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
  const rettung = fake({ items: [FZ("z")], protokoll: {} });
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
  const b = fake({ items: [FZ("1")], protokoll: {} });
  const r = await beschaffe("testportal", EINGABEN, {
    providers: konf([{ id: "L0", adapter: "existiert-nicht", enabled: true }, { id: "L3", adapter: "b", enabled: true }]),
    adapterMap: { b: b.lader },
  });
  assert.match(r.beschaffungsprotokoll.versuche[0].fehler, /Unbekannter Adapter/);
  assert.equal(r.beschaffungsprotokoll.getrageneStufe, "L3");
});

test("Protokoll trägt Zeitstempel und Dauer je Stufe", async () => {
  const a = fake({ items: [FZ("1")], protokoll: { abrufe: [] } });
  const r = await beschaffe("testportal", EINGABEN, {
    providers: konf([{ id: "L0", adapter: "a", enabled: true }]),
    adapterMap: { a: a.lader },
  });
  const v = r.beschaffungsprotokoll.versuche[0];
  assert.ok(typeof v.ms === "number");
  assert.match(v.zeitpunkt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(r.beschaffungsprotokoll.portal, "testportal");
});

/* ------------------------------------------------------------------
 * Ergänzungen aus TESTKONZEPT.md Abschnitt 4 ("Zusätzliche Fälle")
 * ---------------------------------------------------------------- */

const fs = require("fs");
const os = require("os");
const { ladeProviders, sauberUrl, saubereProtokollDaten, MINDEST_BRAUCHBAR } =
  require(path.join(SC, "fetch-portal.js"));
const as24 = require(path.join(SC, "adapters", "autoscout24.js"));

test("Treffer mit lauter leeren Pflichtfeldern gelten NICHT als Erfolg", async () => {
  // Der realistische Portalumbau liefert nicht nichts, sondern Objekte voller null.
  const muell = fake({ items: Array.from({ length: 25 }, (_, i) => ({ id: String(i), preis: null, kilometerstand: null })), protokoll: {} });
  const gut = fake({ items: [{ id: "g", preis: 12000, kilometerstand: 80000 }], protokoll: {} });
  const r = await beschaffe("testportal", EINGABEN, {
    providers: konf([{ id: "L0", adapter: "muell", enabled: true }, { id: "L3", adapter: "gut", enabled: true }]),
    adapterMap: { muell: muell.lader, gut: gut.lader },
  });
  assert.equal(r.beschaffungsprotokoll.versuche[0].ergebnis, "unbrauchbar");
  assert.equal(r.beschaffungsprotokoll.versuche[0].treffer, 25, "die Trefferzahl wird trotzdem protokolliert");
  assert.equal(r.beschaffungsprotokoll.getrageneStufe, "L3", "es muss eskaliert werden");
  assert.equal(gut.zaehler.aufrufe, 1);
});

test("Teilweise gefüllte Treffer oberhalb der Schwelle gelten als Erfolg", async () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ id: String(i), preis: i < 6 ? 1000 : null, kilometerstand: i < 6 ? 50000 : null }));
  const a = fake({ items, protokoll: {} });
  const teuer = fake(() => { throw new Error("darf nicht laufen"); });
  const r = await beschaffe("testportal", EINGABEN, {
    providers: konf([{ id: "L0", adapter: "a", enabled: true }, { id: "L3", adapter: "teuer", enabled: true }]),
    adapterMap: { a: a.lader, teuer: teuer.lader },
  });
  assert.ok(0.6 >= MINDEST_BRAUCHBAR);
  assert.equal(r.beschaffungsprotokoll.getrageneStufe, "L0");
  assert.equal(teuer.zaehler.aufrufe, 0);
  assert.equal(r.beschaffungsprotokoll.versuche[0].anteilBrauchbar, 0.6);
});

test("Stufen werden in der Reihenfolge der Liste versucht, nicht nach Schlüssel", async () => {
  const reihenfolge = [];
  const mk = (id) => ({ lader: () => ({ async holen() { reihenfolge.push(id); return { items: [], protokoll: {} }; } }) });
  await beschaffe("testportal", EINGABEN, {
    providers: konf([
      { id: "L0", adapter: "z", enabled: true },
      { id: "L1", adapter: "a", enabled: true },
      { id: "L2", adapter: "m", enabled: true },
      { id: "L3", adapter: "b", enabled: true },
    ]),
    adapterMap: { z: mk("L0").lader, a: mk("L1").lader, m: mk("L2").lader, b: mk("L3").lader },
  });
  assert.deepEqual(reihenfolge, ["L0", "L1", "L2", "L3"], "sonst entscheidet die Sortierung über die Kosten");
});

test("providers.json defekt -> klare Meldung, Code PROVIDERS_DEFEKT", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "wbw-"));
  const kaputt = path.join(d, "kaputt.json");
  fs.writeFileSync(kaputt, "{ das ist kein JSON");
  assert.throws(() => ladeProviders(kaputt), (e) => e.code === "PROVIDERS_DEFEKT" && /kein gültiges JSON/.test(e.message));

  const ohnePortale = path.join(d, "ohne.json");
  fs.writeFileSync(ohnePortale, JSON.stringify({ irgendwas: 1 }));
  assert.throws(() => ladeProviders(ohnePortale), (e) => e.code === "PROVIDERS_DEFEKT" && /portale/.test(e.message));

  const stufeOhneId = path.join(d, "stufe.json");
  fs.writeFileSync(stufeOhneId, JSON.stringify({ portale: { x: { stufen: [{ enabled: true }] } } }));
  assert.throws(() => ladeProviders(stufeOhneId), (e) => e.code === "PROVIDERS_DEFEKT" && /ohne id\/adapter/.test(e.message));

  assert.throws(() => ladeProviders(path.join(d, "gibtsnicht.json")), (e) => e.code === "PROVIDERS_DEFEKT");
  fs.rmSync(d, { recursive: true, force: true });
});

test("die echte providers.json ist gültig", () => {
  const p = ladeProviders();
  assert.ok(Object.keys(p.portale).length >= 3);
  for (const [name, k] of Object.entries(p.portale)) {
    assert.ok(k.stufen.length >= 2, `${name} braucht mindestens zwei Stufen`);
    assert.ok(k.stufen.some((s) => s.enabled), `${name} hat keine aktive Stufe`);
    // Jede deaktivierte Stufe muss begründet sein — sonst weiß in sechs Monaten
    // niemand mehr, ob sie kaputt oder nur ungenutzt ist.
    for (const s of k.stufen.filter((x) => !x.enabled)) {
      assert.ok(s.grund && s.grund.length > 20, `${name}/${s.id}: deaktivierte Stufe ohne Begründung`);
    }
  }
});

test("Teilerfolg über Seitengrenzen: Seite 1 bleibt erhalten, wenn Seite 2 wirft", async () => {
  const fx = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "autoscout24-suchseite.json"), "utf8"));
  const html = '<script id="__NEXT_DATA__" type="application/json">' + JSON.stringify(fx) + "</script>";
  let n = 0;
  const r = await as24.holen(
    { autoScout: { make: "fiat", model: "tipo" }, _abgeleitet: {} },
    {
      maxItems: 100, maxSeiten: 3, pause: async () => {},
      hole: async () => { if (++n === 1) return { status: 200, headers: {}, body: html }; throw new Error("Netz weg"); },
    }
  );
  assert.equal(r.items.length, 5, "die Treffer von Seite 1 müssen erhalten bleiben");
  assert.equal(r.protokoll.unvollstaendig, true, "die Unvollständigkeit muss dranstehen");
  assert.match(r.protokoll.warnungen.join(" "), /unvollständig/i);
});

test("Scheitert schon Seite 1, gilt die Stufe als gescheitert", async () => {
  await assert.rejects(
    () => as24.holen({ autoScout: { make: "fiat" }, _abgeleitet: {} },
      { maxSeiten: 2, pause: async () => {}, hole: async () => { throw new Error("sofort weg"); } }),
    /sofort weg/
  );
});

test("Protokoll trägt niemals ein Token — auch nicht in URLs", async () => {
  const a = { lader: () => ({ async holen() { return {
    items: [{ id: "1", preis: 1, kilometerstand: 1 }],
    protokoll: { abrufe: [{ url: "https://api.apify.com/v2/acts/x/runs?token=apify_api_SUPERGEHEIM0815&maxTotalChargeUsd=0.5" }],
                 tief: { verschachtelt: ["https://u:passwort@dienst.example/x?key=abc123def456"] } },
  }; } }) };
  const r = await beschaffe("testportal", EINGABEN, {
    providers: konf([{ id: "L0", adapter: "a", enabled: true }]),
    adapterMap: { a: a.lader },
  });
  const s = JSON.stringify(r.beschaffungsprotokoll);
  assert.ok(!s.includes("apify_api_SUPERGEHEIM0815"), "Token darf das Protokoll nicht verlassen");
  assert.ok(!s.includes("passwort"), "Benutzerinfo darf nicht im Protokoll stehen");
  assert.ok(!s.includes("abc123def456"), "key-Parameter muss redigiert sein");
  assert.ok(s.includes("maxTotalChargeUsd=0.5"), "fachliche Parameter bleiben erhalten");
});

test("sauberUrl() — Kanten", () => {
  assert.equal(sauberUrl("kein url"), "kein url");
  assert.equal(sauberUrl(""), "");
  assert.ok(sauberUrl("https://x/y?TOKEN=geheim").includes("REDIGIERT"), "Parametername case-insensitiv");
  assert.deepEqual(saubereProtokollDaten(null), null);
  assert.deepEqual(saubereProtokollDaten({ a: 1 }), { a: 1 });
});
