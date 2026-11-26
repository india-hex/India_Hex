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
| Polling booths (pins, zoom 10+) | 50,697–58,023 per Karnataka election; 90,712 Bihar 2025; 20,631–21,555 Punjab; 24,799 Assam 2016; 21,264 Kerala 2014 |
| Polling-location catchments (zoom 10+) | 32,746–55,541 per Karnataka election; 46,410 for Bihar 2025 |
| AC and PC election results | 178 Assembly and Lok Sabha elections in 24 states and UTs, 2004–2026 |

Each hexagon belongs to the constituency, district and state that contains its centre. Values for a
constituency, district or state are aggregated from its H8 hexagons, except for elections, where they
are the official results.

## Data

173 variables, many of them yearly, plus AC/PC results maps for 54 elections:

- **People:** population, 2010–2030 (2025 and 2030 are projections).
- **Economy:** night-time lights, 2012–2025.
- **Built environment:** built-up share and average building height, 2015, 2020 and 2025.
- **Land cover:** trees, crops, built area, open land and water, 2017–2024; industrial land use.
- **Forest:** forest cover, forest loss, tree canopy and permanent water, 2012–2025.
- **Commerce:** all points of interest and commercial ones.
- **Property:** the median residential sale rate per sq ft; and locality sale rates and rents from
  Housing.com, quarterly from 2021 (monthly in 2026), for Mumbai, Pune, Bengaluru, Gurugram,
  Ahmedabad, Hyderabad, Chennai and Kolkata.
- **Elections on hexagons:** Karnataka Lok Sabha 2014, 2019 and 2024 and Assembly 2018 and 2023;
  Bihar Assembly 2025; Punjab Assembly 2017 and Lok Sabha 2014; Maharashtra Assembly 2014; Assam
  Assembly 2016; Kerala and Tamil Nadu Lok Sabha 2014; West Bengal Assembly 2026. Vote shares of
  parties and alliances, the margin between the two main sides, turnout, votes, electors, and the
  leading party and alliance. Hexagon values are modelled from
  booth results (Form 20) spread over where voters live; constituency, district and state values are
  the official results. Hexagons are grey where most of their voters are in constituencies with
  incomplete booth data.
- **AC and PC results:** 178 Assembly and Lok Sabha elections in 24 states and union territories, wherever
  the election was held on the constituency map India Hex shows (2008 seats; 1976 in Assam; 1995 in Jammu &
  Kashmir): the winner, the top candidates, turnout, NOTA, party and alliance shares and
  the change since the previous election, on each constituency's card and as maps (winner, winning margin, vote
  shares). Lok Sabha results at Assembly level are segment leads (EVM votes); undivided Andhra Pradesh (2009,
  2014) covers today's Andhra Pradesh and Telangana.
- **Polling booths:** every booth with coordinates as a pin, and each polling location's catchment
  (the area where the people it serves live), with booth-level results: EVM votes from Form 20,
  without postal ballots. The number of booths is a variable too, and every card shows it.

Sources: GHSL (population, built-up), NASA Black Marble (night lights), Esri 10 m Land Cover,
Hansen Global Forest Change, OpenStreetMap (POIs, industrial land), property listing portals, and for
elections the Election Commission of India (results, Form 20), CEO Bihar (Form 20), TCPD Lokdhaba,
OpenCity and WorldPop. Booth locations: ECI polling-station locator (2017 scrape), Susewind 2014 (ECI
psleci, CC BY-NC-SA), the Maharashtra 2026 polling-station list, and np-supplied points.
Basemaps: Esri World Imagery and OpenFreeMap / OpenStreetMap.

## What you can do

- **Explore by boundary:** click any state, district, Lok Sabha or Assembly constituency, or search
  by name or number.
- **Overlay hexagons** at H6, H7 or H8, for the selected place or for everything in view.
- **Choose what the map shows** in an explorer (press `/`): grouped and searchable, or as a sortable
  table with each variable's years, resolution, coverage and source.
  - play through the years;
  - show change between two years (on a scale centred on zero) or values per km²;
  - use breaks relative to the view or the same for all of India; counts and shares start at zero.
- **Fold any panel away:** the side panel, legend, layers, tools and cards each fold, and `\` hides
  them all; on a phone the sheet swipes between three heights or away, and one button brings
  everything back.
- **Click a hexagon** for its own values and the constituencies it belongs to.
- **Zoom into a polling booth:** from zoom 10, switch on booth pins and catchments in Layers → Booths.
  Hover for a booth's result, click for its card: booth number, AC and PC, every party's votes, the
  leading party and margin, and the other booths at the same location. With **Footprint on click**,
  a booth's actual catchment is drawn: every 100 m cell shaded by the share of its electors that the
  model assigns to that polling location (from zoom 14, click any cell to see how it is split).
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

## Data repositories

The election data for each state is published from its own repository in this organisation
(`data-ka`, `data-br`, `data-pb`, `data-mh`, `data-as`, `data-kl`, `data-tn`, `data-wb`) and read by the map on demand. The
former elections map (`/Elections/`) now opens the same view here.

## Run it yourself

The site is built from a single settings file, `india_hex.yaml`, which controls basemaps, colours,
boundaries, variables and features.

```
pip install duckdb geopandas shapely h3 pandas numpy pyyaml
python server.py            # build and preview at http://localhost:8000
python server.py --list     # list every variable found in the source data
python server.py --deploy   # after any change: rebuild, push the code, update the data repositories and the site
```

Building needs the source data (H3 parquet files and boundary files), which isn't included in this
repository. The published site is on the `gh-pages` branch.
