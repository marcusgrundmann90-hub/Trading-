// Parity: web/lib/engine.js must reproduce the Python engine (fixtures from make_fixtures.py).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyze } from '../lib/engine.js';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/parity.json', import.meta.url), 'utf8'),
);

const toCandles = (rows) =>
  rows.map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }));

function close(actual, expected, label, rel = 1e-6) {
  if (expected === null) {
    assert.equal(actual, null, label);
    return;
  }
  assert.equal(typeof actual, 'number', `${label}: not a number`);
  const tol = rel * Math.max(1, Math.abs(expected));
  assert.ok(Math.abs(actual - expected) <= tol, `${label}: ${actual} != ${expected}`);
}

function closeObj(actual, expected, label) {
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${label}: keys`);
  for (const [k, v] of Object.entries(expected)) {
    if (typeof v === 'number' || v === null) close(actual[k], v, `${label}.${k}`);
    else assert.equal(actual[k], v, `${label}.${k}`);
  }
}

test('fixture has several cases with a long/short/neutral mix', () => {
  assert.ok(fixture.cases.length >= 4);
  const dirs = new Set(fixture.cases.map((c) => c.expected.direction));
  assert.ok(dirs.has('long') && dirs.has('short') && dirs.has('neutral'));
});

for (const c of fixture.cases) {
  test(`parity: ${c.symbol} (${c.asset_class})`, () => {
    const exp = c.expected;
    const res = analyze({
      symbol: c.symbol,
      name: c.name,
      assetClass: c.asset_class,
      candles: toCandles(c.candles),
      accountSize: c.account_size,
      riskPct: c.risk_pct,
      dataSource: 'demo',
      updatedAt: 1760000000,
      includeSeries: true,
    });

    // Exact fields
    for (const k of ['symbol', 'name', 'asset_class', 'score', 'direction', 'confidence', 'summary', 'data_source']) {
      assert.equal(res[k], exp[k], k);
    }
    assert.equal(res.updated_at, 1760000000);
    assert.deepEqual(res.signals, exp.signals, 'signals (ids, names, directions, weights, descriptions)');

    // Numbers (rounded identically in both engines; tolerance guards against last-bit noise)
    close(res.price, exp.price, 'price');
    close(res.change_pct, exp.change_pct, 'change_pct');
    closeObj(res.metrics, exp.metrics, 'metrics');
    if (exp.trade_plan === null) assert.equal(res.trade_plan, null, 'trade_plan');
    else closeObj(res.trade_plan, exp.trade_plan, 'trade_plan');

    // Strict equality of the whole Opportunity (without series) – documents bit-level parity.
    const { candles, indicators, ...core } = res;
    const { candles_head, candles_tail, candles_count, indicators: expInd, ...expCore } = exp;
    // (JSON round trip: Python may emit -0.0 where JS emits 0.)
    const norm = (o) => JSON.parse(JSON.stringify(o, (k, v) => (v === 0 ? 0 : v)));
    assert.deepEqual(norm({ ...core, updated_at: 0 }), norm({ ...expCore, updated_at: 0 }));

    // Candles
    assert.equal(candles.length, candles_count);
    assert.deepEqual(norm(candles.slice(0, 3)), norm(candles_head));
    assert.deepEqual(norm(candles.slice(-3)), norm(candles_tail));

    // Indicator series (sampled in the fixture)
    assert.deepEqual(Object.keys(indicators).sort(), Object.keys(expInd).sort());
    for (const [key, s] of Object.entries(expInd)) {
      const got = indicators[key];
      assert.equal(got.length, s.count, `${key}: length`);
      if (s.count) assert.equal(got[0].time, s.first_time, `${key}: first time`);
      for (const [i, time, value] of s.points) {
        assert.equal(got[i].time, time, `${key}[${i}].time`);
        close(got[i].value, value, `${key}[${i}].value`, 1e-9);
      }
      for (const p of got) assert.ok(Number.isFinite(p.value), `${key}: finite values only`);
    }

    // No NaN / undefined anywhere in the output
    const json = JSON.stringify(res, (k, v) => {
      assert.notEqual(v, undefined, `undefined at ${k}`);
      if (typeof v === 'number') assert.ok(Number.isFinite(v), `non-finite at ${k}`);
      return v;
    });
    assert.ok(json.length > 0);
  });
}
