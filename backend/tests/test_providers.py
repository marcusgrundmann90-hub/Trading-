import httpx
import pandas as pd
import pytest

from app.analysis.engine import analyze
from app.data.providers import BinanceProvider, DemoProvider, MarketData, YahooProvider


class FailingProvider:
    calls = 0

    def fetch(self, symbol):
        FailingProvider.calls += 1
        raise httpx.ConnectError("blocked")


def test_demo_provider_deterministic_and_shape():
    a = DemoProvider().fetch("BTCUSDT", "crypto")
    b = DemoProvider().fetch("BTCUSDT", "crypto")
    assert len(a) == 365
    assert list(a.columns) == ["open", "high", "low", "close", "volume"]
    pd.testing.assert_frame_equal(a, b)
    assert (a["high"] >= a[["open", "close"]].max(axis=1)).all()
    assert (a["low"] <= a[["open", "close"]].min(axis=1)).all()
    assert (a["close"] > 0).all()
    assert a.index[-1].date() == pd.Timestamp.now(tz="UTC").date()
    assert 20000 < a["close"].iloc[-1] < 200000  # realistic BTC level
    other = DemoProvider().fetch("ETHUSDT", "crypto")
    assert not other["close"].equals(a["close"])


def test_fallback_to_demo_on_live_failure():
    FailingProvider.calls = 0
    md = MarketData(mode="live", stock_provider=FailingProvider(), crypto_provider=FailingProvider())
    df, source = md.get("AAPL", "stock")
    assert source == "demo" and len(df) == 365
    # cached: provider not called again
    md.get("AAPL", "stock")
    assert FailingProvider.calls == 1
    opp = analyze("ETHUSDT", "crypto", "Ethereum", market_data=md)
    assert opp["data_source"] == "demo"


def test_live_provider_used_when_ok():
    class OkProvider:
        def fetch(self, symbol):
            return DemoProvider().fetch(symbol, "stock")

    md = MarketData(mode="live", stock_provider=OkProvider(), crypto_provider=FailingProvider())
    assert md.get("MSFT", "stock")[1] == "live"


def _mock_client(handler):
    return lambda: httpx.Client(transport=httpx.MockTransport(handler))


def test_yahoo_parsing_drops_null_closes():
    payload = {"chart": {"result": [{
        "timestamp": [1700000000, 1700086400, 1700172800],
        "indicators": {"quote": [{
            "open": [1.0, 2.0, 3.0], "high": [1.5, 2.5, 3.5], "low": [0.5, 1.5, 2.5],
            "close": [1.2, None, 3.2], "volume": [100, 200, None]}]},
    }]}}

    def handler(request):
        assert "/v8/finance/chart/AAPL" in request.url.path
        assert request.url.params["range"] == "1y"
        return httpx.Response(200, json=payload)

    df = YahooProvider(client_factory=_mock_client(handler)).fetch("AAPL")
    assert len(df) == 2
    assert df["close"].tolist() == [1.2, 3.2]
    assert df["volume"].tolist() == [100.0, 0.0]


def test_binance_parsing():
    rows = [[1700000000000, "1.0", "2.0", "0.5", "1.5", "10", 0, "0", 0, "0", "0", "0"],
            [1700086400000, "1.5", "2.5", "1.0", "2.0", "20", 0, "0", 0, "0", "0", "0"]]

    def handler(request):
        assert request.url.params["symbol"] == "BTCUSDT"
        assert request.url.params["interval"] == "1d"
        return httpx.Response(200, json=rows)

    df = BinanceProvider(client_factory=_mock_client(handler)).fetch("BTCUSDT")
    assert df["close"].tolist() == [1.5, 2.0]
    assert df.index[0] == pd.Timestamp(1700000000, unit="s", tz="UTC")


def test_http_error_raises():
    def handler(request):
        return httpx.Response(500)

    with pytest.raises(httpx.HTTPStatusError):
        BinanceProvider(client_factory=_mock_client(handler)).fetch("BTCUSDT")
