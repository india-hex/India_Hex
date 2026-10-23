// Ruler: the length of a path, or the area and perimeter of a closed shape, on the WGS84 ellipsoid.
// While it is on (store key `measuring`) it owns the pointer: main.js skips hover and selection.
//   click / tap        add a point (within 12 px of the first point, with 3 or more: close the shape)
//   double-click/Enter finish the path        Backspace / Undo  remove the last point (reopen first)
//   Esc / Clear        clear; Esc again leaves  Done / tool button  leave
import { distance, densify, greatCircle, midpoint, pathLength, ringArea, ringPerimeter, fmtLength, fmtArea } from './geo.js';

const SNAP_PX = 12;
const DBL_MS = 400;
const touch = () => window.matchMedia('(hover: none)').matches;
const isMobile = () => window.matchMedia('(max-width: 820px)').matches;

export function initMeasure(ctx) {
  const { S, cfg, view } = ctx;
  const card = document.getElementById('measureCard');
  if (!cfg.features.measure) { card.hidden = true; return; }
  const m = view.map;
  view.initMeasureLayers();

  let pts = []; // [lng, lat]
  let closed = false;
  let finished = false;
  let cursor = null;
  let lastClick = null;

  const on = () => S.get().measuring;
  const drawing = () => pts.length > 0 && !closed && !finished;
  const nearPx = (a, b) => { const p = m.project(a); const q = m.project(b); return Math.hypot(p.x - q.x, p.y - q.y) <= SNAP_PX; };
  const reset = () => { pts = []; closed = false; finished = false; };

  function features() {
    const f = [];
    const add = (k, geometry, props = {}) => f.push({ type: 'Feature', properties: { k, ...props }, geometry });
    const path = closed ? [...pts, pts[0]] : pts;
    if (closed) add('fill', { type: 'Polygon', coordinates: [densify(path)] });
    if (pts.length >= 2) add('line', { type: 'LineString', coordinates: densify(path) });
    if (drawing() && cursor) add('live', { type: 'LineString', coordinates: greatCircle(pts[pts.length - 1], cursor) });
    pts.forEach((p, i) => add('pt', { type: 'Point', coordinates: p }, { first: i === 0 }));
    const segs = path.length - 1;
    if (segs >= 2) {
      for (let i = 0; i < segs; i++) {
        add('lbl', { type: 'Point', coordinates: midpoint(path[i], path[i + 1]) }, { t: fmtLength(distance(path[i], path[i + 1])), anc: 'center', off: [0, 0] });
      }
    }
    // the area is in the card; on the map it would collide with segment labels in thin shapes
    if (!closed && pts.length >= 2) {
      add('lbl', { type: 'Point', coordinates: pts[pts.length - 1] }, { t: fmtLength(pathLength(pts)), anc: 'bottom', off: [0, -0.9] });
    }
    return { type: 'FeatureCollection', features: f };
  }

  function renderCard() {
    const t = touch();
    const n = pts.length;
    const nPts = `${n} point${n === 1 ? '' : 's'}`;
    let big; let hint;
    if (!n) {
      big = '0 m';
      hint = `${t ? 'Tap' : 'Click'} the map to add the first point`;
    } else if (closed) {
      big = fmtArea(ringArea(pts));
      hint = `area · perimeter ${fmtLength(ringPerimeter(pts))}`;
    } else {
      const total = pathLength(pts);
      const extra = drawing() && cursor && !t ? distance(pts[n - 1], cursor) : 0;
      big = `${fmtLength(total)}${extra ? `<small>+${fmtLength(extra)} to the pointer</small>` : ''}`;
      hint = finished
        ? `path of ${nPts} · ${t ? 'tap' : 'click'} the map to start a new one`
        : `${nPts} · ${t ? 'double-tap' : 'double-click'} to finish${n >= 3 ? ` · ${t ? 'tap' : 'click'} the first point to close` : ''}`;
    }
    card.innerHTML = `<div class="mc-text"><div class="mc-num">${big}</div><div class="mc-hint">${hint}</div></div>
      <div class="mc-btns"><button data-mc="undo" ${n ? '' : 'disabled'} title="Remove the last point (Backspace)">Undo</button>
      <button data-mc="clear" ${n ? '' : 'disabled'} title="Clear (Esc)">Clear</button>
      <button data-mc="done" class="primary" title="Leave the ruler">Done</button></div>`;
  }

  let raf = 0;
  function draw() {
    cancelAnimationFrame(raf);
    raf = 0;
    view.setMeasure(features());
    renderCard();
  }
  const drawSoon = () => { if (!raf) raf = requestAnimationFrame(draw); };

  const finish = () => { if (!closed && pts.length >= 2) finished = true; draw(); };
  const undo = () => {
    if (closed) closed = false;
    else if (pts.length) { pts.pop(); finished = false; }
    draw();
  };

  m.on('click', (e) => {
    if (!on()) return;
    const now = performance.now();
    const second = lastClick && now - lastClick.t < DBL_MS && Math.hypot(e.point.x - lastClick.x, e.point.y - lastClick.y) <= SNAP_PX;
    lastClick = { t: now, x: e.point.x, y: e.point.y };
    const p = e.lngLat.toArray();
    if (closed || finished) {
      if (second) return; // second click of the double-click that just finished or closed
      reset();
    }
    if (pts.length >= 3 && nearPx(p, pts[0])) { closed = true; draw(); return; }
    pts.push(p);
    draw();
  });

  // A double-click first fires two clicks, each adding a point: drop the trailing points that sit
  // on top of the one before them, then finish.
  m.on('dblclick', (e) => {
    if (!on()) return;
    e.preventDefault();
    if (closed || finished) return;
    while (pts.length >= 2 && nearPx(pts[pts.length - 1], pts[pts.length - 2])) pts.pop();
    finish();
  });

  m.on('mousemove', (e) => {
    if (!on()) return;
    cursor = e.lngLat.toArray();
    if (drawing()) drawSoon();
  });
  m.getCanvasContainer().addEventListener('mouseleave', () => { if (on()) { cursor = null; drawSoon(); } });
  m.on('move', () => { if (on() && pts.length) drawSoon(); }); // keeps "near the first point" honest after zooming

  document.addEventListener('keydown', (e) => {
    if (!on()) return;
    const tag = document.activeElement?.tagName;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || document.activeElement?.isContentEditable) return;
    if (e.key === 'Enter') { e.preventDefault(); finish(); } else if (e.key === 'Backspace') { e.preventDefault(); undo(); } else if (e.key === 'Escape') {
      e.preventDefault();
      if (pts.length) { reset(); draw(); } else S.set({ measuring: false });
    }
  });

  card.addEventListener('click', (e) => {
    const b = e.target.closest('[data-mc]');
    if (!b) return;
    if (b.dataset.mc === 'undo') undo();
    else if (b.dataset.mc === 'clear') { reset(); draw(); } else S.set({ measuring: false });
  });

  S.on(['measuring'], (st) => {
    const container = m.getContainer();
    container.classList.toggle('measuring', st.measuring);
    view.setPickable(!st.measuring);
    reset();
    cursor = null;
    lastClick = null;
    if (st.measuring) {
      m.doubleClickZoom.disable();
      card.hidden = false;
      if (isMobile()) document.getElementById('side').classList.add('peek');
      draw();
    } else {
      m.doubleClickZoom.enable();
      card.hidden = true;
      view.setMeasure(null);
    }
  });
}
