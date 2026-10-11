# Trading Radar – Handy-Version (statische PWA)

Ziel: Die App läuft komplett im Browser (primär Handy), ohne eigenen Server. Gehostet auf GitHub Pages unter
`https://marcusgrundmann90-hub.github.io/Trading-/`. Alle Pfade in der App sind **relativ** (Unterpfad `/Trading-/`).

## Bausteine
| Teil | Pfad | Inhalt |
|---|---|---|
| App (statisch) | `web/` | `index.html`, `styles.css`, `app.js`, `manifest.webmanifest`, `sw.js`, `icons/`, `vendor/` |
| Analyse-Engine (JS) | `web/lib/indicators.js`, `signals.js`, `risk.js`, `engine.js` | 1:1-Port von `backend/app/analysis/*` (gleiche Signale, Gewichte, Schwellen, deutsche Texte) |
| Datenschicht (JS) | `web/lib/data.js`, `web/lib/demo.js` | Binance live, Aktien-Snapshot, Demo-Fallback |
| JS-Tests | `web/tests/*.test.mjs` | `node --test "web/tests/*.test.mjs"` (Node 22, keine npm-Abhängigkeiten) |
| Aktien-Daten-Job | `scripts/fetch_stocks.py`, `web/data/universe.json` | holt Yahoo-Tageskerzen → `web/data/stocks.json` (nur im CI erzeugt, nicht committet) |
| Deployment | `.github/workflows/pages.yml` | Push auf `main`, Zeitplan, manuell → Daten holen → `web/` auf GitHub Pages deployen |

ES-Module, keine Build-Tools, kein npm im Laufzeitcode. Chart-Bibliothek: lightweight-charts 4.2.0 lokal in `web/vendor/` (inkl. LICENSE), damit die App offline/als PWA ohne CDN läuft.

## Datenformate

### `web/data/universe.json` (committet)
```json
{"stocks": [{"symbol": "SAP.DE", "name": "SAP", "region": "DE"}, {"symbol": "AAPL", "name": "Apple", "region": "US"}]}
```
`region`: `"DE" | "EU" | "US"`. Inhalt: DAX 40 komplett, ca. 50 große US-Werte (Mega-Caps + bekannte Tech/Wachstum), ca. 15 große Europa-Werte (ASML, Novo Nordisk, LVMH, Nestlé, …) – Yahoo-Ticker.

### `web/data/stocks.json` (vom CI erzeugt; für lokale Tests via `python scripts/fetch_stocks.py --demo`)
```json
{
  "generated_at": 1760000000,
  "source": "yahoo",                 // "yahoo" | "demo"
  "symbols": {
    "SAP.DE": {"name": "SAP", "region": "DE", "currency": "EUR",
               "candles": [[1760000000, 230.1, 233.0, 229.5, 232.12, 1234567], ...]}  // [t,o,h,l,c,v], ~260 Tageskerzen, aufsteigend
  },
  "errors": ["XYZ"]                  // Symbole, die nicht geladen werden konnten
}
```
Preise auf 4 signifikante Nachkommastellen sinnvoll gerundet, Volumen ganzzahlig, kompakt (ohne Leerzeichen) serialisiert.

## JS-API

### `web/lib/data.js`
```js
export async function loadStocksSnapshot()            // -> {generatedAt, source, symbols, errors}; cached im Speicher; fetch('./data/stocks.json'); bei Fehler {generatedAt:null, source:'unavailable', symbols:{}, errors:[]}
export async function loadUniverse()                  // -> [{symbol, name, region}] aus ./data/universe.json
export async function loadCandles(symbol, assetClass) // -> {candles:[{time,open,high,low,close,volume}], dataSource:'live'|'snapshot'|'demo', updatedAt}
   // crypto: Binance klines 1d limit 365, zuerst https://data-api.binance.vision/api/v3/klines, Fallback https://api.binance.com/api/v3/klines; Cache 5 min im Speicher
   // stock: aus Snapshot; fehlt das Symbol -> Fehler (throw), außer Demo-Modus
   // Demo-Modus (settings.demo === true) oder Netzwerkfehler bei Krypto -> demo.js (deterministische GBM-Daten, Seed aus Symbol), dataSource 'demo'
export async function topCryptoSymbols(n = 25)        // -> [{symbol:'BTCUSDT', name:'BTC'}] nach 24h-Quote-Volumen aus /api/v3/ticker/24hr (nur *USDT, ohne Stablecoins wie USDCUSDT/FDUSDUSDT/TUSDUSDT/USDPUSDT/DAIUSDT/EURUSDT, ohne UP/DOWN/BULL/BEAR-Token); Demo-Fallback: feste Liste
export async function validateCryptoSymbol(symbol)    // -> boolean (klines-Abruf limit=1 erfolgreich)
export function setDemoMode(on)
```

### `web/lib/engine.js`
```js
export function analyze({symbol, name, assetClass, candles, accountSize, riskPct, dataSource, updatedAt, includeSeries = false})
```
Rückgabe: exakt das `Opportunity`-Objekt aus `docs/API.md` (snake_case-Felder: `asset_class`, `change_pct`, `trade_plan`, `data_source`, …); bei `includeSeries` zusätzlich `candles` und `indicators` wie in `/api/analysis`. `data_source` darf hier zusätzlich `"snapshot"` sein. Wirft bei < 60 Kerzen einen Fehler.

## App-Verhalten (mobile first)
- Speicherung nur lokal (`localStorage`, alle Zugriffe in try/catch): Watchlist, Kontogröße, Risiko %, Theme, Demo-Modus, Checklisten-Zustand nicht nötig.
- Standard-Watchlist: AAPL, MSFT, NVDA, SAP.DE, ALV.DE, BTCUSDT, ETHUSDT, SOLUSDT.
- Ansichten (Bottom-Navigation): **Radar** (Watchlist-Scan), **Markt** (Scan über ganzes Universum + Top-Krypto, Top-Chancen zuerst), **Watchlist** (bearbeiten: Aktien per Suche im Universum, Krypto per Binance-Paar mit Validierung), **Einstellungen** (Kontogröße, Risiko, Theme, Demo-Modus, Datenstand der Aktien, Hinweise/Disclaimer).
- Detailansicht als Vollbild-Sheet mit Chart (Kerzen, SMA, Bollinger, Volumen, Trade-Level), RSI, MACD, Trade-Plan, Signale, Kennzahlen, Checkliste vor dem Trade.
- Anzeige des Datenstands: Aktien „Stand: 14:30 Uhr (verzögert)“, Krypto „live“.
- PWA: installierbar (Manifest, Icons 192/512 + maskable + apple-touch-icon), Service Worker cacht App-Shell (cache-first) und `data/stocks.json` (network-first), Binance-Abrufe nicht cachen.
