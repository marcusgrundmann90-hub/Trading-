"""Application settings, read from environment variables."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

VERSION = "0.1.0"
REPO_ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class Settings:
    data_mode: str
    watchlist_file: Path
    cache_ttl: int


def get_settings() -> Settings:
    """Build settings from the current environment (re-read on each call so tests can monkeypatch)."""
    mode = os.environ.get("TRADING_DATA_MODE", "live").strip().lower()
    if mode not in ("live", "demo"):
        mode = "live"
    wl = Path(os.environ.get("TRADING_WATCHLIST_FILE", "backend/data/watchlist.json"))
    if not wl.is_absolute():
        wl = REPO_ROOT / wl
    try:
        ttl = int(os.environ.get("TRADING_CACHE_TTL", "300"))
    except ValueError:
        ttl = 300
    return Settings(data_mode=mode, watchlist_file=wl, cache_ttl=ttl)
