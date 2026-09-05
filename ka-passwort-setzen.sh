#!/usr/bin/env bash
# Setzt das Basic-Auth-Passwort des Kleinanzeigen-Dienstes (ka-api) neu.
#
# Warum ein Skript und nicht die Coolify-Oberflaeche: der Zugriffsschutz haengt an
# einem eigenen Traefik-Labelsatz der Anwendung. Der wurde ueber die Coolify-API
# gesetzt und ist in der Oberflaeche nicht editierbar. Ausserdem ERSETZEN gesetzte
# custom_labels die von Coolify erzeugten - der Satz muss deshalb immer vollstaendig
# geschrieben werden (Router, Service, Port, TLS, Middleware). Genau das tut dieses
# Skript; Teilaenderungen von Hand legen den Dienst mit HTTP 503 lahm.
#
# Aufruf:  ./ka-passwort-setzen.sh 'neues-passwort'
#          ./ka-passwort-setzen.sh --pruefen      (nur pruefen, nichts aendern)
#          ./ka-passwort-setzen.sh --zeigen 'pw'  (Labelsatz anzeigen, nichts senden)
#
# Erwartet in der .env: KA_API_USER, KA_API_BASE, COOLIFY_BASE_URL, COOLIFY_API_TOKEN
set -euo pipefail
cd "$(dirname "$0")"

APP_UUID="${KA_COOLIFY_APP_UUID:-cscqzonjs5idabs6an5a3x5c}"
HOST_NEU="ka-api.gollenstede.app"
HOST_ALT="ka-api.116.202.21.243.sslip.io"

[ -f .env ] || { echo "FEHLER: .env nicht gefunden in $(pwd)" >&2; exit 2; }
set -a; . ./.env; set +a

for v in KA_API_USER COOLIFY_BASE_URL COOLIFY_API_TOKEN; do
  [ -n "${!v:-}" ] || { echo "FEHLER: $v fehlt in der .env" >&2; exit 2; }
done
BASE="${COOLIFY_BASE_URL%/}"; case "$BASE" in http*) ;; *) BASE="https://$BASE";; esac
ZIEL="${KA_API_BASE:-https://$HOST_NEU}"

pruefen() {
  local pw="$1" ohne falsch mit
  ohne=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$ZIEL/")
  falsch=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -u "$KA_API_USER:falsch" "$ZIEL/")
  mit=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -u "$KA_API_USER:$pw" "$ZIEL/")
  echo "  ohne Zugangsdaten : $ohne   (erwartet 401)"
  echo "  falsches Passwort : $falsch   (erwartet 401)"
  echo "  mit Zugangsdaten  : $mit   (erwartet 200)"
  [ "$ohne" = 401 ] && [ "$falsch" = 401 ] && [ "$mit" = 200 ]
}

if [ "${1:-}" = "--pruefen" ]; then
  echo "Pruefe $ZIEL mit dem Passwort aus der .env:"
  pruefen "${KA_API_PASS:-}" && { echo "OK - Schutz wirkt, Zugangsdaten stimmen."; exit 0; }
  echo "NICHT OK." >&2; exit 1
fi

TROCKEN=nein
if [ "${1:-}" = "--zeigen" ]; then TROCKEN=ja; shift; fi

NEU="${1:-}"
[ -n "$NEU" ] || { echo "Aufruf: $0 'neues-passwort'   |   $0 --pruefen   |   $0 --zeigen 'pw'" >&2; exit 2; }
[ "${#NEU}" -ge 12 ] || { echo "FEHLER: Passwort zu kurz (mindestens 12 Zeichen)." >&2; exit 2; }
case "$NEU" in
  *"'"*) echo "FEHLER: Das Passwort darf kein einfaches Anfuehrungszeichen enthalten - die .env" >&2
         echo "        wird sowohl von der Shell als auch vom Skill gelesen und liesse sich sonst" >&2
         echo "        nicht eindeutig zitieren. Bitte ein anderes Zeichen waehlen." >&2; exit 2;;
esac

# Vollstaendiger Labelsatz - eine Zeile je Label.
baue_labels() {
KA_NEUES_PW="$NEU" python3 - "$KA_API_USER" "$HOST_NEU" "$HOST_ALT" <<'PY'
import os, sys, base64, hashlib
user, neu, alt = sys.argv[1], sys.argv[2], sys.argv[3]
h = '{SHA}' + base64.b64encode(hashlib.sha1(os.environ['KA_NEUES_PW'].encode()).digest()).decode()
regel = f'Host(`{neu}`) || Host(`{alt}`)'
L = [
 'traefik.enable=true',
 f'traefik.http.middlewares.ka-auth.basicauth.users={user}:{h}',
 'traefik.http.middlewares.ka-auth.basicauth.realm=WBW-Beschaffung',
 'traefik.http.services.ka-svc.loadbalancer.server.port=8000',
 # HTTP wird bewusst NICHT auf HTTPS umgeleitet: Cloudflare terminiert TLS und
 # spricht je nach SSL-Modus per HTTP zum Ursprung - eine Umleitung ergaebe eine
 # Schleife. Der Schutz haengt an der Auth-Middleware, nicht am Schema.
 f'traefik.http.routers.ka-http.rule={regel}',
 'traefik.http.routers.ka-http.entryPoints=http',
 'traefik.http.routers.ka-http.middlewares=ka-auth',
 'traefik.http.routers.ka-http.service=ka-svc',
 f'traefik.http.routers.ka-https.rule={regel}',
 'traefik.http.routers.ka-https.entryPoints=https',
 'traefik.http.routers.ka-https.tls=true',
 'traefik.http.routers.ka-https.tls.certresolver=letsencrypt',
 'traefik.http.routers.ka-https.middlewares=ka-auth',
 'traefik.http.routers.ka-https.service=ka-svc',
]
print('\n'.join(L))
PY
}

if [ "$TROCKEN" = ja ]; then
  echo "Labelsatz, der an Coolify geschrieben wuerde (Hash gekuerzt, nichts gesendet):"
  baue_labels | sed 's#\({SHA}[A-Za-z0-9+/]\{8\}\)[A-Za-z0-9+/=]*#\1...#'
  exit 0
fi

LABELS_B64=$(baue_labels | python3 -c "
import sys, base64
print(base64.b64encode(sys.stdin.read().rstrip('\n').encode()).decode(), end='')")

echo "1/4  Labelsatz an Coolify schreiben (Anwendung $APP_UUID) ..."
RUMPF=$(LB="$LABELS_B64" HN="$HOST_NEU" HA="$HOST_ALT" python3 -c "
import json,os
print(json.dumps({'custom_labels': os.environ['LB'],
                  'fqdn': 'https://%s,https://%s' % (os.environ['HN'], os.environ['HA'])}))")
ANTWORT=$(curl -s -X PATCH -H "Authorization: Bearer $COOLIFY_API_TOKEN" \
  -H "Content-Type: application/json" -d "$RUMPF" "$BASE/api/v1/applications/$APP_UUID")
echo "     Antwort: $(printf '%s' "$ANTWORT" | head -c 160)"

echo "2/4  Neu ausrollen ..."
curl -s -X POST -H "Authorization: Bearer $COOLIFY_API_TOKEN" \
  "$BASE/api/v1/deploy?uuid=$APP_UUID&force=true" | head -c 160; echo

echo "3/4  Warten, bis der neue Labelsatz greift ..."
erreichbar=nein
for i in $(seq 1 40); do
  sleep 6
  if [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -u "$KA_API_USER:$NEU" "$ZIEL/")" = 200 ]; then
    echo "     nach $((i*6)) s erreichbar."
    erreichbar=ja
    break
  fi
done
[ "$erreichbar" = ja ] || { echo "FEHLER: Dienst antwortet nach 4 Minuten nicht mit dem neuen Passwort." >&2; exit 1; }

echo "4/4  Schutz pruefen:"
pruefen "$NEU" || { echo "FEHLER: Zugriffsschutz verhaelt sich nicht wie erwartet." >&2; exit 1; }

python3 - "$NEU" <<'PY'
import sys, pathlib, re
# Einfache Anfuehrungszeichen: die .env wird einmal von der Shell gesourct
# (set -a; . ./.env) und einmal von gemeinsam.js gelesen, das genau ein Paar
# umschliessender Anfuehrungszeichen entfernt. Nur so bleiben $, \ und & heil.
p = pathlib.Path('.env'); t = p.read_text()
neu = sys.argv[1]
ersatz = "KA_API_PASS='" + neu + "'"
t2, n = re.subn(r'^KA_API_PASS=.*$', lambda m: ersatz, t, flags=re.M)
if n == 0:
    t2 = t.rstrip('\n') + '\n' + ersatz + '\n'
p.write_text(t2)
print("     KA_API_PASS in der .env nachgezogen.")
PY

echo
echo "Fertig. Dasselbe Passwort noch in ~/.claude/.env eintragen, falls der Skill von dort liest."
