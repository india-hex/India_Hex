/* global maplibregl, deck, h3 */
// One map: MapLibre (basemap, overlays, boundaries, selection, labels) + a deck.gl layer for
// hexagons drawn on the GPU in the same WebGL context (interleaved, so hexes sit under the mask,
// road lines and labels). The main map and the compare map are both MapViews.
//
// Drawing order, bottom to top: basemap · unit fills · hexagons (deck, before `z-hex`) · booth
// catchments (before `z-catch`) · mask · overlays · boundary lines · selection · booth pins (before
// `unit-labels`) · unit labels · symbol overlays · booth numbers · ruler.
import { groupLayers } from './overlays.js';

const EMPTY = { type: 'FeatureCollection', features: [] };
const NOLOC = ['==', ['get', 'loc'], -1];
const NONE_RGBA = 'rgba(0,0,0,0)';
const PIN_R = (add = 0) => ['interpolate', ['linear'], ['zoom'], 10, 2.1 + add * 0.6, 12, 3.1 + add * 0.8, 14, 4.6 + add, 16, 6.4 + add, 18, 8.6 + add];
const BOOTH_LAYERS = ['catch-fill', 'catch-line', 'catch-hl', 'catch-sel', 'pin-halo', 'pin', 'pin-sel', 'pin-hl', 'pin-badge', 'pin-label'];
const LEVELS = ['state', 'district', 'pc', 'ac'];
const FALLBACK_GLYPHS = 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf';
const BASEMAP_FALLBACK = ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}'];

function signedArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  return a;
}

/** World polygon with the selected unit cut out (holes wound opposite to the outer ring). */
function maskFor(feature) {
  const world = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]];
  const g = feature.geometry;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  const ws = Math.sign(signedArea(world));
  const holes = polys.map((p) => (Math.sign(signedArea(p[0])) === ws ? [...p[0]].reverse() : p[0]));
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [world, ...holes] } };
}

export class MapView {
  constructor(container, { cfg, vs, interactive = true, view }) {
    this.cfg = cfg;
    this.vs = vs;
    this.dark = true;
    this.lineScale = 1;
    this.map = new maplibregl.Map({
      container,
      style: {
        version: 8,
        glyphs: vs?.glyphs || FALLBACK_GLYPHS,
        ...(vs?.sprite ? { sprite: vs.sprite } : {}),
        sources: {},
        layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0d1117' } }],
      },
      ...view,
      interactive,
      minZoom: 3,
      maxZoom: 18.5,
      maxPitch: 70,
      // tilt and rotate are always free: right-drag / ctrl-drag on desktop, two fingers on touch
      dragRotate: true,
      pitchWithRotate: true,
      attributionControl: interactive ? { compact: true } : false,
      preserveDrawingBuffer: true, // PNG export
      fadeDuration: 150,
    });
    this.overlay = new deck.MapboxOverlay({ interleaved: true, layers: [] });
    this.map.addControl(this.overlay);
    this.ready = new Promise((resolve) => this.map.on('load', () => { this._setup(); resolve(); }));
    // one count badge per polling location: mark its first booth whenever pin tiles arrive
    this.map.on('sourcedata', (e) => {
      if (!this.boothEl || e.sourceId !== `bt-${this.boothEl}-booths` || !e.isSourceLoaded) return;
      clearTimeout(this._firstT);
      this._firstT = setTimeout(() => this._markFirstPins(), 80);
    });
    this.hexLayerProps = null;
  }

  _setup() {
    const m = this.map;
    const anchor = (id) => m.addLayer({ id, type: 'background', layout: { visibility: 'none' }, paint: {} });
    for (const l of LEVELS) m.addSource(`b-${l}`, { type: 'geojson', data: EMPTY, tolerance: 0.3 });
    for (const s of ['mask', 'sel', 'hexsel', 'labels', 'here']) m.addSource(s, { type: 'geojson', data: EMPTY });

    anchor('z-base');
    for (const l of LEVELS) {
      m.addLayer({
        id: `fill-${l}`, type: 'fill', source: `b-${l}`, layout: { visibility: 'none' },
        paint: {
          'fill-color': ['coalesce', ['feature-state', 'fc'],
            ['case', ['boolean', ['feature-state', 'hover'], false], 'rgba(242,196,109,0.16)', 'rgba(0,0,0,0)']],
          'fill-opacity': 0.72,
        },
      });
    }
    anchor('z-hex'); // hexagons go just below this (deck re-inserts its layer before it on every update)
    anchor('z-catch'); // booth catchments: above the hexagons, below the mask and lines
    m.addLayer({ id: 'mask-fill', type: 'fill', source: 'mask', paint: { 'fill-color': 'rgba(0,0,0,0.4)' } });
    anchor('z-lines');
    m.addSource('acd', { type: 'geojson', data: EMPTY });
    for (const l of ['ac', 'pc', 'district', 'state']) {
      m.addLayer({ id: `line-${l}`, type: 'line', source: `b-${l}`, layout: { visibility: 'none', 'line-join': 'round' }, paint: {} });
      // detailed AC outlines in view while booth layers are on (the national layer is simplified)
      if (l === 'ac') m.addLayer({ id: 'line-acd', type: 'line', source: 'acd', layout: { visibility: 'none', 'line-join': 'round' }, paint: {} });
    }
    m.addLayer({ id: 'sel-casing', type: 'line', source: 'sel', layout: { 'line-join': 'round' }, paint: { 'line-color': 'rgba(0,0,0,0.45)', 'line-width': 6, 'line-blur': 3 } });
    m.addLayer({ id: 'sel-line', type: 'line', source: 'sel', layout: { 'line-join': 'round' }, paint: { 'line-width': 2.6 } });
    m.addLayer({ id: 'hexsel-line', type: 'line', source: 'hexsel', paint: { 'line-color': '#7dd3fc', 'line-width': 3 } });
    // "you are here": accuracy circle, the H7 cell around you (dashed) and the dot
    m.addLayer({ id: 'here-acc', type: 'fill', source: 'here', filter: ['==', ['get', 'k'], 'acc'], paint: { 'fill-color': '#2f7de1', 'fill-opacity': 0.12 } });
    m.addLayer({ id: 'here-acc-line', type: 'line', source: 'here', filter: ['==', ['get', 'k'], 'acc'], paint: { 'line-color': '#2f7de1', 'line-width': 1, 'line-opacity': 0.6 } });
    m.addLayer({ id: 'here-h7', type: 'line', source: 'here', filter: ['==', ['get', 'k'], 'h7'], paint: { 'line-color': '#7dd3fc', 'line-width': 1.6, 'line-dasharray': [2, 1.5] } });
    m.addLayer({ id: 'here-dot', type: 'circle', source: 'here', filter: ['==', ['get', 'k'], 'dot'], paint: { 'circle-radius': 7, 'circle-color': '#2f7de1', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5 } });
    m.addLayer({
      id: 'unit-labels', type: 'symbol', source: 'labels',
      layout: {
        'text-field': ['get', 'n'],
        'text-font': [this.vs ? 'Noto Sans Italic' : 'Noto Sans Medium'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 4, 10.5, 8, 12, 12, 14],
        'text-max-width': 8, 'text-padding': 6, 'symbol-sort-key': ['get', 'r'], 'text-letter-spacing': 0.02,
      },
      paint: { 'text-halo-width': 1.4 },
    });
    anchor('z-symbols');

    // Overlays: vector groups (roads / places / POIs / buildings) and raster ones.
    this.ovGroups = {};
    if (this.vs?.source) {
      m.addSource('ov', this.vs.source);
      this.ovGroups = groupLayers(this.vs, this.cfg.overlays.groups);
      for (const layers of Object.values(this.ovGroups)) {
        for (const L of layers) {
          try { m.addLayer(L, L.type === 'symbol' ? 'z-symbols' : 'z-lines'); } catch (e) { /* layer uses unsupported paint */ }
        }
      }
    }
    for (const [id, r] of Object.entries(this.cfg.overlays.raster || {})) {
      m.addSource(`ovr-${id}`, { type: 'raster', tiles: r.tiles, tileSize: 256, maxzoom: r.maxzoom || 19 });
      m.addLayer({ id: `ovr-${id}`, type: 'raster', source: `ovr-${id}`, layout: { visibility: 'none' } }, 'z-lines');
    }
  }

  // ---- basemap / theme / overlays --------------------------------------------------------------
  /**
   * Raster basemap (`tiles`) or the vector style (`vector: true`: OpenFreeMap liberty, whose
   * background/land/roads go under the data and whose labels go on top).
   */
  setBasemap(bm) {
    const m = this.map;
    const style = m.getStyle();
    for (const l of style.layers) if (l.id.startsWith('bm-') || l.id.startsWith('bmv-')) m.removeLayer(l.id);
    for (const s of Object.keys(style.sources)) if (s.startsWith('bm-')) m.removeSource(s);
    if (bm.vector && this.vs?.source) {
      for (const L of this.vs.style.layers) {
        if (L.source && L.source !== this.vs.sourceId) continue; // skip the low-zoom raster relief
        const layout = { ...(L.layout || {}) };
        if (JSON.stringify(layout['text-field'] || '').includes('name')) layout['text-field'] = ['coalesce', ['get', 'name:en'], ['get', 'name_en'], ['get', 'name:latin'], ['get', 'name']];
        const layer = { ...L, id: `bmv-${L.id}`, layout, ...(L.source ? { source: 'ov' } : {}) };
        try { m.addLayer(layer, L.type === 'symbol' ? 'z-symbols' : 'z-base'); } catch (e) { /* unsupported layer */ }
      }
    } else {
      const tiles = bm.tiles || BASEMAP_FALLBACK;
      m.addSource('bm-0', { type: 'raster', tiles, tileSize: 256, maxzoom: bm.maxzoom || 19, attribution: bm.attribution || '' });
      m.addLayer({ id: 'bm-0', type: 'raster', source: 'bm-0', paint: { 'raster-fade-duration': 150 } }, 'z-base');
    }
    this.dark = !!bm.dark;
    this.applyPalette();
  }

  /** Dot + accuracy circle + the H7 cell around a position (null clears). */
  setHere(here) {
    if (!here) { this.map.getSource('here').setData(EMPTY); return; }
    const { lat, lng, acc, h7 } = here;
    const r = Math.max(acc || 0, 15);
    const ring = [];
    for (let i = 0; i <= 64; i++) {
      const a = (i / 64) * 2 * Math.PI;
      ring.push([lng + (r / (111320 * Math.cos((lat * Math.PI) / 180))) * Math.cos(a), lat + (r / 110540) * Math.sin(a)]);
    }
    const feats = [
      { type: 'Feature', properties: { k: 'acc' }, geometry: { type: 'Polygon', coordinates: [ring] } },
      { type: 'Feature', properties: { k: 'dot' }, geometry: { type: 'Point', coordinates: [lng, lat] } },
    ];
    if (h7) {
      const b = h3.cellToBoundary(h7, true); b.push(b[0]);
      feats.push({ type: 'Feature', properties: { k: 'h7' }, geometry: { type: 'Polygon', coordinates: [b] } });
    }
    this.map.getSource('here').setData({ type: 'FeatureCollection', features: feats });
  }

  get pal() { return this.cfg.palette[this.dark ? 'dark' : 'light']; }

  applyPalette() {
    const m = this.map;
    const p = this.pal;
    for (const l of LEVELS) {
      const [col, op, w8, w12, dash] = p[l];
      const k = this.lw?.[l] ?? 1; // the user's width multiplier for this level (Layers panel)
      const hw = (w) => ['case', ['boolean', ['feature-state', 'hover'], false], w * k + 1.4, w * k];
      for (const id of l === 'ac' ? ['line-ac', 'line-acd'] : [`line-${l}`]) {
        m.setPaintProperty(id, 'line-color', col);
        m.setPaintProperty(id, 'line-opacity', Math.min(1, op * this.lineScale));
        m.setPaintProperty(id, 'line-width', ['interpolate', ['linear'], ['zoom'], 4, hw(w8 * 0.45), 8, hw(w8), 12, hw(w12), 16, hw(w12 * 1.3)]);
        m.setPaintProperty(id, 'line-dasharray', dash && dash.length ? dash : [1, 0]);
      }
    }
    m.setPaintProperty('sel-line', 'line-color', p.selection);
    m.setPaintProperty('mask-fill', 'fill-color', p.mask);
    m.setPaintProperty('unit-labels', 'text-color', p.label);
    m.setPaintProperty('unit-labels', 'text-halo-color', p.label_halo);
    if (this.boothEl) this._paintBooths();
  }

  setLineScale(f) { this.lineScale = f; this.applyPalette(); }

  /** Width multipliers per level, e.g. {ac: 1.6, pc: 2} (1 = the palette's width). */
  setLineWidths(lw) { this.lw = { ...lw }; this.applyPalette(); }

  setOverlays(on) {
    for (const [g, layers] of Object.entries(this.ovGroups)) {
      for (const L of layers) if (this.map.getLayer(L.id)) this.map.setLayoutProperty(L.id, 'visibility', on.includes(g) ? 'visible' : 'none');
    }
    for (const id of Object.keys(this.cfg.overlays.raster || {})) {
      this.map.setLayoutProperty(`ovr-${id}`, 'visibility', on.includes(id) ? 'visible' : 'none');
    }
  }

  // ---- boundaries ------------------------------------------------------------------------------
  setBoundaryData(level, fc) { this.map.getSource(`b-${level}`).setData(fc); }

  /** The active level fills and draws its lines; `lines` lists other levels whose lines show too. */
  setLevel(level, stateLines, lines = []) {
    for (const l of LEVELS) {
      const on = l === level || (l === 'state' && stateLines) || lines.includes(l) ? 'visible' : 'none';
      this.map.setLayoutProperty(`fill-${l}`, 'visibility', l === level ? 'visible' : 'none');
      this.map.setLayoutProperty(`line-${l}`, 'visibility', on);
      if (l === 'ac') this.map.setLayoutProperty('line-acd', 'visibility', on);
    }
  }

  /**
   * Detailed outlines of these ACs replace their simplified national lines (features: GeoJSON with
   * numeric id = AC id). An empty list restores the national layer.
   */
  setAcDetail(features) {
    const ids = features.map((f) => f.id);
    this.map.getSource('acd').setData({ type: 'FeatureCollection', features });
    this.map.setFilter('line-ac', ids.length ? ['!', ['in', ['id'], ['literal', ids]]] : null);
  }

  setFillOpacity(op) { for (const l of LEVELS) this.map.setPaintProperty(`fill-${l}`, 'fill-opacity', op); }

  /** colours: Map(unitId -> css colour) or null to clear. */
  setUnitColours(level, colours) {
    const src = `b-${level}`;
    this.map.removeFeatureState({ source: src });
    if (colours) for (const [id, c] of colours) this.map.setFeatureState({ source: src, id }, { fc: c });
  }

  setUnitHover(level, id, on) {
    if (id == null) return;
    this.map.setFeatureState({ source: `b-${level}`, id }, { hover: on });
  }

  setSelection(feature, mask) {
    this.map.getSource('sel').setData(feature || EMPTY);
    this.map.getSource('mask').setData(feature && mask ? maskFor(feature) : EMPTY);
  }

  setHexSelection(h3id) {
    if (!h3id) { this.map.getSource('hexsel').setData(EMPTY); return; }
    const ring = h3.cellToBoundary(h3id, true);
    ring.push(ring[0]);
    this.map.getSource('hexsel').setData({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } });
  }

  setLabels(units, minzoom, visible) {
    this.map.getSource('labels').setData({
      type: 'FeatureCollection',
      features: units.map((u) => ({ type: 'Feature', properties: { n: u.name, r: -(u.h8 || 0) }, geometry: { type: 'Point', coordinates: u.lp } })),
    });
    this.map.setLayerZoomRange('unit-labels', minzoom, 24);
    this.map.setLayoutProperty('unit-labels', 'visibility', visible ? 'visible' : 'none');
  }

  // ---- hexagons (deck.gl) ----------------------------------------------------------------------
  /**
   * cs: CellSet; fill: Uint8Array(4n) RGBA or null (outline only); elev: Float32Array(n) metres or null.
   * version: bump to make deck re-read colours/heights without rebuilding geometry.
   */
  setHexes({ cs, fill, elev, threeD, lines, version }) {
    if (!cs || !cs.n) { this.overlay.setProps({ layers: [] }); this.hexLayerProps = null; return; }
    const lineRGBA = this.dark ? [255, 255, 255, 80] : [40, 38, 34, 70];
    const data = cs.idx || (cs.idx = Uint32Array.from({ length: cs.n }, (_, i) => i));
    const props = {
      id: 'hex',
      beforeId: 'z-hex',
      data,
      getHexagon: (i) => cs.h[i],
      highPrecision: cs.n < 15000 ? true : 'auto',
      filled: true,
      stroked: lines && !threeD,
      extruded: !!threeD,
      getFillColor: fill ? (i, { target }) => { const o = 4 * i; target[0] = fill[o]; target[1] = fill[o + 1]; target[2] = fill[o + 2]; target[3] = fill[o + 3]; return target; } : [0, 0, 0, 0],
      getLineColor: lineRGBA,
      // outline width in metres (~4% of the cell edge): crisp up close, fades out when zoomed out
      lineWidthUnits: 'meters',
      getLineWidth: { 6: 150, 7: 56, 8: 21 }[cs.res] || 30,
      lineWidthMaxPixels: 1.4,
      getElevation: elev ? (i) => elev[i] : 0,
      elevationScale: 1,
      pickable: this.pickOn !== false,
      autoHighlight: this.pickOn !== false,
      highlightColor: [255, 214, 140, 150],
      material: { ambient: 0.55, diffuse: 0.6, shininess: 24, specularColor: [40, 40, 40] },
      updateTriggers: { getFillColor: version, getElevation: version, getLineColor: this.dark },
    };
    this.hexLayerProps = props;
    this.overlay.setProps({ layers: [new deck.H3HexagonLayer(props)] });
  }

  /** Hexagon picking and hover highlight on/off (off while the ruler owns the pointer). */
  setPickable(on) {
    this.pickOn = on;
    if (!this.hexLayerProps) return;
    this.hexLayerProps = { ...this.hexLayerProps, pickable: on, autoHighlight: on };
    this.overlay.setProps({ layers: [new deck.H3HexagonLayer(this.hexLayerProps)] });
  }

  // ---- booth pins and catchments (PMTiles, one zoom: z10, overzoomed above) ---------------------
  /**
   * b: {el, pins, catchMode: 'off'|'line'|'fill', colour: {expr, pinExpr}, opacity} or null.
   * The layers are rebuilt only when the election changes; otherwise paint and visibility update.
   */
  setBooths(b) {
    const show = !!b && (b.pins || b.catchMode !== 'off');
    const elId = show ? b.el.id : null;
    if (elId !== this.boothEl) {
      this._removeBoothLayers();
      if (elId) this._addBoothLayers(b.el, b.minzoom);
      this.boothEl = elId;
    }
    this.booth = show ? b : null;
    if (show) this._paintBooths();
  }

  _addBoothLayers(el, minzoom = 10) {
    const m = this.map;
    const url = (kind) => new URL(`data/booths/${el.id}/${kind}.pmtiles?v=${el.v}`, location.href).href;
    const src = (kind) => {
      const id = `bt-${el.id}-${kind}`;
      if (!m.getSource(id)) {
        m.addSource(id, { type: 'vector', tiles: [`pmtiles://${url(kind)}/{z}/{x}/{y}`], minzoom: 10, maxzoom: 10, bounds: el.bbox, promoteId: 'uid' });
      }
      return id;
    };
    const sc = src('catchments');
    const sp = src('booths');
    const C = { source: sc, 'source-layer': 'catchments', minzoom };
    const P = { source: sp, 'source-layer': 'booths', minzoom };
    const font = [this.vs ? 'Noto Sans Bold' : 'Noto Sans Medium'];
    m.addLayer({ id: 'catch-fill', type: 'fill', ...C, paint: { 'fill-color': NONE_RGBA, 'fill-opacity': 0 } }, 'z-catch');
    m.addLayer({ id: 'catch-line', type: 'line', ...C, layout: { 'line-join': 'round' }, paint: {} }, 'z-catch');
    m.addLayer({ id: 'catch-hl', type: 'line', ...C, filter: NOLOC, layout: { 'line-join': 'round' }, paint: { 'line-color': '#ffd166', 'line-width': 2.4 } }, 'z-catch');
    m.addLayer({ id: 'catch-sel', type: 'line', ...C, filter: NOLOC, layout: { 'line-join': 'round' }, paint: { 'line-width': 3 } }, 'z-catch');
    m.addLayer({ id: 'pin-halo', type: 'circle', ...P, paint: { 'circle-radius': PIN_R(1.4), 'circle-color': 'rgba(0,0,0,0.38)', 'circle-blur': 0.5 } }, 'unit-labels');
    m.addLayer({
      id: 'pin', type: 'circle', ...P,
      paint: { 'circle-radius': PIN_R(), 'circle-stroke-color': '#ffffff', 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 10, 0.4, 14, 0.9, 17, 1.4] },
    }, 'unit-labels');
    m.addLayer({ id: 'pin-sel', type: 'circle', ...P, filter: NOLOC, paint: { 'circle-radius': PIN_R(3.2), 'circle-color': NONE_RGBA, 'circle-stroke-width': 2.6 } }, 'unit-labels');
    m.addLayer({ id: 'pin-hl', type: 'circle', ...P, filter: NOLOC, paint: { 'circle-radius': PIN_R(2.6), 'circle-color': NONE_RGBA, 'circle-stroke-color': '#ffd166', 'circle-stroke-width': 2.2 } }, 'unit-labels');
    // several booths at one location: one count badge, on its first booth (the filter lists them, see
    // _markFirstPins); the location's other pins (same point, or a few metres off) carry none
    m.addLayer({
      id: 'pin-badge', type: 'symbol', ...P, minzoom: Math.max(minzoom, 12.5), filter: ['boolean', false],
      layout: { 'text-field': ['to-string', ['get', 'n_booths']], 'text-font': font, 'text-size': 10, 'text-offset': [0.95, -0.9], 'text-anchor': 'center', 'text-allow-overlap': true, 'text-ignore-placement': true },
      paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(0,0,0,0.85)', 'text-halo-width': 1.4 },
    }, 'unit-labels');
    m.addLayer({
      id: 'pin-label', type: 'symbol', ...P, minzoom: Math.max(minzoom, 15.5),
      layout: { 'text-field': ['get', 'booth'], 'text-font': font, 'text-size': 10.5, 'text-offset': [0, 1.15], 'text-anchor': 'top', 'text-optional': true },
      paint: {},
    }, m.getLayer('ms-fill') ? 'ms-fill' : undefined);
  }

  /** Badge filter: the lowest-uid booth of every multi-booth location in the loaded tiles. */
  _markFirstPins() {
    const src = `bt-${this.boothEl}-booths`;
    if (!this.map.getSource(src) || !this.map.getLayer('pin-badge')) return;
    const first = new Map();
    for (const f of this.map.querySourceFeatures(src, { sourceLayer: 'booths', filter: ['>', ['get', 'n_booths'], 1] })) {
      const u = f.properties.uid;
      const l = f.properties.loc;
      if (!first.has(l) || u < first.get(l)) first.set(l, u);
    }
    const uids = [...new Set(first.values())].sort((a, b) => a - b);
    if (uids.join() === this._firstUids) return;
    this._firstUids = uids.join();
    this.map.setFilter('pin-badge', uids.length ? ['match', ['get', 'uid'], uids, true, false] : ['boolean', false]);
  }

  _removeBoothLayers() {
    this._firstUids = null;
    for (const id of BOOTH_LAYERS) if (this.map.getLayer(id)) this.map.removeLayer(id);
  }

  _paintBooths() {
    const m = this.map;
    const b = this.booth;
    if (!b) return;
    const vis = (ids, on) => ids.forEach((id) => m.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'));
    vis(['pin-halo', 'pin', 'pin-sel', 'pin-hl', 'pin-badge', 'pin-label'], b.pins);
    vis(['catch-fill', 'catch-line', 'catch-hl', 'catch-sel'], b.catchMode !== 'off');
    const op = b.opacity ?? 0.72;
    const fill = b.catchMode === 'fill';
    // outline mode keeps the fill (invisible) so catchments can still be hovered and picked
    m.setPaintProperty('catch-fill', 'fill-color', b.colour.expr);
    m.setPaintProperty('catch-fill', 'fill-opacity', fill ? ['case', ['==', ['get', 'pop'], 0], op * 0.38, op] : 0);
    const ink = this.dark ? '255,255,255' : '38,34,28';
    m.setPaintProperty('catch-line', 'line-color', `rgba(${ink},${fill ? 0.4 : 0.55})`);
    m.setPaintProperty('catch-line', 'line-width', ['interpolate', ['linear'], ['zoom'], 10, 0.3, 12, 0.55, 14, 0.85, 17, 1.4]);
    m.setPaintProperty('catch-sel', 'line-color', this.pal.selection);
    m.setPaintProperty('pin', 'circle-color', b.colour.pinExpr);
    m.setPaintProperty('pin-sel', 'circle-stroke-color', this.pal.selection);
    m.setPaintProperty('pin-label', 'text-color', this.pal.label);
    m.setPaintProperty('pin-label', 'text-halo-color', this.pal.label_halo);
    m.setPaintProperty('pin-label', 'text-halo-width', 1.3);
  }

  /** Outline the catchment and ring the pins of one location (hover) and of the selected one. */
  setBoothHighlight(hlLoc, selLoc) {
    if (!this.boothEl) return;
    const f = (loc) => (loc == null ? NOLOC : ['==', ['get', 'loc'], loc]);
    this.map.setFilter('catch-hl', f(hlLoc));
    this.map.setFilter('pin-hl', f(hlLoc));
    this.map.setFilter('catch-sel', f(selLoc));
    this.map.setFilter('pin-sel', f(selLoc));
  }

  /** {pin, catch}: the booth pin nearest the point (within a few pixels) and the catchment under it. */
  pickBooth(point, touch = false) {
    const m = this.map;
    const out = { pin: null, catch: null };
    if (!this.boothEl || !this.booth) return out;
    if (this.booth.pins && m.getZoom() >= (this.booth.minzoom ?? 10)) {
      const r = touch ? 14 : 6;
      const fs = m.queryRenderedFeatures([[point.x - r, point.y - r], [point.x + r, point.y + r]], { layers: ['pin'] });
      let best = Infinity;
      for (const f of fs) {
        const q = m.project(f.geometry.coordinates);
        const d = (q.x - point.x) ** 2 + (q.y - point.y) ** 2;
        if (d < best) { best = d; out.pin = f; }
      }
    }
    if (this.booth.catchMode !== 'off') out.catch = m.queryRenderedFeatures(point, { layers: ['catch-fill'] })[0] || null;
    return out;
  }

  // ---- ruler ------------------------------------------------------------------------------------
  /**
   * Ruler layers, added last so they draw above everything. Basemap switches only swap the bm-
   * and bmv- layers below the anchors, so these survive them.
   */
  initMeasureLayers() {
    const m = this.map;
    if (m.getSource('measure')) return;
    const AMBER = '#f5a524';
    const k = (v) => ['==', ['get', 'k'], v];
    m.addSource('measure', { type: 'geojson', data: EMPTY });
    m.addLayer({ id: 'ms-fill', type: 'fill', source: 'measure', filter: k('fill'), paint: { 'fill-color': AMBER, 'fill-opacity': 0.22 } });
    m.addLayer({ id: 'ms-casing', type: 'line', source: 'measure', filter: k('line'), layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': 'rgba(0,0,0,0.55)', 'line-width': 5 } });
    m.addLayer({ id: 'ms-line', type: 'line', source: 'measure', filter: k('line'), layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': AMBER, 'line-width': 2.5 } });
    m.addLayer({ id: 'ms-live', type: 'line', source: 'measure', filter: k('live'), paint: { 'line-color': AMBER, 'line-width': 2, 'line-dasharray': [2, 1.6] } });
    m.addLayer({
      id: 'ms-pts', type: 'circle', source: 'measure', filter: k('pt'),
      paint: { 'circle-radius': ['case', ['get', 'first'], 6, 4.5], 'circle-color': '#ffffff', 'circle-stroke-color': AMBER, 'circle-stroke-width': 2 },
    });
    m.addLayer({
      id: 'ms-lbl', type: 'symbol', source: 'measure', filter: k('lbl'),
      layout: {
        'text-field': ['get', 't'],
        // a font the style's glyph server actually serves (OpenFreeMap has no "Medium")
        'text-font': [this.vs ? 'Noto Sans Bold' : 'Noto Sans Medium'],
        'text-size': 12, 'text-allow-overlap': true, 'text-ignore-placement': true,
        'text-anchor': ['get', 'anc'], 'text-offset': ['get', 'off'],
      },
      paint: { 'text-color': '#ffffff', 'text-halo-color': 'rgba(0,0,0,0.85)', 'text-halo-width': 1.6 },
    });
  }

  setMeasure(fc) { this.map.getSource('measure')?.setData(fc || EMPTY); }

  /**
   * Show only the compact "i" attribution button (it expands on click) so the status bar fits
   * beside it. MapLibre expands it itself once the first source attributions arrive, so this waits
   * for that moment, collapses it once, and then leaves the user's own clicks alone.
   */
  collapseAttribution() {
    const a = this.map.getContainer().querySelector('.maplibregl-ctrl-attrib');
    if (!a) return;
    const collapse = () => { a.classList.remove('maplibregl-compact-show'); a.removeAttribute('open'); };
    if (a.classList.contains('maplibregl-compact-show')) { collapse(); return; }
    const obs = new MutationObserver(() => {
      if (a.classList.contains('maplibregl-compact-show')) { obs.disconnect(); collapse(); }
    });
    obs.observe(a, { attributes: true, attributeFilter: ['class'] });
    setTimeout(() => obs.disconnect(), 30000);
  }

  /** {hex: index|null, unit: id|null} under a screen point. */
  pick(point, level) {
    let hex = null;
    if (this.hexLayerProps) {
      const info = this.overlay.pickObject({ x: point.x, y: point.y, radius: 1, layerIds: ['hex'] });
      if (info && info.index >= 0) hex = info.index; // data is a typed array of indices: deck reports the index
    }
    const f = this.map.queryRenderedFeatures(point, { layers: [`fill-${level}`] })[0];
    return { hex, unit: f ? f.id : null };
  }
}
