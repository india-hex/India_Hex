"""Interaction test for the status bar and the ruler (headless Chrome).

usage: python tools/ruler_test.py [base_url] [out_dir]      default http://127.0.0.1:$PORT/ , design/frames
Checks: coordinates on hover + DMS/decimal switch, a 3-point path finished by double-click, a closed
shape (area + perimeter), Backspace / Esc, hover back after Done, ruler surviving basemap switches,
card on one line (desktop) and clear of the bottom sheet (phone), no console errors.
"""
import os
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
BASE = sys.argv[1] if len(sys.argv) > 1 else f"http://127.0.0.1:{os.environ.get('PORT', 8000)}/"
OUT = Path(sys.argv[2] if len(sys.argv) > 2 else Path(__file__).resolve().parent.parent / "design" / "frames")
OUT.mkdir(parents=True, exist_ok=True)
fails = []


def check(name, ok, detail=""):
    print(f"  {'OK ' if ok else 'BAD'} {name}{f'  ({detail})' if detail else ''}")
    if not ok:
        fails.append(name)


def until(pg, js, timeout=15000):
    """Poll a JS predicate (wait_for_function with a string is blocked by the page's CSP)."""
    for _ in range(timeout // 200):
        if pg.evaluate(js):
            return True
        pg.wait_for_timeout(200)
    return False


CARD = "() => { const c = document.querySelector('#measureCard'); return c.hidden ? null : c.innerText; }"
FEATS = "() => (indiaHex.view.map.getSource('measure')._data.features || []).map(f => f.properties.k).join(',')"


def desktop(b):
    print("desktop 1600x900")
    pg = b.new_page(viewport={"width": 1600, "height": 900})
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("console", lambda m: errs.append(m.text) if m.type == "error" and "ERR_ABORTED" not in m.text else None)
    pg.goto(BASE + "#l=pc&h=off&at=8.5/19.2/73.6&b=satellite")
    until(pg, "() => !!document.querySelector('[data-tool=measure]') && !!document.querySelector('.sb-coord')")
    pg.wait_for_timeout(2500)

    # status bar
    pg.mouse.move(900, 450); pg.mouse.move(905, 452); pg.wait_for_timeout(400)
    sb = pg.evaluate("() => ({ t: document.querySelector('.sb-coord').innerText, dim: document.querySelector('#statusbar').classList.contains('dim'), scale: document.querySelector('.sb-lbl').innerText, cam: document.querySelector('.sb-cam').innerText })")
    check("coordinates under the pointer (DMS)", "°" in sb["t"] and "′" in sb["t"] and not sb["dim"], sb["t"])
    check("scale bar and camera height", bool(sb["scale"]) and sb["cam"].startswith("Camera:"), f"{sb['scale']} · {sb['cam']}")
    pg.click(".sb-coord"); pg.wait_for_timeout(500)
    dec = pg.evaluate("() => document.querySelector('.sb-coord').innerText")
    check("click switches to decimal", "′" not in dec and "° N" in dec, dec)
    pg.click(".sb-coord"); pg.wait_for_timeout(500)
    pg.mouse.move(1500, 880); pg.mouse.move(380, 450); pg.wait_for_timeout(300)  # leave the canvas
    check("pointer off the map: centre shown dimmed", pg.evaluate("() => document.querySelector('#statusbar').classList.contains('dim')"))
    ov = pg.evaluate("""() => { const a = document.querySelector('#statusbar').getBoundingClientRect(); const b = document.querySelector('.maplibregl-ctrl-attrib').getBoundingClientRect();
      return { overlap: !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top), a: [a.left, a.right], b: [b.left, b.right] }; }""")
    check("status bar clear of the attribution button", not ov["overlap"], str(ov))

    # ruler: 3-point path finished by double-click
    pg.click('[data-tool="measure"]'); pg.wait_for_timeout(300)
    check("tool button shows the on state", pg.evaluate("() => document.querySelector('[data-tool=measure]').classList.contains('on')"))
    pg.mouse.click(800, 450); pg.wait_for_timeout(250)
    pg.mouse.click(1000, 520); pg.wait_for_timeout(250)
    pg.mouse.dblclick(1100, 380); pg.wait_for_timeout(600)
    card = pg.evaluate(CARD)
    check("double-click finishes a 3-point path", card and "path of 3 points" in card, (card or "").replace("\n", " | "))
    check("no selection while measuring", pg.evaluate("() => indiaHex.S.get().sel === null"))
    one = pg.evaluate("() => document.querySelector('#measureCard').getBoundingClientRect().height")
    check("card on one line (desktop)", one < 64, f"{one:.0f}px")
    pg.wait_for_timeout(2500)
    pg.screenshot(path=str(OUT / "ruler_path.png"))

    # closed shape
    pg.mouse.click(780, 300); pg.wait_for_timeout(700)  # starts a new measurement
    pg.mouse.click(980, 300); pg.wait_for_timeout(250)
    pg.mouse.click(930, 430); pg.wait_for_timeout(250)
    pg.mouse.click(783, 302); pg.wait_for_timeout(600)  # within 12 px of the first point
    card = pg.evaluate(CARD)
    check("clicking the first point closes the shape", card and "area · perimeter" in card, (card or "").replace("\n", " | "))
    check("fill drawn", "fill" in pg.evaluate(FEATS))

    # survives basemap switches
    for bm in ("map", "satellite", "terrain"):
        pg.evaluate(f"() => indiaHex.S.set({{ basemap: '{bm}' }})"); pg.wait_for_timeout(1500)
        alive = pg.evaluate("() => !!indiaHex.view.map.getLayer('ms-fill') && indiaHex.view.map.getStyle().layers.slice(-1)[0].id === 'ms-lbl'")
        check(f"ruler on top after switching to {bm}", alive and "fill" in pg.evaluate(FEATS))
    pg.wait_for_timeout(3000)
    pg.screenshot(path=str(OUT / "ruler_area_terrain.png"))
    pg.evaluate("() => indiaHex.S.set({ basemap: 'satellite' })"); pg.wait_for_timeout(800)

    # keys
    pg.keyboard.press("Backspace"); pg.wait_for_timeout(300)
    card = pg.evaluate(CARD)
    check("Backspace reopens the closed shape first", card and "3 points" in card and "area" not in card, (card or "").replace("\n", " | "))
    pg.keyboard.press("Backspace"); pg.wait_for_timeout(300)
    check("Backspace removes the last point", "2 points" in (pg.evaluate(CARD) or ""))
    pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
    check("Esc clears", pg.evaluate("() => indiaHex.S.get().measuring") and "0 m" in (pg.evaluate(CARD) or ""))
    pg.keyboard.press("Escape"); pg.wait_for_timeout(400)
    check("Esc again leaves the tool", not pg.evaluate("() => indiaHex.S.get().measuring") and pg.evaluate(CARD) is None)
    check("double-click zoom back on", pg.evaluate("() => indiaHex.view.map.doubleClickZoom.isEnabled()"))

    # Done brings hover and selection back
    pg.click('[data-tool="measure"]'); pg.wait_for_timeout(300)
    pg.mouse.click(900, 600); pg.wait_for_timeout(200)
    pg.click('#measureCard [data-mc="done"]'); pg.wait_for_timeout(400)
    pg.mouse.move(950, 470); pg.mouse.move(955, 472); pg.wait_for_timeout(800)
    check("hover tooltip back after Done", pg.evaluate("() => !document.querySelector('#tip').hidden"))
    pg.mouse.click(955, 472); pg.wait_for_timeout(1200)
    check("selection back after Done", pg.evaluate("() => indiaHex.S.get().sel !== null"))
    check("no console errors", not errs, "; ".join(errs[:3]))
    pg.close()


def phone(b):
    print("phone 390x844")
    ctx = b.new_context(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True)
    pg = ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(BASE + "#l=pc&h=off&at=8.5/19.2/73.6&b=satellite")
    until(pg, "() => !!document.querySelector('[data-tool=measure]') && !!document.querySelector('.sb-coord')")
    pg.wait_for_timeout(2500)
    cam = pg.evaluate("() => getComputedStyle(document.querySelector('.sb-cam')).display")
    check("camera height hidden on a phone", cam == "none")
    check("touch: map centre shown, not dimmed", not pg.evaluate("() => document.querySelector('#statusbar').classList.contains('dim')"))
    pg.tap('[data-tool="measure"]'); pg.wait_for_timeout(700)
    for x, y in ((120, 200), (260, 260), (200, 330)):
        pg.touchscreen.tap(x, y); pg.wait_for_timeout(400)
    pg.touchscreen.tap(122, 202); pg.wait_for_timeout(700)
    card = pg.evaluate(CARD)
    check("phone: closed shape", card and "area" in card, (card or "").replace("\n", " | "))
    geo = pg.evaluate("""() => { const c = document.querySelector('#measureCard').getBoundingClientRect(); const s = document.querySelector('#side').getBoundingClientRect();
      const sb = document.querySelector('#statusbar').getBoundingClientRect();
      return { cardBottom: c.bottom, sheetTop: s.top, w: c.width, vw: innerWidth, sbBottom: sb.bottom, sbClearOfCard: sb.bottom <= c.top || c.bottom <= sb.top }; }""")
    check("card clear of the bottom sheet", geo["cardBottom"] <= geo["sheetTop"] + 0.5, str(geo))
    check("card fits the screen width", geo["w"] <= geo["vw"] - 20, f"{geo['w']:.0f}px")
    check("status bar clear of the card", geo["sbClearOfCard"])
    pg.wait_for_timeout(2500)
    pg.screenshot(path=str(OUT / "ruler_phone.png"))
    check("no console errors (phone)", not errs, "; ".join(errs[:3]))
    ctx.close()


with sync_playwright() as p:
    b = p.chromium.launch(channel="chrome", headless=True, args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
    desktop(b)
    phone(b)
    b.close()
print("ALL PASS" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
