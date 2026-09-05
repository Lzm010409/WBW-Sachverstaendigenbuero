# Testkonzept — Adapterschicht WBW-Vergleichsfahrzeuge

Stand: 2026-09-05 · **Entwurf, vorgezogene Phase 1**

Dieses Konzept entsteht vor der Implementierung. Es ist dort vollständig, wo es
ohne Netzzugang und ohne den Plugin-Quellcode vollständig sein kann. Zwei Stellen
sind ausdrücklich offen und mit **[OFFEN]** markiert; sie zu schließen ist der
erste Schritt der nächsten Session.

**[OFFEN 1]** Die Kandidatenlisten von `scripts/normalize.js` sind unbekannt — die
Datei lag nicht vor. Abschnitt 6 (Regression Altformat) kann erst danach konkret
werden.
**[OFFEN 2]** Der Testrunner-Bestand des Plugins ist unbekannt. Dieses Konzept
geht von `node --test` aus (Begründung in Abschnitt 1). Bringt das Plugin bereits
vitest oder jest mit, wird darauf aufgebaut statt etwas danebenzustellen.

---

## 1. Testrunner und Aufrufwege

**Empfehlung: `node --test` (Node 22.22 vorhanden, Runner ist eingebaut).**
Begründung: Ein Gutachten-Skill soll ohne `npm install` lauffähig bleiben. Jede
Testabhängigkeit ist eine, die bei einem Node-Update kaputtgehen kann, während
niemand hinschaut. Der eingebaute Runner kann alles, was hier gebraucht wird:
Subtests, `mock.fn`, `assert`, Filterung über Glob-Muster.

Die Trennung nach Kosten und Netzbedarf ist die wichtigste Eigenschaft des
Aufbaus — **`npm test` darf niemals einen kostenpflichtigen Apify-Lauf auslösen:**

| Befehl | Umfang | Netz | Kosten |
|---|---|---|---|
| `npm test` | E1 + E2 + E3 | nein | keine |
| `npm run test:schema` | Schema-Wächter (E2b) | ja | keine |
| `npm run test:live` | E4 je Adapter, nur L0–L2 | ja | keine |
| `npm run test:l3` | L3/Apify, einzeln, explizit | ja | **kostenpflichtig** |
| `npm run test:e2e` | E5 Regression mit TESTFAHRZEUG | ja | ggf. L3 |

Durchgesetzt wird das nicht durch Disziplin, sondern durch eine Sperre: Die
L3-Adapter prüfen beim Laden `process.env.WBW_ALLOW_PAID === "1"` und werfen
sonst sofort. `npm test` setzt die Variable nicht. Ein versehentlicher
Apify-Aufruf im normalen Testlauf schlägt damit fehl, statt Geld zu kosten.

Ein eigener Test prüft genau diese Sperre — sonst ist sie beim nächsten Refactor
still weg.

---

## 2. E1 — Reine Funktionen, offline

Ziel: `bauSuchUrl()`, `bauQuery()`, `mappe()`, `findeListings()`, `findeItems()`,
`zahl()`, `ez()` ohne Netz vollständig abdecken. Diese Tests müssen in unter einer
Sekunde durchlaufen, sonst werden sie nicht ausgeführt.

### `zahl()` — Zahlenparser

Der Parser ist die häufigste stille Fehlerquelle, weil deutsche Portale
Tausenderpunkt und Dezimalkomma verwenden und Fehler nicht auffallen, sondern
plausible falsche Werte erzeugen.

| Eingabe | Erwartung | Warum |
|---|---|---|
| `"12.500 €"` | `12500` | Tausenderpunkt, nicht Dezimaltrenner |
| `"12.500,50 €"` | `12500.5` | Komma ist Dezimaltrenner |
| `"150.000 km"` | `150000` | Einheit muss weg |
| `"110 kW (150 PS)"` | `110` | **kW nehmen, nicht PS** — die 150 wäre plausibel und falsch |
| `"0"` | `0` | Nicht `null`. Ein Neuwagen mit 0 km ist gültig |
| `"VB"` / `"Verhandlungsbasis"` | `null` | Kein Preis, nicht 0 |
| `"Zu verschenken"` | `null` | Kein Preis |
| `"Auf Anfrage"` | `null` | Kein Preis |
| `""` / `null` / `undefined` | `null` | Kein Absturz |
| `1250` (schon Zahl) | `1250` | Idempotent |

Der Fall `0` verdient Nachdruck: Ein Parser, der mit `Number(x) || null` arbeitet,
verwandelt 0 km still in „unbekannt". Bei einem Neufahrzeug im Vergleichsbestand
ist das ein echter Datenverlust.

### `ez()` — Erstzulassung

| Eingabe | Erwartung |
|---|---|
| `"2019"` | Jahr 2019, Monat unbekannt |
| `"03/2019"` | 2019-03 |
| `"2019-03-01"` | 2019-03 |
| `"März 2019"` | 2019-03 |
| `"2019-03-01T00:00:00Z"` | 2019-03 |
| `""` / `null` | `null` |
| `"2049"` | `null` **und Warnung** — implausibel, vermutlich Tippfehler im Inserat |

Die Zukunftsprüfung ist kein Formalismus: Eine EZ im Jahr 2049 im
Vergleichsbestand verschiebt den Altersdurchschnitt und damit den WBW-Vorschlag.

### `bauSuchUrl()` / `bauQuery()`

- Vollständige Eingabe → erwartete URL
- Optionalfelder fehlen (kein Umkreis, keine PLZ) → URL bleibt gültig, Parameter
  entfallen statt als `undefined` zu erscheinen
- Modellnamen mit Sonderzeichen: `"C-Klasse"`, `"3er"`, `"ID.4"`, `"Passat B8"`
  → korrekt kodiert
- Umlaute im Modell → korrekt kodiert, kein Mojibake
- Seitenzahl 1 vs. 2 → Paginierung greift, Seite 1 ohne Seitenparameter
- Leeres Eingabeobjekt → klare Fehlermeldung, kein `"undefined"` in der URL

### `mappe()` / `findeListings()` / `findeItems()`

- Leeres Array → leeres Array, kein Absturz
- Element ohne Preis → Objekt mit `preis: null`, **nicht** übersprungen
  (das Verwerfen ist Aufgabe der Filterkette, nicht des Mappings)
- Verschachtelter Pfad fehlt komplett → `null`, kein `TypeError`
- Unerwarteter Typ (String statt Objekt) → übersprungen, gezählt
- Duplikate über Seitengrenzen → per ID dedupliziert

---

## 3. E2 — Vertragsprüfung gegen echte Antworten

Der wichtigste Teil. Fixtures machen aus einem fragilen Live-Test einen
deterministischen Offline-Test, der beliebig oft läuft.

### 3a. Fixtures

Ablage `tests/fixtures/`, je Portal mindestens:

```
tests/fixtures/
  kleinanzeigen-liste.json      POST /inserate-by-url, max_pages 1
  kleinanzeigen-detail.json     GET /inserat/{id}?batch_id=…
  mobilede-liste.json           BFF-Antwort   [erst nach Phase 3]
  autoscout24-next-data.json    __NEXT_DATA__ [erst nach Phase 4]
```

Jede Fixture bekommt eine Beistelldatei `<name>.meta.json` mit Abrufzeitpunkt,
Quell-URL und der Skill-Version. Ohne dieses Datum weiß in sechs Monaten niemand
mehr, ob eine Fixture noch etwas über die Realität aussagt.

**Anonymisierung** vor dem Commit: Verkäufernamen, Telefonnummern, Adressen,
Nutzer-IDs raus. Fahrzeugdaten bleiben unverändert — sie sind der Prüfgegenstand.

Die Anonymisierung wird selbst getestet. Ein Test scannt alle Fixtures auf
Telefonnummernmuster, `@`-Adressen und die Schlüssel `seller.name`/`user_id`. Eine
von Hand durchgeführte Anonymisierung, die niemand prüft, ist beim dritten Mal
lückenhaft.

### 3b. Schema-Wächter

Ein separater, nicht im Standardlauf enthaltener Test (`npm run test:schema`)
holt eine frische Live-Antwort und vergleicht **die Struktur** mit der Fixture:
Schlüsselmenge, Typen, Verschachtelungstiefe — nicht die Werte, die ändern sich
naturgemäß.

Er schlägt an, wenn ein Portal umbaut. Genau das ist der Zweck: Ein
Strukturwechsel bei mobile.de führt sonst nicht zu einem Fehler, sondern zu einem
Gutachten mit leeren Feldern. Die zweite Variante ist die gefährliche.

Der Wächter meldet in beide Richtungen:
- Feld verschwunden → Mapping läuft ins Leere
- Feld neu hinzugekommen → möglicherweise die bessere Quelle als die bisherige

Empfehlung: monatlich ausführen, mindestens aber vor jedem Gutachten, das
gerichtsfest werden soll.

---

## 4. E3 — Eskalationslogik mit Fehlerinjektion

Der Dispatcher wird gegen erfundene Adapter getestet, nie gegen echte Portale.
Vollständig offline, vollständig deterministisch.

| # | Szenario | Erwartung |
|---|---|---|
| 1 | L0 wirft | L1 übernimmt, Protokoll zeigt **beide** Stufen mit Fehlergrund |
| 2 | L0 liefert `[]` | Nächste Stufe wird versucht — **leer ist kein Erfolg** |
| 3 | L0 liefert Treffer | L1/L2/L3 werden **nicht** aufgerufen (Kosten) |
| 4 | Alle Stufen scheitern | Exit-Code 0, `items: []`, vollständiges Protokoll, kein Absturz |
| 5 | `enabled: false` | Stufe wird übersprungen, im Protokoll als übersprungen vermerkt |
| 6 | L0 antwortet nie | Timeout greift, nächste Stufe startet, kein Hängen |
| 7 | Unbekanntes Portal | Klare Meldung, **Exit-Code 2** |
| 8 | Block fehlt in `search-inputs.json` | Klare Meldung, **Exit-Code 2** |

Szenario 3 bekommt eine harte Zusicherung: Der Mock-Adapter für L3 zählt seine
Aufrufe, der Test verlangt `aufrufe === 0`. Das ist der Test, der verhindert, dass
ein späterer Umbau still Geld kostet.

### Zusätzliche Fälle, die in der Vorgabe fehlen

**9 — L0 liefert Treffer, aber alle Pflichtfelder leer.**
Der realistische Portalumbau sieht nicht so aus, dass nichts kommt. Er sieht so
aus, dass 25 Objekte kommen, in denen `preis`, `kilometerstand` und
`erstzulassung` durchgängig `null` sind. Wertet der Dispatcher das als Erfolg,
bricht er die Kette ab und liefert Datenmüll, ohne dass eine Stufe scheitert.

Regel: Eine Stufe gilt nur als erfolgreich, wenn sie Treffer liefert **und** bei
mindestens der Hälfte davon Preis und Kilometerstand gefüllt sind. Sonst wird
eskaliert und der Grund protokolliert. Die Schwelle liegt bewusst niedriger als
die E4-Schwelle aus Abschnitt 5 — sie soll den Totalausfall abfangen, nicht die
Qualität bewerten.

**10 — Reihenfolge.** Ein Test prüft, dass die Stufen in der Reihenfolge
L0 → L1 → L2 → L3 versucht werden, nicht in Objektschlüssel-Reihenfolge. Sonst
entscheidet die Sortierung in `providers.json` über die Kosten.

**11 — `providers.json` defekt.** Nicht parsebar oder Stufe ohne `endpoint` →
klare Meldung, Exit-Code 2, kein Zugriffsversuch.

**12 — Teilerfolg über Seiten.** Seite 1 kommt, Seite 2 wirft. Erwartung: Die
Treffer von Seite 1 bleiben erhalten, das Protokoll vermerkt die unvollständige
Beschaffung. Ein Gutachten mit 25 statt 50 Fahrzeugen ist brauchbar — es muss nur
dranstehen.

---

## 5. E4 — Live-Integration je Adapter

Ein Lauf pro Portal gegen die echte Quelle. Gemessen wird nicht „kommt etwas an",
sondern Feldvollständigkeit über alle Treffer.

### Schwellen

| Feld | Schwelle | Begründung |
|---|---|---|
| Preis | ≥ 90 % | Ein Inserat ohne Preis ist die Ausnahme („VB", „Auf Anfrage"). Über 10 % Ausfall heißt: der Parser trifft ein Preisformat nicht |
| Kilometerstand | ≥ 90 % | Pflichtangabe bei Fahrzeuginseraten, praktisch immer vorhanden |
| Erstzulassung | ≥ 80 % | Toleranter, weil das Format streut (`2019`, `03/2019`, ausgeschrieben) und Kleinanzeigen es im Freitext führt |

Die Schwellen sind Diagnosewerkzeuge, keine Zielgrößen. Wird eine gerissen, ist
das Mapping kaputt — nicht die Quelle schlecht. **Die Schwelle wird dann nicht
gesenkt.** Genau diese eine Handlung würde den gesamten Aufbau wertlos machen.

### Zusätzlich: Plausibilitätsband

Vollständigkeit allein reicht nicht — ein Feld kann gefüllt und trotzdem falsch
sein. Ein Mapping, das versehentlich auf die Monatsrate statt auf den Kaufpreis
zeigt, liefert 100 % Vollständigkeit und ruiniert den WBW.

Deshalb zusätzlich je Portal:
- Preis zwischen 300 € und 250.000 € — Ausreißer werden gezählt und benannt
- Kilometerstand unter 800.000
- Erstzulassung zwischen 1950 und dem laufenden Jahr
- Median des Preises in derselben Größenordnung wie bei den anderen Portalen

Der letzte Punkt ist der schärfste Test: Liefert ein Portal einen Medianpreis, der
um den Faktor 10 von den anderen abweicht, zeigt sein Mapping auf das falsche
Feld. Das fällt bei keiner Vollständigkeitsmessung auf.

---

## 6. E5 — End-to-End, Regression, nicht-funktionale Prüfungen

### Regressionslauf

Vollständiger Skill-Durchlauf mit dem Testfahrzeug aus einem abgeschlossenen
Gutachten, Vergleich gegen den Apify-Altstand:

| Kriterium | alt (Apify) | neu |
|---|---|---|
| Treffer je Portal | | |
| Treffer nach Filterkette | | |
| Feldvollständigkeit Preis / km / EZ | | |
| WBW-Vorschlag | | |
| Laufzeit gesamt | | |

Der WBW-Vorschlag darf abweichen — anderer Bestand, anderer Zeitpunkt.
Nicht passieren darf: deutlich weniger Treffer nach der Filterkette, oder
systematisch leere Felder. Beides heißt kaputtes Mapping, und die Antwort darauf
sind die Phasen 2–4, nicht weichere Toleranzen.

**Kleinanzeigen ohne GPS** (in Abschnitt 3.3 der Übergabe aus der Quelle belegt):
Diese Fahrzeuge dürfen nicht still aus der Umkreisfilterung fallen. Ein eigener
Test prüft, dass sie im Report separat ausgewiesen werden — nicht, dass sie
irgendwie vorhanden sind, sondern dass sie in der dafür vorgesehenen Rubrik
erscheinen.

### Regression Altformat **[OFFEN 1]**

Die alten Apify-Rohdateien müssen weiterhin fehlerfrei durch `normalize.js`
laufen, nachdem die kanonischen Adapterfelder in die Kandidatenlisten aufgenommen
wurden. Test: alte Rohdatei rein, Feldbelegung vorher/nachher identisch.

Konkretisierbar erst, wenn `normalize.js` und mindestens eine alte Rohdatei
vorliegen.

### Ratenlimit-Treue

Jeder Portalabruf protokolliert einen Zeitstempel. Ein Test rechnet die Abstände
zwischen aufeinanderfolgenden Seitenabrufen nach und verlangt mindestens 1,5 s.

Der Test existiert nicht, weil die Pausen unsicher wären, sondern damit sie
niemand später „wegoptimiert". Ein ausgebauter `sleep` sieht in einem Diff
harmlos aus und macht die Beschaffung unzuverlässig, sobald das Portal reagiert.

Für Kleinanzeigen ist die 2-Sekunden-Pause im Upstream-Dienst verankert
(`asyncio.sleep(2)`) — dort wird gemessen, nicht implementiert.

### Kein Secret-Leck

Geprüft werden `git diff`, alle erzeugten Artefakte **und die Fixtures**.

Erweiterung gegenüber der Vorgabe: Auch das `beschaffungsprotokoll` wird geprüft.
Es wandert in den Report und damit ins Gutachten-PDF. Enthält eine
Endpunkt-URL einen Token als Query-Parameter, steht dieser Token anschließend in
einem Dokument, das das Haus verlässt. Regel: Das Protokoll speichert Host und
Pfad, niemals den Query-String.

Zusätzlich ein Test, der `.env.example` gegen `.env` abgleicht — jede dort
benötigte Variable muss im Beispiel dokumentiert sein, mit Platzhalter statt Wert.

### Idempotenz

Zweimal derselbe Lauf, kurz hintereinander. Erwartung: identische Feldstruktur,
Trefferzahl innerhalb von ±20 %. Größere Abweichung heißt instabile Beschaffung —
und ein Gutachten, dessen Marktstand vom Zufall des Abrufzeitpunkts abhängt, ist
nicht reproduzierbar.

---

## 7. Was dieses Konzept bewusst nicht abdeckt

- **Rechtliche Bewertung** der Beschaffung. Technisches Konzept, keine Prüfung
  von Nutzungsbedingungen.
- **Lasttests.** Der Skill läuft pro Gutachten einmal; Durchsatz ist kein Thema.
- **Der Coolify-Dienst selbst.** Er wird als Blackbox über seine HTTP-Schnittstelle
  getestet. Sein Zugriffsschutz bekommt genau einen Test: Abruf ohne Credentials
  muss scheitern.
