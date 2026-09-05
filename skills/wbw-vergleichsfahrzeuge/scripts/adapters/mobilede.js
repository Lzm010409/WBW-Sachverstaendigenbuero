/**
 * mobile.de — Stufe L0 (direkter Abruf).  DERZEIT NICHT VERFÜGBAR.
 * ------------------------------------------------------------------
 * BEFUND (2026-09-05, dokumentiert statt geraten):
 *
 *   1. Direkter Abruf mit schlankem Headersatz  -> HTTP 403, `server: AkamaiGHost`.
 *      Der Proxy-Tunnel steht (CONNECT 200); die Sperre kommt von mobile.de.
 *   2. Abruf mit vollständigem Browser-Headersatz -> HTTP 200, aber der Rumpf ist
 *      die Akamai-Bot-Manager-JS-Challenge (sec-if-cpt-container, sensor_data).
 *      Ohne JS-Ausführung nicht auflösbar.
 *   3. Echter Chromium (Playwright) -> von der Egress-Infrastruktur nur mit
 *      TLS 1.2 nutzbar; mit diesem TLS-Fingerabdruck antwortet Akamai mit einem
 *      harten 403 statt der Challenge.
 *   4. Suche nach einem BFF-/JSON-Endpunkt: kein Endpunkt gefunden, der ohne
 *      Bot-Manager antwortet.
 *
 * Daraus folgt bewusst KEIN geratener Endpunkt und KEIN Parser gegen eine nie
 * gesehene Struktur. Ein falsch geratener Endpunkt ist schlechter als ein
 * deaktivierter. mobile.de läuft deshalb über die nächste aktive Stufe (L3).
 *
 * Wird in providers.json ein `endpoint` hinterlegt (weil er später ermittelt
 * wurde), muss dieses Modul ergänzt werden — `mappe()` gegen die dann VORLIEGENDE
 * echte Antwort schreiben, nicht gegen eine Vermutung.
 */
const QUELLE = "mobile.de";

const BEFUND = [
  "Akamai Bot Manager blockt den direkten Abruf (403 bzw. JS-Challenge).",
  "Kein unauthentifizierter JSON-/BFF-Endpunkt ermittelt.",
  "L0 bleibt deaktiviert, bis ein Endpunkt an einer echten Antwort verifiziert ist.",
].join(" ");

async function holen(_eingaben, opts = {}) {
  if (!opts.endpoint) {
    const e = new Error(`mobile.de L0 nicht verfügbar: ${BEFUND}`);
    e.code = "L0_NICHT_VERIFIZIERT";
    throw e;
  }
  const e = new Error(
    "mobile.de L0: In providers.json ist ein endpoint hinterlegt, aber dieses Modul " +
    "hat noch kein an einer echten Antwort verifiziertes mappe(). Bitte zuerst eine " +
    "echte Antwort aufnehmen (tests/fixtures/) und das Mapping dagegen schreiben."
  );
  e.code = "L0_MAPPING_FEHLT";
  throw e;
}

module.exports = { holen, QUELLE, BEFUND };
