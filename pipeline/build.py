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
from .config import DATA, ROOT, SHARDS, SITE, data_dir
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


REDIRECT_JS = """// Forward an old link to the app, keeping its view (the URL hash) and adding the preset keys.
const add = %s;
const withBooth = %s;   // added too when the link selects a booth: its footprint needs the booth layers
const p = new URLSearchParams(location.hash.slice(1));
for (const [k, v] of Object.entries({ ...add, ...(p.has('bt') ? withBooth : {}) })) if (!p.has(k)) p.set(k, v);
const h = p.toString().replace(/%%7C/gi, '|').replace(/%%3A/gi, ':').replace(/%%2C/gi, ',').replace(/%%2F/gi, '/');
location.replace(new URL(%s, location.origin + %s).href + (h ? `#${h}` : ''));  // from deep links too
"""

REDIRECT_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <meta name="robots" content="noindex">
  <title>{title}</title>
  <link rel="canonical" href="{to}">
  <script src="{base}go.js"></script>
</head>
<body style="font: 15px/1.5 system-ui, sans-serif; margin: 3rem auto; max-width: 34rem; padding: 0 1rem; color: #222">
  <p>India Hex · Elections is now part of <a href="{to}">India Hex</a>: booth pins, catchments and footprints are in Layers → Booths.</p>
</body>
</html>
"""


def write_redirect(cfg):
    """A site that only forwards (`redirect` in its settings): index.html and 404.html (deep links) plus
    go.js, which keeps the URL hash. Everything else in the build folder is removed."""
    r = cfg["redirect"]
    repo = ((cfg.get("publish") or {}).get("repo") or "").rstrip("/").removesuffix(".git")
    base = f"/{repo.rsplit('/', 1)[-1]}/" if repo else "/"   # the old site's path, e.g. /Elections/
    files = {"index.html": REDIRECT_HTML.format(title=r.get("title", "Moved"), to=r["to"], base=base),
             "go.js": REDIRECT_JS % (json.dumps(r.get("add") or {}), json.dumps(r.get("add_with_booth") or {}), json.dumps(r["to"]), json.dumps(base))}
    files["404.html"] = files["index.html"]
    SITE.mkdir(parents=True, exist_ok=True)
    for f in SITE.rglob("*"):
        if f.is_file() and f.relative_to(SITE).as_posix() not in files and f.name != ".nojekyll":
            os.chmod(f, stat.S_IWRITE)
            f.unlink()
    for d in sorted((p for p in SITE.rglob("*") if p.is_dir()), reverse=True):
        if not any(d.iterdir()):
            os.chmod(d, stat.S_IWRITE)
            d.rmdir()
    for name, text in files.items():
        (SITE / name).write_text(text, encoding="utf-8")
    log(f"redirect: {SITE.name}/ forwards to {r['to']}")


def build(cfg, force=False, only_config=False):
    if cfg.get("redirect"):
        write_redirect(cfg)
        return []
    t0 = time.time()
    st = {} if force else _load_state()
    st.setdefault("bins", {}), st.setdefault("q", {}), st.setdefault("agg", {}), st.setdefault("index", {})
    st.setdefault("chunks", {})

    _sync_shell(cfg)
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
                files_ok = all((data_dir(s.shard) / "hex" / f"h{res}" / "v" / s.bin_name(y)).exists() for y in s.res_years.get(res, []))
                for y in s.res_years.get(res, []):
                    expected.add(f"{s.shard or ''}|h{res}/v/{s.bin_name(y)}")
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
    roots = [(None, DATA)] + [(d.name, d / "data") for d in (sorted(SHARDS.iterdir()) if SHARDS.exists() else []) if d.is_dir()]
    for shard, droot in roots:
        for res in cfg.resolutions:
            vdir = droot / "hex" / f"h{res}" / "v"
            for f in vdir.glob("*.bin") if vdir.exists() else []:
                if f"{shard or ''}|h{res}/v/{f.name}" not in expected:
                    os.chmod(f, stat.S_IWRITE)
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
    for name in shard_names(cfg, series):
        mb = dir_size(SHARDS / name) / 1e6 if (SHARDS / name).exists() else 0
        log(f"  shard {name}: {mb:.0f} MB" + (f"  ⚠ over the {budget} MB budget" if mb > budget else ""))
    return series


def shard_names(cfg, series=()):
    """Every data repository in use: dataset `shard` keys and booth sources' `shard`."""
    names = {s.shard for s in series if s.shard}
    names |= {b.get("shard") for b in booths.source_list(cfg) if b.get("shard")}
    return sorted(names)


SHELL_SKIP = ("config.json", ".nojekyll")


def _sync_shell(cfg):
    """A site built into its own folder (`output`, e.g. the elections site) gets the app itself: every
    file of `shell.from` (default site/) except its data and config.json, then the files of
    `shell.overlay` on top, then the `shell.html` edits ([old, new] pairs) applied to index.html.
    Files are written only when their bytes change; app files no longer in the source are removed."""
    sh = cfg.get("shell")
    if not sh:
        return
    src = ROOT / sh.get("from", "site")
    if src.resolve() == SITE.resolve():
        raise ValueError("shell.from is the output folder itself")
    files = {}
    for base in [src] + ([ROOT / sh["overlay"]] if sh.get("overlay") else []):
        for f in base.rglob("*"):
            rel = f.relative_to(base).as_posix()
            if f.is_file() and not rel.startswith("data/") and rel not in SHELL_SKIP:
                files[rel] = f
    written = 0
    for rel, f in files.items():
        data = f.read_bytes()
        if rel == "index.html" and sh.get("html"):
            text = data.decode("utf-8")
            for old, new in sh["html"]:
                if old not in text:
                    raise ValueError(f"shell.html: {old!r} is not in {f}")
                text = text.replace(old, new, 1)
            data = text.encode("utf-8")
        out = SITE / rel
        if not out.exists() or out.read_bytes() != data:
            out.parent.mkdir(parents=True, exist_ok=True)
            if out.exists():
                os.chmod(out, stat.S_IWRITE)
            out.write_bytes(data)
            written += 1
    stale = [f for f in SITE.rglob("*") if f.is_file() and (r := f.relative_to(SITE).as_posix()) not in files
             and not r.startswith("data/") and r not in SHELL_SKIP]
    for f in stale:
        os.chmod(f, stat.S_IWRITE)
        f.unlink()
    if written or stale:
        log(f"app files: {written} written, {len(stale)} removed (from {sh.get('from', 'site')}/{' + ' + sh['overlay'] if sh.get('overlay') else ''})")


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
            raw = (data_dir(s.shard) / "hex" / f"h{res}" / "v" / name).read_bytes()
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
    names = shard_names(cfg, series)
    if names:   # where each data repository is served, relative to the app (same origin on GitHub Pages)
        tmpl = (cfg.get("shards") or {}).get("url", "../{name}/")
        client["shards"] = {n: tmpl.format(name=n) for n in names}
    bc = booths.client_config(cfg, st, series)
    if bc:
        client["booths"] = bc   # sparse datasets: the index chunks in their files, in file order
    out = SITE / "config.json"
    text = json.dumps(client, ensure_ascii=False, separators=(",", ":"))
    try:  # nothing changed: keep the version stamp, so a rebuild reproduces the published file
        old = json.loads(out.read_text(encoding="utf-8"))
        new = json.loads(text)
        if {k: v for k, v in old.items() if k != "version"} == {k: v for k, v in new.items() if k != "version"}:
            client["version"] = old["version"]
            text = json.dumps(client, ensure_ascii=False, separators=(",", ":"))
    except (OSError, ValueError, KeyError):
        pass
    out.write_text(text, encoding="utf-8")
    log(f"  config.json: {len(cat_out)} variables in {len(groups)} groups")
