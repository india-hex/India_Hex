// Every panel and overlay can be folded away and brought back in one tap (owner's decision D5).
//   Desktop: the sidebar collapses to a slim edge tab; the lens bar folds to one line (variable + colour
//   ramp); the Layers panel to its head; the tools and status bar to one button; cards and popups to
//   their title. "\" hides or shows every panel at once.
//   Phone: the sidebar is a bottom sheet with three heights (peek, half, full) by swipe or tap, and
//   can be swiped away; a floating "Panels" button brings everything back in one tap.
// Fold states are kept in localStorage (this device only; convenience, never required).

let CTX = null;
const $ = (s) => document.querySelector(s);
const isMobile = () => window.matchMedia('(max-width: 820px)').matches;

const KEY = 'indiahex.fold.';
function saved(name, dflt) {
  try { const v = localStorage.getItem(KEY + name); return v == null ? dflt : v === '1'; } catch { return dflt; }
}
function save(name, on) {
  try { localStorage.setItem(KEY + name, on ? '1' : '0'); } catch { /* private mode */ }
}

const CHEV = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>';
const PANELS = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M9 4.5v15"/></svg>';

/** Keep the map(s) sized to the stage after a layout change (grid column, sheet height). */
function resizeMaps() {
  const go = () => { CTX.view.map.resize(); CTX.cview?.map?.resize(); };
  requestAnimationFrame(go);
  setTimeout(go, 320); // after CSS transitions
}

// ---- sidebar (desktop) ----------------------------------------------------------------------------
function setSide(off, remember = true) {
  $('#app').classList.toggle('side-off', off);
  $('#sideTab').hidden = !off || isMobile();
  $('#sideFold')?.setAttribute('aria-expanded', String(!off));
  if (remember) save('side', off);
  resizeMaps();
}

// ---- lens bar: one line (variable + ramp) or full ------------------------------------------------------
function setBar(folded, remember = true) {
  const bar = $('#lensbar');
  bar.classList.toggle('folded', folded);
  const b = $('#barFold');
  if (b) { b.setAttribute('aria-expanded', String(!folded)); b.title = folded ? 'Show the legend notes and years' : 'Fold to one line'; }
  if (remember) save(isMobile() ? 'bar.m' : 'bar', folded);
}

// ---- tools + status bar ------------------------------------------------------------------------------
function setTools(folded, remember = true) {
  $('#app').classList.toggle('tools-off', folded);
  const b = $('#toolsFold');
  if (b) { b.setAttribute('aria-expanded', String(!folded)); b.title = folded ? 'Show map tools' : 'Hide map tools'; }
  if (remember) save('tools', folded);
}

// ---- everything at once ("\" or the Panels button) -----------------------------------------------------
function setBare(bare) {
  const app = $('#app');
  app.classList.toggle('bare', bare);
  if (isMobile()) {
    const s = $('#side');
    if (bare) s.classList.add('gone');
    else { s.classList.remove('gone'); if (!s.classList.contains('full')) s.classList.add('peek'); }
  }
  $('#panelsBtn').hidden = !bare && !$('#side').classList.contains('gone');
  resizeMaps();
}

/** One tap brings every panel back (and unfolds the sidebar). */
function restoreAll() {
  setBare(false);
  if ($('#app').classList.contains('side-off')) setSide(false);
  if ($('#app').classList.contains('tools-off')) setTools(false);
  $('#panelsBtn').hidden = true;
}

// ---- phone bottom sheet: peek / half / full / gone, by swipe or tap -------------------------------------
const STATES = ['gone', 'peek', 'half', 'full'];
function sheetState() {
  const s = $('#side');
  if (s.classList.contains('gone')) return 'gone';
  if (s.classList.contains('peek')) return 'peek';
  if (s.classList.contains('full')) return 'full';
  return 'half';
}
function setSheet(state) {
  const s = $('#side');
  s.classList.remove('gone', 'peek', 'full');
  if (state !== 'half') s.classList.add(state);
  $('#app').classList.toggle('bare', state === 'gone' && $('#app').classList.contains('bare'));
  $('#panelsBtn').hidden = state !== 'gone';
  resizeMaps();
}

function sheetGestures() {
  const h = $('#sheetHandle');
  let y0 = null; let t0 = 0; let moved = false;
  h.addEventListener('pointerdown', (e) => { y0 = e.clientY; t0 = performance.now(); moved = false; h.setPointerCapture(e.pointerId); });
  h.addEventListener('pointermove', (e) => { if (y0 != null && Math.abs(e.clientY - y0) > 8) moved = true; });
  h.addEventListener('pointerup', (e) => {
    if (y0 == null) return;
    const dy = e.clientY - y0;
    const fast = Math.abs(dy) / Math.max(1, performance.now() - t0) > 0.5;
    y0 = null;
    if (!moved) return; // a tap: main.js cycles peek -> half -> full
    const i = STATES.indexOf(sheetState());
    const steps = fast || Math.abs(dy) > 160 ? 2 : 1;
    const next = dy > 0 ? Math.max(0, i - steps) : Math.min(STATES.length - 1, i + steps);
    setSheet(STATES[next]);
    h.dataset.swiped = '1'; // the click that follows a swipe is not a tap
    setTimeout(() => { delete h.dataset.swiped; }, 350);
  });
  // a tap that follows a swipe must not cycle the sheet again
  h.addEventListener('click', (e) => { if (h.dataset.swiped) e.stopImmediatePropagation(); }, true);
}

// ---- cards and popups: fold to their title --------------------------------------------------------------
const FOLDABLE = [
  // [container selector, title selector inside it, storage name]
  ['#sec-band > .band', '.title, .t1, h2, .kicker', 'card'],
];
function foldButtons(root = document) {
  for (const [sel, titleSel, name] of FOLDABLE) {
    root.querySelectorAll(sel).forEach((card) => {
      if (card.querySelector(':scope > .fold-btn')) return;
      const b = document.createElement('button');
      b.className = 'fold-btn';
      b.type = 'button';
      b.innerHTML = CHEV;
      const apply = (f) => { card.classList.toggle('folded', f); b.setAttribute('aria-expanded', String(!f)); b.title = f ? 'Show the card' : 'Fold the card'; };
      apply(saved(name, false));
      b.onclick = (e) => { e.stopPropagation(); const f = !card.classList.contains('folded'); apply(f); save(name, f); };
      card.prepend(b);
      void titleSel;
    });
  }
  // the cell-split popup of the footprints
  document.querySelectorAll('.fp-popup .maplibregl-popup-content').forEach((c) => {
    if (c.querySelector(':scope > .fold-btn')) return;
    const b = document.createElement('button');
    b.className = 'fold-btn';
    b.type = 'button';
    b.innerHTML = CHEV;
    b.title = 'Fold';
    b.onclick = (e) => { e.stopPropagation(); c.classList.toggle('folded'); };
    c.prepend(b);
  });
}

// ---- sidebar width (desktop): drag its right edge, 300–720 px, kept per viewer; double-click resets ----
const SIDE_MIN = 300;
const SIDE_MAX = 720;
function setSideWidth(w, remember = false) {
  if (w == null) document.documentElement.style.setProperty('--side-w', `${CTX.cfg.ui.sidebar_width || 392}px`);
  else document.documentElement.style.setProperty('--side-w', `${Math.round(Math.min(SIDE_MAX, Math.max(SIDE_MIN, w)))}px`);
  if (remember) {
    try { if (w == null) localStorage.removeItem('indiahex.sidew'); else localStorage.setItem('indiahex.sidew', String(Math.round(w))); } catch { /* private mode */ }
  }
}

function sideResizer() {
  const side = $('#side');
  const h = document.createElement('div');
  h.className = 'side-resize';
  h.id = 'sideResize';
  h.setAttribute('role', 'separator');
  h.setAttribute('aria-orientation', 'vertical');
  h.title = 'Drag to resize the panel · double-click to reset';
  side.appendChild(h);
  let raf = 0;
  const follow = (x) => {
    setSideWidth(x - side.getBoundingClientRect().left);
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; CTX.view.map.resize(); CTX.cview?.map?.resize(); });
  };
  h.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    h.setPointerCapture(e.pointerId);   // the release never lands on the map as a click
    document.body.classList.add('resizing');
  });
  h.addEventListener('pointermove', (e) => { if (document.body.classList.contains('resizing')) follow(e.clientX); });
  const end = (e) => {
    if (!document.body.classList.contains('resizing')) return;
    document.body.classList.remove('resizing');
    if (h.hasPointerCapture(e.pointerId)) h.releasePointerCapture(e.pointerId);
    setSideWidth(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--side-w')), true);
    resizeMaps();
  };
  h.addEventListener('pointerup', end);
  h.addEventListener('pointercancel', end);
  h.addEventListener('dblclick', () => { setSideWidth(null, true); resizeMaps(); });
  try { const w = +localStorage.getItem('indiahex.sidew'); if (w) setSideWidth(w); } catch { /* ignore */ }
}

export function initPanels(ctx) {
  CTX = ctx;
  const app = $('#app');
  sideResizer();

  // sidebar fold button (desktop) + the edge tab that brings it back
  const actions = $('.mast-actions');
  const sf = document.createElement('button');
  sf.className = 'icon fold-side';
  sf.id = 'sideFold';
  sf.title = 'Hide this panel ( \\ hides all )';
  sf.setAttribute('aria-label', 'Hide the side panel');
  sf.innerHTML = CHEV;
  sf.onclick = () => setSide(true);
  actions.prepend(sf);
  const tab = document.createElement('button');
  tab.className = 'side-tab';
  tab.id = 'sideTab';
  tab.hidden = true;
  tab.title = 'Show the side panel';
  tab.innerHTML = `<span>India <em>Hex</em></span>${CHEV}`;
  tab.onclick = () => setSide(false);
  $('#stage').appendChild(tab);

  // lens bar fold
  const fb = document.createElement('button');
  fb.className = 'bar-fold';
  fb.id = 'barFold';
  fb.innerHTML = CHEV;
  fb.setAttribute('aria-label', 'Fold the legend');
  fb.onclick = (e) => { e.stopPropagation(); setBar(!$('#lensbar').classList.contains('folded')); };
  $('#lensbar').appendChild(fb);

  // tools fold (also folds the status bar)
  const tools = $('#tools');
  const tf = document.createElement('button');
  tf.className = 'tools-fold';
  tf.id = 'toolsFold';
  tf.innerHTML = CHEV;
  tf.setAttribute('aria-label', 'Hide map tools');
  tf.onclick = () => setTools(!app.classList.contains('tools-off'));
  tools.appendChild(tf);

  // the one-tap restore button
  const pb = document.createElement('button');
  pb.className = 'panels-btn';
  pb.id = 'panelsBtn';
  pb.hidden = true;
  pb.innerHTML = `${PANELS}<span>Panels</span>`;
  pb.title = 'Show every panel ( \\ )';
  pb.onclick = restoreAll;
  $('#stage').appendChild(pb);

  // initial states: the viewer's own, else open (phones: the lens bar folded to one line)
  setSide(!isMobile() && saved('side', false), false);
  setBar(saved(isMobile() ? 'bar.m' : 'bar', isMobile()), false);
  setTools(saved('tools', false), false);
  if (!isMobile() && saved('layers', false)) $('#lens').classList.add('closed');
  $('#lensToggle')?.addEventListener('click', () => { if (!isMobile()) save('layers', $('#lens').classList.contains('closed')); });

  document.addEventListener('keydown', (e) => {
    if (e.key !== '\\' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
    e.preventDefault();
    if (app.classList.contains('bare')) restoreAll(); else setBare(true);
  });

  sheetGestures();
  // phones: a hidden sheet comes back as a peek when a place, hexagon or booth is picked
  ctx.S.on(['sel', 'hex', 'booth'], (st) => {
    if (isMobile() && $('#side').classList.contains('gone') && !app.classList.contains('bare') && (st.sel || st.hex || st.booth)) setSheet('peek');
  });
  new MutationObserver(() => foldButtons()).observe(document.getElementById('panel'), { childList: true, subtree: true });
  new MutationObserver(() => foldButtons()).observe(document.getElementById('map'), { childList: true, subtree: true });
  window.matchMedia('(max-width: 820px)').addEventListener('change', () => { $('#sideTab').hidden = !app.classList.contains('side-off') || isMobile(); resizeMaps(); });
}
