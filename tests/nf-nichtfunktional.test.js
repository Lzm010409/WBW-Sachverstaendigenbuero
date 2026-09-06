/**
 * Nicht-funktionale Prüfungen: Ratenlimit-Treue, Kostensperre, keine Secrets.
 * Alles offline.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const WURZEL = path.join(__dirname, "..");
const SC = path.join(WURZEL, "skills", "wbw-vergleichsfahrzeuge", "scripts");
const g = require(path.join(SC, "adapters", "gemeinsam.js"));
const as24 = require(path.join(SC, "adapters", "autoscout24.js"));
const ka = require(path.join(SC, "adapters", "kleinanzeigen.js"));
const apify = require(path.join(SC, "adapters", "apify.js"));

const FIX = path.join(__dirname, "fixtures");
const fixtureHtml = () => {
  const fx = JSON.parse(fs.readFileSync(path.join(FIX, "autoscout24-suchseite.json"), "utf8"));
  return '<script id="__NEXT_DATA__" type="application/json">' + JSON.stringify(fx) + "</script>";
};

test("Ratenlimit: zwischen Seitenabrufen liegen mindestens 1,5 s", async () => {
  const stempel = [];
  const html = fixtureHtml();
  await as24.holen(
    { autoScout: { make: "volkswagen", model: "golf", maxResults: 100 }, _abgeleitet: {} },
    {
      maxItems: 15, maxSeiten: 3,
      hole: async () => { stempel.push(Date.now()); return { status: 200, headers: {}, body: html }; },
      // echte Pause, nicht gefälscht — genau die soll ja nachgewiesen werden
    }
  );
  assert.ok(stempel.length >= 3, `zu wenige Abrufe: ${stempel.length}`);
  for (let i = 1; i < stempel.length; i++) {
    const abstand = stempel[i] - stempel[i - 1];
    assert.ok(abstand >= 1500, `Abstand Abruf ${i} -> ${i + 1} war nur ${abstand} ms (Mindestpause 1500 ms)`);
  }
});

test("Ratenlimit: auch zwischen Kleinanzeigen-Detailabrufen wird pausiert", async () => {
  const stempel = [];
  const liste = JSON.parse(fs.readFileSync(path.join(FIX, "kleinanzeigen-liste.json"), "utf8"));
  const detail = JSON.parse(fs.readFileSync(path.join(FIX, "kleinanzeigen-detail.json"), "utf8"))[0];
  await ka.holen(
    { kleinanzeigen: { car_make: "volkswagen", limit: 3 }, _abgeleitet: {} },
    {
      endpoint: "https://beispiel.invalid", maxItems: 3,
      holeJson: async (url) => {
        if (String(url).includes("/inserate-by-url")) return { status: 200, headers: {}, daten: liste };
        stempel.push(Date.now());
        return { status: 200, headers: {}, daten: detail };
      },
    }
  );
  assert.ok(stempel.length >= 3, `zu wenige Detailabrufe: ${stempel.length}`);
  for (let i = 1; i < stempel.length; i++) {
    assert.ok(stempel[i] - stempel[i - 1] >= 1500, `Detailabrufe zu dicht: ${stempel[i] - stempel[i - 1]} ms`);
  }
});

test("pause() wartet wirklich", async () => {
  const t0 = Date.now();
  await g.pause(400);
  assert.ok(Date.now() - t0 >= 380, "pause() darf nicht wegoptimiert werden");
});

test("Kostensperre: L3/Apify verweigert ohne WBW_ALLOW_PAID", () => {
  const alt = process.env.WBW_ALLOW_PAID;
  delete process.env.WBW_ALLOW_PAID;
  try {
    assert.throws(() => apify.pruefeFreigabe(), (e) => e.code === "L3_GESPERRT");
  } finally { if (alt !== undefined) process.env.WBW_ALLOW_PAID = alt; }
});

test("Kostensperre: holen() bricht ab, bevor irgendein Netzaufruf passiert", async () => {
  const alt = process.env.WBW_ALLOW_PAID;
  delete process.env.WBW_ALLOW_PAID;
  try {
    await assert.rejects(
      () => apify.holen({ mobileDe: {} }, { actor: "beliebig/actor", inputKey: "mobileDe" }),
      (e) => e.code === "L3_GESPERRT"
    );
  } finally { if (alt !== undefined) process.env.WBW_ALLOW_PAID = alt; }
});

test("Kostensperre: der normale Testlauf setzt WBW_ALLOW_PAID nicht", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(WURZEL, "package.json"), "utf8"));
  assert.ok(!/WBW_ALLOW_PAID/.test(pkg.scripts.test), "npm test darf die Kostensperre nicht aufheben");
  assert.ok(!/e4|live|l3|schema/i.test(pkg.scripts.test), `npm test darf keine Netz-/Kostenläufe enthalten: ${pkg.scripts.test}`);
});

test("Kein Secret im Repo: providers.json und Adapter enthalten keine Token", () => {
  const dateien = [
    path.join(SC, "providers.json"),
    ...fs.readdirSync(path.join(SC, "adapters")).map((n) => path.join(SC, "adapters", n)),
  ];
  const muster = [
    /apify_api_[A-Za-z0-9]{10,}/i,
    /\b[0-9]+\|[A-Za-z0-9]{30,}\b/,          // Coolify-Token-Format
    /Bearer\s+[A-Za-z0-9._~+/-]{20,}/,
    /"(APIFY_TOKEN|BRIGHTDATA_TOKEN|KA_API_PASS)"\s*:\s*"[^"]{6,}"/,
  ];
  for (const d of dateien) {
    const s = fs.readFileSync(d, "utf8");
    for (const m of muster) assert.ok(!m.test(s), `mögliches Secret in ${path.basename(d)}: ${m}`);
  }
});

test("Kein Secret: .env ist ignoriert, .env.example ohne Werte", () => {
  const gi = fs.readFileSync(path.join(WURZEL, ".gitignore"), "utf8");
  assert.ok(/^\.env$/m.test(gi), ".env muss in .gitignore stehen");
  const bsp = fs.readFileSync(path.join(WURZEL, ".env.example"), "utf8");
  for (const z of bsp.split("\n")) {
    if (!z.includes("=") || z.trim().startsWith("#")) continue;
    const [k, ...rest] = z.split("=");
    const wert = rest.join("=").trim();
    if (/TOKEN|PASS|USER|SECRET/i.test(k)) {
      assert.equal(wert, "", `.env.example darf keinen Wert für ${k.trim()} enthalten`);
    }
  }
});

test("Idempotenz: dasselbe Mapping zweimal ergibt dasselbe Ergebnis", () => {
  const fx = JSON.parse(fs.readFileSync(path.join(FIX, "autoscout24-suchseite.json"), "utf8"));
  const ls = as24.findeListings(fx);
  const a = ls.map((l) => as24.mappe(l));
  const b = ls.map((l) => as24.mappe(l));
  assert.deepEqual(a, b, "mappe() muss deterministisch sein");
});

test("ladeEnv() liest eine .env, ohne gesetzte Variablen zu überschreiben", () => {
  const os = require("os");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "wbw-env-"));
  fs.writeFileSync(path.join(d, ".env"), [
    "# Kommentar wird ignoriert",
    "",
    "WBW_TEST_NEU=ausDerDatei",
    "WBW_TEST_VORHANDEN=ausDerDatei",
    'WBW_TEST_QUOTED="mit Anführungszeichen"',
    "WBW_TEST_LEER=",
    "kein_gleichheitszeichen",
  ].join("\n"));

  const alt = { ...process.env };
  process.env.WBW_TEST_VORHANDEN = "ausDerUmgebung";
  delete process.env.WBW_TEST_NEU;
  delete process.env.WBW_TEST_QUOTED;
  delete process.env.WBW_TEST_LEER;
  process.env.WBW_ENV_DATEI = path.join(d, ".env");
  try {
    const datei = g.ladeEnv(d);
    assert.equal(datei, path.join(d, ".env"));
    assert.equal(process.env.WBW_TEST_NEU, "ausDerDatei");
    assert.equal(process.env.WBW_TEST_VORHANDEN, "ausDerUmgebung",
      "eine bewusst gesetzte Variable darf die Datei NICHT überschreiben");
    assert.equal(process.env.WBW_TEST_QUOTED, "mit Anführungszeichen", "Anführungszeichen werden entfernt");
    assert.equal(process.env.WBW_TEST_LEER, undefined, "leere Werte werden nicht gesetzt");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in alt)) delete process.env[k];
    Object.assign(process.env, alt);
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test("ladeEnv() ohne .env liefert null statt zu werfen", () => {
  const os = require("os");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "wbw-leer-"));
  const alt = process.env.WBW_ENV_DATEI;
  process.env.WBW_ENV_DATEI = path.join(d, "gibtsnicht.env");
  try {
    // Aufwärtssuche findet die .env des Repos ggf. trotzdem — der Test prüft nur,
    // dass nichts wirft und der Rückgabewert ein Pfad oder null ist.
    const r = g.ladeEnv(d);
    assert.ok(r === null || typeof r === "string");
  } finally {
    if (alt === undefined) delete process.env.WBW_ENV_DATEI; else process.env.WBW_ENV_DATEI = alt;
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test("ladeEnv() bevorzugt den Arbeitsordner vor dem globalen Ort", () => {
  // Wichtig fuer installierte Plugins: die .env eines konkreten Vorgangs muss
  // die globale Datei im Benutzerprofil schlagen koennen.
  const os = require("os");
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "wbw-vorrang-"));
  const lokal = path.join(d, ".env");
  fs.writeFileSync(lokal, "WBW_TEST_VORRANG=ausDemArbeitsordner\n");
  const alt = { ...process.env };
  delete process.env.WBW_TEST_VORRANG;
  delete process.env.WBW_ENV_DATEI;
  const cwd = process.cwd();
  try {
    process.chdir(d);
    const datei = g.ladeEnv(d);
    assert.equal(datei, lokal, "die .env im Arbeitsordner muss gewinnen");
    assert.equal(process.env.WBW_TEST_VORRANG, "ausDemArbeitsordner");
  } finally {
    process.chdir(cwd);
    for (const k of Object.keys(process.env)) if (!(k in alt)) delete process.env[k];
    Object.assign(process.env, alt);
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test("globaleEnvDatei() zeigt auf einen Ort, der Plugin-Updates überlebt", () => {
  const os = require("os");
  const p = g.globaleEnvDatei();
  assert.equal(p, path.join(os.homedir(), ".claude", "wbw-vergleichsfahrzeuge.env"));
  // Nicht im Plugin-Cache: der wird bei jedem Update ersetzt.
  assert.ok(!/plugins[\/\\]cache/.test(p), "darf nicht im Plugin-Cache liegen");
});

test("Marketplace-Manifest ist vollständig und zeigt auf die Plugin-Wurzel", () => {
  const m = JSON.parse(fs.readFileSync(path.join(WURZEL, ".claude-plugin", "marketplace.json"), "utf8"));
  assert.ok(m.name && m.description && m.owner && m.owner.name);
  assert.equal(m.plugins.length, 1);
  const p0 = m.plugins[0];
  assert.equal(p0.source, "./", "die Plugin-Wurzel ist das Repo-Wurzelverzeichnis");
  const manifest = JSON.parse(fs.readFileSync(path.join(WURZEL, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(p0.name, manifest.name, "Name muss zum Plugin-Manifest passen");
  assert.equal(p0.version, manifest.version, "Version muss zum Plugin-Manifest passen");
  const pkg = JSON.parse(fs.readFileSync(path.join(WURZEL, "package.json"), "utf8"));
  assert.equal(manifest.version, pkg.version, "und zu package.json — sonst driften die Versionen auseinander");
});

test("Der SessionStart-Hook liegt im Plugin und ist an beiden Stellen registriert", () => {
  // Der Hook muss IM Plugin liegen, nicht unter .claude/ - sonst reist er weder
  // in der .plugin-Datei noch bei einer Marketplace-Installation mit.
  const h = path.join(WURZEL, "hooks", "session-start.sh");
  assert.ok(fs.existsSync(h), "hooks/session-start.sh muss existieren");
  assert.ok(fs.statSync(h).mode & 0o111, "muss ausführbar sein");

  // 1. Plugin-Registrierung (reist mit)
  const hj = JSON.parse(fs.readFileSync(path.join(WURZEL, "hooks", "hooks.json"), "utf8"));
  const pluginCmds = hj.hooks.SessionStart.flatMap((e) => e.hooks).map((x) => x.command);
  assert.ok(pluginCmds.some((c) => c.includes("${CLAUDE_PLUGIN_ROOT}/hooks/session-start.sh")),
    "muss über ${CLAUDE_PLUGIN_ROOT} referenziert sein, nicht über einen festen Pfad");

  // 2. Projekt-Registrierung (für die Arbeit aus dem Repo heraus)
  const s = JSON.parse(fs.readFileSync(path.join(WURZEL, ".claude", "settings.json"), "utf8"));
  const projektCmds = s.hooks.SessionStart.flatMap((e) => e.hooks).map((x) => x.command);
  assert.ok(projektCmds.some((c) => c.includes("hooks/session-start.sh")));
  assert.ok(!projektCmds.some((c) => c.includes(".claude/hooks/")),
    "der alte Ort unter .claude/ darf nicht mehr referenziert werden");
});

test("Der Hook meldet Tests nur, wenn sie tatsächlich danebenliegen", () => {
  // In einer reinen Plugin-Installation gibt es keine Testsuite - ein Hinweis
  // auf `npm test` waere dort eine Sackgasse.
  const s = fs.readFileSync(path.join(WURZEL, "hooks", "session-start.sh"), "utf8");
  assert.match(s, /if \[ -f "\$WURZEL\/package\.json" \] && \[ -d "\$WURZEL\/tests" \]/);
});
