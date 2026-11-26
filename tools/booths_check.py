"""Acceptance checks for the booth layers (BOOTHS brief §8: data fidelity and booth counts).

  tiles     every pin and catchment piece of every election decodes from the published PMTiles: unique
            uids = the parquet rows; 200 random booths: tile fields and detail rows equal the parquet,
            and the pin lies within 15 m of the booth point
  locs      every pin's location has a catchment, except booths at locations without votes (and pins in ACs
            whose catchments the producer withholds); ties and no-vote booths carry lead_code 9 / no lead_code
  counts    booth-count hexagons sum to the pins at H6/H7/H8; AC values = booths_YYYY (empty where the
            booth data is incomplete); PC / district / state = sums of their other ACs, with the count of
            ACs left out

Elections in the booth-catchment delivery layout (`layout: bcexport`, LAYOUT.md sections 4-7) get, on top:
  tiles     every occurrence of every pin and piece in every tile: attributes = exactly the parquet values of
            the fields `layers.<layer>.tile_fields` lists (absent where NULL; no other attribute, so share fields
            dropped by the size-level ladder must be absent; `parties[]/blocs[].in_tiles` agree), bloc_lead_code
            included; every pin within 15 m of its booth point
  leads     lead_code / bloc_lead_code (and lead / bloc_lead) of every booth and piece recomputed from the vote
            columns: the largest series, 9 where the top two are equal, NULL where votes = 0
  details   every AC file: the published file = the source file plus the build's area_fields / areas, byte for
            byte; every booth row (uid, booth, loc, votes, every party and bloc, method, source, flags,
            relocated) and location row (sums of its booths, booth numbers, point) = the parquet; booth rows +
            unlocated = the AC's booth counts
  files     booths.pmtiles, catchments.pmtiles and split/ byte-identical to the source; nothing else published
  counts    `<prefix>booths`: every published cell = the election's counts/h{R} file (NA cells included), sum +
            pins outside the site index = pins; AC / located / unlocated = counts/units; PC (seat map) /
            district / state = sums of their ACs, with the ACs left out; AC sums + NA ACs' rows = all booths
python tools/booths_check.py [election ...] [counts]    (run in the site folder after a build; no argument: everything)
  An election id runs its tile checks (and, for a bcexport election, its counts); `counts` runs the counts of
  the KA/BR datasets (and of every bcexport election when no election id is given).

Reads PMTiles v3 and Mapbox Vector Tiles with the small decoder below (no extra packages).
"""
import gzip
import json
import math
import random
import struct
import sys
from collections import defaultdict
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from pipeline import bcexport  # noqa: E402
from pipeline.booths import _BCEXPORT, _areas, elections  # noqa: E402
from pipeline.build import _decode_index  # noqa: E402
from pipeline.config import DATA, data_dir, find_data, load_config  # noqa: E402
from pipeline.hexes import decode  # noqa: E402
from pipeline.official import ac_district  # noqa: E402

cfg = load_config()
UNITS = json.loads((DATA / "units.json").read_text(encoding="utf-8"))
CC = json.loads((ROOT / "site" / "config.json").read_text(encoding="utf-8"))
CC_EL = {e["id"]: e for e in (CC.get("booths") or {}).get("elections") or []}
fails = []
TILES = {}
ORDERS = {}
CTX = ["-"]                    # what the checks are about now: (part, election id)
FAILS_BY = defaultdict(list)   # (part, election id) -> failure messages
SKIPPED = {}                   # election id -> why it was not checked


def check(ok, msg):
    if not ok:
        fails.append(msg)
        FAILS_BY[CTX[0]].append(msg)
        print("  FAIL", msg)
    return ok


# ---- PMTiles v3 ------------------------------------------------------------------------------------
def _varint(b, i):
    r = s = 0
    while True:
        x = b[i]; i += 1
        r |= (x & 0x7F) << s
        if x < 0x80:
            return r, i
        s += 7


def _dir(b):
    n, i = _varint(b, 0)
    ids, runs, lens, offs = [], [], [], []
    last = 0
    for _ in range(n):
        d, i = _varint(b, i); last += d; ids.append(last)
    for _ in range(n):
        x, i = _varint(b, i); runs.append(x)
    for _ in range(n):
        x, i = _varint(b, i); lens.append(x)
    for k in range(n):
        x, i = _varint(b, i)
        offs.append(offs[k - 1] + lens[k - 1] if x == 0 and k > 0 else x - 1)
    return list(zip(ids, offs, lens, runs))


def _zxy(tid):
    acc = 0
    for z in range(32):
        n = 4 ** z
        if acc + n > tid:
            pos = tid - acc
            x = y = 0
            s = 1
            t = pos
            while s < 2 ** z:   # Hilbert d -> (x, y)
                rx = 1 & (t // 2)
                ry = 1 & (t ^ rx)
                if ry == 0:
                    if rx == 1:
                        x, y = s - 1 - x, s - 1 - y
                    x, y = y, x
                x += s * rx; y += s * ry
                t //= 4; s *= 2
            return z, x, y
        acc += n


def pmtiles_tiles(path):
    """[(z, x, y, raw tile bytes, stored (compressed) length)] of every tile in a PMTiles v3 file."""
    data = Path(path).read_bytes()
    assert data[:7] == b"PMTiles" and data[7] == 3, "not PMTiles v3"
    (root_off, root_len, _mo, _ml, leaf_off, _ll, tile_off, _tl, _a, _e, _c) = struct.unpack_from("<11Q", data, 8)
    icomp, tcomp = data[97], data[98]
    unz = lambda b, c: gzip.decompress(b) if c == 2 else b
    out = []

    def walk(off, length):
        for tid, o, ln, run in _dir(unz(data[off:off + length], icomp)):
            if run == 0:
                walk(leaf_off + o, ln)
            else:
                raw = unz(data[tile_off + o:tile_off + o + ln], tcomp)
                for r in range(run):
                    out.append((*_zxy(tid + r), raw, ln))
    walk(root_off, root_len)
    return out


# ---- Mapbox Vector Tile (protobuf) -----------------------------------------------------------------
def _fields(b):
    i = 0
    while i < len(b):
        key, i = _varint(b, i)
        f, wt = key >> 3, key & 7
        if wt == 0:
            v, i = _varint(b, i)
        elif wt == 2:
            ln, i = _varint(b, i); v = b[i:i + ln]; i += ln
        elif wt == 5:
            v = b[i:i + 4]; i += 4
        elif wt == 1:
            v = b[i:i + 8]; i += 8
        else:
            raise ValueError(f"wire type {wt}")
        yield f, wt, v


def _packed(b):
    out, i = [], 0
    while i < len(b):
        v, i = _varint(b, i); out.append(v)
    return out


def _value(b):
    for f, wt, v in _fields(b):
        if f == 1: return v.decode()
        if f == 2: return struct.unpack("<f", v)[0]
        if f == 3: return struct.unpack("<d", v)[0]
        if f == 4: return v if v < 2 ** 63 else v - 2 ** 64
        if f == 5: return v
        if f == 6: return (v >> 1) ^ -(v & 1)
        if f == 7: return bool(v)


def mvt_features(raw, layer):
    """[(id, properties, first point (x, y) in tile units, extent)] of one layer of a tile."""
    out = []
    for f, wt, lb in _fields(raw):
        if f != 3:
            continue
        name, feats, keys, vals, extent = None, [], [], [], 4096
        for g, _wt, v in _fields(lb):
            if g == 1: name = v.decode()
            elif g == 2: feats.append(v)
            elif g == 3: keys.append(v.decode())
            elif g == 4: vals.append(_value(v))
            elif g == 5: extent = v
        if name != layer:
            continue
        for fb in feats:
            fid, tags, geom = None, [], []
            for g, _wt, v in _fields(fb):
                if g == 1: fid = v
                elif g == 2: tags = _packed(v)
                elif g == 4: geom = _packed(v)
            props = {keys[tags[k]]: vals[tags[k + 1]] for k in range(0, len(tags), 2)}
            pt = None
            if len(geom) >= 3 and (geom[0] & 7) == 1:
                zz = lambda n: (n >> 1) ^ -(n & 1)
                pt = (zz(geom[1]), zz(geom[2]))
            out.append((fid, props, pt, extent))
    return out


def tile_lonlat(z, x, y, px, py, extent):
    n = 2 ** z
    lon = (x + px / extent) / n * 360 - 180
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + py / extent) / n))))
    return lon, lat


# ---- checks ----------------------------------------------------------------------------------------
def tile_checks(el, src, meta, bc=None, shard=None):
    """bc: the election folder of a bcexport election (None: legacy KA/BR layout)."""
    d = find_data(f"booths/{el}")
    print(f"== {el}")
    pins, catch = {}, {}
    occ = {"booths": [], "catchments": []}   # bcexport: every (uid, attributes) in every tile
    maxtile = maxraw = 0
    for kind, store in (("booths", pins), ("catchments", catch)):
        for z, x, y, raw, stored in pmtiles_tiles(d / f"{kind}.pmtiles"):
            maxtile, maxraw = max(maxtile, stored), max(maxraw, len(raw))
            check(z == 10, f"{el} {kind}: tile at z{z}")
            for fid, props, pt, ext in mvt_features(raw, kind):
                check(fid == props.get("uid"), f"{el} {kind}: MVT id {fid} != uid {props.get('uid')}")
                if bc:
                    occ[kind].append((fid, props))
                if fid not in store and pt is not None:
                    store[fid] = (props, tile_lonlat(z, x, y, pt[0], pt[1], ext))
                elif fid not in store:
                    store[fid] = (props, None)
    bp = duckdb.sql(f"SELECT *, ST_X(geometry) AS lon, ST_Y(geometry) AS lat FROM '{src / f'{el}_booths.parquet'}'").df()
    if bc:   # every field: the tile attributes are compared with all of them
        cp = duckdb.sql(f"SELECT * EXCLUDE (geometry) FROM '{src / f'{el}_catchments.parquet'}'").df()
    else:
        cp = duckdb.sql(f"SELECT uid, loc_id, ac_no, pop, lead_code, votes FROM '{src / f'{el}_catchments.parquet'}'").df()
    check(len(pins) == len(bp), f"{el}: {len(pins)} pins in the tiles, {len(bp)} booth rows")
    check(len(catch) == len(cp), f"{el}: {len(catch)} catchment pieces in the tiles, {len(cp)} rows")
    check(set(pins) == set(bp.uid), f"{el}: pin uids differ from the parquet")
    check(set(catch) == set(cp.uid), f"{el}: catchment uids differ from the parquet")
    print(f"   pins {len(pins):,} = parquet {len(bp):,}; catchment pieces {len(catch):,} = {len(cp):,}; largest tile {maxtile / 1e3:.0f} KB transferred ({maxraw / 1e3:.0f} KB unzipped)")
    TILES[el] = maxtile
    # 200 random booths: tile fields, detail rows and position
    rng = random.Random(7)
    rows = bp.sample(min(200, len(bp)), random_state=rng.randrange(10 ** 6))
    tf = {f["name"] for f in meta["layers"]["booths"]["tile_fields"]} if bc else None
    # bcexport: only the share fields the tiles carry at the layer's size level (the others are in the details)
    pm = [c for c in bp.columns if c.endswith("_pm") and (tf is None or c in tf)]
    dets = {}
    bad = 0
    for _, r in rows.iterrows():
        props, ll = pins[int(r.uid)]
        want = {"loc": int(r.loc_id), "ac_no": int(r.ac_no), "n_booths": int(r.n_booths)}
        want.update({c: int(r[c]) for c in pm if pd.notna(r[c])})
        if pd.notna(r.lead_code):
            want["lead_code"] = int(r.lead_code)
        if bc and "bloc_lead_code" in tf and pd.notna(r.get("bloc_lead_code")):
            want["bloc_lead_code"] = int(r.bloc_lead_code)
        got = {k: props.get(k) for k in want}
        if got != want or (pd.isna(r.lead_code) and "lead_code" in props):
            bad += 1
            print("   tile mismatch", int(r.uid), {k: (got[k], want[k]) for k in want if got[k] != want[k]})
        dist = math.hypot((ll[0] - r.lon) * 111320 * math.cos(math.radians(r.lat)), (ll[1] - r.lat) * 110540)
        if dist > 15:
            bad += 1
            print(f"   pin {int(r.uid)} {dist:.1f} m from the booth point")
        ac = int(r.ac_no)
        if ac not in dets:
            dets[ac] = json.loads((d / f"ac_{ac:03d}.json").read_text(encoding="utf-8"))
        dj = dets[ac]
        row = dict(zip(dj["booth_fields"], next(x for x in dj["booths"] if x[0] == int(r.uid))))
        if bc:   # every vote column of the detail rows: votes, each party, each bloc
            parties = [c for c in dj["booth_fields"] if c not in NOT_VOTES and c != "votes"]
        else:
            parties = [c for c in ("bjp", "inc", "jds", "oth", "nda", "mgb", "jsp", "others", "nota") if c in row]
        for c in ["votes", *parties]:
            if bc:
                pq_v = r[c] if c in r else "absent"
                if not isinstance(pq_v, str) and (pd.isna(pq_v) != (row[c] is None) or (pd.notna(pq_v) and row[c] != int(pq_v))) \
                        or isinstance(pq_v, str):
                    bad += 1
                    print(f"   detail {int(r.uid)} {c}: {row[c]} != {pq_v}")
            elif c in r and pd.notna(r[c]) and row[c] != int(r[c]):
                bad += 1
                print(f"   detail {int(r.uid)} {c}: {row[c]} != {r[c]}")
        if bc and (row["loc"] != int(r.loc_id) or str(row["booth"]) != str(r.booth_id)):
            bad += 1
            print(f"   detail {int(r.uid)} loc / booth: {row['loc']} {row['booth']} != {int(r.loc_id)} {r.booth_id}")
    check(bad == 0, f"{el}: {bad} mismatches in 200 random booths")
    # every pin's location has a catchment, except booths at locations without votes and pins in ACs whose
    # catchments the producer withholds (bcexport: spread / unpublishable ACs, decision P4)
    wh = meta.get("catchments_withheld") or {}
    withheld = set(wh.get("spread_acs") or []) | set(wh.get("excluded_acs") or [])
    locs_with_catch = set(cp.loc_id)
    loc_votes = bp.groupby("loc_id").votes.sum()
    no_catch = bp[~bp.loc_id.isin(locs_with_catch)]
    in_withheld = no_catch.ac_no.isin(withheld) if "ac_no" in no_catch else pd.Series(False, index=no_catch.index)
    check(not len(withheld) or set(cp.ac_no) .isdisjoint(withheld), f"{el}: catchments published in withheld ACs")
    rest = no_catch[~in_withheld]
    check((loc_votes.loc[rest.loc_id.unique()] == 0).all() if len(rest) else True, f"{el}: pins without a catchment at locations with votes")
    if len(withheld):
        print(f"   pins in withheld ACs {int(in_withheld.sum())} (ACs {sorted(withheld)}: no catchments by design)")
    no_catch = rest
    # ties and no-vote booths
    ties = int((bp.lead_code == 9).sum())
    tie_tiles = sum(1 for p, _ in pins.values() if p.get("lead_code") == 9)
    novote = bp[bp.votes == 0]
    check(ties == tie_tiles, f"{el}: ties {tie_tiles} in tiles, {ties} in the parquet")
    check(all("lead_code" not in pins[int(u)][0] for u in novote.uid), f"{el}: a no-vote booth carries a lead_code")
    print(f"   200 random booths ok; pins without catchment {len(no_catch)} (all at no-vote locations); ties {ties}; no-vote booths {len(novote)}")
    if bc:
        bc_tile_checks(el, meta, bp, cp, pins, occ)
        del occ
        bc_detail_checks(el, src, meta, bc, d, bp, cp)
        bc_file_checks(el, src, meta, bc, shard, d, cp)


# ---- bcexport elections (LAYOUT.md sections 4-7) ---------------------------------------------------
TF_COL = {"loc": "loc_id", "booth": "booth_id"}   # tile field -> parquet column; every other field: same name
NOT_VOTES = {"uid", "booth", "loc", "method", "source", "flags", "electors"}   # detail row fields that are not votes


def report(n0, label, text):
    """Section line: what was verified, or that it failed (failures printed above)."""
    print(f"   {label}: {text}" if len(fails) == n0 else f"   {label}: FAILED ({len(fails) - n0} failures above)")


def _isnull(v):
    return v is None or (not isinstance(v, str) and pd.isna(v))


def _attr(field, v):
    """Parquet value as the tiles carry it (None = absent)."""
    if _isnull(v):
        return None
    if field == "booth":
        return str(v)
    iv = int(v)
    return iv if iv == v else float(v)


def _diff(a, b):
    a, b = a or {}, b or {}
    return {k: (a.get(k), b.get(k)) for k in sorted(set(a) | set(b)) if a.get(k) != b.get(k)}


def _differ(a, b):
    """Positions where two value arrays differ (NaN = NaN)."""
    a, b = pd.Series(a).reset_index(drop=True), pd.Series(b).reset_index(drop=True)
    return ~((a == b) | (a.isna() & b.isna())).to_numpy()


def _expected_lead(df, cats):
    """Lead codes recomputed from the vote columns: the largest series (NOTA never leads), 9 where the top two are
    equal, NaN where votes = 0."""
    names = [c["value"] for c in cats if c["code"] != 9]
    code = np.array([c["code"] for c in cats if c["code"] != 9], float)
    v = df[names].to_numpy(float)
    top = np.sort(v, axis=1)
    tie = top[:, -1] == top[:, -2] if len(names) > 1 else np.zeros(len(df), bool)
    out = np.where(tie, 9.0, code[v.argmax(axis=1)])
    return np.where(df.votes.to_numpy(float) == 0, np.nan, out)


def bc_tile_checks(el, meta, bp, cp, pins, occ):
    n0 = len(fails)
    lay = meta["layers"]
    has_bloc = bool((meta.get("bloc_lead") or {}).get("categories"))
    for kind, df in (("booths", bp), ("catchments", cp)):
        tf = [f["name"] for f in lay[kind]["tile_fields"]]
        # the size-level ladder: a share is in the tiles exactly when the field dictionary says so
        for p in (meta.get("parties") or []) + (meta.get("blocs") or []):
            f = f"{p['name']}_pm"
            check((f in tf) == bool(p.get("in_tiles")), f"{el} {kind}: {f} in tile_fields {f in tf}, in_tiles {p.get('in_tiles')}")
        if has_bloc:
            check("bloc_lead_code" in tf, f"{el} {kind}: no bloc_lead_code in the tile fields of an election with blocs")
        miss = [f for f in tf if TF_COL.get(f, f) not in df.columns]
        check(not miss, f"{el} {kind}: tile fields {miss} not in the parquet")
        tf = [f for f in tf if f not in miss]
        exp = {}
        for vals in zip(*(df[TF_COL.get(f, f)].tolist() for f in tf)):
            row = {f: _attr(f, v) for f, v in zip(tf, vals)}
            exp[row["uid"]] = {f: v for f, v in row.items() if v is not None}
        # every occurrence (a piece crossing tiles is in each of them): exactly the parquet's tile fields,
        # absent where the parquet is NULL, and no attribute the field dictionary does not list
        bad = [(fid, props) for fid, props in occ[kind] if props != exp.get(fid)]
        for fid, props in bad[:5]:
            print(f"   {kind} tile attributes of uid {fid} (tile, parquet): {_diff(props, exp.get(fid))}")
        check(not bad, f"{el} {kind}: {len(bad)} of {len(occ[kind]):,} tile features differ from the parquet")
        # leads: recomputed from the parquet's vote columns (ties = 9, no lead without votes)
        for lead, key in (("lead", "lead_code"), ("bloc_lead", "bloc_lead_code")):
            cats = (meta.get(lead) or {}).get("categories")
            if not cats:
                check(key not in df.columns or df[key].isna().all(), f"{el} {kind}: {key} values without categories")
                continue
            want = _expected_lead(df, cats)
            n = int(_differ(df[key].astype(float), want).sum())
            check(n == 0, f"{el} {kind}: {n} {key} differ from the vote columns (largest series, 9 = tie)")
            if lead in df.columns:   # the string column names the same category
                val = {float(c["code"]): c["value"] for c in cats}
                ws = [None if np.isnan(c) else val[c] for c in want]
                n = sum(1 for a, b in zip(df[lead].tolist(), ws) if (None if _isnull(a) else a) != b)
                check(n == 0, f"{el} {kind}: {n} {lead} strings differ from {key}")
    # every pin (not only the sample) within 15 m of its booth point
    ll = np.array([pins[int(u)][1] for u in bp.uid], float)
    dist = np.hypot((ll[:, 0] - bp.lon.to_numpy()) * 111320 * np.cos(np.radians(bp.lat.to_numpy())),
                    (ll[:, 1] - bp.lat.to_numpy()) * 110540)
    check((dist <= 15).all(), f"{el}: {int((dist > 15).sum())} pins more than 15 m from the booth point (max {dist.max():.1f} m)")
    bt = int((bp["bloc_lead_code"] == 9).sum()) if "bloc_lead_code" in bp else 0
    report(n0, "tiles", f"every feature = parquet: {len(occ['booths']):,} pin and {len(occ['catchments']):,} piece occurrences "
          f"(size levels {lay['booths'].get('size_level')}/{lay['catchments'].get('size_level')}, "
          f"{len(lay['booths']['tile_fields'])}/{len(lay['catchments']['tile_fields'])} tile fields); "
          f"lead_code{' and bloc_lead_code' if has_bloc else ''} = vote columns"
          f"{f' (bloc ties {bt})' if has_bloc else ''}; every pin within 15 m (max {dist.max():.1f} m)")


def bc_detail_checks(el, src, meta, bc, d, bp, cp):
    n0 = len(fails)
    sfiles = sorted((bc / "details").glob("ac_*.json"))
    pnames = sorted(p.name for p in d.glob("ac_*.json"))
    check([p.name for p in sfiles] == pnames, f"{el}: published AC files differ from the source ({len(pnames)} / {len(sfiles)})")
    areas = _areas(src, el)
    wh = meta.get("catchments_withheld") or {}
    withheld = set(wh.get("spread_acs") or []) | set(wh.get("excluded_acs") or [])
    brows, lrows, per_ac, bits = [], [], {}, {}
    nbytes = 0
    for p in sfiles:
        j = json.loads(p.read_text(encoding="utf-8"))
        # what the build writes (pipeline/booths.py sync): the source plus each location's populated / empty area
        j["area_fields"] = ["loc", "populated_ha", "empty_ha"]
        j["areas"] = areas.get(int(j["ac_no"]), [])
        want = json.dumps(j, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        pp = d / p.name
        if not pp.exists():
            continue
        got = pp.read_bytes()
        if got != want:
            gj = json.loads(got.decode("utf-8"))
            print(f"   {p.name}: published file differs from source + areas in {sorted(k for k in set(j) | set(gj) if j.get(k) != gj.get(k))}")
            nbytes += 1
        else:
            gj = j
        # rows of the published file (what the site shows) against the parquet
        ac = int(gj["ac_no"])
        check(gj.get("key") == el, f"{el} {p.name}: key {gj.get('key')}")
        check(p.name == f"ac_{ac:03d}.json", f"{el} {p.name}: ac_no {ac}")
        check(bool(gj.get("catchment_withheld")) == (ac in withheld),
              f"{el} {p.name}: catchment_withheld {gj.get('catchment_withheld')}, AC withheld {ac in withheld}")
        b = pd.DataFrame(gj["booths"], columns=gj["booth_fields"])
        b["ac_no"] = ac
        b["method"] = [gj["methods"][i] for i in b["method"]]
        b["source"] = [gj["sources"][i] for i in b["source"]]
        bits.update({name: int(k) for k, name in gj["flag_bits"].items()})
        rel = gj.get("relocated") or {}
        b["rel"] = [rel.get(str(u)) for u in b.uid]
        brows.append(b)
        loc = pd.DataFrame(gj["locations"], columns=gj["location_fields"])
        loc["ac_no"] = ac
        if len(loc):
            lrows.append(loc)
        per_ac[ac] = (len(b), int((gj.get("unlocated") or {}).get("n", 0)))
    check(nbytes == 0, f"{el}: {nbytes} published AC files differ from the source + the build's areas")
    if not brows:
        check(False, f"{el}: no AC detail files")
        return
    B = pd.concat(brows, ignore_index=True)
    L = pd.concat(lrows, ignore_index=True) if lrows else pd.DataFrame(columns=["ac_no", "loc", "booths", "lon", "lat"])
    vcols = [c for c in B.columns if c not in NOT_VOTES | {"ac_no", "rel"}]
    lcols = [c for c in L.columns if c not in NOT_VOTES | {"ac_no", "booths", "lon", "lat"}]
    check(B.uid.is_unique and set(B.uid) == set(bp.uid), f"{el}: detail booth rows ({len(B)}) are not the pins ({len(bp)}) one to one")
    m = B.merge(bp, on="uid", how="inner", suffixes=("", "_pq"))
    bad = {}

    def cmp(name, a, b):
        dif = _differ(a, b)
        if dif.any():
            bad[name] = int(dif.sum())
            i = int(np.flatnonzero(dif)[0])
            print(f"   detail rows {name}: {int(dif.sum())} differ, e.g. uid {int(m.uid.iloc[i])}: {pd.Series(a).iloc[i]} != {pd.Series(b).iloc[i]}")

    cmp("ac_no", m.ac_no.astype(int), m.ac_no_pq.astype(int))
    cmp("booth", m.booth.astype(str), m.booth_id.astype(str))
    cmp("loc", m["loc"].astype(float), m.loc_id.astype(float))
    for c in vcols:
        if f"{c}_pq" not in m:
            bad[c] = len(m)
            print(f"   detail field {c} not in the parquet")
            continue
        cmp(c, m[c].astype(float), m[f"{c}_pq"].astype(float))
    cmp("method", m["method"], m["loc_method"])
    cmp("source", m["source"], m["source_pq"])
    flags = sum(m[n].fillna(0).astype(int) * v for n, v in bits.items() if n in m.columns)
    cmp("flags", m["flags"].astype(int), flags)
    has_rel = m.rel.notna()
    cmp("relocated", has_rel.astype(int), m.relocated.fillna(0).astype(int))
    r = m[has_rel & m.relocated.fillna(0).astype(bool)]
    if len(r):
        lat = np.array([x[0] for x in r.rel], float)
        lon = np.array([x[1] for x in r.rel], float)
        off = max(np.abs(lat - r.orig_lat.to_numpy()).max(), np.abs(lon - r.orig_lon.to_numpy()).max())
        if off > 1e-5:
            bad["relocated point"] = 1
            print(f"   relocated points differ from orig_lat / orig_lon by up to {off:.6f} degrees")
    check(not bad, f"{el}: detail booth rows differ from the parquet in {bad}")
    # LAYOUT section 5: the party columns add up to votes, and so do the bloc columns plus nota
    for D, what in ((B, "booth"), (L, "location")):
        pcols = [p["name"] for p in meta.get("parties") or [] if p["name"] in D]
        bcols = [p["name"] for p in meta.get("blocs") or [] if p["name"] in D] + (["nota"] if "nota" in D else [])
        if len(D) and pcols:
            n = int((D[pcols].astype(float).sum(axis=1) != D["votes"].astype(float)).sum())
            check(n == 0, f"{el}: {n} detail {what} rows whose party columns do not add up to votes")
        if len(D) and meta.get("blocs"):
            n = int((D[bcols].astype(float).sum(axis=1) != D["votes"].astype(float)).sum())
            check(n == 0, f"{el}: {n} detail {what} rows whose bloc columns + nota do not add up to votes")
    # location rows: their booths summed, the booth numbers, the location point (catchments parquet)
    g = bp.groupby(["ac_no", "loc_id"])
    sums = g[[c for c in lcols if c != "loc" and c in bp.columns]].sum(min_count=1)
    nums = g.booth_id.apply(lambda s: sorted(map(str, s)))
    key = pd.MultiIndex.from_arrays([L.ac_no.astype(sums.index.levels[0].dtype), L["loc"].astype(sums.index.levels[1].dtype)])
    lbad = {}
    if not (key.is_unique and set(key) == set(sums.index)):
        lbad["locations"] = len(set(key) ^ set(sums.index)) or "duplicates"
    else:
        s2 = sums.reindex(key)
        for c in lcols:
            if c == "loc":
                continue
            n = int(_differ(L[c].astype(float), s2[c].astype(float) if c in s2 else np.full(len(L), np.nan)).sum())
            if n:
                lbad[c] = n
        n = sum(1 for x, y in zip(L["booths"], nums.reindex(key)) if sorted(str(x).split()) != y)
        if n:
            lbad["booths"] = n
        pt = cp.groupby("loc_id")[["lon", "lat"]].first()
        q = L[L["loc"].isin(pt.index)]
        if len(q):
            off = np.abs(q[["lon", "lat"]].to_numpy(float) - pt.loc[q["loc"]].to_numpy(float)).max()
            if off > 6e-6:   # 5 decimals
                lbad["point"] = f"{off:.6f} deg"
    for k, v in lbad.items():
        print(f"   location rows {k}: {v} differ")
    check(not lbad, f"{el}: detail location rows differ from the parquet in {lbad}")
    # booth rows + unlocated = the AC's booth counts (counts/units; NA ACs: their rows complete the total)
    y = int(meta["year"])
    u = pd.read_parquet(bc / "counts" / "units" / f"{el}_booth_counts.parquet")
    cbad, na_rows = 0, 0
    for no, tot, loc_n, unl in zip(u.ac_no, u[f"booths_{y}"], u[f"booths_located_{y}"], u[f"booths_unlocated_{y}"]):
        rows_n, unl_n = per_ac.get(int(no), (0, 0))
        if pd.isna(tot):
            na_rows += rows_n + unl_n
            continue
        if (rows_n, unl_n, rows_n + unl_n) != (int(loc_n), int(unl), int(tot)):
            cbad += 1
            print(f"   AC {int(no)}: detail rows {rows_n} + unlocated {unl_n} != located {loc_n} + unlocated {unl} = {tot}")
    check(cbad == 0, f"{el}: {cbad} ACs whose detail rows differ from counts/units")
    check(set(per_ac) <= set(int(x) for x in u.ac_no), f"{el}: detail files of ACs not in counts/units")
    c = meta["counts"]
    n_rows, n_unl = sum(a for a, _ in per_ac.values()), sum(b for _, b in per_ac.values())
    check(n_rows == c["booths_located_pins"] and n_unl == c["booths_unlocated"],
          f"{el}: detail rows {n_rows} / unlocated {n_unl} != booth_layers counts {c['booths_located_pins']} / {c['booths_unlocated']}")
    tot = int(u[f"booths_{y}"].fillna(0).sum())
    check(tot + na_rows == c["booths"], f"{el}: AC counts {tot} + rows of NA ACs {na_rows} != booths {c['booths']}")
    report(n0, "details", f"{len(pnames)} AC files = source + the build's areas, byte for byte; {len(B):,} booth rows "
          f"({len(vcols)} vote columns, booth, loc, method, source, flags, relocated) and {len(L):,} location rows = parquet; "
          f"rows + unlocated = counts/units (AC sum {tot:,} + NA ACs {na_rows:,} = {c['booths']:,} booths)")


def bc_file_checks(el, src, meta, bc, shard, d, cp):
    n0 = len(fails)
    cc = CC_EL.get(el)
    check(cc is not None, f"{el}: published but not in config.json booths")
    check(d == data_dir(shard) / "booths" / el, f"{el}: published at {d}, not in its data repository {shard}")
    expected = {"booths.pmtiles", "catchments.pmtiles"} | {p.name for p in (bc / "details").glob("ac_*.json")}
    same = 0
    for kind in ("booths", "catchments"):
        same += bool(check((d / f"{kind}.pmtiles").read_bytes() == (src / f"{el}_{kind}.pmtiles").read_bytes(),
                           f"{el}: published {kind}.pmtiles differs from the source"))
    nsplit = 0
    if cc and cc.get("split"):
        sd = bc / "split"
        sfiles = sorted(sd.glob("ac_*.bin.gz")) + ([sd / "index.json"] if (sd / "index.json").exists() else [])
        expected |= {f"split/{f.name}" for f in sfiles}
        diff = [f.name for f in sfiles if not (d / "split" / f.name).exists() or (d / "split" / f.name).read_bytes() != f.read_bytes()]
        check(not diff, f"{el}: {len(diff)} published split files differ from the source ({diff[:5]})")
        nsplit = len(sfiles) - len(diff)
        sacs = {int(f.name[3:6]) for f in sfiles if f.name.startswith("ac_")}
        wh = meta.get("catchments_withheld") or {}
        withheld = set(wh.get("spread_acs") or []) | set(wh.get("excluded_acs") or [])
        cacs = set(int(x) for x in cp.ac_no)
        check(sacs.isdisjoint(withheld), f"{el}: split files of withheld ACs {sorted(sacs & withheld)}")
        check(sacs <= cacs, f"{el}: split files of ACs without catchments {sorted(sacs - cacs)}")
    actual = {f.relative_to(d).as_posix() for f in d.rglob("*") if f.is_file()}
    check(actual == expected, f"{el}: published files differ from the source set: extra {sorted(actual - expected)[:5]}, missing {sorted(expected - actual)[:5]}")
    if cc:   # what the browser is told
        for k in ("booths", "booths_located_pins", "booths_unlocated", "locations_with_catchment"):
            check(cc["counts"].get(k) == meta["counts"].get(k), f"{el}: config.json counts.{k} {cc['counts'].get(k)} != {meta['counts'].get(k)}")
        for k in ("booths", "catchments"):
            check(cc["fields"][k] == [f["name"] for f in meta["layers"][k]["tile_fields"]], f"{el}: config.json fields.{k} != tile_fields")
        check(cc.get("shard") == shard, f"{el}: config.json shard {cc.get('shard')} != {shard}")
    report(n0, "files", f"{same}/2 PMTiles and {nsplit} split files byte-identical to the source; published folder = the "
          f"{len(expected)} expected files, nothing else; config.json counts, fields and shard agree")


def count_checks():
    print("== booth counts")
    datasets = {k: v for k, v in cfg["variables"]["datasets"].items() if k.endswith("_booths")}
    for dsid, ds in datasets.items():
        pre = ds["prefix"]
        sid = f"{pre}booths"
        s = next(v for v in CC["variables"] if v["id"] == sid)
        spec = ds["units_table"]
        st_id = next(u["id"] for u in UNITS["state"] if u["key"] == spec["state"])
        for y in s["years"]:
            el = next(e for e in CC["booths"]["elections"] if e["prefix"] == pre and e["year"] == y)
            CTX[0] = ("counts", el["id"])
            pins = el["counts"]["booths_located_pins"]
            dropped = {}
            for res in (8, 7, 6):
                q = s["q"][str(res)]
                raw = np.frombuffer(find_data(f"hex/h{res}/v/{sid}_{y}.bin").read_bytes(), "<u2").astype(float)
                vals = np.where(raw == 65535, np.nan, q["offset"] + raw * q["scale"])
                # pins in cells the site's index does not have (sea, outside the boundary) cannot be shown
                if res not in ORDERS:
                    man = json.loads((DATA / "hex" / f"h{res}" / "manifest.json").read_text())
                    ORDERS[res] = set(_decode_index(res, man, cfg.chunk_levels)[0].tolist())
                src = duckdb.sql(f"SELECT h3_index, booths_{y} AS b FROM '{ds['root']}/h{res}/{ds['file'].format(res=res)}'").df()
                inidx = np.array([int(h, 16) in ORDERS[res] for h in src.h3_index])
                dropped[res] = int(src.b[~inidx].fillna(0).sum())
                check(np.nansum(vals) + dropped[res] == pins, f"{sid} {y} h{res}: cells {np.nansum(vals):.0f} + outside the index {dropped[res]} != pins {pins}")
                check(np.nansum(vals) == src.b[inidx].fillna(0).sum(), f"{sid} {y} h{res}: published cells differ from the parquet")
            tab = duckdb.sql(f"SELECT * FROM '{spec['path'].format(year=y)}'").df()
            acs = {u["no"]: u for u in UNITS["ac"] if u["st"] == st_id}
            f = {lvl: json.loads((DATA / "units" / "v" / sid / f"{lvl}.json").read_text()) for lvl in ("ac", "pc", "district", "state")}
            j = f["ac"]["y"].index(y)
            acv = np.array([np.nan if x is None else x for x in f["ac"]["v"][j]], float)
            exp = np.full(len(UNITS["ac"]), np.nan)
            for no, v in zip(tab.ac_no, tab[f"booths_{y}"]):
                exp[acs[int(no)]["id"]] = np.nan if pd.isna(v) else v
            check(np.array_equal(acv, exp, equal_nan=True), f"{sid} {y}: AC values differ from booths_{y}")
            # PC / district / state: sums over the ACs with a value; k ACs left out
            ac_ids = np.array([acs[int(no)]["id"] for no in tab.ac_no])
            v = tab[f"booths_{y}"].to_numpy(float)
            a8 = None
            for lvl in ("pc", "district", "state"):
                if lvl == "pc":
                    g = np.array([UNITS["ac"][a]["pc"] for a in ac_ids])
                elif lvl == "state":
                    g = np.full(len(ac_ids), st_id)
                else:
                    if a8 is None:
                        man = json.loads((DATA / "hex" / "h8" / "manifest.json").read_text())
                        _, ids8 = _decode_index(8, man, cfg.chunk_levels)
                        a8, d8 = ids8["a"].astype(int), ids8["d"].astype(int)
                    g = np.array([np.bincount(d8[(a8 == a) & (d8 >= 0)]).argmax() for a in ac_ids])
                n = len(UNITS[lvl])
                ok = np.isfinite(v)
                sums = np.bincount(g[ok], weights=v[ok], minlength=n)
                have = np.bincount(g[ok], minlength=n) > 0
                left = np.bincount(g[~ok], minlength=n) if (~ok).any() else np.zeros(n, int)
                got = np.array([np.nan if x is None else x for x in f[lvl]["v"][j]], float)
                expv = np.where(have, sums, np.nan)
                check(np.array_equal(got, expv, equal_nan=True), f"{sid} {y} {lvl}: values differ from the sums of their ACs")
                gx = np.array(f[lvl]["x"][j]) if "x" in f[lvl] else np.zeros(n, int)
                check(np.array_equal(gx, left), f"{sid} {y} {lvl}: left-out AC counts differ")
            na = sorted(int(no) for no, x in zip(tab.ac_no, v) if not np.isfinite(x))
            print(f"   {sid} {y}: pins {pins:,} = cells + pins in cells outside the site index (H8/H7/H6: {dropped[8]}/{dropped[7]}/{dropped[6]}); state {f['state']['v'][j][st_id]:,.0f} excl. {len(na)} ACs {na[:12]}{'…' if len(na) > 12 else ''}")


INDEX = {}   # res -> (h3 order, unit ids, manifest) of the site index


def _index(res):
    if res not in INDEX:
        man = json.loads((DATA / "hex" / f"h{res}" / "manifest.json").read_text())
        order, ids = _decode_index(res, man, cfg.chunk_levels)
        srt = np.argsort(order)
        INDEX[res] = (order, ids, man, order[srt], srt)
    return INDEX[res]


def _positions(res, h3):
    """Index position of each H3 cell (-1: not in the site index)."""
    _, _, _, sorted_ids, srt = _index(res)
    x = np.array([int(h, 16) for h in h3], np.uint64)
    i = np.minimum(np.searchsorted(sorted_ids, x), len(sorted_ids) - 1)
    return np.where(sorted_ids[i] == x, srt[i], -1)


def bc_count_checks(keys):
    """Booth counts of bcexport elections (LAYOUT section 6): the published `<prefix>booths` series against the
    election's counts/ files, cell by cell and unit by unit."""
    print("== booth counts (booth-catchment layout)")
    els = {e.key: e for ds in bcexport.datasets(cfg) for e in ds.els}
    for key in keys:
        CTX[0] = ("counts", key)
        n0 = len(fails)
        cc, e = CC_EL.get(key), els.get(key)
        if cc is None or e is None:
            check(False, f"{key}: not in config.json booths / bcexport elections")
            continue
        sid, y = f"{cc['prefix']}booths", e.year
        s = next((v for v in CC["variables"] if v["id"] == sid), None)
        files = e.count_files()
        if s is None or y not in s.get("years", []):
            # booths_complete publishes the counts with the booth layers: their absence is an error, unless the
            # election has no count files at all
            check(not all(f.exists() for f in files.values()), f"{sid} {y}: booth counts not published although counts/ is complete")
            print(f"   {sid} {y}: not published (no counts files)")
            continue
        meta = json.loads((e.dir / "booths" / f"{key}_booth_layers.json").read_text(encoding="utf-8"))
        pins = cc["counts"]["booths_located_pins"]
        check(pins == meta["counts"]["booths_located_pins"], f"{sid} {y}: config.json pins {pins} != booth_layers {meta['counts']['booths_located_pins']}")
        chunks = (CC.get("chunks") or {}).get(s["sparse"]) if s.get("sparse") else None
        dropped, cells, na_n = {}, {}, {}
        for res in (8, 7, 6):
            order, ids, man, _, _ = _index(res)
            n, start = man["n"], man["start"]
            q = s["q"][str(res)]
            raw = (data_dir(s.get("shard")) / "hex" / f"h{res}" / "v" / f"{sid}_{y}.bin").read_bytes()
            a = np.frombuffer(raw, "<u2")
            full = np.full(n, 65535, np.uint16)   # cells outside a sparse file's chunks: missing
            if chunks is not None:
                o = 0
                for k in chunks[str(res)]:
                    full[start[k]:start[k + 1]] = a[o:o + start[k + 1] - start[k]]
                    o += start[k + 1] - start[k]
                check(o == len(a), f"{sid} {y} h{res}: file holds {len(a)} values, its chunks {o}")
            else:
                check(len(a) == n, f"{sid} {y} h{res}: file holds {len(a)} values, the index {n}")
                full[:] = a[:n]
            vals = decode(full.tobytes(), q)
            na_pub = full == q["na"] if "na" in q else np.zeros(n, bool)
            src = pd.read_parquet(files[res], columns=["h3_index", f"booths_{y}"])
            b = src[f"booths_{y}"].astype("float64").to_numpy()
            check(np.nansum(b) == pins, f"{sid} {y} h{res}: counts file sums to {np.nansum(b):.0f}, pins {pins}")
            pos = _positions(res, src.h3_index)
            inidx = pos >= 0
            dropped[res] = int(np.nansum(b[~inidx]))
            # the published cells, cell by cell: the source value, NA (NULL) as the NA code, every other cell empty
            want = np.full(n, np.nan)
            want[pos[inidx]] = b[inidx]
            want_na = np.zeros(n, bool)
            want_na[pos[inidx]] = np.isnan(b[inidx])
            tol = q.get("scale", 1) / 2 + 1e-9
            dif = ~((np.abs(vals - want) <= tol) | (np.isnan(vals) & np.isnan(want)))
            check(not dif.any(), f"{sid} {y} h{res}: {int(dif.sum())} published cells differ from counts/h{res}")
            check(np.array_equal(na_pub, want_na), f"{sid} {y} h{res}: NA cells {int(na_pub.sum())} published, {int(want_na.sum())} NULL in counts/h{res}")
            check(np.nansum(vals) + dropped[res] == pins, f"{sid} {y} h{res}: cells {np.nansum(vals):.0f} + outside the index {dropped[res]} != pins {pins}")
            cells[res], na_n[res] = int(inidx.sum()), int(want_na.sum())
        # units: AC values and the located / unlocated extras = counts/units; PC by the seat map, district, state
        st_id = next(u["id"] for u in UNITS["state"] if u["key"] == e.state_key)
        acs = {u["no"]: u["id"] for u in UNITS["ac"] if u["st"] == st_id}
        pcs = {u["no"]: u["id"] for u in UNITS["pc"] if u["st"] == st_id}
        tab = pd.read_parquet(files["units"])
        missing = [int(no) for no in tab.ac_no if int(no) not in acs]
        if not check(not missing, f"{sid} {y}: AC numbers not in the site's ACs {missing[:10]}"):
            continue
        f = {lvl: json.loads((DATA / "units" / "v" / sid / f"{lvl}.json").read_text()) for lvl in ("ac", "pc", "district", "state")}
        j = f["ac"]["y"].index(y)
        ac_ids = np.array([acs[int(no)] for no in tab.ac_no])
        v = tab[f"booths_{y}"].astype("float64").to_numpy()
        nul = lambda xs: np.array([np.nan if x is None else x for x in xs], float)
        exp = np.full(len(UNITS["ac"]), np.nan)
        exp[ac_ids] = v
        check(np.array_equal(nul(f["ac"]["v"][j]), exp, equal_nan=True), f"{sid} {y}: AC values differ from counts/units booths_{y}")
        for name, col in (("located", f"booths_located_{y}"), ("unlocated", f"booths_unlocated_{y}")):
            exp = np.full(len(UNITS["ac"]), np.nan)
            exp[ac_ids] = tab[col].astype("float64").to_numpy()
            got = nul(((f["ac"].get("e") or {}).get(name) or [[None] * len(UNITS["ac"])] * (j + 1))[j])
            check(np.array_equal(got, exp, equal_nan=True), f"{sid} {y}: AC {name} differ from counts/units {col}")
        sm = pd.read_csv(e.seatmap_csv)
        pc_of = dict(zip(sm.ac_no.astype(int), sm.pc_no.astype(int)))
        bad_pc = [int(no) for no in tab.ac_no if pcs.get(pc_of.get(int(no))) is None]
        if not check(not bad_pc, f"{sid} {y}: ACs {bad_pc[:10]} have no site PC by the seat map {e.seatmap_csv.name}"):
            continue
        ac_d = ac_district(_index(8)[1], len(UNITS["ac"]))
        for lvl in ("pc", "district", "state"):
            if lvl == "pc":
                g = np.array([pcs[pc_of[int(no)]] for no in tab.ac_no])
            elif lvl == "district":
                g = ac_d[ac_ids]
            else:
                g = np.full(len(ac_ids), st_id)
            nu = len(UNITS[lvl])
            inside = g >= 0
            ok = inside & np.isfinite(v)
            sums = np.bincount(g[ok], weights=v[ok], minlength=nu)
            have = np.bincount(g[ok], minlength=nu) > 0
            left = np.bincount(g[inside & ~ok], minlength=nu)
            check(np.array_equal(nul(f[lvl]["v"][j]), np.where(have, sums, np.nan), equal_nan=True),
                  f"{sid} {y} {lvl}: values differ from the sums of their ACs")
            gx = np.array(f[lvl]["x"][j]) if "x" in f[lvl] else np.zeros(nu, int)
            check(np.array_equal(gx, left), f"{sid} {y} {lvl}: left-out AC counts differ")
        # Σ AC counts + the booth rows of NA ACs = every booth row (LAYOUT section 6)
        na = sorted(int(no) for no, x in zip(tab.ac_no, v) if not np.isfinite(x))
        report(n0, f"{sid} {y}", f"every cell = counts/h{{8,7,6}} ({cells[8]:,}/{cells[7]:,}/{cells[6]:,} cells, NA {na_n[8]}/{na_n[7]}/{na_n[6]}); "
              f"pins {pins:,} = cells + pins outside the site index (H8/H7/H6: {dropped[8]}/{dropped[7]}/{dropped[6]}); "
              f"AC / located / unlocated = counts/units; PC (seat map {e.seat_map}), district, state = AC sums; "
              f"state {f['state']['v'][j][st_id]:,.0f} excl. {len(na)} ACs {na[:12]}{'...' if len(na) > 12 else ''}")


def summary(ran, counts_ran, bc_counts):
    print("\n== summary")
    for el, kind in ran:
        if el in SKIPPED:
            print(f"   {el:<10} {kind:<8} SKIPPED: {SKIPPED[el]}")
            continue
        parts = [("tiles/details", ("tiles", el))]
        if kind == "bcexport" and el in bc_counts:
            parts.append(("counts", ("counts", el)))
        elif kind == "legacy" and counts_ran:
            parts.append(("counts", ("counts", el)))
        txt = "; ".join(f"{name} {'PASS' if not FAILS_BY[k] else f'FAIL ({len(FAILS_BY[k])})'}" for name, k in parts)
        what = "tiles, leads, details, files" if kind == "bcexport" else "tiles, details"
        print(f"   {el:<10} {kind:<8} {txt}   [{what}]")
    other = [k for k in FAILS_BY if k == "-" and FAILS_BY[k]]
    if other:
        print(f"   other    FAIL ({len(FAILS_BY['-'])})")


if __name__ == "__main__":
    duckdb.sql("INSTALL spatial; LOAD spatial;")
    want = set(sys.argv[1:])
    ran = []
    els = elections(cfg)
    ids = {el for el, *_ in els}
    for el, src, meta, shard in els:
        if not want or el in want:
            bc = _BCEXPORT.get(el)
            ran.append((el, "bcexport" if bc else "legacy"))
            CTX[0] = ("tiles", el)
            if not find_data(f"booths/{el}").exists() and el not in CC_EL:
                # the producer finished it after the last site build: config.json does not offer it yet
                print(f"== {el}\n   not published yet (source complete, the site has not been rebuilt since); skipped")
                SKIPPED[el] = "not published yet (not in config.json; rebuild the site)"
                continue
            tile_checks(el, src, meta, bc, shard)
    CTX[0] = "-"
    counts_ran = not want or "counts" in want
    if counts_ran:
        count_checks()
    # bcexport counts: per election (an election id given runs its counts too)
    bc_counts = [el for el, *_ in els if el in _BCEXPORT and el not in SKIPPED
                 and (not want or el in want or ("counts" in want and not (want & ids)))]
    if bc_counts:
        bc_count_checks(bc_counts)
    CTX[0] = "-"
    summary(ran, counts_ran, bc_counts)
    print(f"\n{'ALL PASS' if not fails else f'{len(fails)} FAILURES'}")
    sys.exit(1 if fails else 0)
