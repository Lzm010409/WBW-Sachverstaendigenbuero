#!/usr/bin/env node
/**
 * Beschaffung eines Portals über die Eskalationskette.
 * ------------------------------------------------------------------
 * Ersetzt den früheren direkten Apify-Aufruf in Schritt 5 des Skills.
 * Die Stufen werden in der Reihenfolge aus providers.json versucht; die erste,
 * die Treffer liefert, gewinnt — spätere Stufen werden dann NICHT mehr
 * aufgerufen (das ist der Kostensinn der Kette).
 *
 * Aufruf:
 *   node fetch-portal.js <portal> <search-inputs.json> <ausgabe.json>
 *
 * Ausgabe:  { portal, items: [...], beschaffungsprotokoll: {...} }
 *
 * Exit-Codes:
 *   0  Erfolg — ODER: alle Stufen gescheitert (leere items, vollständiges
 *      Protokoll). Ein leeres Portal darf den Gutachtenlauf nicht abbrechen.
 *   2  Bedienfehler: unbekanntes Portal, fehlende Datei, fehlender Eingabeblock.
 */
const fs = require("fs");
const path = require("path");

// .env aus dem Arbeitsordner (oder aufwaerts bis zur Plugin-Wurzel) uebernehmen.
// Ohne das muesste der Aufrufer die Variablen selbst exportieren - und
// .env.example waere eine Anleitung, die ins Leere laeuft.
const { ladeEnv } = require("./adapters/gemeinsam.js");
const ENV_DATEI = ladeEnv(__dirname);

/**
 * Mindestqualität, damit eine Stufe als erfolgreich gilt. Der realistische
 * Portalumbau liefert nicht NICHTS, sondern 25 Objekte mit lauter null-Feldern.
 * Ohne diese Hürde bräche die Kette dort ab und lieferte Datenmüll, ohne dass
 * eine Stufe "scheitert". Bewusst niedriger als die E4-Schwelle: das hier fängt
 * den Totalausfall ab, es bewertet nicht die Qualität.
 */
const MINDEST_BRAUCHBAR = 0.5;

/**
 * URLs fürs Protokoll entschärfen. Das Protokoll wandert in den Report und damit
 * ins Gutachten-PDF — ein Token im Query-String verließe damit das Haus.
 * Benutzerinfo raus, verdächtig benannte Parameter redigiert; die fachlichen
 * Suchparameter bleiben stehen, weil sie im Gutachten dokumentieren, WAS gesucht wurde.
 */
const GEHEIM = /^(token|key|apikey|api_key|access_token|auth|authorization|password|passwd|pass|secret|signature|sig)$/i;
function sauberUrl(u) {
  try {
    const x = new URL(String(u));
    x.username = ""; x.password = "";
    for (const k of [...x.searchParams.keys()]) if (GEHEIM.test(k)) x.searchParams.set(k, "REDIGIERT");
    return x.toString();
  } catch { return String(u).replace(/([?&](?:token|key|apikey|api_key|access_token|auth|password|secret)=)[^&#]*/gi, "$1REDIGIERT"); }
}
function saubereProtokollDaten(o, tiefe = 0) {
  if (o == null || tiefe > 8) return o;
  if (typeof o === "string") return /^https?:\/\//.test(o) ? sauberUrl(o) : o;
  if (Array.isArray(o)) return o.map((x) => saubereProtokollDaten(x, tiefe + 1));
  if (typeof o === "object") {
    const r = {};
    for (const [k, v] of Object.entries(o)) r[k] = saubereProtokollDaten(v, tiefe + 1);
    return r;
  }
  return o;
}

const ADAPTER = {
  autoscout24: () => require("./adapters/autoscout24.js"),
  kleinanzeigen: () => require("./adapters/kleinanzeigen.js"),
  mobilede: () => require("./adapters/mobilede.js"),
  unlocker: () => require("./adapters/unlocker.js"),
  apify: () => require("./adapters/apify.js"),
};

function ladeProviders(datei) {
  const p = datei || path.join(__dirname, "providers.json");
  let roh;
  try { roh = fs.readFileSync(p, "utf8"); }
  catch (e) { throw Object.assign(new Error(`providers.json nicht lesbar (${p}): ${e.message}`), { code: "PROVIDERS_DEFEKT" }); }
  let j;
  try { j = JSON.parse(roh); }
  catch (e) { throw Object.assign(new Error(`providers.json ist kein gültiges JSON (${p}): ${e.message}`), { code: "PROVIDERS_DEFEKT" }); }
  if (!j || typeof j.portale !== "object" || j.portale === null) {
    throw Object.assign(new Error(`providers.json enthält kein Objekt "portale" (${p})`), { code: "PROVIDERS_DEFEKT" });
  }
  for (const [name, k] of Object.entries(j.portale)) {
    if (!Array.isArray(k.stufen)) throw Object.assign(new Error(`providers.json: Portal "${name}" hat keine Stufenliste`), { code: "PROVIDERS_DEFEKT" });
    for (const s of k.stufen) {
      if (!s.id || !s.adapter) throw Object.assign(new Error(`providers.json: Portal "${name}" hat eine Stufe ohne id/adapter`), { code: "PROVIDERS_DEFEKT" });
    }
  }
  return j;
}

/** Bricht eine Stufe ab, wenn sie zu lange braucht — blockiert nie endlos. */
function mitZeitgrenze(promise, ms, was) {
  if (!ms || ms <= 0) return promise;
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, rej) => {
      t = setTimeout(() => {
        rej(Object.assign(new Error(`${was}: Zeitgrenze ${ms} ms überschritten`), { code: "ZEITGRENZE" }));
      }, ms);
    }),
  ]);
}

/**
 * Führt die Kette für ein Portal aus.
 * @param {string} portal        Schlüssel in providers.json
 * @param {object} eingaben      Inhalt von search-inputs.json
 * @param {object} opts          { providers, maxItems, stufenZeitgrenzeMs, log }
 */
async function beschaffe(portal, eingaben, opts = {}) {
  const providers = opts.providers || ladeProviders(opts.providersDatei);
  const konf = (providers.portale || {})[portal];
  if (!konf) {
    const e = new Error(`Unbekanntes Portal "${portal}". Bekannt: ${Object.keys(providers.portale || {}).join(", ")}`);
    e.code = "UNBEKANNTES_PORTAL";
    throw e;
  }
  const inputKey = konf.inputKey;
  if (inputKey && (eingaben == null || eingaben[inputKey] == null)) {
    const e = new Error(`In search-inputs.json fehlt der Block "${inputKey}" für Portal "${portal}".`);
    e.code = "EINGABEBLOCK_FEHLT";
    throw e;
  }

  // Für E3 (Fehlerinjektion) austauschbar: erfundene Adapter statt echter Portale.
  const adapterMap = opts.adapterMap || ADAPTER;
  const log = opts.log || (() => {});
  const versuche = [];
  const beginn = new Date().toISOString();
  let items = [];
  let getrageneStufe = null;

  for (const stufe of (konf.stufen || [])) {
    if (!stufe.enabled) {
      versuche.push({ stufe: stufe.id, adapter: stufe.adapter, ergebnis: "uebersprungen", grund: stufe.grund || "enabled: false", zeitpunkt: new Date().toISOString() });
      log(`   ${stufe.id} übersprungen (deaktiviert)`);
      continue;
    }
    const t0 = Date.now();
    try {
      const lader = adapterMap[stufe.adapter];
      if (!lader) throw new Error(`Unbekannter Adapter "${stufe.adapter}"`);
      const mod = lader();
      const stufenOpts = {
        ...stufe,
        maxItems: opts.maxItems,
        quelle: portal,
        inputKey,
      };
      let ergebnis;
      if (stufe.adapter === "unlocker") {
        const portalMod = adapterMap[stufe.ueberPortal] && adapterMap[stufe.ueberPortal]();
        if (!portalMod) throw new Error(`L2: ueberPortal "${stufe.ueberPortal}" nicht auflösbar`);
        ergebnis = await mitZeitgrenze(mod.holenUeberUnlocker(portalMod, eingaben, stufenOpts), opts.stufenZeitgrenzeMs, `${portal}/${stufe.id}`);
      } else {
        ergebnis = await mitZeitgrenze(mod.holen(eingaben, stufenOpts), opts.stufenZeitgrenzeMs, `${portal}/${stufe.id}`);
      }
      const n = (ergebnis && ergebnis.items) ? ergebnis.items.length : 0;
      const details = saubereProtokollDaten((ergebnis && ergebnis.protokoll) || null);
      if (n === 0) {
        // Leer ist KEIN Erfolg — die nächste Stufe wird versucht.
        versuche.push({ stufe: stufe.id, adapter: stufe.adapter, ergebnis: "leer", treffer: 0, ms: Date.now() - t0, zeitpunkt: new Date().toISOString(), details });
        log(`   ${stufe.id} lieferte 0 Treffer — nächste Stufe`);
        continue;
      }
      const brauchbar = ergebnis.items.filter((x) => x && x.preis != null && x.kilometerstand != null).length / n;
      if (brauchbar < MINDEST_BRAUCHBAR) {
        // Treffer da, aber Pflichtfelder leer -> Mapping passt nicht mehr zur Quelle.
        versuche.push({ stufe: stufe.id, adapter: stufe.adapter, ergebnis: "unbrauchbar", treffer: n,
          anteilBrauchbar: Number(brauchbar.toFixed(3)), ms: Date.now() - t0, zeitpunkt: new Date().toISOString(), details });
        log(`   ${stufe.id} lieferte ${n} Treffer, aber nur ${(brauchbar * 100).toFixed(0)} % mit Preis UND Kilometerstand — nächste Stufe`);
        continue;
      }
      items = ergebnis.items;
      getrageneStufe = stufe.id;
      versuche.push({ stufe: stufe.id, adapter: stufe.adapter, ergebnis: "erfolg", treffer: n,
        anteilBrauchbar: Number(brauchbar.toFixed(3)), ms: Date.now() - t0, zeitpunkt: new Date().toISOString(),
        kostenpflichtig: !!stufe.kostenpflichtig, details });
      log(`   ${stufe.id} lieferte ${n} Treffer`);
      break; // spätere Stufen bewusst NICHT mehr aufrufen
    } catch (err) {
      versuche.push({ stufe: stufe.id, adapter: stufe.adapter, ergebnis: "fehler", fehler: err.message, code: err.code || null, ms: Date.now() - t0, zeitpunkt: new Date().toISOString() });
      log(`   ${stufe.id} gescheitert: ${err.message}`);
    }
  }

  return {
    portal,
    items,
    beschaffungsprotokoll: {
      portal,
      getrageneStufe,
      trefferGesamt: items.length,
      beginn,
      ende: new Date().toISOString(),
      versuche,
    },
  };
}

async function main() {
  const [, , portal, eingabenPfad, ausgabePfad] = process.argv;
  if (!portal || !eingabenPfad || !ausgabePfad) {
    console.error("Aufruf: node fetch-portal.js <portal> <search-inputs.json> <ausgabe.json>");
    process.exit(2);
  }
  if (!fs.existsSync(eingabenPfad)) {
    console.error(`Datei nicht gefunden: ${eingabenPfad}`);
    process.exit(2);
  }
  let eingaben;
  try { eingaben = JSON.parse(fs.readFileSync(eingabenPfad, "utf8")); }
  catch (e) { console.error(`${eingabenPfad} ist kein gültiges JSON: ${e.message}`); process.exit(2); }

  console.log(`Beschaffung ${portal} …`);
  if (ENV_DATEI) console.log(`   (Zugangsdaten aus ${ENV_DATEI})`);
  let ergebnis;
  try {
    ergebnis = await beschaffe(portal, eingaben, {
      log: (s) => console.log(s),
      stufenZeitgrenzeMs: Number(process.env.WBW_STUFEN_TIMEOUT_MS || 900000),
    });
  } catch (err) {
    if (err.code === "UNBEKANNTES_PORTAL" || err.code === "EINGABEBLOCK_FEHLT" || err.code === "PROVIDERS_DEFEKT") {
      console.error(`Fehler: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }

  fs.writeFileSync(ausgabePfad, JSON.stringify(ergebnis, null, 2), "utf8");
  const p = ergebnis.beschaffungsprotokoll;
  if (p.getrageneStufe) {
    console.log(`${portal}: ${ergebnis.items.length} Treffer über Stufe ${p.getrageneStufe} -> ${ausgabePfad}`);
  } else {
    console.log(`${portal}: KEINE Treffer — alle Stufen gescheitert oder deaktiviert. Protokoll steht in ${ausgabePfad}.`);
    for (const v of p.versuche) console.log(`   ${v.stufe}: ${v.ergebnis}${v.fehler ? " — " + v.fehler : ""}`);
  }
  process.exit(0);
}

if (require.main === module) main().catch((e) => { console.error("Unerwarteter Fehler:", e.message); process.exit(1); });
module.exports = { beschaffe, ladeProviders, ADAPTER, sauberUrl, saubereProtokollDaten, MINDEST_BRAUCHBAR };
