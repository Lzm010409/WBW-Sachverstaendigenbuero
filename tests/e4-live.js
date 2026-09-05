#!/usr/bin/env node
/**
 * E4 — Live-Integration je Adapter, mit Schwellen für die Feldvollständigkeit.
 *   npm run test:live
 *
 * Läuft NICHT im normalen Testlauf (braucht Netz) und löst KEINE
 * kostenpflichtigen L3-Aufrufe aus: geprüft werden nur L0/L1/L2.
 *
 * Schwellen (bewusst gesetzt, siehe TESTKONZEPT.md):
 *   Preis          >= 90 %   Ohne Preis ist ein Inserat für den WBW wertlos.
 *   Kilometerstand >= 90 %   Trägt den Toleranzfilter (±25.000 km).
 *   Erstzulassung  >= 80 %   Etwas laxer: einzelne Inserate lassen sie weg.
 * Wird eine Schwelle gerissen, ist das MAPPING kaputt — nicht die Quelle schlecht.
 */
const path = require("path");
const SC = path.join(__dirname, "..", "skills", "wbw-vergleichsfahrzeuge", "scripts");
const { beschaffe } = require(path.join(SC, "fetch-portal.js"));

const SCHWELLEN = { preis: 0.9, kilometerstand: 0.9, erstzulassung: 0.8 };
const MINDESTTREFFER = 20;

function anteil(items, feld) {
  if (!items.length) return 0;
  return items.filter((x) => x[feld] != null && x[feld] !== "" && !(Array.isArray(x[feld]) && !x[feld].length)).length / items.length;
}

/** Streicht L3 aus der Konfiguration — dieser Test darf nie Geld kosten. */
function ohneL3(providers) {
  const k = JSON.parse(JSON.stringify(providers));
  for (const p of Object.values(k.portale)) p.stufen = p.stufen.filter((s) => !s.kostenpflichtig);
  return k;
}

async function main() {
  const { ladeProviders } = require(path.join(SC, "fetch-portal.js"));
  const providers = ohneL3(ladeProviders());
  const eingaben = require(path.resolve(process.argv[2] || path.join(__dirname, "..", "tests", "live-eingaben.json")));
  const portale = process.argv[3] ? [process.argv[3]] : Object.keys(providers.portale);

  let ok = true;
  const mediane = {};
  for (const portal of portale) {
    const aktive = providers.portale[portal].stufen.filter((s) => s.enabled);
    console.log(`\n=== ${portal} === (aktive kostenfreie Stufen: ${aktive.map((s) => s.id).join(", ") || "keine"})`);
    if (!aktive.length) { console.log("  Übersprungen: keine kostenfreie Stufe aktiv (läuft produktiv über L3)."); continue; }
    const t0 = Date.now();
    let r;
    try {
      r = await beschaffe(portal, eingaben, { providers, maxItems: Number(process.env.WBW_E4_MAX || 40) });
    } catch (e) { console.log(`  FEHLER: ${e.message}`); ok = false; continue; }
    const it = r.items;
    console.log(`  Stufe ${r.beschaffungsprotokoll.getrageneStufe || "keine"} · ${it.length} Treffer · ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    if (it.length < MINDESTTREFFER) { console.log(`  ZU WENIGE TREFFER (< ${MINDESTTREFFER})`); ok = false; }
    for (const [feld, schwelle] of Object.entries(SCHWELLEN)) {
      const a = anteil(it, feld);
      const gut = a >= schwelle;
      if (!gut) ok = false;
      console.log(`  ${gut ? "OK  " : "RISS"} ${feld.padEnd(15)} ${(a * 100).toFixed(1)}%  (Schwelle ${(schwelle * 100).toFixed(0)}%)`);
    }
    for (const feld of ["leistungKw", "getriebe", "plz", "url", "ausstattung", "bilder"]) {
      console.log(`       ${feld.padEnd(15)} ${(anteil(it, feld) * 100).toFixed(1)}%`);
    }
    const ohneGps = it.filter((x) => x.lat == null).length;
    if (ohneGps) console.log(`       ohne Koordinaten: ${ohneGps}/${it.length} — werden per PLZ geocodiert, Rest weist der Report separat aus`);

    // --- Plausibilitätsband ---------------------------------------------------
    // Vollständigkeit allein reicht nicht: ein Mapping, das versehentlich auf die
    // Monatsrate statt auf den Kaufpreis zeigt, liefert 100 % und ruiniert den WBW.
    const ausreisser = [];
    for (const x of it) {
      if (x.preis != null && (x.preis < 300 || x.preis > 250000)) ausreisser.push(`Preis ${x.preis} (${x.url || x.id})`);
      if (x.kilometerstand != null && (x.kilometerstand < 0 || x.kilometerstand > 800000)) ausreisser.push(`km ${x.kilometerstand} (${x.url || x.id})`);
      const j = x.erstzulassung ? Number(String(x.erstzulassung).slice(-4)) : null;
      if (j != null && (j < 1950 || j > new Date().getFullYear())) ausreisser.push(`EZ ${x.erstzulassung} (${x.url || x.id})`);
    }
    if (ausreisser.length) {
      ok = false;
      console.log(`  AUSREISSER (${ausreisser.length}) — Mapping zeigt vermutlich auf ein falsches Feld:`);
      for (const a of ausreisser.slice(0, 5)) console.log(`       ${a}`);
    } else {
      console.log("  OK   Plausibilitätsband  keine Ausreißer bei Preis/km/EZ");
    }
    const preise = it.map((x) => x.preis).filter((p) => p != null).sort((a, b) => a - b);
    if (preise.length) {
      const med = preise[Math.floor(preise.length / 2)];
      mediane[portal] = med;
      console.log(`       Medianpreis      ${med} EUR`);
    }
  }
  // Der schärfste Test: weicht ein Portal im Medianpreis um Faktor 5 ab, zeigt
  // sein Mapping auf ein anderes Feld. Das fällt bei keiner Vollständigkeitsmessung auf.
  const werte = Object.entries(mediane);
  if (werte.length >= 2) {
    const min = Math.min(...werte.map(([, v]) => v));
    const max = Math.max(...werte.map(([, v]) => v));
    console.log(`\nMedianpreise: ${werte.map(([k, v]) => `${k} ${v} EUR`).join(" · ")}`);
    if (max / min > 5) {
      ok = false;
      console.log(`  ABWEICHUNG Faktor ${(max / min).toFixed(1)} — ein Mapping zeigt vermutlich auf das falsche Feld.`);
    } else {
      console.log(`  OK   Größenordnung stimmt überein (Faktor ${(max / min).toFixed(2)}).`);
    }
  }

  console.log(`\n${ok ? "ERGEBNIS: alle Schwellen gehalten." : "ERGEBNIS: mindestens eine Schwelle gerissen — Mapping prüfen, NICHT die Schwelle senken."}`);
  process.exit(ok ? 0 : 1);
}
main();
