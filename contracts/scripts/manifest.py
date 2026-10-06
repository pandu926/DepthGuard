#!/usr/bin/env python3
"""Record public build artifacts only; signing keys never enter the manifest."""
import hashlib
import json
from pathlib import Path
root = Path(__file__).resolve().parents[2]
programs = {"registry": "5sUGNQ5pymevqfVmg99rgQ2jM4aVSo6RqhJtSK7VrPYz",
            "escrow": "8zEaBFNNVDx9U4Cr111xfZjUmX7JMBapJhd6yT4XwtuZ",
            "reserve": "7kaGXYpxPuCoh5o2AhxRoU8F13UUkHjfxVZUTYsKG88Y"}
result = {"network": "localnet", "anchor": "1.0.2", "agave": "4.0.0",
          "platform_tools": "1.57", "sbf_arch": "v3", "production_certified": False,
          "programs": []}
for name, address in programs.items():
    file = root / "contracts/target/deploy" / f"depthguard_{name}.so"
    blob = file.read_bytes()
    if len(blob) < 10000:
        raise SystemExit(f"Missing entrypoint or invalid build: {name}")
    result["programs"].append({"name": name, "address": address,
                               "size": len(blob), "sha256": hashlib.sha256(blob).hexdigest()})
(root / "contracts/build-manifest.json").write_text(json.dumps(result, indent=2) + "\n")
