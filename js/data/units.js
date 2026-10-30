// Units (state / district / pc / ac): metadata from units.json, values per variable and level lazily
// from data/units/v/<series>/<level>.json  ({"y": [years], "v": [[value per unit id] per year]}; official-
// table series may add "x": ACs left out per unit and year, and in the AC file "e": extra columns).

let VER = '';
let U = null;
const valueFiles = new Map();

export const LEVEL_FIELD = { state: 's', district: 'd', pc: 'p', ac: 'a' };

export async function loadUnits(version) {
  VER = version;
  U = await fetch(`data/units.json?v=${VER}`).then((r) => r.json());
  return U;
}

export const units = () => U;
export const unit = (sel) => (sel ? U[sel.level][sel.id] : null);
export const stateName = (i) => (i >= 0 ? U.state[i].name : '');

function unitFile(seriesId, level) {
  const key = `${seriesId}/${level}`;
  if (!valueFiles.has(key)) {
    valueFiles.set(key, fetch(`data/units/v/${key}.json?v=${VER}`).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  }
  return valueFiles.get(key);
}

/**
 * Extra fields of one series-year at a level (official-table series): {left: ACs left out of each
 * unit's value, extra: {name: per-AC values}} (AC level), or null.
 */
export async function unitExtras(seriesId, level, year) {
  const f = await unitFile(seriesId, level);
  if (!f) return null;
  const yi = f.y.indexOf(year ?? null);
  if (yi < 0) return null;
  return { left: f.x ? f.x[yi] : null, extra: f.e ? Object.fromEntries(Object.entries(f.e).map(([k, v]) => [k, v[yi]])) : {} };
}

/** Raw (untransformed) values of one series-year for every unit of a level, or null. */
export async function rawUnitValues(seriesId, level, year) {
  const f = await unitFile(seriesId, level);
  if (!f) return null;
  const yi = f.y.indexOf(year ?? null);
  return yi < 0 ? null : f.v[yi];
}

/** Children of a unit at `level` (ACs of a PC, everything of a state, ACs of a district). */
export function childrenOf(sel, level) {
  if (!sel) return U[level];
  const u = U[sel.level][sel.id];
  if (sel.level === 'state') return U[level].filter((x) => x.st === u.id);
  if (sel.level === 'pc') return U.ac.filter((x) => x.pc === u.id);
  if (sel.level === 'district') return U.ac.filter((x) => x.d === u.id);
  return U.ac.filter((x) => x.pc === u.pc && u.pc >= 0);
}
