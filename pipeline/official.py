"""Unit values from official results (one row per assembly constituency) for election datasets.

india_hex.yaml, per dataset:
  units_table:
    path:    .../karnataka_ae{year}_ac_official.parquet   ({year} filled in per election)
    state:   KARNATAKA                                   (state key as in units.json)
    key:     ac_no                                       (AC number column)
    weights: {votes_{year}: total_valid_{year}}          (series weight -> table column used to combine ACs)
    lead:    {column: lead_bucket_{year}, share: "{cat}_share_{year}"}
    na_flag: incomplete_booth_data                       (ACs whose missing cells the map draws grey)

AC values are the table's own. PC, district and state values combine their ACs exactly: a share or
margin weighted by the share denominator (valid votes) equals summed party votes over summed valid
votes, turnout weighted by electors equals summed votes over summed electors, and counts are summed.
A unit's leading category is the one with the largest combined share. Districts group ACs by the
district holding most of the AC's H8 cells, so district values are approximate.
"""
import duckdb
import numpy as np

from .hexes import _sig4
from .util import file_sig, log

LEVELS = ("state", "district", "pc", "ac")


def table_path(spec, year):
    return spec["path"].format(year=year)


def signature(series):
    spec = series.units_table
    return [file_sig(table_path(spec, y)) for y in series.years] if spec else None


def _table(spec, year, cache={}):
    p = table_path(spec, year)
    if p not in cache:
        cache[p] = duckdb.sql(f"SELECT * FROM '{p}'").df()
    return cache[p]


def flagged_acs(spec, units, years):
    """{year: [site AC ids]} whose `na_flag` column is true (e.g. incomplete booth data)."""
    if not spec or not spec.get("na_flag"):
        return None
    st = next(u["id"] for u in units["state"] if u["key"] == spec["state"])
    by_no = {u["no"]: u["id"] for u in units["ac"] if u["st"] == st}
    out = {}
    for y in years:
        df = _table(spec, y)
        out[str(y)] = sorted(by_no[k] for k, f in zip(df[spec["key"]], df[spec["na_flag"]]) if bool(f))
    return out


def ac_district(ids8, n_ac):
    """District id holding most of each AC's H8 cells (-1 when the AC has none)."""
    a, d = ids8["a"].astype(np.int64), ids8["d"].astype(np.int64)
    ok = (a >= 0) & (d >= 0)
    out = np.full(n_ac, -1)
    if ok.any():
        pairs = np.unique(np.stack([a[ok], d[ok]]), axis=1, return_counts=True)
        (aa, dd), cnt = pairs
        order = np.lexsort((-cnt, aa))
        first = np.r_[True, aa[order][1:] != aa[order][:-1]]
        out[aa[order][first]] = dd[order][first]
    return out


def _combine(vals, wts, groups, n, how):
    """Combine AC values into n units by group id (wmean or sum); NaN where a unit has no AC."""
    ok = groups >= 0
    if how == "sum":
        s = np.bincount(groups[ok], weights=vals[ok], minlength=n)[:n]
        c = np.bincount(groups[ok], minlength=n)[:n]
        return np.where(c > 0, s, np.nan)
    s = np.bincount(groups[ok], weights=vals[ok] * wts[ok], minlength=n)[:n]
    c = np.bincount(groups[ok], weights=wts[ok], minlength=n)[:n]
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(c > 0, s / c, np.nan)


class Official:
    """Official AC rows of one dataset mapped onto the site's units."""

    def __init__(self, spec, units, ids8):
        self.spec, self.units = spec, units
        st = [u for u in units["state"] if u["key"] == spec["state"]]
        if not st:
            raise ValueError(f"units_table: state {spec['state']} not in units.json")
        self.state = st[0]["id"]
        self.n = {lvl: len(units[lvl]) for lvl in LEVELS}
        acs = [u for u in units["ac"] if u["st"] == self.state]
        self.ac_by_no = {u["no"]: u["id"] for u in acs}
        self.ac_pc = np.array([u.get("pc", -1) for u in units["ac"]])
        self.ac_d = ac_district(ids8, self.n["ac"])
        self.n_district_fallback = 0

    def rows(self, year):
        """Table for `year` plus the site AC id of every row."""
        df = _table(self.spec, year)
        ids = df[self.spec["key"]].map(self.ac_by_no)
        missing = df[self.spec["key"]][ids.isna()].tolist()
        if missing:
            raise ValueError(f"{table_path(self.spec, year)}: AC numbers not in the site's {self.spec['state']} ACs: {missing[:10]}")
        return df, ids.astype(int).to_numpy()

    def _groups(self, ac_ids, lvl):
        if lvl == "ac":
            return ac_ids
        if lvl == "pc":
            return self.ac_pc[ac_ids]
        if lvl == "district":
            return self.ac_d[ac_ids]
        return np.full(len(ac_ids), self.state)

    def values(self, series, year):
        """{level: per-unit array} for one year; NaN for units without official rows."""
        df, ac_ids = self.rows(year)
        out = {}
        if series.type == "categorical":
            lead = self.spec["lead"]
            col = lead["column"].format(year=year)
            codes = {c["id"]: i for i, c in enumerate(series.categories)}
            cats = [c["id"] for c in series.categories if year in c["years"]]
            bad = set(df[col]) - set(cats)
            if bad:
                raise ValueError(f"{series.id} {year}: official {col} has categories {bad} not in the series")
            w = df[self._weight_col(series, year, lead_weight=True)].to_numpy(float)
            for lvl in LEVELS:
                arr = np.full(self.n[lvl], np.nan)
                if lvl == "ac":
                    arr[ac_ids] = df[col].map(codes).to_numpy(float)
                else:
                    g = self._groups(ac_ids, lvl)
                    shares = np.stack([_combine(df[lead["share"].format(cat=c, year=year)].to_numpy(float), w, g, self.n[lvl], "wmean")
                                       for c in cats])
                    have = ~np.all(np.isnan(shares), axis=0)
                    best = np.nanargmax(np.where(np.isnan(shares), -1, shares), axis=0)
                    arr[have] = np.array([codes[cats[b]] for b in best[have]], float)
                out[lvl] = arr
            return out
        col = (series.official_col or series.cols[year]).format(year=year)
        if col not in df:
            raise ValueError(f"{series.id} {year}: column {col} not in {table_path(self.spec, year)}")
        v = df[col].to_numpy(float)
        how = "sum" if series.agg == "sum" else "wmean"
        w = df[self._weight_col(series, year)].to_numpy(float) if how == "wmean" else None
        for lvl in LEVELS:
            if lvl == "ac":
                arr = np.full(self.n["ac"], np.nan)
                arr[ac_ids] = v
            else:
                arr = _combine(v, w, self._groups(ac_ids, lvl), self.n[lvl], how)
            out[lvl] = arr
        return out

    def _weight_col(self, series, year, lead_weight=False):
        wmap = self.spec.get("weights") or {}
        name = self.spec["lead"].get("weight", "votes_{year}") if lead_weight else series.weight
        if not name:
            raise ValueError(f"{series.id}: needs a weight to combine official AC values")
        return wmap.get(name, name).format(year=year)

    def apply(self, series, agg):
        """Overwrite hexagon aggregates with official values wherever the table has them."""
        n_fallback = {lvl: 0 for lvl in LEVELS}
        for j, y in enumerate(agg["y"]):
            off = self.values(series, y)
            for lvl in LEVELS:
                cur = agg[lvl][j]
                o = off[lvl]
                for i, x in enumerate(o):
                    if np.isfinite(x):
                        cur[i] = _sig4(x)
                    elif cur[i] is not None:
                        n_fallback[lvl] += 1
        fb = {k: v for k, v in n_fallback.items() if v}
        if fb:
            log(f"  {series.id}: hexagon fallback (no official rows) for {fb}")
        return agg
