"""Drive the locally served site in headless Chrome: screenshots + console errors.

Start the site first:  python serve.py            (port 8000; override with env PORT)
usage: python tools/shot.py <out_dir> <name>=<url-hash> [<name>=<url-hash> ...]

  <url-hash> is the part after '#', e.g.  sakri=s=ac:MAHARASHTRA|5|Sakri (ST)&l=ac&h=7
  Optional actions after load:  name=<hash>!js:<step>;;<step>;;...  where a step is
     wait<ms>        e.g. wait3000
     click<x>,<y>    mouse click at viewport pixel
     hover<x>,<y>    mouse move
     <javascript>    evaluated in the page
  Env W / H set the viewport (default 1600x900; use W=390 H=844 for phone).
Needs: pip install playwright  (uses the installed Chrome via channel="chrome", no browser download).
"""
import os, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
shots = [a.split("=", 1) for a in sys.argv[2:]]
W, H = int(os.environ.get("W", 1600)), int(os.environ.get("H", 900))
PORT = int(os.environ.get("PORT", 8000))

with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True,
                          args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
    for name, spec in shots:
        js = None
        if "!js:" in spec:
            spec, js = spec.split("!js:", 1)
        pg = b.new_page(viewport={"width": W, "height": H})
        logs = []
        pg.on("console", lambda m: logs.append(f"{m.type}: {m.text}") if m.type in ("error", "warning") else None)
        pg.on("pageerror", lambda e: logs.append(f"PAGEERROR: {e}"))
        pg.on("requestfailed", lambda r: logs.append(f"REQFAIL: {r.url[:120]} {r.failure}"))
        pg.goto(f"http://127.0.0.1:{PORT}/#{spec}")
        pg.wait_for_timeout(9000)
        if js:
            for part in js.split(";;"):
                if part.startswith("wait"):
                    pg.wait_for_timeout(int(part[4:]))
                elif part.startswith("click"):
                    x, y = map(int, part[5:].split(","))
                    pg.mouse.move(x - 5, y - 5); pg.mouse.move(x, y); pg.wait_for_timeout(400)
                    pg.mouse.click(x, y)
                elif part.startswith("hover"):
                    x, y = map(int, part[5:].split(","))
                    pg.mouse.move(x - 5, y - 5); pg.mouse.move(x, y)
                else:
                    pg.evaluate(part)
            pg.wait_for_timeout(7000)
        pg.screenshot(path=str(out / f"{name}.png"))
        print(f"== {name}: {len(logs)} issues")
        logs = [l for l in logs if "REQFAIL" not in l and "ERR_ABORTED" not in l]
        for l in logs[:15]:
            print("  ", l[:300])
        pg.close()
    b.close()
