"""Stage 4: price check via the Yahoo Finance chart API."""
from __future__ import annotations

import logging
from urllib.parse import quote

import httpx

from . import config

log = logging.getLogger(__name__)

CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"


def compute_changes(payload: dict) -> tuple[float | None, float | None]:
    """(change vs previous close %, change over 5 days %) from a chart payload."""
    try:
        result = payload["chart"]["result"][0]
    except (KeyError, IndexError, TypeError):
        return None, None
    meta = result.get("meta") or {}
    try:
        closes = result["indicators"]["quote"][0]["close"]
    except (KeyError, IndexError, TypeError):
        closes = []
    closes = [c for c in (closes or []) if isinstance(c, (int, float)) and c > 0]
    price = meta.get("regularMarketPrice")
    if not isinstance(price, (int, float)) or price <= 0:
        price = closes[-1] if closes else None
    if price is None:
        return None, None

    prev = closes[-2] if len(closes) >= 2 else meta.get("previousClose")
    base5 = meta.get("chartPreviousClose") or (closes[0] if closes else None)

    def pct(base) -> float | None:
        if not isinstance(base, (int, float)) or base <= 0:
            return None
        return round((price / base - 1.0) * 100.0, 2)

    return pct(prev), pct(base5)


def fetch_changes(ticker: str, client: httpx.Client | None = None) -> tuple[float | None, float | None]:
    own = client is None
    client = client or httpx.Client(timeout=config.FEED_TIMEOUT_S, headers={"User-Agent": config.BROWSER_UA},
                                    follow_redirects=True)
    try:
        resp = client.get(CHART_URL.format(ticker=quote(ticker, safe="")),
                          params={"range": "5d", "interval": "1d"})
        resp.raise_for_status()
        return compute_changes(resp.json())
    except Exception as exc:
        log.info("Kurs nicht verfügbar: %s (%s)", ticker, type(exc).__name__)
        return None, None
    finally:
        if own:
            client.close()


def enrich_assets(assets: list[dict], client: httpx.Client | None = None) -> list[dict]:
    for a in assets:
        d1, d5 = fetch_changes(a.get("ticker", ""), client) if a.get("ticker") else (None, None)
        a["change_1d_pct"] = d1
        a["change_5d_pct"] = d5
    return assets
