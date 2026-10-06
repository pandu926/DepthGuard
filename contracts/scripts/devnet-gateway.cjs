"use strict";
// Bound deployment traffic to the public devnet RPC instead of overwhelming it.
// Loopback only; not a public proxy and not an alternate Solana cluster.
const http = require("node:http");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const endpoint = process.env.DEVNET_RPC_FILE
  ? fs.readFileSync(process.env.DEVNET_RPC_FILE, "utf8").trim()
  : process.env.DEVNET_RPC_URL || "https://api.devnet.solana.com";
assert.equal(new URL(endpoint).protocol, "https:");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let tail = Promise.resolve();
let queued = 0;
async function forward(body) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(20000),
    });
    const value = await response.text();
    if (response.status !== 429) return { status: response.status, value };
    console.log(`Devnet RPC throttled; bounded retry ${attempt + 1}`);
    await sleep(5000 * (attempt + 1));
  }
  return {
    status: 503,
    value: JSON.stringify({ error: "Devnet RPC rate limit persisted" }),
  };
}
const server = http.createServer(async (request, response) => {
  if (request.method !== "POST" || queued >= 1024) {
    response.writeHead(503);
    response.end();
    return;
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 4 * 1024 * 1024) {
      response.writeHead(413);
      response.end();
      return;
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString();
  try {
    const rpc = JSON.parse(body);
    assert(!Array.isArray(rpc) && rpc.jsonrpc === "2.0");
  } catch {
    response.writeHead(400);
    response.end();
    return;
  }
  queued++;
  const work = tail.then(async () => {
    try {
      const result = await forward(body);
      response.writeHead(result.status, { "Content-Type": "application/json" });
      response.end(result.value);
    } catch {
      response.writeHead(502);
      response.end();
    } finally {
      queued--;
      await sleep(
        Math.max(100, Number(process.env.DEVNET_RPC_INTERVAL_MS || 300)),
      );
    }
  });
  tail = work.catch(() => {});
});
server.listen(18812, "127.0.0.1", () =>
  console.log("Devnet deployment gateway: 127.0.0.1:18812"),
);
process.on("SIGTERM", () => server.close());
