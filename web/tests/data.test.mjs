import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadStocksSnapshot, loadUniverse, loadCandles, topCryptoSymbols, validateCryptoSymbol,
  setDemoMode, clearCache, parseSnapshot, isScannableUsdtPair,
} from '../lib/data.js';

const realFetch = globalThis.fetch;
let calls;

/** Install a fake fetch: routes maps URL substrings to a JSON body, a status number, or an Error. */
function mockFetch(routes) {
  calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    for (const [frag, val] of Object.entries(routes)) {
      if (!String(url).includes(frag)) continue;
      const v = typeof val === 'function' ? val(url) : val;
      if (v instanceof Error) throw v;
      if (typeof v === 'number') return { ok: false, status: v, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => structuredClone(v) };
    }
    throw new TypeError('network down');
  };
}

const SNAPSHOT = {
  generated_at: 1760000000,
  source: 'yahoo',
  symbols: {
    'SAP.DE': { name: 'SAP', region: 'DE', currency: 'EUR',
      candles: [[1760086400, 2, 3, 1, 2.5, 20], [1760000000, 1, 2, 0.5, 1.5, 10], [1760172800, 2.5, 3, 2, null, 5]] },
    'SHEL.L': { name: 'Shell', region: 'EU', currency: 'GBp', candles: [[1760000000, 2700, 2710, 2690, 2705.5, 1000]] },
    EMPTY: { name: 'x', candles: [] },
  },
  errors: ['XYZ'],
};

const kline = (tMs, c) => [tMs, String(c), String(c * 1.01), String(c * 0.99), String(c), '123.5', tMs + 86399999, '0', 1, '0', '0', '0'];

beforeEach(() => { clearCache(); setDemoMode(false); });
afterEach(() => { globalThis.fetch = realFetch; setDemoMode(false); });

test('parseSnapshot converts compact rows to sorted candle objects', () => {
  const s = parseSnapshot(SNAPSHOT);
  assert.equal(s.generatedAt, 1760000000);
  assert.equal(s.source, 'yahoo');
  assert.deepEqual(s.errors, ['XYZ']);
  assert.deepEqual(Object.keys(s.symbols).sort(), ['SAP.DE', 'SHEL.L']);
  assert.deepEqual(s.symbols['SAP.DE'].candles, [
    { time: 1760000000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
    { time: 1760086400, open: 2, high: 3, low: 1, close: 2.5, volume: 20 },
  ]);
  assert.equal(s.symbols['SHEL.L'].currency, 'GBp');
});

test('loadStocksSnapshot fetches ./data/stocks.json once and caches it', async () => {
  mockFetch({ 'data/stocks.json': SNAPSHOT });
  const a = await loadStocksSnapshot();
  const b = await loadStocksSnapshot();
  assert.equal(a, b);
  assert.deepEqual(calls, ['./data/stocks.json']);
  assert.equal(a.symbols['SAP.DE'].name, 'SAP');
});

test('loadStocksSnapshot reports unavailable on error (and retries later)', async () => {
  mockFetch({ 'data/stocks.json': 404 });
  assert.deepEqual(await loadStocksSnapshot(), { generatedAt: null, source: 'unavailable', symbols: {}, errors: [] });
  mockFetch({ 'data/stocks.json': SNAPSHOT });
  assert.equal((await loadStocksSnapshot()).source, 'yahoo');
});

test('loadUniverse', async () => {
  mockFetch({ 'data/universe.json': { stocks: [{ symbol: 'SAP.DE', name: 'SAP', region: 'DE' }, { name: 'broken' }] } });
  assert.deepEqual(await loadUniverse(), [{ symbol: 'SAP.DE', name: 'SAP', region: 'DE' }]);
  assert.deepEqual(calls, ['./data/universe.json']);
});

test('loadCandles(stock) uses the snapshot; unknown symbols throw', async () => {
  mockFetch({ 'data/stocks.json': SNAPSHOT });
  const r = await loadCandles('sap.de', 'stock');
  assert.equal(r.dataSource, 'snapshot');
  assert.equal(r.updatedAt, 1760000000);
  assert.equal(r.currency, 'EUR');
  assert.equal(r.candles.length, 2);
  await assert.rejects(loadCandles('NOPE', 'stock'));
});

test('loadCandles(stock) from a demo snapshot reports dataSource demo', async () => {
  mockFetch({ 'data/stocks.json': { ...SNAPSHOT, source: 'demo' } });
  assert.equal((await loadCandles('SAP.DE', 'stock')).dataSource, 'demo');
});

test('loadCandles(crypto): data-api first, cached for 5 minutes', async () => {
  mockFetch({ 'data-api.binance.vision/api/v3/klines': [kline(1760000000000, 100), kline(1760086400000, 101)] });
  const r = await loadCandles('btcusdt', 'crypto');
  assert.equal(r.dataSource, 'live');
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^https:\/\/data-api\.binance\.vision\/api\/v3\/klines\?symbol=BTCUSDT&interval=1d&limit=365$/);
  assert.deepEqual(r.candles[0], { time: 1760000000, open: 100, high: 101, low: 99, close: 100, volume: 123.5 });
  await loadCandles('BTCUSDT', 'crypto');
  assert.equal(calls.length, 1);
});

test('loadCandles(crypto): falls back to api.binance.com, then to demo data', async () => {
  mockFetch({ 'data-api.binance.vision': 503, 'api.binance.com/api/v3/klines': [kline(1760000000000, 5)] });
  assert.equal((await loadCandles('ETHUSDT', 'crypto')).dataSource, 'live');
  assert.equal(calls.length, 2);
  clearCache();
  mockFetch({});
  const d = await loadCandles('ETHUSDT', 'crypto');
  assert.equal(d.dataSource, 'demo');
  assert.equal(d.candles.length, 365);
});

test('loadCandles(crypto): unknown pair (HTTP 400) throws', async () => {
  mockFetch({ 'binance': 400 });
  await assert.rejects(loadCandles('FOOBARUSDT', 'crypto'), /Unbekanntes Binance-Paar/);
});

test('demo mode never touches the network', async () => {
  mockFetch({});
  setDemoMode(true);
  const s = await loadCandles('AAPL', 'stock');
  const c = await loadCandles('SOLUSDT', 'crypto');
  assert.equal(s.dataSource, 'demo');
  assert.equal(c.dataSource, 'demo');
  assert.equal((await topCryptoSymbols(5)).length, 5);
  assert.equal(await validateCryptoSymbol('SOLUSDT'), true);
  assert.deepEqual(calls, []);
});

test('topCryptoSymbols sorts by quote volume and filters stables and leveraged tokens', async () => {
  const t = (symbol, quoteVolume) => ({ symbol, quoteVolume: String(quoteVolume) });
  mockFetch({ 'ticker/24hr': [
    t('ETHUSDT', 500), t('BTCUSDT', 900), t('USDCUSDT', 5000), t('FDUSDUSDT', 4000), t('BTCUPUSDT', 800),
    t('ETHDOWNUSDT', 700), t('BTCEUR', 10000), t('JUPUSDT', 50), t('SOLUSDT', 300), t('DEADUSDT', 0),
  ] });
  assert.deepEqual(await topCryptoSymbols(3), [
    { symbol: 'BTCUSDT', name: 'BTC' }, { symbol: 'ETHUSDT', name: 'ETH' }, { symbol: 'SOLUSDT', name: 'SOL' },
  ]);
  assert.deepEqual((await topCryptoSymbols(10)).map((x) => x.symbol), ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'JUPUSDT']);
  assert.ok(isScannableUsdtPair('JUPUSDT'));
  assert.ok(!isScannableUsdtPair('DAIUSDT'));
  assert.ok(!isScannableUsdtPair('BNBBULLUSDT'));
});

test('topCryptoSymbols falls back to a fixed list offline', async () => {
  mockFetch({});
  const list = await topCryptoSymbols(25);
  assert.equal(list.length, 25);
  assert.deepEqual(list[0], { symbol: 'BTCUSDT', name: 'BTC' });
});

test('validateCryptoSymbol', async () => {
  mockFetch({ 'symbol=BTCUSDT': [kline(1760000000000, 1)], 'symbol=NOPEUSDT': 400 });
  assert.equal(await validateCryptoSymbol('btcusdt'), true);
  assert.match(calls[0], /limit=1$/);
  assert.equal(await validateCryptoSymbol('NOPEUSDT'), false);
  assert.equal(await validateCryptoSymbol('bad symbol!'), false);
});
