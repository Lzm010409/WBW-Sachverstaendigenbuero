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

/**
 * Die Modellliste, die AutoScout24 selbst mitliefert (props.pageProps.taxonomy.models).
 * Damit laesst sich pruefen, ob ein Modellname ueberhaupt existiert - statt zu raten.
 */
function findeModelle(next) {
  const tx = next && next.props && next.props.pageProps && next.props.pageProps.taxonomy;
  const m = tx && tx.models;
  if (!m || typeof m !== "object") return [];
  return Object.values(m).flat().filter((x) => x && x.label).map((x) => String(x.label));
}

const norm = (s) => String(s || "").toLowerCase().replace(/[\s\-_.]+/g, " ").trim();

/**
 * Loest einen Modellnamen gegen die Portal-Taxonomie auf.
 * Nur eine Generationsangabe am Ende wird abgeschnitten ("Golf VII" -> "Golf"),
 * und auch das NUR, wenn der Rest exakt einem echten Modellnamen entspricht.
 * Ohne Treffer wird NICHTS geraten - der Aufrufer meldet den Fehler.
 * @returns {{label:string, korrigiert:boolean}|null}
 */
function aufloeseModell(gewuenscht, modelle) {
  const z = norm(gewuenscht);
  if (!z || !modelle.length) return null;
  const treffer = modelle.find((m) => norm(m) === z);
  if (treffer) return { label: treffer, korrigiert: false };

  // Eine Generationsangabe darf entfallen - egal an welcher Stelle sie steht
  // ("Golf VII", "Golf VII Variant", "Golf Mk7"). Uebernommen wird das Ergebnis
  // NUR, wenn der Rest exakt einem echten Modellnamen entspricht und genau ein
  // Modell in Frage kommt. Bewusst NICHT generisch Buchstabe+Ziffer abschneiden -
  // das wuerde echte Modellnamen wie "A4", "Mazda 3" oder "500" zerstoeren.
  const istGeneration = (w) => /^(?:m(?:k|ark)?\s?\d{1,2}|[ivx]{1,5}|\d{1,2})$/i.test(w);
  const worte = z.split(" ");
  const kandidaten = new Set();
  for (let i = 0; i < worte.length; i++) {
    if (!istGeneration(worte[i])) continue;
    const rest = worte.slice(0, i).concat(worte.slice(i + 1)).join(" ").trim();
    if (!rest) continue;
    const m = modelle.find((x) => norm(x) === rest);
    if (m) kandidaten.add(m);
  }
  if (kandidaten.size === 1) return { label: [...kandidaten][0], korrigiert: true };
  return null;
}

/** Modellnamen, die zum ersten Wort der Eingabe passen - fuer die Fehlermeldung. */
function modellVorschlaege(gewuenscht, modelle) {
  const kopf = norm(gewuenscht).split(" ")[0];
  if (!kopf) return [];
  return modelle.filter((m) => norm(m).split(" ")[0] === kopf).slice(0, 12);
}

/** Anteil der Treffer, die wirklich das gesuchte Modell sind. */
function modellAnteil(listings, modell) {
  if (!listings.length || !modell) return 1;
  const z = norm(modell);
  const passt = listings.filter((l) => {
    const m = norm(l && l.vehicle && l.vehicle.model);
    return m && (m === z || z.startsWith(m) || m.startsWith(z));
  }).length;
  return passt / listings.length;
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
  let unvollstaendig = false;
  let geprueft = false;

  // Modell gegen die Portal-Taxonomie pruefen. Grund: AutoScout24 antwortet auf
  // einen unbekannten Modellnamen NICHT mit 404, sondern liefert stillschweigend
  // alle Modelle der Marke. "Golf VII" ergab so 40 Treffer quer durch Tiguan,
  // Caddy und T6 - ein Vergleichskorb, der im Gutachten nichts taugt.
  let eff = eingaben;
  let modellHinweis = null;

  for (let seite = 1; seite <= maxSeiten; seite++) {
    if (seite > 1) await pauseFn();
    const url = bauSuchUrl(eff, seite);
    const t0 = Date.now();
    let r, next, ls;
    try {
      r = await holeFn(url, { headers: BROWSER_HEADERS });
      abrufe.push({ url, status: r.status, ms: Date.now() - t0, zeitpunkt: new Date().toISOString() });
      if (r.status !== 200) throw new Error(`AutoScout24 antwortete HTTP ${r.status} auf Seite ${seite}`);
      next = findeNextData(r.body);
      if (!next) throw new Error(`AutoScout24: __NEXT_DATA__ nicht gefunden (Seite ${seite}) — Seitenaufbau geändert?`);
      ls = findeListings(next);
    } catch (err) {
      // Teilerfolg: Was schon geholt ist, bleibt erhalten. Ein Gutachten mit 20
      // statt 60 Fahrzeugen ist brauchbar - es muss nur dranstehen.
      if (items.length) {
        warnungen.push(`Beschaffung unvollständig: Seite ${seite} scheiterte (${err.message}). ${items.length} Treffer aus den vorherigen Seiten bleiben erhalten.`);
        unvollstaendig = true;
        break;
      }
      throw err;  // schon die erste Seite scheitert -> Stufe ist gescheitert
    }
    if (gesamt == null) gesamt = gesamtTreffer(next);

    if (seite === 1 && !geprueft) {
      geprueft = true;
      const gewuenscht = (eff.autoScout && eff.autoScout.model) || "";
      const modelle = findeModelle(next);
      if (gewuenscht && modelle.length) {
        const auf = aufloeseModell(gewuenscht, modelle);
        if (!auf) {
          const v = modellVorschlaege(gewuenscht, modelle);
          const e = new Error(
            `AutoScout24 kennt kein Modell "${gewuenscht}". Das Portal liefert dann ` +
            `stillschweigend ALLE Modelle der Marke - der Korb waere unbrauchbar.` +
            (v.length ? `\n   Gueltige Modellnamen: ${v.join(", ")}` : "") +
            `\n   subject.modell in params.json entsprechend setzen.`);
          e.code = "MODELL_UNBEKANNT";
          throw e;
        }
        if (auf.korrigiert) {
          // Der bereinigte Name ist ein ECHTER Modellname aus der Portalliste -
          // keine Vermutung. Einmal neu holen und im Protokoll vermerken.
          modellHinweis = `Modell "${gewuenscht}" existiert bei AutoScout24 nicht; auf "${auf.label}" korrigiert (aus der Modellliste des Portals).`;
          warnungen.push(modellHinweis);
          eff = { ...eingaben, autoScout: { ...eingaben.autoScout, model: auf.label } };
          items = []; seite = 0; gesamt = null;   // Lauf mit dem richtigen Modell neu beginnen
          continue;
        }
      }
      const anteil = modellAnteil(ls, gewuenscht);
      if (gewuenscht && anteil < 0.6) {
        const e = new Error(
          `AutoScout24 lieferte nur ${(anteil * 100).toFixed(0)} % Treffer des gesuchten ` +
          `Modells "${gewuenscht}" - der Modellfilter hat nicht gegriffen.`);
        e.code = "MODELLFILTER_WIRKUNGSLOS";
        throw e;
      }
    }

    if (!ls.length) break;
    for (const l of ls) { const f = mappe(l, warnungen); if (f) items.push(f); }
    if (items.length >= maxItems) break;
  }

  items = dedupe(items).slice(0, maxItems);
  return { items, protokoll: { abrufe, gesamtTrefferLautPortal: gesamt, unvollstaendig, modellHinweis, warnungen } };
}

module.exports = { holen, bauSuchUrl, mappe, findeListings, findeNextData, gesamtTreffer,
  findeModelle, aufloeseModell, modellVorschlaege, modellAnteil, BASIS, QUELLE };
