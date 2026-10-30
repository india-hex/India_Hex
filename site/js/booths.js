/* global pmtiles, maplibregl */
// Booth pins and catchments (polling locations) per election, from PMTiles in data/booths/<election>/,
// plus per-AC detail files for the cards. Which election, which layers and which colours follow the
// state: an election variable on the map couples them to its state and year; otherwise the election
// chips (`bel`) decide, and the layers stay off until switched on (`pins`, `catch`).

let CFG = null;
let BY_ID = new Map();
const details = new Map(); // `${el}/${ac}` -> Promise<detail>

export const NONE = 'rgba(0,0,0,0)';

export function initBooths(cfg) {
  CFG = cfg;
  BY_ID = new Map((cfg.booths?.elections || []).map((e) => [e.id, e]));
  if (cfg.booths && typeof pmtiles !== 'undefined') {
    const protocol = new pmtiles.Protocol();
    maplibregl.addProtocol('pmtiles', protocol.tile);
  }
}

export const boothElections = () => CFG.booths?.elections || [];
export const electionById = (id) => BY_ID.get(id) || null;
export const boothMinZoom = () => CFG.booths?.minzoom ?? 10;

/** Elections of one state (by units.json state key), oldest first. */
export const electionsOf = (stateKey) => boothElections().filter((e) => e.state === stateKey).sort((a, b) => a.year - b.year);

/** The election an election-series lens belongs to (same prefix and year), or null. */
export function electionOfLens(lens) {
  if (!lens || lens.none || !lens.states) return null;
  return boothElections().find((e) => e.prefix && lens.id.startsWith(e.prefix) && e.year === lens.year) || null;
}

/**
 * The election in effect for a state key: the one on the map (election variable), else the chip
 * choice if it is in that state, else the state's latest election. null when the state has none.
 */
export function electionFor(stateKey, st, lens) {
  const onMap = electionOfLens(lens);
  if (onMap && onMap.state === stateKey) return onMap;
  const chip = electionById(st.bel);
  if (chip && chip.state === stateKey) return chip;
  const all = electionsOf(stateKey);
  return all.length ? all[all.length - 1] : null;
}

/**
 * What the booth layers show: {el, pins, catchMode, auto} or null. Auto ('' in the store): with an
 * election variable on the map, pins on and catchments as outlines over hexagons (filled without);
 * with any other variable, both off. Explicit choices win.
 */
export function boothView(st, lens, curStateKey) {
  if (!CFG.booths) return null;
  const onMap = electionOfLens(lens);
  const el = onMap || electionById(st.bel) || (curStateKey ? electionFor(curStateKey, st, lens) : null);
  if (!el) return null;
  const hexes = st.res !== 'off';
  const pins = st.pins === 'on' ? true : st.pins === 'off' ? false : !!onMap;
  let catchMode = st.catch || (onMap ? (hexes ? 'line' : 'fill') : 'off');
  if (!['off', 'line', 'fill'].includes(catchMode)) catchMode = 'off';
  return { el, pins, catchMode, coupled: !!onMap, auto: !st.pins && !st.catch };
}

// ---- colours -------------------------------------------------------------------------------------
/** match expression on lead_code: party colours, ties grey, no votes transparent. */
export function leadExpr(el, none = NONE) {
  const m = ['match', ['get', 'lead_code']];
  for (const c of el.lead) m.push(c.code, c.color);
  m.push(none);
  return m;
}

/**
 * Colour of the booth layers for a lens: the same share / margin / turnout field on the same scale
 * as the hexagons, else the leading party. sc: the map's scale ({breaks, colors}).
 * Returns {expr, kind: 'lead' | 'field', field, factor}.
 */
export function boothColour(el, lens, sc) {
  const lead = { expr: leadExpr(el), pinExpr: leadExpr(el, '#ffffff'), kind: 'lead' };
  if (!lens || lens.none || lens.mode !== 'value' || lens.density || !sc || sc.cat || !electionOfLens(lens) || electionOfLens(lens).id !== el.id) return lead;
  const bare = lens.id.slice(el.prefix.length);
  let field = null; let factor = 1000;
  if (bare === 'turnout_share') field = el.fields.booths.includes('turnout_pm') ? 'turnout_pm' : null;
  else if (bare.endsWith('_share')) field = `${bare.slice(0, -6)}_pm`;
  else if (lens.series.diverging && bare.endsWith('_margin_pp')) { field = 'margin_pm'; factor = 10; }
  if (!field || !el.fields.booths.includes(field) || !el.fields.catchments.includes(field)) return lead;
  const value = ['/', ['get', field], factor];
  const step = ['step', value, sc.colors[0]];
  sc.breaks.forEach((b, i) => step.push(b, sc.colors[i + 1]));
  return {
    expr: ['case', ['has', field], step, NONE],
    pinExpr: ['case', ['has', field], step, '#ffffff'],
    kind: 'field', field, factor,
  };
}

// ---- detail files (per AC, loaded on click) ------------------------------------------------------
const pad3 = (n) => String(n).padStart(3, '0');

/** Booth and location rows of one AC of an election, as objects keyed by uid / loc. */
export function detailFor(el, acNo) {
  const key = `${el.id}/${acNo}`;
  if (!details.has(key)) {
    details.set(key, fetch(`data/booths/${el.id}/ac_${pad3(acNo)}.json?v=${el.v}`).then((r) => (r.ok ? r.json() : null)).then((j) => {
      if (!j) return null;
      const rows = (fields, data) => data.map((r) => Object.fromEntries(fields.map((f, i) => [f, r[i]])));
      const booths = rows(j.booth_fields, j.booths);
      const locs = rows(j.location_fields, j.locations);
      const areas = new Map((j.areas || []).map(([loc, a1, a0]) => [loc, [a1, a0]]));
      return {
        ...j,
        booth: new Map(booths.map((b) => [b.uid, b])),
        loc: new Map(locs.map((l) => [l.loc, l])),
        boothsAt: (loc) => booths.filter((b) => b.loc === loc),
        area: (loc) => areas.get(loc) || null,
      };
    }).catch(() => null));
  }
  return details.get(key);
}

/** Votes per lead category, the leading one (or 'tie') and the bloc margin for a booth/location row. */
export function resultOf(el, row) {
  const v = (p) => row[p] ?? 0;
  // an alliance bucket (inc_jds, bjp_jds) is the sum of its parties' columns
  const cats = el.lead.filter((c) => c.id !== 'tie').map((c) => ({ ...c, votes: c.id.split('_').reduce((t, p) => t + v(p), 0) }));
  const total = row.votes ?? 0;
  const sorted = [...cats].sort((a, b) => b.votes - a.votes);
  let lead = null;
  if (total > 0 && sorted.length) lead = sorted.length > 1 && sorted[0].votes === sorted[1].votes ? el.lead.find((c) => c.id === 'tie') : sorted[0];
  const side = (re) => cats.find((c) => re.test(c.id));
  const a = side(/^(bjp|nda)/); const b = side(/^(inc|mgb)/);
  const margin = total > 0 && a && b ? ((a.votes - b.votes) / total) * 100 : null;
  return { cats, lead, margin, total };
}
