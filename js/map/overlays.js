// Google-style overlays (roads, places, POIs, buildings) taken from the OpenFreeMap "liberty"
// vector style and grouped by source layer, as configured in india_hex.yaml → overlays.groups.

let cached = null;

export function loadVectorStyle(url) {
  if (!cached) {
    cached = fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null).then((style) => {
      if (!style) return null;
      const src = Object.entries(style.sources).find(([, s]) => s.type === 'vector');
      return { style, sourceId: src?.[0], source: src?.[1], sprite: style.sprite, glyphs: style.glyphs };
    });
  }
  return cached;
}

/** {group: [layer, …]} with ids prefixed and the vector source renamed to 'ov'. */
export function groupLayers(vs, groups) {
  const out = {};
  for (const [g, def] of Object.entries(groups)) {
    out[g] = vs.style.layers
      .filter((l) => l.source === vs.sourceId && def.source_layers.includes(l['source-layer']))
      .filter((l) => l.type !== 'fill-extrusion')
      .map((l) => {
        const layout = { ...(l.layout || {}), visibility: 'none' };
        // English first (OSM names are often in local scripts), then any latin name, then the local one
        if (JSON.stringify(layout['text-field'] || '').includes('name')) layout['text-field'] = ['coalesce', ['get', 'name:en'], ['get', 'name_en'], ['get', 'name:latin'], ['get', 'name']];
        return { ...l, id: `ov-${g}-${l.id}`, source: 'ov', layout };
      });
  }
  return out;
}
