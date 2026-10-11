#!/usr/bin/env python3
"""Fetch daily candles for the stock universe and write web/data/stocks.json.

Standard library only (no pip install needed in CI).

Usage:
    python scripts/fetch_stocks.py              # fetch from Yahoo
    python scripts/fetch_stocks.py --demo       # deterministic synthetic data, no network
    python scripts/fetch_stocks.py --out PATH   # custom output path

Exit code 1 if more than 50% of symbols fail (so CI skips the deploy and the
previously deployed snapshot stays online).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_UNIVERSE = ROOT / "web" / "data" / "universe.json"
DEFAULT_OUT = ROOT / "web" / "data" / "stocks.json"

HOSTS = ("query1.finance.yahoo.com", "query2.finance.yahoo.com")
URL_TEMPLATE = "https://{host}/v8/finance/chart/{symbol}?range=1y&interval=1d"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
TIMEOUT = 15
RETRIES = 2  # retries per host (so up to 3 attempts per host)
BACKOFF = 1.5  # seconds, doubled each retry
REQUEST_DELAY = 0.3
WORKERS = 4
MAX_CANDLES = 260
FAIL_THRESHOLD = 0.5


class FetchError(Exception):
    pass


def round_price(x: float) -> float:
    """Round to 4 significant decimals in a sensible way.

    Large prices keep 2 decimals, small prices keep more (up to 4 significant digits).
    """
    if x == 0 or not math.isfinite(x):
        return 0.0
    ax = abs(x)
    if ax >= 1:
        decimals = 2 if ax >= 10 else 4
    else:
        decimals = min(8, 4 - int(math.floor(math.log10(ax))) - 1)
    return round(x, decimals)


def load_universe(path: Path) -> list[dict]:
    data = json.loads(path.read_text(encoding="utf-8"))
    stocks = data.get("stocks", [])
    seen: set[str] = set()
    out = []
    for s in stocks:
        sym = str(s.get("symbol", "")).strip()
        if not sym or sym in seen:
            continue
        seen.add(sym)
        out.append({"symbol": sym, "name": s.get("name") or sym, "region": s.get("region") or "US"})
    return out


def parse_chart(payload: dict, max_candles: int = MAX_CANDLES) -> tuple[str | None, list[list]]:
    """Parse a Yahoo chart API response into (currency, candles)."""
    chart = payload.get("chart") or {}
    if chart.get("error"):
        err = chart["error"]
        raise FetchError(err.get("description") if isinstance(err, dict) else str(err))
    results = chart.get("result") or []
    if not results:
        raise FetchError("empty result")
    res = results[0]
    meta = res.get("meta") or {}
    currency = meta.get("currency")
    timestamps = res.get("timestamp") or []
    quotes = ((res.get("indicators") or {}).get("quote") or [{}])[0] or {}
    opens = quotes.get("open") or []
    highs = quotes.get("high") or []
    lows = quotes.get("low") or []
    closes = quotes.get("close") or []
    volumes = quotes.get("volume") or []

    candles: list[list] = []
    for i, t in enumerate(timestamps):
        try:
            o, h, l, c = opens[i], highs[i], lows[i], closes[i]
        except IndexError:
            continue
        if t is None or o is None or h is None or l is None or c is None:
            continue
        v = volumes[i] if i < len(volumes) and volumes[i] is not None else 0
        candles.append([int(t), round_price(o), round_price(h), round_price(l), round_price(c), int(v)])

    candles.sort(key=lambda r: r[0])
    # de-duplicate timestamps (Yahoo sometimes repeats the live bar)
    dedup: list[list] = []
    for row in candles:
        if dedup and dedup[-1][0] == row[0]:
            dedup[-1] = row
        else:
            dedup.append(row)
    if not dedup:
        raise FetchError("no valid candles")
    return currency, dedup[-max_candles:]


def http_get_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_symbol(symbol: str) -> tuple[str | None, list[list]]:
    quoted = urllib.parse.quote(symbol, safe="")
    last_err: Exception | None = None
    for host in HOSTS:
        delay = BACKOFF
        for attempt in range(RETRIES + 1):
            try:
                payload = http_get_json(URL_TEMPLATE.format(host=host, symbol=quoted))
                return parse_chart(payload)
            except urllib.error.HTTPError as e:
                last_err = e
                if e.code == 404:
                    # symbol unknown; the other host will say the same
                    raise FetchError(f"HTTP 404 for {symbol}") from e
            except FetchError as e:
                last_err = e
            except (urllib.error.URLError, TimeoutError, OSError, ValueError) as e:
                last_err = e
            if attempt < RETRIES:
                time.sleep(delay)
                delay *= 2
    raise FetchError(f"{symbol}: {last_err}")


def fetch_all(universe: list[dict], workers: int = WORKERS) -> dict:
    symbols: dict[str, dict] = {}
    errors: list[str] = []

    def job(idx_entry):
        idx, entry = idx_entry
        # stagger request starts a little to be polite
        time.sleep(REQUEST_DELAY * (idx % workers))
        try:
            currency, candles = fetch_symbol(entry["symbol"])
            time.sleep(REQUEST_DELAY)
            return entry, currency, candles, None
        except Exception as e:  # noqa: BLE001
            return entry, None, None, e

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for entry, currency, candles, err in pool.map(job, enumerate(universe)):
            sym = entry["symbol"]
            if err is not None:
                print(f"  FAIL {sym}: {err}", file=sys.stderr)
                errors.append(sym)
                continue
            symbols[sym] = {
                "name": entry["name"],
                "region": entry["region"],
                "currency": currency or default_currency(sym, entry["region"]),
                "candles": candles,
            }
    return {"generated_at": int(time.time()), "source": "yahoo", "symbols": symbols, "errors": errors}


def default_currency(symbol: str, region: str) -> str:
    suffix = symbol.rsplit(".", 1)[-1] if "." in symbol else ""
    return {
        "DE": "EUR", "PA": "EUR", "AS": "EUR", "MC": "EUR", "MI": "EUR",
        "L": "GBp", "SW": "CHF", "CO": "DKK", "ST": "SEK", "OL": "NOK",
    }.get(suffix, "EUR" if region == "DE" else "USD")


def demo_candles(symbol: str, n: int = MAX_CANDLES, end_ts: int | None = None) -> list[list]:
    """Deterministic GBM-like daily candles (weekdays only), seeded from the symbol."""
    seed = int(hashlib.sha256(symbol.encode()).hexdigest()[:12], 16)
    rng = random.Random(seed)
    price = 20 + rng.random() * 480
    drift = (rng.random() - 0.4) * 0.0015
    vol = 0.012 + rng.random() * 0.02
    base_vol = int(5e5 + rng.random() * 2e7)

    if end_ts is None:
        end_ts = int(time.time())  # prices depend only on the seed; dates track today
    day = 86400
    t = end_ts - (end_ts % day)
    days: list[int] = []
    while len(days) < n:
        if time.gmtime(t).tm_wday < 5:
            days.append(t)
        t -= day
    days.reverse()

    out: list[list] = []
    for ts in days:
        o = price
        ret = drift + vol * rng.gauss(0, 1)
        c = max(0.5, o * math.exp(ret))
        h = max(o, c) * (1 + abs(rng.gauss(0, vol / 2)))
        l = min(o, c) * (1 - abs(rng.gauss(0, vol / 2)))
        v = int(base_vol * (0.6 + rng.random() * 0.8) * (1 + abs(ret) * 20))
        out.append([ts, round_price(o), round_price(h), round_price(l), round_price(c), v])
        price = c
    return out


def build_demo(universe: list[dict], end_ts: int | None = None) -> dict:
    symbols = {}
    for e in universe:
        symbols[e["symbol"]] = {
            "name": e["name"],
            "region": e["region"],
            "currency": default_currency(e["symbol"], e["region"]),
            "candles": demo_candles(e["symbol"], end_ts=end_ts),
        }
    return {"generated_at": int(time.time()), "source": "demo", "symbols": symbols, "errors": []}


def write_snapshot(data: dict, out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(out.suffix + ".tmp")
    tmp.write_text(json.dumps(data, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    tmp.replace(out)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--demo", action="store_true", help="synthetic deterministic data, no network")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT, help=f"output path (default {DEFAULT_OUT})")
    ap.add_argument("--universe", type=Path, default=DEFAULT_UNIVERSE, help="universe.json path")
    ap.add_argument("--workers", type=int, default=WORKERS)
    args = ap.parse_args(argv)

    universe = load_universe(args.universe)
    if not universe:
        print("universe is empty", file=sys.stderr)
        return 1

    if args.demo:
        data = build_demo(universe)
    else:
        print(f"Fetching {len(universe)} symbols from Yahoo ...")
        data = fetch_all(universe, workers=max(1, args.workers))

    failed = len(data["errors"])
    total = len(universe)
    print(f"ok={len(data['symbols'])} failed={failed} total={total} source={data['source']}")
    if failed / total > FAIL_THRESHOLD:
        print(f"More than {int(FAIL_THRESHOLD * 100)}% of symbols failed; not writing snapshot.", file=sys.stderr)
        return 1
    write_snapshot(data, args.out)
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
