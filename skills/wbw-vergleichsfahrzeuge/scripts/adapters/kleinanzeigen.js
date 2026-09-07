/**
 * Kleinanzeigen — Stufe L1 (eigener Dienst auf Coolify).
 * ------------------------------------------------------------------
 * Nutzt DanielWTE/ebay-kleinanzeigen-api (unverändert, Commit-gepinnt).
 * Der Dienst läuft auf der Infrastruktur des Büros; der direkte Zugriff auf
 * kleinanzeigen.de aus fremden Netzen wird von Kleinanzeigen IP-gesperrt.
 *
 * Verifiziert an echten Antworten (Fixtures: tests/fixtures/kleinanzeigen-*.json):
 *   - GET  /                       -> Statusobjekt. EIN /health GIBT ES NICHT (404).
 *   - POST /inserate-by-url        -> {success, results[], unique_results, ...}
 *        results[]: adid, url, title, price, location, description, published_at
 *        ACHTUNG: `price` ist in der Liste regelmäßig LEER -> Preis kommt aus dem Detail.
 *        Weder Kilometerstand noch Erstzulassung stehen in der Liste.
 *   - GET  /inserat/{adid}?batch_id=...   (batch_id ist PFLICHT, sonst HTTP 422)
 *        data.details (Labels kommen aus dem DOM, hier real beobachtet):
 *          Marke, Modell, Kilometerstand ("42.536 km"), Fahrzeugzustand,
 *          Erstzulassung ("Oktober 2022" — deutscher Monatsname!),
 *          Kraftstoffart, Leistung ("65 PS" — PS, NICHT kW!), Getriebe,
 *          Fahrzeugtyp, "Anzahl Türen" ("4/5"), Außenfarbe, …
 *        data.price = {amount:"10500", currency:"€", negotiable:false}
 *        data.location = {zip, city, state}  -> KEINE Koordinaten (geocode.js füllt nach)
 *        data.features = Liste von Strings (Ausstattung)
 */
const { holeJson, pause, zahl, ez, ausstattung, dedupe, leeresFahrzeug, fehlendeZugangsdaten } = require("./gemeinsam.js");

const QUELLE = "kleinanzeigen";
const PORTAL = "https://www.kleinanzeigen.de";

// Standardadresse des eigenen Dienstes. Kein Geheimnis (steht in .env.example und
// im README); nur die Zugangsdaten sind vertraulich. Der Standardwert nimmt einer
// Cloud-Umgebung eine Variable ab: dort muessen nur noch KA_API_USER und
// KA_API_PASS gesetzt werden. KA_API_BASE bleibt fuer Testadressen ueberschreibbar.
const KA_API_BASE_STANDARD = "https://ka-api.gollenstede.app";

const slug = (s) => String(s || "").toLowerCase().trim()
  .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * Baut die Kleinanzeigen-Such-URL. Die Filter stehen bei Kleinanzeigen im PFAD,
 * nicht in der Query: `c216` (Kategorie Autos) plus `+autos.<feld>:<wert>`.
 * Der Dienst hängt die Seitenzahl selbst an.
 */
function bauSuchUrl(eingaben) {
  const k = (eingaben && eingaben.kleinanzeigen) || {};
  const abg = (eingaben && eingaben._abgeleitet) || {};
  const teile = ["c216"];
  const marke = slug(k.car_make ? String(k.car_make).replace(/_/g, "-") : "");
  const modell = slug(k.car_model);
  if (marke) teile.push(`autos.marke_s:${marke}`);
  if (modell) teile.push(`autos.model_s:${modell}`);
  if (k.min_first_registration_year != null && k.max_first_registration_year != null) {
    teile.push(`autos.ez_i:${k.min_first_registration_year},${k.max_first_registration_year}`);
  }
  if (k.min_mileage != null && k.max_mileage != null) {
    teile.push(`autos.km_i:${k.min_mileage},${k.max_mileage}`);
  }
  // Umkreis: Kleinanzeigen akzeptiert `locationStr` (PLZ ODER Ortsname) zusammen
  // mit `radius` als Query-Parameter - an einer echten Antwort verifiziert: mit
  // locationStr=47798&radius=200 verschiebt sich die PLZ-Verteilung der Treffer
  // deutlich in den Umkreis, ohne die Parameter ist die Suche bundesweit.
  // Ist zusätzlich eine numerische Standort-ID hinterlegt, wird die genauere
  // Pfadform `c216l<id>r<radius>` verwendet. Ohne beides wird NICHTS geraten.
  const loc = abg.kleinanzeigenLocId;
  const radius = abg.radius ?? 200;
  const kopf = loc ? `${teile[0]}l${loc}r${radius}` : teile[0];
  const pfad = `${PORTAL}/s-autos/${[kopf, ...teile.slice(1)].join("+")}`;
  if (!loc && abg.plz) {
    const q = new URLSearchParams({ locationStr: String(abg.plz), radius: String(radius) });
    return `${pfad}?${q.toString()}`;
  }
  return pfad;
}

/** results[] aus der Dienstantwort. Leer statt Absturz. */
function findeItems(antwort) {
  const r = antwort && antwort.results;
  return Array.isArray(r) ? r : [];
}

/** PS -> kW, wenn das Feld PS trägt (Kleinanzeigen liefert PS). */
function leistungKw(rohLeistung) {
  const n = zahl(rohLeistung);
  if (n == null) return null;
  const s = String(rohLeistung);
  if (/ps/i.test(s) && !/kw/i.test(s)) return Math.round(n / 1.35962);
  return n;
}

/**
 * Listeneintrag + (optionales) Detail -> kanonisches Fahrzeug.
 * Fehlt das Detail, bleiben km/EZ leer — das Fahrzeug wird trotzdem geliefert,
 * das Verwerfen ist Sache der Filterkette, nicht des Mappings.
 */
function mappe(eintrag, detail, warnungen) {
  if (!eintrag || typeof eintrag !== "object") return null;
  const f = leeresFahrzeug(QUELLE);
  const d = (detail && detail.data) || {};
  const det = d.details || {};

  f.id = eintrag.adid != null ? String(eintrag.adid) : (d.id != null ? String(d.id) : null);
  f.url = eintrag.url || d.url_redirected || d.url_requested || null;
  f.titel = eintrag.title || d.title || null;
  f.variante = null;

  f.preis = zahl(d.price && d.price.amount) ?? zahl(eintrag.price);
  f.kilometerstand = zahl(det["Kilometerstand"]);
  f.erstzulassung = ez(det["Erstzulassung"], warnungen);
  f.leistungKw = leistungKw(det["Leistung"]);
  f.getriebe = det["Getriebe"] || null;
  f.kraftstoff = det["Kraftstoffart"] || null;
  f.fahrzeugtyp = det["Fahrzeugtyp"] || null;
  f.tueren = det["Anzahl Türen"] || null;

  const loc = d.location || {};
  f.plz = loc.zip != null ? String(loc.zip) : (function () {
    const m = String(eintrag.location || "").match(/\b\d{5}\b/); return m ? m[0] : null;
  })();
  f.ort = loc.city || (String(eintrag.location || "").replace(/\b\d{5}\b/, "").trim() || null);
  // Kleinanzeigen liefert grundsätzlich KEINE Koordinaten (im Quellcode bestätigt).
  f.lat = null;
  f.lon = null;

  // features ist eine Liste; der Deleted-Stub des Dienstes liefert {} -> beides vertragen.
  f.ausstattung = ausstattung(Array.isArray(d.features) ? d.features : (d.features && typeof d.features === "object" ? Object.values(d.features) : []));
  const bilder = ((d.media || {}).images || {}).urls;
  f.bilder = Array.isArray(bilder) ? bilder.filter((u) => typeof u === "string" && /^https?:\/\//.test(u)) : [];
  f.beschreibung = d.description || eintrag.description || null;
  return f;
}

function authKopf() {
  const u = process.env.KA_API_USER, p = process.env.KA_API_PASS;
  if (!u || !p) return {};
  return { Authorization: "Basic " + Buffer.from(`${u}:${p}`).toString("base64") };
}

/**
 * Holt Trefferliste + Details. Zwischen den Detailabrufen wird pausiert
 * (der Dienst selbst pausiert nur zwischen SEITEN der Trefferliste).
 */
async function holen(eingaben, opts = {}) {
  const basis = String(opts.endpoint || process.env.KA_API_BASE || KA_API_BASE_STANDARD).replace(/\/+$/, "");
  if (!basis) throw fehlendeZugangsdaten("Kleinanzeigen L1", ["KA_API_BASE"]);
  const maxItems = opts.maxItems ?? ((eingaben.kleinanzeigen && eingaben.kleinanzeigen.limit) || 60);
  const maxSeiten = Math.min(opts.maxSeiten ?? 3, 20);
  const batchId = opts.batchId || `wbw-${Date.now()}`;
  // Naht für Tests (siehe autoscout24.js).
  const holeFn = opts.holeJson || holeJson;
  const pauseFn = opts.pause || pause;
  const warnungen = [];
  const abrufe = [];
  const kopf = { "Content-Type": "application/json", ...authKopf() };

  const suchUrl = bauSuchUrl(eingaben);
  const t0 = Date.now();
  const liste = await holeFn(`${basis}/inserate-by-url`, {
    method: "POST", headers: kopf,
    body: JSON.stringify({ url: suchUrl, max_pages: maxSeiten }),
    timeoutMs: opts.timeoutMs ?? 240000,
  });
  abrufe.push({ url: `${basis}/inserate-by-url`, suchUrl, status: liste.status, ms: Date.now() - t0, zeitpunkt: new Date().toISOString() });
  if (liste.status === 401) {
    if (!process.env.KA_API_USER || !process.env.KA_API_PASS) throw fehlendeZugangsdaten("Kleinanzeigen L1 (HTTP 401)", ["KA_API_USER", "KA_API_PASS"]);
    throw new Error("Kleinanzeigen L1: HTTP 401 — KA_API_USER/KA_API_PASS sind gesetzt, werden aber abgelehnt");
  }
  if (liste.status !== 200 || !liste.daten) throw new Error(`Kleinanzeigen L1: HTTP ${liste.status} von /inserate-by-url`);
  if (liste.daten.success === false) throw new Error(`Kleinanzeigen L1: Dienst meldet success:false (${liste.daten.error || "ohne Grund"})`);

  const eintraege = findeItems(liste.daten).slice(0, maxItems);
  const items = [];
  let mitDetail = 0;
  for (const e of eintraege) {
    let detail = null;
    if (e && e.adid && opts.details !== false) {
      await pauseFn();
      const td = Date.now();
      try {
        const r = await holeFn(`${basis}/inserat/${encodeURIComponent(e.adid)}?batch_id=${encodeURIComponent(batchId)}`,
          { headers: authKopf(), timeoutMs: opts.timeoutMs ?? 120000 });
        abrufe.push({ url: `${basis}/inserat/${e.adid}`, status: r.status, ms: Date.now() - td, zeitpunkt: new Date().toISOString() });
        if (r.status === 200 && r.daten && r.daten.success) { detail = r.daten; mitDetail++; }
        else if (r.status !== 404) warnungen.push(`Detailabruf ${e.adid}: HTTP ${r.status}`);
      } catch (err) {
        warnungen.push(`Detailabruf ${e.adid} fehlgeschlagen: ${err.message}`);
      }
    }
    const f = mappe(e, detail, warnungen);
    if (f) items.push(f);
  }

  return {
    items: dedupe(items),
    protokoll: {
      abrufe, suchUrl,
      trefferLautDienst: liste.daten.unique_results ?? null,
      detailsGeholt: mitDetail,
      warnungen,
    },
  };
}

module.exports = { holen, bauSuchUrl, mappe, findeItems, leistungKw, QUELLE, PORTAL, KA_API_BASE_STANDARD };
