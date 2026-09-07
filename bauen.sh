#!/bin/bash
# Baut die .plugin-Datei fuer Cowork bzw. eine Installation aus der Datei.
#
# Enthaelt NUR Laufzeit-Bestandteile: kein .claude/ (das ist Projektkonfiguration
# dieses Repos, keine Plugin-Eigenschaft), keine Tests, kein .git, keine .env.
# Die Marketplace-Datei bleibt ebenfalls draussen - sie gehoert zum Weg ueber
# `/plugin marketplace add`, nicht zur Installation aus einer Datei.
#
#   ./bauen.sh [zieldatei]
#
# Fuer Cloud-Sitzungen, in denen es keinen Benutzerordner zum Hinterlegen gibt:
#
#   ./bauen.sh --mit-zugangsdaten [quelle.env] [zieldatei]
#
# Dann landet eine .env MIT den Zugangsdaten im Paket. Die Datei ist damit
# vertraulich wie ein Passwort - nicht ins Repo, nicht weitergeben. Uebernommen
# werden ausschliesslich die Variablen, die der Skill braucht; alles andere
# (etwa ein Coolify-Verwaltungstoken) bleibt garantiert draussen.
set -euo pipefail
cd "$(dirname "$0")"

# Nur diese Variablen duerfen in ein Paket. Whitelist statt Blacklist: was hier
# nicht steht, kann auch nicht versehentlich mitgehen.
ERLAUBT="KA_API_BASE KA_API_USER KA_API_PASS APIFY_TOKEN WBW_ALLOW_PAID BRIGHTDATA_TOKEN BRIGHTDATA_ZONE WBW_PAUSE_MS WBW_CHROME"

MIT_ZUGANG=0
QUELLE=".env"
if [ "${1:-}" = "--mit-zugangsdaten" ]; then
  MIT_ZUGANG=1; shift
  case "${1:-}" in *.env) QUELLE="$1"; shift;; esac
fi

ZIEL="${1:-$PWD/wbw-vergleichsfahrzeug-finder.plugin}"
VERSION="$(node -p "require('./.claude-plugin/plugin.json').version")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for P in .claude-plugin skills hooks README.md .env.example; do cp -a "$P" "$TMP/"; done
rm -f "$TMP/.claude-plugin/marketplace.json"
chmod +x "$TMP/hooks/"*.sh

if [ "$MIT_ZUGANG" = 1 ]; then
  [ -f "$QUELLE" ] || { echo "ABBRUCH: $QUELLE nicht gefunden." >&2; exit 1; }
  : > "$TMP/.env"
  ANZAHL=0
  while IFS='=' read -r K V; do
    K="$(printf '%s' "${K:-}" | tr -d '[:space:]')"
    case "$K" in ''|\#*) continue;; esac
    case " $ERLAUBT " in *" $K "*) ;; *) continue;; esac
    [ -z "${V:-}" ] && continue
    printf '%s=%s\n' "$K" "$V" >> "$TMP/.env"
    ANZAHL=$((ANZAHL+1))
  done < "$QUELLE"
  chmod 600 "$TMP/.env"
  echo "ACHTUNG: $ANZAHL Zugangsdaten aus $QUELLE liegen im Paket."
  echo "         Diese Datei ist ab jetzt so vertraulich wie ein Passwort:"
  echo "         nicht ins Repo, nicht per Mail, nicht weitergeben."
  echo "         Uebernommen wurden nur: $ERLAUBT"
fi

# Sicherheitsnetz: nichts Vertrauliches ins Paket - ausser dem, was oben
# ausdruecklich hineingelegt wurde.
if [ -f .env ] && [ "$MIT_ZUGANG" = 0 ]; then
  while IFS='=' read -r K V; do
    case "$K" in ''|\#*) continue;; esac
    case "$K" in *PASS*|*TOKEN*|*SECRET*) ;; *) continue;; esac
    [ -z "${V:-}" ] && continue
    if grep -rIqs -F "$V" "$TMP"; then
      echo "ABBRUCH: Wert von $K steckt im Paket." >&2; exit 1
    fi
  done < .env
fi

rm -f "$ZIEL"
( cd "$TMP" && zip -qr "$ZIEL" . -x '.DS_Store' )
echo "Gebaut: $ZIEL  (Version $VERSION, $(unzip -l "$ZIEL" | tail -1 | awk '{print $2}') Dateien, $(du -h "$ZIEL" | cut -f1))"
