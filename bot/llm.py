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


# --- Cost tracking ------------------------------------------------------------
# USD per million tokens (input, output), Anthropic first-party list prices.
# Cache writes cost 1.25x input, cache reads 0.1x input. Thinking tokens are
# billed as output and already included in usage.output_tokens.
PRICES_PER_MTOK: dict[str, tuple[float, float]] = {
    "claude-haiku-5-5": (0.10, 0.50),
    "claude-opus-5-5": (4.00, 20.00),
    "claude-opus-5": (5.00, 25.00),
    "claude-opus-4-8": (5.00, 25.00),
    "claude-sonnet-5-5": (2.00, 10.00),
    "claude-fable-5-1": (10.00, 50.00),
}
# Unknown model (e.g. a server-side fallback we don't list): assume Opus-5 rates.
_DEFAULT_PRICE = (5.00, 25.00)

_run_cost_usd = 0.0


def _price_for(model: str) -> tuple[float, float]:
    model = (model or "").strip()
    for name, price in PRICES_PER_MTOK.items():
        if model == name or model.startswith(name + "-"):
            return price
    return _DEFAULT_PRICE


def cost_of(model: str, usage) -> float:
    """Estimated USD cost of one response from its usage block."""
    if usage is None:
        return 0.0
    p_in, p_out = _price_for(model)
    inp = getattr(usage, "input_tokens", 0) or 0
    out = getattr(usage, "output_tokens", 0) or 0
    cw = getattr(usage, "cache_creation_input_tokens", 0) or 0
    cr = getattr(usage, "cache_read_input_tokens", 0) or 0
    return (inp * p_in + cw * p_in * 1.25 + cr * p_in * 0.1 + out * p_out) / 1_000_000


def record_usage(resp, requested_model: str) -> None:
    """Add a response's cost to the running total of this run."""
    global _run_cost_usd
    model = getattr(resp, "model", None) or requested_model
    _run_cost_usd += cost_of(str(model), getattr(resp, "usage", None))


def take_run_cost() -> float:
    """Return and reset the cost accumulated in this run."""
    global _run_cost_usd
    total, _run_cost_usd = _run_cost_usd, 0.0
    return total
