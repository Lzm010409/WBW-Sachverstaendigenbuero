"use strict";
// E6 - Zugriffsschutz des Kleinanzeigen-Dienstes.
//
// Der Vorschalter ersetzt den Traefik-Labelsatz. Was hier gruen ist, ist genau
// das, was in Coolify spaeter den Dienst schuetzt: ohne Zugangsdaten kein
// Durchkommen, mit richtigen Zugangsdaten unveraenderte Weiterleitung.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { baueServer, zugangsdaten, gleich } =
  require("../ops/ka-api/auth-proxy/proxy.js");

const BENUTZER = "wbw";
const PASSWORT = "geheim-fuer-den-test-123";

// --- Hilfsmittel ------------------------------------------------------------

function lauschen(server) {
  return new Promise((fertig) => server.listen(0, "127.0.0.1", () => fertig(server.address().port)));
}

function schliessen(server) {
  return new Promise((fertig) => server.close(fertig));
}

function anfragen(port, pfad, opts = {}) {
  return new Promise((fertig, scheitern) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: pfad, method: opts.method || "GET", headers: opts.headers || {} },
      (res) => {
        const stuecke = [];
        res.on("data", (d) => stuecke.push(d));
        res.on("end", () => fertig({
          status: res.statusCode,
          kopf: res.headers,
          koerper: Buffer.concat(stuecke).toString("utf8"),
        }));
      }
    );
    req.on("error", scheitern);
    if (opts.koerper !== undefined) req.write(opts.koerper);
    req.end();
  });
}

function basic(benutzer, passwort) {
  return { authorization: "Basic " + Buffer.from(`${benutzer}:${passwort}`).toString("base64") };
}

// Nimmt jede Anfrage entgegen und spiegelt zurueck, was angekommen ist -
// so laesst sich pruefen, ob der Vorschalter wirklich nichts verbiegt.
function stubDienst(gesehen) {
  return http.createServer((req, res) => {
    const stuecke = [];
    req.on("data", (d) => stuecke.push(d));
    req.on("end", () => {
      gesehen.push({
        methode: req.method,
        url: req.url,
        kopf: req.headers,
        koerper: Buffer.concat(stuecke).toString("utf8"),
      });
      res.writeHead(200, { "Content-Type": "application/json", "X-Vom-Dienst": "ja" });
      res.end(JSON.stringify({ success: true }));
    });
  });
}

async function aufbau() {
  const gesehen = [];
  const dienst = stubDienst(gesehen);
  const dienstPort = await lauschen(dienst);
  const proxy = baueServer({
    benutzer: BENUTZER,
    passwort: PASSWORT,
    upstream: `http://127.0.0.1:${dienstPort}`,
    realm: "WBW-Beschaffung",
  });
  const proxyPort = await lauschen(proxy);
  return {
    gesehen, proxyPort,
    abbau: async () => { await schliessen(proxy); await schliessen(dienst); },
  };
}

// --- Der Schutz selbst ------------------------------------------------------

test("ohne Zugangsdaten: 401, und der Dienst sieht die Anfrage nie", async () => {
  const { gesehen, proxyPort, abbau } = await aufbau();
  try {
    const a = await anfragen(proxyPort, "/");
    assert.strictEqual(a.status, 401);
    assert.match(a.kopf["www-authenticate"], /^Basic realm="WBW-Beschaffung"/);
    assert.strictEqual(gesehen.length, 0, "die Anfrage darf den Dienst nicht erreichen");
  } finally { await abbau(); }
});

test("falsches Passwort: 401", async () => {
  const { gesehen, proxyPort, abbau } = await aufbau();
  try {
    const a = await anfragen(proxyPort, "/", { headers: basic(BENUTZER, "falsch") });
    assert.strictEqual(a.status, 401);
    assert.strictEqual(gesehen.length, 0);
  } finally { await abbau(); }
});

test("falscher Benutzer bei richtigem Passwort: 401", async () => {
  const { gesehen, proxyPort, abbau } = await aufbau();
  try {
    const a = await anfragen(proxyPort, "/", { headers: basic("jemand", PASSWORT) });
    assert.strictEqual(a.status, 401);
    assert.strictEqual(gesehen.length, 0);
  } finally { await abbau(); }
});

test("kaputter Authorization-Header fuehrt nicht durch", async () => {
  const { gesehen, proxyPort, abbau } = await aufbau();
  try {
    for (const kopf of [
      { authorization: "Bearer abc" },
      { authorization: "Basic" },
      { authorization: "Basic !!!kein-base64!!!" },
      { authorization: "Basic " + Buffer.from("ohne-doppelpunkt").toString("base64") },
      { authorization: "" },
    ]) {
      const a = await anfragen(proxyPort, "/", { headers: kopf });
      assert.strictEqual(a.status, 401, `durchgelassen: ${JSON.stringify(kopf)}`);
    }
    assert.strictEqual(gesehen.length, 0);
  } finally { await abbau(); }
});

test("richtige Zugangsdaten: 200 und die Antwort des Dienstes kommt durch", async () => {
  const { proxyPort, abbau } = await aufbau();
  try {
    const a = await anfragen(proxyPort, "/", { headers: basic(BENUTZER, PASSWORT) });
    assert.strictEqual(a.status, 200);
    assert.strictEqual(a.kopf["x-vom-dienst"], "ja");
    assert.deepStrictEqual(JSON.parse(a.koerper), { success: true });
  } finally { await abbau(); }
});

// --- Weiterleiten ohne Verbiegen -------------------------------------------

test("Methode, Pfad, Abfrageteil und Koerper kommen unveraendert an", async () => {
  const { gesehen, proxyPort, abbau } = await aufbau();
  try {
    const nutzlast = JSON.stringify({ url: "https://www.kleinanzeigen.de/s-autos/k0" });
    const a = await anfragen(proxyPort, "/inserate-by-url?page_count=2", {
      method: "POST",
      headers: { ...basic(BENUTZER, PASSWORT), "content-type": "application/json" },
      koerper: nutzlast,
    });
    assert.strictEqual(a.status, 200);
    assert.strictEqual(gesehen.length, 1);
    assert.strictEqual(gesehen[0].methode, "POST");
    assert.strictEqual(gesehen[0].url, "/inserate-by-url?page_count=2");
    assert.strictEqual(gesehen[0].koerper, nutzlast);
    assert.strictEqual(gesehen[0].kopf["content-type"], "application/json");
  } finally { await abbau(); }
});

test("der Authorization-Header wird nicht an den Dienst weitergereicht", async () => {
  const { gesehen, proxyPort, abbau } = await aufbau();
  try {
    await anfragen(proxyPort, "/", { headers: basic(BENUTZER, PASSWORT) });
    assert.strictEqual(gesehen.length, 1);
    assert.strictEqual(gesehen[0].kopf.authorization, undefined,
      "das Passwort darf den Dienst nicht erreichen");
  } finally { await abbau(); }
});

test("ein 502 hinterlaesst eine Spur im Log", async () => {
  // Beim ersten echten Ausrollen kam ein 502 zurueck und in den Container-Logs
  // stand nichts dazu. Diese Zeile ist der Grund, warum es die Meldung gibt.
  const leer = http.createServer();
  const totPort = await lauschen(leer);
  await schliessen(leer);

  const gemeldet = [];
  const echt = console.error;
  console.error = (...a) => gemeldet.push(a.join(" "));
  const proxy = baueServer({
    benutzer: BENUTZER, passwort: PASSWORT,
    upstream: `http://127.0.0.1:${totPort}`, realm: "WBW-Beschaffung",
  });
  const proxyPort = await lauschen(proxy);
  try {
    await anfragen(proxyPort, "/inserate-by-url", { method: "POST", headers: basic(BENUTZER, PASSWORT) });
    const zeile = gemeldet.join("\n");
    assert.match(zeile, /^502 POST \/inserate-by-url/m, "Methode und Pfad fehlen im Log");
    assert.ok(!zeile.includes(PASSWORT), "das Passwort darf nicht ins Log");
  } finally {
    console.error = echt;
    await schliessen(proxy);
  }
});

test("nicht erreichbarer Dienst ergibt 502, nicht 200", async () => {
  // Freien Port ermitteln und sofort wieder freigeben - dorthin zeigt niemand.
  const leer = http.createServer();
  const totPort = await lauschen(leer);
  await schliessen(leer);

  const proxy = baueServer({
    benutzer: BENUTZER, passwort: PASSWORT,
    upstream: `http://127.0.0.1:${totPort}`, realm: "WBW-Beschaffung",
  });
  const proxyPort = await lauschen(proxy);
  try {
    const a = await anfragen(proxyPort, "/", { headers: basic(BENUTZER, PASSWORT) });
    assert.strictEqual(a.status, 502);
  } finally { await schliessen(proxy); }
});

// --- Bausteine --------------------------------------------------------------

test("Zugangsdaten mit Sonderzeichen und Doppelpunkt im Passwort", async () => {
  const z = zugangsdaten("Basic " + Buffer.from("wbw:pa:ss$wo\\rt&mehr").toString("base64"));
  assert.deepStrictEqual(z, { benutzer: "wbw", passwort: "pa:ss$wo\\rt&mehr" });
});

test("der Vergleich urteilt richtig, auch bei ungleicher Laenge", () => {
  assert.strictEqual(gleich("abc", "abc"), true);
  assert.strictEqual(gleich("abc", "abd"), false);
  assert.strictEqual(gleich("abc", "abcdefghij"), false);
  assert.strictEqual(gleich("", ""), true);
  assert.strictEqual(gleich("ümlaut", "ümlaut"), true);
});

// --- Startverhalten ---------------------------------------------------------

test("ohne Zugangsdaten in der Umgebung startet der Vorschalter nicht", () => {
  const skript = path.join(__dirname, "..", "ops", "ka-api", "auth-proxy", "proxy.js");
  for (const fehlt of ["KA_API_USER", "KA_API_PASS", "PROXY_UPSTREAM"]) {
    const umgebung = {
      ...process.env,
      KA_API_USER: BENUTZER,
      KA_API_PASS: PASSWORT,
      PROXY_UPSTREAM: "http://127.0.0.1:1",
      PROXY_PORT: "0",
    };
    delete umgebung[fehlt];
    const lauf = spawnSync(process.execPath, [skript], { env: umgebung, encoding: "utf8", timeout: 15000 });
    assert.strictEqual(lauf.status, 2, `${fehlt} fehlt, trotzdem gestartet`);
    assert.match(lauf.stderr, new RegExp(fehlt));
  }
});

test("das Passwort steht nicht in der Startmeldung", async () => {
  const skript = path.join(__dirname, "..", "ops", "ka-api", "auth-proxy", "proxy.js");
  const dienst = http.createServer((_, res) => res.end("ok"));
  const dienstPort = await lauschen(dienst);
  const { spawn } = require("node:child_process");
  const kind = spawn(process.execPath, [skript], {
    env: {
      ...process.env,
      KA_API_USER: BENUTZER, KA_API_PASS: PASSWORT,
      PROXY_UPSTREAM: `http://127.0.0.1:${dienstPort}`, PROXY_PORT: "0",
    },
    encoding: "utf8",
  });
  try {
    const ausgabe = await new Promise((fertig) => {
      let t = "";
      kind.stdout.on("data", (d) => { t += d; if (t.includes("\n")) fertig(t); });
      setTimeout(() => fertig(t), 5000);
    });
    assert.match(ausgabe, /Auth-Vorschalter laeuft/);
    assert.ok(!ausgabe.includes(PASSWORT), "das Passwort darf nicht ins Log");
  } finally {
    kind.kill("SIGTERM");
    await schliessen(dienst);
  }
});

// --- Zusammenspiel mit dem echten Adapter -----------------------------------
//
// Der Vorschalter nuetzt nichts, wenn der Skill seine Zugangsdaten anders
// schickt, als der Vorschalter sie erwartet. Deshalb hier einmal die echte
// Kette: kleinanzeigen.js -> Vorschalter -> Dienst (Fixtures).

const fs = require("node:fs");

function fixtureDienst() {
  const liste = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "kleinanzeigen-liste.json"), "utf8"));
  const detail = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "kleinanzeigen-detail.json"), "utf8"));
  return http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(req.url.startsWith("/inserate-by-url") ? liste : detail[0]));
    });
  });
}

async function ketteAufbauen(passwortImSkill) {
  const dienst = fixtureDienst();
  const dienstPort = await lauschen(dienst);
  const proxy = baueServer({
    benutzer: BENUTZER, passwort: PASSWORT,
    upstream: `http://127.0.0.1:${dienstPort}`, realm: "WBW-Beschaffung",
  });
  const proxyPort = await lauschen(proxy);

  const vorher = { u: process.env.KA_API_USER, p: process.env.KA_API_PASS, b: process.env.KA_API_BASE };
  process.env.KA_API_USER = BENUTZER;
  process.env.KA_API_PASS = passwortImSkill;
  process.env.KA_API_BASE = `http://127.0.0.1:${proxyPort}`;

  return {
    abbau: async () => {
      for (const [k, v] of [["KA_API_USER", vorher.u], ["KA_API_PASS", vorher.p], ["KA_API_BASE", vorher.b]]) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      await schliessen(proxy); await schliessen(dienst);
    },
  };
}

const EINGABEN = {
  marke: "Volkswagen", modell: "Golf",
  ez: "01/2020", kilometerstand: 60000, plz: "26123",
  kleinanzeigen: { limit: 2 },
};

test("echter Adapter kommt mit richtigem Passwort durch den Vorschalter", async () => {
  const { abbau } = await ketteAufbauen(PASSWORT);
  try {
    const ka = require("../skills/wbw-vergleichsfahrzeuge/scripts/adapters/kleinanzeigen.js");
    const e = await ka.holen(EINGABEN, { maxItems: 2, maxSeiten: 1, pause: async () => {} });
    assert.ok(Array.isArray(e.items), "Adapter liefert keine Trefferliste");
    assert.ok(e.items.length > 0, "keine Treffer durchgekommen");
    // Der Vorschalter darf die Nutzdaten nicht antasten: was der Dienst geliefert
    // hat, muss unveraendert beim Adapter ankommen.
    assert.ok(e.items.every((f) => f && typeof f === "object"));
    assert.strictEqual(e.protokoll.abrufe[0].status, 200);
  } finally { await abbau(); }
});

test("echter Adapter mit falschem Passwort: 401 mit verstaendlicher Meldung", async () => {
  const { abbau } = await ketteAufbauen("falsches-passwort-xyz");
  try {
    const ka = require("../skills/wbw-vergleichsfahrzeuge/scripts/adapters/kleinanzeigen.js");
    await assert.rejects(
      () => ka.holen(EINGABEN, { maxItems: 2, maxSeiten: 1, pause: async () => {} }),
      /401/,
      "ein falsches Passwort muss als 401 durchschlagen, nicht als leeres Ergebnis"
    );
  } finally { await abbau(); }
});
