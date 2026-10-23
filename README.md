# India Hex

**Live map: https://india-hex.github.io/India_Hex/**

India Hex is an interactive map of India's states, districts, Lok Sabha and Assembly constituencies,
with economic and land data at three sizes of H3 hexagon. It runs in any modern browser, on desktop
or phone.

## What's on the map

| Layer | Count |
|---|---|
| States and union territories | 36 |
| Districts (LGD) | 785 |
| Lok Sabha constituencies | 543 |
| Assembly constituencies | 4,119 |
| H6 hexagons (≈36 km² each) | 89,284 |
| H7 hexagons (≈5.2 km² each) | 624,978 |
| H8 hexagons (≈0.74 km² each) | 4,374,944 |

Each hexagon belongs to the constituency, district and state that contains its centre. Values for a
constituency, district or state are aggregated from its H8 hexagons.

## Data

53 variables, many of them yearly:

- **People:** population, 2010–2030 (2025 and 2030 are projections).
- **Economy:** night-time lights, 2012–2025.
- **Built environment:** built-up surface, volume, share and average building height, 2015, 2020
  and 2025, split into residential and non-residential.
- **Land cover:** trees, crops, built area, open land and water, 2017–2024; industrial land use.
- **Forest:** forest cover, forest loss, tree canopy and permanent water, 2012–2025.
- **Commerce:** points of interest in 16 categories (retail, food, finance, health, education,
  transport and more).
- **Property:** median sale and rent prices and listing counts, residential and commercial.

Sources: GHSL (population, built-up), NASA Black Marble (night lights), Esri 10 m Land Cover,
Hansen Global Forest Change, OpenStreetMap (POIs, industrial land) and property listing portals.
Basemaps: Esri World Imagery and OpenFreeMap / OpenStreetMap.

## What you can do

- **Explore by boundary:** click any state, district, Lok Sabha or Assembly constituency, or search
  by name or number.
- **Overlay hexagons** at H6, H7 or H8, for the selected place or for everything in view.
- **Colour the map** by any variable, as hexagons or whole constituencies:
  - play through the years;
  - show change between two years or values per km²;
  - use breaks relative to the view or the same for all of India.
- **Click a hexagon** for its own values and the constituencies it belongs to.
- **Read rankings:** each place shows its value, its rank within its state and across India, and how
  its constituencies compare.
- **Compare:** swipe between two years, variables or basemaps, pin places to see them side by side,
  or raise hexagons in 3D.
- **Switch map styles and labels:** Map, Satellite and Terrain, with roads, place names, POIs and
  buildings toggled on or off.
- **Find me:** your position, the H8 and H7 hexagons you're in, and their AC, PC and district.
- **Read the status bar:** a scale bar, the camera's height, and the latitude and longitude under the
  pointer (click to switch degrees-minutes-seconds and decimal; double-click to copy).
- **Measure** the length of a path, or the area and perimeter of a shape, along the Earth's surface
  (WGS84).
- **Export** the map as PNG, rankings as CSV, or hexagons as GeoJSON.
- **Share:** every view has its own link. The site works on phones and can be added to the home
  screen.

## Run it yourself

The site is built from a single settings file, `india_hex.yaml`, which controls basemaps, colours,
boundaries, variables and features.

```
pip install duckdb geopandas shapely h3 pandas numpy pyyaml
python server.py            # build and preview at http://localhost:8000
python server.py --list     # list every variable found in the source data
python server.py --deploy   # after any change: rebuild, push the code and update the live site
```

Building needs the source data (H3 parquet files and boundary files), which isn't included in this
repository. The published site is on the `gh-pages` branch.
