#!/bin/bash
# SessionStart-Hook für das Plugin wbw-vergleichsfahrzeug-finder.
#
# Es gibt NICHTS zu installieren: die Skripte nutzen ausschliesslich Node-Bordmittel
# (fs, https, tls, zlib ...), package.json hat weder dependencies noch devDependencies.
# Das ist Absicht - ein Gutachten-Skill soll ohne `npm install` lauffaehig bleiben.
#
# Der Hook tut deshalb zwei Dinge:
#   1. Er meldet, welche Beschaffungsstufen mit den vorhandenen Zugangsdaten nutzbar
#      sind. Ohne das faellt erst mitten im Lauf auf, dass eine Variable fehlt.
#   2. Er sucht ein Chromium und exportiert WBW_CHROME. Ohne das erzeugt run-report.js
#      still nur HTML statt PDF, weil in Container-Umgebungen kein Chrome im
#      Standardpfad liegt.
#
# Idempotent, ohne Netzzugriff, ohne Rueckfragen. Laeuft in unter einer Sekunde.
set -uo pipefail

WURZEL="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

# --- Node vorhanden? ----------------------------------------------------------
if command -v node >/dev/null 2>&1; then
  NODE_V="$(node -v)"
else
  echo "WBW-Plugin: node nicht gefunden - die Skripte koennen nicht laufen."
  exit 0     # Hooks duerfen den Sessionstart nicht abbrechen
fi

# --- .env einlesen, nur um den Status zu melden (ueberschreibt nichts) ---------
KA=""; APIFY=""; BRIGHT=""
if [ -f "$WURZEL/.env" ]; then
  KA="$(grep -E '^KA_API_BASE=.+' "$WURZEL/.env" 2>/dev/null | head -1)"
  APIFY="$(grep -E '^APIFY_TOKEN=.+' "$WURZEL/.env" 2>/dev/null | head -1)"
  BRIGHT="$(grep -E '^BRIGHTDATA_TOKEN=.+' "$WURZEL/.env" 2>/dev/null | head -1)"
fi
[ -n "${KA_API_BASE:-}" ]      && KA="gesetzt"
[ -n "${APIFY_TOKEN:-}" ]      && APIFY="gesetzt"
[ -n "${BRIGHTDATA_TOKEN:-}" ] && BRIGHT="gesetzt"

# --- Chromium fuer die PDF-Erzeugung finden -----------------------------------
if [ -z "${WBW_CHROME:-}" ]; then
  for KANDIDAT in \
    /opt/pw-browsers/chromium-*/chrome-linux/chrome \
    "$(command -v google-chrome 2>/dev/null)" \
    "$(command -v chromium 2>/dev/null)" \
    "$(command -v chromium-browser 2>/dev/null)"
  do
    if [ -n "$KANDIDAT" ] && [ -x "$KANDIDAT" ]; then
      if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
        echo "export WBW_CHROME=\"$KANDIDAT\"" >> "$CLAUDE_ENV_FILE"
      fi
      CHROME="$KANDIDAT"
      break
    fi
  done
fi

# --- Kurzmeldung in den Sessionkontext ----------------------------------------
echo "WBW-Vergleichsfahrzeug-Finder bereit (Node $NODE_V, keine Abhaengigkeiten zu installieren)."
echo "  Beschaffungsstufen:"
echo "    L0 AutoScout24    : nutzbar (keine Zugangsdaten noetig)"
echo "    L1 Kleinanzeigen  : $([ -n "$KA" ] && echo 'nutzbar' || echo 'KA_API_BASE/KA_API_USER/KA_API_PASS fehlen')"
echo "    L2 Bright Data    : $([ -n "$BRIGHT" ] && echo 'Token vorhanden' || echo 'deaktiviert (kein Token)')"
echo "    L3 Apify          : $([ -n "$APIFY" ] && echo 'Token vorhanden - Lauf zusaetzlich mit WBW_ALLOW_PAID=1 freischalten' || echo 'APIFY_TOKEN fehlt (nur fuer mobile.de noetig)')"
echo "  PDF-Erzeugung      : ${CHROME:-kein Chromium gefunden - Report bleibt HTML}"
echo "  Tests              : npm test (offline, kostenlos) | npm run test:schema (Netz) | npm run test:live (Netz)"
exit 0
