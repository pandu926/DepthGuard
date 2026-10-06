import fs from "node:fs";
const endpoint = process.env.DEVNET_RPC_FILE
  ? fs.readFileSync(process.env.DEVNET_RPC_FILE, "utf8").trim()
  : process.env.DEVNET_RPC_URL || "https://api.devnet.solana.com";
const url = new URL(endpoint);
if (url.protocol !== "https:") throw Error("Devnet RPC requires HTTPS.");
const programs = {
  dbc: "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",
  damm_v2: "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG",
  dfs: "dfsdo2UqvwfN8DuUVrMRNfQe11VaiNoKcMqLHVvDPzh",
  registry: "5sUGNQ5pymevqfVmg99rgQ2jM4aVSo6RqhJtSK7VrPYz",
  escrow: "8zEaBFNNVDx9U4Cr111xfZjUmX7JMBapJhd6yT4XwtuZ",
  reserve: "7kaGXYpxPuCoh5o2AhxRoU8F13UUkHjfxVZUTYsKG88Y",
};
async function rpc(method, params = []) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw Error(`RPC HTTP ${response.status}`);
  const r = await response.json();
  if (r.error) throw Error("RPC preflight request failed.");
  return r.result;
}
const evidence = {
  network: "devnet",
  read_only: true,
  writes_performed: false,
  release_accepted: false,
  recorded_at: new Date().toISOString(),
  programs: [],
};
try {
  const genesis = await rpc("getGenesisHash");
  if (genesis !== "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG")
    throw Error("Configured RPC is not devnet.");
  const response = await rpc("getMultipleAccounts", [
    Object.values(programs),
    { encoding: "base64", commitment: "finalized" },
  ]);
  evidence.programs = Object.entries(programs).map(([name, address], i) => ({
    name,
    address,
    deployed: Boolean(response.value[i]?.executable),
    owner: response.value[i]?.owner || null,
  }));
  evidence.blockers = evidence.programs
    .filter((p) => !p.deployed)
    .map(
      (p) => `${p.name} program is not deployed at the configured release ID`,
    );
  const read = (file) =>
    fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
  const deployment = read("contracts/tests/evidence/devnet-deployment.json");
  const lifecycle = read("web/tests/evidence/devnet-lifecycle.json");
  const manifest = read("contracts/build-manifest.json");
  const verified =
    deployment?.network === "devnet" &&
    deployment.deployment_verified &&
    deployment.platform?.initialized &&
    manifest?.programs.every((p) =>
      deployment.programs.some(
        (d) =>
          d.address === p.address &&
          d.sha256 === p.sha256 &&
          d.bytecode_verified,
      ),
    );
  if (!verified)
    evidence.blockers.push(
      "Verify release bytecode, authority and platform initialization on devnet.",
    );
  const lifecycleRelease =
    lifecycle?.release_programs || lifecycle?.extra?.release_programs;
  const lifecycleMatches =
    lifecycle?.network === "devnet" &&
    lifecycle.e2e_accepted &&
    manifest?.programs.every((p) =>
      lifecycleRelease?.some(
        (l) => l.address === p.address && l.sha256 === p.sha256,
      ),
    );
  if (!lifecycleMatches)
    evidence.blockers.push(
      "Complete real devnet browser and multi-wallet lifecycle acceptance for this release binary.",
    );
  evidence.release_accepted = evidence.blockers.length === 0;
  evidence.acceptance_scope = "devnet_only";
  evidence.production_certified = false;
} catch (error) {
  evidence.blockers = [
    error.message,
    "RPC connectivity must pass before devnet deployment or lifecycle acceptance.",
  ];
}
fs.mkdirSync("web/tests/evidence", { recursive: true });
fs.writeFileSync(
  "web/tests/evidence/devnet-preflight.json",
  JSON.stringify(evidence, null, 2) + "\n",
);
console.log(JSON.stringify(evidence));
if (!evidence.release_accepted) process.exitCode = 1;
