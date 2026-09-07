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
#      Die Meldung kommt aus pruefe-umgebung.js --kurz und damit aus GENAU der
#      Suchlogik, die fetch-portal.js spaeter benutzt (Umgebungsvariablen zuerst,
#      dann .env im Arbeitsordner, Benutzerprofil, Plugin-Wurzel). Frueher hatte
#      der Hook eine eigene, kuerzere Liste - und meldete in der Cloud "fehlen",
#      obwohl der Lauf die Werte gefunden haette.
#   2. Er sucht ein Chromium und exportiert WBW_CHROME. Ohne das erzeugt run-report.js
#      still nur HTML statt PDF, weil in Container-Umgebungen kein Chrome im
#      Standardpfad liegt.
#
# Idempotent, ohne Netzzugriff, ohne Rueckfragen. Laeuft in unter einer Sekunde.
set -uo pipefail

# Plugin-Wurzel: von Claude Code gesetzt (Plugin-Installation) oder aus dem
# eigenen Pfad abgeleitet (Arbeit aus dem Repo, Projekt-Hook in .claude/settings.json).
HIER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN="${CLAUDE_PLUGIN_ROOT:-$(cd "$HIER/.." && pwd)}"
# Arbeitsordner der Sitzung: dort sucht der Lauf spaeter zuerst nach einer .env.
WURZEL="${CLAUDE_PROJECT_DIR:-$PWD}"
SC="$PLUGIN/skills/wbw-vergleichsfahrzeuge/scripts"

# --- Node vorhanden? ----------------------------------------------------------
if command -v node >/dev/null 2>&1; then
  NODE_V="$(node -v)"
else
  echo "WBW-Plugin: node nicht gefunden - die Skripte koennen nicht laufen."
  exit 0     # Hooks duerfen den Sessionstart nicht abbrechen
fi

# --- Chromium fuer die PDF-Erzeugung finden -----------------------------------
if [ -n "${WBW_CHROME:-}" ]; then
  CHROME="$WBW_CHROME"          # bereits gesetzt - dann gilt der Wert
else
  CHROME=""
  for KANDIDAT in \
    /opt/pw-browsers/chromium-*/chrome-linux/chrome \
    "$(command -v google-chrome 2>/dev/null)" \
    "$(command -v google-chrome-stable 2>/dev/null)" \
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
if [ -f "$SC/pruefe-umgebung.js" ]; then
  # Im Arbeitsordner ausfuehren und die Plugin-Wurzel durchreichen - so sieht die
  # Pruefung dieselben Pfade wie der spaetere Lauf. Gibt nie Passwoerter aus.
  ( cd "$WURZEL" 2>/dev/null || true; CLAUDE_PLUGIN_ROOT="$PLUGIN" node "$SC/pruefe-umgebung.js" --kurz 2>&1 ) \
    || echo "  Umgebungspruefung fehlgeschlagen - bitte 'node \"$SC/pruefe-umgebung.js\"' von Hand ausfuehren."
else
  echo "  pruefe-umgebung.js fehlt unter $SC - Plugin unvollstaendig?"
fi
echo "  PDF-Erzeugung      : ${CHROME:-kein Chromium gefunden - Report bleibt HTML}"
echo "  Umgebungspruefung  : node \"$SC/pruefe-umgebung.js\" --netz"
# Die Testsuite gehoert zum Repo, nicht zum ausgelieferten Plugin. Nur melden,
# wenn sie tatsaechlich danebenliegt - sonst waere der Hinweis in einer reinen
# Plugin-Installation eine Sackgasse.
if [ -f "$WURZEL/package.json" ] && [ -d "$WURZEL/tests" ]; then
  echo "  Tests              : npm test (offline, kostenlos) | npm run test:schema (Netz) | npm run test:live (Netz)"
fi
exit 0
