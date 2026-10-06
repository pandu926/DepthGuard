#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
[[ -f "$ROOT/.local/contracts/operator-keypair.json" ]] || { echo 'Build the contracts and create a private local operator keypair first' >&2; exit 1; }
LOCAL_OPERATOR_PUBKEY=$("$ROOT/.local/agave-4.0.0/solana-release/bin/solana-keygen" pubkey "$ROOT/.local/contracts/operator-keypair.json")
export LOCAL_OPERATOR_PUBKEY
# Agave test-validator binds RPC to all interfaces even with --bind-address 127.0.0.1.
# Container publication enforces loopback access and provides a private backend network.
exec docker compose -f "$ROOT/contracts/compose.yaml" up -d validator
