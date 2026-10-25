from __future__ import annotations

import json

from bot import config, main, state
from bot.tests.conftest import NOW, FakeClient, make_assessment, make_item, rate_limit_error, resp
from bot.triage import TriageHit, TriageResult


def settings(**kw):
    base = dict(anthropic_api_key="k", ntfy_topic="topic", ntfy_server="https://ntfy.sh",
                alert_min_confidence=75, max_assess_per_day=40, feeds=[("X", "https://x")])
    base.update(kw)
    return config.Settings(**base)


class Harness:
    def __init__(self, items, triage_resps, assess_resps):
        self.items = items
        self.client = FakeClient(triage=triage_resps, assess=assess_resps)
        self.pushed = []

    def fetch(self, feeds_):
        return list(self.items), 1

    def price(self, assets):
        for a in assets:
            a["change_1d_pct"], a["change_5d_pct"] = 3.1, 4.0
        return assets

    def send(self, alert, topic, server, app_url):
        self.pushed.append(alert)
        return True

    def run(self, tmp_path, s=None, now=NOW):
        return main.run(s or settings(), str(tmp_path), client=self.client, fetch=self.fetch,
                        price_fn=self.price, send_fn=self.send, now=now)


def hits(*ids_scores):
    return resp(TriageResult(hits=[TriageHit(id=i, score=s, reason="r", pending_key="") for i, s in ids_scores]))


def test_alert_created_pushed_and_saved(tmp_path):
    items = [make_item(1), make_item(2, title="Fed holds rates as expected")]
    h = Harness(items, [hits(("h0", 9))], [resp(make_assessment())])
    assert h.run(tmp_path) == 0
    assert len(h.pushed) == 1
    doc = json.loads((tmp_path / "alerts.json").read_text(encoding="utf-8"))
    assert doc["updated_at"] == NOW
    a = doc["alerts"][0]
    assert set(a) == {"id", "created_at", "level", "event_key", "headline", "one_liner", "assets", "confidence",
                      "horizon", "rationale", "priced_in", "risks", "second_order", "sources"}
    assert a["level"] == "big"
    assert len(a["id"]) == 8 and a["assets"][0]["change_1d_pct"] == 3.1
    assert a["sources"][0]["url"] == "https://example.com/1"
    st = json.loads((tmp_path / "state.json").read_text())
    assert set(st["seen"]) == {"id1", "id2"}
    assert st["assess_count"] == {state.utc_date(NOW): 1}
    assert st["last_run"] == NOW


def test_below_threshold_or_not_big_bet_no_alert(tmp_path):
    items = [make_item(1), make_item(2, title="Something else entirely here")]
    h = Harness(items, [hits(("h0", 9), ("h1", 8))],
                [resp(make_assessment(confidence=70)), resp(make_assessment(is_big_bet=False, confidence=90))])
    h.run(tmp_path, s=settings(watch_min_confidence=100))  # watch level disabled
    assert h.pushed == []
    assert json.loads((tmp_path / "alerts.json").read_text())["alerts"] == []


def test_priced_in_rejected():
    ok, why = main.should_alert(make_assessment(priced_in="weitgehend"), 75, set())
    assert not ok and "eingepreist" in why


def test_dedupe_by_event_key_and_escalation(tmp_path):
    state.save_alerts(tmp_path, {"alerts": [{"id": "old", "created_at": NOW - 3600,
                                             "event_key": "saudi-oil-terminal-attack-2025-10",
                                             "headline": "h", "one_liner": "o"}]}, NOW - 3600)
    items = [make_item(1), make_item(2, title="Second wave of strikes hits Abqaiq facility")]
    dup = make_assessment()
    esc = make_assessment(duplicate_of_event_key="saudi-oil-terminal-attack-2025-10", is_material_escalation=True,
                          event_key="saudi-oil-terminal-attack-2025-10")
    h = Harness(items, [hits(("h0", 9), ("h1", 9))], [resp(dup), resp(esc)])
    h.run(tmp_path)
    assert len(h.pushed) == 1
    assert h.pushed[0]["event_key"] == "saudi-oil-terminal-attack-2025-10-e2"
    # the assessor saw the earlier alert
    assert "event_key=saudi-oil-terminal-attack-2025-10" in h.client.beta.messages.calls[0]["messages"][0]["content"]
    doc = state.load_alerts(tmp_path)
    assert [a["id"] for a in doc["alerts"]][1] == "old"


def test_same_run_duplicates_only_alert_once(tmp_path):
    items = [make_item(1), make_item(2, title="Completely different words about the attack")]
    h = Harness(items, [hits(("h0", 9), ("h1", 9))], [resp(make_assessment()), resp(make_assessment())])
    h.run(tmp_path)
    assert len(h.pushed) == 1
    # second assessment received the first alert in its recent list
    assert "event_key=saudi-oil-terminal-attack-2025-10" in h.client.beta.messages.calls[1]["messages"][0]["content"]


def test_daily_cap_and_per_run_cap(tmp_path):
    st = state.empty_state()
    st["assess_count"][state.utc_date(NOW)] = 39
    state.save_state(tmp_path, st, NOW - 60)
    items = [make_item(i, title=t) for i, t in enumerate(["Alpha strike on refinery", "Bravo bank collapses suddenly", "Charlie coup topples government"])]
    h = Harness(items, [hits(("h0", 9), ("h1", 8), ("h2", 7))], [resp(make_assessment(is_big_bet=False))])
    h.run(tmp_path)
    assert len(h.client.beta.messages.calls) == 1
    saved = state.load_state(tmp_path)
    assert saved["assess_count"][state.utc_date(NOW)] == 40
    # candidates beyond the budget are dropped (marked seen), not queued: they would be stale next run
    assert all(i in saved["seen"] for i in ("id0", "id1", "id2"))

    h2 = Harness([make_item(9, title="another fresh item here")], [hits(("h0", 9))], [])
    h2.run(tmp_path)
    assert h2.client.beta.messages.calls == []


def test_errors_keep_items_for_retry_and_run_continues(tmp_path):
    items = [make_item(1), make_item(2, title="Other big event in markets today")]
    h = Harness(items, [hits(("h0", 9), ("h1", 9))], [rate_limit_error(), resp(None, stop_reason="refusal")])
    assert h.run(tmp_path) == 0
    st = state.load_state(tmp_path)
    triaged_order = [c["messages"][0]["content"] for c in h.client.beta.messages.calls]
    assert len(triaged_order) == 2
    # one errored (retry → not seen), one refused (seen, skipped)
    assert len(st["seen"]) == 1


def test_triage_failure_leaves_items_unseen(tmp_path):
    h = Harness([make_item(1)], [rate_limit_error()], [])
    assert h.run(tmp_path) == 0
    assert state.load_state(tmp_path)["seen"] == {}


def test_seen_items_not_triaged_again(tmp_path):
    h = Harness([make_item(1)], [hits()], [])
    h.run(tmp_path)
    h2 = Harness([make_item(1)], [], [])
    h2.run(tmp_path, now=NOW + 300)
    assert h2.client.messages.calls == []


def test_dry_run_makes_no_calls_and_writes_nothing(tmp_path, capsys):
    h = Harness([make_item(1)], [], [])
    assert main.run(settings(), str(tmp_path), dry_run=True, client=h.client, fetch=h.fetch, now=NOW) == 0
    assert h.client.messages.calls == []
    assert not (tmp_path / "state.json").exists()
    assert "Missiles hit" in capsys.readouterr().out


def test_main_requires_secrets(monkeypatch, tmp_path):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setenv("NTFY_TOPIC", "t")
    assert main.main(["--state-dir", str(tmp_path)]) == 2
    monkeypatch.delenv("NTFY_TOPIC", raising=False)
    assert main.main(["--test-push", "--state-dir", str(tmp_path)]) == 2


def test_state_round_trip_and_pruning(tmp_path):
    st = state.empty_state()
    st["seen"] = {"fresh": NOW - 3600, "stale": NOW - 73 * 3600}
    st["assess_count"] = {state.utc_date(NOW): 3, "2000-01-01": 9}
    state.save_state(tmp_path, st, NOW)
    loaded = state.load_state(tmp_path)
    assert loaded["seen"] == {"fresh": NOW - 3600}
    assert loaded["assess_count"] == {state.utc_date(NOW): 3}
    assert loaded["last_run"] == NOW


def test_corrupt_state_starts_empty(tmp_path):
    (tmp_path / "state.json").write_text("{not json")
    (tmp_path / "alerts.json").write_text("")
    assert state.load_state(tmp_path) == state.empty_state()
    assert state.load_alerts(tmp_path) == {"updated_at": 0, "alerts": []}


def test_alerts_capped_and_sorted(tmp_path):
    alerts = [{"id": str(i), "created_at": NOW - i} for i in range(250)]
    alerts.reverse()
    state.save_alerts(tmp_path, {"alerts": alerts}, NOW)
    doc = json.loads((tmp_path / "alerts.json").read_text())
    assert len(doc["alerts"]) == config.ALERTS_MAX
    assert doc["alerts"][0]["id"] == "0"
    assert doc["updated_at"] == NOW


def test_costs_are_tracked_and_published(tmp_path):
    from types import SimpleNamespace
    usage_t = SimpleNamespace(input_tokens=10_000, output_tokens=1_000,
                              cache_creation_input_tokens=0, cache_read_input_tokens=0)
    usage_a = SimpleNamespace(input_tokens=3_000, output_tokens=5_000,
                              cache_creation_input_tokens=2_000, cache_read_input_tokens=0)
    triage_resp = hits(("h0", 9))
    triage_resp.model, triage_resp.usage = "claude-haiku-5-5", usage_t
    h = Harness([make_item(0, title="Alpha strike on refinery")], [triage_resp],
                [resp(make_assessment(is_big_bet=False), model="claude-opus-5-5", usage=usage_a)])
    h.run(tmp_path)
    expected = (10_000 * 0.10 + 1_000 * 0.50) / 1e6 + (3_000 * 4 + 2_000 * 4 * 1.25 + 5_000 * 20) / 1e6
    saved = state.load_state(tmp_path)
    assert abs(saved["costs"][state.utc_date(NOW)] - expected) < 1e-9
    doc = json.loads((tmp_path / "alerts.json").read_text(encoding="utf-8"))
    assert abs(doc["usage"]["today_usd"] - round(expected, 4)) < 1e-9
    assert doc["usage"]["assess_today"] == 1
    assert doc["usage"]["assess_max_per_day"] == 40


def test_cost_of_unknown_model_uses_conservative_price():
    from types import SimpleNamespace
    from bot import llm
    u = SimpleNamespace(input_tokens=1_000_000, output_tokens=0)
    assert llm.cost_of("claude-opus-5-5", u) == 4.0
    assert llm.cost_of("some-future-model", u) == 5.0


def pending_hit(i, key):
    return TriageHit(id=i, score=5, reason="r", pending_key=key)


def test_watch_level_for_medium_confidence(tmp_path):
    from bot import notify
    h = Harness([make_item(1)], [hits(("h0", 9))], [resp(make_assessment(is_big_bet=False, confidence=65))])
    h.run(tmp_path)
    assert len(h.pushed) == 1 and h.pushed[0]["level"] == "watch"
    payload = notify.build_payload(h.pushed[0], "topic", "https://app/")
    assert payload["priority"] == 3 and payload["title"].startswith("Beobachten: ")
    assert "eyes" in payload["tags"]
    # below the watch threshold: nothing
    h2 = Harness([make_item(5, title="Other unrelated thing happens")], [hits(("h0", 9))],
                 [resp(make_assessment(event_key="other-2025-10", is_big_bet=False, confidence=55))])
    h2.run(tmp_path)
    assert h2.pushed == []


def test_watch_then_confirmed_big_bet_is_not_blocked(tmp_path):
    h = Harness([make_item(1)], [hits(("h0", 9))], [resp(make_assessment(is_big_bet=False, confidence=65))])
    h.run(tmp_path)
    h2 = Harness([make_item(2, title="Reuters confirms terminal hit and export halt")], [hits(("h0", 9))],
                 [resp(make_assessment(confidence=85))])
    h2.run(tmp_path, now=NOW + 600)
    assert len(h2.pushed) == 1 and h2.pushed[0]["level"] == "big"
    # but a second watch for the same event is suppressed
    h3 = Harness([make_item(3, title="Yet another report on the terminal")], [hits(("h0", 9))],
                 [resp(make_assessment(is_big_bet=False, confidence=65))])
    h3.run(tmp_path, now=NOW + 1200)
    assert h3.pushed == []


def test_unconfirmed_event_is_watched_and_rechecked_on_new_outlet(tmp_path):
    key = "saudi-oil-terminal-attack-2025-10"
    # Run 1: important but unconfirmed -> no push, event is watched
    h = Harness([make_item(1, source="Some Blog")], [hits(("h0", 9))],
                [resp(make_assessment(is_big_bet=False, confidence=45, awaiting_confirmation=True))])
    h.run(tmp_path)
    assert h.pushed == []
    st = state.load_state(tmp_path)
    assert key in st["pending"] and st["pending"][key]["sources"][0]["source"] == "Some Blog"

    # Run 2: same outlet again -> no Opus re-check
    h2 = Harness([make_item(2, title="Blog follow-up on terminal", source="Some Blog")],
                 [resp(TriageResult(hits=[pending_hit("h0", key)]))], [])
    h2.run(tmp_path, now=NOW + 600)
    assert h2.client.beta.messages.calls == []
    assert "Events awaiting confirmation" in h2.client.messages.calls[0]["messages"][0]["content"]

    # Run 3: a new outlet reports it -> re-check with earlier coverage, now a Big Bet
    h3 = Harness([make_item(3, title="AP: terminal hit confirmed by Aramco", source="AP")],
                 [resp(TriageResult(hits=[pending_hit("h0", key)]))], [resp(make_assessment(confidence=85))])
    h3.run(tmp_path, now=NOW + 1200)
    assert len(h3.client.beta.messages.calls) == 1
    msg = h3.client.beta.messages.calls[0]["messages"][0]["content"]
    assert "Earlier coverage of this event" in msg and "Some Blog" in msg
    assert len(h3.pushed) == 1 and h3.pushed[0]["level"] == "big"
    assert key not in state.load_state(tmp_path)["pending"]


def test_pending_expires_and_unknown_keys_are_ignored(tmp_path):
    st = state.empty_state()
    st["pending"]["old-event"] = {"first_seen": NOW - 13 * 3600, "rechecks": 0, "sources": [], "headline": "x"}
    st["pending"]["fresh-event"] = {"first_seen": NOW - 3600, "rechecks": 0, "sources": [], "headline": "y"}
    state.save_state(tmp_path, st, NOW)
    saved = state.load_state(tmp_path)
    assert set(saved["pending"]) == {"fresh-event"}
    h = Harness([make_item(1)], [resp(TriageResult(hits=[pending_hit("h0", "made-up-key")]))], [])
    h.run(tmp_path)
    assert h.client.beta.messages.calls == []
