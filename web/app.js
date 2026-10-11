// Trading Radar – mobile-first PWA. Runs completely in the browser:
// data via ./lib/data.js (Binance live, stock snapshot, demo fallback),
// analysis via ./lib/engine.js. No build step, all paths relative.
import { analyze } from './lib/engine.js';
import { loadCandles, loadStocksSnapshot, loadUniverse, topCryptoSymbols, validateCryptoSymbol, setDemoMode } from './lib/data.js';
import * as dataLib from './lib/data.js';
import {
  nf, fmtPrice, fmtNum, fmtInt, fmtMoney, fmtPct, fmtScore, fmtSize, fmtDateTime, fmtStamp, fmtTime,
  trendClass, esc, currencyLabel,
} from './ui/format.js';
import { settings, getWatchlist, saveWatchlist } from './ui/store.js';
import { charts } from './ui/charts.js';

const APP_VERSION = '1.0.0';
const MARKET_TTL_MS = 5 * 60 * 1000;
const RADAR_STALE_MS = 5 * 60 * 1000;
const MIN_ABS_SCORE = 25;
const CONF_RANK = { low: 0, medium: 1, high: 2 };
const CONF_LABEL = { low: 'niedrig', medium: 'mittel', high: 'hoch' };
const DIR_LABEL = { long: 'Long', short: 'Short', neutral: 'Neutral' };
const CLASS_LABEL = { stock: 'Aktie', crypto: 'Krypto' };
const VIEW_TITLE = { radar: 'Radar', market: 'Markt', watchlist: 'Watchlist', settings: 'Einstellungen' };
const VIEWS = Object.keys(VIEW_TITLE);
const CRYPTO_NAMES = {
  BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana', BNB: 'BNB', XRP: 'XRP', DOGE: 'Dogecoin', ADA: 'Cardano',
  TRX: 'Tron', AVAX: 'Avalanche', LINK: 'Chainlink', DOT: 'Polkadot', LTC: 'Litecoin', SHIB: 'Shiba Inu',
  PEPE: 'Pepe', SUI: 'Sui', TON: 'Toncoin', NEAR: 'NEAR Protocol', APT: 'Aptos', ARB: 'Arbitrum', OP: 'Optimism',
  UNI: 'Uniswap', ATOM: 'Cosmos', FIL: 'Filecoin', ETC: 'Ethereum Classic', BCH: 'Bitcoin Cash', XLM: 'Stellar',
  HBAR: 'Hedera', ICP: 'Internet Computer', AAVE: 'Aave', INJ: 'Injective', WLD: 'Worldcoin', ENA: 'Ethena',
  TAO: 'Bittensor', FET: 'Fetch.ai', RNDR: 'Render', RENDER: 'Render', SEI: 'Sei', TIA: 'Celestia', WIF: 'dogwifhat',
  BONK: 'Bonk', FLOKI: 'Floki', TRUMP: 'Trump', ONDO: 'Ondo', POL: 'Polygon', MATIC: 'Polygon',
};
const cryptoName = (symbol, fallback) => CRYPTO_NAMES[symbol.replace(/(USDT|USDC|FDUSD|EUR|TRY|BTC|ETH|BNB)$/, '')] || fallback || symbol;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const tick = () => new Promise((r) => setTimeout(r));

// ---------------------------------------------------------------- state
const state = {
  view: 'radar',
  watchlist: getWatchlist(),
  snapshot: null,
  universe: null,
  cryptoSource: null, // 'live' | 'demo' | null (unknown)
  filters: {
    radar: { asset: 'all', dirs: new Set() },
    market: { asset: 'all', dirs: new Set() },
  },
  radar: { results: [], errors: [], loading: false, dirty: true, runId: 0, at: 0 },
  market: { results: [], errors: [], loading: false, runId: 0, at: 0, total: 0, done: 0 },
  scroll: {},
  detail: null, // { item, data }
  detailRun: 0,
  sheetOpen: false,
  lastFocus: null,
  installEvent: null,
};

// ---------------------------------------------------------------- helpers
function toast(msg, { action, onAction, ms = 3200 } = {}) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${action ? ` <button type="button" class="toast-action">${esc(action)}</button>` : ''}`;
  t.hidden = false;
  if (action) $('.toast-action', t).addEventListener('click', () => { t.hidden = true; onAction?.(); }, { once: true });
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, action ? 5000 : ms);
}

const inWatchlist = (symbol) => state.watchlist.some((w) => w.symbol === symbol);
const snapInfo = (symbol) => state.snapshot?.symbols?.[symbol] || null;

function stockName(symbol) {
  return snapInfo(symbol)?.name || state.universe?.find((u) => u.symbol === symbol)?.name || null;
}

function currencyFor(o) {
  if (o.asset_class === 'crypto') return /USDT$/.test(o.symbol) ? 'USDT' : '';
  return snapInfo(o.symbol)?.currency || (o.symbol.includes('.') ? '' : 'USD');
}

function noteSource(assetClass, src) {
  if (assetClass !== 'crypto' || !src) return;
  // 'live' wins once any crypto symbol was fetched live in this session/run
  if (src === 'live') state.cryptoSource = 'live';
  else if (state.cryptoSource !== 'live') state.cryptoSource = 'demo';
}

function friendlyError(e) {
  const m = String(e?.message || e || '');
  if (/60|kerzen|candles|zu wenig/i.test(m)) return 'zu wenig Kursdaten';
  if (/unbekannt/i.test(m)) return 'unbekanntes Paar';
  if (/snapshot|not found|nicht gefunden|keine daten|missing|unknown/i.test(m)) return 'keine Kursdaten';
  if (/fetch|network|netz/i.test(m)) return 'keine Verbindung';
  return m.slice(0, 80) || 'Fehler';
}

/** Loads candles + runs the engine for one symbol. */
async function analyzeItem(item, includeSeries = false) {
  const assetClass = item.asset_class;
  const r = await loadCandles(item.symbol, assetClass);
  noteSource(assetClass, r?.dataSource);
  const name = (assetClass === 'stock' ? (r?.name || stockName(item.symbol)) : null) || item.name || item.symbol;
  return analyze({
    symbol: item.symbol, name, assetClass, candles: r.candles,
    accountSize: settings.account, riskPct: settings.risk,
    dataSource: r.dataSource, updatedAt: r.updatedAt, includeSeries,
  });
}

/** Runs fn over items in batches, yielding to the UI between batches. */
async function runBatches(items, size, fn, { onBatch, isCancelled } = {}) {
  for (let i = 0; i < items.length; i += size) {
    if (isCancelled?.()) return false;
    const chunk = items.slice(i, i + size);
    await Promise.all(chunk.map((it) => fn(it).catch(() => { /* handled in fn */ })));
    onBatch?.(Math.min(items.length, i + size));
    await tick();
  }
  return !isCancelled?.();
}

const byAbsScore = (a, b) => Math.abs(b.score) - Math.abs(a.score) || a.symbol.localeCompare(b.symbol);

function passes(o, f) {
  if (f.asset !== 'all' && o.asset_class !== f.asset) return false;
  if (f.dirs.size && !f.dirs.has(o.direction)) return false;
  return true;
}

// ---------------------------------------------------------------- shared markup
function gaugeHTML(score) {
  const s = Math.max(-100, Math.min(100, Number(score) || 0));
  const w = Math.abs(s) / 2;
  const pos = s >= 0 ? `left:50%;width:${w}%` : `left:${50 - w}%;width:${w}%`;
  return `<div class="gauge" role="meter" aria-valuemin="-100" aria-valuemax="100" aria-valuenow="${Math.round(s)}" aria-label="Score ${Math.round(s)} von −100 bis +100"><div class="gauge-fill ${s >= 0 ? 'up' : 'down'}" style="${pos}"></div></div>`;
}

function confHTML(c) {
  const n = (CONF_RANK[c] ?? 0) + 1;
  return `<span class="conf" title="Konfidenz"><span class="conf-bars" aria-hidden="true">${[1, 2, 3].map((i) => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</span>${CONF_LABEL[c] || esc(c)}</span>`;
}

const demoTag = (o) => (o.data_source === 'demo' && !settings.demo ? '<span class="tag demo" title="Live-Abruf fehlgeschlagen – synthetische Daten">Demo</span>' : '');

function priceHTML(o) {
  const cur = o.asset_class === 'stock' ? currencyLabel(currencyFor(o)) : '';
  return `<span class="num">${fmtPrice(o.price)}${cur ? `<span class="cur">${esc(cur)}</span>` : ''}</span>`;
}

function cardHTML(o, mode) {
  const sig = [...(o.signals || [])].sort((a, b) => (b.weight || 0) - (a.weight || 0)).slice(0, 3);
  const s = Math.round(o.score);
  const added = inWatchlist(o.symbol);
  const action = mode === 'market'
    ? `<button type="button" class="btn btn-small btn-secondary card-action" data-add="${esc(o.symbol)}" data-class="${esc(o.asset_class)}" data-name="${esc(o.name || '')}" aria-pressed="${added}" ${added ? 'aria-label="Bereits in der Watchlist"' : `aria-label="${esc(o.symbol)} zur Watchlist hinzufügen"`}>${added ? '✓ Watchlist' : '+ Watchlist'}</button>`
    : '<span class="card-cta" aria-hidden="true">Analyse ›</span>';
  return `<article class="card ${esc(o.direction)}">
    <div class="card-top">
      <div class="card-id">
        <div class="card-sym">
          <h3 class="sym"><button type="button" class="card-hit" data-open="${esc(o.symbol)}" data-class="${esc(o.asset_class)}" aria-label="Details zu ${esc(o.symbol)} öffnen">${esc(o.symbol)}</button></h3>
          <span class="tag ${esc(o.asset_class)}">${CLASS_LABEL[o.asset_class] || ''}</span>${demoTag(o)}
        </div>
        <div class="card-name">${esc(o.name || '')}</div>
      </div>
      <div class="card-price">${priceHTML(o)}<span class="change ${trendClass(o.change_pct)}">${fmtPct(o.change_pct)}</span></div>
    </div>
    <div>
      <div class="score-line">
        <span class="left"><span class="score ${trendClass(s)}">${fmtScore(s)}</span><span>Score</span></span>
        <span class="right">${confHTML(o.confidence)}<span class="dir-badge ${esc(o.direction)}">${DIR_LABEL[o.direction] || ''}</span></span>
      </div>
      <div style="margin-top:8px">${gaugeHTML(s)}</div>
    </div>
    ${o.summary ? `<p class="card-summary">${esc(o.summary)}</p>` : ''}
    ${sig.length ? `<ul class="chips" aria-label="Wichtigste Signale">${sig.map((x) => `<li class="chip ${esc(x.direction)}">${esc(x.name)}</li>`).join('')}</ul>` : ''}
    <div class="card-foot">
      ${o.trade_plan ? `<span>Stop <span class="num">${fmtPrice(o.trade_plan.stop_loss, o.price)}</span> · R:R <span class="num">${fmtNum(o.trade_plan.risk_reward, 1)}</span></span>` : '<span>Kein Trade-Plan</span>'}
      ${action}
    </div>
  </article>`;
}

function rowHTML(o) {
  const s = Math.round(o.score);
  return `<li><button type="button" class="row" data-open="${esc(o.symbol)}" data-class="${esc(o.asset_class)}" aria-label="Details zu ${esc(o.symbol)} öffnen, Score ${s}">
    <span class="row-id"><span class="top"><span class="sym">${esc(o.symbol)}</span><span class="tag ${esc(o.asset_class)}">${CLASS_LABEL[o.asset_class] || ''}</span>${demoTag(o)}</span><span class="name">${esc(o.name || '')}</span></span>
    <span class="row-price">${priceHTML(o)}<span class="change ${trendClass(o.change_pct)}">${fmtPct(o.change_pct)}</span></span>
    <span class="mini-score"><span>${fmtScore(s)}</span>${gaugeHTML(s)}</span>
  </button></li>`;
}

function skeletonHTML(n = 3) {
  return Array.from({ length: n }, () => `
    <div class="card skeleton" aria-hidden="true">
      <div class="card-top"><div style="flex:1"><div class="skel" style="width:40%;height:16px"></div><div class="skel" style="width:60%;margin-top:8px"></div></div><div class="skel" style="width:70px;height:16px"></div></div>
      <div class="skel" style="height:8px"></div>
      <div class="skel" style="width:95%"></div><div class="skel" style="width:70%"></div>
      <div style="display:flex;gap:6px"><div class="skel" style="width:90px;height:22px;border-radius:999px"></div><div class="skel" style="width:110px;height:22px;border-radius:999px"></div></div>
    </div>`).join('');
}

function emptyHTML(title, text, button) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><path d="M12 12l6-6"/></svg>
    <p class="empty-title">${esc(title)}</p><p>${esc(text)}</p>${button || ''}`;
}

// ---------------------------------------------------------------- header / freshness
function renderFreshness() {
  const el = $('#freshness');
  const snap = state.snapshot;
  const parts = [];
  if (state.view === 'radar' || state.view === 'market') {
    if (snap) {
      if (settings.demo) parts.push('Aktien: Demo');
      else if (snap.source === 'unavailable' || !snap.generatedAt) parts.push('Aktien: keine Daten');
      else parts.push(`Aktien: Stand ${esc(fmtStamp(snap.generatedAt))} (verzögert)`);
    }
    if (state.cryptoSource === 'live') parts.push('<span class="live">Krypto live</span>');
    else if (state.cryptoSource === 'demo') parts.push('Krypto: Demo');
  } else if (state.view === 'watchlist') {
    parts.push(`${state.watchlist.length} ${state.watchlist.length === 1 ? 'Symbol' : 'Symbole'}`);
  } else {
    parts.push(`Version ${APP_VERSION}`);
  }
  el.innerHTML = parts.join(' · ') || '&nbsp;';
  $('#btn-refresh').hidden = !(state.view === 'radar' || state.view === 'market');

  const demo = settings.demo || snap?.source === 'demo' || state.cryptoSource === 'demo';
  const badge = $('#demo-badge');
  badge.hidden = !demo;
  badge.title = settings.demo ? 'Demo-Modus aktiv – synthetische Kurse'
    : snap?.source === 'demo' ? 'Aktien-Snapshot enthält Demo-Daten'
      : 'Live-Abruf fehlgeschlagen – teilweise synthetische Kurse';
}

function setRefreshing(on) {
  $('#btn-refresh').classList.toggle('spinning', on);
}

function updateRefreshSpinner() {
  const busy = (state.view === 'radar' && state.radar.loading) || (state.view === 'market' && state.market.loading);
  setRefreshing(busy);
}

// ---------------------------------------------------------------- Radar
async function scanRadar({ silent = false } = {}) {
  const R = state.radar;
  const id = ++R.runId;
  R.loading = true;
  R.dirty = false;
  updateRefreshSpinner();
  if (!silent || !R.results.length) {
    $('#radar-list').innerHTML = skeletonHTML(Math.min(3, Math.max(1, state.watchlist.length)));
    $('#radar-list').setAttribute('aria-busy', 'true');
    $('#radar-empty').hidden = true;
    $('#radar-watch').hidden = true;
    $('#radar-meta').textContent = `Analysiere ${state.watchlist.length} Symbole …`;
  }
  try { state.snapshot = await loadStocksSnapshot(); } catch { /* data.js returns fallback */ }
  renderFreshness();

  const items = state.watchlist.slice();
  const results = [], errors = [];
  if (items.some((i) => i.asset_class === 'crypto')) state.cryptoSource = null;
  await runBatches(items, 4, async (it) => {
    try { results.push(await analyzeItem(it)); } catch (e) { errors.push({ symbol: it.symbol, msg: friendlyError(e) }); }
  }, { isCancelled: () => id !== R.runId });
  if (id !== R.runId) return;
  R.results = results.sort(byAbsScore);
  R.errors = errors;
  R.at = Date.now();
  R.loading = false;
  updateRefreshSpinner();
  renderRadar();
  renderFreshness();
}

function renderRadar() {
  const R = state.radar;
  const f = state.filters.radar;
  const list = $('#radar-list');
  list.setAttribute('aria-busy', 'false');
  const visible = R.results.filter((o) => passes(o, f));
  const actionable = visible.filter((o) => o.direction !== 'neutral');
  // "Beobachten" ignores the Long/Short chips (neutral has no direction) but respects the asset filter
  const neutral = R.results.filter((o) => o.direction === 'neutral' && (f.asset === 'all' || o.asset_class === f.asset));

  list.innerHTML = actionable.map((o) => cardHTML(o, 'radar')).join('');
  $('#radar-watch-list').innerHTML = neutral.map(rowHTML).join('');
  $('#radar-watch').hidden = neutral.length === 0;

  const empty = $('#radar-empty');
  empty.hidden = actionable.length > 0;
  if (!state.watchlist.length) {
    empty.innerHTML = emptyHTML('Deine Watchlist ist leer', 'Füge Aktien oder Krypto-Paare hinzu – der Radar prüft sie dann auf Setups.',
      '<button type="button" class="btn btn-primary" data-goto="watchlist">Watchlist öffnen</button>');
  } else if (!actionable.length) {
    empty.innerHTML = R.results.length && !visible.length && !neutral.length
      ? emptyHTML('Nichts passt zu den Filtern', 'Lockere die Filter, um mehr zu sehen.')
      : emptyHTML('Gerade kein klares Setup', neutral.length ? 'Alle Symbole sind neutral – siehe „Beobachten“. Abwarten ist auch eine Position.' : 'Keine Signale mit klarer Richtung.');
  }

  const long = R.results.filter((o) => o.direction === 'long').length;
  const short = R.results.filter((o) => o.direction === 'short').length;
  $('#radar-meta').textContent = R.results.length
    ? `${R.results.length} analysiert · ${long} Long · ${short} Short · ${fmtTime(R.at / 1000)} Uhr`
    : '';
  const err = $('#radar-errors');
  err.hidden = !R.errors.length;
  err.textContent = R.errors.length ? `Nicht analysiert: ${R.errors.map((e) => `${e.symbol} (${e.msg})`).join(', ')}` : '';
}

// ---------------------------------------------------------------- Markt
async function scanMarket({ force = false } = {}) {
  const M = state.market;
  if (M.loading && !force) return;
  if (!force && M.at && Date.now() - M.at < MARKET_TTL_MS) { renderMarket(); return; }
  const id = ++M.runId;
  M.loading = true;
  M.results = [];
  M.errors = [];
  M.done = 0;
  M.total = 0;
  updateRefreshSpinner();
  const prog = $('#market-progress');
  prog.hidden = false;
  setProgress('Lade Marktdaten …', 0);
  $('#market-list').innerHTML = skeletonHTML(2);
  $('#market-empty').hidden = true;
  $('#market-errors').hidden = true;
  $('#market-meta').textContent = '';

  let universe = [], cryptos = [];
  try {
    [universe, state.snapshot, cryptos] = await Promise.all([
      loadUniverse().catch(() => []),
      loadStocksSnapshot().catch(() => state.snapshot),
      topCryptoSymbols(25).catch(() => []),
    ]);
  } catch { /* individual fallbacks above */ }
  if (id !== M.runId) return;
  state.universe = universe.length ? universe : state.universe;
  renderFreshness();

  const snapSyms = state.snapshot?.symbols || {};
  const stocks = settings.demo ? universe : universe.filter((u) => snapSyms[u.symbol]);
  const missing = universe.length - stocks.length;
  const items = [
    ...stocks.map((s) => ({ symbol: s.symbol, name: s.name, asset_class: 'stock' })),
    ...cryptos.map((c) => ({ symbol: c.symbol, name: cryptoName(c.symbol, c.name), asset_class: 'crypto' })),
  ];
  M.total = items.length;
  if (cryptos.length) state.cryptoSource = null;

  const all = [];
  const ok = await runBatches(items, 6, async (it) => {
    try { all.push(await analyzeItem(it)); } catch (e) { M.errors.push({ symbol: it.symbol, msg: friendlyError(e) }); }
  }, {
    isCancelled: () => id !== M.runId,
    onBatch: (n) => {
      if (id !== M.runId) return;
      M.done = n;
      M.results = all.filter((o) => Math.abs(o.score) >= MIN_ABS_SCORE).sort(byAbsScore);
      setProgress(`${n}/${M.total} analysiert`, (n / Math.max(1, M.total)) * 100);
      renderMarket({ partial: true });
      renderFreshness();
    },
  });
  if (!ok || id !== M.runId) return;
  M.analyzed = all.length;
  M.missing = missing;
  M.at = Date.now();
  M.loading = false;
  prog.hidden = true;
  updateRefreshSpinner();
  renderMarket();
  renderFreshness();
}

function setProgress(text, pct) {
  $('#market-progress-text').textContent = text;
  $('#market-progress-fill').style.width = `${pct}%`;
  $('.progress-bar').setAttribute('aria-valuenow', String(Math.round(pct)));
}

function renderMarket({ partial = false } = {}) {
  const M = state.market;
  const f = state.filters.market;
  const visible = M.results.filter((o) => passes(o, f));
  $('#market-list').innerHTML = visible.map((o) => cardHTML(o, 'market')).join('') || (partial ? skeletonHTML(1) : '');
  const empty = $('#market-empty');
  empty.hidden = partial || visible.length > 0;
  if (!empty.hidden) {
    empty.innerHTML = M.results.length
      ? emptyHTML('Nichts passt zu den Filtern', 'Lockere die Filter, um mehr zu sehen.')
      : M.total
        ? emptyHTML('Keine klaren Chancen', `Kein Symbol erreicht aktuell einen Score von mindestens ±${MIN_ABS_SCORE}.`)
        : emptyHTML('Keine Marktdaten', 'Universum oder Aktien-Snapshot konnten nicht geladen werden.', '<button type="button" class="btn btn-secondary" data-action="rescan-market">Erneut versuchen</button>');
  }
  if (!partial) {
    const long = M.results.filter((o) => o.direction === 'long').length;
    const short = M.results.filter((o) => o.direction === 'short').length;
    $('#market-meta').textContent = M.total
      ? `${M.analyzed ?? M.done}/${M.total} analysiert · ${M.results.length} Chancen · ${long} Long · ${short} Short · ${fmtTime(M.at / 1000)}`
      : '';
    const err = $('#market-errors');
    const nErr = M.errors.length + (M.missing || 0);
    err.hidden = !nErr;
    err.textContent = nErr ? `${nErr} Symbole ohne ausreichende Daten übersprungen.` : '';
  } else {
    $('#market-meta').textContent = M.results.length ? `${M.results.length} Chancen bisher` : '';
  }
}

// ---------------------------------------------------------------- Watchlist
function addToWatchlist(item, { silent = false } = {}) {
  if (inWatchlist(item.symbol)) return false;
  state.watchlist.push({ symbol: item.symbol, asset_class: item.asset_class, name: item.name || item.symbol });
  saveWatchlist(state.watchlist);
  state.radar.dirty = true;
  if (!silent) toast(`${item.symbol} zur Watchlist hinzugefügt`);
  return true;
}

function removeFromWatchlist(symbol) {
  const idx = state.watchlist.findIndex((w) => w.symbol === symbol);
  if (idx < 0) return;
  const [removed] = state.watchlist.splice(idx, 1);
  saveWatchlist(state.watchlist);
  state.radar.results = state.radar.results.filter((o) => o.symbol !== symbol);
  toast(`${symbol} entfernt`, {
    action: 'Rückgängig',
    onAction: () => {
      if (inWatchlist(removed.symbol)) return;
      state.watchlist.splice(Math.min(idx, state.watchlist.length), 0, removed);
      saveWatchlist(state.watchlist);
      state.radar.dirty = true;
      refreshWatchlistUI();
    },
  });
}

function refreshWatchlistUI() {
  if (state.view === 'watchlist') { renderWatchlist(); renderSearch(); renderFreshness(); }
  if (state.view === 'market') renderMarket();
  if (state.view === 'radar' && state.radar.dirty) scanRadar({ silent: true });
}

function renderWatchlist() {
  const ul = $('#wl-list');
  const n = state.watchlist.length;
  $('#wl-count').textContent = n ? `${n} ${n === 1 ? 'Symbol' : 'Symbole'}` : '';
  ul.innerHTML = n ? state.watchlist.map((w) => {
    const name = w.asset_class === 'stock' ? (stockName(w.symbol) || w.name) : w.name;
    return `<li class="wl-item">
      <button type="button" class="wl-open" data-open="${esc(w.symbol)}" data-class="${esc(w.asset_class)}" aria-label="Details zu ${esc(w.symbol)} öffnen">
        <span class="row-id"><span class="top"><span class="sym">${esc(w.symbol)}</span><span class="tag ${esc(w.asset_class)}">${CLASS_LABEL[w.asset_class]}</span></span>
        <span class="name">${esc(name && name !== w.symbol ? name : '')}</span></span>
      </button>
      <button type="button" class="icon-btn danger" data-remove="${esc(w.symbol)}" aria-label="${esc(w.symbol)} aus der Watchlist entfernen">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>
      </button>
    </li>`;
  }).join('') : '';
  let emptyEl = $('#wl-empty');
  if (!n) {
    if (!emptyEl) {
      ul.insertAdjacentHTML('afterend', '<div id="wl-empty" class="empty"></div>');
      emptyEl = $('#wl-empty');
    }
    emptyEl.innerHTML = emptyHTML('Noch keine Symbole', 'Suche oben nach einer Aktie oder gib ein Krypto-Kürzel wie BTC ein.');
    emptyEl.hidden = false;
  } else if (emptyEl) emptyEl.hidden = true;
}

async function ensureUniverse() {
  if (state.universe?.length) return state.universe;
  try { state.universe = await loadUniverse(); } catch { state.universe = []; }
  if (!state.snapshot) { try { state.snapshot = await loadStocksSnapshot(); } catch { /* ignore */ } }
  return state.universe;
}

function searchUniverse(q) {
  const query = q.trim().toLowerCase();
  if (!query) return [];
  const uni = state.universe || [];
  const scored = [];
  for (const u of uni) {
    const sym = u.symbol.toLowerCase(), base = sym.split('.')[0], name = (u.name || '').toLowerCase();
    let rank = -1;
    if (sym === query || base === query) rank = 0;
    else if (base.startsWith(query)) rank = 1;
    else if (name.startsWith(query)) rank = 2;
    else if (name.split(/[\s\-&.]+/).some((w) => w.startsWith(query))) rank = 3;
    else if (sym.includes(query) || name.includes(query)) rank = 4;
    if (rank >= 0) scored.push([rank, u]);
  }
  return scored.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name, 'de')).slice(0, 30).map((x) => x[1]);
}

const REGION_LABEL = { DE: 'DE', EU: 'EU', US: 'US' };

function renderSearch() {
  const input = $('#stock-search');
  const ul = $('#stock-results');
  const q = input.value;
  const hint = $('#stock-hint');
  if (!q.trim()) { ul.hidden = true; ul.innerHTML = ''; hint.textContent = 'Aktien aus DAX 40, großen US- und Europa-Werten.'; return; }
  if (!state.universe?.length) { ul.hidden = true; hint.textContent = 'Aktien-Universum wird geladen …'; return; }
  const res = searchUniverse(q);
  hint.textContent = res.length ? '' : `Keine Aktie zu „${q.trim()}“ gefunden.`;
  ul.hidden = !res.length;
  ul.innerHTML = res.map((u) => {
    const added = inWatchlist(u.symbol);
    return `<li><button type="button" class="result-btn" data-add="${esc(u.symbol)}" data-class="stock" data-name="${esc(u.name)}" ${added ? 'disabled aria-label="' + esc(u.symbol) + ' ist bereits in der Watchlist"' : `aria-label="${esc(u.name)} (${esc(u.symbol)}) hinzufügen"`}>
      <span class="row-id"><span class="top"><span class="sym">${esc(u.symbol)}</span>${u.region ? `<span class="region">${esc(REGION_LABEL[u.region] || u.region)}</span>` : ''}</span><span class="name">${esc(u.name)}</span></span>
      <span class="plus" aria-hidden="true">${added ? '✓' : '+'}</span>
    </button></li>`;
  }).join('');
}

/** "doge" → "DOGEUSDT", "ethbtc" stays, "btc-usdt" → "BTCUSDT". */
function normalizePair(raw) {
  const s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!s) return '';
  for (const q of ['USDT', 'USDC', 'FDUSD', 'EUR', 'TRY']) if (s.endsWith(q) && s.length >= q.length + 2) return s;
  for (const q of ['BTC', 'ETH', 'BNB']) if (s.endsWith(q) && s.length - q.length >= 3) return s;
  return `${s}USDT`;
}

async function onCryptoSubmit(e) {
  e.preventDefault();
  const input = $('#crypto-input');
  const msg = $('#crypto-msg');
  const btn = $('#crypto-submit');
  const setMsg = (t, kind = '') => { msg.textContent = t; msg.className = `form-msg ${kind}`; };
  const pair = normalizePair(input.value);
  input.removeAttribute('aria-invalid');
  if (!pair) { setMsg('Bitte ein Kürzel eingeben, z.B. BTC oder DOGEUSDT.', 'err'); input.setAttribute('aria-invalid', 'true'); input.focus(); return; }
  if (!/^[A-Z0-9]{3,20}$/.test(pair)) { setMsg('Ungültiges Paar – nur Buchstaben und Ziffern.', 'err'); input.setAttribute('aria-invalid', 'true'); return; }
  if (inWatchlist(pair)) { setMsg(`${pair} ist bereits in der Watchlist.`, 'err'); return; }
  btn.disabled = true;
  btn.textContent = 'Prüfe …';
  setMsg('');
  let valid = settings.demo;
  if (!valid) { try { valid = await validateCryptoSymbol(pair); } catch { valid = false; } }
  btn.disabled = false;
  btn.textContent = 'Hinzufügen';
  if (!valid) {
    setMsg(navigator.onLine === false
      ? 'Keine Internetverbindung – Paar kann nicht geprüft werden.'
      : `${pair} wurde bei Binance nicht gefunden. Format: Kürzel + USDT, z.B. DOGEUSDT.`, 'err');
    input.setAttribute('aria-invalid', 'true');
    return;
  }
  const base = pair.replace(/(USDT|USDC|FDUSD|EUR|TRY|BTC|ETH|BNB)$/, '') || pair;
  addToWatchlist({ symbol: pair, asset_class: 'crypto', name: cryptoName(pair, base) }, { silent: true });
  setMsg(`${pair} wurde hinzugefügt.`, 'ok');
  input.value = '';
  renderWatchlist();
  renderFreshness();
}

// ---------------------------------------------------------------- Settings
function renderRiskSummary() {
  const amt = (settings.account * settings.risk) / 100;
  $('#risk-summary').innerHTML = `Max. Verlust je Trade: <strong>${fmtMoney(amt)}</strong> (${nf(0, 2).format(settings.risk)} % von ${fmtMoney(settings.account, 0)})`;
}

function renderSettings() {
  $('#in-account').value = settings.account;
  $('#in-risk').value = settings.risk;
  $('#in-risk-range').value = settings.risk;
  $('#in-demo').checked = settings.demo;
  renderRiskSummary();
  $$('#theme-seg .seg-btn').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.themeOpt === settings.theme)));
  renderDataInfo();
  renderInstall();
}

async function renderDataInfo() {
  if (!state.snapshot) { try { state.snapshot = await loadStocksSnapshot(); } catch { /* ignore */ } }
  const s = state.snapshot;
  const n = s ? Object.keys(s.symbols || {}).length : 0;
  const src = !s || s.source === 'unavailable' ? 'nicht verfügbar' : s.source === 'demo' ? 'Demo (synthetisch)' : s.source === 'yahoo' ? 'Yahoo Finance (Tageskerzen)' : esc(s.source);
  const rows = [
    ['Aktien-Daten', src],
    ['Stand', s?.generatedAt ? `${fmtDateTime(s.generatedAt)} Uhr` : '–'],
    ['Aktien im Snapshot', n ? `${fmtInt(n)}${s.errors?.length ? ` (${fmtInt(s.errors.length)} fehlen)` : ''}` : '–'],
    ['Krypto', settings.demo ? 'Demo (synthetisch)' : state.cryptoSource === 'demo' ? 'Binance nicht erreichbar → Demo' : 'Binance, live'],
    ['Offline-Cache', 'serviceWorker' in navigator ? (navigator.serviceWorker.controller ? 'aktiv' : 'wird eingerichtet …') : 'nicht unterstützt'],
    ['App-Version', APP_VERSION],
  ];
  $('#data-info').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function renderInstall() {
  const body = $('#install-body');
  if (isStandalone()) {
    body.innerHTML = '<p class="install-note">✓ Trading Radar läuft als installierte App.</p>';
    return;
  }
  const ios = `<p class="install-os">iPhone / iPad (Safari)</p><ol class="install-steps"><li>Unten auf <strong>Teilen</strong> tippen (Quadrat mit Pfeil).</li><li><strong>„Zum Home-Bildschirm“</strong> wählen.</li><li>Mit <strong>„Hinzufügen“</strong> bestätigen.</li></ol>`;
  const android = `<p class="install-os">Android (Chrome)</p><ol class="install-steps"><li>Oben rechts das <strong>Menü ⋮</strong> öffnen.</li><li><strong>„App installieren“</strong> bzw. „Zum Startbildschirm hinzufügen“ wählen.</li></ol>`;
  body.innerHTML = `${state.installEvent ? '<button type="button" class="btn btn-primary btn-block" id="btn-install">App installieren</button><p class="install-note">Oder manuell:</p>' : '<p class="install-note">Als App auf dem Home-Bildschirm startet Trading Radar im Vollbild und funktioniert auch offline.</p>'}
    ${isIOS() ? ios + android : android + ios}`;
  $('#btn-install')?.addEventListener('click', async () => {
    const ev = state.installEvent;
    if (!ev) return;
    state.installEvent = null;
    ev.prompt();
    try {
      const { outcome } = await ev.userChoice;
      if (outcome === 'accepted') toast('Trading Radar wird installiert');
    } catch { /* ignore */ }
    renderInstall();
  });
}

function applyTheme() {
  const t = settings.theme;
  const root = document.documentElement;
  if (t === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', t);
  const metas = $$('meta[name="theme-color"]');
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
  metas.forEach((m) => {
    if (!m.dataset.orig) m.dataset.orig = m.getAttribute('content');
    m.setAttribute('content', t === 'system' ? m.dataset.orig : bg);
  });
  requestAnimationFrame(() => charts.retheme());
}

let settingsTimer = null;
function onRiskSettingsChanged() {
  renderRiskSummary();
  clearTimeout(settingsTimer);
  // stop & R:R don't depend on account/risk; only the detail trade plan does
  settingsTimer = setTimeout(() => { if (state.sheetOpen && state.detail) loadDetail(state.detail.item, { keepCharts: true }); }, 300);
}

function initSettings() {
  const acc = $('#in-account'), riskN = $('#in-risk'), riskR = $('#in-risk-range');
  acc.addEventListener('input', () => {
    const v = parseFloat(acc.value);
    if (!Number.isFinite(v) || v < 100) return;
    settings.account = v;
    onRiskSettingsChanged();
  });
  acc.addEventListener('blur', () => { acc.value = settings.account; });
  riskR.addEventListener('input', () => { settings.risk = parseFloat(riskR.value); riskN.value = settings.risk; onRiskSettingsChanged(); });
  riskN.addEventListener('input', () => {
    const v = parseFloat(riskN.value);
    if (Number.isFinite(v) && v >= 0.25 && v <= 3) { settings.risk = v; riskR.value = settings.risk; onRiskSettingsChanged(); }
  });
  riskN.addEventListener('blur', () => { riskN.value = settings.risk; riskR.value = settings.risk; });
  [acc, riskN].forEach((el) => el.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.blur(); }));

  $('#theme-seg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-theme-opt]');
    if (!b) return;
    settings.theme = b.dataset.themeOpt;
    $$('#theme-seg .seg-btn').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    applyTheme();
  });

  $('#in-demo').addEventListener('change', (e) => {
    const on = e.target.checked;
    settings.demo = on;
    setDemoMode(on);
    state.cryptoSource = null;
    state.radar.dirty = true;
    state.radar.results = [];
    state.market.at = 0;
    state.market.runId++;
    state.market.loading = false;
    state.market.results = [];
    toast(on ? 'Demo-Modus an – synthetische Kurse' : 'Demo-Modus aus – Live-Daten');
    renderFreshness();
    renderDataInfo();
  });
}

// ---------------------------------------------------------------- navigation
function setView(view, { replace = true } = {}) {
  if (!VIEWS.includes(view)) view = 'radar';
  const prev = state.view;
  if (prev !== view) state.scroll[prev] = window.scrollY;
  state.view = view;
  $$('.view').forEach((v) => { v.hidden = v.dataset.view !== view; });
  $$('.nav-btn').forEach((b) => { if (b.dataset.nav === view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
  $('#view-title').textContent = VIEW_TITLE[view];
  document.title = view === 'radar' ? 'Trading Radar' : `${VIEW_TITLE[view]} · Trading Radar`;
  if (replace && !state.sheetOpen) {
    try { history.replaceState(history.state, '', `#${view}`); } catch { /* ignore */ }
  }
  window.scrollTo(0, prev === view ? 0 : (state.scroll[view] || 0));

  if (view === 'radar') {
    if (state.radar.dirty || (!state.radar.loading && Date.now() - state.radar.at > RADAR_STALE_MS)) scanRadar({ silent: state.radar.results.length > 0 });
    else renderRadar();
  } else if (view === 'market') {
    scanMarket();
  } else if (view === 'watchlist') {
    renderWatchlist();
    ensureUniverse().then(renderSearch);
  } else if (view === 'settings') {
    renderSettings();
  }
  updateRefreshSpinner();
  renderFreshness();
}

/** Drops the data layer's in-memory caches (snapshot + 5-min candle cache) so a manual refresh refetches. */
function dropDataCaches() {
  try { dataLib.clearCache?.(); } catch { /* optional API */ }
}

function onRefresh() {
  if (state.view === 'radar') { dropDataCaches(); state.market.at = 0; scanRadar({ silent: false }); }
  else if (state.view === 'market') { dropDataCaches(); scanMarket({ force: true }); }
}

function initFilters() {
  $$('.filterbar').forEach((bar) => {
    const key = bar.dataset.filter;
    const f = state.filters[key];
    bar.addEventListener('click', (e) => {
      const seg = e.target.closest('.seg-btn');
      const chip = e.target.closest('.chip-toggle');
      if (seg) {
        f.asset = seg.dataset.asset;
        $$('.seg-btn', bar).forEach((b) => b.setAttribute('aria-pressed', String(b === seg)));
      } else if (chip) {
        const on = chip.getAttribute('aria-pressed') !== 'true';
        chip.setAttribute('aria-pressed', String(on));
        if (on) f.dirs.add(chip.dataset.dir); else f.dirs.delete(chip.dataset.dir);
      } else return;
      if (key === 'radar') renderRadar(); else renderMarket({ partial: state.market.loading });
    });
  });
}

// ---------------------------------------------------------------- Detail sheet
function findKnown(symbol) {
  return state.radar.results.find((o) => o.symbol === symbol)
    || state.market.results.find((o) => o.symbol === symbol)
    || null;
}

function openDetail(item, trigger) {
  const sheet = $('#sheet');
  const backdrop = $('#sheet-backdrop');
  state.lastFocus = trigger || document.activeElement;
  const known = findKnown(item.symbol);
  if (!item.name) item.name = known?.name || state.watchlist.find((w) => w.symbol === item.symbol)?.name || stockName(item.symbol) || '';
  fillHead(known || { symbol: item.symbol, name: item.name, asset_class: item.asset_class });
  resetChecklist();
  $('#sheet-body').scrollTop = 0;

  if (!state.sheetOpen) {
    state.sheetOpen = true;
    sheet.hidden = false;
    backdrop.hidden = false;
    document.body.classList.add('no-scroll');
    sheet.getBoundingClientRect(); // force layout so the transition runs
    sheet.classList.add('open');
    backdrop.classList.add('open');
    try { history.pushState({ sheet: item.symbol }, '', location.href); } catch { /* ignore */ }
    setTimeout(() => $('#d-close').focus({ preventScroll: true }), 50);
  }
  loadDetail(item);
}

function requestCloseDetail() {
  if (!state.sheetOpen) return;
  if (history.state && history.state.sheet) history.back(); // popstate closes the sheet
  else closeDetail();
}

function closeDetail() {
  if (!state.sheetOpen) return;
  state.sheetOpen = false;
  state.detailRun++;
  const sheet = $('#sheet');
  const backdrop = $('#sheet-backdrop');
  sheet.classList.remove('dragging');
  sheet.style.transform = '';
  sheet.classList.remove('open');
  backdrop.classList.remove('open');
  document.body.classList.remove('no-scroll');
  const done = () => {
    if (state.sheetOpen) return;
    sheet.hidden = true;
    backdrop.hidden = true;
    charts.destroy();
    state.detail = null;
  };
  setTimeout(done, 340);
  const lf = state.lastFocus;
  if (lf && document.contains(lf)) lf.focus({ preventScroll: true });
}

function fillHead(o) {
  $('#d-title').textContent = o.symbol;
  $('#d-name').textContent = o.name && o.name !== o.symbol ? o.name : '';
  const tag = $('#d-tag');
  tag.className = `tag ${o.asset_class || ''}`;
  tag.textContent = CLASS_LABEL[o.asset_class] || '';
  const dir = $('#d-dir');
  dir.className = `dir-badge ${o.direction || ''}`;
  dir.textContent = DIR_LABEL[o.direction] || '';
  const cur = o.price != null ? currencyLabel(currencyFor(o)) : '';
  $('#d-price').innerHTML = o.price != null ? `${fmtPrice(o.price)}${cur ? `<span class="cur">${esc(cur)}</span>` : ''}` : '';
  const ch = $('#d-change');
  ch.className = `change ${trendClass(o.change_pct)}`;
  ch.textContent = o.change_pct != null ? fmtPct(o.change_pct) : '';
}

async function loadDetail(item, { keepCharts = false } = {}) {
  const run = ++state.detailRun;
  const err = $('#d-error');
  err.hidden = true;
  if (!keepCharts) {
    $('#d-loading').hidden = false;
    $('#d-content').hidden = true;
    charts.destroy();
  }
  try {
    const d = await analyzeItem(item, true);
    if (run !== state.detailRun) return;
    state.detail = { item, data: d };
    fillHead(d);
    renderDetail(d);
    $('#d-loading').hidden = true;
    $('#d-content').hidden = false;
    if (!keepCharts || !charts.main) {
      requestAnimationFrame(() => {
        if (run !== state.detailRun) return;
        charts.build({ main: $('#chart-main'), rsi: $('#chart-rsi'), macd: $('#chart-macd'), legend: $('#chart-legend') }, d);
      });
    } else {
      charts.data = { ...charts.data, trade_plan: d.trade_plan };
      charts.setLevels(d.trade_plan);
    }
  } catch (e) {
    if (run !== state.detailRun) return;
    $('#d-loading').hidden = true;
    err.innerHTML = `<div class="banner-text"><strong>Analyse nicht verfügbar.</strong> ${esc(friendlyError(e) === 'Fehler' ? '' : `(${friendlyError(e)})`)}</div>
      <button type="button" class="btn btn-small btn-secondary" id="d-retry">Erneut versuchen</button>`;
    err.hidden = false;
    $('#d-retry').addEventListener('click', () => loadDetail(item));
  }
}

function renderDetail(d) {
  const s = Math.round(d.score);
  $('#d-score').innerHTML = `
    <div class="score-line">
      <span class="left"><span class="score ${trendClass(s)}">${fmtScore(s)}</span><span>Score</span></span>
      <span class="right">${confHTML(d.confidence)}</span>
    </div>
    ${gaugeHTML(s)}
    <div class="gauge-scale" aria-hidden="true"><span>−100 bärisch</span><span>0</span><span>bullisch +100</span></div>`;
  $('#d-summary').textContent = d.summary || '';
  $('#d-plan').innerHTML = planHTML(d);
  renderSignals(d);
  renderMetrics(d);
  const src = d.data_source === 'demo' ? 'Synthetische Demo-Daten' : d.data_source === 'live' ? 'Live-Daten (Binance)' : 'Tagesdaten, verzögert (Yahoo-Snapshot)';
  $('#d-meta').textContent = `${src} · Tageskerzen · Stand ${fmtDateTime(d.updated_at)} Uhr`;
  renderDetailActions(d);
}

function renderDetailActions(d) {
  const added = inWatchlist(d.symbol);
  $('#d-actions').innerHTML = added
    ? `<button type="button" class="btn btn-secondary" data-remove="${esc(d.symbol)}" data-from="sheet">Aus Watchlist entfernen</button>`
    : `<button type="button" class="btn btn-primary" data-add="${esc(d.symbol)}" data-class="${esc(d.asset_class)}" data-name="${esc(d.name || '')}" data-from="sheet">+ Zur Watchlist</button>`;
}

function planHTML(d) {
  const p = d.trade_plan;
  if (!p) {
    return '<p class="plan-none">Kein Trade-Plan: Das Setup ist <strong>neutral</strong> (|Score| unter 25). Die Signale widersprechen sich oder sind zu schwach – abwarten und beobachten ist hier auch eine Position.</p>';
  }
  const ref = p.entry;
  const isStock = d.asset_class === 'stock';
  const account = settings.account;
  const riskPctTxt = nf(0, 2).format(settings.risk);
  const pctFromEntry = (x) => fmtPct(((x - p.entry) / p.entry) * 100, 2);
  const units = isStock ? 'Stück' : (d.symbol.replace(/(USDT|USDC|FDUSD|EUR|TRY|BTC|ETH|BNB)$/, '') || 'Einheiten');
  const long = p.side === 'long';
  const warnings = [];
  if (!(p.position_size > 0)) {
    warnings.push(`<strong>Positionsgröße 0:</strong> Dein Risikobudget von ${fmtMoney((account * settings.risk) / 100)} reicht bei diesem Stop-Abstand nicht für eine ganze ${isStock ? 'Aktie' : 'Einheit'}. Trade auslassen oder Kontogröße/Risiko anpassen – nicht den Stop enger ziehen.`);
  }
  if (p.position_value > account * 1.0001) {
    warnings.push(`<strong>Positionswert über Kontogröße:</strong> ${fmtMoney(p.position_value, 0)} sind mehr als dein Konto (${fmtMoney(account, 0)}) – nur mit Hebel/Margin möglich. Lieber kleiner handeln.`);
  }
  if (!long && !isStock) {
    warnings.push('<strong>Short bei Krypto:</strong> Leerverkauf geht nur über Margin oder Futures (z.B. Perpetuals). Finanzierungskosten und Liquidationsrisiko beachten.');
  } else if (!long && isStock) {
    warnings.push('<strong>Short bei Aktien:</strong> Leerverkauf braucht ein Margin-Konto oder ein Produkt wie Put/Short-Zertifikat – dann gilt die Stückzahl nicht 1:1.');
  }
  const risk = Math.abs(p.entry - p.stop_loss) || 1;
  const r1 = Math.abs(p.take_profit_1 - p.entry), r2 = Math.abs(p.take_profit_2 - p.take_profit_1);
  const tot = risk + r1 + r2;
  const lossTxt = fmtMoney(p.max_loss, p.max_loss >= 100 ? 0 : 2);
  const verb = long ? (isStock ? 'kaufst' : 'kaufst') : 'verkaufst leer';
  return `
    <div class="plan-grid">
      <div class="plan-item side ${esc(p.side)}"><span class="k">Richtung</span><span class="v">${long ? 'Long' : 'Short'}</span><span class="s">${long ? 'Kauf' : 'Leerverkauf'} · R:R ${fmtNum(p.risk_reward, 1)} : 1</span></div>
      <div class="plan-item"><span class="k">Einstieg</span><span class="v">${fmtPrice(p.entry, ref)}</span><span class="s">aktueller Kurs</span></div>
      <div class="plan-item stop"><span class="k">Stop-Loss</span><span class="v">${fmtPrice(p.stop_loss, ref)}</span><span class="s">${pctFromEntry(p.stop_loss)} · 2× ATR</span></div>
      <div class="plan-item loss"><span class="k">Max. Verlust</span><span class="v">${fmtMoney(p.max_loss)}</span><span class="s">${riskPctTxt} % vom Konto</span></div>
      <div class="plan-item tp"><span class="k">Ziel 1 (1R)</span><span class="v">${fmtPrice(p.take_profit_1, ref)}</span><span class="s">${pctFromEntry(p.take_profit_1)}</span></div>
      <div class="plan-item tp"><span class="k">Ziel 2 (2R)</span><span class="v">${fmtPrice(p.take_profit_2, ref)}</span><span class="s">${pctFromEntry(p.take_profit_2)}</span></div>
      <div class="plan-item"><span class="k">Positionsgröße</span><span class="v">${fmtSize(p.position_size, d.asset_class)}</span><span class="s">${esc(units)}</span></div>
      <div class="plan-item"><span class="k">Positionswert</span><span class="v">${fmtMoney(p.position_value, p.position_value >= 1000 ? 0 : 2)}</span><span class="s">${fmtNum((p.position_value / account) * 100, 1)} % vom Konto</span></div>
    </div>
    <div class="rr-bar" aria-hidden="true"><span class="r" style="width:${(risk / tot) * 100}%"></span><span class="g1" style="width:${(r1 / tot) * 100}%"></span><span class="g2" style="width:${(r2 / tot) * 100}%"></span></div>
    <div class="rr-legend" aria-hidden="true"><span>Stop ${fmtPrice(p.stop_loss, ref)}</span><span>Entry ${fmtPrice(p.entry, ref)}</span><span>TP2 ${fmtPrice(p.take_profit_2, ref)}</span></div>
    <div class="plan-explain">
      <p><strong>Was heißt das?</strong> Du ${verb} ${p.position_size > 0 ? `<strong>${fmtSize(p.position_size, d.asset_class)} ${esc(units)}</strong>` : 'nichts'} zu ca. ${fmtPrice(p.entry, ref)}. ${long ? 'Fällt' : 'Steigt'} der Kurs auf ${fmtPrice(p.stop_loss, ref)}, greift der Stop – dann verlierst du höchstens <strong>${lossTxt}</strong> (${riskPctTxt} % deines Kontos).</p>
      <p>Bei Ziel 1 (${fmtPrice(p.take_profit_1, ref)}) liegst du etwa ${fmtMoney(p.max_loss, 0)} im Plus – guter Punkt, um die Hälfte ${long ? 'zu verkaufen' : 'zurückzukaufen'} und den Stop auf Einstand nachzuziehen. Ziel 2 entspricht etwa ${fmtMoney(p.max_loss * 2, 0)}.</p>
    </div>
    ${warnings.map((w) => `<p class="plan-warn">⚠ ${w}</p>`).join('')}
    <p class="fine">Risiko je Einheit ${fmtPrice(p.risk_per_unit, ref)}. Beträge in Kurswährung (${isStock ? 'USD/EUR je nach Börse' : 'USDT'}), vereinfachend als € dargestellt. Gebühren und Slippage nicht berücksichtigt.</p>`;
}

function renderSignals(d) {
  const list = [...(d.signals || [])].sort((a, b) => (b.weight || 0) - (a.weight || 0));
  $('#d-signals').innerHTML = list.length
    ? list.map((s) => `<li class="signal ${esc(s.direction)}">
        <span class="ico" aria-hidden="true">${s.direction === 'bullish' ? '↑' : '↓'}</span>
        <div><div class="nm">${esc(s.name)} <span class="sr-only">(${s.direction === 'bullish' ? 'bullisch' : 'bärisch'})</span></div><div class="ds">${esc(s.description)}</div></div>
        <span class="wt ${s.direction === 'bullish' ? 'up' : 'down'}" title="Beitrag zum Score">${s.direction === 'bullish' ? '+' : '−'}${fmtInt(s.weight)}</span>
      </li>`).join('')
    : '<li class="plan-none">Keine aktiven Signale.</li>';
}

function renderMetrics(d) {
  const m = d.metrics || {};
  const p = d.price;
  const dist = (x) => (x ? fmtPct(((p - x) / x) * 100, 1) : '–');
  const distCls = (x) => (x ? trendClass(p - x) : '');
  const rsiNote = m.rsi >= 70 ? 'überkauft' : m.rsi <= 30 ? 'überverkauft' : 'neutral';
  const volNote = m.volume_ratio >= 1.5 ? 'erhöht' : m.volume_ratio <= 0.7 ? 'schwach' : 'normal';
  const rows = [
    ['RSI (14)', `${fmtNum(m.rsi, 1)}<span class="sub">${rsiNote}</span>`],
    ['ATR (14)', `${fmtPrice(m.atr, p)}<span class="sub">${fmtNum(m.atr_pct, 2)} % vom Kurs</span>`],
    ['Volumen', `${fmtNum(m.volume_ratio, 2)}×<span class="sub">${volNote} vs. Ø 20 Tage</span>`],
    ['Abstand SMA20', `<span class="${distCls(m.sma20)}">${dist(m.sma20)}</span><span class="sub">${fmtPrice(m.sma20, p)}</span>`],
    ['Abstand SMA50', `<span class="${distCls(m.sma50)}">${dist(m.sma50)}</span><span class="sub">${fmtPrice(m.sma50, p)}</span>`],
    ['Abstand SMA200', `<span class="${distCls(m.sma200)}">${dist(m.sma200)}</span><span class="sub">${fmtPrice(m.sma200, p)}</span>`],
    ['52W-Hoch', `${fmtPrice(m.high_52w, p)}<span class="sub">${m.high_52w ? fmtPct(((p - m.high_52w) / m.high_52w) * 100, 1) : ''}</span>`],
    ['52W-Tief', `${fmtPrice(m.low_52w, p)}<span class="sub">${m.low_52w ? fmtPct(((p - m.low_52w) / m.low_52w) * 100, 1) : ''}</span>`],
  ];
  $('#d-metrics').innerHTML = rows.map(([k, v]) => `<tr><th scope="row">${k}</th><td>${v}</td></tr>`).join('');
}

function resetChecklist() {
  $$('#checklist input').forEach((c) => { c.checked = false; });
  updateChecklist();
}

function updateChecklist() {
  const boxes = $$('#checklist input');
  const n = boxes.filter((b) => b.checked).length;
  const pill = $('#check-progress');
  pill.textContent = `${n}/${boxes.length}`;
  pill.classList.toggle('done', n === boxes.length);
  const st = $('#check-status');
  st.classList.toggle('ok', n === boxes.length);
  st.textContent = n === boxes.length ? '✓ Alle Punkte erledigt – handle nach Plan.' : 'Erst alle Punkte abhaken, dann handeln.';
}

function initSheet() {
  const sheet = $('#sheet');
  $('#d-close').addEventListener('click', requestCloseDetail);
  $('#sheet-backdrop').addEventListener('click', requestCloseDetail);
  $('#checklist').addEventListener('change', updateChecklist);
  window.addEventListener('popstate', () => {
    if (state.sheetOpen && !(history.state && history.state.sheet)) closeDetail();
  });
  document.addEventListener('keydown', (e) => {
    if (!state.sheetOpen) return;
    if (e.key === 'Escape') { e.preventDefault(); requestCloseDetail(); return; }
    if (e.key === 'Tab') {
      const f = $$('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])', sheet).filter((el) => !el.disabled && el.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      else if (!sheet.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    }
  });
  $$('.ind-toggle').forEach((b) => {
    b.setAttribute('aria-pressed', String(charts.visible[b.dataset.ind]));
    b.addEventListener('click', () => b.setAttribute('aria-pressed', String(charts.toggle(b.dataset.ind))));
  });

  // Drag the header down to dismiss (like a native sheet).
  const head = $('#sheet-head');
  let startY = null, dy = 0, dragging = false, pid = null;
  head.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    startY = e.clientY; dy = 0; dragging = false; pid = e.pointerId;
  });
  head.addEventListener('pointermove', (e) => {
    if (startY == null || e.pointerId !== pid) return;
    dy = Math.max(0, e.clientY - startY);
    if (!dragging && dy > 8) {
      dragging = true;
      sheet.classList.add('dragging');
      try { head.setPointerCapture(pid); } catch { /* ignore */ }
    }
    if (dragging) sheet.style.transform = `translateY(${dy}px)`;
  });
  const end = () => {
    if (startY == null) return;
    const wasDragging = dragging;
    startY = null; dragging = false;
    sheet.classList.remove('dragging');
    if (!wasDragging) return;
    if (dy > 110) requestCloseDetail();
    else sheet.style.transform = '';
  };
  head.addEventListener('pointerup', end);
  head.addEventListener('pointercancel', end);
  // swallow the click that ends a drag so buttons in the header aren't triggered
  head.addEventListener('click', (e) => { if (dy > 8) { e.stopPropagation(); e.preventDefault(); dy = 0; } }, true);
}

// ---------------------------------------------------------------- global clicks
function initClicks() {
  document.addEventListener('click', (e) => {
    const add = e.target.closest('[data-add]');
    if (add) {
      e.preventDefault();
      if (add.disabled || add.getAttribute('aria-pressed') === 'true') { toast(`${add.dataset.add} ist bereits in der Watchlist`); return; }
      const ok = addToWatchlist({ symbol: add.dataset.add, asset_class: add.dataset.class, name: add.dataset.name }, { silent: add.classList.contains('result-btn') });
      if (add.classList.contains('result-btn') && ok) toast(`${add.dataset.add} hinzugefügt`);
      if (add.dataset.from === 'sheet' && state.detail) renderDetailActions(state.detail.data);
      refreshWatchlistUI();
      return;
    }
    const rm = e.target.closest('[data-remove]');
    if (rm) {
      removeFromWatchlist(rm.dataset.remove);
      if (rm.dataset.from === 'sheet' && state.detail) renderDetailActions(state.detail.data);
      if (state.view === 'watchlist') { renderWatchlist(); renderSearch(); renderFreshness(); $('#stock-search').focus({ preventScroll: true }); }
      if (state.view === 'radar') renderRadar();
      return;
    }
    const open = e.target.closest('[data-open]');
    if (open) { openDetail({ symbol: open.dataset.open, asset_class: open.dataset.class }, open); return; }
    const card = e.target.closest('.card:not(.skeleton)');
    if (card) { const b = $('.card-hit', card); if (b) openDetail({ symbol: b.dataset.open, asset_class: b.dataset.class }, b); return; }
    const go = e.target.closest('[data-goto]');
    if (go) { setView(go.dataset.goto); return; }
    const act = e.target.closest('[data-action="rescan-market"]');
    if (act) scanMarket({ force: true });
  });

  $$('.nav-btn').forEach((b) => b.addEventListener('click', () => {
    if (state.view === b.dataset.nav) window.scrollTo({ top: 0, behavior: 'smooth' });
    else setView(b.dataset.nav);
  }));
  $('#btn-refresh').addEventListener('click', onRefresh);
  $('#stock-search').addEventListener('input', renderSearch);
  $('#crypto-form').addEventListener('submit', onCryptoSubmit);
  $('#crypto-input').addEventListener('input', () => { $('#crypto-input').removeAttribute('aria-invalid'); });
}

// ---------------------------------------------------------------- PWA
function initPWA() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.installEvent = e;
    if (state.view === 'settings') renderInstall();
  });
  window.addEventListener('appinstalled', () => { state.installEvent = null; toast('Trading Radar wurde installiert'); if (state.view === 'settings') renderInstall(); });

  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return; // first install: nothing to reload
    reloading = true;
    location.reload();
  });
  const showUpdate = (worker) => {
    const banner = $('#update-banner');
    banner.hidden = false;
    $('#btn-update').onclick = () => { $('#btn-update').disabled = true; worker.postMessage({ type: 'SKIP_WAITING' }); };
  };
  const register = async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
      if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) showUpdate(w);
        });
      });
      // check for updates when the app returns to the foreground
      document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
    } catch (err) {
      console.warn('Service Worker nicht registriert:', err);
    }
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

// ---------------------------------------------------------------- boot
function boot() {
  setDemoMode(settings.demo);
  applyTheme();
  window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', () => { if (settings.theme === 'system') applyTheme(); });
  initFilters();
  initSettings();
  initSheet();
  initClicks();
  initPWA();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || state.sheetOpen) return;
    if (state.view === 'radar' && !state.radar.loading && Date.now() - state.radar.at > RADAR_STALE_MS) scanRadar({ silent: true });
  });
  const initial = (location.hash || '').replace('#', '');
  // a reload while the sheet was open leaves a stale {sheet} history entry → normalise
  try { if (history.state?.sheet) history.replaceState(null, '', location.href); } catch { /* ignore */ }
  setView(VIEWS.includes(initial) ? initial : 'radar');
  ensureUniverse();
}

boot();
