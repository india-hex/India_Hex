// Exports: PNG of the map (with title, legend and credits), CSV of lists/tables, GeoJSON of hexes.
import { legendNum } from '../scales.js';

function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

const slug = (s) => String(s).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');

export function csv(name, header, rows) {
  const q = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const text = [header, ...rows].map((r) => r.map(q).join(',')).join('\n');
  download(`${slug(name)}.csv`, new Blob([`﻿${text}`], { type: 'text/csv;charset=utf-8' }));
}

export function geojson(name, fc) {
  download(`${slug(name)}.geojson`, new Blob([JSON.stringify(fc)], { type: 'application/geo+json' }));
}

/** Map canvas(es) + editorial frame: title, subtitle, legend, credits. */
export async function png(ctx, { title, subtitle }) {
  const main = ctx.view.map;
  await new Promise((r) => { main.once('render', r); main.triggerRepaint(); });
  const c1 = main.getCanvas();
  const W = c1.width; const H = c1.height;
  const dpr = W / c1.clientWidth;
  const pad = 28 * dpr;
  const head = 86 * dpr;
  const foot = 70 * dpr;
  const out = document.createElement('canvas');
  out.width = W + 2 * pad;
  out.height = H + head + foot;
  const g = out.getContext('2d');
  const dark = document.documentElement.dataset.theme === 'dark';
  g.fillStyle = dark ? '#131417' : '#f5f3ee';
  g.fillRect(0, 0, out.width, out.height);
  g.drawImage(c1, pad, head);
  if (ctx.cview && ctx.S.get().compare) {
    const c2 = ctx.cview.map.getCanvas();
    const x = Math.round(W * ctx.S.get().comparePos);
    g.drawImage(c2, x, 0, W - x, H, pad + x, head, W - x, H);
    g.fillStyle = '#fff';
    g.fillRect(pad + x - dpr, head, 2 * dpr, H);
  }
  const ink = dark ? '#ece9e2' : '#1b1a17';
  const ink3 = dark ? '#8b867b' : '#857f73';
  g.fillStyle = ink;
  g.font = `${36 * dpr}px "Instrument Serif", Georgia, serif`;
  g.fillText(title, pad, 48 * dpr);
  g.fillStyle = ink3;
  g.font = `${13 * dpr}px Inter, sans-serif`;
  g.fillText(subtitle, pad, 72 * dpr);
  const lg = ctx.rt.legend;
  if (lg && lg.sc && lg.sc.cat && !lg.lens.none) { // categories: swatch + label
    const y = head + H + 20 * dpr;
    let x = pad;
    g.font = `${11 * dpr}px Inter, sans-serif`;
    for (const i of lg.sc.shown) {
      g.fillStyle = lg.sc.colors[i];
      g.fillRect(x, y, 12 * dpr, 12 * dpr);
      g.fillStyle = ink3;
      g.fillText(lg.sc.labels[i], x + 17 * dpr, y + 10 * dpr);
      x += (26 + lg.sc.labels[i].length * 6.5) * dpr;
    }
  } else if (lg && lg.sc && !lg.lens.none) {
    const n = lg.sc.colors.length;
    const lw = Math.min(360 * dpr, W * 0.5);
    const sw = lw / n;
    const y = head + H + 20 * dpr;
    lg.sc.colors.forEach((c, i) => { g.fillStyle = c; g.fillRect(pad + i * sw, y, sw, 10 * dpr); });
    g.fillStyle = ink3;
    g.font = `${10.5 * dpr}px Inter, sans-serif`;
    g.textAlign = 'center';
    lg.sc.breaks.forEach((b, i) => g.fillText(legendNum(b, lg.lens), pad + (i + 1) * sw, y + 24 * dpr));
    g.textAlign = 'left';
  }
  g.fillStyle = ink3;
  g.font = `${10.5 * dpr}px Inter, sans-serif`;
  g.textAlign = 'right';
  g.fillText(`${ctx.cfg.site.title} · ${ctx.cfg.site.data_credit || ''} · basemap © its providers`, out.width - pad, head + H + 30 * dpr);
  g.fillText(location.href.length < 140 ? location.href : location.origin + location.pathname, out.width - pad, head + H + 48 * dpr);
  g.textAlign = 'left';
  await new Promise((r) => out.toBlob((b) => { download(`${slug(title)}.png`, b); r(); }, 'image/png'));
}
