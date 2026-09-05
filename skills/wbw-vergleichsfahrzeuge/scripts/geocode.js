#!/usr/bin/env node
/**
 * Geocoding der Vergleichsfahrzeuge.
 * ------------------------------------------------------------------
 * Wichtig: AutoScout24 und Kleinanzeigen liefern KEINE Koordinaten, nur
 * eine PLZ (bzw. eine Adresszeile mit PLZ). Ohne Koordinaten würden diese
 * Fahrzeuge im Geo-Filter aussortiert -> es bliebe faktisch nur mobile.de.
 *
 * Dieses Modul füllt für Fahrzeuge OHNE lat/lon, aber MIT PLZ (`zip`), die
 * Koordinaten nach. Reihenfolge der Quellen:
 *
 *   1. zippopotam.us  — schnell, parallelisierbar, keine Auflagen.
 *   2. Nominatim/OSM  — Rückfall, sequenziell mit >= 1 s Abstand (Nutzungsregeln).
 *   3. 2-stellige PLZ-Region aus geo-filter.js — grober letzter Rückfall.
 *
 * Warum zwei Quellen: zippopotam liefert für ganze PLZ-Regionen VERSCHOBENE
 * Datensätze — `latitude` enthält dann den Gemeindeschlüssel (z. B. "05113" für
 * Essen), `longitude` die tatsächliche Breite, und die Länge fehlt ganz.
 * Betroffen sind unter anderem 42xxx, 45xxx, 50xxx, 51xxx und 65xxx, also
 * ausgerechnet der Rhein-Ruhr-Raum. Die Plausibilitätsprüfung unten verwirft
 * solche Sätze zu Recht — ohne zweite Quelle landete damit rund ein Viertel des
 * Vergleichskorbs in "ohne Koordinaten" und fiele aus dem Umkreisfilter.
 *
 * Als CLI:  node geocode.js <input.json> <output.json>
 * Als Modul: const { applyGeocoding } = require("./geocode.js");
 *            await applyGeocoding(fahrzeuge);
 */
const fs = require("fs");
const { PLZ_ZENTREN } = require("./geo-filter.js");

// Grobe Deutschland-Bounding-Box zur Plausibilitätsprüfung (zippopotam liefert
// vereinzelt korrupte Werte, z. B. latitude "05112").
function plausibelDE(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon)
    && lat >= 47 && lat <= 55.2 && lon >= 5.5 && lon <= 15.5;
}

// JSON über das eingebaute https-Modul holen (unabhängig von globalem fetch,
// das in älteren Node-Builds fehlt).
function getJson(url, timeoutMs = 12000, extraHeaders = {}) {
  return new Promise((resolve) => {
    let lib, u;
    try { u = new URL(url); lib = u.protocol === "http:" ? require("http") : require("https"); }
    catch { return resolve(null); }
    // Hinter einem Unternehmens-/Agenten-Proxy liest Nodes https-Modul die
    // HTTPS_PROXY-Variable NICHT von selbst. Ohne diesen Agenten schlägt das
    // Geocoding dort still fehl -> fast alle Fahrzeuge landen in
    // "ohne Koordinaten" und fallen aus dem Umkreis. Ohne Proxy ist es ein No-op.
    let agent;
    try { agent = u.protocol === "https:" ? require("./adapters/gemeinsam.js").proxyAgent() : undefined; } catch { agent = undefined; }
    const req = lib.get(u, { headers: { accept: "application/json", "user-agent": "Mozilla/5.0", ...extraHeaders }, timeout: timeoutMs, agent }, (res) => {
      if ((res.statusCode || 0) !== 200) { res.resume(); return resolve(null); }
      let body = "";
      res.on("data", (c) => { body += c; if (body.length > 1_000_000) req.destroy(); });
      res.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
      res.on("error", () => resolve(null));
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

async function geocodeOne(plz) {
  const data = await getJson(`https://api.zippopotam.us/de/${encodeURIComponent(plz)}`);
  if (!data) return null;
  const p = (data.places || [])[0];
  if (!p) return null;
  const lat = Number(p.latitude), lon = Number(p.longitude);
  if (!plausibelDE(lat, lon)) return null; // korrupte Antwort -> Rückfall greift
  return { lat, lon };
}

// Rückfallquelle: Nominatim (OpenStreetMap). Die Nutzungsregeln verlangen einen
// aussagekräftigen User-Agent und höchstens eine Anfrage pro Sekunde - deshalb
// wird diese Quelle streng sequenziell und nur für die Reste angefragt.
const NOMINATIM_PAUSE_MS = 1100;
const UA = "WBW-Vergleichsfahrzeug-Finder (Kfz-Sachverstaendigenbuero Gollenstede)";

async function geocodeOneNominatim(plz) {
  const data = await getJson(
    `https://nominatim.openstreetmap.org/search?postalcode=${encodeURIComponent(plz)}&country=de&format=json&limit=1`,
    12000, { "user-agent": UA });
  const p = Array.isArray(data) ? data[0] : null;
  if (!p) return null;
  const lat = Number(p.lat), lon = Number(p.lon);
  if (!plausibelDE(lat, lon)) return null;
  return { lat, lon };
}

const schlaf = (ms) => new Promise((r) => setTimeout(r, ms));

async function geocodeZips(zips, { concurrency = 5, cache = new Map(), nominatim = true } = {}) {
  const todo = [...new Set(zips.filter(Boolean).map(String))].filter((z) => !cache.has(z));
  const rest = [];
  let i = 0;
  async function worker() {
    while (i < todo.length) {
      const z = todo[i++];
      const r = await geocodeOne(z);
      if (r) cache.set(z, r); else rest.push(z);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) || 1 }, worker));

  // Zweite Runde: nur die, die zippopotam nicht plausibel beantwortet hat.
  for (const z of rest) {
    let r = null;
    if (nominatim) {
      r = await geocodeOneNominatim(z);
      await schlaf(NOMINATIM_PAUSE_MS);
    }
    if (!r) {
      const f = PLZ_ZENTREN[z.slice(0, 2)];
      if (f) r = { lat: f.lat, lon: f.lon, approx: true };
    }
    cache.set(z, r);
  }
  return cache;
}

/**
 * Füllt dealerDetails.location für Fahrzeuge ohne Koordinaten, aber mit PLZ.
 * Mutiert die Objekte in `fahrzeuge`. @returns { gefuellt, gesucht }
 */
async function applyGeocoding(fahrzeuge, opts = {}) {
  const need = (fahrzeuge || []).filter((f) =>
    (f.dealerDetails?.location?.latitude == null || f.dealerDetails?.location?.longitude == null)
    && f.zip);
  const cache = await geocodeZips(need.map((f) => f.zip), opts);
  let gefuellt = 0;
  for (const f of need) {
    const r = cache.get(String(f.zip));
    if (r) {
      f.dealerDetails = f.dealerDetails || {};
      f.dealerDetails.location = { latitude: r.lat, longitude: r.lon };
      if (r.approx) f._geoApprox = true;
      gefuellt++;
    }
  }
  return { gefuellt, gesucht: need.length };
}

async function main() {
  const [, , inPath, outPath] = process.argv;
  if (!inPath || !outPath) {
    console.error("Aufruf: node geocode.js <input.json> <output.json>");
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(inPath, "utf8"));
  const stat = await applyGeocoding(cfg.fahrzeuge || []);
  fs.writeFileSync(outPath, JSON.stringify(cfg, null, 2), "utf8");
  console.log(`Geocoding: ${stat.gefuellt}/${stat.gesucht} Fahrzeuge per PLZ verortet -> ${outPath}`);
}

if (require.main === module) main();
module.exports = { applyGeocoding, geocodeZips, geocodeOneNominatim, plausibelDE };
