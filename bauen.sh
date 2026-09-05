#!/bin/bash
# Baut die .plugin-Datei fuer Cowork bzw. eine Installation aus der Datei.
#
# Enthaelt NUR Laufzeit-Bestandteile: kein .claude/ (das ist Projektkonfiguration
# dieses Repos, keine Plugin-Eigenschaft), keine Tests, kein .git, keine .env.
# Die Marketplace-Datei bleibt ebenfalls draussen - sie gehoert zum Weg ueber
# `/plugin marketplace add`, nicht zur Installation aus einer Datei.
#
#   ./bauen.sh [zieldatei]
set -euo pipefail
cd "$(dirname "$0")"

ZIEL="${1:-$PWD/wbw-vergleichsfahrzeug-finder.plugin}"
VERSION="$(node -p "require('./.claude-plugin/plugin.json').version")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for P in .claude-plugin skills hooks README.md .env.example; do cp -a "$P" "$TMP/"; done
rm -f "$TMP/.claude-plugin/marketplace.json"
chmod +x "$TMP/hooks/"*.sh

# Sicherheitsnetz: nichts Vertrauliches ins Paket.
if [ -f .env ]; then
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
