"use strict";
// Isolated, resumable devnet release. Never reads or changes the global CLI wallet.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
} = require("@solana/web3.js");
const { Program, AnchorProvider, Wallet } = require("@coral-xyz/anchor");
const { CpAmm } = require("@meteora-ag/cp-amm-sdk");
const dbc = require("@meteora-ag/dynamic-bonding-curve-sdk");
const root = path.resolve(__dirname, "../..");
const dir = path.join(root, ".local/devnet");
const endpoint = require("./devnet-rpc.cjs").endpoint();
assert.equal(new URL(endpoint).protocol, "https:");
const connection = require("./devnet-rpc.cjs").connect("finalized");
const loader = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const config = dbc.DAMM_V2_MIGRATION_FEE_ADDRESS[6];
const manifest = require("../build-manifest.json");
const key = (name) =>
  Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(fs.readFileSync(path.join(dir, "keys", `${name}.json`))),
    ),
  );
const evidenceFile = path.join(
  root,
  "contracts/tests/evidence/devnet-deployment.json",
);
const previous = fs.existsSync(evidenceFile)
  ? JSON.parse(fs.readFileSync(evidenceFile))
  : {};
const evidence = {
  ...previous,
  network: "devnet",
  recorded_at: new Date().toISOString(),
  production_certified: false,
  programs: [],
  transactions: previous.transactions || [],
};
delete evidence.error;
function save() {
  fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
  fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2) + "\n");
}
async function cli(args, name) {
  if (process.env.DEVNET_DEPLOY_RPC_URL) {
    const transport = new Connection(
      process.env.DEVNET_DEPLOY_RPC_URL,
      "confirmed",
    );
    assert.equal(
      await transport.getGenesisHash(),
      "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
      "Deployment transport is not devnet",
    );
  }
  const executable =
    process.env.SOLANA_CLI ||
    path.join(root, ".local/agave-4.0.0/solana-release/bin/solana");
  const log = fs.openSync(path.join(dir, `${name}.log`), "a", 0o600);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(
        executable,
        [
          "--url",
          process.env.DEVNET_DEPLOY_RPC_URL || endpoint,
          "--keypair",
          path.join(dir, "keys/authority.json"),
          ...args,
        ],
        { stdio: ["ignore", log, log] },
      );
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0
          ? resolve()
          : reject(Error(`${name} failed; inspect .local/devnet/${name}.log`)),
      );
    });
  } finally {
    fs.closeSync(log);
  }
}
async function verifiedProgram(entry, authority) {
  const address = new PublicKey(entry.address);
  const account = await connection.getAccountInfo(address);
  if (!account) return null;
  assert(
    account.executable && account.owner.equals(loader),
    "Unexpected deployment owner",
  );
  const dataAddress = PublicKey.findProgramAddressSync(
    [address.toBuffer()],
    loader,
  )[0];
  assert(account.data.subarray(4, 36).equals(dataAddress.toBuffer()));
  const data = await connection.getAccountInfo(dataAddress);
  assert(data && data.owner.equals(loader) && data.data.readUInt32LE(0) === 3);
  assert.equal(data.data[12], 1, "Devnet program must remain upgradeable");
  assert(
    data.data.subarray(13, 45).equals(authority.publicKey.toBuffer()),
    "Unexpected upgrade authority",
  );
  const binary = fs.readFileSync(
    path.join(root, "contracts/target/deploy", `depthguard_${entry.name}.so`),
  );
  assert.equal(
    crypto.createHash("sha256").update(binary).digest("hex"),
    entry.sha256,
  );
  assert(
    data.data.subarray(45, 45 + binary.length).equals(binary),
    "Deployed binary mismatch",
  );
  const signatures = await connection.getSignaturesForAddress(
    dataAddress,
    { limit: 50 },
    "finalized",
  );
  const deploymentSlot = Number(data.data.readBigUInt64LE(4));
  const deploymentReceipt = signatures.find(
    (receipt) => receipt.slot === deploymentSlot && !receipt.err,
  );
  assert(
    deploymentReceipt,
    "Deployment receipt unavailable at the program deployment slot",
  );
  return {
    ...entry,
    program_data: dataAddress.toBase58(),
    bytecode_verified: true,
    upgrade_authority: authority.publicKey.toBase58(),
    deployment_slot: deploymentSlot,
    deployment_signature: deploymentReceipt.signature,
    explorer: `https://explorer.solana.com/tx/${deploymentReceipt.signature}?cluster=devnet`,
    commitment: "finalized",
  };
}
async function send(label, tx, signers) {
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = (
    await connection.getLatestBlockhash("confirmed")
  ).blockhash;
  tx.sign(...signers);
  const simulation = await connection.simulateTransaction(tx);
  assert.equal(
    simulation.value.err,
    null,
    `${label}: ${JSON.stringify(simulation.value.logs)}`,
  );
  console.log(`${label}: simulation passed`);
  const signature = await sendAndConfirmTransaction(connection, tx, signers, {
    commitment: "finalized",
    preflightCommitment: "confirmed",
  });
  evidence.transactions.push({
    label,
    signature,
    explorer: `https://explorer.solana.com/tx/${signature}?cluster=devnet`,
    commitment: "finalized",
  });
  save();
}
async function fillBuffer(entry, bufferPath, authority) {
  const buffer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(bufferPath))),
  );
  const binary = fs.readFileSync(
    path.join(root, "contracts/target/deploy", `depthguard_${entry.name}.so`),
  );
  let account = await connection.getAccountInfo(buffer.publicKey, "confirmed");
  if (!account) {
    const initialize = new TransactionInstruction({
      programId: loader,
      keys: [
        { pubkey: buffer.publicKey, isSigner: false, isWritable: true },
        { pubkey: authority.publicKey, isSigner: false, isWritable: false },
      ],
      data: Buffer.alloc(4),
    });
    await send(
      `initialize-${entry.name}-buffer`,
      new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: authority.publicKey,
          newAccountPubkey: buffer.publicKey,
          lamports: await connection.getMinimumBalanceForRentExemption(
            binary.length + 37,
          ),
          space: binary.length + 37,
          programId: loader,
        }),
        initialize,
      ),
      [authority, buffer],
    );
    account = await connection.getAccountInfo(buffer.publicKey, "confirmed");
  }
  assert(
    account.owner.equals(loader) &&
      account.data.length === binary.length + 37 &&
      account.data.readUInt32LE(0) === 1 &&
      account.data[4] === 1,
  );
  assert(
    account.data.subarray(5, 37).equals(authority.publicKey.toBuffer()),
    "Unexpected buffer authority",
  );
  const offsets = [];
  for (let offset = 0; offset < binary.length; offset += 900) {
    const chunk = binary.subarray(offset, offset + 900);
    if (
      !account.data
        .subarray(offset + 37, offset + 37 + chunk.length)
        .equals(chunk)
    )
      offsets.push(offset);
  }
  console.log(`${entry.name}: ${offsets.length} remaining upload chunks`);
  for (let start = 0; start < offsets.length; start += 12) {
    const latest = await connection.getLatestBlockhash("confirmed");
    const signatures = [];
    for (const offset of offsets.slice(start, start + 12)) {
      const chunk = binary.subarray(offset, offset + 900);
      const header = Buffer.alloc(16);
      header.writeUInt32LE(1, 0); // UpgradeableLoaderInstruction::Write
      header.writeUInt32LE(offset, 4);
      header.writeBigUInt64LE(BigInt(chunk.length), 8);
      const tx = new Transaction({
        feePayer: authority.publicKey,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      }).add(
        new TransactionInstruction({
          programId: loader,
          keys: [
            { pubkey: buffer.publicKey, isSigner: false, isWritable: true },
            { pubkey: authority.publicKey, isSigner: true, isWritable: false },
          ],
          data: Buffer.concat([header, chunk]),
        }),
      );
      tx.sign(authority);
      if (start === 0 && signatures.length === 0) {
        const simulation = await connection.simulateTransaction(tx);
        assert.equal(
          simulation.value.err,
          null,
          "Buffer write simulation rejected",
        );
        console.log(`${entry.name}: buffer write simulation passed`);
      }
      signatures.push(
        await connection.sendRawTransaction(tx.serialize(), {
          skipPreflight: false,
          preflightCommitment: "confirmed",
          maxRetries: 3,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    let confirmed = false;
    for (let retry = 0; retry < 40; retry++) {
      const statuses = await connection.getSignatureStatuses(signatures);
      assert(
        statuses.value.every((s) => !s?.err),
        "Buffer transaction failed",
      );
      if (
        statuses.value.every((s) =>
          ["confirmed", "finalized"].includes(s?.confirmationStatus),
        )
      ) {
        confirmed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert(
      confirmed,
      "Buffer upload confirmation deadline; retry with the same buffer",
    );
    if (start % 60 === 0)
      console.log(
        `${entry.name}: uploaded ${Math.min(start + 12, offsets.length)}/${offsets.length} remaining chunks`,
      );
  }
  const verified = await connection.getAccountInfo(
    buffer.publicKey,
    "confirmed",
  );
  assert(
    verified.data.subarray(37).equals(binary),
    "Uploaded buffer differs from release binary",
  );
  console.log(`${entry.name}: uploaded buffer bytecode verified`);
}
(async () => {
  fs.mkdirSync(path.join(dir, "keys"), { recursive: true, mode: 0o700 });
  for (const name of [
    "authority",
    "creator",
    "trader",
    "reviewer-1",
    "reviewer-2",
    "reviewer-3",
  ]) {
    const file = path.join(dir, "keys", `${name}.json`);
    if (!fs.existsSync(file))
      fs.writeFileSync(
        file,
        JSON.stringify([...Keypair.generate().secretKey]),
        { mode: 0o600 },
      );
    fs.chmodSync(file, 0o600);
  }
  assert.equal(
    await connection.getGenesisHash(),
    "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    "Refusing non-devnet network",
  );
  const authority = key("authority");
  evidence.authority = authority.publicKey.toBase58();
  evidence.balance_before_sol =
    (await connection.getBalance(authority.publicKey)) / 1e9;
  for (const address of [
    dbc.DYNAMIC_BONDING_CURVE_PROGRAM_ID,
    dbc.DAMM_V2_PROGRAM_ID,
    new PublicKey("dfsdo2UqvwfN8DuUVrMRNfQe11VaiNoKcMqLHVvDPzh"),
  ]) {
    assert(
      (await connection.getAccountInfo(address))?.executable,
      `Missing native program ${address}`,
    );
  }
  const configAccount = await connection.getAccountInfo(config);
  assert(configAccount?.owner.equals(dbc.DAMM_V2_PROGRAM_ID));
  const configState = await new CpAmm(connection).fetchConfigState(config);
  assert.equal(configState.configType, 1);
  assert(configState.poolCreatorAuthority.equals(dbc.deriveDbcPoolAuthority()));
  evidence.damm_config = config.toBase58();
  const action = process.argv[2] || "preflight";
  assert(
    ["preflight", "faucet", "deploy", "verify"].includes(action),
    "Invalid action",
  );
  if (action === "faucet") await cli(["airdrop", "2"], "faucet");
  for (const entry of manifest.programs) {
    let verified = await verifiedProgram(entry, authority);
    if (!verified && action === "deploy") {
      const binaryPath = path.join(
        root,
        "contracts/target/deploy",
        `depthguard_${entry.name}.so`,
      );
      const identityPath = path.join(
        root,
        "contracts/target/deploy",
        `depthguard_${entry.name}-keypair.json`,
      );
      const identity = Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(fs.readFileSync(identityPath))),
      );
      assert.equal(identity.publicKey.toBase58(), entry.address);
      assert.equal(
        crypto
          .createHash("sha256")
          .update(fs.readFileSync(binaryPath))
          .digest("hex"),
        entry.sha256,
      );
      const rent = await connection.getMinimumBalanceForRentExemption(
        entry.size + 45,
      );
      const bufferRent = await connection.getMinimumBalanceForRentExemption(
        entry.size + 37,
      );
      const balance = await connection.getBalance(authority.publicKey);
      assert(
        balance > rent + bufferRent + 20_000_000,
        `Insufficient deployment balance for ${entry.name}`,
      );
      const bufferPath = path.join(dir, "keys", `buffer-${entry.name}.json`);
      if (!fs.existsSync(bufferPath))
        fs.writeFileSync(
          bufferPath,
          JSON.stringify([...Keypair.generate().secretKey]),
          { mode: 0o600 },
        );
      console.log(
        `Deploying ${entry.name}; authority balance ${balance / 1e9} devnet SOL`,
      );
      await fillBuffer(entry, bufferPath, authority);
      await cli(
        [
          "program",
          "deploy",
          binaryPath,
          "--program-id",
          identityPath,
          "--upgrade-authority",
          path.join(dir, "keys/authority.json"),
          "--buffer",
          bufferPath,
          "--max-len",
          String(entry.size),
          "--use-rpc",
          "--with-compute-unit-price",
          "1000",
          "--max-sign-attempts",
          "5",
          "--output",
          "json",
        ],
        `deploy-${entry.name}`,
      );
      for (let attempt = 0; attempt < 30; attempt++) {
        verified = await verifiedProgram(entry, authority);
        if (verified) break;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      assert(verified);
      console.log(`${entry.name}: finalized bytecode verified`);
    }
    evidence.programs.push(verified || { ...entry, deployed: false });
    save();
  }
  if (["deploy", "verify"].includes(action)) {
    const registry = new PublicKey(manifest.programs[0].address);
    const platform = PublicKey.findProgramAddressSync(
      [Buffer.from("platform")],
      registry,
    )[0];
    const programData = PublicKey.findProgramAddressSync(
      [registry.toBuffer()],
      loader,
    )[0];
    const program = new Program(
      require("../idl/depthguard_registry.json"),
      new AnchorProvider(connection, new Wallet(authority), {}),
    );
    if (action === "deploy" && !(await connection.getAccountInfo(platform)))
      await send(
        "initialize-platform",
        await program.methods
          .initializePlatform(authority.publicKey, config)
          .accountsPartial({
            platform,
            authority: authority.publicKey,
            programData,
            systemProgram: SystemProgram.programId,
          })
          .transaction(),
        [authority],
      );
    const state = await program.account.platform.fetch(platform);
    assert(
      state.authority.equals(authority.publicKey) &&
        state.recipient.equals(authority.publicKey) &&
        state.dammConfig.equals(config) &&
        !state.paused,
    );
    evidence.platform = {
      address: platform.toBase58(),
      initialized: true,
      damm_config: state.dammConfig.toBase58(),
    };
    // Reduced devnet curves use 0.1 SOL graduation targets, not the 5 SOL product preset.
    if (action === "deploy")
      for (const [name, target] of [
        ["creator", 1_500_000_000],
        ["trader", 100_000_000],
        ["reviewer-1", 30_000_000],
        ["reviewer-2", 30_000_000],
        ["reviewer-3", 30_000_000],
      ]) {
        const recipient = key(name).publicKey;
        const balance = await connection.getBalance(recipient);
        if (balance < target)
          await send(
            `fund-${name}`,
            new Transaction().add(
              SystemProgram.transfer({
                fromPubkey: authority.publicKey,
                toPubkey: recipient,
                lamports: target - balance,
              }),
            ),
            [authority],
          );
      }
  }
  if (action === "verify")
    assert(
      evidence.programs.every((p) => p.bytecode_verified),
      "Release is not fully deployed",
    );
  evidence.balance_after_sol =
    (await connection.getBalance(authority.publicKey)) / 1e9;
  evidence.deployment_verified = evidence.programs.every(
    (p) => p.bytecode_verified,
  );
  evidence.e2e_accepted = false;
  save();
  console.log(JSON.stringify(evidence));
})().catch((error) => {
  evidence.error = error.message;
  save();
  console.error(error.message);
  process.exitCode = 1;
});
