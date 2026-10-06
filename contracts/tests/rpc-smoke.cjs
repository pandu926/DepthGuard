"use strict";
// Genuine Agave RPC acceptance. Public endpoints are deliberately unsupported here.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  SystemProgram,
  sendAndConfirmTransaction,
} = require("@solana/web3.js");
const {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
} = require("@solana/spl-token");
const { Program, AnchorProvider, Wallet } = require("@coral-xyz/anchor");
const BN = require("bn.js");
const dbc = require("@meteora-ag/dynamic-bonding-curve-sdk");
const { buildPair } = require("../../proof/src/curves.ts");
const { decimalJson } = require("../../proof/src/run.ts");
const root = path.resolve(__dirname, "../..");
const ids = {
  registry: new PublicKey("5sUGNQ5pymevqfVmg99rgQ2jM4aVSo6RqhJtSK7VrPYz"),
  reserve: new PublicKey("7kaGXYpxPuCoh5o2AhxRoU8F13UUkHjfxVZUTYsKG88Y"),
};
const connection = new Connection("http://127.0.0.1:18999", "confirmed");
const native = (input) => {
  const p = spawnSync(
    path.join(root, "backend/native/target/debug/depthguard-native"),
    { input: JSON.stringify(input), encoding: "utf8", timeout: 10000 },
  );
  assert.equal(p.status, 0);
  const r = JSON.parse(p.stdout);
  assert(r.ok, r.error);
  return r.result;
};
const instruction = (v) =>
  new TransactionInstruction({
    programId: new PublicKey(v.program_id),
    data: Buffer.from(v.data, "base64"),
    keys: v.accounts.map((a) => ({
      pubkey: new PublicKey(a.address),
      isSigner: a.signer,
      isWritable: a.writable,
    })),
  });
const addresses = (v) =>
  Object.fromEntries(
    Object.entries(v).map(([k, v]) => [
      k,
      v instanceof PublicKey ? v.toBase58() : v,
    ]),
  );
const snake = (v) =>
  Array.isArray(v)
    ? v.map(snake)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v).map(([k, v]) => [
            k.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase()),
            snake(v),
          ]),
        )
      : v;
const pda = (program, seeds) =>
  PublicKey.findProgramAddressSync(seeds, program)[0];
(async () => {
  const operator = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(
          path.join(root, ".local/contracts/operator-keypair.json"),
        ),
      ),
    ),
  );
  const platform = Keypair.generate(),
    config = Keypair.generate(),
    mint = Keypair.generate(),
    feeBase = Keypair.generate(),
    first = Keypair.generate(),
    second = Keypair.generate();
  const genesis = await connection.getGenesisHash();
  assert(
    ![
      "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
      "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    ].includes(genesis),
  );
  const deployedPrograms = [];
  const loader = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "contracts/build-manifest.json")),
  );
  for (const entry of manifest.programs) {
    const address = new PublicKey(entry.address);
    const program = await connection.getAccountInfo(address);
    assert(program.executable && program.owner.equals(loader));
    const programData = pda(loader, [address.toBuffer()]);
    assert(
      Buffer.from(program.data).subarray(4, 36).equals(programData.toBuffer()),
    );
    const account = await connection.getAccountInfo(programData);
    assert(account.owner.equals(loader) && account.data.readUInt32LE(0) === 3);
    const binary = fs.readFileSync(
      path.join(root, "contracts/target/deploy", `depthguard_${entry.name}.so`),
    );
    assert(
      account.data.subarray(45, 45 + binary.length).equals(binary),
      "Deployed code differs from build artifact",
    );
    assert.equal(
      crypto.createHash("sha256").update(binary).digest("hex"),
      entry.sha256,
    );
    deployedPrograms.push({
      ...entry,
      bytecode_verified: true,
      upgrade_authority_present: account.data[12] === 1,
    });
  }
  const airdrop = await connection.requestAirdrop(
    operator.publicKey,
    100_000_000_000,
  );
  await connection.confirmTransaction(airdrop, "confirmed");
  const receipts = [];
  async function send(label, tx, signers = [operator]) {
    const signature = await sendAndConfirmTransaction(connection, tx, signers, {
      commitment: "confirmed",
    });
    const t = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    assert(t && !t.meta.err, label);
    receipts.push({
      label,
      signature,
      slot: t.slot,
      compute_units: t.meta.computeUnitsConsumed,
    });
    return signature;
  }
  async function action(name, accounts, args, signers = [operator]) {
    return send(
      name,
      new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1000000 }),
        instruction(
          native({
            operation: "contract_build",
            action: name,
            accounts: addresses(accounts),
            args,
          }),
        ),
      ),
      signers,
    );
  }
  const damm = dbc.createDammV2Program(connection);
  const migrationOperator = pda(dbc.DAMM_V2_PROGRAM_ID, [
    Buffer.from("operator"),
    operator.publicKey.toBuffer(),
  ]);
  if (!(await connection.getAccountInfo(migrationOperator)))
    await send(
      "native-operator",
      await damm.methods
        .createOperatorAccount(new BN(1))
        .accountsPartial({
          operator: migrationOperator,
          whitelistedAddress: operator.publicKey,
          signer: operator.publicKey,
          payer: operator.publicKey,
        })
        .transaction(),
    );
  const dammConfig = pda(dbc.DAMM_V2_PROGRAM_ID, [
    Buffer.from("config"),
    new BN(701).toArrayLike(Buffer, "le", 8),
  ]);
  if (!(await connection.getAccountInfo(dammConfig)))
    await send(
      "native-migration-config",
      await damm.methods
        .createDynamicConfig(new BN(701), {
          poolCreatorAuthority: dbc.deriveDbcPoolAuthority(),
          permission: new BN(1),
        })
        .accountsPartial({
          config: dammConfig,
          operator: migrationOperator,
          signer: operator.publicKey,
          payer: operator.publicKey,
        })
        .transaction(),
    );
  const program = new Program(
    require("../idl/depthguard_registry.json"),
    new AnchorProvider(connection, new Wallet(operator), {}),
  );
  const platformAccount = pda(ids.registry, [Buffer.from("platform")]);
  if (!(await connection.getAccountInfo(platformAccount)))
    await send(
      "initialize-platform-real-loader",
      await program.methods
        .initializePlatform(platform.publicKey, dammConfig)
        .accountsPartial({
          platform: platformAccount,
          authority: operator.publicKey,
          programData: pda(
            new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"),
            [ids.registry.toBuffer()],
          ),
          systemProgram: SystemProgram.programId,
        })
        .transaction(),
    );
  const stored = await program.account.platform.fetch(platformAccount);
  const platformWallet = stored.recipient;
  assert(stored.dammConfig.equals(dammConfig));
  const fee = native({
    operation: "fee_create",
    base: feeBase.publicKey.toBase58(),
    wallet: operator.publicKey.toBase58(),
    quote_mint: NATIVE_MINT.toBase58(),
    recipients: [
      { wallet: operator.publicKey.toBase58(), share: 9000 },
      { wallet: platformWallet.toBase58(), share: 1000 },
    ],
  });
  await send("native-dfs", new Transaction().add(instruction(fee)), [
    operator,
    feeBase,
  ]);
  const feeVault = new PublicKey(fee.vault),
    params = snake(decimalJson(buildPair().baseline));
  params.padding = [0, 0];
  params.migration_fee = { fee_percentage: 5, creator_fee_percentage: 100 };
  const encoded = native({
    operation: "contract_model",
    publisher: operator.publicKey.toBase58(),
    parent: PublicKey.default.toBase58(),
    author: operator.publicKey.toBase58(),
    parameters: params,
    mechanism: 2,
    quote_decimals: 9,
    launcher_bps: 8000,
    author_bps: 1000,
    platform_bps: 1000,
    reviewer_threshold: 0,
    milestones: [],
  });
  const model = pda(ids.registry, [
    Buffer.from("model"),
    operator.publicKey.toBuffer(),
    Buffer.from(encoded.digest, "base64"),
  ]);
  if (!(await connection.getAccountInfo(model))) {
    await action(
      "begin_model",
      { platform: platformAccount, model, publisher: operator.publicKey },
      {
        digest: encoded.digest,
        json_hash: crypto
          .createHash("sha256")
          .update(encoded.bytes)
          .digest("base64"),
        size: String(encoded.size),
      },
    );
    const bytes = Buffer.from(encoded.bytes, "base64");
    for (let o = 0; o < bytes.length; o += 500)
      await action(
        "write_model",
        { model, publisher: operator.publicKey },
        {
          offset: String(o),
          bytes: bytes.subarray(o, o + 500).toString("base64"),
        },
      );
    await action("seal_model", { model, publisher: operator.publicKey }, {});
  }
  const nonce = BigInt(Date.now()),
    nonceBytes = Buffer.alloc(8);
  nonceBytes.writeBigUInt64LE(nonce);
  const launch = pda(ids.registry, [
    Buffer.from("launch"),
    model.toBuffer(),
    operator.publicKey.toBuffer(),
    nonceBytes,
  ]);
  await action(
    "initialize_launch",
    {
      platform: platformAccount,
      model,
      launch,
      launcher: operator.publicKey,
      system_program: SystemProgram.programId,
    },
    {
      nonce: String(nonce),
      config: config.publicKey.toBase58(),
      base_mint: mint.publicKey.toBase58(),
      fee_vault: feeVault.toBase58(),
      first_position_mint: first.publicKey.toBase58(),
      reviewers: [],
    },
  );
  const eventAuthority = pda(dbc.DYNAMIC_BONDING_CURVE_PROGRAM_ID, [
    Buffer.from("__event_authority"),
  ]);
  await action(
    "create_config",
    {
      platform: platformAccount,
      model,
      launch,
      config: config.publicKey,
      fee_vault: feeVault,
      quote_mint: NATIVE_MINT,
      launcher: operator.publicKey,
      dbc_program: dbc.DYNAMIC_BONDING_CURVE_PROGRAM_ID,
      event_authority: eventAuthority,
      system_program: SystemProgram.programId,
    },
    {},
    [operator, config],
  );
  const pool = dbc.deriveDbcPoolAddress(
    NATIVE_MINT,
    mint.publicKey,
    config.publicKey,
  );
  const upstream = native({
    operation: "dbc_pool",
    config: config.publicKey.toBase58(),
    base_mint: mint.publicKey.toBase58(),
    wallet: operator.publicKey.toBase58(),
    quote_mint: NATIVE_MINT.toBase58(),
    name: "RPC Backed Token",
    symbol: "RBT",
    uri: "https://example.com/rbt.json",
  });
  const common = {
    launch,
    config: config.publicKey,
    pool_authority: dbc.deriveDbcPoolAuthority(),
    base_mint: mint.publicKey,
    quote_mint: NATIVE_MINT,
    pool,
    base_vault: new PublicKey(upstream.base_vault),
    quote_vault: new PublicKey(upstream.quote_vault),
    mint_metadata: new PublicKey(upstream.accounts[8].address),
    metadata_program: dbc.METAPLEX_PROGRAM_ID,
    launcher: operator.publicKey,
    token_program: TOKEN_PROGRAM_ID,
    dbc_program: dbc.DYNAMIC_BONDING_CURVE_PROGRAM_ID,
    system_program: SystemProgram.programId,
    event_authority: eventAuthority,
  };
  await send(
    "fund-native-flash-rent-authority",
    new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: operator.publicKey,
        toPubkey: dbc.deriveDbcPoolAuthority(),
        lamports: 1_000_000_000,
      }),
    ),
  );
  await action(
    "create_pool",
    common,
    {
      name: "RPC Backed Token",
      symbol: "RBT",
      uri: "https://example.com/rbt.json",
    },
    [operator, mint],
  );
  const vault = pda(ids.reserve, [Buffer.from("vault"), launch.toBuffer()]),
    tokenVault = getAssociatedTokenAddressSync(NATIVE_MINT, vault, true);
  await action(
    "initialize_module",
    {
      launch,
      model,
      base_mint: mint.publicKey,
      quote_mint: NATIVE_MINT,
      module_vault: vault,
      token_vault: tokenVault,
      module_program: ids.reserve,
      launcher: operator.publicKey,
      token_program: TOKEN_PROGRAM_ID,
      associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
      system_program: SystemProgram.programId,
    },
    {},
  );
  const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, operator.publicKey);
  await send(
    "fund-local-trader",
    new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        operator.publicKey,
        wsol,
        operator.publicKey,
        NATIVE_MINT,
      ),
      SystemProgram.transfer({
        fromPubkey: operator.publicKey,
        toPubkey: wsol,
        lamports: 12_000_000_000,
      }),
      createSyncNativeInstruction(wsol),
    ),
  );
  const clock = await connection.getSlot();
  const timestamp = await connection.getBlockTime(clock);
  const swap = native({
    operation: "swap_prepare",
    protocol: "dbc",
    pool: pool.toBase58(),
    wallet: operator.publicKey.toBase58(),
    pool_data: (await connection.getAccountInfo(pool)).data.toString("base64"),
    config_data: (
      await connection.getAccountInfo(config.publicKey)
    ).data.toString("base64"),
    config_address: config.publicKey.toBase58(),
    amount: "10000000000",
    mode: "partial_fill",
    base_for_quote: false,
    slot: String(clock),
    timestamp: String(timestamp),
    slippage_bps: 100,
  });
  await send(
    "graduate",
    new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1000000 }),
      ...swap.instructions.map(instruction),
    ),
  );
  const migration = native({
    operation: "dbc_migrate",
    wallet: operator.publicKey.toBase58(),
    config: config.publicKey.toBase58(),
    base_mint: mint.publicKey.toBase58(),
    quote_mint: NATIVE_MINT.toBase58(),
    damm_config: dammConfig.toBase58(),
    first_position_mint: first.publicKey.toBase58(),
    second_position_mint: second.publicKey.toBase58(),
  });
  await send(
    "native-migration",
    new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1000000 }),
      instruction(migration),
    ),
    [operator, first, second],
  );
  await action(
    "verify_migration",
    {
      launch,
      base_mint: mint.publicKey,
      config: config.publicKey,
      pool,
      damm_pool: new PublicKey(migration.damm_pool),
      position: dbc.derivePositionAddress(first.publicKey),
      position_nft: dbc.derivePositionNftAccount(first.publicKey),
    },
    {},
  );
  await action(
    "fund_and_activate",
    {
      launch,
      config: config.publicKey,
      pool,
      module_vault: vault,
      token_vault: tokenVault,
      module_program: ids.reserve,
      quote_mint: NATIVE_MINT,
      quote_vault: new PublicKey(upstream.quote_vault),
      pool_authority: dbc.deriveDbcPoolAuthority(),
      token_program: TOKEN_PROGRAM_ID,
      dbc_program: dbc.DYNAMIC_BONDING_CURVE_PROGRAM_ID,
      event_authority: eventAuthority,
    },
    {},
  );
  const holderTokens = getAssociatedTokenAddressSync(
    mint.publicKey,
    operator.publicKey,
  );
  const before = BigInt(
    (await connection.getTokenAccountBalance(tokenVault)).value.amount,
  );
  const supply = BigInt(
    (await connection.getTokenSupply(mint.publicKey)).value.amount,
  );
  const burn =
    BigInt(
      (await connection.getTokenAccountBalance(holderTokens)).value.amount,
    ) / 100n;
  await action(
    "reserve_redeem",
    {
      vault,
      base_mint: mint.publicKey,
      holder: operator.publicKey,
      holder_tokens: holderTokens,
      token_vault: tokenVault,
      receiver: wsol,
      token_program: TOKEN_PROGRAM_ID,
    },
    { burn_amount: String(burn), min_payout: String((burn * before) / supply) },
  );
  assert.equal(
    BigInt((await connection.getTokenAccountBalance(tokenVault)).value.amount),
    before - (burn * before) / supply,
  );
  await connection.confirmTransaction(
    {
      signature: receipts.at(-1).signature,
      ...(await connection.getLatestBlockhash()),
    },
    "finalized",
  );
  const report = {
    build_manifest: JSON.parse(
      fs.readFileSync(path.join(root, "contracts/build-manifest.json")),
    ),
    deployed_programs: deployedPrograms,
    status: "passed",
    runtime: "Agave 4.0.0",
    endpoint: "http://127.0.0.1:18999",
    genesis_hash: genesis,
    public_transactions_sent: 0,
    production_certified: false,
    checks: [
      "real_upgradeable_loader_authority",
      "native_DFS",
      "staged_registry_model",
      "factory_DBC_config_and_pool",
      "native_DAMM_migration",
      "verified_capital_activation",
      "atomic_reserve_redemption",
    ],
    launch: launch.toBase58(),
    vault: vault.toBase58(),
    capital_funded: String(before),
    receipts,
  };
  fs.writeFileSync(
    path.join(root, "contracts/tests/evidence/rpc-smoke.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    "PASS real local validator lifecycle:",
    receipts.length,
    "transactions",
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
