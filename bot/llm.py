"""Shared Anthropic client helpers."""
from __future__ import annotations

import logging

import anthropic

log = logging.getLogger(__name__)


def make_client(api_key: str) -> anthropic.Anthropic:
    # SDK retries 408/409/429/5xx and connection errors itself (2 retries by default).
    return anthropic.Anthropic(api_key=api_key, max_retries=2, timeout=300.0)


def describe_error(exc: Exception) -> str:
    """Short, secret-free description of an API error for logs."""
    if isinstance(exc, anthropic.RateLimitError):
        return "Rate-Limit (429)"
    if isinstance(exc, anthropic.APIStatusError):
        rid = getattr(exc, "request_id", None)
        return f"API-Fehler {exc.status_code}" + (f" ({rid})" if rid else "")
    if isinstance(exc, anthropic.APIConnectionError):
        return "Verbindungsfehler"
    return type(exc).__name__
