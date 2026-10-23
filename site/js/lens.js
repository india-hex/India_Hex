// A "lens" is what the map is showing: a series, a year, and how to read it (value, change
// between years, per km²). Hex and unit numbers are both computed through it, so every view,
// legend, ranking and tooltip agrees.
import * as HX from './data/hexstore.js';
import { periodLabel } from './scales.js';
import { rawUnitValues } from './data/units.js';

let CFG = null;
let BY_ID = new Map();

export function initLens(cfg) {
  CFG = cfg;
  BY_ID = new Map(cfg.variables.map((s) => [s.id, s]));
}

export const seriesById = (id) => BY_ID.get(id) || null;
export const allSeries = () => CFG.variables;

/** Build the lens for a state (optionally overridden, e.g. the right side of compare). */
export function lensOf(st, over = {}) {
  const o = { ...st, ...over };
  const s = BY_ID.get(o.var);
  if (!s) return { none: true, id: 'none', label: 'Outline only' };
  const years = s.years || [];
  const dflt = years.includes(s.default_year) ? s.default_year : years[years.length - 1];
  const year = years.length ? (years.includes(o.year) ? o.year : dflt) : null;
  const canChange = years.length >= 2 && CFG.features.change_mode;
  const mode = canChange && o.mode === 'change' ? 'change' : 'value';
  let from = null;
  if (mode === 'change') {
    from = years.includes(o.from) && o.from < year ? o.from : years[0];
    if (from === year) from = years[0];
  }
  const density = !!(o.density && s.density && CFG.features.density_toggle);
  const pctChange = mode === 'change' && s.agg === 'sum';
  const diverging = mode === 'change' || ['rdbu', 'brbg', 'puor'].includes(s.ramp);
  let unitLabel = s.unit || (s.format === 'pct' ? '%' : '');
  if (density) unitLabel = `${s.unit ? `${s.unit} ` : ''}per km²`;
  if (mode === 'change') unitLabel = pctChange ? '% change' : s.format === 'pct' ? 'percentage points' : `change${s.unit ? ` (${s.unit})` : ''}`;
  return {
    id: s.id, series: s, label: s.label, note: s.note, group: s.group, years, year, from, mode, density,
    pctChange, diverging, ramp: s.ramp, format: density ? 'dec2' : s.format, agg: s.agg, unitLabel,
    title: `${s.label}${density ? ' per km²' : ''}${mode === 'change' ? `, change ${periodLabel(from)}–${periodLabel(year)}` : year ? `, ${periodLabel(year)}` : ''}`,
  };
}

/** Resolutions at which every year this lens needs is published. */
export function resAvailable(lens, res) {
  if (lens.none) return true;
  const ys = lens.series.res_years[String(res)];
  if (!ys) return false;
  const need = lens.mode === 'change' ? [lens.year, lens.from] : [lens.year];
  return need.every((y) => ys.includes(y));
}

function combine(v, v0, lens, area) {
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) {
    let x = v[i];
    const a = area ? (typeof area === 'number' ? area : area[i]) : 1;
    if (lens.mode === 'change') {
      const y0 = v0[i];
      if (lens.pctChange) x = y0 > 0 ? ((x - y0) / y0) * 100 : NaN;
      else x = lens.density ? (x - y0) / a : x - y0;
    } else if (lens.density) x /= a;
    out[i] = x;
  }
  return out;
}

/** Values for every cell of a CellSet, or null when this lens isn't published at its resolution. */
export async function hexValues(cs, lens) {
  if (lens.none || !resAvailable(lens, cs.res)) return null;
  const [v, v0] = await Promise.all([
    HX.values(cs, lens.series, lens.year),
    lens.mode === 'change' ? HX.values(cs, lens.series, lens.from) : null,
  ]);
  if (!v) return null;
  return combine(v, v0, lens, lens.density ? cs.area : null);
}

/** Values for every unit of a level (index = unit id), or null. */
export async function unitValues(level, lens, units) {
  if (lens.none) return null;
  const [v, v0] = await Promise.all([
    rawUnitValues(lens.id, level, lens.year),
    lens.mode === 'change' ? rawUnitValues(lens.id, level, lens.from) : null,
  ]);
  if (!v) return null;
  const f = Float64Array.from(v, (x) => (x == null ? NaN : x));
  const f0 = v0 ? Float64Array.from(v0, (x) => (x == null ? NaN : x)) : null;
  return combine(f, f0, lens, lens.density ? units[level].map((u) => u.area || NaN) : null);
}

/** All-India breaks precomputed by the pipeline (value mode, no density), else null. */
export function indiaBreaks(lens, res) {
  if (lens.none || lens.mode === 'change') return null;
  const b = lens.series.breaks?.[String(res)]?.[lens.year == null ? 'None' : String(lens.year)];
  if (!b || !b.length) return null;
  if (!lens.density) return b;
  return b.map((x) => x / HXarea(res));
}

const AREAS = { 6: 36.129, 7: 5.161, 8: 0.737 };
const HXarea = (res) => AREAS[res];
