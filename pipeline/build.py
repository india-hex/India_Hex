"""Incremental build of site/data and site/config.json from india_hex.yaml.

Every output carries a signature (source file mtime/size + the settings that shape it) in
site/data/.build.json; outputs whose signature is unchanged are skipped. Editing only display
settings in india_hex.yaml rewrites config.json and nothing else.
"""
import json
import os
import shutil
import stat
import time
from collections import defaultdict

import numpy as np

from . import catalog as cat
from . import booths, geo, hexes, official
from .config import DATA, SITE
from .util import dir_size, file_sig, log, obj_sig

STATE_PATH = DATA / ".build.json"


def _load_state():
    try:
        return json.loads(STATE_PATH.read_text())
    except (OSError, ValueError):
        return {}


def _save_state(st):
    DATA.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(st, indent=1))


def build(cfg, force=False, only_config=False):
    t0 = time.time()
    st = {} if force else _load_state()
    st.setdefault("bins", {}), st.setdefault("q", {}), st.setdefault("agg", {}), st.setdefault("index", {})
    st.setdefault("chunks", {})

    log("catalog: discovering variables")
    series = cat.discover(cfg, verbose=True)
    log(f"  {len(series)} series, {sum(len(s.years) or 1 for s in series)} series-years")

    if only_config:
        write_client_config(cfg, series, st)
        return series

    # ---- units + boundaries (everything downstream keys off unit ids) ------------------------
    bsrc = [cfg.boundary_path(k) for k in ("ac", "ac_lookup", "pc", "district")] + cfg.ac_patch_paths
    h8_ntl = cfg.hex_file(cfg["variables"]["datasets"]["ntl"]["file"], 8)
    units_sig = obj_sig([file_sig(p) for p in bsrc], file_sig(h8_ntl))
    bnd_sig = obj_sig(units_sig, cfg["boundaries"]["simplify"], cfg["boundaries"]["detail"])
    need_units = st.get("units") != units_sig or not (DATA / "units.json").exists()
    need_bnd = st.get("boundaries") != bnd_sig or not (DATA / "boundaries" / "ac.json").exists()

    h8cells = None
    if need_units or need_bnd:
        log("geography: loading boundaries")
        bounds = geo.load_boundaries(cfg)
        h8cells = hexes.cell_table(cfg, 8)
        units = geo.build_units(cfg, h8cells, bounds) if need_units else json.loads((DATA / "units.json").read_text(encoding="utf-8"))
        if need_bnd or need_units:
            geo.build_boundaries(cfg, units, bounds)
        st["units"], st["boundaries"] = units_sig, bnd_sig
        _save_state(st)
    else:
        units = json.loads((DATA / "units.json").read_text(encoding="utf-8"))
        log("geography: unchanged")
    n_units = {k: len(v) for k, v in units.items()}

    # ---- hex index per resolution ---------------------------------------------------------------
    orders, ids_by_res = {}, {}
    res_list = sorted(cfg.resolutions, reverse=True)  # 8 first: H6 needs H8's AC lookup
    for res in res_list:
        ntl = cfg.hex_file(cfg["variables"]["datasets"]["ntl"]["file"], res)
        sig = obj_sig(units_sig, file_sig(ntl), cfg.chunk_levels)
        if st["index"].get(str(res)) == sig and (DATA / "hex" / f"h{res}" / "index.bin").exists():
            continue
        log(f"h{res}: building index")
        if res in (6, 8) and h8cells is None:
            h8cells = hexes.cell_table(cfg, 8)
        h8_ac = h8cells.set_index("h3_index").ac_key if res == 6 else None
        cells = h8cells if res == 8 else hexes.cell_table(cfg, res, h8_ac=h8_ac)
        orders[res], ids_by_res[res] = hexes.build_index(cfg, res, cells, units)
        st["index"][str(res)] = sig
        # unit ids changed -> every variable file at this res is stale
        st["bins"] = {k: v for k, v in st["bins"].items() if not k.startswith(f"{res}/")}
        st["chunks"] = {k: v for k, v in st["chunks"].items() if not k.endswith(f"/{res}")}
        if res == 8:
            st["agg"] = {}
        _save_state(st)

    def order_for(res):
        if res not in orders:
            man = json.loads((DATA / "hex" / f"h{res}" / "manifest.json").read_text())
            orders[res], ids_by_res[res] = _decode_index(res, man, cfg.chunk_levels)
        return orders[res]

    _split_old_unit_files()
    starts = {}

    def start_for(res):
        if res not in starts:
            starts[res] = np.array(json.loads((DATA / "hex" / f"h{res}" / "manifest.json").read_text())["start"])
        return starts[res]

    allowed_cache = {}

    def allowed_for(states):
        """{level: bool per unit}: units inside these states (None = no restriction)."""
        if not states:
            return None
        key = tuple(states)
        if key not in allowed_cache:
            sids = {u["id"] for u in units["state"] if u["key"] in states}
            if len(sids) != len(states):
                raise ValueError(f"states {states}: not all found in units.json state keys")
            allowed_cache[key] = {lvl: np.array([(u["id"] if lvl == "state" else u["st"]) in sids for u in units[lvl]])
                                  for lvl in geo.LEVELS}
        return allowed_cache[key]

    off_cache = {}

    # ---- variables ------------------------------------------------------------------------------
    by_ds = defaultdict(list)
    for s in series:
        by_ds[s.dataset].append(s)
    expected = set()
    readers = {}
    for ds, ss in by_ds.items():
        for res in res_list:
            src = cfg.hex_file(ss[0].file, res, ss[0].root)
            if not src.exists():
                continue
            ckey = f"{ds}/{res}"
            if ss[0].sparse and ckey not in st["chunks"]:
                reader = readers.get(res) or readers.setdefault(res, hexes.SeriesReader(cfg, res, hexes.Aligner(order_for(res))))
                st["chunks"][ckey] = hexes.chunks_of(reader.positions(ss[0]), start_for(res))
            elif not ss[0].sparse:
                st["chunks"].pop(ckey, None)
            todo = []
            for s in ss:
                if res not in s.res_years and not (res == 8):
                    continue
                # settings only the newer dataset kinds use are signed only when set, so adding them
                # leaves every existing series' signature (and file) as it was
                extra = {k: v for k, v in (("sparse", st["chunks"].get(ckey) if s.sparse else None),
                                           ("type", s.type if s.type != "numeric" else None), ("root", s.root)) if v}
                ssig = obj_sig(st["index"].get(str(res)), file_sig(src), s.cols if not s.pivot else {str(k): list(v) for k, v in s.cols.items()},
                               s.dtype, s.fill_missing, s.res_years.get(res), s.pivot, *([extra] if extra else []))
                key = f"{res}/{s.id}"
                files_ok = all((DATA / "hex" / f"h{res}" / "v" / s.bin_name(y)).exists() for y in s.res_years.get(res, []))
                for y in s.res_years.get(res, []):
                    expected.add(f"h{res}/v/{s.bin_name(y)}")
                need_bin = res in s.res_years and (st["bins"].get(key) != ssig or not files_ok)
                aextra = {k: v for k, v in (("weight", s.weight), ("states", s.states), ("official", official.signature(s)),
                                            ("units_table", s.units_table), ("official_col", s.official_col)) if v}
                asig = obj_sig(ssig, s.agg, st["index"].get("8"), *([aextra] if aextra else []))
                need_agg = res == 8 and (st["agg"].get(s.id) != asig or not (DATA / "units" / "v" / s.id / "state.json").exists())
                if need_bin or need_agg:
                    todo.append((s, key, ssig, need_bin, need_agg, asig))
            if not todo:
                continue
            log(f"h{res}: {ds}: {len(todo)} series")
            reader = readers.get(res) or readers.setdefault(res, hexes.SeriesReader(cfg, res, hexes.Aligner(order_for(res))))
            for s, key, ssig, need_bin, need_agg, asig in todo:
                years = (s.years or [None]) if need_agg else s.res_years[res]
                by_year = {y: reader.column(s, y) for y in years}
                if need_bin:
                    q = hexes.quant_params(s, [by_year[y] for y in s.res_years[res]])
                    hexes.write_series(res, s, by_year, q, st["chunks"].get(ckey) if s.sparse else None, start_for(res))
                    st["q"][key], st["bins"][key] = q, ssig
                if need_agg:
                    weights = {y: reader.raw(s, s.weight_col(y)) for y in years} if s.agg == "wmean" else None
                    agg = hexes.aggregate(s, by_year, ids_by_res[8], n_units, weights, allowed_for(s.states))
                    if s.units_table:
                        tk = obj_sig(s.units_table)
                        off = off_cache.get(tk) or off_cache.setdefault(tk, official.Official(s.units_table, units, ids_by_res[8]))
                        agg = off.apply(s, agg)
                    _write_unit_files(s.id, agg)
                    st["agg"][s.id] = asig
            _save_state(st)

    # ---- remove files no longer in the catalog ---------------------------------------------------
    removed = 0
    for res in cfg.resolutions:
        vdir = DATA / "hex" / f"h{res}" / "v"
        for f in vdir.glob("*.bin") if vdir.exists() else []:
            if f"h{res}/v/{f.name}" not in expected:
                f.unlink(); removed += 1
    ids_ok = {s.id for s in series}
    udir = DATA / "units" / "v"
    for d in udir.iterdir() if udir.exists() else []:
        if d.is_dir() and d.name not in ids_ok:
            _rmtree(d); removed += 1
    if removed:
        log(f"  removed {removed} stale files")

    # earlier layouts
    for f in (DATA / "boundaries").glob("*.geojson"):
        f.unlink()
    # old v1 layout
    for old in ("hex/h6/*.json", "hex/h7/*.json", "hex/h8/*.json"):
        for f in DATA.glob(old):
            if f.name != "manifest.json":
                f.unlink()

    if cfg.get("booths"):
        booths.sync(cfg, st)   # pins, catchments and per-AC details for every election
        _save_state(st)
    compute_breaks(series, st)
    _save_state(st)
    write_client_config(cfg, series, st)
    size = dir_size(SITE) / 1e6
    budget = cfg["variables"].get("budget_mb", 950)
    log(f"done in {time.time() - t0:.0f}s · site is {size:.0f} MB" + (f"  ⚠ over the {budget} MB budget" if size > budget else ""))
    return series


def _rmtree(d):
    """shutil.rmtree that also removes read-only entries: OneDrive marks its folders read-only
    (and robocopy keeps the flag), and Windows refuses to delete those."""
    def clear_and_retry(func, path, _exc):
        os.chmod(path, stat.S_IWRITE)
        func(path)
    shutil.rmtree(d, onerror=clear_and_retry)


def _write_unit_files(sid, agg):
    """units/v/<series>/<level>.json = {"y": [years], "v": [[value per unit id] per year]}.
    One small file per level: the India view only needs the 36-row state file. Official-table series
    may add "x" (ACs left out of a unit's value, per year) and, in the AC file, "e" (extra columns)."""
    d = DATA / "units" / "v" / sid
    d.mkdir(parents=True, exist_ok=True)
    for lvl in geo.LEVELS:
        out = {"y": agg["y"], "v": agg[lvl]}
        if lvl in agg.get("x", {}):
            out["x"] = agg["x"][lvl]
        if lvl == "ac" and agg.get("e"):
            out["e"] = agg["e"]
        (d / f"{lvl}.json").write_text(json.dumps(out, separators=(",", ":")))


def _split_old_unit_files():
    """Earlier builds wrote one file per series with every level; split them without recomputing."""
    udir = DATA / "units" / "v"
    for f in udir.glob("*.json") if udir.exists() else []:
        _write_unit_files(f.stem, json.loads(f.read_text()))
        f.unlink()


def compute_breaks(series, st):
    """All-India class breaks per published file (quantiles at i/9 above the minimum)."""
    st.setdefault("breaks", {})
    for s in series:
        for res, y, name in s.files():
            key = f"{res}/{name}"
            q = st["q"].get(f"{res}/{s.id}")
            if not q or st["breaks"].get(key, {}).get("sig") == st["bins"].get(f"{res}/{s.id}"):
                continue
            if s.type == "categorical" or s.breaks:   # categories need none; fixed breaks are used as given
                st["breaks"][key] = {"sig": st["bins"].get(f"{res}/{s.id}"), "b": [float(b) for b in s.breaks] if s.breaks else None}
                continue
            raw = (DATA / "hex" / f"h{res}" / "v" / name).read_bytes()
            v = hexes.decode(raw, q)   # a sparse file holds only its chunks: same distribution
            v = np.sort(v[~np.isnan(v)])
            br = []
            if len(v) and s.diverging:   # symmetric around 0
                a = np.abs(v[v != 0])
                qs = [float(f"{x:.5g}") for x in np.quantile(a, [0.1, 0.35, 0.6, 0.85])] if len(a) else []
                br = sorted({-x for x in qs} | set(qs))
            elif len(v):
                for qq in np.quantile(v[v > v[0]], [i / 9 for i in range(1, 9)]) if (v > v[0]).any() else []:
                    if not br or qq > br[-1] * (1 + 1e-9) + 1e-12:
                        br.append(float(f"{qq:.5g}"))
            st["breaks"][key] = {"sig": st["bins"].get(f"{res}/{s.id}"), "b": br}


def _decode_index(res, man, levels):
    """Rebuild (h3 order, unit ids) from an existing index.bin (used when only variables change)."""
    raw = (DATA / "hex" / f"h{res}" / "index.bin").read_bytes()
    starts, parents = man["start"], man["parents"]
    n = man["n"]
    codes = np.empty(n, np.uint16)
    ids = {k: np.empty(n, np.int16) for k in "sapd"}
    pids = np.empty(n, np.uint64)
    for k, p in enumerate(parents):
        a, b = starts[k], starts[k + 1]
        m = b - a
        off = 10 * a
        codes[a:b] = np.frombuffer(raw, "<u2", m, off)
        for j, key in enumerate("sapd"):
            ids[key][a:b] = np.frombuffer(raw, "<i2", m, off + 2 * m * (j + 1))
        pids[a:b] = int(p, 16)
    pres = res - levels
    x = (pids & ~np.uint64(0xF << 52)) | np.uint64(res << 52)
    for r in range(pres + 1, res + 1):
        s = np.uint64((15 - r) * 3)
        d = (codes.astype(np.uint64) >> np.uint64(3 * (res - r))) & np.uint64(7)
        x = (x & ~(np.uint64(7) << s)) | (d << s)
    return x, ids


def write_client_config(cfg, series, st):
    """site/config.json: everything the browser needs besides the data files."""
    cat_out = []
    units = None
    for s in series:
        d = s.to_client()
        if s.na_label and (s.units_table or {}).get("na_flag"):
            units = units or json.loads((DATA / "units.json").read_text(encoding="utf-8"))
            d["na_acs"] = official.flagged_acs(s.units_table, units, s.years)   # grey where missing
        d["q"] = {str(r): st["q"].get(f"{r}/{s.id}") for r in s.res_years}
        d["breaks"] = {str(r): {str(y): (st.get("breaks", {}).get(f"{r}/{s.bin_name(y)}") or {}).get("b")
                                for y in ys} for r, ys in s.res_years.items()}
        cat_out.append(d)
    groups = []
    for s in series:
        if s.group not in groups:
            groups.append(s.group)
    manifests = {}
    for res in cfg.resolutions:
        p = DATA / "hex" / f"h{res}" / "manifest.json"
        if p.exists():
            manifests[str(res)] = json.loads(p.read_text())["n"]
    chunks = {}
    for s in series:
        if s.sparse:
            chunks[s.dataset] = {str(r): st["chunks"].get(f"{s.dataset}/{r}") for r in s.res_years}
    client = {
        "version": time.strftime("%Y%m%d%H%M%S"),
        "site": cfg["site"], "defaults": cfg["defaults"], "hex": cfg["hex"],
        "boundaries": {k: cfg["boundaries"][k] for k in ("levels", "palette")},
        "palette": cfg["palettes"][cfg["boundaries"]["palette"]],
        "basemaps": cfg["basemaps"], "overlays": cfg["overlays"],
        "features": cfg["features"], "ui": cfg["ui"],
        "featured": [f for f in cfg["variables"].get("featured", []) if any(s.id == f for s in series)],
        "groups": groups, "variables": cat_out, "cells": manifests,
    }
    if chunks:
        client["chunks"] = chunks
    bc = booths.client_config(cfg, st, series)
    if bc:
        client["booths"] = bc   # sparse datasets: the index chunks in their files, in file order
    (SITE / "config.json").write_text(json.dumps(client, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    log(f"  config.json: {len(cat_out)} variables in {len(groups)} groups")
