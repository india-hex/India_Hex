"""AC/PC election results from the booth-catchment results store, joined to India Hex units.

india_hex.yaml:
  results:
    root: D:/booth_catchment/results      # elections.json, parties.json, <key>/{units,candidates}.parquet, seatmaps/
    exclude_seat_maps: [AS_2023]          # elections on these seat maps have no India Hex units: never joined

Per election (elections.json, minus excluded seat maps) the build writes, keyed by India Hex unit id:
  data/results/<key>/ac.json, pc.json   the unit card: candidates (top 5), party and bloc totals, turnout,
                                        electors, NOTA, winner, runner-up, margin, gaps
  data/units/v/r_<key>_*/<level>.json   unit-only map series (no hexagons): Winner, Winning margin, vote
                                        share of each party or alliance with >= 5% statewide, Others.
                                        Stored for the state's id range only ("o": first id, "n": length).

The join: every unit number of the election's seat map has an India Hex key in seatmaps/<MAP>_ihex_keys.csv
(ac_key / pc_key = units.json keys). AC -> PC is the seat map's (<MAP>_ac_pc.csv), never India Hex's own PC
layer, which is wrong for PB AC 107/108 and WB AC 84/85. PC values are the store's PC rows (LS: the
official PC results; VS: the store's sums of each PC's ACs). Districts sum their ACs (India Hex's
AC -> district: most of the AC's H8 cells), so district values are approximate; a state sums its ACs (VS)
or PCs (LS). Winner and margin exist for ACs and PCs only. Gaps are passed on, never filled.
Rebuilt per election when its source files, the seat-map tables, units.json or this module change.
"""
import csv
import json
import os
import re
import stat
from pathlib import Path

import duckdb

from .catalog import Series
from .config import DATA
from .util import file_sig, log, obj_sig

VERSION = 8   # bump when the output format or the series rules change
HOUSE = {"VS": "Assembly", "LS": "Lok Sabha"}
# India Hex's election palette (BJP/NDA orange, INC/MGB/UPA blue, JD(S) green, JSP pink, others grey)
PALETTE = {"BJP": "#E69F00", "NDA": "#E69F00", "INC": "#0072B2", "MGB": "#0072B2", "UPA": "#0072B2",
           "JD(S)": "#009E73", "JSP": "#CC79A7", "JNSRJP": "#CC79A7"}
GREY = "#999999"
# colours for parties with none set (Okabe-Ito and Tol, colour-blind-friendly), handed out per state by votes
AUTO = ["#882255", "#44AA99", "#332288", "#D55E00", "#56B4E9", "#999933", "#CC6677", "#117733", "#AA4499",
        "#DDCC77", "#88CCEE"]   # pale sand and cyan last: they are close to the light shades of orange and blue
NO_COLOUR = {"IND", "NOTA", "OTH", "OTHERS"}   # stay grey
DULL = {"#888888", "#999999"}
RAMP = {"#E69F00": "oranges", "#0072B2": "blues", "#56B4E9": "blues", "#009E73": "bugn", "#117733": "greens",
        "#44AA99": "bugn", "#CC79A7": "rdpu", "#AA4499": "rdpu", "#D55E00": "ylorrd", "#332288": "purples",
        "#882255": "rdpu", "#CC6677": "rdpu", "#DDCC77": "ylorbr", "#999933": "ylgn", "#88CCEE": "blues"}
MAIN_SHARE = 0.05      # parties and alliances with at least this statewide share get a map series
TOP = 5                # candidates per unit in the card files
MARGIN_BREAKS = [2, 5, 10, 15, 20, 30]


def _rm(p):
    os.chmod(p, stat.S_IWRITE)
    p.unlink()


def _slug(s):
    return re.sub(r"[^a-z0-9]+", "", s.lower()) or "x"


def _r(x, k=4):
    """Round to k significant digits (None stays None)."""
    if x is None or x != x:
        return None
    return float(f"{x:.{k}g}")


class Store:
    """The results store on disk: elections, parties, seat maps."""

    def __init__(self, spec):
        self.root = Path(spec["root"])
        self.exclude = set(spec.get("exclude_seat_maps") or [])
        self.elections = json.loads((self.root / "elections.json").read_text(encoding="utf-8"))
        self.parties = json.loads((self.root / "parties.json").read_text(encoding="utf-8"))
        self._keys = {}
        self._ok = {}
        self._auto = None
        self.keep = {}       # {India Hex state key: {party: colour}}: the last build's assignment, kept
        self.assigned = {}   # this build's assignment, saved for the next one

    def joinable(self, e):
        """True when every AC and PC of the election's seat map has a checked India Hex key. Maps with no key table
        (old 1976 seats), a table of `none` rows (Assam 2023, J&K 2022, Ladakh 2024: India Hex has no such units) or
        no seat map are left out; `exclude_seat_maps` can also leave a map out."""
        sm = e.get("seat_map")
        if not sm or sm in self.exclude:
            return False
        if sm not in self._ok:
            path = self.root / "seatmaps" / f"{sm}_ihex_keys.csv"
            ok = path.exists()
            if ok:
                with open(path, encoding="utf-8") as f:
                    ok = all(r["ac_key"] and r["pc_key"] and r["match"] != "none" for r in csv.DictReader(f))
            self._ok[sm] = ok
        return self._ok[sm]

    def keys(self, seat_map):
        """{ac_no: (ac_key, pc_no)}, {pc_no: pc_key} from <MAP>_ihex_keys.csv, checked against <MAP>_ac_pc.csv."""
        if seat_map not in self._keys:
            with open(self.root / "seatmaps" / f"{seat_map}_ihex_keys.csv", encoding="utf-8") as f:
                rows = list(csv.DictReader(f))
            with open(self.root / "seatmaps" / f"{seat_map}_ac_pc.csv", encoding="utf-8") as f:
                amap = {int(r["ac_no"]): int(r["pc_no"]) for r in csv.DictReader(f)}
            ac, pc = {}, {}
            for r in rows:
                n, p = int(r["ac_no"]), int(r["pc_no"])
                if amap.get(n) != p:
                    raise ValueError(f"{seat_map}: AC {n} has PC {p} in the key table but {amap.get(n)} in the seat map")
                if not r["ac_key"] or not r["pc_key"] or r["match"] == "none":
                    raise ValueError(f"{seat_map}: AC {n} has no India Hex key")
                ac[n] = (r["ac_key"], p)
                pc[p] = r["pc_key"]
            if len(amap) != len(ac):
                raise ValueError(f"{seat_map}: {len(amap)} ACs in the seat map, {len(ac)} in the key table")
            self._keys[seat_map] = (ac, pc)
        return self._keys[seat_map]

    def auto_colours(self, e):
        """{party: colour} for parties with no set colour, shared by every election of the election's states (states
        joined by a multi-state seat map, e.g. undivided Andhra Pradesh, share one list). A party keeps the colour it
        had in the last build (`keep`), so new or older elections arriving do not recolour live maps; a party new to
        the states takes the least-used free colour, most-voted first (from nothing: the most-voted party gets the
        first free colour, and so on round the palette). Colours of the states' set-colour parties are skipped while
        enough remain."""
        if self._auto is None:
            parent = {}

            def find(x):
                while parent[x] != x:
                    x = parent[x]
                return x
            els = [e2 for e2 in self.elections if self.joinable(e2)]
            st_of = {}
            for e2 in els:
                sts = sorted({k.split("|")[0] for k, _ in self.keys(e2["seat_map"])[0].values()})
                for s in sts:
                    parent.setdefault(s, s)
                for s in sts[1:]:
                    parent[find(s)] = find(sts[0])
                st_of[e2["key"]] = sts[0]
            groups, members = {}, {}
            for e2 in els:
                groups.setdefault(find(st_of[e2["key"]]), []).append(e2["key"])
            for s in parent:
                members.setdefault(find(s), []).append(s)
            parties = self.parties["parties"]
            self._auto = {}
            for root, keys in groups.items():
                files = [(self.root / k / "candidates.parquet").as_posix() for k in keys]
                rows = duckdb.sql(f"SELECT party, sum(votes) AS v FROM read_parquet({files!r}, union_by_name=true) "
                                  "WHERE party IS NOT NULL GROUP BY party ORDER BY v DESC NULLS LAST, party").fetchall()
                taken = {(parties.get(p) or {}).get("colour") or PALETTE.get(p) for p, _ in rows}
                free = [c for c in AUTO if c not in taken]
                if len(free) < 6:
                    free = AUTO
                plain = [p for p, _ in rows if not ((parties.get(p) or {}).get("colour") or PALETTE.get(p))
                         and p.upper() not in NO_COLOUR]
                kept = {}
                for s in sorted(members[root]):
                    for p, c in (self.keep.get(s) or {}).items():
                        kept.setdefault(p, c)
                cols = {p: kept[p] for p in plain if kept.get(p) in AUTO}
                for p in plain:
                    if p not in cols:
                        use = {c: 0 for c in free}
                        for c in cols.values():
                            if c in use:
                                use[c] += 1
                        cols[p] = min(free, key=lambda c: (use[c], free.index(c)))
                for s in members[root]:
                    self.assigned[s] = cols
                for k in keys:
                    self._auto[k] = cols
        return self._auto.get(e["key"], {})

    def files_sig(self, e):
        k = e["key"]
        sm = e["seat_map"]
        return [file_sig(self.root / k / "units.parquet"), file_sig(self.root / k / "candidates.parquet"),
                file_sig(self.root / "seatmaps" / f"{sm}_ihex_keys.csv"), file_sig(self.root / "seatmaps" / f"{sm}_ac_pc.csv"),
                file_sig(self.root / "parties.json"), file_sig(self.root / "elections.json")]


def _tint(hex_colour, k):
    """The k-th variant of a colour shared by alliance partners: lighter, then darker, then lighter still."""
    r, g, b = (int(hex_colour[i:i + 2], 16) for i in (1, 3, 5))
    mix = [(255, 0.5), (0, 0.38), (255, 0.75), (0, 0.6)][(k - 1) % 4]
    r, g, b = (round(x + (mix[0] - x) * mix[1]) for x in (r, g, b))
    return f"#{r:02x}{g:02x}{b:02x}"


def _distinct(cats):
    """No two categories of one map share a colour: partners keep their alliance's hue in another shade."""
    seen = {}
    for c in cats:
        key = c["color"].lower()
        k = seen.get(key, 0)
        if k:
            c["color"] = _tint(c["color"], k)
        seen[key] = k + 1


def _colour_fn(store, key):
    """Party colour in one election: parties.json, else its alliance's colour, else the palette, else grey."""
    parties = store.parties["parties"]
    blocs = store.parties["blocs"].get(key) or {}
    via_bloc = {}
    for b in blocs.values():
        if len(b["members"]) >= 2 and b["colour"] not in DULL:
            for m in b["members"]:
                via_bloc.setdefault(m, b["colour"])

    auto = store.auto_colours({"key": key})

    def colour(party):
        c = (parties.get(party) or {}).get("colour")
        return c or via_bloc.get(party) or PALETTE.get(party) or auto.get(party) or GREY
    return colour


def _alliances(store, key):
    """{bloc: (label, colour)} for the election's alliances (two or more member parties)."""
    out = {}
    for b, v in (store.parties["blocs"].get(key) or {}).items():
        if len(v["members"]) >= 2:
            out[b] = (v["label"], v["colour"] if v["colour"] not in DULL else PALETTE.get(b, GREY))
    return out


def _units(con, path, level):
    df = con.sql(f"SELECT * FROM '{path}' WHERE level = '{level}' ORDER BY unit_no").df()
    return df.astype(object).where(df.notna(), None)   # pandas NA -> None


def _cands(con, path, level):
    df = con.sql(f"SELECT unit_no, candidate, party, bloc, votes, is_nota FROM '{path}' WHERE level = '{level}' "
                   f"ORDER BY unit_no, votes DESC NULLS LAST, cand_no").df()
    df["votes"] = df["votes"].astype(float)            # NULL -> NaN
    for c in ("candidate", "bloc"):
        df[c] = df[c].astype(object).where(df[c].notna(), None)
    return df


def _num(x):
    return None if x is None or x != x else x


def _int(x):
    x = _num(x)
    return None if x is None else int(x)


def build_election(store, e, units, out_dir):
    """Write the card files of one election; return its map values and meta (for series and config)."""
    key, sm = e["key"], e["seat_map"]
    ac_keys, pc_keys = store.keys(sm)
    id_of = {lvl: {u["key"]: u["id"] for u in units[lvl]} for lvl in ("ac", "pc")}
    ac_id, pc_id = {}, {}
    for n, (k, p) in ac_keys.items():
        if k not in id_of["ac"]:
            raise ValueError(f"{key}: AC key {k} not in units.json")
        ac_id[n] = id_of["ac"][k]
    for p, k in pc_keys.items():
        if k not in id_of["pc"]:
            raise ValueError(f"{key}: PC key {k} not in units.json")
        pc_id[p] = id_of["pc"][k]
    # the India Hex states the seats are drawn in (undivided Andhra Pradesh: AP + Telangana; J&K 1995 seats: J&K +
    # Ladakh), by each AC unit's own state on the map; the main one has the most ACs
    n_in = {}
    for i in ac_id.values():
        sk = units["state"][units["ac"][i]["st"]]["key"]
        n_in[sk] = n_in.get(sk, 0) + 1
    sts = [u for u in units["state"] if u["key"] in n_in]
    st = max(sts, key=lambda u: n_in[u["key"]])
    colour = _colour_fn(store, key)
    allies = _alliances(store, key)
    names = store.parties["parties"]
    con = duckdb.connect()
    up, cp = store.root / key / "units.parquet", store.root / key / "candidates.parquet"
    used_parties = set()
    vals = {}   # level -> {unit id: {"tv": votes, "p": {party: votes}, "b": {bloc: votes}, "w", "mp"}}
    for level in ("ac", "pc"):
        U = _units(con, up, level)
        C = _cands(con, cp, level)
        by_unit = {n: g for n, g in C.groupby("unit_no")}
        ids = ac_id if level == "ac" else pc_id
        if level == "ac" and e["house"] == "LS" and not len(U) and not len(C):
            # a Lok Sabha election with PC results only (ECI printed no assembly-segment figures before 2004):
            # no AC rows, an empty AC card file; its maps are PC and state only
            vals[level] = {}
            (out_dir / "ac.json").write_text(json.dumps({"v": 1, "key": key, "level": "ac", "lead": True, "agg": False,
                                                        "seat_map": sm, "pc_only": 1, "u": {}}, separators=(",", ":")),
                                             encoding="utf-8")
            continue
        missing = sorted(set(U.unit_no) - set(ids))
        if missing:
            raise ValueError(f"{key} {level}: unit numbers without an India Hex key: {missing[:10]}")
        if len(U) != len(ids):
            raise ValueError(f"{key} {level}: {len(U)} units in the store, {len(ids)} on the seat map {sm}")
        out = {}
        lv = vals[level] = {}
        for r in U.itertuples(index=False):
            n = int(r.unit_no)
            g = by_unit.get(n)
            d = {"no": n, "n": r.unit_name}
            if level == "ac":
                p = ac_keys[n][1]
                if _int(r.pc_no) is not None and int(r.pc_no) != p:
                    raise ValueError(f"{key}: AC {n} is in PC {r.pc_no} in the store but {p} on the seat map")
                d["pc"] = pc_id[p]
            for f, col in (("e", "electors"), ("vp", "votes_polled"), ("tv", "total_valid"), ("nota", "nota"), ("m", "margin_votes")):
                v = _int(getattr(r, col))
                if v is not None:
                    d[f] = v
            for f, col in (("t", "turnout_pct"), ("mp", "margin_pct")):
                v = _num(getattr(r, col))
                if v is not None:
                    d[f] = round(float(v), 2)
            for f, col in (("w", "winner_party"), ("wb", "winner_bloc"), ("r", "runner_party")):
                v = getattr(r, col)
                if v is not None and v == v:
                    d[f] = v
            if not bool(r.complete):
                d["x"] = 1
                if r.note:
                    d["note"] = r.note
            if g is not None:
                g = g[~g.is_nota.astype(bool)]
                top = g.head(TOP)
                d["c"] = [[c, p, _int(v)] for c, p, v in zip(top.candidate, top.party, top.votes)]
                tv = d.get("tv")
                if tv is not None:
                    d["o"] = int(tv - top.votes.fillna(0).sum() - (d.get("nota") or 0))
                pv = g.groupby("party", sort=False).votes.sum(min_count=1)
                d["p"] = [[p, _int(v)] for p, v in sorted(pv.items(), key=lambda x: -(x[1] if x[1] == x[1] else -1))]
                bv = g[g.bloc.isin(list(allies))].groupby("bloc").votes.sum(min_count=1)
                if len(bv):
                    d["b"] = [[b, _int(v)] for b, v in sorted(bv.items(), key=lambda x: -(x[1] if x[1] == x[1] else -1))]
                used_parties |= set(pv.index)
                if tv:
                    lv[ids[n]] = {"tv": tv, "p": {p: float(v) for p, v in pv.items() if v == v},
                                  "b": {b: float(v) for b, v in bv.items() if v == v}, "w": d.get("w"), "mp": d.get("mp")}
            out[str(ids[n])] = d
        head = {"v": 1, "key": key, "level": level, "lead": level == "ac" and e["house"] == "LS",
                "agg": level == "pc" and e["house"] == "VS", "seat_map": sm}
        if True:   # party colours, names and alliances of the election
            head["colours"] = {p: colour(p) for p in sorted(used_parties) if colour(p) != GREY}
            head["names"] = {p: names[p]["name"] for p in sorted(used_parties) if (names.get(p) or {}).get("name") and names[p]["name"] != p}
            head["blocs"] = {b: list(v) for b, v in allies.items()}
        (out_dir / f"{level}.json").write_text(json.dumps({**head, "u": out}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return {"state": st, "states": sts, "vals": vals, "colour": colour, "allies": allies}


def _sum(rows):
    tv = sum(r["tv"] for r in rows)
    p, b = {}, {}
    for r in rows:
        for k, v in r["p"].items():
            p[k] = p.get(k, 0) + v
        for k, v in r["b"].items():
            b[k] = b.get(k, 0) + v
    return {"tv": tv, "p": p, "b": b}


def map_series(e, built, units):
    """The election's unit-only map series: [(Series, {level: {unit id: value}})]."""
    key, year, house = e["key"], e["year"], e["house"]
    st = built["state"]
    vals = built["vals"]
    colour = built["colour"]
    # districts sum their ACs (India Hex's AC -> district); the state sums its ACs (VS) or PCs (LS)
    dist = {}
    for u in units["ac"]:
        if u["id"] in vals["ac"] and u.get("d", -1) >= 0:
            dist.setdefault(u["d"], []).append(vals["ac"][u["id"]])
    top = "ac" if house == "VS" else "pc"
    agg = {"district": {d: _sum(rs) for d, rs in dist.items()},
           "state": {s["id"]: _sum([v for i, v in vals[top].items() if units[top][i]["st"] == s["id"]]) for s in built["states"]}}
    agg["state"] = {i: r for i, r in agg["state"].items() if r["tv"]}
    whole = _sum(list(vals[top].values()))   # the whole election (statewide shares pick the main parties)
    name, hname = st["name"], HOUSE[house]
    group = f"{name} {hname} {year} results"
    menu = ["Elections", name, hname, f"{year} results"]
    seg = house == "LS"
    pc_only = seg and not vals["ac"]   # PC results only: no segment figures, so no AC or district values
    base = dict(dataset="results", group=group, file="", cols={year: None}, states=[s["key"] for s in built["states"]], menu=menu,
                results=key)
    note_src = ("ECI results. PCs only (no assembly-segment figures for this election)" if pc_only else
                "ECI results. ACs: lead in the assembly segment (EVM votes); PCs: the official result" if seg
                else "ECI results. PCs: sums of their ACs")
    seat_lv = ["pc"] if pc_only else ["ac", "pc"]
    all_lv = ["pc", "state"] if pc_only else ["ac", "pc", "district", "state"]
    out = []

    def levels_of(get, lvls=("ac", "pc", "district", "state")):
        lv = {}
        for lvl in lvls:
            src = vals[lvl] if lvl in ("ac", "pc") else agg[lvl]
            lv[lvl] = {i: get(r) for i, r in src.items()}
            lv[lvl] = {i: v for i, v in lv[lvl].items() if v is not None}
        return lv

    # winner (categorical): one category per party winning 2+ units or with its own colour, else Others
    wins = {}
    for lvl in ("ac", "pc"):
        for r in vals[lvl].values():
            if r["w"]:
                wins[r["w"]] = wins.get(r["w"], 0) + 1
    ac_w, pc_w = {}, {}
    for r in vals["ac"].values():
        if r["w"]:
            ac_w[r["w"]] = ac_w.get(r["w"], 0) + 1
    for r in vals["pc"].values():
        if r["w"]:
            pc_w[r["w"]] = pc_w.get(r["w"], 0) + 1
    # own category: 3+ AC wins (VS) or segment leads, or a PC won (LS); everyone else is Others
    own = sorted((p for p in wins if ac_w.get(p, 0) >= 3 or (seg and pc_w.get(p, 0) >= 1) or (not seg and pc_w.get(p, 0) >= 1 and ac_w.get(p, 0) >= 2)),
                 key=lambda p: (-pc_w.get(p, 0) if seg else 0, -ac_w.get(p, 0)))
    cats = [{"id": p, "label": "Independents" if p == "IND" else p, "color": colour(p), "years": [year]} for p in own]
    if len(own) < len(wins):
        cats.append({"id": "others", "label": "Others", "color": GREY, "years": [year]})
    _distinct(cats)
    code = {c["id"]: i for i, c in enumerate(cats)}
    win = Series(id=f"r_{key}_win", label="Winner" if not seg or pc_only else "Winner (AC: segment lead)", type="categorical",
                 categories=cats, format="cat", agg="lead", dtype="u8", ramp="cat",
                 note=("PCs: the party of the elected candidate" if pc_only else
                       "PCs: the party of the elected candidate; ACs: the party leading the assembly segment (EVM votes)" if seg
                       else "ACs: the party of the elected candidate; PCs: the party with most votes over its ACs"),
                 unit_levels=seat_lv, **base)
    out.append((win, levels_of(lambda r: code.get(r["w"], code.get("others")) if r["w"] else None, seat_lv)))
    mar = Series(id=f"r_{key}_margin", label="Winning margin" if not seg or pc_only else "Winning margin (AC: segment lead)",
                 unit="pp", format="dec1", agg="wmean", ramp="viridis", breaks=MARGIN_BREAKS,
                 note=f"Percentage points of valid votes incl. NOTA, winner over runner-up. {note_src}",
                 unit_levels=seat_lv, **base)
    out.append((mar, levels_of(lambda r: r["mp"], seat_lv)))
    # vote shares: parties, then alliances, with >= 5% statewide; Others is everything else incl. NOTA
    main = [p for p, v in sorted(whole["p"].items(), key=lambda x: -x[1]) if p not in ("IND", "NOTA") and v / whole["tv"] >= MAIN_SHARE]
    blocs = [b for b, v in sorted(whole["b"].items(), key=lambda x: -x[1])
             if v / whole["tv"] >= MAIN_SHARE and b in built["allies"]]
    ids = set()
    lv_note = f"Share of valid votes incl. NOTA. {note_src}" + ("" if pc_only else "; districts: sums of their ACs (approximate)")
    for p in main:
        sid = f"r_{key}_{_slug(p)}"
        while sid in ids:
            sid += "x"
        ids.add(sid)
        s = Series(id=sid, label=f"{p} vote share", format="pct", agg="wmean", dtype="u8", ramp=RAMP.get(colour(p), "purples"),
                   note=lv_note, unit_levels=all_lv, **base)
        out.append((s, levels_of(lambda r, p=p: _r(r["p"].get(p, 0) / r["tv"]) if r["tv"] else None, all_lv)))
    for b in blocs:
        label, col = built["allies"][b]
        sid = f"r_{key}_bloc_{_slug(b)}"
        short = label.split(" (")[0]
        s = Series(id=sid, label=f"{short} vote share", format="pct", agg="wmean", dtype="u8", ramp=RAMP.get(col, "purples"),
                   note=f"{label}. {lv_note}", unit_levels=all_lv, **base)
        out.append((s, levels_of(lambda r, b=b: _r(r["b"].get(b, 0) / r["tv"]) if r["tv"] else None, all_lv)))
    oth = Series(id=f"r_{key}_others", label="Others vote share (incl. NOTA)", format="pct", agg="wmean", dtype="u8",
                 ramp="greys", note=f"Everyone except {', '.join(main)}. {lv_note}", unit_levels=all_lv, **base)
    out.append((oth, levels_of(lambda r: _r(1 - sum(r["p"].get(p, 0) for p in main) / r["tv"]) if r["tv"] else None, all_lv)))
    return out, main, blocs


def _write_unit_files(sid, year, by_level, units, st_id):
    """units/v/<sid>/<level>.json for the state's id range: {"y", "o", "n", "v": [[values]]}; a level
    without values gets "v": [null] (the browser treats it as no data)."""
    d = DATA / "units" / "v" / sid
    d.mkdir(parents=True, exist_ok=True)
    names = []
    for lvl in ("state", "district", "pc", "ac"):
        lv = by_level.get(lvl)
        if not lv:
            out = {"y": [year], "v": [None]}
        else:
            lo, hi = min(lv), max(lv)   # the units with values (one state, or several for undivided Andhra Pradesh)
            out = {"y": [year], "o": lo, "n": len(units[lvl]), "v": [[lv.get(i) for i in range(lo, hi + 1)]]}
        p = d / f"{lvl}.json"
        text = json.dumps(out, separators=(",", ":"))
        if not p.exists() or p.read_text() != text:
            p.write_text(text)
        names.append(p)
    return names


def _series_from(d):
    return Series(**{k: (({int(y): c for y, c in v.items()}) if k == "cols" else v) for k, v in d.items()})


def _series_dict(s):
    from dataclasses import asdict
    d = asdict(s)
    d["cols"] = {str(y): c for y, c in s.cols.items()}
    return d


def build(cfg, st, units, units_sig):
    """Every joinable election: card files + map series (incremental). Returns the map series."""
    spec = cfg.get("results")
    if not spec:
        return []
    store = Store(spec)
    store.keep = st.get("results_colours") or {}
    prev = st.get("results") or {}
    done = {}
    series = []
    base = DATA / "results"
    expected = set()
    for e in store.elections:
        key = e["key"]
        if not store.joinable(e):
            continue
        sig = obj_sig(VERSION, store.files_sig(e), units_sig, MAIN_SHARE, TOP, store.auto_colours(e))
        out_dir = base / key
        files = [out_dir / "ac.json", out_dir / "pc.json"]
        old = prev.get(key)
        ok = old and old.get("sig") == sig and all(f.exists() for f in files)
        if ok:
            ss = [_series_from(d) for d in old["series"]]
            ok = all((DATA / "units" / "v" / s.id / "ac.json").exists() for s in ss)
        if ok:
            done[key] = old
            series += ss
            expected |= {f.resolve() for f in files}
            continue
        log(f"results: {key}")
        out_dir.mkdir(parents=True, exist_ok=True)
        built = build_election(store, e, units, out_dir)
        ms, main, blocs = map_series(e, built, units)
        for s, lv in ms:
            _write_unit_files(s.id, e["year"], lv, units, built["state"]["id"])
        done[key] = {"sig": sig, "series": [_series_dict(s) for s, _ in ms], "state": built["state"]["key"],
                     "states": [s["key"] for s in built["states"]], "state_name": built["state"]["name"], "main": main,
                     "blocs": blocs}
        series += [s for s, _ in ms]
        expected |= {f.resolve() for f in files}
    removed = 0
    for f in base.rglob("*") if base.exists() else []:
        if f.is_file() and f.resolve() not in expected:
            _rm(f)
            removed += 1
    for d in sorted((p for p in base.rglob("*") if p.is_dir()), reverse=True) if base.exists() else []:
        if not any(d.iterdir()):
            os.chmod(d, stat.S_IWRITE)
            d.rmdir()
    if removed:
        log(f"results: removed {removed} stale files")
    st["results"] = done
    if store.assigned:
        st["results_colours"] = store.assigned
    return series


def cached_series(cfg, st):
    """The map series of the last build (config-only rebuilds)."""
    if not cfg.get("results"):
        return []
    return [_series_from(d) for v in (st.get("results") or {}).values() for d in v["series"]]


def client_config(cfg, st):
    """config.json "results": the elections (joinable ones, with their files and series) and the coupling
    of the hexagon election datasets (by prefix) to a state and house."""
    spec = cfg.get("results")
    if not spec:
        return None
    store = Store(spec)
    done = st.get("results") or {}
    els, skipped, notes, levels = [], [], [], []
    for e in store.elections:
        if e["key"] not in done:
            if not store.joinable(e):
                skipped.append({"key": e["key"], "state": e["state"], "house": e["house"], "year": e["year"], "seat_map": e["seat_map"]})
            continue
        d = done[e["key"]]
        els.append({"key": e["key"], "state": d["state"], **({"states": d["states"]} if len(d.get("states") or []) > 1 else {}),
                    "state_name": d["state_name"], "house": e["house"], "year": e["year"],
                    "label": f"{HOUSE[e['house']]} {e['year']}", "seat_map": e["seat_map"], "gaps": e.get("gaps") or [],
                    "files": {"ac": f"results/{e['key']}/ac.json", "pc": f"results/{e['key']}/pc.json"},
                    "maps": [_compact(s, e["key"], notes, levels) for s in d["series"]]})
    els.sort(key=lambda x: (x["state"], x["house"], x["year"]))
    for x in els:   # the previous election of the same house in the state (for the change column)
        before = [y for y in els if y["state"] == x["state"] and y["house"] == x["house"] and y["year"] < x["year"]]
        x["prev"] = before[-1]["key"] if before else None
    prefixes = {}
    for ds in cfg["variables"]["datasets"].values():
        m = ds.get("menu") or []
        if ds.get("prefix") and len(m) == 3 and m[0] == "Elections" and ds.get("states"):
            house = {v: k for k, v in HOUSE.items()}.get(m[2])
            if house:
                prefixes[ds["prefix"]] = {"state": ds["states"][0], "house": house}
    return {"elections": els, "prefixes": prefixes, "not_joined": skipped, "notes": notes, "levels": levels}


# Fields of a results series that differ between series; everything else follows from its election
# (site/js/ui/results.js expandSeries rebuilds the full catalog entries).
DEFAULTS = {"format": "pct", "agg": "wmean", "dtype": "u8", "type": "numeric"}   # also in results.js
CAT_DEFAULTS = {"format": "cat", "agg": "lead", "dtype": "u8", "type": "categorical", "ramp": "cat"}
COMPACT = {"label": "l", "unit": "un", "ramp": "r", "format": "f", "agg": "a", "dtype": "dt", "type": "t", "breaks": "b"}


def _compact(d, key, notes, levels):
    out = {"s": d["id"][len(f"r_{key}_"):]}
    cat = d.get("type") == "categorical"
    for k, short in COMPACT.items():
        if d.get(k) not in (None, "", []) and d[k] != (CAT_DEFAULTS if cat else DEFAULTS).get(k):
            out[short] = d[k]
    if d.get("categories"):
        out["c"] = [[c["id"], c["label"], c["color"]] for c in d["categories"]]
    for val, table, short in ((d.get("note") or "", notes, "n"), (d.get("unit_levels"), levels, "lv")):
        if val not in table:
            table.append(val)
        out[short] = table.index(val)
    return out
