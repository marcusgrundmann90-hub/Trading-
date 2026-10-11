from __future__ import annotations

import time

import httpx

from bot import feeds
from bot.tests.conftest import NOW, make_item

def _rfc822(ts):
    return time.strftime("%a, %d %b %Y %H:%M:%S GMT", time.gmtime(ts))

RSS = f"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>T</title>
<item><title>OPEC+ agrees surprise 1 mb/d cut</title>
<link>https://www.example.com/opec/?utm_source=rss&amp;id=7#frag</link>
<description>&lt;p&gt;Ministers &lt;b&gt;agreed&lt;/b&gt; a cut.&lt;/p&gt;</description>
<pubDate>{_rfc822(NOW - 600)}</pubDate></item>
<item><title>Old story about oil</title><link>https://www.example.com/old</link>
<pubDate>{_rfc822(NOW - 7 * 3600)}</pubDate></item>
<item><title>Ölpreis: Ägypten schließt Suezkanal – Börse reagiert</title><link>https://www.example.com/suez</link>
<description>{'x' * 900}</description>
<pubDate>{_rfc822(NOW - 60)}</pubDate></item>
</channel></rss>"""

GNEWS = f"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>G</title>
<item><title>Iran seizes tanker in Strait of Hormuz - Reuters</title>
<link>https://news.google.com/rss/articles/abc</link>
<description>&lt;a href="x"&gt;Iran seizes tanker&lt;/a&gt;</description>
<source url="https://www.reuters.com">Reuters</source>
<pubDate>{_rfc822(NOW - 120)}</pubDate></item>
</channel></rss>"""


def test_parse_feed_normalizes():
    items = feeds.parse_feed(RSS.encode(), "BBC", now=NOW)
    assert len(items) == 3
    opec = items[0]
    assert opec.summary == "Ministers agreed a cut."
    assert opec.published == NOW - 600
    assert opec.source == "BBC"
    assert len(opec.id) == 16
    suez = items[2]
    assert "Ägypten" in suez.title
    assert len(suez.summary) == 500


def test_id_ignores_tracking_params_and_fragment():
    a = feeds.make_id("https://www.Example.com/opec/?utm_source=rss&id=7#frag", "x")
    b = feeds.make_id("https://www.example.com/opec?id=7", "y")
    assert a == b


def test_google_news_title_and_source():
    items = feeds.parse_feed(GNEWS.encode(), "Google News: Öl/Angriffe", now=NOW)
    assert items[0].title == "Iran seizes tanker in Strait of Hormuz"
    assert items[0].source == "Reuters"
    assert items[0].summary == ""


def test_parse_gdelt():
    payload = {"articles": [
        {"url": "https://x.de/a", "title": "Sanktionen gegen Iran", "seendate": "20251009T080000Z", "domain": "x.de"},
        {"url": "", "title": "no url"},
    ]}
    items = feeds.parse_gdelt(payload, now=NOW)
    assert len(items) == 1
    assert items[0].source == "x.de (GDELT)"
    assert items[0].published == 1759996800


def test_filter_fresh_age_seen_future_and_id_dupes():
    fresh = make_item(1, age_min=30)
    old = make_item(2, age_min=7 * 60)
    seen = make_item(3, age_min=5)
    future = make_item(4, age_min=-120)
    dup = make_item(1, age_min=30)
    out = feeds.filter_fresh([fresh, old, seen, future, dup], {"id3": NOW}, NOW)
    assert [i.id for i in out] == ["id1"]


def test_dedupe_near_identical_titles():
    a = make_item(1, title="Iran seizes oil tanker in Strait of Hormuz")
    b = make_item(2, title="Iran seizes oil tanker in the Strait of Hormuz", source="AP")
    c = make_item(3, title="IRAN SEIZES OIL TANKER IN STRAIT OF HORMUZ!")
    d = make_item(4, title="Fed holds rates steady as expected")
    unique, dupes = feeds.dedupe_titles([a, b, c, d])
    assert [u.id for u in unique] == ["id1", "id4"]
    assert {x.id for x in dupes} == {"id2", "id3"}
    assert {x.id for x in a.related} == {"id2", "id3"}


def test_related_headlines():
    a = make_item(1, title="Iran seizes oil tanker in Strait of Hormuz")
    b = make_item(2, title="Oil prices jump after Iran tanker seizure in Hormuz")
    c = make_item(3, title="Bundesliga results")
    rel = feeds.related_headlines(a, [a, b, c])
    assert [r.id for r in rel] == ["id2"]


def test_fetch_all_skips_failing_feeds():
    def handler(request: httpx.Request) -> httpx.Response:
        if "good" in str(request.url):
            return httpx.Response(200, content=RSS.encode())
        if "gdelt" in str(request.url):
            raise httpx.ConnectTimeout("timeout")
        return httpx.Response(503)

    client = httpx.Client(transport=httpx.MockTransport(handler))
    items, ok = feeds.fetch_all([("Good", "https://good.example/rss"), ("Bad", "https://bad.example/rss")],
                                client=client, now=NOW)
    assert ok == 1
    assert len(items) == 3


def test_fetch_feed_garbage_is_harmless():
    client = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200, content=b"<html>nope")))
    assert feeds.fetch_feed(client, "X", "https://x.example", NOW) == []
