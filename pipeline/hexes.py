"""Hexagon index and variable files.

Per resolution r (all little-endian):

  data/hex/h{r}/manifest.json   {"res", "chunk_res", "n", "parents": [...], "start": [... n_chunks + 1]}
  data/hex/h{r}/index.bin       cells grouped by H3 parent chunk (parents sorted by H3 id, cells by code).
                                Chunk k occupies bytes [10*start[k], 10*start[k+1]) laid out as
                                  uint16 code[n] | int16 state[n] | int16 ac[n] | int16 pc[n] | int16 district[n]
                                code = the cell's 4 H3 digits below its parent (12 bits); ids = unit ids (-1 none).
  data/hex/h{r}/v/{series}[_{year}].bin
                                one value per cell in index order: uint8 (shares) or uint16.
                                Chunk k's values are bytes [w*start[k], w*start[k+1]), w = 1 or 2.

So any chunk of any variable is one HTTP Range request; adding a variable adds files and touches
nothing else. Decoding (catalog `q` per series and resolution):
  u8   value = q * scale                        (255 = missing)
  u16  sqrt:   value = (q * scale) ** 2          (65535 = missing)
       linear: value = offset + q * scale
"""
import json

import duckdb
import h3
import numpy as np
import pandas as pd

from .config import DATA
from .util import log

U8_MISSING, U16_MISSING = 255, 65535


# ---------------------------------------------------------------------------------------------
# Cells and index
# ---------------------------------------------------------------------------------------------

def cell_table(cfg, res, h8_ac=None):
    """Every cell at `res` with its geography (from the night-lights file, which holds all cells)."""
    ntl = cfg.hex_file(cfg["variables"]["datasets"]["ntl"]["file"], res)
    pop = cfg.hex_file(cfg["variables"]["datasets"]["population"]["file"], res)
    ac = "n.ac_key" if res != 6 else "NULL::VARCHAR AS ac_key"
    df = duckdb.sql(f"""
        SELECT n.h3_index, n.lat, n.lng, n.state, {ac}, n.pc_key, n.district_lgd_key, p.hex_area_m2
        FROM '{ntl}' n LEFT JOIN '{pop}' p USING (h3_index)
    """).df()
    if res == 6 and h8_ac is not None:
        # H6 has no AC column: take the AC of the H8 hexagon at the cell centre (source rule).
        centres = [h3.latlng_to_cell(la, ln, 8) for la, ln in zip(df.lat.values, df.lng.values)]
        df["ac_key"] = pd.Series(centres, index=df.index).map(h8_ac)
    return df


def h3_codes(h3_strings, res, levels):
    """Vectorised (parent id, 12-bit child code) for each cell."""
    x = np.array([int(s, 16) for s in h3_strings], dtype=np.uint64)
    pres = res - levels
    code = np.zeros(len(x), dtype=np.uint64)
    parent = (x & ~np.uint64(0xF << 52)) | np.uint64(pres << 52)
    for r in range(pres + 1, res + 1):
        s = np.uint64((15 - r) * 3)
        code = (code << np.uint64(3)) | ((x >> s) & np.uint64(7))
        parent |= np.uint64(7) << s
    return parent, code.astype(np.uint16)


def build_index(cfg, res, cells, units):
    """Write index.bin + manifest.json; return the cells' h3 ids in file order."""
    from .geo import lgd_state_series
    idx = {lvl: {u["key"]: u["id"] for u in units[lvl]} for lvl in units}
    levels = cfg.chunk_levels
    parent, code = h3_codes(cells.h3_index.values, res, levels)
    order = np.lexsort((code, parent))
    parent, code = parent[order], code[order]
    c = cells.iloc[order].reset_index(drop=True)
    ids = {
        "s": lgd_state_series(c).map(idx["state"]),
        "a": c.ac_key.map(idx["ac"]),
        "p": c.pc_key.map(idx["pc"]),
        "d": c.district_lgd_key.map(idx["district"]),
    }
    ids = {k: v.fillna(-1).astype(np.int16).to_numpy() for k, v in ids.items()}
    bounds = np.flatnonzero(np.r_[True, parent[1:] != parent[:-1], True])
    out = DATA / "hex" / f"h{res}"
    out.mkdir(parents=True, exist_ok=True)
    with open(out / "index.bin", "wb") as f:
        for i in range(len(bounds) - 1):
            a, b = bounds[i], bounds[i + 1]
            f.write(code[a:b].astype("<u2").tobytes())
            for k in ("s", "a", "p", "d"):
                f.write(ids[k][a:b].astype("<i2").tobytes())
    manifest = {
        "res": res, "chunk_res": res - levels, "n": int(len(c)),
        "parents": [format(int(parent[i]), "x") for i in bounds[:-1]],
        "start": [int(i) for i in bounds],
    }
    (out / "manifest.json").write_text(json.dumps(manifest, separators=(",", ":")))
    log(f"  h{res}: index {len(c):,} cells in {len(bounds) - 1} chunks ({(out / 'index.bin').stat().st_size / 1e6:.1f} MB)")
    return h3_to_u64(c.h3_index.to_numpy()), ids


# ---------------------------------------------------------------------------------------------
# Variables
# ---------------------------------------------------------------------------------------------

def h3_to_u64(strings):
    return np.fromiter((int(x, 16) for x in strings), dtype=np.uint64, count=len(strings))


class Aligner:
    """Maps source rows (by numeric H3 id) to positions in index order."""

    def __init__(self, order_ids):
        self.n = len(order_ids)
        self.sort = np.argsort(order_ids)
        self.sorted = order_ids[self.sort]

    def positions(self, src_ids):
        j = np.searchsorted(self.sorted, src_ids)
        j[j >= self.n] = 0
        return np.where(self.sorted[j] == src_ids, self.sort[j], -1)

    def scatter(self, pos, vals):
        out = np.full(self.n, np.nan, dtype=np.float32)
        m = pos >= 0
        out[pos[m]] = vals[m]
        return out


class SeriesReader:
    """Reads one column at a time (DuckDB keeps parquet row order), aligned to index order."""

    def __init__(self, cfg, res, aligner):
        self.cfg, self.res, self.al = cfg, res, aligner
        self._pos = {}

    def _positions(self, path):
        if path not in self._pos:
            ids = duckdb.sql(f"SELECT h3_index FROM '{path}'").fetchnumpy()["h3_index"]
            self._pos[path] = self.al.positions(h3_to_u64(ids))
        return self._pos[path]

    def column(self, series, year):
        path = self.cfg.hex_file(series.file, self.res)
        col = series.cols[year]
        if series.pivot:
            seg, c = col
            r = duckdb.sql(f"SELECT h3_index, {c} AS v FROM '{path}' WHERE {series.pivot} = '{seg}'").fetchnumpy()
            pos = self.al.positions(h3_to_u64(r["h3_index"]))
            vals = np.asarray(r["v"], dtype="float64")
        else:
            pos = self._positions(path)
            vals = duckdb.sql(f"SELECT {col} AS v FROM '{path}'").fetchnumpy()["v"]
            vals = np.ma.filled(vals.astype("float64"), np.nan) if np.ma.isMaskedArray(vals) else np.asarray(vals, dtype="float64")
            if len(vals) != len(pos):
                raise RuntimeError(f"row count changed while reading {path}")
        out = self.al.scatter(pos, vals.astype(np.float32))
        if series.fill_missing is not None:
            out[np.isnan(out)] = series.fill_missing
        return out


def quant_params(series, arrays):
    """Shared decoding parameters for all years of one series at one resolution."""
    if series.dtype == "u8":
        return {"dtype": "u8", "t": "linear", "scale": 1 / 250, "offset": 0}
    vals = np.concatenate([a[~np.isnan(a)] for a in arrays]) if arrays else np.array([])
    if not len(vals):
        return {"dtype": "u16", "t": "linear", "scale": 1, "offset": 0}
    vmin, vmax = float(vals.min()), float(vals.max())
    if vmin >= 0 and vmax <= 65534 and np.all(np.mod(vals, 1) == 0):
        return {"dtype": "u16", "t": "linear", "scale": 1, "offset": 0}
    if vmin >= 0:
        return {"dtype": "u16", "t": "sqrt", "scale": (np.sqrt(vmax) / 65534) or 1, "offset": 0}
    return {"dtype": "u16", "t": "linear", "scale": ((vmax - vmin) / 65534) or 1, "offset": vmin}


def encode(v, q):
    nan = np.isnan(v)
    if q["dtype"] == "u8":
        out = np.round(np.clip(np.nan_to_num(v), 0, 1) / q["scale"]).astype(np.uint8)
        out[nan] = U8_MISSING
        return out
    x = np.nan_to_num(v)
    x = np.sqrt(np.clip(x, 0, None)) / q["scale"] if q["t"] == "sqrt" else (x - q["offset"]) / q["scale"]
    out = np.clip(np.round(x), 0, 65534).astype("<u2")
    out[nan] = U16_MISSING
    return out


def decode(raw: bytes, q):
    """Inverse of encode (used for All-India breaks)."""
    if q["dtype"] == "u8":
        a = np.frombuffer(raw, np.uint8).astype("float64")
        out = a * q["scale"]
        out[a == U8_MISSING] = np.nan
        return out
    a = np.frombuffer(raw, "<u2").astype("float64")
    out = (a * q["scale"]) ** 2 if q["t"] == "sqrt" else q["offset"] + a * q["scale"]
    out[a == U16_MISSING] = np.nan
    return out


def write_series(res, series, arrays_by_year, q):
    out = DATA / "hex" / f"h{res}" / "v"
    out.mkdir(parents=True, exist_ok=True)
    for y in series.res_years[res]:
        (out / series.bin_name(y)).write_bytes(encode(arrays_by_year[y], q).tobytes())


# ---------------------------------------------------------------------------------------------
# Unit aggregates (always from H8, the finest cells)
# ---------------------------------------------------------------------------------------------

def _sig4(x):
    return None if x is None or not np.isfinite(x) else float(f"{x:.5g}")


def aggregate(series, arrays_by_year, ids, n_units):
    """{"y": [...], "<level>": [[values per unit] per year]} from H8 values."""
    out = {"y": [y for y in (series.years or [None])]}
    keys = {"state": "s", "district": "d", "pc": "p", "ac": "a"}
    for lvl, k in keys.items():
        g = ids[k].astype(np.int64)
        per_year = []
        for y in out["y"]:
            v = arrays_by_year[y]
            ok = (g >= 0) & ~np.isnan(v)
            n = n_units[lvl]
            if series.agg == "median":
                med = pd.Series(v[ok]).groupby(g[ok]).median()
                arr = np.full(n, np.nan)
                arr[med.index.to_numpy()] = med.to_numpy()
            else:
                s = np.bincount(g[ok], weights=v[ok], minlength=n)[:n]
                c = np.bincount(g[ok], minlength=n)[:n]
                with np.errstate(invalid="ignore", divide="ignore"):
                    arr = s / c if series.agg == "mean" else np.where(c > 0, s, np.nan)
            per_year.append([_sig4(x) for x in arr])
        out[lvl] = per_year
    return out
