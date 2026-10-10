"""Signal detectors. Each detector receives the indicator frame and returns a Signal or None."""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass
from typing import Callable

import pandas as pd

BULLISH = "bullish"
BEARISH = "bearish"


@dataclass
class Signal:
    id: str
    name: str
    direction: str  # "bullish" | "bearish"
    weight: int
    description: str
    phrase: str = ""  # short German phrase for the summary (not part of the API output)

    def to_dict(self) -> dict:
        d = asdict(self)
        d.pop("phrase")
        return d


def _ok(*values) -> bool:
    return all(v is not None and not (isinstance(v, float) and math.isnan(v)) for v in values)


def _days(n: int) -> str:
    if n == 0:
        return "heute"
    if n == 1:
        return "gestern"
    return f"vor {n} Tagen"


def _last_cross(a: pd.Series, b: pd.Series, lookback: int) -> tuple[int, int] | None:
    """Find the most recent cross of a over/under b within the last `lookback` bars.

    Returns (bars_ago, sign) with sign +1 for a crossing above b, -1 for crossing below.
    """
    diff = (a - b).to_numpy()
    n = len(diff)
    for ago in range(0, min(lookback, n - 1)):
        i = n - 1 - ago
        cur, prev = diff[i], diff[i - 1]
        if math.isnan(cur) or math.isnan(prev):
            return None
        if prev <= 0 < cur:
            return ago, 1
        if prev >= 0 > cur:
            return ago, -1
    return None


def golden_death_cross(f: pd.DataFrame) -> Signal | None:
    cross = _last_cross(f["sma50"], f["sma200"], 10)
    if not cross:
        return None
    ago, sign = cross
    if sign > 0:
        return Signal("golden_cross", "Golden Cross", BULLISH, 20,
                      f"SMA50 hat SMA200 {_days(ago)} nach oben gekreuzt.", "Golden Cross")
    return Signal("death_cross", "Death Cross", BEARISH, 20,
                  f"SMA50 hat SMA200 {_days(ago)} nach unten gekreuzt.", "Death Cross")


def trend_alignment(f: pd.DataFrame) -> Signal | None:
    last = f.iloc[-1]
    c, s20, s50, s200 = last["close"], last["sma20"], last["sma50"], last["sma200"]
    if not _ok(c, s20, s50, s200):
        return None
    if c > s20 > s50 > s200:
        return Signal("trend_alignment", "Intakter Aufwärtstrend", BULLISH, 15,
                      "Kurs über SMA20 über SMA50 über SMA200 – alle Trends zeigen nach oben.",
                      "intakter Aufwärtstrend")
    if c < s20 < s50 < s200:
        return Signal("trend_alignment", "Intakter Abwärtstrend", BEARISH, 15,
                      "Kurs unter SMA20 unter SMA50 unter SMA200 – alle Trends zeigen nach unten.",
                      "intakter Abwärtstrend")
    return None


def rsi_extreme(f: pd.DataFrame) -> Signal | None:
    r = f["rsi"].iloc[-1]
    if not _ok(r):
        return None
    if r < 30:
        return Signal("rsi_oversold", "RSI überverkauft", BULLISH, 8,
                      f"RSI(14) steht bei {r:.1f} und signalisiert eine überverkaufte Lage.",
                      "überverkaufter RSI")
    if r > 70:
        return Signal("rsi_overbought", "RSI überkauft", BEARISH, 8,
                      f"RSI(14) steht bei {r:.1f} und signalisiert eine überkaufte Lage.",
                      "überkaufter RSI")
    return None


def rsi_reversal(f: pd.DataFrame) -> Signal | None:
    r = f["rsi"]
    up = _last_cross(r, pd.Series(30.0, index=r.index), 3)
    if up and up[1] > 0:
        return Signal("rsi_bullish_reversal", "RSI-Umkehr bullisch", BULLISH, 15,
                      f"RSI hat die 30er-Marke {_days(up[0])} von unten zurückerobert.",
                      "RSI-Umkehr aus dem überverkauften Bereich")
    down = _last_cross(r, pd.Series(70.0, index=r.index), 3)
    if down and down[1] < 0:
        return Signal("rsi_bearish_reversal", "RSI-Umkehr bärisch", BEARISH, 15,
                      f"RSI ist {_days(down[0])} von oben unter die 70er-Marke gefallen.",
                      "RSI-Umkehr aus dem überkauften Bereich")
    return None


def macd_cross(f: pd.DataFrame) -> Signal | None:
    cross = _last_cross(f["macd"], f["macd_signal"], 3)
    if not cross:
        return None
    ago, sign = cross
    if sign > 0:
        return Signal("macd_cross", "MACD-Kaufsignal", BULLISH, 12,
                      f"MACD hat die Signallinie {_days(ago)} nach oben gekreuzt.",
                      "MACD-Kaufsignal")
    return Signal("macd_cross", "MACD-Verkaufssignal", BEARISH, 12,
                  f"MACD hat die Signallinie {_days(ago)} nach unten gekreuzt.",
                  "MACD-Verkaufssignal")


def bollinger_breakout(f: pd.DataFrame) -> Signal | None:
    last = f.iloc[-1]
    c, up, lo = last["close"], last["bb_upper"], last["bb_lower"]
    if not _ok(c, up, lo):
        return None
    if c > up:
        return Signal("bollinger_breakout", "Bollinger-Ausbruch nach oben", BULLISH, 10,
                      "Schlusskurs liegt über dem oberen Bollinger-Band (20, 2).",
                      "Ausbruch über das obere Bollinger-Band")
    if c < lo:
        return Signal("bollinger_breakout", "Bollinger-Ausbruch nach unten", BEARISH, 10,
                      "Schlusskurs liegt unter dem unteren Bollinger-Band (20, 2).",
                      "Bruch des unteren Bollinger-Bands")
    return None


def bollinger_squeeze(f: pd.DataFrame) -> Signal | None:
    bw = f["bb_bandwidth"].dropna()
    if len(bw) < 60:
        return None
    window = bw.iloc[-126:]
    cur = bw.iloc[-1]
    if cur > window.min() * 1.05:
        return None
    last = f.iloc[-1]
    ref = last["sma50"] if _ok(last["sma50"]) else last["bb_mid"]
    bullish = last["close"] >= ref
    where = "über" if bullish else "unter"
    return Signal("bollinger_squeeze", "Bollinger Squeeze", BULLISH if bullish else BEARISH, 8,
                  f"Bollinger-Bandbreite auf 6-Monats-Tief ({cur * 100:.1f} %) – Kurs {where} SMA50, "
                  "eine starke Bewegung kündigt sich an.",
                  "Bollinger Squeeze")


def _52w_window(f: pd.DataFrame) -> pd.DataFrame:
    start = f.index[-1] - pd.Timedelta(days=365)
    return f[f.index > start]


def breakout_52w(f: pd.DataFrame) -> Signal | None:
    w = _52w_window(f)
    if len(w) < 30:
        return None
    last = w.iloc[-1]
    prior = w.iloc[:-1]
    vr = last["volume_ratio"]
    if not _ok(vr) or vr <= 1.5:
        return None
    hi, lo = prior["high"].max(), prior["low"].min()
    c = last["close"]
    if c >= hi * 0.98:
        txt = "über" if c > hi else "nahe"
        return Signal("breakout_52w", "52-Wochen-Hoch-Ausbruch", BULLISH, 20,
                      f"Kurs schließt {txt} dem 52-Wochen-Hoch ({hi:.2f}) bei {vr:.1f}-fachem Volumen.",
                      "Ausbruch über 52-Wochen-Hoch bei hohem Volumen")
    if c <= lo * 1.02:
        txt = "unter" if c < lo else "nahe"
        return Signal("breakdown_52w", "52-Wochen-Tief-Bruch", BEARISH, 20,
                      f"Kurs schließt {txt} dem 52-Wochen-Tief ({lo:.2f}) bei {vr:.1f}-fachem Volumen.",
                      "Bruch des 52-Wochen-Tiefs bei hohem Volumen")
    return None


def volume_spike(f: pd.DataFrame) -> Signal | None:
    last = f.iloc[-1]
    vr = last["volume_ratio"]
    if not _ok(vr) or vr <= 2 or last["close"] == last["open"]:
        return None
    if last["close"] > last["open"]:
        return Signal("volume_spike", "Volumenspitze (Kaufdruck)", BULLISH, 10,
                      f"Volumen {vr:.1f}-fach über dem 20-Tage-Schnitt bei steigender Kerze.",
                      "Volumenspitze mit Kaufdruck")
    return Signal("volume_spike", "Volumenspitze (Verkaufsdruck)", BEARISH, 10,
                  f"Volumen {vr:.1f}-fach über dem 20-Tage-Schnitt bei fallender Kerze.",
                  "Volumenspitze mit Verkaufsdruck")


def pullback(f: pd.DataFrame) -> Signal | None:
    last = f.iloc[-1]
    c, lo, hi = last["close"], last["low"], last["high"]
    s20, s50, s200, r = last["sma20"], last["sma50"], last["sma200"], last["rsi"]
    if not _ok(c, s20, s50, s200, r):
        return None
    if s50 > s200 and c > s200 and 40 <= r <= 50:
        touched = [n for n, s in (("SMA20", s20), ("SMA50", s50)) if lo <= s * 1.01 and c >= s * 0.99]
        if touched:
            return Signal("pullback_in_uptrend", "Rücksetzer im Aufwärtstrend", BULLISH, 20,
                          f"Kurs testet im Aufwärtstrend die {touched[0]}, RSI bei {r:.1f} – "
                          "klassische Einstiegszone.",
                          f"Rücksetzer an die {touched[0]} im Aufwärtstrend")
    if s50 < s200 and c < s200 and 50 <= r <= 60:
        touched = [n for n, s in (("SMA20", s20), ("SMA50", s50)) if hi >= s * 0.99 and c <= s * 1.01]
        if touched:
            return Signal("rally_in_downtrend", "Erholung im Abwärtstrend", BEARISH, 20,
                          f"Kurs läuft im Abwärtstrend an die {touched[0]}, RSI bei {r:.1f} – "
                          "mögliche Short-Zone.",
                          f"Erholung an die {touched[0]} im Abwärtstrend")
    return None


DETECTORS: list[Callable[[pd.DataFrame], Signal | None]] = [
    golden_death_cross,
    trend_alignment,
    rsi_extreme,
    rsi_reversal,
    macd_cross,
    bollinger_breakout,
    bollinger_squeeze,
    breakout_52w,
    volume_spike,
    pullback,
]


def detect_signals(frame: pd.DataFrame) -> list[Signal]:
    signals = []
    for det in DETECTORS:
        try:
            s = det(frame)
        except Exception:  # noqa: BLE001 - a broken detector must not kill the analysis
            s = None
        if s is not None:
            signals.append(s)
    signals.sort(key=lambda s: s.weight, reverse=True)
    return signals


def score_signals(signals: list[Signal]) -> int:
    total = sum(s.weight if s.direction == BULLISH else -s.weight for s in signals)
    return int(max(-100, min(100, total)))


def direction_for(score: int) -> str:
    if abs(score) < 25:
        return "neutral"
    return "long" if score > 0 else "short"


def confidence_for(score: int) -> str:
    a = abs(score)
    if a >= 70:
        return "high"
    if a >= 40:
        return "medium"
    return "low"


def _join(parts: list[str]) -> str:
    if len(parts) == 1:
        return parts[0]
    return ", ".join(parts[:-1]) + " und " + parts[-1]


def build_summary(signals: list[Signal], score: int) -> str:
    if not signals:
        return "Kein klares Setup: aktuell liegen keine nennenswerten technischen Signale vor."
    direction = direction_for(score)
    if direction == "neutral":
        bull = [s for s in signals if s.direction == BULLISH]
        bear = [s for s in signals if s.direction == BEARISH]
        if bull and bear:
            return (f"Gemischtes Bild: {bull[0].phrase} steht {bear[0].phrase} gegenüber – "
                    "abwarten, bis sich eine Richtung durchsetzt.")
        only = signals[0]
        return f"Noch kein klares Setup: {only.phrase}, aber zu wenig Bestätigung für einen Trade."
    wanted = BULLISH if direction == "long" else BEARISH
    top = [s.phrase for s in signals if s.direction == wanted][:3]
    phrases = [top[0][0].upper() + top[0][1:]] + top[1:]
    prefix = "Bullisches Setup" if direction == "long" else "Bärisches Setup"
    return f"{prefix}: {_join(phrases)}."
