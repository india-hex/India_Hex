"""Compare a built site folder with a published gh-pages commit, file by file (git blob hashes).

python tools/site_diff.py <site folder> <git dir> [ref]      ref: a commit, or default the remote gh-pages head

Prints the files that differ, exist only locally or only in the commit; exit 1 if any.
config.json is compared twice: as bytes, and with its "version" stamp set aside.
"""
import hashlib
import json
import subprocess
import sys
from pathlib import Path


def blob(data):
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def git_blobs(gitdir, site, paths):
    """The blobs git would store on publish (its own core.autocrlf filters, e.g. CRLF -> LF in text
    files; binary files untouched), i.e. what the site would serve."""
    if not paths:
        return {}
    out = subprocess.run(["git", f"--git-dir={gitdir}", f"--work-tree={site}", "hash-object", "--stdin-paths"],
                         input="\n".join(paths), capture_output=True, text=True, check=True, cwd=site).stdout.split()
    return dict(zip(paths, out))


def main():
    site, gitdir = Path(sys.argv[1]), sys.argv[2]
    git = lambda *a: subprocess.run(["git", f"--git-dir={gitdir}", *a], capture_output=True, text=True, check=True).stdout
    ref = sys.argv[3] if len(sys.argv) > 3 else git("ls-remote", "origin", "gh-pages").split()[0]
    tree = {}
    for line in git("ls-tree", "-r", ref).splitlines():
        meta, path = line.split("\t", 1)
        tree[path] = meta.split()[2]
    local = {p.relative_to(site).as_posix(): p for p in site.rglob("*") if p.is_file()}
    raw_differ = [f for f in sorted(set(tree) & set(local)) if blob(local[f].read_bytes()) != tree[f]]
    normal = git_blobs(gitdir, site.resolve(), raw_differ)   # line endings: as publishing would store them
    differ = [f for f in raw_differ if normal[f] != tree[f]]
    if raw_differ:
        print(f"  {len(raw_differ) - len(differ)} text files differ only in line endings (CRLF here, LF as published)")
    only_local, only_pub = sorted(set(local) - set(tree)), sorted(set(tree) - set(local))
    print(f"commit {ref[:10]}: {len(tree)} files published, {len(local)} local")
    print(f"  differ: {differ[:20]}{' …' if len(differ) > 20 else ''}")
    print(f"  only local: {only_local[:10]}  only published: {only_pub[:10]}")
    if "config.json" in differ:
        pub = json.loads(git("cat-file", "-p", tree["config.json"]))
        loc = json.loads(local["config.json"].read_text(encoding="utf-8"))
        same = {k: v for k, v in pub.items() if k != "version"} == {k: v for k, v in loc.items() if k != "version"}
        print(f"  config.json apart from its version stamp: {'identical' if same else 'DIFFERENT'} (published {pub.get('version')}, local {loc.get('version')})")
    sys.exit(1 if differ or only_local or only_pub else 0)


if __name__ == "__main__":
    main()
