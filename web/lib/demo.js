// Deterministic synthetic OHLCV for demo/offline mode.
// Idea ported from backend DemoProvider: seeded geometric Brownian motion with regime changes and a
// shaped "setup" at the end (breakout, breakdown, pullback, …) so demo scans show varied results.
// Not numerically identical to the Python version.

const DAY = 86400;

// Salt for the demo seeds; chosen so the default watchlist shows a mix of long/short/neutral.
export const DEMO_SALT = 's6';

// Realistic price anchors for well-known symbols.
const ANCHORS = {
  AAPL: 190, MSFT: 420, NVDA: 120, AMZN: 185, TSLA: 240, GOOGL: 170, META: 500,
  'SAP.DE': 230, 'ALV.DE': 300, 'SIE.DE': 180, 'DTE.DE': 23,
  BTCUSDT: 65000, ETHUSDT: 3200, SOLUSDT: 150, BNBUSDT: 580,
  XRPUSDT: 0.55, ADAUSDT: 0.45, DOGEUSDT: 0.12, PEPEUSDT: 0.00001,
};

export const SCENARIOS = [
  'breakout', 'breakdown', 'pullback', 'rally',
  'oversold_bounce', 'overbought_fade', 'squeeze', 'random',
];

/** cyrb53 string hash -> 53-bit integer. */
export function hashString(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** mulberry32 PRNG -> function returning floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seed) {
  const rand = mulberry32(seed);
  let spare = null;
  const normal = (mu = 0, sigma = 1) => {
    if (spare !== null) {
      const z = spare;
      spare = null;
      return mu + sigma * z;
    }
    let u = 0;
    while (u === 0) u = rand();
    const v = rand();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return mu + sigma * r * Math.cos(2 * Math.PI * v);
  };
  return {
    random: rand,
    uniform: (lo, hi) => lo + (hi - lo) * rand(),
    int: (lo, hi) => lo + Math.floor(rand() * (hi - lo)), // [lo, hi)
    normal,
    lognormal: (mu, sigma) => Math.exp(normal(mu, sigma)),
    choice: (arr) => arr[Math.floor(rand() * arr.length)],
  };
}

const seedFor = (symbol, assetClass) => hashString(`${DEMO_SALT}|${symbol}|${assetClass}`);
const clip = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** Start of the current UTC day in unix seconds. */
export function todayUtcMidnight(nowMs = Date.now()) {
  return Math.floor(nowMs / 1000 / DAY) * DAY;
}

/**
 * Deterministic demo candles for a symbol.
 * @param {string} symbol
 * @param {'stock'|'crypto'} [assetClass='stock']
 * @param {{n?: number, end?: number}} [opts] n candles (default 365); end = time of the last candle
 *   in unix seconds (default: today 00:00 UTC)
 * @returns {{time:number,open:number,high:number,low:number,close:number,volume:number}[]}
 */
export function demoCandles(symbol, assetClass = 'stock', opts = {}) {
  symbol = String(symbol).toUpperCase();
  const n = opts.n ?? 365;
  const end = opts.end ?? todayUtcMidnight();
  const rng = makeRng(seedFor(symbol, assetClass) % 4294967296);
  const crypto = assetClass === 'crypto';
  const dv = crypto ? 0.03 : 0.017;
  const trendK = crypto ? 0.65 : 1.0;

  // Regimes: piecewise drift/volatility segments (trend up, trend down, sideways).
  const drift = new Array(n).fill(0);
  const vol = new Array(n).fill(dv);
  for (let i = 0; i < n; ) {
    const len = rng.int(25, 110);
    const r = rng.random();
    const kind = r < 0.4 ? 'up' : r < 0.7 ? 'down' : 'side';
    const strength = rng.uniform(0.6, 1.8);
    const d = kind === 'up' ? dv * 0.12 * trendK * strength : kind === 'down' ? -dv * 0.12 * trendK * strength : 0;
    const v = dv * rng.uniform(0.6, 1.4) * (kind === 'side' ? 0.6 : 1.0);
    for (let j = i; j < Math.min(n, i + len); j++) {
      drift[j] = d;
      vol[j] = v;
    }
    i += len;
  }

  const shocks = Array.from({ length: n }, () => rng.normal());
  const jumps = Array.from({ length: n }, () => rng.random() < 0.03);
  const jumpSize = jumps.map((j) => (j ? rng.normal(0, dv * 3.0) : 0));
  const volBoost = new Array(n).fill(1);

  // Shape the most recent bars into a recognisable setup (indices relative to the end).
  const from = (k) => Math.max(0, n - k);
  const range = (a, b, fn) => { for (let i = from(a); i < n - b; i++) fn(i); };
  const scenario = rng.choice(SCENARIOS);
  if (scenario === 'breakout' || scenario === 'breakdown') {
    const sgn = scenario === 'breakout' ? 1 : -1;
    range(120, 0, (i) => { drift[i] = sgn * dv * 0.2 * trendK; vol[i] = dv * 0.8; });
    range(25, 2, (i) => { shocks[i] = clip(shocks[i], -0.8, 0.8); });
    range(25, 0, (i) => { jumpSize[i] = 0; });
    [1.6, 2.2].forEach((m, k) => {
      const i = n - 2 + k;
      shocks[i] = 0;
      jumpSize[i] = sgn * dv * m;
      volBoost[i] = 3.0;
    });
  } else if (scenario === 'pullback' || scenario === 'rally') {
    const sgn = scenario === 'pullback' ? 1 : -1;
    range(200, 12, (i) => { drift[i] = sgn * dv * 0.18 * trendK; });
    range(200, 0, (i) => { vol[i] = dv * 0.7; });
    range(12, 0, (i) => { drift[i] = -sgn * dv * 0.45; shocks[i] = clip(shocks[i], -0.5, 0.5); });
    range(30, 0, (i) => { jumpSize[i] = 0; });
  } else if (scenario === 'oversold_bounce' || scenario === 'overbought_fade') {
    const sgn = scenario === 'oversold_bounce' ? 1 : -1;
    range(26, 3, (i) => { drift[i] = -sgn * dv * 0.75; shocks[i] = clip(shocks[i], -0.7, 0.7); });
    range(26, 0, (i) => { jumpSize[i] = 0; });
    [[0.6, 1.5], [1.2, 2.0], [1.6, 3.0]].forEach(([m, b], k) => {
      const i = n - 3 + k;
      shocks[i] = 0;
      jumpSize[i] = sgn * dv * m;
      volBoost[i] = b;
    });
  } else if (scenario === 'squeeze') {
    range(45, 0, (i) => { drift[i] = 0; vol[i] = dv * 0.3; jumpSize[i] = 0; });
  }

  const logRet = drift.map((d, i) => (i === 0 ? 0 : d - 0.5 * vol[i] ** 2 + vol[i] * shocks[i] + jumpSize[i]));
  const path = new Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += logRet[i];
    path[i] = Math.exp(acc);
  }

  let anchor = ANCHORS[symbol];
  if (anchor === undefined) {
    const h = hashString(`${symbol}|anchor`) % 10000;
    anchor = crypto ? 10 ** ((h % 600) / 100 - 2) : 5 + (h % 500);
  }
  const scale = (anchor / path[n - 1]) * rng.uniform(0.9, 1.1);
  const close = path.map((p) => p * scale);

  const baseVolume = (crypto ? 2e4 : 5e6) * (1 + (hashString(`${symbol}|vol`) % 50) / 10);
  const candles = [];
  for (let i = 0; i < n; i++) {
    const gap = rng.normal(0, vol[i] * 0.3);
    const open = i === 0 ? close[0] * (1 + gap) : close[i - 1] * (1 + gap);
    const high = Math.max(open, close[i]) * (1 + Math.abs(rng.normal(0, vol[i] * 0.5)));
    const low = Math.min(open, close[i]) * (1 - Math.abs(rng.normal(0, vol[i] * 0.5)));
    const absMove = Math.abs(logRet[i]) / dv;
    const volume = baseVolume * rng.lognormal(0, 0.3) * (1 + 0.6 * absMove) * (jumps[i] ? 2.5 : 1) * volBoost[i];
    candles.push({
      time: end - (n - 1 - i) * DAY,
      open: sig(open),
      high: sig(high),
      low: sig(low),
      close: sig(close[i]),
      volume: Math.round(volume),
    });
  }
  return candles;
}

/** Round to 6 significant digits (keeps tiny crypto prices meaningful). */
function sig(x) {
  return Number(x.toPrecision(6));
}

/** Fixed fallback list for the market view when Binance is unreachable. */
export const DEMO_CRYPTO = [
  'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'TRX', 'AVAX', 'LINK', 'DOT', 'TON', 'SUI',
  'LTC', 'BCH', 'NEAR', 'APT', 'UNI', 'PEPE', 'SHIB', 'ARB', 'OP', 'FIL', 'ATOM', 'INJ',
].map((name) => ({ symbol: `${name}USDT`, name }));
