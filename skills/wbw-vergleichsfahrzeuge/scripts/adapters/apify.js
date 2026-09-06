/**
 * Stufe L3 — Apify. LETZTE Rückfallebene, KOSTENPFLICHTIG.
 * ------------------------------------------------------------------
 * Bleibt bewusst erhalten: die Eskalationskette hat nur Sinn, wenn die unterste
 * Ebene wirklich trägt. Die drei Actors sind dieselben wie vor der Umstellung
 * (siehe references/beschaffung.md).
 *
 * Kostenschutz: Dieses Modul verweigert den Lauf, solange WBW_ALLOW_PAID nicht
 * auf "1" steht. `npm test` setzt die Variable nicht — ein versehentlicher
 * kostenpflichtiger Lauf im normalen Testlauf schlägt damit fehl, statt Geld
 * zu kosten.
 *
 * Schnittstelle (Apify REST v2):
 *   POST /v2/acts/{actor}/run-sync-get-dataset-items?token=…&maxTotalChargeUsd=…
 *   Rumpf = das Actor-Input-Objekt, Antwort = das Dataset als JSON-Array.
 */
const { holeJson, zahl, ez, ausstattung, leeresFahrzeug, fehlendeZugangsdaten } = require("./gemeinsam.js");

const BASIS = "https://api.apify.com/v2";

function pruefeFreigabe() {
  if (process.env.WBW_ALLOW_PAID !== "1") {
    const e = new Error(
      "L3 Apify ist kostenpflichtig und gesperrt. Zum bewussten Freischalten " +
      "WBW_ALLOW_PAID=1 setzen (siehe TESTKONZEPT.md, Abschnitt 1)."
    );
    e.code = "L3_GESPERRT";
    throw e;
  }
}

function token() {
  const t = process.env.APIFY_TOKEN;
  if (!t) throw fehlendeZugangsdaten("L3 Apify", ["APIFY_TOKEN"]);
  return t;
}

/**
 * Rohdatensatz eines Apify-Actors -> kanonisches Fahrzeug.
 * Die Kandidatenlisten decken die Formate der drei bisher genutzten Actors ab;
 * normalize.js versteht daneben weiterhin die Apify-Rohformate direkt.
 */
function mappe(raw, quelle, warnungen) {
  if (!raw || typeof raw !== "object") return null;
  const g = (...pfade) => {
    for (const p of pfade) {
      const v = p.split(".").reduce((o, k) => (o == null ? undefined : o[k]), raw);
      if (v != null && v !== "") return v;
      if (raw[p] != null && raw[p] !== "") return raw[p];
    }
    return null;
  };
  const f = leeresFahrzeug(quelle);
  f.id = g("id", "listingId", "adId", "offerId", "adid") != null ? String(g("id", "listingId", "adId", "offerId", "adid")) : null;
  f.url = g("url", "canonicalUrl", "detailUrl", "link", "adUrl");
  f.titel = g("title", "name", "makeModel", "headline");
  f.variante = g("variant", "subTitle", "trimLevel", "modelVersion");
  f.preis = zahl(g("price.total.amount", "price.amount", "priceGross", "price", "priceValue"));
  f.kilometerstand = zahl(g("attributes.Mileage", "mileageKm", "mileage", "km", "kilometers"));
  f.erstzulassung = ez(g("attributes.First Registration", "firstRegistration", "firstRegistrationDate", "ez", "year"), warnungen);
  const p = g("attributes.Power", "powerKw", "power", "kw", "enginePower");
  f.leistungKw = zahl(p) != null && /ps/i.test(String(p)) && !/kw/i.test(String(p)) ? Math.round(zahl(p) / 1.35962) : zahl(p);
  f.getriebe = g("transmission", "gearbox");
  f.kraftstoff = g("fuel", "fuelType", "Kraftstoffart");
  f.fahrzeugtyp = g("bodyType", "vehicleType", "Fahrzeugtyp");
  f.tueren = g("doors", "numberOfDoors");
  f.plz = g("dealerDetails.addressStructured.zip", "location.zipcode", "zipCode", "zip", "plz");
  f.ort = g("location.city", "city", "ort");
  const la = g("dealerDetails.location.latitude", "location.latitude", "latitude", "lat");
  const lo = g("dealerDetails.location.longitude", "location.longitude", "longitude", "lon", "lng");
  f.lat = la != null ? Number(la) : null;
  f.lon = lo != null ? Number(lo) : null;
  f.ausstattung = ausstattung(g("features", "equipment", "options", "extras"));
  const b = g("images", "imageUrls", "photos", "pictures");
  f.bilder = Array.isArray(b) ? b.map((x) => (typeof x === "string" ? x : (x && (x.url || x.src)) || null)).filter(Boolean) : [];
  f.beschreibung = g("description", "descriptionText");
  if (f.plz != null) f.plz = String(f.plz);
  return f;
}

/** Führt den Actor synchron aus und liefert die Dataset-Items. */
async function holen(eingaben, opts = {}) {
  pruefeFreigabe();
  const actor = opts.actor;
  if (!actor) throw new Error("L3 Apify: kein Actor in providers.json hinterlegt");
  const inputKey = opts.inputKey;
  const input = inputKey ? eingaben[inputKey] : eingaben;
  if (!input) throw new Error(`L3 Apify: Eingabeblock "${inputKey}" fehlt in search-inputs.json`);

  const url = `${BASIS}/acts/${encodeURIComponent(actor.replace("/", "~"))}/run-sync-get-dataset-items`
    + `?token=${encodeURIComponent(token())}`
    + `&maxTotalChargeUsd=${encodeURIComponent(String(opts.maxTotalChargeUsd ?? 0.5))}`;
  const t0 = Date.now();
  const r = await holeJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    timeoutMs: opts.timeoutMs ?? 600000,
  });
  if (r.status < 200 || r.status >= 300) throw new Error(`L3 Apify: HTTP ${r.status} für Actor ${actor}`);
  const roh = Array.isArray(r.daten) ? r.daten : [];
  const warnungen = [];
  const items = roh.map((x) => mappe(x, opts.quelle || "apify", warnungen)).filter(Boolean);
  return {
    items,
    protokoll: {
      abrufe: [{ url: `${BASIS}/acts/${actor}/run-sync-get-dataset-items`, status: r.status, ms: Date.now() - t0, zeitpunkt: new Date().toISOString() }],
      actor, maxTotalChargeUsd: opts.maxTotalChargeUsd ?? 0.5, rohTreffer: roh.length, warnungen,
      kostenpflichtig: true,
    },
    roh,
  };
}

module.exports = { holen, mappe, pruefeFreigabe, BASIS };
