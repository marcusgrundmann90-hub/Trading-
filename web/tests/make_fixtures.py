"""Generate JS parity fixtures from the Python analysis engine.

Usage (from the repo root):  python web/tests/make_fixtures.py
Writes web/tests/fixtures/parity.json with input candles and the expected Python `analyze` output
(including series) for a handful of cases. The JS tests in web/tests/parity.test.mjs replay the
same candles through web/lib/engine.js and compare.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from app.analysis import engine  # noqa: E402
from app.data.providers import DemoProvider  # noqa: E402

OUT = Path(__file__).resolve().parent / "fixtures" / "parity.json"
# Fixed end date so the fixture file is reproducible (DemoProvider would otherwise end "today").
END = pd.Timestamp("2026-10-09", tz="UTC")
ACCOUNT_SIZE = 10000.0
RISK_PCT = 1.0


class FixedData:
    """Minimal stand-in for MarketData: always returns the given frame."""

    def __init__(self, df: pd.DataFrame, source: str = "demo"):
        self.df, self.source = df, source

    def get(self, symbol, asset_class):
        return self.df, self.source


def _reindex(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df.index = pd.date_range(end=END, periods=len(df), freq="D")
    return df


def demo(symbol: str, asset_class: str, last: int | None = None, scale: float = 1.0) -> pd.DataFrame:
    df = _reindex(DemoProvider().fetch(symbol, asset_class))
    if scale != 1.0:
        for c in ("open", "high", "low", "close"):
            df[c] = df[c] * scale
    if last:
        df = df.iloc[-last:]
    return df


def golden_cross() -> pd.DataFrame:
    """Long decline, then a strong rally; ends 3 bars after SMA50 crosses above SMA200."""
    rng = np.random.default_rng(7)
    down = np.linspace(200, 100, 230)
    up = np.linspace(100, 190, 60)
    closes = np.concatenate([down, up]) * (1 + rng.normal(0, 0.004, 290))
    s50 = pd.Series(closes).rolling(50).mean().to_numpy()
    s200 = pd.Series(closes).rolling(200).mean().to_numpy()
    diff = s50 - s200
    cross = np.flatnonzero((diff[:-1] <= 0) & (diff[1:] > 0))
    end = cross[-1] + 1 + 3
    closes = closes[: end + 1]
    n = len(closes)
    opens = np.concatenate([[closes[0]], closes[:-1]])
    vols = 1000.0 * (1 + rng.random(n))
    df = pd.DataFrame(
        {"open": opens, "high": np.maximum(opens, closes) * 1.006,
         "low": np.minimum(opens, closes) * 0.994, "close": closes, "volume": vols},
        index=pd.date_range(end=END, periods=n, freq="D"),
    )
    return df


CASES = [
    # (symbol, name, asset_class, frame builder)
    ("AAPL", "Apple", "stock", lambda: demo("AAPL", "stock")),
    ("SAP.DE", "SAP", "stock", lambda: demo("SAP.DE", "stock", last=260)),
    ("NVDA", "Nvidia", "stock", lambda: demo("NVDA", "stock", last=250)),
    ("BTCUSDT", "BTC", "crypto", lambda: demo("BTCUSDT", "crypto")),
    ("PEPEUSDT", "PEPE", "crypto", lambda: demo("XRPUSDT", "crypto", scale=2e-5)),
    ("GOLDEN", "Golden Cross (konstruiert)", "stock", golden_cross),
]


def _sig(x: float, digits: int = 7) -> float:
    return float(f"{float(x):.{digits}g}")


def compact(df: pd.DataFrame) -> pd.DataFrame:
    """Round inputs to 7 significant digits (like a snapshot) so the fixture stays small.

    The engine runs on exactly these rounded values, so parity is unaffected.
    """
    df = df.copy()
    for c in ("open", "high", "low", "close"):
        df[c] = [_sig(v) for v in df[c]]
    df["volume"] = [float(round(v)) for v in df["volume"]]
    return df


def candles_of(df: pd.DataFrame) -> list[list]:
    """Compact [t, o, h, l, c, v] rows (same layout as web/data/stocks.json)."""
    return [
        [int(t.timestamp()), float(o), float(h), float(l), float(c), int(v)]
        for t, o, h, l, c, v in zip(df.index, df["open"], df["high"], df["low"], df["close"], df["volume"])
    ]


def sample(points: list[dict], step: int = 9) -> dict:
    """Keep every `step`-th point plus the last three, with their positions, to bound the size."""
    idx = sorted(set(range(0, len(points), step)) | set(range(max(0, len(points) - 3), len(points))))
    return {"count": len(points), "first_time": points[0]["time"] if points else None,
            "points": [[i, points[i]["time"], points[i]["value"]] for i in idx]}


def main() -> None:
    cases = []
    for symbol, name, asset_class, build in CASES:
        df = compact(build())
        res = engine.analyze(symbol, asset_class, name=name, account_size=ACCOUNT_SIZE,
                             risk_pct=RISK_PCT, include_series=True,
                             market_data=FixedData(df))
        res.pop("updated_at")
        expected = {k: v for k, v in res.items() if k != "candles"}  # candles are checked separately
        expected["candles_head"] = res["candles"][:3]
        expected["candles_tail"] = res["candles"][-3:]
        expected["candles_count"] = len(res["candles"])
        expected["indicators"] = {k: sample(v) for k, v in res["indicators"].items()}
        cases.append({
            "symbol": symbol, "name": name, "asset_class": asset_class,
            "account_size": ACCOUNT_SIZE, "risk_pct": RISK_PCT,
            "candles": candles_of(df), "expected": expected,
        })
        print(f"{symbol:10s} {res['direction']:8s} score={res['score']:4d} "
              f"signals={[s['id'] for s in res['signals']]}")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"cases": cases}, separators=(",", ":"), ensure_ascii=False))
    print(f"wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} KiB)")


if __name__ == "__main__":
    main()
