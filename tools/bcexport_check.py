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
  blocs  every election whose hexagon files have lead_bloc publishes <prefix>bloc_lead (the others do not): cells =
         lead_bloc decoded with the file's own code table (folded -> Others), identical NA and missing sets; AC (and
         Lok Sabha PC) values = the bloc with the most votes in the results store's candidates, Assembly PCs and the
         state = the largest combined bloc; all colours of a series differ
  counts every election that passes the booth-layer gate publishes <prefix>booths (the others do not): per resolution
         sum of cells + pins outside India Hex's index = pins; every cell, NA cell and absent cell as delivered; AC
         values, located and unlocated = the counts table (empty where it is); PC (seat map), district and state =
         sums of their other ACs, with the number left out; config.json couples the election to the series

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
    out["oth_share"] = (tv - u.nota.astype(float).fillna(0) - sum(pv(lab) for _, lab, _ in e.parties())) / tv   # no NOTA before 2013
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


# ---- leading alliance, booth counts ---------------------------------------------------------------------------
_ORD = {}


def index(res):
    """(start, n, sorted cell ids, their positions, index ids) of one resolution."""
    if res not in _ORD:
        man = json.loads((DATA / "hex" / f"h{res}" / "manifest.json").read_text())
        order, ids = _decode_index(res, man, cfg.chunk_levels)
        sorter = np.argsort(order)
        _ORD[res] = np.array(man["start"]), man["n"], order[sorter], sorter, ids
    return _ORD[res]


def locate(res, h3s):
    """Index position of every cell (-1: not in India Hex's index)."""
    _, n, so, sorter, _ = index(res)
    ids = np.array([int(h, 16) for h in h3s], dtype=np.uint64)
    j = np.searchsorted(so, ids)
    j[j >= n] = 0
    return np.where(so[j] == ids, sorter[j], -1)


def published(d, sid, ds_id, y, res):
    """(values, NA mask) over the whole index of one published file."""
    start, n, *_ = index(res)
    f = SHARDS / f"data-{d.st.lower()}" / "data" / "hex" / f"h{res}" / "v" / f"{sid}_{y}.bin"
    return full(decode(f.read_bytes(), VARS[sid]["q"][str(res)]), CC["chunks"][ds_id][str(res)], start, n)


def geography(d, e):
    st = next(s for s in UNITS["state"] if s["key"] == d.state_key)
    acs = {a["no"]: a["id"] for a in UNITS["ac"] if a["st"] == st["id"]}
    pcs = {p["no"]: p["id"] for p in UNITS["pc"] if p["st"] == st["id"]}
    sm = pd.read_csv(e.seatmap_csv)
    return st["id"], acs, pcs, dict(zip(sm.ac_no.astype(int), sm.pc_no.astype(int)))


def top_bloc(c, labels, kept):
    """{unit_no: leading bloc label or Others}: candidates outside every bloc stand alone; ties in statewide order."""
    out = {}
    for no, g in c.groupby("unit_no"):
        tot = {}
        for i, (b, v) in enumerate(zip(g.bloc, g.votes)):
            tot[b if isinstance(b, str) else i] = tot.get(b if isinstance(b, str) else i, 0) + v
        best = max(tot, key=lambda k: (tot[k], -labels.index(k) if k in labels else -len(labels)))
        out[int(no)] = best if best in kept else "Others"
    return out


def bloc_checks(dsets):
    print("blocs: leading alliance vs lead_bloc and the results store")
    for d in dsets:
        sid = f"{d.id}_bloc_lead"
        for e in d.els:
            y = e.year
            schema = pq.read_schema(e.hex_files[8])
            has = "lead_bloc" in schema.names
            pub = sid in VARS and y in VARS[sid]["years"]
            if not check(has == pub, f"{e.key}: lead_bloc in the file: {has}, {sid} published: {pub}") or not has:
                continue
            var = VARS[sid]
            meta = json.loads(schema.metadata[b"bcexport"])
            codes = meta["codes"]["lead_bloc"]
            # category id of a bloc label: the series id of the file's own table
            cid = {c["label"]: ("oth" if c["folded"] or c["series"] == "b_OTH" else c["series"][2:].lower()) for c in codes}
            cats = [c["id"] for c in var["categories"]]
            cols = [c["color"].lower() for c in var["categories"]]
            check(len(set(cols)) == len(cols), f"{sid}: two categories share a colour")
            main = VARS[f"{d.id}_lead"]
            check((var["group"], var["menu"], var.get("shard")) == (main["group"], main["menu"], main.get("shard")) and var.get("featured"),
                  f"{sid}: not beside the party lead in the picker")
            for res in (8, 7, 6):
                t = pq.read_table(e.hex_files[res], columns=["h3_index", "na", "lead_bloc"])
                pos = locate(res, t.column("h3_index").to_pylist())
                ok = pos >= 0
                m = json.loads(t.schema.metadata[b"bcexport"])["codes"]["lead_bloc"]
                by_code = {c["code"]: ("oth" if c["folded"] or c["series"] == "b_OTH" else c["series"][2:].lower()) for c in m}
                want = np.array([cats.index(by_code[int(c)]) if np.isfinite(c) else np.nan for c in src_num(t, "lead_bloc")[ok]])
                na_src = t.column("na").to_numpy(zero_copy_only=False).astype(bool)[ok]
                v, na = published(d, sid, f"{d.id}_bloc", y, res)
                check(np.array_equal(na[pos[ok]], na_src), f"h{res} {sid} {y}: NA set differs")
                check(np.array_equal(v[pos[ok]], want, equal_nan=True), f"h{res} {sid} {y}: cells with another alliance")
                other = np.ones(len(v), bool)
                other[pos[ok]] = False
                check(not np.isfinite(v[other]).any() and not na[other].any(), f"h{res} {sid} {y}: values outside the election's cells")
            # units
            st, acs, pcs, pc_of = geography(d, e)
            c = pd.read_parquet(e.results / "candidates.parquet")
            c = c[~c.is_nota.astype(bool)].assign(votes=lambda x: x.votes.fillna(0))   # no vote figure in the store counts as no votes
            u = pd.read_parquet(e.results / "units.parquet")
            labels = [x["label"] for x in codes if x["series"] != "b_OTH"]
            kept = [x["label"] for x in codes if not x["folded"] and x["series"] != "b_OTH"]
            ids = lambda lab: "oth" if lab == "Others" else cid[lab]
            vals = {lvl: unit_file(sid, lvl, y) for lvl in ("ac", "pc", "district", "state")}
            name = lambda x: None if not np.isfinite(x) else cats[int(x)]
            ca = c[c.level == "ac"]
            win = lambda lvl: {int(n): (w if isinstance(w, str) and w in kept else "Others")
                               for n, w in u[u.level == lvl].set_index("unit_no").winner_bloc.items()}
            ac = win("ac")   # owner, 25 Nov: an AC (and a Lok Sabha PC) shows the winner's alliance
            most = top_bloc(ca, labels, kept)
            check(set(ac) == set(acs), f"{sid} {y}: ACs differ")
            bad = [n for n in ac if name(vals["ac"][acs[n]]) != ids(ac[n])]
            check(not bad, f"{sid} {y}: AC alliances differ from the results store: {bad[:10]}")
            pooled = lambda g: g.assign(k=[b if isinstance(b, str) and b in kept else "Others" for b in g.bloc]).groupby("k").votes.sum().reindex(kept + ["Others"]).fillna(0).idxmax()
            if d.house == "LS":
                cp = c[c.level == "pc"]
                pc = win("pc")
                state = pooled(cp)
            else:
                # the summed ACs, NOTA out of the AC's valid votes, and the store's aggregated PC rows agree
                pc = {int(n): pooled(g) for n, g in ca.groupby(ca.unit_no.map(pc_of))}
                pcr = {int(n): pooled(g) for n, g in c[c.level == "pc"].groupby("unit_no")}
                check(pc == pcr, f"{sid} {y}: AC sums and the store's PC rows give other alliances")
                state = pooled(ca)
            bad = [n for n in pc if name(vals["pc"][pcs[n]]) != ids(pc[n])]
            check(set(pc) == set(pcs) and not bad, f"{sid} {y}: PC alliances differ from the results store: {bad[:10]}")
            check(name(vals["state"][st]) == ids(state), f"{sid} {y}: state alliance {name(vals['state'][st])} != {state}")
            for lvl in vals:
                inside = np.array([(x["id"] if lvl == "state" else x["st"]) == st for x in UNITS[lvl]])
                check(not np.isfinite(vals[lvl][~inside]).any(), f"{sid} {y}: {lvl} values outside {d.state_key}")
            # for the record: units whose leading alliance is not the winner's (several candidates of one alliance, PC sums)
            diff = [n for n in ac if ac[n] != most[n]]
            print(f"  {e.key}: cells at H6/H7/H8, {len(ac)} ACs, {len(pc)} PCs and the state match; "
                  f"{', '.join(x['label'] for x in var['categories'])}; ACs where the most-votes alliance is not the winner's: {diff or 'none'}")


def count_checks(dsets):
    print("counts: booth counts vs counts/ of the delivery")
    gated = {b["key"] for b in bcexport.booth_sources(cfg)}
    for d in dsets:
        sid = f"{d.id}_booths"
        for e in d.els:
            y = e.year
            pub = sid in VARS and y in VARS[sid]["years"]
            if not check((e.key in gated) == pub, f"{e.key}: passes the booth gate: {e.key in gated}, {sid} published: {pub}") or not pub:
                continue
            el = next((x for x in CC["booths"]["elections"] if x["id"] == e.key), None)
            check(el is not None and f"{el['prefix']}booths" == sid and el["year"] == y and el["state"] == d.state_key,
                  f"{e.key}: config.json does not couple the election to {sid}")
            q8 = VARS[sid]["q"]["8"]
            check(q8["dtype"] == "u16" and q8["t"] == "linear" and q8["scale"] == 1, f"{sid}: counts are not stored exactly")
            pins = el["counts"]["booths_located_pins"]
            dropped, nas = {}, {}
            for res in (8, 7, 6):
                t = pd.read_parquet(e.dir / "counts" / f"h{res}" / f"h{res}_{e.key}_booths.parquet")
                src = t[f"booths_{y}"].astype(float).to_numpy()
                pos = locate(res, t.h3_index)
                ok = pos >= 0
                v, na = published(d, sid, f"{d.id}_booths", y, res)
                check(np.array_equal(v[pos[ok]], src[ok], equal_nan=True), f"{sid} {y} h{res}: cells differ from the delivery")
                check(np.array_equal(na[pos[ok]], np.isnan(src[ok])), f"{sid} {y} h{res}: NA set differs")
                other = np.ones(len(v), bool)
                other[pos[ok]] = False
                check(not np.isfinite(v[other]).any() and not na[other].any(), f"{sid} {y} h{res}: values outside the delivered cells")
                dropped[res], nas[res] = int(np.nansum(src[~ok])), int(na.sum())
                check(np.nansum(v) + dropped[res] == pins, f"{sid} {y} h{res}: cells {np.nansum(v):.0f} + outside {dropped[res]} != pins {pins}")
            # units
            st, acs, pcs, pc_of = geography(d, e)
            t = pd.read_parquet(e.dir / "counts" / "units" / f"{e.key}_booth_counts.parquet")
            no = t.ac_no.astype(int).to_numpy()
            col = {k: t[f"{c}_{y}"].astype(float).to_numpy() for k, c in (("", "booths"), ("located", "booths_located"), ("unlocated", "booths_unlocated"))}
            x = col[""]
            check(np.nansum(col["located"]) + np.nansum(col["unlocated"]) == np.nansum(x), f"{sid} {y}: located + unlocated != booths")
            f = {lvl: json.loads((DATA / "units" / "v" / sid / f"{lvl}.json").read_text()) for lvl in ("ac", "pc", "district", "state")}
            j = f["ac"]["y"].index(y)
            at = np.array([acs[n] for n in no])
            exp = np.full(len(UNITS["ac"]), np.nan)
            exp[at] = x
            check(np.array_equal(unit_file(sid, "ac", y), exp, equal_nan=True), f"{sid} {y}: AC values differ from the counts table")
            for k in ("located", "unlocated"):
                exp = np.full(len(UNITS["ac"]), np.nan)
                exp[at] = col[k]
                got = np.array([np.nan if z is None else z for z in f["ac"]["e"][k][j]], float)
                check(np.array_equal(got, exp, equal_nan=True), f"{sid} {y}: AC {k} differs from the counts table")
            _, _, _, _, ids8 = index(8)
            a8, d8 = ids8["a"].astype(int), ids8["d"].astype(int)
            groups = {"pc": [pcs[pc_of[n]] for n in no], "state": [st] * len(no),
                      "district": [np.bincount(d8[(a8 == a) & (d8 >= 0)]).argmax() for a in at]}
            good = np.isfinite(x)
            for lvl, g in groups.items():
                g, n = np.array(g), len(UNITS[lvl])
                want = np.where(np.bincount(g[good], minlength=n) > 0, np.bincount(g[good], weights=x[good], minlength=n), np.nan)
                check(close(unit_file(sid, lvl, y), want).all(), f"{sid} {y} {lvl}: values differ from the sums of their ACs")
                left = np.array(f[lvl]["x"][j]) if "x" in f[lvl] else np.zeros(n, int)
                check(np.array_equal(left, np.bincount(g[~good], minlength=n)), f"{sid} {y} {lvl}: left-out AC counts differ")
            print(f"  {e.key}: pins {pins:,} = cells + pins outside the index (H8/H7/H6: {dropped[8]}/{dropped[7]}/{dropped[6]}); NA cells "
                  f"{nas[8]:,}/{nas[7]:,}/{nas[6]:,}; state {int(np.nansum(x)):,} booths, {int((~good).sum())} ACs without a value")


if __name__ == "__main__":
    dsets = bcexport.datasets(cfg)
    print("bcexport datasets: " + ", ".join(d.id + " (" + ", ".join(e.key for e in d.els) + ")" for d in dsets))
    hex_checks(dsets)
    unit_checks(dsets)
    bloc_checks(dsets)
    count_checks(dsets)
    for n_ in dict.fromkeys(notes):
        print("  note:", n_)
    print("ALL PASS" if not fails else f"{len(fails)} FAILED")
    sys.exit(1 if fails else 0)
