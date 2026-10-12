// Map chrome: the Layers panel (boundaries, hexagons, variable, mode, legend, display options),
// the toolbar, basemap/overlay strip, the year timeline and the compare bar.
// Everything is generated from config.json and reflects store state; edits go to the store.
import { esc, legendNum } from '../scales.js';
import { lensOf, allSeries, seriesById } from '../lens.js';

let CTX = null;
let pickerOpen = false;
let pickerQuery = '';
let playTimer = null;

const I = {
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  minus: '<svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg>',
  home: '<svg viewBox="0 0 24 24"><path d="M4 11l8-7 8 7v9h-5v-6H9v6H4z"/></svg>',
  locate: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.5"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/><circle cx="12" cy="12" r="7.5"/></svg>',
  three: '<span class="txt">3D</span>',
  compare: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M12 3v18"/></svg>',
  camera: '<svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  full: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12-7.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z"/></svg>',
  chev: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
};

export function initControls(ctx) {
  CTX = ctx;
  const { S, cfg } = ctx;
  const lens = document.getElementById('lens');
  document.getElementById('lensToggle').onclick = () => {
    lens.classList.toggle('closed');
    document.getElementById('lensToggle').setAttribute('aria-expanded', String(!lens.classList.contains('closed')));
  };
  if (window.matchMedia('(max-width: 820px)').matches) lens.classList.add('closed');

  const body = document.getElementById('lensBody');
  body.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-k]');
    if (b) {
      const k = b.dataset.k;
      let v = b.dataset.v;
      if (k === 'res') v = /^\d$/.test(v) ? +v : v;
      if (k === 'density') v = !S.get().density;
      if (k === 'var') { pickerOpen = false; S.set({ var: v, mode: 'value', density: false }); return; }
      S.set({ [k]: v });
      return;
    }
    if (e.target.closest('#pickerBtn')) { pickerOpen = !pickerOpen; renderLens(); if (pickerOpen) document.getElementById('pickerQ')?.focus(); }
  });
  body.addEventListener('input', (e) => {
    if (e.target.id === 'pickerQ') { pickerQuery = e.target.value; renderPickerList(); }
    else if (e.target.id === 'opacity') S.set({ opacity: +e.target.value });
    else if (e.target.id === 'lineScale') S.set({ lineScale: +e.target.value });
  });
  body.addEventListener('change', (e) => {
    const k = e.target.dataset?.tog;
    if (k === 'theme') S.set({ theme: e.target.checked ? 'dark' : 'light' });
    else if (k) S.set({ [k]: e.target.checked });
  });

  // toolbar
  const f = cfg.features;
  const groups = [
    [['zin', I.plus, 'Zoom in'], ['zout', I.minus, 'Zoom out']],
    [['home', I.home, 'All of India'], ...(f.locate_me ? [['locate', I.locate, 'Which constituency am I in?']] : [])],
    [...(f.three_d ? [['3d', I.three, '3D hexagons']] : []), ...(f.compare ? [['compare', I.compare, 'Swipe compare']] : []),
      ...(f.export_png ? [['png', I.camera, 'Export map as PNG']] : []), ['full', I.full, 'Full screen']],
  ];
  const tools = document.getElementById('tools');
  tools.innerHTML = groups.map((g) => `<div class="tgroup">${g.map(([id, ic, t]) => `<button data-tool="${id}" title="${t}" aria-label="${t}">${ic}</button>`).join('')}</div>`).join('');
  tools.addEventListener('click', (e) => { const b = e.target.closest('[data-tool]'); if (b) ctx.act.tool(b.dataset.tool); });

  // basemaps + overlays
  const bases = document.getElementById('bases');
  bases.addEventListener('click', (e) => {
    const b = e.target.closest('[data-bm]');
    if (b) { S.set({ basemap: b.dataset.bm }); return; }
    const o = e.target.closest('[data-ov]');
    if (o) {
      const cur = S.get().overlays;
      S.set({ overlays: cur.includes(o.dataset.ov) ? cur.filter((x) => x !== o.dataset.ov) : [...cur, o.dataset.ov] });
    }
  });

  // timeline
  const tl = document.getElementById('timeline');
  tl.addEventListener('click', (e) => {
    if (e.target.closest('.play')) { togglePlay(); return; }
    const y = e.target.closest('[data-year]');
    if (!y) return;
    const yr = +y.dataset.year;
    const st = S.get();
    const l = lensOf(st);
    if (l.mode === 'change' && yr < l.year) S.set({ from: yr });
    else S.set({ year: yr });
  });

  // compare bar
  document.getElementById('compareBar').addEventListener('change', (e) => {
    const st = S.get();
    if (e.target.id === 'cmpKind') {
      const kind = e.target.value;
      S.set({ compare: { kind, value: defaultCompareValue(kind, st) } });
    } else if (e.target.id === 'cmpValue') S.set({ compare: { ...st.compare, value: e.target.value } });
  });
  document.getElementById('compareBar').addEventListener('click', (e) => { if (e.target.closest('.x')) S.set({ compare: null }); });

  S.on(null, (st, prev, changed) => {
    const lensKeys = ['level', 'res', 'scope', 'var', 'year', 'mode', 'from', 'density', 'scale', 'mask', 'labels', 'stateLines', 'hexLines', 'cbSafe', 'theme', 'sel'];
    if (lensKeys.some((k) => changed.has(k))) renderLens();
    if (['basemap', 'overlays'].some((k) => changed.has(k))) renderBases();
    if (['var', 'year', 'mode', 'from'].some((k) => changed.has(k))) renderTimeline();
    if (['threeD', 'compare'].some((k) => changed.has(k))) renderTools();
    if (['compare', 'var', 'year', 'basemap'].some((k) => changed.has(k))) renderCompareBar();
  });
  renderLens(); renderBases(); renderTimeline(); renderTools(); renderCompareBar();
}

export function defaultCompareValue(kind, st) {
  const l = lensOf(st);
  if (kind === 'year') return String(l.years.length ? l.years[0] : '');
  if (kind === 'basemap') return CTX.cfg.basemaps.find((b) => b.id !== st.basemap)?.id || st.basemap;
  const other = CTX.cfg.featured.find((id) => id !== st.var) || allSeries()[0].id;
  return other;
}

// ------------------------------------------------------------------------------------------------
function seg(key, items, cur, cls = '') {
  return `<div class="seg ${cls}">${items.map(([v, label, dis, title]) => `<button data-k="${key}" data-v="${v}" class="${String(cur) === String(v) ? 'on' : ''}" ${dis ? 'disabled' : ''} ${title ? `title="${esc(title)}"` : ''}>${label}</button>`).join('')}</div>`;
}

/** Mark the resolution actually drawn (it can differ from the one asked for: Auto, size limits, data). */
function markShownRes() {
  const shown = CTX.rt.shownRes;
  document.querySelectorAll('#lensBody [data-k="res"]').forEach((b) => b.classList.toggle('shown', shown != null && String(shown) === b.dataset.v));
}

function tog(key, label, on) {
  return `<label class="tog">${label}<input type="checkbox" data-tog="${key}" ${on ? 'checked' : ''}><i></i></label>`;
}

export function renderLens() {
  const { S, cfg, rt } = CTX;
  const st = S.get();
  const lens = lensOf(st);
  const L = cfg.boundaries.levels;
  const f = cfg.features;
  const AREA = { 6: '≈36 km²', 7: '≈5.2 km²', 8: '≈0.74 km²' };
  const resItems = [['off', 'Off', false, 'No hexagons'], ['auto', 'Auto', false, 'Resolution follows the zoom or the size of the selected place'],
    ...cfg.hex.resolutions.map((r) => [r, `H${r}`, false, `H${r} cells, ${AREA[r] || ''} each`])];
  const hint = rt.hexHint || '';
  const s = lens.series;
  const modeChips = [];
  if (s && s.years.length >= 2 && f.change_mode) {
    modeChips.push(`<button class="chip${lens.mode === 'value' ? ' on' : ''}" data-k="mode" data-v="value">Value</button>`);
    modeChips.push(`<button class="chip${lens.mode === 'change' ? ' on' : ''}" data-k="mode" data-v="change">Change</button>`);
  }
  if (s && s.density && f.density_toggle) modeChips.push(`<button class="chip${lens.density ? ' on' : ''}" data-k="density">Per km²</button>`);
  const scaleChips = s ? `<button class="chip${st.scale !== 'india' ? ' on' : ''}" data-k="scale" data-v="relative" title="Colour breaks from what's on screen">Relative</button>
    <button class="chip${st.scale === 'india' ? ' on' : ''}" data-k="scale" data-v="india" title="The same colour breaks everywhere in India">All-India</button>` : '';
  document.getElementById('lensBody').innerHTML = `
    <div><div class="lab">Boundaries</div>${seg('level', Object.entries(L).map(([id, l]) => [id, l.label]), st.level)}</div>
    <div><div class="lab">Hexagons <span>${esc(hint)}</span></div>${seg('res', resItems, st.res)}
      ${st.res !== 'off' ? `<div style="margin-top:5px">${seg('scope', [['sel', 'Selected place', false, st.sel ? 'Only the cells of the selected place' : 'Nothing is selected yet: cells in view are shown'], ['view', 'Everything in view', false, 'All cells on screen; the selected place stays highlighted']], st.scope, 'sm')}</div>` : ''}</div>
    <div><div class="lab">Colour by</div>
      <button class="picker-btn" id="pickerBtn" aria-expanded="${pickerOpen}"><span><span class="pg">${esc(s ? s.group : 'No variable')}</span><br><span class="pv">${esc(s ? s.label : 'Outline only')}</span></span>${I.chev}</button>
      ${pickerOpen ? `<div class="picker" id="picker"><input id="pickerQ" placeholder="Find a variable…" value="${esc(pickerQuery)}"><div id="pickerList"></div></div>` : ''}
      ${modeChips.length || scaleChips ? `<div class="chips" style="margin-top:8px">${modeChips.join('')}${modeChips.length ? '<span style="width:6px"></span>' : ''}${scaleChips}</div>` : ''}
    </div>
    <div class="legend" id="legend">${legendHTML()}</div>
    <div class="slider">Fill<input type="range" id="opacity" min="0.1" max="1" step="0.02" value="${st.opacity}" aria-label="Fill opacity"></div>
    <details class="drawer"${rt.drawerOpen ? ' open' : ''} id="drawer"><summary>Display options <span>＋</span></summary>
      ${tog('mask', 'Dim outside selection', st.mask)}
      ${tog('labels', 'Unit names', st.labels)}
      ${tog('stateLines', 'State borders', st.stateLines)}
      ${tog('hexLines', 'Hexagon outlines', st.hexLines)}
      ${f.colourblind_ramps ? tog('cbSafe', 'Colour-blind-safe colours', st.cbSafe) : ''}
      ${tog('theme', 'Dark interface', st.theme === 'dark')}
      <div class="slider">Boundary strength<input type="range" id="lineScale" min="0.3" max="1.8" step="0.05" value="${st.lineScale}"></div>
    </details>`;
  document.getElementById('drawer').addEventListener('toggle', (e) => { rt.drawerOpen = e.target.open; });
  markShownRes();
  if (pickerOpen) renderPickerList();
}

function renderPickerList() {
  const el = document.getElementById('pickerList');
  if (!el) return;
  const st = CTX.S.get();
  const q = pickerQuery.trim().toLowerCase();
  const items = allSeries().filter((s) => !q || s.label.toLowerCase().includes(q) || s.id.includes(q) || s.group.toLowerCase().includes(q));
  const featured = CTX.cfg.featured.map(seriesById).filter((s) => s && items.includes(s));
  const groups = {};
  for (const s of items) if (!featured.includes(s) || q) (groups[s.group] ||= []).push(s);
  const btn = (s) => `<button data-k="var" data-v="${s.id}" class="${st.var === s.id ? 'on' : ''}">${esc(s.label)}<small>${s.years.length > 1 ? `${s.years[0]}–${s.years[s.years.length - 1]}` : s.years[0] || ''}</small></button>`;
  el.innerHTML = `${!q ? `<button data-k="var" data-v="none" class="${st.var === 'none' ? 'on' : ''}">Outline only</button>` : ''}
    ${featured.length && !q ? `<div class="g">Featured</div>${featured.map(btn).join('')}` : ''}
    ${Object.entries(groups).map(([g, ss]) => `<div class="g">${esc(g)}</div>${ss.map(btn).join('')}`).join('')}
    ${!items.length ? '<div class="g">Nothing matches</div>' : ''}`;
}

export function legendHTML() {
  const lg = CTX.rt.legend;
  if (!lg || lg.lens.none) return '';
  const cov = lg.coverage;
  if (cov && cov.n && !cov.fin) return `<div class="lnote nodata">No ${esc(lg.lens.label.toLowerCase())} data for these ${cov.n.toLocaleString('en-IN')} cells.</div>`;
  if (!lg.sc) return '';
  const { sc, lens, scopeLabel } = lg;
  const part = cov && cov.fin < cov.n ? `<br>Data for ${cov.fin.toLocaleString('en-IN')} of ${cov.n.toLocaleString('en-IN')} cells; the rest are left uncoloured.` : '';
  return `<div class="ramp">${sc.colors.map((c) => `<i style="background:${c}"></i>`).join('')}</div>
    <div class="ticks"><span></span>${sc.breaks.map((b) => `<span>${esc(legendNum(b, lens))}</span>`).join('')}<span></span></div>
    <div class="lnote">${esc(lens.title)}${lens.unitLabel ? ` · ${esc(lens.unitLabel)}` : ''}<br>${sc.rel ? `Breaks relative to ${esc(scopeLabel)}` : 'All-India breaks'}${lens.note ? ` · ${esc(lens.note)}` : ''}${part}</div>`;
}

export function updateLegend() {
  const el = document.getElementById('legend');
  if (el) el.innerHTML = legendHTML();
  const st = CTX.S.get();
  const hintEl = document.querySelector('#lensBody .lab span');
  if (hintEl) hintEl.textContent = st.res === 'off' ? '' : CTX.rt.hexHint || '';
  markShownRes();
}

function renderBases() {
  const { S, cfg } = CTX;
  const st = S.get();
  const thumb = (b) => b.tiles[0].replace('{z}', 7).replace('{x}', 91).replace('{y}', 53).replace('{s}', 'a');
  const ovs = [...Object.entries(cfg.overlays.groups || {}), ...Object.entries(cfg.overlays.raster || {})];
  document.getElementById('bases').innerHTML = `
    <div class="ov-row"><span class="lbl">Show</span>${ovs.map(([id, o]) => `<button class="chip${st.overlays.includes(id) ? ' on' : ''}" data-ov="${id}">${esc(o.label)}</button>`).join('')}</div>
    <div class="bm-row">${cfg.basemaps.map((b) => `<button class="bm${st.basemap === b.id ? ' on' : ''}" data-bm="${b.id}" title="${esc(b.label)}"><img src="${thumb(b)}" alt="" loading="lazy">${esc(b.label)}</button>`).join('')}</div>`;
}

function renderTools() {
  const st = CTX.S.get();
  document.querySelectorAll('[data-tool="3d"]').forEach((b) => b.classList.toggle('on', !!st.threeD));
  document.querySelectorAll('[data-tool="compare"]').forEach((b) => b.classList.toggle('on', !!st.compare));
}

export function renderTimeline() {
  const st = CTX.S.get();
  const lens = lensOf(st);
  const el = document.getElementById('timeline');
  if (!CTX.cfg.features.timeline || lens.none || lens.years.length < 2) { el.hidden = true; stopPlay(); return; }
  el.hidden = false;
  el.innerHTML = `<button class="play" aria-label="${playTimer ? 'Pause' : 'Play'}">${playTimer ? I.pause : I.play}</button>
    ${lens.mode === 'change' ? '<span class="tl-lbl">From · to</span>' : ''}
    <div class="years">${lens.years.map((y) => {
    let cls = y === lens.year ? 'on' : '';
    if (lens.mode === 'change') { if (y === lens.from) cls = 'from'; else if (y > lens.from && y < lens.year) cls = 'span'; }
    return `<button data-year="${y}" class="${cls}">${y}</button>`;
  }).join('')}</div>`;
  el.querySelector('.years .on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function togglePlay() {
  if (playTimer) { stopPlay(); return; }
  const step = () => {
    const st = CTX.S.get();
    const lens = lensOf(st);
    const ys = lens.years;
    const i = ys.indexOf(lens.year);
    if (i >= ys.length - 1) { stopPlay(); return; }
    CTX.S.set({ year: ys[i + 1] });
    if (ys[i + 2] != null) CTX.act.prefetchYear(ys[i + 2]);
  };
  const st = CTX.S.get();
  const lens = lensOf(st);
  if (lens.year === lens.years[lens.years.length - 1]) CTX.S.set({ year: lens.mode === 'change' ? lens.years[1] : lens.years[0] });
  playTimer = setInterval(step, 1300);
  renderTimeline();
}

function stopPlay() {
  if (playTimer) { clearInterval(playTimer); playTimer = null; renderTimeline(); }
}

function renderCompareBar() {
  const { S, cfg } = CTX;
  const st = S.get();
  const bar = document.getElementById('compareBar');
  if (!st.compare) { bar.hidden = true; return; }
  bar.hidden = false;
  const lens = lensOf(st);
  const kinds = [['year', 'Year', lens.years.length >= 2], ['variable', 'Variable', true], ['basemap', 'Basemap', true]];
  let opts = '';
  if (st.compare.kind === 'year') opts = lens.years.map((y) => `<option value="${y}" ${String(y) === st.compare.value ? 'selected' : ''}>${y}</option>`).join('');
  else if (st.compare.kind === 'basemap') opts = cfg.basemaps.map((b) => `<option value="${b.id}" ${b.id === st.compare.value ? 'selected' : ''}>${esc(b.label)}</option>`).join('');
  else opts = allSeries().map((s) => `<option value="${s.id}" ${s.id === st.compare.value ? 'selected' : ''}>${esc(s.label)}</option>`).join('');
  bar.innerHTML = `<span>Right side</span>
    <select id="cmpKind">${kinds.filter((k) => k[2]).map(([k, l]) => `<option value="${k}" ${k === st.compare.kind ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <select id="cmpValue">${opts}</select><button class="x" title="Close compare">✕</button>`;
}
