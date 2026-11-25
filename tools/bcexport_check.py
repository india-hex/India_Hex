"""Acceptance checks for the booth-catchment (bcexport) election layers, independent of the build code paths.

  hex    every published .bin of every bcexport dataset (shards/data-*/data/hex/h{res}/v/) decodes to the
         delivered parquet (D:/booth_catchment/<ST>/outputs/maps/elections/<key>/hex/, not the cache) within half
         a quantisation step (shares <= 0.002), with identical NA sets (NA code <-> `na`), identical missing cells
         otherwise, and identical leads (folded parties -> Others)
  units  AC values = the results store (shares of valid votes, turnout, votes, electors, winner) for every AC;
         PC values = the results store's PC rows (Lok Sabha) or the AC sums by the seat map (Assembly, also equal
         to the store's aggregated PC rows); state = sum of PCs (LS) / ACs (VS); nothing outside the state
  join   every AC / PC of the election joins India Hex by number with the key in <MAP>_ihex_keys.csv; PB AC 107
         and 108 count in Sangrur PC (not Patiala, where India Hex's PC layer puts their cells)

python tools/bcexport_check.py            (after a build)
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from pipeline import bcexport  # noqa: E402  (election discovery and file locations only)
from pipeline.build import _decode_index  # noqa: E402  (index order only)
from pipeline.config import DATA, SHARDS, load_config  # noqa: E402

cfg = load_config()
CC = json.loads((ROOT / "site" / "config.json").read_text(encoding="utf-8"))
VARS = {v["id"]: v for v in CC["variables"]}
UNITS = json.loads((DATA / "units.json").read_text(encoding="utf-8"))
fails, notes = [], []
EPS = 1e-9


def check(ok, msg):
    if not ok:
        fails.append(msg)
        print("  FAIL", msg)
    return ok


def decode(raw, q):
    """(values, NA mask); missing = NaN, NA = NaN with the mask set."""
    if q["dtype"] == "u8":
        a = np.frombuffer(raw, np.uint8).astype(float)
        out = a if q.get("t") == "cat" else a * q["scale"]
        out = out.copy()
        out[a == 255] = np.nan
    else:
        a = np.frombuffer(raw, "<u2").astype(float)
        out = (a * q["scale"]) ** 2 if q["t"] == "sqrt" else q["offset"] + a * q["scale"]
        out[a == 65535] = np.nan
    na = a == q["na"] if "na" in q else np.zeros(len(a), bool)
    out[na] = np.nan
    return out, na


def full(raw_vals, chunks, start, n):
    v, na = raw_vals
    exp = sum(start[k + 1] - start[k] for k in chunks)
    check(len(v) == exp, f"{len(v)} values, chunks hold {exp}")
    fv, fn = np.full(n, np.nan), np.zeros(n, bool)
    o = 0
    for k in chunks:
        m = start[k + 1] - start[k]
        fv[start[k]:start[k + 1]] = v[o:o + m]
        fn[start[k]:start[k + 1]] = na[o:o + m]
        o += m
    return fv, fn


def src_num(t, col):
    return t.column(col).to_pandas().astype(float).to_numpy()


# ---- hexagons ------------------------------------------------------------------------------------------------
def hex_checks(dsets):
    print("hex: published bins vs the delivered parquet")
    for res in (8, 7, 6):
        man = json.loads((DATA / "hex" / f"h{res}" / "manifest.json").read_text())
        order, _ = _decode_index(res, man, cfg.chunk_levels)
        start, n = np.array(man["start"]), man["n"]
        sorter = np.argsort(order)
        for d in dsets:
            chunks = CC["chunks"][d.id][str(res)]
            shard = SHARDS / f"data-{d.st.lower()}" / "data" / "hex" / f"h{res}" / "v"
            pre = f"{d.id}_"
            for e in d.els:
                y = e.year
                t = pq.read_table(e.hex_files[res])
                ids = np.array([int(h, 16) for h in t.column("h3_index").to_pylist()], dtype=np.uint64)
                j = np.searchsorted(order[sorter], ids)
                j[j >= n] = 0
                pos = np.where(order[sorter][j] == ids, sorter[j], -1)
                ok = pos >= 0
                p = pos[ok]
                na_src = t.column("na").to_numpy(zero_copy_only=False).astype(bool)[ok]
                if (~ok).sum():
                    notes.append(f"h{res} {e.key}: {int((~ok).sum())} of {len(ok)} cells are outside India Hex's index (not shown)")
                # expected series: (series id, source values or None for lead, tolerance)
                exp = {}
                for stem, _, col in e.parties():
                    exp[f"{pre}{stem}_share"] = src_num(t, col) / 1000
                exp[f"{pre}oth_share"] = src_num(t, "share_p_OTH") / 1000
                if e.nota:
                    exp[f"{pre}nota_share"] = src_num(t, "share_p_NOTA") / 1000
                else:
                    check(f"{pre}nota_share" not in VARS or y not in VARS[f"{pre}nota_share"]["years"],
                          f"{e.key}: hexagon NOTA published although the booth files lack it")
                for stem, _, col, _ in e.blocs():
                    exp[f"{pre}{stem}_bloc_share"] = src_num(t, col) / 1000
                mp = e.margin_pair()
                if mp:
                    exp[f"{pre}{mp[0]}_{mp[1]}_margin_pp"] = (src_num(t, mp[5]) - src_num(t, mp[6])) / 10
                exp[f"{pre}turnout_share"] = src_num(t, "turnout") / 1000
                exp[f"{pre}votes"] = src_num(t, "votes")
                exp[f"{pre}electors"] = src_num(t, "electors")
                for c in e.withhold:   # provisional at the producer: must not be published for this year
                    exp.pop(f"{pre}{c}")
                    check(f"{pre}{c}" not in VARS or y not in VARS[f"{pre}{c}"]["years"], f"{e.key}: withheld {c} is published")
                worst = {}
                for sid, sv in exp.items():
                    s = VARS.get(sid)
                    if not check(s is not None and y in s["res_years"].get(str(res), []), f"h{res} {sid} {y}: not published"):
                        continue
                    q = s["q"][str(res)]
                    v, na = full(decode((shard / f"{sid}_{y}.bin").read_bytes(), q), chunks, start, n)
                    got, gna, want = v[p], na[p], sv[ok]
                    check(np.array_equal(gna, na_src), f"h{res} {sid} {y}: NA set differs ({int(gna.sum())} vs {int(na_src.sum())})")
                    m = ~na_src
                    check(np.array_equal(np.isnan(got[m]), np.isnan(want[m])), f"h{res} {sid} {y}: missing cells differ")
                    both = m & ~np.isnan(want) & ~np.isnan(got)
                    if q["dtype"] == "u8":
                        tol, err = 0.002, np.abs(got[both] - want[both])
                    elif q["t"] == "sqrt":
                        tol, err = q["scale"] / 2, np.abs(np.sqrt(got[both]) - np.sqrt(want[both]))
                    else:
                        tol, err = q["scale"] / 2, np.abs(got[both] - want[both])
                    mx = float(err.max()) if len(err) else 0.0
                    worst[sid.removeprefix(pre)] = mx
                    # + float32 rounding: the build reads source columns as float32 (hexes.Aligner.scatter)
                    f32 = float(np.abs(want[both]).max()) * 2 ** -24 if len(err) and q["dtype"] != "u8" else 0.0
                    check(mx <= tol + f32 + EPS, f"h{res} {sid} {y}: max error {mx:.6g} > half step {tol:.6g}")
                    # outside the source cells nothing is drawn (clear): every other cell of the chunks is missing
                    other = np.ones(n, bool)
                    other[p] = False
                    check(not np.isfinite(v[other]).any() and not na[other].any(), f"h{res} {sid} {y}: values outside the election's cells")
                # leads
                s = VARS[f"{pre}lead"]
                v, na = full(decode((shard / f"{pre}lead_{y}.bin").read_bytes(), s["q"][str(res)]), chunks, start, n)
                cats = [c["id"] for c in s["categories"]]
                lm = e.lead_map()
                lead = src_num(t, "lead_party")[ok]
                want = np.array([cats.index(lm[int(c)]) if np.isfinite(c) else np.nan for c in lead])
                got = v[p]
                check(np.array_equal(na[p], na_src), f"h{res} {pre}lead {y}: NA set differs")
                same = (np.isnan(got) & np.isnan(want)) | (got == want)
                check(same.all(), f"h{res} {pre}lead {y}: {int((~same).sum())} cells with another lead")
                print(f"  h{res} {e.key}: {int(ok.sum()):,} cells, {int(na_src.sum()):,} NA, {len(exp) + 1} series; "
                      f"max share error {max(v for k, v in worst.items() if 'share' in k):.4f}")


# ---- units ---------------------------------------------------------------------------------------------------
def unit_file(sid, lvl, y):
    f = json.loads((DATA / "units" / "v" / sid / f"{lvl}.json").read_text())
    j = f["y"].index(y)
    return np.array([np.nan if x is None else x for x in f["v"][j]], float)


def sig5(x):
    """Unit files keep 5 significant digits (pipeline hexes._sig4)."""
    return np.array([float(f"{v:.5g}") if np.isfinite(v) else np.nan for v in np.atleast_1d(np.asarray(x, float))])


def close(a, b):
    return np.isclose(np.asarray(a, float), sig5(b).reshape(np.shape(a)), rtol=1e-9, atol=1e-12, equal_nan=True)


def results_values(e, level):
    """{series stem: per-unit Series} straight from the results store (independent of the cache)."""
    u = pd.read_parquet(e.results / "units.parquet")
    c = pd.read_parquet(e.results / "candidates.parquet")
    u, c = u[u.level == level].set_index("unit_no"), c[c.level == level]
    tv = u.total_valid.astype(float)
    pv = lambda lab: c[c.party == lab].groupby("unit_no").votes.sum().reindex(u.index).fillna(0).astype(float)
    bv = lambda lab: c[c.bloc == lab].groupby("unit_no").votes.sum().reindex(u.index).fillna(0).astype(float)
    out = {}
    for stem, lab, _ in e.parties():
        out[f"{stem}_share"] = pv(lab) / tv
    out["oth_share"] = (tv - u.nota.astype(float) - sum(pv(lab) for _, lab, _ in e.parties())) / tv
    out["nota_share"] = u.nota.astype(float) / tv
    for stem, lab, _, _ in e.blocs():
        out[f"{stem}_bloc_share"] = bv(lab) / tv
    mp = e.margin_pair()
    if mp:
        f = bv if mp[4] == "bloc" else pv
        out[f"{mp[0]}_{mp[1]}_margin_pp"] = (f(mp[2]) - f(mp[3])) / tv * 100
    out["turnout_share"] = u.turnout_pct.astype(float) / 100
    out["votes"], out["electors"] = tv, u.electors.astype(float)
    return out, u, tv


def unit_checks(dsets):
    print("units: unit files vs the results store")
    for d in dsets:
        pre = f"{d.id}_"
        st = next(s for s in UNITS["state"] if s["key"] == d.state_key)
        acs = {a["no"]: a for a in UNITS["ac"] if a["st"] == st["id"]}
        pcs = {p["no"]: p for p in UNITS["pc"] if p["st"] == st["id"]}
        for e in d.els:
            y = e.year
            ac, uac, tva = results_values(e, "ac")
            pc, upc, tvp = results_values(e, "pc")
            sm = pd.read_csv(e.seatmap_csv)
            pc_of = dict(zip(sm.ac_no, sm.pc_no))
            # join: numbers -> India Hex keys as in <MAP>_ihex_keys.csv
            keys = pd.read_csv(e.ihex_keys)
            check(all(acs[a]["key"] == k for a, k in zip(keys.ac_no, keys.ac_key)), f"{e.key}: AC keys differ from {e.ihex_keys.name}")
            check(all(pcs[p]["key"] == k for p, k in zip(keys.pc_no, keys.pc_key)), f"{e.key}: PC keys differ from {e.ihex_keys.name}")
            check(set(uac.index) == set(acs), f"{e.key}: ACs of the results store and India Hex differ")
            ac_ids = np.array([acs[a]["id"] for a in uac.index])
            pc_by_ac = np.array([pcs[pc_of[a]]["id"] for a in uac.index])
            n_ok = 0
            for stem in list(ac) + ["lead"]:
                sid = pre + stem
                if sid not in VARS or y not in VARS[sid]["years"]:
                    continue
                vals = {lvl: unit_file(sid, lvl, y) for lvl in ("ac", "pc", "district", "state")}
                inside = {lvl: np.array([(u["id"] if lvl == "state" else u["st"]) == st["id"] for u in UNITS[lvl]]) for lvl in vals}
                for lvl in vals:
                    check(not np.isfinite(vals[lvl][~inside[lvl]]).any(), f"{sid} {y}: {lvl} values outside {d.state_key}")
                if stem == "lead":
                    cats = [c["id"] for c in VARS[sid]["categories"]]
                    own = {lab: s for s, lab, _ in e.parties()}
                    w = lambda units: np.array([cats.index(own.get(x, "oth")) for x in units.winner_party], float)
                    check(np.array_equal(vals["ac"][ac_ids], w(uac)), f"{sid} {y}: AC leads differ from the winners")
                    if d.house == "LS":
                        check(np.array_equal(vals["pc"][[pcs[p]["id"] for p in upc.index]], w(upc)), f"{sid} {y}: PC leads differ from the PC winners")
                    n_ok += 1
                    continue
                exp_ac = ac[stem].to_numpy()
                check(close(vals["ac"][ac_ids], exp_ac).all(), f"{sid} {y}: AC values differ from the results store "
                      f"(max {np.nanmax(np.abs(vals['ac'][ac_ids] - exp_ac)):.3g})")
                wt = (uac.electors if stem == "turnout_share" else tva).astype(float).to_numpy()
                agg = lambda g, nn: (np.bincount(g, exp_ac * wt, nn) / np.bincount(g, wt, nn)) if stem not in ("votes", "electors") \
                    else np.bincount(g, exp_ac, nn)
                with np.errstate(invalid="ignore", divide="ignore"):
                    if d.house == "LS":
                        exp_pc = pc[stem].to_numpy()
                        got = vals["pc"][[pcs[p]["id"] for p in upc.index]]
                        check(close(got, exp_pc).all(), f"{sid} {y}: PC values differ from the PC rows")
                        pw = (upc.electors if stem == "turnout_share" else tvp).astype(float).to_numpy()
                        st_exp = exp_pc.sum() if stem in ("votes", "electors") else (exp_pc * pw).sum() / pw.sum()
                    else:
                        exp_pc = agg(pc_by_ac, len(UNITS["pc"]))[[pcs[p]["id"] for p in upc.index]]
                        got = vals["pc"][[pcs[p]["id"] for p in upc.index]]
                        check(close(got, exp_pc).all(), f"{sid} {y}: PC values differ from the AC sums by the seat map")
                        if stem not in ("turnout_share",):   # the store's aggregated PC rows (turnout: polled basis)
                            check(close(got, pc[stem].to_numpy()).all(), f"{sid} {y}: PC values differ from the store's aggregated PC rows")
                        st_exp = exp_ac.sum() if stem in ("votes", "electors") else (exp_ac * wt).sum() / wt.sum()
                check(close(vals["state"][st["id"]], st_exp), f"{sid} {y}: state value {vals['state'][st['id']]} != {st_exp}")
                n_ok += 1
            # PB: AC 107 Dhuri and 108 Sangrur count in Sangrur PC (12), whatever India Hex's PC layer says
            if e.st == "PB":
                sang = pcs[12]["id"]
                check(pc_of[107] == 12 and pc_of[108] == 12, "PB seat map: ACs 107/108 not in PC 12")
                sid = f"{pre}votes"
                v = unit_file(sid, "pc", y)[sang]
                sub = uac.loc[[a for a in uac.index if pc_of[a] == 12]]
                check(107 in sub.index and 108 in sub.index and close(v, float(sub.total_valid.sum()) if d.house == "VS" else float(upc.loc[12].total_valid)),
                      f"{e.key}: Sangrur PC votes {v} do not include ACs 107/108")
                if d.house == "VS":
                    ihex_pc = {UNITS["ac"][acs[a]["id"]]["pc"] for a in (107, 108)}
                    print(f"  {e.key}: Sangrur PC = {int(v):,} votes incl. AC 107/108 (India Hex's layer puts them in "
                          f"{', '.join(UNITS['pc'][i]['name'] for i in ihex_pc)})")
            print(f"  {e.key}: {len(uac)} ACs, {len(upc)} PCs, {n_ok} series match the results store")


if __name__ == "__main__":
    dsets = bcexport.datasets(cfg)
    print("bcexport datasets: " + ", ".join(d.id + " (" + ", ".join(e.key for e in d.els) + ")" for d in dsets))
    hex_checks(dsets)
    unit_checks(dsets)
    for n_ in dict.fromkeys(notes):
        print("  note:", n_)
    print("ALL PASS" if not fails else f"{len(fails)} FAILED")
    sys.exit(1 if fails else 0)
