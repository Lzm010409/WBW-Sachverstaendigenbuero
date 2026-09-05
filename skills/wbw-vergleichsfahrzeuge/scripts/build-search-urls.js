#!/usr/bin/env node
/**
 * Baut DETERMINISTISCH die Such-Eingaben für die drei Apify-Actors aus
 * params.json und schreibt search-inputs.json:
 *
 *   - mobileDe      : strukturiertes Input-Objekt (Actor blackfalcondata/mobile-de-scraper).
 *                     Native zipCode/radiusKm + includeDetails (Ausstattung/Beschreibung/GPS).
 *   - autoScout     : strukturiertes Input-Objekt (Actor blackfalcondata/autoscout24-scraper).
 *                     make/model-Slug, countries:["DE"], includeDetails (+ GPS); kein
 *                     PLZ-Umkreis am Actor -> Geo wird in pipeline.js per Luftlinie gefiltert.
 *   - kleinanzeigen : strukturiertes Input-Objekt (Actor fatihtahta/ebay-kleinanzeigen-scraper).
 *                     car_make/car_model + Jahr/km-Filter + enrich_data (km/EZ/Leistung/
 *                     Fahrzeugtyp/PLZ+GPS/Ausstattung/Bilder).
 *
 * Aufruf: node build-search-urls.js <params.json> <search-inputs.json>
 */
const fs = require("fs");

// Marken-Schreibweise für AutoScout24-URL-Slug (lowercase) und mobile.de.
const MARKEN_SLUG = {
  vw: "volkswagen", volkswagen: "volkswagen",
  mercedes: "mercedes-benz", "mercedes benz": "mercedes-benz", "mercedes-benz": "mercedes-benz",
  bmw: "bmw", audi: "audi", opel: "opel", ford: "ford", skoda: "skoda", seat: "seat",
  toyota: "toyota", renault: "renault", peugeot: "peugeot", fiat: "fiat", hyundai: "hyundai",
  kia: "kia", mazda: "mazda", nissan: "nissan", volvo: "volvo", mini: "mini",
};
// mobile.de erwartet im models-Feld die Portal-Schreibweise der Marke ("BMW|328").
const MARKEN_MOBILE = {
  volkswagen: "VW", "mercedes-benz": "Mercedes-Benz", bmw: "BMW", audi: "Audi",
  opel: "Opel", ford: "Ford", skoda: "Skoda", seat: "Seat", toyota: "Toyota",
  renault: "Renault", peugeot: "Peugeot", fiat: "Fiat", hyundai: "Hyundai",
  kia: "Kia", mazda: "Mazda", nissan: "Nissan", volvo: "Volvo", mini: "MINI",
};

// Vom Kleinanzeigen-Actor (fatihtahta) unterstützte Marken (car_make-Enum).
// Passt der Marken-Slug nicht hierein, läuft die Suche nur über das Stichwort.
const KLEINANZEIGEN_MAKES = new Set(["audi", "bmw", "mercedes_benz", "volkswagen", "opel",
  "ford", "skoda", "renault", "seat", "peugeot", "fiat", "hyundai", "toyota", "nissan",
  "mazda", "tesla"]);

function num(v) { if (v == null) return null; const m = String(v).replace(/[^\d]/g, ""); return m ? parseInt(m, 10) : null; }
function jahr(ez) { const m = String(ez || "").match(/(19|20)\d{2}/); return m ? parseInt(m[0], 10) : null; }
function markeSlug(marke) { const k = String(marke || "").toLowerCase().trim(); return MARKEN_SLUG[k] || k.replace(/\s+/g, "-"); }
function modellSlug(modell) { return String(modell || "").toLowerCase().trim().replace(/[\/\s]+/g, "-"); }

function build(params) {
  const s = params.subject || {};
  const y = jahr(s.ez);
  const ezTol = params.ezToleranzJahre ?? 1;
  const kmTol = params.kmToleranz ?? 25000;
  const km = num(s.mileage);
  const fregfrom = y != null ? y - ezTol : null;
  const fregto   = y != null ? y + ezTol : null;
  const kmfrom   = km != null ? Math.max(0, km - kmTol) : null;
  const kmto     = km != null ? km + kmTol : null;
  const plz = params.plz ? String(params.plz) : null;
  const radius = params.radiusKm ?? 200;
  const maxItems = params.maxItemsProPortal ?? 60;

  const mkSlug = markeSlug(s.marke);
  const mdSlug = modellSlug(s.modell);

  const keyword = [s.marke, s.modell].filter(Boolean).join(" ").trim();

  // ---- mobile.de: blackfalcondata/mobile-de-scraper (strukturiert + PLZ-Umkreis) ----
  // Freitext-`query` (robust) + strukturierte Filter inkl. nativem zipCode/radiusKm.
  // `includeDetails` liefert Ausstattung, Beschreibung und GPS-Koordinaten.
  const mobileDe = {
    query: keyword,
    category: "CAR",
    ...(fregfrom != null ? { yearMin: fregfrom } : {}),
    ...(fregto != null ? { yearMax: fregto } : {}),
    ...(kmfrom != null ? { mileageMin: kmfrom } : {}),
    ...(kmto != null ? { mileageMax: kmto } : {}),
    ...(plz ? { zipCode: plz, radiusKm: radius } : {}),
    maxResults: maxItems,
    includeDetails: true,
    sort: "relevance",
  };

  // ---- AutoScout24: blackfalcondata/autoscout24-scraper (strukturiert) ----
  // make/model als URL-Slug, Land DE. Kein PLZ-Radius am Actor -> bundesweit;
  // der Geo-Bezug kommt über die mitgelieferten GPS-Koordinaten + Luftlinien-
  // Filter in `pipeline.js`. `includeDetails` liefert Ausstattung + GPS.
  const autoScout = {
    make: mkSlug,
    model: mdSlug,
    countries: ["DE"],
    ...(fregfrom != null ? { yearFrom: fregfrom } : {}),
    ...(fregto != null ? { yearTo: fregto } : {}),
    ...(kmto != null ? { mileageTo: kmto } : {}),
    maxResults: maxItems,
    includeDetails: true,
    // Residential-Proxy: AutoScout blockt Datacenter-IPs auf Detailseiten und
    // liefert sonst stillschweigend leere Detailfelder (GPS/Ausstattung/kW).
    proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ["RESIDENTIAL"] },
  };

  // ---- Kleinanzeigen: fatihtahta/ebay-kleinanzeigen-scraper (strukturiert, auto-spezifisch).
  // Liefert km/EZ/Leistung/Fahrzeugtyp + PLZ & GPS-Koordinaten + Ausstattung + Bilder
  // (enrich_data). Kein PLZ-Umkreis am Actor -> bundesweit, Umkreis per GPS in pipeline.js.
  // car_make ist ein Enum; passt der Slug nicht, nur über die Stichwortsuche (queries).
  const kaMake = mkSlug.replace(/-/g, "_");
  const kleinanzeigen = {
    queries: [keyword],
    category: "216", // Autos
    ...(KLEINANZEIGEN_MAKES.has(kaMake) ? { car_make: kaMake } : {}),
    ...(s.modell ? { car_model: String(s.modell) } : {}),
    ...(fregfrom != null ? { min_first_registration_year: fregfrom } : {}),
    ...(fregto != null ? { max_first_registration_year: fregto } : {}),
    ...(kmfrom != null ? { min_mileage: kmfrom } : {}),
    ...(kmto != null ? { max_mileage: kmto } : {}),
    enrich_data: true,
    limit: maxItems,
  };

  return {
    mobileDe, autoScout, kleinanzeigen,
    // Von der Adapterschicht (fetch-portal.js) genutzt: AutoScout24 baut daraus
    // seinen PLZ-Umkreis, Kleinanzeigen den Standort-Radius.
    _abgeleitet: { jahr: y, fregfrom, fregto, kmfrom, kmto, plz, radius,
      kleinanzeigenLocId: params.kleinanzeigenLocId ?? null },
  };
}

function main() {
  const [, , inPath, outPath] = process.argv;
  if (!inPath || !outPath) {
    console.error("Aufruf: node build-search-urls.js <params.json> <search-inputs.json>");
    process.exit(1);
  }
  const out = build(JSON.parse(fs.readFileSync(inPath, "utf8")));
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), "utf8");
  console.log("mobile.de    :", JSON.stringify(out.mobileDe));
  console.log("AutoScout24  :", JSON.stringify(out.autoScout));
  console.log("Kleinanzeigen:", JSON.stringify(out.kleinanzeigen));
}

if (require.main === module) main();
module.exports = { build };
