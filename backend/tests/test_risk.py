import pytest

from app.analysis.risk import trade_plan


def test_long_stock_plan():
    p = trade_plan("long", 100.0, 2.5, "stock", 10000, 1)
    assert p["side"] == "long"
    assert p["stop_loss"] == 95.0
    assert p["take_profit_1"] == 105.0
    assert p["take_profit_2"] == 110.0
    assert p["risk_per_unit"] == 5.0
    assert p["risk_reward"] == 2.0
    assert p["position_size"] == 20
    assert p["position_value"] == 2000.0
    assert p["max_loss"] == 100.0


def test_short_crypto_plan_rounding():
    p = trade_plan("short", 3000.0, 70.0, "crypto", 10000, 1)
    assert p["stop_loss"] == 3140.0
    assert p["take_profit_1"] == 2860.0
    assert p["take_profit_2"] == 2720.0
    assert p["position_size"] == pytest.approx(0.714285, abs=1e-6)
    assert p["max_loss"] == pytest.approx(100.0, abs=0.01)


def test_stock_size_floored():
    p = trade_plan("long", 189.32, 3.61, "stock", 10000, 1)
    assert p["position_size"] == 13  # 100 / 7.22 = 13.85 -> 13
    assert p["max_loss"] == round(13 * 7.22, 2)


def test_position_capped_to_account():
    # tiny ATR -> huge size; must be capped at account size
    p = trade_plan("long", 100.0, 0.05, "stock", 10000, 1)
    assert p["position_value"] <= 10000
    assert p["position_size"] == 100
    assert p["max_loss"] == pytest.approx(10.0)
    c = trade_plan("long", 50000.0, 10.0, "crypto", 10000, 2)
    assert c["position_value"] <= 10000
    assert c["position_size"] == 0.2


def test_neutral_returns_none():
    assert trade_plan("neutral", 100.0, 2.0, "stock") is None
    assert trade_plan("long", 100.0, 0.0, "stock") is None


def test_small_price_precision():
    p = trade_plan("long", 0.5432, 0.0123, "crypto", 10000, 1)
    assert p["stop_loss"] == pytest.approx(0.5186, abs=1e-5)
    assert p["entry"] == 0.5432
