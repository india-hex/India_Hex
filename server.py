"""India Hex: build, preview and publish.

  python server.py                 rebuild what india_hex.yaml / the source data changed, then serve
                                   http://localhost:8000 (re-reads india_hex.yaml whenever it is saved)
  python server.py --no-build      serve only
  python server.py --build-only    rebuild, don't serve
  python server.py --force         rebuild everything from scratch
  python server.py --list          list every variable found in the source data
  python server.py --publish       rebuild, then push site/ to GitHub Pages (india_hex.yaml: publish.repo)
  python server.py --port 8080

Needs: duckdb geopandas shapely>=2.1 h3>=4 pandas numpy pyyaml
"""
import argparse
import gzip
import http.server
import os
import re
import socket
import socketserver
import subprocess
import sys
import threading
import time
from io import BytesIO
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
for _stream in (sys.stdout, sys.stderr):  # Windows consoles default to cp1252
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass

from pipeline.build import build  # noqa: E402
from pipeline.catalog import discover  # noqa: E402
from pipeline.config import CONFIG_PATH, SITE, load_config  # noqa: E402

COMPRESSIBLE = {".json", ".geojson", ".js", ".css", ".html", ".svg"}
TYPES = {".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml",
         ".json": "application/json", ".geojson": "application/geo+json", ".bin": "application/octet-stream",
         ".png": "image/png", ".webmanifest": "application/manifest+json"}


class Handler(http.server.SimpleHTTPRequestHandler):
    """Static files with gzip for text and HTTP Range for everything (like GitHub Pages)."""

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(SITE), **kw)

    def log_message(self, fmt, *args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def send_head(self):
        path = Path(self.translate_path(self.path))
        if path.is_dir():
            path = path / "index.html"
        if not path.is_file():
            return super().send_head()
        ctype = TYPES.get(path.suffix, "application/octet-stream")
        size = path.stat().st_size
        rng = self.headers.get("Range")
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)", rng)
            if m:
                a = int(m.group(1)) if m.group(1) else max(0, size - int(m.group(2)))
                b = int(m.group(2)) if m.group(1) and m.group(2) else size - 1
                b = min(b, size - 1)
                with open(path, "rb") as f:
                    f.seek(a)
                    body = f.read(b - a + 1)
                self.send_response(206)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Range", f"bytes {a}-{b}/{size}")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                return BytesIO(body)
        if path.suffix in COMPRESSIBLE and "gzip" in self.headers.get("Accept-Encoding", ""):
            body = gzip.compress(path.read_bytes(), compresslevel=5)
            self.send_response(200)
            self.send_header("Content-Type", f"{ctype}; charset=utf-8")
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            return BytesIO(body)
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        return BytesIO(body)


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = False  # on Windows, True would silently share a port another server is using
    request_queue_size = 512


def watch_config():
    """Re-read india_hex.yaml on save; rebuild incrementally (display-only edits take a second)."""
    last = CONFIG_PATH.stat().st_mtime
    while True:
        time.sleep(1.5)
        try:
            m = CONFIG_PATH.stat().st_mtime
        except OSError:
            continue
        if m != last:
            last = m
            print("\nindia_hex.yaml changed: rebuilding…")
            try:
                build(load_config())
                print("Done. Reload the page to see the changes.")
            except Exception as e:  # keep serving on a bad edit
                print(f"Build failed: {e}")


def list_variables():
    cfg = load_config()
    series = discover(cfg, verbose=True)
    group = None
    for s in series:
        if s.group != group:
            group = s.group
            print(f"\n{group}")
        yrs = f"{s.years[0]}–{s.years[-1]} ({len(s.years)})" if s.years else "single"
        res = ",".join(f"H{r}" for r in sorted(s.res_years))
        print(f"  {s.id:48s} {yrs:16s} {res:10s} {s.agg:6s} {s.label}")
    print(f"\n{len(series)} variables. Change labels, years, H8 publishing etc. in india_hex.yaml → variables.")


def _noreply_email():
    """<id>+<login>@users.noreply.github.com of the signed-in gh account (keeps the real email private)."""
    try:
        out = subprocess.run(["gh", "api", "user", "--jq", '(.id|tostring) + "+" + .login'], capture_output=True, text=True, check=True).stdout.strip()
        return f"{out}@users.noreply.github.com" if "+" in out else ""
    except (OSError, subprocess.CalledProcessError):
        return ""


def publish(cfg):
    """Push site/ as a single orphan commit to the gh-pages branch (no data history piles up)."""
    repo = (cfg.get("publish") or {}).get("repo")
    branch = (cfg.get("publish") or {}).get("branch", "gh-pages")
    if not repo:
        sys.exit("Set publish.repo in india_hex.yaml (e.g. https://github.com/<user>/India_Hex.git)")
    gitdir = ROOT / ".publish.git"
    env = {**os.environ, "GIT_DIR": str(gitdir), "GIT_WORK_TREE": str(SITE)}
    run = lambda *a: subprocess.run(["git", *a], env=env, check=True, capture_output=True, text=True).stdout.strip()
    if not gitdir.exists():
        subprocess.run(["git", "init", "--bare", str(gitdir)], check=True, capture_output=True)
        run("remote", "add", "origin", repo)
    else:
        run("remote", "set-url", "origin", repo)
    pub = cfg.get("publish") or {}
    email = pub.get("git_email") or _noreply_email()
    if pub.get("git_name"):
        run("config", "user.name", pub["git_name"])
    if email:
        run("config", "user.email", email)
    (SITE / ".nojekyll").write_text("")
    print("Staging site/ …")
    run("add", "-A", "--", ".")
    tree = run("write-tree")
    commit = run("commit-tree", tree, "-m", f"Publish {time.strftime('%Y-%m-%d %H:%M')}")
    print(f"Pushing to {repo} ({branch}); the first push uploads everything and can take a while…")
    subprocess.run(["git", "push", "--force", "origin", f"{commit}:refs/heads/{branch}"], env=env, check=True)
    m = re.match(r"https://github\.com/([^/]+)/([^/.]+)", repo)
    if m:
        print(f"\nPublished. Site: https://{m.group(1).lower()}.github.io/{m.group(2)}/")
        print(f"(First time only: GitHub → {m.group(1)}/{m.group(2)} → Settings → Pages → Branch: {branch} / root.)")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--no-build", action="store_true")
    ap.add_argument("--build-only", action="store_true")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--publish", action="store_true")
    a = ap.parse_args()

    if a.list:
        return list_variables()
    cfg = load_config()
    if not a.no_build:
        build(cfg, force=a.force)
    if a.publish:
        return publish(cfg)
    if a.build_only:
        return
    threading.Thread(target=watch_config, daemon=True).start()
    for port in range(a.port, a.port + 20):  # skip ports already in use (Windows lets two servers share one)
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.3).close()
            continue  # something already answers here
        except OSError:
            pass
        try:
            httpd = Server(("0.0.0.0", port), Handler)
            break
        except OSError:
            continue
    else:
        sys.exit(f"No free port between {a.port} and {a.port + 19}")
    with httpd:
        print(f"\nIndia Hex → http://localhost:{port}   (phone on the same Wi-Fi: http://<this PC's IP>:{port})")
        print("Watching india_hex.yaml for changes. Ctrl+C to stop.", flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
