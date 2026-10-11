from __future__ import annotations

import json

import httpx

from bot import notify, prices


def _alert(**kw):
    a = {"id": "ab12cd34", "headline": "Raketen treffen saudisches Ölterminal",
         "one_liner": "🛢️ LONG Öl (Brent) · Angriff auf Ras Tanura · hoch · Tage", "confidence": 82,
         "assets": [{"name": "Brent-Öl", "ticker": "BZ=F", "direction": "long", "conviction": 9,
                     "change_1d_pct": 4.23, "change_5d_pct": 6.1}]}
    a.update(kw)
    return a


def test_payload_fields():
    p = notify.build_payload(_alert(), "bigbets-secret", "https://u.github.io/Trading-/")
    assert p["topic"] == "bigbets-secret"
    assert p["title"] == "Raketen treffen saudisches Ölterminal"
    assert p["message"] == "🛢️ LONG Öl (Brent) · Angriff auf Ras Tanura · hoch · Tage\nBereits: Brent-Öl +4,2 % heute"
    assert p["priority"] == 4
    assert p["tags"] == ["chart_with_upwards_trend"]
    assert p["click"] == "https://u.github.io/Trading-/#ab12cd34"


def test_payload_priority_short_and_no_prices():
    a = _alert(confidence=93, assets=[{"name": "S&P 500", "ticker": "^GSPC", "direction": "short",
                                       "conviction": 7, "change_1d_pct": None, "change_5d_pct": None}])
    p = notify.build_payload(a, "t", "https://x/")
    assert p["priority"] == 5
    assert p["tags"][0] == "chart_with_downwards_trend" and "rotating_light" in p["tags"]
    assert "Bereits" not in p["message"]


def test_send_posts_utf8_json_to_server_root():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["ctype"] = request.headers["content-type"]
        seen["body"] = json.loads(request.content.decode("utf-8"))
        # nothing non-latin-1 in headers
        for v in request.headers.values():
            v.encode("latin-1")
        return httpx.Response(200, json={"id": "x"})

    client = httpx.Client(transport=httpx.MockTransport(handler))
    assert notify.send_alert(_alert(), "topic1", "https://ntfy.sh", "https://app/", client=client)
    assert seen["url"] == "https://ntfy.sh/"
    assert seen["ctype"] == "application/json"
    assert seen["body"]["title"] == "Raketen treffen saudisches Ölterminal"
    assert seen["body"]["message"].startswith("🛢️")


def test_send_failure_returns_false():
    client = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(500)))
    assert notify.send_test("t", "https://ntfy.sh", "https://app/", client=client) is False


def test_test_push_message():
    seen = {}
    client = httpx.Client(transport=httpx.MockTransport(
        lambda r: seen.setdefault("b", json.loads(r.content)) and httpx.Response(200)))
    assert notify.send_test("t", "https://ntfy.sh/", "https://app/", client=client)
    assert seen["b"]["message"] == "✅ Big-Bets-Wächter ist eingerichtet"


CHART = {"chart": {"result": [{
    "meta": {"regularMarketPrice": 84.0, "chartPreviousClose": 80.0},
    "indicators": {"quote": [{"close": [80.5, 81.0, None, 82.0, 84.0]}]},
}]}}


def test_compute_changes():
    d1, d5 = prices.compute_changes(CHART)
    assert d1 == round((84 / 82 - 1) * 100, 2)
    assert d5 == 5.0
    assert prices.compute_changes({}) == (None, None)
    assert prices.compute_changes({"chart": {"result": []}}) == (None, None)


def test_fetch_changes_encodes_ticker_and_handles_failure():
    urls = []

    def handler(request):
        urls.append(str(request.url))
        if "FAIL" in str(request.url):
            return httpx.Response(404)
        return httpx.Response(200, json=CHART)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    assets = [{"ticker": "^GDAXI"}, {"ticker": "FAIL"}, {"ticker": ""}]
    prices.enrich_assets(assets, client)
    assert "%5EGDAXI" in urls[0] and "range=5d" in urls[0] and "interval=1d" in urls[0]
    assert assets[0]["change_5d_pct"] == 5.0
    assert assets[1]["change_1d_pct"] is None and assets[2]["change_5d_pct"] is None
