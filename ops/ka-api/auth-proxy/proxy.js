#!/usr/bin/env node
"use strict";
// Basic-Auth-Vorschalter fuer den Kleinanzeigen-Dienst.
//
// Warum es das gibt: der Zugriffsschutz hing bisher an einem eigenen Traefik-
// Labelsatz der Coolify-Anwendung. Labels sind dort nach dem Setzen per API nicht
// mehr editierbar, und ein Passwortwechsel bedeutete, den kompletten Satz neu zu
// schreiben. Dieser Vorschalter liest Benutzer und Passwort stattdessen aus ganz
// normalen Umgebungsvariablen - in Coolify also aus dem Reiter "Environment
// Variables", aenderbar ohne ein einziges Label.
//
// Er reicht jede Anfrage unveraendert an den eigentlichen Dienst weiter, sobald
// die Zugangsdaten stimmen. Ohne oder mit falschen Zugangsdaten: 401, und die
// Anfrage erreicht den Dienst nie.
//
// Umgebungsvariablen:
//   KA_API_USER      Benutzername                              (Pflicht)
//   KA_API_PASS      Passwort im Klartext                      (Pflicht)
//   PROXY_UPSTREAM   Adresse des Dienstes, z. B. http://api:8000 (Pflicht)
//   PROXY_PORT       Port, auf dem der Vorschalter lauscht     (Vorgabe 8080)
//   PROXY_REALM      Realm im 401-Header      (Vorgabe WBW-Beschaffung)
//
// Abhaengigkeiten: keine. Nur Node-Bordmittel, wie im ganzen Projekt.

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { URL } = require("url");

// Hop-by-hop-Header gehoeren zur einzelnen Verbindung und duerfen nicht
// weitergereicht werden (RFC 9110, Abschnitt 7.6.1).
const VERBINDUNGSHEADER = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

function pflicht(name) {
  const v = process.env[name];
  if (v === undefined || v === "") {
    throw new Error(
      `${name} fehlt. Der Vorschalter startet nicht ohne Zugangsdaten - ` +
      `sonst stuende der Dienst ungeschuetzt im Netz. ` +
      `In Coolify unter "Environment Variables" setzen.`
    );
  }
  return v;
}

// Konstantzeit-Vergleich ueber Hashes fester Laenge: so verraet weder die
// Laufzeit noch die Laenge des Vergleichs etwas ueber das Passwort.
function gleich(a, b) {
  const ha = crypto.createHash("sha256").update(a, "utf8").digest();
  const hb = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(ha, hb);
}

function zugangsdaten(header) {
  if (typeof header !== "string") return null;
  const m = /^Basic\s+(.+)$/i.exec(header.trim());
  if (!m) return null;
  let roh;
  try {
    roh = Buffer.from(m[1], "base64").toString("utf8");
  } catch {
    return null;
  }
  const i = roh.indexOf(":");
  if (i < 0) return null;
  return { benutzer: roh.slice(0, i), passwort: roh.slice(i + 1) };
}

function baueServer(konfig) {
  const ziel = new URL(konfig.upstream);
  const transport = ziel.protocol === "https:" ? https : http;

  return http.createServer((anfrage, antwort) => {
    const z = zugangsdaten(anfrage.headers.authorization);
    const ok = z !== null &&
      gleich(z.benutzer, konfig.benutzer) &&
      gleich(z.passwort, konfig.passwort);

    if (!ok) {
      // Anfragekoerper verwerfen, sonst bleibt die Verbindung haengen.
      anfrage.resume();
      antwort.writeHead(401, {
        "WWW-Authenticate": `Basic realm="${konfig.realm}", charset="UTF-8"`,
        "Content-Type": "text/plain; charset=utf-8",
      });
      antwort.end("401 Zugangsdaten erforderlich\n");
      return;
    }

    const kopf = {};
    for (const [k, v] of Object.entries(anfrage.headers)) {
      if (VERBINDUNGSHEADER.has(k.toLowerCase())) continue;
      if (k.toLowerCase() === "authorization") continue;  // nicht weiterreichen
      if (k.toLowerCase() === "host") continue;           // setzt der Transport
      kopf[k] = v;
    }

    const weiter = transport.request(
      {
        protocol: ziel.protocol,
        hostname: ziel.hostname,
        port: ziel.port || (ziel.protocol === "https:" ? 443 : 80),
        method: anfrage.method,
        path: anfrage.url,
        headers: kopf,
      },
      (oben) => {
        const raus = {};
        for (const [k, v] of Object.entries(oben.headers)) {
          if (VERBINDUNGSHEADER.has(k.toLowerCase())) continue;
          raus[k] = v;
        }
        antwort.writeHead(oben.statusCode || 502, raus);
        oben.pipe(antwort);
      }
    );

    weiter.on("error", (fehler) => {
      if (!antwort.headersSent) {
        antwort.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      }
      antwort.end(`502 Dienst nicht erreichbar: ${fehler.message}\n`);
    });

    anfrage.on("aborted", () => weiter.destroy());
    anfrage.pipe(weiter);
  });
}

function konfigAusUmgebung() {
  return {
    benutzer: pflicht("KA_API_USER"),
    passwort: pflicht("KA_API_PASS"),
    upstream: pflicht("PROXY_UPSTREAM"),
    port: Number(process.env.PROXY_PORT || 8080),
    realm: process.env.PROXY_REALM || "WBW-Beschaffung",
  };
}

if (require.main === module) {
  let konfig;
  try {
    konfig = konfigAusUmgebung();
  } catch (fehler) {
    console.error("FEHLER: " + fehler.message);
    process.exit(2);
  }
  const server = baueServer(konfig);
  server.listen(konfig.port, "0.0.0.0", () => {
    // Bewusst ohne Passwort in der Ausgabe - Container-Logs sind kein Tresor.
    console.log(
      `Auth-Vorschalter laeuft auf Port ${konfig.port}, ` +
      `Benutzer "${konfig.benutzer}", Ziel ${konfig.upstream}`
    );
  });
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}

module.exports = { baueServer, zugangsdaten, gleich, konfigAusUmgebung };
