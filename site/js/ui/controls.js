// Map chrome, generated from config.json and kept in sync with the store:
//   lens bar   (top)        what the map is coloured by: variable, mode, scale, legend, years
//   Layers     (top-left)   boundaries, hexagons, fill, display options
//   tools      (right)      zoom, home, find me, compass, 3D, compare, export, full screen
//   bases      (bottom-left) Map / Satellite / Terrain tabs + a Labels popover
//   compare bar              what the right side of a swipe compare shows
import { esc, legendNum } from '../scales.js';
import { lensOf, allSeries, seriesById } from '../lens.js';

let CTX = null;
let pickerQuery = '';
let playTimer = null;

const I = {
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  minus: '<svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg>',
  home: '<svg viewBox="0 0 24 24"><path d="M4 11l8-7 8 7v9h-5v-6H9v6H4z"/></svg>',
  locate: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.5"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/><circle cx="12" cy="12" r="7.5"/></svg>',
  compass: '<svg viewBox="0 0 24 24"><path d="M12 3l3.5 9h-7z" fill="currentColor" stroke="none" opacity=".9"/><path d="M12 21l-3.5-9h7z"/></svg>',
  three: '<span class="txt">3D</span>',
  compare: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M12 3v18"/></svg>',
  camera: '<svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  full: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
  layers: '<svg viewBox="0 0 24 24"><path d="M12 4l9 5-9 5-9-5z"/><path d="M3 14l9 5 9-5"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12-7.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z"/></svg>',
  chev: '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
};

const isMobile = () => window.matchMedia('(max-width: 820px)').matches;

export function initControls(ctx) {
  CTX = ctx;
  const { S, cfg } = ctx;

  // ---- Layers panel ----
  const lens = document.getElementById('lens');
  document.getElementById('lensToggle').onclick = () => {
    lens.classList.toggle('closed');
    document.getElementById('lensToggle').setAttribute('aria-expanded', String(!lens.classList.contains('closed')));
  };
  if (isMobile()) lens.classList.add('closed');
  const body = document.getElementById('lensBody');
  body.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-k]');
    if (!b) return;
    let v = b.dataset.v;
    if (b.dataset.k === 'res') v = /^\d$/.test(v) ? +v : v;
    S.set({ [b.dataset.k]: v });
  });
  body.addEventListener('input', (e) => {
    if (e.target.id === 'opacity') S.set({ opacity: +e.target.value });
    else if (e.target.id === 'lineScale') S.set({ lineScale: +e.target.value });
  });
  body.addEventListener('change', (e) => {
    const k = e.target.dataset?.tog;
    if (k === 'theme') S.set({ theme: e.target.checked ? 'dark' : 'light' });
    else if (k) S.set({ [k]: e.target.checked });
  });

  // ---- lens bar ----
  const bar = document.getElementById('lensbar');
  bar.addEventListener('click', (e) => {
    if (e.target.closest('#varBtn')) { togglePicker(); return; }
    const b = e.target.closest('button[data-k]');
    if (b) {
      const k = b.dataset.k;
      if (k === 'var') { togglePicker(false); S.set({ var: b.dataset.v, mode: 'value', density: false }); return; }
      if (k === 'density') { S.set({ density: !S.get().density }); return; }
      S.set({ [k]: b.dataset.v });
      return;
    }
    if (e.target.closest('.play')) { togglePlay(); return; }
    const y = e.target.closest('[data-year]');
    if (y) {
      const yr = +y.dataset.year;
      const l = lensOf(S.get());
      if (l.mode === 'change' && yr < l.year) S.set({ from: yr });
      else S.set({ year: yr });
    }
  });
  document.getElementById('pickerQ').addEventListener('input', (e) => { pickerQuery = e.target.value; renderPickerList(); });
  document.getElementById('pickerQ').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') togglePicker(false);
    if (e.key === 'Enter') document.querySelector('#pickerList button')?.click();
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('#lensbar')) togglePicker(false); });

  // ---- tools ----
  const f = cfg.features;
  const groups = [
    [['layers', I.layers, 'Layers'], ['zin', I.plus, 'Zoom in'], ['zout', I.minus, 'Zoom out'], ['north', I.compass, 'Reset north and tilt']],
    [['home', I.home, 'All of India'], ...(f.locate_me ? [['locate', I.locate, 'Find me']] : [])],
    [...(f.three_d ? [['3d', I.three, '3D hexagons']] : []), ...(f.compare ? [['compare', I.compare, 'Swipe compare']] : []),
      ...(f.export_png ? [['png', I.camera, 'Save map as PNG']] : []), ['full', I.full, 'Full screen']],
  ];
  const tools = document.getElementById('tools');
  tools.innerHTML = groups.map((g) => `<div class="tgroup">${g.map(([id, ic, t]) => `<button data-tool="${id}" title="${t}" aria-label="${t}">${ic}</button>`).join('')}</div>`).join('');
  tools.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tool]');
    if (!b) return;
    if (b.dataset.tool === 'layers') { lens.classList.toggle('closed'); return; }
    ctx.act.tool(b.dataset.tool);
  });
  ctx.view.map.on('rotate', renderCompass);
  ctx.view.map.on('pitch', renderCompass);

  // ---- bases ----
  const bases = document.getElementById('bases');
  bases.addEventListener('click', (e) => {
    const b = e.target.closest('[data-bm]');
    if (b) { S.set({ basemap: b.dataset.bm }); return; }
    if (e.target.closest('#ovBtn')) document.getElementById('ovPop').hidden = !document.getElementById('ovPop').hidden;
  });
  bases.addEventListener('change', (e) => {
    const id = e.target.dataset?.ov;
    if (!id) return;
    const cur = S.get().overlays.filter((x) => x !== id);
    S.set({ overlays: e.target.checked ? [...cur, id] : cur });
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('#bases')) { const p = document.getElementById('ovPop'); if (p) p.hidden = true; } });

  // ---- compare bar ----
  document.getElementById('compareBar').addEventListener('change', (e) => {
    const st = S.get();
    if (e.target.id === 'cmpKind') S.set({ compare: { kind: e.target.value, value: defaultCompareValue(e.target.value, st) } });
    else if (e.target.id === 'cmpValue') S.set({ compare: { ...st.compare, value: e.target.value } });
  });
  document.getElementById('compareBar').addEventListener('click', (e) => { if (e.target.closest('.x')) S.set({ compare: null }); });

  S.on(null, (st, prev, changed) => {
    if (['level', 'res', 'scope', 'mask', 'labels', 'stateLines', 'hexLines', 'cbSafe', 'theme', 'sel'].some((k) => changed.has(k))) renderLens();
    if (['var', 'year', 'mode', 'from', 'density', 'scale'].some((k) => changed.has(k))) { renderBar(); renderTimeline(); }
    if (['basemap', 'overlays'].some((k) => changed.has(k))) renderBases();
    if (['threeD', 'compare'].some((k) => changed.has(k))) renderTools();
    if (['compare', 'var', 'year', 'basemap'].some((k) => changed.has(k))) renderCompareBar();
  });
  renderLens(); renderBar(); renderBases(); renderTimeline(); renderTools(); renderCompareBar();
}

export function defaultCompareValue(kind, st) {
  const l = lensOf(st);
  if (kind === 'year') return String(l.years.length ? l.years[0] : '');
  if (kind === 'basemap') return visibleBasemaps().find((b) => b.id !== st.basemap)?.id || st.basemap;
  return CTX.cfg.featured.find((id) => id !== st.var) || allSeries()[0].id;
}

const visibleBasemaps = () => CTX.cfg.basemaps.filter((b) => b.show !== false);

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

/** Layers panel: where things are drawn (not what they're coloured by). */
export function renderLens() {
  const { S, cfg, rt } = CTX;
  const st = S.get();
  const f = cfg.features;
  const AREA = { 6: '≈36 km²', 7: '≈5.2 km²', 8: '≈0.74 km²' };
  const resItems = [['off', 'Off', false, 'No hexagons'], ['auto', 'Auto', false, 'Resolution follows the zoom or the size of the selected place'],
    ...cfg.hex.resolutions.map((r) => [r, `H${r}`, false, `H${r} cells, ${AREA[r] || ''} each`])];
  document.getElementById('lensBody').innerHTML = `
    <div><div class="lab">Boundaries</div>${seg('level', Object.entries(cfg.boundaries.levels).map(([id, l]) => [id, l.label]), st.level)}</div>
    <div><div class="lab">Hexagons <span id="hexHint">${esc(st.res === 'off' ? '' : rt.hexHint || '')}</span></div>${seg('res', resItems, st.res)}
      ${st.res !== 'off' ? `<div style="margin-top:5px">${seg('scope', [['sel', 'Selected place', false, st.sel ? 'Only the cells of the selected place' : 'Nothing is selected yet: cells in view are shown'], ['view', 'Everything in view', false, 'All cells on screen; the selected place stays highlighted']], st.scope, 'sm')}</div>` : ''}</div>
    <div class="slider">Fill<input type="range" id="opacity" min="0.1" max="1" step="0.02" value="${st.opacity}" aria-label="Fill opacity"></div>
    <details class="drawer"${rt.drawerOpen ? ' open' : ''} id="drawer"><summary>Display options <span>＋</span></summary>
      ${tog('mask', 'Dim outside selection', st.mask)}
      ${tog('labels', 'Unit names', st.labels)}
      ${tog('stateLines', 'State borders', st.stateLines)}
      ${tog('hexLines', 'Hexagon outlines', st.hexLines)}
      ${f.colourblind_ramps ? tog('cbSafe', 'Colour-blind-safe colours', st.cbSafe) : ''}
      ${tog('theme', 'Dark interface', st.theme === 'dark')}
      <div class="slider">Boundaries<input type="range" id="lineScale" min="0.3" max="1.8" step="0.05" value="${st.lineScale}" aria-label="Boundary strength"></div>
    </details>`;
  document.getElementById('drawer').addEventListener('toggle', (e) => { rt.drawerOpen = e.target.open; });
  markShownRes();
}

/** Lens bar: what the map is coloured by. */
function renderBar() {
  const { S, cfg } = CTX;
  const st = S.get();
  const lens = lensOf(st);
  const f = cfg.features;
  const s = lens.series;
  const chips = [];
  if (s && s.years.length >= 2 && f.change_mode) {
    chips.push(`<button class="chip${lens.mode === 'value' ? ' on' : ''}" data-k="mode" data-v="value">Value</button>`);
    chips.push(`<button class="chip${lens.mode === 'change' ? ' on' : ''}" data-k="mode" data-v="change" title="Difference between two years">Change</button>`);
  }
  if (s && s.density && f.density_toggle) chips.push(`<button class="chip${lens.density ? ' on' : ''}" data-k="density" title="Divide by area">Per km²</button>`);
  if (s) chips.push(`<button class="chip${st.scale === 'india' ? ' on' : ''}" data-k="scale" data-v="${st.scale === 'india' ? 'relative' : 'india'}" title="${st.scale === 'india' ? 'Same colour breaks everywhere in India (click for breaks relative to the view)' : 'Colour breaks relative to the view (click for All-India breaks)'}">${st.scale === 'india' ? 'All-India scale' : 'Relative scale'}</button>`);
  document.getElementById('lbRow').innerHTML = `
    <button class="var-btn" id="varBtn" aria-haspopup="listbox"><span class="vk">Colour by</span><span class="vv">${esc(s ? s.label : 'Choose a variable')}</span>${I.chev}</button>
    ${chips.length ? `<div class="chips">${chips.join('')}</div>` : ''}`;
  document.getElementById('lensbar').classList.toggle('empty', !s);
  updateLegend();
}

function togglePicker(open) {
  const p = document.getElementById('picker');
  const show = open ?? p.hidden;
  p.hidden = !show;
  document.getElementById('varBtn')?.setAttribute('aria-expanded', String(show));
  if (show) { renderPickerList(); const q = document.getElementById('pickerQ'); q.value = pickerQuery; q.focus(); }
}

function renderPickerList() {
  const el = document.getElementById('pickerList');
  const st = CTX.S.get();
  const q = pickerQuery.trim().toLowerCase();
  const items = allSeries().filter((s) => !q || s.label.toLowerCase().includes(q) || s.id.includes(q) || s.group.toLowerCase().includes(q));
  const featured = CTX.cfg.featured.map(seriesById).filter((s) => s && items.includes(s));
  const groups = {};
  for (const s of items) if (!featured.includes(s) || q) (groups[s.group] ||= []).push(s);
  const btn = (s) => `<button data-k="var" data-v="${s.id}" class="${st.var === s.id ? 'on' : ''}">${esc(s.label)}<small>${s.years.length > 1 ? `${s.years[0]}–${s.years[s.years.length - 1]}` : s.years[0] || ''}</small></button>`;
  el.innerHTML = `${!q ? `<button data-k="var" data-v="none" class="${st.var === 'none' ? 'on' : ''}">None (boundaries only)</button>` : ''}
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
  const part = cov && cov.fin < cov.n ? ` · data for ${cov.fin.toLocaleString('en-IN')} of ${cov.n.toLocaleString('en-IN')} cells` : '';
  const full = `${lens.title}${lens.unitLabel ? ` (${lens.unitLabel})` : ''}. ${sc.rel ? `Breaks relative to ${scopeLabel}` : 'All-India breaks'}.${lens.note ? ` ${lens.note}.` : ''}`;
  return `<div class="ramp">${sc.colors.map((c) => `<i style="background:${c}"></i>`).join('')}</div>
    <div class="ticks"><span></span>${sc.breaks.map((b) => `<span>${esc(legendNum(b, lens))}</span>`).join('')}<span></span></div>
    <div class="lnote" title="${esc(full)}">${esc(lens.unitLabel || '')}${lens.year ? ` · ${lens.mode === 'change' ? `${lens.from}–${lens.year}` : lens.year}` : ''}${sc.rel ? ` · relative to ${esc(scopeLabel)}` : ' · All-India'}${part}</div>`;
}

export function updateLegend() {
  const el = document.getElementById('legend');
  if (el) { el.innerHTML = legendHTML(); el.hidden = !el.innerHTML.trim(); }
  const st = CTX.S.get();
  const hintEl = document.getElementById('hexHint');
  if (hintEl) hintEl.textContent = st.res === 'off' ? '' : CTX.rt.hexHint || '';
  markShownRes();
}

function renderBases() {
  const { S, cfg } = CTX;
  const st = S.get();
  const ovs = [...Object.entries(cfg.overlays.groups || {}), ...Object.entries(cfg.overlays.raster || {})];
  const off = cfg.basemaps.find((b) => b.id === st.basemap)?.overlays_off || [];
  const pop = document.getElementById('ovPop');
  const open = !!pop && !pop.hidden;
  const on = st.overlays.filter((o) => !off.includes(o)).length;
  document.getElementById('bases').innerHTML = `
    <div class="tabs-bm" role="tablist">${visibleBasemaps().map((b) => `<button role="tab" aria-selected="${st.basemap === b.id}" class="${st.basemap === b.id ? 'on' : ''}" data-bm="${b.id}">${esc(b.label)}</button>`).join('')}</div>
    <div class="ov-wrap"><button class="ov-btn" id="ovBtn" aria-haspopup="true">Labels${on ? ` · ${on}` : ''}</button>
      <div class="ov-pop" id="ovPop"${open ? '' : ' hidden'}>${ovs.map(([id, o]) => {
    const dis = off.includes(id);
    return `<label class="tog${dis ? ' dis' : ''}" ${dis ? 'title="Already part of this map style"' : ''}>${esc(o.label)}<input type="checkbox" data-ov="${id}" ${st.overlays.includes(id) && !dis ? 'checked' : ''} ${dis ? 'disabled' : ''}><i></i></label>`;
  }).join('')}</div></div>`;
}

function renderCompass() {
  const m = CTX.view.map;
  const b = document.querySelector('[data-tool="north"]');
  if (!b) return;
  b.querySelector('svg').style.transform = `rotate(${-m.getBearing()}deg)`;
  b.classList.toggle('on', Math.abs(m.getBearing()) > 0.5 || m.getPitch() > 1);
}

function renderTools() {
  const st = CTX.S.get();
  document.querySelectorAll('[data-tool="3d"]').forEach((b) => b.classList.toggle('on', !!st.threeD));
  document.querySelectorAll('[data-tool="compare"]').forEach((b) => b.classList.toggle('on', !!st.compare));
  renderCompass();
}

export function renderTimeline() {
  const st = CTX.S.get();
  const lens = lensOf(st);
  const el = document.getElementById('timeline');
  if (!CTX.cfg.features.timeline || lens.none || lens.years.length < 2) { el.hidden = true; stopPlay(); return; }
  el.hidden = false;
  el.innerHTML = `<button class="play" aria-label="${playTimer ? 'Pause' : 'Play through the years'}">${playTimer ? I.pause : I.play}</button>
    <div class="years">${lens.years.map((y) => {
    let cls = y === lens.year ? 'on' : '';
    if (lens.mode === 'change') { if (y === lens.from) cls = 'from'; else if (y > lens.from && y < lens.year) cls = 'span'; }
    return `<button data-year="${y}" class="${cls}" ${lens.mode === 'change' && y < lens.year ? 'title="Set as the start year"' : ''}>${y}</button>`;
  }).join('')}</div>`;
  el.querySelector('.years .on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function togglePlay() {
  if (playTimer) { stopPlay(); return; }
  const step = () => {
    const lens = lensOf(CTX.S.get());
    const ys = lens.years;
    const i = ys.indexOf(lens.year);
    if (i >= ys.length - 1) { stopPlay(); return; }
    CTX.S.set({ year: ys[i + 1] });
    if (ys[i + 2] != null) CTX.act.prefetchYear(ys[i + 2]);
  };
  const lens = lensOf(CTX.S.get());
  if (lens.year === lens.years[lens.years.length - 1]) CTX.S.set({ year: lens.mode === 'change' ? lens.years[1] : lens.years[0] });
  playTimer = setInterval(step, 1300);
  renderTimeline();
}

function stopPlay() {
  if (playTimer) { clearInterval(playTimer); playTimer = null; renderTimeline(); }
}

function renderCompareBar() {
  const { S } = CTX;
  const st = S.get();
  const bar = document.getElementById('compareBar');
  if (!st.compare) { bar.hidden = true; return; }
  bar.hidden = false;
  const lens = lensOf(st);
  const kinds = [['year', 'Year', lens.years.length >= 2], ['variable', 'Variable', true], ['basemap', 'Map style', true]];
  let opts = '';
  if (st.compare.kind === 'year') opts = lens.years.map((y) => `<option value="${y}" ${String(y) === st.compare.value ? 'selected' : ''}>${y}</option>`).join('');
  else if (st.compare.kind === 'basemap') opts = visibleBasemaps().map((b) => `<option value="${b.id}" ${b.id === st.compare.value ? 'selected' : ''}>${esc(b.label)}</option>`).join('');
  else opts = allSeries().map((s) => `<option value="${s.id}" ${s.id === st.compare.value ? 'selected' : ''}>${esc(s.label)}</option>`).join('');
  bar.innerHTML = `<span>Right side</span>
    <select id="cmpKind">${kinds.filter((k) => k[2]).map(([k, l]) => `<option value="${k}" ${k === st.compare.kind ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <select id="cmpValue">${opts}</select><button class="x" title="Close compare">✕</button>`;
}
