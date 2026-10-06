#!/usr/bin/env python3
"""Create a consistent database dump and encrypt it with immutable artifacts off-host."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
from urllib.parse import urlparse, unquote

os.umask(0o077)
for variable in ("DATABASE_URL", "RESTIC_REPOSITORY", "RESTIC_PASSWORD_FILE", "ARTIFACTS_DIR"):
    if not os.environ.get(variable):
        raise SystemExit(f"Missing required setting: {variable}")
url = urlparse(os.environ["DATABASE_URL"])
env = os.environ.copy()
env.update(PGHOST=url.hostname, PGPORT=str(url.port or 5432), PGUSER=unquote(url.username or ""),
           PGPASSWORD=unquote(url.password or ""), PGDATABASE=url.path.removeprefix("/"))
lock_path = Path(os.environ.get("BACKUP_LOCK", "/tmp/depthguard-backup.lock"))
with lock_path.open("w") as lock:
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit("Another backup is running")
    with tempfile.TemporaryDirectory(prefix="depthguard-backup-") as temporary:
        directory = Path(temporary)
        dump = directory / "database.dump"
        subprocess.run(["pg_dump", "--format=custom", "--no-owner", "--no-privileges", "--file", str(dump)], env=env, check=True)
        # Completed artifacts are immutable and written before their database records commit.
        shutil.copytree(os.environ["ARTIFACTS_DIR"], directory / "artifacts")
        artifact_root=directory / "artifacts"
        artifacts={str(p.relative_to(artifact_root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in artifact_root.rglob("*") if p.is_file()}
        manifest = {"schema_version": 1, "dump_sha256": hashlib.sha256(dump.read_bytes()).hexdigest(), "artifacts":artifacts}
        (directory / "manifest.json").write_text(json.dumps(manifest))
        if os.environ.get("KEY_ENCRYPTION_KEY"):
            (directory / "account-signer-key.txt").write_text(os.environ["KEY_ENCRYPTION_KEY"])
        subprocess.run(["restic", "backup", "--tag", "depthguard", "--host", "depthguard", str(directory)], check=True)
        subprocess.run(["restic", "check"], check=True)
        (Path(os.environ["ARTIFACTS_DIR"]) / ".backup-success").write_text(str(int(time.time())))
        print("Encrypted off-host backup completed and repository integrity checked")
