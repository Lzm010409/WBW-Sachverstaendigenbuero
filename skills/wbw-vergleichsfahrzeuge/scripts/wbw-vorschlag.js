/**
 * WBW-Wertvorschlag aus dem bewerteten Vergleichskorb.
 * ------------------------------------------------------------------
 * Liefert Median/Mittel der Inseratspreise sowie eine km- und
 * EZ-bereinigte Schätzung relativ zum Subjektfahrzeug. Bewusst
 * transparent und UNVERBINDLICH – die WBW-Festsetzung trifft der
 * Sachverständige. Inseratspreise sind Angebots-, keine
 * Transaktionspreise.
 */

function num(v) {
  if (v == null) return null;
  const m = String(v).replace(/[^\d]/g, "");
  return m ? parseInt(m, 10) : null;
}
function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}
function mean(a) { return a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : null; }
function trimmedMean(a) {
  if (a.length < 4) return mean(a);
  const s = [...a].sort((x, y) => x - y);
  const k = Math.floor(s.length * 0.1) || 1;
  return mean(s.slice(k, s.length - k));
}

/**
 * @param {object[]} scored  Ausgabe von bewerteKorb (Array {fahrzeug, score, ...})
 * @param {object} subject   { mileage, ezYear }
 * @param {object} opts      { eurProKm=0.10, eurProEzMonat=120, scoreMin=0 }
 */
function wbwVorschlag(scored, subject, opts = {}) {
  const eurProKm = opts.eurProKm ?? 0.10;          // Wertverlust je km
  const eurProEzMonat = opts.eurProEzMonat ?? 120; // Wertverlust je Monat EZ-Differenz
  const scoreMin = opts.scoreMin ?? 0;

  const verwendet = scored.filter((s) => (s.score ?? 0) >= scoreMin);
  const rows = verwendet.map((s) => {
    const f = s.fahrzeug;
    const preis = num(f.price?.total?.amount ?? f.price);
    const km = num(f.attributes?.Mileage ?? f.mileage);
    const ezYear = f._ezYear ?? null;
    let kmKorr = 0, ezKorr = 0, adj = preis;
    if (preis != null) {
      // mehr km / älter als Subjekt -> Vergleichspreis nach oben korrigiert
      if (km != null && subject?.mileage != null) kmKorr = Math.round((km - subject.mileage) * eurProKm);
      if (ezYear != null && subject?.ezYear != null) ezKorr = Math.round((subject.ezYear - ezYear) * 12 * eurProEzMonat);
      adj = preis + kmKorr + ezKorr;
    }
    return { id: f.id, source: f.source, preis, km, ezYear, kmKorr, ezKorr,
      adjustiert: preis != null ? adj : null, score: s.score };
  });

  const preise = rows.map((r) => r.preis).filter((x) => x != null);
  const adj = rows.map((r) => r.adjustiert).filter((x) => x != null);

  return {
    anzahl: preise.length,
    parameter: { eurProKm, eurProEzMonat, scoreMin },
    roh: {
      min: preise.length ? Math.min(...preise) : null,
      max: preise.length ? Math.max(...preise) : null,
      median: median(preise), mittel: mean(preise),
    },
    bereinigt: { median: median(adj), mittel: mean(adj), getrimmt: trimmedMean(adj) },
    vorschlagBrutto: median(adj),
    rows,
  };
}

module.exports = { wbwVorschlag };
