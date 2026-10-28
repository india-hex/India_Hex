"""Load india_hex.yaml and resolve paths."""
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
DATA = SITE / "data"
CONFIG_PATH = ROOT / "india_hex.yaml"


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


def load_config(path=CONFIG_PATH) -> Config:
    with open(path, encoding="utf-8") as f:
        cfg = Config(yaml.safe_load(f))
    cfg.setdefault("variables", {}).setdefault("overrides", {})
    cfg["variables"].setdefault("exclude", [])
    cfg["variables"].setdefault("featured", [])
    cfg["variables"].setdefault("h8", [])
    return cfg
