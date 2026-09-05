#!/usr/bin/env node
/**
 * Baut aus den Apify-Rohdateien + Parametern das Pipeline-Input-JSON.
 *
 * Aufruf:
 *   node build-input.js <params.json> <out-input.json> \
 *        "mobile.de=raw-mobile.json" "autoscout24=raw-autoscout.json" "kleinanzeigen=raw-kleinanzeigen.json"
 *
 * Jede Rohdatei darf ein Array sein ODER ein Objekt mit { items|results|data: [...] }.
 */
const fs = require("fs");
const { normalizeAll } = require("./normalize.js");

const [, , paramsPath, outPath, ...srcArgs] = process.argv;
if (!paramsPath || !outPath) {
  console.error('Aufruf: node build-input.js <params.json> <out.json> "quelle=datei.json" ...');
  process.exit(1);
}

const params = JSON.parse(fs.readFileSync(paramsPath, "utf8"));
const rawBySource = {};
for (const a of srcArgs) {
  const i = a.indexOf("=");
  if (i < 0) continue;
  const src = a.slice(0, i);
  const file = a.slice(i + 1);
  if (!fs.existsSync(file)) { console.warn(`Übersprungen (fehlt): ${file}`); continue; }
  const j = JSON.parse(fs.readFileSync(file, "utf8"));
  rawBySource[src] = Array.isArray(j) ? j : (j.items || j.results || j.data || []);
}

const fahrzeuge = normalizeAll(rawBySource);
fs.writeFileSync(outPath, JSON.stringify({ ...params, fahrzeuge }, null, 2), "utf8");
console.log(`Normalisiert: ${fahrzeuge.length} Fahrzeuge aus [${Object.keys(rawBySource).join(", ")}] -> ${outPath}`);
