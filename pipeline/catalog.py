"""Discover every publishable variable in processed/h{res}/ and describe it as a Series.

A Series is one quantity, possibly over several years (columns ending in _YYYY are grouped).
Inference from the column name supplies label, aggregation, storage type and colour ramp;
india_hex.yaml `variables.overrides` wins over every inferred field.
"""
import fnmatch
import re
from dataclasses import dataclass, field, asdict
from pathlib import Path

import duckdb

GEO_COLS = {
    "h3_index", "lat", "lng", "state", "ac_key", "ac_no", "ac_name", "pc_key", "pc_name",
    "district_lgd", "district_lgd_key", "district_c2011", "district_c2011_key", "h6_index",
    "h8_index", "hex_area_m2", "in_ntl_grid", "near_ac_pc_border",
}
NUMERIC = ("DOUBLE", "FLOAT", "REAL", "BIGINT", "INTEGER", "SMALLINT", "TINYINT", "HUGEINT",
           "UBIGINT", "UINTEGER", "USMALLINT", "UTINYINT", "BOOLEAN", "DECIMAL")
YEAR_RE = re.compile(r"^(.*?)_((?:19|20)\d{2})$")


@dataclass
class Series:
    id: str
    dataset: str
    group: str
    file: str                       # template relative to processed/h{res}/
    cols: dict                      # year (int) or None -> source column (or (segment, column) when pivoted)
    pivot: str | None = None
    period: list | None = None      # long table over time: columns that identify the period
    fill_missing: float | None = None
    label: str = ""
    unit: str = ""
    note: str = ""
    ramp: str = "viridis"
    format: str = "dec2"
    agg: str = "sum"
    density: bool = False
    dtype: str = "u16"              # u8 (shares, 0-1) | u16
    default_year: int | None = None  # year shown first (e.g. skip projections)
    res_years: dict = field(default_factory=dict)   # res -> [years] actually published

    @property
    def years(self):
        return sorted(y for y in self.cols if y is not None)

    def files(self):
        """(res, year, published file name) for everything this series publishes."""
        for res, years in self.res_years.items():
            for y in years:
                yield res, y, self.bin_name(y)

    def bin_name(self, year):
        return f"{self.id}_{year}.bin" if year is not None else f"{self.id}.bin"

    def to_client(self):
        d = asdict(self)
        d.pop("cols"), d.pop("file"), d.pop("pivot"), d.pop("fill_missing"), d.pop("dataset"), d.pop("period")
        d["years"] = self.years
        d["res_years"] = {str(r): ys for r, ys in self.res_years.items()}
        return d


def _humanise(name):
    s = name.replace("_", " ").strip()
    s = re.sub(r"\binr\b", "₹", s)
    s = re.sub(r"\bm2\b", "m²", s)
    s = re.sub(r"\bm3\b", "m³", s)
    s = re.sub(r"\bntl\b", "night lights", s)
    return s[:1].upper() + s[1:]


def _infer(series: Series):
    n = series.id.lower()
    if "share" in n or n.startswith("is_"):
        series.dtype, series.format, series.agg, series.density, series.ramp = "u8", "pct", "mean", False, "ylgn"
    elif any(t in n for t in ("median", "rate", "price")):
        series.format, series.agg, series.density, series.ramp = "inr" if "inr" in n else "dec1", "median", False, "viridis"
    elif any(t in n for t in ("mean", "avg", "height", "pct")):
        series.format, series.agg, series.density, series.ramp = "dec2", "mean", False, "magma"
    else:
        series.format, series.agg, series.density, series.ramp = "int", "sum", True, "ylorrd"
    if "change" in n:
        series.ramp = "rdbu"
    series.label = _humanise(series.id)


def _numeric_columns(con, path):
    rows = con.sql(f"DESCRIBE SELECT * FROM '{path}'").fetchall()
    return [r[0] for r in rows if r[0] not in GEO_COLS and r[1].upper().startswith(NUMERIC)], {r[0] for r in rows}


def _excluded(name, patterns):
    return any(fnmatch.fnmatch(name, p) for p in patterns)


def _group_years(columns):
    """{base: {year|None: column}} grouping *_YYYY columns into series."""
    out = {}
    for c in columns:
        m = YEAR_RE.match(c)
        if m and not re.search(r"_(?:19|20)\d{2}$", m.group(1)):
            out.setdefault(m.group(1), {})[int(m.group(2))] = c
        else:
            out.setdefault(c, {})[None] = c
    return out


def _h8_years(years, policy):
    if not years or years == [None]:
        return [None]
    years = sorted(years)
    if policy == "all":
        return years
    latest = years[-1]
    if policy == "latest":
        return [latest]
    keep = {latest, years[0]} | {y for y in years if (latest - y) % 5 == 0}
    return sorted(keep)


def _datasets(cfg):
    """Known datasets from india_hex.yaml plus auto-discovered parquet files."""
    vcfg = cfg["variables"]
    ds = {k: dict(v) for k, v in (vcfg.get("datasets") or {}).items()}
    if not vcfg.get("auto_discover", True):
        return ds
    known = {cfg.hex_file(v["file"], 8).resolve() for v in ds.values()}
    base = cfg.processed / "h8"
    for p in sorted(base.rglob("*.parquet")):
        rel = p.relative_to(base).as_posix()
        if p.resolve() in known or any(fnmatch.fnmatch(p.name, pat) for pat in vcfg.get("skip_files", [])):
            continue
        template = re.sub(r"(?<![a-z0-9])h8(?![0-9])", "h{res}", rel)
        key = re.sub(r"^h8_", "", p.stem)
        group = p.parent.name.replace("_", " ").title() if p.parent != base else "Other"
        ds[key] = {"file": template, "group": group, "auto": True}
    return ds


def discover(cfg, verbose=False):
    vcfg = cfg["variables"]
    excl = vcfg.get("exclude", [])
    overrides = vcfg.get("overrides", {})
    h8_list = vcfg.get("h8", [])
    h8_all = "all" in h8_list
    con = duckdb.connect()
    series, seen = [], set()

    for ds_id, ds in _datasets(cfg).items():
        res_paths = {r: cfg.hex_file(ds["file"], r) for r in cfg.resolutions}
        res_paths = {r: p for r, p in res_paths.items() if p.exists()}
        if 8 not in res_paths and verbose:
            print(f"  [catalog] {ds_id}: no H8 file; skipped (units are aggregated from H8)")
        if 8 not in res_paths:
            continue
        cols, allcols = _numeric_columns(con, res_paths[8])
        if "h3_index" not in allcols:
            continue
        pivot = ds.get("pivot")
        period = ds.get("period")
        if pivot:
            segs = ds.get("segments") or [r[0] for r in con.sql(
                f"SELECT DISTINCT {pivot} FROM '{res_paths[8]}' ORDER BY 1").fetchall()]
            if period:
                # one row per cell, segment and period: each period becomes a "year" of the series.
                # A date column ('YYYY-MM-DD') is coded YYYYMM (202603 = Mar 2026); a number stays as is.
                cols = [c for c in cols if c not in period and c not in (ds.get("ignore") or [])]
                plist = con.sql(f"SELECT DISTINCT {', '.join(period)} FROM '{res_paths[8]}' ORDER BY ALL").fetchall()
                code = lambda p: int(p[0][:4]) * 100 + int(p[0][5:7]) if isinstance(p[0], str) else int(p[0])
                groups = {f"{s}_{c}": {code(p): (s, c, tuple(p)) for p in plist} for s in segs for c in cols}
            else:
                groups = {f"{s}_{c}": {None: (s, c)} for s in segs for c in cols}
        else:
            if ds.get("auto"):
                p6 = res_paths.get(min(res_paths))
                n, nu = con.sql(f"SELECT count(*), count(DISTINCT h3_index) FROM '{p6}'").fetchone()
                if n != nu:
                    if verbose:
                        print(f"  [catalog] {ds_id}: several rows per cell and no `pivot:` set; skipped")
                    continue
            groups = _group_years(cols)
        for sid, colmap in groups.items():
            if _excluded(sid, excl) or any(_excluded(c if isinstance(c, str) else "_".join(c[:2]), excl) for c in colmap.values()):
                continue
            uid = sid if sid not in seen else f"{ds_id}_{sid}"
            seen.add(uid)
            s = Series(id=uid, dataset=ds_id, group=ds.get("group", "Other"), file=ds["file"], cols=colmap,
                       pivot=pivot, period=period, fill_missing=ds.get("fill_missing"))
            _infer(s)
            for k, v in (overrides.get(uid) or overrides.get(sid) or {}).items():
                setattr(s, k, v)
            if s.format == "pct":
                s.dtype = "u8"
            years = s.years or [None]
            for r in res_paths:
                if r == 8 and not (h8_all or uid in h8_list or sid in h8_list):
                    continue
                s.res_years[r] = _h8_years(years, vcfg.get("h8_years", "latest_and_steps")) if r == 8 else years
            series.append(s)

    featured = vcfg.get("featured", [])
    series.sort(key=lambda s: (featured.index(s.id) if s.id in featured else len(featured)))
    return series


def size_estimate(series, cell_counts):
    """Bytes of variable files that `series` will publish."""
    total = 0
    for s in series:
        b = 1 if s.dtype == "u8" else 2
        for r, years in s.res_years.items():
            total += b * cell_counts.get(r, 0) * len(years)
    return total
