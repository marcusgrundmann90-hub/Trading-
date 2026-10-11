"""Analysis engine: data -> indicators -> signals -> score -> trade plan (Opportunity dict)."""
from __future__ import annotations

import math
import time

import pandas as pd

from ..data.providers import DataUnavailable, MarketData
from . import indicators as ind
from .risk import price_decimals, round_price, trade_plan
from .signals import build_summary, confidence_for, detect_signals, direction_for, score_signals

_market_data: MarketData | None = None


def set_market_data(md: MarketData | None) -> None:
    global _market_data
    _market_data = md


def get_market_data() -> MarketData:
    """Shared MarketData instance; rebuilt when mode/TTL settings change."""
    global _market_data
    from ..config import get_settings

    s = get_settings()
    md = _market_data
    if md is None or md.mode != s.data_mode or md.cache_ttl != s.cache_ttl:
        md = MarketData(mode=s.data_mode, cache_ttl=s.cache_ttl)
        _market_data = md
    return md


def _num(value, decimals: int = 2) -> float | None:
    if value is None:
        return None
    v = float(value)
    if not math.isfinite(v):
        return None
    return round(v, decimals)


def _ts(idx: pd.Timestamp) -> int:
    return int(pd.Timestamp(idx).timestamp())


def _series(s: pd.Series, decimals: int) -> list[dict]:
    s = s.dropna()
    out = []
    for t, v in zip(s.index, s.to_numpy(dtype=float)):
        if math.isfinite(v):
            out.append({"time": _ts(t), "value": round(float(v), decimals)})
    return out


def analyze(
    symbol: str,
    asset_class: str,
    name: str | None = None,
    account_size: float = 10000.0,
    risk_pct: float = 1.0,
    include_series: bool = False,
    market_data: MarketData | None = None,
) -> dict:
    symbol = symbol.upper()
    md = market_data or get_market_data()
    df, source = md.get(symbol, asset_class)
    if df is None or len(df) < 2:
        raise DataUnavailable(f"not enough data for {symbol}")

    f = ind.compute_all(df)
    last = f.iloc[-1]
    prev_close = float(f["close"].iloc[-2])
    price = float(last["close"])
    pd_ = price_decimals(price)

    signals = detect_signals(f)
    score = score_signals(signals)
    direction = direction_for(score)

    atr_v = _num(last["atr"], 12)
    plan = trade_plan(direction, price, atr_v, asset_class, account_size, risk_pct) if atr_v else None

    window = f[f.index > f.index[-1] - pd.Timedelta(days=365)]
    metrics = {
        "rsi": _num(last["rsi"], 1),
        "atr": _num(last["atr"], pd_),
        "atr_pct": _num(last["atr"] / price * 100, 2) if atr_v else None,
        "volume_ratio": _num(last["volume_ratio"], 2),
        "sma20": _num(last["sma20"], pd_),
        "sma50": _num(last["sma50"], pd_),
        "sma200": _num(last["sma200"], pd_),
        "high_52w": _num(window["high"].max(), pd_),
        "low_52w": _num(window["low"].min(), pd_),
    }

    result = {
        "symbol": symbol,
        "name": name or symbol,
        "asset_class": asset_class,
        "price": round_price(price),
        "change_pct": _num((price / prev_close - 1) * 100, 2) if prev_close else 0.0,
        "score": score,
        "direction": direction,
        "confidence": confidence_for(score),
        "summary": build_summary(signals, score),
        "signals": [s.to_dict() for s in signals],
        "trade_plan": plan,
        "metrics": metrics,
        "updated_at": int(time.time()),
        "data_source": source,
    }

    if include_series:
        candles = []
        for t, o, h, l, c, v in zip(
            f.index, f["open"], f["high"], f["low"], f["close"], f["volume"]
        ):
            candles.append({
                "time": _ts(t),
                "open": round(float(o), pd_),
                "high": round(float(h), pd_),
                "low": round(float(l), pd_),
                "close": round(float(c), pd_),
                "volume": round(float(v), 2),
            })
        result["candles"] = candles
        result["indicators"] = {
            "sma20": _series(f["sma20"], pd_),
            "sma50": _series(f["sma50"], pd_),
            "sma200": _series(f["sma200"], pd_),
            "bb_upper": _series(f["bb_upper"], pd_),
            "bb_lower": _series(f["bb_lower"], pd_),
            "rsi": _series(f["rsi"], 2),
            "macd": _series(f["macd"], pd_ + 2),
            "macd_signal": _series(f["macd_signal"], pd_ + 2),
            "macd_hist": _series(f["macd_hist"], pd_ + 2),
        }
    return result
