// Chart controller for the detail sheet (lightweight-charts 4.2.0, loaded as a
// classic script from ./vendor/ → window.LightweightCharts).
import { nf, priceDecimals, fmtPrice, fmtNum } from './format.js';

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const alpha = (hex, a) => {
  // accepts #rrggbb; returns rgba(); falls back to the raw colour
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};
const DATE_FMT = { day: '2-digit', month: '2-digit', year: 'numeric' };
const fmtDay = (t) => new Date(t * 1000).toLocaleDateString('de-DE', DATE_FMT);

export const charts = {
  main: null, rsi: null, macd: null,
  els: null, data: null,
  series: {}, priceLines: [], rsiLines: [], ro: null, syncing: false,
  visible: { sma20: true, sma50: true, sma200: true, bb: false, levels: true },

  available() { return typeof window.LightweightCharts !== 'undefined'; },

  baseOptions(showTime) {
    const border = cssVar('--border');
    return {
      layout: { background: { type: 'solid', color: 'transparent' }, textColor: cssVar('--muted'), fontFamily: cssVar('--font'), fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: alpha(border, 0.5) }, horzLines: { color: alpha(border, 0.5) } },
      rightPriceScale: { borderColor: border, minimumWidth: 64 },
      timeScale: { borderColor: border, visible: showTime, timeVisible: false, rightOffset: 3, minBarSpacing: 2 },
      crosshair: {
        mode: 0,
        vertLine: { color: cssVar('--muted'), labelBackgroundColor: cssVar('--surface-3') },
        horzLine: { color: cssVar('--muted'), labelBackgroundColor: cssVar('--surface-3') },
      },
      // Vertical finger drags scroll the page, horizontal drags pan the chart.
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { axisPressedMouseMove: { time: true, price: false }, mouseWheel: true, pinch: true },
      kineticScroll: { touch: true, mouse: false },
    };
  },

  destroy() {
    this.ro?.disconnect();
    this.ro = null;
    for (const k of ['main', 'rsi', 'macd']) { try { this[k]?.remove(); } catch { /* ignore */ } this[k] = null; }
    this.series = {};
    this.priceLines = [];
    this.rsiLines = [];
    this.data = null;
    if (this.els) Object.values(this.els).forEach((el) => { if (el && el.classList.contains('chart')) el.innerHTML = ''; });
  },

  /** els: {main, rsi, macd, legend}; d: Opportunity with candles + indicators */
  build(els, d) {
    this.destroy();
    this.els = els;
    this.data = d;
    if (!this.available()) {
      els.main.innerHTML = '<div class="chart-fallback">Chart-Bibliothek konnte nicht geladen werden.</div>';
      return;
    }
    const LC = window.LightweightCharts;
    const prec = priceDecimals(d.price);
    this.prec = prec;
    const priceFormat = { type: 'price', precision: prec, minMove: Math.pow(10, -prec) };
    const macdPrec = Math.max(2, prec + 1);
    const macdFormat = { type: 'price', precision: macdPrec, minMove: Math.pow(10, -macdPrec) };
    const loc = (p) => ({ locale: 'de-DE', dateFormat: 'dd.MM.yy', priceFormatter: (v) => nf(p).format(v) });

    const mk = (el, showTime, p) => LC.createChart(el, { ...this.baseOptions(showTime), localization: loc(p), width: el.clientWidth, height: el.clientHeight });
    this.main = mk(els.main, false, prec);
    this.rsi = mk(els.rsi, false, 1);
    this.macd = mk(els.macd, true, macdPrec);

    const S = this.series;
    const ind = d.indicators || {};
    const raw = d.candles || [];
    const candles = raw.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));

    S.volume = this.main.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
    this.main.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 }, visible: false });

    const line = (key, opts = {}) => {
      const s = this.main.addLineSeries({ lineWidth: 1.5, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, priceFormat, ...opts });
      s.setData(ind[key] || []);
      return s;
    };
    S.bb_upper = line('bb_upper', { lineWidth: 1, lineStyle: 2 });
    S.bb_lower = line('bb_lower', { lineWidth: 1, lineStyle: 2 });
    S.sma200 = line('sma200');
    S.sma50 = line('sma50');
    S.sma20 = line('sma20');
    S.candles = this.main.addCandlestickSeries({ priceFormat });
    S.candles.setData(candles);
    this.main.priceScale('right').applyOptions({ scaleMargins: { top: 0.08, bottom: 0.22 } });

    // Whitespace series so every pane shares the same time axis (logical ranges stay in sync)
    const ws = candles.map((c) => ({ time: c.time }));
    this.rsi.addLineSeries({ lastValueVisible: false, priceLineVisible: false }).setData(ws);
    this.macd.addLineSeries({ lastValueVisible: false, priceLineVisible: false, priceFormat: macdFormat }).setData(ws);

    S.rsi = this.rsi.addLineSeries({ lineWidth: 1.5, priceLineVisible: false, crosshairMarkerVisible: false, priceFormat: { type: 'price', precision: 1, minMove: 0.1 }, autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) });
    S.rsi.setData(ind.rsi || []);
    this.rsiLines = [70, 30].map((v) => S.rsi.createPriceLine({ price: v, lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: '' }));
    this.rsi.priceScale('right').applyOptions({ scaleMargins: { top: 0.08, bottom: 0.08 } });

    S.macd_hist = this.macd.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false, priceFormat: macdFormat });
    S.macd = this.macd.addLineSeries({ lineWidth: 1.5, priceLineVisible: false, crosshairMarkerVisible: false, priceFormat: macdFormat });
    S.macd.setData(ind.macd || []);
    S.macd_signal = this.macd.addLineSeries({ lineWidth: 1.5, priceLineVisible: false, crosshairMarkerVisible: false, lastValueVisible: false, priceFormat: macdFormat });
    S.macd_signal.setData(ind.macd_signal || []);

    this.retheme();
    this.applyVisibility();

    // Sync visible range across panes
    const all = [this.main, this.rsi, this.macd];
    all.forEach((src) => src.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (this.syncing || !range) return;
      this.syncing = true;
      all.forEach((dst) => { if (dst !== src) dst.timeScale().setVisibleLogicalRange(range); });
      this.syncing = false;
    }));

    // Sync crosshair + legend
    const target = new Map([[this.main, S.candles], [this.rsi, S.rsi], [this.macd, S.macd]]);
    const byTime = new Map(raw.map((c) => [c.time, c]));
    const valAt = (arr) => { const m = new Map((arr || []).map((p) => [p.time, p.value])); return (t) => m.get(t); };
    const look = { sma20: valAt(ind.sma20), sma50: valAt(ind.sma50), sma200: valAt(ind.sma200), rsi: valAt(ind.rsi), macd: valAt(ind.macd) };
    all.forEach((src) => src.subscribeCrosshairMove((param) => {
      if (this.syncing) return;
      this.syncing = true;
      const t = param && param.time;
      all.forEach((dst) => {
        if (dst === src) return;
        try {
          if (t == null) dst.clearCrosshairPosition();
          else {
            const s = target.get(dst);
            const v = dst === this.main ? byTime.get(t)?.close : dst === this.rsi ? look.rsi(t) : look.macd(t);
            if (v != null) dst.setCrosshairPosition(v, t, s); else dst.clearCrosshairPosition();
          }
        } catch { /* ignore */ }
      });
      this.syncing = false;
      this.legend(t == null ? null : byTime.get(t), look);
    }));
    this.legend(null, look);

    // Default: show roughly the last 6 months (fewer bars on narrow screens)
    const n = candles.length;
    const bars = els.main.clientWidth < 420 ? 90 : 130;
    if (n > bars) this.main.timeScale().setVisibleLogicalRange({ from: n - bars, to: n + 2 });
    else this.main.timeScale().fitContent();

    this.ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const ch = e.target === els.main ? this.main : e.target === els.rsi ? this.rsi : this.macd;
        const { width, height } = e.contentRect;
        if (ch && width > 0 && height > 0) ch.applyOptions({ width: Math.floor(width), height: Math.floor(height) });
      }
    });
    [els.main, els.rsi, els.macd].forEach((el) => this.ro.observe(el));
  },

  legend(c, look) {
    const el = this.els?.legend;
    if (!el || !this.data) return;
    const raw = this.data.candles || [];
    const bar = c || raw[raw.length - 1];
    if (!bar) { el.textContent = ''; return; }
    const ref = this.data.price;
    const up = bar.close >= bar.open;
    const sma = (k, cls) => {
      const v = look[k](bar.time);
      return v != null && this.visible[k] ? `<span class="lg-${cls}">${k.toUpperCase()} ${fmtPrice(v, ref)}</span>` : '';
    };
    el.innerHTML = `<span class="lg-date">${fmtDay(bar.time)}</span>`
      + `<span>O ${fmtPrice(bar.open, ref)}</span><span>H ${fmtPrice(bar.high, ref)}</span><span>L ${fmtPrice(bar.low, ref)}</span>`
      + `<span class="${up ? 'up' : 'down'}">C ${fmtPrice(bar.close, ref)}</span>`
      + sma('sma20', 's20') + sma('sma50', 's50') + sma('sma200', 's200')
      + (look.rsi(bar.time) != null ? `<span>RSI ${fmtNum(look.rsi(bar.time), 1)}</span>` : '');
  },

  setLevels(plan) {
    const S = this.series;
    if (!S.candles) return;
    this.priceLines.forEach((l) => { try { S.candles.removePriceLine(l); } catch { /* ignore */ } });
    this.priceLines = [];
    if (!plan || !this.visible.levels) return;
    const up = cssVar('--up'), down = cssVar('--down'), accent = cssVar('--accent');
    const mk = (price, color, title, style = 2) => price != null && this.priceLines.push(
      S.candles.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title }));
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

  toggle(key) {
    this.visible[key] = !this.visible[key];
    if (key === 'levels') this.setLevels(this.data?.trade_plan);
    else this.applyVisibility();
    return this.visible[key];
  },

  /** Re-apply all colours from the current CSS custom properties. */
  retheme() {
    if (!this.main) return;
    this.main.applyOptions(this.baseOptions(false));
    this.rsi.applyOptions(this.baseOptions(false));
    this.macd.applyOptions(this.baseOptions(true));
    const S = this.series;
    const up = cssVar('--up'), down = cssVar('--down'), accent = cssVar('--accent');
    S.candles.applyOptions({ upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down });
    S.sma20.applyOptions({ color: cssVar('--c-sma20') });
    S.sma50.applyOptions({ color: cssVar('--c-sma50') });
    S.sma200.applyOptions({ color: cssVar('--c-sma200') });
    S.bb_upper.applyOptions({ color: cssVar('--c-bb') });
    S.bb_lower.applyOptions({ color: cssVar('--c-bb') });
    S.rsi.applyOptions({ color: accent });
    S.macd.applyOptions({ color: accent });
    S.macd_signal.applyOptions({ color: cssVar('--c-sma20') });
    this.rsiLines.forEach((l, i) => l.applyOptions({ color: i === 0 ? down : up }));
    const d = this.data;
    S.volume.setData((d.candles || []).map((c) => ({ time: c.time, value: c.volume || 0, color: alpha(c.close >= c.open ? up : down, 0.32) })));
    S.macd_hist.setData((d.indicators?.macd_hist || []).map((p) => ({ ...p, color: alpha(p.value >= 0 ? up : down, 0.6) })));
    this.setLevels(d.trade_plan);
  },
};
