#!/usr/bin/env python3
"""Fetch immutable official fixtures and verify every checksum before writing."""
import hashlib
import json
import os
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
DEST = Path(os.environ.get("SBF_FIXTURES_DIR", ROOT / "proof/fixtures"))
DEST.mkdir(parents=True, exist_ok=True)
manifest = json.loads((ROOT / "proof/fixture-manifest.json").read_text())
files = [(manifest["repository"], manifest["commit"], manifest["directory"] + "/" + name, digest)
         for name, digest in manifest["sha256"].items()]
dfs = json.loads((ROOT / "backend/native/fixture-manifest.json").read_text())
files.append((dfs["repository"], dfs["commit"], dfs["path"], dfs["sha256"]))
for repo, commit, path, digest in files:
    target = DEST / Path(path).name
    if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() == digest:
        print(f"Verified {target.name}")
        continue
    url = f"https://raw.githubusercontent.com/{repo}/{commit}/{path}"
    with urllib.request.urlopen(url, timeout=60) as response:
        body = response.read(20 * 1024 * 1024 + 1)
    if len(body) > 20 * 1024 * 1024 or hashlib.sha256(body).hexdigest() != digest:
        raise SystemExit(f"Checksum validation failed: {target.name}")
    temporary = target.with_suffix(".tmp")
    temporary.write_bytes(body)
    temporary.replace(target)
    print(f"Verified {target.name}")
