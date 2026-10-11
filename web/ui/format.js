// Formatting helpers (de-DE). No dependencies.

const nfCache = new Map();
export function nf(min, max = min, extra = {}) {
  const k = `${min}|${max}|${JSON.stringify(extra)}`;
  if (!nfCache.has(k)) nfCache.set(k, new Intl.NumberFormat('de-DE', { minimumFractionDigits: min, maximumFractionDigits: max, ...extra }));
  return nfCache.get(k);
}

const ok = (v) => v != null && Number.isFinite(Number(v));

/** Decimals appropriate for a price (tiny crypto prices need more). */
export function priceDecimals(p) {
  const a = Math.abs(Number(p));
  if (!Number.isFinite(a) || a === 0) return 2;
  if (a >= 1) return 2;
  if (a >= 0.1) return 4;
  return Math.min(10, Math.ceil(-Math.log10(a)) + 3); // ~4 significant digits
}

export const fmtPrice = (p, ref = p) => (ok(p) ? nf(priceDecimals(ref)).format(p) : '–');
export const fmtNum = (v, d = 2) => (ok(v) ? nf(d).format(v) : '–');
export const fmtInt = (v) => (ok(v) ? nf(0).format(v) : '–');
export const fmtMoney = (v, d = 2) => (ok(v) ? `${nf(d).format(v)}\u00a0€` : '–');
export const fmtPct = (v, d = 2, sign = true) => (ok(v) ? `${sign && v > 0 ? '+' : ''}${nf(d).format(v)}\u00a0%` : '–');
export const fmtScore = (s) => `${s > 0 ? '+' : s < 0 ? '−' : ''}${Math.abs(Math.round(s))}`;
export const trendClass = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');

export function fmtSize(v, assetClass) {
  if (!ok(v)) return '–';
  if (assetClass === 'stock' || Number.isInteger(v)) return nf(0).format(v);
  return nf(0, v >= 100 ? 2 : v >= 1 ? 4 : 6).format(v);
}

/** Normalises seconds / milliseconds to a Date. */
export function toDate(ts) {
  if (!ok(ts)) return null;
  const n = Number(ts);
  return new Date(n > 1e12 ? n : n * 1000);
}

export function fmtTime(ts) {
  const d = toDate(ts);
  return d ? d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '–';
}

export function fmtDateTime(ts) {
  const d = toDate(ts);
  return d ? d.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : '–';
}

/** "14:30" today, "gestern 14:30", otherwise "09.10. 14:30". */
export function fmtStamp(ts) {
  const d = toDate(ts);
  if (!d) return '–';
  const now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  const t = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  if (diff === 0) return t;
  if (diff === 1) return `gestern ${t}`;
  return `${d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })} ${t}`;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Currency suffix for display of quotes. */
export function currencyLabel(cur) {
  if (!cur) return '';
  return { EUR: '€', USD: '$', GBP: '£', GBp: 'p', CHF: 'CHF', DKK: 'DKK', SEK: 'SEK', NOK: 'NOK', USDT: 'USDT' }[cur] || cur;
}
