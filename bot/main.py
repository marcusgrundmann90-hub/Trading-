"""Entry point: `python -m bot.main [--state-dir DIR] [--dry-run] [--test-push]`."""
from __future__ import annotations

import argparse
import hashlib
import logging
import sys
import time
from datetime import datetime, timezone

from . import config, feeds, llm, notify, prices, state
from .assess import Assessment, assess_item
from .feeds import NewsItem
from .triage import triage

log = logging.getLogger("bot")


def should_alert(a: Assessment, min_confidence: int, known_keys: set[str]) -> tuple[bool, str]:
    if not a.is_big_bet:
        return False, "kein Big Bet"
    if a.confidence < min_confidence:
        return False, f"Konfidenz {a.confidence} < {min_confidence}"
    if not a.assets:
        return False, "keine Assets"
    if a.priced_in == "weitgehend":
        return False, "weitgehend eingepreist"
    is_dup = a.event_key in known_keys or (a.duplicate_of_event_key and a.duplicate_of_event_key in known_keys)
    if is_dup and not a.is_material_escalation:
        return False, f"Duplikat ({a.duplicate_of_event_key or a.event_key})"
    return True, "ok"


def classify(a: Assessment, settings: config.Settings, known_big: set[str], known_all: set[str]) -> tuple[str | None, str]:
    """Return ("big" | "watch" | None, reason)."""
    ok, why = should_alert(a, settings.alert_min_confidence, known_big)
    if ok:
        return "big", "ok"
    watch_min = settings.watch_min_confidence
    if watch_min >= settings.alert_min_confidence or a.confidence < watch_min or a.confidence >= settings.alert_min_confidence and a.is_big_bet:
        return None, why
    if not a.assets or a.priced_in == "weitgehend":
        return None, why
    if a.event_key in known_all or (a.duplicate_of_event_key and a.duplicate_of_event_key in known_all):
        return None, f"schon gemeldet ({a.duplicate_of_event_key or a.event_key})"
    return "watch", f"Beobachten (Konfidenz {a.confidence})"


def unique_event_key(key: str, known_keys: set[str]) -> str:
    key = key or "ereignis"
    if key not in known_keys:
        return key
    n = 2
    while f"{key}-e{n}" in known_keys:
        n += 1
    return f"{key}-e{n}"


def build_alert(a: Assessment, item: NewsItem, related: list[NewsItem], now: int, event_key: str,
                level: str = "big", earlier: list[dict] | None = None) -> dict:
    alert_id = hashlib.sha1(f"{event_key}|{now}|{item.id}".encode("utf-8")).hexdigest()[:8]
    sources = [item.as_source()]
    for src in earlier or []:
        if len(sources) >= 4:
            break
        if src.get("url") not in {s["url"] for s in sources}:
            sources.append(src)
    for r in related:
        if len(sources) >= 4:
            break
        if r.url not in {s["url"] for s in sources}:
            sources.append(r.as_source())
    return {
        "id": alert_id,
        "created_at": now,
        "level": "watch" if level == "watch" else "big",
        "event_key": event_key,
        "headline": a.headline,
        "one_liner": a.one_liner,
        "assets": [
            {"name": x.name, "ticker": x.ticker, "direction": x.direction, "conviction": x.conviction,
             "change_1d_pct": None, "change_5d_pct": None}
            for x in a.assets
        ],
        "confidence": a.confidence,
        "horizon": a.horizon,
        "rationale": a.rationale,
        "priced_in": a.priced_in,
        "risks": a.risks,
        "second_order": a.second_order,
        "sources": sources,
    }


def _order_for_dedupe(items: list[NewsItem]) -> list[NewsItem]:
    # Prefer items with a teaser (direct outlets), then newest first.
    return sorted(items, key=lambda it: (0 if it.summary else 1, -it.published))


def run(settings: config.Settings, state_dir: str, dry_run: bool = False, client=None,
        fetch=feeds.fetch_all, price_fn=prices.enrich_assets, send_fn=notify.send_alert,
        now: int | None = None) -> int:
    now = int(now if now is not None else time.time())
    st = state.load_state(state_dir)
    alerts_doc = state.load_alerts(state_dir)

    # 1. Collect
    raw, ok_sources = fetch(settings.feeds)
    fresh = feeds.filter_fresh(raw, st["seen"], now)
    unique, dupes = feeds.dedupe_titles(_order_for_dedupe(fresh))
    unique.sort(key=lambda it: -it.published)
    to_triage = unique[: config.MAX_TRIAGE_PER_RUN]
    log.info("Quellen ok: %d/%d | Meldungen: %d | neu (≤%dh, ungesehen): %d | nach Dedupe: %d | zur Triage: %d",
             ok_sources, len(settings.feeds) + 1, len(raw), config.MAX_AGE_HOURS, len(fresh), len(unique), len(to_triage))

    if dry_run:
        for it in to_triage:
            age = max(0, (now - it.published) // 60)
            print(f"  [{age:>4} min] {it.source[:28]:<28} {it.title[:120]}")
        log.info("Dry-Run: keine API-Aufrufe, kein Push, Zustand unverändert.")
        return 0

    if client is None:
        from .llm import make_client
        client = make_client(settings.anthropic_api_key)

    # 2. Triage (also matches new coverage of events awaiting confirmation)
    pending = state.active_pending(st, now)
    pending_heads = {k: v.get("headline", k) for k, v in pending.items()}
    if to_triage:
        outcome = triage(client, to_triage, now, pending=pending_heads)
        candidates, triaged_ids, matches = outcome.candidates, outcome.triaged_ids, outcome.pending_matches
        log.info("Triage: %d Aufruf(e), %d fehlgeschlagen, Kandidaten ≥%d: %d, Bestätigungs-Treffer: %d (offen: %d)",
                 outcome.calls, outcome.failed_batches, config.TRIAGE_MIN_SCORE, len(candidates),
                 sum(len(v) for v in matches.values()), len(pending))
    else:
        candidates, triaged_ids, matches = [], set(), {}

    # Re-checks: a watched event gets a new Opus look only if a new outlet reports on it.
    rechecks = []
    for key, items in matches.items():
        entry = pending.get(key)
        if not entry:
            continue
        known_outlets = {x.get("source") for x in entry.get("sources", [])}
        new_items = [it for it in items if it.source not in known_outlets]
        if not new_items:
            state.remember_pending(st, key, entry.get("headline", key), int(entry.get("confidence", 0)),
                                   [it.as_source() for it in items], now)
            continue
        newest = max(new_items, key=lambda it: it.published)
        rechecks.append((key, newest, items, list(entry.get("sources", []))))

    # 3. Assess (daily and per-run caps); re-checks of watched events first
    remaining_today = max(0, settings.max_assess_per_day - state.assess_used_today(st, now))
    budget = min(config.MAX_ASSESS_PER_RUN, remaining_today)
    jobs = [("recheck", key, it, 10, "Neue Berichte zu einem Ereignis, das auf Bestätigung wartet", items, earlier)
            for key, it, items, earlier in rechecks]
    jobs += [("new", None, it, score, reason, [], None) for it, score, reason in candidates]
    if len(jobs) > budget:
        # Not queued for later: by the next run they are stale and would only burn the budget.
        log.info("Bewertungs-Budget: %d (heute noch %d) – %d schwächere(r) Kandidat(en) verworfen",
                 budget, remaining_today, len(jobs) - budget)
    retry_ids: set[str] = set()

    recent = state.recent_alerts(alerts_doc, now)
    known_all = {a.get("event_key") for a in recent if a.get("event_key")}
    known_big = {a.get("event_key") for a in recent if a.get("event_key") and a.get("level") != "watch"}
    new_alerts: list[dict] = []
    assessed = 0
    for kind, pkey, item, score, reason, extra, earlier in jobs[:budget]:
        related = feeds.related_headlines(item, unique)
        for it in extra:
            if it.id != item.id and it not in related:
                related.append(it)
        state.count_assess(st, now)
        assessed += 1
        status, a = assess_item(client, item, score, reason, related, recent + new_alerts, now, earlier=earlier)
        if status == "error":
            retry_ids.add(item.id)  # transient: try again next run
            continue
        if a is None:
            continue
        level, why = classify(a, settings, known_big, known_all)
        tag = "Nachprüfung" if kind == "recheck" else "Bewertet"
        log.info("%s: %s → big_bet=%s konf=%d warten=%s (%s)", tag, a.event_key, a.is_big_bet, a.confidence,
                 a.awaiting_confirmation,
                 why if level else (why + ("; " + a.rejection_reason if a.rejection_reason else "")))

        # Watch the event until it is confirmed (or give up after a few re-checks / 12 h).
        watch_key = pkey or a.event_key
        if level == "big":
            state.drop_pending(st, watch_key)
        elif a.awaiting_confirmation and a.confidence >= config.PENDING_MIN_CONFIDENCE:
            srcs = [x.as_source() for x in [item] + list(extra)]
            state.remember_pending(st, watch_key, a.headline, a.confidence, srcs, now, recheck=kind == "recheck")
            log.info("Wartet auf Bestätigung: %s", watch_key)
        elif kind == "recheck":
            state.drop_pending(st, watch_key)

        if not level:
            continue
        event_key = unique_event_key(a.event_key, known_big if level == "big" else known_all)
        alert = build_alert(a, item, related, now, event_key, level=level, earlier=earlier)
        price_fn(alert["assets"])
        pushed = send_fn(alert, settings.ntfy_topic, settings.ntfy_server, settings.app_url)
        log.info("%s %s: %s (Push %s)", "ALARM" if level == "big" else "BEOBACHTEN", alert["id"],
                 alert["one_liner"], "ok" if pushed else "FEHLGESCHLAGEN")
        new_alerts.append(alert)
        known_all.add(event_key)
        if level == "big":
            known_big.add(event_key)

    # 4. Persist
    for it in to_triage:
        if it.id in triaged_ids and it.id not in retry_ids:
            st["seen"][it.id] = now
            for d in it.related:
                st["seen"][d.id] = now
    run_cost = llm.take_run_cost()
    state.add_cost(st, now, run_cost)
    alerts_doc["alerts"] = new_alerts + alerts_doc["alerts"]
    usage = state.usage_summary(st, now, settings.max_assess_per_day)
    state.save_state(state_dir, st, now)
    state.save_alerts(state_dir, alerts_doc, now, usage=usage)
    log.info("Fertig: %d bewertet, %d Alarm(e), Opus heute %d/%d | Kosten Lauf %.4f $, heute %.2f $, Monat %.2f $",
             assessed, len(new_alerts), state.assess_used_today(st, now), settings.max_assess_per_day,
             run_cost, usage["today_usd"], usage["month_usd"])
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m bot.main", description="Big-Bets-Wächter")
    parser.add_argument("--state-dir", default="./state", help="Verzeichnis für state.json/alerts.json")
    parser.add_argument("--dry-run", action="store_true", help="Nur Feeds holen und anzeigen, keine API-Aufrufe")
    parser.add_argument("--test-push", action="store_true", help="Eine Test-Benachrichtigung senden und beenden")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stdout)
    for noisy in ("httpx", "httpx2", "httpcore", "anthropic"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    settings = config.Settings.from_env()
    log.info("Big-Bets-Lauf %s", datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"))

    if args.test_push:
        if not settings.ntfy_topic:
            log.error("NTFY_TOPIC fehlt – Test-Push nicht möglich.")
            return 2
        ok = notify.send_test(settings.ntfy_topic, settings.ntfy_server, settings.app_url)
        log.info("Test-Push %s", "gesendet" if ok else "FEHLGESCHLAGEN")
        return 0 if ok else 1

    if not args.dry_run:
        missing = [n for n, v in (("ANTHROPIC_API_KEY", settings.anthropic_api_key),
                                  ("NTFY_TOPIC", settings.ntfy_topic)) if not v]
        if missing:
            log.error("Fehlende Konfiguration: %s – Lauf abgebrochen, kein Push.", ", ".join(missing))
            return 2

    return run(settings, args.state_dir, dry_run=args.dry_run)


if __name__ == "__main__":
    sys.exit(main())
