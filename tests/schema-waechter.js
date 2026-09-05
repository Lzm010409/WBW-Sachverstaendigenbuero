#!/usr/bin/env node
/**
 * Schema-Wächter (E2b) — läuft NICHT im normalen Testlauf.
 *   npm run test:schema
 *
 * Vergleicht die LIVE-Antwort der Portale gegen die Struktur der Fixtures.
 * Schlägt an, wenn ein Portal sein Format ändert — bevor ein Gutachten mit
 * leeren Feldern rausgeht. Kostet nichts (keine L3-Aufrufe).
 */
const fs = require("fs");
const path = require("path");

const SC = path.join(__dirname, "..", "skills", "wbw-vergleichsfahrzeuge", "scripts");
const FIX = path.join(__dirname, "fixtures");
const as24 = require(path.join(SC, "adapters", "autoscout24.js"));
const ka = require(path.join(SC, "adapters", "kleinanzeigen.js"));
const { hole, holeJson, BROWSER_HEADERS } = require(path.join(SC, "adapters", "gemeinsam.js"));

/** Struktur eines Objekts als sortierte Pfadliste (Werte egal). */
function pfade(o, praefix = "", tiefe = 0, out = new Set()) {
  if (tiefe > 3 || o == null) return out;
  if (Array.isArray(o)) { if (o.length) pfade(o[0], praefix + "[]", tiefe + 1, out); return out; }
  if (typeof o === "object") {
    for (const k of Object.keys(o)) {
      const p = praefix ? `${praefix}.${k}` : k;
      out.add(p);
      pfade(o[k], p, tiefe + 1, out);
    }
  }
  return out;
}

// Nicht vergleichen: die eigene Herkunftsnotiz in der Fixture und alles unter
// `seller`, weil die Fixtures dort anonymisiert sind. Beides wären Fehlalarme.
const IGNORIEREN = (x) => x === "_herkunft" || /(^|\.)seller(\.|$)/.test(x);

function vergleiche(name, fixtureObj, liveObj) {
  const f = pfade(fixtureObj), l = pfade(liveObj);
  const fehlt = [...f].filter((x) => !l.has(x) && !IGNORIEREN(x));
  const neu = [...l].filter((x) => !f.has(x) && !IGNORIEREN(x));
  console.log(`\n--- ${name} ---`);
  console.log(`  Fixture: ${f.size} Pfade · Live: ${l.size} Pfade`);
  if (fehlt.length) {
    console.log(`  FEHLEND in der Live-Antwort (${fehlt.length}):`);
    for (const x of fehlt.slice(0, 25)) console.log(`     - ${x}`);
  }
  if (neu.length) {
    console.log(`  NEU in der Live-Antwort (${neu.length}, meist harmlos):`);
    for (const x of neu.slice(0, 10)) console.log(`     + ${x}`);
  }
  if (!fehlt.length) console.log("  OK — alle bekannten Pfade sind weiterhin vorhanden.");
  return fehlt;
}

/** Genau die Pfade, ohne die das Mapping bricht. */
const KRITISCH = {
  autoscout24: ["id", "url", "price.priceRaw", "vehicle.make", "vehicle.transmission",
    "tracking.mileage", "tracking.firstRegistration", "location.zip", "vehicleDetails[].ariaLabel"],
  kleinanzeigenListe: ["results[].adid", "results[].url", "results[].title"],
  kleinanzeigenDetail: ["data.details.Kilometerstand", "data.details.Erstzulassung",
    "data.details.Leistung", "data.details.Getriebe", "data.price.amount", "data.location.zip"],
};

function pruefeKritisch(name, obj) {
  const p = pfade(obj);
  const fehlt = KRITISCH[name].filter((x) => !p.has(x));
  if (fehlt.length) {
    console.log(`  KRITISCH FEHLEND (${name}): ${fehlt.join(", ")}`);
    return false;
  }
  console.log(`  Kritische Pfade (${name}): alle vorhanden.`);
  return true;
}

async function main() {
  // Zwei verschiedene Dinge, die nicht verwechselt werden dürfen:
  //   strukturfehler -> ein Portal hat umgebaut, das Mapping ist zu prüfen.
  //   netzfehler     -> Zeitüberschreitung/HTTP-Fehler, der Lauf ist unschlüssig.
  // Ein Timeout als "Portal hat umgebaut" zu melden, macht den Wächter unglaubwürdig.
  let strukturfehler = false;
  let netzfehler = [];
  console.log("Schema-Wächter — vergleicht Live-Antworten gegen die Fixtures.");

  // ---- AutoScout24 ----
  try {
    // Dieselben Suchparameter wie bei der Fixture-Aufnahme: mit PLZ-Umkreis liefert
    // AutoScout24 zusätzlich location.distanceToSearchLocationInKm — ohne PLZ fehlte
    // das Feld und würde fälschlich als Strukturänderung gemeldet.
    const url = as24.bauSuchUrl({
      autoScout: { make: "volkswagen", model: "golf", yearFrom: 2017, yearTo: 2019, mileageTo: 150000 },
      _abgeleitet: { plz: "47798", radius: 200 },
    });
    const r = await hole(url, { headers: BROWSER_HEADERS });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    const live = as24.findeListings(as24.findeNextData(r.body))[0];
    if (!live) throw new Error("keine Inserate in der Live-Antwort");
    const fix = as24.findeListings(JSON.parse(fs.readFileSync(path.join(FIX, "autoscout24-suchseite.json"), "utf8")))[0];
    vergleiche("AutoScout24 Trefferliste", fix, live);
    if (!pruefeKritisch("autoscout24", live)) strukturfehler = true;
  } catch (e) { console.log(`\n--- AutoScout24 ---\n  NETZFEHLER: ${e.message}`); netzfehler.push("AutoScout24: " + e.message); }

  // ---- Kleinanzeigen (eigener Dienst) ----
  const basis = String(process.env.KA_API_BASE || "").replace(/\/+$/, "");
  if (!basis) {
    console.log("\n--- Kleinanzeigen ---\n  Übersprungen: KA_API_BASE nicht gesetzt.");
  } else {
    const auth = process.env.KA_API_USER
      ? { Authorization: "Basic " + Buffer.from(`${process.env.KA_API_USER}:${process.env.KA_API_PASS}`).toString("base64") } : {};
    try {
      const suchUrl = ka.bauSuchUrl({ kleinanzeigen: { car_make: "volkswagen", car_model: "golf" }, _abgeleitet: {} });
      const liste = await holeJson(`${basis}/inserate-by-url`, {
        method: "POST", headers: { "Content-Type": "application/json", ...auth },
        body: JSON.stringify({ url: suchUrl, max_pages: 1 }), timeoutMs: 240000,
      });
      if (liste.status !== 200) throw new Error(`HTTP ${liste.status} von /inserate-by-url`);
      const fixListe = JSON.parse(fs.readFileSync(path.join(FIX, "kleinanzeigen-liste.json"), "utf8"));
      vergleiche("Kleinanzeigen Trefferliste", fixListe, liste.daten);
      if (!pruefeKritisch("kleinanzeigenListe", liste.daten)) strukturfehler = true;

      const adid = (liste.daten.results || [])[0] && liste.daten.results[0].adid;
      if (adid) {
        const det = await holeJson(`${basis}/inserat/${adid}?batch_id=schema-waechter`, { headers: auth, timeoutMs: 120000 });
        if (det.status !== 200) throw new Error(`HTTP ${det.status} von /inserat/${adid}`);
        const fixDet = JSON.parse(fs.readFileSync(path.join(FIX, "kleinanzeigen-detail.json"), "utf8"))[0];
        vergleiche("Kleinanzeigen Detail", fixDet, det.daten);
        // details-Labels sind DOM-abhängig: nur die kritischen prüfen, nicht alle.
        if (!pruefeKritisch("kleinanzeigenDetail", det.daten)) strukturfehler = true;
      }
    } catch (e) { console.log(`\n--- Kleinanzeigen ---\n  NETZFEHLER: ${e.message}`); netzfehler.push("Kleinanzeigen: " + e.message); }
  }

  if (strukturfehler) {
    console.log("\nERGEBNIS: ABWEICHUNG. Mapping im betroffenen Adapter prüfen, BEVOR ein Gutachten läuft.");
    process.exit(1);
  }
  if (netzfehler.length) {
    console.log("\nERGEBNIS: UNSCHLÜSSIG — kein Strukturwechsel festgestellt, aber der Lauf war unvollständig:");
    for (const f of netzfehler) console.log(`  ${f}`);
    console.log("  Das ist ein Netz-/Verfügbarkeitsproblem, keine Portaländerung. Bitte wiederholen.");
    process.exit(2);
  }
  console.log("\nERGEBNIS: Struktur unverändert — Mapping trägt weiter.");
  process.exit(0);
}

main();
