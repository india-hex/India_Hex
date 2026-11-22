// Variable explorer: what the map shows. Opens from the lens bar's "Map shows" button, or with "/".
//   Tree   Recent chips, Featured, Elections > state > house > variables, then every other group;
//          a search flattens it to groups with the matches highlighted
//   Table  one row per variable (group, unit, years, resolution, coverage, notes), sortable,
//          filtered by the same search and a group select
// Keyboard: ↑/↓ move through the visible rows, Enter picks (or opens a group), Escape closes.
import { esc, periodLabel } from '../scales.js';
import { allSeries, seriesById } from '../lens.js';
import { units } from '../data/units.js';

let CTX = null;
let root = null;
let scrim = null;
let bodyEl = null;
let qEl = null;
let groupEl = null;
let countEl = null;
const ui = { open: false, view: 'tree', q: '', terms: [], group: '', sort: null, dir: 1, act: -1 };
const treeOpen = new Map(); // tree nodes the viewer opened or closed this visit
const RECENT_KEY = 'indiahex.recent';
const VIEW_KEY = 'indiahex.explorer';
const PREF = ['People', 'Economy', 'Built environment', 'Land cover', 'Forest', 'Commerce', 'Property'];
const NUM = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const NONE_WORDS = 'none boundaries only outline';

const isPhone = () => window.matchMedia('(max-width: 820px)').matches;
const finePointer = () => window.matchMedia('(pointer: fine)').matches;
const typing = (el) => !!el && (['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) || el.isContentEditable);
const inElections = (s) => s.menu?.[0] === 'Elections' && s.menu.length >= 3;

export const isExplorerOpen = () => ui.open;

export function initExplorer(ctx) {
  CTX = ctx;
  try { const v = localStorage.getItem(VIEW_KEY); if (v === 'tree' || v === 'table') ui.view = v; } catch { /* private mode */ }
  const n = allSeries().length;
  const groups = groupList();
  scrim = document.createElement('div');
  scrim.className = 'ex-scrim';
  scrim.hidden = true;
  root = document.createElement('div');
  root.className = 'explorer';
  root.id = 'explorer';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-labelledby', 'exTitle');
  root.innerHTML = `
    <div class="ex-head">
      <div class="ex-top">
        <h2 class="ex-title" id="exTitle">Map shows</h2>
        <span class="ex-count" id="exCount"></span>
        <div class="seg sm ex-view" role="group" aria-label="View">
          <button data-view="tree" aria-pressed="false">Tree</button><button data-view="table" aria-pressed="false">Table</button>
        </div>
        <button class="ex-x" id="exClose" aria-label="Close" title="Close (Esc)"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      </div>
      <div class="ex-tools">
        <label class="ex-q"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>
          <input id="exQ" type="search" placeholder="Search name, source or state" autocomplete="off" spellcheck="false" aria-label="Search variables" aria-controls="exBody"><kbd>/</kbd></label>
        <select id="exGroup" aria-label="Filter by group"><option value="">All groups</option>${groups.map((g) => `<option value="${esc(g)}">${esc(g)}</option>`).join('')}</select>
      </div>
    </div>
    <div class="ex-body" id="exBody"></div>
    <div class="ex-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> show on map</span><span><kbd>Esc</kbd> close</span><span class="ex-foot-r">${n} variables in ${groups.length} groups</span></div>`;
  document.body.append(scrim, root);
  bodyEl = root.querySelector('#exBody');
  qEl = root.querySelector('#exQ');
  groupEl = root.querySelector('#exGroup');
  countEl = root.querySelector('#exCount');

  qEl.addEventListener('input', () => { setQuery(qEl.value); render(); firstAct(); });
  groupEl.addEventListener('change', () => { ui.group = groupEl.value; render(); firstAct(); });
  root.querySelector('#exClose').addEventListener('click', (e) => closeExplorer(e.detail === 0));
  root.querySelector('.ex-view').addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (b) setView(b.dataset.view);
  });
  bodyEl.addEventListener('click', (e) => {
    const sb = e.target.closest('[data-sort]');
    if (sb) { sortBy(sb.dataset.sort); return; }
    const it = e.target.closest('[data-v]');
    if (it) pick(it.dataset.v, e.detail === 0);
  });
  bodyEl.addEventListener('toggle', (e) => { if (e.target.dataset?.node) treeOpen.set(e.target.dataset.node, e.target.open); }, true);
  root.addEventListener('keydown', onKey);
  scrim.addEventListener('click', () => closeExplorer());

  // "/" opens it with the search focused (unless the viewer is typing somewhere); Escape closes
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !typing(document.activeElement)) {
      e.preventDefault();
      openExplorer({ focus: true });
    } else if (e.key === 'Escape' && ui.open) closeExplorer(true);
  });
  // outside press or focus closes it (the lens bar button toggles it itself)
  const outside = (t) => ui.open && t instanceof Node && !root.contains(t) && t !== scrim && !t.closest?.('#varBtn');
  document.addEventListener('pointerdown', (e) => { if (outside(e.target)) closeExplorer(); }, true);
  document.addEventListener('focusin', (e) => { if (outside(e.target)) closeExplorer(); });
  window.addEventListener('resize', () => { if (ui.open) { place(); scrim.hidden = !isPhone(); } });
  // the lens bar grows and shrinks with its legend: keep the popover just under it
  const lb = document.getElementById('lensbar');
  if (lb && window.ResizeObserver) new ResizeObserver(() => { if (ui.open) place(); }).observe(lb);

  CTX.S.on(null, (st, prev, changed) => {
    if (!changed.has('var')) return;
    if (seriesById(st.var)) remember(st.var);
    if (ui.open) render();
  });
}

export function openExplorer({ focus = finePointer() } = {}) {
  if (!root) return;
  if (ui.open) { if (focus) { qEl.focus(); qEl.select(); } return; }
  ui.open = true;
  qEl.value = '';
  setQuery('');
  ui.act = -1;
  root.hidden = false;
  scrim.hidden = !isPhone();
  syncView();
  place();
  render();
  document.getElementById('varBtn')?.setAttribute('aria-expanded', 'true');
  if (focus) qEl.focus({ preventScroll: true });
  // bring the variable on the map into view
  const cur = bodyEl.querySelector('.ex-row.on, tr.on');
  if (cur) bodyEl.scrollTop = Math.max(0, cur.getBoundingClientRect().top - bodyEl.getBoundingClientRect().top - bodyEl.clientHeight / 3);
}

export function closeExplorer(restoreFocus = false) {
  if (!ui.open) return;
  ui.open = false;
  root.hidden = true;
  scrim.hidden = true;
  const b = document.getElementById('varBtn');
  b?.setAttribute('aria-expanded', 'false');
  if (restoreFocus) b?.focus();
}

export function toggleExplorer() {
  if (ui.open) closeExplorer();
  else openExplorer();
}

// ------------------------------------------------------------------------------------------------
function pick(id, viaKey) {
  closeExplorer();
  CTX.act.pickVar(id);
  // the lens bar redraws its button after the store flushes: focus the new one
  if (viaKey) setTimeout(() => document.getElementById('varBtn')?.focus(), 0);
}

function remember(id) {
  try {
    const cur = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    const next = [id, ...(Array.isArray(cur) ? cur : []).filter((x) => x !== id)].slice(0, 5);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* storage off */ }
}

function recent() {
  try {
    const cur = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return (Array.isArray(cur) ? cur : []).map(seriesById).filter(Boolean).slice(0, 5);
  } catch { return []; }
}

function setQuery(q) {
  ui.q = q;
  ui.terms = q.toLowerCase().split(/\s+/).filter(Boolean);
}

function setView(v) {
  ui.view = v === 'table' ? 'table' : 'tree';
  try { localStorage.setItem(VIEW_KEY, ui.view); } catch { /* storage off */ }
  ui.act = -1;
  syncView();
  place();
  render();
  bodyEl.scrollTop = 0;
  bodyEl.scrollLeft = 0;
  if (ui.terms.length) firstAct();
}

function syncView() {
  root.classList.toggle('is-table', ui.view === 'table');
  root.querySelectorAll('[data-view]').forEach((b) => {
    const on = b.dataset.view === ui.view;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  groupEl.hidden = ui.view !== 'table';
}

/** Desktop: a popover under the lens bar. Phones: CSS makes it a full-width sheet. */
function place() {
  const s = root.style;
  if (isPhone()) { ['--ex-l', '--ex-t', '--ex-w', '--ex-h'].forEach((k) => s.removeProperty(k)); return; }
  const lb = document.getElementById('lensbar').getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.min(ui.view === 'table' ? 980 : 760, vw * (ui.view === 'table' ? 0.94 : 0.92), vw - 16);
  const left = Math.max(8, Math.min(vw - w - 8, lb.left + lb.width / 2 - w / 2));
  const top = Math.round(lb.bottom + 8);
  const h = Math.max(240, Math.min(vh * 0.7, vh - top - 12));
  s.setProperty('--ex-l', `${Math.round(left)}px`);
  s.setProperty('--ex-t', `${top}px`);
  s.setProperty('--ex-w', `${Math.round(w)}px`);
  s.setProperty('--ex-h', `${Math.round(h)}px`);
}

// ---- describing a series ------------------------------------------------------------------------
const titleCase = (k) => String(k).toLowerCase().replace(/(^|[\s(&-])([a-z])/g, (m, a, b) => a + b.toUpperCase()).replace(/\b(And|Of|The)\b/g, (w) => w.toLowerCase());
const stateLabel = (key) => units()?.state?.find((u) => u.key === key)?.name || titleCase(key);
const years = (s) => {
  const y = s.years || [];
  if (!y.length) return '';
  return y.length > 1 ? `${periodLabel(y[0])}–${periodLabel(y[y.length - 1])}` : periodLabel(y[0]);
};
const unitOf = (s) => (s.type === 'categorical' ? 'categories' : s.unit || (s.format === 'pct' ? '%' : ''));
const where = (s) => (inElections(s) ? `${s.menu[1]} ${s.menu[2]}` : '');
const resOf = (s) => Object.keys(s.res_years || {}).map(Number).filter((r) => Number.isFinite(r)).sort((a, b) => a - b);

/** "N cities" from a note that says so ("eight cities") or that ends with a list of names. */
function cityInfo(note) {
  const t = String(note || '');
  const m = /\b(\d+|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+cities\b/i.exec(t);
  if (m) return { n: +m[1] || NUM[m[1].toLowerCase()] };
  const tail = t.split(';').pop().split(',').map((x) => x.trim()).filter(Boolean);
  if (tail.length >= 3 && tail.every((x) => /^[A-Z][A-Za-z .'-]{1,30}$/.test(x))) return { n: tail.length, names: tail };
  return null;
}

let COV = null;
/** Coverage badge: All India, the state(s) it covers, or the cities / selected areas of a sparse series. */
function coverage(s) {
  if (!COV) {
    COV = new Map();
    const bySparse = new Map();
    for (const x of allSeries()) {
      if (!x.sparse || x.states?.length) continue;
      const c = cityInfo(x.note);
      if (c) { const p = bySparse.get(x.sparse) || {}; bySparse.set(x.sparse, { n: c.n || p.n, names: c.names || p.names }); }
    }
    for (const x of allSeries()) {
      let c;
      if (x.states?.length) {
        const names = x.states.map(stateLabel);
        c = { kind: 'state', rank: 1, label: names.length > 2 ? `${names.length} states` : names.join(', '), title: `Covers ${names.join(', ')} only` };
      } else if (x.sparse) {
        const ci = bySparse.get(x.sparse);
        c = ci ? { kind: 'part', rank: 2, label: `${ci.n} cities`, title: ci.names ? `Covers ${ci.names.join(', ')}` : `Covers ${ci.n} cities only` }
          : { kind: 'part', rank: 3, label: 'Selected areas', title: 'Covers selected areas only' };
      } else c = { kind: 'all', rank: 0, label: 'All India', title: 'Covers all of India' };
      COV.set(x.id, c);
    }
  }
  return COV.get(s.id) || { kind: 'all', rank: 0, label: 'All India', title: '' };
}

function haystack(s) {
  const cov = coverage(s);
  return [s.label, s.id, s.group, s.note, unitOf(s), cov.label, cov.title, ...(s.menu || []), ...(s.states || []).map(stateLabel)].join(' ').toLowerCase();
}
const matches = (s, terms) => !terms.length || terms.every((t) => haystack(s).includes(t));

/** Escape text and wrap every search term in <mark>. */
function hl(text, terms = ui.terms) {
  const s = String(text ?? '');
  if (!terms.length || !s) return esc(s);
  const low = s.toLowerCase();
  const on = new Uint8Array(s.length);
  for (const t of terms) for (let i = low.indexOf(t); i >= 0; i = low.indexOf(t, i + t.length)) on.fill(1, i, i + t.length);
  let out = '';
  let open = false;
  for (let i = 0; i < s.length; i++) {
    if (!!on[i] !== open) { out += open ? '</mark>' : '<mark>'; open = !open; }
    out += esc(s[i]);
  }
  return open ? `${out}</mark>` : out;
}

const covBadge = (s) => { const c = coverage(s); return `<span class="ex-cov ${c.kind}" title="${esc(c.title)}">${hl(c.label)}</span>`; };
const resChips = (s) => {
  const have = resOf(s);
  return `<span class="ex-res">${CTX.cfg.hex.resolutions.map((r) => `<i class="${have.includes(r) ? '' : 'off'}" title="${have.includes(r) ? `H${r} hexagons` : `No H${r} data`}">H${r}</i>`).join('')}</span>`;
};

function groupRank(g) {
  const p = PREF.indexOf(g);
  if (p >= 0) return p;
  const c = (CTX.cfg.groups || []).indexOf(g);
  return c >= 0 ? 100 + c : 1000;
}
function groupList() {
  const gs = [...new Set(allSeries().map((s) => s.group))];
  return gs.sort((a, b) => groupRank(a) - groupRank(b) || a.localeCompare(b));
}

// ---- rendering ----------------------------------------------------------------------------------
function render() {
  if (!root || !ui.open) return;
  if (ui.view === 'table') renderTable();
  else renderTree();
  const n = allSeries().length;
  const shown = ui.view === 'table'
    ? bodyEl.querySelectorAll('tbody tr[data-v]').length
    : allSeries().filter((s) => matches(s, ui.terms)).length;
  countEl.textContent = shown === n ? `${n} variables` : `${shown} of ${n}`;
}

function rowHTML(s, st) {
  const on = st.var === s.id;
  const note = s.note || '';
  const yr = years(s);
  return `<button class="ex-row${on ? ' on' : ''}" data-v="${esc(s.id)}"${on ? ' aria-current="true"' : ''}>
    <span class="ex-l"><span class="ex-lt">${hl(s.label)}</span>${yr ? `<span class="ex-y">${esc(yr)}</span>` : ''}</span>
    <span class="ex-d"${note ? ` title="${esc(note)}"` : ''}>${note ? hl(note) : `<span class="ex-dim">${esc(unitOf(s) ? `Unit: ${unitOf(s)}` : s.group)}</span>`}</span>
    <span class="ex-meta">${covBadge(s)}${resChips(s)}</span>
  </button>`;
}

function noneRow(st) {
  return `<button class="ex-row ex-none${st.var === 'none' ? ' on' : ''}" data-v="none"${st.var === 'none' ? ' aria-current="true"' : ''}>
    <span class="ex-l"><span class="ex-lt">${hl('None (boundaries only)')}</span></span>
    <span class="ex-d"><span class="ex-dim">No colour: only the boundary lines and the base map</span></span></button>`;
}

function renderTree() {
  const st = CTX.S.get();
  const terms = ui.terms;
  const items = allSeries().filter((s) => matches(s, terms));
  const row = (s) => rowHTML(s, st);
  const byGroup = (list) => {
    const g = new Map();
    for (const s of list) { if (!g.has(s.group)) g.set(s.group, []); g.get(s.group).push(s); }
    return [...g.entries()].sort((a, b) => groupRank(a[0]) - groupRank(b[0]) || a[0].localeCompare(b[0]));
  };
  const noneHit = !terms.length || terms.every((t) => NONE_WORDS.includes(t));
  if (terms.length) { // a search flattens the tree: groups with their matches
    bodyEl.innerHTML = items.length || noneHit
      ? `${byGroup(items).map(([g, ss]) => `<section class="ex-sec"><h3 class="ex-h">${hl(g)}<small>${ss.length}</small></h3>${ss.map(row).join('')}</section>`).join('')}
        ${noneHit ? `<section class="ex-sec">${noneRow(st)}</section>` : ''}`
      : `<div class="ex-empty"><b>Nothing matches “${esc(ui.q.trim())}”.</b><span>Try one word: a theme (forest, price), a source (GHSL, OpenStreetMap) or a state.</span></div>`;
    return;
  }
  const open = (node, dflt) => (treeOpen.has(node) ? treeOpen.get(node) : dflt);
  const grp = (node, title, ss, dflt, extra = '') => `<details class="ex-g" data-node="${esc(node)}"${open(node, dflt) ? ' open' : ''}>
      <summary><span class="ex-gt">${esc(title)}</span>${extra}<small>${ss.length}</small></summary>${ss.map(row).join('')}</details>`;

  // Recent: chips
  const rec = recent();
  const recentHTML = rec.length ? `<div class="ex-recent"><span class="ex-rl">Recent</span>${rec.map((s) => `<button class="ex-chip${st.var === s.id ? ' on' : ''}" data-v="${esc(s.id)}" title="${esc(`${s.label}${where(s) ? ` · ${where(s)}` : ''}`)}">${esc(s.label)}${where(s) ? `<small>${esc(where(s))}</small>` : ''}</button>`).join('')}</div>` : '';

  // Featured
  const featured = (CTX.cfg.featured || []).map(seriesById).filter((s) => s && !inElections(s));
  const featHTML = featured.length ? grp('Featured', 'Featured', featured, true) : '';

  // Elections > state > house > variables; the state you are in opens first
  const tree = new Map();
  for (const s of items) {
    if (!inElections(s)) continue;
    const [, stName, house] = s.menu;
    if (!tree.has(stName)) tree.set(stName, { keys: s.states || [], houses: new Map() });
    const t = tree.get(stName);
    if (!t.houses.has(house)) t.houses.set(house, []);
    t.houses.get(house).push(s);
  }
  const curKey = CTX.rt.curState >= 0 ? units()?.state?.[CTX.rt.curState]?.key : null;
  const curVar = seriesById(st.var);
  const here = [...tree.keys()].find((k) => tree.get(k).keys.includes(curKey));
  const order = [...tree.keys()].sort((a, b) => (b === here) - (a === here) || a.localeCompare(b));
  const varIn = (stName, house) => !!stName && curVar?.menu?.[0] === 'Elections' && curVar.menu[1] === stName && (!house || curVar.menu[2] === house);
  const yearsOf = (ss) => [...new Set(ss.flatMap((s) => s.years))].sort().map((y) => periodLabel(y)).join(' · ');
  // a fourth menu level (AC/PC results: "<year> results") nests under the house, latest first
  const leaves = (hk, ss) => {
    const subs = new Map();
    for (const s of ss) if (s.menu[3]) { if (!subs.has(s.menu[3])) subs.set(s.menu[3], []); subs.get(s.menu[3]).push(s); }
    return ss.filter((s) => !s.menu[3]).map(row).join('') + [...subs.keys()].sort((a, b) => b.localeCompare(a)).map((k) => {
      const nk = `${hk}/${k}`;
      return `<details class="ex-g4" data-node="${esc(nk)}"${open(nk, subs.get(k).some((s) => s.id === st.var)) ? ' open' : ''}><summary>${esc(k)}<small>${subs.get(k).length}</small></summary>${subs.get(k).map(row).join('')}</details>`;
    }).join('');
  };
  const nEl = [...tree.values()].reduce((a, t) => a + [...t.houses.values()].reduce((b, ss) => b + ss.length, 0), 0);
  const elections = tree.size ? `<details class="ex-g" data-node="Elections"${open('Elections', !!here || varIn(curVar?.menu?.[1])) ? ' open' : ''}>
      <summary><span class="ex-gt">Elections</span>${here ? `<span class="ex-here">${esc(here)} first</span>` : ''}<small>${nEl}</small></summary>
      ${order.map((stName) => {
    const t = tree.get(stName);
    const nodeKey = `Elections/${stName}`;
    const n = [...t.houses.values()].reduce((b, ss) => b + ss.length, 0);
    return `<details class="ex-g2" data-node="${esc(nodeKey)}"${open(nodeKey, stName === here || varIn(stName)) ? ' open' : ''}><summary>${esc(stName)}<small>${n}</small></summary>
        ${[...t.houses.entries()].map(([house, ss]) => {
      const hk = `${nodeKey}/${house}`;
      return `<details class="ex-g3" data-node="${esc(hk)}"${open(hk, stName === here || varIn(stName, house)) ? ' open' : ''}><summary>${esc(house)}<small>${esc(yearsOf(ss))}</small></summary>${leaves(hk, ss)}</details>`;
    }).join('')}</details>`;
  }).join('')}</details>` : '';

  // every other group, the whole catalogue (featured ones too)
  const rest = byGroup(items.filter((s) => !inElections(s)));
  bodyEl.innerHTML = `${recentHTML}${featHTML}${elections}
    ${rest.map(([g, ss]) => grp(`g/${g}`, g, ss, true)).join('')}
    <div class="ex-sec ex-endrow">${noneRow(st)}</div>`;
}

/** A period as a fractional year: 2025, or 202603 (March 2026) → 2026.17. */
const yv = (p) => (p == null ? 0 : p < 100000 ? p : Math.floor(p / 100) + ((p % 100) - 1) / 12);

const COLS = [['label', 'Variable'], ['group', 'Group'], ['unit', 'Unit'], ['years', 'Years'], ['res', 'Resolution'], ['cov', 'Coverage'], ['note', 'Source / notes']];

function cmp(key) {
  const byLabel = (a, b) => a.label.localeCompare(b.label);
  const f = {
    label: byLabel,
    group: (a, b) => a.group.localeCompare(b.group),
    unit: (a, b) => (unitOf(a) || '￿').localeCompare(unitOf(b) || '￿'),
    years: (a, b) => yv(a.years[0]) - yv(b.years[0]) || yv(a.years[a.years.length - 1]) - yv(b.years[b.years.length - 1]) || a.years.length - b.years.length,
    res: (a, b) => Math.max(0, ...resOf(a)) - Math.max(0, ...resOf(b)) || resOf(a).length - resOf(b).length,
    cov: (a, b) => coverage(a).rank - coverage(b).rank || coverage(a).label.localeCompare(coverage(b).label),
    note: (a, b) => (a.note || '￿').localeCompare(b.note || '￿'),
  }[key] || byLabel;
  return (a, b) => f(a, b) * ui.dir || byLabel(a, b);
}

function sortBy(key) {
  if (ui.sort === key) ui.dir = -ui.dir;
  else { ui.sort = key; ui.dir = 1; }
  render();
  bodyEl.querySelector(`[data-sort="${key}"]`)?.focus({ preventScroll: true });
  ui.act = -1;
}

function renderTable() {
  const st = CTX.S.get();
  const all = allSeries();
  let rows = all.filter((s) => matches(s, ui.terms) && (!ui.group || s.group === ui.group));
  rows = ui.sort ? rows.slice().sort(cmp(ui.sort))
    : rows.slice().sort((a, b) => groupRank(a.group) - groupRank(b.group) || all.indexOf(a) - all.indexOf(b));
  const head = COLS.map(([k, l]) => {
    const on = ui.sort === k;
    return `<th scope="col" class="c-${k}"${on ? ` aria-sort="${ui.dir > 0 ? 'ascending' : 'descending'}"` : ''}><button data-sort="${k}" title="Sort by ${l.toLowerCase()}">${esc(l)}<i aria-hidden="true">${on ? (ui.dir > 0 ? '▲' : '▼') : '↕'}</i></button></th>`;
  }).join('');
  const body = rows.map((s) => {
    const on = st.var === s.id;
    const n = s.years.length;
    const yearly = s.years.every((y) => y < 100000);
    return `<tr data-v="${esc(s.id)}" class="${on ? 'on' : ''}"${on ? ' aria-current="true"' : ''}>
      <td class="c-label"><span class="ex-tl">${hl(s.label)}</span>${where(s) ? `<small>${esc(where(s))}</small>` : ''}<code>${hl(s.id)}</code></td>
      <td class="c-group">${hl(s.group)}</td>
      <td class="c-unit">${esc(unitOf(s) || '–')}</td>
      <td class="c-years">${esc(years(s) || '–')}${n > 1 ? `<small>${n} ${yearly ? 'years' : 'periods'}</small>` : ''}</td>
      <td class="c-res">${resChips(s)}</td>
      <td class="c-cov">${covBadge(s)}</td>
      <td class="c-note"><span${s.note ? ` title="${esc(s.note)}"` : ''}>${s.note ? hl(s.note) : '<span class="ex-dim">–</span>'}</span></td>
    </tr>`;
  }).join('');
  bodyEl.innerHTML = rows.length
    ? `<table class="ex-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
    : `<div class="ex-empty"><b>Nothing matches${ui.q.trim() ? ` “${esc(ui.q.trim())}”` : ''}${ui.group ? ` in ${esc(ui.group)}` : ''}.</b><span>Clear the search or choose All groups.</span></div>`;
}

// ---- keyboard -----------------------------------------------------------------------------------
function navItems() {
  const sel = ui.view === 'table' ? 'tbody tr[data-v]' : 'summary, [data-v]';
  return [...bodyEl.querySelectorAll(sel)].filter((el) => el.getClientRects().length);
}

function setAct(items = navItems()) {
  bodyEl.querySelector('#exAct')?.removeAttribute('id');
  bodyEl.querySelectorAll('.ex-act').forEach((el) => el.classList.remove('ex-act'));
  const el = items[ui.act];
  if (!el) { qEl.removeAttribute('aria-activedescendant'); return; }
  el.classList.add('ex-act');
  el.id = 'exAct';
  qEl.setAttribute('aria-activedescendant', 'exAct');
  const r = el.getBoundingClientRect();
  const b = bodyEl.getBoundingClientRect();
  const top = b.top + (bodyEl.querySelector('thead')?.offsetHeight || 0);
  if (r.top < top) bodyEl.scrollTop -= top - r.top + 6;
  else if (r.bottom > b.bottom) bodyEl.scrollTop += r.bottom - b.bottom + 6;
}

/** With a search or a group filter, the first match is the one Enter picks. */
function firstAct() {
  if (!ui.terms.length && !(ui.view === 'table' && ui.group)) { ui.act = -1; setAct(); return; }
  const items = navItems();
  ui.act = items.findIndex((el) => el.dataset.v);
  setAct(items);
}

function onKey(e) {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeExplorer(true); return; }
  if (e.target.tagName === 'SELECT') return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const items = navItems();
    if (!items.length) return;
    const d = e.key === 'ArrowDown' ? 1 : -1;
    ui.act = ui.act < 0 ? (d > 0 ? 0 : items.length - 1) : (ui.act + d + items.length) % items.length;
    setAct(items);
    return;
  }
  if (e.key !== 'Enter') return;
  // a focused button or summary does its own thing (click / toggle); from the search box, act on the active row
  if (e.target !== qEl && e.target.closest('button, summary')) return;
  const items = navItems();
  const it = items[ui.act] || (e.target === qEl && ui.terms.length ? items.find((el) => el.dataset.v) : null);
  if (!it) return;
  e.preventDefault();
  if (it.tagName === 'SUMMARY') {
    it.parentElement.open = !it.parentElement.open;
    ui.act = navItems().indexOf(it);
    setAct();
  } else pick(it.dataset.v, true);
}
