#!/usr/bin/env node
/**
 * Erzeugt aus dem Pipeline-Ergebnis einen druckfertigen HTML-Report (A4)
 * sowie eine separate Quellen-Linkliste.
 *
 * Als CLI:  node generate-report.js <result.json> <outDir>
 * Als Modul: const { renderReport } = require("./generate-report.js");
 *            const { html, linksMd } = renderReport(result);
 */
const fs = require("fs");
const path = require("path");

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function eur(n) {
  return n == null ? "–" : new Intl.NumberFormat("de-DE",
    { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n);
}
function fmtKm(n) {
  return n == null ? "–" : new Intl.NumberFormat("de-DE").format(n) + " km";
}
function dt(iso) {
  try { return new Date(iso).toLocaleDateString("de-DE", { year: "numeric", month: "2-digit", day: "2-digit" }); }
  catch (e) { return iso; }
}

/**
 * Reine Funktion: Ergebnisobjekt -> { html, linksMd, fahrzeugName }.
 */
function renderReport(R) {
  const soll = R.parameter.sollAusstattung || [];
  const korb = R.korb || [];
  const w = R.wbw || {};
  const st = R.statistik || {};
  // Ad-hoc-Merkmale (nicht im Katalog -> per Literal-Textsuche geprüft, "≈").
  const adhocSoll = new Set();
  for (const k of korb) for (const m of (k.matrix || [])) if (m.adhoc) adhocSoll.add(String(m.soll).toLowerCase());
  const hatAdhoc = adhocSoll.size > 0;
  const istAdhoc = (s) => adhocSoll.has(String(s).toLowerCase());
  // KI-Treffer (semantisch via Claude) – pro Zelle, nicht pro Spalte.
  let hatLlm = false;
  for (const k of korb) for (const m of (k.matrix || [])) if (m.llm) { hatLlm = true; break; }
  const lbl = (m) => (m.llm ? "✦ " : istAdhoc(m.soll) ? "≈ " : "") + esc(m.soll); // Label mit Markierung

  const zeilen = korb.map((k) => {
    const f = k.fahrzeug;
    return `<tr>
      <td class="num">${k.rang}</td>
      <td>${esc(f.source)}</td>
      <td>${esc(f.model || f.title)}</td>
      <td>${esc(f.ez || "–")}</td>
      <td class="num">${fmtKm(f.attributes?.Mileage ?? f.mileage)}</td>
      <td class="num">${f.power != null ? f.power + " kW" : "–"}</td>
      <td class="num">${eur(f.price?.total?.amount)}</td>
      <td class="num">${k._distanzKm != null ? k._distanzKm + " km" : "–"}</td>
      <td class="num">${k.score != null ? (k.score * 100).toFixed(0) + " %" : "–"}</td>
      <td>${f.url ? `<a href="${esc(f.url)}">Inserat</a>` : "–"}</td>
    </tr>`;
  }).join("\n");

  function cell(m) {
    if (!m) return '<td class="mq">?</td>';
    if (m.vorhanden) return m.llm
      ? '<td class="my" title="semantisch via Claude">✓<sup>K</sup></td>'
      : '<td class="my">✓</td>';
    return '<td class="mn">–</td>';
  }
  const matrixHead = soll.map((s) => `<th class="rot">${esc(s)}${istAdhoc(s) ? " ≈" : ""}</th>`).join("");
  const matrixRows = korb.map((k) => {
    const byKey = {};
    (k.matrix || []).forEach((m) => { byKey[String(m.soll).toLowerCase()] = m; });
    const cells = soll.map((s) => cell(byKey[String(s).toLowerCase()])).join("");
    return `<tr><td class="num">${k.rang}</td><td>${esc(k.fahrzeug.model || k.fahrzeug.title)}</td>${cells}</tr>`;
  }).join("\n");

  const quellen = korb.filter((k) => k.fahrzeug.url).map((k) =>
    `<li>${esc(k.fahrzeug.source)} – ${esc(k.fahrzeug.model || k.fahrzeug.title)} – ${eur(k.fahrzeug.price?.total?.amount)}<br><a href="${esc(k.fahrzeug.url)}">${esc(k.fahrzeug.url)}</a></li>`
  ).join("\n");

  // Einzelergebnisse als Karten (inkl. Bild)
  const karten = korb.map((k) => {
    const f = k.fahrzeug;
    const matched = (k.matrix || []).filter((m) => m.vorhanden);
    const missing = (k.matrix || []).filter((m) => !m.vorhanden);
    const eqHtml = soll.length ? `<div class="eq">`
      + (matched.length ? `<span class="ok">✓ ${matched.map(lbl).join(", ")}</span>` : "")
      + (matched.length && missing.length ? " · " : "")
      + (missing.length ? `<span class="no">– ${missing.map(lbl).join(", ")}</span>` : "")
      + `</div>` : "";
    const src = f._img || f.image; // _img = eingebettetes Base64 (selbsttragende PDF)
    const img = src
      ? `<img src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
      : `<div class="noimg">kein Bild</div>`;
    return `<div class="card">
      <div class="ci">${img}</div>
      <div class="cb">
        <div class="ch"><span class="r">#${k.rang}</span><span class="t">${esc(f.model || f.title)}</span><span class="badge">${esc(f.source)}</span></div>
        <div class="p">${eur(f.price?.total?.amount)}</div>
        <div class="sp">EZ ${esc(f.ez || "–")} · ${fmtKm(f.attributes?.Mileage ?? f.mileage)} · ${f.power != null ? f.power + " kW" : "–"} · ${k._distanzKm != null ? k._distanzKm + " km" : "–"} · Match ${k.score != null ? (k.score * 100).toFixed(0) + " %" : "–"}</div>
        ${eqHtml}
        ${f.url ? `<a href="${esc(f.url)}">Zum Inserat ↗</a>` : ""}
      </div>
    </div>`;
  }).join("\n");

  const fahrzeugName = [R.subjekt.marke, R.subjekt.modell, R.subjekt.variante].filter(Boolean).join(" ")
    || R.subjekt.modell || "–";

  const html = `<!doctype html><html lang="de"><head><meta charset="utf-8">
<base target="_blank" rel="noopener noreferrer">
<title>WBW-Marktrecherche</title>
<style>
@page { size: A4; margin: 18mm 16mm; }
* { box-sizing: border-box; }
body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1a1a1a; font-size: 10.5px; line-height: 1.45; }
h1 { font-size: 18px; margin: 0 0 2px; }
h2 { font-size: 13px; margin: 18px 0 6px; border-bottom: 1px solid #ccc; padding-bottom: 3px; }
.muted { color: #666; } .small { font-size: 9px; }
table { border-collapse: collapse; width: 100%; margin: 6px 0; }
th, td { border: 1px solid #d0d0d0; padding: 3px 5px; text-align: left; vertical-align: top; }
th { background: #f3f3f3; font-weight: 600; }
td.num, th.num { text-align: right; white-space: nowrap; }
a { color: #0a7d33; text-decoration: none; } a:hover { text-decoration: underline; }
.box { border: 1px solid #bbb; background: #fafafa; border-radius: 6px; padding: 10px 12px; margin: 8px 0; }
.wbw { font-size: 22px; font-weight: 700; }
.rot { writing-mode: vertical-rl; transform: rotate(180deg); white-space: nowrap; height: 92px; font-weight: 500; font-size: 9px; }
.my { text-align: center; color: #0a7d33; font-weight: 700; }
.mn { text-align: center; color: #c0392b; }
.mq { text-align: center; color: #999; }
.params td:first-child { font-weight: 600; width: 38%; background: #f8f8f8; }
.cards { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; margin: 6px 0; }
.card { border: 1px solid #d0d0d0; border-radius: 8px; overflow: hidden; display: grid; grid-template-columns: 116px 1fr; break-inside: avoid; page-break-inside: avoid; }
.card .ci { background: #f0f0f0; display: flex; align-items: center; justify-content: center; }
.card .ci img { width: 116px; height: 100%; min-height: 100px; object-fit: cover; display: block; }
.card .ci .noimg { color: #aaa; font-size: 9px; text-align: center; padding: 6px; }
.card .cb { padding: 7px 9px; font-size: 9.5px; }
.card .ch { display: flex; align-items: baseline; gap: 6px; }
.card .ch .r { font-weight: 700; color: #999; }
.card .ch .t { font-weight: 700; font-size: 11px; }
.card .badge { margin-left: auto; background: #eef3ef; color: #0a7d33; border: 1px solid #cfe6d6; border-radius: 10px; padding: 1px 7px; font-size: 8px; font-weight: 600; white-space: nowrap; }
.card .p { font-size: 15px; font-weight: 800; margin: 2px 0; }
.card .sp { color: #555; }
.card .eq { margin-top: 3px; line-height: 1.35; }
.card .eq .ok { color: #0a7d33; } .card .eq .no { color: #c0392b; }
.card a { font-size: 9px; display: inline-block; margin-top: 3px; }
ol { padding-left: 18px; } li { margin-bottom: 4px; word-break: break-all; }
.disc { font-size: 8.5px; color: #777; margin-top: 4px; }
</style></head><body>

<h1>Wiederbeschaffungswert – Marktrecherche Vergleichsfahrzeuge</h1>
<div class="muted small">Erstellt am ${dt(R.erstelltAm)} · Methodik: regionaler Markt (Luftlinie), Toleranzfilter, Dublettenbereinigung, Ausstattungsabgleich</div>

<h2>1 · Subjektfahrzeug &amp; Suchparameter</h2>
<table class="params">
<tr><td>Fahrzeug</td><td>${esc(fahrzeugName)}</td></tr>
<tr><td>Erstzulassung</td><td>${esc(R.subjekt.ez || "–")} (Toleranz ±${R.parameter.ezToleranzJahre} Jahr)</td></tr>
<tr><td>Laufleistung</td><td>${fmtKm(R.subjekt.mileage)} (Toleranz ±${fmtKm(R.parameter.kmToleranz)})</td></tr>
<tr><td>Leistung</td><td>${R.subjekt.power != null ? esc(R.subjekt.power) + " kW" + (R.parameter.leistungToleranzKw != null ? ` (Toleranz ±${R.parameter.leistungToleranzKw} kW)` : "") : "–"}</td></tr>
<tr><td>Suchraum</td><td>PLZ ${esc(R.parameter.plz || "–")} · Umkreis ${R.parameter.radiusKm} km</td></tr>
<tr><td>Soll-Ausstattung</td><td>${soll.map(esc).join(", ") || "–"}</td></tr>
${R.parameter.ausstattungslinie ? `<tr><td>Ausstattungslinie</td><td>${esc(R.parameter.ausstattungslinie)}${(R.linieInfo && R.linieInfo.fallback) ? " — keine Treffer dieser Linie, daher alle Linien einbezogen" : ((R.linieInfo && R.linieInfo.gefiltert) ? " — nur diese Linie" : "")}</td></tr>` : ""}
${(R.karoInfo && R.karoInfo.referenz && R.karoInfo.gefiltert) ? `<tr><td>Karosserie</td><td>${esc(R.karoInfo.referenz)}${R.karoInfo.abgeleitet ? " — aus dem Vergleichskorb abgeleitet (nur diese Bauart)" : " — nur diese Bauart"}</td></tr>` : ""}
${R.parameter.getriebe ? `<tr><td>Getriebe</td><td>${esc(R.parameter.getriebe)}${(R.getriebeInfo && R.getriebeInfo.fallback) ? " — keine Treffer dieser Getriebeart, daher alle einbezogen" : " — nur diese Getriebeart"}</td></tr>` : ""}
${R.parameter.tueren ? `<tr><td>Anzahl Türen</td><td>${esc(R.parameter.tueren)}${(R.tuerenInfo && R.tuerenInfo.fallback) ? " — keine Treffer dieser Türenzahl, daher alle einbezogen" : " — nur diese Türenzahl"}</td></tr>` : ""}
</table>

<h2>2 · Wertvorschlag (unverbindlich)</h2>
<div class="box">
  <div class="wbw">${eur(w.vorschlagBrutto)}</div>
  <div class="muted small">km-/EZ-bereinigter Median aus ${w.anzahl || 0} Vergleichsfahrzeugen (brutto). Maßgeblich ist die Festsetzung durch den Sachverständigen.</div>
  <table class="small" style="margin-top:8px">
   <tr><th class="num">Roh-Median</th><th class="num">Roh-Mittel</th><th class="num">Spanne (roh)</th><th class="num">Bereinigt Median</th><th class="num">Bereinigt getrimmt</th></tr>
   <tr><td class="num">${eur(w.roh?.median)}</td><td class="num">${eur(w.roh?.mittel)}</td><td class="num">${eur(w.roh?.min)} – ${eur(w.roh?.max)}</td><td class="num">${eur(w.bereinigt?.median)}</td><td class="num">${eur(w.bereinigt?.getrimmt)}</td></tr>
  </table>
  <div class="disc">Bereinigung: ${w.parameter?.eurProKm} €/km, ${w.parameter?.eurProEzMonat} €/Monat EZ-Differenz, jeweils relativ zum Subjektfahrzeug.</div>
</div>

<h2>3 · Vergleichsfahrzeuge (${korb.length})</h2>
<table>
<thead><tr><th class="num">#</th><th>Portal</th><th>Modell</th><th>EZ</th><th class="num">km</th><th class="num">Leistung</th><th class="num">Preis</th><th class="num">Distanz</th><th class="num">Match</th><th>Quelle</th></tr></thead>
<tbody>
${zeilen}
</tbody></table>

<h2>4 · Einzelergebnisse</h2>
<div class="cards">
${karten}
</div>

${soll.length ? `<h2>5 · Ausstattungsmatrix</h2>
<table><thead><tr><th class="num">#</th><th>Modell</th>${matrixHead}</tr></thead>
<tbody>${matrixRows}</tbody></table>
<div class="small muted">✓ vorhanden · – nicht gefunden · ? unklar${hatLlm ? ` · <b>✓ᴷ</b> / <b>✦</b> semantisch erkannt (Claude, bei abweichender Benennung)` : ""}${hatAdhoc ? ` · <b>≈</b> automatisch ergänzt (einfache Textsuche, ohne Synonyme/Ausschlüsse — bitte manuell prüfen)` : ""}</div>` : ""}

<h2>6 · Quellen / Linkliste</h2>
<ol>${quellen}</ol>

<h2>7 · Nachvollziehbarkeit</h2>
<table class="small">
<tr><td>Gescrapte Treffer gesamt</td><td class="num">${st.gescraped ?? "–"}</td></tr>
<tr><td>Im Umkreis (${R.parameter.radiusKm} km)</td><td class="num">${st.imUmkreis ?? "–"}</td></tr>
<tr><td>Außerhalb Umkreis entfernt</td><td class="num">${st.ausserhalb ?? "–"}</td></tr>
<tr><td>Ohne Koordinaten (separat geprüft)</td><td class="num">${st.ohneKoordinaten ?? "–"}</td></tr>
<tr><td>Durch Toleranzfilter entfernt</td><td class="num">${st.toleranzRaus ?? "–"}</td></tr>
${(R.linieInfo && R.linieInfo.gefiltert) ? `<tr><td>Andere/abweichende Ausstattungslinie als „${esc(R.parameter.ausstattungslinie)}" entfernt</td><td class="num">${st.linieRaus ?? "–"}</td></tr>` : ""}
${(R.karoInfo && R.karoInfo.gefiltert) ? `<tr><td>Abweichende Karosserie als „${esc(R.karoInfo.referenz)}" entfernt</td><td class="num">${st.karosserieRaus ?? "–"}</td></tr>` : ""}
${(R.getriebeInfo && R.getriebeInfo.gefiltert) ? `<tr><td>Abweichendes Getriebe als „${esc(R.parameter.getriebe)}" entfernt</td><td class="num">${st.getriebeRaus ?? "–"}</td></tr>` : ""}
${(R.tuerenInfo && R.tuerenInfo.gefiltert) ? `<tr><td>Abweichende Türenzahl als „${esc(R.parameter.tueren)}" entfernt</td><td class="num">${st.tuerenRaus ?? "–"}</td></tr>` : ""}
<tr><td>Dubletten zusammengefasst</td><td class="num">${st.dublettenRaus ?? "–"}</td></tr>
<tr><td><b>Im Vergleichskorb</b></td><td class="num"><b>${st.imKorb ?? "–"}</b></td></tr>
</table>
${(R.ohneKoordinaten && R.ohneKoordinaten.length)
      ? `<div class="small muted">Hinweis: ${R.ohneKoordinaten.length} Inserat(e) ohne Standortkoordinaten wurden nicht automatisch verortet und sind ggf. manuell zu prüfen.</div>` : ""}

${(R.beschaffung && R.beschaffung.length) ? `
<h3 style="margin-top:14px">Datenbeschaffung je Portal</h3>
<table class="small">
<tr><th>Portal</th><th>Stufe</th><th>Treffer</th><th>Zeitpunkt</th></tr>
${R.beschaffung.map((b) => `<tr>
  <td>${esc(b.portal)}</td>
  <td>${esc(b.getrageneStufe || "keine – alle Stufen gescheitert")}${b.kostenpflichtig ? " (kostenpflichtig)" : ""}</td>
  <td class="num">${b.trefferGesamt ?? "–"}</td>
  <td>${esc(dt(b.ende))}</td>
</tr>`).join("")}
</table>
${R.beschaffung.flatMap((b) => ((b.versuche || []).find((v) => v.ergebnis === "erfolg")?.details?.warnungen || [])
    .map((w) => `<div class="small" style="margin-top:6px"><b>Hinweis ${esc(b.portal)}:</b> ${esc(w)}</div>`)).join("")}
<div class="small muted">Stufen: L0 = direkter Portalabruf · L1 = eigener Dienst · L2 = Web Unlocker · L3 = Apify.${R.beschaffung.filter((b) => !b.getrageneStufe).length ? ` Für ${R.beschaffung.filter((b) => !b.getrageneStufe).map((b) => esc(b.portal)).join(", ")} lieferte keine Stufe Treffer – als dokumentierter Leerstand zu werten.` : ""}</div>
` : ""}

<div class="disc" style="margin-top:16px">Erstellt mit dem Plugin „WBW-Vergleichsfahrzeug-Finder". Datenquellen: mobile.de, AutoScout24, Kleinanzeigen (Beschaffung über die Eskalationskette, siehe Abschnitt 7). Inseratspreise sind Angebots-, keine Transaktionspreise.</div>

</body></html>`;

  const linksMd = [
    "# Verwendete Vergleichsfahrzeuge – Quellen",
    "",
    `Subjektfahrzeug: ${fahrzeugName} · Stand: ${dt(R.erstelltAm)}`,
    "",
    ...korb.filter((k) => k.fahrzeug.url).map((k, i) =>
      `${i + 1}. **${k.fahrzeug.source}** – ${k.fahrzeug.model || k.fahrzeug.title} – ${eur(k.fahrzeug.price?.total?.amount)}\n   ${k.fahrzeug.url}`),
  ].join("\n") + "\n";

  return { html, linksMd, fahrzeugName };
}

// --- Bilder ins HTML einbetten (Base64) -----------------------------------
// Damit die PDF selbsttragend ist: viele PDF-Konverter laden keine externen
// Bilder. Auf macOS werden die Bilder per `sips` zu JPEG vereinheitlicht und
// verkleinert (max. 600 px), damit auch Konverter ohne avif/webp sie zeigen.
const { execFileSync } = require("child_process");
let _hasSips = null;
function hasSips() {
  if (_hasSips !== null) return _hasSips;
  try { execFileSync("which", ["sips"], { stdio: "ignore" }); _hasSips = true; }
  catch { _hasSips = false; }
  return _hasSips;
}
function optimizeImage(buf, type) {
  if (!hasSips()) return { buf, type };
  const os = require("os");
  const base = path.join(os.tmpdir(), "wbwimg-" + Math.random().toString(36).slice(2));
  const inF = base + ".src"; const outF = base + ".jpg";
  try {
    fs.writeFileSync(inF, buf);
    execFileSync("sips", ["-s", "format", "jpeg", "-Z", "600", inF, "--out", outF], { stdio: "ignore" });
    const out = fs.readFileSync(outF);
    return { buf: out, type: "image/jpeg" };
  } catch { return { buf, type }; }
  finally { try { fs.unlinkSync(inF); } catch {} try { fs.unlinkSync(outF); } catch {} }
}
// Bild laden über das eingebaute https/http-Modul (unabhängig von der Node-
// Version – globales fetch fehlt in älteren Node-Builds, wie sie in manchen
// Umgebungen laufen). Folgt Redirects, mit Timeout und Größenobergrenze.
function fetchImage(url, timeoutMs = 12000, redirects = 0) {
  return new Promise((resolve) => {
    if (redirects > 4) return resolve(null);
    let lib, u;
    try { u = new URL(url); lib = u.protocol === "http:" ? require("http") : require("https"); }
    catch { return resolve(null); }
    const req = lib.get(u, {
      headers: { accept: "image/jpeg,image/png,image/*", "user-agent": "Mozilla/5.0" },
      timeout: timeoutMs,
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(fetchImage(next, timeoutMs, redirects + 1));
      }
      if (status !== 200) { res.resume(); return resolve(null); }
      const type = String(res.headers["content-type"] || "image/jpeg").split(";")[0];
      const chunks = []; let size = 0;
      res.on("data", (c) => {
        size += c.length;
        if (size > 8_000_000) { req.destroy(); resolve(null); } else chunks.push(c);
      });
      res.on("end", () => resolve({ buf: Buffer.concat(chunks), type }));
      res.on("error", () => resolve(null));
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}
// Fallback-Download über curl (System-Netzwerk), falls node selbst keinen
// Socket aufbauen kann. Typ grob aus den Magic-Bytes.
function fetchImageCurl(url, timeoutMs = 12000) {
  try {
    const os = require("os");
    const tmp = path.join(os.tmpdir(), "wbwdl-" + Math.random().toString(36).slice(2));
    execFileSync("curl", ["-sL", "--max-time", String(Math.ceil(timeoutMs / 1000)),
      "-A", "Mozilla/5.0", "-o", tmp, url], { stdio: "ignore" });
    const buf = fs.readFileSync(tmp);
    try { fs.unlinkSync(tmp); } catch {}
    if (!buf || buf.length < 100) return null;
    let type = "image/jpeg";
    if (buf[0] === 0x89 && buf[1] === 0x50) type = "image/png";
    else if (buf.slice(0, 4).toString("latin1") === "RIFF") type = "image/webp";
    else if (buf.slice(4, 12).toString("latin1").includes("ftyp")) type = "image/avif";
    return { buf, type };
  } catch { return null; }
}

async function inlineKorbImages(R, opts = {}) {
  const korb = R.korb || [];
  const urls = [...new Set(korb.map((k) => k.fahrzeug.image).filter(Boolean))];
  const cache = {};
  let idx = 0; let eingebettet = 0;
  async function worker() {
    while (idx < urls.length) {
      const url = urls[idx++];
      let img = await fetchImage(url, opts.timeoutMs);
      if (!img) img = fetchImageCurl(url, opts.timeoutMs); // Fallback ohne node-Sockets
      if (!img) continue;
      const o = optimizeImage(img.buf, img.type);
      cache[url] = `data:${o.type};base64,${o.buf.toString("base64")}`;
      eingebettet++;
    }
  }
  await Promise.all(Array.from({ length: Math.min(opts.concurrency || 6, urls.length || 1) }, worker));
  for (const k of korb) { const u = k.fahrzeug.image; if (u && cache[u]) k.fahrzeug._img = cache[u]; }
  return { angefragt: urls.length, eingebettet };
}

async function main() {
  const [, , resPath, outDir = "."] = process.argv;
  if (!resPath) { console.error("Aufruf: node generate-report.js <result.json> <outDir>"); process.exit(1); }
  const R = JSON.parse(fs.readFileSync(resPath, "utf8"));
  const stat = await inlineKorbImages(R);
  const { html, linksMd } = renderReport(R);
  fs.mkdirSync(outDir, { recursive: true });
  const htmlPath = path.join(outDir, "WBW-Vergleichsfahrzeuge.html");
  const linksPath = path.join(outDir, "Linkliste.md");
  fs.writeFileSync(htmlPath, html, "utf8");
  fs.writeFileSync(linksPath, linksMd, "utf8");
  console.log(`Bilder eingebettet: ${stat.eingebettet}/${stat.angefragt}`);
  console.log(`HTML:  ${htmlPath}`);
  console.log(`Links: ${linksPath}`);
}

if (require.main === module) main();
module.exports = { renderReport, inlineKorbImages };
