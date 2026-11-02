"""Checks of the elections site's actual catchments (ELECTIONS_SITE brief §6, checks 2-4), against the
booth-catchment project's reference decoder, in a headless browser running the site's own decoder.

  decoder    20 random ACs per election: the browser's rows (location, cell, share), totals and cells
             equal the Python reference (split_catchments.decode_split + the cells layout), as exact
             position-weighted checksums plus the first and last 50 rows
  geometry   200 random cells: the drawn cell's centre (and the mean of its corners) lies within 1 m of
             the GHSL centroid (processed/grid/population/grid/*.parquet)
  totals     50 random locations per election: the browser's drawn total (sum share x cell electors) and
             exact total equal the reference within 0.01%

python tools/elections_site_check.py [--port 8002]   (serve the elections site first)
"""
import gzip
import importlib.util
import json
import math
import random
import sys
from pathlib import Path

sys.dont_write_bytecode = True   # the reference module lives in a read-only folder
import duckdb  # noqa: E402
import numpy as np  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
REF = Path("D:/booth_catchment/maps/booth_layers/split_catchments.py")
GRID = "D:/economy_index_data/processed/grid/population/grid/*.parquet"
PORT = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 8002
SITE = ROOT / "site_elections"
P = 1_000_000_007
rng = random.Random(20261102)
fails = []

spec = importlib.util.spec_from_file_location("split_catchments", REF)
ref = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ref)


def check(ok, msg):
    if not ok:
        fails.append(msg)
        print("  FAIL", msg)
    return ok


def wsum(a):
    """sum over k of (k+1) * a[k], mod P (a: integer array)."""
    k = np.arange(1, len(a) + 1, dtype=np.int64)
    return int((((k * (np.asarray(a, dtype=np.int64) % P)) % P).sum()) % P)


def py_ac(el, ac):
    d = SITE / "data" / "booths" / el / "split"
    cb = gzip.decompress((d / f"ac_{ac:03d}.cells.bin.gz").read_bytes())
    sb = gzip.decompress((d / f"ac_{ac:03d}.split.bin.gz").read_bytes())
    row0, col0, n = np.frombuffer(cb, "<i4", 2, 0).tolist() + np.frombuffer(cb, "<u4", 1, 8).tolist()
    dr = np.frombuffer(cb, "<u2", n, 12); dc = np.frombuffer(cb, "<u2", n, 12 + 2 * n)
    el_bits = np.frombuffer(cb, "<u4", n, 12 + 4 * n); kept = np.frombuffer(cb, "<u2", n, 12 + 8 * n)
    electors = np.frombuffer(cb, "<f4", n, 12 + 4 * n).astype(np.float64)
    loc, pix, s, tot = ref.decode_split(sb)
    locs = sorted(tot)
    tot_bits = np.array(locs and np.array([tot[x] for x in locs], dtype="<f4").view("<u4"), dtype=np.int64)
    return {
        "cells": {"row0": row0, "col0": col0, "n": n, "dr": wsum(dr), "dc": wsum(dc), "el": wsum(el_bits), "kept": wsum(kept)},
        "split": {"N": int(len(pix)), "m": len(locs), "loc": wsum(loc), "pix": wsum(pix), "share": wsum(s), "tot": wsum(tot_bits),
                  "head": [[int(a), int(b), int(c)] for a, b, c in zip(loc[:50], pix[:50], s[:50])],
                  "tail": [[int(a), int(b), int(c)] for a, b, c in zip(loc[-50:], pix[-50:], s[-50:])]},
        "_raw": (dr, dc, row0, col0, electors, loc, pix, s, tot),
    }


JS_SUMS = """async ([elId, ac]) => {
  const P = 1000000007;
  const ws = (a) => { let t = 0; for (let k = 0; k < a.length; k++) t = (t + ((k + 1) * (a[k] % P)) % P) % P; return t; };
  const el = window.indiaHex.cfg.booths.elections.find((e) => e.id === elId);
  const d = await window.indiaHexElections.acData(el, ac);
  if (!d) return null;
  const c = d.cells, s = d.split;
  const loc = new Uint32Array(s.pix.length);
  for (let i = 0; i < s.m; i++) loc.fill(s.locs[i], s.start[i], s.start[i + 1]);
  const bits = new Uint32Array(c.electors.buffer, c.electors.byteOffset, c.n);
  const tb = new Uint32Array(s.total.buffer, s.total.byteOffset, s.m);
  const rows = (a, b) => Array.from({ length: b - a }, (_, j) => [loc[a + j], s.pix[a + j], s.share[a + j]]);
  const N = s.pix.length;
  return {
    cells: { row0: c.row0, col0: c.col0, n: c.n, dr: ws(c.dr), dc: ws(c.dc), el: ws(bits), kept: ws(c.kept) },
    split: { N, m: s.m, loc: ws(loc), pix: ws(s.pix), share: ws(s.share), tot: ws(tb), head: rows(0, Math.min(50, N)), tail: rows(Math.max(0, N - 50), N) },
    ms: d.ms,
  };
}"""

JS_FP = """async ([elId, ac, locs]) => {
  const el = window.indiaHex.cfg.booths.elections.find((e) => e.id === elId);
  const d = await window.indiaHexElections.acData(el, ac);
  return locs.map((l) => { const f = window.indiaHexElections.footprintOf(d, l); return f ? [l, f.cells, f.drawn, f.exact] : [l, null, null, null]; });
}"""

JS_GEO = """(cells) => cells.map(([r, c]) => {
  const E = window.indiaHexElections;
  const ring = E.cellRing(r, c).slice(0, 4);
  const mean = [ring.reduce((t, p) => t + p[0], 0) / 4, ring.reduce((t, p) => t + p[1], 0) / 4];
  return [E.corner(r + 0.5, c + 0.5), mean, E.cellOf(...E.corner(r + 0.5, c + 0.5))];
})"""


def metres(a, b):
    dl = math.radians(b[0] - a[0]) * math.cos(math.radians((a[1] + b[1]) / 2))
    return 6371008.8 * math.hypot(dl, math.radians(b[1] - a[1]))


def main():
    cfg = json.loads((SITE / "config.json").read_text(encoding="utf-8"))
    els = [e["id"] for e in cfg["booths"]["elections"] if e.get("split")]
    timings = []
    geo_cells = []
    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome", headless=True, args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        pg = b.new_page(viewport={"width": 1280, "height": 800})
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.goto(f"http://127.0.0.1:{PORT}/?t=check")
        pg.wait_for_function("() => window.indiaHexElections && window.indiaHex && window.indiaHex.cfg", timeout=60000)
        for el in els:
            idx = json.loads((SITE / "data" / "booths" / el / "split" / "index.json").read_text())
            acs = sorted(int(a) for a in idx["acs"])
            pick = rng.sample(acs, min(20, len(acs)))
            ok_dec = 0
            fp_locs = []
            for ac in pick:
                py = py_ac(el, ac)
                js = pg.evaluate(JS_SUMS, [el, ac])
                if not check(js is not None, f"{el} AC {ac}: the browser found no split files"):
                    continue
                timings.append((el, ac, js["ms"]["fetch"], js["ms"]["decode"], py["split"]["N"]))
                same = js["cells"] == py["cells"] and all(js["split"][k] == py["split"][k] for k in ("N", "m", "loc", "pix", "share", "tot", "head", "tail"))
                if check(same, f"{el} AC {ac}: browser decode differs from the reference"):
                    ok_dec += 1
                dr, dc, row0, col0, electors, loc, pix, s, tot = py["_raw"]
                for _ in range(2):   # cells for the geometry check
                    k = rng.randrange(len(dr))
                    geo_cells.append((row0 + int(dr[k]), col0 + int(dc[k])))
                # locations for the totals check
                for l in rng.sample(sorted(tot), min(3, len(tot))):
                    m = loc == l
                    fp_locs.append((ac, l, float((s[m] / 65535.0 * electors[pix[m]]).sum()), float(tot[l]), int(m.sum())))
            # 50 random locations per election: drawn and exact totals
            fp_locs = rng.sample(fp_locs, min(50, len(fp_locs)))
            worst = 0.0
            by_ac = {}
            for ac, l, drawn, exact, n in fp_locs:
                by_ac.setdefault(ac, []).append((l, drawn, exact, n))
            for ac, items in by_ac.items():
                got = pg.evaluate(JS_FP, [el, ac, [x[0] for x in items]])
                for (l, drawn, exact, n), (_, cells, jd, je) in zip(items, got):
                    e1 = abs(jd - drawn) / max(drawn, 1e-9); e2 = abs(je - exact) / max(exact, 1e-9)
                    worst = max(worst, e1, e2)
                    check(cells == n and e1 <= 1e-4 and e2 <= 1e-4, f"{el} AC {ac} loc {l}: cells {cells}/{n}, drawn {jd}/{drawn}, exact {je}/{exact}")
            print(f"{el}: decoder {ok_dec}/{len(pick)} ACs identical; totals {len(fp_locs)} locations, worst difference {worst * 100:.6f}%")
        # geometry: 200 random cells against the GHSL centroids
        cells = rng.sample(geo_cells, min(200, len(geo_cells)))
        gids = ",".join(str(r * 10**6 + c) for r, c in cells)
        cent = {int(g): (lo, la) for g, lo, la in duckdb.sql(f"SELECT grid_id, centroid_lon, centroid_lat FROM '{GRID}' WHERE grid_id IN ({gids})").fetchall()}
        got = pg.evaluate(JS_GEO, [list(x) for x in cells])
        worst_c = worst_m = 0.0
        found = 0
        for (r, c), (ctr, mean, back) in zip(cells, got):
            g = cent.get(r * 10**6 + c)
            check(list(back) == [r, c], f"cell {r},{c}: forward Mollweide of its centre gives {back}")
            if g is None:
                continue
            found += 1
            worst_c, worst_m = max(worst_c, metres(ctr, g)), max(worst_m, metres(mean, g))
        check(found >= 150, f"geometry: only {found} of {len(cells)} cells found in the GHSL grid files")
        check(worst_c < 1 and worst_m < 1, f"geometry: centre {worst_c:.3f} m, corner mean {worst_m:.3f} m from the GHSL centroid")
        print(f"geometry: {found} cells against GHSL centroids: centre within {worst_c * 100:.2f} cm, corner mean within {worst_m * 100:.2f} cm; forward Mollweide returns every cell")
        check(not errs, f"page errors: {errs[:3]}")
        b.close()
    if timings:
        t = sorted(timings, key=lambda x: -(x[2] + x[3]))
        print(f"decode times: median {sorted(x[3] for x in timings)[len(timings) // 2]:.0f} ms, slowest {max(x[3] for x in timings):.0f} ms ({t[0][0]} AC {t[0][1]}, {t[0][4]:,} rows); fetch median {sorted(x[2] for x in timings)[len(timings) // 2]:.0f} ms (local)")
    print(f"\n{'ALL PASS' if not fails else f'{len(fails)} FAILURES'}")
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
