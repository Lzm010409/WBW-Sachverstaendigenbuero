/**
 * Dedup-Modul für WBW-Vergleichsfahrzeuge
 * ------------------------------------------------------------------
 * Entfernt Dubletten in zwei Stufen:
 *  1) nach mobile.de-Inserats-ID (exakte Wiedervorlage)
 *  2) nach Fingerprint aus Modell+Preis+km+EZ+Leistung
 *     -> fängt dasselbe Fahrzeug ab, das unter mehreren IDs / von
 *        mehreren (Cross-Posting-)Händlern inseriert ist.
 *
 * Liefert die eindeutigen Fahrzeuge plus eine Dubletten-Übersicht,
 * damit im Gutachten nachvollziehbar bleibt, was zusammengefasst wurde.
 */

function num(v) {
  if (v == null) return null;
  const m = String(v).replace(/[^\d]/g, "");
  return m ? parseInt(m, 10) : null;
}

function fingerprint(f) {
  const model = String(f.model || f.title || "").toLowerCase().replace(/\s+/g, " ").trim();
  const preis = num(f.price?.total?.amount ?? f.price);
  const km = num(f.attributes?.Mileage ?? f.mileage);
  const ez = String(f.attributes?.["First Registration"] ?? f.ez ?? "").trim();
  const kw = num(f.attributes?.Power ?? f.power);
  return [model, preis, km, ez, kw].join("|");
}

function dedupeFahrzeuge(fahrzeuge) {
  const byId = new Map();
  const dubletten = [];

  // Stufe 1: ID
  for (const f of fahrzeuge) {
    const id = String(f.id ?? "");
    if (id && byId.has(id)) {
      dubletten.push({ grund: "id", id, behalten: byId.get(id).id });
      continue;
    }
    byId.set(id || Symbol(), f);
  }

  // Stufe 2: Fingerprint
  const byFp = new Map();
  const unique = [];
  for (const f of byId.values()) {
    const fp = fingerprint(f);
    if (byFp.has(fp)) {
      dubletten.push({ grund: "fingerprint", id: f.id, behalten: byFp.get(fp).id, fingerprint: fp });
      continue;
    }
    byFp.set(fp, f);
    unique.push(f);
  }

  return {
    unique,
    eingang: fahrzeuge.length,
    ausgang: unique.length,
    entfernt: fahrzeuge.length - unique.length,
    dubletten,
  };
}

module.exports = { dedupeFahrzeuge, fingerprint };
