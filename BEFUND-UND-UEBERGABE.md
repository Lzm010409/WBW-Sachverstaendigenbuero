# Befund und Übergabe — WBW-Skill von Apify entkoppeln

Stand: 2026-09-05 · Session: Vorbereitung, **keine Implementierung**

Diese Session konnte den Auftrag nicht ausführen. Zwei Voraussetzungen fehlten.
Das Dokument hält fest, was belegt wurde, was korrigiert werden muss und was
erfüllt sein muss, damit die nächste Session durchläuft.

---

## 1. Warum diese Session nicht liefern konnte

### Blocker 1 — Das Plugin liegt nicht im Repo

```
$ find . -path ./.git -prune -o -type f -print
./.claude/settings.json
```

Kein `skills/wbw-vergleichsfahrzeuge/`, kein `SKILL.md`, kein `normalize.js`,
kein `run-report.js`. Auch die in Phase 5 vorausgesetzten vorbereiteten Dateien
(`fetch-portal.js`, `providers.json`, `adapters/`) existieren nirgends:

```
$ find / -xdev \( -name "fetch-portal.js" -o -name "providers.json" \
    -o -name "normalize.js" -o -name "run-report.js" \) | grep -v node_modules
(keine Treffer)
```

Auf Rückfrage bestätigt: Das Plugin existiert **nur lokal** auf dem Rechner des
Nutzers. Damit war Phase 0 Punkt 2 nicht erfüllbar — die Kandidatenlisten von
`normalize.js` konnten nicht notiert werden.

**Nebenbefund:** `.claude/settings.json` registriert einen `SessionStart`-Hook
`$CLAUDE_PROJECT_DIR/.claude/hooks/session-start.sh`. Die Datei fehlt im Repo.

### Blocker 2 — Egress-Policy sperrt alle Zielsysteme

```
curl: (56) CONNECT tunnel failed, response 403   suchen.mobile.de
curl: (56) CONNECT tunnel failed, response 403   www.autoscout24.de
curl: (56) CONNECT tunnel failed, response 403   www.kleinanzeigen.de
curl: (56) CONNECT tunnel failed, response 403   api.apify.com
302                                              coolify.gollenstede.app
```

Der Egress-Proxy weist das als Policy-Entscheidung aus, nicht als Portalsperre:

```json
{"kind":"connect_rejected",
 "detail":"gateway answered 403 to CONNECT (policy denial or upstream failure)",
 "host":"suchen.mobile.de:443"}
```

Die Proxy-Dokumentation (`/root/.ccr/README.md`) untersagt ausdrücklich, solche
Sperren zu umgehen. Damit war **jeder** Live-Nachweis der Definition of Done
unmöglich: BFF-Ermittlung (Phase 3), AutoScout24-Messreihe (Phase 4),
Kleinanzeigen-Detailabruf (Phase 2), E2E-Regressionslauf (Phase 6) — und selbst
der Apify-Rückfall L3.

**Offen geblieben ist der Git-Kanal.** `git clone` gegen github.com funktioniert,
weil der Proxy git gesondert behandelt. Nur deshalb war die Vorarbeit in
Abschnitt 3 überhaupt möglich.

---

## 2. Voraussetzungen für die nächste Session

Beide Punkte müssen erfüllt sein. Die Netzfreigabe allein genügt **nicht** —
ohne das Plugin startet die nächste Session mit demselben Blocker 1.

### 2.1 Plugin verfügbar machen

Eine der beiden Varianten:

- **Empfohlen:** Plugin-Ordner in dieses Repo pushen, unter
  `skills/wbw-vergleichsfahrzeuge/`. Dann arbeitet die Cloud-Session direkt darauf.
- **Alternativ:** Auftrag in einer lokalen Claude-Code-Session fahren, wo das
  Plugin ohnehin liegt. Dann entfällt auch Blocker 2 vollständig, weil lokal kein
  Egress-Proxy dazwischensteht.

### 2.2 Egress-Policy erweitern

In der Environment-Konfiguration (claude.ai/code → Environment) freizugeben:

| Host | Wofür | Phase |
|---|---|---|
| `suchen.mobile.de` | Trefferliste, BFF-Endpunkt | 3 |
| `www.mobile.de` | Fallback-Domain, Detailseiten | 3 |
| `www.autoscout24.de` | `__NEXT_DATA__`, Blockade-Messreihe | 4 |
| `www.kleinanzeigen.de` | Vom KA-Dienst angesteuert | 2 |
| `api.apify.com` | L3-Rückfallebene, Regressionsvergleich | 6 |
| `ka-api.gollenstede.app` | Eigener KA-Dienst nach Deployment | 2 |

`coolify.gollenstede.app` ist bereits erreichbar (HTTP 302) und muss nicht
freigegeben werden.

**Ohne `api.apify.com` ist die Regressionstabelle in Phase 6 nicht ausfüllbar** —
die Spalte „alt (Apify)" braucht einen echten Vergleichslauf.

### 2.3 Vorhandenes Tooling (geprüft)

```
Node   v22.22.2      npm 10.9.7      npx 10.9.7
Python 3.11.15       Docker 29.3.1
```

Ausreichend für `node --test`, für einen lokalen Container-Build des KA-Dienstes
und für Playwright (Chromium ist vorinstalliert unter `/opt/pw-browsers`).

---

## 3. Vorarbeit Phase 2 — verifiziert am Quellcode

`DanielWTE/ebay-kleinanzeigen-api` wurde geklont und gelesen. Die folgenden
Angaben stammen aus der Implementierung, **nicht** aus einer Live-Antwort. Sie
ersetzen keine Fixture, verhindern aber Rätselraten beim Adapter.

### 3.1 Drei Korrekturen an den Auftragsannahmen

**(a) Es gibt keinen `/health`-Endpunkt.**
`main.py` definiert nur `GET /` plus die Router. Der Docker-`HEALTHCHECK` prüft
`/docs`, nicht `/health`.

```python
@app.get("/")
async def root():
    return {"message": "Welcome to the Kleinanzeigen API",
            "endpoints": ["/inserate", "/inserat/{id}", "/inserate-detailed"],
            "status": "operational"}
```

→ Der Coolify-Healthcheck muss auf `/` oder `/docs` zeigen. Der Abnahmebefehl
`curl -s https://ka-api.gollenstede.app/health` läuft sonst in einen 404.

**(b) `GET /inserat/{id}` verlangt einen Pflicht-Parameter `batch_id`.**

```python
batch_id: str = Query(..., description="Client-supplied ID to correlate ...")
```

Das `...` macht ihn erforderlich. Der Abnahmebefehl aus Phase 2 ohne `batch_id`
scheitert mit HTTP 422. Korrekt ist:
`GET /inserat/{id}?batch_id=<beliebige-korrelations-id>`

**(c) Kein GPS — aus der Quelle bestätigt.**
Eine Suche über das gesamte Repo nach `latitude|longitude|lat|lon|geo` liefert
keinen einzigen Treffer. `get_location()` gibt ausschließlich zurück:

```python
return {"zip": zip_code, "city": city, "state": state}
```

Die Annahme des Auftrags stimmt also. Die Sonderbehandlung dieser Fahrzeuge in
Phase 6 (separat ausweisen statt still verwerfen) ist zwingend, nicht optional.

### 3.2 Trefferliste — `POST /inserate-by-url`

Antwortrumpf: `success`, `results[]`, `unique_results`, `time_taken`,
`performance_metrics`, `browser_metrics`, `total_results` (nur wenn die
Breadcrumb parsebar war).

Jedes Element in `results[]` (aus `_extract_single_ad`):

| Feld | Herkunft |
|---|---|
| `adid` | Attribut `data-adid` |
| `url` | `https://www.kleinanzeigen.de` + `data-href` |
| `title` | `h2.text-module-begin a.ellipsis` |
| `price` | `p.aditem-main--middle--price-shipping--price` |
| `location` | Freitext aus der Kachel |
| `description` | `p.aditem-main--middle--description` |
| `published_at` | geparst aus `.aditem-main--top--right` |

**Kein Kilometerstand, keine Erstzulassung.** Beide sind nur über den
Detailabruf zu bekommen — die Annahme des Auftrags trägt.

### 3.3 Detailabruf — `GET /inserat/{id}?batch_id=…`

Hülle: `{success, time_taken, data, performance_metrics}`.
`data` enthält: `id`, `scraped_at`, `url_requested`, `url_redirected`,
`categories`, `title`, `status`, `price`, `delivery`, `location`,
`media.images.{count,urls}`, `details`, `features`, `description`, `seller`,
`extra_info.{created_at,views}`.

**`data.details` hat keine im Code festgelegten Schlüssel.** Die Labels werden
zur Laufzeit aus dem DOM gelesen:

```python
label: str = content.replace(value, "").strip()
details[label] = value.strip()
```

Die vom Auftrag erwarteten Bezeichnungen (`Kilometerstand`, `Erstzulassung`,
`Leistung`, `Getriebe`, `Kraftstoffart`, `Fahrzeugtyp`) sind damit **aus dem
Quellcode nicht verifizierbar** — sie stehen so, wie Kleinanzeigen sie rendert.
Die Anweisung „Rate nicht, lies die echte Antwort" bleibt für diesen Punkt
vollständig offen und ist der erste Schritt der nächsten Session.

`features` ist eine **Liste** von Strings (Ausstattung), kein Objekt — trotz
`"features": {}` im Deleted-Response-Stub. Der Adapter muss beides vertragen.

### 3.4 Ratenlimit — vom Upstream bereits eingehalten

`scrapers/inserate_by_url.py` pausiert zwischen Seitenabrufen:

```python
if page_num > 1:
    await asyncio.sleep(2)
```

Die Seiten werden bewusst sequenziell geholt; der Kommentar nennt als Grund, dass
Kleinanzeigen parallele Zugriffe derselben IP blockt. Für den Nachweis der
Ratenlimit-Treue (E5) heißt das: Für Kleinanzeigen ist die Pause im Dienst
verankert und muss dort **nicht** noch einmal implementiert, aber gemessen werden.

---

## 4. Entschiedene Vorab-Variablen

| Variable | Wert |
|---|---|
| `PLUGIN_PFAD` | nur lokal — muss bereitgestellt werden (siehe 2.1) |
| `ADAPTER_PFAD` | nicht vorhanden — Dateien existieren nirgends |
| `COOLIFY_TOKEN` | nicht abgefragt, da Phase 2 ohne Plugin nicht sinnvoll startet |
| `KA_DOMAIN` | `ka-api.gollenstede.app`, Basic Auth am Coolify-Proxy |
| `BRIGHTDATA` | **nein** — L2 bleibt deaktiviert |
| `TESTFAHRZEUG` | noch offen |

### Konsequenz aus „kein Bright Data"

Für AutoScout24 fällt die mittlere Stufe weg. Es bleiben L0 (direkter Abruf) und
L3 (Apify). Ergibt die Messreihe aus Phase 4 Schritt 3, dass Akamai ab Abruf 3–4
blockt, läuft AutoScout24 im Dauerbetrieb **zwingend über L3** — also weiterhin
kostenpflichtig über Apify. Das ist keine Umgehung des Auftragsziels, sondern
seine direkte Folge; die Kette funktioniert, aber die Ersparnis beschränkt sich
dann auf Kleinanzeigen und mobile.de.

Das ist der Punkt, an dem eine Entscheidung ansteht: entweder Bright Data doch
aufsetzen (Free Tier deckt 5.000 Requests/Monat), oder L3-Kosten für AutoScout24
bewusst in Kauf nehmen.

---

## 5. Was ausdrücklich **nicht** getan wurde

- Keine Zeile am Skill geändert — er liegt nicht vor.
- Kein Endpunkt in eine `providers.json` geschrieben. Der mobile.de-BFF wurde
  nicht ermittelt und wird nicht geraten.
- Kein Adapter implementiert. Ein Mapping gegen eine ungesehene Antwort wäre
  genau die Sorte Vermutung, die der Auftrag untersagt.
- Nichts auf Coolify deployt.
- Keine Fixture erzeugt — Fixtures aus erfundenen Daten sind wertlos.

`TESTKONZEPT.md` liegt als vorgezogene Phase 1 bei. Es ist vollständig, wo es
ohne Netz und ohne Plugin vollständig sein kann, und markiert die offenen Stellen
als solche.
