"""Collect fresh headlines from RSS/Atom feeds and GDELT."""
from __future__ import annotations

import calendar
import hashlib
import html
import logging
import re
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import feedparser
import httpx

from . import config

log = logging.getLogger(__name__)

_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")
_WORD_RE = re.compile(r"[a-z0-9äöüß]+")
_TRACKING_PARAMS = {"fbclid", "gclid", "ocid", "cmpid", "mod", "ref", "taid", "smid"}


@dataclass
class NewsItem:
    id: str
    title: str
    summary: str
    url: str
    source: str
    published: int  # unix seconds (UTC)
    related: list["NewsItem"] = field(default_factory=list, repr=False)

    def as_source(self) -> dict:
        return {"title": self.title, "url": self.url, "source": self.source, "published": self.published}


# --- normalisation -------------------------------------------------------------

def strip_html(text: str | None) -> str:
    if not text:
        return ""
    text = _TAG_RE.sub(" ", text)
    text = html.unescape(text)
    return _WS_RE.sub(" ", text).strip()


def normalize_url(url: str) -> str:
    try:
        parts = urlsplit(url.strip())
    except ValueError:
        return url.strip()
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
             if not k.lower().startswith("utm_") and k.lower() not in _TRACKING_PARAMS]
    path = parts.path.rstrip("/") or "/"
    return urlunsplit((parts.scheme.lower() or "https", parts.netloc.lower(), path, urlencode(query), ""))


def make_id(url: str, title: str) -> str:
    basis = normalize_url(url) if url else normalize_title(title)
    return hashlib.sha1(basis.encode("utf-8")).hexdigest()[:16]


def normalize_title(title: str) -> str:
    return " ".join(_WORD_RE.findall(title.lower()))


def title_tokens(title: str) -> set[str]:
    return {w for w in _WORD_RE.findall(title.lower()) if len(w) > 2}


def jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def _split_google_title(title: str, source: str) -> tuple[str, str]:
    """Google News titles end with ' - Outlet'. Split that off."""
    if " - " in title:
        head, tail = title.rsplit(" - ", 1)
        if head and 0 < len(tail) <= 60:
            return head.strip(), tail.strip()
    return title, source


def _entry_time(entry) -> int | None:
    for key in ("published_parsed", "updated_parsed", "created_parsed"):
        st = entry.get(key)
        if st:
            try:
                return int(calendar.timegm(st))
            except (TypeError, ValueError, OverflowError):
                continue
    return None


# --- parsing -----------------------------------------------------------------

def parse_feed(content: bytes | str, source_name: str, now: int | None = None) -> list[NewsItem]:
    now = int(now if now is not None else time.time())
    parsed = feedparser.parse(content)
    is_google = "Google News" in source_name
    items: list[NewsItem] = []
    for entry in parsed.entries:
        title = strip_html(entry.get("title"))
        url = (entry.get("link") or "").strip()
        if not title or not url:
            continue
        source = source_name
        if is_google:
            src = entry.get("source")
            src_title = src.get("title") if hasattr(src, "get") else None
            title, outlet = _split_google_title(title, source_name)
            source = src_title or outlet
            summary = ""  # Google's description is just the title + outlet link list
        else:
            summary = strip_html(entry.get("summary") or entry.get("description"))
        published = _entry_time(entry) or now
        items.append(NewsItem(
            id=make_id(url, title),
            title=title[:300],
            summary=summary[: config.SUMMARY_MAX_CHARS],
            url=url,
            source=source,
            published=published,
        ))
    return items


def parse_gdelt(payload: dict, now: int | None = None) -> list[NewsItem]:
    now = int(now if now is not None else time.time())
    items: list[NewsItem] = []
    for art in payload.get("articles") or []:
        title = strip_html(art.get("title"))
        url = (art.get("url") or "").strip()
        if not title or not url:
            continue
        published = now
        seen = art.get("seendate")  # e.g. 20261011T120000Z
        if seen:
            try:
                published = int(calendar.timegm(time.strptime(seen, "%Y%m%dT%H%M%SZ")))
            except ValueError:
                pass
        items.append(NewsItem(
            id=make_id(url, title),
            title=title[:300],
            summary="",
            url=url,
            source=f"{art.get('domain') or 'GDELT'} (GDELT)",
            published=published,
        ))
    return items


# --- fetching ------------------------------------------------------------------

def _http_client() -> httpx.Client:
    return httpx.Client(
        timeout=config.FEED_TIMEOUT_S,
        follow_redirects=True,
        headers={"User-Agent": config.BROWSER_UA,
                 "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, application/json, */*"},
    )


def fetch_feed(client: httpx.Client, name: str, url: str, now: int) -> list[NewsItem]:
    try:
        resp = client.get(url)
        resp.raise_for_status()
        return parse_feed(resp.content, name, now)
    except Exception as exc:  # network, HTTP or parser errors: skip this feed
        log.warning("Feed übersprungen: %s (%s)", name, type(exc).__name__)
        return []


def fetch_gdelt(client: httpx.Client, now: int) -> list[NewsItem]:
    params = {"query": config.GDELT_QUERY, "mode": "artlist", "format": "json",
              "timespan": "1h", "maxrecords": "75", "sort": "datedesc"}
    try:
        resp = client.get(config.GDELT_URL, params=params)
        resp.raise_for_status()
        return parse_gdelt(resp.json(), now)
    except Exception as exc:
        log.warning("Feed übersprungen: GDELT (%s)", type(exc).__name__)
        return []


def fetch_all(feeds: list[tuple[str, str]], include_gdelt: bool = True,
              client: httpx.Client | None = None, now: int | None = None) -> tuple[list[NewsItem], int]:
    """Fetch all feeds in parallel. Returns (items, number_of_sources_ok)."""
    now = int(now if now is not None else time.time())
    own = client is None
    client = client or _http_client()
    try:
        jobs = [(n, u) for n, u in feeds]
        with ThreadPoolExecutor(max_workers=8) as pool:
            futures = [pool.submit(fetch_feed, client, n, u, now) for n, u in jobs]
            if include_gdelt:
                futures.append(pool.submit(fetch_gdelt, client, now))
            results = [f.result() for f in futures]
    finally:
        if own:
            client.close()
    ok = sum(1 for r in results if r)
    return [it for r in results for it in r], ok


# --- filtering -----------------------------------------------------------------

def filter_fresh(items: list[NewsItem], seen: dict, now: int,
                 max_age_hours: float = config.MAX_AGE_HOURS) -> list[NewsItem]:
    """Drop items that are too old, from the future, or already seen. Dedupe by id."""
    min_ts = now - int(max_age_hours * 3600)
    out: list[NewsItem] = []
    ids: set[str] = set()
    for it in items:
        if it.id in ids or it.id in seen:
            continue
        if it.published < min_ts or it.published > now + 3600:
            continue
        ids.add(it.id)
        out.append(it)
    return out


def dedupe_titles(items: list[NewsItem], threshold: float = 0.75) -> tuple[list[NewsItem], list[NewsItem]]:
    """Collapse near-identical titles (keeps the earliest-listed, i.e. preferred source).

    Returns (unique, duplicates). Duplicates are attached to the kept item's `related`.
    """
    kept: list[tuple[NewsItem, set[str], str]] = []
    exact: dict[str, NewsItem] = {}
    dupes: list[NewsItem] = []
    for it in items:
        key = normalize_title(it.title)
        if key in exact:
            exact[key].related.append(it)
            dupes.append(it)
            continue
        toks = title_tokens(it.title)
        match = None
        if len(toks) >= 4:
            for other, otoks, _ in kept:
                if jaccard(toks, otoks) >= threshold:
                    match = other
                    break
        if match is not None:
            match.related.append(it)
            dupes.append(it)
            continue
        kept.append((it, toks, key))
        exact[key] = it
    return [k[0] for k in kept], dupes


def related_headlines(item: NewsItem, pool: list[NewsItem], limit: int = 8,
                      min_sim: float = 0.2) -> list[NewsItem]:
    """Headlines from this run that look like coverage of the same story."""
    toks = title_tokens(item.title)
    scored = []
    seen_ids = {item.id}
    for r in item.related:
        if r.id not in seen_ids:
            scored.append((1.0, r))
            seen_ids.add(r.id)
    for other in pool:
        if other.id in seen_ids:
            continue
        sim = jaccard(toks, title_tokens(other.title))
        if sim >= min_sim:
            scored.append((sim, other))
            seen_ids.add(other.id)
    scored.sort(key=lambda x: -x[0])
    return [o for _, o in scored[:limit]]
