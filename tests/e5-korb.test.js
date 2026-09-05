/**
 * E5-Anteile, die offline prüfbar sind: Fahrzeuge ohne Koordinaten dürfen NICHT
 * still verworfen werden, sondern müssen separat ausgewiesen werden. Das ist
 * gutachterlich relevant — der Sachverständige entscheidet über manuelle Prüfung.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const SC = path.join(__dirname, "..", "skills", "wbw-vergleichsfahrzeuge", "scripts");
const { runPipeline } = require(path.join(SC, "pipeline.js"));
const { normalizeAll } = require(path.join(SC, "normalize.js"));
const { renderReport } = require(path.join(SC, "generate-report.js"));

/** Kanonisches Adapter-Fahrzeug, wie fetch-portal.js es liefert. */
function fz(id, extra = {}) {
  return {
    id, quelle: "kleinanzeigen", url: `https://www.kleinanzeigen.de/s-anzeige/x/${id}`,
    titel: "Fiat Tipo Kombi", preis: 11000, kilometerstand: 75000, erstzulassung: "01/2020",
    leistungKw: 88, getriebe: "Manuell", kraftstoff: "Benzin", fahrzeugtyp: "Kombi",
    plz: "47798", ort: "Krefeld", lat: 51.33, lon: 6.56,
    ausstattung: ["Klimaanlage"], bilder: [], beschreibung: "",
    ...extra,
  };
}

const PARAMS = {
  subject: { marke: "Fiat", modell: "Tipo", ez: "01/2020", mileage: 74781, power: 88 },
  plz: "47798", radiusKm: 200, kmToleranz: 25000, ezToleranzJahre: 1, leistungToleranzKw: 15,
  sollAusstattung: ["Klimaanlage"], wbwOpts: { eurProKm: 0.1, eurProEzMonat: 120 },
};

test("Fahrzeuge ohne Koordinaten werden separat ausgewiesen, nicht verworfen", () => {
  const roh = [fz("mit-1"), fz("mit-2"), fz("ohne-1", { lat: null, lon: null }), fz("ohne-2", { lat: null, lon: null })];
  const fahrzeuge = normalizeAll({ kleinanzeigen: roh });
  // Bewusst KEIN Geocoding: so sieht es aus, wenn die PLZ nicht auflösbar ist.
  const r = runPipeline({ ...PARAMS, fahrzeuge });

  const ohne = (r.ohneKoordinaten || []).map((x) => (x.fahrzeug || x).id);
  assert.equal(ohne.length, 2, "beide Fahrzeuge ohne Koordinaten müssen aufgeführt sein");
  assert.deepEqual(ohne.sort(), ["ohne-1", "ohne-2"]);
  assert.equal(r.statistik.ohneKoordinaten, 2, "die Statistik muss sie zählen");

  const korbIds = (r.korb || []).map((k) => k.fahrzeug.id);
  for (const id of ohne) assert.ok(!korbIds.includes(id), "sie gehören nicht in den Korb");
  assert.ok(korbIds.includes("mit-1"), "verortete Fahrzeuge bleiben im Korb");

  // Nichts darf spurlos verschwinden.
  assert.equal(r.statistik.gescraped, 4);
  assert.equal(r.statistik.imUmkreis + r.statistik.ausserhalb + r.statistik.ohneKoordinaten, 4,
    "die Geo-Aufteilung muss aufgehen — sonst fällt etwas still heraus");
});

test("Der Report weist die Fahrzeuge ohne Koordinaten sichtbar aus", () => {
  const fahrzeuge = normalizeAll({ kleinanzeigen: [fz("a"), fz("b", { lat: null, lon: null })] });
  const r = runPipeline({ ...PARAMS, fahrzeuge });
  const { html } = renderReport(r);
  assert.match(html, /ohne Standortkoordinaten/i, "der Hinweis muss im Report stehen");
  assert.match(html, /Ohne Koordinaten \(separat geprüft\)/i, "und in der Nachvollziehbarkeit auftauchen");
});

test("Das Beschaffungsprotokoll erscheint im Report", () => {
  const fahrzeuge = normalizeAll({ kleinanzeigen: [fz("a")] });
  const r = runPipeline({ ...PARAMS, fahrzeuge });
  r.beschaffung = [
    { portal: "mobile.de", getrageneStufe: null, trefferGesamt: 0, ende: "2026-09-05T07:44:53.447Z" },
    { portal: "autoscout24", getrageneStufe: "L0", trefferGesamt: 29, ende: "2026-09-05T07:44:57.052Z" },
    { portal: "kleinanzeigen", getrageneStufe: "L1", trefferGesamt: 28, ende: "2026-09-05T07:52:31.030Z", kostenpflichtig: false },
  ];
  const { html } = renderReport(r);
  assert.match(html, /Datenbeschaffung je Portal/);
  assert.match(html, /autoscout24/);
  assert.match(html, /L0/);
  assert.match(html, /L1/);
  assert.match(html, /keine – alle Stufen gescheitert/, "ein leergelaufenes Portal muss als solches dastehen");
  assert.match(html, /dokumentierter Leerstand/i);
});

test("Eine kostenpflichtige Stufe wird im Report als solche gekennzeichnet", () => {
  const fahrzeuge = normalizeAll({ kleinanzeigen: [fz("a")] });
  const r = runPipeline({ ...PARAMS, fahrzeuge });
  r.beschaffung = [{ portal: "mobile.de", getrageneStufe: "L3", trefferGesamt: 40,
    ende: "2026-09-05T08:00:00.000Z", kostenpflichtig: true }];
  const { html } = renderReport(r);
  assert.match(html, /L3.*kostenpflichtig/s);
});

test("Eine Modellkorrektur erscheint sichtbar im Report", () => {
  // Gutachterlich relevant: wenn der Adapter den Suchbegriff ändert, muss das
  // im Report stehen — sonst weiss niemand, wonach tatsächlich gesucht wurde.
  const fahrzeuge = normalizeAll({ autoscout24: [fz("a")] });
  const r = runPipeline({ ...PARAMS, fahrzeuge });
  r.beschaffung = [{
    portal: "autoscout24", getrageneStufe: "L0", trefferGesamt: 40, ende: "2026-09-05T08:00:00.000Z",
    versuche: [{ ergebnis: "erfolg", details: { warnungen: [
      'Modell "golf-vii" existiert bei AutoScout24 nicht; auf "Golf" korrigiert (aus der Modellliste des Portals).',
    ] } }],
  }];
  const { html } = renderReport(r);
  assert.match(html, /Hinweis autoscout24/);
  // esc() maskiert die Anführungszeichen im HTML — auf den Klartext prüfen.
  assert.match(html, /korrigiert \(aus der Modellliste des Portals\)/);
  assert.match(html, /existiert bei AutoScout24 nicht/);
});
