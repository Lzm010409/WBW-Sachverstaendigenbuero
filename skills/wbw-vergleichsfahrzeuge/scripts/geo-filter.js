/**
 * Geo-Filter für WBW-Vergleichsfahrzeuge
 * ------------------------------------------------------------------
 * Schränkt den Vergleichskorb auf den regionalen Markt ein:
 * PLZ-Zentrum + Umkreis (Default 200 km), gemessen per Luftlinie
 * (Haversine) zur Händlerkoordinate (dealerDetails.location).
 *
 * Wichtig: Fahrzeuge OHNE Koordinaten werden nicht still verworfen,
 * sondern separat als `ohneKoordinaten` ausgewiesen -> der SV
 * entscheidet, ob er sie manuell prüft.
 *
 * Die regionale Eingrenzung ist für den WBW methodisch relevant
 * (der regionale Markt zählt) und filtert nebenbei Importanbieter
 * aus fernen Ländern automatisch heraus.
 */

// PLZ-Zentren für das Einzugsgebiet (grobe Stadtzentren; für
// beliebige PLZ einmalig geocoden und hier ergänzen).
const PLZ_ZENTREN = {
  "47": { ort: "Krefeld",     lat: 51.3333, lon: 6.5667 },
  "41": { ort: "Neuss",       lat: 51.1980, lon: 6.6878 },
  "40": { ort: "Düsseldorf",  lat: 51.2277, lon: 6.7735 },
};

function zentrumFuerPLZ(plz) {
  const p2 = String(plz).trim().slice(0, 2);
  const z = PLZ_ZENTREN[p2];
  if (!z) throw new Error(`Kein Zentrum für PLZ-Bereich ${p2} hinterlegt – bitte ergänzen.`);
  return z;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

/**
 * @param {object[]} fahrzeuge
 * @param {object} opts
 * @param {string} [opts.plz]            PLZ des Zentrums (z.B. "47798")
 * @param {{lat:number,lon:number}} [opts.zentrum]  alternativ direkte Koordinate
 * @param {number} [opts.radiusKm=200]
 */
function geoFilter(fahrzeuge, opts = {}) {
  const { plz, radiusKm = 200 } = opts;
  const zentrum = opts.zentrum || zentrumFuerPLZ(plz);

  const imUmkreis = [];
  const ausserhalb = [];
  const ohneKoordinaten = [];

  for (const f of fahrzeuge) {
    const lat = f.dealerDetails?.location?.latitude;
    const lon = f.dealerDetails?.location?.longitude;
    if (lat == null || lon == null) {
      ohneKoordinaten.push(f);
      continue;
    }
    const dist = haversineKm(zentrum.lat, zentrum.lon, lat, lon);
    const eintrag = { ...f, _distanzKm: dist };
    if (dist <= radiusKm) imUmkreis.push(eintrag);
    else ausserhalb.push(eintrag);
  }

  imUmkreis.sort((a, b) => a._distanzKm - b._distanzKm);
  return {
    zentrum, radiusKm,
    imUmkreis, ausserhalb, ohneKoordinaten,
    eingang: fahrzeuge.length, ausgang: imUmkreis.length,
  };
}

module.exports = { geoFilter, haversineKm, zentrumFuerPLZ, PLZ_ZENTREN };
