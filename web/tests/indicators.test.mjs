import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sma, rollingStd, ema, rsi, macd, bollinger, atr, trueRange, volumeRatio, wilder, computeAll } from '../lib/indicators.js';
import { pyRound, formatFixed, priceDecimals, roundPrice, tradePlan } from '../lib/risk.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('sma: NaN until the window is full, then the mean', () => {
  const s = sma([1, 2, 3, 4, 5], 3);
  assert.ok(Number.isNaN(s[0]) && Number.isNaN(s[1]));
  assert.deepEqual(s.slice(2), [2, 3, 4]);
  assert.deepEqual(sma([7, 7, 7, 7], 2).slice(1), [7, 7, 7]); // constant series stays exact
});

test('rollingStd: population std (ddof=0)', () => {
  const s = rollingStd([2, 4, 4, 4, 5, 5, 7, 9], 8);
  near(s[7], 2);
  assert.equal(rollingStd([3, 3, 3], 3)[2], 0);
});

test('ema (adjust=False) with min_periods', () => {
  const e = ema([1, 2, 3, 4], 3); // alpha = 0.5
  assert.ok(Number.isNaN(e[0]) && Number.isNaN(e[1]));
  near(e[2], 2.25);
  near(e[3], 3.125);
});

test('wilder seeds with the mean and then smooths', () => {
  const w = wilder([NaN, 1, 2, 3, 4], 3);
  assert.ok(Number.isNaN(w[2]));
  near(w[3], 2);
  near(w[4], (2 * 2 + 4) / 3);
});

test('rsi: 100 on pure gains, 50 without movement, low on losses', () => {
  const up = Array.from({ length: 30 }, (_, i) => 10 + i);
  assert.equal(rsi(up).at(-1), 100);
  assert.equal(rsi(new Array(30).fill(5)).at(-1), 50);
  const down = up.slice().reverse();
  assert.equal(rsi(down).at(-1), 0);
  assert.ok(Number.isNaN(rsi(up)[13]) && !Number.isNaN(rsi(up)[14]));
});

test('macd / bollinger / atr / volume ratio shapes', () => {
  const close = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 5) * 5);
  const m = macd(close);
  assert.ok(Number.isNaN(m.macd[24]) && !Number.isNaN(m.macd[25]));
  assert.ok(Number.isNaN(m.signal[32]) && !Number.isNaN(m.signal[33]));
  near(m.hist[50], m.macd[50] - m.signal[50]);
  const bb = bollinger(close);
  assert.ok(bb.upper[40] > bb.mid[40] && bb.lower[40] < bb.mid[40]);
  const high = close.map((c) => c + 1), low = close.map((c) => c - 1);
  assert.equal(trueRange(high, low, close)[0], 2);
  assert.ok(atr(high, low, close)[13] > 0);
  const vr = volumeRatio([...new Array(19).fill(100), 300], 20);
  near(vr[19], 300 / 110);
});

test('computeAll returns every column with the input length', () => {
  const candles = Array.from({ length: 70 }, (_, i) => ({ time: i * 86400, open: 10 + i, high: 11 + i, low: 9 + i, close: 10.5 + i, volume: 1000 }));
  const f = computeAll(candles);
  for (const k of ['sma20', 'sma50', 'sma200', 'rsi', 'macd', 'macd_signal', 'macd_hist', 'bb_mid', 'bb_upper', 'bb_lower', 'bb_bandwidth', 'atr', 'volume_ratio']) {
    assert.equal(f[k].length, 70, k);
  }
  assert.ok(f.sma200.every(Number.isNaN));
});

test('pyRound matches Python round() incl. half-even on exact ties', () => {
  assert.equal(pyRound(2.5), 2);
  assert.equal(pyRound(3.5), 4);
  assert.equal(pyRound(0.125, 2), 0.12);
  assert.equal(pyRound(0.375, 2), 0.38);
  assert.equal(pyRound(2.675, 2), 2.67); // binary value is below .675
  assert.equal(pyRound(1.005, 2), 1);
  assert.equal(pyRound(-1.5), -2);
  assert.equal(pyRound(123.456789, 4), 123.4568);
  assert.equal(pyRound(1.23456e-7, 10), 1.235e-7);
  assert.equal(pyRound(-0.001, 2), 0);
  assert.equal(formatFixed(0.25, 1), '0.2');
  assert.equal(formatFixed(73.45, 1), '73.5'); // 73.45 is stored slightly above .45
});

test('priceDecimals / roundPrice', () => {
  assert.equal(priceDecimals(65000), 2);
  assert.equal(priceDecimals(150), 2);
  assert.equal(priceDecimals(5), 3);
  assert.equal(priceDecimals(0.5), 5);
  assert.equal(priceDecimals(0.00001234), 8);
  assert.equal(roundPrice(0.000012345678), 0.00001235);
});

test('tradePlan: long/short, stock whole shares, crypto 6 decimals, capped to account', () => {
  const p = tradePlan('long', 100, 2.5, 'stock', 10000, 1);
  assert.deepEqual(p, { side: 'long', entry: 100, stop_loss: 95, take_profit_1: 105, take_profit_2: 110, risk_reward: 2, risk_per_unit: 5, position_size: 20, position_value: 2000, max_loss: 100 });
  const s = tradePlan('short', 100, 2.5, 'crypto', 10000, 1);
  assert.equal(s.stop_loss, 105);
  assert.equal(s.take_profit_2, 90);
  const capped = tradePlan('long', 100, 0.1, 'stock', 10000, 1); // 500 shares would exceed account
  assert.equal(capped.position_size, 100);
  const c = tradePlan('long', 3, 0.01, 'crypto', 1000, 2);
  assert.equal(c.position_size, 333.333333);
  assert.equal(tradePlan('neutral', 100, 1, 'stock'), null);
  assert.equal(tradePlan('long', 100, 0, 'stock'), null);
  const deep = tradePlan('long', 10, 6, 'stock'); // stop below zero -> risk capped at 95% of entry
  assert.equal(deep.stop_loss, 0.5);
});
