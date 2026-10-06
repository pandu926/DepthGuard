#!/usr/bin/env python3
"""Restore a backup into an existing, dedicated acceptance database only."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
from urllib.parse import urlparse, unquote

source = Path(os.environ["RESTORE_DIRECTORY"])
url = urlparse(os.environ["RESTORE_DATABASE_URL"])
database = url.path.removeprefix("/")
if not database.startswith("depthguard_restore_"):
    raise SystemExit("Restore target must be a dedicated depthguard_restore_ database")
manifest = json.loads((source / "manifest.json").read_text())
dump = source / "database.dump"
if hashlib.sha256(dump.read_bytes()).hexdigest() != manifest["dump_sha256"]:
    raise SystemExit("Backup dump checksum mismatch")
for name,digest in manifest.get("artifacts",{}).items():
    path=source / "artifacts" / name
    if not path.resolve().is_relative_to((source / "artifacts").resolve()) or hashlib.sha256(path.read_bytes()).hexdigest()!=digest:
        raise SystemExit("Artifact checksum mismatch")
env = os.environ.copy()
env.update(PGHOST=url.hostname, PGPORT=str(url.port or 5432), PGUSER=unquote(url.username or ""),
           PGPASSWORD=unquote(url.password or ""), PGDATABASE=database)
subprocess.run(["pg_restore", "--dbname", database, "--single-transaction", "--exit-on-error", "--no-owner", "--no-privileges", str(dump)], env=env, check=True)
subprocess.run(["psql", "--no-psqlrc", "--set", "ON_ERROR_STOP=1", "--command",
                "SELECT count(*) AS migrations FROM _sqlx_migrations WHERE success; "
                "SELECT count(*) AS invalid_fees FROM fee_accounting_entries WHERE amount<0; "
                "SELECT count(*) AS active_jobs FROM jobs WHERE state IN ('pending','running');"], env=env, check=True)
print("Database restore validation passed; complete artifact hashes and application smoke acceptance before promotion")
