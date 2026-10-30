# India Hex

**Live map: https://india-hex.github.io/India_Hex/**

India Hex is an interactive map of India's states, districts, Lok Sabha and Assembly constituencies,
with economic, land and election data at three sizes of H3 hexagon. It runs in any modern browser, on desktop
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
| Polling booths (pins, zoom 10+) | 50,697–58,023 per Karnataka election; 90,712 for Bihar 2025 |
| Polling-location catchments (zoom 10+) | 32,746–55,541 per Karnataka election; 46,410 for Bihar 2025 |

Each hexagon belongs to the constituency, district and state that contains its centre. Values for a
constituency, district or state are aggregated from its H8 hexagons, except for elections, where they
are the official results.

## Data

53 variables, many of them yearly:

- **People:** population, 2010–2030 (2025 and 2030 are projections).
- **Economy:** night-time lights, 2012–2025.
- **Built environment:** built-up share and average building height, 2015, 2020 and 2025.
- **Land cover:** trees, crops, built area, open land and water, 2017–2024; industrial land use.
- **Forest:** forest cover, forest loss, tree canopy and permanent water, 2012–2025.
- **Commerce:** all points of interest and commercial ones.
- **Property:** the median residential sale rate per sq ft; and locality sale rates and rents from
  Housing.com, quarterly from 2021 (monthly in 2026), for Mumbai, Pune, Bengaluru, Gurugram,
  Ahmedabad, Hyderabad, Chennai and Kolkata.
- **Elections:** Karnataka Lok Sabha 2014, 2019 and 2024 and Assembly 2018 and 2023; Bihar Assembly
  2025. Vote shares of parties and alliances, the margin between the two main sides, turnout, votes,
  electors and the leading party. Hexagon values are modelled from booth results (Form 20) spread over
  where voters live; constituency, district and state values are the official results. Karnataka
  hexagons are left grey where an Assembly constituency's booth data is incomplete.
- **Polling booths:** every booth with coordinates as a pin, and each polling location's catchment
  (the area where the people it serves live), with booth-level results: EVM votes from Form 20,
  without postal ballots. The number of booths is a variable too, and every card shows it.

Sources: GHSL (population, built-up), NASA Black Marble (night lights), Esri 10 m Land Cover,
Hansen Global Forest Change, OpenStreetMap (POIs, industrial land), property listing portals, and for
elections the Election Commission of India (results, Form 20), CEO Bihar (Form 20), TCPD Lokdhaba,
OpenCity and WorldPop.
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
- **Zoom into a polling booth:** from zoom 10, booth pins and their catchments appear with the
  election on the map (or switch them on in Layers). Hover for a booth's result, click for its card:
  booth number, AC and PC, every party's votes, the leading party and margin, and the other booths
  at the same location.
- **Stack layers:** hexagons, booth catchments (outline or fill), pins, and Assembly and Lok Sabha
  lines together, each line width adjustable.
- **Read rankings:** each place shows its value, its rank within its state and across India, and how
  its constituencies compare.
- **Compare:** swipe between two years, variables or basemaps, pin places to see them side by side,
  or raise hexagons in 3D.
- **Switch map styles and labels:** Map, Satellite and Terrain, with roads, place names, POIs and
  buildings toggled on or off.
- **Find me:** your position, the H8 and H7 hexagons you're in, and their AC, PC and district.
- **Read the status bar:** a scale bar, the camera's height, and the latitude and longitude under the
  pointer in decimal degrees (click to copy).
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
