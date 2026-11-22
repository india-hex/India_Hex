"""Election layers in the booth-catchment delivery layout (bcexport schema 1.x), read by one generic adapter.

india_hex.yaml:
  bcexport:
    root: D:/booth_catchment                  results store at <root>/results; elections are DISCOVERED from
                                              <root>/results/elections.json: every one with layers_layout
                                              "bcexport" and has_hexes (folder `layers`), except
    exclude: [ka_ge2014]                      these keys (and seat maps without an India Hex key: AS_2023)
    overrides: {as_ae2016: {state_key: ASSAM}} per-election settings (optional)
    colours: {IUML: "#117733"}                party / bloc colour overrides (codes as in the files)

Booth layers (LAYOUT sections 4-7) are added to booths.sources automatically once an election's manifest says
they are present and the files are on disk (`booth_sources`).

Each election is read from its folder (`manifest.json`, `hex/<key>_h{6,7,8}.parquet`, codes in the parquet
key-value metadata `bcexport`) and from the results store (`results/<key>/units.parquet`, `candidates.parquet`,
`results/seatmaps/<MAP>_ac_pc.csv`). Elections of the same state and house form one dataset (id `<st>_<ae|ge>`,
series prefix `<st>_<ae|ge>_`), with the elections' years as series years.

Per dataset, a wide parquet per resolution is cached under .cache/bcexport/<dataset>/h{res}/ (rebuilt only when a
source file or this adapter changes), with the columns the existing dataset machinery reads unchanged:

  <party>_share_<Y>        party vote share, fraction (uint16 / 1000); kept (unfolded) parties only
  oth_share_<Y>            all other candidates incl. folded parties;  nota_share_<Y>  NOTA (not where the booth
                           files lack it: manifest gap `booth_nota_missing`)
  <bloc>_bloc_share_<Y>    bloc share, for blocs that are more than one party with its own column
  <a>_<b>_margin_pp_<Y>    signed two-way margin in percentage points (two largest blocs statewide, else parties)
  turnout_share_<Y>, votes_<Y>, electors_<Y>
  is_lead_<cat>_<Y>        0/1 from `lead_party` (a folded party's lead counts as `oth`)
  na_<Y>                   1 where the cell is NA (`na` true): every value of the cell is NULL, drawn grey

NULL stays NULL; cells absent from an election's file are absent (clear on the map). Unit values come from the
official results (never from the hexagons): an AC table per year with the same column names (AC rows; for Lok
Sabha elections these are EVM-only segment leads) and, for Lok Sabha, a PC table from the official PC rows.
ACs are grouped into PCs by the seat map (`pc_map`), not by India Hex's PC layer.
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from .config import ROOT
from .util import log

ADAPTER_VERSION = 4
CACHE = ROOT / ".cache" / "bcexport"
HOUSE = {"VS": ("ae", "Assembly"), "LS": ("ge", "Lok Sabha")}
RESOLUTIONS = (6, 7, 8)

# Coordinate-source wording (LAYOUT.md section 9, exact strings); `none` has no pin and is not a source credit
COORD_SOURCES = {
    "eci2017": "ECI polling-station locator (2017 scrape)",
    "susewind2014": "Susewind 2014 (ECI psleci), CC BY-NC-SA",
    "supplied": "np-supplied",
    "geo2026": "MH 2026 polling-station list, located",
    "neighbour_median": "modelled (neighbour median)",
}

# Election palette (colour-blind safe): the national pair is fixed, then the producer's known colours, then a
# categorical list (the same as the booth layers, bcexport/bl_bcpipe.py, so pins and hexagons agree)
ANCHORS = {"BJP": "#E69F00", "NDA": "#E69F00", "BJP_PLUS": "#E69F00", "INC": "#0072B2", "UPA": "#0072B2",
           "UDF": "#0072B2", "OTH": "#999999", "NOTA": "#666666"}
KNOWN = {"JD_S": "#009E73", "LDF": "#D55E00", "CPI_M": "#D55E00", "AAP": "#56B4E9", "SAD": "#882255",
         "BSP": "#332288", "AIUDF": "#117733", "SHS": "#F0E442", "NCP": "#44AA99"}
PALETTE = ["#CC79A7", "#AA4499", "#DDCC77", "#88CCEE", "#117733", "#44AA99", "#882255", "#332288", "#D55E00",
           "#56B4E9", "#F0E442", "#009E73", "#999933", "#661100"]
# sequential ramp for a share coloured like its party (scales.js RAMPS)
RAMP_OF = {"#E69F00": "oranges", "#0072B2": "blues", "#999999": "greys", "#666666": "greys", "#56B4E9": "ylgnbu",
           "#88CCEE": "ylgnbu", "#882255": "rdpu", "#CC79A7": "rdpu", "#332288": "purples", "#AA4499": "purples",
           "#661100": "ylorbr", "#F0E442": "ylorbr", "#DDCC77": "ylorbr", "#D55E00": "reds", "#009E73": "bugn",
           "#44AA99": "bugn", "#117733": "greens", "#999933": "ylgn"}
MARGIN_BREAKS = [-20, -10, -5, -2, 2, 5, 10, 20]


# ---------------------------------------------------------------------------------------------
# Reading one election
# ---------------------------------------------------------------------------------------------

def _sid(series):
    """bcpipe series id -> India Hex column stem: p_CPI_M -> cpi_m, b_BJP_PLUS -> bjp_plus."""
    return series[2:].lower()


def _file_stamp(p):
    s = Path(p).stat()
    return [str(p), s.st_size, s.st_mtime_ns]


class Election:
    """One election folder plus its official results."""

    def __init__(self, root, entry):
        e = entry if isinstance(entry, dict) else {"key": entry}
        self.key = e["key"]
        self.root = Path(root)
        self.st = self.key[:2].upper()
        self.dir = self.root / (e.get("layers") or f"{self.st}/outputs/maps/elections/{self.key}/")
        mpath = self.dir / "manifest.json"
        if not mpath.exists():
            raise FileNotFoundError(f"bcexport: {self.key}: no manifest at {mpath}")
        self.manifest = json.loads(mpath.read_text(encoding="utf-8"))
        m = self.manifest
        if not str(m.get("schema_version", "")).startswith("1."):
            raise ValueError(f"bcexport: {self.key}: schema {m.get('schema_version')} (adapter reads 1.x)")
        self.year, self.house, self.state_name = int(m["year"]), m["house"], m["state_name"]
        self.state_key = e.get("state_key") or self.state_name.upper()
        self.seat_map = m["seat_map"]
        self.hex_files = {r: self.dir / "hex" / f"{self.key}_h{r}.parquet" for r in RESOLUTIONS}
        for r, f in self.hex_files.items():
            if not f.exists():
                raise FileNotFoundError(f"bcexport: {self.key}: {f} missing (manifest parts.hex)")
        self.meta = json.loads(pq.read_schema(self.hex_files[8]).metadata[b"bcexport"])
        self.gaps = {g["kind"] for g in m.get("gaps", [])}
        self.results = self.root / "results" / self.key
        self.seatmap_csv = self.root / "results" / "seatmaps" / f"{self.seat_map}_ac_pc.csv"
        self.ihex_keys = self.root / "results" / "seatmaps" / f"{self.seat_map}_ihex_keys.csv"
        self.sha = {f["path"]: f["sha256"] for f in m.get("files", [])}

    # -- series of the election --------------------------------------------------------------
    @property
    def nota(self):
        """Publish hexagon NOTA? Not where the booth files lack it (MH VS2014): unit NOTA comes from results."""
        return "booth_nota_missing" not in self.gaps and any(p["series"] == "p_NOTA" for p in self.meta["party"])

    def parties(self):
        """[(stem, label, column)] of kept parties (own column), in statewide order; OTH and NOTA excluded."""
        return [(_sid(p["series"]), p["label"], p["column"]) for p in self.meta["party"]
                if not p["folded"] and p["series"] not in ("p_OTH", "p_NOTA")]

    def blocs(self):
        """[(stem, label, column, members)] of blocs worth their own series: more than one member, or a single
        member that is not a party with its own column."""
        own = {lab for _, lab, _ in self.parties()}
        out = []
        for b in self.meta.get("bloc") or []:
            if b["folded"] or b["series"] in ("b_OTH", "b_NOTA"):
                continue
            mem = b.get("members") or []
            if len(mem) == 1 and mem[0] in own:
                continue
            out.append((_sid(b["series"]), b["label"], b["column"], mem))
        return out

    def margin_pair(self):
        """(a, b, a_label, b_label, kind, a_col, b_col): the two largest blocs statewide (parties if there are no
        blocs), oriented so that a positive margin is the side not coloured blue (the buor ramp: blue low)."""
        bl = [b for b in self.meta.get("bloc") or [] if not b["folded"] and b["series"] not in ("b_OTH", "b_NOTA")]
        kind = "bloc" if len(bl) >= 2 else "party"
        pool = bl if kind == "bloc" else [p for p in self.meta["party"] if not p["folded"] and p["series"] not in ("p_OTH", "p_NOTA")]
        top = sorted(pool, key=lambda x: -x["statewide_share_pct"])[:2]
        if len(top) < 2:
            return None
        x, y = top
        if _colour_code(x["series"][2:]) == "#0072B2":
            x, y = y, x
        return _sid(x["series"]), _sid(y["series"]), x["label"], y["label"], kind, x["column"], y["column"]

    def lead_map(self):
        """{lead_party code: category stem}; folded parties and Others -> oth."""
        return {c["code"]: ("oth" if c["folded"] or c["series"] == "p_OTH" else _sid(c["series"]))
                for c in self.meta["codes"]["lead_party"]}

    def coord_credit(self):
        """Point sources of this election's booths, in the exact LAYOUT section 9 wording."""
        out = []
        for c in self.manifest.get("coordinate_sources") or []:
            if c["code"] == "none":
                continue
            out.append(COORD_SOURCES.get(c["code"], c.get("label") or c["code"]))
        return out

    def sources(self):
        """Stamp of every input of the cache: hex files (+ manifest sha256), results tables, seat map. The manifest
        itself is refreshed as booth layers land and is read for the configuration only, so it is not stamped."""
        files = list(self.hex_files.values()) + [self.results / "units.parquet",
                                                 self.results / "candidates.parquet", self.seatmap_csv]
        return [_file_stamp(f) + [self.sha.get(f.relative_to(self.dir).as_posix(), "") if self.dir in f.parents else ""]
                for f in files]




def _colour_code(code):
    return ANCHORS.get(code.upper()) or KNOWN.get(code.upper())


# ---------------------------------------------------------------------------------------------
# Wide hexagon tables (cache)
# ---------------------------------------------------------------------------------------------

def _hex_frame(el, res):
    """One election at one resolution as India Hex columns (suffix _<year>), indexed by h3_index."""
    t = pq.read_table(el.hex_files[res])
    cols = set(t.column_names)
    y = el.year
    num = lambda c: t.column(c).to_pandas().astype("float64").to_numpy()   # NULL -> NaN
    out = {}
    na = t.column("na").to_numpy(zero_copy_only=False).astype(bool)
    for stem, _, col in el.parties():
        out[f"{stem}_share_{y}"] = num(col) / 1000
    out[f"oth_share_{y}"] = num("share_p_OTH") / 1000
    if el.nota and "share_p_NOTA" in cols:
        out[f"nota_share_{y}"] = num("share_p_NOTA") / 1000
    for stem, _, col, _ in el.blocs():
        out[f"{stem}_bloc_share_{y}"] = num(col) / 1000
    mp = el.margin_pair()
    if mp:
        a, b, _, _, _, ca, cb = mp
        out[f"{a}_{b}_margin_pp_{y}"] = (num(ca) - num(cb)) / 10     # 0.1 pp units -> pp; NULL stays NULL
    out[f"turnout_share_{y}"] = num("turnout") / 1000
    out[f"votes_{y}"] = num("votes")
    out[f"electors_{y}"] = num("electors")
    lead = num("lead_party")
    lm = el.lead_map()
    cats = _year_categories(el)
    lut = np.full(256, -1.0)
    for code, c in lm.items():
        if c in cats:              # a party that leads no cell and wins no seat has no category
            lut[code] = cats.index(c)
    idx = np.where(np.isfinite(lead), lut[np.nan_to_num(lead, nan=0).astype(int)], np.nan)
    if np.any(idx < 0):
        raise ValueError(f"bcexport: {el.key} h{res}: lead code outside the code table")
    for i, c in enumerate(cats):
        out[f"is_lead_{c}_{y}"] = np.where(np.isnan(idx), np.nan, (idx == i).astype("float64"))
    cat = idx
    out[f"na_{y}"] = na.astype("float64")
    df = pd.DataFrame(out, index=pd.Index(t.column("h3_index").to_numpy(zero_copy_only=False), name="h3_index"))
    # an NA cell carries no value (LAYOUT 3.3); check rather than trust
    vals = df.drop(columns=[f"na_{y}"])
    if vals[na].notna().any().any():
        raise ValueError(f"bcexport: {el.key} h{res}: NA cells carry values")
    return df, cat


_CAT_CACHE = {}


def _year_categories(el):
    """Lead categories of one election: parties leading some cell at any resolution, the official AC (and PC)
    winners, in statewide order, `oth` last."""
    if el.key in _CAT_CACHE:
        return _CAT_CACHE[el.key]
    lm = el.lead_map()
    present = set()
    for r in RESOLUTIONS:
        codes = pq.read_table(el.hex_files[r], columns=["lead_party"]).column("lead_party").drop_null()
        present |= {lm[int(c)] for c in pa.compute.unique(codes).to_pylist()}
    units = pd.read_parquet(el.results / "units.parquet")
    own = {lab: stem for stem, lab, _ in el.parties()}
    present |= {own.get(w, "oth") for w in units.winner_party.dropna()}
    order = [stem for stem, _, _ in el.parties()] + ["oth"]
    cats = [c for c in order if c in present]
    _CAT_CACHE[el.key] = cats
    return cats


# ---------------------------------------------------------------------------------------------
# Official unit tables (cache)
# ---------------------------------------------------------------------------------------------

def _official(el, level):
    """Official rows of one level (ac | pc) with the hexagon column names, from units + candidates."""
    y = el.year
    u = pd.read_parquet(el.results / "units.parquet")
    c = pd.read_parquet(el.results / "candidates.parquet")
    u, c = u[u.level == level].copy(), c[c.level == level]
    key = "ac_no" if level == "ac" else "pc_no"
    u[key] = u.unit_no.astype(int)
    u = u.set_index(key).sort_index()
    tv = u.total_valid.astype("float64")
    votes_by = lambda col, val: c[c[col] == val].groupby("unit_no").votes.sum().reindex(u.index).fillna(0).astype(float)
    out = pd.DataFrame(index=u.index)
    if level == "ac":
        sm = pd.read_csv(el.seatmap_csv)
        pc_of = dict(zip(sm.ac_no.astype(int), sm.pc_no.astype(int)))
        out["pc_no"] = [pc_of[a] for a in u.index]
        bad = [a for a, p in zip(u.index, u.pc_no) if pd.notna(p) and pc_of[a] != int(p)]
        if bad:
            raise ValueError(f"bcexport: {el.key}: results pc_no disagrees with {el.seatmap_csv.name} for ACs {bad}")
    kept = 0
    for stem, lab, _ in el.parties():
        v = votes_by("party", lab)
        kept = kept + v
        out[f"{stem}_share_{y}"] = v / tv
    nota = u.nota.astype("float64")
    out[f"oth_share_{y}"] = (tv - nota - kept) / tv
    out[f"nota_share_{y}"] = nota / tv
    bv = {}
    for b in el.meta.get("bloc") or []:
        if b["series"] not in ("b_OTH", "b_NOTA"):
            bv[_sid(b["series"])] = votes_by("bloc", b["label"])
    for stem, _, _, _ in el.blocs():
        out[f"{stem}_bloc_share_{y}"] = bv[stem] / tv
    mp = el.margin_pair()
    if mp:
        a, b, la, lb, kind, _, _ = mp
        va, vb = (bv[a], bv[b]) if kind == "bloc" else (votes_by("party", la), votes_by("party", lb))
        out[f"{a}_{b}_margin_pp_{y}"] = (va - vb) / tv * 100
    out[f"turnout_share_{y}"] = u.turnout_pct.astype("float64") / 100
    out[f"votes_{y}"] = tv
    out[f"electors_{y}"] = u.electors.astype("float64")
    own = {lab: stem for stem, lab, _ in el.parties()}
    out[f"lead_bucket_{y}"] = [own.get(w, "oth") if pd.notna(w) else None for w in u.winner_party]
    out[f"winner_party_{y}"] = u.winner_party.astype(object)
    out[f"complete_{y}"] = u.complete.astype(bool)
    return out.reset_index()


# ---------------------------------------------------------------------------------------------
# Datasets
# ---------------------------------------------------------------------------------------------

class Dataset:
    """Elections of one state and house: one India Hex dataset, years as series years."""

    def __init__(self, dsid, elections, settings):
        self.id, self.els = dsid, sorted(elections, key=lambda e: e.year)
        self.settings = settings
        e0 = self.els[0]
        self.st, self.house, self.state_name, self.state_key = e0.st, e0.house, e0.state_name, e0.state_key
        if len({e.year for e in self.els}) != len(self.els):
            raise ValueError(f"bcexport: {dsid}: two elections in the same year")
        self.dir = CACHE / dsid
        self.years = [e.year for e in self.els]

    def file(self, res):
        return self.dir / f"h{res}" / f"h{res}_{self.id}.parquet"

    def ac_table(self, year="{year}"):
        return self.dir / "units" / f"{self.id}_ac_{year}.parquet"

    def pc_table(self, year="{year}"):
        return self.dir / "units" / f"{self.id}_pc_{year}.parquet"

    def stamp(self):
        return {"version": ADAPTER_VERSION, "elections": {e.key: e.sources() for e in self.els}}

    def ensure(self):
        """Write the cache when a source (or this adapter) changed; return the cache metadata."""
        sp, mp = self.dir / "stamp.json", self.dir / "meta.json"
        stamp = self.stamp()
        outs = [self.file(r) for r in RESOLUTIONS] + [self.ac_table(y) for y in self.years] + \
               ([self.pc_table(y) for y in self.years] if self.house == "LS" else []) + [mp]
        try:
            if json.loads(sp.read_text()) == stamp and all(p.exists() for p in outs):
                return json.loads(mp.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pass
        log(f"bcexport: {self.id}: converting {', '.join(e.key for e in self.els)}")
        meta = {"cells": {}, "outside": {}, "na": {}, "folded_lead_cells": {}}
        for r in RESOLUTIONS:
            frames = []
            for e in self.els:
                df, _ = _hex_frame(e, r)
                frames.append(df)
                folded = {c["code"] for c in e.meta["codes"]["lead_party"] if c["folded"]}
                lead = pq.read_table(e.hex_files[r], columns=["lead_party"]).column("lead_party").to_pandas()
                meta["folded_lead_cells"].setdefault(str(e.year), {})[str(r)] = int(lead.isin(folded).sum())
                meta["na"].setdefault(str(e.year), {})[str(r)] = int(df[f"na_{e.year}"].sum())
                meta["cells"].setdefault(str(e.year), {})[str(r)] = len(df)
            wide = pd.concat(frames, axis=1, join="outer").sort_index()
            wide.index.name = "h3_index"
            self.file(r).parent.mkdir(parents=True, exist_ok=True)
            _write(wide.reset_index(), self.file(r))
        (self.dir / "units").mkdir(parents=True, exist_ok=True)
        for e in self.els:
            _write(_official(e, "ac"), self.ac_table(e.year))
            if self.house == "LS":
                _write(_official(e, "pc"), self.pc_table(e.year))
        meta["categories"] = {str(e.year): _year_categories(e) for e in self.els}
        mp.write_text(json.dumps(meta, indent=1), encoding="utf-8")
        sp.write_text(json.dumps(stamp))
        return meta

    # -- configuration -----------------------------------------------------------------------
    def colours(self, kind="p"):
        """{code (upper, as in the files): colour} for parties (kind p) or blocs (b), distinct within the kind."""
        over = {k.upper(): v for k, v in (self.settings.get("colours") or {}).items()}
        try:
            pj = json.loads((self.els[0].root / "results" / "parties.json").read_text(encoding="utf-8"))
        except OSError:
            pj = {"parties": {}, "blocs": {}}
        key = "party" if kind == "p" else "bloc"
        codes, label = [], {}
        for e in self.els:
            for x in e.meta.get(key) or []:
                codes.append(x["series"][2:])
                label[x["series"][2:]] = x["label"]
        codes = list(dict.fromkeys(codes))
        out = {c: ANCHORS[c] for c in codes if c in ANCHORS}
        out.update({c: over[c] for c in codes if c in over and c not in ANCHORS})
        used = set(out.values()) - {"#999999", "#666666"}
        for c in codes:
            if c in out:
                continue
            pjc = (pj["parties"].get(label.get(c, c)) or {}).get("colour") if kind == "p" else                 next((b.get("colour") for e in self.els for k, b in (pj["blocs"].get(e.key) or {}).items() if k == label.get(c, c)), None)
            for cand in [pjc, KNOWN.get(c)] + PALETTE:
                if cand and cand not in used and cand != "#888888":
                    out[c] = cand
                    used.add(cand)
                    break
        return out

    def config(self, meta):
        """(dataset entry, {series id: override}) in india_hex.yaml terms."""
        hl = HOUSE[self.house][1]
        pre = f"{self.id}_"
        col, bcol = self.colours("p"), self.colours("b")
        ls = self.house == "LS"
        yrs = ", ".join(map(str, self.years))
        ramp = lambda c: RAMP_OF.get(c, "greys")
        # lead categories over every year, in first-seen order (statewide order per year), oth last
        cat_order, labels = [], {}
        for e in self.els:
            for stem, lab, _ in e.parties():
                labels.setdefault(stem, lab)
            for c in meta["categories"][str(e.year)]:
                if c not in cat_order:
                    cat_order.append(c)
        cat_order = [c for c in cat_order if c != "oth"] + (["oth"] if "oth" in cat_order else [])
        code_of = {stem: e_p["series"][2:] for e in self.els for e_p in e.meta["party"] for stem in [_sid(e_p["series"])]}
        cats = {c: {"label": "Others" if c == "oth" else labels.get(c, c.upper()), "color": col.get(code_of.get(c, c.upper()), "#999999")}
                for c in cat_order}
        folded = {y: v.get("8", 0) for y, v in meta.get("folded_lead_cells", {}).items() if v.get("8")}
        lead_note = "The party with the most votes in the cell, not a seat winner; Others: all other candidates combined."
        if folded:
            names = sorted({c["label"] for e in self.els for c in e.meta["codes"]["lead_party"] if c["folded"]})
            lead_note += (f" Parties under 1% of the state's votes ({', '.join(names)}) count as Others: they lead "
                          + "; ".join(f"{n:,} H8 cells in {y}" for y, n in folded.items()) + ".")
        credit = list(dict.fromkeys(s for e in self.els for s in e.coord_credit()))
        caveat = ("Modelled from booth results spread over where voters live. Shares of votes polled incl. NOTA, EVM + "
                  "postal" + (" (split over a PC's segments by electors)" if ls else "")
                  + ". Grey: NA, over half the cell's electors in ACs with incomplete or spread booth data."
                  + "".join(f" No hexagon NOTA in {e.year} (booth files lack it)." for e in self.els if not e.nota)
                  + (f" Booth locations: {'; '.join(credit)}." if credit else ""))
        unit_note = ("Unit values are the official ECI results; hexagons are modelled."
                     + (" AC values are assembly-segment leads (EVM votes only); PC and state values include postal votes."
                        if ls else " PCs combine their ACs by the delimitation seat map."))
        seat_maps = {e.seat_map for e in self.els}
        pc_map = str(self.els[0].seatmap_csv) if len(seat_maps) == 1 else str(self.ac_table())
        units_table = {"path": str(self.ac_table()), "state": self.state_key, "key": "ac_no",
                       "lead": {"column": "lead_bucket_{year}", "share": "{cat}_share_{year}"},
                       "pc_map": pc_map, "fallback": False}
        if ls:
            units_table["pc_table"] = {"path": str(self.pc_table()), "key": "pc_no"}
        ds = {
            "shard": f"data-{self.st.lower()}", "root": str(self.dir), "file": f"h{{res}}_{self.id}.parquet",
            "group": f"{self.state_name} {hl} ({yrs})", "menu": ["Elections", self.state_name, hl], "prefix": pre,
            "states": [self.state_key], "sparse": True, "h8": "all", "exclude": ["na", "is_lead_*"], "na_cells": "na_{year}",
            "units_table": units_table,
            "lead": {"from": "is_lead_", "label": "Leading party", "note": lead_note, "categories": cats},
            "caveat": caveat, "na_label": "NA: incomplete or spread booth data",
        }
        share = lambda label, rmp, note, featured=True: {"label": label, "format": "pct", "agg": "wmean", "weight": "votes_{year}",
                                                          "ramp": rmp, "featured": featured, "note": note}
        ov = {}
        try:
            pj_blocs = json.loads((self.els[0].root / "results" / "parties.json").read_text(encoding="utf-8"))["blocs"]
        except (OSError, KeyError, ValueError):
            pj_blocs = {}
        bloc_years = {}   # series id -> [(year, full label)]
        for e in self.els:
            for stem, lab, _ in e.parties():
                ov.setdefault(f"{pre}{stem}_share", share(f"{lab} vote share", ramp(col.get(code_of.get(stem, ""), "")), unit_note))
            for stem, lab, _, mem in e.blocs():
                full = ((pj_blocs.get(e.key) or {}).get(lab) or {}).get("label") or f"{lab} ({', '.join(mem)})"
                sid = f"{pre}{stem}_bloc_share"
                ov.setdefault(sid, share(f"{full.split(' (')[0].replace('_PLUS', '+')} vote share", ramp(bcol.get(stem.upper(), "")), unit_note))
                bloc_years.setdefault(sid, []).append((e.year, full))
            mp = e.margin_pair()
            if mp:
                a, b, la, lb, kind, _, _ = mp
                la, lb = (x.replace("_PLUS", "+") for x in (la, lb))
                ov.setdefault(f"{pre}{a}_{b}_margin_pp", {
                    "label": f"Margin, {la} − {lb}", "unit": "pp", "format": "pp", "agg": "wmean", "weight": "votes_{year}",
                    "density": False, "ramp": "buor", "diverging": True, "breaks": MARGIN_BREAKS, "featured": True,
                    "note": f"Percentage points of votes polled; positive = {la} ahead, negative = {lb} ahead"
                            f" ({'blocs' if kind == 'bloc' else 'parties'}: the two largest statewide). {unit_note}"})
        for sid, yl in bloc_years.items():
            ov[sid]["note"] = ("Alliance: " + "; ".join(f + (f" in {y}" if len(self.years) > 1 else "") for y, f in yl)
                               + ". " + unit_note)
        ov[f"{pre}oth_share"] = share("Others vote share", "greys",
                                      "All other candidates (independents and parties without their own series, incl. "
                                      "parties under 1% of the state's votes); NOTA is separate. " + unit_note, featured=False)
        if any(e.nota for e in self.els):
            ov[f"{pre}nota_share"] = share("NOTA share", "greys", unit_note, featured=False)
        ov[f"{pre}turnout_share"] = {"label": "Turnout (votes polled / electors)", "format": "pct", "agg": "wmean",
                                     "weight": "electors_{year}", "ramp": "viridis",
                                     "note": "Hexagon electors are modelled from votes (booth electors scaled to the AC's "
                                             "official electors), so hexagon turnout follows the AC's. " + unit_note}
        ov[f"{pre}votes"] = {"label": "Votes polled", "unit": "votes", "format": "int", "agg": "sum", "ramp": "ylorrd",
                             "note": "Valid votes incl. NOTA, EVM + postal. " + unit_note}
        ov[f"{pre}electors"] = {"label": "Electors", "unit": "electors", "format": "int", "agg": "sum", "ramp": "ylorrd",
                                "note": "Hexagon electors are modelled; unit values are the official ECI electors"}
        ov[f"{pre}lead"] = {"featured": True}
        return ds, ov


def _write(df, path):
    """Write only when the bytes change, so an unchanged table keeps its mtime (and the build skips it)."""
    tmp = path.with_suffix(".tmp")
    df.to_parquet(tmp, index=False, compression="zstd")
    if path.exists() and path.read_bytes() == tmp.read_bytes():
        tmp.unlink()
        return
    tmp.replace(path)


# ---------------------------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------------------------

_MEMO = {}


# seat maps without an India Hex key (BOOTH_EXPORT_RESULT section 5): joining them by number would misplace votes
NO_IHEX_KEY = {"AS_2023"}


def discover(b):
    """Election entries to read: every election of results/elections.json with layers_layout "bcexport" and
    has_hexes, except `exclude` keys and seat maps India Hex has no key for. `overrides: {key: {...}}` adds
    per-election settings (e.g. state_key). Returns ([entry], [(key, reason skipped)])."""
    root = Path(b["root"])
    listed = json.loads((root / "results" / "elections.json").read_text(encoding="utf-8"))
    excl, over = set(b.get("exclude") or []), b.get("overrides") or {}
    out, skipped = [], []
    for e in listed:
        if e.get("layers_layout") != "bcexport":
            continue                                   # legacy (KA/BR wide layout) stays on its own datasets
        k = e["key"]
        why = ("excluded in india_hex.yaml" if k in excl else "no hexagons yet" if not e.get("has_hexes")
               else f"seat map {e.get('seat_map')} has no India Hex key" if e.get("seat_map") in NO_IHEX_KEY else None)
        if why:
            skipped.append((k, why))
            continue
        out.append({"key": k, "layers": e.get("layers"), **(over.get(k) or {})})
    return out, skipped


def datasets(cfg):
    """[Dataset] for india_hex.yaml `bcexport`, grouped by state and house (cached per process)."""
    b = cfg.get("bcexport")
    if not b or not b.get("root"):
        return []
    key = json.dumps(b, sort_keys=True, default=str)
    if key not in _MEMO:
        entries, skipped = discover(b)
        for k, why in skipped:
            log(f"bcexport: {k} skipped ({why})")
        groups = {}
        for entry in entries:
            el = Election(b["root"], entry)
            groups.setdefault(f"{el.st.lower()}_{HOUSE[el.house][0]}", []).append(el)
        _MEMO[key] = [Dataset(dsid, els, b) for dsid, els in sorted(groups.items())]
    return _MEMO[key]


_WARNED = set()
BOOTH_FILES = ("booths/{key}_booth_layers.json", "booths/{key}_booths.pmtiles", "booths/{key}_catchments.pmtiles",
               "booths/{key}_catchments.parquet")


def booth_sources(cfg):
    """booths.sources entries for elections whose booth layers have landed (LAYOUT sections 4-7): manifest
    parts booths + details present and every file the site copies on disk. Others are left out until then."""
    out = []
    for d in datasets(cfg):
        for e in d.els:
            parts = e.manifest.get("parts") or {}
            files = [e.dir / f.format(key=e.key) for f in BOOTH_FILES]
            if (parts.get("booths") or {}).get("present") and (parts.get("details") or {}).get("present") \
                    and all(f.exists() for f in files):
                out.append({"path": str(e.dir), "layout": "bcexport", "key": e.key, "shard": f"data-{e.st.lower()}"})
            elif (parts.get("booths") or {}).get("present") and e.key not in _WARNED:
                _WARNED.add(e.key)
                log(f"bcexport: {e.key}: booth layers incomplete on disk (still building?); not published yet")
    return out


def expand(cfg):
    """({dataset id: entry}, {series id: override}) for every configured election; writes the cache if stale."""
    ds_out, ov_out = {}, {}
    known_prefixes = {v.get("prefix") for v in (cfg["variables"].get("datasets") or {}).values() if v.get("prefix")}
    for d in datasets(cfg):
        if d.id in (cfg["variables"].get("datasets") or {}):
            raise ValueError(f"bcexport: dataset id {d.id} is also in variables.datasets")
        if f"{d.id}_" in known_prefixes:
            raise ValueError(f"bcexport: prefix {d.id}_ is already used by a dataset in variables.datasets")
        meta = d.ensure()
        ds, ov = d.config(meta)
        ds_out[d.id] = ds
        ov_out.update(ov)
    return ds_out, ov_out
