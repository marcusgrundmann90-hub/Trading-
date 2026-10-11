// Analysis engine: candles -> indicators -> signals -> score -> trade plan (Opportunity object).
// Port of backend/app/analysis/engine.py; output matches the Opportunity schema in docs/API.md.

import { computeAll } from './indicators.js';
import { priceDecimals, pyRound, roundPrice, tradePlan } from './risk.js';
import {
  buildSummary, confidenceFor, detectSignals, directionFor, scoreSignals, toDict, window52wStart,
} from './signals.js';

export const MIN_CANDLES = 60;

/** Round a finite number, otherwise null (never NaN/undefined in the output). */
function num(value, decimals = 2) {
  if (value === null || value === undefined) return null;
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  return pyRound(v, decimals);
}

function series(times, values, decimals) {
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isFinite(v)) out.push({ time: times[i], value: pyRound(v, decimals) });
  }
  return out;
}

/** Sort by time, drop rows without a finite close, keep the last row per timestamp. */
function normalizeCandles(candles) {
  const byTime = new Map();
  for (const c of candles || []) {
    if (!c) continue;
    const close = Number(c.close);
    const time = Number(c.time);
    if (!Number.isFinite(close) || !Number.isFinite(time)) continue;
    byTime.set(time, {
      time,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close,
      volume: Number(c.volume),
    });
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/**
 * Analyse one instrument.
 * @param {object} p
 * @param {string} p.symbol
 * @param {string} [p.name]
 * @param {'stock'|'crypto'} p.assetClass
 * @param {{time:number,open:number,high:number,low:number,close:number,volume:number}[]} p.candles
 * @param {number} [p.accountSize=10000]
 * @param {number} [p.riskPct=1]
 * @param {'live'|'snapshot'|'demo'} [p.dataSource='live']
 * @param {number} [p.updatedAt] unix seconds, default now
 * @param {boolean} [p.includeSeries=false] add `candles` and `indicators`
 * @returns {object} Opportunity (snake_case fields as in docs/API.md)
 */
export function analyze({
  symbol,
  name,
  assetClass,
  candles,
  accountSize = 10000.0,
  riskPct = 1.0,
  dataSource = 'live',
  updatedAt,
  includeSeries = false,
}) {
  symbol = String(symbol || '').toUpperCase();
  const rows = normalizeCandles(candles);
  if (rows.length < MIN_CANDLES) {
    throw new Error(`not enough data for ${symbol} (${rows.length} candles, need ${MIN_CANDLES})`);
  }
  accountSize = Number(accountSize);
  riskPct = Number(riskPct);

  const f = computeAll(rows);
  const last = f.length - 1;
  const prevClose = f.close[last - 1];
  const price = f.close[last];
  const pd = priceDecimals(price);

  const signals = detectSignals(f);
  const score = scoreSignals(signals);
  const direction = directionFor(score);

  const atrLast = f.atr[last];
  const atrV = num(atrLast, 12);
  const plan = atrV ? tradePlan(direction, price, atrV, assetClass, accountSize, riskPct) : null;

  const ws = window52wStart(f);
  let hi52 = NaN, lo52 = NaN;
  for (let i = ws; i <= last; i++) {
    if (!Number.isNaN(f.high[i])) hi52 = Number.isNaN(hi52) ? f.high[i] : Math.max(hi52, f.high[i]);
    if (!Number.isNaN(f.low[i])) lo52 = Number.isNaN(lo52) ? f.low[i] : Math.min(lo52, f.low[i]);
  }

  const metrics = {
    rsi: num(f.rsi[last], 1),
    atr: num(atrLast, pd),
    atr_pct: atrV ? num((atrLast / price) * 100, 2) : null,
    volume_ratio: num(f.volume_ratio[last], 2),
    sma20: num(f.sma20[last], pd),
    sma50: num(f.sma50[last], pd),
    sma200: num(f.sma200[last], pd),
    high_52w: num(hi52, pd),
    low_52w: num(lo52, pd),
  };

  let changePct = 0.0;
  if (prevClose) changePct = num((price / prevClose - 1) * 100, 2) ?? 0.0;

  const ts = Number(updatedAt);
  const result = {
    symbol,
    name: name || symbol,
    asset_class: assetClass,
    price: roundPrice(price),
    change_pct: changePct,
    score,
    direction,
    confidence: confidenceFor(score),
    summary: buildSummary(signals, score),
    signals: signals.map(toDict),
    trade_plan: plan,
    metrics,
    updated_at: Number.isFinite(ts) && updatedAt !== null ? Math.trunc(ts) : Math.floor(Date.now() / 1000),
    data_source: dataSource || 'live',
  };

  if (includeSeries) {
    const r = (v, d) => (Number.isFinite(v) ? pyRound(v, d) : 0);
    result.candles = rows.map((c) => ({
      time: c.time,
      open: r(c.open, pd),
      high: r(c.high, pd),
      low: r(c.low, pd),
      close: r(c.close, pd),
      volume: r(c.volume, 2),
    }));
    result.indicators = {
      sma20: series(f.time, f.sma20, pd),
      sma50: series(f.time, f.sma50, pd),
      sma200: series(f.time, f.sma200, pd),
      bb_upper: series(f.time, f.bb_upper, pd),
      bb_lower: series(f.time, f.bb_lower, pd),
      rsi: series(f.time, f.rsi, 2),
      macd: series(f.time, f.macd, pd + 2),
      macd_signal: series(f.time, f.macd_signal, pd + 2),
      macd_hist: series(f.time, f.macd_hist, pd + 2),
    };
  }
  return result;
}
