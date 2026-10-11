"""Market data providers (Yahoo Finance, Binance, deterministic demo data) and a caching facade."""
from __future__ import annotations

import hashlib
import logging
import threading
import time
from datetime import datetime, timezone
from typing import Callable

import httpx
import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

COLUMNS = ["open", "high", "low", "close", "volume"]
HTTP_TIMEOUT = 10.0
BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)


class DataUnavailable(Exception):
    """Raised when no usable data could be retrieved for a symbol."""


def _finalize(df: pd.DataFrame) -> pd.DataFrame:
    df = df[COLUMNS].astype(float)
    df = df[df["close"].notna()]
    df = df[~df.index.duplicated(keep="last")].sort_index()
    if df.empty:
        raise DataUnavailable("empty data")
    return df


class YahooProvider:
    URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"

    def __init__(self, client_factory: Callable[[], httpx.Client] | None = None):
        self._client_factory = client_factory or (
            lambda: httpx.Client(timeout=HTTP_TIMEOUT, headers={"User-Agent": BROWSER_UA})
        )

    def fetch(self, symbol: str) -> pd.DataFrame:
        with self._client_factory() as client:
            resp = client.get(
                self.URL.format(symbol=symbol), params={"range": "1y", "interval": "1d"}
            )
            resp.raise_for_status()
            payload = resp.json()
        result = (payload.get("chart") or {}).get("result") or []
        if not result:
            raise DataUnavailable(f"no chart result for {symbol}")
        res = result[0]
        timestamps = res.get("timestamp") or []
        quote = ((res.get("indicators") or {}).get("quote") or [{}])[0]
        if not timestamps:
            raise DataUnavailable(f"no timestamps for {symbol}")
        df = pd.DataFrame(
            {c: quote.get(c) or [None] * len(timestamps) for c in COLUMNS},
            index=pd.to_datetime(timestamps, unit="s", utc=True),
        )
        df = df.dropna(subset=["close"])
        df["volume"] = df["volume"].fillna(0)
        for c in ("open", "high", "low"):
            df[c] = df[c].fillna(df["close"])
        return _finalize(df)


class BinanceProvider:
    URL = "https://api.binance.com/api/v3/klines"

    def __init__(self, client_factory: Callable[[], httpx.Client] | None = None):
        self._client_factory = client_factory or (lambda: httpx.Client(timeout=HTTP_TIMEOUT))

    def fetch(self, symbol: str) -> pd.DataFrame:
        with self._client_factory() as client:
            resp = client.get(self.URL, params={"symbol": symbol, "interval": "1d", "limit": 365})
            resp.raise_for_status()
            rows = resp.json()
        if not isinstance(rows, list) or not rows:
            raise DataUnavailable(f"no klines for {symbol}")
        df = pd.DataFrame(
            {
                "open": [float(r[1]) for r in rows],
                "high": [float(r[2]) for r in rows],
                "low": [float(r[3]) for r in rows],
                "close": [float(r[4]) for r in rows],
                "volume": [float(r[5]) for r in rows],
            },
            index=pd.to_datetime([int(r[0]) for r in rows], unit="ms", utc=True),
        )
        return _finalize(df)


# Realistic price anchors for well-known symbols (demo mode only).
_DEMO_ANCHORS = {
    "AAPL": 190.0, "MSFT": 420.0, "NVDA": 120.0, "AMZN": 185.0, "TSLA": 240.0,
    "SAP.DE": 230.0, "ALV.DE": 300.0, "GOOGL": 170.0, "META": 500.0,
    "BTCUSDT": 65000.0, "ETHUSDT": 3200.0, "SOLUSDT": 150.0, "BNBUSDT": 580.0,
    "XRPUSDT": 0.55, "ADAUSDT": 0.45, "DOGEUSDT": 0.12,
}



# Salt for the demo seeds; chosen so the default watchlist shows a varied mix of setups.
DEMO_SALT = "g"


class DemoProvider:
    """Deterministic synthetic OHLCV: seeded geometric Brownian motion with regime changes."""

    N_CANDLES = 365
    SCENARIOS = (
        "breakout", "breakdown", "pullback", "rally",
        "oversold_bounce", "overbought_fade", "squeeze", "random",
    )

    @staticmethod
    def _seed(symbol: str, asset_class: str) -> int:
        digest = hashlib.sha256(f"{DEMO_SALT}|{symbol.upper()}|{asset_class}".encode()).digest()
        return int.from_bytes(digest[:8], "big")

    def fetch(self, symbol: str, asset_class: str = "stock") -> pd.DataFrame:
        symbol = symbol.upper()
        rng = np.random.default_rng(self._seed(symbol, asset_class))
        n = self.N_CANDLES
        crypto = asset_class == "crypto"
        daily_vol = 0.03 if crypto else 0.017
        trend_k = 0.65 if crypto else 1.0  # keep crypto yearly ranges realistic

        # Regimes: piecewise drift/volatility segments (trend up, trend down, sideways).
        drift = np.empty(n)
        vol = np.empty(n)
        i = 0
        while i < n:
            length = int(rng.integers(25, 110))
            kind = rng.choice(["up", "down", "side"], p=[0.4, 0.3, 0.3])
            strength = rng.uniform(0.6, 1.8)
            if kind == "up":
                d = daily_vol * 0.12 * trend_k * strength
            elif kind == "down":
                d = -daily_vol * 0.12 * trend_k * strength
            else:
                d = 0.0
            v = daily_vol * rng.uniform(0.6, 1.4) * (0.6 if kind == "side" else 1.0)
            drift[i:i + length] = d
            vol[i:i + length] = v
            i += length

        shocks = rng.standard_normal(n)
        # Occasional jumps (news days) with heavy volume.
        jumps = rng.random(n) < 0.03
        jump_size = np.where(jumps, rng.normal(0, daily_vol * 3.0, n), 0.0)
        vol_boost = np.ones(n)

        # Shape the most recent bars into a recognisable setup so demo scans are varied.
        scenario = rng.choice(self.SCENARIOS)
        dv = daily_vol
        if scenario in ("breakout", "breakdown"):
            sgn = 1 if scenario == "breakout" else -1
            drift[-120:] = sgn * dv * 0.2 * trend_k
            vol[-120:] = dv * 0.8
            shocks[-25:-2] = np.clip(shocks[-25:-2], -0.8, 0.8)
            shocks[-2:] = 0.0
            jump_size[-25:] = 0.0
            jump_size[-2:] = sgn * dv * np.array([1.6, 2.2])
            vol_boost[-2:] = 3.0
        elif scenario in ("pullback", "rally"):
            sgn = 1 if scenario == "pullback" else -1
            drift[-200:-12] = sgn * dv * 0.18 * trend_k
            vol[-200:] = dv * 0.7
            drift[-12:] = -sgn * dv * 0.45
            shocks[-12:] = np.clip(shocks[-12:], -0.5, 0.5)
            jump_size[-30:] = 0.0
        elif scenario in ("oversold_bounce", "overbought_fade"):
            sgn = 1 if scenario == "oversold_bounce" else -1
            drift[-26:-3] = -sgn * dv * 0.75
            shocks[-26:-3] = np.clip(shocks[-26:-3], -0.7, 0.7)
            shocks[-3:] = 0.0
            jump_size[-26:] = 0.0
            jump_size[-3:] = sgn * dv * np.array([0.6, 1.2, 1.6])
            vol_boost[-3:] = np.array([1.5, 2.0, 3.0])
        elif scenario == "squeeze":
            drift[-45:] = 0.0
            vol[-45:] = dv * 0.3
            jump_size[-45:] = 0.0
        log_ret = drift - 0.5 * vol**2 + vol * shocks + jump_size
        log_ret[0] = 0.0
        path = np.exp(np.cumsum(log_ret))

        anchor = _DEMO_ANCHORS.get(symbol)
        if anchor is None:
            h = self._seed(symbol, "anchor") % 10_000
            anchor = (5 + h % 500) if not crypto else 10 ** (h % 600 / 100 - 2)
        close = anchor * path / path[-1] * rng.uniform(0.9, 1.1)

        gap = rng.normal(0, vol * 0.3, n)
        open_ = np.empty(n)
        open_[0] = close[0] * (1 + gap[0])
        open_[1:] = close[:-1] * (1 + gap[1:])
        wick_hi = np.abs(rng.normal(0, vol * 0.5, n))
        wick_lo = np.abs(rng.normal(0, vol * 0.5, n))
        high = np.maximum(open_, close) * (1 + wick_hi)
        low = np.minimum(open_, close) * (1 - wick_lo)

        base_volume = (2e4 if crypto else 5e6) * (1 + self._seed(symbol, "vol") % 50 / 10)
        abs_move = np.abs(log_ret) / daily_vol
        volume = base_volume * rng.lognormal(0, 0.3, n) * (1 + 0.6 * abs_move) * np.where(jumps, 2.5, 1.0) * vol_boost

        end = pd.Timestamp(datetime.now(timezone.utc).date(), tz="UTC")
        index = pd.date_range(end=end, periods=n, freq="D")
        df = pd.DataFrame(
            {"open": open_, "high": high, "low": low, "close": close, "volume": volume}, index=index
        )
        return _finalize(df)


class MarketData:
    """Picks the provider by asset class and mode, falls back to demo data, caches results."""

    def __init__(
        self,
        mode: str = "live",
        cache_ttl: int = 300,
        stock_provider=None,
        crypto_provider=None,
        demo_provider: DemoProvider | None = None,
    ):
        self.mode = mode
        self.cache_ttl = cache_ttl
        self.stock_provider = stock_provider or YahooProvider()
        self.crypto_provider = crypto_provider or BinanceProvider()
        self.demo_provider = demo_provider or DemoProvider()
        self._cache: dict[tuple[str, str], tuple[float, pd.DataFrame, str]] = {}
        self._lock = threading.Lock()

    def get(self, symbol: str, asset_class: str) -> tuple[pd.DataFrame, str]:
        """Return (ohlcv DataFrame, data_source) where data_source is 'live' or 'demo'."""
        symbol = symbol.upper()
        key = (symbol, asset_class)
        now = time.monotonic()
        with self._lock:
            hit = self._cache.get(key)
            if hit and now - hit[0] < self.cache_ttl:
                return hit[1], hit[2]

        df, source = None, "demo"
        if self.mode == "live":
            provider = self.crypto_provider if asset_class == "crypto" else self.stock_provider
            try:
                df = provider.fetch(symbol)
                source = "live"
            except Exception as exc:  # noqa: BLE001 - any failure falls back to demo data
                logger.warning("Live data for %s failed (%s), falling back to demo", symbol, exc)
                df = None
        if df is None:
            df = self.demo_provider.fetch(symbol, asset_class)
            source = "demo"

        with self._lock:
            self._cache[key] = (now, df, source)
        return df, source

    def clear(self) -> None:
        with self._lock:
            self._cache.clear()
