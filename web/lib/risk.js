// ATR-based, risk-managed trade plan – port of backend/app/analysis/risk.py.

export const ATR_MULTIPLIER = 2.0;

const _view = new DataView(new ArrayBuffer(8));
const _pow10 = [];
const pow10n = (d) => (_pow10[d] ??= 10n ** BigInt(d));

/**
 * Python's `round(x, nd)` for floats: rounds the exact binary value half-to-even and returns the
 * double nearest to the rounded decimal. (Math.round / toFixed differ on exact ties.)
 */
export function pyRound(x, nd = 0) {
  if (!Number.isFinite(x)) return x;
  if (x === 0) return 0;
  _view.setFloat64(0, x);
  const hi = _view.getUint32(0);
  const lo = _view.getUint32(4);
  const negative = hi >>> 31 === 1;
  const expBits = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e;
  if (expBits === 0) e = -1074;
  else {
    mant |= 1n << 52n;
    e = expBits - 1075;
  }
  if (e >= 0) return x; // integral value, nothing to round
  const num = mant * pow10n(nd);
  const den = 1n << BigInt(-e);
  let q = num / den;
  const r2 = (num % den) * 2n;
  if (r2 > den || (r2 === den && (q & 1n) === 1n)) q += 1n;
  if (q === 0n) return 0; // Python would return -0.0 for tiny negatives; JS output uses plain 0
  return Number(`${negative ? '-' : ''}${q}e-${nd}`);
}

/** Python `f"{x:.{nd}f}"`. */
export function formatFixed(x, nd) {
  if (!Number.isFinite(x)) return String(x);
  return pyRound(x, nd).toFixed(nd);
}

/** Sensible number of decimals: more for small prices. */
export function priceDecimals(price) {
  const p = Math.abs(price);
  if (p >= 1000) return 2;
  if (p >= 1) return p >= 10 ? 2 : 3;
  if (p >= 0.01) return 5;
  if (p === 0 || !Number.isFinite(p)) return 2;
  return Math.min(12, -Math.floor(Math.log10(p)) + 3);
}

export function roundPrice(value, ref = null) {
  return pyRound(Number(value), priceDecimals(ref !== null && ref !== undefined ? ref : value));
}

/** Build the trade plan object per API contract; null for neutral or unusable inputs. */
export function tradePlan(direction, entry, atr, assetClass, accountSize = 10000.0, riskPct = 1.0) {
  if (direction !== 'long' && direction !== 'short') return null;
  if (!(entry && entry > 0 && atr && atr > 0 && Number.isFinite(atr))) return null;

  let riskPerUnit = ATR_MULTIPLIER * atr;
  const sign = direction === 'long' ? 1 : -1;
  let stop = entry - sign * riskPerUnit;
  if (stop <= 0) {
    // a long stop below zero makes no sense: cap risk at 95% of entry
    riskPerUnit = entry * 0.95;
    stop = entry - sign * riskPerUnit;
  }
  const tp1 = entry + sign * riskPerUnit;
  const tp2 = entry + sign * 2 * riskPerUnit;

  const riskAmount = (accountSize * riskPct) / 100.0;
  let size = riskAmount / riskPerUnit;
  if (assetClass === 'stock') {
    size = Math.floor(size);
    if (size * entry > accountSize) size = Math.floor(accountSize / entry);
  } else {
    size = Math.floor(size * 1e6) / 1e6;
    if (size * entry > accountSize) size = Math.floor((accountSize / entry) * 1e6) / 1e6;
  }
  size = Math.max(size, 0);

  const positionValue = size * entry;
  const maxLoss = size * riskPerUnit;
  return {
    side: direction,
    entry: roundPrice(entry),
    stop_loss: roundPrice(stop, entry),
    take_profit_1: roundPrice(tp1, entry),
    take_profit_2: roundPrice(tp2, entry),
    risk_reward: 2.0,
    risk_per_unit: roundPrice(riskPerUnit, entry),
    position_size: assetClass === 'stock' ? Math.trunc(size) : pyRound(size, 6),
    position_value: pyRound(positionValue, 2),
    max_loss: pyRound(maxLoss, 2),
  };
}
