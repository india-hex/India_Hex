// Variable explorer: what the map shows. Opens from the lens bar's "Map shows" button, or with "/".
//   Tree     None (boundaries only), Elections > state > house > variables (and "<year> results"),
//            Featured > the headline variables, then a sub-list per theme
//   Columns  the same catalogue as drill columns, left to right: Category > State or Theme >
//            House and year > Variables, with a breadcrumb; phones show one column at a time
// A search flattens either view to the matches, in the same three-part order.
// Keyboard: ↑/↓ move, ←/→ move between columns, Enter picks (or opens), Escape clears a search
// in Columns, else closes.
import { esc, periodLabel } from '../scales.js';
import { allSeries, seriesById } from '../lens.js';
import { units } from '../data/units.js';

let CTX = null;
let root = null;
let scrim = null;
let bodyEl = null;
let qEl = null;
let countEl = null;
let footEl = null;
// path: the drill selection (['el', state, house key] or ['feat', theme] or ['none']);
// pc: the column a phone shows; kc / kr: the keyboard's column and row in Columns (kr -1: none yet)
const ui = { open: false, view: 'tree', q: '', terms: [], act: -1, path: [], pc: 0, kc: 0, kr: -1 };
const treeOpen = new Map(); // tree nodes the viewer opened or closed this visit
const VIEW_KEY = 'indiahex.explorer';
const PREF = ['People', 'Economy', 'Built environment', 'Land cover', 'Forest', 'Commerce', 'Property'];
const NUM = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const NONE_WORDS = 'none boundaries only outline';
const NONE_LABEL = 'None (boundaries only)';
const HEADLINE = '*'; // the Featured theme key of the headline variables
const SEP = '\u0001'; // house key: "<house>\u0001<sub-list>" ('' for the hexagon series)

const isPhone = () => window.matchMedia('(max-width: 820px)').matches;
const finePointer = () => window.matchMedia('(pointer: fine)').matches;
const typing = (el) => !!el && (['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) || el.isContentEditable);
const inElections = (s) => s.menu?.[0] === 'Elections' && s.menu.length >= 3;

export const isExplorerOpen = () => ui.open;

export function initExplorer(ctx) {
  CTX = ctx;
  try { const v = localStorage.getItem(VIEW_KEY); if (v === 'tree' || v === 'cols') ui.view = v; else if (v === 'table') ui.view = 'cols'; } catch { /* private mode */ }
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
          <button data-view="tree" aria-pressed="false">Tree</button><button data-view="cols" aria-pressed="false">Columns</button>
        </div>
        <button class="ex-x" id="exClose" aria-label="Close" title="Close (Esc)"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      </div>
      <div class="ex-tools">
        <label class="ex-q"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>
          <input id="exQ" type="search" placeholder="Search variables or states" autocomplete="off" spellcheck="false" aria-label="Search variables" aria-controls="exBody"><kbd>/</kbd></label>
      </div>
    </div>
    <div class="ex-body" id="exBody"></div>
    <div class="ex-foot" id="exFoot"></div>`;
  document.body.append(scrim, root);
  bodyEl = root.querySelector('#exBody');
  qEl = root.querySelector('#exQ');
  countEl = root.querySelector('#exCount');
  footEl = root.querySelector('#exFoot');

  qEl.addEventListener('input', () => { setQuery(qEl.value); render(); firstAct(); });
  root.querySelector('#exClose').addEventListener('click', (e) => closeExplorer(e.detail === 0));
  root.querySelector('.ex-view').addEventListener('click', (e) => {
    const b = e.target.closest('[data-view]');
    if (b) setView(b.dataset.view);
  });
  bodyEl.addEventListener('click', onClick);
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
    if (changed.has('var') && ui.open) render();
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
  preselect();
  render();
  document.getElementById('varBtn')?.setAttribute('aria-expanded', 'true');
  if (focus) qEl.focus({ preventScroll: true });
  revealCurrent();
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

function setQuery(q) {
  ui.q = q;
  ui.terms = q.toLowerCase().split(/\s+/).filter(Boolean);
}

function setView(v) {
  ui.view = v === 'cols' ? 'cols' : 'tree';
  try { localStorage.setItem(VIEW_KEY, ui.view); } catch { /* storage off */ }
  ui.act = -1;
  syncView();
  place();
  preselect();
  render();
  bodyEl.scrollTop = 0;
  bodyEl.scrollLeft = 0;
  if (ui.terms.length) firstAct();
  else revealCurrent();
}

function syncView() {
  root.classList.toggle('is-cols', ui.view === 'cols');
  root.querySelectorAll('[data-view]').forEach((b) => {
    const on = b.dataset.view === ui.view;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

/** Desktop: a popover under the lens bar. Phones: CSS makes it a full-width sheet. */
function place() {
  const s = root.style;
  if (isPhone()) { ['--ex-l', '--ex-t', '--ex-w', '--ex-h'].forEach((k) => s.removeProperty(k)); return; }
  const lb = document.getElementById('lensbar').getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const cols = ui.view === 'cols';
  const w = Math.min(cols ? 1000 : 760, vw * (cols ? 0.94 : 0.92), vw - 16);
  const left = Math.max(8, Math.min(vw - w - 8, lb.left + lb.width / 2 - w / 2));
  const top = Math.round(lb.bottom + 8);
  const h = Math.max(240, Math.min(vh * (cols ? 0.74 : 0.7), vh - top - 12));
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
const resOf = (s) => Object.keys(s.res_years || {}).map(Number).filter((r) => Number.isFinite(r)).sort((a, b) => a - b);
const yearsOf = (ss) => [...new Set(ss.flatMap((s) => s.years || []))].sort((a, b) => a - b).map((y) => periodLabel(y)).join(' · ');

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
        c = { kind: 'state', label: names.length > 2 ? `${names.length} states` : names.join(', '), title: `Covers ${names.join(', ')} only` };
      } else if (x.sparse) {
        const ci = bySparse.get(x.sparse);
        c = ci ? { kind: 'part', label: `${ci.n} cities`, title: ci.names ? `Covers ${ci.names.join(', ')}` : `Covers ${ci.n} cities only` }
          : { kind: 'part', label: 'Selected areas', title: 'Covers selected areas only' };
      } else c = { kind: 'all', label: 'All India', title: 'Covers all of India' };
      COV.set(x.id, c);
    }
  }
  return COV.get(s.id) || { kind: 'all', label: 'All India', title: '' };
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
/** H6 / H7 / H8 chips; a unit-only results series (no hexagons) shows the levels it maps instead. */
const resChips = (s) => {
  const have = resOf(s);
  if (!have.length && s.unit_levels) {
    const lv = s.unit_levels.filter((l) => l === 'ac' || l === 'pc').map((l) => l.toUpperCase());
    return `<span class="ex-res"><i class="u" title="No hexagons: mapped by constituency">${esc(lv.join(' · ') || 'AC · PC')}</i></span>`;
  }
  return `<span class="ex-res">${CTX.cfg.hex.resolutions.map((r) => `<i class="${have.includes(r) ? '' : 'off'}" title="${have.includes(r) ? `H${r} hexagons` : `No H${r} data`}">H${r}</i>`).join('')}</span>`;
};

function groupRank(g) {
  const p = PREF.indexOf(g);
  if (p >= 0) return p;
  const c = (CTX.cfg.groups || []).indexOf(g);
  return c >= 0 ? 100 + c : 1000;
}

// ---- the catalogue: None, Elections, Featured ----------------------------------------------------
let CAT = null;
let CAT_N = -1;
/** states: name → { keys, houses: house → sub ('' or "<year> results") → series }; headline; themes: group → series */
function catalog() {
  const all = allSeries();
  if (CAT && CAT_N === all.length) return CAT;
  const headline = (CTX.cfg.featured || []).map(seriesById).filter((s) => s && !inElections(s));
  const head = new Set(headline.map((s) => s.id));
  const states = new Map();
  const themes = new Map();
  for (const s of all) {
    if (inElections(s)) {
      const [, stName, house, sub = ''] = s.menu;
      if (!states.has(stName)) states.set(stName, { keys: new Set(), houses: new Map() });
      const t = states.get(stName);
      (s.states || []).forEach((k) => t.keys.add(k));
      if (!t.houses.has(house)) t.houses.set(house, new Map());
      const h = t.houses.get(house);
      if (!h.has(sub)) h.set(sub, []);
      h.get(sub).push(s);
    } else if (!head.has(s.id)) {
      if (!themes.has(s.group)) themes.set(s.group, []);
      themes.get(s.group).push(s);
    }
  }
  // houses A–Z (Assembly, Lok Sabha); in a house the hexagon series first, then results latest first
  for (const t of states.values()) {
    t.houses = new Map([...t.houses.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([h, subs]) => [h, new Map([...subs.entries()].sort((a, b) => (a[0] !== '') - (b[0] !== '') || b[0].localeCompare(a[0])))]));
    t.n = [...t.houses.values()].reduce((a, subs) => a + [...subs.values()].reduce((b, ss) => b + ss.length, 0), 0);
  }
  const themeList = [...themes.entries()].sort((a, b) => groupRank(a[0]) - groupRank(b[0]) || a[0].localeCompare(b[0]));
  CAT = { states, headline, themes: new Map(themeList), nEl: [...states.values()].reduce((a, t) => a + t.n, 0) };
  CAT_N = all.length;
  return CAT;
}

/** The state the viewer is in (its Elections entry opens and sorts first), then A–Z. */
function stateOrder() {
  const C = catalog();
  const curKey = CTX.rt.curState >= 0 ? units()?.state?.[CTX.rt.curState]?.key : null;
  const here = [...C.states.keys()].find((k) => C.states.get(k).keys.has(curKey)) || null;
  return { here, order: [...C.states.keys()].sort((a, b) => (b === here) - (a === here) || a.localeCompare(b)) };
}

const houseKey = (house, sub) => `${house}${SEP}${sub}`;
const subLabel = (sub, ss) => sub || yearsOf(ss);
const houseLabel = (st, hk) => {
  const [house, sub] = hk.split(SEP);
  return `${house} ${subLabel(sub, catalog().states.get(st)?.houses.get(house)?.get(sub) || [])}`;
};
const themeLabel = (k) => (k === HEADLINE ? 'Headline' : k);

/** The drill path to a variable. */
function pathOf(id) {
  if (id === 'none') return ['none'];
  const s = seriesById(id);
  if (!s) return [];
  if (inElections(s)) return ['el', s.menu[1], houseKey(s.menu[2], s.menu[3] || '')];
  return ['feat', catalog().headline.includes(s) ? HEADLINE : s.group];
}

// ---- rendering ----------------------------------------------------------------------------------
function render() {
  if (!root || !ui.open) return;
  root.classList.toggle('is-search', !!ui.terms.length);
  if (ui.terms.length) renderSearch();
  else if (ui.view === 'cols') renderCols();
  else renderTree();
  const n = allSeries().length;
  const shown = allSeries().filter((s) => matches(s, ui.terms)).length;
  countEl.textContent = shown === n ? `${n} variables` : `${shown} of ${n}`;
  const cols = ui.view === 'cols' && !ui.terms.length;
  footEl.innerHTML = `<span><kbd>↑</kbd><kbd>↓</kbd>${cols ? '<kbd>←</kbd><kbd>→</kbd>' : ''} move</span><span><kbd>Enter</kbd> ${cols ? 'open / show' : 'show on map'}</span><span><kbd>Esc</kbd> ${ui.view === 'cols' && ui.terms.length ? 'clear search' : 'close'}</span><span class="ex-foot-r">${n} variables</span>`;
}

function rowHTML(s, st) {
  const on = st.var === s.id;
  const yr = years(s);
  return `<button class="ex-row${on ? ' on' : ''}" data-v="${esc(s.id)}"${on ? ' aria-current="true"' : ''}>
    <span class="ex-l"><span class="ex-lt">${hl(s.label)}</span>${yr ? `<span class="ex-y">${esc(yr)}</span>` : ''}</span>
    <span class="ex-meta">${covBadge(s)}${resChips(s)}</span>
  </button>`;
}

function noneRow(st) {
  const on = st.var === 'none';
  return `<button class="ex-row ex-none${on ? ' on' : ''}" data-v="none"${on ? ' aria-current="true"' : ''}>
    <span class="ex-l"><span class="ex-lt">${hl(NONE_LABEL)}</span></span></button>`;
}

function renderTree() {
  const st = CTX.S.get();
  const C = catalog();
  const row = (s) => rowHTML(s, st);
  const open = (node, dflt) => (treeOpen.has(node) ? treeOpen.get(node) : dflt);
  const curVar = seriesById(st.var);
  const has = (ss) => ss.some((s) => s.id === st.var);

  // Elections > state > house > variables, and a fourth level "<year> results"; the state you are in first
  const { here, order } = stateOrder();
  const varIn = (stName, house) => inElections(curVar || {}) && curVar.menu[1] === stName && (!house || curVar.menu[2] === house);
  const elections = C.states.size ? `<details class="ex-g ex-lv-el" data-node="Elections"${open('Elections', !!here || inElections(curVar || {})) ? ' open' : ''}>
      <summary><span class="ex-gt">Elections</span>${here ? `<span class="ex-here">${esc(here)} first</span>` : ''}<small>${C.nEl}</small></summary>
      ${order.map((stName) => {
    const t = C.states.get(stName);
    const nodeKey = `Elections/${stName}`;
    return `<details class="ex-g2" data-node="${esc(nodeKey)}"${open(nodeKey, stName === here || varIn(stName)) ? ' open' : ''}><summary>${esc(stName)}<small>${t.n}</small></summary>
        ${[...t.houses.entries()].map(([house, subs]) => {
      const hk = `${nodeKey}/${house}`;
      const plain = subs.get('') || [];
      const nested = [...subs.entries()].filter(([k]) => k);
      return `<details class="ex-g3" data-node="${esc(hk)}"${open(hk, stName === here || varIn(stName, house)) ? ' open' : ''}><summary>${esc(house)}<small>${esc(yearsOf(plain))}</small></summary>
          ${plain.map(row).join('')}${nested.map(([k, ss]) => {
        const nk = `${hk}/${k}`;
        return `<details class="ex-g4" data-node="${esc(nk)}"${open(nk, has(ss)) ? ' open' : ''}><summary>${esc(k)}<small>${ss.length}</small></summary>${ss.map(row).join('')}</details>`;
      }).join('')}</details>`;
    }).join('')}</details>`;
  }).join('')}</details>` : '';

  // Featured: the headline variables, then a sub-list per theme
  const nFeat = C.headline.length + [...C.themes.values()].reduce((a, ss) => a + ss.length, 0);
  const featured = `<details class="ex-g ex-lv-ft" data-node="Featured"${open('Featured', true) ? ' open' : ''}>
      <summary><span class="ex-gt">Featured</span><small>${nFeat}</small></summary>
      ${C.headline.map(row).join('')}
      ${[...C.themes.entries()].map(([g, ss]) => {
    const nk = `Featured/${g}`;
    return `<details class="ex-g2 ex-theme" data-node="${esc(nk)}"${open(nk, has(ss)) ? ' open' : ''}><summary>${esc(g)}<small>${ss.length}</small></summary>${ss.map(row).join('')}</details>`;
  }).join('')}</details>`;

  bodyEl.innerHTML = `<div class="ex-sec ex-toprow">${noneRow(st)}</div>${elections}${featured}`;
}

/** A search, in either view: the matches in the same three-part order, with a heading per list. */
function renderSearch() {
  const st = CTX.S.get();
  const C = catalog();
  const terms = ui.terms;
  const row = (s) => rowHTML(s, st);
  const noneHit = terms.every((t) => NONE_WORDS.includes(t));
  const sub = (title, ss) => (ss.length ? `<h4 class="ex-h4">${hl(title)}<small>${ss.length}</small></h4>${ss.map(row).join('')}` : '');
  let nEl = 0;
  const el = stateOrder().order.map((stName) => [...C.states.get(stName).houses.entries()].map(([house, subs]) => [...subs.entries()].map(([k, ss]) => {
    const m = ss.filter((s) => matches(s, terms));
    nEl += m.length;
    return sub(`${stName} · ${house} ${subLabel(k, ss)}`, m);
  }).join('')).join('')).join('');
  const head = C.headline.filter((s) => matches(s, terms));
  let nFt = head.length;
  const ft = sub('Headline', head) + [...C.themes.entries()].map(([g, ss]) => {
    const m = ss.filter((s) => matches(s, terms));
    nFt += m.length;
    return sub(g, m);
  }).join('');
  bodyEl.innerHTML = noneHit || nEl || nFt
    ? `${noneHit ? `<section class="ex-sec ex-toprow">${noneRow(st)}</section>` : ''}
      ${nEl ? `<section class="ex-sec ex-lv-el"><h3 class="ex-h">Elections<small>${nEl}</small></h3>${el}</section>` : ''}
      ${nFt ? `<section class="ex-sec ex-lv-ft"><h3 class="ex-h">Featured<small>${nFt}</small></h3>${ft}</section>` : ''}`
    : `<div class="ex-empty"><b>Nothing matches “${esc(ui.q.trim())}”.</b><span>Try one word: a theme (forest, price), a party or a state.</span></div>`;
}

// ---- drill columns ------------------------------------------------------------------------------
/** The columns for a path, the path cut back to what exists. Each column: title, level, rows (nav order). */
function columns(path = ui.path) {
  const C = catalog();
  const st = CTX.S.get();
  const cols = [];
  const p = [];
  const item = (k, label, extra = {}) => ({ k, label, ...extra });
  cols.push({ title: 'Category', lv: 1, rows: [
    item('none', NONE_LABEL, { v: 'none', on: st.var === 'none' }),
    item('el', 'Elections', { n: `${C.states.size} states`, next: true }),
    item('feat', 'Featured', { n: `${C.headline.length + [...C.themes.values()].reduce((a, ss) => a + ss.length, 0)}`, next: true }),
  ] });
  const [c0, c1, c2] = path;
  if (c0 === 'none') p.push('none');
  if (c0 === 'el' && C.states.size) {
    p.push('el');
    const { here, order } = stateOrder();
    cols.push({ title: 'State', lv: 2, rows: order.map((s) => item(s, s, { n: `${C.states.get(s).n}`, here: s === here, next: true })) });
    const t = C.states.get(c1);
    if (t) {
      p.push(c1);
      const rows = [];
      for (const [house, subs] of t.houses) {
        rows.push({ head: house });
        for (const [k, ss] of subs) rows.push(item(houseKey(house, k), subLabel(k, ss), { n: `${ss.length}`, tag: k ? '' : 'Hexagons', next: true }));
      }
      cols.push({ title: 'House · year', lv: 3, rows });
      const [house, k] = String(c2 || '').split(SEP);
      const ss = c2 != null && t.houses.get(house)?.get(k);
      if (ss) { p.push(c2); cols.push({ title: 'Variables', lv: 4, vars: ss }); }
    }
  } else if (c0 === 'feat') {
    p.push('feat');
    const rows = [];
    if (C.headline.length) rows.push(item(HEADLINE, 'Headline', { n: `${C.headline.length}`, next: true }));
    for (const [g, ss] of C.themes) rows.push(item(g, g, { n: `${ss.length}`, next: true }));
    cols.push({ title: 'Theme', lv: 2, rows });
    const ss = c1 === HEADLINE ? C.headline : C.themes.get(c1);
    if (ss?.length) { p.push(c1); cols.push({ title: 'Variables', lv: 4, vars: ss }); }
  }
  for (const c of cols) if (c.vars) c.rows = c.vars.map((s) => ({ v: s.id }));
  return { cols, path: p };
}

/** Open the view on the variable on the map. */
function preselect() {
  const { cols, path } = columns(pathOf(CTX.S.get().var));
  ui.path = path;
  ui.pc = cols.length - 1;
  ui.kc = ui.pc;
  ui.kr = -1;
}

const navRows = (c) => (c.rows || []).filter((r) => !r.head);
/** The row of a column that is selected: the path's entry, or in the variables column the one on the map. */
function selIndex(cols, i) {
  const rows = navRows(cols[i]);
  if (cols[i].vars) return rows.findIndex((r) => r.v === CTX.S.get().var);
  return rows.findIndex((r) => r.k === ui.path[i]);
}

function renderCols() {
  const st = CTX.S.get();
  const { cols, path } = columns();
  ui.path = path;
  ui.pc = Math.max(0, Math.min(ui.pc, cols.length - 1));
  ui.kc = Math.max(0, Math.min(ui.kc, cols.length - 1));
  // keep each column's scroll position across the redraw
  const scroll = new Map([...bodyEl.querySelectorAll('.ex-col')].map((el) => [el.dataset.col, el.querySelector('.ex-cl')?.scrollTop || 0]));
  const hadFocus = bodyEl.contains(document.activeElement);

  const crumbs = [`<button class="ex-cr" data-crumb="-1">All</button>`, ...path.map((k, i) => {
    const label = i === 0 ? { none: 'None', el: 'Elections', feat: 'Featured' }[k] : path[0] === 'el' ? (i === 1 ? k : houseLabel(path[1], k)) : themeLabel(k);
    const last = i === path.length - 1;
    return `<span class="ex-sep" aria-hidden="true">›</span><button class="ex-cr lv${i + 1}${last ? ' last' : ''}" data-crumb="${i}"${last ? ' aria-current="location"' : ''}>${esc(label)}</button>`;
  })].join('');

  const colHTML = (c, i) => {
    const sel = path[i];
    let body;
    if (c.vars) body = c.vars.map((s) => rowHTML(s, st).replace('class="ex-row', `data-c="${i}" class="ex-row ex-ci`)).join('');
    else {
      body = c.rows.map((r) => {
        if (r.head) return `<h4 class="ex-chd">${esc(r.head)}</h4>`;
        const on = r.k === sel;
        return `<button class="ex-ci${on ? ' sel' : ''}${r.on ? ' on' : ''}" data-c="${i}" data-k="${esc(r.k)}"${r.v ? ` data-v="${esc(r.v)}"` : ''}${on ? ' aria-selected="true"' : ''}>
          <span class="ex-cit">${esc(r.label)}${r.here ? '<em class="ex-here">here</em>' : ''}</span>
          ${r.tag ? `<span class="ex-tag${r.tag === 'Hexagons' ? '' : ' u'}">${esc(r.tag)}</span>` : ''}${r.n ? `<small>${esc(r.n)}</small>` : ''}${r.next ? '<i class="ex-chev" aria-hidden="true"></i>' : ''}</button>`;
      }).join('');
    }
    const n = c.vars ? c.vars.length : navRows(c).length;
    return `<section class="ex-col lv${c.lv}${c.vars ? ' vars' : ''}${i === ui.pc ? ' cur' : ''}" data-col="${i}" role="group" aria-label="${esc(c.title)}">
      <h3 class="ex-ch"><span>${esc(c.title)}</span><small>${n}</small></h3><div class="ex-cl">${body}</div></section>`;
  };
  const last = cols[cols.length - 1];
  const hint = last.vars ? '' : `<div class="ex-col ex-hint" aria-hidden="true"><span>${esc(path[0] === 'none' ? (st.var === 'none' ? 'The map shows boundaries only' : 'Pick None to show boundaries only') : last.title === 'Category' ? 'Choose a category' : `Choose ${last.title === 'State' ? 'a state' : last.title === 'Theme' ? 'a theme' : 'a house and year'}`)}</span></div>`;
  const back = ui.pc > 0 ? `<button class="ex-back" data-back aria-label="Back to ${esc(cols[ui.pc - 1].title)}"><svg viewBox="0 0 24 24"><path d="M14.5 6l-6 6 6 6"/></svg></button>` : '';
  bodyEl.innerHTML = `<nav class="ex-crumbs" aria-label="Path">${back}<span class="ex-crl">${crumbs}</span></nav>
    <div class="ex-cols">${cols.map(colHTML).join('')}${hint}</div>`;

  bodyEl.querySelectorAll('.ex-col').forEach((el) => {
    const l = el.querySelector('.ex-cl');
    if (l && scroll.has(el.dataset.col)) l.scrollTop = scroll.get(el.dataset.col);
  });
  setColAct(cols);
  if (hadFocus) {
    const c = `.ex-col[data-col="${ui.kc}"]`;
    (bodyEl.querySelector('#exAct') || bodyEl.querySelector(`${c} .ex-ci.sel, ${c} .ex-row.on`) || bodyEl.querySelector(`${c} .ex-ci`) || qEl).focus({ preventScroll: true });
  }
}

/** Mark the keyboard's row and keep it (or, before any key, each selection) in view. */
function setColAct(cols) {
  qEl.removeAttribute('aria-activedescendant');
  const list = (i) => [...bodyEl.querySelectorAll(`.ex-col[data-col="${i}"] .ex-ci`)];
  if (ui.kr >= 0) {
    const el = list(ui.kc)[ui.kr];
    if (el) {
      el.classList.add('ex-act');
      el.id = 'exAct';
      qEl.setAttribute('aria-activedescendant', 'exAct');
      intoView(el);
    }
  }
  return cols;
}

function intoView(el, center = false) {
  const box = el.closest('.ex-cl') || bodyEl;
  const r = el.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  if (center) { box.scrollTop += r.top - b.top - box.clientHeight / 3; return; }
  if (r.top < b.top) box.scrollTop -= b.top - r.top + 6;
  else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom + 6;
}

/** Bring the variable on the map (and in Columns each selected entry) into view. */
function revealCurrent() {
  if (ui.view === 'cols' && !ui.terms.length) {
    bodyEl.querySelectorAll('.ex-ci.sel, .ex-col.vars .ex-row.on').forEach((el) => intoView(el, true));
    const cl = bodyEl.querySelector('.ex-cols');
    if (cl) cl.scrollLeft = cl.scrollWidth;
    return;
  }
  const cur = bodyEl.querySelector('.ex-row.on');
  if (cur) bodyEl.scrollTop = Math.max(0, cur.getBoundingClientRect().top - bodyEl.getBoundingClientRect().top - bodyEl.clientHeight / 3);
}

/** Choose entry k of column i: opens the next column (phones move to it). */
function choose(i, k, { kr = -1, advance = true } = {}) {
  ui.path = [...ui.path.slice(0, i), k];
  const { cols } = columns();
  ui.kc = i;
  ui.kr = kr;
  ui.pc = advance && cols.length > i + 1 ? i + 1 : i;
  render();
  const next = bodyEl.querySelector(`.ex-col[data-col="${i + 1}"] .ex-cl`);
  if (next) next.scrollTop = 0;
}

function onClick(e) {
  const cr = e.target.closest('[data-crumb]');
  if (cr) {
    const i = +cr.dataset.crumb;
    ui.path = ui.path.slice(0, i + 1);
    ui.pc = i + 1;
    ui.kc = ui.pc;
    ui.kr = -1;
    render();
    return;
  }
  if (e.target.closest('[data-back]')) {
    ui.pc = Math.max(0, ui.pc - 1);
    ui.kc = ui.pc;
    ui.kr = -1;
    render();
    return;
  }
  const it = e.target.closest('[data-v], [data-k]');
  if (!it) return;
  if (it.dataset.v) { pick(it.dataset.v, e.detail === 0); return; }
  choose(+it.dataset.c, it.dataset.k);
}

// ---- keyboard -----------------------------------------------------------------------------------
function navItems() {
  return [...bodyEl.querySelectorAll('summary, [data-v]')].filter((el) => el.getClientRects().length);
}

function setAct(items = navItems()) {
  bodyEl.querySelector('#exAct')?.removeAttribute('id');
  bodyEl.querySelectorAll('.ex-act').forEach((el) => el.classList.remove('ex-act'));
  const el = items[ui.act];
  if (!el) { qEl.removeAttribute('aria-activedescendant'); return; }
  el.classList.add('ex-act');
  el.id = 'exAct';
  qEl.setAttribute('aria-activedescendant', 'exAct');
  intoView(el);
}

/** With a search, the first match is the one Enter picks. */
function firstAct() {
  if (!ui.terms.length) { ui.act = -1; if (ui.view === 'tree') setAct(); return; }
  const items = navItems();
  ui.act = items.findIndex((el) => el.dataset.v);
  setAct(items);
}

/** Columns: ↑/↓ within a column (moving through a list opens the entry), ←/→ between columns, Enter opens or picks. */
function colKey(e) {
  const own = e.target.closest?.('.ex-ci[data-c]'); // a focused entry (Tab, click) is where the keys start
  if (own) {
    ui.kc = +own.dataset.c;
    ui.kr = [...bodyEl.querySelectorAll(`.ex-col[data-col="${ui.kc}"] .ex-ci`)].indexOf(own);
  }
  const { cols } = columns();
  const kc = Math.max(0, Math.min(ui.kc, cols.length - 1));
  const rows = navRows(cols[kc]);
  const k = e.key;
  if (k === 'ArrowDown' || k === 'ArrowUp') {
    e.preventDefault();
    if (!rows.length) return;
    const d = k === 'ArrowDown' ? 1 : -1;
    let r = ui.kr;
    if (r < 0) { const s = selIndex(cols, kc); r = s >= 0 ? s + d : (d > 0 ? 0 : rows.length - 1); } else r += d;
    r = Math.max(0, Math.min(rows.length - 1, r));
    const row = rows[r];
    ui.pc = kc;
    if (row.k) choose(kc, row.k, { kr: r, advance: false });
    else { ui.kc = kc; ui.kr = r; render(); }
    return;
  }
  const enter = (k === 'Enter' && (e.target === qEl || !e.target.closest('button'))) || k === 'ArrowRight';
  if (k === 'ArrowLeft') {
    if (e.target === qEl && ui.q) return;
    e.preventDefault();
    if (kc === 0) return;
    ui.kc = kc - 1;
    ui.pc = ui.kc;
    ui.kr = Math.max(0, selIndex(cols, ui.kc));
    render();
    return;
  }
  if (!enter) return;
  e.preventDefault();
  const r = ui.kr >= 0 ? ui.kr : selIndex(cols, kc);
  const row = rows[r];
  if (k === 'Enter' && row?.v) { pick(row.v, true); return; }
  if (row?.k && row.next && ui.path[kc] !== row.k) ui.path = [...ui.path.slice(0, kc), row.k];
  const next = columns().cols;
  if (next.length <= kc + 1) return;
  ui.kc = kc + 1;
  ui.pc = ui.kc;
  let s = selIndex(next, ui.kc);
  if (s < 0) {
    s = 0;
    const first = navRows(next[ui.kc])[0];
    if (first?.k && first.next) ui.path = [...ui.path.slice(0, ui.kc), first.k];
  }
  ui.kr = s;
  render();
}

function onKey(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    if (ui.view === 'cols' && ui.q) { qEl.value = ''; setQuery(''); ui.act = -1; render(); qEl.focus({ preventScroll: true }); revealCurrent(); return; }
    closeExplorer(true);
    return;
  }
  if (ui.view === 'cols' && !ui.terms.length) {
    if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(e.key)) colKey(e);
    return;
  }
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
