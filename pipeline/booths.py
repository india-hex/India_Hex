"""Booth pins and catchments: copy the booth-catchment project's per-election files into site/data/booths/.

india_hex.yaml `booths.sources` lists folders holding, per election `<st>_<tag>` (e.g. ka_ge2019):
  <st>_<tag>_booth_layers.json   field dictionary, lead categories, counts, bbox (read here, not published)
  <st>_<tag>_booths.pmtiles      layer `booths`: one point per booth with coordinates (z10 only)
  <st>_<tag>_catchments.pmtiles  layer `catchments`: polling-location areas, uid = 2*loc + pop (z10 only)
  <st>_<tag>_details/ac_NNN.json per-AC booth and location rows, loaded when a booth is clicked
  <st>_<tag>_catchments.parquet  read for each location's populated / empty area (added to the details)

Published as data/booths/<st>_<tag>/{booths.pmtiles, catchments.pmtiles, ac_NNN.json}. Files are copied
(never linked: the drives differ and git would store links) when their sources' signature changes, and
anything else under data/booths/ is removed. config.json "booths" describes each election for the browser.
"""
import json
import os
import shutil
import stat
from pathlib import Path

import duckdb

from .config import DATA
from .util import file_sig, log, obj_sig

OUT = DATA / "booths"
HOUSE = {"AE": "Assembly", "GE": "Lok Sabha"}
# share columns of the detail rows, in display order: label and colour (election palette, D4)
PARTIES = {
    "bjp": ("BJP", "#E69F00"), "inc": ("INC", "#0072B2"), "jds": ("JD(S)", "#009E73"),
    "oth": ("Others incl. NOTA", "#999999"),
    "nda": ("NDA", "#E69F00"), "mgb": ("Mahagathbandhan", "#0072B2"), "jsp": ("Jan Suraaj", "#CC79A7"),
    "others": ("Others", "#999999"), "nota": ("NOTA", "#5f5f5f"),
}


def elections(cfg):
    """[(id, source folder, booth_layers.json content)] for every election under booths.sources."""
    out = []
    for src in (cfg.get("booths") or {}).get("sources") or []:
        for meta in sorted(Path(src).glob("*_booth_layers.json")):
            out.append((meta.name[: -len("_booth_layers.json")], Path(src), json.loads(meta.read_text(encoding="utf-8"))))
    return out


def _source_sig(el, src, meta):
    files = [src / f"{el}_booths.pmtiles", src / f"{el}_catchments.pmtiles", src / f"{el}_catchments.parquet",
             src / f"{el}_booth_layers.json"]
    det = src / f"{el}_details"
    return obj_sig([file_sig(f) for f in files], sorted((p.name, file_sig(p)) for p in det.glob("ac_*.json")))


def _areas(src, el):
    """{ac_no: [[loc, populated ha, empty ha], ...]} from the catchments parquet."""
    rows = duckdb.sql(f"""
        SELECT ac_no, loc_id, round(sum(CASE WHEN pop = 1 THEN area_ha ELSE 0 END), 1) AS a1,
               round(sum(CASE WHEN pop = 0 THEN area_ha ELSE 0 END), 1) AS a0
        FROM '{src / f"{el}_catchments.parquet"}' GROUP BY ac_no, loc_id ORDER BY ac_no, loc_id""").fetchall()
    out = {}
    for ac, loc, a1, a0 in rows:
        out.setdefault(int(ac), []).append([int(loc), float(a1), float(a0)])
    return out


def sync(cfg, st):
    """Copy changed elections into data/booths/<id>/ and remove anything stale. Returns the expected files."""
    st.setdefault("booths", {})
    expected = set()
    for el, src, meta in elections(cfg):
        d = OUT / el
        sig = _source_sig(el, src, meta)
        names = ["booths.pmtiles", "catchments.pmtiles"] + [p.name for p in sorted((src / f"{el}_details").glob("ac_*.json"))]
        expected |= {f"{el}/{n}" for n in names}
        if st["booths"].get(el) == sig and all((d / n).exists() for n in names):
            continue
        log(f"booths: {el}: copying tiles and {len(names) - 2} AC detail files")
        d.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src / f"{el}_booths.pmtiles", d / "booths.pmtiles")
        shutil.copyfile(src / f"{el}_catchments.pmtiles", d / "catchments.pmtiles")
        areas = _areas(src, el)
        for p in sorted((src / f"{el}_details").glob("ac_*.json")):
            j = json.loads(p.read_text(encoding="utf-8"))
            # each location's populated and empty area (catchment card: share of empty land)
            j["area_fields"] = ["loc", "populated_ha", "empty_ha"]
            j["areas"] = areas.get(int(j["ac_no"]), [])
            (d / p.name).write_text(json.dumps(j, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        st["booths"][el] = sig
    removed = 0
    if OUT.exists():
        for f in OUT.rglob("*"):
            if f.is_file() and f.relative_to(OUT).as_posix() not in expected:
                f.unlink()
                removed += 1
        for dd in sorted((p for p in OUT.rglob("*") if p.is_dir()), reverse=True):
            if not any(dd.iterdir()):
                os.chmod(dd, stat.S_IWRITE)   # OneDrive folders are read-only, which blocks rmdir
                dd.rmdir()
    st["booths"] = {k: v for k, v in st["booths"].items() if any(e.startswith(f"{k}/") for e in expected)}
    if removed:
        log(f"booths: removed {removed} stale files")
    return expected


def client_config(cfg, st, series):
    """config.json "booths": one entry per election, coupled to its election series by prefix and year."""
    bcfg = cfg.get("booths") or {}
    datasets = cfg["variables"]["datasets"]
    out = []
    for el, src, meta in elections(cfg):
        state = meta["state_name"].upper()
        house = HOUSE[meta["type"]]
        prefix = next((ds.get("prefix") for ds in datasets.values()
                       if ds.get("menu") == ["Elections", meta["state_name"], house] and ds.get("lead")), None)
        lay = meta["layers"]
        fields = {k: [f["name"] for f in lay[k]["tile_fields"]] for k in ("booths", "catchments")}
        det = meta["details"]
        parties = [c for c in det["booth_fields"] if c in PARTIES]
        out.append({
            "id": el, "state": state, "state_name": meta["state_name"], "house": house, "type": meta["type"],
            "year": int(meta["year"]), "label": f"{house} {meta['year']}", "prefix": prefix,
            "v": (st.get("booths") or {}).get(el, ""), "bbox": meta["bbox"],
            "lead": [{"code": c["code"], "id": c["value"], "label": c["label"], "color": c["colour"]} for c in meta["lead"]["categories"]],
            "fields": fields,
            "parties": [{"id": p, "label": PARTIES[p][0], "color": PARTIES[p][1]} for p in parties],
            "margin": meta["margin"]["definition"],
            "electors": "electors" in det["booth_fields"],   # Bihar: roll electors and turnout
            "flag_bits": det.get("flag_bits", {}),
            "counts": {k: meta["counts"].get(k) for k in ("booths", "booths_located_pins", "booths_unlocated", "locations_with_catchment")},
            "no_catchments": meta["counts"].get("acs_without_catchments", []),
        })
    return {"minzoom": bcfg.get("minzoom", 10), "elections": out} if out else None
