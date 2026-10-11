# Trading Radar

Ein Dashboard für Aktien und Krypto – als **Handy-App** (statische PWA auf GitHub Pages) und als **PC-Version** (Python-Server). Es scannt deine Watchlist mit technischer Analyse, zeigt die interessantesten Setups (Long/Short) mit Score und Begründung und erstellt zu jedem Setup einen **Trade-Plan mit Risikomanagement**: Stop-Loss, Kursziele und Positionsgröße.

> ⚠️ Keine Anlageberatung. Die Signale basieren auf technischer Analyse und können falsch sein.

## Handy-App (GitHub Pages)

Die Handy-Version läuft komplett im Browser – ohne eigenen Server. Adresse:
**https://marcusgrundmann90-hub.github.io/Trading-/**

### Einmalige Einrichtung
1. Repository auf **öffentlich** stellen (GitHub Pages ist für private Repos nur mit bezahltem Plan verfügbar): *Settings → General → Danger Zone → Change visibility*.
2. *Settings → Pages → Build and deployment → Source:* **„GitHub Actions“** auswählen.
3. Den Branch nach `main` mergen. Der Workflow `.github/workflows/pages.yml` startet automatisch (Fortschritt unter *Actions*); nach ein bis zwei Minuten ist die Seite online. Manuell starten geht über *Actions → Handy-App (GitHub Pages) → Run workflow*.
4. Die Adresse auf dem Handy öffnen und zum Startbildschirm hinzufügen:
   - **iPhone (Safari):** Teilen-Symbol → **„Zum Home-Bildschirm“**
   - **Android (Chrome):** Menü ⋮ → **„Zum Startbildschirm hinzufügen“** bzw. „App installieren“

   Danach startet die App wie eine normale App im Vollbild.

### Aktien zum Universum hinzufügen
Die Liste der Aktien, die im CI abgerufen werden, steht in `web/data/universe.json` (DAX 40, große US- und Europa-Werte). Neue Aktie aufnehmen:
1. Auf GitHub die Datei `web/data/universe.json` öffnen und auf den Stift (Bearbeiten) tippen – das geht auch in der **GitHub-App auf dem Handy**.
2. Einen Eintrag ergänzen, z. B. `{"symbol": "PUM.DE", "name": "Puma", "region": "DE"}`.
   - `symbol` ist der **Yahoo-Finance-Ticker** (deutsche Werte mit `.DE`, Paris `.PA`, Amsterdam `.AS`, Schweiz `.SW`, London `.L`, US-Werte ohne Endung).
   - `region`: `"DE"`, `"EU"` oder `"US"`.
3. Auf `main` committen. Der Workflow läuft sofort und lädt die neuen Daten; danach ist die Aktie in der App suchbar und kann in die Watchlist.

Krypto braucht keinen Eintrag: Jedes Binance-USDT-Paar (z. B. `SOLUSDT`) kann direkt in der App zur Watchlist hinzugefügt werden.

### Datenstand
- **Aktien:** Tageskerzen von Yahoo Finance, abgerufen vom GitHub-Workflow – werktags etwa **alle 30 Minuten zwischen 08:00 und 23:59 Uhr (MESZ)**, am Wochenende einmal täglich. Die Kurse sind also **bis ca. 30 Minuten (plus Yahoo-Verzögerung) verzögert**; die App zeigt den Stand an („Stand: 14:30 Uhr (verzögert)“). GitHub führt Zeitpläne bei hoher Last manchmal etwas später aus.
- **Krypto:** **live** direkt von Binance aus dem Browser.
- Schlägt der Datenabruf größtenteils fehl, wird nicht neu veröffentlicht – die zuletzt veröffentlichte Version bleibt online.
- Hinweis: Bei öffentlichen Repos pausiert GitHub zeitgesteuerte Workflows nach 60 Tagen ohne Commits. Dann einfach unter *Actions* den Workflow wieder aktivieren oder einen Commit machen.

Lokal testen (ohne Netz):
```bash
python scripts/fetch_stocks.py --demo        # erzeugt web/data/stocks.json mit Demo-Daten
python -m http.server -d web 8080            # dann http://localhost:8080 öffnen
python -m unittest discover -s scripts/tests # Tests des Daten-Jobs
node --test "web/tests/*.test.mjs"           # Tests der Analyse-Engine (Node 22)
```

## PC-Version (Python-Server)

Die ursprüngliche Desktop-Version mit FastAPI-Backend – Live-Daten für beliebige Ticker, läuft lokal auf dem Rechner.

### Schnellstart

```bash
./run.sh                          # Live-Daten (Yahoo Finance für Aktien, Binance für Krypto)
TRADING_DATA_MODE=demo ./run.sh   # Offline mit synthetischen Demo-Daten
```
Dann im Browser http://localhost:8000 öffnen. Voraussetzung ist Python 3.11 oder neuer.

### Funktionen
- **Scanner:** analysiert alle Watchlist-Symbole und vergibt einen Score von −100 (bärisch) bis +100 (bullisch).
- **Signale:** Golden/Death Cross, Trend-Ausrichtung, RSI-Extreme und RSI-Umkehr, MACD-Kreuzung, Bollinger-Ausbruch/-Squeeze, 52-Wochen-Ausbruch, Volumenspitzen, Pullback im Aufwärtstrend.
- **Trade-Plan:** Stop bei 2× ATR(14), TP1 = 1R, TP2 = 2R. Die Positionsgröße ergibt sich aus Kontogröße und Risiko pro Trade.
- **Detailansicht:** Candlestick-Chart mit SMA 20/50/200, Bollinger-Bändern, Volumen, RSI und MACD sowie eingezeichneten Entry-, Stop- und Ziel-Linien.
- **Checkliste vor dem Trade:** gegen FOMO-Käufe.
- **Watchlist:** frei bearbeitbar. Aktien als Yahoo-Ticker (`AAPL`, `SAP.DE`), Krypto als Binance-Paar (`BTCUSDT`).

### Aufbau
| Teil | Pfad |
|---|---|
| API-Vertrag | `docs/API.md` |
| Backend (FastAPI) | `backend/app` – `data/` Kursdaten, `analysis/` Indikatoren, Signale, Risiko |
| Frontend (HTML/CSS/JS, kein Build) | `frontend/` |
| Tests | `cd backend && python -m pytest` |
| Handy-App (statisch) | `web/` – siehe `docs/WEB.md` |
| Aktien-Daten-Job | `scripts/fetch_stocks.py`, `web/data/universe.json` |
| Deployment | `.github/workflows/pages.yml` |

Umgebungsvariablen: `TRADING_DATA_MODE` (live/demo), `TRADING_WATCHLIST_FILE`, `TRADING_CACHE_TTL` (Sekunden).
