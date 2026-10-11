import pytest
from fastapi.testclient import TestClient

from app.analysis import engine


@pytest.fixture
def demo_env(tmp_path, monkeypatch):
    wl = tmp_path / "watchlist.json"
    monkeypatch.setenv("TRADING_DATA_MODE", "demo")
    monkeypatch.setenv("TRADING_WATCHLIST_FILE", str(wl))
    engine.set_market_data(None)
    yield wl
    engine.set_market_data(None)


@pytest.fixture
def client(demo_env):
    from app.main import app

    with TestClient(app) as c:
        yield c
