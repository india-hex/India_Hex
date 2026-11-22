"""Load india_hex.yaml and resolve paths.

One codebase, several sites: the environment variable INDIA_HEX_CONFIG (set by `server.py --config`)
names another settings file, e.g. india_hex_elections.yaml, whose `output` key names its own build
folder (default `site`, the main site).
"""
import os
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = Path(os.environ.get("INDIA_HEX_CONFIG") or ROOT / "india_hex.yaml")
if not CONFIG_PATH.is_absolute():
    CONFIG_PATH = ROOT / CONFIG_PATH


def _output():
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            return (yaml.safe_load(f) or {}).get("output") or "site"
    except OSError:
        return "site"


SITE = ROOT / _output()
DATA = SITE / "data"
# Data shards: per-state data published from its own GitHub Pages repository (india_hex.yaml `shards`),
# built into shards/<name>/ with the same layout as site/ (data/hex/h{res}/v/..., data/booths/...).
SHARDS = ROOT / "shards"


def data_dir(shard=None):
    """site/data, or shards/<name>/data for data published from a shard repository."""
    return SHARDS / shard / "data" if shard else DATA


def find_data(rel):
    """A published data file or folder (path under data/), wherever it is built: site/data or a shard."""
    for root in [DATA] + (sorted(p / "data" for p in SHARDS.iterdir() if p.is_dir()) if SHARDS.exists() else []):
        if (root / rel).exists():
            return root / rel
    return DATA / rel


class Config(dict):
    """india_hex.yaml as a dict, plus resolved source paths."""

    @property
    def src_root(self) -> Path:
        return Path(self["source"]["root"])

    @property
    def processed(self) -> Path:
        return self.src_root / self["source"]["processed"]

    def boundary_path(self, name) -> Path:
        return self.src_root / self["source"]["boundaries"][name]

    @property
    def pc_fixes(self):
        """{ac_key: pc_key}: ACs whose cells and area belong to another PC than the PC map draws."""
        return dict(self["source"]["boundaries"].get("pc_fixes") or {})

    @property
    def ac_patch_paths(self):
        return [self.src_root / p for p in self["source"]["boundaries"].get("ac_patches") or []]

    def hex_file(self, template, res, root=None) -> Path:
        """processed/h{res}/<file>, or <root>/h{res}/<file> for a dataset kept elsewhere."""
        base = Path(root) if root else self.processed
        return base / f"h{res}" / template.format(res=res)

    @property
    def resolutions(self):
        return list(self["hex"]["resolutions"])

    @property
    def chunk_levels(self):
        return int(self["hex"].get("chunk_levels", 4))


def _merge(base, over):
    """`over` on top of `base`: nested sections merge, lists and values replace, null removes a key."""
    out = dict(base)
    for k, v in over.items():
        if v is None:
            out.pop(k, None)
        elif isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


def _read(path):
    """A settings file; `extends: <file>` starts from another one (e.g. the elections site from the main)."""
    path = Path(path)
    with open(path, encoding="utf-8") as f:
        d = yaml.safe_load(f) or {}
    base = d.pop("extends", None)
    return _merge(_read(path.parent / base), d) if base else d


def load_config(path=CONFIG_PATH) -> Config:
    cfg = Config(_read(path))
    cfg.pop("output", None)   # resolved into SITE above
    cfg.setdefault("variables", {}).setdefault("overrides", {})
    cfg["variables"].setdefault("exclude", [])
    cfg["variables"].setdefault("featured", [])
    cfg["variables"].setdefault("h8", [])
    return cfg
