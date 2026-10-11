// Data layer: Binance (crypto, live), stock snapshot (./data/stocks.json, built by CI), demo fallback.
// See docs/WEB.md. All paths are relative so the app works under the GitHub Pages sub-path.

import { demoCandles, DEMO_CRYPTO } from './demo.js';

export const BINANCE_HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com'];
export const FETCH_TIMEOUT_MS = 10000;
export const CANDLE_CACHE_TTL_MS = 5 * 60 * 1000;
const SNAPSHOT_URL = './data/stocks.json';
const UNIVERSE_URL = './data/universe.json';

const STABLE_BASES = new Set([
  'USDC', 'FDUSD', 'TUSD', 'USDP', 'DAI', 'EUR', 'BUSD', 'USDE', 'PYUSD', 'AEUR', 'EURI',
  'USD1', 'XUSD', 'BFUSD', 'RLUSD', 'USDS', 'GBP', 'UST', 'SUSD', 'PAX', 'PAXG',
]);
// Bases of Binance's (former) leveraged tokens, e.g. BTCUP / ETHDOWN / BNBBULL / XRPBEAR.
const LEVERAGED_PREFIXES = new Set([
  'BTC', 'ETH', 'BNB', 'XRP', 'ADA', 'DOT', 'LINK', 'TRX', 'XTZ', 'EOS', 'LTC', 'YFI', 'SXP',
  'FIL', 'SUSHI', 'UNI', 'AAVE', '1INCH', 'XLM', 'BCH',
]);

let demoMode = false;
let snapshotCache = null; // resolved snapshot object (only successful loads are cached)
let snapshotPromise = null;
let universeCache = null;
const candleCache = new Map(); // key -> {at, value}

export function setDemoMode(on) {
  const next = Boolean(on);
  if (next !== demoMode) candleCache.clear();
  demoMode = next;
}

export function isDemoMode() {
  return demoMode;
}

/** Drop all in-memory caches (snapshot, universe, candles). */
export function clearCache() {
  snapshotCache = null;
  snapshotPromise = null;
  universeCache = null;
  candleCache.clear();
}

class HttpError extends Error {
  constructor(status, url) {
    super(`HTTP ${status} for ${url}`);
    this.status = status;
  }
}

async function fetchJson(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, ctrl ? { signal: ctrl.signal } : undefined);
    if (!res.ok) throw new HttpError(res.status, url);
    return await res.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Try each Binance host in turn; an HTTP 400 (unknown symbol) is final. */
async function binance(pathAndQuery) {
  let lastErr;
  for (const host of BINANCE_HOSTS) {
    try {
      return await fetchJson(host + pathAndQuery);
    } catch (err) {
      if (err instanceof HttpError && err.status === 400) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

const nowSec = () => Math.floor(Date.now() / 1000);

/** Compact rows [t,o,h,l,c,v] -> sorted candle objects; rows without a finite close are dropped. */
export function rowsToCandles(rows) {
  const byTime = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!Array.isArray(r) || r.length < 5) continue;
    if (r[0] === null || r[4] === null) continue;
    const time = Number(r[0]);
    const close = Number(r[4]);
    if (!Number.isFinite(time) || !Number.isFinite(close)) continue;
    const num = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? close : Number(v));
    const vol = Number(r[5]);
    byTime.set(time, {
      time, open: num(r[1]), high: num(r[2]), low: num(r[3]), close,
      volume: Number.isFinite(vol) ? vol : 0,
    });
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/** Parse the raw stocks.json payload into {generatedAt, source, symbols, errors}. */
export function parseSnapshot(raw) {
  const symbols = {};
  const src = raw && typeof raw.symbols === 'object' && raw.symbols ? raw.symbols : {};
  for (const [sym, entry] of Object.entries(src)) {
    if (!entry) continue;
    const candles = rowsToCandles(entry.candles);
    if (!candles.length) continue;
    symbols[sym.toUpperCase()] = {
      name: entry.name || sym,
      region: entry.region || null,
      currency: entry.currency || null,
      candles,
    };
  }
  const gen = Number(raw && raw.generated_at);
  return {
    generatedAt: Number.isFinite(gen) && gen > 0 ? Math.trunc(gen) : null,
    source: (raw && raw.source) || 'yahoo',
    symbols,
    errors: Array.isArray(raw && raw.errors) ? raw.errors : [],
  };
}

const UNAVAILABLE = () => ({ generatedAt: null, source: 'unavailable', symbols: {}, errors: [] });

export async function loadStocksSnapshot() {
  if (snapshotCache) return snapshotCache;
  if (!snapshotPromise) {
    snapshotPromise = (async () => {
      try {
        const snap = parseSnapshot(await fetchJson(SNAPSHOT_URL));
        snapshotCache = snap;
        return snap;
      } catch {
        return UNAVAILABLE();
      } finally {
        snapshotPromise = null;
      }
    })();
  }
  return snapshotPromise;
}

export async function loadUniverse() {
  if (universeCache) return universeCache;
  try {
    const raw = await fetchJson(UNIVERSE_URL);
    const list = (raw && Array.isArray(raw.stocks) ? raw.stocks : [])
      .filter((s) => s && s.symbol)
      .map((s) => ({ symbol: String(s.symbol).toUpperCase(), name: s.name || s.symbol, region: s.region || null }));
    universeCache = list;
    return list;
  } catch {
    return [];
  }
}

function klinesToCandles(rows) {
  if (!Array.isArray(rows)) return [];
  return rowsToCandles(
    rows.map((r) => [Math.floor(Number(r[0]) / 1000), r[1], r[2], r[3], r[4], r[5]].map(Number)),
  );
}

function demoResult(symbol, assetClass) {
  return { candles: demoCandles(symbol, assetClass), dataSource: 'demo', updatedAt: nowSec() };
}

/**
 * Candles for one instrument.
 * @returns {Promise<{candles: object[], dataSource: 'live'|'snapshot'|'demo', updatedAt: number|null,
 *   currency?: string|null, name?: string}>}
 */
export async function loadCandles(symbol, assetClass) {
  symbol = String(symbol || '').trim().toUpperCase();
  if (!symbol) throw new Error('symbol required');
  const key = `${demoMode ? 'demo' : 'real'}:${assetClass}:${symbol}`;
  const hit = candleCache.get(key);
  if (hit && Date.now() - hit.at < CANDLE_CACHE_TTL_MS) return hit.value;

  let value;
  if (demoMode) {
    value = demoResult(symbol, assetClass);
  } else if (assetClass === 'crypto') {
    try {
      const rows = await binance(`/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=1d&limit=365`);
      const candles = klinesToCandles(rows);
      if (!candles.length) throw new Error(`no klines for ${symbol}`);
      value = { candles, dataSource: 'live', updatedAt: nowSec(), currency: 'USDT' };
    } catch (err) {
      if (err instanceof HttpError && err.status === 400) {
        throw new Error(`Unbekanntes Binance-Paar: ${symbol}`);
      }
      value = demoResult(symbol, assetClass); // network failure -> demo data
    }
  } else {
    const snap = await loadStocksSnapshot();
    const entry = snap.symbols[symbol];
    if (!entry) throw new Error(`Keine Kursdaten für ${symbol} im Aktien-Snapshot`);
    // Snapshot entries are not copied per call; treat candles as read-only.
    return {
      candles: entry.candles,
      dataSource: snap.source === 'demo' ? 'demo' : 'snapshot',
      updatedAt: snap.generatedAt,
      currency: entry.currency,
      name: entry.name,
    };
  }
  candleCache.set(key, { at: Date.now(), value });
  return value;
}

/** Whether a symbol is a regular USDT spot pair worth scanning (no stablecoins / leveraged tokens). */
export function isScannableUsdtPair(symbol) {
  if (!/^[A-Z0-9]+USDT$/.test(symbol)) return false;
  const base = symbol.slice(0, -4);
  if (!base || STABLE_BASES.has(base)) return false;
  const m = base.match(/^(.+?)(UP|DOWN|BULL|BEAR)$/);
  if (m && LEVERAGED_PREFIXES.has(m[1])) return false;
  return true;
}

export async function topCryptoSymbols(n = 25) {
  const fallback = () => DEMO_CRYPTO.slice(0, n).map((x) => ({ ...x }));
  if (demoMode) return fallback();
  try {
    const tickers = await binance('/api/v3/ticker/24hr');
    if (!Array.isArray(tickers)) throw new Error('unexpected ticker payload');
    const list = tickers
      .filter((t) => t && isScannableUsdtPair(t.symbol) && Number(t.quoteVolume) > 0)
      .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
      .slice(0, n)
      .map((t) => ({ symbol: t.symbol, name: t.symbol.slice(0, -4) }));
    return list.length ? list : fallback();
  } catch {
    return fallback();
  }
}

export async function validateCryptoSymbol(symbol) {
  symbol = String(symbol || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{2,20}$/.test(symbol)) return false;
  if (demoMode) return /USDT$/.test(symbol);
  try {
    const rows = await binance(`/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=1d&limit=1`);
    return Array.isArray(rows) && rows.length > 0;
  } catch {
    return false;
  }
}
