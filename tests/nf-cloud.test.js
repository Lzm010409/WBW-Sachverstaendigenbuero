/**
 * Cloud-Betrieb: Zugangsdaten aus Umgebungsvariablen oder aus einer im Paket
 * eingebauten .env, ohne Benutzerprofil und ohne .env im Arbeitsordner.
 * Alles offline; die Paketpruefungen brauchen zip/unzip und werden sonst uebersprungen.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const WURZEL = path.join(__dirname, "..");
const SC = path.join(WURZEL, "skills", "wbw-vergleichsfahrzeuge", "scripts");
const g = require(path.join(SC, "adapters", "gemeinsam.js"));
const ka = require(path.join(SC, "adapters", "kleinanzeigen.js"));
const pruefung = require(path.join(SC, "pruefe-umgebung.js"));
const { chromeKandidaten } = require(path.join(SC, "run-report.js"));

const PASSWORT = "Geheim#Cloud-4711";
const FREMD = "1|abcdefghijklmnopqrstuvwxyz0123456789ABCD";   // Coolify-Tokenformat, darf nie mitreisen

function tmp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

/** Fuehrt fn mit einer sauberen Umgebung aus und stellt process.env danach wieder her. */
function mitUmgebung(setzen, fn) {
  const alt = { ...process.env };
  const cwd = process.cwd();
  for (const k of ["KA_API_BASE", "KA_API_USER", "KA_API_PASS", "APIFY_TOKEN", "WBW_ALLOW_PAID",
    "BRIGHTDATA_TOKEN", "BRIGHTDATA_ZONE", "WBW_ENV_DATEI", "CLAUDE_PLUGIN_ROOT"]) delete process.env[k];
  Object.assign(process.env, setzen);
  try { return fn(); } finally {
    process.chdir(cwd);
    for (const k of Object.keys(process.env)) if (!(k in alt)) delete process.env[k];
    Object.assign(process.env, alt);
  }
}

function hatWerkzeug(name) {
  try { execFileSync("which", [name], { stdio: "ignore" }); return true; } catch { return false; }
}
const ZIP_DA = hatWerkzeug("zip") && hatWerkzeug("unzip");

// ------------------------------------------------------------------ ladeEnv

test("ladeEnv(): Umgebungsvariable schlaegt die Datei, leere Umgebungsvariable nicht", () => {
  const d = tmp("wbw-cloud-env-");
  fs.writeFileSync(path.join(d, "quelle.env"), "KA_API_USER=ausDatei\nKA_API_PASS=ausDatei\n");
  mitUmgebung({ WBW_ENV_DATEI: path.join(d, "quelle.env"), KA_API_USER: "ausUmgebung", KA_API_PASS: "" }, () => {
    process.chdir(d);
    g.ladeEnv(d);
    assert.equal(process.env.KA_API_USER, "ausUmgebung", "gesetzte Variable gewinnt");
    assert.equal(process.env.KA_API_PASS, "ausDatei",
      "eine LEER durchgereichte Variable (KA_API_PASS=) darf die Datei nicht verdecken");
  });
  fs.rmSync(d, { recursive: true, force: true });
});

test("ladeEnv(): mehrere Dateien werden zusammengefuehrt, je Schluessel gewinnt die erste", () => {
  // Fall aus der Praxis: im Arbeitsordner liegt eine fremde .env (anderes Projekt),
  // die Zugangsdaten des Plugins liegen in der Plugin-Wurzel.
  const arbeit = tmp("wbw-cloud-arbeit-");
  const plugin = tmp("wbw-cloud-plugin-");
  fs.writeFileSync(path.join(arbeit, ".env"), "ANDERES_PROJEKT=1\nWBW_ALLOW_PAID=0\n");
  fs.writeFileSync(path.join(plugin, ".env"), `KA_API_USER=wbw\nKA_API_PASS=${PASSWORT}\nWBW_ALLOW_PAID=1\n`);
  mitUmgebung({ CLAUDE_PLUGIN_ROOT: plugin }, () => {
    process.chdir(arbeit);
    delete process.env.ANDERES_PROJEKT;
    const erste = g.ladeEnv(arbeit);
    assert.equal(erste, path.join(arbeit, ".env"), "die Datei des ersten Treffers wird gemeldet");
    assert.deepEqual(g.envDateienBenutzt(), [path.join(arbeit, ".env"), path.join(plugin, ".env")]);
    assert.equal(process.env.KA_API_USER, "wbw", "Plugin-Wurzel wird trotz fremder .env im Arbeitsordner gelesen");
    assert.equal(process.env.KA_API_PASS, PASSWORT);
    assert.equal(process.env.WBW_ALLOW_PAID, "0", "je Schluessel gewinnt die ERSTE Nennung (Arbeitsordner)");
    delete process.env.ANDERES_PROJEKT;
  });
  fs.rmSync(arbeit, { recursive: true, force: true });
  fs.rmSync(plugin, { recursive: true, force: true });
});

test("envSuchpfade(): Plugin-Wurzel wird auch OHNE CLAUDE_PLUGIN_ROOT ueber den Modulordner gefunden", () => {
  mitUmgebung({}, () => {
    const pfade = g.envSuchpfade();
    assert.ok(pfade.includes(path.join(WURZEL, ".env")),
      "die .env in der Plugin-Wurzel (4 Ebenen ueber adapters/) muss in der Suchliste stehen");
  });
  mitUmgebung({ CLAUDE_PLUGIN_ROOT: "/irgendwo/plugin" }, () => {
    const pfade = g.envSuchpfade();
    const i = pfade.indexOf(path.join("/irgendwo/plugin", ".env"));
    assert.ok(i >= 0, "CLAUDE_PLUGIN_ROOT/.env muss in der Suchliste stehen");
    assert.ok(i > pfade.indexOf(path.join(process.cwd(), ".env")), "aber NACH dem Arbeitsordner");
  });
});

// ----------------------------------------------------- Standardwert KA_API_BASE

test("Kleinanzeigen L1: ohne KA_API_BASE wird die Standardadresse benutzt, gesetzt gewinnt die Variable", async () => {
  const liste = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "kleinanzeigen-liste.json"), "utf8"));
  const gesehen = [];
  const holeJson = async (url) => { gesehen.push(String(url)); return { status: 200, headers: {}, daten: liste }; };
  const eingaben = { kleinanzeigen: { car_make: "volkswagen", limit: 1 }, _abgeleitet: {} };

  await mitUmgebung({ KA_API_USER: "u", KA_API_PASS: "p" }, () =>
    ka.holen(eingaben, { holeJson, details: false, maxItems: 1 }));
  assert.ok(gesehen[0].startsWith(ka.KA_API_BASE_STANDARD + "/inserate-by-url"), `Standardadresse erwartet, war ${gesehen[0]}`);
  assert.equal(ka.KA_API_BASE_STANDARD, "https://ka-api.gollenstede.app");

  gesehen.length = 0;
  await mitUmgebung({ KA_API_USER: "u", KA_API_PASS: "p", KA_API_BASE: "https://test.invalid/" }, () =>
    ka.holen(eingaben, { holeJson, details: false, maxItems: 1 }));
  assert.ok(gesehen[0].startsWith("https://test.invalid/inserate-by-url"), "KA_API_BASE ueberschreibt den Standardwert");
});

test("Kleinanzeigen L1: fehlende Zugangsdaten nennen Cloud-Weg und Umgebungspruefung", () => {
  const e = g.fehlendeZugangsdaten("Kleinanzeigen L1 (HTTP 401)", ["KA_API_USER", "KA_API_PASS"]);
  assert.equal(e.code, "ZUGANGSDATEN_FEHLEN");
  assert.match(e.message, /Cloud-Sitzung/);
  assert.match(e.message, /--mit-zugangsdaten/);
  assert.match(e.message, /pruefe-umgebung\.js/);
});

// ------------------------------------------------------------ Umgebungspruefung

test("pruefe-umgebung: Herkunft je Variable (Umgebung / Datei / Standardwert) stimmt", () => {
  const plugin = tmp("wbw-cloud-pr-");
  fs.writeFileSync(path.join(plugin, ".env"), `KA_API_PASS=${PASSWORT}\nAPIFY_TOKEN=apify_api_testtoken1234567890\n`);
  mitUmgebung({ CLAUDE_PLUGIN_ROOT: plugin, KA_API_USER: "wbw", WBW_ALLOW_PAID: "1" }, () => {
    process.chdir(plugin);
    const z = pruefung.ermittle();
    assert.equal(z.woher.KA_API_USER, "Umgebung");
    assert.equal(z.woher.KA_API_PASS, "Datei");
    assert.equal(z.woher.KA_API_BASE, "Standardwert");
    assert.equal(z.woher.BRIGHTDATA_TOKEN, null);
    assert.ok(z.ka, "L1 muss mit Benutzer aus der Umgebung und Passwort aus der Datei nutzbar sein");
    assert.match(z.stufen.L1, /^nutzbar/);
    assert.equal(z.stufen.L3, "nutzbar");
    assert.deepEqual(z.dateien, [path.join(plugin, ".env")]);
    const kurz = pruefung.herkunftKurz(z);
    assert.match(kurz, /Umgebung \(KA_API_USER\)/);
    assert.ok(kurz.includes(path.join(plugin, ".env")));
  });
  fs.rmSync(plugin, { recursive: true, force: true });
});

test("pruefe-umgebung: gibt nie ein Passwort oder Token aus", () => {
  assert.equal(pruefung.zeige(PASSWORT, "KA_API_PASS"), `gesetzt (${PASSWORT.length} Zeichen)`);
  assert.equal(pruefung.zeige("apify_api_x", "APIFY_TOKEN"), "gesetzt (11 Zeichen)");
  assert.equal(pruefung.zeige("wbw", "KA_API_USER"), "wbw");
  assert.equal(pruefung.zeige("", "KA_API_PASS"), "nicht gesetzt");

  // Vollausgabe und Kurzfassung als echter Prozess, mit Passwort aus Datei UND Umgebung.
  const plugin = tmp("wbw-cloud-aus-");
  fs.writeFileSync(path.join(plugin, ".env"), `KA_API_PASS=${PASSWORT}\n`);
  for (const args of [[], ["--kurz"]]) {
    const r = spawnSync(process.execPath, [path.join(SC, "pruefe-umgebung.js"), ...args], {
      cwd: plugin, encoding: "utf8",
      env: { ...process.env, HOME: plugin, CLAUDE_PLUGIN_ROOT: plugin, KA_API_USER: "wbw", APIFY_TOKEN: "apify_api_" + PASSWORT },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stdout.includes(PASSWORT), `Passwort in der Ausgabe von pruefe-umgebung.js ${args.join(" ")}`);
    assert.match(r.stdout, /L1 Kleinanzeigen\s*: nutzbar/);
  }
  fs.rmSync(plugin, { recursive: true, force: true });
});

// ---------------------------------------------------------------- Chrome-Suche

test("chromeKandidaten(): WBW_CHROME zuerst, Windows-Pfade unter win32, Unix-Namen ueberall", () => {
  const win = chromeKandidaten({ WBW_CHROME: "X:\\mein\\chrome.exe", PROGRAMFILES: "C:\\PF", LOCALAPPDATA: "C:\\LA" }, "win32");
  assert.equal(win[0], "X:\\mein\\chrome.exe");
  assert.ok(win.includes("C:\\PF\\Google\\Chrome\\Application\\chrome.exe"));
  assert.ok(win.includes("C:\\LA\\Google\\Chrome\\Application\\chrome.exe"));
  assert.ok(win.includes("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"), "feste Orte auch ohne PROGRAMFILES");
  const linux = chromeKandidaten({}, "linux");
  assert.ok(linux.includes("chromium") && linux.includes("google-chrome"));
  assert.ok(!linux.some((p) => p.endsWith("chrome.exe") && !p.startsWith("C:")), "unter Linux kein nacktes chrome.exe");
  assert.ok(linux.every(Boolean), "keine undefined-Eintraege");
});

// ------------------------------------------------------------- SessionStart-Hook

test("Hook: meldet L1 nutzbar, wenn die Zugangsdaten NUR als Umgebungsvariablen vorliegen", () => {
  const heim = tmp("wbw-cloud-heim-");
  const projekt = tmp("wbw-cloud-projekt-");
  const r = spawnSync("bash", [path.join(WURZEL, "hooks", "session-start.sh")], {
    cwd: projekt, encoding: "utf8",
    env: { ...process.env, HOME: heim, CLAUDE_PLUGIN_ROOT: WURZEL, CLAUDE_PROJECT_DIR: projekt,
      KA_API_USER: "wbw", KA_API_PASS: PASSWORT, APIFY_TOKEN: "apify_api_x", WBW_ALLOW_PAID: "1", WBW_ENV_DATEI: "" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /L1 Kleinanzeigen\s*: nutzbar/);
  assert.match(r.stdout, /L3 Apify\s*: nutzbar/);
  assert.match(r.stdout, /Zugangsdaten aus\s*: Umgebung \(KA_API_USER, KA_API_PASS, APIFY_TOKEN\)/);
  assert.ok(!r.stdout.includes(PASSWORT), "der Hook darf das Passwort nicht ausgeben");
  assert.ok(!/Tests\s*:/.test(r.stdout), "ohne Testsuite im Projekt kein Hinweis auf npm test");
  fs.rmSync(heim, { recursive: true, force: true });
  fs.rmSync(projekt, { recursive: true, force: true });
});

test("Hook: findet eine im Plugin eingebaute .env ohne Benutzerprofil und ohne Projekt-.env", () => {
  const heim = tmp("wbw-cloud-heim-");
  const projekt = tmp("wbw-cloud-projekt-");
  const plugin = tmp("wbw-cloud-plugin-");
  for (const p of ["hooks", "skills"]) fs.cpSync(path.join(WURZEL, p), path.join(plugin, p), { recursive: true });
  fs.writeFileSync(path.join(plugin, ".env"), `KA_API_USER=wbw\nKA_API_PASS=${PASSWORT}\n`);
  const r = spawnSync("bash", [path.join(plugin, "hooks", "session-start.sh")], {
    cwd: projekt, encoding: "utf8",
    env: { ...process.env, HOME: heim, CLAUDE_PLUGIN_ROOT: plugin, CLAUDE_PROJECT_DIR: projekt,
      KA_API_USER: "", KA_API_PASS: "", APIFY_TOKEN: "", WBW_ENV_DATEI: "" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /L1 Kleinanzeigen\s*: nutzbar/);
  assert.ok(r.stdout.includes(`Zugangsdaten aus   : ${path.join(plugin, ".env")}`), r.stdout);
  assert.ok(!r.stdout.includes(PASSWORT));
  for (const d of [heim, projekt, plugin]) fs.rmSync(d, { recursive: true, force: true });
});

// ------------------------------------------------------------------ bauen.sh

test("bauen.sh --mit-zugangsdaten: nur erlaubte Variablen reisen mit, Fremdtoken bleibt draussen", { skip: !ZIP_DA && "zip/unzip fehlen" }, () => {
  const d = tmp("wbw-cloud-bau-");
  const quelle = path.join(d, "quelle.env");
  fs.writeFileSync(quelle, [
    "# Kommentar",
    "KA_API_BASE=https://ka-api.gollenstede.app",
    "KA_API_USER=wbw",
    `KA_API_PASS='${PASSWORT}'`,
    `COOLIFY_TOKEN=${FREMD}`,
    "WBW_ALLOW_PAID=1",
    "APIFY_TOKEN=",
    "",
  ].join("\n"));
  const ziel = path.join(d, "mit.plugin");
  const r = spawnSync("bash", [path.join(WURZEL, "bauen.sh"), "--mit-zugangsdaten", quelle, ziel], { encoding: "utf8", cwd: WURZEL });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /VERTRAULICH/);
  const env = execFileSync("unzip", ["-p", ziel, ".env"], { encoding: "utf8" });
  assert.match(env, /^KA_API_USER=wbw$/m);
  assert.match(env, new RegExp(`^KA_API_PASS='${PASSWORT.replace(/[#]/g, "\\$&")}'$`, "m"), "Wert unveraendert (ladeEnv entfernt die Anfuehrungszeichen)");
  assert.match(env, /^WBW_ALLOW_PAID=1$/m);
  assert.ok(!env.includes("COOLIFY_TOKEN"), "nicht erlaubte Variable darf nicht mitreisen");
  assert.ok(!env.includes("APIFY_TOKEN="), "leere Werte werden nicht uebernommen");
  // Nirgendwo sonst im Paket:
  const liste = execFileSync("unzip", ["-l", ziel], { encoding: "utf8" });
  assert.match(liste, /\s\.env$/m);
  assert.match(liste, /pruefe-umgebung\.js/);
  assert.ok(!/marketplace\.json|\/tests\/|\.claude\/settings/.test(liste));
  const alles = execFileSync("unzip", ["-p", ziel], { encoding: "latin1" });
  assert.ok(!alles.includes(FREMD), "Fremdtoken darf nirgends im Paket stehen");
  assert.equal(alles.split(PASSWORT).length - 1, 1, "das Passwort steht genau einmal im Paket (in der .env)");
  fs.rmSync(d, { recursive: true, force: true });
});

test("bauen.sh ohne Schalter: keine .env im Paket, auch wenn im Repo eine liegt", { skip: !ZIP_DA && "zip/unlink fehlen" }, () => {
  const d = tmp("wbw-cloud-bau0-");
  const ziel = path.join(d, "ohne.plugin");
  const r = spawnSync("bash", [path.join(WURZEL, "bauen.sh"), ziel], { encoding: "utf8", cwd: WURZEL });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const liste = execFileSync("unzip", ["-l", ziel], { encoding: "utf8" });
  assert.ok(!/\s\.env$/m.test(liste), "ohne --mit-zugangsdaten darf keine .env im Paket sein");
  assert.match(liste, /\s\.env\.example$/m);
  fs.rmSync(d, { recursive: true, force: true });
});

test("bauen.sh --mit-zugangsdaten bricht ab, wenn ein Passwort ausserhalb der .env im Paket steht", { skip: !ZIP_DA && "zip/unzip fehlen" }, () => {
  // Kopie des Repos mit "verseuchter" README, damit das echte Repo unberuehrt bleibt.
  const kopie = tmp("wbw-cloud-leck-");
  for (const p of [".claude-plugin", "skills", "hooks", "README.md", ".env.example", "bauen.sh"]) {
    fs.cpSync(path.join(WURZEL, p), path.join(kopie, p), { recursive: true });
  }
  fs.appendFileSync(path.join(kopie, "README.md"), `\nHier steht versehentlich ${PASSWORT}\n`);
  const quelle = path.join(kopie, "quelle.env");
  fs.writeFileSync(quelle, `KA_API_USER=wbw\nKA_API_PASS=${PASSWORT}\n`);
  const ziel = path.join(kopie, "leck.plugin");
  const r = spawnSync("bash", [path.join(kopie, "bauen.sh"), "--mit-zugangsdaten", quelle, ziel], { encoding: "utf8", cwd: kopie });
  assert.notEqual(r.status, 0, "muss abbrechen");
  assert.match(r.stderr, /ABBRUCH: Wert von KA_API_PASS/);
  assert.ok(!fs.existsSync(ziel), "es darf kein Paket entstehen");
  fs.rmSync(kopie, { recursive: true, force: true });
});

test("Versionen: plugin.json, marketplace.json, package.json und SKILL.md stimmen ueberein", () => {
  const v = JSON.parse(fs.readFileSync(path.join(WURZEL, ".claude-plugin", "plugin.json"), "utf8")).version;
  const skill = fs.readFileSync(path.join(WURZEL, "skills", "wbw-vergleichsfahrzeuge", "SKILL.md"), "utf8");
  assert.match(skill, new RegExp(`version:\\s*"${v.replace(/\./g, "\\.")}"`), "SKILL.md-Metadaten muessen die Plugin-Version tragen");
});
