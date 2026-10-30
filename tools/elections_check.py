"""Acceptance checks for the election layers (brief checks 3-5), independent of the build code paths.

  3  every published bin (sparse layout) decodes to the parquet value within half a quantisation
     step, with the same missing cells, zeros kept, and H8 votes/electors exact
  4  unit files: AC values = official table; PC, district and state = sums of official AC votes;
     no value outside the dataset's state; Bihar AC 182 Bankipur = official
  5  margin breaks are the fixed ones; lead codes match the is_lead_* flags in every cell

python tools/elections_check.py            (run in the site folder after a build)
"""
import json
import sys
from pathlib import Path

import duckdb
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from pipeline.build import _decode_index  # noqa: E402  (index order only; values are decoded here)
from pipeline.config import DATA, load_config  # noqa: E402

cfg = load_config()
CC = json.loads((ROOT / "site" / "config.json").read_text(encoding="utf-8"))
UNITS = json.loads((DATA / "units.json").read_text(encoding="utf-8"))
DS = cfg["variables"]["datasets"]
fails = []


def check(ok, msg):
    if not ok:
        fails.append(msg)
        print("  FAIL", msg)
    return ok


def decode(raw, q):
    if q["dtype"] == "u8":
        a = np.frombuffer(raw, np.uint8).astype(float)
        out = a * q["scale"]
        out[a == 255] = np.nan
        return out
    a = np.frombuffer(raw, "<u2").astype(float)
    out = (a * q["scale"]) ** 2 if q["t"] == "sqrt" else q["offset"] + a * q["scale"]
    out[a == 65535] = np.nan
    return out


def full_values(res, name, q, chunks, start, n):
    v = decode((DATA / "hex" / f"h{res}" / "v" / name).read_bytes(), q)
    exp = sum(start[k + 1] - start[k] for k in chunks)
    check(len(v) == exp, f"h{res}/{name}: {len(v)} values, chunks hold {exp}")
    full = np.full(n, np.nan)
    o = 0
    for k in chunks:
        m = start[k + 1] - start[k]
        full[start[k]:start[k + 1]] = v[o:o + m]
        o += m
    return full


# ---- 3 + 5: hexagon files ------------------------------------------------------------------------
def hex_checks():
    print("check 3/5: hexagon files")
    for res in (8, 7, 6):
        man = json.loads((DATA / "hex" / f"h{res}" / "manifest.json").read_text())
        order, ids = _decode_index(res, man, cfg.chunk_levels)
        start = np.array(man["start"])
        n = man["n"]
        pos_of = dict(zip(order.tolist(), range(n)))
        for dsid, ds in DS.items():
            if not (ds.get("sparse") and ds.get("states")):   # election datasets (incl. booth counts)
                continue
            chunks = CC["chunks"][dsid][str(res)]
            path = f"{ds['root']}/h{res}/{ds['file'].format(res=res)}"
            src = duckdb.sql(f"SELECT * FROM '{path}'").df()
            p = np.array([pos_of.get(int(h, 16), -1) for h in src.h3_index])
            inidx = p >= 0
            print(f"  h{res} {dsid}: {len(src):,} rows, {int((~inidx).sum())} outside the index, {len(chunks)} chunks")
            # chunks: exactly those holding a dataset cell
            want = sorted(set((np.searchsorted(start, p[inidx], side="right") - 1).tolist()))
            check(want == chunks, f"h{res} {dsid}: chunk list differs from the cells' chunks")
            in_ds = np.zeros(n, bool)
            in_ds[p[inidx]] = True
            for s in [v for v in CC["variables"] if v.get("sparse") == dsid]:
                q = s["q"][str(res)]
                bare = s["id"][len(ds["prefix"]):]
                for y in s["res_years"][str(res)]:
                    name = f"{s['id']}_{y}.bin"
                    dec = full_values(res, name, q, chunks, start, n)
                    check(np.isnan(dec[~in_ds]).all(), f"h{res}/{name}: values on cells outside the dataset")
                    if s.get("type") == "categorical":
                        cats = [c for c in s["categories"]]
                        flags = {c["id"]: src.get(f"is_lead_{c['id']}_{y}") for c in cats if y in c["years"]}
                        f = np.stack([flags[c].to_numpy(float) for c in flags])
                        allnull = np.isnan(f).all(axis=0)
                        code = dec[p[inidx]]
                        ids_ = [c["id"] for c in cats]
                        got = np.array([ids_[int(c)] if np.isfinite(c) else None for c in code], dtype=object)
                        exp = np.array([None if an else list(flags)[int(np.nanargmax(col))] for an, col in zip(allnull[inidx], f[:, inidx].T)], dtype=object)
                        one = (np.nan_to_num(f[:, inidx]) == 1).sum(axis=0)
                        check(((one == 1) | allnull[inidx]).all(), f"h{res}/{name}: cells without exactly one flag")
                        check((got == exp).all(), f"h{res}/{name}: {(got != exp).sum()} cells differ from is_lead flags")
                        continue
                    col = f"{bare}_{y}"
                    sv = src[col].to_numpy(float)[inidx]
                    dv = dec[p[inidx]]
                    na_s, na_d = np.isnan(sv), np.isnan(dv)
                    check((na_s == na_d).all(), f"h{res}/{name}: NA sets differ ({(na_s != na_d).sum()} cells)")
                    ok = ~na_s & ~na_d
                    err = np.abs(dv[ok] - sv[ok]).max() if ok.any() else 0
                    half = 0.002 if q["dtype"] == "u8" else (q["scale"] / 2 if q["t"] == "linear" else None)
                    if q["t"] == "sqrt":
                        half = (np.sqrt(np.abs(sv[ok])) * 2 * q["scale"] / 2 + q["scale"] ** 2).max()
                    check(err <= half * (1 + 1e-6) + 1e-9, f"h{res}/{name}: max error {err:.6g} > half step {half:.6g}")
                    zero = ok & (sv == 0)
                    check((dv[zero] == 0).all(), f"h{res}/{name}: {int((dv[zero] != 0).sum())} zeros not kept")
                    if res == 8 and bare in ("votes", "electors"):
                        small = ok & (sv < 65535)
                        check((dv[small] == sv[small]).all(), f"h8/{name}: votes not exact")
                    if s.get("fixed_breaks"):
                        b = s["breaks"][str(res)][str(y)]
                        check(b == [-20, -10, -5, -2, 2, 5, 10, 20], f"h{res}/{name}: breaks {b}")
                    print(f"    {name:34s} max|err| {err:.5f}  NA {int(na_s.sum()):,}  zeros {int(zero.sum()):,}")


# ---- 4: unit files ----------------------------------------------------------------------------------
def sig5(x):
    return None if x is None or not np.isfinite(x) else float(f"{x:.5g}")


def ka_sides(y):
    bjp = ["bjp", "jds"] if y == 2024 else ["bjp"]
    inc = ["inc", "jds"] if y == 2019 else ["inc"]
    return bjp, inc


def official_units(dsid, y, s_bare, df, groups, n):
    """Independent recomputation from summed vote columns (NaN where a unit has no AC)."""
    ka = dsid.startswith("karnataka")
    den = df[f"total_valid_{y}"] if ka else df[f"valid_votes_{y}"]
    sums = lambda col: np.bincount(groups, weights=np.asarray(col, float), minlength=n)[:n]
    have = np.bincount(groups, minlength=n)[:n] > 0
    D = sums(den)
    out = None
    if s_bare.endswith("_share") and s_bare != "turnout_share":
        party = s_bare[:-6]
        parts = party.split("_") if party in ("inc_jds", "bjp_jds") else [party]
        num = sum(sums(df[f"{p}_votes_{y}"]) for p in parts)
        out = num / D
    elif s_bare in ("bloc_margin_pp", "nda_mgb_margin_pp"):
        a, b = ka_sides(y) if ka else (["nda"], ["mgb"])
        out = (sum(sums(df[f"{p}_votes_{y}"]) for p in a) - sum(sums(df[f"{p}_votes_{y}"]) for p in b)) / D * 100
    elif s_bare == "turnout_share":
        evm = df[f"total_valid_{y}"] if ka else df[f"turnout_evm_share_{y}"] * df[f"electors_{y}"]
        out = sums(evm) / sums(df[f"electors_{y}"])
    elif s_bare == "votes":
        out = sums(df[f"votes_{y}"] if ka else df[f"valid_votes_{y}"])
    elif s_bare == "electors":
        out = sums(df[f"electors_{y}"])
    return np.where(have, out, np.nan)


def unit_checks():
    print("check 4: unit files")
    man = json.loads((DATA / "hex" / "h8" / "manifest.json").read_text())
    _, ids8 = _decode_index(8, man, cfg.chunk_levels)
    a8, d8 = ids8["a"].astype(int), ids8["d"].astype(int)
    for dsid, ds in DS.items():
        if not ds.get("units_table") or not ds.get("lead"):   # booth counts: tools/booths_check.py
            continue
        spec = ds["units_table"]
        st_id = next(u["id"] for u in UNITS["state"] if u["key"] == spec["state"])
        acs = {u["no"]: u for u in UNITS["ac"] if u["st"] == st_id}
        n = {lvl: len(UNITS[lvl]) for lvl in UNITS}
        for s in [v for v in CC["variables"] if v.get("sparse") == dsid]:
            bare = s["id"][len(ds["prefix"]):]
            for y in s["years"]:
                df = duckdb.sql(f"SELECT * FROM '{spec['path'].format(year=y)}'").df()
                ac_ids = np.array([acs[k]["id"] for k in df.ac_no])
                ok_pc = all(UNITS["pc"][acs[k]["pc"]]["no"] == pc for k, pc in zip(df.ac_no, df.pc_no)) if "pc_no" in df else True
                check(ok_pc, f"{dsid} {y}: AC -> PC parents differ from the official table")
                j = None
                vals = {}
                for lvl in ("ac", "pc", "district", "state"):
                    f = json.loads((DATA / "units" / "v" / s["id"] / f"{lvl}.json").read_text())
                    j = f["y"].index(y)
                    vals[lvl] = np.array([np.nan if x is None else x for x in f["v"][j]], float)
                    inside = np.array([(u["id"] if lvl == "state" else u["st"]) == st_id for u in UNITS[lvl]])
                    check(np.isnan(vals[lvl][~inside]).all(), f"{s['id']} {y} {lvl}: values outside {spec['state']}")
                # majority district per AC from the H8 index
                dmaj = {}
                for a in set(ac_ids.tolist()):
                    m = (a8 == a) & (d8 >= 0)
                    dmaj[a] = np.bincount(d8[m]).argmax() if m.any() else -1
                grp = {"ac": ac_ids, "pc": np.array([UNITS["ac"][a]["pc"] for a in ac_ids]),
                       "district": np.array([dmaj[a] for a in ac_ids]), "state": np.full(len(ac_ids), st_id)}
                if s.get("type") == "categorical":
                    cats = [c["id"] for c in s["categories"]]
                    have = [c["id"] for c in s["categories"] if y in c["years"]]
                    got = vals["ac"][ac_ids]
                    exp = np.array([cats.index(b) for b in df[f"lead_bucket_{y}"]], float)
                    check((got == exp).all(), f"{s['id']} {y}: AC leads differ from lead_bucket")
                    for lvl in ("pc", "district", "state"):
                        sh = np.stack([official_units(dsid, y, f"{c}_share", df, grp[lvl], n[lvl]) for c in have])
                        units_with = ~np.isnan(sh).all(axis=0)
                        e = np.array([cats.index(have[i]) for i in np.nanargmax(np.where(np.isnan(sh), -1, sh), axis=0)], float)
                        check((vals[lvl][units_with] == e[units_with]).all(), f"{s['id']} {y} {lvl}: lead differs from largest summed votes")
                    continue
                col = s["id"][len(ds["prefix"]):] + f"_{y}"
                col = {"turnout_share": f"turnout_evm_share_{y}", "votes": f"valid_votes_{y}"}.get(bare, col) if not dsid.startswith("karnataka") else col
                exp_ac = np.array([sig5(x) for x in df[col].to_numpy(float)], float)
                check(np.array_equal(vals["ac"][ac_ids], exp_ac, equal_nan=True), f"{s['id']} {y}: AC values differ from the official table")
                for lvl in ("pc", "district", "state"):
                    e = official_units(dsid, y, bare, df, grp[lvl], n[lvl])
                    e5 = np.array([sig5(x) for x in e], float)
                    m = np.isfinite(e5)
                    rel = np.abs(vals[lvl][m] - e5[m]) / np.maximum(np.abs(e5[m]), 1e-9)
                    check((rel <= 1e-4).all() and np.isfinite(vals[lvl][m]).all(), f"{s['id']} {y} {lvl}: differs from official sums (max rel {rel.max():.2e})")
                if dsid == "bihar_ae2025" and bare == "nda_share":
                    b = acs[182]["id"]
                    check(vals["ac"][b] == sig5(df.loc[df.ac_no == 182, col].iloc[0]), "Bankipur AC 182 differs")
                    print(f"    Bankipur AC 182 NDA share {vals['ac'][b]} (official {df.loc[df.ac_no == 182, col].iloc[0]:.6f})")
            print(f"    {s['id']}: ok" if not any(f.startswith(s["id"] + " ") for f in fails) else f"    {s['id']}: FAILED")


if __name__ == "__main__":
    hex_checks()
    unit_checks()
    print(f"\n{'ALL PASS' if not fails else f'{len(fails)} FAILURES'}")
    sys.exit(1 if fails else 0)
