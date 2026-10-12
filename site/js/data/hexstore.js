/* global h3 */
// Hexagon data: index chunks and variable slices, fetched with HTTP Range requests.
// File layout is documented in pipeline/hexes.py. One chunk = every cell under one H3 parent
// cell (chunk_res = res - chunk_levels); chunk k spans cells [start[k], start[k+1]).

let VER = '';
const manifests = new Map(); // res -> Promise<manifest>
const indexCache = new Map(); // `${res}/${k}` -> Promise<chunk>
const valueCache = new Map(); // `${res}/${file}/${k}` -> Promise<Float32Array>
const wholeFile = new Map(); // url -> Promise<ArrayBuffer>  (only when a server ignores Range)
const MAX_INDEX = 2500;
const MAX_VALUES = 6000;

export function initHexStore(version) { VER = version; }

const url = (res, file) => `data/hex/h${res}/${file}?v=${VER}`;

export function manifest(res) {
  if (!manifests.has(res)) {
    manifests.set(res, fetch(url(res, 'manifest.json')).then((r) => r.json()).then((m) => {
      m.byParent = new Map(m.parents.map((p, k) => [p, k]));
      m.levels = res - m.chunk_res;
      m.area = h3.getHexagonAreaAvg(res, 'km2');
      return m;
    }));
  }
  return manifests.get(res);
}

function lru(map, max) {
  while (map.size > max) map.delete(map.keys().next().value);
}

// ---- ranged fetching -------------------------------------------------------------------------
async function fetchRange(u, a, b) {
  if (wholeFile.has(u)) return (await wholeFile.get(u)).slice(a, b);
  const r = await fetch(u, { headers: { Range: `bytes=${a}-${b - 1}` } });
  if (r.status === 206) return r.arrayBuffer();
  if (!r.ok) throw new Error(`${r.status} ${u}`);
  const whole = r.arrayBuffer();
  wholeFile.set(u, whole);
  return (await whole).slice(a, b);
}

/** Fetch byte ranges for chunks ks of one file (width = bytes per cell); contiguous chunks share a request. */
async function fetchChunks(u, m, ks, width) {
  const sorted = [...ks].sort((x, y) => x - y);
  const runs = [];
  for (const k of sorted) {
    const last = runs[runs.length - 1];
    if (last && k === last.to + 1 && m.start[k + 1] - m.start[last.from] < 40000) last.to = k;
    else runs.push({ from: k, to: k });
  }
  const out = new Map();
  await Promise.all(runs.map(async ({ from, to }) => {
    const base = m.start[from];
    const buf = await fetchRange(u, width * base, width * m.start[to + 1]);
    for (let k = from; k <= to; k++) out.set(k, buf.slice(width * (m.start[k] - base), width * (m.start[k + 1] - base)));
  }));
  return out;
}

// ---- index chunks ----------------------------------------------------------------------------
function childId(parentBig, res, levels, code) {
  let x = (parentBig & ~(0xfn << 52n)) | (BigInt(res) << 52n);
  for (let r = res - levels + 1; r <= res; r++) {
    const d = BigInt((code >> (3 * (res - r))) & 7);
    const shift = BigInt((15 - r) * 3);
    x = (x & ~(7n << shift)) | (d << shift);
  }
  return x.toString(16);
}

function decodeIndex(buf, m, res, k) {
  const n = m.start[k + 1] - m.start[k];
  const c = {
    k, n, res,
    codes: new Uint16Array(buf, 0, n),
    s: new Int16Array(buf, 2 * n, n), a: new Int16Array(buf, 4 * n, n),
    p: new Int16Array(buf, 6 * n, n), d: new Int16Array(buf, 8 * n, n),
  };
  const pBig = BigInt(`0x${m.parents[k]}`);
  c.h = Array.from(c.codes, (code) => childId(pBig, res, m.levels, code));
  return c;
}

async function indexChunks(res, ks) {
  const m = await manifest(res);
  const missing = ks.filter((k) => !indexCache.has(`${res}/${k}`));
  if (missing.length) {
    const p = fetchChunks(url(res, 'index.bin'), m, missing, 10);
    for (const k of missing) indexCache.set(`${res}/${k}`, p.then((bufs) => decodeIndex(bufs.get(k), m, res, k)));
    p.catch(() => missing.forEach((k) => indexCache.delete(`${res}/${k}`)));
  }
  const out = await Promise.all(ks.map((k) => indexCache.get(`${res}/${k}`)));
  lru(indexCache, MAX_INDEX);
  return out;
}

function centres(c) {
  if (!c.lat) {
    c.lat = new Float32Array(c.n);
    c.lng = new Float32Array(c.n);
    for (let i = 0; i < c.n; i++) {
      const [la, ln] = h3.cellToLatLng(c.h[i]);
      c.lat[i] = la; c.lng[i] = ln;
    }
  }
  return c;
}

// ---- public API ------------------------------------------------------------------------------
/** Chunk numbers whose cells may fall inside bbox [w, s, e, n]. */
export async function chunksFor(res, [w, s, e, n]) {
  const m = await manifest(res);
  const cres = m.chunk_res;
  const cand = new Set(h3.polygonToCells([[s, w], [s, e], [n, e], [n, w], [s, w]], cres));
  cand.add(h3.latLngToCell((s + n) / 2, (w + e) / 2, cres));
  const ring = new Set();
  for (const c of cand) for (const x of h3.gridDisk(c, 1)) ring.add(x);
  const ks = [];
  for (const c of ring) { const k = m.byParent.get(c); if (k !== undefined) ks.push(k); }
  return ks;
}

/**
 * A CellSet: cells of `res` within bbox, optionally only those of one unit
 * (filter = {field: 's'|'a'|'p'|'d', id}) and/or only those whose centre is inside clip bbox.
 */
export async function cellSet(res, bbox, { filter = null, clip = null } = {}) {
  const ks = await chunksFor(res, bbox);
  const chunks = await indexChunks(res, ks);
  const parts = [];
  let n = 0;
  for (const c of chunks) {
    if (clip) centres(c);
    const idx = [];
    const f = filter ? c[filter.field] : null;
    for (let i = 0; i < c.n; i++) {
      if (f && f[i] !== filter.id) continue;
      if (clip && (c.lng[i] < clip[0] || c.lng[i] > clip[2] || c.lat[i] < clip[1] || c.lat[i] > clip[3])) continue;
      idx.push(i);
    }
    if (idx.length) { parts.push({ c, idx }); n += idx.length; }
  }
  const cs = { res, n, h: new Array(n), s: new Int16Array(n), a: new Int16Array(n), p: new Int16Array(n), d: new Int16Array(n), parts, area: (await manifest(res)).area };
  let o = 0;
  for (const { c, idx } of parts) {
    for (const i of idx) {
      cs.h[o] = c.h[i]; cs.s[o] = c.s[i]; cs.a[o] = c.a[i]; cs.p[o] = c.p[i]; cs.d[o] = c.d[i];
      o++;
    }
  }
  return cs;
}

function decodeValues(buf, q) {
  const out = new Float32Array(q.dtype === 'u8' ? buf.byteLength : buf.byteLength / 2);
  if (q.dtype === 'u8') {
    const a = new Uint8Array(buf);
    for (let i = 0; i < a.length; i++) out[i] = a[i] === 255 ? NaN : a[i] * q.scale;
  } else {
    const a = new Uint16Array(buf);
    if (q.t === 'sqrt') for (let i = 0; i < a.length; i++) { const x = a[i] * q.scale; out[i] = a[i] === 65535 ? NaN : x * x; }
    else for (let i = 0; i < a.length; i++) out[i] = a[i] === 65535 ? NaN : q.offset + a[i] * q.scale;
  }
  return out;
}

/** Float32Array of one series-year for every cell of a CellSet (NaN = missing). */
export async function values(cs, series, year) {
  const q = series.q[String(cs.res)];
  if (!q) return null;
  const file = `v/${year == null ? series.id : `${series.id}_${year}`}.bin`;
  const m = await manifest(cs.res);
  const width = q.dtype === 'u8' ? 1 : 2;
  const ks = cs.parts.map((p) => p.c.k);
  const missing = ks.filter((k) => !valueCache.has(`${cs.res}/${file}/${k}`));
  if (missing.length) {
    const p = fetchChunks(url(cs.res, file), m, missing, width);
    for (const k of missing) valueCache.set(`${cs.res}/${file}/${k}`, p.then((b) => decodeValues(b.get(k), q)));
    p.catch(() => missing.forEach((k) => valueCache.delete(`${cs.res}/${file}/${k}`)));
  }
  const arrs = await Promise.all(ks.map((k) => valueCache.get(`${cs.res}/${file}/${k}`)));
  lru(valueCache, MAX_VALUES);
  const out = new Float32Array(cs.n);
  let o = 0;
  cs.parts.forEach(({ idx }, j) => { const a = arrs[j]; for (const i of idx) out[o++] = a[i]; });
  return out;
}

/** The single cell `h3id` (for deep links / search), or null. */
export async function findCell(h3id) {
  const res = h3.getResolution(h3id);
  const m = await manifest(res).catch(() => null);
  if (!m) return null;
  const k = m.byParent.get(h3.cellToParent(h3id, m.chunk_res));
  if (k === undefined) return null;
  const [c] = await indexChunks(res, [k]);
  const i = c.h.indexOf(h3id);
  if (i < 0) return null;
  return { res, h: h3id, s: c.s[i], a: c.a[i], p: c.p[i], d: c.d[i], chunk: c, i };
}
