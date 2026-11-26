// Status bar (bottom right): scale bar, camera height and the coordinates under the pointer, in
// decimal degrees. Click the coordinates to copy them.
import { distance, fmtDec, plainLatLng } from './geo.js';

const SCALE_PX = 110;
const touch = () => window.matchMedia('(hover: none)').matches;

/** Coordinates as shown everywhere on the site: decimal degrees (used by the sidebar cards too). */
export const fmtCoord = (lng, lat) => fmtDec(lng, lat);

/** Largest 1, 2 or 5 × 10ⁿ metres that is ≤ m. */
function niceLength(m) {
  const p = 10 ** Math.floor(Math.log10(m));
  for (const k of [5, 2, 1]) if (k * p <= m) return k * p;
  return p;
}

const grouped = (v) => v.toLocaleString('en-IN');

export function initStatusBar(ctx) {
  const { cfg, view } = ctx;
  const el = document.getElementById('statusbar');
  if (!cfg.features.coordinates) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `
    <span class="sb-scale" title="Scale at the bottom of the view"><span class="sb-bar"></span><span class="sb-lbl"></span></span>
    <span class="sb-cam" title="Approximate height of the viewpoint above the ground"></span>
    <button class="sb-coord" type="button" title="Click to copy latitude, longitude"></button>`;
  const bar = el.querySelector('.sb-bar');
  const lbl = el.querySelector('.sb-lbl');
  const cam = el.querySelector('.sb-cam');
  const coord = el.querySelector('.sb-coord');
  const m = view.map;
  let shown = null; // [lng, lat] currently displayed
  let pointer = null; // [lng, lat] under the pointer, null when it is off the map

  const showCoord = () => {
    const c = pointer && !touch() ? pointer : m.getCenter().toArray();
    shown = c;
    coord.textContent = fmtCoord(c[0], c[1]);
    el.classList.toggle('dim', !pointer && !touch());
  };

  const showScaleAndCamera = () => {
    const canvas = m.getCanvas();
    const w = canvas.clientWidth; const h = canvas.clientHeight;
    const y = Math.max(0, h - 30);
    const a = m.unproject([w / 2 - SCALE_PX / 2, y]).toArray();
    const b = m.unproject([w / 2 + SCALE_PX / 2, y]).toArray();
    const d = distance(a, b);
    if (Number.isFinite(d) && d > 0) {
      const nice = niceLength(d);
      bar.style.width = `${Math.max(8, Math.round((SCALE_PX * nice) / d))}px`;
      lbl.textContent = nice < 1000 ? `${grouped(nice)} m` : `${grouped(nice / 1000)} km`;
    }
    // camera height ≈ camera-to-centre distance (px) × metres per pixel at the centre × cos(pitch)
    const tr = m.transform;
    const lat = m.getCenter().lat;
    const mpp = (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** m.getZoom());
    const fov = ((tr.fov ?? 36.87) * Math.PI) / 180;
    const camPx = tr.cameraToCenterDistance ?? (0.5 / Math.tan(fov / 2)) * h;
    const alt = camPx * mpp * Math.cos((m.getPitch() * Math.PI) / 180);
    cam.textContent = `Camera: ${alt >= 100000 ? `${grouped(Math.round(alt / 1000))} km` : `${grouped(Math.round(alt))} m`}`;
  };

  let raf = 0;
  const schedule = (fn) => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; fn(); }); };
  m.on('mousemove', (e) => { pointer = e.lngLat.toArray(); schedule(showCoord); });
  m.getCanvasContainer().addEventListener('mouseleave', () => { pointer = null; showCoord(); });
  m.on('move', () => schedule(() => { showScaleAndCamera(); if (!pointer || touch()) showCoord(); }));
  m.on('resize', () => { showScaleAndCamera(); showCoord(); });

  coord.addEventListener('click', () => {
    if (!shown) return;
    const text = plainLatLng(shown[0], shown[1]);
    const done = () => ctx.act.toast(`Copied ${text}`, { ttl: 2000 });
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, () => ctx.act.toast("Couldn't copy to the clipboard", { ttl: 2500 }));
  });
  try { localStorage.removeItem('indiahex.coords'); } catch { /* the old format switch is gone */ }

  showScaleAndCamera();
  showCoord();
}
