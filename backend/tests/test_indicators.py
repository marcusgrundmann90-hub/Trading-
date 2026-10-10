import numpy as np
import pandas as pd
import pytest

from app.analysis import indicators as ind


def test_sma_known_values():
    s = pd.Series([1, 2, 3, 4, 5], dtype=float)
    out = ind.sma(s, 3)
    assert out.isna().sum() == 2
    assert list(out.iloc[2:]) == [2.0, 3.0, 4.0]


def test_ema_converges_to_constant():
    s = pd.Series([10.0] * 50)
    assert ind.ema(s, 12).dropna().eq(10.0).all()


def test_rsi_bounds_and_extremes():
    rng = np.random.default_rng(1)
    s = pd.Series(100 + rng.standard_normal(300).cumsum())
    r = ind.rsi(s).dropna()
    assert len(r) == 300 - 14
    assert ((r >= 0) & (r <= 100)).all()
    up = ind.rsi(pd.Series(np.arange(1, 40, dtype=float))).dropna()
    assert (up == 100).all()
    down = ind.rsi(pd.Series(np.arange(40, 1, -1, dtype=float))).dropna()
    assert (down == 0).all()


def test_rsi_wilder_reference():
    # Classic StockCharts RSI example; their sheet shows 70.53/66.32 due to intermediate
    # rounding, an exact Wilder computation yields 70.46/66.25.
    closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89,
              46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64]
    r = ind.rsi(pd.Series(closes))
    assert r.iloc[14] == pytest.approx(70.46, abs=0.01)
    assert r.iloc[15] == pytest.approx(66.25, abs=0.01)


def test_atr_positive_and_constant_range():
    n = 40
    df = pd.DataFrame({"open": [10.0] * n, "high": [11.0] * n, "low": [9.0] * n,
                       "close": [10.0] * n, "volume": [1.0] * n})
    a = ind.atr(df).dropna()
    assert (a > 0).all()
    assert a.iloc[-1] == pytest.approx(2.0)


def test_macd_and_bollinger_shapes():
    s = pd.Series(np.linspace(1, 100, 100))
    m = ind.macd(s)
    assert set(m.columns) == {"macd", "signal", "hist"}
    assert m["macd"].dropna().iloc[-1] > 0  # rising series -> fast EMA above slow
    bb = ind.bollinger(s)
    last = bb.dropna().iloc[-1]
    assert last["lower"] < last["mid"] < last["upper"]


def test_volume_ratio():
    v = pd.Series([100.0] * 20 + [300.0])
    r = ind.volume_ratio(v, 20)
    assert r.iloc[19] == pytest.approx(1.0)
    assert r.iloc[20] == pytest.approx(300 / 110)
