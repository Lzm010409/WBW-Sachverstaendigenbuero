#!/usr/bin/env node
/**
 * WBW-Pipeline: normalisierte Fahrzeuge + Subjekt/Parameter ->
 * Geo-Filter -> Toleranzfilter (km, EZ) -> Dedup -> Ausstattungs-Score
 * -> Wertvorschlag.
 *
 * Als CLI:  node pipeline.js <input.json> <output.json>
 * Als Modul: const { runPipeline } = require("./pipeline.js"); runPipeline(cfg)
 */
const fs = require("fs");
const { geoFilter } = require("./geo-filter.js");
const { dedupeFahrzeuge } = require("./dedup-fahrzeuge.js");
const { bewerteKorb, detectLinie, detectKarosserie, detectGetriebe } = require("./ausstattung-matcher.js");
const { wbwVorschlag } = require("./wbw-vorschlag.js");
const { ezToYear } = require("./normalize.js");

function num(v) {
  if (v == null) return null;
  const m = String(v).replace(/[^\d]/g, "");
  return m ? parseInt(m, 10) : null;
}

// Türenzahl -> Menge plausibler Werte (2..7). "4/5" -> {4,5}, "5" -> {5}, 5 -> {5}.
function parseTueren(v) {
  if (v == null || v === "") return null;
  const tokens = String(v).match(/[2-7]/g);
  if (!tokens) return null;
  const set = new Set(tokens.map(Number));
  return set.size ? set : null;
}
function tuerenSchnitt(a, b) {
  if (!a || !b) return false;
  for (const x of a) if (b.has(x)) return true;
  return false;
}

function toleranzFilter(fahrzeuge, subject, kmTol, ezTolJahre, kwTol) {
  const passt = [], raus = [];
  const sKm = subject?.mileage != null ? num(subject.mileage) : null;
  const sEz = subject?.ezYear ?? null;
  const sKw = subject?.power != null ? num(subject.power) : null;
  for (const f of fahrzeuge) {
    const km = num(f.attributes?.Mileage ?? f.mileage);
    const ezY = f._ezYear ?? ezToYear(f.ez);
    const kw = num(f.power);
    let ok = true; const gruende = [];
    if (sKm != null && km != null && Math.abs(km - sKm) > kmTol) {
      ok = false; gruende.push(`km Δ${Math.abs(km - sKm)}`);
    }
    if (sEz != null && ezY != null && Math.abs(ezY - sEz) > ezTolJahre) {
      ok = false; gruende.push(`EZ Δ${Math.abs(ezY - sEz).toFixed(1)}J`);
    }
    // Motorleistung: nur prüfen, wenn beim Subjekt UND beim Fahrzeug bekannt
    // (unbekannte Leistung wird nicht verworfen).
    if (kwTol != null && sKw != null && kw != null && Math.abs(kw - sKw) > kwTol) {
      ok = false; gruende.push(`kW Δ${Math.abs(kw - sKw)}`);
    }
    if (ok) passt.push(f); else raus.push({ id: f.id, source: f.source, model: f.model, gruende });
  }
  return { passt, raus };
}

/**
 * Reine Funktion: Konfiguration -> Ergebnisobjekt (keine Datei-IO).
 * @param {object} cfg { subject, sollAusstattung, plz|zentrum, radiusKm,
 *                        kmToleranz, ezToleranzJahre, fahrzeuge, wbwOpts }
 */
function runPipeline(cfg) {
  const {
    subject = {}, plz, zentrum,
    radiusKm = 200, kmToleranz = 25000, ezToleranzJahre = 1, leistungToleranzKw = 10,
    fahrzeuge = [], wbwOpts = {},
  } = cfg;

  // Soll-Ausstattung als Freitext zulassen: String -> in Begriffe zerlegen.
  const sollAusstattung = (Array.isArray(cfg.sollAusstattung)
    ? cfg.sollAusstattung
    : String(cfg.sollAusstattung || "").split(/[,;\n]/))
    .map((s) => String(s).trim()).filter(Boolean);

  const subjEzYear = subject.ezYear ?? ezToYear(subject.ez);
  const subj = { mileage: num(subject.mileage), ezYear: subjEzYear, power: num(subject.power) };

  const geo = geoFilter(fahrzeuge, { plz, zentrum, radiusKm });

  // Geo-eingegrenzte Kleinanzeigen-Suche (locId): die Inserate haben keine
  // Koordinaten, die Suche war aber bereits auf den Umkreis beschränkt – daher
  // als "im Umkreis" behandeln statt sie als "ohne Koordinaten" zu verwerfen.
  let imUmkreis = geo.imUmkreis;
  let ohneKoordinaten = geo.ohneKoordinaten;
  if (cfg.kleinanzeigenGeoConstrained) {
    const trusted = ohneKoordinaten.filter((f) => f.source === "kleinanzeigen");
    if (trusted.length) {
      ohneKoordinaten = ohneKoordinaten.filter((f) => f.source !== "kleinanzeigen");
      imUmkreis = imUmkreis.concat(trusted.map((f) => ({ ...f, _distanzKm: null })));
    }
  }

  const tol = toleranzFilter(imUmkreis, subj, kmToleranz, ezToleranzJahre, leistungToleranzKw);
  const dd = dedupeFahrzeuge(tol.passt);

  // Ausstattungslinie/Trim: ist beim Subjekt explizit eine Linie angegeben
  // (z. B. "Style"), nur Fahrzeuge dieser Linie in den Korb. Andere/unbekannte
  // Linien werden ausgeschlossen – AUSSER es gäbe dann keine Treffer (Fallback)
  // oder es ist gar keine Linie angegeben.
  const subjLinie = cfg.linie ?? detectLinie([subject.variante, subject.modell].filter(Boolean).join(" "));
  let korbInput = dd.unique;
  const linieInfo = { subjekt: subjLinie, gefiltert: false, fallback: false, ausgeschlossen: [] };
  if (subjLinie) {
    const mitLinie = dd.unique.map((f) => ({
      f, linie: detectLinie([f.title, f.variant, f.model].filter(Boolean).join(" ")),
    }));
    const matching = mitLinie.filter((x) => x.linie === subjLinie).map((x) => x.f);
    const raus = mitLinie.filter((x) => x.linie !== subjLinie);
    if (matching.length > 0) {
      korbInput = matching;
      linieInfo.gefiltert = true;
      linieInfo.ausgeschlossen = raus.map((x) => ({
        id: x.f.id, source: x.f.source, model: x.f.model, linie: x.linie || "unbekannt",
      }));
    } else {
      linieInfo.fallback = true; // keine Treffer der Linie -> alle einbeziehen
    }
  }

  // Karosserie/Bauart: nur Fahrzeuge der Subjekt-Bauart. Ist sie beim Subjekt nicht
  // angegeben (z. B. "T-Roc Style" sagt nicht "SUV"), wird die häufigste Bauart im
  // bereits linien-gefilterten Korb als Referenz genommen und Abweichler (z. B. ein
  // Cabrio bei lauter SUV) ausgeschlossen. Unbekannte Bauart wird nicht verworfen.
  const karoInfo = { subjekt: null, referenz: null, abgeleitet: false, gefiltert: false, fallback: false, ausgeschlossen: [] };
  {
    const subjKaro = cfg.karosserie
      ?? detectKarosserie([subject.marke, subject.modell, subject.variante].filter(Boolean).join(" "));
    const mitKaro = korbInput.map((f) => ({
      f, k: detectKarosserie([f.bodyType, f.title].filter(Boolean).join(" ")),
    }));
    let referenz = subjKaro;
    if (!referenz) {
      const counts = {};
      for (const x of mitKaro) if (x.k) counts[x.k] = (counts[x.k] || 0) + 1;
      const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      if (top) { referenz = top[0]; karoInfo.abgeleitet = true; }
    }
    karoInfo.subjekt = subjKaro;
    karoInfo.referenz = referenz;
    if (referenz) {
      const matching = mitKaro.filter((x) => x.k === referenz || x.k == null).map((x) => x.f);
      const raus = mitKaro.filter((x) => x.k != null && x.k !== referenz);
      if (matching.length > 0 && raus.length > 0) {
        korbInput = matching;
        karoInfo.gefiltert = true;
        karoInfo.ausgeschlossen = raus.map((x) => ({
          id: x.f.id, source: x.f.source, model: x.f.model, karosserie: x.k,
        }));
      } else if (matching.length === 0) {
        karoInfo.fallback = true;
      }
    }
  }

  // Getriebe: nur filtern, wenn der Nutzer es explizit gewählt hat (Automatik/Manuell).
  // Anders als die Karosserie wird das NICHT abgeleitet – ein Modell gibt es meist in
  // beiden Varianten, eine Ableitung würde willkürlich filtern.
  const subjGetriebe = detectGetriebe(cfg.getriebe);
  const getriebeInfo = { subjekt: subjGetriebe, gefiltert: false, fallback: false, ausgeschlossen: [] };
  if (subjGetriebe) {
    const mitG = korbInput.map((f) => ({ f, g: detectGetriebe([f.getriebe, f.title].filter(Boolean).join(" ")) }));
    const matching = mitG.filter((x) => x.g === subjGetriebe || x.g == null).map((x) => x.f);
    const raus = mitG.filter((x) => x.g != null && x.g !== subjGetriebe);
    if (matching.length > 0 && raus.length > 0) {
      korbInput = matching;
      getriebeInfo.gefiltert = true;
      getriebeInfo.ausgeschlossen = raus.map((x) => ({ id: x.f.id, source: x.f.source, model: x.f.model, getriebe: x.g }));
    } else if (matching.length === 0) {
      getriebeInfo.fallback = true;
    }
  }

  // Türenzahl: ist sie beim Subjekt angegeben, nur Fahrzeuge mit passender
  // Türenzahl. Unbekannte Türenzahl bleibt drin (nicht über-filtern). Bereiche
  // ("4/5") gelten als Treffer, wenn die Subjekt-Türenzahl enthalten ist.
  const subjTueren = parseTueren(cfg.tueren ?? subject.tueren);
  const tuerenInfo = { subjekt: cfg.tueren ?? subject.tueren ?? null, gefiltert: false, fallback: false, ausgeschlossen: [] };
  if (subjTueren) {
    const mitT = korbInput.map((f) => ({ f, t: parseTueren(f.tueren) }));
    const matching = mitT.filter((x) => !x.t || tuerenSchnitt(x.t, subjTueren)).map((x) => x.f);
    const raus = mitT.filter((x) => x.t && !tuerenSchnitt(x.t, subjTueren));
    if (matching.length > 0 && raus.length > 0) {
      korbInput = matching;
      tuerenInfo.gefiltert = true;
      tuerenInfo.ausgeschlossen = raus.map((x) => ({
        id: x.f.id, source: x.f.source, model: x.f.model, tueren: x.f.tueren,
      }));
    } else if (matching.length === 0) {
      tuerenInfo.fallback = true;
    }
  }

  const scored = bewerteKorb(sollAusstattung, korbInput);
  const wbw = wbwVorschlag(scored, subj, wbwOpts);

  return {
    erstelltAm: new Date().toISOString(),
    subjekt: { ...subject, ezYear: subjEzYear },
    parameter: { plz, zentrum: geo.zentrum, radiusKm, kmToleranz, ezToleranzJahre,
      leistungToleranzKw, sollAusstattung, ausstattungslinie: subjLinie,
      karosserie: karoInfo.referenz, getriebe: subjGetriebe, tueren: tuerenInfo.subjekt },
    statistik: {
      gescraped: fahrzeuge.length,
      imUmkreis: imUmkreis.length,
      ausserhalb: geo.ausserhalb.length,
      ohneKoordinaten: ohneKoordinaten.length,
      toleranzRaus: tol.raus.length,
      dublettenRaus: dd.entfernt,
      linieRaus: linieInfo.ausgeschlossen.length,
      karosserieRaus: karoInfo.ausgeschlossen.length,
      getriebeRaus: getriebeInfo.ausgeschlossen.length,
      tuerenRaus: tuerenInfo.ausgeschlossen.length,
      imKorb: scored.length,
    },
    linieInfo,
    karoInfo,
    getriebeInfo,
    tuerenInfo,
    wbw,
    korb: scored.map((s, i) => ({
      rang: i + 1,
      score: s.score,
      matrix: s.matrix, fehlend: s.fehlend, unbekannt: s.unbekannt,
      _distanzKm: s.fahrzeug._distanzKm ?? null,
      fahrzeug: s.fahrzeug,
    })),
    ohneKoordinaten,
    toleranzRaus: tol.raus,
    dubletten: dd.dubletten,
  };
}

function main() {
  const [, , inPath, outPath] = process.argv;
  if (!inPath || !outPath) {
    console.error("Aufruf: node pipeline.js <input.json> <output.json>");
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(inPath, "utf8"));
  const result = runPipeline(cfg);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), "utf8");
  console.log(`OK: ${result.statistik.imKorb} im Korb · WBW-Vorschlag ${result.wbw.vorschlagBrutto ?? "n/a"} EUR -> ${outPath}`);
}

if (require.main === module) main();
module.exports = { runPipeline, toleranzFilter };
