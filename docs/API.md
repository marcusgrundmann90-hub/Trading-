# API-Vertrag (Backend ⇄ Frontend)

Basis: FastAPI unter `http://localhost:8000`. Das Frontend (statische Dateien in `frontend/`) wird vom Backend unter `/` ausgeliefert, alle API-Routen liegen unter `/api`.
Alle Zeitstempel sind Unix-Sekunden (UTC). Alle Preise in der Quotierungswährung des Assets (Aktien: USD/EUR je nach Börse, Krypto: USDT).

## Datenmodus
- `TRADING_DATA_MODE=live` (Default): Aktien via Yahoo Finance Chart-API, Krypto via Binance Public API. Fällt ein Abruf aus, wird für dieses Symbol automatisch auf Demo-Daten zurückgefallen und `data_source: "demo"` gesetzt.
- `TRADING_DATA_MODE=demo`: deterministische synthetische Kursdaten (für Tests/Offline).

## Endpunkte

### `GET /api/health`
`{"status": "ok", "mode": "live" | "demo", "version": "0.1.0"}`

### `GET /api/watchlist`
`[{"symbol": "AAPL", "asset_class": "stock", "name": "Apple"}, {"symbol": "BTCUSDT", "asset_class": "crypto", "name": "Bitcoin"}]`

### `POST /api/watchlist`
Body: `{"symbol": "NVDA", "asset_class": "stock", "name": "Nvidia"}` (`name` optional) → 201 + Eintrag. 409 wenn vorhanden, 422 bei ungültiger asset_class.

### `DELETE /api/watchlist/{symbol}` → 204, 404 wenn unbekannt.

### `GET /api/scan?asset_class=all|stock|crypto&account_size=10000&risk_pct=1`
Analysiert alle Watchlist-Symbole, sortiert absteigend nach `abs(score)`. Antwort: `{"generated_at": int, "opportunities": [Opportunity, ...]}`

### `GET /api/analysis/{symbol}?asset_class=stock|crypto&account_size=10000&risk_pct=1`
Symbol muss nicht in der Watchlist sein. Antwort: `Opportunity` + zusätzliche Felder `candles` und `indicators`. 404 wenn keine Daten.

## Schemas

### Opportunity
```json
{
  "symbol": "AAPL",
  "name": "Apple",
  "asset_class": "stock",
  "price": 189.32,
  "change_pct": 1.24,            // Veränderung zur Vorkerze in %
  "score": 62,                   // -100 (stark bärisch) .. +100 (stark bullisch)
  "direction": "long",           // "long" | "short" | "neutral"  (|score| < 25 => neutral)
  "confidence": "medium",        // "low" (<40) | "medium" (40-69) | "high" (>=70), bezogen auf |score|
  "summary": "Kurzer deutscher Satz, warum das Setup interessant ist.",
  "signals": [
    {"id": "golden_cross", "name": "Golden Cross", "direction": "bullish", "weight": 20,
     "description": "SMA50 hat SMA200 vor 3 Tagen nach oben gekreuzt."}
  ],
  "trade_plan": {                // null wenn direction == "neutral"
    "side": "long",
    "entry": 189.32,
    "stop_loss": 182.10,         // ATR-basiert (2x ATR14)
    "take_profit_1": 196.54,     // 1R
    "take_profit_2": 203.76,     // 2R
    "risk_reward": 2.0,
    "risk_per_unit": 7.22,
    "position_size": 13.85,      // Einheiten = account_size*risk_pct/100 / risk_per_unit (Aktien abgerundet auf ganze Stück)
    "position_value": 2622.08,
    "max_loss": 100.0
  },
  "metrics": {"rsi": 58.3, "atr": 3.61, "atr_pct": 1.9, "volume_ratio": 1.4,
              "sma20": 185.1, "sma50": 180.2, "sma200": 170.4, "high_52w": 199.6, "low_52w": 140.1},
  "updated_at": 1760000000,
  "data_source": "live"          // "live" | "demo"
}
```
Signal-`direction`: `"bullish" | "bearish"`; `weight`: positive Ganzzahl (Beitrag zum Score, Vorzeichen ergibt sich aus direction).

### Zusätzlich bei `/api/analysis`
```json
"candles": [{"time": 1760000000, "open": 1, "high": 2, "low": 0.5, "close": 1.5, "volume": 1000}],
"indicators": {
  "sma20": [{"time": 1760000000, "value": 1.2}], "sma50": [...], "sma200": [...],
  "bb_upper": [...], "bb_lower": [...],
  "rsi": [...], "macd": [...], "macd_signal": [...], "macd_hist": [...]
}
```
Indikator-Reihen enthalten nur Punkte mit gültigem Wert (keine NaN/null). Tageskerzen, ca. 1 Jahr (bis 365 Kerzen).
