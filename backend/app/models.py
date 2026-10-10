"""Pydantic models for request bodies and enums."""
from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field, field_validator


class AssetClass(str, Enum):
    stock = "stock"
    crypto = "crypto"


class ScanAssetClass(str, Enum):
    all = "all"
    stock = "stock"
    crypto = "crypto"


class WatchlistEntryIn(BaseModel):
    symbol: str = Field(min_length=1, max_length=32)
    asset_class: AssetClass
    name: str | None = Field(default=None, max_length=100)

    @field_validator("symbol")
    @classmethod
    def _upper(cls, v: str) -> str:
        v = v.strip().upper()
        if not v:
            raise ValueError("symbol must not be empty")
        return v


class WatchlistEntry(BaseModel):
    symbol: str
    asset_class: AssetClass
    name: str
