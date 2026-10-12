"""Render candidate boundary palettes on the live map and compose a comparison sheet.

Needs the site running (python serve.py; env PORT, default 8000) and Playwright.
Output: design/boundary_palettes.png  (+ the individual frames in design/frames/)
"""
import json
import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import sync_playwright

PORT = int(os.environ.get("PORT", 8000))
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "design"
FRAMES = OUT / "frames"
FRAMES.mkdir(parents=True, exist_ok=True)

# Each palette: per basemap theme, per boundary: colour, opacity, width at z8 / z12, dash.
PALETTES = {
    "Current": {
        "note": "Bright, saturated: what the site uses today",
        "dark": {"state": ("#ffffff", .95, 1.8, 3, None), "pc": ("#d8b4fe", .85, 1.1, 2.2, None),
                 "district": ("#ffd166", .85, 1, 2, None), "ac": ("#7af0c4", .85, .8, 1.8, None),
                 "sel": "#ffd23f", "hex": "rgba(255,255,255,0.72)"},
        "light": {"state": ("#5b3a1e", .95, 1.8, 3, None), "pc": ("#6b4c9a", .85, 1.1, 2.2, None),
                  "district": ("#8a6d1f", .85, 1, 2, None), "ac": ("#1f7a5c", .85, .8, 1.8, None),
                  "sel": "#ffd23f", "hex": "rgba(28,28,28,0.55)"},
    },
    "A · Ivory hierarchy": {
        "note": "One calm ivory/graphite tone; type is told apart by weight, opacity and dashes",
        "dark": {"state": ("#fbf6ea", .92, 2.2, 3.4, None), "pc": ("#fbf6ea", .62, 1.3, 2.2, None),
                 "district": ("#fbf6ea", .55, 1.0, 1.8, [3, 2]), "ac": ("#fbf6ea", .32, .6, 1.3, None),
                 "sel": "#f3d48e", "hex": "rgba(255,255,255,0.30)"},
        "light": {"state": ("#34322d", .85, 2.0, 3.2, None), "pc": ("#34322d", .55, 1.2, 2.0, None),
                  "district": ("#34322d", .5, 1.0, 1.7, [3, 2]), "ac": ("#34322d", .3, .6, 1.2, None),
                  "sel": "#c0882b", "hex": "rgba(40,38,34,0.28)"},
    },
    "B · Muted earth": {
        "note": "Soft desaturated hues (parchment, lavender, sand, sage) plus weight",
        "dark": {"state": ("#f2e6cc", .9, 2.2, 3.4, None), "pc": ("#c7bfe0", .7, 1.3, 2.2, None),
                 "district": ("#e0c79a", .65, 1.0, 1.8, [3, 2]), "ac": ("#a9d3c6", .5, .6, 1.3, None),
                 "sel": "#f2c46d", "hex": "rgba(255,255,255,0.30)"},
        "light": {"state": ("#5f523f", .85, 2.0, 3.2, None), "pc": ("#6d6590", .7, 1.2, 2.0, None),
                  "district": ("#97784b", .7, 1.0, 1.7, [3, 2]), "ac": ("#4d7d74", .5, .6, 1.2, None),
                  "sel": "#b7791f", "hex": "rgba(40,38,34,0.28)"},
    },
    "C · Nordic slate": {
        "note": "Cool, quiet: white, powder blue, oat, sage",
        "dark": {"state": ("#f1f5f9", .9, 2.2, 3.4, None), "pc": ("#bcd2e8", .7, 1.3, 2.2, None),
                 "district": ("#d8c7b2", .62, 1.0, 1.8, [3, 2]), "ac": ("#a3bdb2", .5, .6, 1.3, None),
                 "sel": "#ffe1a1", "hex": "rgba(241,245,249,0.30)"},
        "light": {"state": ("#334155", .85, 2.0, 3.2, None), "pc": ("#4a6a8a", .7, 1.2, 2.0, None),
                  "district": ("#8a7862", .7, 1.0, 1.7, [3, 2]), "ac": ("#62877a", .5, .6, 1.2, None),
                  "sel": "#cf8a2c", "hex": "rgba(40,38,34,0.28)"},
    },
}

HASH = "s=ac:MAHARASHTRA|273|Kagal&l=ac&h=7&o=&b={bm}"
VIEW = {"center": [74.3, 16.3], "zoom": 9.25}


def style_js(p):
    js = ["async () => { const m=indiaHex.view.map;",
          "await Promise.all(['state','district','pc','ac'].map(indiaHex.ensureGeo));",
          "m.getSource('mask').setData({type:'FeatureCollection',features:[]});",
          "for (const l of ['state','pc','district','ac']) m.setLayoutProperty('line-'+l,'visibility','visible');",
          "for (const s of ['#lens','#bases','#timeline','#toast','#tools']) { const e=document.querySelector(s); if (e) e.style.display='none'; }"]
    for lvl in ("state", "pc", "district", "ac"):
        col, op, w8, w12, dash = p[lvl]
        js.append(f"m.setPaintProperty('line-{lvl}','line-color','{col}');")
        js.append(f"m.setPaintProperty('line-{lvl}','line-opacity',{op});")
        js.append(f"m.setPaintProperty('line-{lvl}','line-width',['interpolate',['linear'],['zoom'],5,{w8 * .5},8,{w8},12,{w12}]);")
        js.append(f"m.setPaintProperty('line-{lvl}','line-dasharray',{json.dumps(dash) if dash else '[1,0]'});")
    js.append(f"m.setPaintProperty('sel-line','line-color','{p['sel']}');")
    js.append("m.setPaintProperty('sel-line','line-width',2.6);")
    js.append(f"m.setPaintProperty('hex-line','line-color','{p['hex']}');")
    js.append(f"m.jumpTo({json.dumps(VIEW)});")
    js.append("}")
    return "\n".join(js)


def main():
    frames = {}
    with sync_playwright() as pw:
        b = pw.chromium.launch(channel="chrome", headless=True,
                               args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])
        for bm, theme in (("satellite", "dark"), ("light", "light")):
            pg = b.new_page(viewport={"width": 1400, "height": 860})
            key_hash = HASH.format(bm=bm).replace("Kagal", "Kagal")
            pg.goto(f"http://127.0.0.1:{PORT}/#{key_hash}")
            pg.wait_for_timeout(9000)
            for name, pal in PALETTES.items():
                pg.evaluate(style_js(pal[theme]))
                pg.wait_for_timeout(4500)
                f = FRAMES / f"{list(PALETTES).index(name)}_{bm}.png"
                pg.screenshot(path=str(f), clip={"x": 380, "y": 0, "width": 1020, "height": 860})
                frames[(name, bm)] = f
            pg.close()
        b.close()
    compose(frames)


def font(size, bold=False):
    for f in (["seguisb.ttf", "segoeuib.ttf"] if bold else ["segoeui.ttf"]) + ["arial.ttf"]:
        try:
            return ImageFont.truetype(f, size)
        except OSError:
            continue
    return ImageFont.load_default()


def compose(frames):
    tw, th = 680, 573  # thumb size (1020x860 scaled 2/3)
    pad, head, side = 24, 120, 300
    names = list(PALETTES)
    W = side + 2 * tw + 3 * pad
    H = head + len(names) * (th + pad) + pad
    sheet = Image.new("RGB", (W, H), "#f7f5f1")
    d = ImageDraw.Draw(sheet)
    d.text((pad, 22), "Boundary colour options", fill="#1c1a16", font=font(38, True))
    d.text((pad, 74), "Kagal AC (Maharashtra–Karnataka border) with H7 hexes · all four boundary types drawn at once",
           fill="#6b6558", font=font(19))
    d.text((side + pad, head - 30), "On satellite", fill="#4a453a", font=font(20, True))
    d.text((side + 2 * pad + tw, head - 30), "On light basemap", fill="#4a453a", font=font(20, True))
    for i, name in enumerate(names):
        y = head + i * (th + pad)
        pal = PALETTES[name]
        d.text((pad, y + 6), name, fill="#1c1a16", font=font(24, True))
        # wrap note
        words, line, ly = pal["note"].split(), "", y + 44
        for w in words:
            if d.textlength(line + " " + w, font=font(16)) > side - 2 * pad:
                d.text((pad, ly), line.strip(), fill="#6b6558", font=font(16)); ly += 22; line = ""
            line += " " + w
        d.text((pad, ly), line.strip(), fill="#6b6558", font=font(16))
        # line samples on dark + light chips
        ly += 40
        for theme, bg in (("dark", "#2b3a2f"), ("light", "#ecebe6")):
            d.rounded_rectangle((pad, ly, side - pad, ly + 150), 10, fill=bg)
            for j, (lvl, label) in enumerate((("state", "State"), ("pc", "Lok Sabha"), ("district", "District"), ("ac", "Assembly"))):
                col, op, w8, w12, dash = pal[theme][lvl]
                yy = ly + 22 + j * 30
                width = max(1, round(w12))
                rgb = Image.new("RGB", (1, 1), col).getpixel((0, 0))
                base = Image.new("RGB", (1, 1), bg).getpixel((0, 0))
                mix = tuple(round(base[k] + (rgb[k] - base[k]) * op) for k in range(3))
                x0, x1 = pad + 14, pad + 120
                if dash:
                    x = x0
                    while x < x1:
                        d.line((x, yy, min(x + dash[0] * width * 2, x1), yy), fill=mix, width=width)
                        x += (dash[0] + dash[1]) * width * 2
                else:
                    d.line((x0, yy, x1, yy), fill=mix, width=width)
                d.text((x1 + 14, yy - 11), label, fill="#f5f2ea" if theme == "dark" else "#34322d", font=font(15))
            ly += 162
        for k, (bm, x) in enumerate((("satellite", side + pad), ("light", side + 2 * pad + tw))):
            im = Image.open(frames[(name, bm)]).resize((tw, th), Image.LANCZOS)
            sheet.paste(im, (x, y))
    out = OUT / "boundary_palettes.png"
    sheet.save(out, optimize=True)
    print("wrote", out, sheet.size)


if __name__ == "__main__":
    main()
