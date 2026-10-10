import json
import math

OPP_KEYS = {"symbol", "name", "asset_class", "price", "change_pct", "score", "direction",
            "confidence", "summary", "signals", "trade_plan", "metrics", "updated_at",
            "data_source"}
PLAN_KEYS = {"side", "entry", "stop_loss", "take_profit_1", "take_profit_2", "risk_reward",
             "risk_per_unit", "position_size", "position_value", "max_loss"}
METRIC_KEYS = {"rsi", "atr", "atr_pct", "volume_ratio", "sma20", "sma50", "sma200",
               "high_52w", "low_52w"}
INDICATOR_KEYS = {"sma20", "sma50", "sma200", "bb_upper", "bb_lower", "rsi", "macd",
                  "macd_signal", "macd_hist"}


def _check_opportunity(o):
    assert set(o) >= OPP_KEYS
    assert isinstance(o["score"], int) and -100 <= o["score"] <= 100
    a = abs(o["score"])
    assert o["direction"] == ("neutral" if a < 25 else ("long" if o["score"] > 0 else "short"))
    assert o["confidence"] == ("low" if a < 40 else "medium" if a < 70 else "high")
    assert isinstance(o["summary"], str) and o["summary"]
    assert set(o["metrics"]) == METRIC_KEYS
    assert o["data_source"] == "demo"
    assert isinstance(o["updated_at"], int)
    for s in o["signals"]:
        assert set(s) == {"id", "name", "direction", "weight", "description"}
        assert s["direction"] in ("bullish", "bearish")
        assert isinstance(s["weight"], int) and s["weight"] > 0
    if o["direction"] == "neutral":
        assert o["trade_plan"] is None
    else:
        p = o["trade_plan"]
        assert set(p) == PLAN_KEYS
        assert p["side"] == o["direction"]
        if p["side"] == "long":
            assert p["stop_loss"] < p["entry"] < p["take_profit_1"] < p["take_profit_2"]
        else:
            assert p["stop_loss"] > p["entry"] > p["take_profit_1"] > p["take_profit_2"]
        assert p["position_value"] <= 10000.01


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "mode": "demo", "version": "0.1.0"}


def test_watchlist_defaults_and_crud(client, demo_env):
    r = client.get("/api/watchlist")
    assert r.status_code == 200
    items = r.json()
    assert {"symbol": "AAPL", "asset_class": "stock", "name": "Apple"} in items
    assert {"symbol": "BTCUSDT", "asset_class": "crypto", "name": "Bitcoin"} in items
    assert len(items) == 12
    assert demo_env.exists()

    r = client.post("/api/watchlist", json={"symbol": "adausdt", "asset_class": "crypto"})
    assert r.status_code == 201
    assert r.json() == {"symbol": "ADAUSDT", "asset_class": "crypto", "name": "ADAUSDT"}
    assert client.post("/api/watchlist", json={"symbol": "ADAUSDT", "asset_class": "crypto"}).status_code == 409
    assert client.post("/api/watchlist", json={"symbol": "X", "asset_class": "bond"}).status_code == 422
    assert any(e["symbol"] == "ADAUSDT" for e in json.loads(demo_env.read_text()))

    assert client.delete("/api/watchlist/adausdt").status_code == 204
    assert client.delete("/api/watchlist/ADAUSDT").status_code == 404
    assert all(e["symbol"] != "ADAUSDT" for e in client.get("/api/watchlist").json())


def test_scan_structure_and_sorting(client):
    r = client.get("/api/scan")
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"generated_at", "opportunities"}
    opps = body["opportunities"]
    assert len(opps) == 12
    for o in opps:
        _check_opportunity(o)
    scores = [abs(o["score"]) for o in opps]
    assert scores == sorted(scores, reverse=True)
    directions = {o["direction"] for o in opps}
    assert directions == {"long", "short", "neutral"}


def test_scan_filter_and_params(client):
    r = client.get("/api/scan", params={"asset_class": "crypto", "account_size": 5000, "risk_pct": 2})
    opps = r.json()["opportunities"]
    assert opps and all(o["asset_class"] == "crypto" for o in opps)
    plans = [o["trade_plan"] for o in opps if o["trade_plan"]]
    for p in plans:
        assert p["max_loss"] <= 100.01
        assert p["position_value"] <= 5000.01
    assert client.get("/api/scan", params={"asset_class": "bond"}).status_code == 422


def test_scan_skips_failing_symbols(client, monkeypatch):
    from app import api

    real = api.analyze

    def flaky(symbol, *a, **kw):
        if symbol == "AAPL":
            raise RuntimeError("boom")
        return real(symbol, *a, **kw)

    monkeypatch.setattr(api, "analyze", flaky)
    opps = client.get("/api/scan").json()["opportunities"]
    assert len(opps) == 11 and all(o["symbol"] != "AAPL" for o in opps)


def test_analysis_structure(client):
    r = client.get("/api/analysis/BTCUSDT", params={"asset_class": "crypto"})
    assert r.status_code == 200
    o = r.json()
    _check_opportunity(o)
    assert o["symbol"] == "BTCUSDT" and o["name"] == "Bitcoin"
    candles = o["candles"]
    assert 200 <= len(candles) <= 365
    assert set(candles[0]) == {"time", "open", "high", "low", "close", "volume"}
    times = [c["time"] for c in candles]
    assert times == sorted(times)
    assert set(o["indicators"]) == INDICATOR_KEYS
    for key, series in o["indicators"].items():
        assert series, key
        for pt in series:
            assert set(pt) == {"time", "value"}
            assert isinstance(pt["value"], float) and math.isfinite(pt["value"])
    assert len(o["indicators"]["sma200"]) == len(candles) - 199


def test_analysis_symbol_not_in_watchlist(client):
    r = client.get("/api/analysis/meta", params={"asset_class": "stock"})
    assert r.status_code == 200
    assert r.json()["symbol"] == "META" and r.json()["name"] == "META"


def test_analysis_invalid_asset_class(client):
    assert client.get("/api/analysis/AAPL", params={"asset_class": "bond"}).status_code == 422


def test_analysis_404_when_no_data(client, monkeypatch):
    from app.data.providers import DataUnavailable, DemoProvider

    def no_data(self, symbol, asset_class="stock"):
        raise DataUnavailable("none")

    monkeypatch.setattr(DemoProvider, "fetch", no_data)
    assert client.get("/api/analysis/ZZZZ", params={"asset_class": "stock"}).status_code == 404
