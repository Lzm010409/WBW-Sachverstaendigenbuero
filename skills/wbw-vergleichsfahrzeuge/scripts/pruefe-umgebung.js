#!/usr/bin/env node
"use strict";
/**
 * Zeigt, was der Skill in DIESER Umgebung tatsaechlich sieht.
 *
 * Gedacht fuer den Fall "ich habe die Zugangsdaten doch hinterlegt, trotzdem
 * 0 Treffer". Statt zu raten, wo es klemmt, zeigt diese Pruefung:
 *   - auf welchem Rechner/Betriebssystem der Skill laeuft,
 *   - welche Zugangsdaten-Datei benutzt wurde (und welche gesucht wurden),
 *   - welche Variablen gesetzt sind und WOHER sie kommen,
 *   - welche Beschaffungsstufen damit nutzbar sind,
 *   - ob ein Chrome fuer die PDF-Erzeugung gefunden wird,
 *   - und ob der Kleinanzeigen-Dienst wirklich antwortet (mit --netz).
 *
 * Aufruf:  node pruefe-umgebung.js [--netz]
 *
 * Passwoerter und Token werden NIE ausgegeben, nur ob sie da sind und wie lang
 * sie sind - die Ausgabe darf man gefahrlos weiterschicken.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const gemeinsam = require("./adapters/gemeinsam.js");

const GEHEIM = /PASS|TOKEN|SECRET|KEY/i;
const VARIABLEN = [
  "KA_API_BASE", "KA_API_USER", "KA_API_PASS",
  "APIFY_TOKEN", "WBW_ALLOW_PAID",
  "BRIGHTDATA_TOKEN", "BRIGHTDATA_ZONE",
  "WBW_CHROME", "WBW_PAUSE_MS", "WBW_ENV_DATEI",
];

function zeige(wert, name) {
  if (wert === undefined || wert === "") return "nicht gesetzt";
  return GEHEIM.test(name) ? `gesetzt (${wert.length} Zeichen)` : wert;
}

function findeChrome() {
  let kandidaten;
  try {
    ({ chromeKandidaten: kandidaten } = require("./run-report.js"));
  } catch { return null; }
  for (const bin of kandidaten()) {
    // Absolute Pfade direkt pruefen, blosse Namen ueber den Suchpfad.
    try {
      if (bin.includes("/") || bin.includes("\\")) {
        if (fs.existsSync(bin)) return bin;
      } else {
        const wo = process.platform === "win32" ? "where" : "which";
        const p = execFileSync(wo, [bin], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        if (p) return p.split(/\r?\n/)[0];
      }
    } catch { /* naechster Kandidat */ }
  }
  return null;
}

async function pruefeDienst() {
  const basis = String(process.env.KA_API_BASE || "").replace(/\/+$/, "");
  if (!basis) return "  KA_API_BASE fehlt - nicht pruefbar";
  const u = process.env.KA_API_USER, p = process.env.KA_API_PASS;
  const kopf = u && p
    ? { Authorization: "Basic " + Buffer.from(`${u}:${p}`).toString("base64") }
    : {};
  try {
    const r = await gemeinsam.hole(basis + "/", { headers: kopf, timeoutMs: 30000 });
    if (r.status === 200) return `  ${basis} antwortet mit 200 - Zugangsdaten stimmen`;
    if (r.status === 401) {
      return u && p
        ? `  ${basis} antwortet mit 401 - Benutzer oder Passwort stimmen NICHT`
        : `  ${basis} antwortet mit 401 - es wurden keine Zugangsdaten mitgeschickt`;
    }
    return `  ${basis} antwortet mit HTTP ${r.status}`;
  } catch (fehler) {
    return `  ${basis} nicht erreichbar: ${fehler.message}`;
  }
}

async function main() {
  const mitNetz = process.argv.includes("--netz");

  // Vorher merken, was aus der Umgebung kommt - danach laedt ladeEnv() die Datei.
  const ausUmgebung = new Set(VARIABLEN.filter((v) => process.env[v] !== undefined && process.env[v] !== ""));
  const pfade = gemeinsam.envSuchpfade();
  const benutzt = gemeinsam.ladeEnv();

  console.log("WBW-Vergleichsfahrzeug-Finder - Umgebungspruefung");
  console.log("");
  console.log(`  Betriebssystem : ${process.platform} (${os.release()})`);
  console.log(`  Node           : ${process.version}`);
  console.log(`  Benutzerordner : ${os.homedir()}`);
  console.log(`  Arbeitsordner  : ${process.cwd()}`);
  console.log("");

  const alleBenutzt = gemeinsam.envDateienBenutzt();
  console.log("Zugangsdaten-Dateien");
  if (alleBenutzt.length === 0) {
    console.log("  KEINE gefunden");
  } else {
    // Mehrere Dateien werden zusammengefuehrt: je Schluessel gewinnt die erste.
    for (const d of alleBenutzt) console.log(`  benutzt: ${d}`);
  }
  console.log("  gesucht wurde in dieser Reihenfolge (erste gefundene gewinnt):");
  for (const p of [...new Set(pfade)]) {
    console.log(`    ${fs.existsSync(p) ? "[vorhanden]" : "[fehlt]    "} ${p}`);
  }
  console.log("");

  console.log("Variablen");
  for (const v of VARIABLEN) {
    const woher = ausUmgebung.has(v) ? "Umgebung (z. B. settings.json)"
      : process.env[v] ? `Datei ${benutzt || "?"}`
        : "-";
    console.log(`  ${v.padEnd(17)} ${zeige(process.env[v], v).padEnd(34)} ${woher}`);
  }
  console.log("");

  const ka = process.env.KA_API_BASE && process.env.KA_API_USER && process.env.KA_API_PASS;
  const apify = !!process.env.APIFY_TOKEN;
  const bezahlt = process.env.WBW_ALLOW_PAID === "1";
  console.log("Beschaffungsstufen");
  console.log("  L0 AutoScout24   : nutzbar (braucht keine Zugangsdaten)");
  console.log(`  L1 Kleinanzeigen : ${ka ? "nutzbar" : "NICHT nutzbar - KA_API_BASE, KA_API_USER und KA_API_PASS noetig"}`);
  console.log(`  L2 Bright Data   : ${process.env.BRIGHTDATA_TOKEN ? "Token vorhanden (in providers.json trotzdem deaktiviert)" : "deaktiviert (kein Token)"}`);
  console.log(`  L3 Apify         : ${!apify ? "NICHT nutzbar - APIFY_TOKEN fehlt" : bezahlt ? "nutzbar" : "gesperrt - WBW_ALLOW_PAID muss auf 1 stehen"}`);
  console.log("                     (L3 wird nur fuer mobile.de gebraucht)");
  console.log("");

  const chrome = findeChrome();
  console.log("PDF-Erzeugung");
  if (chrome) {
    console.log(`  Chrome gefunden: ${chrome}`);
  } else {
    console.log("  kein Chrome gefunden - der Report bleibt HTML (druckfertig, per Browser-Druck als PDF speicherbar)");
    console.log("  Abhilfe: WBW_CHROME auf den vollen Pfad zur chrome.exe bzw. zum Chrome-Binary setzen,");
    console.log("           unter Windows z. B. C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
  }
  console.log("");

  if (mitNetz) {
    console.log("Erreichbarkeit des Kleinanzeigen-Dienstes");
    console.log(await pruefeDienst());
  } else {
    console.log("Mit --netz wird zusaetzlich geprueft, ob der Kleinanzeigen-Dienst antwortet.");
  }
}

if (require.main === module) {
  main().catch((f) => { console.error("Pruefung abgebrochen: " + f.message); process.exit(1); });
}

module.exports = { findeChrome, zeige, VARIABLEN };
