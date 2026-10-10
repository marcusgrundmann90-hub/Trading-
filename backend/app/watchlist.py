"""Watchlist persistence in a JSON file."""
from __future__ import annotations

import json
import threading
from pathlib import Path

DEFAULT_WATCHLIST = [
    {"symbol": "AAPL", "asset_class": "stock", "name": "Apple"},
    {"symbol": "MSFT", "asset_class": "stock", "name": "Microsoft"},
    {"symbol": "NVDA", "asset_class": "stock", "name": "Nvidia"},
    {"symbol": "AMZN", "asset_class": "stock", "name": "Amazon"},
    {"symbol": "TSLA", "asset_class": "stock", "name": "Tesla"},
    {"symbol": "SAP.DE", "asset_class": "stock", "name": "SAP"},
    {"symbol": "ALV.DE", "asset_class": "stock", "name": "Allianz"},
    {"symbol": "BTCUSDT", "asset_class": "crypto", "name": "Bitcoin"},
    {"symbol": "ETHUSDT", "asset_class": "crypto", "name": "Ethereum"},
    {"symbol": "SOLUSDT", "asset_class": "crypto", "name": "Solana"},
    {"symbol": "BNBUSDT", "asset_class": "crypto", "name": "BNB"},
    {"symbol": "XRPUSDT", "asset_class": "crypto", "name": "XRP"},
]

_lock = threading.RLock()


class WatchlistError(Exception):
    pass


class AlreadyExists(WatchlistError):
    pass


class NotFound(WatchlistError):
    pass


class Watchlist:
    def __init__(self, path: Path):
        self.path = Path(path)

    def _load(self) -> list[dict]:
        if not self.path.exists():
            items = [dict(e) for e in DEFAULT_WATCHLIST]
            self._save(items)
            return items
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            data = [dict(e) for e in DEFAULT_WATCHLIST]
            self._save(data)
        return [
            {"symbol": str(e["symbol"]).upper(), "asset_class": e["asset_class"],
             "name": e.get("name") or str(e["symbol"]).upper()}
            for e in data if isinstance(e, dict) and e.get("symbol") and e.get("asset_class")
        ]

    def _save(self, items: list[dict]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        tmp.write_text(json.dumps(items, indent=2, ensure_ascii=False), encoding="utf-8")
        tmp.replace(self.path)

    def list(self) -> list[dict]:
        with _lock:
            return self._load()

    def add(self, symbol: str, asset_class: str, name: str | None = None) -> dict:
        symbol = symbol.strip().upper()
        with _lock:
            items = self._load()
            if any(e["symbol"] == symbol for e in items):
                raise AlreadyExists(symbol)
            entry = {"symbol": symbol, "asset_class": asset_class, "name": (name or "").strip() or symbol}
            items.append(entry)
            self._save(items)
            return entry

    def remove(self, symbol: str) -> None:
        symbol = symbol.strip().upper()
        with _lock:
            items = self._load()
            remaining = [e for e in items if e["symbol"] != symbol]
            if len(remaining) == len(items):
                raise NotFound(symbol)
            self._save(remaining)

    def get(self, symbol: str) -> dict | None:
        symbol = symbol.strip().upper()
        return next((e for e in self.list() if e["symbol"] == symbol), None)
