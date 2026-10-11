import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../lib/engine.js';
import { demoCandles } from '../lib/demo.js';

const KEYS = ['symbol', 'name', 'asset_class', 'price', 'change_pct', 'score', 'direction', 'confidence', 'summary', 'signals', 'trade_plan', 'metrics', 'updated_at', 'data_source'];

test('analyze returns the Opportunity shape', () => {
  const r = analyze({ symbol: 'aapl', assetClass: 'stock', candles: demoCandles('AAPL', 'stock'), dataSource: 'snapshot', updatedAt: 1700000000 });
  assert.deepEqual(Object.keys(r), KEYS);
  assert.equal(r.symbol, 'AAPL');
  assert.equal(r.name, 'AAPL');
  assert.equal(r.data_source, 'snapshot');
  assert.equal(r.updated_at, 1700000000);
  assert.ok(r.score >= -100 && r.score <= 100);
  assert.equal(r.direction === 'neutral', r.trade_plan === null);
  assert.ok(!('candles' in r) && !('indicators' in r));
});

test('includeSeries adds candles and NaN-free indicator series', () => {
  const r = analyze({ symbol: 'BTCUSDT', assetClass: 'crypto', candles: demoCandles('BTCUSDT', 'crypto'), includeSeries: true });
  assert.equal(r.candles.length, 365);
  assert.deepEqual(Object.keys(r.indicators), ['sma20', 'sma50', 'sma200', 'bb_upper', 'bb_lower', 'rsi', 'macd', 'macd_signal', 'macd_hist']);
  assert.equal(r.indicators.sma200.length, 365 - 199);
  for (const s of Object.values(r.indicators)) for (const p of s) assert.ok(Number.isFinite(p.value));
  JSON.stringify(r, (k, v) => { assert.notEqual(v, undefined); if (typeof v === 'number') assert.ok(Number.isFinite(v), k); return v; });
});

test('analyze throws with fewer than 60 candles', () => {
  assert.throws(() => analyze({ symbol: 'X', assetClass: 'stock', candles: demoCandles('X', 'stock').slice(-59) }), /not enough data/);
});

test('flat series: no signals, neutral, no NaN', () => {
  const candles = Array.from({ length: 100 }, (_, i) => ({ time: i * 86400, open: 10, high: 10, low: 10, close: 10, volume: 0 }));
  const r = analyze({ symbol: 'FLAT', assetClass: 'stock', candles });
  assert.equal(r.direction, 'neutral');
  assert.equal(r.trade_plan, null);
  assert.equal(r.metrics.atr_pct, null);
  assert.equal(r.metrics.volume_ratio, null);
  assert.equal(r.metrics.rsi, 50);
});
