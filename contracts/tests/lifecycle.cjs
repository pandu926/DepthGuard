const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const {
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  SystemProgram,
} = require("@solana/web3.js");
const BN = require("bn.js");
const dbc = require("@meteora-ag/dynamic-bonding-curve-sdk");
const {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
} = require("@solana/spl-token");
const { ProofVm } = require("../../proof/src/vm.ts");
const { buildPair } = require("../../proof/src/curves.ts");
const { decimalJson } = require("../../proof/src/run.ts");
const { RustVm } = require("./rust-vm.cjs");
const { Program, AnchorProvider, Wallet } = require("@coral-xyz/anchor");
const ROOT = path.resolve(__dirname, "../.."),
  REGISTRY = new PublicKey("5sUGNQ5pymevqfVmg99rgQ2jM4aVSo6RqhJtSK7VrPYz"),
  ESCROW = new PublicKey("8zEaBFNNVDx9U4Cr111xfZjUmX7JMBapJhd6yT4XwtuZ"),
  RESERVE = new PublicKey("7kaGXYpxPuCoh5o2AhxRoU8F13UUkHjfxVZUTYsKG88Y"),
  DFS = new PublicKey("dfsdo2UqvwfN8DuUVrMRNfQe11VaiNoKcMqLHVvDPzh");
const native = (input) => {
  const p = spawnSync(
    path.join(ROOT, "backend/native/target/debug/depthguard-native"),
    { input: JSON.stringify(input), encoding: "utf8", timeout: 10000 },
  );
  assert.equal(p.status, 0, p.stderr);
  const r = JSON.parse(p.stdout);
  assert(r.ok, r.error);
  return r.result;
};
const ix = (value) =>
  new TransactionInstruction({
    programId: new PublicKey(value.program_id),
    data: Buffer.from(value.data, "base64"),
    keys: value.accounts.map((a) => ({
      pubkey: new PublicKey(a.address),
      isSigner: a.signer,
      isWritable: a.writable,
    })),
  });
const names = (obj) =>
  Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [
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
  const vm = new ProofVm(),
    initialMint = vm.svm.getAccount(NATIVE_MINT),
    initialAuthority = vm.svm.getAccount(dbc.deriveDbcPoolAuthority()),
    clock = vm.svm.getClock();
  vm.svm = new RustVm();
  try {
    for (const [id, file] of [
      [dbc.DYNAMIC_BONDING_CURVE_PROGRAM_ID, "dynamic_bonding_curve"],
      [dbc.DAMM_V2_PROGRAM_ID, "cp_amm"],
      [dbc.METAPLEX_PROGRAM_ID, "metaplex"],
      [DFS, "dynamic_fee_sharing"],
    ])
      vm.svm.addProgramFromFile(
        id,
        path.join(ROOT, "proof/fixtures", file + ".so"),
      );
    for (const [id, file] of [
      [REGISTRY, "registry"],
      [ESCROW, "escrow"],
      [RESERVE, "reserve"],
    ])
      vm.svm.addProgramFromFile(
        id,
        path.join(ROOT, "contracts/target/deploy/depthguard_" + file + ".so"),
      );
    vm.svm.setAccount(NATIVE_MINT, initialMint);
    vm.svm.setAccount(dbc.deriveDbcPoolAuthority(), initialAuthority);
    vm.svm.setClock(clock);
    const launcher = vm.wallet(),
      author = vm.wallet(),
      platform = vm.wallet(),
      reviewers = [vm.wallet(), vm.wallet(), vm.wallet()],
      attacker = vm.wallet();
    vm.svm.airdrop(launcher.publicKey, 500_000_000_000n);
    const damm = dbc.createDammV2Program(vm.connection);
    const operator = pda(dbc.DAMM_V2_PROGRAM_ID, [
      Buffer.from("operator"),
      launcher.publicKey.toBuffer(),
    ]);
    const dammConfig = pda(dbc.DAMM_V2_PROGRAM_ID, [
      Buffer.from("config"),
      new BN(601).toArrayLike(Buffer, "le", 8),
    ]);
    vm.send(
      "create-migration-operator",
      await damm.methods
        .createOperatorAccount(new BN(1))
        .accountsPartial({
          operator,
          whitelistedAddress: launcher.publicKey,
          signer: launcher.publicKey,
          payer: launcher.publicKey,
        })
        .transaction(),
      [launcher],
    );
    vm.send(
      "create-migration-config",
      await damm.methods
        .createDynamicConfig(new BN(601), {
          poolCreatorAuthority: dbc.deriveDbcPoolAuthority(),
          permission: new BN(1),
        })
        .accountsPartial({
          config: dammConfig,
          operator,
          signer: launcher.publicKey,
          payer: launcher.publicKey,
        })
        .transaction(),
      [launcher],
    );
    const loader = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
    const programData = pda(loader, [REGISTRY.toBuffer()]);
    const data = Buffer.alloc(45);
    data.writeUInt32LE(3, 0);
    data[12] = 1;
    launcher.publicKey.toBuffer().copy(data, 13);
    // Test-only deployment account: mimics the loader's upgrade-authority record.
    vm.svm.setAccount(programData, {
      owner: loader,
      executable: false,
      lamports: 1e8,
      data,
    });
    const program = new Program(
      require("../idl/depthguard_registry.json"),
      new AnchorProvider(vm.connection, new Wallet(launcher), {}),
    );
    const platformAccount = pda(REGISTRY, [Buffer.from("platform")]);
    vm.send(
      "initialize-platform",
      await program.methods
        .initializePlatform(platform.publicKey, dammConfig)
        .accountsPartial({
          platform: platformAccount,
          authority: launcher.publicKey,
          programData,
          systemProgram: SystemProgram.programId,
        })
        .transaction(),
      [launcher],
    );
    const read = (kind, address) =>
      native({
        operation: "contract_state",
        kind,
        data: Buffer.from(vm.svm.getAccount(address).data).toString("base64"),
      });
    const send = (action, accounts, args, signers = [launcher]) => {
      const built = native({
        operation: "contract_build",
        action,
        accounts: names(accounts),
        args,
      });
      vm.send(
        action,
        new Transaction().add(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 1000000 }),
          ix(built),
        ),
        signers,
      );
      return built;
    };
    const originalSend = vm.send.bind(vm);
    vm.send = (label, tx, signers) => {
      originalSend(label, tx, signers);
      const wireBytes = tx.serialize().length;
      assert(wireBytes <= 1232);
      vm.receipts.at(-1).wire_bytes = wireBytes;
    };
    const results = [];
    let httpFixture;
    const security = [];
    for (const mechanism of [0, 1, 2, 3])
      for (const compounding of [0, 5000, 10000]) {
        const config = Keypair.generate(),
          mint = Keypair.generate(),
          feeBase = Keypair.generate(),
          plannedFirst = Keypair.generate(),
          second = Keypair.generate();
        const first =
          mechanism === 2 && compounding === 5000
            ? Keypair.generate()
            : plannedFirst;
        const prepared = native({
          operation: "fee_create",
          base: feeBase.publicKey.toBase58(),
          wallet: launcher.publicKey.toBase58(),
          quote_mint: NATIVE_MINT.toBase58(),
          recipients: [
            { wallet: launcher.publicKey.toBase58(), share: 8000 },
            { wallet: author.publicKey.toBase58(), share: 1000 },
            { wallet: platform.publicKey.toBase58(), share: 1000 },
          ],
        });
        vm.send("create-native-dfs", new Transaction().add(ix(prepared)), [
          launcher,
          feeBase,
        ]);
        const feeVault = new PublicKey(prepared.vault);
        const params = snake(decimalJson(buildPair().baseline));
        if (mechanism === 0 && compounding === 0) {
          // Split both constant-liquidity baseline segments while preserving their shapes.
          assert.equal(params.curve.length, 2);
          let start = BigInt(params.sqrt_start_price);
          params.curve = params.curve.flatMap((point) => {
            const end = BigInt(point.sqrt_price),
              lower = start;
            start = end;
            return Array.from({ length: 8 }, (_, i) => ({
              sqrt_price: String(lower + ((end - lower) * BigInt(i + 1)) / 8n),
              liquidity: point.liquidity,
            }));
          });
        }
        params.padding = [0, 0];
        params.compounding_fee_bps = compounding;
        params.migrated_pool_fee.collect_fee_mode = compounding > 0 ? 2 : 0;
        params.migration_fee = {
          fee_percentage: mechanism === 1 || mechanism === 2 ? 5 : 0,
          creator_fee_percentage: mechanism === 1 || mechanism === 2 ? 100 : 0,
        };
        const spec = {
          operation: "contract_model",
          publisher: author.publicKey.toBase58(),
          parent: PublicKey.default.toBase58(),
          author: author.publicKey.toBase58(),
          parameters: params,
          mechanism,
          quote_decimals: 9,
          launcher_bps: 8000,
          author_bps: 1000,
          platform_bps: 1000,
          reviewer_threshold: mechanism === 1 ? 2 : 0,
          milestones:
            mechanism === 1
              ? [
                  { weight_bps: 4000, deadline_offset: "100" },
                  { weight_bps: 6000, deadline_offset: "200" },
                ]
              : [],
        };
        const encoded = native(spec),
          model = pda(REGISTRY, [
            Buffer.from("model"),
            author.publicKey.toBuffer(),
            Buffer.from(encoded.digest, "base64"),
          ]);
        send(
          "begin_model",
          { platform: platformAccount, model, publisher: author.publicKey },
          {
            digest: encoded.digest,
            json_hash: crypto
              .createHash("sha256")
              .update(JSON.stringify(spec))
              .digest("base64"),
            size: String(encoded.size),
          },
          [author],
        );
        const bytes = Buffer.from(encoded.bytes, "base64");
        for (let offset = 0; offset < bytes.length; offset += 500)
          send(
            "write_model",
            { model, publisher: author.publicKey },
            {
              offset: String(offset),
              bytes: bytes.subarray(offset, offset + 500).toString("base64"),
            },
            [author],
          );
        assert.throws(() =>
          send("seal_model", { model, publisher: attacker.publicKey }, {}, [
            attacker,
          ]),
        );
        send("seal_model", { model, publisher: author.publicKey }, {}, [
          author,
        ]);
        assert(read("model", model).sealed);
        assert.throws(() =>
          send(
            "write_model",
            { model, publisher: author.publicKey },
            { offset: "0", bytes: "AA==" },
            [author],
          ),
        );
        if (mechanism === 0 && compounding === 0) {
          for (const tampered of [false, true]) {
            const copy = native({
              ...spec,
              publisher: attacker.publicKey.toBase58(),
              parent: model.toBase58(),
              ...(tampered
                ? { launcher_bps: 9000, author_bps: 500, platform_bps: 500 }
                : {}),
            });
            const copyModel = pda(REGISTRY, [
              Buffer.from("model"),
              attacker.publicKey.toBuffer(),
              Buffer.from(copy.digest, "base64"),
            ]);
            send(
              "begin_model",
              {
                platform: platformAccount,
                model: copyModel,
                parent: model,
                publisher: attacker.publicKey,
              },
              {
                digest: copy.digest,
                json_hash: crypto
                  .createHash("sha256")
                  .update(copy.bytes)
                  .digest("base64"),
                size: String(copy.size),
              },
              [attacker],
            );
            const copyBytes = Buffer.from(copy.bytes, "base64");
            for (let o = 0; o < copyBytes.length; o += 500)
              send(
                "write_model",
                { model: copyModel, publisher: attacker.publicKey },
                {
                  offset: String(o),
                  bytes: copyBytes.subarray(o, o + 500).toString("base64"),
                },
                [attacker],
              );
            if (tampered)
              assert.throws(
                () =>
                  send(
                    "seal_model",
                    { model: copyModel, publisher: attacker.publicKey },
                    {},
                    [attacker],
                  ),
                /InvalidTerms/,
              );
            else {
              send(
                "seal_model",
                { model: copyModel, publisher: attacker.publicKey },
                {},
                [attacker],
              );
              assert.equal(
                read("model", copyModel).author,
                author.publicKey.toBase58(),
              );
            }
          }
          security.push({
            checks: [
              "official_fork_inherits_original_author",
              "royalty_tampering_rejected_at_seal",
            ],
          });
        }
        const nonce = BigInt(mechanism * 10000 + compounding),
          nonceBuffer = Buffer.alloc(8);
        nonceBuffer.writeBigUInt64LE(nonce);
        const launch = pda(REGISTRY, [
          Buffer.from("launch"),
          model.toBuffer(),
          launcher.publicKey.toBuffer(),
          nonceBuffer,
        ]);
        send(
          "initialize_launch",
          {
            platform: platformAccount,
            model,
            launch,
            launcher: launcher.publicKey,
            system_program: SystemProgram.programId,
          },
          {
            nonce: String(nonce),
            config: config.publicKey.toBase58(),
            base_mint: mint.publicKey.toBase58(),
            fee_vault: feeVault.toBase58(),
            first_position_mint: plannedFirst.publicKey.toBase58(),
            reviewers:
              mechanism === 1
                ? reviewers.map((k) => k.publicKey.toBase58())
                : [],
          },
        );
        const eventAuthority = pda(dbc.DYNAMIC_BONDING_CURVE_PROGRAM_ID, [
          Buffer.from("__event_authority"),
        ]);
        send(
          "create_config",
          {
            platform: platformAccount,
            model,
            launch,
            config: config.publicKey,
            fee_vault: feeVault,
            quote_mint: NATIVE_MINT,
            launcher: launcher.publicKey,
            dbc_program: dbc.DYNAMIC_BONDING_CURVE_PROGRAM_ID,
            event_authority: eventAuthority,
            system_program: SystemProgram.programId,
          },
          {},
          [launcher, config],
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
          wallet: launcher.publicKey.toBase58(),
          quote_mint: NATIVE_MINT.toBase58(),
          name: "Contract Launch",
          symbol: "DGC",
          uri: "https://example.com/dgc.json",
        });
        const met = upstream.accounts;
        send(
          "create_pool",
          {
            launch,
            config: config.publicKey,
            pool_authority: dbc.deriveDbcPoolAuthority(),
            base_mint: mint.publicKey,
            quote_mint: NATIVE_MINT,
            pool,
            base_vault: new PublicKey(upstream.base_vault),
            quote_vault: new PublicKey(upstream.quote_vault),
            mint_metadata: new PublicKey(met[8].address),
            metadata_program: dbc.METAPLEX_PROGRAM_ID,
            launcher: launcher.publicKey,
            token_program: TOKEN_PROGRAM_ID,
            dbc_program: dbc.DYNAMIC_BONDING_CURVE_PROGRAM_ID,
            system_program: SystemProgram.programId,
            event_authority: eventAuthority,
          },
          {
            name: "Contract Launch",
            symbol: "DGC",
            uri: "https://example.com/dgc.json",
          },
          [launcher, mint],
        );
        const module = mechanism === 1 ? ESCROW : RESERVE,
          vault = pda(module, [Buffer.from("vault"), launch.toBuffer()]),
          tokenVault = getAssociatedTokenAddressSync(NATIVE_MINT, vault, true);
        const moduleAccounts = {
          launch,
          model,
          base_mint: mint.publicKey,
          quote_mint: NATIVE_MINT,
          module_vault: vault,
          token_vault: tokenVault,
          module_program: module,
          launcher: launcher.publicKey,
          token_program: TOKEN_PROGRAM_ID,
          associated_token_program: new PublicKey(
            "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
          ),
          system_program: SystemProgram.programId,
        };
        const delayedModule = mechanism === 2 && compounding === 5000;
        if (mechanism === 1 || mechanism === 2) {
          assert.throws(
            () =>
              send(
                "initialize_module",
                {
                  ...moduleAccounts,
                  module_program: mechanism === 1 ? RESERVE : ESCROW,
                },
                {},
              ),
            /InvalidTerms/,
          );
          assert.throws(
            () =>
              send(
                "initialize_module",
                { ...moduleAccounts, launcher: attacker.publicKey },
                {},
                [attacker],
              ),
            /ConstraintHasOne/,
          );
          security.push({
            mechanism,
            compounding_bps: compounding,
            checks: [
              "wrong_module_program_rejected",
              "foreign_launcher_rejected",
            ],
          });
        }
        if ((mechanism === 1 || mechanism === 2) && !delayedModule)
          send("initialize_module", moduleAccounts, {});
        const wsol = getAssociatedTokenAddressSync(
          NATIVE_MINT,
          launcher.publicKey,
        );
        vm.send(
          "fund-swap-wallet",
          new Transaction().add(
            createAssociatedTokenAccountIdempotentInstruction(
              launcher.publicKey,
              wsol,
              launcher.publicKey,
              NATIVE_MINT,
            ),
            SystemProgram.transfer({
              fromPubkey: launcher.publicKey,
              toPubkey: wsol,
              lamports: 20_000_000_000n,
            }),
            createSyncNativeInstruction(wsol),
          ),
          [launcher],
        );
        const raw = (address) =>
          Buffer.from(vm.svm.getAccount(address).data).toString("base64");
        const swap = (protocol, address, amount, mode = "exact_in") =>
          native({
            operation: "swap_prepare",
            protocol,
            pool: address.toBase58(),
            wallet: launcher.publicKey.toBase58(),
            pool_data: raw(address),
            config_data: raw(config.publicKey),
            config_address: config.publicKey.toBase58(),
            amount: String(amount),
            mode,
            base_for_quote: false,
            slot: vm.svm.getClock().slot.toString(),
            timestamp: vm.svm.getClock().unixTimestamp.toString(),
            slippage_bps: 100,
          });
        vm.send(
          "graduate-dbc",
          new Transaction().add(
            ComputeBudgetProgram.setComputeUnitLimit({ units: 1000000 }),
            ...swap(
              "dbc",
              pool,
              10_000_000_000n,
              "partial_fill",
            ).instructions.map(ix),
          ),
          [launcher],
        );
        const migration = native({
          operation: "dbc_migrate",
          wallet: launcher.publicKey.toBase58(),
          config: config.publicKey.toBase58(),
          base_mint: mint.publicKey.toBase58(),
          quote_mint: NATIVE_MINT.toBase58(),
          damm_config: dammConfig.toBase58(),
          first_position_mint: first.publicKey.toBase58(),
          second_position_mint: second.publicKey.toBase58(),
        });
        vm.send(
          "native-migration",
          new Transaction().add(
            ComputeBudgetProgram.setComputeUnitLimit({ units: 1000000 }),
            ix(migration),
          ),
          [launcher, first, second],
        );
        const dammPool = new PublicKey(migration.damm_pool);
        send(
          "verify_migration",
          {
            launch,
            base_mint: mint.publicKey,
            config: config.publicKey,
            pool,
            damm_pool: dammPool,
            position: dbc.derivePositionAddress(first.publicKey),
            position_nft: dbc.derivePositionNftAccount(first.publicKey),
          },
          {},
        );
        assert.equal(
          read("launch", launch).first_position_mint,
          first.publicKey.toBase58(),
        );
        if (!first.publicKey.equals(plannedFirst.publicKey))
          security.push({
            checks: [
              "permissionless_migration_with_different_nft_does_not_block_capital",
            ],
          });
        if (delayedModule) {
          send("initialize_module", moduleAccounts, {});
          security.push({
            checks: ["module_initialization_after_permissionless_migration"],
          });
        }
        let funded = "0";
        if (mechanism === 1 || mechanism === 2) {
          const fundingAccounts = {
            launch,
            config: config.publicKey,
            pool,
            module_vault: vault,
            token_vault: tokenVault,
            module_program: module,
            quote_mint: NATIVE_MINT,
            quote_vault: new PublicKey(upstream.quote_vault),
            pool_authority: dbc.deriveDbcPoolAuthority(),
            token_program: TOKEN_PROGRAM_ID,
            dbc_program: dbc.DYNAMIC_BONDING_CURVE_PROGRAM_ID,
            event_authority: eventAuthority,
          };
          if (compounding === 0) {
            assert.throws(
              () =>
                send(
                  "fund_and_activate",
                  { ...fundingAccounts, token_vault: wsol },
                  {},
                ),
              /ConstraintTokenOwner|InvalidTerms/,
            );
            security.push({
              mechanism,
              checks: ["capital_cannot_be_redirected_to_launcher"],
            });
          }
          send("fund_and_activate", fundingAccounts, {});
          assert.throws(() => send("fund_and_activate", fundingAccounts, {}));
          funded = read(
            mechanism === 1 ? "escrow" : "reserve",
            vault,
          ).initial_funding;
          assert(BigInt(funded) > 0n);
          const holderTokens = getAssociatedTokenAddressSync(
            mint.publicKey,
            launcher.publicKey,
          );
          const redeemAccounts = {
            vault,
            base_mint: mint.publicKey,
            holder: launcher.publicKey,
            holder_tokens: holderTokens,
            token_vault: tokenVault,
            receiver: wsol,
            token_program: TOKEN_PROGRAM_ID,
          };
          if (mechanism === 1) {
            const voteAccounts = {
              vault,
              reviewer: reviewers[0].publicKey,
              token_vault: tokenVault,
              beneficiary_tokens: wsol,
              token_program: TOKEN_PROGRAM_ID,
            };
            assert.throws(() =>
              send(
                "escrow_vote",
                { ...voteAccounts, reviewer: attacker.publicKey },
                { approve: true },
                [attacker],
              ),
            );
            send("escrow_vote", voteAccounts, { approve: true }, [
              reviewers[0],
            ]);
            assert.throws(() =>
              send("escrow_vote", voteAccounts, { approve: true }, [
                reviewers[0],
              ]),
            );
            send(
              "escrow_vote",
              { ...voteAccounts, reviewer: reviewers[1].publicKey },
              { approve: true },
              [reviewers[1]],
            );
            assert.equal(read("escrow", vault).current_milestone, 1);
            if (compounding === 0) {
              const nextClock = vm.svm.getClock();
              nextClock.unixTimestamp += 200n;
              vm.svm.setClock(nextClock);
              send("escrow_fail_expired", { vault }, {});
              assert.equal(read("escrow", vault).state, 2);
            } else if (compounding === 5000) {
              send("escrow_vote", voteAccounts, { approve: false }, [
                reviewers[0],
              ]);
              send(
                "escrow_vote",
                { ...voteAccounts, reviewer: reviewers[1].publicKey },
                { approve: false },
                [reviewers[1]],
              );
              assert.equal(read("escrow", vault).state, 2);
            } else {
              send("escrow_vote", voteAccounts, { approve: true }, [
                reviewers[0],
              ]);
              send(
                "escrow_vote",
                { ...voteAccounts, reviewer: reviewers[1].publicKey },
                { approve: true },
                [reviewers[1]],
              );
              assert.equal(read("escrow", vault).state, 3);
              vm.send(
                "completed-escrow-donation",
                new Transaction().add(
                  require("@solana/spl-token").createTransferInstruction(
                    wsol,
                    tokenVault,
                    launcher.publicKey,
                    1000000n,
                  ),
                ),
                [launcher],
              );
            }
            assert.throws(() =>
              send("escrow_vote", voteAccounts, { approve: true }, [
                reviewers[0],
              ]),
            );
          }
          security.push({
            mechanism,
            compounding_bps: compounding,
            checks: require("./adversarial.cjs")({
              vm,
              native,
              send,
              ix,
              names,
              mechanism,
              vault,
              tokenVault,
              mint: mint.publicKey,
              holderTokens,
              holder: launcher,
              receiver: wsol,
              attacker,
              quoteMint: NATIVE_MINT,
              read,
            }),
          });
          const burn = vm.balance(holderTokens) / 10n,
            reserveBefore = vm.balance(tokenVault),
            baseBefore = vm.balance(holderTokens),
            supply = Buffer.from(
              vm.svm.getAccount(mint.publicKey).data,
            ).readBigUInt64LE(36);
          const expected = (burn * reserveBefore) / supply;
          assert.throws(() =>
            send(
              mechanism === 1 ? "escrow_refund" : "reserve_redeem",
              redeemAccounts,
              { burn_amount: String(burn), min_payout: String(expected + 1n) },
            ),
          );
          assert.equal(vm.balance(holderTokens), baseBefore);
          assert.equal(vm.balance(tokenVault), reserveBefore);
          send(
            mechanism === 1 ? "escrow_refund" : "reserve_redeem",
            redeemAccounts,
            { burn_amount: String(burn), min_payout: String(expected) },
          );
          assert.equal(vm.balance(holderTokens), baseBefore - burn);
          assert.equal(vm.balance(tokenVault), reserveBefore - expected);
        }
        vm.send(
          "post-migration-buy",
          new Transaction().add(
            ComputeBudgetProgram.setComputeUnitLimit({ units: 1000000 }),
            ...swap("damm_v2", dammPool, 100000000n).instructions.map(ix),
          ),
          [launcher],
        );
        const sweep = native({
          operation: "fee_sweep",
          protocol: "damm_v2",
          pool: dammPool.toBase58(),
          pool_data: raw(dammPool),
          position: dbc.derivePositionAddress(first.publicKey).toBase58(),
          position_nft_account: dbc
            .derivePositionNftAccount(first.publicKey)
            .toBase58(),
          vault: feeVault.toBase58(),
          vault_data: raw(feeVault),
          wallet: platform.publicKey.toBase58(),
        });
        vm.send(
          "fee-only-native-dfs-sweep",
          new Transaction().add(...sweep.instructions.map(ix)),
          [platform],
        );
        const feeState = native({
          operation: "fee_vault",
          vault_data: raw(feeVault),
        });
        if (compounding === 10000) assert.equal(feeState.total_funded, "0");
        else assert(BigInt(feeState.total_funded) > 0n);
        if (mechanism === 2 && compounding === 10000) {
          httpFixture = {
            launcher,
            vault: vault.toBase58(),
            burn:
              vm.balance(
                getAssociatedTokenAddressSync(
                  mint.publicKey,
                  launcher.publicKey,
                ),
              ) / 100n,
            accounts: names({
              vault,
              base_mint: mint.publicKey,
              holder: launcher.publicKey,
              holder_tokens: getAssociatedTokenAddressSync(
                mint.publicKey,
                launcher.publicKey,
              ),
              token_vault: tokenVault,
              receiver: wsol,
              token_program: TOKEN_PROGRAM_ID,
            }),
          };
        }
        results.push({
          mechanism,
          compounding_bps: compounding,
          curve_segments: params.curve.length,
          capital_funded: funded,
          fee_funded: feeState.total_funded,
          launch_phase: read("launch", launch).phase,
        });
      }
    const httpAcceptance =
      process.env.CONTRACT_HTTP_TEST === "true"
        ? await require("./http.cjs")(vm, httpFixture, ROOT)
        : { status: "not_requested" };
    const report = {
      build_manifest: JSON.parse(
        fs.readFileSync(path.join(ROOT, "contracts/build-manifest.json")),
      ),
      security,
      http_acceptance: httpAcceptance,
      scope: "local_compiled_Anchor_programs_and_official_Meteora_SBF",
      public_transactions_sent: 0,
      production_certified: false,
      runtime: "Rust LiteSVM 0.17.0",
      cases: results,
      receipts: vm.receipts,
    };
    fs.mkdirSync(path.join(ROOT, "contracts/tests/evidence"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(ROOT, "contracts/tests/evidence/lifecycle.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log("PASS", results.length, "Anchor/Meteora lifecycle cases");
  } finally {
    vm.svm.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
