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

const ADAPTER = {
  autoscout24: () => require("./adapters/autoscout24.js"),
  kleinanzeigen: () => require("./adapters/kleinanzeigen.js"),
  mobilede: () => require("./adapters/mobilede.js"),
  unlocker: () => require("./adapters/unlocker.js"),
  apify: () => require("./adapters/apify.js"),
};

function ladeProviders(datei) {
  const p = datei || path.join(__dirname, "providers.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
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
      if (n === 0) {
        // Leer ist KEIN Erfolg — die nächste Stufe wird versucht.
        versuche.push({ stufe: stufe.id, adapter: stufe.adapter, ergebnis: "leer", treffer: 0, ms: Date.now() - t0, zeitpunkt: new Date().toISOString(), details: (ergebnis && ergebnis.protokoll) || null });
        log(`   ${stufe.id} lieferte 0 Treffer — nächste Stufe`);
        continue;
      }
      items = ergebnis.items;
      getrageneStufe = stufe.id;
      versuche.push({ stufe: stufe.id, adapter: stufe.adapter, ergebnis: "erfolg", treffer: n, ms: Date.now() - t0, zeitpunkt: new Date().toISOString(), kostenpflichtig: !!stufe.kostenpflichtig, details: ergebnis.protokoll || null });
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
  let ergebnis;
  try {
    ergebnis = await beschaffe(portal, eingaben, {
      log: (s) => console.log(s),
      stufenZeitgrenzeMs: Number(process.env.WBW_STUFEN_TIMEOUT_MS || 900000),
    });
  } catch (err) {
    if (err.code === "UNBEKANNTES_PORTAL" || err.code === "EINGABEBLOCK_FEHLT") {
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
module.exports = { beschaffe, ladeProviders, ADAPTER };
