#!/usr/bin/env python3
"""Replay checked-in native quotes and signed SBF snapshots without network access."""
import json
import os
from pathlib import Path
import subprocess
ROOT = Path(__file__).resolve().parents[2]
NATIVE = os.environ.get("NATIVE_HELPER_PATH", str(ROOT / "backend/native/target/debug/depthguard-native"))
SBF = os.environ.get("SBF_HELPER_PATH", str(ROOT / "backend/sbf/target/debug/depthguard-sbf"))

def run(binary, request):
    process = subprocess.run([binary], input=json.dumps(request), capture_output=True, text=True,
                             check=True, timeout=20, cwd=ROOT)
    result = json.loads(process.stdout)
    assert result["ok"], result.get("error")
    return result["result"]

quotes = json.loads((ROOT / "backend/tests/fixtures/native-quotes.json").read_text())["snapshots"]
for index, case in enumerate(quotes):
    result = run(NATIVE, case["input"])
    for field, expected in case["native_result"].items():
        assert result[field] == expected, (index, field, result[field], expected)
print(f"Passed {len(quotes)} native SDK parity quotes")
cases = json.loads((ROOT / "backend/tests/fixtures/sbf-swaps.json").read_text())["cases"]
for index, case in enumerate(cases):
    result = run(SBF, case)
    assert result["output"] == case["expected_output"], (index, result["output"], case["expected_output"])
print(f"Passed {len(cases)} signed Rust LiteSVM swaps")
