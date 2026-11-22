// Data repositories ("shards"): heavy per-state election data is published from its own GitHub Pages
// repository in the org and read from the same origin (config.json "shards": name -> URL relative to
// the app, e.g. "../data-ka/"). A series or booth election with `shard` reads its files from there.
let SH = {};

export function initShards(cfg) { SH = cfg.shards || {}; }

/** URL prefix of a dataset's files ('' = the app's own data). */
export const base = (shard) => (shard && SH[shard]) || '';
