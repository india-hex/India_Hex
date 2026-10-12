/* global h3 */
// Boot + orchestration. State lives in the store (store.js); this file reacts to it:
//   cells   (which hexagons: resolution, selected place or viewport)  -> updateCells()
//   colours (lens values -> scale -> fills / unit colours / 3D)       -> recolour()
//   chrome  (sidebar, controls) re-render from state.
// Adding a feature = add state + a subscriber; nothing else needs to know.
import { createStore, readHash, writeHash } from './store.js';
import { initHexStore, cellSet, findCell, chunksFor, manifest, values as hexRaw } from './data/hexstore.js';
import { loadUnits, units, unit, LEVEL_FIELD } from './data/units.js';
import { initLens, lensOf, hexValues, unitValues, resAvailable, indiaBreaks, seriesById } from './lens.js';
import { MapView } from './map/view.js';
import { loadVectorStyle } from './map/overlays.js';
import { rampFor, scaleFromValues, spread, colourOf, position, rgba, fmtValue } from './scales.js';
import { initPanel, renderPanel } from './ui/panel.js';
import { initControls, renderLens, updateLegend, renderTimeline, defaultCompareValue } from './ui/controls.js';
import { initSearch } from './ui/search.js';
import * as EX from './ui/exporter.js';

const $ = (s) => document.querySelector(s);
const INDIA = [68.0, 6.5, 97.5, 35.8];

// ---- boot ---------------------------------------------------------------------------------------
const cfg = await fetch('config.json', { cache: 'no-cache' }).then((r) => r.json());
document.title = cfg.site.title;
document.documentElement.style.setProperty('--side-w', `${cfg.ui.sidebar_width || 392}px`);
if (cfg.ui.accent) document.documentElement.style.setProperty('--accent', cfg.ui.accent);
initHexStore(cfg.version);
initLens(cfg);
const [U, vs] = await Promise.all([loadUnits(cfg.version), loadVectorStyle(cfg.overlays.vector_style)]);

const D = cfg.defaults;
const DEFAULTS = {
  level: D.level, res: D.hex === 'off' || D.hex === 'auto' ? D.hex : +D.hex, scope: D.scope || 'sel', sel: null, hex: null,
  basemap: D.basemap, overlays: D.overlays || [], var: D.variable || 'none', year: null, mode: 'value', from: null,
  density: false, scale: D.scale === 'india' ? 'india' : 'relative', threeD: false, compare: null, view: null,
};
const hash = readHash();
let pins = [];
try { pins = JSON.parse(localStorage.getItem('indiahex.pins') || '[]'); } catch { /* private mode */ }
let theme = D.theme || 'light';
try { theme = localStorage.getItem('indiahex.theme') || theme; } catch { /* ignore */ }

let sel0 = null;
if (hash.sel) {
  const u = U[hash.sel.level]?.find((x) => x.key === hash.sel.key);
  if (u) sel0 = { level: hash.sel.level, id: u.id };
}
const S = createStore({
  ...DEFAULTS, ...hash, sel: sel0,
  opacity: D.opacity ?? 0.72, theme, mask: !!D.dim_outside_selection, labels: true, stateLines: true, hexLines: true, lineScale: 1, cbSafe: false,
  pinned: pins, panel: 'place', tab: 'ac', filter: '', limit: 50, comparePos: 0.5,
});

let initView = { bounds: [[INDIA[0], INDIA[1]], [INDIA[2], INDIA[3]]], fitBoundsOptions: { padding: 30 } };
if (hash.view && hash.view.length === 3 && hash.view.every(Number.isFinite)) initView = { zoom: hash.view[0], center: [hash.view[2], hash.view[1]] };
const view = new MapView('map', { cfg, vs, view: initView });
window.indiaHex = { S, view, cfg, ensureGeo: (l) => ensureGeo(l) }; // debug / test hook (tools/)

const ctx = { cfg, S, view, cview: null, rt: { hexHint: '' }, geo: {}, feat: {}, act: {} };
let st0Ready = false;
window.indiaHex.ctx = ctx;
const rt = ctx.rt;

// ---- helpers ------------------------------------------------------------------------------------
const views = () => (ctx.cview ? [view, ctx.cview] : [view]);
const isMobile = () => window.matchMedia('(max-width: 820px)').matches;
let toastTimer;
function toast(msg, { spin = false, ttl = 0 } = {}) {
  const el = $('#toast');
  clearTimeout(toastTimer);
  if (!msg) { el.hidden = true; return; }
  el.innerHTML = `${spin ? '<span class="spin"></span>' : ''}<span>${msg}</span>`;
  el.hidden = false;
  if (ttl) toastTimer = setTimeout(() => { el.hidden = true; }, ttl);
}

function padding() {
  if (isMobile()) return { top: 60, bottom: Math.round(window.innerHeight * 0.5) + 20, left: 20, right: 60 };
  const lens = $('#lens');
  return { top: 40, bottom: 110, left: lens.classList.contains('closed') ? 40 : lens.offsetWidth + 40, right: 70 };
}
function fit(b, opts = {}) {
  view.map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: padding(), maxZoom: 13.5, duration: 900, ...opts });
}
function afterMove(fn) {
  let done = false;
  const run = () => { if (!done) { done = true; fn(); } };
  view.map.once('moveend', run);
  setTimeout(run, 1500);
}

// ---- boundaries ---------------------------------------------------------------------------------
const geoLoading = {};
function ensureGeo(level) {
  if (!geoLoading[level]) {
    geoLoading[level] = fetch(`data/boundaries/${level}.json?v=${cfg.version}`).then((r) => r.json()).then((fc) => {
      ctx.geo[level] = fc;
      ctx.feat[level] = new Map(fc.features.map((f) => [f.id, f]));
      views().forEach((v) => v.setBoundaryData(level, fc));
      return fc;
    });
  }
  return geoLoading[level];
}

// ---- cells ---------------------------------------------------------------------------------------
let cellTok = 0;
function viewBBox(pad = 0.08) {
  const b = view.map.getBounds();
  const w = b.getWest(); const e = b.getEast(); const s = b.getSouth(); const n = b.getNorth();
  const dx = (e - w) * pad; const dy = (n - s) * pad;
  return [Math.max(w - dx, 60), Math.max(s - dy, 0), Math.min(e + dx, 105), Math.min(n + dy, 40)];
}

/** Resolution for 'auto' in view scope, or null when zoomed out past the first threshold. */
function autoResForView() {
  const z = view.map.getZoom();
  let res = null;
  for (const [r, minz] of Object.entries(cfg.hex.auto_zoom)) if (z >= minz && cfg.hex.resolutions.includes(+r)) res = Math.max(res ?? 0, +r);
  return res;
}
function autoResForUnit(u) {
  const max = cfg.hex.auto_max_cells || 90000;
  for (const r of [...cfg.hex.resolutions].sort((a, b) => b - a)) if ((u.h8 || 0) / 7 ** (8 - r) <= max) return r;
  return cfg.hex.resolutions[0];
}

async function updateCells() {
  const t = ++cellTok;
  const st = S.get();
  rt.notice = '';
  if (st.res === 'off') { ctx.cs = null; rt.hexHint = ''; rt.shownRes = null; return recolour(); }
  const lens = lensOf(st);
  const useView = st.scope === 'view' || !st.sel;
  let res; let cs = null;
  const fallback = (r) => { let x = r; while (x > cfg.hex.resolutions[0] && !resAvailable(lens, x)) x--; if (x !== r) rt.notice = `${lens.label}${lens.year ? ` ${lens.year}` : ''} is published down to H${x}`; return x; };
  const viewRes = useView ? (st.res === 'auto' ? autoResForView() : st.res) : null;
  if (useView && viewRes == null) rt.notice = 'zoom in for hexagons';
  if (useView && viewRes != null) {
    res = fallback(viewRes);
    const bb = viewBBox();
    // estimate from the chunks that actually exist (sea and neighbours have none)
    const m = await manifest(res);
    const est = (await chunksFor(res, bb)).length * (m.n / m.parents.length);
    if (est <= cfg.hex.max_cells_view) {
      toast(`Loading H${res} hexagons…`, { spin: true });
      cs = await cellSet(res, bb, { clip: viewBBox(0.15) });
    } else rt.notice = st.sel ? 'zoom in to see all · showing selection' : `zoom in for H${res}`;
  }
  if (!cs && st.sel) {
    const u = unit(st.sel);
    res = fallback(st.res === 'auto' ? autoResForUnit(u) : st.res);
    while (res > cfg.hex.resolutions[0] && (u.h8 || 0) / 7 ** (8 - res) > cfg.hex.max_cells_selection) {
      res--; rt.notice = `${u.name} is too large for H${st.res} · showing H${res}`;
    }
    toast(`Loading H${res} hexagons for ${u.name}…`, { spin: true });
    cs = await cellSet(res, u.bbox, { filter: { field: LEVEL_FIELD[st.sel.level], id: st.sel.id } });
  }
  if (t !== cellTok) return;
  toast('');
  ctx.cs = cs;
  rt.shownRes = cs ? cs.res : null;
  rt.hexHint = cs ? `H${cs.res} · ${cs.n.toLocaleString('en-IN')} cells` : rt.notice;
  if (cs && rt.notice) rt.hexHint = `H${cs.res} · ${cs.n.toLocaleString('en-IN')} · ${rt.notice}`;
  await recolour();
}
let cellTimer;
const updateCellsSoon = (ms = 200) => { clearTimeout(cellTimer); cellTimer = setTimeout(updateCells, ms); };

// ---- colouring ------------------------------------------------------------------------------------
let colTok = 0;
let ver = 0;

function inSelMask(cs, st) {
  if (!st.sel) return null;
  const f = cs[LEVEL_FIELD[st.sel.level]];
  const m = new Uint8Array(cs.n);
  for (let i = 0; i < cs.n; i++) m[i] = f[i] === st.sel.id ? 1 : 0;
  return m;
}

function hexScale(vals, cs, lens, st, mask) {
  const ramp = rampFor(lens, st.cbSafe);
  if (st.scale === 'india') {
    const b = indiaBreaks(lens, cs.res);
    if (b) return spread(b, ramp, false);
  }
  let pool = vals;
  if (mask) { pool = []; for (let i = 0; i < vals.length; i++) if (mask[i]) pool.push(vals[i]); }
  return scaleFromValues(pool, lens, ramp) || scaleFromValues(vals, lens, ramp);
}

function fills(vals, sc, cs, st, mask) {
  const out = new Uint8Array(cs.n * 4);
  const a1 = Math.round(st.opacity * 255);
  const a0 = Math.round(st.opacity * 255 * 0.32);
  for (let i = 0; i < cs.n; i++) {
    const c = vals ? colourOf(vals[i], sc) : null;
    if (!c) { out[4 * i + 3] = 0; continue; }
    const [r, g, b] = rgba(c);
    let a = mask && !mask[i] ? a0 : a1;
    if (sc.faintFirst && vals[i] < sc.breaks[0]) a = Math.round(a * 0.3);
    out[4 * i] = r; out[4 * i + 1] = g; out[4 * i + 2] = b; out[4 * i + 3] = a;
  }
  return out;
}

function elevations(vals, sc, cs) {
  const k = { 6: 2.6, 7: 1.5, 8: 1 }[cs.res] || 1;
  const e = new Float32Array(cs.n);
  for (let i = 0; i < cs.n; i++) e[i] = Number.isFinite(vals[i]) ? 30 + position(vals[i], sc) * cfg.hex.extrude_scale * k : 0;
  return e;
}

/** Colour one view: hexes if drawn, otherwise the unit choropleth. */
async function paint(v, lens, st, { scaleFrom } = {}) {
  const cs = ctx.cs;
  const mask = cs ? inSelMask(cs, st) : null;
  const vals = cs && !lens.none ? await hexValues(cs, lens) : null;
  const uvals = !lens.none && (!vals) ? await unitValues(st.level, lens, U) : null;
  return (shared) => {
    let sc = null;
    let scopeLabel = '';
    let coverage = null;
    if (vals) {
      let fin = 0; let n = 0;
      for (let i = 0; i < cs.n; i++) if (!mask || mask[i]) { n++; if (Number.isFinite(vals[i])) fin++; }
      coverage = { fin, n };
      sc = shared || scaleFrom || hexScale(vals, cs, lens, st, mask);
      scopeLabel = st.sel ? unit(st.sel).name : 'the hexagons in view';
      v.setHexes({ cs, fill: fills(vals, sc, cs, st, mask), elev: st.threeD ? elevations(vals, sc, cs) : null, threeD: st.threeD, lines: st.hexLines, version: ++ver });
      v.setUnitColours(st.level, null);
    } else {
      v.setHexes({ cs, fill: cs && mask ? outlineFill(cs, mask) : null, elev: null, threeD: false, lines: true, version: ++ver });
      if (uvals) {
        const ramp = rampFor(lens, st.cbSafe);
        const stId = st.sel ? (st.sel.level === 'state' ? st.sel.id : unit(st.sel).st) : -1;
        const pool = U[st.level].filter((u) => st.scale === 'india' || stId < 0 || u.st === stId || st.level === 'state').map((u) => uvals[u.id]);
        sc = shared || scaleFrom || scaleFromValues(pool, lens, ramp);
        if (st.scale === 'india' && sc) sc.rel = false;
        scopeLabel = `${cfg.boundaries.levels[st.level].label}${stId >= 0 && st.level !== 'state' && st.scale !== 'india' ? ` in ${U.state[stId].name}` : ' across India'}`;
        const colours = new Map();
        if (sc) U[st.level].forEach((u) => { const c = colourOf(uvals[u.id], sc); if (c) colours.set(u.id, c); });
        v.setUnitColours(st.level, colours);
      } else v.setUnitColours(st.level, null);
    }
    return { sc, scopeLabel, coverage };
  };
}

function outlineFill(cs, mask) {
  // Outline-only mode in "everything in view": faintly shade the selected place's cells.
  const out = new Uint8Array(cs.n * 4);
  for (let i = 0; i < cs.n; i++) if (mask[i]) { out[4 * i] = 242; out[4 * i + 1] = 196; out[4 * i + 2] = 109; out[4 * i + 3] = 34; }
  return out;
}

async function recolour() {
  const t = ++colTok;
  const st = S.get();
  const lens = lensOf(st);
  const applyMain = await paint(view, lens, st);
  let applyCmp = null;
  if (ctx.cview && st.compare) {
    const c = st.compare;
    const lens2 = c.kind === 'year' ? lensOf(st, { year: +c.value }) : c.kind === 'variable' ? lensOf(st, { var: c.value, mode: 'value', density: false }) : lens;
    applyCmp = await paint(ctx.cview, lens2, st);
    rt.cmpLens = lens2;
  }
  if (t !== colTok) return;
  const { sc, scopeLabel, coverage } = applyMain();
  // comparing years: one shared scale so colours mean the same on both sides
  if (applyCmp) applyCmp(st.compare.kind === 'year' ? sc : null);
  rt.legend = { sc, lens, scopeLabel, coverage };
  updateLegend();
  renderPanel();
}

// ---- selection ------------------------------------------------------------------------------------
async function showSelection() {
  const st = S.get();
  if (!st.sel) { views().forEach((v) => v.setSelection(null, false)); return; }
  const { level, id } = st.sel;
  await ensureGeo(level);
  const f = ctx.feat[level].get(id);
  rt.selFeat = f;
  views().forEach((v) => v.setSelection(f, st.mask));
  fetch(`data/detail/${level}/${id}.json?v=${cfg.version}`).then((r) => (r.ok ? r.json() : null)).then((geom) => {
    const cur = S.get().sel;
    if (geom && cur && cur.level === level && cur.id === id) {
      rt.selFeat = { type: 'Feature', id, properties: {}, geometry: geom };
      views().forEach((v) => v.setSelection(rt.selFeat, S.get().mask));
    }
  }).catch(() => {});
}

function select(level, id, { fly = true } = {}) {
  const st = S.get();
  const patch = { sel: { level, id }, hex: null, filter: '', limit: 50, panel: 'place' };
  if (level === 'state' && st.level === 'state') patch.level = rt.drill || 'ac';
  else if (level !== 'state' && st.level !== level) patch.level = level;
  if (level === 'state') patch.tab = (patch.level || st.level) === 'state' ? 'ac' : (patch.level || st.level);
  S.set(patch);
  if (fly) fit(U[level][id].bbox);
  if (isMobile()) $('#side').classList.remove('peek');
}

function clearSelection() {
  S.set({ sel: null, hex: null, panel: 'place', filter: '' });
  fit(INDIA, { maxZoom: 5 });
}

// ---- hex info (sidebar band) -------------------------------------------------------------------------
const hexInfoCache = new Map();
async function hexInfo(h3id) {
  if (hexInfoCache.has(h3id)) return hexInfoCache.get(h3id);
  const c = await findCell(h3id);
  if (!c) return null;
  const cs = { res: c.res, n: 1, parts: [{ c: c.chunk, idx: [c.i] }], area: h3.cellArea(h3id, 'km2') };
  const [lat, lng] = h3.cellToLatLng(h3id);
  const figs = (await Promise.all(cfg.featured.map(async (id) => {
    const s = seriesById(id);
    const ys = s.res_years[String(c.res)];
    if (!ys) return null;
    const y = ys.includes(s.default_year) ? s.default_year : ys[ys.length - 1];
    const v = await hexRaw(cs, s, y);
    return { s, v: v ? v[0] : NaN, year: y };
  }))).filter(Boolean);
  const info = { ...c, area: cs.area, lat, lng, figs };
  hexInfoCache.set(h3id, info);
  return info;
}

async function goToHex(h3id) {
  const c = await findCell(h3id);
  if (!c) { toast('That hexagon is not in this dataset (H6–H8 cells inside India only)', { ttl: 4000 }); return; }
  const lvl = c.a >= 0 ? 'ac' : c.d >= 0 ? 'district' : 'state';
  const id = lvl === 'ac' ? c.a : lvl === 'district' ? c.d : c.s;
  S.set({ res: c.res });
  select(lvl, id, { fly: false });
  S.set({ hex: h3id });
  const [lat, lng] = h3.cellToLatLng(h3id);
  view.map.flyTo({ center: [lng, lat], zoom: { 6: 9.5, 7: 11.5, 8: 13.5 }[c.res] });
}

// ---- compare (swipe) --------------------------------------------------------------------------------
async function setCompare(on) {
  const mapB = $('#mapB');
  if (on && !ctx.cview) {
    mapB.hidden = false;
    const c = view.map.getCenter();
    ctx.cview = new MapView('mapB', { cfg, vs, interactive: false, view: { center: [c.lng, c.lat], zoom: view.map.getZoom(), pitch: view.map.getPitch() } });
    await ctx.cview.ready;
    for (const [level, fc] of Object.entries(ctx.geo)) ctx.cview.setBoundaryData(level, fc);
    mirror();
    view.map.on('move', syncCompare);
    $('#swipe').hidden = false;
    positionSwipe();
    recolour();
  } else if (!on && ctx.cview) {
    view.map.off('move', syncCompare);
    ctx.cview.map.remove();
    ctx.cview = null;
    mapB.hidden = true;
    $('#swipe').hidden = true;
    document.querySelectorAll('.side-tag').forEach((e) => e.remove());
  }
}
function syncCompare() {
  if (!ctx.cview) return;
  const m = view.map;
  ctx.cview.map.jumpTo({ center: m.getCenter(), zoom: m.getZoom(), bearing: m.getBearing(), pitch: m.getPitch() });
}
function positionSwipe() {
  const st = S.get();
  const pct = st.comparePos * 100;
  $('#mapB').style.clipPath = `inset(0 0 0 ${pct}%)`;
  $('#swipe').style.left = `${pct}%`;
  const bar = $('#compareBar');
  bar.style.left = `calc(${pct}% + ${(100 - pct) / 2}% )`;
  bar.style.transform = 'translateX(-50%)';
}
function mirror() {
  const cv = ctx.cview;
  if (!cv) return;
  const st = S.get();
  const bmId = st.compare?.kind === 'basemap' ? st.compare.value : st.basemap;
  cv.setBasemap(cfg.basemaps.find((b) => b.id === bmId) || cfg.basemaps[0]);
  cv.setOverlays(effectiveOverlays(st, bmId));
  cv.setLevel(st.level, st.stateLines);
  cv.setFillOpacity(st.opacity);
  cv.setLineScale(st.lineScale);
  cv.setLabels(U[st.level], cfg.boundaries.levels[st.level].label_minzoom, st.labels);
  cv.setSelection(st.sel ? rt.selFeat : null, st.mask);
  cv.setHexSelection(st.hex);
}

// ---- basemap / overlays ---------------------------------------------------------------------------
function effectiveOverlays(st, bmId) {
  const off = cfg.basemaps.find((b) => b.id === bmId)?.overlays_off || [];
  return st.overlays.filter((o) => !off.includes(o));
}

// ---- actions used by UI modules ------------------------------------------------------------------
ctx.act = {
  select, clearSelection, goToHex, hexInfo, toast,
  prefetchYear(y) {
    const st = S.get();
    if (ctx.cs) hexValues(ctx.cs, lensOf(st, { year: y })).catch(() => {});
  },
  async tool(id) {
    const st = S.get();
    const m = view.map;
    if (id === 'zin') m.zoomIn();
    else if (id === 'zout') m.zoomOut();
    else if (id === 'home') clearSelection();
    else if (id === 'full') { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.(); }
    else if (id === '3d') S.set({ threeD: !st.threeD });
    else if (id === 'compare') S.set({ compare: st.compare ? null : { kind: lensOf(st).years.length >= 2 ? 'year' : 'basemap', value: defaultCompareValue(lensOf(st).years.length >= 2 ? 'year' : 'basemap', st) } });
    else if (id === 'png') {
      toast('Preparing image…', { spin: true });
      const lens = lensOf(st);
      const place = st.sel ? unit(st.sel).name : 'India';
      await EX.png(ctx, { title: lens.none ? place : `${place}: ${lens.title}`, subtitle: `${lens.none ? 'Boundaries' : lens.unitLabel || ''}${ctx.cs ? ` · H${ctx.cs.res} hexagons` : ''} · ${new Date().toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' })}` });
      toast('');
    } else if (id === 'locate') locate();
  },
  run(action, data) {
    const st = S.get();
    if (action === 'zoom' && st.sel) fit(unit(st.sel).bbox);
    else if (action === 'copy') navigator.clipboard?.writeText(location.href).then(() => toast('Link copied', { ttl: 1800 }));
    else if (action === 'copyhex') navigator.clipboard?.writeText(st.hex).then(() => toast('H3 id copied', { ttl: 1800 }));
    else if (action === 'closehex') S.set({ hex: null });
    else if (action === 'more') S.set({ limit: 100000 });
    else if (action === 'pin' && st.sel) {
      const key = `${st.sel.level}:${st.sel.id}`;
      S.set({ pinned: st.pinned.includes(key) ? st.pinned.filter((p) => p !== key) : [...st.pinned, key].slice(-8) });
    } else if (action === 'unpin') S.set({ pinned: st.pinned.filter((p) => p !== data.pin) });
    else if (action === 'compare') S.set({ panel: 'compare' });
    else if (action === 'back') S.set({ panel: 'place' });
    else if (action === 'about') S.set({ panel: 'about' });
    else if (action === 'csv' && rt.list) {
      const { level, rows, lens } = rt.list;
      EX.csv(`${st.sel ? unit(st.sel).name : 'India'}_${level}_${lens.id}`, ['rank', 'name', 'number', 'state', 'key', `${lens.title} (${lens.unitLabel})`],
        rows.map((r, i) => [i + 1, r.u.name, r.u.no ?? '', U.state[r.u.st]?.name ?? r.u.name, r.u.key, Number.isFinite(r.v) ? r.v : '']));
    } else if (action === 'csvcompare' && rt.compareRows) {
      const { pins: ps, rows } = rt.compareRows;
      EX.csv('pinned_places', ['variable', 'year', ...ps.map((p) => unit(p).name)], rows.map((r) => [r.s.label, r.y ?? '', ...r.vals.map((v) => v ?? '')]));
    } else if (action === 'geojson') downloadHexes();
  },
};

function downloadHexes() {
  const st = S.get();
  const cs = ctx.cs;
  if (!cs || !cs.n) { toast('Turn on hexagons first', { ttl: 2500 }); return; }
  const lens = lensOf(st);
  const mask = inSelMask(cs, st);
  hexValues(cs, lens).then((vals) => {
    const feats = [];
    for (let i = 0; i < cs.n; i++) {
      if (mask && !mask[i]) continue;
      const ring = h3.cellToBoundary(cs.h[i], true); ring.push(ring[0]);
      feats.push({
        type: 'Feature',
        properties: { h3_index: cs.h[i], resolution: cs.res, state: U.state[cs.s[i]]?.key ?? null, ac: U.ac[cs.a[i]]?.key ?? null, pc: U.pc[cs.p[i]]?.key ?? null, district: U.district[cs.d[i]]?.key ?? null, ...(vals ? { [lens.id + (lens.year ? `_${lens.year}` : '') + (lens.mode === 'change' ? `_change_from_${lens.from}` : '') + (lens.density ? '_per_km2' : '')]: Number.isFinite(vals[i]) ? vals[i] : null } : {}) },
        geometry: { type: 'Polygon', coordinates: [ring] },
      });
    }
    EX.geojson(`${st.sel ? unit(st.sel).key : 'view'}_h${cs.res}`, { type: 'FeatureCollection', features: feats });
  });
}

function locate() {
  if (!navigator.geolocation) { toast('Location is not available in this browser', { ttl: 3000 }); return; }
  toast('Finding you…', { spin: true });
  navigator.geolocation.getCurrentPosition(async (p) => {
    const { latitude: lat, longitude: lng } = p.coords;
    const c = await findCell(h3.latLngToCell(lat, lng, 8));
    if (!c) { toast('You seem to be outside India', { ttl: 3000 }); return; }
    const lvl = c.a >= 0 ? 'ac' : 'district';
    const id = lvl === 'ac' ? c.a : c.d;
    toast(`You are in ${U[lvl][id].name}`, { ttl: 4000 });
    select(lvl, id);
  }, () => toast('Location permission was denied', { ttl: 3000 }), { enableHighAccuracy: true, timeout: 10000 });
}

// ---- map interaction ------------------------------------------------------------------------------
let hoverUnit = null;
function wireMap() {
  const tip = $('#tip');
  const m = view.map;
  m.on('mousemove', (e) => {
    const st = S.get();
    const p = view.pick(e.point, st.level);
    if (hoverUnit !== p.unit) { view.setUnitHover(st.level, hoverUnit, false); hoverUnit = p.unit; view.setUnitHover(st.level, hoverUnit, true); }
    m.getCanvas().style.cursor = p.hex != null || p.unit != null ? 'pointer' : '';
    if (p.hex == null && p.unit == null) { tip.hidden = true; return; }
    const lens = lensOf(st);
    let html = '';
    if (p.unit != null) {
      const u = U[st.level][p.unit];
      html += `<div class="t1">${u.name}</div><div class="t2">${cfg.boundaries.levels[st.level].one}${u.no != null ? ` ${u.no}` : ''}${st.level !== 'state' ? ` · ${U.state[u.st]?.name}` : ''}</div>`;
    }
    if (p.hex != null && ctx.cs) {
      html += `<div class="t2" style="margin-top:3px">H${ctx.cs.res} · ${ctx.cs.h[p.hex]}</div>`;
      if (!lens.none) html += hexTipValue(p.hex, lens);
    } else if (p.unit != null && !lens.none) {
      unitValues(st.level, lens, U).then((vals) => {
        if (hoverUnit === p.unit && vals) {
          const extra = `<div class="t3"><b>${fmtValue(vals[p.unit], lens)}</b> ${lens.unitLabel}</div>`;
          if (!tip.innerHTML.includes('t3')) tip.innerHTML += extra;
        }
      });
    }
    tip.innerHTML = html;
    tip.hidden = false;
    const r = m.getContainer().getBoundingClientRect();
    tip.style.left = `${Math.min(e.point.x + 14, r.width - tip.offsetWidth - 8)}px`;
    tip.style.top = `${Math.min(e.point.y + 14, r.height - tip.offsetHeight - 8)}px`;
  });
  m.getCanvas().addEventListener('mouseleave', () => { tip.hidden = true; view.setUnitHover(S.get().level, hoverUnit, false); hoverUnit = null; });

  m.on('click', (e) => {
    const st = S.get();
    const p = view.pick(e.point, st.level);
    const inSel = p.hex != null && ctx.cs && (!st.sel || ctx.cs[LEVEL_FIELD[st.sel.level]][p.hex] === st.sel.id);
    if (p.hex != null && inSel) { S.set({ hex: ctx.cs.h[p.hex] }); if (isMobile()) $('#side').classList.remove('peek'); return; }
    if (p.unit != null) {
      if (st.sel && st.sel.level === st.level && st.sel.id === p.unit) { if (st.hex) S.set({ hex: null }); return; }
      select(st.level, p.unit);
    }
  });

  m.on('moveend', () => {
    const st = S.get();
    if (st.res !== 'off' && (st.scope === 'view' || !st.sel)) updateCellsSoon(250);
    if (!st.sel) S.set({ view: [+m.getZoom().toFixed(2), +m.getCenter().lat.toFixed(4), +m.getCenter().lng.toFixed(4)] });
  });

  // swipe handle
  const grip = $('#swipe .swipe-grip');
  let dragging = false;
  const move = (x) => {
    const r = $('#stage').getBoundingClientRect();
    S.set({ comparePos: Math.min(0.95, Math.max(0.05, (x - r.left) / r.width)) });
  };
  grip.addEventListener('pointerdown', (e) => { dragging = true; grip.setPointerCapture(e.pointerId); });
  grip.addEventListener('pointermove', (e) => { if (dragging) move(e.clientX); });
  grip.addEventListener('pointerup', () => { dragging = false; });
}

// value cache for hex tooltips (main lens values of the current cells)
let tipVals = null;
function hexTipValue(i, lens) {
  if (!tipVals || tipVals.cs !== ctx.cs || tipVals.key !== JSON.stringify([lens.id, lens.year, lens.mode, lens.from, lens.density])) {
    tipVals = { cs: ctx.cs, key: JSON.stringify([lens.id, lens.year, lens.mode, lens.from, lens.density]), vals: null };
    hexValues(ctx.cs, lens).then((v) => { if (tipVals) tipVals.vals = v; });
  }
  const v = tipVals.vals ? tipVals.vals[i] : null;
  return v == null ? '' : `<div class="t3"><b>${fmtValue(v, lens)}</b> ${lens.unitLabel}</div>`;
}

// ---- menu ------------------------------------------------------------------------------------------
function wireMenu() {
  const menu = $('#menu');
  const items = [
    ['about', 'About'],
    ...(cfg.site.github ? [['github', 'Source on GitHub']] : []),
    ['theme', 'Switch light / dark'],
    ['copy', 'Copy link to this view'],
    ['reset', 'Reset everything'],
  ];
  menu.innerHTML = items.map(([id, l]) => (id === 'github' ? `<a href="${cfg.site.github}" target="_blank" rel="noopener">${l}</a>` : `<button data-m="${id}">${l}</button>`)).join('');
  $('#menuBtn').onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
  document.addEventListener('click', () => { menu.hidden = true; });
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-m]');
    if (!b) return;
    const id = b.dataset.m;
    if (id === 'about') S.set({ panel: 'about' });
    if (id === 'theme') S.set({ theme: S.get().theme === 'dark' ? 'light' : 'dark' });
    if (id === 'copy') ctx.act.run('copy');
    if (id === 'reset') { location.hash = ''; location.reload(); }
  });
  $('#home').onclick = (e) => { e.preventDefault(); clearSelection(); };
  // mobile sheet: tap the handle to cycle peek -> half -> full
  $('#sheetHandle').onclick = () => {
    const s = $('#side');
    if (s.classList.contains('peek')) s.classList.remove('peek');
    else if (s.classList.contains('full')) { s.classList.remove('full'); s.classList.add('peek'); }
    else s.classList.add('full');
  };
}

// ---- subscriptions (registered once the map and UI exist) -----------------------------------------
function subscribe() {
S.on(['theme'], (st) => {
  document.documentElement.dataset.theme = st.theme;
  document.querySelector('meta[name=theme-color]').content = st.theme === 'dark' ? '#131417' : '#f5f3ee';
  try { localStorage.setItem('indiahex.theme', st.theme); } catch { /* ignore */ }
});
S.on(['basemap'], (st, prev) => {
  const bm = cfg.basemaps.find((b) => b.id === st.basemap) || cfg.basemaps[0];
  view.setBasemap(bm);
  // overlays a basemap already draws are switched off; coming back to imagery restores the defaults
  if (bm.overlays_off?.length) S.set({ overlays: st.overlays.filter((o) => !bm.overlays_off.includes(o)) });
  else if (!st.overlays.length && cfg.basemaps.find((b) => b.id === prev.basemap)?.overlays_off?.length) S.set({ overlays: D.overlays || [] });
  view.setOverlays(effectiveOverlays(S.get(), st.basemap));
  mirror();
  recolour();
});
S.on(['overlays'], (st) => { view.setOverlays(effectiveOverlays(st, st.basemap)); mirror(); });
S.on(['level', 'stateLines', 'labels'], async (st, prev, changed) => {
  if (st.level !== 'state') rt.drill = st.level;
  views().forEach((v) => {
    v.setLevel(st.level, st.stateLines);
    v.setLabels(U[st.level], cfg.boundaries.levels[st.level].label_minzoom, st.labels);
  });
  if (!ctx.geo[st.level]) { toast('Loading boundaries…', { spin: true }); await ensureGeo(st.level); toast(''); }
  if (changed.has('level')) { views().forEach((v) => v.setUnitColours(prev.level, null)); recolour(); }
});
S.on(['sel'], () => { showSelection(); mirror(); });
S.on(['mask'], (st) => views().forEach((v) => v.setSelection(st.sel ? rt.selFeat : null, st.mask)));
S.on(['hex'], (st) => views().forEach((v) => v.setHexSelection(st.hex)));
S.on(['res', 'scope', 'sel'], () => updateCellsSoon(st0Ready ? 50 : 0));
S.on(['var', 'year', 'mode', 'from', 'density', 'scale', 'cbSafe', 'hexLines', 'threeD', 'opacity'], (st) => {
  const lens = lensOf(st);
  if (ctx.cs && !lens.none && !resAvailable(lens, ctx.cs.res)) updateCellsSoon(0);
  else recolour();
});
S.on(['opacity'], (st) => views().forEach((v) => v.setFillOpacity(st.opacity)));
S.on(['lineScale'], (st) => views().forEach((v) => v.setLineScale(st.lineScale)));
S.on(['threeD'], (st) => {
  view.map.dragRotate[st.threeD ? 'enable' : 'disable']();
  view.map.easeTo({ pitch: st.threeD ? 52 : 0, bearing: st.threeD ? -12 : 0, duration: 900 });
});
S.on(['compare'], async (st, prev) => {
  if (!!st.compare !== !!prev.compare) await setCompare(!!st.compare);
  else { mirror(); recolour(); }
});
S.on(['comparePos'], positionSwipe);
S.on(['pinned'], (st) => { try { localStorage.setItem('indiahex.pins', JSON.stringify(st.pinned)); } catch { /* ignore */ } });
S.on(['sel', 'hex', 'panel', 'tab', 'filter', 'limit', 'pinned', 'level'], () => renderPanel());
S.on(null, (st) => writeHash({ ...st, sel: st.sel ? { level: st.sel.level, key: unit(st.sel).key } : null, view: st.sel ? null : st.view }, DEFAULTS));
}

// ---- start --------------------------------------------------------------------------------------------
await view.ready;
document.documentElement.dataset.theme = S.get().theme;
const st0 = S.get();
view.setBasemap(cfg.basemaps.find((b) => b.id === st0.basemap) || cfg.basemaps[0]);
view.setOverlays(effectiveOverlays(st0, st0.basemap));
view.setFillOpacity(st0.opacity);
await ensureGeo('state');
await ensureGeo(st0.level);
view.setLevel(st0.level, st0.stateLines);
view.setLabels(U[st0.level], cfg.boundaries.levels[st0.level].label_minzoom, st0.labels);
initPanel(ctx);
initControls(ctx);
initSearch(ctx);
wireMap();
wireMenu();
subscribe();
if (st0.sel) { showSelection(); if (!hash.view) fit(U[st0.sel.level][st0.sel.id].bbox, { duration: 0 }); }
if (st0.compare) await setCompare(true);
if (st0.threeD) { view.map.dragRotate.enable(); view.map.setPitch(52); }
st0Ready = true;
renderPanel(); // sidebar first; hexagons follow
await updateCells();
if (hash.hex && h3.isValidCell(hash.hex)) S.set({ hex: hash.hex });
renderLens();
renderTimeline();
// warm the other boundary layers once the first view is done, so they don't compete with it
const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1));
setTimeout(() => idle(() => ['district', 'pc', 'ac'].forEach((l, i) => setTimeout(() => ensureGeo(l), i * 1500))), 6000);
