'use strict';

// Big Bets – Mini-App. Liest alerts.json vom Branch `data` und zeigt die Alarme als Einzeiler.
const DEFAULT_DATA_URL = 'https://raw.githubusercontent.com/marcusgrundmann90-hub/Trading-/data/alerts.json';
const CACHE_KEY = 'bigbets.alerts.v1';
const REFRESH_MS = 2 * 60 * 1000;
const STALE_AFTER_S = 30 * 60;

const DATA_URL = (() => {
  try {
    const q = new URLSearchParams(location.search).get('data');
    if (q) {
      const u = new URL(q, location.href);
      if (u.protocol === 'https:' || u.protocol === 'http:') return u.href;
    }
  } catch (e) { /* ignore */ }
  return DEFAULT_DATA_URL;
})();

const $ = (id) => document.getElementById(id);
const els = {
  status: $('status'), refresh: $('refresh'), notice: $('notice'), usage: $('usage'), usageText: $('usage-text'), list: $('list'),
  empty: $('empty'), error: $('error'), toast: $('toast'),
};

const state = {
  data: null,          // { updated_at, alerts: [] }
  fromCache: false,
  cachedAt: 0,         // ms, when the cached copy was fetched
  loading: false,
  lastFetch: 0,
  open: new Set(),
};

const numFmt1 = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const dateFmt = new Intl.DateTimeFormat('de-DE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// ---------- helpers ----------
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

function svgChevron() {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', 'chev');
  s.setAttribute('aria-hidden', 'true');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '2.2');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', 'M6 9l6 6 6-6');
  s.appendChild(p);
  return s;
}

function nowS() { return Date.now() / 1000; }

function relTime(ts) {
  if (!Number.isFinite(ts) || ts <= 0) return '–';
  const d = Math.max(0, nowS() - ts);
  if (d < 60) return 'gerade eben';
  const m = Math.floor(d / 60);
  if (m < 60) return `vor ${m} Min.`;
  const h = Math.floor(m / 60);
  if (h < 24) return `vor ${h} Std.`;
  const days = Math.floor(h / 24);
  if (days === 1) return 'gestern';
  if (days < 7) return `vor ${days} Tagen`;
  return dateFmt.format(new Date(ts * 1000));
}

function signedPct(v) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return { text: '–', cls: '' };
  const n = Number(v);
  const sign = n > 0 ? '+' : n < 0 ? '−' : '±';
  return { text: `${sign}${numFmt1.format(Math.abs(n))} %`, cls: n > 0 ? 'up' : n < 0 ? 'down' : '' };
}

function dirOf(a) {
  const d = String((a && a.direction) || '').toLowerCase();
  return d === 'long' || d === 'short' ? d : '';
}

function safeUrl(u) {
  try {
    const url = new URL(String(u));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch (e) { return null; }
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('Ungültige Daten');
  const alerts = Array.isArray(raw.alerts) ? raw.alerts.filter((a) => a && typeof a === 'object' && a.id) : [];
  alerts.sort((a, b) => (Number(b.created_at) || 0) - (Number(a.created_at) || 0));
  const u = raw.usage && typeof raw.usage === 'object' ? raw.usage : null;
  const usage = u ? {
    today: Number(u.today_usd) || 0,
    month: Number(u.month_usd) || 0,
    assessToday: Number(u.assess_today) || 0,
    assessMax: Number(u.assess_max_per_day) || 0,
  } : null;
  return { updated_at: Number(raw.updated_at) || 0, alerts, usage };
}

function readCache() {
  try {
    const s = localStorage.getItem(CACHE_KEY);
    if (!s) return null;
    const c = JSON.parse(s);
    return c && c.data ? { data: normalize(c.data), at: Number(c.at) || 0 } : null;
  } catch (e) { return null; }
}

function writeCache(data) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), data })); } catch (e) { /* ignore */ }
}

let toastTimer = 0;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 1800);
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* fall through */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) { return false; }
}

// ---------- rendering ----------
function renderStatus() {
  const s = els.status;
  s.className = 'status';
  if (!state.data) {
    if (state.loading) { s.classList.add('loading'); s.textContent = 'Lade …'; }
    else { s.classList.add('offline'); s.textContent = 'Keine Daten'; }
    return;
  }
  const up = state.data.updated_at;
  if (!up) { s.classList.add('offline'); s.textContent = 'Noch kein Check'; return; }
  const age = nowS() - up;
  const rel = relTime(up);
  let text = rel === 'gerade eben' ? 'Letzter Check gerade eben' : `Letzter Check ${rel}`;
  if (state.fromCache) {
    s.classList.add('offline');
    text = `Offline · ${text}`;
  } else if (age > STALE_AFTER_S) {
    s.classList.add('stale');
    text += ' · Wächter läuft evtl. nicht';
  }
  s.textContent = text;
}

const usdFmt = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const monthFmt = new Intl.DateTimeFormat('de-DE', { month: 'long', timeZone: 'UTC' });

function renderUsage() {
  const u = state.data && state.data.usage;
  if (!u) { els.usage.hidden = true; return; }
  const parts = [
    `heute ${usdFmt.format(u.today)}`,
    `${monthFmt.format(new Date())} ${usdFmt.format(u.month)}`,
  ];
  if (u.assessMax) parts.push(`Prüfungen heute ${u.assessToday}/${u.assessMax}`);
  els.usageText.textContent = parts.join(' · ');
  els.usage.hidden = false;
}

function renderNotice() {
  if (state.fromCache && state.data) {
    const when = state.cachedAt ? ` (Stand ${dateFmt.format(new Date(state.cachedAt))})` : '';
    els.notice.textContent = `Offline – du siehst die zuletzt geladene Liste${when}.`;
    els.notice.hidden = false;
  } else {
    els.notice.hidden = true;
  }
}

function fact(label, value) {
  const d = el('div', 'fact');
  d.appendChild(el('dt', '', label));
  d.appendChild(el('dd', '', value));
  return d;
}

function sectionTitle(t) { return el('h3', 'section-title', t); }

function renderAsset(a) {
  const box = el('div', 'asset');
  const head = el('div', 'asset-head');
  const dir = dirOf(a);
  if (dir) head.appendChild(el('span', `dir ${dir}`, dir === 'long' ? 'LONG ↑' : 'SHORT ↓'));
  head.appendChild(el('span', 'asset-name', a.name || a.ticker || 'Unbekannt'));
  if (a.ticker) head.appendChild(el('span', 'ticker', a.ticker));
  box.appendChild(head);

  const stats = el('div', 'asset-stats');
  const add = (label, val, cls) => {
    const c = el('div');
    c.appendChild(el('span', '', label));
    c.appendChild(el('b', cls || '', val));
    stats.appendChild(c);
  };
  const conv = Number(a.conviction);
  add('Überzeugung', Number.isFinite(conv) ? `${conv}/10` : '–');
  const d1 = signedPct(a.change_1d_pct);
  const d5 = signedPct(a.change_5d_pct);
  add('Heute', d1.text, d1.cls);
  add('5 Tage', d5.text, d5.cls);
  box.appendChild(stats);

  if (a.ticker) {
    const btn = el('button', 'copy', `Ticker ${a.ticker} kopieren`);
    btn.type = 'button';
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const ok = await copyText(String(a.ticker));
      toast(ok ? `${a.ticker} kopiert` : 'Kopieren nicht möglich');
    });
    box.appendChild(btn);
  }
  return box;
}

function renderDetail(al) {
  const d = el('div', 'detail');
  d.id = `detail-${al.id}`;
  if (al.headline) d.appendChild(el('p', 'headline', al.headline));

  const facts = el('dl', 'facts');
  const conf = Number(al.confidence);
  facts.appendChild(fact('Konfidenz', Number.isFinite(conf) ? `${conf}/100` : '–'));
  facts.appendChild(fact('Horizont', al.horizon || '–'));
  facts.appendChild(fact('Eingepreist', al.priced_in || '–'));
  d.appendChild(facts);

  const assets = Array.isArray(al.assets) ? al.assets.filter(Boolean) : [];
  if (assets.length) {
    d.appendChild(sectionTitle(assets.length > 1 ? 'Betroffene Werte' : 'Betroffener Wert'));
    const wrap = el('div', 'assets');
    assets.forEach((a) => wrap.appendChild(renderAsset(a)));
    d.appendChild(wrap);
  }

  if (al.rationale) {
    d.appendChild(sectionTitle('Begründung'));
    d.appendChild(el('p', 'prose', al.rationale));
  }
  if (al.risks) {
    d.appendChild(sectionTitle('Risiken'));
    d.appendChild(el('p', 'prose', al.risks));
  }
  const so = Array.isArray(al.second_order) ? al.second_order.filter(Boolean) : [];
  if (so.length) {
    d.appendChild(sectionTitle('Folgen zweiter Ordnung'));
    const chips = el('div', 'chips');
    so.forEach((s) => chips.appendChild(el('span', 'chip', s)));
    d.appendChild(chips);
  }
  const src = Array.isArray(al.sources) ? al.sources.filter(Boolean) : [];
  if (src.length) {
    d.appendChild(sectionTitle('Quellen'));
    const ul = el('ul', 'sources');
    src.forEach((s) => {
      const li = el('li');
      const href = safeUrl(s.url);
      const title = s.title || s.source || href || 'Quelle';
      if (href) {
        const a = el('a', '', title);
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        li.appendChild(a);
      } else {
        li.appendChild(el('span', '', title));
      }
      const meta = [s.source, Number(s.published) ? relTime(Number(s.published)) : ''].filter(Boolean).join(' · ');
      if (meta) li.appendChild(el('small', '', meta));
      ul.appendChild(li);
    });
    d.appendChild(ul);
  }
  return d;
}

function renderCard(al) {
  const assets = Array.isArray(al.assets) ? al.assets : [];
  const dir = dirOf(assets[0]);
  const li = el('li', `card${dir ? ' ' + dir : ''}${al.level === 'watch' ? ' watch' : ''}`);
  li.id = String(al.id);
  li.dataset.id = String(al.id);

  const row = el('button', 'row');
  row.type = 'button';
  row.setAttribute('aria-controls', `detail-${al.id}`);
  row.appendChild(el('p', 'one-liner', al.one_liner || al.headline || 'Big Bet'));

  const meta = el('div', 'meta');
  meta.appendChild(el('span', '', relTime(Number(al.created_at))));
  meta.appendChild(el('span', 'spacer'));
  if (al.level === 'watch') meta.appendChild(el('span', 'pill watch', 'Beobachten'));
  const conf = Number(al.confidence);
  if (Number.isFinite(conf)) {
    const pill = el('span', `pill${conf >= 85 ? ' hi' : ''}`, `Konfidenz ${conf}`);
    meta.appendChild(pill);
  }
  meta.appendChild(svgChevron());
  row.appendChild(meta);
  li.appendChild(row);

  const isOpen = state.open.has(String(al.id));
  row.setAttribute('aria-expanded', String(isOpen));
  if (isOpen) {
    li.classList.add('open');
    li.appendChild(renderDetail(al));
  }

  row.addEventListener('click', () => toggle(String(al.id)));
  return li;
}

function render() {
  renderStatus();
  renderNotice();
  renderUsage();
  const data = state.data;
  els.error.hidden = !!data || state.loading;
  if (!data) {
    els.list.replaceChildren();
    els.empty.hidden = true;
    return;
  }
  els.empty.hidden = data.alerts.length > 0;
  const frag = document.createDocumentFragment();
  data.alerts.forEach((al) => frag.appendChild(renderCard(al)));
  els.list.replaceChildren(frag);
}

function findAlert(id) {
  return state.data ? state.data.alerts.find((a) => String(a.id) === id) : null;
}

function toggle(id) {
  if (state.open.has(id)) {
    state.open.delete(id);
    if (location.hash === `#${id}`) history.replaceState(null, '', location.pathname + location.search);
  } else {
    state.open.add(id);
    history.replaceState(null, '', `#${encodeURIComponent(id)}`);
  }
  const al = findAlert(id);
  const old = document.getElementById(id);
  if (al && old) old.replaceWith(renderCard(al));
}

// ---------- deep link ----------
let pendingHash = '';
function applyHash() {
  let id = '';
  try { id = decodeURIComponent(location.hash.slice(1)); } catch (e) { id = ''; }
  if (!id) return;
  if (!findAlert(id)) { pendingHash = id; return; }
  pendingHash = '';
  state.open.add(id);
  render();
  const card = document.getElementById(id);
  if (card) {
    requestAnimationFrame(() => {
      card.scrollIntoView({ block: 'start', behavior: 'auto' });
      card.classList.remove('flash');
      void card.offsetWidth;
      card.classList.add('flash');
    });
  }
}

// ---------- data ----------
async function load() {
  if (state.loading) return;
  state.loading = true;
  els.refresh.classList.add('spin');
  if (!state.data) renderStatus();
  try {
    const res = await fetch(DATA_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    const data = normalize(raw);
    state.data = data;
    state.fromCache = false;
    writeCache(raw);
  } catch (e) {
    const cached = readCache();
    if (cached) {
      state.data = cached.data;
      state.cachedAt = cached.at;
      state.fromCache = true;
    } else if (!state.data) {
      state.data = null;
    } else {
      state.fromCache = true;
    }
  } finally {
    state.loading = false;
    state.lastFetch = Date.now();
    els.refresh.classList.remove('spin');
  }
  render();
  if (pendingHash || location.hash.length > 1) applyHash();
}

// ---------- boot ----------
(function boot() {
  // Sofort die zuletzt gespeicherte Liste zeigen, dann frisch laden.
  const cached = readCache();
  if (cached) {
    state.data = cached.data;
    state.cachedAt = cached.at;
  }
  state.loading = true;
  render();
  state.loading = false;
  if (cached && location.hash.length > 1) applyHash();
  load();

  els.refresh.addEventListener('click', () => load());
  window.addEventListener('hashchange', applyHash);
  window.addEventListener('online', () => load());

  setInterval(() => {
    if (document.visibilityState === 'visible') load();
  }, REFRESH_MS);
  setInterval(renderStatus, 30 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - state.lastFetch > 60 * 1000) load();
    else renderStatus();
  });

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
