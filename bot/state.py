"""Stage 6: persistent state (state.json) and published alerts (alerts.json)."""
from __future__ import annotations

import json
import logging
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from . import config

log = logging.getLogger(__name__)

STATE_FILE = "state.json"
ALERTS_FILE = "alerts.json"


def utc_date(ts: int) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")


def _read_json(path: Path) -> dict | None:
    try:
        with path.open("r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as exc:
        log.warning("%s nicht lesbar (%s) – starte leer", path.name, type(exc).__name__)
        return None


def _write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-", suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1, sort_keys=False)
        f.write("\n")
    os.replace(tmp, path)


def empty_state() -> dict:
    return {"seen": {}, "assess_count": {}, "costs": {}, "last_run": 0}


def load_state(state_dir: str | Path) -> dict:
    data = _read_json(Path(state_dir) / STATE_FILE) or {}
    st = empty_state()
    if isinstance(data.get("seen"), dict):
        st["seen"] = {str(k): int(v) for k, v in data["seen"].items() if isinstance(v, (int, float))}
    if isinstance(data.get("assess_count"), dict):
        st["assess_count"] = {str(k): int(v) for k, v in data["assess_count"].items() if isinstance(v, (int, float))}
    if isinstance(data.get("costs"), dict):
        st["costs"] = {str(k): float(v) for k, v in data["costs"].items() if isinstance(v, (int, float))}
    st["last_run"] = int(data.get("last_run") or 0)
    return st


def prune_state(st: dict, now: int) -> dict:
    cutoff = now - config.SEEN_TTL_HOURS * 3600
    st["seen"] = {k: v for k, v in st["seen"].items() if v >= cutoff}
    keep_days = {utc_date(now - d * 86400) for d in range(3)}
    st["assess_count"] = {k: v for k, v in st["assess_count"].items() if k in keep_days}
    cost_cutoff = utc_date(now - config.COST_DAYS_KEPT * 86400)
    st["costs"] = {k: v for k, v in st.get("costs", {}).items() if k > cost_cutoff}
    return st


def save_state(state_dir: str | Path, st: dict, now: int) -> None:
    st = prune_state(st, now)
    st["last_run"] = now
    _write_json(Path(state_dir) / STATE_FILE, st)


def assess_used_today(st: dict, now: int) -> int:
    return int(st["assess_count"].get(utc_date(now), 0))


def count_assess(st: dict, now: int) -> None:
    d = utc_date(now)
    st["assess_count"][d] = int(st["assess_count"].get(d, 0)) + 1


def add_cost(st: dict, now: int, usd: float) -> None:
    if usd <= 0:
        return
    costs = st.setdefault("costs", {})
    d = utc_date(now)
    costs[d] = round(float(costs.get(d, 0.0)) + usd, 6)


def usage_summary(st: dict, now: int, max_assess_per_day: int) -> dict:
    """Estimated API spend for the app: today, this calendar month (UTC), last 30 days."""
    costs = st.get("costs", {})
    today = utc_date(now)
    month = today[:7]
    last30 = {utc_date(now - i * 86400) for i in range(30)}
    return {
        "today_usd": round(costs.get(today, 0.0), 4),
        "month_usd": round(sum(v for k, v in costs.items() if k.startswith(month)), 4),
        "last30_usd": round(sum(v for k, v in costs.items() if k in last30), 4),
        "assess_today": assess_used_today(st, now),
        "assess_max_per_day": max_assess_per_day,
        "tracked_since": min(costs) if costs else today,
    }


def load_alerts(state_dir: str | Path) -> dict:
    data = _read_json(Path(state_dir) / ALERTS_FILE) or {}
    alerts = data.get("alerts") if isinstance(data.get("alerts"), list) else []
    return {"updated_at": int(data.get("updated_at") or 0), "alerts": [a for a in alerts if isinstance(a, dict)]}


def save_alerts(state_dir: str | Path, doc: dict, now: int, usage: dict | None = None) -> None:
    alerts = sorted(doc.get("alerts") or [], key=lambda a: -int(a.get("created_at", 0)))
    out = {"updated_at": now, "alerts": alerts[: config.ALERTS_MAX]}
    if usage is not None:
        out["usage"] = usage
    _write_json(Path(state_dir) / ALERTS_FILE, out)


def recent_alerts(doc: dict, now: int, hours: int = config.RECENT_ALERTS_HOURS) -> list[dict]:
    cutoff = now - hours * 3600
    return [a for a in doc.get("alerts") or [] if int(a.get("created_at", 0)) >= cutoff]
