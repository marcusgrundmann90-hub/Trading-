// Trading Radar – frontend logic (no build step, ES module).
// Talks to the backend via relative /api/... URLs (see docs/API.md).

const AUTO_REFRESH_MS = 5 * 60 * 1000;
const LS = { account: 'tr.account', risk: 'tr.risk', theme: 'tr.theme', auto: 'tr.auto' };
const CONF_RANK = { low: 0, medium: 1, high: 2 };
const CONF_LABEL = { low: 'niedrig', medium: 'mittel', high: 'hoch' };
const DIR_LABEL = { long: 'Long', short: 'Short', neutral: 'Neutral' };
const CLASS_LABEL = { stock: 'Aktie', crypto: 'Krypto' };

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, String(value));
  } catch { /* storage unavailable */ }
  return null;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const nfCache = new Map();
function nf(min, max = min, extra = {}) {
  const k = `${min}|${max}|${JSON.stringify(extra)}`;
  if (!nfCache.has(k)) nfCache.set(k, new Intl.NumberFormat('de-DE', { minimumFractionDigits: min, maximumFractionDigits: max, ...extra }));
  return nfCache.get(k);
}

/** Number of decimals appropriate for a price (small crypto prices need more). */
function priceDecimals(p) {
  const a = Math.abs(Number(p));
  if (!isFinite(a) || a === 0) return 2;
  if (a >= 1000) return 2;
  if (a >= 1) return 2;
  if (a >= 0.1) return 4;
  // keep ~4 significant digits for tiny prices
  return Math.min(10, Math.ceil(-Math.log10(a)) + 3);
}
const fmtPrice = (p, ref = p) => (p == null || !isFinite(p) ? '–' : nf(priceDecimals(ref)).format(p));
const fmtNum = (v, d = 2) => (v == null || !isFinite(v) ? '–' : nf(d).format(v));
const fmtInt = (v) => (v == null || !isFinite(v) ? '–' : nf(0).format(v));
const fmtMoney = (v, d = 2) => (v == null || !isFinite(v) ? '–' : `${nf(d).format(v)} €`);
const fmtPct = (v, d = 2, sign = true) => (v == null || !isFinite(v) ? '–' : `${sign && v > 0 ? '+' : ''}${nf(d).format(v)} %`);
const trendClass = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');
const fmtSize = (v, cls) => {
  if (v == null || !isFinite(v)) return '–';
  if (cls === 'stock' || Number.isInteger(v)) return nf(0).format(v);
  return nf(0, v >= 100 ? 2 : v >= 1 ? 4 : 6).format(v);
};
const fmtTime = (ts) => (ts ? new Date(ts * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '–');
const fmtDate = (ts) => (ts ? new Date(ts * 1000).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : '–');

class ApiError extends Error {
  constructor(status, detail) { super(detail || `HTTP ${status}`); this.status = status; this.detail = detail; }
}

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, { headers: { Accept: 'application/json', ...(opts.body ? { 'Content-Type': 'application/json' } : {}) }, ...opts });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError(0, 'Server nicht erreichbar.');
  }
  if (res.status === 204) return null;
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    let detail = data && data.detail;
    if (Array.isArray(detail)) detail = detail.map((d) => d.msg || JSON.stringify(d)).join('; ');
    else if (detail && typeof detail !== 'string') detail = JSON.stringify(detail);
    throw new ApiError(res.status, detail || `HTTP ${res.status}`);
  }
  return data;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 3200);
}

// ---------- state ----------
const state = {
  assetClass: 'all',
  dirs: new Set(), // empty = all
  minConf: 'low',
  account: clampNum(parseFloat(store(LS.account)), 100, 1e9, 10000),
  risk: clampNum(parseFloat(store(LS.risk)), 0.25, 3, 1),
  opportunities: [],
  generatedAt: null,
  loading: false,
  scanCtrl: null,
  autoTimer: null,
  mode: null,
  detail: null, // current analysis
  detailCtrl: null,
  lastFocus: null,
};

function clampNum(v, min, max, fallback) {
  if (!isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

// ---------- header: settings, health, theme ----------
function initSettings() {
  const acc = $('#in-account'), riskN = $('#in-risk'), riskR = $('#in-risk-range');
  acc.value = state.account;
  riskN.value = state.risk;
  riskR.value = state.risk;
  updateRiskSummary();

  let t;
  const commit = () => {
    clearTimeout(t);
    t = setTimeout(() => {
      store(LS.account, state.account);
      store(LS.risk, state.risk);
      loadScan();
      if (state.detail) loadDetail(state.detail.symbol, state.detail.asset_class, { keepCharts: true });
    }, 450);
  };

  acc.addEventListener('input', () => {
    const v = parseFloat(acc.value);
    if (!isFinite(v) || v < 100) return;
    state.account = clampNum(v, 100, 1e9, 10000);
    updateRiskSummary();
    commit();
  });
  acc.addEventListener('blur', () => { acc.value = state.account; });

  const setRisk = (v, from) => {
    if (!isFinite(v)) return;
    state.risk = clampNum(Math.round(v * 100) / 100, 0.25, 3, 1);
    if (from !== riskR) riskR.value = state.risk;
    if (from !== riskN) riskN.value = state.risk;
    updateRiskSummary();
    commit();
  };
  riskR.addEventListener('input', () => setRisk(parseFloat(riskR.value), riskR));
  riskN.addEventListener('input', () => {
    const v = parseFloat(riskN.value);
    if (isFinite(v) && v >= 0.25 && v <= 3) setRisk(v, riskN);
  });
  riskN.addEventListener('blur', () => { riskN.value = state.risk; });
}

function riskAmount() { return (state.account * state.risk) / 100; }

function updateRiskSummary() {
  $('#risk-summary').innerHTML = `Max. Verlust je Trade: <strong>${fmtMoney(riskAmount())}</strong>`;
}

async function loadHealth() {
  const b = $('#mode-badge');
  try {
    const h = await api('/api/health');
    state.mode = h.mode;
    b.hidden = false;
    if (h.mode === 'live') {
      b.className = 'mode-badge live';
      b.textContent = 'LIVE';
      b.title = 'Echte Marktdaten (Yahoo Finance / Binance)';
    } else {
      b.className = 'mode-badge demo';
      b.textContent = 'DEMO';
      b.title = 'Synthetische Daten – keine echten Kurse';
    }
    b.setAttribute('aria-label', `Datenmodus: ${b.textContent}. ${b.title}`);
    b.tabIndex = 0;
  } catch {
    b.hidden = false;
    b.className = 'mode-badge offline';
    b.textContent = 'OFFLINE';
    b.title = 'Backend nicht erreichbar';
  }
}

function initTheme() {
  const btn = $('#btn-theme');
  const sync = () => {
    const light = document.documentElement.getAttribute('data-theme') === 'light';
    btn.setAttribute('aria-label', light ? 'Dunkles Design aktivieren' : 'Helles Design aktivieren');
  };
  sync();
  btn.addEventListener('click', () => {
    const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    store(LS.theme, next);
    sync();
    charts.retheme();
  });
}

function initRefresh() {
  $('#btn-refresh').addEventListener('click', () => { loadHealth(); loadScan(); });
  $('#btn-retry').addEventListener('click', () => loadScan());
  const auto = $('#btn-auto');
  const apply = (on) => {
    auto.setAttribute('aria-pressed', String(on));
    clearInterval(state.autoTimer);
    state.autoTimer = on ? setInterval(() => { if (!document.hidden) loadScan({ silent: true }); }, AUTO_REFRESH_MS) : null;
    store(LS.auto, on ? '1' : '0');
  };
  apply(store(LS.auto) === '1');
  auto.addEventListener('click', () => {
    const on = auto.getAttribute('aria-pressed') !== 'true';
    apply(on);
    toast(on ? 'Auto-Aktualisierung alle 5 Minuten aktiv' : 'Auto-Aktualisierung aus');
  });
}

// ---------- filters ----------
function initFilters() {
  const tabs = $$('.tab');
  tabs.forEach((tab, i) => {
    tab.tabIndex = tab.getAttribute('aria-selected') === 'true' ? 0 : -1;
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', (e) => {
      let j = null;
      if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
      if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
      if (j !== null) { e.preventDefault(); tabs[j].focus(); selectTab(tabs[j]); }
    });
  });
  function selectTab(tab) {
    if (tab.getAttribute('aria-selected') === 'true') return;
    tabs.forEach((t) => { const on = t === tab; t.setAttribute('aria-selected', String(on)); t.tabIndex = on ? 0 : -1; });
    state.assetClass = tab.dataset.asset;
    loadScan();
  }
  $$('.chip-toggle').forEach((chip) => chip.addEventListener('click', () => {
    const on = chip.getAttribute('aria-pressed') !== 'true';
    chip.setAttribute('aria-pressed', String(on));
    on ? state.dirs.add(chip.dataset.dir) : state.dirs.delete(chip.dataset.dir);
    render();
  }));
  $('#sel-confidence').addEventListener('change', (e) => { state.minConf = e.target.value; render(); });
}

// ---------- scan ----------
async function loadScan({ silent = false } = {}) {
  state.scanCtrl?.abort();
  const ctrl = new AbortController();
  state.scanCtrl = ctrl;
  state.loading = true;
  const btn = $('#btn-refresh');
  btn.classList.add('spinning');
  if (!silent || !state.opportunities.length) renderSkeletons();
  const qs = new URLSearchParams({ asset_class: state.assetClass, account_size: String(state.account), risk_pct: String(state.risk) });
  try {
    const data = await api(`/api/scan?${qs}`, { signal: ctrl.signal });
    state.opportunities = Array.isArray(data?.opportunities) ? data.opportunities : [];
    state.generatedAt = data?.generated_at ?? Math.floor(Date.now() / 1000);
    $('#error-banner').hidden = true;
    render();
  } catch (e) {
    if (e.name === 'AbortError') return;
    $('#error-detail').textContent = e.status ? `${e.message} (Status ${e.status})` : e.message;
    $('#error-banner').hidden = false;
    if (!state.opportunities.length || !silent) { state.opportunities = []; render({ failed: true }); }
  } finally {
    if (state.scanCtrl === ctrl) { state.loading = false; btn.classList.remove('spinning'); }
  }
}

function renderSkeletons() {
  const grid = $('#grid');
  grid.setAttribute('aria-busy', 'true');
  $('#empty').hidden = true;
  $('#watch-section').hidden = true;
  $('#scan-meta').textContent = 'Lade Marktdaten …';
  grid.innerHTML = Array.from({ length: 6 }, () => `
    <div class="card skeleton" aria-hidden="true">
      <div class="card-top"><div style="flex:1"><div class="skel" style="width:40%;height:16px"></div><div class="skel" style="width:60%;margin-top:8px"></div></div><div class="skel" style="width:70px;height:16px"></div></div>
      <div class="skel" style="height:8px"></div>
      <div class="skel" style="width:95%"></div><div class="skel" style="width:75%"></div>
      <div style="display:flex;gap:6px"><div class="skel" style="width:80px;height:20px;border-radius:999px"></div><div class="skel" style="width:100px;height:20px;border-radius:999px"></div></div>
    </div>`).join('');
}

function passesFilter(o) {
  if (state.dirs.size && !state.dirs.has(o.direction)) return false;
  if ((CONF_RANK[o.confidence] ?? 0) < CONF_RANK[state.minConf]) return false;
  return true;
}

function render({ failed = false } = {}) {
  const grid = $('#grid');
  grid.setAttribute('aria-busy', 'false');
  const all = state.opportunities;
  const visible = all.filter(passesFilter);
  const actionable = visible.filter((o) => o.direction !== 'neutral');
  const neutral = visible.filter((o) => o.direction === 'neutral');

  grid.innerHTML = actionable.map(cardHTML).join('');
  $('#watch-list').innerHTML = neutral.map(watchRowHTML).join('');
  $('#watch-section').hidden = neutral.length === 0;

  const empty = $('#empty');
  empty.hidden = failed || actionable.length > 0;
  if (!empty.hidden) {
    $('#empty-text').textContent = all.length === 0
      ? 'Die Watchlist ist leer. Füge über „Watchlist“ Aktien oder Krypto-Paare hinzu.'
      : neutral.length
        ? 'Aktuell kein Symbol mit klarer Richtung – siehe „Beobachten“ unten.'
        : 'Kein Symbol passt zu den gewählten Filtern. Lockere die Filter, um mehr zu sehen.';
  }
  if (failed) grid.innerHTML = '';

  const long = all.filter((o) => o.direction === 'long').length;
  const short = all.filter((o) => o.direction === 'short').length;
  $('#scan-meta').textContent = failed ? '' :
    `${all.length} Symbole analysiert · ${long} Long · ${short} Short · Stand ${fmtTime(state.generatedAt)} Uhr`;
}

function gaugeHTML(score, cls = '') {
  const s = Math.max(-100, Math.min(100, Number(score) || 0));
  const w = Math.abs(s) / 2;
  const pos = s >= 0 ? `left:50%;width:${w}%` : `left:${50 - w}%;width:${w}%`;
  return `<div class="gauge ${cls}" role="meter" aria-valuemin="-100" aria-valuemax="100" aria-valuenow="${s}" aria-label="Score ${s} von -100 bis +100">
    <div class="gauge-fill ${s >= 0 ? 'up' : 'down'}" style="${pos}"></div></div>`;
}

function confHTML(c) {
  const n = (CONF_RANK[c] ?? 0) + 1;
  return `<span class="conf" title="Konfidenz: ${CONF_LABEL[c] || c}"><span class="conf-bars" aria-hidden="true">${[1, 2, 3].map((i) => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</span>${CONF_LABEL[c] || esc(c)}</span>`;
}

function topSignals(o, n = 3) {
  return [...(o.signals || [])].sort((a, b) => (b.weight || 0) - (a.weight || 0)).slice(0, n);
}

function cardHTML(o) {
  const sig = topSignals(o);
  const s = Math.round(o.score);
  const demo = o.data_source === 'demo' && state.mode === 'live' ? '<span class="tag demo" title="Live-Abruf fehlgeschlagen – synthetische Daten">Demo</span>' : '';
  return `<article class="card ${esc(o.direction)}">
    <div class="card-top">
      <div class="card-id">
        <div class="card-sym">
          <h3 class="sym"><button type="button" class="card-hit" data-symbol="${esc(o.symbol)}" data-class="${esc(o.asset_class)}" aria-label="Details zu ${esc(o.symbol)} öffnen">${esc(o.symbol)}</button></h3>
          <span class="tag ${esc(o.asset_class)}">${CLASS_LABEL[o.asset_class] || esc(o.asset_class)}</span>${demo}
        </div>
        <div class="card-name">${esc(o.name || '')}</div>
      </div>
      <div class="card-price">
        <span class="mono">${fmtPrice(o.price)}</span>
        <span class="change ${trendClass(o.change_pct)}">${fmtPct(o.change_pct)}</span>
      </div>
    </div>
    <div class="gauge-wrap">
      <div class="gauge-head">
        <span><span class="score ${trendClass(s)}">${s > 0 ? '+' : ''}${s}</span> Score</span>
        <span style="display:flex;gap:10px;align-items:center">${confHTML(o.confidence)}<span class="dir-badge ${esc(o.direction)}">${DIR_LABEL[o.direction] || esc(o.direction)}</span></span>
      </div>
      ${gaugeHTML(s)}
      <div class="gauge-scale" aria-hidden="true"><span>−100 bärisch</span><span>0</span><span>bullisch +100</span></div>
    </div>
    <p class="card-summary">${esc(o.summary)}</p>
    ${sig.length ? `<ul class="chips" aria-label="Wichtigste Signale">${sig.map((x) => `<li class="chip ${esc(x.direction)}" title="${esc(x.description)}">${esc(x.name)}</li>`).join('')}</ul>` : ''}
    <div class="card-foot">
      ${o.trade_plan ? `<span>Stop <span class="mono">${fmtPrice(o.trade_plan.stop_loss, o.price)}</span> · R:R <span class="mono">${fmtNum(o.trade_plan.risk_reward, 1)}</span></span>` : '<span>Kein Trade-Plan</span>'}
      <span class="card-cta" aria-hidden="true">Analyse →</span>
    </div>
  </article>`;
}

function watchRowHTML(o) {
  const s = Math.round(o.score);
  return `<li><button type="button" class="watch-row" data-symbol="${esc(o.symbol)}" data-class="${esc(o.asset_class)}" aria-label="Details zu ${esc(o.symbol)} öffnen">
    <span class="watch-id"><span class="sym">${esc(o.symbol)}</span><span class="tag ${esc(o.asset_class)}">${CLASS_LABEL[o.asset_class] || ''}</span><span class="name">${esc(o.name || '')}</span></span>
    <span class="watch-price"><span class="mono">${fmtPrice(o.price)}</span><span class="change ${trendClass(o.change_pct)}">${fmtPct(o.change_pct)}</span></span>
    <span class="mini-gauge"><span class="mono" style="min-width:32px;text-align:right">${s > 0 ? '+' : ''}${s}</span>${gaugeHTML(s)}</span>
    <span class="chev" aria-hidden="true">›</span>
  </button></li>`;
}

function initGridClicks() {
  document.addEventListener('click', (e) => {
    const hit = e.target.closest('.card-hit, .watch-row');
    if (hit) { state.lastFocus = hit; openDrawer(hit.dataset.symbol, hit.dataset.class); return; }
    // Make the whole card clickable (pointer users) without nesting interactive content.
    const card = e.target.closest('.card:not(.skeleton)');
    if (card) { const b = $('.card-hit', card); state.lastFocus = b; openDrawer(b.dataset.symbol, b.dataset.class); }
  });
}

// ---------- charts ----------
const charts = {
  main: null, rsi: null, macd: null,
  series: {}, priceLines: [], ro: null, syncing: false,
  visible: { sma20: true, sma50: true, sma200: true, bb: false, levels: true },

  available() { return typeof window.LightweightCharts !== 'undefined'; },

  baseOptions(showTime, logo = false) {
    return {
      layout: { background: { type: 'solid', color: 'transparent' }, textColor: cssVar('--muted'), fontFamily: cssVar('--font') || 'Inter, sans-serif', fontSize: 11, attributionLogo: logo },
      grid: { vertLines: { color: cssVar('--border') + '80' }, horzLines: { color: cssVar('--border') + '80' } },
      rightPriceScale: { borderColor: cssVar('--border'), minimumWidth: 78 },
      timeScale: { borderColor: cssVar('--border'), visible: showTime, timeVisible: false, rightOffset: 4 },
      crosshair: { mode: 1, vertLine: { color: cssVar('--muted'), labelBackgroundColor: cssVar('--surface-3') }, horzLine: { color: cssVar('--muted'), labelBackgroundColor: cssVar('--surface-3') } },
      handleScroll: { vertTouchDrag: false },
    };
  },

  destroy() {
    this.ro?.disconnect();
    this.ro = null;
    for (const k of ['main', 'rsi', 'macd']) { try { this[k]?.remove(); } catch { /* ignore */ } this[k] = null; }
    this.series = {};
    this.priceLines = [];
    for (const id of ['chart-main', 'chart-rsi', 'chart-macd']) $('#' + id).innerHTML = '';
  },

  build(d) {
    this.destroy();
    if (!this.available()) {
      $('#chart-main').innerHTML = '<div class="chart-fallback">Chart-Bibliothek konnte nicht geladen werden (Internetverbindung zu unpkg.com prüfen).</div>';
      return;
    }
    const LC = window.LightweightCharts;
    const elMain = $('#chart-main'), elRsi = $('#chart-rsi'), elMacd = $('#chart-macd');
    const prec = priceDecimals(d.price);
    const priceFormat = { type: 'price', precision: prec, minMove: Math.pow(10, -prec) };
    const up = cssVar('--up'), down = cssVar('--down');

    this.main = LC.createChart(elMain, { ...this.baseOptions(false, true), localization: { locale: 'de-DE', dateFormat: 'dd.MM.yyyy' }, width: elMain.clientWidth, height: elMain.clientHeight });
    this.rsi = LC.createChart(elRsi, { ...this.baseOptions(false), width: elRsi.clientWidth, height: elRsi.clientHeight });
    this.macd = LC.createChart(elMacd, { ...this.baseOptions(true), width: elMacd.clientWidth, height: elMacd.clientHeight });

    const S = this.series;
    const ind = d.indicators || {};
    const candles = (d.candles || []).map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));

    // Volume (overlay at bottom of main chart)
    S.volume = this.main.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
    this.main.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, visible: false });
    S.volume.setData((d.candles || []).map((c) => ({ time: c.time, value: c.volume || 0, color: (c.close >= c.open ? up : down) + '55' })));

    const line = (key, color, opts = {}) => {
      const s = this.main.addLineSeries({ color, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, priceFormat, ...opts });
      s.setData(ind[key] || []);
      return s;
    };
    S.bb_upper = line('bb_upper', cssVar('--c-bb'), { lineWidth: 1, lineStyle: 2 });
    S.bb_lower = line('bb_lower', cssVar('--c-bb'), { lineWidth: 1, lineStyle: 2 });
    S.sma200 = line('sma200', cssVar('--c-sma200'));
    S.sma50 = line('sma50', cssVar('--c-sma50'));
    S.sma20 = line('sma20', cssVar('--c-sma20'));

    S.candles = this.main.addCandlestickSeries({
      upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down, priceFormat,
    });
    S.candles.setData(candles);
    this.main.priceScale('right').applyOptions({ scaleMargins: { top: 0.08, bottom: 0.2 } });

    // Whitespace series so every pane has the same time axis (keeps logical ranges in sync)
    const ws = candles.map((c) => ({ time: c.time }));
    const macdPrec = Math.max(2, prec + 1);
    const macdFormat = { type: 'price', precision: macdPrec, minMove: Math.pow(10, -macdPrec) };
    this.rsi.addLineSeries({ lastValueVisible: false, priceLineVisible: false, priceFormat: { type: 'price', precision: 1, minMove: 0.1 } }).setData(ws);
    this.macd.addLineSeries({ lastValueVisible: false, priceLineVisible: false, priceFormat: macdFormat }).setData(ws);
    // German number formatting on the price axes
    this.main.applyOptions({ localization: { locale: 'de-DE', dateFormat: 'dd.MM.yyyy', priceFormatter: (v) => nf(prec).format(v) } });
    this.rsi.applyOptions({ localization: { locale: 'de-DE', dateFormat: 'dd.MM.yyyy', priceFormatter: (v) => nf(1).format(v) } });
    this.macd.applyOptions({ localization: { locale: 'de-DE', dateFormat: 'dd.MM.yyyy', priceFormatter: (v) => nf(macdPrec).format(v) } });
    this.rsi.priceScale('right').applyOptions({ scaleMargins: { top: 0.06, bottom: 0.06 } });

    // RSI pane
    S.rsi = this.rsi.addLineSeries({ color: cssVar('--accent'), lineWidth: 1.5, priceLineVisible: false, crosshairMarkerVisible: false, priceFormat: { type: 'price', precision: 1, minMove: 0.1 }, autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) });
    S.rsi.setData(ind.rsi || []);
    this.rsiLines = [70, 30].map((v) => S.rsi.createPriceLine({ price: v, color: (v === 70 ? down : up), lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '' }));

    // MACD pane
    S.macd_hist = this.macd.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false, priceFormat: macdFormat });
    S.macd_hist.setData((ind.macd_hist || []).map((p) => ({ ...p, color: (p.value >= 0 ? up : down) + '99' })));
    S.macd = this.macd.addLineSeries({ color: cssVar('--accent'), lineWidth: 1.5, priceLineVisible: false, crosshairMarkerVisible: false, priceFormat: macdFormat });
    S.macd.setData(ind.macd || []);
    S.macd_signal = this.macd.addLineSeries({ color: cssVar('--c-sma20'), lineWidth: 1.5, priceLineVisible: false, crosshairMarkerVisible: false, lastValueVisible: false, priceFormat: macdFormat });
    S.macd_signal.setData(ind.macd_signal || []);

    this.setLevels(d.trade_plan, d.price);
    this.applyVisibility();

    // Sync visible range across panes
    const all = [this.main, this.rsi, this.macd];
    all.forEach((src) => src.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (this.syncing || !range) return;
      this.syncing = true;
      all.forEach((dst) => { if (dst !== src) dst.timeScale().setVisibleLogicalRange(range); });
      this.syncing = false;
    }));
    // Show roughly the last 6 months by default
    const n = candles.length;
    if (n > 130) this.main.timeScale().setVisibleLogicalRange({ from: n - 130, to: n + 3 });
    else this.main.timeScale().fitContent();

    // Resize with container
    this.ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const ch = e.target === elMain ? this.main : e.target === elRsi ? this.rsi : this.macd;
        const { width, height } = e.contentRect;
        if (ch && width > 0) ch.applyOptions({ width: Math.floor(width), height: Math.floor(height) });
      }
    });
    [elMain, elRsi, elMacd].forEach((el) => this.ro.observe(el));
  },

  setLevels(plan, ref) {
    if (!this.series.candles) return;
    this.priceLines.forEach((l) => this.series.candles.removePriceLine(l));
    this.priceLines = [];
    if (!plan || !this.visible.levels) return;
    const up = cssVar('--up'), down = cssVar('--down'), accent = cssVar('--accent');
    const mk = (price, color, title, style = 2) => price != null && this.priceLines.push(
      this.series.candles.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title }));
    mk(plan.entry, accent, 'Entry', 0);
    mk(plan.stop_loss, down, 'Stop');
    mk(plan.take_profit_1, up, 'TP1');
    mk(plan.take_profit_2, up, 'TP2');
  },

  applyVisibility() {
    const S = this.series;
    if (!S.candles) return;
    S.sma20.applyOptions({ visible: this.visible.sma20 });
    S.sma50.applyOptions({ visible: this.visible.sma50 });
    S.sma200.applyOptions({ visible: this.visible.sma200 });
    S.bb_upper.applyOptions({ visible: this.visible.bb });
    S.bb_lower.applyOptions({ visible: this.visible.bb });
  },

  retheme() {
    if (!this.main) return;
    const up = cssVar('--up'), down = cssVar('--down');
    [['main', false, true], ['rsi', false], ['macd', true]].forEach(([k, t, l]) => this[k]?.applyOptions(this.baseOptions(t, l)));
    const S = this.series;
    S.candles.applyOptions({ upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down });
    S.sma20.applyOptions({ color: cssVar('--c-sma20') });
    S.sma50.applyOptions({ color: cssVar('--c-sma50') });
    S.sma200.applyOptions({ color: cssVar('--c-sma200') });
    S.bb_upper.applyOptions({ color: cssVar('--c-bb') });
    S.bb_lower.applyOptions({ color: cssVar('--c-bb') });
    S.rsi.applyOptions({ color: cssVar('--accent') });
    S.macd.applyOptions({ color: cssVar('--accent') });
    S.macd_signal.applyOptions({ color: cssVar('--c-sma20') });
    this.rsiLines?.forEach((l, i) => l.applyOptions({ color: i === 0 ? down : up }));
    const d = state.detail;
    if (d) {
      S.volume.setData((d.candles || []).map((c) => ({ time: c.time, value: c.volume || 0, color: (c.close >= c.open ? up : down) + '55' })));
      S.macd_hist.setData((d.indicators?.macd_hist || []).map((p) => ({ ...p, color: (p.value >= 0 ? up : down) + '99' })));
      this.setLevels(d.trade_plan, d.price);
    }
  },
};

function initChartToggles() {
  $$('.ind-toggle').forEach((b) => {
    b.setAttribute('aria-pressed', String(charts.visible[b.dataset.ind]));
    b.addEventListener('click', () => {
      const k = b.dataset.ind;
      charts.visible[k] = !charts.visible[k];
      b.setAttribute('aria-pressed', String(charts.visible[k]));
      if (k === 'levels') charts.setLevels(state.detail?.trade_plan, state.detail?.price);
      else charts.applyVisibility();
    });
  });
}

// ---------- detail drawer ----------
function openDrawer(symbol, assetClass) {
  const drawer = $('#drawer');
  const wasOpen = !drawer.hidden;
  drawer.hidden = false;
  $('#drawer-backdrop').hidden = false;
  document.body.classList.add('no-scroll');
  if (!wasOpen) $('#d-close').focus();

  // Pre-fill the header from scan data for instant feedback
  const o = state.opportunities.find((x) => x.symbol === symbol);
  fillHead(o || { symbol, asset_class: assetClass });
  $('#drawer-body').scrollTop = 0;
  resetChecklist();
  loadDetail(symbol, assetClass);
}

function closeDrawer() {
  const drawer = $('#drawer');
  if (drawer.hidden) return;
  state.detailCtrl?.abort();
  drawer.hidden = true;
  $('#drawer-backdrop').hidden = true;
  document.body.classList.remove('no-scroll');
  charts.destroy();
  state.detail = null;
  if (state.lastFocus && document.contains(state.lastFocus)) state.lastFocus.focus();
  else {
    // the card may have been re-rendered: refocus by symbol
    const sym = state.lastFocus?.dataset?.symbol;
    const el = sym && $(`[data-symbol="${CSS.escape(sym)}"]`);
    el?.focus();
  }
}

function fillHead(o) {
  $('#d-title').textContent = o.symbol;
  $('#d-name').textContent = o.name || '';
  const tag = $('#d-tag');
  tag.className = `tag ${o.asset_class || ''}`;
  tag.textContent = CLASS_LABEL[o.asset_class] || '';
  const dir = $('#d-dir');
  dir.hidden = !o.direction;
  dir.className = `dir-badge ${o.direction || ''}`;
  dir.textContent = DIR_LABEL[o.direction] || '';
  $('#d-price').textContent = o.price != null ? fmtPrice(o.price) : '';
  const ch = $('#d-change');
  ch.className = `change ${trendClass(o.change_pct)}`;
  ch.textContent = o.change_pct != null ? fmtPct(o.change_pct) : '';
}

async function loadDetail(symbol, assetClass, { keepCharts = false } = {}) {
  state.detailCtrl?.abort();
  const ctrl = new AbortController();
  state.detailCtrl = ctrl;
  const err = $('#d-error');
  err.hidden = true;
  if (!keepCharts) {
    $('#d-loading').hidden = false;
    $('#d-content').hidden = true;
    charts.destroy();
  }
  const qs = new URLSearchParams({ asset_class: assetClass || 'stock', account_size: String(state.account), risk_pct: String(state.risk) });
  try {
    const d = await api(`/api/analysis/${encodeURIComponent(symbol)}?${qs}`, { signal: ctrl.signal });
    if (ctrl.signal.aborted) return;
    state.detail = d;
    fillHead(d);
    renderDetail(d);
    $('#d-loading').hidden = true;
    $('#d-content').hidden = false;
    if (!keepCharts || !charts.main) {
      // build after content is visible so containers have a size
      requestAnimationFrame(() => { if (state.detail === d) charts.build(d); });
    } else {
      charts.setLevels(d.trade_plan, d.price);
    }
  } catch (e) {
    if (e.name === 'AbortError') return;
    $('#d-loading').hidden = true;
    err.innerHTML = `<div class="banner-text"><strong>Analyse nicht verfügbar.</strong> ${esc(e.status === 404 ? 'Für dieses Symbol liegen keine Daten vor.' : e.message)}</div>
      <button type="button" class="btn btn-small" id="d-retry">Erneut versuchen</button>`;
    err.hidden = false;
    $('#d-retry').addEventListener('click', () => loadDetail(symbol, assetClass));
  }
}

function renderDetail(d) {
  const s = Math.round(d.score);
  $('#d-score').innerHTML = `
    <div class="gauge-wrap">
      <div class="gauge-head"><span><span class="score ${trendClass(s)}">${s > 0 ? '+' : ''}${s}</span> Score</span><span>−100 bärisch · bullisch +100</span></div>
      ${gaugeHTML(s)}
    </div>
    <div class="meta">${confHTML(d.confidence)}</div>`;
  $('#d-summary').textContent = d.summary || '';
  $('#d-plan').innerHTML = planHTML(d);
  renderSignals(d);
  renderMetrics(d);
  const src = d.data_source === 'demo' ? 'Synthetische Demo-Daten' : 'Live-Daten';
  $('#d-meta').textContent = `${src} · Tageskerzen · Stand ${fmtDate(d.updated_at)}`;
}

function planHTML(d) {
  const p = d.trade_plan;
  if (!p) {
    return `<p class="plan-none">Kein Trade-Plan: Das Setup ist <strong>neutral</strong> (|Score| unter 25). Die Signale widersprechen sich oder sind zu schwach – abwarten und beobachten ist hier auch eine Position.</p>`;
  }
  const ref = p.entry;
  const isStock = d.asset_class === 'stock';
  const riskPct = nf(0, 2).format(state.risk);
  const pctFromEntry = (x) => fmtPct(((x - p.entry) / p.entry) * 100, 2);
  const units = isStock ? 'Stück' : (d.symbol.replace(/USDT$|USDC$|BUSD$|EUR$/, '') || 'Einheiten');
  const sideTxt = p.side === 'long' ? 'Long' : 'Short';
  const sideSub = p.side === 'long' ? 'Kauf' : 'Leerverkauf';
  const warnings = [];
  if (!(p.position_size > 0)) {
    warnings.push(`Dein Risikobudget von ${fmtMoney(riskAmount())} reicht bei diesem Stop-Abstand für keine ganze Einheit. Trade auslassen oder Kontogröße/Risiko anpassen – nicht den Stop enger ziehen.`);
  }
  if (p.position_value > state.account * 1.0001) {
    warnings.push(`Der Positionswert (${fmtMoney(p.position_value, 0)}) übersteigt deine Kontogröße – das wäre nur mit Hebel/Margin möglich.`);
  }
  if (p.side === 'short' && !isStock) {
    warnings.push('Short bei Krypto erfordert Margin oder Derivate (z.B. Perpetual Futures) – Finanzierungskosten beachten.');
  }
  // R:R visual: distance stop→entry vs entry→TP1→TP2
  const risk = Math.abs(p.entry - p.stop_loss) || 1;
  const r1 = Math.abs(p.take_profit_1 - p.entry), r2 = Math.abs(p.take_profit_2 - p.take_profit_1);
  const tot = risk + r1 + r2;
  return `
    <div class="plan-grid">
      <div class="plan-item side ${esc(p.side)}"><span class="k">Richtung</span><span class="v">${sideTxt}</span><span class="s">${sideSub} · R:R ${fmtNum(p.risk_reward, 1)} : 1</span></div>
      <div class="plan-item"><span class="k">Einstieg</span><span class="v">${fmtPrice(p.entry, ref)}</span><span class="s">aktueller Kurs</span></div>
      <div class="plan-item stop"><span class="k">Stop-Loss</span><span class="v">${fmtPrice(p.stop_loss, ref)}</span><span class="s">${pctFromEntry(p.stop_loss)} · 2× ATR</span></div>
      <div class="plan-item loss"><span class="k">Max. Verlust</span><span class="v">${fmtMoney(p.max_loss)}</span><span class="s">${riskPct} % vom Konto</span></div>
      <div class="plan-item tp"><span class="k">Ziel 1 (1R)</span><span class="v">${fmtPrice(p.take_profit_1, ref)}</span><span class="s">${pctFromEntry(p.take_profit_1)}</span></div>
      <div class="plan-item tp"><span class="k">Ziel 2 (2R)</span><span class="v">${fmtPrice(p.take_profit_2, ref)}</span><span class="s">${pctFromEntry(p.take_profit_2)}</span></div>
      <div class="plan-item"><span class="k">Positionsgröße</span><span class="v">${fmtSize(p.position_size, d.asset_class)}</span><span class="s">${esc(units)} · Risiko/Einheit ${fmtPrice(p.risk_per_unit, ref)}</span></div>
      <div class="plan-item"><span class="k">Positionswert</span><span class="v">${fmtMoney(p.position_value)}</span><span class="s">${fmtNum((p.position_value / state.account) * 100, 1)} % vom Konto</span></div>
    </div>
    <div class="rr-bar" aria-hidden="true"><span class="r" style="width:${(risk / tot) * 100}%"></span><span class="g1" style="width:${(r1 / tot) * 100}%"></span><span class="g2" style="width:${(r2 / tot) * 100}%"></span></div>
    <div class="rr-legend" aria-hidden="true"><span>Stop ${fmtPrice(p.stop_loss, ref)}</span><span>Entry ${fmtPrice(p.entry, ref)}</span><span>TP2 ${fmtPrice(p.take_profit_2, ref)}</span></div>
    <div class="plan-explain">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5v.5"/></svg>
      <p>Bei <strong>${riskPct} % Risiko</strong> verlierst du maximal <strong>${fmtMoney(p.max_loss, p.max_loss >= 100 ? 0 : 2)}</strong>, wenn der Stop bei ${fmtPrice(p.stop_loss, ref)} greift.
      Erreicht der Kurs Ziel 1, gewinnst du etwa ${fmtMoney(p.max_loss, 0)} (1R) – ein guter Punkt, um die Hälfte zu verkaufen und den Stop auf Einstand nachzuziehen.
      Ziel 2 entspricht etwa ${fmtMoney(p.max_loss * 2, 0)} (2R).</p>
    </div>
    ${warnings.map((w) => `<p class="plan-warn">⚠ ${esc(w)}</p>`).join('')}
    <p class="fine">Beträge in Kurswährung (${isStock ? 'USD/EUR je nach Börse' : 'USDT'}); vereinfachend als € dargestellt. Gebühren und Slippage nicht berücksichtigt.</p>`;
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
    ['Volumen-Verhältnis', `${fmtNum(m.volume_ratio, 2)}×<span class="sub">${volNote} vs. Ø 20 Tage</span>`],
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

function initDrawer() {
  $('#d-close').addEventListener('click', closeDrawer);
  $('#drawer-backdrop').addEventListener('click', closeDrawer);
  $('#checklist').addEventListener('change', updateChecklist);
  document.addEventListener('keydown', (e) => {
    const drawer = $('#drawer');
    if (drawer.hidden) return;
    if (e.key === 'Escape' && !$('#wl-dialog').open) { e.preventDefault(); closeDrawer(); }
    if (e.key === 'Tab') {
      // simple focus trap
      const f = $$('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])', drawer).filter((el) => !el.disabled && el.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      else if (!drawer.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    }
  });
}

// ---------- watchlist ----------
let wlItems = [];
let wlChanged = false;

async function openWatchlist() {
  const dlg = $('#wl-dialog');
  wlChanged = false;
  setMsg('');
  dlg.showModal();
  $('#wl-symbol').focus();
  await loadWatchlist();
}

async function loadWatchlist() {
  const ul = $('#wl-list');
  ul.innerHTML = '<li class="wl-empty">Lade Watchlist …</li>';
  try {
    wlItems = await api('/api/watchlist') || [];
    renderWatchlist();
  } catch (e) {
    ul.innerHTML = `<li class="wl-empty">Watchlist konnte nicht geladen werden: ${esc(e.message)}</li>`;
  }
}

function renderWatchlist() {
  const ul = $('#wl-list');
  if (!wlItems.length) { ul.innerHTML = '<li class="wl-empty">Noch keine Symbole. Füge oben dein erstes hinzu.</li>'; return; }
  const sorted = [...wlItems].sort((a, b) => a.asset_class.localeCompare(b.asset_class) || a.symbol.localeCompare(b.symbol));
  ul.innerHTML = sorted.map((w) => `<li>
    <span class="sym">${esc(w.symbol)}</span>
    <span class="tag ${esc(w.asset_class)}">${CLASS_LABEL[w.asset_class] || esc(w.asset_class)}</span>
    <span class="name">${esc(w.name && w.name !== w.symbol ? w.name : '')}</span>
    <button type="button" class="icon-btn" data-remove="${esc(w.symbol)}" aria-label="${esc(w.symbol)} aus der Watchlist entfernen" title="Entfernen">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>
    </button></li>`).join('');
}

function setMsg(text, kind = '') {
  const m = $('#wl-msg');
  m.textContent = text;
  m.className = `form-msg ${kind}`;
}

function initWatchlist() {
  const dlg = $('#wl-dialog');
  $('#btn-watchlist').addEventListener('click', openWatchlist);
  $('#wl-close').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener('close', () => { if (wlChanged) loadScan(); $('#btn-watchlist').focus(); });

  const sym = $('#wl-symbol'), cls = $('#wl-class');
  sym.addEventListener('input', () => {
    sym.removeAttribute('aria-invalid');
    // Auto-guess asset class for typical Binance pairs
    if (/^[A-Z0-9]{2,}(USDT|USDC|BUSD|FDUSD|BTC|ETH|EUR)$/i.test(sym.value.trim()) && !sym.value.includes('.')) cls.value = 'crypto';
  });
  $('#wl-hint').addEventListener('click', (e) => {
    const c = e.target.closest('code');
    if (!c) return;
    sym.value = c.textContent;
    cls.value = /USDT$/.test(c.textContent) ? 'crypto' : 'stock';
    sym.focus();
  });

  $('#wl-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const symbol = sym.value.trim().toUpperCase();
    const name = $('#wl-name').value.trim();
    const asset_class = cls.value;
    if (!symbol) { sym.setAttribute('aria-invalid', 'true'); setMsg('Bitte ein Symbol eingeben.', 'err'); sym.focus(); return; }
    if (!/^[A-Z0-9.\-^=]{1,20}$/.test(symbol)) { sym.setAttribute('aria-invalid', 'true'); setMsg('Ungültiges Symbol – nur Buchstaben, Ziffern, Punkt und Bindestrich.', 'err'); return; }
    if (asset_class === 'crypto' && !/(USDT|USDC|BUSD|FDUSD|BTC|ETH|EUR)$/.test(symbol)) {
      setMsg('Hinweis: Krypto bitte als Binance-Paar angeben, z.B. BTCUSDT.', 'err'); sym.setAttribute('aria-invalid', 'true'); return;
    }
    const btn = $('#wl-submit');
    btn.disabled = true;
    try {
      const body = { symbol, asset_class };
      if (name) body.name = name;
      const created = await api('/api/watchlist', { method: 'POST', body: JSON.stringify(body) });
      wlItems.push(created || body);
      wlChanged = true;
      renderWatchlist();
      setMsg(`${symbol} wurde hinzugefügt.`, 'ok');
      $('#wl-form').reset();
      sym.focus();
    } catch (err) {
      if (err.status === 409) setMsg(`${symbol} ist bereits in der Watchlist.`, 'err');
      else if (err.status === 422) setMsg(`Ungültige Eingabe: ${err.detail || 'bitte Symbol und Klasse prüfen.'}`, 'err');
      else setMsg(`Hinzufügen fehlgeschlagen: ${err.message}`, 'err');
      sym.setAttribute('aria-invalid', 'true');
    } finally {
      btn.disabled = false;
    }
  });

  $('#wl-list').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-remove]');
    if (!b) return;
    const symbol = b.dataset.remove;
    b.disabled = true;
    try {
      await api(`/api/watchlist/${encodeURIComponent(symbol)}`, { method: 'DELETE' });
      wlItems = wlItems.filter((w) => w.symbol !== symbol);
      wlChanged = true;
      setMsg(`${symbol} wurde entfernt.`, 'ok');
    } catch (err) {
      if (err.status === 404) { wlItems = wlItems.filter((w) => w.symbol !== symbol); wlChanged = true; setMsg(`${symbol} war nicht (mehr) in der Watchlist.`, 'err'); }
      else { setMsg(`Entfernen fehlgeschlagen: ${err.message}`, 'err'); b.disabled = false; return; }
    }
    renderWatchlist();
    $('#wl-symbol').focus();
  });
}

// ---------- boot ----------
function boot() {
  initTheme();
  initSettings();
  initRefresh();
  initFilters();
  initGridClicks();
  initChartToggles();
  initDrawer();
  initWatchlist();
  loadHealth();
  loadScan();
  document.addEventListener('visibilitychange', () => {
    // catch up after the tab was in the background with auto-refresh on
    if (!document.hidden && state.autoTimer && state.generatedAt && Date.now() / 1000 - state.generatedAt > AUTO_REFRESH_MS / 1000) loadScan({ silent: true });
  });
}

boot();
