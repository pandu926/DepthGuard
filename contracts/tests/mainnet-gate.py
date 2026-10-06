#!/usr/bin/env python3
"""Check release guards before any database or RPC access can occur."""
import os
from pathlib import Path
import subprocess
root = Path(__file__).resolve().parents[2]
base = dict(os.environ, DATABASE_URL="postgres://localhost:1/unreachable",
            SOLANA_CLUSTER="mainnet-beta", APP_ORIGIN="https://release-test.invalid",
            SOLANA_RPC_URLS="https://api.mainnet-beta.solana.com")
for contracts, writes, expected in [("true", "false", "immutable release acceptance"),
                                   ("false", "true", "Mainnet broadcast requires")]:
    env = dict(base, ENABLE_CONTRACTS=contracts, ENABLE_CHAIN_WRITES=writes)
    p = subprocess.run([root / "backend/target/debug/depthguard-api"], env=env,
                       capture_output=True, text=True, timeout=3, check=False)
    assert p.returncode != 0 and expected in p.stderr, "Mainnet gate did not reject before I/O"
print("PASS contract and native-broadcast mainnet gates before database/RPC access")
