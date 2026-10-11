// localStorage-backed settings + watchlist. Every access is wrapped in try/catch
// (private mode, blocked storage, quota) and falls back to in-memory values.

const PREFIX = 'tr.';
const memory = new Map();

export function getItem(key) {
  try {
    const v = localStorage.getItem(PREFIX + key);
    if (v !== null) return v;
  } catch { /* storage unavailable */ }
  return memory.has(key) ? memory.get(key) : null;
}

export function setItem(key, value) {
  memory.set(key, String(value));
  try { localStorage.setItem(PREFIX + key, String(value)); } catch { /* storage unavailable */ }
}

function getJSON(key, fallback) {
  const raw = getItem(key);
  if (raw == null) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

const clamp = (v, min, max, fb) => (Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fb);

export const DEFAULT_WATCHLIST = [
  { symbol: 'AAPL', asset_class: 'stock', name: 'Apple' },
  { symbol: 'MSFT', asset_class: 'stock', name: 'Microsoft' },
  { symbol: 'NVDA', asset_class: 'stock', name: 'Nvidia' },
  { symbol: 'SAP.DE', asset_class: 'stock', name: 'SAP' },
  { symbol: 'ALV.DE', asset_class: 'stock', name: 'Allianz' },
  { symbol: 'BTCUSDT', asset_class: 'crypto', name: 'Bitcoin' },
  { symbol: 'ETHUSDT', asset_class: 'crypto', name: 'Ethereum' },
  { symbol: 'SOLUSDT', asset_class: 'crypto', name: 'Solana' },
];

export const settings = {
  get account() { return clamp(parseFloat(getItem('account')), 100, 1e9, 10000); },
  set account(v) { setItem('account', clamp(Number(v), 100, 1e9, 10000)); },
  get risk() { return clamp(parseFloat(getItem('risk')), 0.25, 3, 1); },
  set risk(v) { setItem('risk', clamp(Math.round(Number(v) * 100) / 100, 0.25, 3, 1)); },
  /** 'system' | 'light' | 'dark' */
  get theme() { const t = getItem('theme'); return t === 'light' || t === 'dark' ? t : 'system'; },
  set theme(v) { setItem('theme', v === 'light' || v === 'dark' ? v : 'system'); },
  get demo() { return getItem('demo') === '1'; },
  set demo(v) { setItem('demo', v ? '1' : '0'); },
};

export function getWatchlist() {
  const list = getJSON('watchlist', null);
  if (!Array.isArray(list)) return DEFAULT_WATCHLIST.map((x) => ({ ...x }));
  return list.filter((x) => x && typeof x.symbol === 'string' && (x.asset_class === 'stock' || x.asset_class === 'crypto'));
}

export function saveWatchlist(list) {
  setItem('watchlist', JSON.stringify(list.map(({ symbol, asset_class, name }) => ({ symbol, asset_class, name: name || symbol }))));
}
