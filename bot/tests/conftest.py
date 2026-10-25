from __future__ import annotations

from types import SimpleNamespace

import anthropic
import httpx2
import pytest

from bot.assess import Assessment, AssetCall
from bot.feeds import NewsItem

NOW = 1_760_000_000


def make_item(i: int = 1, title: str = "Missiles hit Saudi oil terminal at Ras Tanura", age_min: int = 10,
              summary: str = "Attack halts exports.", source: str = "Reuters") -> NewsItem:
    return NewsItem(id=f"id{i}", title=title, summary=summary, url=f"https://example.com/{i}",
                    source=source, published=NOW - age_min * 60)


def make_assessment(**kw) -> Assessment:
    base = dict(
        event_key="saudi-oil-terminal-attack-2025-10",
        headline="Raketen treffen saudisches Ölterminal",
        duplicate_of_event_key="",
        is_material_escalation=False,
        rationale="Angriff legt Exporte lahm. Angebot sinkt kurzfristig.",
        priced_in="teilweise",
        risks="Schnelle Reparatur.",
        assets=[AssetCall(name="Brent-Öl", ticker="BZ=F", direction="long", conviction=9)],
        second_order=["Tanker-Reedereien ↑", "Airlines ↓"],
        horizon="Tage",
        awaiting_confirmation=False,
        confidence=82,
        is_big_bet=True,
        one_liner="🛢️ LONG Öl (Brent) · Angriff auf Ras Tanura · hoch · Tage",
        rejection_reason="",
    )
    base.update(kw)
    return Assessment(**base)


def api_request():
    return httpx2.Request("POST", "https://api.anthropic.com/v1/messages")


def rate_limit_error():
    return anthropic.RateLimitError("rate limited", response=httpx2.Response(429, request=api_request()), body=None)


def server_error():
    return anthropic.InternalServerError("boom", response=httpx2.Response(500, request=api_request()), body=None)


def connection_error():
    return anthropic.APIConnectionError(request=api_request())


class _Endpoint:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls: list[dict] = []

    def parse(self, **kwargs):
        self.calls.append(kwargs)
        r = self.responses.pop(0)
        if isinstance(r, BaseException):
            raise r
        return r


class FakeClient:
    """Mimics anthropic.Anthropic: .messages.parse (triage) and .beta.messages.parse (assess)."""

    def __init__(self, triage=(), assess=()):
        self.messages = _Endpoint(triage)
        self.beta = SimpleNamespace(messages=_Endpoint(assess))


def resp(parsed=None, stop_reason="end_turn", model=None, usage=None):
    return SimpleNamespace(stop_reason=stop_reason, parsed_output=parsed, content=[], model=model, usage=usage)


@pytest.fixture
def now():
    return NOW
