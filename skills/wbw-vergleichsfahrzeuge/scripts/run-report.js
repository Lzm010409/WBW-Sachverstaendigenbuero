#!/usr/bin/env node
/**
 * Ein-Schritt-Pipeline NACH dem Scrapen: aus den Roh-JSON-Dateien der drei
 * Portale direkt den fertigen Report bauen (normalisieren -> geocoden ->
 * filtern/bewerten -> Bilder einbetten -> HTML/Linkliste/result.json -> PDF).
 * Spart gegenüber den Einzelschritten mehrere Agenten-Durchläufe.
 *
 * Aufruf:
 *   node run-report.js <params.json> <outDir> \
 *        "mobile.de=raw-mobile.json" "autoscout24=raw-autoscout.json" \
 *        "kleinanzeigen=raw-kleinanzeigen.json"
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { normalizeAll } = require("./normalize.js");
const { applyGeocoding } = require("./geocode.js");
const { runPipeline } = require("./pipeline.js");
const { renderReport, inlineKorbImages } = require("./generate-report.js");

// fetch-portal.js liefert { portal, items, beschaffungsprotokoll }; die alten
// Apify-Rohdateien waren nackte Arrays. Beides wird HIER an genau einer Stelle
// entpackt - die restliche Pipeline bleibt unverändert.
function loadItems(file) {
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  return Array.isArray(j) ? j : (j.items || j.results || j.data || []);
}

// Beschaffungsprotokoll (falls vorhanden) für die Nachvollziehbarkeit im Report.
function loadProtokoll(file, quelle) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    const p = j && j.beschaffungsprotokoll;
    if (!p) return null;
    const getragen = (p.versuche || []).find((v) => v.ergebnis === "erfolg");
    return { ...p, portal: p.portal || quelle, kostenpflichtig: !!(getragen && getragen.kostenpflichtig) };
  } catch { return null; }
}

// Kandidatenpfade fuer Chrome/Chromium/Edge. Ausgelagert, damit die Liste
// pruefbar ist: die Windows-Pfade haben lange gefehlt, und das Ergebnis war ein
// "kein Chromium gefunden" auf Rechnern, auf denen Chrome installiert war.
function chromeKandidaten(env = process.env, plattform = process.platform) {
  const win = [
    env["PROGRAMFILES"] && env["PROGRAMFILES"] + "\\Google\\Chrome\\Application\\chrome.exe",
    env["PROGRAMFILES(X86)"] && env["PROGRAMFILES(X86)"] + "\\Google\\Chrome\\Application\\chrome.exe",
    env.LOCALAPPDATA && env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe",
    env["PROGRAMFILES(X86)"] && env["PROGRAMFILES(X86)"] + "\\Microsoft\\Edge\\Application\\msedge.exe",
    env["PROGRAMFILES"] && env["PROGRAMFILES"] + "\\Microsoft\\Edge\\Application\\msedge.exe",
    // Ohne gesetzte PROGRAMFILES-Variablen (etwa unter Git Bash) die ueblichen Orte.
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "chrome.exe", "msedge.exe",
  ];
  const mac = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ];
  const unix = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"];
  return [
    // Ausdrücklich gesetzter Pfad gewinnt (z. B. Container ohne System-Chrome).
    env.WBW_CHROME, env.CHROME_PATH, env.PUPPETEER_EXECUTABLE_PATH,
    ...(plattform === "win32" ? win : []),
    ...mac,
    ...unix,
    // Auch unter Git Bash/WSL kann ein Windows-Chrome erreichbar sein.
    ...(plattform === "win32" ? [] : win.filter((p) => typeof p === "string" && p.startsWith("C:"))),
  ].filter(Boolean);
}

function tryPdf(htmlPath, pdfPath) {
  const candidates = chromeKandidaten();
  const fileUrl = "file://" + encodeURI(path.resolve(htmlPath));
  const basis = ["--headless=new", "--disable-gpu", "--no-pdf-header-footer",
    `--print-to-pdf=${path.resolve(pdfPath)}`, "--virtual-time-budget=20000"];
  // Zweiter Versuch mit --no-sandbox: Chromium verweigert den Start als root
  // (Container/CI). Auf einem normalen Arbeitsplatz greift schon der erste Versuch,
  // dort wird die Sandbox also NICHT abgeschaltet.
  for (const bin of candidates.filter(Boolean)) {
    for (const extra of [[], ["--no-sandbox"]]) {
      try {
        execFileSync(bin, [...basis, ...extra, fileUrl], { stdio: "ignore", timeout: 90000 });
        if (fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 8000) return bin + (extra.length ? " (--no-sandbox)" : "");
      } catch { /* nächste Variante */ }
    }
  }
  return null;
}

async function main() {
  const [, , paramsPath, outDir = ".", ...srcArgs] = process.argv;
  if (!paramsPath) {
    console.error('Aufruf: node run-report.js <params.json> <outDir> "quelle=datei.json" ...');
    process.exit(1);
  }
  const params = JSON.parse(fs.readFileSync(paramsPath, "utf8"));

  const rawBySource = {};
  const beschaffung = [];
  for (const a of srcArgs) {
    const i = a.indexOf("="); if (i < 0) continue;
    const src = a.slice(0, i); const file = a.slice(i + 1);
    if (fs.existsSync(file)) {
      rawBySource[src] = loadItems(file);
      const p = loadProtokoll(file, src);
      if (p) beschaffung.push(p);
    } else console.warn(`Übersprungen (fehlt): ${file}`);
  }

  const fahrzeuge = normalizeAll(rawBySource);
  const geocodeStat = await applyGeocoding(fahrzeuge);
  const result = runPipeline({ ...params, fahrzeuge });
  result.beschaffung = beschaffung;
  const imgStat = await inlineKorbImages(result);
  const { html, linksMd } = renderReport(result);

  fs.mkdirSync(outDir, { recursive: true });
  const htmlPath = path.join(outDir, "WBW-Vergleichsfahrzeuge.html");
  const linksPath = path.join(outDir, "Linkliste.md");
  fs.writeFileSync(htmlPath, html, "utf8");
  fs.writeFileSync(linksPath, linksMd, "utf8");
  fs.writeFileSync(path.join(outDir, "result.json"), JSON.stringify(result, null, 2), "utf8");

  const pdfPath = path.join(outDir, "WBW-Vergleichsfahrzeuge.pdf");
  const pdfBin = tryPdf(htmlPath, pdfPath);

  const st = result.statistik;
  console.log(`Korb: ${st.imKorb} (mobile.de/AutoScout/Kleinanzeigen gemischt) · WBW-Vorschlag ${result.wbw.vorschlagBrutto ?? "n/a"} EUR`);
  console.log(`Bilder eingebettet: ${imgStat.eingebettet}/${imgStat.angefragt} · Geocoding: ${geocodeStat.gefuellt}/${geocodeStat.gesucht}`);
  for (const b of beschaffung) {
    console.log(`Beschaffung ${b.portal}: Stufe ${b.getrageneStufe || "keine"} · ${b.trefferGesamt} Treffer · ${b.ende}`);
  }
  console.log(`HTML:  ${htmlPath}`);
  console.log(`Links: ${linksPath}`);
  console.log(pdfBin ? `PDF:   ${pdfPath}` : `PDF:   (kein Chrome gefunden – die HTML ist druckfertig & selbsttragend, per Browser-Druck als PDF speicherbar)`);
}

// Nur beim direkten Aufruf laufen lassen - so ist chromeKandidaten() testbar,
// ohne dass ein require() gleich einen ganzen Report erzeugt.
if (require.main === module) main();

module.exports = { chromeKandidaten };
