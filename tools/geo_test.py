"""Acceptance test for site/js/ui/geo.js against pyproj (WGS84).

Imports the module inside headless Chrome on a same-origin static file (no page boot needed) and
compares distances (within 1 cm), areas (within 0.001 %) and the decimal coordinate format.
usage: python tools/geo_test.py [base_url]     (default http://127.0.0.1:8000/; set PORT or pass a URL)
"""
import os
import sys

from playwright.sync_api import sync_playwright
from pyproj import Geod

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
BASE = sys.argv[1] if len(sys.argv) > 1 else f"http://127.0.0.1:{os.environ.get('PORT', 8000)}/"
G = Geod(ellps="WGS84")

DIST = [
    ("Mumbai CST → Pune station", (72.8355, 18.9398), (73.8743, 18.5289), 118615.60),
    ("Delhi → Chennai", (77.2295, 28.6129), (80.2838, 13.0500), 1751949.91),
    ("Kanyakumari → Leh", (77.5385, 8.0883), (77.5771, 34.1526), 2886173.78),
    ("Kolkata → Guwahati", (88.3639, 22.5726), (91.7362, 26.1445), 523018.87),
    ("same point", (77.0, 20.0), (77.0, 20.0), 0.0),
]
AREA = [
    ("box 77–78°E, 12–13°N", [(77, 12), (78, 12), (78, 13), (77, 13)], 12024.95e6),
    ("box 72–73°E, 28–29°N", [(72, 28), (73, 28), (73, 29), (72, 29)], 10850.43e6),
]
COORD = [((77.630956, 12.975372), "12.975372° N, 77.630956° E"), ((-73.9999999, -18.9999999), "19.000000° S, 74.000000° W")]

with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True)
    pg = b.new_page()
    pg.goto(BASE + "manifest.webmanifest")
    r = pg.evaluate("""async ([d, a, s]) => {
        const g = await import(new URL('js/ui/geo.js', location.href).href); // works under a sub-path (GitHub Pages)
        return {
          d: d.map(([n, p, q]) => g.distance(p, q)),
          a: a.map(([n, ring]) => g.ringArea(ring)),
          s: s.map(([pt]) => g.fmtDec(pt[0], pt[1])),
          f: [g.fmtLength(8.4), g.fmtLength(850), g.fmtLength(12430), g.fmtLength(1234567), g.fmtLength(5432),
              g.fmtArea(8500), g.fmtArea(4.21e6), g.fmtArea(1234e6)],
          gc: g.greatCircle([77.5385, 8.0883], [77.5771, 34.1526]).length,
        };
    }""", [[(n, list(p), list(q)) for n, p, q, _ in DIST], [(n, [list(x) for x in ring]) for n, ring, _ in AREA], [[list(pt)] for pt, _ in COORD]])
    b.close()

ok = True
print("distance (m)               site            pyproj         expected      diff")
for (n, p, q, exp), got in zip(DIST, r["d"]):
    ref = G.inv(p[0], p[1], q[0], q[1])[2]
    good = abs(got - exp) <= 0.01 and abs(got - ref) <= 0.01
    ok &= good
    print(f"  {'OK ' if good else 'BAD'} {n:24s} {got:14.2f} {ref:14.2f} {exp:14.2f}  {got - exp:+.4f}")
print("area (km²)")
for (n, ring, exp), got in zip(AREA, r["a"]):
    lons, lats = zip(*ring)
    ref = abs(G.polygon_area_perimeter(lons, lats)[0])
    rel = abs(got - exp) / exp
    good = rel <= 1e-5
    ok &= good
    print(f"  {'OK ' if good else 'BAD'} {n:24s} {got / 1e6:12.2f} {ref / 1e6:12.2f} {exp / 1e6:12.2f}  {rel * 100:.5f} %")
print("coordinates")
for (pt, exp), got in zip(COORD, r["s"]):
    good = got == exp
    ok &= good
    print(f"  {'OK ' if good else 'BAD'} {got}   (expected {exp})")
print("formats:", r["f"], "| great-circle vertices Kanyakumari→Leh:", r["gc"])
print("ALL PASS" if ok else "FAILURES")
sys.exit(0 if ok else 1)
