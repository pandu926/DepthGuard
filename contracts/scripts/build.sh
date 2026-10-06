#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
AGAVE_BIN=${AGAVE_BIN:-"$ROOT/.local/agave-4.0.0/solana-release/bin"}
export PATH="$AGAVE_BIN:$PATH"
command -v cargo-build-sbf >/dev/null
[[ $(solana --version) == solana-cli\ 4.0.0* ]] || { echo 'Agave 4.0.0 is required' >&2; exit 1; }
[[ $(anchor --version) == 'anchor-cli 1.0.2' ]] || { echo 'Anchor CLI 1.0.2 is required' >&2; exit 1; }
mkdir -p "$ROOT/contracts/target/deploy" "$ROOT/contracts/idl" "$ROOT/.local/contracts"
if [[ ! -f "$ROOT/.local/contracts/operator-keypair.json" ]]; then
  "$AGAVE_BIN/solana-keygen" new --no-bip39-passphrase --silent --outfile "$ROOT/.local/contracts/operator-keypair.json" >/dev/null
  chmod 600 "$ROOT/.local/contracts/operator-keypair.json"
fi
# Build each manifest independently. Workspace-wide CPI feature unification disables entrypoints.
# Anchor 1.0.2 defaults to older platform tools, so invoke the pinned SBF builder explicitly.
for program in registry escrow reserve; do
  cargo build-sbf --manifest-path "$ROOT/contracts/programs/$program/Cargo.toml" \
    --tools-version v1.57 --arch v3 --sbf-out-dir "$ROOT/contracts/target/deploy" -j 2 -- --locked
  (cd "$ROOT/contracts" && anchor idl build -p "depthguard_$program") > "$ROOT/contracts/idl/depthguard_$program.json"
done
python3 "$ROOT/contracts/scripts/manifest.py"
