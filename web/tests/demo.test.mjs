import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoCandles, hashString, mulberry32, todayUtcMidnight } from '../lib/demo.js';
import { analyze } from '../lib/engine.js';

test('hash and PRNG are deterministic', () => {
  assert.equal(hashString('AAPL'), hashString('AAPL'));
  assert.notEqual(hashString('AAPL'), hashString('MSFT'));
  const a = mulberry32(42), b = mulberry32(42);
  for (let i = 0; i < 5; i++) assert.equal(a(), b());
});

test('demoCandles is deterministic per symbol and asset class', () => {
  const end = 1760000000 - (1760000000 % 86400);
  assert.deepEqual(demoCandles('AAPL', 'stock', { end }), demoCandles('aapl', 'stock', { end }));
  assert.notDeepEqual(demoCandles('AAPL', 'stock', { end }), demoCandles('MSFT', 'stock', { end }));
  assert.notDeepEqual(demoCandles('AAPL', 'stock', { end }), demoCandles('AAPL', 'crypto', { end }));
});

test('365 valid daily candles ending today 00:00 UTC', () => {
  const c = demoCandles('ETHUSDT', 'crypto');
  assert.equal(c.length, 365);
  assert.equal(c.at(-1).time, todayUtcMidnight());
  assert.equal(c.at(-1).time % 86400, 0);
  for (let i = 0; i < c.length; i++) {
    const k = c[i];
    if (i) assert.equal(k.time - c[i - 1].time, 86400);
    assert.ok(k.low > 0 && k.low <= Math.min(k.open, k.close) && k.high >= Math.max(k.open, k.close));
    assert.ok(Number.isInteger(k.volume) && k.volume > 0);
  }
});

test('anchors give realistic prices, tiny coins keep precision', () => {
  const btc = demoCandles('BTCUSDT', 'crypto').at(-1).close;
  assert.ok(btc > 50000 && btc < 80000, String(btc));
  const pepe = demoCandles('PEPEUSDT', 'crypto').at(-1).close;
  assert.ok(pepe > 5e-6 && pepe < 2e-5, String(pepe));
});

test('default watchlist shows a mix of long, short and neutral setups', () => {
  const wl = [['AAPL', 'stock'], ['MSFT', 'stock'], ['NVDA', 'stock'], ['SAP.DE', 'stock'], ['ALV.DE', 'stock'], ['BTCUSDT', 'crypto'], ['ETHUSDT', 'crypto'], ['SOLUSDT', 'crypto']];
  const dirs = wl.map(([s, a]) => analyze({ symbol: s, assetClass: a, candles: demoCandles(s, a) }).direction);
  for (const d of ['long', 'short', 'neutral']) assert.ok(dirs.includes(d), `${d} missing: ${dirs}`);
});
