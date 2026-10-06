#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
DEST="$ROOT/.local/agave-4.0.0"
mkdir -p "$DEST"
if [[ ! -x "$DEST/solana-release/bin/solana" ]]; then
  curl --fail --location --retry 3 --output "$DEST/release.tar.bz2" \
    https://github.com/anza-xyz/agave/releases/download/v4.0.0/solana-release-x86_64-unknown-linux-gnu.tar.bz2
  printf '%s  %s\n' c839ba629d10edd5f99af68807dc25948fce62cd5176b56ad13e23f7562ef4f2 "$DEST/release.tar.bz2" | sha256sum --check --status
  tar --extract --bzip2 --file "$DEST/release.tar.bz2" --directory "$DEST"
fi
"$DEST/solana-release/bin/solana" --version
