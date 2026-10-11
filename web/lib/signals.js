// Signal detectors – port of backend/app/analysis/signals.py.
// Each detector receives the indicator frame from indicators.computeAll() and returns a signal or null.
// A signal is {id, name, direction, weight, description, phrase}; `phrase` is only used for the
// summary and stripped by toDict().

import { formatFixed } from './risk.js';

export const BULLISH = 'bullish';
export const BEARISH = 'bearish';

const DAY = 86400;

function sig(id, name, direction, weight, description, phrase = '') {
  return { id, name, direction, weight, description, phrase };
}

export function toDict(s) {
  return { id: s.id, name: s.name, direction: s.direction, weight: s.weight, description: s.description };
}

const ok = (...values) => values.every((v) => v !== null && v !== undefined && !Number.isNaN(v));
const lastOf = (arr) => arr[arr.length - 1];

function days(n) {
  if (n === 0) return 'heute';
  if (n === 1) return 'gestern';
  return `vor ${n} Tagen`;
}

/**
 * Most recent cross of a over/under b within the last `lookback` bars.
 * `b` may be an array or a constant. Returns [barsAgo, sign] or null.
 */
export function lastCross(a, b, lookback) {
  const n = a.length;
  const bAt = typeof b === 'number' ? () => b : (i) => b[i];
  const lim = Math.min(lookback, n - 1);
  for (let ago = 0; ago < lim; ago++) {
    const i = n - 1 - ago;
    const cur = a[i] - bAt(i);
    const prev = a[i - 1] - bAt(i - 1);
    if (Number.isNaN(cur) || Number.isNaN(prev)) return null;
    if (prev <= 0 && 0 < cur) return [ago, 1];
    if (prev >= 0 && 0 > cur) return [ago, -1];
  }
  return null;
}

export function goldenDeathCross(f) {
  const cross = lastCross(f.sma50, f.sma200, 10);
  if (!cross) return null;
  const [ago, sign] = cross;
  if (sign > 0) {
    return sig('golden_cross', 'Golden Cross', BULLISH, 20,
      `SMA50 hat SMA200 ${days(ago)} nach oben gekreuzt.`, 'Golden Cross');
  }
  return sig('death_cross', 'Death Cross', BEARISH, 20,
    `SMA50 hat SMA200 ${days(ago)} nach unten gekreuzt.`, 'Death Cross');
}

export function trendAlignment(f) {
  const c = lastOf(f.close), s20 = lastOf(f.sma20), s50 = lastOf(f.sma50), s200 = lastOf(f.sma200);
  if (!ok(c, s20, s50, s200)) return null;
  if (c > s20 && s20 > s50 && s50 > s200) {
    return sig('trend_alignment', 'Intakter Aufwärtstrend', BULLISH, 15,
      'Kurs über SMA20 über SMA50 über SMA200 – alle Trends zeigen nach oben.',
      'intakter Aufwärtstrend');
  }
  if (c < s20 && s20 < s50 && s50 < s200) {
    return sig('trend_alignment', 'Intakter Abwärtstrend', BEARISH, 15,
      'Kurs unter SMA20 unter SMA50 unter SMA200 – alle Trends zeigen nach unten.',
      'intakter Abwärtstrend');
  }
  return null;
}

export function rsiExtreme(f) {
  const r = lastOf(f.rsi);
  if (!ok(r)) return null;
  if (r < 30) {
    return sig('rsi_oversold', 'RSI überverkauft', BULLISH, 8,
      `RSI(14) steht bei ${formatFixed(r, 1)} und signalisiert eine überverkaufte Lage.`,
      'überverkaufter RSI');
  }
  if (r > 70) {
    return sig('rsi_overbought', 'RSI überkauft', BEARISH, 8,
      `RSI(14) steht bei ${formatFixed(r, 1)} und signalisiert eine überkaufte Lage.`,
      'überkaufter RSI');
  }
  return null;
}

export function rsiReversal(f) {
  const up = lastCross(f.rsi, 30.0, 3);
  if (up && up[1] > 0) {
    return sig('rsi_bullish_reversal', 'RSI-Umkehr bullisch', BULLISH, 15,
      `RSI hat die 30er-Marke ${days(up[0])} von unten zurückerobert.`,
      'RSI-Umkehr aus dem überverkauften Bereich');
  }
  const down = lastCross(f.rsi, 70.0, 3);
  if (down && down[1] < 0) {
    return sig('rsi_bearish_reversal', 'RSI-Umkehr bärisch', BEARISH, 15,
      `RSI ist ${days(down[0])} von oben unter die 70er-Marke gefallen.`,
      'RSI-Umkehr aus dem überkauften Bereich');
  }
  return null;
}

export function macdCross(f) {
  const cross = lastCross(f.macd, f.macd_signal, 3);
  if (!cross) return null;
  const [ago, sign] = cross;
  if (sign > 0) {
    return sig('macd_cross', 'MACD-Kaufsignal', BULLISH, 12,
      `MACD hat die Signallinie ${days(ago)} nach oben gekreuzt.`, 'MACD-Kaufsignal');
  }
  return sig('macd_cross', 'MACD-Verkaufssignal', BEARISH, 12,
    `MACD hat die Signallinie ${days(ago)} nach unten gekreuzt.`, 'MACD-Verkaufssignal');
}

export function bollingerBreakout(f) {
  const c = lastOf(f.close), up = lastOf(f.bb_upper), lo = lastOf(f.bb_lower);
  if (!ok(c, up, lo)) return null;
  if (c > up) {
    return sig('bollinger_breakout', 'Bollinger-Ausbruch nach oben', BULLISH, 10,
      'Schlusskurs liegt über dem oberen Bollinger-Band (20, 2).',
      'Ausbruch über das obere Bollinger-Band');
  }
  if (c < lo) {
    return sig('bollinger_breakout', 'Bollinger-Ausbruch nach unten', BEARISH, 10,
      'Schlusskurs liegt unter dem unteren Bollinger-Band (20, 2).',
      'Bruch des unteren Bollinger-Bands');
  }
  return null;
}

export function bollingerSqueeze(f) {
  const bw = f.bb_bandwidth.filter((v) => !Number.isNaN(v));
  if (bw.length < 60) return null;
  const window = bw.slice(-126);
  const cur = bw[bw.length - 1];
  let min = Infinity;
  for (const v of window) if (v < min) min = v;
  if (cur > min * 1.05) return null;
  const s50 = lastOf(f.sma50);
  const ref = ok(s50) ? s50 : lastOf(f.bb_mid);
  const bullish = lastOf(f.close) >= ref;
  const where = bullish ? 'über' : 'unter';
  return sig('bollinger_squeeze', 'Bollinger Squeeze', bullish ? BULLISH : BEARISH, 8,
    `Bollinger-Bandbreite auf 6-Monats-Tief (${formatFixed(cur * 100, 1)} %) – Kurs ${where} SMA50, ` +
      'eine starke Bewegung kündigt sich an.',
    'Bollinger Squeeze');
}

/** Index of the first bar inside the trailing 365-day window (time > last - 365 days). */
export function window52wStart(f) {
  const start = f.time[f.length - 1] - 365 * DAY;
  let i = 0;
  while (i < f.length && !(f.time[i] > start)) i++;
  return i;
}

export function breakout52w(f) {
  const s = window52wStart(f);
  const n = f.length;
  if (n - s < 30) return null;
  const last = n - 1;
  const vr = f.volume_ratio[last];
  if (!ok(vr) || vr <= 1.5) return null;
  let hi = -Infinity, lo = Infinity, any = false;
  for (let i = s; i < last; i++) {
    const h = f.high[i], l = f.low[i];
    if (!Number.isNaN(h)) { hi = Math.max(hi, h); any = true; }
    if (!Number.isNaN(l)) lo = Math.min(lo, l);
  }
  if (!any) { hi = NaN; lo = NaN; }
  const c = f.close[last];
  if (c >= hi * 0.98) {
    const txt = c > hi ? 'über' : 'nahe';
    return sig('breakout_52w', '52-Wochen-Hoch-Ausbruch', BULLISH, 20,
      `Kurs schließt ${txt} dem 52-Wochen-Hoch (${formatFixed(hi, 2)}) bei ${formatFixed(vr, 1)}-fachem Volumen.`,
      'Ausbruch über 52-Wochen-Hoch bei hohem Volumen');
  }
  if (c <= lo * 1.02) {
    const txt = c < lo ? 'unter' : 'nahe';
    return sig('breakdown_52w', '52-Wochen-Tief-Bruch', BEARISH, 20,
      `Kurs schließt ${txt} dem 52-Wochen-Tief (${formatFixed(lo, 2)}) bei ${formatFixed(vr, 1)}-fachem Volumen.`,
      'Bruch des 52-Wochen-Tiefs bei hohem Volumen');
  }
  return null;
}

export function volumeSpike(f) {
  const last = f.length - 1;
  const vr = f.volume_ratio[last];
  const c = f.close[last], o = f.open[last];
  if (!ok(vr) || vr <= 2 || c === o) return null;
  if (c > o) {
    return sig('volume_spike', 'Volumenspitze (Kaufdruck)', BULLISH, 10,
      `Volumen ${formatFixed(vr, 1)}-fach über dem 20-Tage-Schnitt bei steigender Kerze.`,
      'Volumenspitze mit Kaufdruck');
  }
  return sig('volume_spike', 'Volumenspitze (Verkaufsdruck)', BEARISH, 10,
    `Volumen ${formatFixed(vr, 1)}-fach über dem 20-Tage-Schnitt bei fallender Kerze.`,
    'Volumenspitze mit Verkaufsdruck');
}

export function pullback(f) {
  const i = f.length - 1;
  const c = f.close[i], lo = f.low[i], hi = f.high[i];
  const s20 = f.sma20[i], s50 = f.sma50[i], s200 = f.sma200[i], r = f.rsi[i];
  if (!ok(c, s20, s50, s200, r)) return null;
  const smas = [['SMA20', s20], ['SMA50', s50]];
  if (s50 > s200 && c > s200 && r >= 40 && r <= 50) {
    const touched = smas.filter(([, s]) => lo <= s * 1.01 && c >= s * 0.99).map(([n]) => n);
    if (touched.length) {
      return sig('pullback_in_uptrend', 'Rücksetzer im Aufwärtstrend', BULLISH, 20,
        `Kurs testet im Aufwärtstrend die ${touched[0]}, RSI bei ${formatFixed(r, 1)} – ` +
          'klassische Einstiegszone.',
        `Rücksetzer an die ${touched[0]} im Aufwärtstrend`);
    }
  }
  if (s50 < s200 && c < s200 && r >= 50 && r <= 60) {
    const touched = smas.filter(([, s]) => hi >= s * 0.99 && c <= s * 1.01).map(([n]) => n);
    if (touched.length) {
      return sig('rally_in_downtrend', 'Erholung im Abwärtstrend', BEARISH, 20,
        `Kurs läuft im Abwärtstrend an die ${touched[0]}, RSI bei ${formatFixed(r, 1)} – ` +
          'mögliche Short-Zone.',
        `Erholung an die ${touched[0]} im Abwärtstrend`);
    }
  }
  return null;
}

export const DETECTORS = [
  goldenDeathCross,
  trendAlignment,
  rsiExtreme,
  rsiReversal,
  macdCross,
  bollingerBreakout,
  bollingerSqueeze,
  breakout52w,
  volumeSpike,
  pullback,
];

export function detectSignals(f) {
  const signals = [];
  for (const det of DETECTORS) {
    let s = null;
    try {
      s = det(f);
    } catch {
      s = null; // a broken detector must not kill the analysis
    }
    if (s) signals.push(s);
  }
  signals.sort((a, b) => b.weight - a.weight); // stable, like Python's sort
  return signals;
}

export function scoreSignals(signals) {
  const total = signals.reduce((acc, s) => acc + (s.direction === BULLISH ? s.weight : -s.weight), 0);
  return Math.trunc(Math.max(-100, Math.min(100, total)));
}

export function directionFor(score) {
  if (Math.abs(score) < 25) return 'neutral';
  return score > 0 ? 'long' : 'short';
}

export function confidenceFor(score) {
  const a = Math.abs(score);
  if (a >= 70) return 'high';
  if (a >= 40) return 'medium';
  return 'low';
}

function join(parts) {
  if (parts.length === 1) return parts[0];
  return parts.slice(0, -1).join(', ') + ' und ' + parts[parts.length - 1];
}

export function buildSummary(signals, score) {
  if (!signals.length) {
    return 'Kein klares Setup: aktuell liegen keine nennenswerten technischen Signale vor.';
  }
  const direction = directionFor(score);
  if (direction === 'neutral') {
    const bull = signals.filter((s) => s.direction === BULLISH);
    const bear = signals.filter((s) => s.direction === BEARISH);
    if (bull.length && bear.length) {
      return `Gemischtes Bild: ${bull[0].phrase} steht ${bear[0].phrase} gegenüber – ` +
        'abwarten, bis sich eine Richtung durchsetzt.';
    }
    return `Noch kein klares Setup: ${signals[0].phrase}, aber zu wenig Bestätigung für einen Trade.`;
  }
  const wanted = direction === 'long' ? BULLISH : BEARISH;
  const top = signals.filter((s) => s.direction === wanted).map((s) => s.phrase).slice(0, 3);
  const phrases = [top[0][0].toUpperCase() + top[0].slice(1), ...top.slice(1)];
  const prefix = direction === 'long' ? 'Bullisches Setup' : 'Bärisches Setup';
  return `${prefix}: ${join(phrases)}.`;
}
