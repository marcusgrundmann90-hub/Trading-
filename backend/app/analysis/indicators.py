"""Pure pandas technical indicators."""
from __future__ import annotations

import numpy as np
import pandas as pd


def sma(series: pd.Series, period: int) -> pd.Series:
    return series.rolling(window=period, min_periods=period).mean()


def ema(series: pd.Series, period: int) -> pd.Series:
    return series.ewm(span=period, adjust=False, min_periods=period).mean()


def _wilder(series: pd.Series, period: int) -> pd.Series:
    """Wilder smoothing (RMA), seeded with the simple mean of the first `period` values."""
    values = series.to_numpy(dtype=float)
    out = np.full(len(values), np.nan)
    valid = np.flatnonzero(~np.isnan(values))
    if len(valid) < period:
        return pd.Series(out, index=series.index)
    start = valid[0]
    seed_end = start + period
    if np.isnan(values[start:seed_end]).any():
        return pd.Series(out, index=series.index)
    out[seed_end - 1] = values[start:seed_end].mean()
    for i in range(seed_end, len(values)):
        v = values[i]
        out[i] = out[i - 1] if np.isnan(v) else (out[i - 1] * (period - 1) + v) / period
    return pd.Series(out, index=series.index)


def rsi(close: pd.Series, period: int = 14) -> pd.Series:
    delta = close.diff()
    gain = _wilder(delta.clip(lower=0), period)
    loss = _wilder((-delta).clip(lower=0), period)
    with np.errstate(divide="ignore", invalid="ignore"):
        rs = gain / loss
        out = 100 - 100 / (1 + rs)
    # loss == 0 -> RSI 100 (or 50 if no movement at all)
    out = out.where(loss != 0, np.where(gain > 0, 100.0, 50.0))
    out[gain.isna() | loss.isna()] = np.nan
    return out


def macd(close: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9) -> pd.DataFrame:
    macd_line = ema(close, fast) - ema(close, slow)
    signal_line = macd_line.ewm(span=signal, adjust=False, min_periods=signal).mean()
    return pd.DataFrame(
        {"macd": macd_line, "signal": signal_line, "hist": macd_line - signal_line}
    )


def bollinger(close: pd.Series, period: int = 20, num_std: float = 2.0) -> pd.DataFrame:
    mid = sma(close, period)
    std = close.rolling(window=period, min_periods=period).std(ddof=0)
    upper = mid + num_std * std
    lower = mid - num_std * std
    return pd.DataFrame(
        {"mid": mid, "upper": upper, "lower": lower, "bandwidth": (upper - lower) / mid}
    )


def true_range(df: pd.DataFrame) -> pd.Series:
    prev_close = df["close"].shift(1)
    tr = pd.concat(
        [df["high"] - df["low"], (df["high"] - prev_close).abs(), (df["low"] - prev_close).abs()],
        axis=1,
    ).max(axis=1)
    tr.iloc[0] = df["high"].iloc[0] - df["low"].iloc[0]
    return tr


def atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
    return _wilder(true_range(df), period)


def volume_ratio(volume: pd.Series, period: int = 20) -> pd.Series:
    avg = volume.rolling(window=period, min_periods=period).mean()
    return volume / avg.replace(0, np.nan)


def compute_all(df: pd.DataFrame) -> pd.DataFrame:
    """Return a frame with OHLCV plus all indicator columns used by signals and the engine."""
    out = df.copy()
    close = out["close"]
    out["sma20"] = sma(close, 20)
    out["sma50"] = sma(close, 50)
    out["sma200"] = sma(close, 200)
    out["rsi"] = rsi(close, 14)
    m = macd(close)
    out["macd"], out["macd_signal"], out["macd_hist"] = m["macd"], m["signal"], m["hist"]
    bb = bollinger(close)
    out["bb_mid"], out["bb_upper"], out["bb_lower"] = bb["mid"], bb["upper"], bb["lower"]
    out["bb_bandwidth"] = bb["bandwidth"]
    out["atr"] = atr(out, 14)
    out["volume_ratio"] = volume_ratio(out["volume"], 20)
    return out
