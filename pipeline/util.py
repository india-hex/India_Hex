import hashlib
import json
import time
from pathlib import Path


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def file_sig(path: Path) -> str:
    st = Path(path).stat()
    return f"{st.st_mtime_ns}:{st.st_size}"


def obj_sig(*parts) -> str:
    """Stable short hash of any JSON-serialisable parts."""
    return hashlib.sha1(json.dumps(parts, sort_keys=True, default=str).encode()).hexdigest()[:16]


def dir_size(path: Path) -> int:
    return sum(p.stat().st_size for p in Path(path).rglob("*") if p.is_file())
