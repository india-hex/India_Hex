"""Booth cards and booth colours, as the browser computes them, against the source parquet files.

python tools/boothcard_check.py [--port 8011]   (serve the site first)

Runs the site's own js/booths.js in a headless browser over every booth of every election:
1. the card's leading party = the parquet's lead_code (ties too);
2. the card's margin = the parquet's margin_pm, where the parquet has that pair;
3. margin maps: the pin colour's sign agrees with the hexagon series: per AC, the booths' vote-weighted margin as
   coloured correlates with the official AC margin (> 0.9; about -1 when the sign is the wrong way round).
"""
import json
import sys
from pathlib import Path

import duckdb
import numpy as np
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from pipeline.booths import elections  # noqa: E402
from pipeline.config import SITE, find_data, load_config  # noqa: E402

PORT = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 8011
CC = json.loads((SITE / "config.json").read_text(encoding="utf-8"))
UNITS = json.loads((SITE / "data" / "units.json").read_text(encoding="utf-8"))
fails = []
JS = """async (id) => {
  const B = await import('./js/booths.js'); const cfg = await (await fetch('config.json')).json();
  const el = cfg.booths.elections.find((e) => e.id === id); const v = window.__v; const S = (await import('./js/data/shards.js'));
  S.initShards(cfg);
  const out = [];
  for (const ac of v) {
    const j = await (await fetch(`${S.base(el.shard)}data/booths/${id}/ac_${String(ac).padStart(3, '0')}.json`)).json();
    for (const r of j.booths) { const row = Object.fromEntries(j.booth_fields.map((f, i) => [f, r[i]])); const x = B.resultOf(el, row);
      out.push([row.uid, x.lead ? x.lead.code : null, x.margin, x.marginLabel || '']); }
  }
  const s = cfg.variables.filter((q) => q.id.startsWith(el.prefix) && q.id.endsWith('_margin_pp') && q.years.includes(el.year))[0];
  const sign = s && B.marginSign ? B.marginSign(el, { series: s }) : 1;
  return { out, sid: s ? s.id : null, sign };
}"""


def check(ok, msg):
    if not ok:
        fails.append(msg)
        print("  FAIL", msg)
    return ok


def pq_path(src, el):
    for p in (src / "booths" / f"{el}_booths.parquet", src / f"{el}_booths.parquet"):
        if p.exists():
            return p
    raise FileNotFoundError(el)


with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True)
    pg = b.new_page()
    pg.goto(f"http://127.0.0.1:{PORT}/css/app.css", wait_until="commit", timeout=120000)   # same origin, no map
    pg.goto(f"http://127.0.0.1:{PORT}/config.json", wait_until="commit", timeout=120000)
    pg.set_default_timeout(600000)
    for el, src, meta, _ in elections(load_config()):
        e = next(x for x in CC["booths"]["elections"] if x["id"] == el)
        acs = sorted(int(f.stem[3:]) for f in find_data(f"booths/{el}").glob("ac_*.json"))
        pg.evaluate("(v) => { window.__v = v; }", acs)
        r = pg.evaluate(JS, el)
        t = duckdb.sql(f"SELECT * EXCLUDE (geometry) FROM '{pq_path(Path(src), el)}'").df().set_index("uid")
        got = {int(u): (c, m, lab) for u, c, m, lab in r["out"]}
        check(set(got) == set(t.index.astype(int)), f"{el}: {len(got)} card booths, {len(t)} in the parquet")
        lead = t.lead_code.astype(float)
        bad = [u for u, (c, _, _) in got.items() if u in lead.index and np.isfinite(lead[u]) and c != int(lead[u])]
        check(not bad, f"{el}: card leader differs from lead_code at {len(bad)} of {len(got)} booths, e.g. uid {bad[:3]}")
        mp = t.margin_pm.astype(float) / 10
        wrong = [u for u, (_, m, _) in got.items() if u in mp.index and np.isfinite(mp[u]) and (m is None or abs(m - mp[u]) > 0.0501)]
        check(not wrong, f"{el}: card margin differs from margin_pm at {len(wrong)} booths, e.g. {[(u, got[u][1], mp[u]) for u in wrong[:2]]}")
        corr = None
        if r["sid"]:
            f = json.loads((SITE / "data/units/v" / r["sid"] / "ac.json").read_text(encoding="utf-8"))
            off = f["v"][f["y"].index(e["year"])]
            st = next(u["id"] for u in UNITS["state"] if u["key"] == e["state"])
            no = {u["no"]: u["id"] for u in UNITS["ac"] if u["st"] == st}
            g = t.assign(w=mp * r["sign"] * t.votes).groupby("ac_no").agg(w=("w", "sum"), v=("votes", "sum"))
            xy = [(w / v, off[no[int(a)]]) for a, w, v in zip(g.index, g.w, g.v) if v > 0 and int(a) in no and off[no[int(a)]] is not None]
            corr = float(np.corrcoef(np.array(xy).T)[0, 1])
            check(corr > 0.9, f"{el}: pins on {r['sid']} run against the hexagons (correlation {corr:.3f})")
        print(f"{el}: {len(got)} booths; margin {next(iter(got.values()))[2] or 'BJP side - INC side'}; {r['sid']} sign {r['sign']}, correlation {corr if corr is None else round(corr, 3)}")
    b.close()
# 4. alliance-lead maps: every tile alliance code reaches the hexagon series' category of the same alliance
for e in CC["booths"]["elections"]:
    s = next((v for v in CC["variables"] if v["id"] == f"{e['prefix']}bloc_lead" and e["year"] in v["years"]), None)
    if not s:
        continue
    if not check(e.get("bloc_lead"), f"{e['id']}: {s['id']} is mapped but the booth layers carry no alliance code table"):
        continue
    cats = {c["id"]: c for c in s["categories"]}
    for c in e["bloc_lead"]:
        if c["id"] == "tie":
            continue
        want = c["label"].replace("Others (no bloc)", "Others")
        got = cats.get(c["id"], cats.get("oth"))
        norm = lambda s: "".join(ch for ch in s.lower() if ch.isalnum())
        # the same alliance: its name is one of the map's names for it (an alliance renamed across years carries
        # all of them, "Democratic Front / UPA"), or the tile gives the bloc's code (LEFT_INC = left_inc)
        check(got is not None and (got["id"] == "oth" or norm(want) == norm(got["id"])
                                   or any(p == want or p.startswith(want) for p in got["label"].split(" / "))),
              f"{e['id']}: tile alliance {c['label']} would show as {got and got['label']}")
    print(f"{e['id']}: alliance pins {[(c['label'], cats.get(c['id'], cats.get('oth'))['label']) for c in e['bloc_lead'] if c['id'] != 'tie']}")
print(f"\n{'ALL PASS' if not fails else f'{len(fails)} FAILURES'}")
sys.exit(1 if fails else 0)
