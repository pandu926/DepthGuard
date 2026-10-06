"use strict";
const fs = require("node:fs");
const { Connection } = require("@solana/web3.js");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function endpoint() {
  return process.env.DEVNET_RPC_FILE
    ? fs.readFileSync(process.env.DEVNET_RPC_FILE, "utf8").trim()
    : process.env.DEVNET_RPC_URL || "https://api.devnet.solana.com";
}
async function retryFetch(url, options) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(20000),
      });
      if (![429, 502, 503, 504].includes(response.status)) return response;
      await response.arrayBuffer();
    } catch {
      // Retrying RPC submission uses the same signed wire and therefore signature.
    }
    if (attempt < 3) await sleep(1000 * 2 ** attempt);
  }
  throw Error("Devnet RPC transport retries exhausted");
}
function connect(commitment = "confirmed") {
  return new Connection(endpoint(), {
    commitment,
    fetch: retryFetch,
    disableRetryOnRateLimit: true,
  });
}
module.exports = { endpoint, connect, retryFetch };
