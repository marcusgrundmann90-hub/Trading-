import numpy as np
import pandas as pd

from app.analysis import indicators as ind
from app.analysis import signals as sig


def _frame(closes, volumes=None):
    closes = np.asarray(closes, dtype=float)
    n = len(closes)
    opens = np.concatenate([[closes[0]], closes[:-1]])
    df = pd.DataFrame(
        {"open": opens, "high": np.maximum(opens, closes) * 1.005,
         "low": np.minimum(opens, closes) * 0.995, "close": closes,
         "volume": volumes if volumes is not None else np.full(n, 1000.0)},
        index=pd.date_range("2024-01-01", periods=n, freq="D", tz="UTC"),
    )
    return ind.compute_all(df)


def _golden_cross_series():
    # Long decline, then a strong rally: SMA50 crosses above SMA200 near the end.
    down = np.linspace(200, 100, 230)
    up = np.linspace(100, 190, 60)
    closes = np.concatenate([down, up])
    f = _frame(closes)
    diff = (f["sma50"] - f["sma200"]).to_numpy()
    cross = np.flatnonzero((diff[:-1] <= 0) & (diff[1:] > 0))
    assert len(cross), "constructed series must contain a cross"
    end = cross[-1] + 1 + 3  # three bars after the cross
    return closes[: end + 1]


def test_golden_cross_detected():
    f = _frame(_golden_cross_series())
    s = sig.golden_death_cross(f)
    assert s is not None and s.id == "golden_cross" and s.direction == "bullish"
    assert "vor 3 Tagen" in s.description


def test_death_cross_detected():
    closes = _golden_cross_series()
    f = _frame(closes.max() + closes.min() - closes)  # mirror the series
    s = sig.golden_death_cross(f)
    assert s is not None and s.id == "death_cross" and s.direction == "bearish"


def test_trend_alignment_bullish_and_bearish():
    up = _frame(np.linspace(50, 150, 260))
    s = sig.trend_alignment(up)
    assert s and s.direction == "bullish"
    down = _frame(np.linspace(150, 50, 260))
    s = sig.trend_alignment(down)
    assert s and s.direction == "bearish"


def test_rsi_extremes():
    assert sig.rsi_extreme(_frame(np.linspace(150, 50, 60))).id == "rsi_oversold"
    assert sig.rsi_extreme(_frame(np.linspace(50, 150, 60))).id == "rsi_overbought"


def test_rsi_bullish_reversal():
    closes = np.concatenate([np.linspace(100, 70, 30) + np.tile([0, 1.5], 15), [72, 76, 80]])
    f = _frame(closes)
    s = sig.rsi_reversal(f)
    assert s is not None and s.id == "rsi_bullish_reversal"


def test_breakout_52w_requires_volume():
    rng = np.random.default_rng(3)
    closes = 100 + rng.normal(0, 1, 300).cumsum() * 0.3
    closes[-1] = closes.max() * 1.03
    vol = np.full(300, 1000.0)
    assert sig.breakout_52w(_frame(closes, vol)) is None
    vol[-1] = 5000.0
    s = sig.breakout_52w(_frame(closes, vol))
    assert s is not None and s.id == "breakout_52w"
    vs = sig.volume_spike(_frame(closes, vol))
    assert vs is not None and vs.direction == "bullish"


def test_score_direction_confidence():
    s = [sig.Signal("a", "A", "bullish", 60, ""), sig.Signal("b", "B", "bullish", 60, ""),
         sig.Signal("c", "C", "bearish", 10, "")]
    assert sig.score_signals(s) == 100  # clamped
    assert sig.score_signals(s[2:]) == -10
    assert sig.direction_for(24) == "neutral"
    assert sig.direction_for(25) == "long"
    assert sig.direction_for(-30) == "short"
    assert sig.confidence_for(39) == "low"
    assert sig.confidence_for(-40) == "medium"
    assert sig.confidence_for(70) == "high"


def test_summary_is_german_sentence():
    s = [sig.Signal("golden_cross", "Golden Cross", "bullish", 20, "", "Golden Cross"),
         sig.Signal("breakout_52w", "x", "bullish", 20, "",
                    "Ausbruch über 52-Wochen-Hoch bei hohem Volumen")]
    text = sig.build_summary(s, 40)
    assert text == "Bullisches Setup: Golden Cross und Ausbruch über 52-Wochen-Hoch bei hohem Volumen."
    assert sig.build_summary([], 0).startswith("Kein klares Setup")
