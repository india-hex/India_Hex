"""Boundaries (states, districts, PCs, ACs) and unit metadata (units.json).

Join rules (see README §2.2): AC polygons join the AC lookup on State_source|AC_NO|AC_name;
PC keys are ST_NAME|PC_CODE|PC_NAME with ORISSA renamed; states are LGD districts dissolved.
"""
import json
import math

import geopandas as gpd
import pandas as pd
import shapely
import shapely.ops

from .config import DATA
from .util import log

LEVELS = ["state", "district", "pc", "ac"]

STATE_ALIASES = {
    "ORISSA": "ODISHA",
    "DADRA & NAGAR HAVELI": "DADRA,NAGAR HAVELI,DAMAN & DIU",
    "DAMAN & DIU": "DADRA,NAGAR HAVELI,DAMAN & DIU",
}
STATE_DISPLAY = {
    "DADRA,NAGAR HAVELI,DAMAN & DIU": "Dadra & Nagar Haveli and Daman & Diu",
    "ANDAMAN & NICOBAR": "Andaman & Nicobar Islands",
}


def title(s):
    if s is None or (isinstance(s, float) and math.isnan(s)):
        return ""
    s = str(s)
    if s in STATE_DISPLAY:
        return STATE_DISPLAY[s]
    out = []
    for w in s.replace("_", " ").split(" "):
        if not w:
            continue
        if w.startswith("(") and w.endswith(")") and len(w) <= 6:
            out.append(w.upper())
        elif w.lower() in ("and", "of"):
            out.append(w.lower())
        else:
            out.append(w[:1].upper() + w[1:].lower())
    return " ".join(out)


def norm_state(s):
    return STATE_ALIASES.get(s, s)


def lgd_state_series(df):
    """A cell's state: prefix of its LGD district key, else its own state column normalised."""
    s = df.district_lgd_key.str.split("|").str[0]
    return s.fillna(df.state.map(norm_state))


def load_boundaries(cfg):
    dist = gpd.read_file(cfg.boundary_path("district"))
    dist["geometry"] = dist.geometry.apply(
        lambda g: shapely.unary_union([p for p in getattr(g, "geoms", [g]) if p.geom_type in ("Polygon", "MultiPolygon")])
        if g.geom_type == "GeometryCollection" else g)
    dist = dist[["district_key", "district", "State", "geometry"]].rename(
        columns={"district_key": "key", "district": "name", "State": "state"})
    dist["geometry"] = shapely.make_valid(dist.geometry.values)

    states = dist.dissolve(by="state", as_index=False)[["state", "geometry"]]
    states["key"] = states.state
    states["name"] = states.state.map(title)

    pc = gpd.read_file(cfg.boundary_path("pc"))
    pc["ST_NAME"] = pc.ST_NAME.replace({"ORISSA": "ODISHA"})
    pc["key"] = pc.ST_NAME + "|" + pc.PC_CODE.astype(int).astype(str) + "|" + pc.PC_NAME
    pc = pc.rename(columns={"PC_NAME": "name", "PC_CODE": "no"})
    pc["geometry"] = shapely.make_valid(pc.geometry.values)
    pc = pc.dissolve(by="key", as_index=False, aggfunc="first")[["key", "name", "no", "geometry"]]

    ac = gpd.read_file(cfg.boundary_path("ac"))
    lk = pd.read_csv(cfg.boundary_path("ac_lookup"))
    lk["k"] = lk.State_source + "|" + lk.AC_NO.astype(str) + "|" + lk.AC_name
    ac["k"] = ac.ST_NAME + "|" + ac.AC_NO.astype(str) + "|" + ac.AC_NAME.fillna("")
    ac = ac.merge(lk[["k", "ac_key"]], on="k", how="inner")
    ac["geometry"] = shapely.make_valid(ac.geometry.values)
    ac = ac.dissolve(by="ac_key", as_index=False, aggfunc="first")
    ac = ac.rename(columns={"ac_key": "key", "AC_NAME": "name", "AC_NO": "no"})[["key", "name", "no", "geometry"]]
    return {"state": states, "district": dist, "pc": pc, "ac": ac}


def _bbox(geom):
    x0, y0, x1, y1 = geom.bounds
    return [round(x0, 4), round(y0, 4), round(x1, 4), round(y1, 4)]


def _label_point(geom):
    parts = getattr(geom, "geoms", [geom])
    big = max((p for p in parts if p.geom_type == "Polygon"), key=lambda p: p.area, default=None)
    p = geom.representative_point() if big is None else shapely.ops.polylabel(big, tolerance=max(big.length / 2000, 1e-4))
    return [round(p.x, 4), round(p.y, 4)]


def _mode(h8, key_col, val_col):
    return (h8.dropna(subset=[key_col, val_col]).groupby([key_col, val_col]).size()
            .reset_index(name="n").sort_values("n", ascending=False)
            .drop_duplicates(key_col).set_index(key_col)[val_col])


def build_units(cfg, h8, bounds):
    """units.json: names, parents, bbox, label point, H8 cell count and area for every unit.

    h8: DataFrame of H8 cells with state, ac_key, pc_key, district_lgd_key, hex_area_m2.
    Unit ids are positions after sorting by key, stable while the key set is unchanged.
    """
    h8 = h8.copy()
    h8["lgd_state"] = lgd_state_series(h8)
    ac_state, pc_state = _mode(h8, "ac_key", "lgd_state"), _mode(h8, "pc_key", "lgd_state")
    ac_pc, ac_dist = _mode(h8, "ac_key", "pc_key"), _mode(h8, "ac_key", "district_lgd_key")
    cols = {"state": "lgd_state", "district": "district_lgd_key", "pc": "pc_key", "ac": "ac_key"}
    cells = {lvl: h8.groupby(c).size() for lvl, c in cols.items()}
    area = {lvl: h8.groupby(c).hex_area_m2.sum() / 1e6 for lvl, c in cols.items()}

    units = {}
    for lvl in LEVELS:
        g = bounds[lvl].sort_values("key").reset_index(drop=True)
        units[lvl] = []
        for i, r in enumerate(g.itertuples()):
            u = {"id": i, "key": r.key, "name": r.name if lvl in ("state", "district") else title(r.name),
                 "bbox": _bbox(r.geometry), "lp": _label_point(r.geometry),
                 "h8": int(cells[lvl].get(r.key, 0)), "area": round(float(area[lvl].get(r.key, 0)), 2)}
            if lvl in ("pc", "ac"):
                u["no"] = int(r.no)
            units[lvl].append(u)
    sidx = {u["key"]: u["id"] for u in units["state"]}
    didx = {u["key"]: u["id"] for u in units["district"]}
    pidx = {u["key"]: u["id"] for u in units["pc"]}
    dstate = bounds["district"].set_index("key").state
    for u in units["district"]:
        u["st"] = sidx.get(dstate.get(u["key"]), -1)
    for u in units["pc"]:
        u["st"] = sidx.get(pc_state.get(u["key"]) or norm_state(u["key"].split("|")[0]), -1)
    for u in units["ac"]:
        u["st"] = sidx.get(ac_state.get(u["key"]) or norm_state(u["key"].split("|")[0]), -1)
        u["pc"] = pidx.get(ac_pc.get(u["key"]), -1)
        u["d"] = didx.get(ac_dist.get(u["key"]), -1)

    DATA.mkdir(parents=True, exist_ok=True)
    with open(DATA / "units.json", "w", encoding="utf-8") as f:
        json.dump(units, f, separators=(",", ":"), ensure_ascii=False)
    log(f"  units.json {(DATA / 'units.json').stat().st_size / 1e6:.1f} MB", {k: len(v) for k, v in units.items()})
    return units


# ---------------------------------------------------------------------------------------------
# Boundary files
# ---------------------------------------------------------------------------------------------

def _simplify(gdf, tol):
    geoms = gdf.geometry.values
    try:
        simp = shapely.coverage_simplify(geoms, tol)
    except Exception as e:  # not a valid coverage
        log("  coverage_simplify failed, per-feature instead:", e)
        simp = shapely.simplify(geoms, tol, preserve_topology=True)
    simp = shapely.make_valid(simp)
    fixed = []
    for g in simp:
        parts = [p for p in getattr(g, "geoms", [g]) if p.geom_type in ("Polygon", "MultiPolygon") and not p.is_empty]
        fixed.append(shapely.unary_union(parts) if parts else shapely.Polygon())
    out = gdf.copy()
    out["geometry"] = fixed
    return out


def build_boundaries(cfg, units, bounds):
    tol, dtol = cfg["boundaries"]["simplify"], cfg["boundaries"]["detail"]
    for lvl in LEVELS:
        idx = {u["key"]: u["id"] for u in units[lvl]}
        gdf = bounds[lvl][bounds[lvl].key.isin(idx)].copy()
        gdf["uid"] = gdf.key.map(idx)

        out = DATA / "detail" / lvl
        out.mkdir(parents=True, exist_ok=True)
        for old in out.glob("*.json"):
            old.unlink()
        for r in gdf.itertuples(index=False):
            g = shapely.set_precision(shapely.simplify(r.geometry, dtol[lvl], preserve_topology=True), 1e-5)
            (out / f"{int(r.uid)}.json").write_text(shapely.to_geojson(g), encoding="utf-8")

        simp = _simplify(gdf, tol[lvl])
        feats = []
        for r in simp.itertuples(index=False):
            if r.geometry is None or r.geometry.is_empty:
                continue
            geom = json.loads(shapely.to_geojson(shapely.set_precision(r.geometry, 1e-4)))
            feats.append({"type": "Feature", "id": int(r.uid), "properties": {"uid": int(r.uid)}, "geometry": geom})
        path = DATA / "boundaries" / f"{lvl}.geojson"
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"type": "FeatureCollection", "features": feats}, f, separators=(",", ":"))
        log(f"  boundaries/{lvl}: {len(feats)} features, {path.stat().st_size / 1e6:.1f} MB (+ detail)")
