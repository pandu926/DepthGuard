#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT"
[[ -n ${DATABASE_URL:-} ]] || { echo 'An isolated-test PostgreSQL admin DATABASE_URL is required' >&2; exit 1; }
cargo test --manifest-path contracts/Cargo.toml --locked -j 2
cargo build --manifest-path backend/Cargo.toml --locked -j 2 -p depthguard-api -p depthguard-worker
cargo build --manifest-path backend/native/Cargo.toml --locked -j 2
CARGO_TARGET_DIR="$ROOT/backend/sbf/target" cargo build --manifest-path contracts/tests/runner/Cargo.toml --locked -j 2
python3 contracts/tests/mainnet-gate.py
CONTRACT_HTTP_TEST=true node -r ts-node/register contracts/tests/lifecycle.cjs
