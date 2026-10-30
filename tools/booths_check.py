"""Acceptance checks for the booth layers (BOOTHS brief §8: data fidelity and booth counts).

  tiles     every pin and catchment piece of every election decodes from the published PMTiles: unique
            uids = the parquet rows; 200 random booths: tile fields and detail rows equal the parquet,
            and the pin lies within 15 m of the booth point
  locs      every pin's location has a catchment, except booths at locations without votes; ties and
            no-vote booths carry lead_code 9 / no lead_code
  counts    booth-count hexagons sum to the pins at H6/H7/H8; AC values = booths_YYYY (empty where the
            booth data is incomplete); PC / district / state = sums of their other ACs, with the count of
            ACs left out
python tools/booths_check.py [election ...] [counts]    (run in the site folder after a build; no argument: everything)

Reads PMTiles v3 and Mapbox Vector Tiles with the small decoder below (no extra packages).
"""
import gzip
import json
import math
import random
import struct
import sys
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from pipeline.booths import elections  # noqa: E402
from pipeline.build import _decode_index  # noqa: E402
from pipeline.config import DATA, load_config  # noqa: E402

cfg = load_config()
UNITS = json.loads((DATA / "units.json").read_text(encoding="utf-8"))
CC = json.loads((ROOT / "site" / "config.json").read_text(encoding="utf-8"))
fails = []
TILES = {}
ORDERS = {}


def check(ok, msg):
    if not ok:
        fails.append(msg)
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
def tile_checks(el, src, meta):
    d = DATA / "booths" / el
    print(f"== {el}")
    pins, catch = {}, {}
    maxtile = maxraw = 0
    for kind, store in (("booths", pins), ("catchments", catch)):
        for z, x, y, raw, stored in pmtiles_tiles(d / f"{kind}.pmtiles"):
            maxtile, maxraw = max(maxtile, stored), max(maxraw, len(raw))
            check(z == 10, f"{el} {kind}: tile at z{z}")
            for fid, props, pt, ext in mvt_features(raw, kind):
                check(fid == props.get("uid"), f"{el} {kind}: MVT id {fid} != uid {props.get('uid')}")
                if fid not in store and pt is not None:
                    store[fid] = (props, tile_lonlat(z, x, y, pt[0], pt[1], ext))
                elif fid not in store:
                    store[fid] = (props, None)
    bp = duckdb.sql(f"SELECT *, ST_X(geometry) AS lon, ST_Y(geometry) AS lat FROM '{src / f'{el}_booths.parquet'}'").df()
    cp = duckdb.sql(f"SELECT uid, loc_id, pop, lead_code, votes FROM '{src / f'{el}_catchments.parquet'}'").df()
    check(len(pins) == len(bp), f"{el}: {len(pins)} pins in the tiles, {len(bp)} booth rows")
    check(len(catch) == len(cp), f"{el}: {len(catch)} catchment pieces in the tiles, {len(cp)} rows")
    check(set(pins) == set(bp.uid), f"{el}: pin uids differ from the parquet")
    check(set(catch) == set(cp.uid), f"{el}: catchment uids differ from the parquet")
    print(f"   pins {len(pins):,} = parquet {len(bp):,}; catchment pieces {len(catch):,} = {len(cp):,}; largest tile {maxtile / 1e3:.0f} KB transferred ({maxraw / 1e3:.0f} KB unzipped)")
    TILES[el] = maxtile
    # 200 random booths: tile fields, detail rows and position
    rng = random.Random(7)
    rows = bp.sample(min(200, len(bp)), random_state=rng.randrange(10 ** 6))
    pm = [c for c in bp.columns if c.endswith("_pm")]
    dets = {}
    bad = 0
    for _, r in rows.iterrows():
        props, ll = pins[int(r.uid)]
        want = {"loc": int(r.loc_id), "ac_no": int(r.ac_no), "n_booths": int(r.n_booths)}
        want.update({c: int(r[c]) for c in pm if pd.notna(r[c])})
        if pd.notna(r.lead_code):
            want["lead_code"] = int(r.lead_code)
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
        parties = [c for c in ("bjp", "inc", "jds", "oth", "nda", "mgb", "jsp", "others", "nota") if c in row]
        for c in ["votes", *parties]:
            if c in r and pd.notna(r[c]) and row[c] != int(r[c]):
                bad += 1
                print(f"   detail {int(r.uid)} {c}: {row[c]} != {r[c]}")
        if row["loc"] != int(r.loc_id) or str(row["booth"]) != str(r.get("booth_id", row["booth"])):
            pass
    check(bad == 0, f"{el}: {bad} mismatches in 200 random booths")
    # every pin's location has a catchment, except booths at locations without votes
    locs_with_catch = set(cp.loc_id)
    loc_votes = bp.groupby("loc_id").votes.sum()
    no_catch = bp[~bp.loc_id.isin(locs_with_catch)]
    check((loc_votes.loc[no_catch.loc_id.unique()] == 0).all() if len(no_catch) else True, f"{el}: pins without a catchment at locations with votes")
    # ties and no-vote booths
    ties = int((bp.lead_code == 9).sum())
    tie_tiles = sum(1 for p, _ in pins.values() if p.get("lead_code") == 9)
    novote = bp[bp.votes == 0]
    check(ties == tie_tiles, f"{el}: ties {tie_tiles} in tiles, {ties} in the parquet")
    check(all("lead_code" not in pins[int(u)][0] for u in novote.uid), f"{el}: a no-vote booth carries a lead_code")
    print(f"   200 random booths ok; pins without catchment {len(no_catch)} (all at no-vote locations); ties {ties}; no-vote booths {len(novote)}")


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
            pins = el["counts"]["booths_located_pins"]
            dropped = {}
            for res in (8, 7, 6):
                q = s["q"][str(res)]
                raw = np.frombuffer((DATA / "hex" / f"h{res}" / "v" / f"{sid}_{y}.bin").read_bytes(), "<u2").astype(float)
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


if __name__ == "__main__":
    duckdb.sql("INSTALL spatial; LOAD spatial;")
    want = set(sys.argv[1:])
    for el, src, meta in elections(cfg):
        if not want or el in want:
            tile_checks(el, src, meta)
    if not want or "counts" in want:
        count_checks()
    print(f"\n{'ALL PASS' if not fails else f'{len(fails)} FAILURES'}")
    sys.exit(1 if fails else 0)
