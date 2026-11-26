"""Check the AC/PC results published by pipeline/results.py against the results store.

usage: python tools/results_check.py [--seed N]

1. coverage: every election on a joinable seat map has ac.json + pc.json with every seat-map unit, keyed
   by the India Hex unit id of the key in <MAP>_ihex_keys.csv; excluded seat maps are absent everywhere.
2. cards: random 20 ACs and 10 PCs per election of KA, BR, MH, TN and WB: winner, runner-up, margin,
   top-3 votes, turnout, electors, NOTA against units.parquet / candidates.parquet.
3. AC -> PC: every AC's PC is the seat map's; PB AC 107/108 and WB AC 84/85 explicitly.
4. map series: every share, margin and winner value of the sampled units; state shares from summed votes.
"""
import csv
import json
import random
import sys
from pathlib import Path

import duckdb
import pandas as pd
import yaml

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
DATA = SITE / "data"
CFG = yaml.safe_load((ROOT / "india_hex.yaml").read_text(encoding="utf-8"))["results"]
STORE = Path(CFG["root"])
EXCL = set(CFG.get("exclude_seat_maps") or [])


def joinable(e):
    """Independent of pipeline/results.py: a seat map is joinable when its key table exists and every row has an
    AC and a PC key (no `none` match)."""
    sm = e.get("seat_map")
    p = STORE / "seatmaps" / f"{sm}_ihex_keys.csv"
    if not sm or sm in EXCL or not p.exists():
        return False
    import csv
    with open(p, encoding="utf-8") as fh:
        return all(r["ac_key"] and r["pc_key"] and r["match"] != "none" for r in csv.DictReader(fh))
seed = int(sys.argv[sys.argv.index("--seed") + 1]) if "--seed" in sys.argv else 7
rng = random.Random(seed)
fails = []
n_checks = 0


def check(ok, msg):
    global n_checks
    n_checks += 1
    if not ok:
        fails.append(msg)
        if len(fails) <= 40 or "--all" in sys.argv:
            print("  FAIL", msg)


U = json.loads((DATA / "units.json").read_text(encoding="utf-8"))
ID = {lvl: {u["key"]: u["id"] for u in U[lvl]} for lvl in ("ac", "pc")}
C = json.loads((SITE / "config.json").read_text(encoding="utf-8"))
R = C["results"]
by_key = {e["key"]: e for e in R["elections"]}
elections = json.loads((STORE / "elections.json").read_text(encoding="utf-8"))


def keys(sm):
    with open(STORE / "seatmaps" / f"{sm}_ihex_keys.csv", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    with open(STORE / "seatmaps" / f"{sm}_ac_pc.csv", encoding="utf-8") as f:
        amap = {int(r["ac_no"]): int(r["pc_no"]) for r in csv.DictReader(f)}
    return ({int(r["ac_no"]): ID["ac"][r["ac_key"]] for r in rows}, {int(r["pc_no"]): ID["pc"][r["pc_key"]] for r in rows}, amap)


def unit_vals(sid, level):
    f = json.loads((DATA / "units" / "v" / sid / f"{level}.json").read_text())
    if f["v"][0] is None:
        return None
    out = [None] * f.get("n", 0)
    for i, x in enumerate(f["v"][0]):
        out[f["o"] + i] = x
    return out


print("check 1: coverage")
for e in elections:
    k = e["key"]
    if not joinable(e):
        check(k not in by_key and not (DATA / "results" / k).exists(), f"{k}: on excluded map {e['seat_map']} but published")
        check(not any(s.startswith(f"r_{k}_") for s in (p.name for p in (DATA / "units" / "v").iterdir())), f"{k}: map series published")
        continue
    check(k in by_key, f"{k}: missing from config.json results")
    acid, pcid, amap = keys(e["seat_map"])
    for level, ids in (("ac", acid), ("pc", pcid)):
        f = json.loads((DATA / "results" / k / f"{level}.json").read_text(encoding="utf-8"))
        got = {int(i): u["no"] for i, u in f["u"].items()}
        check(got == {v: n for n, v in ids.items()}, f"{k} {level}: unit ids differ from the key table ({len(got)} vs {len(ids)})")
        if level == "ac":   # 3: AC -> PC is the seat map's
            bad = [u["no"] for u in f["u"].values() if u["pc"] != pcid[amap[u["no"]]]]
            check(not bad, f"{k}: ACs whose PC is not the seat map's: {bad[:5]}")

print("check 3: PB AC 107/108, WB AC 84/85")
pc_name = {u["id"]: u["name"] for u in U["pc"]}
for k, want in [(e["key"], {107: "SANGRUR", 108: "SANGRUR"} if e["state"] == "PB" else {84: "RANAGHAT", 85: "KRISHNANAGAR"})
                for e in elections if e["state"] in ("PB", "WB") and joinable(e)]:
    f = json.loads((DATA / "results" / k / "ac.json").read_text(encoding="utf-8"))
    for i, u in f["u"].items():
        if u["no"] in want:
            check(pc_name[u["pc"]].upper().startswith(want[u["no"]]), f"{k} AC {u['no']}: PC {pc_name[u['pc']]}, want {want[u['no']]}")
            # since the PC fixes (india_hex.yaml source.boundaries.pc_fixes) India Hex's own PC layer agrees too
            check(U["ac"][int(i)]["pc"] == u["pc"], f"{k} AC {u['no']}: India Hex's own PC layer puts it in {pc_name.get(U['ac'][int(i)]['pc'])}")

print("check 2 + 4: cards and map values")
con = duckdb.connect()
sampled = {"ac": 0, "pc": 0}
for e in elections:
    k = e["key"]
    if k not in by_key:   # every joined election, every state
        continue
    el = by_key[k]
    maps = {m["s"]: m for m in el["maps"]}
    acid, pcid, _ = keys(e["seat_map"])
    for level, ids, n in (("ac", acid, 20), ("pc", pcid, 10)):
        f = json.loads((DATA / "results" / k / f"{level}.json").read_text(encoding="utf-8"))
        uu = con.sql(f"SELECT * FROM '{STORE / k / 'units.parquet'}' WHERE level='{level}'").df().set_index("unit_no")
        cc = con.sql(f"SELECT * FROM '{STORE / k / 'candidates.parquet'}' WHERE level='{level}' AND NOT is_nota").df()
        vals = {s: unit_vals(f"r_{k}_{s}", level) for s in maps}
        for no in rng.sample(sorted(ids), min(n, len(ids))):
            sampled[level] += 1
            uid = ids[no]
            u = f["u"][str(uid)]
            r = uu.loc[no]
            g = cc[cc.unit_no == no].sort_values("votes", ascending=False, na_position="last")
            tag = f"{k} {level} {no}"
            if pd.isna(r.total_valid):
                check("c" not in u or not u.get("tv"), f"{tag}: votes published where the store has none")
                continue
            check(u.get("w") == r.winner_party and u.get("r") == (None if pd.isna(r.runner_party) else r.runner_party), f"{tag}: winner/runner {u.get('w')}/{u.get('r')} vs {r.winner_party}/{r.runner_party}")
            check(u.get("m") == (None if pd.isna(r.margin_votes) else r.margin_votes) and abs(u.get("mp", -1) - r.margin_pct) < 0.006, f"{tag}: margin {u.get('m')} {u.get('mp')} vs {r.margin_votes} {r.margin_pct}")
            check([x[2] for x in u["c"][:3]] == [int(v) for v in g.votes.head(3)], f"{tag}: top-3 votes {[x[2] for x in u['c'][:3]]} vs {list(g.votes.head(3))}")
            if level == "ac" or e["house"] == "LS":
                check([x[0] for x in u["c"][:3]] == list(g.candidate.head(3)), f"{tag}: top-3 names differ")
            if not pd.isna(r.turnout_pct):
                check(abs(u.get("t", -1) - r.turnout_pct) < 0.006, f"{tag}: turnout {u.get('t')} vs {r.turnout_pct}")
            check(u.get("e") == (None if pd.isna(r.electors) else r.electors), f"{tag}: electors {u.get('e')} vs {r.electors}")
            check(u.get("tv") == r.total_valid, f"{tag}: valid votes {u.get('tv')} vs {r.total_valid}")
            if not pd.isna(r.nota):
                check(u.get("nota") == r.nota, f"{tag}: NOTA {u.get('nota')} vs {r.nota}")
            # map values of this unit
            pv = g.groupby("party").votes.sum()
            for s, m in maps.items():
                v = vals[s][uid] if vals[s] else None
                if s == "win":
                    cats = [c[0] for c in m["c"]]
                    want = r.winner_party if r.winner_party in cats else "others"
                    check(v is not None and cats[v] == want, f"{tag}: winner series {cats[v] if v is not None else None} vs {want}")
                elif s == "margin":
                    check(v is not None and abs(v - r.margin_pct) < 0.006, f"{tag}: margin series {v} vs {r.margin_pct}")
                elif s.startswith("bloc_"):
                    continue   # bloc totals are checked at state level below
                elif s == "others":
                    continue
                else:
                    party = m["l"].replace(" vote share", "")
                    want = pv.get(party, 0) / r.total_valid
                    check(v is not None and abs(v - want) < 6e-4 * max(1, want * 10), f"{tag}: {s} share {v} vs {want:.4f}")
    # state shares: VS from AC votes, LS from PC votes
    lvl = "ac" if e["house"] == "VS" else "pc"
    call = con.sql(f"SELECT unit_no, party, bloc, votes FROM '{STORE / k / 'candidates.parquet'}' WHERE level='{lvl}'").df()
    # each India Hex state of the election gets its own value, from the votes of its own units (undivided
    # Andhra Pradesh: today's AP and Telangana); the unit's state comes from the key table, independently
    keys_csv = pd.read_csv(STORE / "seatmaps" / f"{el['seat_map']}_ihex_keys.csv")
    # a unit's state = the state it is drawn in on India Hex (units.json "st" of the unit its key names)
    st_key = {u["id"]: u["key"] for u in U["state"]}
    unit_by_key = {u["key"]: u for u in U[lvl]}
    kcol, ncol = ("ac_key", "ac_no") if lvl == "ac" else ("pc_key", "pc_no")
    state_of = {int(n): st_key[unit_by_key[kk]["st"]] for n, kk in zip(keys_csv[ncol], keys_csv[kcol])}
    call["st"] = [state_of[int(n)] for n in call.unit_no]
    states_here = el.get("states") or [el["state"]]
    # the election's states are where its ACs are drawn; state values come from ACs (VS) or PCs (LS), so a state
    # holding only ACs of an LS election (e.g. Bhadrachalam's segment, drawn in Andhra Pradesh) has no state value
    ac_keys_csv = dict(zip(keys_csv.ac_no, keys_csv.ac_key))
    ac_unit = {u["key"]: u for u in U["ac"]}
    ac_states = sorted({st_key[ac_unit[kk]["st"]] for kk in ac_keys_csv.values()})
    check(sorted(states_here) == ac_states, f"{k}: config states {states_here} vs the ACs' states {ac_states}")
    for skey in states_here:
        st_id = next(u["id"] for u in U["state"] if u["key"] == skey)
        cc = call[call.st == skey]
        # denominator: the official valid votes of the state's units (units.parquet), not the printed candidates' sum
        # (Bihar 2015 ACs 195, 210, 229 print only some candidates; their totals come from the ECI summary)
        uu = con.sql(f"SELECT unit_no, total_valid FROM '{STORE / k / 'units.parquet'}' WHERE level='{lvl}'").df()
        uu = uu[[state_of[int(n)] == skey for n in uu.unit_no]]
        # units without an official total (e.g. ECI's blank detailed results) are left out of the state value
        uu = uu[uu.total_valid.notna() & (uu.total_valid > 0)]
        cc = cc[cc.unit_no.isin(set(uu.unit_no))]
        tot = uu.total_valid.sum()
        if not tot:   # no AC (VS) or PC (LS) of the election lies in this state: no state value
            for s in maps:
                if s not in ("win", "margin"):
                    sv = unit_vals(f"r_{k}_{s}", "state")
                    check(sv is None or sv[next(u["id"] for u in U["state"] if u["key"] == skey)] is None,
                          f"{k} state {skey} {s}: a value without units")
            continue
        for s, m in maps.items():
            if s in ("win", "margin"):
                check(unit_vals(f"r_{k}_{s}", "state") is None, f"{k}: {s} has state values")
                continue
            v = unit_vals(f"r_{k}_{s}", "state")[st_id]
            if s == "others":
                main = [x["l"].replace(" vote share", "") for x in el["maps"] if x["s"] not in ("win", "margin", "others") and not x["s"].startswith("bloc_")]
                want = 1 - cc[cc.party.isin(main)].votes.sum() / tot
            elif s.startswith("bloc_"):
                b = [bb for bb in call.bloc.dropna().unique() if bb.lower().replace("(", "").replace(")", "").replace(" ", "") == s[5:] or "".join(ch for ch in bb.lower() if ch.isalnum()) == s[5:]]
                want = cc[cc.bloc == b[0]].votes.sum() / tot if b else None
            else:
                want = cc[cc.party == m["l"].replace(" vote share", "")].votes.sum() / tot
            check(want is not None and v is not None and abs(v - want) < 6e-4, f"{k} state {skey} {s}: {v} vs {want}")

sizes = sum(p.stat().st_size for p in (DATA / "results").rglob("*") if p.is_file())
usz = sum(p.stat().st_size for d in (DATA / "units" / "v").iterdir() if d.name.startswith("r_") for p in d.iterdir())
print(f"sampled {sampled['ac']} AC and {sampled['pc']} PC cards; {len(R['elections'])} elections; "
      f"data/results {sizes / 1e6:.2f} MB + unit files {usz / 1e6:.2f} MB")
print(f"{n_checks} checks, {len(fails)} failed" + ("" if fails else ": ALL PASS"))
sys.exit(1 if fails else 0)
