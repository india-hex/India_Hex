// AC/PC election results (pipeline/results.py → data/results/<key>/{ac,pc}.json, config.json "results").
//   expandSeries(cfg)        the unit-only map series (Winner, Winning margin, vote shares), rebuilt from
//                            config.json's compact form into cfg.variables before the lens starts
//   resultsBlock(st, lens)   the unit card for a selected AC or PC: the election on the map (its state,
//                            house and year), or one line per house for the state's latest election
//   initResults(ctx)         event wiring (top-N control, switching the map to an election)
import { esc } from '../scales.js';
import { units, unit } from '../data/units.js';
import { seriesById, lensOf } from '../lens.js';

let CTX = null;
let CFG = null;
const files = new Map();
const HOUSE = { VS: 'Assembly', LS: 'Lok Sabha' };
const PALETTE = { BJP: '#E69F00', NDA: '#E69F00', INC: '#0072B2', MGB: '#0072B2', UPA: '#0072B2', 'JD(S)': '#009E73', JSP: '#CC79A7' };
const GREY = '#999999';
const TOPN = [3, 4, 5];

const n = (x) => (x == null ? '–' : Math.round(x).toLocaleString('en-IN'));
const pc = (x, d = 1) => (x == null || !Number.isFinite(x) ? '–' : `${x.toFixed(d)}%`);
const mpp = (x) => (x == null ? '–' : `${x.toFixed(Math.abs(x) < 1 ? 2 : 1)} pp`);
const sgn = (x) => (x > 0 ? '+' : x < 0 ? '−' : '±');

function topN() {
  try { const v = +localStorage.getItem('indiahex.topn'); return TOPN.includes(v) ? v : 3; } catch { return 3; }
}

/** config.json "results" → full catalog entries (pushed into cfg.variables). */
export function expandSeries(cfg) {
  CFG = cfg;
  const R = cfg.results;
  if (!R) return;
  for (const el of R.elections) {
    const house = HOUSE[el.house];
    for (const m of el.maps) {
      const s = {
        id: `r_${el.key}_${m.s}`, group: `${el.state_name} ${house} ${el.year} results`, label: m.l, unit: m.un || '',
        note: R.notes[m.n] || '', ramp: m.r || 'viridis', format: m.f || 'pct', agg: m.a || 'wmean', density: false,
        dtype: m.dt || 'u8', default_year: null, res_years: {}, states: el.states || [el.state], menu: ['Elections', el.state_name, house, `${el.year} results`],
        unit_levels: R.levels[m.lv], results: el.key, official: true, years: [el.year], q: {}, breaks: {},
      };
      if (m.c) { // categorical (Winner): defaults as written by pipeline/results.py CAT_DEFAULTS
        Object.assign(s, { type: 'categorical', format: m.f || 'cat', agg: m.a || 'lead', ramp: m.r || 'cat' });
        s.categories = m.c.map(([id, label, color]) => ({ id, label, color, years: [el.year] }));
      } else s.type = m.t || 'numeric';
      if (m.b) s.fixed_breaks = m.b;
      cfg.variables.push(s);
    }
  }
}

const elections = () => CFG?.results?.elections || [];
const byKey = (k) => elections().find((e) => e.key === k) || null;

/** The results election of the variable on the map: a results series, or a hexagon election series
 *  (its dataset prefix gives state and house, the lens year the election). */
export function electionOnMap(lens) {
  if (!lens || lens.none) return null;
  const s = lens.series;
  if (s.results) return byKey(s.results);
  for (const [prefix, p] of Object.entries(CFG?.results?.prefixes || {})) {
    if (s.id.startsWith(prefix)) return elections().find((e) => e.state === p.state && e.house === p.house && e.year === lens.year) || null;
  }
  return null;
}

function load(el, level) {
  const path = el.files[level];
  if (!files.has(path)) files.set(path, fetch(`data/${path}?v=${CFG.version}`).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  return files.get(path);
}

const colourOf = (f, p) => f?.colours?.[p] || PALETTE[p] || GREY;
const pname = (p) => (p === 'IND' ? 'Independent' : p);
function partyTag(f, p) {
  const full = f?.names?.[p];
  return `<span class="rs-party"${full ? ` title="${esc(full)}"` : ''}><i class="sw" style="background:${colourOf(f, p)}"></i>${esc(pname(p))}</span>`;
}

/** Heading of an election at a level: "Lok Sabha 2024 · lead in this segment (EVM votes)". */
function title(el, level) {
  const t = `${HOUSE[el.house]} ${el.year}`;
  if (el.house === 'LS' && level === 'ac') return `${t} · lead in this segment (EVM votes)`;
  if (el.house === 'VS' && level === 'pc') return `${t} · sum of its ACs`;
  return t;
}

/** The map series to show an election: the hexagon election's lead series if there is one, else results Winner. */
function seriesFor(el) {
  for (const [prefix, p] of Object.entries(CFG.results.prefixes || {})) {
    if (p.state === el.state && p.house === el.house) {
      const s = seriesById(`${prefix}lead`);
      if (s && s.years.includes(el.year)) return s.id;
    }
  }
  return `r_${el.key}_win`;
}

function bar(label, share, votes, colour, extra = '') {
  return `<div class="rs-bar"><span class="rs-l">${label}</span><span class="rs-t"><i style="width:${Math.max(0.5, Math.min(100, share || 0)).toFixed(1)}%;background:${colour}"></i></span><span class="rs-v">${pc(share)}</span><span class="rs-n">${votes == null ? '' : n(votes)}</span>${extra}</div>`;
}

/** Party shares of a unit as {party: percent}. */
function shares(u) {
  const out = {};
  if (!u || !u.tv) return out;
  for (const [p, v] of u.p || []) if (v != null) out[p] = (100 * v) / u.tv;
  return out;
}

async function card(el, level, id) {
  const f = await load(el, level);
  const u = f?.u?.[String(id)];
  if (!f || !u) return `<section class="rs"><div class="rs-h">${esc(title(el, level))}</div><p class="note">No result for this unit in this election.</p></section>`;
  const seg = f.lead;
  const agg = f.agg;
  const tv = u.tv;
  const N = topN();
  const c = u.c || [];
  const head = `<div class="rs-h"><span>${esc(title(el, level))}</span><span class="rs-st">${esc(el.state_name)}</span></div>`;
  if (!c.length || !tv) {
    return `<section class="rs">${head}<p class="note">No votes recorded${u.note ? `: ${esc(u.note)}` : ''}.</p></section>`;
  }
  // winner and runner-up
  const w = c.find((x) => x[1] === u.w) || [null, u.w || c[0][1], null];
  const r = u.r ? c.find((x) => x !== w && x[1] === u.r) || [null, u.r, null] : null;
  const verb = seg ? 'led this segment' : agg ? 'led over its ACs' : 'won';
  const who = (x) => (x[0] ? `<b>${esc(x[0])}</b> ${partyTag(f, x[1])}` : `<b>${partyTag(f, x[1])}</b>`);
  const margin = u.m != null ? `<div class="rs-m">margin <b>${n(u.m)}</b> votes · <b>${mpp(u.mp)}</b>${r ? ` over ${r[0] ? esc(r[0]) : ''} ${partyTag(f, r[1])}` : ''}</div>` : '';
  const win = `<div class="rs-win">${who(w)} <span class="rs-verb">${verb}</span></div>${margin}`;
  // top N candidates (or parties, for an assembly result summed over a PC), then Others
  const top = c.slice(0, N);
  const others = tv - top.reduce((t, x) => t + (x[2] || 0), 0) - (u.nota || 0);
  const rows = top.map((x) => bar(x[0] ? `${esc(x[0])} <small>${esc(pname(x[1]))}</small>` : partyTag(f, x[1]), (100 * (x[2] || 0)) / tv, x[2], colourOf(f, x[1]))).join('')
    + bar('Others', (100 * others) / tv, others, 'var(--ink-3)')
    + (u.nota != null ? bar('NOTA', (100 * u.nota) / tv, u.nota, '#5f5f5f') : '');
  const ctl = `<div class="rs-topn" role="group" aria-label="Number of candidates shown">${TOPN.map((k) => `<button data-rn="${k}" class="${k === N ? 'on' : ''}" aria-pressed="${k === N}">${k}</button>`).join('')}</div>`;
  const cand = `<div class="rs-sub"><span>${agg ? 'Top parties' : 'Top candidates'}</span>${ctl}</div><div class="rs-bars">${rows}</div>`;
  // turnout, electors, NOTA
  const kv = [['Turnout', u.t != null ? pc(u.t) : '–'], ['Electors', n(u.e)], [seg ? 'EVM votes' : 'Valid votes', n(tv)]];
  if (u.nota != null) kv.push(['NOTA', `${n(u.nota)} (${pc((100 * u.nota) / tv)})`]);
  const kvs = `<div class="kvs rs-kvs">${kv.map(([k, v]) => `<span>${k} <b>${v}</b></span>`).join('')}</div>`;
  // party shares with the change since the previous election of this house in the state
  const prevEl = el.prev ? byKey(el.prev) : null;
  const pf = prevEl ? await load(prevEl, level) : null;
  const pu = pf?.u?.[String(id)];
  const mapChanged = prevEl && prevEl.seat_map !== el.seat_map;
  const sh = shares(u); const sh0 = mapChanged ? {} : shares(pu);
  const parties = (u.p || []).filter(([p, v]) => p !== 'IND' && v != null && (100 * v) / tv >= 1).slice(0, 8);
  const rest = 100 - parties.reduce((t, [p]) => t + sh[p], 0);
  const chg = (p) => (pu && !mapChanged ? (sh0[p] != null ? `<span class="rs-d ${sh[p] - sh0[p] >= 0 ? 'up' : 'down'}">${sgn(sh[p] - sh0[p])}${Math.abs(sh[p] - sh0[p]).toFixed(1)}</span>` : '<span class="rs-d">new</span>') : '');
  const prow = parties.map(([p, v]) => bar(partyTag(f, p), sh[p], v, colourOf(f, p), chg(p))).join('')
    + bar('<span title="Others incl. independents and NOTA">Others</span>', rest, null, 'var(--ink-3)', pu && !mapChanged ? '<span class="rs-d"></span>' : '');
  const since = pu && !mapChanged ? `<small>pp change since ${prevEl.year}</small>` : mapChanged ? `<small>seat map changed since ${prevEl.year}: no change shown</small>` : '';
  const party = `<div class="rs-sub"><span>Vote share by party</span>${since}</div><div class="rs-bars${pu && !mapChanged ? ' chg' : ''}">${prow}</div>`;
  // alliances (blocs with two or more parties)
  const blocs = (u.b || []).filter(([, v]) => v != null);
  const ally = blocs.length ? `<div class="rs-sub"><span>By alliance</span></div><div class="rs-bars">${blocs.map(([b, v]) => {
    const [label, col] = f.blocs?.[b] || [b, GREY];
    return bar(`<span title="${esc(label)}">${esc(label.split(' (')[0])}</span>`, (100 * v) / tv, v, col || GREY);
  }).join('')}</div>` : '';
  // notes: incomplete unit, the seat map's PC where India Hex's own PC layer differs, election gaps
  const notes = [];
  if (u.x) notes.push(`<p class="note rs-warn">Incomplete${u.note ? `: ${esc(u.note)}` : ''}.</p>`);
  if (level === 'ac' && u.pc != null) {
    const me = unit({ level: 'ac', id });
    if (me && me.pc !== u.pc) notes.push(`<p class="note">On the seat map this AC is in <button class="rs-link" data-rsel="pc:${u.pc}">${esc(units().pc[u.pc]?.name || '')}</button> PC (the map's PC layer differs here).</p>`);
  }
  return `<section class="rs">${head}${win}${cand}${kvs}${party}${ally}${notes.join('')}</section>`;
}

/** True when the election's seats include this state (undivided Andhra Pradesh: AP and Telangana). */
const inState = (el, stateKey) => (el.states || [el.state]).includes(stateKey);

/** One line per house: the state's latest election at this unit, tappable to put it on the map. */
async function lines(stateKey, level, id) {
  const els = elections().filter((e) => inState(e, stateKey));
  if (!els.length) return '';
  const latest = ['VS', 'LS'].map((h) => els.filter((e) => e.house === h).sort((a, b) => b.year - a.year)[0]).filter(Boolean);
  const rows = await Promise.all(latest.map(async (el) => {
    const f = await load(el, level);
    const u = f?.u?.[String(id)];
    const label = `${HOUSE[el.house]} ${el.year}`;
    let what = 'no result';
    if (u && u.w) {
      const seg = f.lead; const agg = f.agg;
      what = `${partyTag(f, u.w)} ${seg ? 'led this segment' : agg ? 'led over its ACs' : 'won'}${u.mp != null ? ` · margin ${mpp(u.mp)}` : ''}`;
    }
    return `<button class="rs-line" data-rsw="${el.key}" title="Show ${esc(el.state_name)} ${esc(label)} on the map"><span class="rs-lk">${esc(label)}</span><span class="rs-lv">${what}</span><span class="rs-go" aria-hidden="true">›</span></button>`;
  }));
  const as = '';
  return `<section class="rs rs-compact"><div class="rs-h"><span>Election results</span><span class="rs-st">latest</span></div>${rows.join('')}${as}</section>`;
}

/** Results for the selected AC or PC (HTML), or '' for other selections and states without results. */
export async function resultsBlock(st, lens) {
  if (!CFG?.results || !st.sel || !['ac', 'pc'].includes(st.sel.level)) return '';
  const u = unit(st.sel);
  const stateKey = units().state[u.st]?.key;
  const el = electionOnMap(lens);
  if (el && inState(el, stateKey)) return card(el, st.sel.level, st.sel.id);
  return lines(stateKey, st.sel.level, st.sel.id);
}

async function rerender() {
  const box = document.getElementById('sec-results');
  if (!box || !CTX) return;
  const st = CTX.S.get();
  box.innerHTML = await resultsBlock(st, lensOf(st));
}

export function initResults(ctx) {
  CTX = ctx;
  document.getElementById('panel').addEventListener('click', (e) => {
    const t = e.target.closest('[data-rn],[data-rsw],[data-rsel]');
    if (!t) return;
    if (t.dataset.rn) {
      try { localStorage.setItem('indiahex.topn', t.dataset.rn); } catch { /* private mode */ }
      rerender();
    } else if (t.dataset.rsel) {
      const [l, id] = t.dataset.rsel.split(':');
      ctx.act.select(l, +id);
    } else if (t.dataset.rsw) {
      const el = byKey(t.dataset.rsw);
      if (!el) return;
      ctx.act.pickVar(seriesFor(el));
      ctx.S.set({ year: el.year });
    }
  });
}
