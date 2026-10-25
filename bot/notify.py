"""Stage 5: push notification via ntfy (JSON publish to the server root)."""
from __future__ import annotations

import logging

import httpx

log = logging.getLogger(__name__)

TEST_TITLE = "Big-Bets-Wächter"
TEST_MESSAGE = "✅ Big-Bets-Wächter ist eingerichtet"


def fmt_pct(v: float) -> str:
    s = f"{v:+.1f}".replace(".", ",")
    return f"{s} %"


def build_message(alert: dict) -> str:
    msg = alert["one_liner"]
    for a in alert.get("assets") or []:
        d1 = a.get("change_1d_pct")
        if isinstance(d1, (int, float)):
            msg += f"\nBereits: {a.get('name') or a.get('ticker')} {fmt_pct(d1)} heute"
            break
    return msg


def priority_for(confidence: int, level: str = "big") -> int:
    if level == "watch":
        return 3  # normal priority: shows up, but no urgent alarm sound
    return 5 if confidence >= 90 else 4


def tags_for(alert: dict) -> list[str]:
    assets = alert.get("assets") or []
    direction = assets[0].get("direction") if assets else None
    tags = ["chart_with_downwards_trend" if direction == "short" else "chart_with_upwards_trend"]
    if alert.get("level") == "watch":
        return ["eyes"] + tags
    if alert.get("confidence", 0) >= 90:
        tags.append("rotating_light")
    return tags


def build_payload(alert: dict, topic: str, app_url: str) -> dict:
    return {
        "topic": topic,
        "title": ("Beobachten: " if alert.get("level") == "watch" else "") + alert["headline"],
        "message": build_message(alert) + ("\nNoch unsicher – erst handeln, wenn es sich bestätigt." if alert.get("level") == "watch" else ""),
        "priority": priority_for(int(alert.get("confidence", 0)), alert.get("level", "big")),
        "tags": tags_for(alert),
        "click": f"{app_url.rstrip('/')}/#{alert['id']}",
    }


def send(payload: dict, server: str, client: httpx.Client | None = None) -> bool:
    """POST JSON to the ntfy server root. JSON body keeps UTF-8 (emoji, umlauts) intact,
    unlike HTTP headers which must be latin-1."""
    own = client is None
    client = client or httpx.Client(timeout=15.0)
    try:
        resp = client.post(server.rstrip("/") + "/", json=payload)
        resp.raise_for_status()
        return True
    except Exception as exc:
        log.warning("Push fehlgeschlagen (%s)", type(exc).__name__)
        return False
    finally:
        if own:
            client.close()


def send_alert(alert: dict, topic: str, server: str, app_url: str, client: httpx.Client | None = None) -> bool:
    return send(build_payload(alert, topic, app_url), server, client)


def send_test(topic: str, server: str, app_url: str, client: httpx.Client | None = None) -> bool:
    payload = {"topic": topic, "title": TEST_TITLE, "message": TEST_MESSAGE,
               "priority": 3, "tags": ["white_check_mark"], "click": app_url}
    return send(payload, server, client)
