/* global maplibregl, deck, h3 */
// One map: MapLibre (basemap, overlays, boundaries, selection, labels) + a deck.gl layer for
// hexagons drawn on the GPU in the same WebGL context (interleaved, so hexes sit under the mask,
// road lines and labels). The main map and the compare map are both MapViews.
import { groupLayers } from './overlays.js';

const EMPTY = { type: 'FeatureCollection', features: [] };
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
    m.addLayer({ id: 'mask-fill', type: 'fill', source: 'mask', paint: { 'fill-color': 'rgba(0,0,0,0.4)' } });
    anchor('z-lines');
    for (const l of ['ac', 'pc', 'district', 'state']) {
      m.addLayer({ id: `line-${l}`, type: 'line', source: `b-${l}`, layout: { visibility: 'none', 'line-join': 'round' }, paint: {} });
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
      const hw = (w) => ['case', ['boolean', ['feature-state', 'hover'], false], w + 1.4, w];
      m.setPaintProperty(`line-${l}`, 'line-color', col);
      m.setPaintProperty(`line-${l}`, 'line-opacity', Math.min(1, op * this.lineScale));
      m.setPaintProperty(`line-${l}`, 'line-width', ['interpolate', ['linear'], ['zoom'], 4, hw(w8 * 0.45), 8, hw(w8), 12, hw(w12), 16, hw(w12 * 1.3)]);
      m.setPaintProperty(`line-${l}`, 'line-dasharray', dash && dash.length ? dash : [1, 0]);
    }
    m.setPaintProperty('sel-line', 'line-color', p.selection);
    m.setPaintProperty('mask-fill', 'fill-color', p.mask);
    m.setPaintProperty('unit-labels', 'text-color', p.label);
    m.setPaintProperty('unit-labels', 'text-halo-color', p.label_halo);
  }

  setLineScale(f) { this.lineScale = f; this.applyPalette(); }

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

  setLevel(level, stateLines) {
    for (const l of LEVELS) {
      this.map.setLayoutProperty(`fill-${l}`, 'visibility', l === level ? 'visible' : 'none');
      this.map.setLayoutProperty(`line-${l}`, 'visibility', l === level || (l === 'state' && stateLines) ? 'visible' : 'none');
    }
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
      beforeId: 'mask-fill',
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
