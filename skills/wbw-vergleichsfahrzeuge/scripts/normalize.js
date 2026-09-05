/**
 * Normalisierung der Apify-Rohdaten -> gemeinsames Fahrzeug-Schema
 * ------------------------------------------------------------------
 * Die drei Portal-Scraper liefern unterschiedlich strukturierte
 * Objekte. Dieses Modul bildet sie defensiv (viele Feld-Kandidaten,
 * Fallbacks) auf das Schema ab, das geo-filter.js / dedup-fahrzeuge.js /
 * ausstattung-matcher.js erwarten (mobile.de-ähnlich):
 *
 *   { id, source, url, title, model,
 *     price: { total: { amount } },
 *     attributes: { Mileage, "First Registration", Power, Climatisation },
 *     features: [], description, dealerDetails: { location: { latitude, longitude } } }
 *
 * Stimmen Feldnamen eines Actors nicht (neue Scraper-Version), nur die
 * Kandidatenlisten unten ergänzen – siehe references/datenschema.md.
 *
 * Seit der Adapterschicht (fetch-portal.js) kommen zusätzlich die KANONISCHEN
 * Feldnamen der Adapter an (preis, kilometerstand, erstzulassung, leistungKw,
 * getriebe, kraftstoff, fahrzeugtyp, tueren, plz, ort, lat, lon, ausstattung,
 * bilder, titel, variante, beschreibung). Sie stehen jeweils am ENDE der
 * Kandidatenlisten: die alten Apify-Rohformate gewinnen weiterhin zuerst und
 * normalisieren unverändert weiter.
 */

// Robuste Ganzzahl: nimmt die ERSTE Zahlengruppe und behandelt Tausender-/
// Dezimaltrenner korrekt. Beispiele:
//   "110 kW (150 hp)" -> 110   (nicht 110150!)
//   "62,500 km"       -> 62500 (Tausenderkomma)
//   "14490.00"        -> 14490 (Dezimal)
//   21950 (number)    -> 21950
function num(v) {
  if (v == null) return null;
  if (typeof v === "number") return Math.round(v);
  const m = String(v).match(/\d[\d.,]*/);
  if (!m) return null;
  let t = m[0];
  if (/^\d+[.,]\d{1,2}$/.test(t)) return Math.round(parseFloat(t.replace(",", ".")));
  t = t.replace(/[.,]/g, "");
  return t ? parseInt(t, 10) : null;
}

// Erste 5-stellige PLZ aus einem Freitext ("..., 40789 Monheim, DE").
function plzFromText(s) {
  const m = String(s || "").match(/\b\d{5}\b/);
  return m ? m[0] : null;
}
function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function pick(obj, paths) {
  for (const p of paths) {
    // Erst flach (Apify-Projektionen liefern Keys mit Punkt, z. B. "entity.title"),
    // dann verschachtelt (volle Datasets liefern echte Objekte).
    let v = (obj != null && typeof obj === "object" && obj[p] != null) ? obj[p] : getPath(obj, p);
    if (v != null && v !== "") return v;
  }
  return null;
}
function asArray(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.flatMap(asArray);
  if (typeof v === "object") return Object.values(v).flatMap(asArray);
  return [String(v)];
}

// Bild-URL extern lad­bar machen. mobile.de liefert Proxy-URLs
// ("m.mobile.de/yams-proxy/img.classistatic.de/…") -> liefern extern 403.
// Direkt auf img.classistatic.de mit Größen-Regel zeigen (liefert 200).
function fixImageUrl(u) {
  let s = String(u);
  const yi = s.indexOf("/yams-proxy/");
  if (yi !== -1) s = "https://" + s.slice(yi + "/yams-proxy/".length);
  if (/img\.classistatic\.de\/api\//.test(s) && !s.includes("?")) s += "?rule=mo-640";
  // AutoScout liefert per Default webp; die .jpg-Variante des Transforms ist
  // breiter kompatibel (nicht jeder PDF-Konverter rendert webp/avif).
  if (/autoscout24\.net\//.test(s)) s = s.replace(/\.webp(\?|$)/i, ".jpg$1");
  return s;
}

// Bild-URLs robust aus Strings oder Objekten ({url|src|href|large|…}) ziehen.
function asImageUrls(v) {
  if (v == null) return [];
  const arr = Array.isArray(v) ? v : [v];
  const out = [];
  for (const it of arr) {
    if (typeof it === "string") { if (it.trim()) out.push(it.trim()); }
    else if (it && typeof it === "object") {
      const u = it.url || it.src || it.href || it.large || it.xxl || it.xl || it.medium
        || it.uri || it.imageUrl || it.original || it.full;
      if (u) out.push(String(u));
    }
  }
  return out.filter((u) => /^https?:\/\//.test(u)).map(fixImageUrl);
}

// EZ -> Vergleichswert (Jahr als Dezimal). Erkennt ISO ("2020-07-01"),
// "MM/YYYY" ("06/2021" -> 2021.42) und reine Jahreszahlen.
function ezToYear(ez) {
  if (ez == null) return null;
  const s = String(ez);
  let m = s.match(/(\d{4})-(\d{1,2})(?!\d)/);      // ISO 2020-07-01 / 2020-7
  if (m) return parseInt(m[1], 10) + (parseInt(m[2], 10) - 1) / 12;
  m = s.match(/(\d{1,2})[\/.\-](\d{4})/);          // MM/YYYY, MM.YYYY, MM-YYYY
  if (m) return parseInt(m[2], 10) + (parseInt(m[1], 10) - 1) / 12;
  // Deutscher Monatsname + Jahr ("Mai 2024" -> 2024.33), z. B. Kleinanzeigen.
  const MONATE = { januar: 1, februar: 2, "märz": 3, maerz: 3, april: 4, mai: 5, juni: 6,
    juli: 7, august: 8, september: 9, oktober: 10, november: 11, dezember: 12 };
  const mn = s.toLowerCase().match(/(januar|februar|märz|maerz|april|mai|juni|juli|august|september|oktober|november|dezember)\s+((?:19|20)\d{2})/);
  if (mn) return parseInt(mn[2], 10) + (MONATE[mn[1]] - 1) / 12;
  const y = s.match(/(19|20)\d{2}/);
  return y ? parseInt(y[0], 10) : null;
}

function normalizeOne(raw, source) {
  const url = pick(raw, ["url", "canonicalUrl", "sourceUrl", "portalUrl", "product.url", "entity.url",
    "source_context.canonical_url", "link", "detailUrl", "adUrl", "vehicleUrl", "seoUrl", "href", "offerUrl"]);
  const id = pick(raw, ["id", "listingId", "adId", "offerId", "mobileAdId", "product.listing_id",
    "record_id", "guid"]) ?? url;
  const makeModel = [pick(raw, ["make", "product.attributes.Marke"]),
    pick(raw, ["model", "product.attributes.Modell"])].filter(Boolean).join(" ").trim();
  const title = pick(raw, ["title", "entity.title", "name", "entity.name", "makeModel", "headline", "subject", "titel"]) || makeModel;
  const model = title || pick(raw, ["model", "modelDescription"]) || makeModel;
  // Ausstattungslinie/Trim steckt je Portal woanders: AutoScout in `variant`/Titel,
  // mobile.de im `subTitle` (trimLevel/series sind dort oft leer), Kleinanzeigen im Titel.
  const variant = pick(raw, ["variant", "subTitle", "trimLevel", "series", "modelVersion", "variante"]);
  // Karosserie/Bauart je Portal: blackfalcondata `bodyType`, Kleinanzeigen `Fahrzeugtyp`.
  const bodyType = pick(raw, ["bodyType", "vehicleType", "product.attributes.Fahrzeugtyp",
    "attributes.listing_attributes.Fahrzeugtyp", "bodyTypeRaw", "segment", "fahrzeugtyp"]);
  // Getriebe: blackfalcondata `transmission`, Kleinanzeigen `Getriebe`.
  const transmission = pick(raw, ["transmission", "product.attributes.Getriebe",
    "attributes.listing_attributes.Getriebe", "gearbox", "transmissionRaw", "getriebe"]);
  // Türenzahl: mobile.de `doors`, AutoScout `numberOfDoors`, Kleinanzeigen `Anzahl Türen`
  // (kann ein Bereich sein, z. B. "4/5"); roh gespeichert, Auswertung in pipeline.js.
  const tueren = pick(raw, ["doors", "numberOfDoors", "product.attributes.Anzahl Türen",
    "attributes.listing_attributes.Anzahl Türen", "doorCount", "numDoors", "tueren"]);
  const price = num(pick(raw, ["price.total.amount", "price.amount", "price.gross", "priceGross",
    "pricing.price", "price", "priceValue", "amount", "preis"]));
  const mileage = num(pick(raw, ["attributes.Mileage", "mileageKm", "product.attributes.Kilometerstand",
    "attributes.listing_attributes.Kilometerstand", "mileage", "km", "kilometers", "odometer", "mileageValue", "kilometerstand"]));
  const ez = pick(raw, ["attributes.First Registration", "firstRegistration", "firstRegistrationDate",
    "product.attributes.Erstzulassung", "attributes.listing_attributes.Erstzulassung",
    "ez", "registration", "yearMonth", "constructionYear", "year", "erstzulassung"]);
  // Leistung: blackfalcondata liefert kW (Zahl), Kleinanzeigen "150 PS" -> in kW umrechnen.
  const powerRaw = pick(raw, ["attributes.Power", "powerKw", "power", "kw", "enginePower", "powerValue",
    "product.attributes.Leistung", "attributes.listing_attributes.Leistung", "leistungKw"]);
  let power = num(powerRaw);
  if (power != null && /ps/i.test(String(powerRaw)) && !/kw/i.test(String(powerRaw))) {
    power = Math.round(power / 1.35962); // PS -> kW
  }
  const climatisation = pick(raw, ["attributes.Climatisation", "climatisation", "airConditioning",
    "climate", "klima"]);
  const description = pick(raw, ["description", "descriptionText", "product.description",
    "fullDescription", "text", "details", "beschreibung"]) ?? "";
  const features = asArray(pick(raw, ["features", "equipment", "equipments", "options",
    "product.attributes.Ausstattung", "attributes.listing_attributes.Ausstattung",
    "attributesList", "highlights", "extras", "ausstattung"]));
  let images = asImageUrls(pick(raw, ["images", "imageURLs", "imageUrls", "media.image_urls", "media", "photos",
    "pictures", "gallery", "imageList", "imgUrls", "bilder"]));
  if (!images.length) {
    images = asImageUrls(pick(raw, ["previewImage", "primaryImageURL", "media.primary_image_url",
      "media.main_image_url", "image", "mainImage", "mainImageUrl", "thumbnail", "thumbnailUrl",
      "imageUrl", "titleImage"]));
  }
  const lat = pick(raw, ["dealerDetails.location.latitude", "sellerLatitude", "location.latitude",
    "location.lat", "seller.location.latitude", "latitude", "lat", "geo.lat", "coordinates.latitude"]);
  const lon = pick(raw, ["dealerDetails.location.longitude", "sellerLongitude", "location.longitude",
    "location.lon", "location.lng", "seller.location.longitude", "longitude", "lon", "lng",
    "geo.lon", "coordinates.longitude"]);
  let zip = pick(raw, ["dealerDetails.addressStructured.zip", "dealerDetails.location.zipcode",
    "location.zipcode", "location.zip", "location.postalCode", "location.postal_code", "zipCode",
    "zip", "postalCode", "plz", "seller.zipCode"]);
  // Fallback: PLZ aus einer Adress-Freitextzeile ziehen.
  if (zip == null) {
    zip = plzFromText(pick(raw, ["dealerDetails.address", "address", "location.display_location",
      "location.city", "sellerAddress"]));
  }

  return {
    id: String(id ?? ""),
    source,
    url: url ?? null,
    title, model,
    variant: variant ?? null,
    bodyType: bodyType ?? null,
    getriebe: transmission ?? null,
    tueren: tueren ?? null,
    price: { total: { amount: price } },
    attributes: {
      Mileage: mileage,
      "First Registration": ez ?? null,
      Power: power,
      Climatisation: climatisation ?? null,
    },
    mileage,
    ez: ez ?? null,
    _ezYear: ezToYear(ez),
    power,
    climatisation: climatisation ?? null,
    features,
    description,
    image: images[0] || null,
    images,
    zip: zip != null ? String(zip) : null,
    dealerDetails: {
      location: {
        latitude: lat != null ? Number(lat) : null,
        longitude: lon != null ? Number(lon) : null,
      },
    },
  };
}

/**
 * @param {object} rawBySource z.B. { "mobile.de": [...], "autoscout24": [...], "kleinanzeigen": [...] }
 */
function normalizeAll(rawBySource) {
  const out = [];
  for (const [source, items] of Object.entries(rawBySource || {})) {
    for (const raw of (items || [])) out.push(normalizeOne(raw, source));
  }
  return out;
}

module.exports = { normalizeAll, normalizeOne, ezToYear };
