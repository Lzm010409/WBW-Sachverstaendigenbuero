#!/usr/bin/env node
"use strict";
/**
 * Zeigt, was der Skill in DIESER Umgebung tatsaechlich sieht.
 *
 * Gedacht fuer den Fall "ich habe die Zugangsdaten doch hinterlegt, trotzdem
 * 0 Treffer". Statt zu raten, wo es klemmt, zeigt diese Pruefung:
 *   - auf welchem Rechner/Betriebssystem der Skill laeuft,
 *   - welche Zugangsdaten-Dateien benutzt wurden (und welche gesucht wurden),
 *   - welche Variablen gesetzt sind und WOHER sie kommen
 *     (Umgebung, Datei oder eingebauter Standardwert),
 *   - welche Beschaffungsstufen damit nutzbar sind,
 *   - ob ein Chrome fuer die PDF-Erzeugung gefunden wird,
 *   - und ob der Kleinanzeigen-Dienst wirklich antwortet (mit --netz).
 *
 * Aufruf:  node pruefe-umgebung.js [--netz] [--kurz]
 *
 *   --netz   prueft zusaetzlich, ob der Kleinanzeigen-Dienst antwortet
 *   --kurz   nur die Stufenuebersicht (fuer den SessionStart-Hook). Damit
 *            benutzt der Hook GENAU dieselbe Suchlogik wie fetch-portal.js
 *            und kann nicht "fehlt" melden, wo der Lauf spaeter fuendig wird.
 *
 * Passwoerter und Token werden NIE ausgegeben, nur ob sie da sind und wie lang
 * sie sind - die Ausgabe darf man gefahrlos weiterschicken.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const gemeinsam = require("./adapters/gemeinsam.js");
const { KA_API_BASE_STANDARD } = require("./adapters/kleinanzeigen.js");

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
  const basis = String(process.env.KA_API_BASE || KA_API_BASE_STANDARD).replace(/\/+$/, "");
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

/**
 * Sammelt den Zustand OHNE auszugeben - so koennen Hook (--kurz), Vollausgabe
 * und Tests dieselbe Wahrheit benutzen. Ruft ladeEnv() auf, veraendert also
 * process.env wie ein echter Lauf.
 */
function ermittle() {
  // Vorher merken, was aus der Umgebung kommt - danach laedt ladeEnv() die Dateien.
  const ausUmgebung = new Set(VARIABLEN.filter((v) => process.env[v] !== undefined && process.env[v] !== ""));
  const pfade = [...new Set(gemeinsam.envSuchpfade())];
  gemeinsam.ladeEnv();
  const dateien = gemeinsam.envDateienBenutzt();

  const woher = {};
  for (const v of VARIABLEN) {
    if (ausUmgebung.has(v)) woher[v] = "Umgebung";
    else if (process.env[v]) woher[v] = "Datei";
    else if (v === "KA_API_BASE") woher[v] = "Standardwert";
    else woher[v] = null;
  }
  const kaBase = process.env.KA_API_BASE || KA_API_BASE_STANDARD;
  const ka = !!(process.env.KA_API_USER && process.env.KA_API_PASS);
  const apify = !!process.env.APIFY_TOKEN;
  const bezahlt = process.env.WBW_ALLOW_PAID === "1";
  const bright = !!process.env.BRIGHTDATA_TOKEN;

  return {
    pfade, dateien, woher, kaBase, ka, apify, bezahlt, bright,
    stufen: {
      L0: "nutzbar (braucht keine Zugangsdaten)",
      L1: ka ? `nutzbar (${kaBase})` : "NICHT nutzbar - KA_API_USER und KA_API_PASS fehlen",
      L2: bright ? "Token vorhanden (in providers.json trotzdem deaktiviert)" : "deaktiviert (kein Token)",
      L3: !apify ? "NICHT nutzbar - APIFY_TOKEN fehlt (nur fuer mobile.de noetig)"
        : bezahlt ? "nutzbar" : "gesperrt - WBW_ALLOW_PAID muss auf 1 stehen",
    },
  };
}

/** Herkunft der Zugangsdaten in einem Satz, fuer die Kurzmeldung. */
function herkunftKurz(z) {
  const teile = [];
  const ausUmgebung = VARIABLEN.filter((v) => z.woher[v] === "Umgebung" && /KA_API|APIFY|BRIGHT/.test(v));
  if (ausUmgebung.length) teile.push(`Umgebung (${ausUmgebung.join(", ")})`);
  for (const d of z.dateien) teile.push(d);
  return teile.length ? teile.join(" + ") : "keine - weder Umgebungsvariablen noch eine Zugangsdaten-Datei gefunden";
}

function kurz(z) {
  console.log("  Beschaffungsstufen:");
  console.log(`    L0 AutoScout24    : ${z.stufen.L0}`);
  console.log(`    L1 Kleinanzeigen  : ${z.stufen.L1}`);
  console.log(`    L2 Bright Data    : ${z.stufen.L2}`);
  console.log(`    L3 Apify          : ${z.stufen.L3}`);
  console.log(`  Zugangsdaten aus   : ${herkunftKurz(z)}`);
}

async function main() {
  const mitNetz = process.argv.includes("--netz");
  const nurKurz = process.argv.includes("--kurz");
  const z = ermittle();

  if (nurKurz) { kurz(z); return; }

  console.log("WBW-Vergleichsfahrzeug-Finder - Umgebungspruefung");
  console.log("");
  console.log(`  Betriebssystem : ${process.platform} (${os.release()})`);
  console.log(`  Node           : ${process.version}`);
  console.log(`  Benutzerordner : ${os.homedir()}`);
  console.log(`  Arbeitsordner  : ${process.cwd()}`);
  console.log(`  Plugin-Wurzel  : ${process.env.CLAUDE_PLUGIN_ROOT || "(CLAUDE_PLUGIN_ROOT nicht gesetzt)"}`);
  console.log("");

  console.log("Zugangsdaten-Dateien");
  if (z.dateien.length === 0) {
    console.log("  KEINE gefunden");
  } else {
    // Mehrere Dateien werden zusammengefuehrt: je Schluessel gewinnt die erste.
    for (const d of z.dateien) console.log(`  benutzt: ${d}`);
  }
  console.log("  gesucht wurde in dieser Reihenfolge (je Schluessel gewinnt die erste Nennung):");
  for (const p of z.pfade) {
    console.log(`    ${fs.existsSync(p) ? "[vorhanden]" : "[fehlt]    "} ${p}`);
  }
  console.log("");

  console.log("Variablen");
  for (const v of VARIABLEN) {
    const wert = v === "KA_API_BASE" && z.woher[v] === "Standardwert" ? KA_API_BASE_STANDARD : process.env[v];
    const woher = z.woher[v] === "Umgebung" ? "Umgebung (Cloud-Umgebung, settings.json oder Shell)"
      : z.woher[v] === "Datei" ? `Datei ${z.dateien[0] || "?"}`
        : z.woher[v] === "Standardwert" ? "eingebauter Standardwert"
          : "-";
    console.log(`  ${v.padEnd(17)} ${zeige(wert, v).padEnd(34)} ${woher}`);
  }
  console.log("");

  console.log("Beschaffungsstufen");
  console.log(`  L0 AutoScout24   : ${z.stufen.L0}`);
  console.log(`  L1 Kleinanzeigen : ${z.stufen.L1}`);
  console.log(`  L2 Bright Data   : ${z.stufen.L2}`);
  console.log(`  L3 Apify         : ${z.stufen.L3}`);
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

module.exports = { findeChrome, zeige, ermittle, herkunftKurz, VARIABLEN };
