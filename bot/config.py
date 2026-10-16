"""Configuration: environment variables, feed list and thresholds."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from urllib.parse import quote_plus

# --- Models -----------------------------------------------------------------
TRIAGE_MODEL = "claude-haiku-5-5"
ASSESS_MODEL = "claude-opus-5-5"
# Beta header for the scalar form `fallbacks: "default"` (the array form uses a
# different header; mixing them returns a 400).
FALLBACK_BETA = "server-side-fallback-2026-07-01"

# --- Pipeline limits ----------------------------------------------------------
MAX_AGE_HOURS = 2            # only news from the last 2 h (older is priced in)
SEEN_TTL_HOURS = 72          # forget seen ids after 72 h
RECENT_ALERTS_HOURS = 72     # alerts shown to the assessor for dedupe
TRIAGE_MIN_SCORE = 8
MAX_ASSESS_PER_RUN = 2
TRIAGE_BATCH_SIZE = 150      # headlines per Haiku call
MAX_TRIAGE_PER_RUN = 900     # hard cap on headlines per run (newest first)
ALERTS_MAX = 200
COST_DAYS_KEPT = 62          # daily cost history kept in state
FEED_TIMEOUT_S = 10.0
SUMMARY_MAX_CHARS = 500
ONE_LINER_MAX_CHARS = 110    # prompt asks for <= 90; hard cut as safety net

APP_URL = "https://marcusgrundmann90-hub.github.io/Trading-/"

BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"
)


def _gnews_search(query: str, lang: str = "en") -> str:
    if lang == "de":
        tail = "hl=de&gl=DE&ceid=DE:de"
    else:
        tail = "hl=en-US&gl=US&ceid=US:en"
    return f"https://news.google.com/rss/search?q={quote_plus(query + ' when:6h')}&{tail}"


def _gnews_topic(topic: str, lang: str = "en") -> str:
    if lang == "de":
        tail = "hl=de&gl=DE&ceid=DE:de"
    else:
        tail = "hl=en-US&gl=US&ceid=US:en"
    return f"https://news.google.com/rss/headlines/section/topic/{topic}?{tail}"


# (source name, url). Each feed is fetched independently; failures are skipped.
FEEDS: list[tuple[str, str]] = [
    # Thematic Google News searches (global coverage, many outlets)
    ("Google News: Öl/Angriffe", _gnews_search(
        '(attack OR strike OR drone OR missile OR seized) (oil OR refinery OR pipeline OR tanker OR LNG OR "Strait of Hormuz" OR "Red Sea")')),
    ("Google News: OPEC", _gnews_search('OPEC OR "OPEC+" (cut OR output OR production OR quota)')),
    ("Google News: Notenbanken", _gnews_search(
        '"central bank" OR Fed OR ECB OR BoJ OR PBOC (surprise OR unexpected OR emergency OR unscheduled) (rate OR cut OR hike)')),
    ("Google News: Krypto-Regulierung", _gnews_search(
        '(SEC OR CFTC OR MiCA OR "crypto bill" OR stablecoin OR "bitcoin reserve" OR "crypto ban") (crypto OR bitcoin)')),
    ("Google News: Exportverbote/Zölle", _gnews_search(
        '("export ban" OR "export controls" OR tariffs OR embargo) (chips OR semiconductors OR "rare earths" OR grain OR wheat OR oil OR gas)')),
    ("Google News: Sanktionen", _gnews_search('sanctions (Russia OR Iran OR China OR Venezuela) (oil OR gas OR banks OR exports)')),
    ("Google News: Krisen", _gnews_search(
        '(default OR bailout OR "bank run" OR "capital controls" OR "debt crisis" OR nationalization)')),
    ("Google News: Krieg/Putsch", _gnews_search(
        '(coup OR invasion OR "declares war" OR mobilization OR ceasefire OR blockade)')),
    ("Google News: Schlagzeilen DE", _gnews_search(
        '(Angriff OR Sanktionen OR Zinsentscheid OR Exportverbot OR Embargo OR Ölpreis OR Staatspleite)', lang="de")),
    # Topic feeds
    ("Google News Business", _gnews_topic("BUSINESS")),
    ("Google News World", _gnews_topic("WORLD")),
    ("Google News Wirtschaft", _gnews_topic("BUSINESS", lang="de")),
    ("Google News Welt", _gnews_topic("WORLD", lang="de")),
    # Direct outlets
    ("BBC World", "https://feeds.bbci.co.uk/news/world/rss.xml"),
    ("BBC Business", "https://feeds.bbci.co.uk/news/business/rss.xml"),
    ("Al Jazeera", "https://www.aljazeera.com/xml/rss/all.xml"),
    ("CNBC", "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114"),
    ("MarketWatch", "https://feeds.content.dowjones.io/public/rss/mw_topstories"),
    ("CoinDesk", "https://www.coindesk.com/arc/outboundfeeds/rss/"),
    ("Cointelegraph", "https://cointelegraph.com/rss"),
    # Official sources
    ("Federal Reserve", "https://www.federalreserve.gov/feeds/press_all.xml"),
    ("EZB", "https://www.ecb.europa.eu/rss/press.html"),
    ("SEC", "https://www.sec.gov/news/pressreleases.rss"),
    ("Bank of England", "https://www.bankofengland.co.uk/rss/news"),
]

GDELT_URL = "https://api.gdeltproject.org/api/v2/doc/doc"
GDELT_QUERY = (
    '(airstrike OR missile OR sanctions OR embargo OR "export ban" OR OPEC OR "rate cut" OR "rate hike" '
    'OR default OR bailout OR coup OR invasion OR blockade OR "state of emergency") '
    "(sourcelang:english OR sourcelang:german)"
)


def _env_int(name: str, default: int) -> int:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    anthropic_api_key: str = ""
    ntfy_topic: str = ""
    ntfy_server: str = "https://ntfy.sh"
    alert_min_confidence: int = 75
    max_assess_per_day: int = 15
    app_url: str = APP_URL
    feeds: list[tuple[str, str]] = field(default_factory=lambda: list(FEEDS))

    @classmethod
    def from_env(cls) -> "Settings":
        server = (os.environ.get("NTFY_SERVER") or "").strip() or "https://ntfy.sh"
        return cls(
            anthropic_api_key=(os.environ.get("ANTHROPIC_API_KEY") or "").strip(),
            ntfy_topic=(os.environ.get("NTFY_TOPIC") or "").strip(),
            ntfy_server=server.rstrip("/"),
            alert_min_confidence=max(0, min(100, _env_int("ALERT_MIN_CONFIDENCE", 75))),
            max_assess_per_day=max(0, _env_int("MAX_ASSESS_PER_DAY", 15)),
            app_url=(os.environ.get("APP_URL") or "").strip() or APP_URL,
        )
