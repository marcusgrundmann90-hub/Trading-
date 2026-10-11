"""API routes (see docs/API.md)."""
from __future__ import annotations

import asyncio
import logging
import time

from fastapi import APIRouter, HTTPException, Query, Response, status

from .analysis.engine import analyze
from .config import VERSION, get_settings
from .models import AssetClass, ScanAssetClass, WatchlistEntry, WatchlistEntryIn
from .watchlist import AlreadyExists, NotFound, Watchlist

logger = logging.getLogger(__name__)
router = APIRouter()


def get_watchlist() -> Watchlist:
    return Watchlist(get_settings().watchlist_file)


@router.get("/health")
def health() -> dict:
    return {"status": "ok", "mode": get_settings().data_mode, "version": VERSION}


@router.get("/watchlist", response_model=list[WatchlistEntry])
def list_watchlist() -> list[dict]:
    return get_watchlist().list()


@router.post("/watchlist", status_code=status.HTTP_201_CREATED, response_model=WatchlistEntry)
def add_watchlist(entry: WatchlistEntryIn) -> dict:
    try:
        return get_watchlist().add(entry.symbol, entry.asset_class.value, entry.name)
    except AlreadyExists:
        raise HTTPException(status_code=409, detail=f"{entry.symbol} ist bereits in der Watchlist.")


@router.delete("/watchlist/{symbol}", status_code=status.HTTP_204_NO_CONTENT)
def delete_watchlist(symbol: str) -> Response:
    try:
        get_watchlist().remove(symbol)
    except NotFound:
        raise HTTPException(status_code=404, detail=f"{symbol.upper()} ist nicht in der Watchlist.")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/scan")
async def scan(
    asset_class: ScanAssetClass = ScanAssetClass.all,
    account_size: float = Query(10000.0, gt=0),
    risk_pct: float = Query(1.0, gt=0, le=100),
) -> dict:
    entries = get_watchlist().list()
    if asset_class != ScanAssetClass.all:
        entries = [e for e in entries if e["asset_class"] == asset_class.value]

    async def run(e: dict):
        try:
            return await asyncio.to_thread(
                analyze, e["symbol"], e["asset_class"], e.get("name"), account_size, risk_pct
            )
        except Exception as exc:  # noqa: BLE001 - skip broken symbols
            logger.warning("Scan: analysis of %s failed: %s", e["symbol"], exc)
            return None

    results = await asyncio.gather(*(run(e) for e in entries))
    opps = [r for r in results if r is not None]
    opps.sort(key=lambda o: (-abs(o["score"]), o["symbol"]))
    return {"generated_at": int(time.time()), "opportunities": opps}


@router.get("/analysis/{symbol}")
async def analysis(
    symbol: str,
    asset_class: AssetClass | None = None,
    account_size: float = Query(10000.0, gt=0),
    risk_pct: float = Query(1.0, gt=0, le=100),
) -> dict:
    symbol = symbol.strip().upper()
    entry = get_watchlist().get(symbol)
    if asset_class is None:
        if entry:
            ac = entry["asset_class"]
        else:
            ac = "crypto" if symbol.endswith(("USDT", "USDC", "BUSD")) else "stock"
    else:
        ac = asset_class.value
    name = entry["name"] if entry and entry["asset_class"] == ac else None
    try:
        return await asyncio.to_thread(
            analyze, symbol, ac, name, account_size, risk_pct, True
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("Analysis of %s failed: %s", symbol, exc)
        raise HTTPException(status_code=404, detail=f"Keine Daten für {symbol}.")
