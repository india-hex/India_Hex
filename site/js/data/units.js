// Units (state / district / pc / ac): metadata from units.json, values per variable lazily from
// data/units/v/<series>.json  ({"y": [years], "<level>": [[value per unit id] per year]}).

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

export function unitFile(seriesId) {
  if (!valueFiles.has(seriesId)) {
    valueFiles.set(seriesId, fetch(`data/units/v/${seriesId}.json?v=${VER}`).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  }
  return valueFiles.get(seriesId);
}

/** Raw (untransformed) values of one series-year for every unit of a level, or null. */
export async function rawUnitValues(seriesId, level, year) {
  const f = await unitFile(seriesId);
  if (!f) return null;
  const yi = f.y.indexOf(year ?? null);
  return yi < 0 ? null : f[level][yi];
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
