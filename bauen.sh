#!/bin/bash
# Baut die .plugin-Datei fuer Cowork bzw. eine Installation aus der Datei.
#
# Enthaelt NUR Laufzeit-Bestandteile: kein .claude/ (das ist Projektkonfiguration
# dieses Repos, keine Plugin-Eigenschaft), keine Tests, kein .git, keine .env.
# Die Marketplace-Datei bleibt ebenfalls draussen - sie gehoert zum Weg ueber
# `/plugin marketplace add`, nicht zur Installation aus einer Datei.
#
#   ./bauen.sh [zieldatei]
#       Paket OHNE Zugangsdaten. Bricht ab, falls doch ein Geheimnis hineingeraet.
#
#   ./bauen.sh --mit-zugangsdaten [quelle.env] [zieldatei]
#       Paket MIT einer .env fuer Umgebungen ohne eigene Umgebungsvariablen
#       (Cloud-Sitzung, fremder Rechner). Uebernommen wird NUR die feste Liste
#       ERLAUBT unten - alles andere aus der Quelldatei (etwa ein Coolify-Token)
#       bleibt garantiert draussen. Die so gebaute Datei ist so vertraulich wie
#       das Passwort selbst: nicht ins Repo, nicht per Mail, nicht weitergeben.
set -euo pipefail
cd "$(dirname "$0")"

ERLAUBT="KA_API_BASE KA_API_USER KA_API_PASS APIFY_TOKEN WBW_ALLOW_PAID BRIGHTDATA_TOKEN BRIGHTDATA_ZONE WBW_PAUSE_MS WBW_CHROME"

MIT_ZUGANG=0
QUELLE=".env"
if [ "${1:-}" = "--mit-zugangsdaten" ]; then
  MIT_ZUGANG=1; shift
  # Erstes Argument ist die Quelldatei, wenn es eine existierende Datei ist,
  # die nicht auf .plugin endet.
  if [ -n "${1:-}" ] && [ -f "$1" ] && [[ "$1" != *.plugin ]]; then QUELLE="$1"; shift; fi
  [ -f "$QUELLE" ] || { echo "ABBRUCH: Quelldatei $QUELLE nicht gefunden." >&2; exit 1; }
fi

if [ "$MIT_ZUGANG" = 1 ]; then
  ZIEL="${1:-$PWD/wbw-vergleichsfahrzeug-finder-VERTRAULICH.plugin}"
else
  ZIEL="${1:-$PWD/wbw-vergleichsfahrzeug-finder.plugin}"
fi
VERSION="$(node -p "require('./.claude-plugin/plugin.json').version")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for P in .claude-plugin skills hooks README.md .env.example; do cp -a "$P" "$TMP/"; done
rm -f "$TMP/.claude-plugin/marketplace.json"
chmod +x "$TMP/hooks/"*.sh

# Liest eine .env zeilenweise: gibt "SCHLUESSEL<TAB>WERT" fuer jede gesetzte Variable aus.
# Anfuehrungszeichen bleiben stehen - ladeEnv() entfernt sie beim Lesen selbst.
lese_env() {
  while IFS= read -r ZEILE || [ -n "$ZEILE" ]; do
    ZEILE="${ZEILE%$'\r'}"
    case "$ZEILE" in ''|\#*) continue;; esac
    case "$ZEILE" in *=*) ;; *) continue;; esac
    K="${ZEILE%%=*}"; V="${ZEILE#*=}"
    K="$(echo "$K" | tr -d '[:space:]')"
    [ -z "$K" ] && continue
    [ -z "$V" ] && continue
    printf '%s\t%s\n' "$K" "$V"
  done < "$1"
}

UEBERNOMMEN=""
if [ "$MIT_ZUGANG" = 1 ]; then
  {
    echo "# Zugangsdaten, mit ./bauen.sh --mit-zugangsdaten eingebaut ($(date -u +%Y-%m-%dT%H:%MZ))."
    echo "# Gesetzte Umgebungsvariablen haben Vorrang vor dieser Datei."
  } > "$TMP/.env"
  while IFS=$'\t' read -r K V; do
    for E in $ERLAUBT; do
      if [ "$K" = "$E" ]; then echo "$K=$V" >> "$TMP/.env"; UEBERNOMMEN="$UEBERNOMMEN $K"; break; fi
    done
  done < <(lese_env "$QUELLE")
  [ -n "$UEBERNOMMEN" ] || { echo "ABBRUCH: $QUELLE enthaelt keine der erlaubten Variablen ($ERLAUBT)." >&2; exit 1; }
  chmod 600 "$TMP/.env"
fi

# Sicherheitsnetz: kein Geheimnis ausserhalb der (optionalen) .env im Paket.
# Geprueft wird gegen die Quelldatei UND gegen eine .env dieses Ordners.
for DATEI in "$QUELLE" .env; do
  [ -f "$DATEI" ] || continue
  while IFS=$'\t' read -r K V; do
    case "$K" in *PASS*|*TOKEN*|*SECRET*) ;; *) continue;; esac
    # Wert ohne umschliessende Anfuehrungszeichen suchen, damit auch entquotete Treffer auffallen.
    W="$V"; W="${W#\"}"; W="${W%\"}"; W="${W#\'}"; W="${W%\'}"
    [ ${#W} -ge 4 ] || continue
    TREFFER="$(grep -rIls -F -- "$W" "$TMP" || true)"
    [ -z "$TREFFER" ] && continue
    if [ "$MIT_ZUGANG" = 1 ] && [ "$TREFFER" = "$TMP/.env" ]; then continue; fi
    echo "ABBRUCH: Wert von $K steckt ausserhalb der .env im Paket:" >&2
    echo "$TREFFER" | sed "s#^$TMP#  #" >&2
    exit 1
  done < <(lese_env "$DATEI")
done
if [ "$MIT_ZUGANG" = 0 ] && [ -e "$TMP/.env" ]; then
  echo "ABBRUCH: eine .env ist ins Paket geraten, obwohl ohne --mit-zugangsdaten gebaut wurde." >&2; exit 1
fi

rm -f "$ZIEL"
( cd "$TMP" && zip -qr "$ZIEL" . -x '.DS_Store' )
if [ "$MIT_ZUGANG" = 1 ]; then
  chmod 600 "$ZIEL"
  echo "Gebaut: $ZIEL  (Version $VERSION, $(unzip -l "$ZIEL" | tail -1 | awk '{print $2}') Dateien, $(du -h "$ZIEL" | cut -f1))"
  echo "  MIT Zugangsdaten:$UEBERNOMMEN"
  echo "  Diese Datei ist VERTRAULICH - nicht ins Repo, nicht per Mail, nicht weitergeben."
else
  echo "Gebaut: $ZIEL  (Version $VERSION, $(unzip -l "$ZIEL" | tail -1 | awk '{print $2}') Dateien, $(du -h "$ZIEL" | cut -f1))"
fi
