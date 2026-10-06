#!/usr/bin/env python3
"""Bounded read-only staging smoke, deliberately not a sustained production load claim."""
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import json
import os
import statistics
import time
from urllib.error import HTTPError
from urllib.parse import urlparse
from urllib.request import urlopen
url=os.environ.get("API_URL","http://127.0.0.1:8800")
parsed=urlparse(url)
if parsed.hostname not in ("localhost","127.0.0.1","::1") or parsed.username or parsed.password or parsed.query:
    raise SystemExit("This acceptance smoke is restricted to a local staging API")
def read(index):
    start=time.monotonic()
    endpoint="/api/v1/model-versions?limit=20" if index%2 else "/health/ready"
    try:
        response=urlopen(url+endpoint,timeout=10)
    except HTTPError as error:
        response=error
    with response:
        body=json.loads(response.read())
        status=response.status
        assert response.headers.get("X-Request-ID"),"Missing request identity"
        assert status in (200,429),body
    return status,(time.monotonic()-start)*1000
start=time.monotonic()
with ThreadPoolExecutor(max_workers=16) as executor:
    results=list(executor.map(read,range(320)))
latencies=sorted(latency for _,latency in results)
print(json.dumps({"status":"passed","scope":"short_local_read_only_smoke","production_capacity_certified":False,"requests":len(results),"concurrency":16,"elapsed_seconds":round(time.monotonic()-start,3),"statuses":dict(Counter(code for code,_ in results)),"p50_ms":round(statistics.median(latencies),3),"p95_ms":round(latencies[int(len(latencies)*.95)-1],3),"p99_ms":round(latencies[int(len(latencies)*.99)-1],3)}))
