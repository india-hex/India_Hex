// Colour ramps, scales and number formatting.

export const RAMPS = {
  magma: ['#1b0c41', '#4a0c6b', '#781c6d', '#a52c60', '#cf4446', '#ed6925', '#fb9b06', '#f7d13d', '#fcffa4'],
  viridis: ['#440154', '#472d7b', '#3b528b', '#2c728e', '#21918c', '#28ae80', '#5ec962', '#addc30', '#fde725'],
  cividis: ['#00224e', '#123570', '#3b496c', '#575d6d', '#707173', '#8a8779', '#a69d75', '#c4b56c', '#fee838'],
  ylorrd: ['#ffffcc', '#ffeda0', '#fed976', '#feb24c', '#fd8d3c', '#fc4e2a', '#e31a1c', '#bd0026', '#800026'],
  greens: ['#f7fcf5', '#e5f5e0', '#c7e9c0', '#a1d99b', '#74c476', '#41ab5d', '#238b45', '#006d2c', '#00441b'],
  ylgn: ['#ffffe5', '#f7fcb9', '#d9f0a3', '#addd8e', '#78c679', '#41ab5d', '#238443', '#006837', '#004529'],
  blues: ['#f7fbff', '#deebf7', '#c6dbef', '#9ecae1', '#6baed6', '#4292c6', '#2171b5', '#08519c', '#08306b'],
  purples: ['#fcfbfd', '#efedf5', '#dadaeb', '#bcbddc', '#9e9ac8', '#807dba', '#6a51a3', '#54278f', '#3f007d'],
  rdbu: ['#b2182b', '#d6604d', '#f4a582', '#fddbc7', '#f7f7f7', '#d1e5f0', '#92c5de', '#4393c3', '#2166ac'],
  brbg: ['#8c510a', '#bf812d', '#dfc27d', '#f6e8c3', '#f5f5f5', '#c7eae5', '#80cdc1', '#35978f', '#01665e'],
  puor: ['#b35806', '#e08214', '#fdb863', '#fee0b6', '#f7f7f7', '#d8daeb', '#b2abd2', '#8073ac', '#542788'],
  // election palette: BJP/NDA orange, INC/MGB blue, JD(S) green, JSP pink, others grey (colour-blind safe)
  oranges: ['#fff5eb', '#fee6ce', '#fdd0a2', '#fdae6b', '#fd8d3c', '#f16913', '#d94801', '#a63603', '#7f2704'],
  bugn: ['#f7fcfd', '#e5f5f9', '#ccece6', '#99d8c9', '#66c2a4', '#41ae76', '#238b45', '#006d2c', '#00441b'],
  rdpu: ['#fff7f3', '#fde0dd', '#fcc5c0', '#fa9fb5', '#f768a1', '#dd3497', '#ae017e', '#7a0177', '#49006a'],
  greys: ['#ffffff', '#f0f0f0', '#d9d9d9', '#bdbdbd', '#969696', '#737373', '#525252', '#252525', '#000000'],
  buor: ['#08519c', '#3182bd', '#6baed6', '#c6dbef', '#f7f7f7', '#fdd0a2', '#fd8d3c', '#e6550d', '#a63603'],
};

/**
 * Colours for a lens. A series with its own diverging ramp (vote margins: buor) or from a
 * state-scoped election dataset keeps its palette, in colour-blind mode too (it is safe already).
 */
export function rampFor(lens, cbSafe) {
  const s = lens.series;
  if (s && lens.mode !== 'change' && (s.diverging || s.states) && RAMPS[lens.ramp]) return RAMPS[lens.ramp];
  if (lens.diverging) return cbSafe ? RAMPS.puor : RAMPS.rdbu;
  return cbSafe ? RAMPS.cividis : RAMPS[lens.ramp] || RAMPS.viridis;
}

/** Scale of a categorical lens: one colour per category code (labels for the legend). */
export function catScale(lens) {
  const cats = lens.series.categories;
  return { cat: true, breaks: [], colors: cats.map((c) => c.color), labels: cats.map((c) => c.label),
    shown: cats.map((c, i) => (lens.year == null || c.years.includes(lens.year) ? i : -1)).filter((i) => i >= 0), rel: false };
}

const quantile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))];

function uniqueAsc(arr) {
  const out = [];
  for (const v of arr) if (!out.length || v > out[out.length - 1] + Math.abs(out[out.length - 1]) * 1e-9 + 1e-12) out.push(v);
  return out;
}

/**
 * Scale {breaks: n, colors: n+1, rel} from values; null only when there is no finite value at all.
 * The lowest value gets its own class (zero-heavy data: POI counts, dark night-light cells, sparse
 * listings), and quantiles are taken over the values above it. Ties collapse; colours spread.
 */
export function scaleFromValues(values, lens, ramp) {
  if (lens.categorical) return catScale(lens);
  if (lens.fixedBreaks) return { breaks: lens.fixedBreaks, colors: ramp, rel: false, fixed: true };
  const v = [];
  for (const x of values) if (Number.isFinite(x)) v.push(x);
  if (!v.length) return null;
  v.sort((a, b) => a - b);
  if (lens.diverging) {
    const pos = v.filter((x) => x > 0);
    const neg = v.filter((x) => x < 0).map(Math.abs).sort((a, b) => a - b);
    const side = (arr) => (arr.length ? [0.2, 0.5, 0.85].map((q) => quantile(arr, q)) : null);
    let p = side(pos); let n = side(neg);
    if (!p && !n) return { breaks: [], colors: [ramp[Math.floor(ramp.length / 2)]], rel: true }; // all zero
    p = p || n; n = n || p;
    const e = Math.min(p[0], n[0]) * 0.35;
    return { breaks: uniqueAsc([-n[2], -n[1], -n[0], -e, e, p[0], p[1], p[2]]), colors: ramp, rel: true };
  }
  const lo = v[0];
  const rest = v.filter((x) => x > lo);
  if (!rest.length) return { breaks: [], colors: [ramp[Math.round((ramp.length - 1) * 0.6)]], rel: true }; // one value
  const br = uniqueAsc([rest[0], ...[1, 2, 3, 4, 5, 6, 7].map((i) => quantile(rest, i / 8))]);
  const sc = spread(br, ramp, true);
  // a large block of cells at the minimum (usually 0) is drawn faintly so the imagery shows through
  sc.faintFirst = lo === 0 && v.length - rest.length > v.length * 0.2;
  return sc;
}

export function spread(breaks, ramp, rel) {
  const k = breaks.length + 1;
  const colors = Array.from({ length: k }, (_, i) => ramp[Math.round((i * (ramp.length - 1)) / Math.max(1, k - 1))]);
  return { breaks, colors, rel };
}

export function classIndex(v, sc) {
  let i = 0;
  while (i < sc.breaks.length && v >= sc.breaks[i]) i++;
  return i;
}

export function colourOf(v, sc) {
  if (!sc || v == null || !Number.isFinite(v)) return null;
  return sc.cat ? sc.colors[v] || null : sc.colors[classIndex(v, sc)];
}

/** 0..1 position of v within the scale (piecewise linear between breaks); used for 3D height. */
export function position(v, sc) {
  if (!sc || !Number.isFinite(v)) return 0;
  const b = sc.breaks;
  if (!b.length) return 0.5;
  const i = classIndex(v, sc);
  const lo = i === 0 ? Math.min(b[0], v) : b[i - 1];
  const hi = i === b.length ? Math.max(b[b.length - 1], v) : b[i];
  const t = hi > lo ? (v - lo) / (hi - lo) : 0.5;
  return Math.max(0, Math.min(1, (i + t) / (b.length + 1)));
}

const hexCache = new Map();
export function rgba(hex, a = 255) {
  let c = hexCache.get(hex);
  if (!c) {
    const h = hex.replace('#', '');
    c = [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    hexCache.set(hex, c);
  }
  return [c[0], c[1], c[2], a];
}

// ----------------------------------------------------------------------------------------------
// Formatting
// ----------------------------------------------------------------------------------------------
export function compact(n) {
  if (n == null || !Number.isFinite(n)) return '–';
  const a = Math.abs(n);
  if (a >= 1e7) return `${(n / 1e7).toFixed(a >= 1e9 ? 0 : 2)} Cr`;
  if (a >= 1e5) return `${(n / 1e5).toFixed(2)} L`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return a >= 10 ? String(Math.round(n)) : n.toFixed(a >= 1 ? 1 : 2);
}

/** Display a value of a lens (handles shares, change, density, currency). */
export function fmtValue(v, lens, { short = false } = {}) {
  if (v == null || !Number.isFinite(v)) return '–';
  const sign = lens.mode === 'change' && v > 0 ? '+' : '';
  if (lens.format === 'cat') return lens.series?.categories?.[v]?.label ?? '–';
  if (lens.format === 'pp') return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}`; // unit (pp) shown beside it
  if (lens.mode === 'change' && lens.pctChange) return `${sign}${v.toFixed(Math.abs(v) < 10 ? 1 : 0)}%`;
  if (lens.format === 'pct') {
    const p = v * 100;
    const s = Math.abs(p) < 10 ? p.toFixed(1) : p.toFixed(0);
    return `${sign}${s}${lens.mode === 'change' ? ' pp' : '%'}`;
  }
  if (lens.format === 'inr') return `${sign}₹${short ? compact(v) : Math.round(v).toLocaleString('en-IN')}`;
  const a = Math.abs(v);
  if (short || a >= 1e5) return sign + compact(v);
  if (lens.format === 'int' && !lens.density) return sign + Math.round(v).toLocaleString('en-IN');
  if (a >= 100) return sign + Math.round(v).toLocaleString('en-IN');
  if (a >= 10) return sign + v.toFixed(1);
  return sign + v.toFixed(a >= 1 ? 2 : a >= 0.01 ? 3 : 4).replace(/0+$/, '').replace(/\.$/, '');
}

export function legendNum(v, lens) {
  if (lens.format === 'pp') return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v) >= 10 || Number.isInteger(v) ? Math.round(Math.abs(v)) : Math.abs(v).toFixed(1)}`;
  if (lens.format === 'pct' && !(lens.mode === 'change' && lens.pctChange)) {
    const p = v * 100;
    return `${Math.abs(p) < 1 ? p.toFixed(1) : Math.round(p)}${lens.mode === 'change' ? '' : '%'}`;
  }
  const a = Math.abs(v);
  if (a >= 1e7) return `${(v / 1e7).toFixed(1)}Cr`;
  if (a >= 1e5) return `${(v / 1e5).toFixed(a >= 1e6 ? 0 : 1)}L`;
  if (a >= 1e4) return `${Math.round(v / 1000)}k`;
  if (a >= 1000) return `${(v / 1000).toFixed(1)}k`;
  if (a >= 10) return String(Math.round(v));
  if (a >= 1) return v.toFixed(1);
  if (a === 0) return '0';
  return v.toFixed(a >= 0.1 ? 2 : 3).replace(/^(-?)0\./, '$1.');
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** A series' time step for display: a year (2025) or a month coded YYYYMM (202603 -> Mar 2026, short: Mar '26). */
export function periodLabel(p, short = false) {
  if (p == null) return '';
  if (p < 100000) return String(p);
  const y = Math.floor(p / 100);
  return `${MON[(p % 100) - 1]} ${short ? `'${String(y).slice(2)}` : y}`;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
