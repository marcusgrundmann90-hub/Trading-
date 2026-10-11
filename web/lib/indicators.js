// Technical indicators on plain number arrays – port of backend/app/analysis/indicators.py.
//
// Every function returns an array with the same length as its input; positions without a value
// hold NaN (like the pandas version). The rolling and EWM algorithms intentionally mirror the
// pandas implementations (Kahan-compensated rolling sums, Welford rolling variance, unadjusted
// EWM with normalisation) so results match the Python backend down to the last bits.

const isNum = (v) => v === v; // not NaN

/** Rolling mean as in pandas `rolling(window=period, min_periods=period).mean()`. */
export function sma(values, period) {
  const n = values.length;
  const out = new Array(n).fill(NaN);
  let nobs = 0, sum = 0, negCt = 0, compAdd = 0, compRemove = 0;
  let sameCt = 0, prev = NaN;

  const add = (val) => {
    if (!isNum(val)) return;
    nobs += 1;
    const y = val - compAdd;
    const t = sum + y;
    compAdd = t - sum - y;
    sum = t;
    if (val < 0 || Object.is(val, -0)) negCt += 1;
    if (val === prev) sameCt += 1;
    else sameCt = 1;
    prev = val;
  };
  const remove = (val) => {
    if (!isNum(val)) return;
    nobs -= 1;
    const y = -val - compRemove;
    const t = sum + y;
    compRemove = t - sum - y;
    sum = t;
    if (val < 0 || Object.is(val, -0)) negCt -= 1;
  };

  for (let i = 0; i < n; i++) {
    const s = Math.max(0, i + 1 - period);
    const e = i + 1;
    if (i === 0) {
      for (let j = s; j < e; j++) add(values[j]);
    } else {
      const ps = Math.max(0, i - period);
      for (let j = ps; j < s; j++) remove(values[j]);
      add(values[i]);
    }
    if (nobs >= period && nobs > 0) {
      let r = sum / nobs;
      if (sameCt >= nobs) r = prev;
      else if (negCt === 0 && r < 0) r = 0;
      else if (negCt === nobs && r > 0) r = 0;
      out[i] = r;
    }
  }
  return out;
}

/** Rolling population standard deviation (ddof=0), as pandas `rolling(...).std(ddof=0)`. */
export function rollingStd(values, period) {
  const n = values.length;
  const out = new Array(n).fill(NaN);
  let nobs = 0, mean = 0, ssqdm = 0, compAdd = 0, compRemove = 0;
  let sameCt = 0, prev = NaN;

  const add = (val) => {
    if (!isNum(val)) return;
    if (val === prev) sameCt += 1;
    else sameCt = 1;
    prev = val;
    nobs += 1;
    const prevMean = mean - compAdd;
    const y = val - compAdd;
    const t = y - mean;
    compAdd = t + mean - y;
    mean = nobs ? mean + t / nobs : 0;
    ssqdm += (val - prevMean) * (val - mean);
  };
  const remove = (val) => {
    if (!isNum(val)) return;
    nobs -= 1;
    if (nobs) {
      const prevMean = mean - compRemove;
      const y = val - compRemove;
      const t = y - mean;
      compRemove = t + mean - y;
      mean -= t / nobs;
      ssqdm -= (val - prevMean) * (val - mean);
    } else {
      mean = 0;
      ssqdm = 0;
    }
  };

  for (let i = 0; i < n; i++) {
    const s = Math.max(0, i + 1 - period);
    if (i === 0) {
      prev = values[0];
      sameCt = 0;
      add(values[0]);
    } else {
      const ps = Math.max(0, i - period);
      for (let j = ps; j < s; j++) remove(values[j]);
      add(values[i]);
    }
    if (nobs >= period && nobs > 0) {
      const v = nobs === 1 || sameCt >= nobs ? 0 : ssqdm / nobs;
      out[i] = v < 0 ? 0 : Math.sqrt(v);
    }
  }
  return out;
}

/** pandas `ewm(span=period, adjust=False, min_periods=minPeriods).mean()`. */
export function ewmMean(values, span, minPeriods = span) {
  const n = values.length;
  const out = new Array(n).fill(NaN);
  if (!n) return out;
  const com = (span - 1) / 2.0;
  const alpha = 1.0 / (1.0 + com);
  const oldWtFactor = 1.0 - alpha;
  const newWt = alpha;
  let weighted = values[0];
  let nobs = isNum(weighted) ? 1 : 0;
  out[0] = nobs >= minPeriods ? weighted : NaN;
  let oldWt = 1.0;
  for (let i = 1; i < n; i++) {
    const cur = values[i];
    const obs = isNum(cur);
    if (obs) nobs += 1;
    if (isNum(weighted)) {
      oldWt *= oldWtFactor;
      if (obs) {
        if (weighted !== cur) {
          weighted = oldWt * weighted + newWt * cur;
          weighted /= oldWt + newWt;
        }
        oldWt = 1.0;
      }
    } else if (obs) {
      weighted = cur;
    }
    out[i] = nobs >= minPeriods ? weighted : NaN;
  }
  return out;
}

export function ema(values, period) {
  return ewmMean(values, period, period);
}

/** numpy pairwise summation (np.add.reduce) for contiguous float64 arrays. */
function npSum(a) {
  const n = a.length;
  if (n < 8) {
    let res = -0.0;
    for (let i = 0; i < n; i++) res += a[i];
    return res;
  }
  if (n <= 128) {
    const r = a.slice(0, 8);
    let i;
    for (i = 8; i < n - (n % 8); i += 8) {
      for (let k = 0; k < 8; k++) r[k] += a[i + k];
    }
    let res = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]));
    for (; i < n; i++) res += a[i];
    return res;
  }
  let n2 = Math.floor(n / 2);
  n2 -= n2 % 8;
  return npSum(a.slice(0, n2)) + npSum(a.slice(n2));
}

/** Wilder smoothing (RMA), seeded with the simple mean of the first `period` values. */
export function wilder(values, period) {
  const n = values.length;
  const out = new Array(n).fill(NaN);
  let start = -1, validCount = 0;
  for (let i = 0; i < n; i++) {
    if (isNum(values[i])) {
      if (start < 0) start = i;
      validCount++;
    }
  }
  if (validCount < period) return out;
  const seedEnd = start + period;
  const seed = values.slice(start, seedEnd);
  if (seed.some((v) => !isNum(v))) return out;
  out[seedEnd - 1] = npSum(seed) / period;
  for (let i = seedEnd; i < n; i++) {
    const v = values[i];
    out[i] = isNum(v) ? (out[i - 1] * (period - 1) + v) / period : out[i - 1];
  }
  return out;
}

export function rsi(close, period = 14) {
  const n = close.length;
  const gainsIn = new Array(n).fill(NaN);
  const lossesIn = new Array(n).fill(NaN);
  for (let i = 1; i < n; i++) {
    const d = close[i] - close[i - 1];
    if (!isNum(d)) continue;
    gainsIn[i] = d < 0 ? 0 : d;
    lossesIn[i] = -d < 0 ? 0 : -d;
  }
  const gain = wilder(gainsIn, period);
  const loss = wilder(lossesIn, period);
  const out = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const g = gain[i], l = loss[i];
    if (!isNum(g) || !isNum(l)) continue;
    if (l !== 0) out[i] = 100 - 100 / (1 + g / l);
    else out[i] = g > 0 ? 100.0 : 50.0;
  }
  return out;
}

export function macd(close, fast = 12, slow = 26, signal = 9) {
  const ef = ema(close, fast);
  const es = ema(close, slow);
  const line = ef.map((v, i) => v - es[i]);
  const sig = ewmMean(line, signal, signal);
  const hist = line.map((v, i) => v - sig[i]);
  return { macd: line, signal: sig, hist };
}

export function bollinger(close, period = 20, numStd = 2.0) {
  const mid = sma(close, period);
  const std = rollingStd(close, period);
  const upper = mid.map((m, i) => m + numStd * std[i]);
  const lower = mid.map((m, i) => m - numStd * std[i]);
  const bandwidth = mid.map((m, i) => (upper[i] - lower[i]) / m);
  return { mid, upper, lower, bandwidth };
}

/** True range; pandas max(axis=1) skips NaN, the first bar is high - low. */
export function trueRange(high, low, close) {
  const n = close.length;
  const out = new Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (i === 0) {
      out[0] = high[0] - low[0];
      continue;
    }
    const pc = close[i - 1];
    const cands = [high[i] - low[i], Math.abs(high[i] - pc), Math.abs(low[i] - pc)].filter(isNum);
    out[i] = cands.length ? Math.max(...cands) : NaN;
  }
  return out;
}

export function atr(high, low, close, period = 14) {
  return wilder(trueRange(high, low, close), period);
}

export function volumeRatio(volume, period = 20) {
  const avg = sma(volume, period);
  return volume.map((v, i) => (avg[i] === 0 ? NaN : v / avg[i]));
}

/**
 * Compute all indicator columns used by signals and the engine.
 * @param {{time:number, open:number, high:number, low:number, close:number, volume:number}[]} candles
 * @returns {object} column arrays: time, open, high, low, close, volume, sma20, sma50, sma200, rsi,
 *   macd, macd_signal, macd_hist, bb_mid, bb_upper, bb_lower, bb_bandwidth, atr, volume_ratio, length
 */
export function computeAll(candles) {
  const time = candles.map((c) => c.time);
  const open = candles.map((c) => Number(c.open));
  const high = candles.map((c) => Number(c.high));
  const low = candles.map((c) => Number(c.low));
  const close = candles.map((c) => Number(c.close));
  const volume = candles.map((c) => Number(c.volume));
  const m = macd(close);
  const bb = bollinger(close);
  return {
    length: candles.length,
    time, open, high, low, close, volume,
    sma20: sma(close, 20),
    sma50: sma(close, 50),
    sma200: sma(close, 200),
    rsi: rsi(close, 14),
    macd: m.macd,
    macd_signal: m.signal,
    macd_hist: m.hist,
    bb_mid: bb.mid,
    bb_upper: bb.upper,
    bb_lower: bb.lower,
    bb_bandwidth: bb.bandwidth,
    atr: atr(high, low, close, 14),
    volume_ratio: volumeRatio(volume, 20),
  };
}
