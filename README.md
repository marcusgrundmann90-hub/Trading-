# Trading Radar

Ein Dashboard für Aktien und Krypto. Es scannt deine Watchlist mit technischer Analyse, zeigt die interessantesten Setups (Long/Short) mit Score und Begründung und erstellt zu jedem Setup einen **Trade-Plan mit Risikomanagement**: Stop-Loss, Kursziele und Positionsgröße.

> ⚠️ Keine Anlageberatung. Die Signale basieren auf technischer Analyse und können falsch sein.

## Schnellstart

```bash
./run.sh                          # Live-Daten (Yahoo Finance für Aktien, Binance für Krypto)
TRADING_DATA_MODE=demo ./run.sh   # Offline mit synthetischen Demo-Daten
```
Dann im Browser http://localhost:8000 öffnen. Voraussetzung ist Python 3.11 oder neuer.

## Funktionen
- **Scanner:** analysiert alle Watchlist-Symbole und vergibt einen Score von −100 (bärisch) bis +100 (bullisch).
- **Signale:** Golden/Death Cross, Trend-Ausrichtung, RSI-Extreme und RSI-Umkehr, MACD-Kreuzung, Bollinger-Ausbruch/-Squeeze, 52-Wochen-Ausbruch, Volumenspitzen, Pullback im Aufwärtstrend.
- **Trade-Plan:** Stop bei 2× ATR(14), TP1 = 1R, TP2 = 2R. Die Positionsgröße ergibt sich aus Kontogröße und Risiko pro Trade.
- **Detailansicht:** Candlestick-Chart mit SMA 20/50/200, Bollinger-Bändern, Volumen, RSI und MACD sowie eingezeichneten Entry-, Stop- und Ziel-Linien.
- **Checkliste vor dem Trade:** gegen FOMO-Käufe.
- **Watchlist:** frei bearbeitbar. Aktien als Yahoo-Ticker (`AAPL`, `SAP.DE`), Krypto als Binance-Paar (`BTCUSDT`).

## Aufbau
| Teil | Pfad |
|---|---|
| API-Vertrag | `docs/API.md` |
| Backend (FastAPI) | `backend/app` – `data/` Kursdaten, `analysis/` Indikatoren, Signale, Risiko |
| Frontend (HTML/CSS/JS, kein Build) | `frontend/` |
| Tests | `cd backend && python -m pytest` |

Umgebungsvariablen: `TRADING_DATA_MODE` (live/demo), `TRADING_WATCHLIST_FILE`, `TRADING_CACHE_TTL` (Sekunden).
