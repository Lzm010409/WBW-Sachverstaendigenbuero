/**
 * Ausstattungs-Matcher v2 (zweisprachig, Apify-Realdaten-tauglich)
 * ------------------------------------------------------------------
 *  - Mustererkennung in DEUTSCH **und** ENGLISCH, weil das
 *    Apify-`features`-Array auf Englisch ausgeliefert wird
 *    ("Heated seats", "Panoramic roof", ...), die Freitext-
 *    Beschreibung aber auf Deutsch.
 *  - Klimaautomatik wird über das strukturierte `Climatisation`-Feld
 *    bestimmt ("Automatic climatisation, 3 zones" = ja,
 *    "A/C (man.)" = nein), nicht per Mustersuche.
 *
 * Eingabe je Fahrzeug: { features: string[], description: string,
 *                        climatisation: string }
 */

const KATALOG = {
  sitzheizung: { tier: "KOMFORT",
    muster: ["sitzheizung", "beheizbare sitze", "sitzheizung vorn", "heated seats", "seat heating"],
    exclude: ["lenkradheizung", "heated steering"] },
  panoramadach: { tier: "HAUPT",
    muster: ["panoramadach", "panorama-glasdach", "panoramaglasdach", "panorama glasdach",
             "pano-dach", "panoramic roof", "panorama"],
    exclude: [] },
  schiebedach: { tier: "HAUPT",
    muster: ["schiebedach", "glasschiebedach", "sunroof"],
    exclude: ["panorama"] },
  navigationssystem: { tier: "HAUPT",
    muster: ["navi", "navigation", "navigationssystem", "navigation system",
             "discover pro", "discover media", "mbux", "comand"],
    exclude: ["navi-vorbereitung", "navigationsvorbereitung", "navigation preparation",
              "ohne navi"] },
  lederausstattung: { tier: "HAUPT",
    muster: ["lederausstattung", "vollleder", "ledersitze", "nappaleder",
             "leder vienna", "leather seats", "full leather", "nappa"],
    exclude: ["lederlenkrad", "leder-lenkrad", "leather steering", "kunstleder",
              "teilleder", "stoff/leder", "ledernachbildung", "artico"] },
  ahk: { tier: "HAUPT",
    muster: ["ahk", "anhängerkupplung", "anhaengerkupplung", "anhängevorrichtung",
             "trailer coupling", "trailer hitch", "tow bar", "towbar", "tow hitch"],
    exclude: ["ahk-vorbereitung", "vorbereitung anhängerkupplung", "trailer coupling preparation"] },
  allrad: { tier: "HAUPT",
    muster: ["allrad", "allradantrieb", "4motion", "quattro", "4matic", "xdrive",
             "4x4", "awd", "four-wheel drive", "four wheel drive", "4wd"],
    exclude: [] },
  led_scheinwerfer: { tier: "KOMFORT",
    muster: ["led-scheinwerfer", "ledscheinwerfer", "voll-led", "matrix led", "matrix-led",
             "led matrix", "led headlights", "led-matrix"],
    exclude: ["led-tagfahrlicht", "led tagfahr", "led running lights", "led daytime",
              "led-rückleuchten", "led running"] },
  standheizung: { tier: "HAUPT",
    muster: ["standheizung", "webasto", "auxiliary heating", "zuheizer"],
    exclude: ["vorbereitung standheizung", "standheizung vorbereitung"] },
  headup: { tier: "KOMFORT",
    muster: ["head-up", "head up", "headup", "head-up display", "heads-up", "heads up display"],
    exclude: [] },
  acc: { tier: "KOMFORT",
    muster: ["acc", "abstandstempomat", "adaptive cruise", "distronic",
             "abstandsregeltempomat", "adaptiver tempomat"],
    exclude: [] },
  // --- häufige Basis-Ausstattung ---
  elektrische_fensterheber: { tier: "KOMFORT",
    muster: ["elektrische fensterheber", "elektr. fensterheber", "elektrischer fensterheber",
             "e-fh", "fensterheber elektrisch", "fensterheber vorn", "power windows", "electric windows"],
    exclude: [] },
  einparkhilfe: { tier: "KOMFORT",
    muster: ["einparkhilfe", "parkpilot", "pdc", "parktronic", "park distance", "parking sensors",
             "parking assist", "parking aid", "parksensoren", "parkhilfe"],
    exclude: [] },
  tempomat: { tier: "KOMFORT",
    muster: ["tempomat", "cruise control", "geschwindigkeitsregel", "gra"],
    exclude: ["adaptive", "acc", "abstands", "distronic"] },
  bluetooth: { tier: "KOMFORT",
    muster: ["bluetooth", "freisprech"], exclude: [] },
  rueckfahrkamera: { tier: "KOMFORT",
    muster: ["rückfahrkamera", "rueckfahrkamera", "rückfahrcamera", "rear view camera",
             "reversing camera", "rear camera", "rückfahr-kamera", "rfk"],
    exclude: [] },
  smartphone: { tier: "KOMFORT",
    muster: ["carplay", "apple carplay", "android auto", "smartphone integration",
             "app-connect", "appconnect"],
    exclude: [] },
  isofix: { tier: "KOMFORT",
    muster: ["isofix"], exclude: [] },
  alufelgen: { tier: "KOMFORT",
    muster: ["alufelgen", "alloy wheels", "leichtmetallfelgen", "leichtmetall",
             "lm-felgen", "lm felgen", "alu-felgen"],
    exclude: [] },
};

// freie SV-Eingabe -> Katalog-Key  (+ Sonderfall klimaautomatik)
const ALIASE = {
  klimaautomatik: "klimaautomatik",
  klimaanlage: "klimaanlage", klima: "klimaanlage",
  sitzheizung: "sitzheizung",
  "elektrische fensterheber": "elektrische_fensterheber", fensterheber: "elektrische_fensterheber",
  "e-fh": "elektrische_fensterheber",
  einparkhilfe: "einparkhilfe", parkpilot: "einparkhilfe", pdc: "einparkhilfe",
  parktronic: "einparkhilfe", parksensoren: "einparkhilfe", parkhilfe: "einparkhilfe",
  tempomat: "tempomat", gra: "tempomat", geschwindigkeitsregelanlage: "tempomat",
  bluetooth: "bluetooth",
  "rückfahrkamera": "rueckfahrkamera", rueckfahrkamera: "rueckfahrkamera", rfk: "rueckfahrkamera",
  carplay: "smartphone", "apple carplay": "smartphone", "android auto": "smartphone",
  "app-connect": "smartphone",
  isofix: "isofix",
  alufelgen: "alufelgen", leichtmetallfelgen: "alufelgen", "lm-felgen": "alufelgen",
  panoramadach: "panoramadach", panorama: "panoramadach", pano: "panoramadach",
  schiebedach: "schiebedach",
  navi: "navigationssystem", navigation: "navigationssystem", navigationssystem: "navigationssystem",
  leder: "lederausstattung", lederausstattung: "lederausstattung",
  ahk: "ahk", anhängerkupplung: "ahk",
  allrad: "allrad", "4motion": "allrad", quattro: "allrad", "4matic": "allrad", xdrive: "allrad",
  led: "led_scheinwerfer", "led-scheinwerfer": "led_scheinwerfer",
  standheizung: "standheizung",
  "head-up": "headup", "head-up-display": "headup", hud: "headup",
  acc: "acc", abstandstempomat: "acc",
};

const GEWICHT = { HAUPT: 1.0, KOMFORT: 0.4 };
const NEGATIONEN = ["kein", "keine", "ohne", "nicht", "no ", "without"];

function norm(s) {
  return String(s || "").toLowerCase().replace(/[^\wäöüß\s\-\/,]/g, " ")
    .replace(/\s+/g, " ").trim();
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function istNegiert(muster, hay) {
  return NEGATIONEN.some((neg) =>
    new RegExp(`\\b${neg.trim()}\\b(?:\\s+\\w+){0,2}\\s+${escapeRe(muster)}`).test(hay));
}
function matchMuster(def, hay) {
  if (!hay) return false;
  const hit = def.muster.some((m) => hay.includes(m) && !istNegiert(m, hay));
  if (!hit) return false;
  if ((def.exclude || []).some((x) => hay.includes(x))) return false;
  return true;
}

// Klimaautomatik aus dem strukturierten Climatisation-Feld bestimmen
function klimaautomatikVorhanden(climatisation) {
  const c = norm(climatisation);
  if (!c) return { found: false, quelle: null };
  // "automatic climatisation", "automatic air conditioning", "klimaautomatik", "2/3/4 zones"
  if (/automat|klimaautomatik|zone/.test(c) && !/man\.|manuell/.test(c)) {
    return { found: true, quelle: "climatisation" };
  }
  return { found: false, quelle: null }; // "a/c (man.)" / "air conditioning" = manuell
}

// Klimaanlage (irgendeine Klimatisierung, manuell ODER automatik).
function klimaanlageVorhanden(climatisation, text) {
  const c = norm(climatisation);
  if (c && !/\b(kein|keine|ohne)\b|no a\/c|^-$/.test(c)) return { found: true, quelle: "climatisation" };
  const t = norm(text);
  if (/\bklima|klimaanlage|klimaautomat|climatronic|air condition|aircondition|a\/c\b|climate control/.test(t)) {
    return { found: true, quelle: "text" };
  }
  return { found: false, quelle: null };
}

function sollToKey(eintrag) {
  const n = norm(eintrag);
  if (ALIASE[n]) return ALIASE[n];
  for (const [alias, key] of Object.entries(ALIASE)) if (n.includes(alias)) return key;
  return null;
}

function matchFahrzeug(sollAusstattung, fahrzeug) {
  const strukturText = norm((fahrzeug.features || []).join(" | "));
  // Titel mitlesen: Portale listen Kernausstattung oft im Inseratstitel
  // ("... Klima Einparkhilfe Sitzheizung"), gerade wenn die Ausstattungsliste fehlt.
  const freitext = norm([fahrzeug.title, fahrzeug.variant, fahrzeug.description].filter(Boolean).join(" | "));
  const climatisation = fahrzeug.climatisation ?? fahrzeug.attributes?.Climatisation;

  const matrix = []; const fehlend = []; const unbekannt = [];
  let gewSum = 0, gewIst = 0;

  for (const soll of sollAusstattung) {
    const sn = norm(soll);
    if (!sn) continue; // leeren Begriff überspringen (würde sonst alles "matchen")
    // Klimaautomatik: erfordert AUTOMATISCHE Klimatisierung.
    if (sn.includes("klimaautomatik")) {
      let r = klimaautomatikVorhanden(climatisation);
      if (!r.found && /klimaautomat|automatic climat|automatic air|climatronic/.test(strukturText + " " + freitext)) {
        r = { found: true, quelle: "text" };
      }
      const g = GEWICHT.KOMFORT; gewSum += g; if (r.found) gewIst += g; else fehlend.push(soll);
      matrix.push({ soll, key: "klimaautomatik", tier: "KOMFORT", vorhanden: r.found, quelle: r.quelle, gewicht: g });
      continue;
    }
    // Klimaanlage / Klima: IRGENDEINE Klimatisierung (manuell oder automatik).
    if (sn === "klima" || sn.includes("klimaanlage")) {
      const r = klimaanlageVorhanden(climatisation, strukturText + " " + freitext);
      const g = GEWICHT.KOMFORT; gewSum += g; if (r.found) gewIst += g; else fehlend.push(soll);
      matrix.push({ soll, key: "klimaanlage", tier: "KOMFORT", vorhanden: r.found, quelle: r.quelle, gewicht: g });
      continue;
    }
    const key = sollToKey(soll);
    const def = key ? KATALOG[key] : null;
    if (def) {
      // Kuratiertes Standardsortiment: Synonyme DE/EN + Ausschlüsse.
      const g = GEWICHT[def.tier];
      const r = matchMuster(def, strukturText) ? { found: true, quelle: "struktur" }
            : matchMuster(def, freitext) ? { found: true, quelle: "text" }
            : { found: false, quelle: null };
      gewSum += g; if (r.found) gewIst += g; else fehlend.push(soll);
      matrix.push({ soll, key, tier: def.tier, vorhanden: r.found, quelle: r.quelle, gewicht: g });
    } else {
      // Ad-hoc: nicht im Katalog -> einfache Literal-Textsuche für DIESEN Lauf,
      // damit jedes angefragte Merkmal geprüft (und nicht ignoriert) wird.
      // Schwächer (keine Synonyme/Ausschlüsse) -> im Report als "≈" markiert.
      const adhocDef = { tier: "KOMFORT", muster: [sn], exclude: [] };
      const r = matchMuster(adhocDef, strukturText) ? { found: true, quelle: "struktur" }
            : matchMuster(adhocDef, freitext) ? { found: true, quelle: "text" }
            : { found: false, quelle: null };
      const g = GEWICHT.KOMFORT; gewSum += g; if (r.found) gewIst += g; else fehlend.push(soll);
      matrix.push({ soll, key: null, tier: "KOMFORT", vorhanden: r.found, quelle: r.quelle, gewicht: g, adhoc: true });
      unbekannt.push(soll); // weiterhin als "automatisch ergänzt" ausweisbar
    }
  }
  const score = gewSum > 0 ? +(gewIst / gewSum).toFixed(3) : 1;
  return { matrix, score, fehlend, unbekannt };
}

function bewerteKorb(sollAusstattung, fahrzeuge) {
  return fahrzeuge.map((f) => ({ fahrzeug: f, ...matchFahrzeug(sollAusstattung, f) }))
    .sort((a, b) => b.score - a.score);
}

// --- Ausstattungslinie / Trimlevel ---------------------------------------
// Reihenfolge = Priorität: spezifische/zusammengesetzte Linien zuerst, damit
// z. B. "R-Line Black Style" als R-Line (nicht als Style) erkannt wird.
const LINIEN = [
  ["R-Line", ["r-line", "r line", "rline"]],
  ["GTI", ["gti"]], ["GTD", ["gtd"]], ["GTE", ["gte"]], ["GTX", ["gtx"]],
  ["AMG Line", ["amg line", "amg-line"]],
  ["M Sport", ["m sport", "m-sport", "msport"]],
  ["S line", ["s line", "s-line", "sline"]],
  ["Black Edition", ["black edition"]],
  ["Style", ["style"]],
  ["Life", ["life"]],
  ["Move", ["move"]],
  ["United", ["united"]],
  ["Active", ["active"]],
  ["Highline", ["highline"]],
  ["Comfortline", ["comfortline"]],
  ["Trendline", ["trendline"]],
  ["Lounge", ["lounge"]],
  ["Pop", ["pop"]], ["Pop Star", ["pop star", "popstar"]],
  ["Sport", ["sport"]], ["S-Design", ["s-design", "s design", "sdesign"]],
  ["City Cross", ["city cross", "citycross"]], ["Cross", ["cross"]],
  ["Mirror", ["mirror"]], ["Easy", ["easy"]],
  ["Ambition", ["ambition"]], ["Ambiente", ["ambiente"]],
  ["Titanium", ["titanium"]], ["Trend", ["trend"]], ["Cool & Sound", ["cool & sound", "cool und sound"]],
  ["Edition", ["edition"]],
  ["Elegance", ["elegance"]],
  ["Avantgarde", ["avantgarde"]],
  ["Progressive", ["progressive"]],
];

// Linie aus einem Text erkennen (Wortgrenzen, damit "lifestyle" nicht "Life"/"Style" trifft).
function detectLinie(text) {
  const t = norm(text);
  if (!t) return null;
  for (const [canon, pats] of LINIEN) {
    if (pats.some((p) => new RegExp(`(^|[^a-zäöü])${escapeRe(p)}([^a-zäöü]|$)`).test(t))) return canon;
  }
  return null;
}

// --- Karosserie / Bauart --------------------------------------------------
// Reihenfolge = Priorität (Cabrio/Coupé zuerst, da im Titel am eindeutigsten).
const KAROSSERIEN = [
  ["Cabrio", ["cabrio", "cabriolet", "convertible", "roadster"]],
  ["Coupé", ["coupe", "coupé"]],
  // "variant", "sportstourer", "shooting brake" u. a.: so heisst der Kombi bei den
  // Herstellern. AutoScout24 liefert KEIN Bauart-Feld - die Bauart steckt nur im
  // Modellnamen bzw. Titel, und ohne diese Begriffe blieb sie dort unerkannt.
  ["Kombi", ["kombi", "estate", "wagon", "station wagon", "touring", "avant",
    "variant", "sportstourer", "sports tourer", "sportbrake", "shooting brake",
    "sw", "kombilimousine", "turnier", "caravan", "vario", "break",
    "combi", "t-modell", "t modell", "tmodell", "sportwagon", "sports wagon"]],
  ["SUV", ["suv", "geländewagen", "gelaendewagen", "gelände", "offroad", "off-road", "crossover"]],
  ["Van", ["van", "minibus", "transporter", "kleinbus", "mpv", "sportsvan",
    "sports van", "tourer", "scenic", "verso", "picasso", "zafira", "sharan",
    "touran", "galaxy", "espace", "multivan", "caddy", "combo", "berlingo",
    "partner", "kangoo", "doblo", "rifter", "proace", "spacetourer"]],
  ["Pickup", ["pickup", "pick-up", "pritsche"]],
  ["Kleinwagen", ["kleinwagen", "small car", "hatchback", "kompaktklasse"]],
  // "lim." ist die Abkuerzung, die AutoScout24 im Titel fuehrt ("VII Lim. Trendline").
  ["Limousine", ["limousine", "sedan", "saloon", "stufenheck", "lim", "lim.",
    "schraegheck", "schrägheck", "fliessheck", "fließheck"]],
];

// Bauart aus Bauart-Feld + Titel erkennen.
function detectKarosserie(text) {
  const t = norm(text);
  if (!t) return null;
  for (const [canon, pats] of KAROSSERIEN) {
    if (pats.some((p) => new RegExp(`(^|[^a-zäöü])${escapeRe(p)}([^a-zäöü]|$)`).test(t))) return canon;
  }
  return null;
}

// --- Getriebe -------------------------------------------------------------
// DSG/Doppelkupplung/Tiptronic/Semi-Automatik zählen als Automatik (kein
// klassisches Schaltgetriebe).
const GETRIEBE = [
  ["Automatik", ["automatik", "automatic", "automatik_gear", "automatic_gear", "dsg", "s-tronic",
    "stronic", "tiptronic", "doppelkupplung", "pdk", "semi-automatic", "semi_automatic",
    "halbautomatik", "wandlerautomatik", "edc", "powershift"]],
  ["Manuell", ["manuell", "manual", "manual_gear", "schaltgetriebe", "schalt", "handschalt"]],
];

function detectGetriebe(text) {
  const t = norm(text);
  if (!t) return null;
  for (const [canon, pats] of GETRIEBE) {
    if (pats.some((p) => new RegExp(`(^|[^a-zäöü])${escapeRe(p)}([^a-zäöü]|$)`).test(t))) return canon;
  }
  return null;
}

module.exports = {
  matchFahrzeug, bewerteKorb, klimaautomatikVorhanden, KATALOG,
  detectLinie, LINIEN, detectKarosserie, KAROSSERIEN, detectGetriebe, GETRIEBE,
};
