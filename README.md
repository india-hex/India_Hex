# India Hex

A static, config-driven web map of India: **states, districts, Lok Sabha (PC) and Assembly (AC)
constituencies** on satellite imagery, plus **H3 hexagons at H6, H7 and H8**. Hexagons and units
can be coloured by any of 53 variables, which are discovered automatically from
`D:/economy_index_data/processed`. Features:

- year timeline and play button, change between years, per-km² values;
- swipe compare, 3D extrusion, pinned-place comparison;
- Google-style road, place and POI overlays;
- PNG, CSV and GeoJSON export;
- works on phones.

Everything is controlled from **`india_hex.yaml`**. The UI direction is editorial (Instrument Serif and
Inter, hairlines rather than cards), loosely modelled on https://electionlens.netlify.app/.

Status (2026-10-12): v2 runs locally and was verified in headless Chrome, desktop and phone.
**Not published yet.** That's waiting on the GitHub account and repository name (see §9).

---

## 1. Quick start

```
python server.py               # rebuild whatever changed, then serve http://localhost:8000 (next free port if busy)
python server.py --list        # every variable found in the source data, its years and resolutions
python server.py --build-only  # rebuild only
python server.py --force       # rebuild everything (~6 min; boundaries take ~5 of that)
python server.py --no-build    # serve only
python server.py --publish     # rebuild, then push site/ to GitHub Pages (india_hex.yaml → publish.repo)
```

- While serving, **saving `india_hex.yaml` triggers an incremental rebuild**. Display-only edits take about a second; then reload the page.
- Restart the server after changing *Python* code, because the watcher keeps the modules it imported at startup.
- Phones on the same Wi-Fi can open `http://<PC's IP>:<port>`.

Python requirements: `duckdb geopandas pyogrio shapely>=2.1 h3>=4 pandas numpy pyyaml`.
Tests also need `playwright`, which drives the installed Chrome.

---

## 2. Repository layout

```
maps/
  india_hex.yaml              THE config: site, sources, defaults, hex, boundaries + palettes, basemaps, overlays,
                          variables (discovery/exclude/H8/featured/overrides), features, ui, publish
  server.py               build + local server (gzip, HTTP Range, port fallback, yaml watcher) + --list + --publish
  pipeline/
    config.py             loads india_hex.yaml (Config: resolved source paths)
    catalog.py            variable discovery → Series (inference + overrides, H8/year policy, size estimate)
    geo.py                boundaries + units.json (joins, state normalisation, label points, simplification)
    hexes.py              hex index + variable binaries (H3 encoding, quantisation, streaming reader, aggregation)
    build.py              incremental orchestration (.build.json signatures), All-India breaks, config.json
    util.py               log, signatures
  site/                   THE WEBSITE (static; this folder is published)
    index.html            shell (sidebar, map stage, layers panel, tools, timeline, bases, compare UI)
    css/app.css           tokens (light/dark) + layout; mobile bottom sheet < 820 px
    js/main.js            boot + orchestration (cells → colours → views), selection, interactions, compare, exports
    js/store.js           reactive store + URL hash (de)serialisation
    js/lens.js            "lens" model: series/year/mode/density → numbers for hexes and units
    js/scales.js          ramps, relative / All-India scales, number formatting
    js/data/hexstore.js   manifest, ranged fetch of index chunks and variable slices, CellSets, findCell
    js/data/units.js      units.json + per-variable unit values
    js/map/view.js        MapView class: MapLibre layers + deck.gl H3HexagonLayer (interleaved)
    js/map/overlays.js    OpenFreeMap "liberty" layers grouped into roads/places/pois/buildings
    js/ui/panel.js        sidebar (hero, lens value + rank + histogram, key figures, land cover, rankings,
                          hex band, pinned comparison, about)
    js/ui/controls.js     layers panel, variable picker, legend, display drawer, toolbar, bases, timeline, compare bar
    js/ui/search.js       places + variables + H3 ids
    js/ui/exporter.js     PNG (framed with title/legend/credits), CSV, GeoJSON
    sw.js                 service worker (versioned data cache-first, shell network-first)
    manifest.webmanifest  installable PWA
    _headers              cache headers for Netlify/Cloudflare (GitHub Pages ignores it)
    config.json           GENERATED: india_hex.yaml display settings + variable catalog
    data/                 GENERATED (see §5)
  tools/shot.py           headless-Chrome screenshots + console errors
  tools/palette_preview.py renders boundary palettes on the live map → design/boundary_palettes.png
  design/                 palette comparison sheet
  .gitignore              generated data is never committed to the source branch
```

---

## 3. `india_hex.yaml`: what each section controls

| Section | Controls | Applies |
|---|---|---|
| `site` | title, tagline, author, GitHub link, data credit | instantly |
| `source` | where the source data and boundary files live | rebuild |
| `defaults` | opening level, hex mode (`off/auto/6/7/8`), scope, variable, basemap, overlays, scale, opacity, theme | instantly |
| `hex` | resolutions, `chunk_levels`, auto-resolution zoom thresholds, `auto_max_cells` (Auto with a selection), cell limits, 3D height | instantly (`chunk_levels`: full rebuild) |
| `boundaries` | active `palette`, level labels and label zooms, simplification tolerances | palette/labels instantly; tolerances rebuild boundaries |
| `palettes` | per palette, `dark` and `light` variants: per level `[colour, opacity, width@z8, width@z12, dash]`, plus selection, hex line, mask and label colours. `muted_earth` (chosen) and `ivory` are included | instantly |
| `basemaps` | raster tile sources (no keys), `dark` flag (picks the palette variant), `overlays_off` (overlays the basemap already draws) | instantly |
| `overlays` | vector style URL and groups (`source_layers` of the OpenMapTiles schema), raster overlays such as Esri labels | instantly |
| `variables` | datasets (file template, group, `pivot` for long tables, `fill_missing`), `auto_discover`, `skip_files`, `exclude` globs, `h8` list and `h8_years` policy, `budget_mb`, `featured`, per-variable `overrides` | rebuilds only the affected files |
| `features` | every optional feature switch (search, timeline, change, density, national view, compare, 3D, pins, exports, Google links, locate, colour-blind ramps) | instantly |
| `ui` | fonts, accent colour, sidebar width | instantly |
| `publish` | GitHub repo URL and branch for `--publish` | at publish |

Variable `overrides` fields: `label`, `unit`, `note`, `ramp`, `format`, `agg`, `density`, `dtype`,
`default_year` (for example population defaults to 2025 rather than the 2030 projection). Unknown
fields are ignored.

---

## 4. Source data (`D:/economy_index_data`)

The source is a separate, audited project. Read its READMEs (`processed/h7/README.txt`,
`processed/h8/README.txt`, `shapefiles/README.txt`, `outputs/ntl/ntl_index_README.md`) before
changing joins.

- **Cells:** H8 4,374,944 (≈0.74 km²), H7 624,978 (≈5.2 km²), H6 89,284 (≈36 km²). The night-lights file at each resolution holds the complete cell set plus its geography (`state, ac_key, pc_key, district_lgd_key, lat, lng`).
- **Variables:** every parquet in `processed/h{res}/<dataset>/` except `*MAPPED*` (point tables), `*preview*` and `*land_summary*` (copies of other files).
  - Wide files use `<name>_<YYYY>` columns.
  - POI aggregates only contain cells with POIs, so missing values are filled with 0.
  - Property aggregates are long, with one row per cell and segment; they're pivoted to `<segment>_<column>`.
- **Keys:**
  - `ac_key = STATE|AC_NO|AC_name`. Polygons join `outputs/ntl/ac_lookup.csv` on `State_source|AC_NO|AC_name`. 4,182 polygons give 4,095 ACs: `AC_NO=0` is dropped and multipart ACs are dissolved.
  - `pc_key = ST_NAME|PC_CODE|PC_NAME`, with `ORISSA` renamed to `ODISHA`.
  - `district_key` comes straight from the LGD gpkg.
- **States:** the site uses the 36 LGD states, made by dissolving districts.
  - Hex/PC state names are older: `DADRA & NAGAR HAVELI` and `DAMAN & DIU` are separate, and there's no `LADAKH`.
  - A cell's state is the prefix of its `district_lgd_key`, falling back to `STATE_ALIASES`.
  - A PC's or AC's state, and an AC's parent PC and district, are the mode over its H8 cells.
- **Cell-to-unit rule:** a cell belongs to the unit at its centre. H6 has no AC column, so the pipeline assigns each H6 cell the AC of the H8 cell at its centre. Small ACs can therefore have no H6 cells.
- **Licensing:** the H8 README calls these files internal; the property figures are portal content; OSM data is ODbL; GHSL, Hansen and Esri land cover are CC BY. The owner chose a **public** GitHub Pages site.

---

## 5. Generated data (`site/data/`) and formats

```
units.json                         {state|district|pc|ac: [{id,key,name,bbox,lp,h8,area,(no),(st),(pc),(d)}]}
units/v/<series>.json              {"y":[years|null], "<level>": [[value per unit id] per year]}  (from H8)
boundaries/<level>.json            GeoJSON simplified with coverage_simplify, top-level numeric id = unit id
                                   (.json on purpose: GitHub Pages gzips .json but not .geojson, 6.8 MB vs 1.7 MB)
detail/<level>/<id>.json           near-full-resolution geometry of one unit (fetched on selection)
hex/h<r>/manifest.json             {"res","chunk_res","n","parents":[...],"start":[...n_chunks+1]}
hex/h<r>/index.bin                 per chunk k, bytes [10*start[k], 10*start[k+1]):
                                     uint16 code[n] | int16 state[n] | int16 ac[n] | int16 pc[n] | int16 district[n]
hex/h<r>/v/<series>[_<year>].bin   one value per cell in index order: uint8 (shares) or uint16
.build.json                        build signatures, quantisation params, All-India breaks
```

### The H3 trick

An H3 index stores its digits in bits: digit *r* sits at shift `(15-r)*3`, the resolution at bits
52–55, and unused digits are set to 7. So a cell is fully described by its parent four levels up plus
a 12-bit code made of its four extra digits. The browser rebuilds the id with BigInt
(`hexstore.js: childId`) and draws it with deck.gl. No geometry is shipped. This was verified
against the source shapefiles: Sakri (ST) gives exactly the 458 H7 cells of `AC005_SAKRI_ST_h7.shp`.

### Ranged storage

Each chunk is contiguous in every file, so the browser fetches **only the chunks on screen, and
only for the variable being viewed**, using HTTP `Range` requests (`hexstore.js: fetchChunks`).
Adjacent chunks are merged into one request. If a server ignores `Range` and returns 200, the
whole file is cached and sliced instead.

- Adding a variable adds files and touches nothing else.
- The site is about 6,000 files (5,459 of them per-unit detail outlines) and 727 MB:
  - variable files: about 570 MB (H8 414, H7 138, H6 20; every year of the H8 series);
  - indexes: 51 MB (H8 alone 44 MB);
  - boundaries and detail: about 80 MB.

### Quantisation (`hexes.quant_params` / `encode`)

- **Shares:** `u8`, `q = round(v*250)`, with 255 meaning missing.
- **Other values:** `u16`, with 65535 meaning missing.
  - Integers up to 65,534 are stored exactly (`scale 1`).
  - Other non-negative values use a **sqrt transform**, `v = (q*scale)^2`, which gives high precision for small values in heavy-tailed data.
  - Negative values use a linear scale.
- Parameters are shared across years at each resolution, so years compare exactly. The client copy is in `config.json → variables[].q[res]`.

### Unit values (`units/v/`)

Unit values are always aggregated from H8 cells using `agg`:

- `sum` for counts and areas;
- `mean` for shares, means and heights (equal-area cells, so a plain mean);
- `median` for prices and rates.

India-level figures in the sidebar are computed from state values: sums, area-weighted means, or
the middle state for medians.

### All-India breaks

`build.compute_breaks` stores 8 quantiles (of values above the minimum) for each published file,
in `config.json → variables[].breaks[res][year]`. They're used when the scale is set to All-India.

---

## 6. Pipeline internals (`pipeline/build.py`)

The build runs in this order:

1. **Catalog:** `catalog.discover(cfg)`. It reads the parquet schema of each dataset's H8 file, groups `_YYYY` columns into series, applies `exclude`, infers fields from the name, then applies `overrides`.
   - Inference rules:
     - names containing `share` or starting `is_` → `u8`, pct, mean;
     - names containing `median`, `rate` or `price` → median;
     - names containing `mean`, `avg`, `height` or `pct` → mean;
     - everything else → sum with density.
   - `res_years` is every year at H6 and H7. At H8 it's only the series listed in `h8`, with the year policy (default: latest, every 5th year, and the first year).
   - If two datasets produce the same series id, the later one is prefixed with its dataset name.
2. **Geography:** rebuilt when the boundary sources or the H8 cell set change.
   - `geo.build_units`, then `geo.build_boundaries`.
   - `coverage_simplify` keeps shared edges identical.
   - The detail files use per-feature `simplify`.
3. **Index per resolution:** `hexes.build_index`. Cells are sorted by (parent, code).
   - When an index is rebuilt, every variable file at that resolution is invalidated, because unit ids may have changed.
4. **Variables, streamed:** `SeriesReader.column` reads **one column at a time**, relying on DuckDB keeping parquet row order.
   - Rows are aligned to index order with numeric H3 ids and `searchsorted` (`Aligner`).
   - This replaced a pandas-wide load that ran out of memory: 36 columns × 4.4M cells.
   - For each series, every year is loaded when its unit aggregates need rebuilding; otherwise only the published years.
5. **Stale files** that are no longer in the catalog are deleted. Then come the All-India breaks, `config.json` and the size report against `budget_mb`.

Each output's signature combines the source file's mtime and size with everything that shapes it:
columns, dtype, years, `fill_missing`, pivot, aggregation, and the index signature. Unchanged
outputs are skipped. A full variable rebuild takes about 100 s; display-only changes take about 1 s.

---

## 7. Front end

### Libraries

All are loaded from CDNs, with no build step:

- MapLibre GL 4.7.1;
- deck.gl 9.0.38 (`MapboxOverlay` interleaved and `H3HexagonLayer`; h3 is bundled inside it);
- h3-js 4.1.0 as a UMD global, used for polygonToCells, cellToLatLng and boundaries;
- Google Fonts (Instrument Serif and Inter);
- glyphs and sprite from OpenFreeMap (fallback: protomaps glyphs).

The app code is native ES modules with top-level `await`.

### State

State lives in a store (`store.js`). Subscribers declare the keys they react to, and microtask
batching merges several `set` calls into one notification. Keys:

```
level res(off|auto|6|7|8) scope(sel|view) sel{level,id} hex(h3 id) basemap overlays[] var year mode(value|change)
from density scale(relative|india) opacity threeD theme mask labels stateLines hexLines lineScale cbSafe
compare{kind:year|variable|basemap, value} comparePos pinned[] panel(place|compare|about) tab filter limit view[z,lat,lng]
```

The URL hash (`store.js: HASH_KEYS`) carries the shareable state using short names:

```
s l h sc v y md f pk k b o 3d x cmp at
```

Selections are stored by unit **key**, not id. Only non-default values are written. Example:
`#s=ac:MAHARASHTRA|5|Sakri (ST)&h=8&v=population&pk=1`. Pins and theme are kept in `localStorage`.

### Flow in `main.js`

- **`updateCells()`** decides which cells to show: their resolution and where they come from.
  - **auto** resolution: in view scope it follows `hex.auto_zoom`; with a selection it picks the finest resolution with at most 45,000 cells.
  - If the lens's year isn't published at a resolution, it **falls back** to a coarser one and says so in the hint.
  - **View scope** estimates the cell count from the chunks that actually exist (so sea doesn't count) and loads up to `max_cells_view` (260k). That's why all 89k H6 cells draw at country zoom.
  - **Selection scope** filters chunks by unit id and drops a resolution above `max_cells_selection`.
  - Result: a `CellSet` `{res, n, h[], s/a/p/d Int16Array, parts}`.
- **`recolour()`** calls `paint(view, lens)`:
  - `hexValues` gives raw values transformed by mode and density.
  - `hexScale` is relative (quantiles of the selected cells) or All-India (precomputed breaks).
  - The result is a `Uint8Array` of RGBA. Cells outside the selection are dimmed to 32%.
  - In 3D, elevations come from `position(v, sc)`.
  - With no hexes, it paints a unit choropleth through feature-state `fc`.
  - With compare on, the right view is painted too; comparing years uses the **same** scale on both sides.
- **Selection** shows the simplified outline at once, then swaps in `detail/<level>/<id>.json`. The mask is a world polygon with the unit as holes; holes are re-wound against the outer ring.
- **Clicks:**
  - A hex inside the selection (or any hex when nothing is selected) opens the hex band.
  - Otherwise the click selects the unit of the current level.
  - Clicking a state at the States level drills down to the last non-state level.
- **Picking:** `MapboxOverlay.pickObject` returns `info.index`. The deck data is a `Uint32Array` of indices, so `info.object` is undefined and `index` must be used.

### Map layer stack (`view.js`)

Bottom to top:

```
bg, bm-0 (basemap raster) | z-base | fill-state…fill-ac (choropleth + picking) | [deck 'hex' beforeId mask-fill] |
mask-fill | overlay lines/fills (roads, buildings, Esri labels raster) | z-lines | line-ac, line-pc, line-district, line-state |
sel-casing, sel-line, hexsel-line | unit-labels | overlay symbols (road names, places, POIs) | z-symbols
```

`z-*` are invisible background layers used as insertion anchors. Hex outlines are drawn in metres
(about 4% of the cell edge), so they disappear when zoomed out instead of hatching the map.
Overlay labels show English names first: `name:en`, then `name_en`, `name:latin`, `name`, but only
for fields that were names to begin with (road shields keep their route numbers).

### Other features

- **Compare** creates a second, non-interactive `MapView` in `#mapB`, clipped with `clip-path: inset(0 0 0 X%)` and camera-synced on `move`.
- **3D** sets `extruded` with pitch 52 and enables rotation.
- **Exports:** maps use `preserveDrawingBuffer: true`, so the PNG export draws the canvas or canvases plus title, legend and credits on a 2D canvas. Esri, OSM and OpenFreeMap all allow CORS.
- **Security:** the site loads only from known hosts.
  - A Content-Security-Policy `<meta>` tag lists the allowed script, tile, font and glyph hosts. Workers are allowed from `blob:` (MapLibre needs that).
  - CDN scripts and CSS carry `integrity` (SRI sha384) hashes; if you change a library version, recompute them.
  - There is no inline script; `js/sw-register.js` registers the service worker.
  - GitHub Pages serves everything over HTTPS.
- **Service worker** (skipped on localhost): data URLs carry `?v=<config.version>`, so they're immutable and served cache-first. Range requests bypass it.

### Mobile

Below 820 px:

- the sidebar becomes a bottom sheet (tapping the handle cycles peek, half and full);
- the Layers panel starts collapsed;
- the timeline sits under the panel;
- the overlay and basemap rows scroll horizontally.

---

## 8. Gotchas already hit

1. **MapLibre expressions:** `zoom` must be the outer `interpolate`; the hover `case` goes inside each stop.
2. **CSS `display` beats `[hidden]`:** fixed with a global `[hidden]{display:none!important}`.
3. **CARTO raster tiles** now need a key and come back watermarked. Esri and OSM are used instead.
4. **Python's `http.server`** has a backlog of 5 and no Range support. Use `server.py`.
5. **Fill-mask holes** need the opposite winding to the outer ring.
6. **`moveend` may not fire** if `fitBounds` doesn't move the camera. Use `afterMove()`.
7. **Memory:** loading wide parquet files into pandas ran out of memory. The reader now streams one column at a time.
8. **Windows networking:** another process can hold `127.0.0.1:8000` while ours binds `0.0.0.0:8000`, and the browser reaches theirs. `server.py` probes by connecting first and uses the next free port. `allow_reuse_address` is off.
9. **Windows console:** it's cp1252, so `server.py` reconfigures stdout to UTF-8.
10. **Startup order:** subscribers must be registered after the map and UI exist, and the URL selection is resolved straight into the initial state. Otherwise layers are touched before the style loads.
11. **The yaml watcher runs the code imported at startup.** After editing `pipeline/*.py`, restart the server.
12. **GitHub Pages gzips responses** and then serves ranges of the gzipped bytes. Browsers send `Accept-Encoding: identity` on Range fetches (it's in the Fetch spec), so this is safe.
13. **Zero-heavy and sparse data broke colouring.** In rural PCs, POI counts, dark-region night lights and property rates are mostly 0 or empty, so the old quantile scale returned `null` and `fills()` threw. Hexagons then didn't draw for some PCs only. Now:
    - the minimum value gets its own class, drawn faintly when it is a large block of zeros;
    - quantiles are taken over the values above it;
    - any non-empty set gets a scale;
    - the legend reports coverage ("data for 7 of 13,049 cells") or "No … data".

    Verified across 18 PCs × 4 variables with `tools`-style probes.
14. **Selecting a place used to darken the map.** That was the "dim outside selection" mask. It's now off by default (`defaults.dim_outside_selection`) and still available under Display options.
15. **H8 used to fall back to H7 for in-between years**, because only some years were published at H8. `h8_years: all` publishes every year of the H8 series, which brings the site to about 727 MB.

---

## 9. Publishing (GitHub Pages)

- `server.py --publish` writes `site/.nojekyll` and stages `site/` in a separate git dir (`.publish.git`).
  - It creates a **single orphan commit** and force-pushes it to `publish.branch` (default `gh-pages`) of `publish.repo`.
  - Data history therefore never accumulates, and only changed blobs upload.
- The first push sends about 510 MB.
- Git for Windows' credential manager opens a browser login on the first push.
- Then, once only: on GitHub, go to the repo's Settings → Pages → Source: branch `gh-pages`, folder `/ (root)`.
- The site URL becomes `https://<user>.github.io/<repo>/` and stays up as long as the repo exists.
- **Limits:** published sites up to 1 GB (`budget_mb: 950` warns), files under 100 MB (the largest is 44 MB), and Range requests are supported.
- The **source code** (main branch) is a normal repo of `maps/`. `.gitignore` keeps generated data out of it, along with personal notes (`maps_proj_README.md`).
- Commits are authored as `publish.git_name` with the account's GitHub noreply email, so neither a personal name nor the real email appears.
- **India Hex is independent of the Maharashtra delimitation project** (`../Delimitation`). It has its own folder, repository (`India_Hex`) and config. Don't share files between them.

---

## 10. Testing

```
python server.py --no-build --port 8001
PORT=8001 python tools/shot.py out sakri="s=ac:MAHARASHTRA|5|Sakri (ST)&h=8&v=population&pk=1"
PORT=8001 python tools/shot.py out hex="s=ac:MAHARASHTRA|5|Sakri (ST)&h=8&v=population!js:click1150,430;;wait3000"
W=390 H=844 PORT=8001 python tools/shot.py out phone="s=ac:MAHARASHTRA|5|Sakri (ST)&h=7&v=ntl_mean"
PORT=8001 python tools/palette_preview.py      # → design/boundary_palettes.png
```

`window.indiaHex = {S, view, cfg, ensureGeo}` is exposed for tests, for example
`indiaHex.S.set({var:'ntl_mean'})`.

These were verified:

- India, a state, a PC, a district and an AC;
- H6 across all of India (89,284 cells) and H8 for an AC;
- value, change and per km² modes;
- Relative and All-India scales;
- a hex click opening the hex band;
- 3D;
- year compare;
- the pinned table;
- PNG export;
- the phone layout;
- the live yaml reload.

---

## 11. Recipes

- **New source data:** drop the parquet files into `processed/h6|h7|h8/<folder>/`, with names containing `h6`/`h7`/`h8`. Run `python server.py`. Every numeric column appears automatically at H6 and H7. Add series to `variables.h8` to also publish them at H8. Check `--list` and the size report.
- **Nicer names or colours** for a variable: add `variables.overrides.<id>`.
- **Hide a variable:** add a glob to `variables.exclude`.
- **Basemap:** append to `basemaps` (raster `tiles`, `dark`, `overlays_off`).
- **Overlay group:** add to `overlays.groups` with OpenMapTiles `source_layers`, or to `overlays.raster`.
- **Palette:** add one under `palettes` and set `boundaries.palette`.
- **New UI feature:** add a state key, and a `features.<flag>` in yaml if it should be switchable. Subscribe in `main.js` (or the relevant `ui/*` module) to the keys it needs, and add a hash short name in `store.js` if it should be shareable.
- **New boundary level** (for example Census 2011 districts):
  1. `geo.load_boundaries` and `geo.build_units`.
  2. A cell id column in `hexes.build_index`. Note this changes the index layout: add 2 bytes per cell and update `decodeIndex`.
  3. `LEVEL_FIELD` and `units.js`.
  4. Palette entries and `boundaries.levels`.
