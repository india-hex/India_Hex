/* global maplibregl */
// India Hex · Elections: each polling location's actual catchment, drawn when a booth pin or catchment
// is selected, and the split of a single 100 m cell between polling locations.
//
// The catchment polygons give every 100 m cell wholly to one location (a simplification). In the
// model a cell's electors are split between several locations; per election and AC the build copies
// that split into data/booths/<election>/split/ac_NNN.{cells,split}.bin.gz (format v2, gzip):
//   cells  int32 row0, int32 col0, uint32 n; uint16[n] row-row0; uint16[n] col-col0;
//          float32[n] electors with a polling location; uint16[n] kept share * 65535
//   split  uint32 m; m x (uint16 loc, uint32 count), loc ascending; per location `count` cell indices as
//          zigzag-varint deltas (first absolute); uint16 share * 65535 per row; float32[m] exact electors
// Cells are the GHSL 100 m Mollweide grid (sphere R = 6378137): x = -18041000 + 100 col (west edge),
// y = 9000000 - 100 row (north edge).
//
// This module only uses what the app exposes (window.indiaHex: store, map view, actions), so the main
// site's files are untouched.
import { electionById, detailFor } from '../booths.js';
import { RAMPS, esc } from '../scales.js';

const R = 6378137;
const SQ2 = Math.SQRT2;
const D = 180 / Math.PI;
const MIN_SHARE = 0.002;
const SPLIT_ZOOM = 14; // from this zoom, with catchments on, a click on a populated cell shows its split
const KEEP = 4; // decoded ACs kept in memory

// ---- wait for the app ----------------------------------------------------------------------------
async function appReady() {
  for (;;) {
    const a = window.indiaHex;
    if (a && a.ctx && a.ctx.act && a.ctx.act.selectBooth && a.view && a.view.map && a.view.map.getLayer('mask-fill')) return a;
    await new Promise((r) => setTimeout(r, 100));
  }
}

// ---- geometry: GHSL Mollweide grid <-> lon/lat ----------------------------------------------------
/** [lon, lat] in degrees of the grid corner at (row, col) (north-west corner of that cell). */
export function corner(row, col) {
  const x = -18041000 + 100 * col;
  const y = 9000000 - 100 * row;
  const th = Math.asin(y / (SQ2 * R));
  const lat = Math.asin((2 * th + Math.sin(2 * th)) / Math.PI);
  const lon = (Math.PI * x) / (2 * SQ2 * R * Math.cos(th));
  return [lon * D, lat * D];
}

/** The cell's polygon: its four corners (north-west, north-east, south-east, south-west). */
export function cellRing(row, col) {
  const a = corner(row, col);
  return [a, corner(row, col + 1), corner(row + 1, col + 1), corner(row + 1, col), a];
}

/** (row, col) of the 100 m cell holding a lon/lat (forward Mollweide, Newton on 2θ + sin 2θ = π sin φ). */
export function cellOf(lon, lat) {
  const phi = lat / D;
  let th = phi;
  for (let i = 0; i < 30; i++) {
    const f = 2 * th + Math.sin(2 * th) - Math.PI * Math.sin(phi);
    const d = f / (2 + 2 * Math.cos(2 * th));
    th -= d;
    if (Math.abs(d) < 1e-13) break;
  }
  const x = ((2 * SQ2) / Math.PI) * R * (lon / D) * Math.cos(th);
  const y = SQ2 * R * Math.sin(th);
  return [Math.floor((9000000 - y) / 100), Math.floor((x + 18041000) / 100)];
}

// ---- data: fetch, gunzip, decode -----------------------------------------------------------------
async function gunzip(buf) {
  const u = new Uint8Array(buf, 0, 2);
  if (u[0] !== 0x1f || u[1] !== 0x8b) return buf; // a server that already decoded it
  return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

export function decodeCells(buf) {
  const dv = new DataView(buf);
  const n = dv.getUint32(8, true);
  return {
    row0: dv.getInt32(0, true), col0: dv.getInt32(4, true), n,
    dr: new Uint16Array(buf, 12, n), dc: new Uint16Array(buf, 12 + 2 * n, n),
    electors: new Float32Array(buf, 12 + 4 * n, n), kept: new Uint16Array(buf, 12 + 8 * n, n),
  };
}

export function decodeSplit(buf) {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const m = dv.getUint32(0, true);
  const locs = new Uint16Array(m);
  const start = new Uint32Array(m + 1);
  let p = 4;
  for (let i = 0; i < m; i++) {
    locs[i] = dv.getUint16(p, true);
    start[i + 1] = start[i] + dv.getUint32(p + 2, true);
    p += 6;
  }
  const N = start[m];
  const pix = new Int32Array(N);
  for (let i = 0, k = 0; i < m; i++) {
    let acc = 0;
    for (let j = start[i]; j < start[i + 1]; j++) {
      let v = 0; let mul = 1; let b;
      do { b = u8[p++]; v += (b & 0x7f) * mul; mul *= 128; } while (b & 0x80);
      const d = v % 2 === 0 ? v / 2 : -(v + 1) / 2; // zigzag
      acc = j === start[i] ? d : acc + d;
      pix[k++] = acc;
    }
  }
  const share = new Uint16Array(buf.slice(p, p + 2 * N));
  const total = new Float32Array(buf.slice(p + 2 * N, p + 2 * N + 4 * m));
  const index = new Map();
  locs.forEach((l, i) => index.set(l, i));
  return { m, locs, start, pix, share, total, index };
}

const acCache = new Map(); // `${el}/${ac}` -> Promise<{cells, split, ms}>
const pad3 = (n) => String(n).padStart(3, '0');

/** One AC's cells and split, decoded (null when the AC has none). Timings in `ms`. */
export function acData(el, ac) {
  const key = `${el.id}/${ac}`;
  if (acCache.has(key)) { const v = acCache.get(key); acCache.delete(key); acCache.set(key, v); return v; }
  const url = (k) => `data/booths/${el.id}/split/ac_${pad3(ac)}.${k}.bin.gz?v=${el.v}`;
  const t0 = performance.now();
  const p = Promise.all([fetch(url('cells')), fetch(url('split'))]).then(async ([a, b]) => {
    if (!a.ok || !b.ok) return null;
    const [ca, sa] = await Promise.all([a.arrayBuffer().then(gunzip), b.arrayBuffer().then(gunzip)]);
    const t1 = performance.now();
    const out = { cells: decodeCells(ca), split: decodeSplit(sa) };
    out.ms = { fetch: t1 - t0, decode: performance.now() - t1 };
    return out;
  }).catch(() => null);
  acCache.set(key, p);
  while (acCache.size > KEEP) acCache.delete(acCache.keys().next().value);
  return p;
}

/** Local index of the cell (row, col) in an AC's cells (sorted by row, then column), or -1. */
export function cellIndex(cells, row, col) {
  const dr = row - cells.row0; const dc = col - cells.col0;
  if (dr < 0 || dc < 0 || dr > 65535 || dc > 65535) return -1;
  const key = dr * 65536 + dc;
  let lo = 0; let hi = cells.n - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const k = cells.dr[mid] * 65536 + cells.dc[mid];
    if (k === key) return mid;
    if (k < key) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}

/** Per cell, the rows (locations and shares) that split it: built once per AC, on demand. */
export function byCell(d) {
  if (d.byCell) return d.byCell;
  const { pix, start, m } = d.split;
  const n = d.cells.n;
  const head = new Uint32Array(n + 1);
  for (let k = 0; k < pix.length; k++) head[pix[k] + 1]++;
  for (let c = 0; c < n; c++) head[c + 1] += head[c];
  const fill = head.slice(0, n);
  const row = new Uint32Array(pix.length);
  const owner = new Uint32Array(pix.length);
  for (let i = 0; i < m; i++) {
    for (let k = start[i]; k < start[i + 1]; k++) { const j = fill[pix[k]]++; row[j] = k; owner[j] = i; }
  }
  d.byCell = { head, row, owner };
  return d.byCell;
}

/** Everything the map, card and legend need for one location (null when it has no rows). */
export function footprintOf(d, loc) {
  const i = d.split.index.get(loc);
  if (i == null) return null;
  const { start, pix, share, total } = d.split;
  const { dr, dc, row0, col0, electors } = d.cells;
  const feats = [];
  let maxS = 0; let maxE = 0; let drawn = 0;
  for (let k = start[i]; k < start[i + 1]; k++) {
    const c = pix[k];
    const s = share[k] / 65535;
    const ce = electors[c];
    const e = s * ce;
    drawn += e;
    if (s > maxS) maxS = s;
    if (e > maxE) maxE = e;
    feats.push({ type: 'Feature', id: k, properties: { s, e, ce }, geometry: { type: 'Polygon', coordinates: [cellRing(row0 + dr[c], col0 + dc[c])] } });
  }
  return { i, loc, cells: start[i + 1] - start[i], maxS, maxE, drawn, exact: total[i], fc: { type: 'FeatureCollection', features: feats } };
}

// ---- the app -------------------------------------------------------------------------------------
const { S, view, ctx } = await appReady();
const map = view.map;
const EMPTY = { type: 'FeatureCollection', features: [] };
const VIR = RAMPS.viridis;
let fp = null; // shown footprint: {el, ac, loc, f, label}
let mode = 'share'; // colour by the cell's share, or by the electors it sends here
let tok = 0;

function addLayers() {
  if (map.getSource('fp')) return;
  map.addSource('fp', { type: 'geojson', data: EMPTY, tolerance: 0.05 });
  map.addSource('fp-cell', { type: 'geojson', data: EMPTY });
  // above hexagons and catchments, below the mask, boundary lines and pins
  map.addLayer({ id: 'fp-fill', type: 'fill', source: 'fp', paint: { 'fill-color': VIR[4], 'fill-opacity': 0.85 } }, 'mask-fill');
  map.addLayer({ id: 'fp-line', type: 'line', source: 'fp', minzoom: 14, paint: { 'line-color': 'rgba(255,255,255,0.22)', 'line-width': 0.5 } }, 'mask-fill');
  map.addLayer({ id: 'fp-cell', type: 'line', source: 'fp-cell', paint: { 'line-color': '#ffffff', 'line-width': 2.2 } }, 'mask-fill');
}

/** The location's simplified outline (its catchment polygon pieces), dashed, above the footprint. */
function outline(el, loc) {
  const src = `bt-${el.id}-catchments`;
  if (map.getLayer('fp-outline') && map.getLayer('fp-outline').source === src && loc != null) {
    map.setFilter('fp-outline', ['==', ['get', 'loc'], loc]);
    return;
  }
  if (map.getLayer('fp-outline')) map.removeLayer('fp-outline');
  if (!map.getSource(src) || loc == null) return;
  map.addLayer({
    id: 'fp-outline', type: 'line', source: src, 'source-layer': 'catchments', filter: ['==', ['get', 'loc'], loc],
    paint: { 'line-color': '#ffffff', 'line-width': 1.6, 'line-dasharray': [2, 1.5], 'line-opacity': 0.95 },
  }, 'mask-fill');
}

function paint() {
  if (!fp?.f) return;
  const key = mode === 'share' ? 's' : 'e';
  const max = (mode === 'share' ? fp.f.maxS : fp.f.maxE) || 1;
  const t = ['/', ['get', key], max];
  const ramp = ['interpolate', ['linear'], t];
  VIR.forEach((c, i) => ramp.push(i / (VIR.length - 1), c));
  map.setPaintProperty('fp-fill', 'fill-color', ramp);
  map.setPaintProperty('fp-fill', 'fill-opacity', ['interpolate', ['linear'], t, 0, 0.6, 1, 0.92]);
}

function clear() {
  fp = null;
  if (map.getSource('fp')) map.getSource('fp').setData(EMPTY);
  if (map.getLayer('fp-outline')) map.removeLayer('fp-outline');
  legend();
}

/** The selected booth's or location's footprint (its election must have split files). */
async function update() {
  const t = ++tok;
  const b = S.get().booth;
  const el = b ? electionById(b.el) : null;
  if (!b || !el || !el.split) { clear(); return; }
  let loc = b.k === 'c' ? b.id : null;
  const det = await detailFor(el, b.ac);
  if (b.k === 'b') loc = det?.booth.get(b.id)?.loc ?? null;
  if (loc == null) { if (t === tok) clear(); return; }
  const d = await acData(el, b.ac);
  if (t !== tok) return;
  addLayers();
  const f = d ? footprintOf(d, loc) : null;
  const row = det?.loc.get(loc);
  fp = { el, ac: b.ac, loc, f, d, label: row ? `booth${String(row.booths).includes(' ') ? 's' : ''} ${String(row.booths).split(' ').join(', ')}` : `location ${loc}`, ms: d?.ms };
  map.getSource('fp').setData(f ? f.fc : EMPTY);
  outline(el, loc);
  paint();
  visible();
  legend();
  injectCard();
}

/** Shown only while the map's booth layers are of the footprint's election. */
function visible() {
  const on = !!fp && ctx.rt.booth?.el?.id === fp.el.id;
  for (const id of ['fp-fill', 'fp-line', 'fp-outline']) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  const lg = document.getElementById('fpLegend');
  if (lg) lg.hidden = !on;
}

const pct = (x, d = 1) => `${(x * 100).toFixed(x * 100 < 10 ? d : 0)}%`;
const num = (x) => Math.round(x).toLocaleString('en-IN');
const FP_NOTE = 'Actual model assignment: each cell gives this share of its electors to this location. The outline is a simplified drawing.';

function legend() {
  let el = document.getElementById('fpLegend');
  if (!el) {
    el = document.createElement('div');
    el.id = 'fpLegend';
    el.className = 'legend fp-legend';
    document.getElementById('legend').after(el);
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-fpmode]');
      if (btn) { mode = btn.dataset.fpmode; paint(); legend(); }
    });
  }
  if (!fp) { el.hidden = true; el.innerHTML = ''; return; }
  if (!fp.f) {
    el.innerHTML = `<div class="fp-head"><b>Actual catchment</b> · ${esc(fp.label)}</div><div class="lcaveat">No split data for this location (no electors assigned to it in the model).</div>`;
    visible();
    return;
  }
  const f = fp.f;
  const max = mode === 'share' ? pct(f.maxS) : `${num(f.maxE)}`;
  el.innerHTML = `<div class="fp-head"><b>Actual catchment</b> · ${esc(fp.label)} · ${esc(fp.el.state_name)} ${esc(fp.el.label)}</div>
    <div class="fp-ramp" style="background:linear-gradient(90deg,${VIR.join(',')})"></div>
    <div class="fp-ticks"><span>0</span><span>${mode === 'share' ? 'share of each cell’s electors' : 'electors from each cell'}</span><span>${max}</span></div>
    <div class="fp-mode"><button data-fpmode="share" class="${mode === 'share' ? 'on' : ''}">Share of cell</button><button data-fpmode="electors" class="${mode === 'electors' ? 'on' : ''}">Electors from cell</button></div>
    <div class="lcaveat">${FP_NOTE} ${num(f.cells)} cells; scale 0 to this location's largest value.</div>`;
  visible();
}

/** The footprint lines in the booth / location card (re-added whenever the sidebar re-renders). */
function injectCard() {
  const band = document.querySelector('#sec-band .boothband');
  if (!band || !fp || band.querySelector('.fpblock')) return;
  const b = S.get().booth;
  if (!b || b.el !== fp.el.id || b.ac !== fp.ac) return;
  const div = document.createElement('div');
  div.className = 'fpblock';
  if (!fp.f) {
    div.innerHTML = '<div class="lab">Actual catchment (model)</div><p class="note">No electors are assigned to this location in the model, so it has no footprint.</p>';
  } else {
    const f = fp.f;
    const inDrawn = f.exact > 0 ? f.drawn / f.exact : 1;
    div.innerHTML = `<div class="lab">Actual catchment (model)</div>
      <p class="fp-text">${FP_NOTE}</p>
      <div class="kvs"><span>Cells <b>${num(f.cells)}</b></span><span>Electors <b>${num(f.exact)}</b></span>
        <span>In the drawn cells <b>${(Math.floor(inDrawn * 1000) / 10).toFixed(1)}%</b></span><span>Largest share <b>${pct(f.maxS)}</b></span></div>
      ${inDrawn < 0.99 ? `<p class="note">The rest come in shares under ${pct(MIN_SHARE)} from many cells (not drawn).</p>` : ''}`;
  }
  const anchor = band.querySelector('.bres') || band.querySelector('.meta');
  if (anchor) anchor.after(div); else band.append(div);
}

// ---- hover: a footprint cell's numbers --------------------------------------------------------------
const tip = document.getElementById('tip');
map.on('mousemove', (e) => {
  if (!fp?.f || !map.getLayer('fp-fill') || map.getLayoutProperty('fp-fill', 'visibility') === 'none' || S.get().measuring) return;
  if (view.pickBooth(e.point).pin) return; // a pin keeps its own tooltip
  const c = map.queryRenderedFeatures(e.point, { layers: ['fp-fill'] })[0];
  if (!c) return;
  const { s, e: el, ce } = c.properties;
  tip.innerHTML = `<div class="t1">${pct(s)} of this cell's electors</div><div class="t2">${num(el)} electors to ${esc(fp.label)} · the cell has ${num(ce)}</div><div class="t2">Click for how the cell is split</div>`;
  tip.hidden = false;
  const r = map.getContainer().getBoundingClientRect();
  tip.style.left = `${Math.min(e.point.x + 14, r.width - tip.offsetWidth - 8)}px`;
  tip.style.top = `${Math.min(e.point.y + 14, r.height - tip.offsetHeight - 8)}px`;
  map.getCanvas().style.cursor = 'pointer';
});

// ---- the split of one cell: clicks inside a footprint, or on any populated cell from zoom 14 -----------
let popup = null;
function closeSplit() {
  if (popup) { const p = popup; popup = null; p.remove(); }
  if (map.getSource('fp-cell')) map.getSource('fp-cell').setData(EMPTY);
  if (map.getLayer('fp-pinhl')) map.removeLayer('fp-pinhl');
}

const NEUTRAL = '#7c9cbf';
async function openSplit(el, ac, lngLat) {
  closeSplit();
  addLayers();
  const [row, col] = cellOf(lngLat.lng, lngLat.lat);
  const [d, det] = await Promise.all([acData(el, ac), detailFor(el, ac)]);
  const ix = d ? cellIndex(d.cells, row, col) : -1;
  map.getSource('fp-cell').setData({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [cellRing(row, col)] } });
  let html;
  let locs = [];
  if (ix < 0) {
    html = '<div class="fp-split"><div class="t1">This 100 m cell</div><p class="note">No electors of this AC live here in the model (empty land, or the cell lies in a neighbouring AC).</p></div>';
  } else {
    const bc = byCell(d);
    const rows = [];
    for (let j = bc.head[ix]; j < bc.head[ix + 1]; j++) rows.push({ i: bc.owner[j], s: d.split.share[bc.row[j]] / 65535 });
    rows.sort((a, b) => b.s - a.s);
    locs = rows.map((r) => d.split.locs[r.i]);
    const ce = d.cells.electors[ix];
    const kept = d.cells.kept[ix] / 65535;
    const name = (loc) => { const r = det?.loc.get(loc); return r ? `Booth${String(r.booths).includes(' ') ? 's' : ''} ${String(r.booths).split(' ').join(', ')}` : `Location ${loc}`; };
    html = `<div class="fp-split"><div class="t1">This 100 m cell</div>
      <div class="t2">${num(ce)} electors, shared by ${rows.length} polling location${rows.length === 1 ? '' : 's'}${fp && fp.el.id === el.id ? '' : ` · ${esc(el.state_name)} ${esc(el.label)}`}</div>
      <div class="fp-rows">${rows.map((r) => {
    const loc = d.split.locs[r.i];
    return `<button class="fp-row${fp && fp.loc === loc ? ' on' : ''}" data-loc="${loc}" title="Show this location's footprint"><span class="nm">${esc(name(loc))}</span><span class="br"><i style="width:${Math.max(2, r.s * 100)}%;background:${NEUTRAL}"></i></span><span class="pc">${pct(r.s)}</span></button>`;
  }).join('')}</div>
      <p class="note">${pct(kept)} of the cell's electors are in these rows; shares under ${pct(MIN_SHARE)} are not stored. Click a location for its footprint.</p></div>`;
  }
  // open it where it fits: above the cell, else below, else beside it (clear of the lens bar on top)
  const make = (anchor) => new maplibregl.Popup({ closeButton: true, maxWidth: '320px', className: 'fp-popup', focusAfterOpen: false, anchor, offset: 10 })
    .setLngLat(lngLat).setHTML(html).addTo(map);
  popup = make('bottom');
  const r = box.getBoundingClientRect();
  const top = Math.max(0, document.getElementById('lensbar').getBoundingClientRect().bottom - r.top) + 8;
  const h = popup.getElement().offsetHeight;
  const q = map.project(lngLat);
  if (q.y - h - 12 < top) {
    const side = q.x > r.width * 0.55 ? 'right' : 'left';   // beside it, growing away from the nearer edge
    const anchor = q.y + h + 12 < r.height - 48 ? 'top' : `${q.y > r.height / 2 ? 'bottom' : 'top'}-${side}`;
    const p0 = popup; popup = null; p0.remove();
    popup = make(anchor);
  }
  popup.on('close', () => { if (popup) { popup = null; closeSplit(); } });
  popup.getElement().addEventListener('click', (e) => {
    const btn = e.target.closest('[data-loc]');
    if (btn) { ctx.act.selectBooth(el.id, 'c', +btn.dataset.loc, ac); closeSplit(); }
  });
  // ring the pins of every location sharing the cell
  const src = `bt-${el.id}-booths`;
  if (locs.length && map.getSource(src)) {
    map.addLayer({
      id: 'fp-pinhl', type: 'circle', source: src, 'source-layer': 'booths', filter: ['in', ['get', 'loc'], ['literal', locs]],
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 5, 14, 8, 17, 12], 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#7dd3fc', 'circle-stroke-width': 2.4 },
    }, 'unit-labels');
  }
}

// Clicks are taken before the map's own handler (capture), only where the split applies; pins, drags
// and everything else go on to the app as before.
const box = map.getContainer();
let down = null;
box.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; }, true);
box.addEventListener('click', (e) => {
  if (!(e.target instanceof HTMLCanvasElement) || S.get().measuring) return;
  if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
  const r = box.getBoundingClientRect();
  const pt = { x: e.clientX - r.left, y: e.clientY - r.top };
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  if (view.pickBooth(pt, coarse).pin) return;
  const shown = fp?.f && map.getLayer('fp-fill') && map.getLayoutProperty('fp-fill', 'visibility') !== 'none';
  const inFp = shown && map.queryRenderedFeatures(pt, { layers: ['fp-fill'] }).length > 0;
  const bv = ctx.rt.booth;
  let el = null; let ac = null;
  if (inFp) { el = fp.el; ac = fp.ac; } else if (bv && bv.catchMode !== 'off' && bv.el.split && map.getZoom() >= SPLIT_ZOOM && map.getLayer('catch-fill')) {
    const c = map.queryRenderedFeatures(pt, { layers: ['catch-fill'] })[0];
    if (c && c.properties.pop === 1) { el = bv.el; ac = c.properties.ac_no; }
  }
  if (!el) return;
  e.stopPropagation();
  e.preventDefault();
  openSplit(el, ac, map.unproject([pt.x, pt.y]));
}, true);

// ---- hooks: selection, booth layers, the sidebar ------------------------------------------------------
S.on(['booth'], () => { closeSplit(); update(); });
const setBooths = view.setBooths.bind(view);
view.setBooths = (b) => { setBooths(b); visible(); }; // footprint only with its own election's booth layers

function aboutNote() {
  const panel = document.getElementById('panel');
  if (!panel.querySelector('.steps') || panel.querySelector('.fp-about')) return;
  const p = document.createElement('p');
  p.className = 'note fp-about';
  p.textContent = 'Actual catchments: click a booth pin or a catchment to see where its voters live in the model. Every 100 m cell is shaded by the share of its electors that the model assigns to that polling location; most cells are split between several locations, while the catchment outlines draw each cell with one location only (a simplification). From zoom 14, with catchments on, click any cell to see how its electors are split. Shares under 0.2% of a cell are not stored.';
  const notes = panel.querySelectorAll('.note');
  (notes[notes.length - 2] || panel.lastElementChild).after(p);
}
new MutationObserver(() => { injectCard(); aboutNote(); }).observe(document.getElementById('panel'), { childList: true, subtree: true });

// The picker opens on the Elections tree (once per visit; the user's own opening and closing then stick).
let treeOpened = false;
new MutationObserver(() => {
  if (treeOpened) return;
  const root = document.querySelector('#pickerList details[data-node="Elections"]');
  if (!root) return;
  treeOpened = true;
  root.open = true;
  root.querySelectorAll(':scope > details.t2').forEach((d) => { d.open = true; });
}).observe(document.getElementById('pickerList'), { childList: true });

addLayers(); // empty until a footprint is shown: the first click then only loads data
// Landing (no variable, no link to a place, desktop): open the picker on the Elections tree.
if (S.get().var === 'none' && !S.get().sel && !location.hash && !window.matchMedia('(max-width: 820px)').matches) {
  setTimeout(() => { if (S.get().var === 'none') document.getElementById('varBtn')?.click(); }, 400);
}
if (S.get().booth) update();
// test hook (tools/): the decoder, geometry and the footprint in view
window.indiaHexElections = { acData, footprintOf, decodeCells, decodeSplit, corner, cellRing, cellOf, cellIndex, byCell, state: () => fp };
