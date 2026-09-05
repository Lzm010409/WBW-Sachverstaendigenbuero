/**
 * Stufe L2 — Bright Data Web Unlocker.
 * ------------------------------------------------------------------
 * Holt die Portalseite über den Unlocker (löst Bot-Schutz und liefert das
 * gerenderte HTML) und übergibt sie dem PARSER DES JEWEILIGEN PORTAL-ADAPTERS.
 * Damit gibt es nur ein Mapping je Portal, egal über welche Stufe die Seite kam.
 *
 * Verwendete Schnittstelle: POST https://api.brightdata.com/request
 *   { zone, url, format: "raw" }   Authorization: Bearer <BRIGHTDATA_TOKEN>
 *
 * ACHTUNG — Ehrlichkeitshinweis: In dieser Session existiert kein Bright-Data-
 * Konto. Dieser Adapter ist deshalb NICHT live verifiziert und steht in
 * providers.json auf `enabled: false`. Vor der ersten produktiven Nutzung
 * einmal gegen eine echte Antwort prüfen (npm run test:live).
 */
const { hole, pause, dedupe } = require("./gemeinsam.js");

const API = "https://api.brightdata.com/request";

function token() {
  const t = process.env.BRIGHTDATA_TOKEN;
  if (!t) {
    const e = new Error("L2 Bright Data: BRIGHTDATA_TOKEN nicht gesetzt");
    e.code = "L2_KEIN_TOKEN";
    throw e;
  }
  return t;
}

/** Eine URL über den Unlocker holen -> HTML-Text. */
async function holeSeite(url, opts = {}) {
  const zone = opts.zone || process.env.BRIGHTDATA_ZONE || "mcp_unlocker";
  const r = await hole(API, {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ zone, url, format: "raw" }),
    timeoutMs: opts.timeoutMs ?? 120000,
  });
  if (r.status !== 200) throw new Error(`L2 Bright Data: HTTP ${r.status} für ${url}`);
  return r.body;
}

/**
 * Generische Stufe: baut die URLs mit dem Portal-Adapter, holt sie über den
 * Unlocker und mappt mit dem Portal-Adapter.
 * @param {object} portalAdapter muss bauSuchUrl(), findeNextData()/findeListings() und mappe() bieten
 */
async function holenUeberUnlocker(portalAdapter, eingaben, opts = {}) {
  if (typeof portalAdapter.bauSuchUrl !== "function" || typeof portalAdapter.mappe !== "function") {
    const e = new Error("L2: Der Portal-Adapter bietet kein bauSuchUrl()/mappe() — Stufe nicht nutzbar.");
    e.code = "L2_ADAPTER_UNGEEIGNET";
    throw e;
  }
  const maxItems = opts.maxItems ?? 60;
  const maxSeiten = Math.min(opts.maxSeiten ?? 5, 10);
  const warnungen = []; const abrufe = []; let items = [];

  for (let seite = 1; seite <= maxSeiten; seite++) {
    if (seite > 1) await pause();
    const url = portalAdapter.bauSuchUrl(eingaben, seite);
    const t0 = Date.now();
    const html = await holeSeite(url, opts);
    abrufe.push({ url, ueber: "brightdata", status: 200, ms: Date.now() - t0, zeitpunkt: new Date().toISOString() });
    const next = portalAdapter.findeNextData ? portalAdapter.findeNextData(html) : null;
    const liste = portalAdapter.findeListings ? portalAdapter.findeListings(next) : [];
    if (!liste.length) break;
    for (const l of liste) { const f = portalAdapter.mappe(l, warnungen); if (f) items.push(f); }
    if (items.length >= maxItems) break;
  }
  items = dedupe(items).slice(0, maxItems);
  return { items, protokoll: { abrufe, warnungen } };
}

module.exports = { holeSeite, holenUeberUnlocker, API };
