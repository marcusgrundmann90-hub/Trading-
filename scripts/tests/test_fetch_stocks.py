"""Tests for scripts/fetch_stocks.py (no network; urlopen is mocked).

Run: python -m unittest discover -s scripts/tests   (or: python -m pytest scripts/tests)
"""
from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import fetch_stocks as fs  # noqa: E402

SAMPLE = json.loads((HERE / "fixtures" / "yahoo_chart_sap.json").read_text(encoding="utf-8"))


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


def fake_urlopen_factory(payload_by_symbol: dict, calls: list | None = None):
    def fake_urlopen(req, timeout=None):
        url = req.full_url
        if calls is not None:
            calls.append((url, req.get_header("User-agent"), timeout))
        sym = url.split("/chart/")[1].split("?")[0]
        sym = urllib.parse.unquote(sym)
        payload = payload_by_symbol.get(sym)
        if payload is None:
            raise urllib.error.HTTPError(url, 404, "Not Found", {}, None)
        if isinstance(payload, Exception):
            raise payload
        return FakeResponse(json.dumps(payload).encode())

    return fake_urlopen


import urllib.parse  # noqa: E402


class ParseChartTest(unittest.TestCase):
    def test_parses_sample_drops_nulls_and_dedups(self):
        currency, candles = fs.parse_chart(SAMPLE)
        self.assertEqual(currency, "EUR")
        # 7 rows: one with null open dropped, duplicate last timestamp merged -> 5
        self.assertEqual(len(candles), 5)
        ts = [c[0] for c in candles]
        self.assertEqual(ts, sorted(ts))
        self.assertEqual(len(set(ts)), len(ts))
        first = candles[0]
        self.assertEqual(first, [1757916000, 230.1, 233.0, 229.5, 232.12, 1234567])
        # null volume becomes 0
        self.assertEqual(candles[2][5], 0)
        self.assertEqual(candles[2][3], 227.2)
        # duplicate live bar: the later row wins
        self.assertEqual(candles[-1][4], 233.15)
        for c in candles:
            self.assertEqual(len(c), 6)
            self.assertIsInstance(c[5], int)

    def test_keeps_last_n(self):
        _, candles = fs.parse_chart(SAMPLE, max_candles=2)
        self.assertEqual(len(candles), 2)
        self.assertEqual(candles[-1][4], 233.15)

    def test_error_payload(self):
        with self.assertRaises(fs.FetchError):
            fs.parse_chart({"chart": {"result": None, "error": {"code": "Not Found", "description": "No data found"}}})
        with self.assertRaises(fs.FetchError):
            fs.parse_chart({"chart": {"result": [], "error": None}})

    def test_round_price(self):
        self.assertEqual(fs.round_price(232.1199951171875), 232.12)
        self.assertEqual(fs.round_price(5.123456), 5.1235)
        self.assertEqual(fs.round_price(0.000123456), 0.0001235)


class FetchAllTest(unittest.TestCase):
    def setUp(self):
        # no sleeping in tests
        patcher = mock.patch.object(fs.time, "sleep", lambda s: None)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_fetch_all_success_and_errors(self):
        calls: list = []
        universe = [
            {"symbol": "SAP.DE", "name": "SAP", "region": "DE"},
            {"symbol": "NOVO-B.CO", "name": "Novo Nordisk", "region": "EU"},
            {"symbol": "BAD", "name": "Bad", "region": "US"},
        ]
        payloads = {"SAP.DE": SAMPLE, "NOVO-B.CO": SAMPLE}
        with mock.patch.object(fs.urllib.request, "urlopen", fake_urlopen_factory(payloads, calls)):
            data = fs.fetch_all(universe, workers=2)
        self.assertEqual(data["source"], "yahoo")
        self.assertEqual(sorted(data["symbols"]), ["NOVO-B.CO", "SAP.DE"])
        self.assertEqual(data["errors"], ["BAD"])
        sap = data["symbols"]["SAP.DE"]
        self.assertEqual(sap["name"], "SAP")
        self.assertEqual(sap["region"], "DE")
        self.assertEqual(sap["currency"], "EUR")
        self.assertEqual(len(sap["candles"]), 5)
        url, ua, timeout = calls[0]
        self.assertIn("query1.finance.yahoo.com/v8/finance/chart/", url)
        self.assertIn("range=1y&interval=1d", url)
        self.assertIn("Mozilla", ua)
        self.assertEqual(timeout, 15)

    def test_retries_then_falls_back_to_query2(self):
        calls: list = []

        def flaky(req, timeout=None):
            calls.append(req.full_url)
            if "query1" in req.full_url:
                raise urllib.error.URLError("boom")
            return FakeResponse(json.dumps(SAMPLE).encode())

        with mock.patch.object(fs.urllib.request, "urlopen", flaky):
            currency, candles = fs.fetch_symbol("SAP.DE")
        self.assertEqual(currency, "EUR")
        self.assertEqual(len(candles), 5)
        q1 = [c for c in calls if "query1" in c]
        self.assertEqual(len(q1), fs.RETRIES + 1)
        self.assertIn("query2", calls[-1])

    def test_main_exits_nonzero_when_majority_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            uni = Path(tmp) / "universe.json"
            out = Path(tmp) / "stocks.json"
            uni.write_text(json.dumps({"stocks": [
                {"symbol": "SAP.DE", "name": "SAP", "region": "DE"},
                {"symbol": "X1", "name": "X1", "region": "US"},
                {"symbol": "X2", "name": "X2", "region": "US"},
            ]}))
            with mock.patch.object(fs.urllib.request, "urlopen", fake_urlopen_factory({"SAP.DE": SAMPLE})), \
                    mock.patch("sys.stdout", new=io.StringIO()), mock.patch("sys.stderr", new=io.StringIO()):
                rc = fs.main(["--universe", str(uni), "--out", str(out)])
            self.assertEqual(rc, 1)
            self.assertFalse(out.exists())

    def test_main_writes_compact_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            uni = Path(tmp) / "universe.json"
            out = Path(tmp) / "stocks.json"
            uni.write_text(json.dumps({"stocks": [
                {"symbol": "SAP.DE", "name": "SAP", "region": "DE"},
                {"symbol": "AAPL", "name": "Apple", "region": "US"},
                {"symbol": "X2", "name": "X2", "region": "US"},
            ]}))
            payloads = {"SAP.DE": SAMPLE, "AAPL": SAMPLE}
            with mock.patch.object(fs.urllib.request, "urlopen", fake_urlopen_factory(payloads)), \
                    mock.patch("sys.stdout", new=io.StringIO()), mock.patch("sys.stderr", new=io.StringIO()):
                rc = fs.main(["--universe", str(uni), "--out", str(out)])
            self.assertEqual(rc, 0)
            text = out.read_text()
            self.assertNotIn(" ", text.replace("Apple", ""))
            data = json.loads(text)
            self.assertEqual(data["errors"], ["X2"])
            self.assertIsInstance(data["generated_at"], int)


class DemoTest(unittest.TestCase):
    def test_demo_is_deterministic_and_complete(self):
        universe = fs.load_universe(fs.DEFAULT_UNIVERSE)
        a = fs.build_demo(universe, end_ts=1760000000)
        b = fs.build_demo(universe, end_ts=1760000000)
        self.assertEqual(a["symbols"], b["symbols"])
        self.assertEqual(a["source"], "demo")
        self.assertEqual(set(a["symbols"]), {u["symbol"] for u in universe})
        for sym, entry in a["symbols"].items():
            c = entry["candles"]
            self.assertEqual(len(c), fs.MAX_CANDLES, sym)
            self.assertEqual([r[0] for r in c], sorted(r[0] for r in c))
            for t, o, h, l, cl, v in c:
                self.assertTrue(l <= min(o, cl) <= max(o, cl) <= h, sym)
                self.assertGreater(l, 0)


class UniverseTest(unittest.TestCase):
    def test_universe_shape(self):
        data = json.loads(fs.DEFAULT_UNIVERSE.read_text(encoding="utf-8"))
        stocks = data["stocks"]
        syms = [s["symbol"] for s in stocks]
        self.assertEqual(len(syms), len(set(syms)))
        self.assertEqual(sum(1 for s in stocks if s["region"] == "DE"), 40)
        for s in stocks:
            self.assertIn(s["region"], {"DE", "EU", "US"})
            self.assertTrue(s["name"])
            if s["region"] == "DE":
                self.assertTrue(s["symbol"].endswith(".DE"))


if __name__ == "__main__":
    unittest.main()
