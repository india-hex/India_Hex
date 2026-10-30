// Tiny reactive store. Every feature reads state and subscribes to the keys it cares about,
// so new features plug in without touching existing ones:
//   store.on(['var', 'year'], (state, prev) => …)
// URL-hash persistence lives here too (HASH_KEYS: which keys are shareable and how).

export function createStore(initial) {
  let state = { ...initial };
  const subs = [];
  let queued = null;

  function flush() {
    const { prev, changed } = queued;
    queued = null;
    for (const [keys, fn] of subs) {
      if (!keys || keys.some((k) => changed.has(k))) {
        try { fn(state, prev, changed); } catch (e) { console.error(e); }
      }
    }
  }

  return {
    get: () => state,
    /** Merge a patch; subscribers run once per microtask with the union of changed keys. */
    set(patch) {
      const prev = state;
      const next = { ...state, ...patch };
      const changed = Object.keys(patch).filter((k) => !Object.is(prev[k], next[k]));
      if (!changed.length) return;
      state = next;
      if (!queued) {
        queued = { prev, changed: new Set(changed) };
        queueMicrotask(flush);
      } else changed.forEach((k) => queued.changed.add(k));
    },
    on(keys, fn) { subs.push([keys, fn]); return fn; },
  };
}

// ----------------------------------------------------------------------------------------------
// URL hash: short names, only non-default values
// ----------------------------------------------------------------------------------------------
const HASH_KEYS = {
  sel: 's', level: 'l', res: 'h', scope: 'sc', var: 'v', year: 'y', mode: 'md', from: 'f',
  density: 'pk', scale: 'k', basemap: 'b', overlays: 'o', threeD: '3d', hex: 'x', compare: 'cmp', view: 'at',
  // booth layers: pins on/off, catchments off/line/fill ('' = automatic), election, selected booth or
  // location; boundary lines drawn besides the active level, and their width multipliers
  pins: 'bp', catch: 'bc', bel: 'be', booth: 'bt', lines: 'ln', lw: 'lw',
};

const enc = {
  sel: (v) => (v ? `${v.level}:${v.key}` : ''),
  overlays: (v) => v.join(','),
  compare: (v) => (v ? `${v.kind}:${v.value}` : ''),
  view: (v) => (v ? v.join('/') : ''),
  booth: (v) => (v ? `${v.el}:${v.k}${v.id}:${v.ac}` : ''),
  lines: (v) => v.join(','),
  lw: (v) => Object.entries(v || {}).filter(([, x]) => x !== 1).map(([l, x]) => `${l}:${x}`).join(','),
};
const dec = {
  sel: (s) => { const i = s.indexOf(':'); return i > 0 ? { level: s.slice(0, i), key: s.slice(i + 1) } : null; },
  overlays: (s) => (s ? s.split(',') : []),
  compare: (s) => { const i = s.indexOf(':'); return i > 0 ? { kind: s.slice(0, i), value: s.slice(i + 1) } : null; },
  res: (s) => (/^\d$/.test(s) ? +s : s),
  year: (s) => (s ? +s : null), from: (s) => (s ? +s : null),
  density: (s) => s === '1', threeD: (s) => s === '1',
  view: (s) => s.split('/').map(Number),
  booth: (s) => { const m = /^([a-z]{2}_[a-z]{2}\d{4}):([bc])(\d+):(\d+)$/.exec(s); return m ? { el: m[1], k: m[2], id: +m[3], ac: +m[4] } : null; },
  lines: (s) => (s ? s.split(',') : []),
  lw: (s) => Object.fromEntries(s.split(',').map((p) => p.split(':')).filter(([l, x]) => l && Number.isFinite(+x)).map(([l, x]) => [l, +x])),
};

export function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const out = {};
  for (const [k, short] of Object.entries(HASH_KEYS)) {
    if (!p.has(short)) continue;
    const raw = p.get(short);
    out[k] = dec[k] ? dec[k](raw) : raw;
  }
  return out;
}

export function writeHash(state, defaults) {
  const p = new URLSearchParams();
  for (const [k, short] of Object.entries(HASH_KEYS)) {
    let v = state[k];
    if (v == null || v === '' || (Array.isArray(v) && !v.length && !(defaults[k] || []).length)) continue;
    if (typeof v === 'boolean') { if (v === !!defaults[k]) continue; v = v ? '1' : '0'; }
    const s = enc[k] ? enc[k](v) : String(v);
    const d = defaults[k] == null ? '' : (enc[k] ? enc[k](defaults[k]) : String(defaults[k]));
    if (s === '' || s === d) continue;
    p.set(short, s);
  }
  const str = p.toString().replace(/%7C/gi, '|').replace(/%3A/gi, ':').replace(/%2C/gi, ',').replace(/%2F/gi, '/');
  history.replaceState(null, '', str ? `#${str}` : location.pathname + location.search);
}
