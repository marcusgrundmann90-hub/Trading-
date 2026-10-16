from __future__ import annotations

from pydantic import ValidationError

from bot import assess, config, triage
from bot.assess import Assessment
from bot.tests.conftest import (NOW, FakeClient, connection_error, make_assessment, make_item, rate_limit_error,
                                resp, server_error)
from bot.triage import TriageHit, TriageResult


def _validation_error():
    try:
        Assessment.model_validate_json('{"event_key": "x"')
    except ValidationError as e:
        return e


def test_triage_maps_ids_and_filters_scores():
    items = [make_item(i, title=f"headline {i}") for i in range(3)]
    result = TriageResult(hits=[TriageHit(id="h0", score=9, reason="Angriff"),
                                TriageHit(id="h1", score=5, reason="routine"),
                                TriageHit(id="h99", score=10, reason="hallucinated id")])
    client = FakeClient(triage=[resp(result)])
    out = triage.triage(client, items, NOW)
    assert [(c[0].id, c[1]) for c in out.candidates] == [("id0", 9)]
    assert out.triaged_ids == {"id0", "id1", "id2"}
    call = client.messages.calls[0]
    assert call["model"] == "claude-haiku-5-5"
    assert call["output_config"] == {"effort": "low"}
    assert call["output_format"] is TriageResult
    assert call["system"][0]["text"] == triage.TRIAGE_SYSTEM
    assert "h2 | Reuters |" in call["messages"][0]["content"]
    assert "thinking" not in call


def test_triage_batches_and_survives_errors():
    items = [make_item(i, title=f"headline {i}") for i in range(5)]
    ok = resp(TriageResult(hits=[TriageHit(id="h0", score=8, reason="x")]))
    client = FakeClient(triage=[rate_limit_error(), ok, connection_error()])
    out = triage.triage(client, items, NOW, batch_size=2)
    assert out.calls == 3 and out.failed_batches == 2
    assert out.triaged_ids == {"id2", "id3"}
    assert [c[0].id for c in out.candidates] == ["id2"]


def test_triage_refusal_is_definitive_but_empty():
    items = [make_item(1)]
    client = FakeClient(triage=[resp(None, stop_reason="refusal")])
    out = triage.triage(client, items, NOW)
    assert out.candidates == [] and out.triaged_ids == {"id1"} and out.failed_batches == 0


def test_triage_unparseable_counts_as_failure():
    client = FakeClient(triage=[_validation_error()])
    out = triage.triage(client, [make_item(1)], NOW)
    assert out.failed_batches == 1 and out.triaged_ids == set()


def test_assess_request_shape_and_result():
    a = make_assessment(confidence=150, one_liner="x" * 200)
    client = FakeClient(assess=[resp(a)])
    status, res = assess.assess_item(client, make_item(1), 9, "Angriff", [make_item(2, title="Related")],
                                     [{"event_key": "old-key", "created_at": NOW - 7200, "headline": "H", "one_liner": "O"}],
                                     NOW)
    assert status == "ok"
    assert res.confidence == 100
    assert len(res.one_liner) == config.ONE_LINER_MAX_CHARS
    call = client.beta.messages.calls[0]
    assert call["model"] == "claude-opus-5-5"
    assert call["betas"] == ["server-side-fallback-2026-07-01"]
    assert call["fallbacks"] == "default"
    assert call["output_config"] == {"effort": "high"}
    assert call["output_format"] is Assessment
    assert call["system"][0]["text"] == assess.ASSESS_SYSTEM
    assert "thinking" not in call and "temperature" not in call
    user = call["messages"][0]["content"]
    assert "event_key=old-key" in user and "Related" in user and "Missiles hit" in user


def test_assess_refusal_skipped():
    client = FakeClient(assess=[resp(None, stop_reason="refusal")])
    assert assess.assess_item(client, make_item(1), 9, "", [], [], NOW) == ("refusal", None)


def test_assess_errors_do_not_raise():
    for err in (rate_limit_error(), server_error(), connection_error()):
        client = FakeClient(assess=[err])
        assert assess.assess_item(client, make_item(1), 9, "", [], [], NOW) == ("error", None)
    client = FakeClient(assess=[_validation_error()])
    assert assess.assess_item(client, make_item(1), 9, "", [], [], NOW) == ("unparsed", None)


def test_system_prompts_are_stable_strings():
    # No timestamps or per-run values in the cached prefix.
    for p in (triage.TRIAGE_SYSTEM, assess.ASSESS_SYSTEM):
        assert "{" not in p and "Current time" not in p
    assert "🛢️ LONG Öl (Brent) · USA greifen Iran an · hoch · Tage" in assess.ASSESS_SYSTEM
