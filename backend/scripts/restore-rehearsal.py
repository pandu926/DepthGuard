#!/usr/bin/env python3
"""Verify encrypted backup tooling locally; this does not certify an off-host repository."""
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time
from urllib.parse import urlparse,unquote,urlunparse
ROOT=Path(__file__).resolve().parents[2]
url=urlparse(os.environ["DATABASE_URL"])
prefix="depthguard_backup_"+secrets.token_hex(6)
source=prefix
restore="depthguard_restore_"+secrets.token_hex(6)
env=os.environ.copy()
env.update(PGHOST=url.hostname,PGPORT=str(url.port or 5432),PGUSER=unquote(url.username or ""),PGPASSWORD=unquote(url.password or ""))
def command(args,extra=None):
    process=subprocess.run(args,env={**env,**(extra or {})},capture_output=True,text=True)
    if process.returncode:
        error=process.stderr.replace(env.get("PGPASSWORD", ""), "[redacted]") if env.get("PGPASSWORD") else process.stderr
        raise RuntimeError(f"{Path(args[0]).name} failed: {error[-3000:]}")
    return process.stdout
start=time.monotonic()
command(["createdb",source]);command(["createdb",restore])
try:
    with tempfile.TemporaryDirectory(prefix="depthguard-restore-") as directory:
        root=Path(directory);artifact=root/"artifacts";artifact.mkdir()
        (artifact/"sample.json").write_text('{"amount":"18446744073709551615"}\n')
        password=root/"password";password.write_text(secrets.token_hex(32));password.chmod(0o600)
        source_url=urlunparse(url._replace(path="/"+source))
        restore_url=urlunparse(url._replace(path="/"+restore))
        settings={"DATABASE_URL":source_url,"RESTIC_REPOSITORY":str(root/"repository"),"RESTIC_PASSWORD_FILE":str(password),"ARTIFACTS_DIR":str(artifact),"KEY_ENCRYPTION_KEY":secrets.token_hex(32)}
        command([str(ROOT/"backend/target/debug/depthguard-api"),"migrate"],settings)
        command(["psql","--no-psqlrc","--set","ON_ERROR_STOP=1","--command","INSERT INTO fee_accounting_entries(id,cluster,vault_address,signature,event_index,entry_type,amount,finalized) VALUES(gen_random_uuid(),'localnet','11111111111111111111111111111111','restore-fixture',0,'funding',12345,true);"],{"PGDATABASE":source})
        command(["restic","init"],settings)
        command(["python3",str(ROOT/"backend/ops/backup/backup.py")],settings)
        destination=root/"restored"
        command(["restic","restore","latest","--target",str(destination)],settings)
        manifest=next(destination.rglob("manifest.json"))
        command(["python3",str(ROOT/"backend/ops/backup/restore.py")],{"RESTORE_DIRECTORY":str(manifest.parent),"RESTORE_DATABASE_URL":restore_url})
        amount=command(["psql","--no-psqlrc","--tuples-only","--command","SELECT sum(amount)::text FROM fee_accounting_entries WHERE finalized;"],{"PGDATABASE":restore}).strip()
        assert amount=="12345",amount
        assert (manifest.parent/"artifacts/sample.json").read_text()==(artifact/"sample.json").read_text()
        assert (manifest.parent/"account-signer-key.txt").read_text()==settings["KEY_ENCRYPTION_KEY"]
        print(json.dumps({"status":"passed","scope":"local_encrypted_repository_rehearsal","off_host_certified":False,"elapsed_seconds":round(time.monotonic()-start,3),"checks":["encrypted_repository_integrity","database_dump_hash","artifact_hashes","fee_integer_roundtrip","account_signer_key_recovery"]}))
finally:
    command(["dropdb","--force",source]);command(["dropdb","--force",restore])
