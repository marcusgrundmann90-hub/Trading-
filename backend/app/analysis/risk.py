"""ATR-based, risk-managed trade plan."""
from __future__ import annotations

import math

ATR_MULTIPLIER = 2.0


def price_decimals(price: float) -> int:
    """Sensible number of decimals: more for small prices."""
    p = abs(price)
    if p >= 1000:
        return 2
    if p >= 1:
        return 2 if p >= 10 else 3
    if p >= 0.01:
        return 5
    if p == 0:
        return 2
    # very small prices: keep ~4 significant digits
    return min(12, -int(math.floor(math.log10(p))) + 3)


def round_price(value: float, ref: float | None = None) -> float:
    return round(float(value), price_decimals(ref if ref is not None else value))


def trade_plan(
    direction: str,
    entry: float,
    atr: float,
    asset_class: str,
    account_size: float = 10000.0,
    risk_pct: float = 1.0,
) -> dict | None:
    """Build the trade plan dict per API contract; None for neutral or unusable inputs."""
    if direction not in ("long", "short"):
        return None
    if not (entry and entry > 0 and atr and atr > 0 and math.isfinite(atr)):
        return None

    risk_per_unit = ATR_MULTIPLIER * atr
    sign = 1 if direction == "long" else -1
    stop = entry - sign * risk_per_unit
    if stop <= 0:  # a long stop below zero makes no sense: cap risk at 95% of entry
        risk_per_unit = entry * 0.95
        stop = entry - sign * risk_per_unit
    tp1 = entry + sign * risk_per_unit
    tp2 = entry + sign * 2 * risk_per_unit

    risk_amount = account_size * risk_pct / 100.0
    size = risk_amount / risk_per_unit
    if asset_class == "stock":
        size = math.floor(size)
        if size * entry > account_size:
            size = math.floor(account_size / entry)
    else:
        size = math.floor(size * 1e6) / 1e6
        if size * entry > account_size:
            size = math.floor(account_size / entry * 1e6) / 1e6
    size = max(size, 0)

    position_value = size * entry
    max_loss = size * risk_per_unit
    return {
        "side": direction,
        "entry": round_price(entry),
        "stop_loss": round_price(stop, entry),
        "take_profit_1": round_price(tp1, entry),
        "take_profit_2": round_price(tp2, entry),
        "risk_reward": 2.0,
        "risk_per_unit": round_price(risk_per_unit, entry),
        "position_size": int(size) if asset_class == "stock" else round(size, 6),
        "position_value": round(position_value, 2),
        "max_loss": round(max_loss, 2),
    }
