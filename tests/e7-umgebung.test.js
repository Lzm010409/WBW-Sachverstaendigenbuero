"use strict";
// E7 - die Umgebungspruefung.
//
// Sie ist das Werkzeug fuer den Fall "ich habe die Zugangsdaten doch
// hinterlegt, trotzdem 0 Treffer". Zwei Eigenschaften muss sie haben: sie darf
// nie ein Passwort ausgeben (die Ausgabe wird weitergeschickt), und sie muss
// auch dann durchlaufen, wenn gar nichts eingerichtet ist - gerade dann.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SKRIPT = path.join(__dirname, "..", "skills", "wbw-vergleichsfahrzeuge", "scripts", "pruefe-umgebung.js");
const { chromeKandidaten } = require("../skills/wbw-vergleichsfahrzeuge/scripts/run-report.js");

const GEHEIM = "streng-geheimes-passwort-4711";

// Die Suche nach der Zugangsdaten-Datei laeuft auch von der Skriptdatei
// aufwaerts - vom Repo aus gestartet findet sie also immer die echte .env.
// Der Test kopiert die Skripte deshalb in einen leeren Ordner: das ist
// zugleich die realistischere Lage, naemlich ein installiertes Plugin.
function sandkasten() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wbw-e7-"));
  const ziel = path.join(dir, "plugin", "scripts");
  fs.cpSync(path.join(__dirname, "..", "skills", "wbw-vergleichsfahrzeuge", "scripts"), ziel, { recursive: true });
  return {
    dir,
    skript: path.join(ziel, "pruefe-umgebung.js"),
    weg: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function starte(env, s) {
  return spawnSync(process.execPath, [s.skript], {
    cwd: s.dir,
    env: { PATH: process.env.PATH, HOME: s.dir, ...env },
    encoding: "utf8",
    timeout: 30000,
  });
}

test("das Passwort steht nie in der Ausgabe, nur seine Laenge", () => {
  const s = sandkasten();
  try {
    const datei = path.join(s.dir, "zugang.env");
    fs.writeFileSync(datei, `KA_API_BASE=https://beispiel.invalid\nKA_API_USER=wbw\nKA_API_PASS=${GEHEIM}\nAPIFY_TOKEN=apify_api_geheim\n`);
    const lauf = starte({ WBW_ENV_DATEI: datei }, s);
    assert.strictEqual(lauf.status, 0, lauf.stderr);
    const alles = lauf.stdout + lauf.stderr;
    assert.ok(!alles.includes(GEHEIM), "das Passwort steht in der Ausgabe");
    assert.ok(!alles.includes("apify_api_geheim"), "der Token steht in der Ausgabe");
    assert.match(alles, new RegExp(`KA_API_PASS\\s+gesetzt \\(${GEHEIM.length} Zeichen\\)`));
    assert.match(alles, /KA_API_BASE\s+https:\/\/beispiel\.invalid/);
  } finally { s.weg(); }
});

test("ohne jede Einrichtung laeuft die Pruefung durch und sagt, was fehlt", () => {
  const s = sandkasten();
  try {
    const lauf = starte({}, s);
    assert.strictEqual(lauf.status, 0, lauf.stderr);
    assert.match(lauf.stdout, /KEINE gefunden/);
    assert.match(lauf.stdout, /L1 Kleinanzeigen : NICHT nutzbar/);
    assert.match(lauf.stdout, /L3 Apify\s+: NICHT nutzbar/);
    assert.match(lauf.stdout, /L0 AutoScout24\s+: nutzbar/);
  } finally { s.weg(); }
});

test("sie zeigt an, ob ein Wert aus der Umgebung oder aus der Datei kommt", () => {
  const s = sandkasten();
  try {
    const datei = path.join(s.dir, "zugang.env");
    fs.writeFileSync(datei, "KA_API_USER=aus_datei\n");
    const lauf = starte({ WBW_ENV_DATEI: datei, KA_API_BASE: "https://aus-umgebung.invalid" }, s);
    assert.match(lauf.stdout, /KA_API_BASE\s+https:\/\/aus-umgebung\.invalid\s+Umgebung/);
    assert.match(lauf.stdout, /KA_API_USER\s+aus_datei\s+Datei/);
  } finally { s.weg(); }
});

test("ein gesetzter APIFY_TOKEN ohne WBW_ALLOW_PAID gilt als gesperrt, nicht als nutzbar", () => {
  const s = sandkasten();
  try {
    const lauf = starte({ APIFY_TOKEN: "apify_api_x" }, s);
    assert.match(lauf.stdout, /L3 Apify\s+: gesperrt - WBW_ALLOW_PAID muss auf 1 stehen/);
  } finally { s.weg(); }
});

// --- Chrome-Suche -----------------------------------------------------------
//
// Ein echter Befund aus dem Betrieb: auf einem Windows-Rechner MIT installiertem
// Chrome meldete der Report "kein Chromium gefunden", weil die Kandidatenliste
// nur Unix- und macOS-Pfade kannte.

test("unter Windows stehen Chrome und Edge in der Kandidatenliste", () => {
  const k = chromeKandidaten({
    "PROGRAMFILES": "C:\\Program Files",
    "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
    LOCALAPPDATA: "C:\\Users\\Luke\\AppData\\Local",
  }, "win32");
  assert.ok(k.includes("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"));
  assert.ok(k.includes("C:\\Users\\Luke\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe"));
  assert.ok(k.some((p) => p.endsWith("msedge.exe")), "Edge fehlt als Rueckfall");
});

test("auch ohne gesetzte PROGRAMFILES-Variablen bleiben die ueblichen Windows-Orte drin", () => {
  const k = chromeKandidaten({}, "win32");
  assert.ok(k.includes("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"));
});

test("ein ausdruecklich gesetzter Pfad steht immer vorn", () => {
  const k = chromeKandidaten({ WBW_CHROME: "/eigener/pfad/chrome" }, "linux");
  assert.strictEqual(k[0], "/eigener/pfad/chrome");
});

test("unter Linux bleiben die bisherigen Kandidaten erhalten", () => {
  const k = chromeKandidaten({}, "linux");
  for (const erwartet of ["google-chrome", "chromium", "chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]) {
    assert.ok(k.includes(erwartet), `${erwartet} fehlt`);
  }
});

// --- Mehrere Dateien --------------------------------------------------------
//
// Befund beim Nachbauen einer Installation: frueher nahm die Suche die ERSTE
// gefundene Datei und hoerte auf. Eine fremde .env im Arbeitsordner - fuer
// irgendein anderes Projekt, ohne KA_-Schluessel - hat damit die Zugangsdaten
// des Plugins vollstaendig verdeckt. Jetzt werden alle Dateien in der
// Suchreihenfolge zusammengefuehrt, je Schluessel gewinnt die erste Nennung.

test("eine fremde .env im Arbeitsordner verdeckt die Zugangsdaten nicht mehr", () => {
  const s = sandkasten();
  try {
    // Fremde .env im Arbeitsordner, ohne jeden KA_-Schluessel.
    fs.writeFileSync(path.join(s.dir, ".env"), "IRGENDWAS_ANDERES=egal\n");
    // Zugangsdaten dort, wo das Plugin liegt.
    fs.writeFileSync(path.join(s.dir, "plugin", ".env"),
      `KA_API_BASE=https://beispiel.invalid\nKA_API_USER=wbw\nKA_API_PASS=${GEHEIM}\n`);
    const lauf = starte({ CLAUDE_PLUGIN_ROOT: path.join(s.dir, "plugin") }, s);
    assert.strictEqual(lauf.status, 0, lauf.stderr);
    assert.match(lauf.stdout, /L1 Kleinanzeigen : nutzbar/,
      "die Zugangsdaten des Plugins wurden von der fremden .env verdeckt");
    assert.ok(!lauf.stdout.includes(GEHEIM));
  } finally { s.weg(); }
});

test("die naeher liegende Datei gewinnt je Schluessel, nicht die ganze Datei", () => {
  const s = sandkasten();
  try {
    fs.writeFileSync(path.join(s.dir, ".env"), "KA_API_USER=aus_arbeitsordner\n");
    fs.writeFileSync(path.join(s.dir, "plugin", ".env"),
      "KA_API_USER=aus_plugin\nKA_API_BASE=https://aus-plugin.invalid\nKA_API_PASS=xxxxxxxxxx\n");
    const lauf = starte({ CLAUDE_PLUGIN_ROOT: path.join(s.dir, "plugin") }, s);
    // Benutzer aus dem Arbeitsordner (steht frueher in der Reihenfolge),
    // Basis und Passwort aus dem Plugin - die Dateien ergaenzen sich.
    assert.match(lauf.stdout, /KA_API_USER\s+aus_arbeitsordner/);
    assert.match(lauf.stdout, /KA_API_BASE\s+https:\/\/aus-plugin\.invalid/);
    assert.match(lauf.stdout, /L1 Kleinanzeigen : nutzbar/);
  } finally { s.weg(); }
});

test("beide Dateien werden in der Ausgabe genannt", () => {
  const s = sandkasten();
  try {
    fs.writeFileSync(path.join(s.dir, ".env"), "KA_API_USER=a\n");
    fs.writeFileSync(path.join(s.dir, "plugin", ".env"), "KA_API_BASE=https://b.invalid\n");
    const lauf = starte({ CLAUDE_PLUGIN_ROOT: path.join(s.dir, "plugin") }, s);
    const zeilen = lauf.stdout.split("\n").filter((z) => z.includes("benutzt:"));
    assert.strictEqual(zeilen.length, 2, "es muessen beide Dateien genannt werden:\n" + lauf.stdout);
  } finally { s.weg(); }
});
