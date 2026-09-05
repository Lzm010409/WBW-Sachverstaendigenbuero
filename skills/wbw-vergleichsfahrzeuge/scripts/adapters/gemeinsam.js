/**
 * Gemeinsame Bausteine der Adapterschicht.
 * ------------------------------------------------------------------
 * Enthält nur reine Funktionen und einen abhängigkeitsfreien HTTP-Holer.
 * Bewusst ohne npm-Pakete: der Skill soll ohne `npm install` laufen
 * (dieselbe Linie wie geocode.js, das ebenfalls nur `https` nutzt).
 */
const https = require("https");
const http = require("http");
const tls = require("tls");
const zlib = require("zlib");
const { URL } = require("url");

/** Browser-Headersatz. Ohne diesen antwortet AutoScout24 mit 403. */
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7",
  "Accept-Encoding": "gzip, deflate",
  "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

/** Pause zwischen Seitenabrufen. Absicht, kein Optimierungspotenzial. */
const PAUSE_MS = Number(process.env.WBW_PAUSE_MS || 1800);
const pause = (ms = PAUSE_MS) => new Promise((r) => setTimeout(r, ms));

/**
 * Deutsche Zahl aus Freitext. Nimmt die ERSTE Zahlengruppe und behandelt
 * Tausenderpunkt und Dezimalkomma korrekt.
 *   "12.500 €"        -> 12500
 *   "12.500,50 €"     -> 12500.5
 *   "110 kW (150 PS)" -> 110    (kW, nicht PS)
 *   "0"               -> 0      (nicht null!)
 *   "VB"              -> null
 */
function zahl(v) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v);
  const m = s.match(/-?\d[\d.,  ]*/);
  if (!m) return null;
  let t = m[0].replace(/[  ]/g, "").replace(/[.,]+$/, "");
  if (!t || !/\d/.test(t)) return null;
  const punkt = t.includes("."), komma = t.includes(",");
  if (punkt && komma) {
    t = t.lastIndexOf(",") > t.lastIndexOf(".")
      ? t.replace(/\./g, "").replace(",", ".")   // 12.500,50
      : t.replace(/,/g, "");                      // 12,500.50
  } else if (komma) {
    const teile = t.split(",");
    t = (teile.length === 2 && teile[1].length !== 3) ? teile.join(".") : teile.join("");
  } else if (punkt) {
    const teile = t.split(".");
    t = (teile.length === 2 && teile[1].length !== 3) ? t : teile.join("");
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const MONATE = {
  januar: 1, februar: 2, "märz": 3, maerz: 3, april: 4, mai: 5, juni: 6,
  juli: 7, august: 8, september: 9, oktober: 10, november: 11, dezember: 12,
};

/**
 * Erstzulassung -> kanonisch "MM/YYYY" bzw. "YYYY".
 * Erkennt "2019", "03/2019", "01-2018", "2019-03-01", "März 2019", ISO-Zeitstempel.
 * Implausible Jahre (Zukunft, vor 1900) -> null; optional in `warnungen` vermerkt.
 */
function ez(v, warnungen) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const maxJahr = new Date().getFullYear() + 1;
  let jahr = null, monat = null, m;
  if ((m = s.match(/\b((?:19|20)\d{2})-(\d{1,2})(?!\d)/))) { jahr = +m[1]; monat = +m[2]; }
  else if ((m = s.match(/\b(\d{1,2})[\/.\-]((?:19|20)\d{2})\b/))) { monat = +m[1]; jahr = +m[2]; }
  else if ((m = s.toLowerCase().match(/(januar|februar|märz|maerz|april|mai|juni|juli|august|september|oktober|november|dezember)\s+((?:19|20)\d{2})/))) { monat = MONATE[m[1]]; jahr = +m[2]; }
  else if ((m = s.match(/\b(\d{4})\b/))) { jahr = +m[1]; }
  else return null;
  if (!Number.isFinite(jahr) || jahr < 1900 || jahr > maxJahr) {
    if (Array.isArray(warnungen)) warnungen.push(`Implausible Erstzulassung verworfen: ${s}`);
    return null;
  }
  if (monat != null && (monat < 1 || monat > 12)) monat = null;
  return monat ? `${String(monat).padStart(2, "0")}/${jahr}` : String(jahr);
}

/** Erste 5-stellige PLZ aus Freitext. */
function plz(s) {
  const m = String(s == null ? "" : s).match(/\b\d{5}\b/);
  return m ? m[0] : null;
}

/** Ausstattung aus Freitext oder Liste -> saubere String-Liste. */
function ausstattung(v) {
  if (v == null) return [];
  const roh = Array.isArray(v) ? v : String(v).split(/[,;\n]/);
  const out = [];
  for (const x of roh) {
    if (x == null) continue;
    const s = String(typeof x === "object" ? (x.name || x.label || x.value || "") : x)
      .replace(/­/g, "").replace(/\s+/g, " ").trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------- HTTP

/**
 * Agent, der HTTPS_PROXY berücksichtigt (in Cloud-Sessions Pflicht, lokal
 * unwirksam). Node's eingebautes fetch liest die Variable nicht, deshalb
 * hier von Hand per CONNECT-Tunnel.
 */
function proxyAgent() {
  const p = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!p) return undefined;
  const pu = new URL(p);
  return new (class extends https.Agent {
    createConnection(opts, cb) {
      const req = http.request({
        host: pu.hostname, port: pu.port || 80, method: "CONNECT",
        path: `${opts.host}:${opts.port}`,
        headers: { Host: `${opts.host}:${opts.port}` },
      });
      req.on("connect", (res, socket) => {
        if (res.statusCode !== 200) { cb(new Error(`Proxy CONNECT ${res.statusCode} für ${opts.host}`)); return; }
        cb(null, tls.connect({ socket, servername: opts.host }));
      });
      req.on("error", cb);
      req.end();
    }
  })({ keepAlive: false });
}

/**
 * Holt eine URL und liefert { status, headers, body }. Folgt Redirects.
 * Wirft bei Netzfehlern; HTTP-Fehlercodes werden zurückgegeben, nicht geworfen.
 */
function hole(url, opts = {}) {
  const { headers = {}, method = "GET", body = null, timeoutMs = 30000, redirects = 5 } = opts;
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error(`Ungültige URL: ${url}`)); }
    const lib = u.protocol === "http:" ? http : https;
    const req = lib.request(u, {
      method,
      headers: { ...headers, Host: u.host },
      agent: u.protocol === "https:" ? proxyAgent() : undefined,
      timeout: timeoutMs,
    }, (res) => {
      const code = res.statusCode || 0;
      const loc = res.headers.location;
      if (loc && code >= 300 && code < 400 && redirects > 0) {
        res.resume();
        return resolve(hole(new URL(loc, u).toString(), { ...opts, redirects: redirects - 1 }));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let buf = Buffer.concat(chunks);
        const enc = String(res.headers["content-encoding"] || "").toLowerCase();
        try {
          if (enc.includes("gzip")) buf = zlib.gunzipSync(buf);
          else if (enc.includes("deflate")) buf = zlib.inflateSync(buf);
          else if (enc.includes("br")) buf = zlib.brotliDecompressSync(buf);
        } catch { /* unkomprimiert weiterreichen */ }
        resolve({ status: code, headers: res.headers, body: buf.toString("utf8") });
      });
      res.on("error", reject);
    });
    req.on("timeout", () => { req.destroy(new Error(`Zeitüberschreitung nach ${timeoutMs} ms: ${url}`)); });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Wie `hole`, aber parst JSON. */
async function holeJson(url, opts = {}) {
  const r = await hole(url, { ...opts, headers: { Accept: "application/json", ...(opts.headers || {}) } });
  let daten = null;
  try { daten = JSON.parse(r.body); } catch { /* daten bleibt null */ }
  return { ...r, daten };
}

/** Dedupliziert über Seitengrenzen anhand der id. */
function dedupe(items) {
  const seen = new Set(); const out = [];
  for (const it of items || []) {
    const k = it && it.id != null ? String(it.id) : null;
    if (k && seen.has(k)) continue;
    if (k) seen.add(k);
    out.push(it);
  }
  return out;
}

/** Leeres kanonisches Fahrzeug — hält die Feldnamen an EINER Stelle fest. */
function leeresFahrzeug(quelle) {
  return {
    id: null, quelle, url: null, titel: null, variante: null,
    preis: null, kilometerstand: null, erstzulassung: null, leistungKw: null,
    getriebe: null, kraftstoff: null, fahrzeugtyp: null, tueren: null,
    plz: null, ort: null, lat: null, lon: null,
    ausstattung: [], bilder: [], beschreibung: null,
  };
}

module.exports = {
  BROWSER_HEADERS, PAUSE_MS, pause,
  zahl, ez, plz, ausstattung,
  hole, holeJson, dedupe, leeresFahrzeug,
};
