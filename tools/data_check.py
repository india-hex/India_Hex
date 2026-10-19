"""End-to-end data check: the unit values the site shows vs the official outputs/ index files.

Site values: site/data/units/v/<series>/<level>.json (aggregated from H8 cells by the pipeline).
Official:    D:/economy_index_data/outputs/... (the source project's own unit indices).
Also checks H8 cell counts per unit (units.json) against the official hex_count.

usage: python -I tools/data_check.py     -> prints a summary table, writes design/data_check.csv
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from pipeline.config import DATA, load_config  # noqa: E402

cfg = load_config()
OUT = cfg.src_root / "outputs"
U = json.loads((DATA / "units.json").read_text(encoding="utf-8"))
LEVELS = {"ac": ("ac", "ac_key"), "pc": ("pc", "pc_key"), "district": ("district_lgd", "district_key")}

# (site series, year, official file pattern, filter column/value, official column, relative tolerance)
CHECKS = [
    ("population", 2025, "population/{p}_population_index.csv", ("epoch", 2025), "population", 0.01),
    ("population", 2015, "population/{p}_population_index.csv", ("epoch", 2015), "population", 0.01),
    ("ntl_mean", 2025, "ntl/{p}_ntl_index_wide.csv", None, "ntl_mean_2025", 0.02),
    ("ntl_mean", 2015, "ntl/{p}_ntl_index_wide.csv", None, "ntl_mean_2015", 0.02),
    ("all_poi_total", None, "commercial_poi/{p}_poi_index.csv", None, "all_poi_total", 0.0),
    ("commercial_total", None, "commercial_poi/{p}_poi_index.csv", None, "commercial_total", 0.0),
    ("built_s_total_m2", 2025, "built_environment/{p}_built_environment_index.csv", ("epoch", 2025), "built_s_total_m2", 0.01),
    ("built_share_total", 2025, "built_environment/{p}_built_environment_index.csv", ("epoch", 2025), "built_share_total", 0.03),
    ("landcover_agriculture_share", 2024, "land_cover/land_cover_classes/{p}_land_cover_classes_index.csv", ("year", 2024), "landcover_agriculture_share", 0.03),
    ("landcover_forest_share", 2024, "land_cover/land_cover_classes/{p}_land_cover_classes_index.csv", ("year", 2024), "landcover_forest_share", 0.03),
    ("forest_cover_share_canopy10", 2025, "land_cover/forest/{p}_forest_index.csv", ("year", 2025), "forest_cover_share_canopy10", 0.03),
]


def site_values(series, level, year):
    f = DATA / "units" / "v" / series / f"{level}.json"
    if not f.exists():
        return None
    d = json.loads(f.read_text())
    if year not in d["y"]:
        return None
    vals = d["v"][d["y"].index(year)]
    return pd.Series({u["key"]: vals[u["id"]] for u in U[level]}, dtype="float64")


rows, worst = [], []
for level, (prefix, key) in LEVELS.items():
    # cell counts
    lk = pd.read_csv(OUT / "ntl" / f"{prefix}_lookup.csv").set_index(key)["hex_count"]
    site_n = pd.Series({u["key"]: u["h8"] for u in U[level]})
    both = site_n.index.intersection(lk.index)
    rows.append({"level": level, "check": "H8 cells per unit", "units_site": len(site_n), "units_official": len(lk),
                 "matched": len(both), "exact_or_within_tol": int((site_n[both] == lk[both]).sum()),
                 "max_rel_diff": float((site_n[both] - lk[both]).abs().div(lk[both].clip(lower=1)).max())})
    for series, year, pat, flt, col, tol in CHECKS:
        path = OUT / pat.format(p=prefix)
        if not path.exists():
            continue
        off = pd.read_csv(path)
        if flt:
            off = off[off[flt[0]] == flt[1]]
        off = off.set_index(key)[col].astype("float64")
        site = site_values(series, level, year)
        if site is None:
            rows.append({"level": level, "check": f"{series} {year or ''}", "note": "not on site"})
            continue
        idx = site.index.intersection(off.index)
        a, b = site[idx], off[idx]
        ok_both = a.notna() & b.notna()
        rel = (a - b).abs() / b.abs().where(b.abs() > 1e-9, 1.0)
        good = (rel <= tol + 1e-4) | ((a - b).abs() < 1e-6)
        rows.append({"level": level, "check": f"{series} {year or ''}".strip(), "units_site": len(site), "units_official": len(off),
                     "matched": int(ok_both.sum()), "exact_or_within_tol": int((good & ok_both).sum()),
                     "missing_on_site": int((a.isna() & b.notna()).sum()), "missing_official": int((b.isna() & a.notna()).sum()),
                     "max_rel_diff": float(rel[ok_both].max()) if ok_both.any() else None, "tolerance": tol})
        bad = rel[ok_both & ~good].sort_values(ascending=False).head(3)
        for k, r in bad.items():
            worst.append({"level": level, "check": f"{series} {year or ''}".strip(), "unit": k, "site": a[k], "official": b[k], "rel_diff": r})

res = pd.DataFrame(rows)
pd.set_option("display.width", 220, "display.max_columns", 20, "display.max_rows", 200)
print(res.to_string(index=False))
if worst:
    print("\nLargest differences beyond tolerance:")
    print(pd.DataFrame(worst).sort_values("rel_diff", ascending=False).head(25).to_string(index=False))
(ROOT / "design").mkdir(exist_ok=True)
res.to_csv(ROOT / "design" / "data_check.csv", index=False)
pd.DataFrame(worst).to_csv(ROOT / "design" / "data_check_worst.csv", index=False)
