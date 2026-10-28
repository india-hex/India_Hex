// Sidebar: breadcrumb, place hero, the current lens for this place (value, rank, distribution),
// key figures, land cover, rankings of the units inside it, the clicked hexagon, pinned-unit
// comparison and the About view. Pure rendering from state + data; actions go through ctx.act.
import { esc, fmtValue, compact, rampFor, scaleFromValues, colourOf, legendNum, periodLabel } from '../scales.js';
import { units, unit, stateName, childrenOf, rawUnitValues } from '../data/units.js';
import { lensOf, seriesById, unitValues } from '../lens.js';
import { fmtCoord } from './statusbar.js';

let tok = 0;
let CTX = null;
const LC = [
  ['landcover_forest_share', 'Trees', '#3f7d55'], ['landcover_agriculture_share', 'Crops', '#d2a63a'],
  ['landcover_built_share', 'Built', '#c4552f'], ['landcover_water_wetland_share', 'Water', '#3b7bb5'],
  ['landcover_open_natural_share', 'Open land', '#b9ad97'],
];
const ICON = {
  pin: '<svg viewBox="0 0 24 24"><path d="M12 21s-6-5.3-6-11a6 6 0 1 1 12 0c0 5.7-6 11-6 11z"/><circle cx="12" cy="10" r="2.2"/></svg>',
  zoom: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  link: '<svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
  dl: '<svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
  gmap: '<svg viewBox="0 0 24 24"><path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/></svg>',
  earth: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 3.5 5.4 3.5 8.5s-1 5.9-3.5 8.5c-2.5-2.6-3.5-5.4-3.5-8.5s1-5.9 3.5-8.5z"/></svg>',
  csv: '<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 13h6M9 17h6"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};

export function initPanel(ctx) {
  CTX = ctx;
  const click = (e) => {
    const t = e.target.closest('[data-sel],[data-act],[data-tab],[data-var]');
    if (!t) return;
    const { act } = ctx;
    if (t.dataset.sel) {
      const v = t.dataset.sel;
      if (v === 'india') act.clearSelection();
      else { const [l, id] = v.split(':'); act.select(l, +id); }
    } else if (t.dataset.tab) ctx.S.set({ tab: t.dataset.tab, filter: '', limit: 50 });
    else if (t.dataset.var) {
      const st = ctx.S.get();
      ctx.S.set({ var: st.var === t.dataset.var ? 'none' : t.dataset.var, mode: 'value', density: false });
    } else act.run(t.dataset.act, t.dataset);
  };
  document.getElementById('panel').addEventListener('click', click);
  document.getElementById('crumbs').addEventListener('click', click);
  document.getElementById('pins').addEventListener('click', click);
  document.getElementById('panel').addEventListener('input', (e) => {
    if (e.target.id === 'listFilter') ctx.S.set({ filter: e.target.value, limit: 50 });
  });
  document.getElementById('panel').addEventListener('change', (e) => {
    if (e.target.id === 'stateJump' && e.target.value !== '') ctx.act.select('state', +e.target.value);
  });
  document.getElementById('panel').addEventListener('toggle', (e) => {
    if (e.target.id === 'stateFold') ctx.rt.stateFoldOpen = e.target.open;
  }, true);
}

// ------------------------------------------------------------------------------------------------
const U = () => units();
const LEVEL = (id) => CTX.cfg.boundaries.levels[id];
const h3IsHere = (st) => !!st.here && !!st.hex;
const PLURAL = { state: 'states & UTs', district: 'districts', pc: 'Lok Sabha constituencies', ac: 'assembly constituencies' };

function crumbs(st) {
  const parts = [['India', 'india']];
  if (st.sel) {
    const u = unit(st.sel);
    if (st.sel.level !== 'state') parts.push([stateName(u.st), `state:${u.st}`]);
    if (st.sel.level === 'ac') {
      if (st.level === 'district' && u.d >= 0) parts.push([U().district[u.d].name, `district:${u.d}`]);
      else if (u.pc >= 0) parts.push([U().pc[u.pc].name, `pc:${u.pc}`]);
    }
    parts.push([u.name, null]);
  }
  document.getElementById('crumbs').innerHTML = parts.map(([n, s], i) => (i === parts.length - 1
    ? `<span>${esc(n)}</span>` : `<button data-sel="${s}">${esc(n)}</button><span class="sep">/</span>`)).join('');
}

/** Value of every featured series for a unit (or India), latest and first year. */
async function figures(sel) {
  const ids = CTX.cfg.featured;
  return Promise.all(ids.map(async (id) => {
    const s = seriesById(id);
    const ys = s.years.length ? s.years : [null];
    const last = ys.includes(s.default_year) ? s.default_year : ys[ys.length - 1];
    const first = ys.length > 1 ? ys[0] : null;
    const val = async (y) => {
      if (sel) { const a = await rawUnitValues(id, sel.level, y); return a ? a[sel.id] : null; }
      const a = await rawUnitValues(id, 'state', y);
      if (!a) return null;
      const st = U().state;
      if (s.agg === 'sum') return a.reduce((t, x) => t + (x || 0), 0);
      if (s.agg === 'mean' || s.agg === 'wmean') { let w = 0; let t = 0; a.forEach((x, i) => { if (x != null) { t += x * st[i].area; w += st[i].area; } }); return w ? t / w : null; }
      const v = a.filter((x) => x != null).sort((p, q) => p - q);
      return v.length ? v[Math.floor(v.length / 2)] : null; // median: middle state
    };
    const [v, v0] = await Promise.all([val(last), first != null ? val(first) : null]);
    return { s, v, v0, last, first };
  }));
}

function figHTML(f, st, area) {
  const lens = lensOf({ ...st, var: f.s.id, mode: 'value', density: false });
  let delta = '';
  if (f.v0 != null && f.v != null) {
    let d; let txt;
    if (f.s.agg === 'sum' && f.v0 > 0) { d = ((f.v - f.v0) / f.v0) * 100; txt = `${Math.abs(d).toFixed(Math.abs(d) < 10 ? 1 : 0)}%`; }
    else if (f.s.format === 'pct') { d = (f.v - f.v0) * 100; txt = `${Math.abs(d).toFixed(1)} pp`; }
    else { d = f.v - f.v0; txt = fmtValue(Math.abs(d), lens); }
    if (Math.abs(d) > 1e-9) delta = `<div class="fd"><span class="${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'} ${txt}</span> since ${periodLabel(f.first)}</div>`;
  }
  const dens = f.s.density && area && f.v != null ? `<div class="fd">${fmtValue(f.v / area, { ...lens, density: true, format: 'dec2' })} per km²</div>` : '';
  const unitTxt = f.s.unit && !['people', 'POIs'].includes(f.s.unit) && f.s.format !== 'inr' && f.s.format !== 'pct' ? `<small>${esc(f.s.unit)}</small>` : '';
  return `<button class="fig${st.var === f.s.id ? ' on' : ''}" data-var="${f.s.id}" title="Colour the map by ${esc(f.s.label)}">
    <div class="fl">${esc(f.s.label)}${f.last ? ` · ${periodLabel(f.last)}` : ''}</div>
    <div class="fv">${f.s.agg === 'sum' && f.v >= 1e5 ? compact(f.v) : fmtValue(f.v, lens)}${unitTxt}</div>${delta || dens}</button>`;
}

async function landCover(sel) {
  const have = LC.filter(([id]) => seriesById(id));
  if (!have.length) return '';
  const vals = await Promise.all(have.map(async ([id]) => {
    const s = seriesById(id);
    const y = s.years[s.years.length - 1];
    const a = await rawUnitValues(id, sel ? sel.level : 'state', y);
    if (!a) return 0;
    if (sel) return a[sel.id] || 0;
    let w = 0; let t = 0;
    a.forEach((x, i) => { if (x != null) { t += x * U().state[i].area; w += U().state[i].area; } });
    return w ? t / w : 0;
  }));
  const year = seriesById(have[0][0]).years.slice(-1)[0];
  return `<h2 class="h2">Land cover <small>Esri 10 m · ${year}</small></h2>
    <div class="lc"><div class="lc-bar">${have.map(([, , c], i) => `<i style="width:${(vals[i] * 100).toFixed(2)}%;background:${c}"></i>`).join('')}</div>
    <div class="lc-legend">${have.map(([, l, c], i) => `<span><i style="background:${c}"></i>${l} ${Math.round(vals[i] * 100)}%</span>`).join('')}</div></div>`;
}

function histogram(vals, mark, lens, ramp, sc) {
  const v = vals.filter(Number.isFinite);
  if (v.length < 5) return '';
  const lo = Math.min(...v); const hi = Math.max(...v);
  const B = 28; const W = 344; const H = 46;
  const bins = new Array(B).fill(0);
  // skewed positive data (night lights, density…) reads better on a log axis
  const sorted = [...v].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const logAxis = lo >= 0 && med > 0 && hi / med > 15;
  const eps = Math.max(sorted.find((x) => x > 0) || med / 100, 1e-9);
  const tf = (x) => (logAxis ? Math.log(x + eps) : x);
  const tlo = tf(lo); const thi = tf(hi);
  const bi = (x) => Math.min(B - 1, Math.max(0, Math.floor(((tf(x) - tlo) / ((thi - tlo) || 1)) * B)));
  v.forEach((x) => { bins[bi(x)]++; });
  const max = Math.max(...bins);
  const mb = mark != null && Number.isFinite(mark) ? bi(mark) : -1;
  const bw = W / B;
  const rects = bins.map((n, i) => {
    const h = n ? Math.max(1.5, (n / max) * (H - 2)) : 0;
    const t0 = tlo + ((i + 0.5) / B) * (thi - tlo);
    const x0 = logAxis ? Math.exp(t0) - eps : t0;
    const c = i === mb ? 'var(--accent)' : colourOf(x0, sc) || ramp[4];
    return `<rect x="${(i * bw + 0.5).toFixed(1)}" y="${(H - h).toFixed(1)}" width="${(bw - 1).toFixed(1)}" height="${h.toFixed(1)}" fill="${c}" opacity="${i === mb ? 1 : 0.75}"/>`;
  }).join('');
  return `<svg class="hist" viewBox="0 0 ${W} ${H + 14}" width="100%">${rects}
    <text x="0" y="${H + 12}" font-size="10" fill="var(--ink-3)">${esc(legendNum(lo, lens))}</text>
    ${logAxis ? `<text x="${W / 2}" y="${H + 12}" font-size="10" fill="var(--ink-3)" text-anchor="middle">log scale</text>` : ''}
    <text x="${W}" y="${H + 12}" font-size="10" fill="var(--ink-3)" text-anchor="end">${esc(legendNum(hi, lens))}</text></svg>`;
}

/** State ids of a state-scoped (election) series and their names, or null. */
function scopeOf(lens) {
  if (!lens.states) return null;
  const ss = U().state.filter((u) => lens.states.includes(u.key));
  return { ids: new Set(ss.map((u) => u.id)), name: ss.map((u) => u.name).join(' and ') };
}
const inScope = (scope, lvl) => (u) => !scope || scope.ids.has(lvl === 'state' ? u.id : u.st);
const approx = (lens, lvl) => (lens.series?.official && lvl === 'district' ? ' (approximate: ACs grouped by district)' : '');

/** Swatch and label of a category code. */
function catChip(v, lens) {
  const c = lens.series.categories[v];
  return c ? `<i class="sw" style="background:${c.color}"></i>${esc(c.label)}` : '–';
}

/** How many units each category leads, as a stacked bar with counts. */
function catCounts(pv, lens, label) {
  const cats = lens.series.categories;
  const n = cats.map(() => 0);
  for (const x of pv) if (Number.isFinite(x) && n[x] !== undefined) n[x]++;
  const tot = n.reduce((a, b) => a + b, 0);
  if (!tot) return '';
  const order = cats.map((c, i) => i).filter((i) => n[i]).sort((a, b) => n[b] - n[a]);
  return `<div class="rank">Leading in ${tot.toLocaleString('en-IN')} ${esc(label)}</div>
    <div class="catbar">${order.map((i) => `<i style="flex:${n[i]};background:${cats[i].color}" title="${esc(cats[i].label)}: ${n[i]}"></i>`).join('')}</div>
    <div class="catkey">${order.map((i) => `<span>${catChip(i, lens)} <b>${n[i]}</b></span>`).join('')}</div>`;
}

async function lensBlock(st, lens) {
  if (lens.none) return '';
  const scope = scopeOf(lens);
  if (scope && st.sel && !scope.ids.has(st.sel.level === 'state' ? st.sel.id : unit(st.sel).st)) {
    return `<div class="lensblock"><div class="lbl">${esc(lens.title)}</div><div class="rank">Available for ${esc(scope.name)} only.</div></div>`;
  }
  // an election's leading party for a selected state: count its constituencies, like seats
  const lvl = st.sel ? (lens.categorical && st.sel.level === 'state' ? st.tab || 'ac' : st.sel.level) : st.level;
  const vals = await unitValues(lvl, lens, U());
  if (!vals) return '';
  const ramp = rampFor(lens, st.cbSafe);
  let peers; let v = null; let label;
  if (st.sel && lvl !== st.sel.level) {
    v = (await unitValues('state', lens, U()))?.[st.sel.id];
    peers = U()[lvl].filter((x) => x.st === st.sel.id);
    label = `${PLURAL[lvl]} in ${stateName(st.sel.id)}${approx(lens, lvl)}`;
  } else if (st.sel) {
    const u = unit(st.sel);
    v = vals[st.sel.id];
    peers = st.sel.level === 'state' ? U().state.filter(inScope(scope, 'state')) : U()[lvl].filter((x) => x.st === u.st);
    label = st.sel.level === 'state' ? (scope ? scope.name : PLURAL.state) : `${PLURAL[lvl]} in ${stateName(u.st)}${approx(lens, lvl)}`;
  } else {
    peers = U()[lvl].filter(inScope(scope, lvl));
    label = scope ? `${PLURAL[lvl]} in ${scope.name}${approx(lens, lvl)}` : `${PLURAL[lvl]} across India`;
  }
  const pv = peers.map((p) => vals[p.id]);
  if (lens.categorical) {
    const big = st.sel ? `<div class="big catv">${catChip(v, lens)}</div>` : '';
    return `<div class="lensblock"><div class="lbl">${esc(lens.title)}</div>${big}${catCounts(pv, lens, label)}</div>`;
  }
  const sc = scaleFromValues(pv, lens, ramp) || { breaks: [], colors: ramp };
  let rank = '';
  if (st.sel && Number.isFinite(v)) {
    const r = pv.filter((x) => Number.isFinite(x) && x > v).length + 1;
    const n = pv.filter(Number.isFinite).length;
    const allN = Array.from(vals).filter(Number.isFinite);
    const rAll = allN.filter((x) => x > v).length + 1;
    rank = `<div class="rank">${r.toLocaleString('en-IN')} of ${n.toLocaleString('en-IN')} ${esc(label)}${st.sel.level !== 'state' && !scope ? ` · ${rAll.toLocaleString('en-IN')} of ${allN.length.toLocaleString('en-IN')} in India` : ''}</div>`;
    if (scope && st.sel.level === 'state') rank = ''; // one state: nothing to rank against
  }
  const big = st.sel
    ? `<div class="big">${fmtValue(v, lens)}<small>${esc(lens.unitLabel)}</small></div>${rank}`
    : `<div class="rank">Distribution over ${pv.filter(Number.isFinite).length.toLocaleString('en-IN')} ${esc(label)}</div>`;
  return `<div class="lensblock"><div class="lbl">${esc(lens.title)}</div>${big}${histogram(pv, v, lens, ramp, sc)}</div>`;
}

async function listBlock(st, lens) {
  let level; let items; let head = '';
  const scope = lens.none ? null : scopeOf(lens);
  if (!st.sel) {
    level = st.level === 'state' ? 'state' : st.level;
    items = U()[level].filter(inScope(scope, level));
    head = `<h2 class="h2">${lens.none ? 'States & union territories' : `Ranking · ${esc(LEVEL(level).label)}`}<small>${lens.none ? '' : 'top and bottom'}</small></h2>`;
    if (lens.none) { level = 'state'; items = U().state; }
  } else if (st.sel.level === 'state') {
    level = st.tab;
    items = childrenOf(st.sel, level);
    const n = (l) => childrenOf(st.sel, l).length;
    head = `<h2 class="h2">Inside ${esc(unit(st.sel).name)}</h2>
      <div class="tabs">${['ac', 'pc', 'district'].map((l) => `<button data-tab="${l}" class="${st.tab === l ? 'on' : ''}">${LEVEL(l).label}<small>${n(l)}</small></button>`).join('')}</div>
      <input class="filter" id="listFilter" placeholder="Filter by name or number" value="${esc(st.filter)}">`;
  } else {
    level = 'ac';
    items = childrenOf(st.sel, 'ac');
    const u = unit(st.sel);
    const t = st.sel.level === 'ac' ? (u.pc >= 0 ? `Other ACs in ${esc(U().pc[u.pc].name)}` : '') : 'Assembly constituencies';
    if (!t || !items.length) return '';
    head = `<h2 class="h2">${t}</h2>`;
  }
  const vals = lens.none ? null : await unitValues(level, lens, U());
  let rows = items.map((u) => ({ u, v: vals ? vals[u.id] : (u.h8 ? null : null) }));
  if (st.filter) {
    const q = st.filter.toLowerCase();
    rows = rows.filter((r) => r.u.name.toLowerCase().includes(q) || String(r.u.no ?? '') === q);
  }
  if (vals && lens.categorical) rows.sort((a, b) => (Number.isFinite(a.v) ? a.v : 99) - (Number.isFinite(b.v) ? b.v : 99) || a.u.name.localeCompare(b.u.name));
  else if (vals) rows.sort((a, b) => (Number.isFinite(b.v) ? b.v : -Infinity) - (Number.isFinite(a.v) ? a.v : -Infinity));
  else if (level === 'ac' || level === 'pc') rows.sort((a, b) => (a.u.no || 0) - (b.u.no || 0));
  else rows.sort((a, b) => a.u.name.localeCompare(b.u.name));
  const ramp = rampFor(lens, st.cbSafe);
  const sc = vals ? scaleFromValues(rows.map((r) => r.v), lens, ramp) : null;
  const max = vals ? Math.max(1e-12, ...rows.map((r) => Math.abs(r.v)).filter(Number.isFinite)) : 1;
  const row = ({ u, v }, i) => {
    const val = vals ? fmtValue(v, lens, { short: true }) : '';
    const bar = vals && Number.isFinite(v) ? `<span class="br"><i style="width:${lens.categorical ? 100 : Math.max(1.5, (Math.abs(v) / max) * 100)}%;background:${(sc && colourOf(v, sc)) || 'var(--ink-3)'}"></i></span>` : '';
    const no = u.no != null ? `<small>${u.no}</small>` : '';
    const sub = level !== 'state' && !st.sel ? `<small>${esc(stateName(u.st))}</small>` : no;
    return `<button class="row" data-sel="${level}:${u.id}"><span class="rk">${vals ? i + 1 : ''}</span><span class="nm">${esc(u.name)}${sub}</span><span class="vl">${val}</span>${bar}</button>`;
  };
  CTX.rt.list = { level, rows, lens };
  const jumpSel = !st.sel ? `<select class="jump" id="stateJump" aria-label="Go to a state or union territory">
      <option value="">Go to a state or union territory</option>
      ${[...U().state].sort((x, y) => x.name.localeCompare(y.name)).map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}</select>` : '';
  if (!st.sel && vals && rows.length > 24 && !st.filter && level !== 'state' && !lens.categorical) {
    const top = rows.slice(0, 10);
    const bottomRows = rows.filter((r) => Number.isFinite(r.v));
    const bottom = bottomRows.slice(-10).reverse();
    return `<h2 class="h2">States & union territories<small>${U().state.length}</small></h2>${jumpSel}${head}<div class="split"><div><h3>Highest</h3><div class="rows">${top.map(row).join('')}</div></div>
      <div><h3>Lowest</h3><div class="rows">${bottom.map((r) => row(r, bottomRows.indexOf(r))).join('')}</div></div></div>
      <button class="textbtn" data-act="csv" style="margin-top:12px">Download full ranking (CSV)</button>`;
  }
  const lim = st.limit || 50;
  if (!st.sel && level === 'state') {
    // landing page: a dropdown to jump to any state / UT, the full list folded underneath
    return `<h2 class="h2">States & union territories<small>${U().state.length}</small></h2>${jumpSel}
      <details class="fold" id="stateFold"${CTX.rt.stateFoldOpen ? ' open' : ''}><summary>${vals ? `All ${rows.length}, ranked` : `All ${rows.length}`}</summary>
      <div class="rows">${rows.map(row).join('')}</div></details>`;
  }
  return `${head}<div class="rows">${rows.slice(0, lim).map(row).join('') || '<div class="note">No matches.</div>'}</div>
    ${rows.length > lim ? `<button class="more" data-act="more">Show all ${rows.length}</button>` : ''}
    ${vals && CTX.cfg.features.export_csv ? '<button class="textbtn" data-act="csv" style="margin-top:12px">Download as CSV</button>' : ''}`;
}

function googleLinks(lng, lat, z) {
  if (!CTX.cfg.features.google_links) return '';
  const gm = `https://www.google.com/maps/@${lat},${lng},${Math.round(z)}z/data=!3m1!1e3`;
  const ge = `https://earth.google.com/web/@${lat},${lng},300a,${Math.round(40000000 / 2 ** z)}d,35y,0h,0t,0r`;
  return `<a class="icon" href="${gm}" target="_blank" rel="noopener" title="Open in Google Maps (satellite)">${ICON.gmap}</a>
    <a class="icon" href="${ge}" target="_blank" rel="noopener" title="Open in Google Earth">${ICON.earth}</a>`;
}

function hero(st) {
  if (!st.sel) {
    const pop = CTX.rt.indiaPop;
    return `<h1 class="title">India</h1>
      <p class="lede">${U().state.length} states and UTs · ${U().district.length} districts · ${U().pc.length} Lok Sabha · ${U().ac.length.toLocaleString('en-IN')} Assembly${pop ? ` · ${compact(pop)} people` : ''}</p>`;
  }
  const u = unit(st.sel);
  const L = LEVEL(st.sel.level);
  const links = [];
  if (st.sel.level !== 'state') links.push(`<button data-sel="state:${u.st}">${esc(stateName(u.st))}</button>`);
  if (st.sel.level === 'ac') {
    if (u.pc >= 0) links.push(`<span>PC</span><button data-sel="pc:${u.pc}">${esc(U().pc[u.pc].name)}</button>`);
    if (u.d >= 0) links.push(`<span>District</span><button data-sel="district:${u.d}">${esc(U().district[u.d].name)}</button>`);
  }
  const pinned = st.pinned.includes(`${st.sel.level}:${st.sel.id}`);
  const z = { state: 7, district: 9, pc: 9, ac: 11 }[st.sel.level];
  const f = CTX.cfg.features;
  return `<div class="kicker">${esc(L.one)}${u.no != null ? ` · No. <b>${u.no}</b>` : ''}${u.area ? ` · ${Math.round(u.area).toLocaleString('en-IN')} km²` : ''}</div>
    <h1 class="title${u.name.length > 22 ? ' small' : ''}">${esc(u.name)}</h1>
    <div class="meta">${links.join('')}</div>
    <div class="acts">
      ${f.pin_compare ? `<button class="icon${pinned ? ' on' : ''}" data-act="pin" title="${pinned ? 'Unpin' : 'Pin to compare'}">${ICON.pin}</button>` : ''}
      <button class="icon" data-act="zoom" title="Zoom to">${ICON.zoom}</button>
      <button class="icon" data-act="copy" title="Copy link">${ICON.link}</button>
      ${f.export_geojson ? `<button class="icon" data-act="geojson" title="Download hexagons (GeoJSON)">${ICON.dl}</button>` : ''}
      ${googleLinks(u.lp[0], u.lp[1], z)}
    </div>`;
}

/** The hexagon's centre, or your position after Find me, in the status bar's format; click to copy. */
function coordLine(st, info) {
  if (!CTX.cfg.features.coordinates) return '';
  const here = h3IsHere(st);
  const [lng, lat] = here ? [st.here.lng, st.here.lat] : [info.lng, info.lat];
  return `<button class="coordline" data-act="copycoord" data-lat="${lat}" data-lng="${lng}" title="Copy latitude, longitude">
    ${esc(fmtCoord(lng, lat))}<small>${here ? 'your position' : 'centre'}</small></button>`;
}

async function hexBand(st) {
  const info = await CTX.act.hexInfo(st.hex);
  if (!info) return '';
  const links = [];
  if (info.a >= 0) links.push(`<span>AC</span><button data-sel="ac:${info.a}">${esc(U().ac[info.a].name)}</button>`);
  if (info.p >= 0) links.push(`<span>PC</span><button data-sel="pc:${info.p}">${esc(U().pc[info.p].name)}</button>`);
  if (info.d >= 0) links.push(`<span>District</span><button data-sel="district:${info.d}">${esc(U().district[info.d].name)}</button>`);
  const fig = ({ s, v, year }) => {
    const lens = lensOf({ ...st, var: s.id, mode: 'value', density: false, year });
    return `<button class="fig${st.var === s.id ? ' on' : ''}" data-var="${s.id}"><div class="fl">${esc(s.label)}${year ? ` · ${periodLabel(year)}` : ''}</div>
      <div class="fv">${lens.categorical ? (Number.isFinite(v) ? catChip(v, lens) : '–') : fmtValue(v, lens)}${s.format === 'pp' && Number.isFinite(v) ? '<small> pp</small>' : ''}</div>${s.density && Number.isFinite(v) ? `<div class="fd">${fmtValue(v / info.area, { ...lens, density: true, format: 'dec2' })} per km²</div>` : ''}</button>`;
  };
  const figs = info.figs.map(fig).join('');
  const grp = info.group && info.group.figs.length
    ? `<div class="kicker" style="margin-top:14px">${esc(info.group.name)} · ${periodLabel(info.group.year)}</div>
      ${info.group.figs.every((f) => !Number.isFinite(f.v)) ? '<p class="note">No modelled votes in this hexagon for this election.</p>' : `<div class="figs" style="margin-top:8px">${info.group.figs.map(fig).join('')}</div>`}` : '';
  return `<section class="band"><button class="icon close" data-act="closehex" title="Close">${ICON.x}</button>
    ${st.here && h3IsHere(st) ? `<div class="kicker"><b>You are here</b> · accurate to ${st.here.acc < 1000 ? `${Math.round(st.here.acc)} m` : `${(st.here.acc / 1000).toFixed(1)} km`}</div>` : ''}
    <div class="kicker">H${info.res} hexagon · ${info.area.toFixed(2)} km² · ${esc(stateName(info.s))}</div>
    <h2 class="title mono">${info.h}</h2><div class="meta">${links.join('')}</div>
    ${coordLine(st, info)}
    <div class="acts"><button class="icon" data-act="copyhex" title="Copy H3 id">${ICON.link}</button>${googleLinks(info.lng, info.lat, { 6: 11, 7: 13, 8: 15 }[info.res])}</div>
    ${grp}<div class="figs" style="margin-top:12px">${figs}</div></section>`;
}

async function compareTable(st) {
  const pins = st.pinned.map((p) => { const [l, id] = p.split(':'); return { level: l, id: +id }; });
  if (!pins.length) return '<div class="note">Pin places with the pin button to compare them here.</div>';
  const ids = [...new Set([...(st.var !== 'none' ? [st.var] : []), ...CTX.cfg.featured])];
  const rows = await Promise.all(ids.map(async (id) => {
    const s = seriesById(id);
    const y = s.years.length ? (s.years.includes(s.default_year) ? s.default_year : s.years[s.years.length - 1]) : null;
    const vals = await Promise.all(pins.map(async (p) => { const a = await rawUnitValues(id, p.level, y); return a ? a[p.id] : null; }));
    return { s, y, vals };
  }));
  CTX.rt.compareRows = { pins, rows };
  const head = pins.map((p) => `<th>${esc(unit(p).name)}<div style="font-size:10px;color:var(--ink-3)">${esc(LEVEL(p.level).short)}</div></th>`).join('');
  const body = rows.map(({ s, y, vals }) => {
    const lens = lensOf({ ...st, var: s.id, mode: 'value', density: false });
    const best = s.type === 'categorical' ? null : Math.max(...vals.filter(Number.isFinite));
    return `<tr><td>${esc(s.label)}${y ? ` <span style="color:var(--ink-3)">${periodLabel(y)}</span>` : ''}</td>${vals.map((v) => `<td class="${v === best && pins.length > 1 ? 'best' : ''}">${fmtValue(v, lens, { short: true })}</td>`).join('')}</tr>`;
  }).join('');
  return `<div class="kicker">Side by side</div><h1 class="title small">Pinned places</h1>
    <table class="ctable"><thead><tr><th></th>${head}</tr></thead><tbody>${body}</tbody></table>
    <p class="note">Highest value per row highlighted. Values are aggregated from H8 cells: sums for counts, means for shares, medians for prices. Election values are the official ECI results.</p>
    <div style="display:flex;gap:16px;margin-top:14px"><button class="textbtn" data-act="csvcompare">Download CSV</button><button class="textbtn" data-act="back">Back to map panel</button></div>`;
}

function about() {
  const s = CTX.cfg.site;
  return `<div class="kicker">About</div><h1 class="title small">${esc(s.title)}</h1>
    <p class="lede">${esc(s.tagline || '')}</p>
    <ol class="steps">
      <li>Choose a boundary level and click a place, or search.</li>
      <li>Turn on H6, H7 or H8 hexagons. Auto picks one from the zoom.</li>
      <li>Colour by any of ${CTX.cfg.variables.length} variables. Years, change and per km² are in the Layers panel.</li>
      <li>Click a hexagon for its values. Pin places to compare them. Export PNG, CSV or GeoJSON.</li>
    </ol>
    <p class="note">Sources: ${esc(s.data_credit || '')}. A hexagon belongs to the unit that contains its centre. Unit values are aggregated from H8 cells.</p>
    <p class="note">Elections (Karnataka, Bihar): hexagon values are modelled from booth results spread over where voters live. Values for constituencies, districts and states are the official ECI results, not hexagon aggregates; a district combines the ACs that lie mostly inside it, so district values are approximate.</p>
    <p class="note">${s.author ? `${esc(s.author)} · ` : ''}${s.github ? `<a href="${esc(s.github)}" target="_blank" rel="noopener">Source code</a> · ` : ''}Data version ${esc(CTX.cfg.version)}</p>
    <button class="textbtn" data-act="back" style="margin-top:16px">Back</button>`;
}

let lastPlace = null;

/**
 * Progressive render: the hero appears at once; every section fills in as its own data arrives
 * (it keeps its previous content meanwhile, so changing variables doesn't flicker).
 */
export async function renderPanel() {
  const t = ++tok;
  const st = CTX.S.get();
  const lens = lensOf(st);
  crumbs(st);
  renderPins(st);
  const panel = document.getElementById('panel');
  if (st.panel === 'compare' || st.panel === 'about') {
    const html = st.panel === 'compare' ? await compareTable(st) : about();
    if (t === tok) { panel.innerHTML = html; lastPlace = null; }
    return;
  }
  const place = JSON.stringify([st.sel, st.hex]);
  if (place !== lastPlace || !document.getElementById('sec-figs')) {
    lastPlace = place;
    panel.innerHTML = `<div id="sec-band"></div><div id="sec-hero">${hero(st)}</div><div id="sec-block"></div>
      <h2 class="h2">Key figures</h2><div class="figs" id="sec-figs"><div class="note">Loading…</div></div>
      <div id="sec-lc"></div><div id="sec-list"></div>`;
    panel.scrollTop = 0;
  } else {
    document.getElementById('sec-hero').innerHTML = hero(st);
  }
  const area = st.sel ? unit(st.sel).area : null;
  const fill = (id, promise, wrap = (x) => x) => promise.then((html) => {
    if (t !== tok) return;
    const el = document.getElementById(id);
    if (!el) return;
    const focused = document.activeElement?.id === 'listFilter';
    el.innerHTML = wrap(html);
    if (focused) { const f = document.getElementById('listFilter'); f.focus(); f.setSelectionRange(f.value.length, f.value.length); }
  }).catch((e) => console.error(e));
  fill('sec-band', st.hex ? hexBand(st) : Promise.resolve(''));
  fill('sec-block', lensBlock(st, lens));
  fill('sec-figs', figures(st.sel).then((figs) => {
    if (!st.sel) {
      const pop = figs.find((f) => f.s.id === 'population');
      CTX.rt.indiaPop = pop ? pop.v : null;
      const h = document.getElementById('sec-hero');
      if (h && t === tok) h.innerHTML = hero(st);
    }
    return figs.map((f) => figHTML(f, st, area)).join('');
  }));
  fill('sec-lc', landCover(st.sel));
  fill('sec-list', listBlock(st, lens));
}

function renderPins(st) {
  const el = document.getElementById('pins');
  if (!CTX.cfg.features.pin_compare || !st.pinned.length) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = st.pinned.map((p) => {
    const [l, id] = p.split(':');
    return `<span class="pin"><button data-sel="${l}:${id}" style="width:auto;height:auto;border-radius:0">${esc(units()[l][+id].name)}</button><button data-act="unpin" data-pin="${p}" title="Remove">✕</button></span>`;
  }).join('') + (st.pinned.length > 1 || st.panel !== 'compare' ? `<button class="go" data-act="${st.panel === 'compare' ? 'back' : 'compare'}">${st.panel === 'compare' ? 'Close' : 'Compare →'}</button>` : '');
}
