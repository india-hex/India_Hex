/* global h3 */
// Search across places (states, districts, PCs, ACs), variables and H3 ids.
import { esc } from '../scales.js';
import { units, stateName } from '../data/units.js';
import { allSeries } from '../lens.js';

let index = [];
let active = 0;

export function initSearch(ctx) {
  if (!ctx.cfg.features.search) { document.querySelector('.search').hidden = true; return; }
  const U = units();
  const L = ctx.cfg.boundaries.levels;
  for (const level of ['state', 'pc', 'district', 'ac']) {
    for (const u of U[level]) {
      index.push({ kind: level, id: u.id, name: u.name, n: u.name.toLowerCase(), sub: [u.no != null ? `No. ${u.no}` : '', level === 'state' ? '' : stateName(u.st)].filter(Boolean).join(' · '), tag: L[level].short });
    }
  }
  for (const s of allSeries()) index.push({ kind: 'var', id: s.id, name: s.label, n: s.label.toLowerCase(), sub: s.group, tag: 'Data' });

  const input = document.getElementById('search');
  const box = document.getElementById('searchResults');
  const choose = (el) => {
    if (!el) return;
    const [kind, id] = [el.dataset.kind, el.dataset.id];
    box.hidden = true;
    input.blur();
    if (kind === 'var') ctx.S.set({ var: id, mode: 'value', density: false });
    else if (kind === 'hex') ctx.act.goToHex(id);
    else ctx.act.select(kind, +id);
  };
  input.addEventListener('input', () => run(input.value, box));
  input.addEventListener('focus', () => input.value && run(input.value, box));
  input.addEventListener('keydown', (e) => {
    const items = [...box.querySelectorAll('.sr')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach((it, i) => it.classList.toggle('on', i === active));
      items[active].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') choose(items[active]);
    else if (e.key === 'Escape') { box.hidden = true; input.blur(); }
  });
  box.addEventListener('click', (e) => choose(e.target.closest('.sr')));
  document.addEventListener('click', (e) => { if (!e.target.closest('.search')) box.hidden = true; });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) { e.preventDefault(); input.focus(); input.select(); }
  });
}

function run(q, box) {
  q = q.trim();
  if (!q) { box.hidden = true; return; }
  const ql = q.toLowerCase();
  let hits = [];
  if (/^[0-9a-f]{15}$/i.test(q) && h3.isValidCell(q.toLowerCase())) {
    hits = [{ kind: 'hex', id: q.toLowerCase(), name: q.toLowerCase(), sub: `H${h3.getResolution(q.toLowerCase())} hexagon`, tag: 'Hex', i: -1 }];
  } else {
    const rank = { var: 0, state: 1, pc: 2, district: 3, ac: 4 };
    for (const e of index) {
      const i = e.n.indexOf(ql);
      if (i < 0) continue;
      const score = (i === 0 ? 0 : e.n[i - 1] === ' ' || e.n[i - 1] === '(' ? 1 : 2) * 10 + rank[e.kind];
      hits.push({ ...e, i, score });
    }
    hits.sort((a, b) => a.score - b.score || a.name.length - b.name.length);
    hits = hits.slice(0, 30);
  }
  active = 0;
  const vars = hits.filter((h) => h.kind === 'var');
  const places = hits.filter((h) => h.kind !== 'var');
  const item = (h, k) => {
    const nm = h.i >= 0 ? `${esc(h.name.slice(0, h.i))}<mark>${esc(h.name.slice(h.i, h.i + q.length))}</mark>${esc(h.name.slice(h.i + q.length))}` : esc(h.name);
    return `<button class="sr${k === 0 ? ' on' : ''}" data-kind="${h.kind}" data-id="${h.id}"><span class="t">${h.tag}</span><span><div class="n">${nm}</div><div class="m">${esc(h.sub)}</div></span></button>`;
  };
  let k = 0;
  box.innerHTML = !hits.length ? '<div class="sr-empty">No place or variable matches</div>'
    : `${places.length ? `<div class="sr-head">Places</div>${places.map((h) => item(h, k++)).join('')}` : ''}${vars.length ? `<div class="sr-head">Variables</div>${vars.map((h) => item(h, k++)).join('')}` : ''}`;
  box.hidden = false;
}
