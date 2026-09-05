/**
 * AutoScout24 — Stufe L0 (direkter Abruf der Suchseite).
 * ------------------------------------------------------------------
 * AutoScout24 rendert die Trefferliste serverseitig und legt sie als JSON
 * in <script id="__NEXT_DATA__"> ab. Alle hier verwendeten Feldpfade sind
 * gegen eine echte Antwort verifiziert (Fixture: tests/fixtures/autoscout24-*.json),
 * NICHT geraten.
 *
 * Verifizierte Erkenntnisse (Stand der Fixture):
 *   - Trefferliste:      props.pageProps.listings[]        (20 je Seite)
 *   - Gesamttreffer:     props.pageProps.numberOfResults
 *   - Preis:             price.priceRaw                    (NICHT prices.public.amountInEUR)
 *   - Kilometerstand:    tracking.mileage                  (sauberer als vehicle.mileageInKm)
 *   - Erstzulassung:     tracking.firstRegistration        ("01-2018")
 *   - Leistung:          vehicleDetails[ariaLabel=Leistung] ("81 kW (110 PS)")
 *   - PLZ/Ort:           location.zip / location.city
 *   - KEINE Koordinaten: die Liste enthält kein lat/lon -> geocode.js füllt per PLZ nach.
 *   - Ausstattung:       vehicle.subtitle (kommagetrennter Freitext)
 */
const { BROWSER_HEADERS, hole, pause, zahl, ez, ausstattung, dedupe, leeresFahrzeug } = require("./gemeinsam.js");

const BASIS = "https://www.autoscout24.de";
const QUELLE = "autoscout24";

/** Slug für den Pfad /lst/<marke>/<modell>. */
const slug = (s) => String(s || "").toLowerCase().trim().replace(/[\/\s]+/g, "-");

/**
 * Baut die Such-URL. Alle Parameter sind gegen die echte Seite geprüft:
 * fregfrom/fregto, kmfrom/kmto, zip/zipr und page wirken nachweislich.
 */
function bauSuchUrl(eingaben, seite = 1) {
  const a = (eingaben && eingaben.autoScout) || {};
  const abg = (eingaben && eingaben._abgeleitet) || {};
  const marke = slug(a.make);
  if (!marke) throw new Error("AutoScout24: keine Marke in search-inputs.json (autoScout.make)");
  const modell = slug(a.model);
  const pfad = modell ? `/lst/${marke}/${modell}` : `/lst/${marke}`;

  const p = new URLSearchParams();
  p.set("atype", "C");
  p.set("cy", "D");
  p.set("damaged_listing", "exclude");
  p.set("powertype", "kw");
  p.set("sort", "standard");
  p.set("desc", "0");
  p.set("ustate", "N,U");
  if (a.yearFrom != null) p.set("fregfrom", String(a.yearFrom));
  if (a.yearTo != null) p.set("fregto", String(a.yearTo));
  if (abg.kmfrom != null) p.set("kmfrom", String(abg.kmfrom));
  if (a.mileageTo != null) p.set("kmto", String(a.mileageTo));
  if (abg.plz) { p.set("zip", String(abg.plz)); p.set("zipr", String(abg.radius ?? 200)); }
  if (seite > 1) p.set("page", String(seite));
  return `${BASIS}${pfad}?${p.toString()}`;
}

/** Zieht das __NEXT_DATA__-JSON aus dem HTML. */
function findeNextData(html) {
  const m = String(html || "").match(/<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

/** Trefferliste aus dem geparsten __NEXT_DATA__. Leer statt Absturz. */
function findeListings(next) {
  const ls = next && next.props && next.props.pageProps && next.props.pageProps.listings;
  return Array.isArray(ls) ? ls : [];
}

/** Gesamttrefferzahl (nur informativ fürs Protokoll). */
function gesamtTreffer(next) {
  const n = next && next.props && next.props.pageProps && next.props.pageProps.numberOfResults;
  return Number.isFinite(n) ? n : null;
}

/** Wert aus vehicleDetails über das ariaLabel. */
function detail(l, label) {
  const d = (l && Array.isArray(l.vehicleDetails) ? l.vehicleDetails : [])
    .find((x) => x && String(x.ariaLabel || "").toLowerCase() === label.toLowerCase());
  return d ? d.data : null;
}

/** Ein Inserat -> kanonisches Fahrzeug. Unvollständige Inserate werden NICHT verworfen. */
function mappe(l, warnungen) {
  if (!l || typeof l !== "object") return null;
  const f = leeresFahrzeug(QUELLE);
  const v = l.vehicle || {};
  const t = l.tracking || {};

  f.id = l.id != null ? String(l.id) : (l.crossReferenceId != null ? String(l.crossReferenceId) : null);
  f.url = l.url ? (String(l.url).startsWith("http") ? String(l.url) : BASIS + String(l.url)) : null;
  f.titel = [v.make, v.model, v.modelVersionInput].filter(Boolean).join(" ").trim() || null;
  f.variante = v.modelVersionInput || v.variant || null;

  f.preis = zahl(l.price && l.price.priceRaw) ?? zahl(t.price) ?? zahl(l.price && l.price.priceFormatted);
  f.kilometerstand = zahl(t.mileage) ?? zahl(v.mileageInKm) ?? zahl(detail(l, "Kilometerstand"));
  f.erstzulassung = ez(t.firstRegistration, warnungen) ?? ez(detail(l, "Erstzulassung"), warnungen);
  f.leistungKw = zahl(detail(l, "Leistung"));
  f.getriebe = v.transmission || detail(l, "Getriebe") || null;
  f.kraftstoff = v.fuel || detail(l, "Kraftstoff") || null;
  // Die Trefferliste führt keine Karosserieform. bodyType bleibt leer; pipeline.js
  // leitet die Bauart dann aus dem Korb ab, statt hier etwas zu erfinden.
  f.fahrzeugtyp = null;
  f.tueren = null;

  const loc = l.location || {};
  f.plz = loc.zip != null ? String(loc.zip) : null;
  f.ort = loc.city || null;
  f.lat = null;
  f.lon = null;

  f.ausstattung = ausstattung(v.subtitle);
  f.bilder = (Array.isArray(l.images) ? l.images : []).filter((u) => typeof u === "string" && /^https?:\/\//.test(u));
  f.beschreibung = v.subtitle || null;
  return f;
}

/**
 * Holt bis `maxItems` Treffer über mehrere Seiten.
 * @returns {Promise<{items:object[], protokoll:object}>}
 */
async function holen(eingaben, opts = {}) {
  const maxItems = opts.maxItems ?? ((eingaben.autoScout && eingaben.autoScout.maxResults) || 60);
  // Ein ausdrücklich übergebenes maxSeiten gewinnt; sonst aus maxItems abgeleitet
  // (AutoScout24 liefert 20 Inserate je Seite). Harte Obergrenze als Bremse.
  const maxSeiten = Math.min(opts.maxSeiten ?? Math.max(1, Math.ceil(maxItems / 20)), 25);
  // Naht für Tests: ein eigener Holer erlaubt den Ratenlimit-Nachweis ohne Netz.
  const holeFn = opts.hole || hole;
  const pauseFn = opts.pause || pause;
  const warnungen = [];
  const abrufe = [];
  let items = [];
  let gesamt = null;

  for (let seite = 1; seite <= maxSeiten; seite++) {
    if (seite > 1) await pauseFn();
    const url = bauSuchUrl(eingaben, seite);
    const t0 = Date.now();
    const r = await holeFn(url, { headers: BROWSER_HEADERS });
    abrufe.push({ url, status: r.status, ms: Date.now() - t0, zeitpunkt: new Date().toISOString() });
    if (r.status !== 200) throw new Error(`AutoScout24 antwortete HTTP ${r.status} auf Seite ${seite}`);
    const next = findeNextData(r.body);
    if (!next) throw new Error(`AutoScout24: __NEXT_DATA__ nicht gefunden (Seite ${seite}) — Seitenaufbau geändert?`);
    if (gesamt == null) gesamt = gesamtTreffer(next);
    const ls = findeListings(next);
    if (!ls.length) break;
    for (const l of ls) { const f = mappe(l, warnungen); if (f) items.push(f); }
    if (items.length >= maxItems) break;
  }

  items = dedupe(items).slice(0, maxItems);
  return { items, protokoll: { abrufe, gesamtTrefferLautPortal: gesamt, warnungen } };
}

module.exports = { holen, bauSuchUrl, mappe, findeListings, findeNextData, gesamtTreffer, BASIS, QUELLE };
