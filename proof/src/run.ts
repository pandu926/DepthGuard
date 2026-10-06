import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import BN from 'bn.js';
import Decimal from 'decimal.js';
import { PublicKey, Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, MINT_SIZE, createInitializeMint2Instruction, createAssociatedTokenAccountInstruction, createMintToInstruction } from '@solana/spl-token';
import * as dbc from '@meteora-ag/dynamic-bonding-curve-sdk';
import { CpAmm } from '@meteora-ag/cp-amm-sdk';
import { ProofVm } from './vm';
import { buildPair, amountForPct, ORDER_PCTS, TRADE_FEE_BPS, idealSellOutput, SUPPLY } from './curves';
import { runLifecycle } from './lifecycle';

Decimal.set({ precision: 60 });
const Q64 = new Decimal(2).pow(64);
const price = (sqrt: BN) => new Decimal(sqrt.toString()).div(Q64).pow(2);
export function decimalJson(value: unknown): unknown {
  if (BN.isBN(value)) return value.toString(10);
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof PublicKey) return value.toBase58();
  if (Array.isArray(value)) return value.map(decimalJson);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decimalJson(v)]));
  return value;
}

async function makeDammConfig(vm: ProofVm, admin: Keypair) {
  const program = dbc.createDammV2Program(vm.connection);
  const operator = PublicKey.findProgramAddressSync([Buffer.from('operator'), admin.publicKey.toBuffer()], dbc.DAMM_V2_PROGRAM_ID)[0];
  vm.send('damm-create-operator', await program.methods.createOperatorAccount(new BN(1))
    .accountsPartial({ operator, whitelistedAddress: admin.publicKey, signer: admin.publicKey, payer: admin.publicKey }).transaction(), [admin]);
  const index = new BN(1);
  const config = PublicKey.findProgramAddressSync([Buffer.from('config'), index.toArrayLike(Buffer, 'le', 8)], dbc.DAMM_V2_PROGRAM_ID)[0];
  const tx = await program.methods.createDynamicConfig(index, {
    poolCreatorAuthority: dbc.deriveDbcPoolAuthority(), permission: new BN(1),
  }).accountsPartial({ config, operator, signer: admin.publicKey, payer: admin.publicKey }).transaction();
  vm.send('damm-create-config', tx, [admin]);
  return config;
}

export async function experiment(name: string, built: dbc.ConfigParameters,
  options: { mockQuote?: { symbol: string; decimals: 6 | 9 }; withdrawPartnerMigrationFee?: boolean; lifecycle?: { roundTrips: number; quotePerBuySol: number; dumpPct: number; balancedLpSol?: number } } = {}) {
  console.log(`Running ${name} ...`);
  const vm = new ProofVm();
  const owner = vm.wallet(), config = Keypair.generate(), mint = Keypair.generate();
  let quoteMint = NATIVE_MINT;
  const quoteDecimals = options.mockQuote?.decimals ?? 9;
  if (options.mockQuote) {
    assert(!options.lifecycle, 'Native-SOL lifecycle harness is not valid for mock SPL quote');
    const quoteKey = Keypair.generate();
    quoteMint = quoteKey.publicKey;
    const quoteAta = getAssociatedTokenAddressSync(quoteMint, owner.publicKey);
    const rent = await vm.connection.getMinimumBalanceForRentExemption(MINT_SIZE);
    vm.send('create-mock-quote-mint', new Transaction().add(
      SystemProgram.createAccount({ fromPubkey: owner.publicKey, newAccountPubkey: quoteMint, space: MINT_SIZE, lamports: rent, programId: TOKEN_PROGRAM_ID }),
      createInitializeMint2Instruction(quoteMint, quoteDecimals, owner.publicKey, null),
      createAssociatedTokenAccountInstruction(owner.publicKey, quoteAta, owner.publicKey, quoteMint),
      createMintToInstruction(quoteMint, quoteAta, owner.publicKey, 1_000_000n * 10n ** BigInt(quoteDecimals)),
    ), [owner, quoteKey]);
  }
  const client = new dbc.DynamicBondingCurveClient(vm.connection, 'confirmed');
  const cp = new CpAmm(vm.connection);
  const dammConfig = await makeDammConfig(vm, owner);
  vm.send('dbc-create-config', await client.partner.createConfig({ ...built,
    config: config.publicKey, feeClaimer: owner.publicKey, leftoverReceiver: owner.publicKey,
    quoteMint, payer: owner.publicKey }), [owner, config]);
  vm.send('dbc-create-pool', await client.creator.createPool({ config: config.publicKey,
    baseMint: mint.publicKey, name: 'DepthGuard Local Proof', symbol: 'DGP',
    uri: 'https://example.com/depthguard-local-proof.json', payer: owner.publicKey, poolCreator: owner.publicKey }), [owner, mint]);
  const poolAddress = dbc.deriveDbcPoolAddress(quoteMint, mint.publicKey, config.publicKey);
  const state = async () => {
    const pool = await client.state.getPool(poolAddress);
    const cfg = await client.state.getPoolConfig(config.publicKey);
    assert(pool); assert(cfg);
    return { pool, cfg };
  };
  const buy = async (amountIn: BN) => {
    const { pool, cfg } = await state();
    const quote = client.pool.swapQuote2({ virtualPool: pool, config: cfg,
      swapBaseForQuote: false, amountIn, swapMode: dbc.SwapMode.PartialFill,
      slippageBps: 10, hasReferral: false, currentPoint: new BN(vm.svm.getClock().unixTimestamp.toString()),
      eligibleForFirstSwapWithMinFee: false });
    const tx = await client.pool.swap2({ owner: owner.publicKey, pool: poolAddress, amountIn,
      minimumAmountOut: quote.minimumAmountOut!, swapBaseForQuote: false,
      swapMode: dbc.SwapMode.PartialFill, referralTokenAccount: null });
    vm.send('dbc-buy', tx, [owner]);
  };
  const initial = await state();
  const prematureMigration = await client.migration.migrateToDammV2({ pool: poolAddress, dammConfig, payer: owner.publicKey });
  assert.throws(() => vm.simulate(prematureMigration.transaction,
    [owner, prematureMigration.firstPositionNftKeypair, prematureMigration.secondPositionNftKeypair]),
    /NotPermitToDoThisAction|PoolIsIncompleted/, 'SBF program must reject migration before graduation');
  const desiredPreQuote = initial.cfg.migrationQuoteThreshold.subn(1000);
  const [gross] = dbc.getIncludedFeeAmount(new BN(TRADE_FEE_BPS * 100_000), desiredPreQuote);
  await buy(gross);
  const pre = await state();
  assert(pre.pool.poolState.quoteReserve.lt(pre.cfg.migrationQuoteThreshold), 'pre-state must still trade');
  assert(pre.cfg.migrationQuoteThreshold.sub(pre.pool.poolState.quoteReserve).lte(new BN(1001)), 'pre-state within 1001 lamports');
  const outputAta = getAssociatedTokenAddressSync(quoteMint, owner.publicKey);
  const rows = [];
  for (const pct of ORDER_PCTS) {
    const amount = amountForPct(pct);
    const quote = client.pool.swapQuote({ virtualPool: pre.pool, config: pre.cfg,
      swapBaseForQuote: true, amountIn: amount, slippageBps: 10,
      hasReferral: false, currentPoint: new BN(vm.svm.getClock().unixTimestamp.toString()), eligibleForFirstSwapWithMinFee: false });
    const tx = await client.pool.swap({ owner: owner.publicKey, pool: poolAddress,
      amountIn: amount, minimumAmountOut: quote.minimumAmountOut,
      swapBaseForQuote: true, referralTokenAccount: null });
    const actual = vm.trialOutput(tx, [owner], outputAta);
    assert.equal(actual.toString(), quote.outputAmount.toString(), `${name} pre SDK/on-SBF parity at ${pct}%`);
    rows.push({ pctTotalSupply: pct, amountBaseRaw: amount.toString(), preOutputQuoteRaw: actual.toString(),
      preNextSqrtPrice: quote.nextSqrtPrice.toString(), preTradingFeeRaw: quote.tradingFee.add(quote.protocolFee).toString() });
  }
  await buy(new BN(10000));
  const completed = await state();
  assert(completed.pool.poolState.quoteReserve.gte(completed.cfg.migrationQuoteThreshold));
  assert.throws(() => client.pool.swapQuote({ virtualPool: completed.pool, config: completed.cfg,
    swapBaseForQuote: true, amountIn: amountForPct(1), slippageBps: 10, hasReferral: false,
    currentPoint: new BN(vm.svm.getClock().unixTimestamp.toString()), eligibleForFirstSwapWithMinFee: false }), /completed/);
  const baseBefore = vm.balance(completed.pool.poolState.baseVault);
  const quoteBefore = vm.balance(completed.pool.poolState.quoteVault);
  const excludedBase = new BN(baseBefore.toString())
    .sub(completed.pool.poolState.protocolBaseFee).sub(completed.pool.poolState.partnerBaseFee)
    .sub(completed.pool.poolState.creatorBaseFee);
  const quoteAfterPartnerFee = completed.cfg.migrationQuoteThreshold
    .muln(100 - completed.cfg.migrationFeePercentage).addn(99).divn(100);
  const compounding = built.migratedPoolFee.collectFeeMode === dbc.MigratedCollectFeeMode.Compounding;
  const [expectedProtocolBase, expectedProtocolQuote] = compounding ? [
    completed.cfg.migrationBaseThreshold.muln(completed.pool.poolState.protocolLiquidityMigrationFeeBps).divn(10000),
    quoteAfterPartnerFee.muln(completed.pool.poolState.protocolLiquidityMigrationFeeBps).divn(10000),
  ] : dbc.getProtocolMigrationFee(excludedBase,
    quoteAfterPartnerFee, completed.cfg.migrationSqrtPrice,
    completed.pool.poolState.protocolLiquidityMigrationFeeBps, dbc.MigrationOption.MET_DAMM_V2);
  const migration = await client.migration.migrateToDammV2({ pool: poolAddress, dammConfig, payer: owner.publicKey });
  vm.send('dbc-migrate-damm-v2', migration.transaction, [owner, migration.firstPositionNftKeypair, migration.secondPositionNftKeypair]);
  const after = await state();
  assert.equal(after.pool.poolState.isMigrated, 1);
  assert(after.pool.poolState.protocolMigrationBaseFeeAmount.eq(expectedProtocolBase));
  assert(after.pool.poolState.protocolMigrationQuoteFeeAmount.eq(expectedProtocolQuote));
  const dammAddress = dbc.deriveDammV2PoolAddress(dammConfig, mint.publicKey, quoteMint);
  const migrated = await cp.fetchPoolState(dammAddress);
  if (compounding) {
    assert(new Decimal(migrated.sqrtPrice.toString()).div(completed.cfg.migrationSqrtPrice.toString()).sub(1).abs().lt(0.00001));
    assert(migrated.sqrtMinPrice.isZero());
    assert(migrated.sqrtMaxPrice.eq(new BN(1).shln(128).subn(1)));
  } else {
    assert(migrated.sqrtPrice.eq(completed.cfg.migrationSqrtPrice));
    assert(migrated.sqrtMinPrice.eq(dbc.MIN_SQRT_PRICE));
    assert(migrated.sqrtMaxPrice.eq(dbc.MAX_SQRT_PRICE));
  }
  const baseDeposited = vm.balance(migrated.tokenAVault);
  const quoteDeposited = vm.balance(migrated.tokenBVault);
  assert.equal(BigInt(baseBefore) - vm.balance(after.pool.poolState.baseVault), baseDeposited);
  assert.equal(BigInt(quoteBefore) - vm.balance(after.pool.poolState.quoteVault), quoteDeposited);
  assert(quoteDeposited <= BigInt(quoteAfterPartnerFee.sub(expectedProtocolQuote).toString()));
  const position = await cp.fetchPositionState(dbc.derivePositionAddress(migration.firstPositionNftKeypair.publicKey));
  const deadLiquidity = compounding ? new BN(100).shln(64) : new BN(0);
  assert(position.permanentLockedLiquidity.add(deadLiquidity).eq(migrated.liquidity), 'All distributable migrated liquidity must be permanently locked');
  const prePrice = price(pre.pool.poolState.sqrtPrice), postPrice = price(migrated.sqrtPrice);
  const terminalIndex = completed.cfg.curve.findIndex(segment => segment.sqrtPrice.gte(completed.cfg.migrationSqrtPrice));
  assert(terminalIndex >= 0);
  const terminalLiquidity = completed.cfg.curve[terminalIndex].liquidity;
  const boundary = terminalIndex === 0 ? completed.cfg.sqrtStartPrice : completed.cfg.curve[terminalIndex - 1].sqrtPrice;
  const boundaryCapacity = dbc.getDeltaAmountBaseUnsigned(boundary, pre.pool.poolState.sqrtPrice,
    terminalLiquidity, dbc.Rounding.Down);
  const measurements = [];
  for (const row of rows) {
    const amount = new BN(row.amountBaseRaw);
    const quote = cp.getQuote({ inAmount: amount, inputTokenMint: mint.publicKey, slippage: 0.1,
      poolState: migrated, currentTime: Number(vm.svm.getClock().unixTimestamp), currentSlot: Number(vm.svm.getClock().slot),
      tokenADecimal: 6, tokenBDecimal: quoteDecimals, hasReferral: false });
    const tx = await cp.swap({ payer: owner.publicKey, pool: dammAddress, inputTokenMint: mint.publicKey,
      outputTokenMint: quoteMint, amountIn: amount, minimumAmountOut: quote.minSwapOutAmount,
      tokenAVault: migrated.tokenAVault, tokenBVault: migrated.tokenBVault, tokenAMint: mint.publicKey,
      tokenBMint: quoteMint, tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID,
      referralTokenAccount: null, poolState: migrated });
    const actual = vm.trialOutput(tx, [owner], outputAta);
    assert.equal(actual.toString(), quote.swapOutAmount.toString(), `${name} post SDK/on-SBF parity at ${row.pctTotalSupply}%`);
    const preImpact = new Decimal(1).sub(new Decimal(row.preOutputQuoteRaw).div(new Decimal(amount.toString()).mul(prePrice))).mul(100);
    const postImpact = new Decimal(1).sub(new Decimal(actual.toString()).div(new Decimal(amount.toString()).mul(postPrice))).mul(100);
    const postFeeBps = built.migratedPoolFee.poolFeeBps;
    const closedForm = (compounding
      ? new Decimal(migrated.tokenBAmount.toString()).mul(amount.toString())
        .div(new Decimal(migrated.tokenAAmount.toString()).add(amount.toString())).mul(1 - TRADE_FEE_BPS / 10000)
      : idealSellOutput(migrated.sqrtPrice, migrated.liquidity, amount))
      .div(1 - TRADE_FEE_BPS / 10_000).mul(1 - postFeeBps / 10_000);
    assert(closedForm.sub(actual.toString()).abs().lt(3), 'analytical / integer SBF output within 3 quote base units');
    measurements.push({ ...row, postOutputQuoteRaw: actual.toString(), postTradingFeeRaw: quote.totalFee.toString(),
      preImpactPct: preImpact.toNumber(), postImpactPct: postImpact.toNumber(),
      preCurveOnlyImpactPct: preImpact.sub(TRADE_FEE_BPS / 100).div(1 - TRADE_FEE_BPS / 10_000).toNumber(),
      postCurveOnlyImpactPct: postImpact.sub(postFeeBps / 100).div(1 - postFeeBps / 10_000).toNumber(),
      gapPercentagePoints: preImpact.sub(postImpact).abs().toNumber(),
      payoutChangePct: new Decimal(actual.toString()).div(row.preOutputQuoteRaw).sub(1).mul(100).toNumber(),
      staysInTerminalSegment: amount.lte(boundaryCapacity), sdkMatchesSbf: true });
  }
  let claimedPartnerMigrationFeeRaw: string | undefined;
  if (options.withdrawPartnerMigrationFee) {
    const balanceBefore = vm.balance(outputAta);
    const tx = await client.partner.partnerWithdrawMigrationFee({ pool: poolAddress, sender: owner.publicKey });
    // Preserve WSOL ATA so quote transfers can be measured independently of gas/rent.
    tx.instructions = tx.instructions.filter(ix => !(ix.programId.equals(TOKEN_PROGRAM_ID) && ix.data[0] === 9));
    vm.send('claim-partner-migration-fee', tx, [owner]);
    claimedPartnerMigrationFeeRaw = (vm.balance(outputAta) - balanceBefore).toString();
    const expected = completed.cfg.migrationQuoteThreshold.sub(quoteAfterPartnerFee)
      .muln(100 - completed.cfg.creatorMigrationFeePercentage).divn(100);
    assert.equal(claimedPartnerMigrationFeeRaw, expected.toString(), 'Native migration fee withdrawal transfers the exact quote amount');
  }
  const lifecycle = options.lifecycle ? await runLifecycle(vm, cp, dammAddress, owner, mint.publicKey, options.lifecycle) : undefined;
  const result = { name, environment: 'local LiteSVM; official precompiled SDK fixtures; no public chain transactions',
    quoteAsset: { mint: quoteMint.toBase58(), symbol: options.mockQuote?.symbol ?? 'SOL', decimals: quoteDecimals, isMock: !!options.mockQuote },
    sdkVersions: { dbc: '1.5.13', dammV2: '1.5.1', litesvm: '0.1.0' }, binaryHashes: vm.binaryHashes,
    addresses: { dbcConfig: config.publicKey.toBase58(), dbcPool: poolAddress.toBase58(), dammPool: dammAddress.toBase58() },
    config: built, fetchedConfig: completed.cfg,
    accruedDbcQuoteFeesAtGraduation: { protocolRaw: completed.pool.poolState.protocolQuoteFee.toString(),
      partnerRaw: completed.pool.poolState.partnerQuoteFee.toString(), creatorRaw: completed.pool.poolState.creatorQuoteFee.toString() },
    migration: { thresholdRaw: completed.cfg.migrationQuoteThreshold.toString(),
      preQuoteDeficitRaw: completed.cfg.migrationQuoteThreshold.sub(pre.pool.poolState.quoteReserve).toString(),
      migrationFeePercent: completed.cfg.migrationFeePercentage, claimedPartnerMigrationFeeRaw,
      protocolMigrationFeeBps: completed.pool.poolState.protocolLiquidityMigrationFeeBps,
      protocolBaseFeeRaw: expectedProtocolBase.toString(), protocolQuoteFeeRaw: expectedProtocolQuote.toString(),
      actualBaseDepositedRaw: baseDeposited.toString(), actualQuoteDepositedRaw: quoteDeposited.toString(),
      preSqrtPriceRaw: pre.pool.poolState.sqrtPrice.toString(), postSqrtPriceRaw: migrated.sqrtPrice.toString(),
      spotPriceChangePct: postPrice.div(prePrice).sub(1).mul(100).toNumber(),
      terminalLiquidityRaw: terminalLiquidity.toString(), postLiquidityRaw: migrated.liquidity.toString(),
      depthRatio: new Decimal(migrated.liquidity.toString()).div(terminalLiquidity.toString()).toNumber(),
      terminalSegmentSellCapacityPctTotalSupply: new Decimal(boundaryCapacity.toString()).div(SUPPLY * 10 ** 6).mul(100).toNumber(),
      lpPermanentLockedPct: 100, deadLiquidityRaw: deadLiquidity.toString(),
      migratedCollectFeeMode: migrated.collectFeeMode, compoundingFeeBps: built.compoundingFeeBps,
      isMigrated: after.pool.poolState.isMigrated,
      fullRangeVerified: true, vaultConservationVerified: true, prematureMigrationRejected: true },
    measurements, lifecycle, receipts: vm.receipts };
  console.table(measurements.map(x => ({ sellPct: x.pctTotalSupply, before: x.preImpactPct.toFixed(6),
    after: x.postImpactPct.toFixed(6), gapPP: x.gapPercentagePoints.toFixed(6), withinSegment: x.staysInTerminalSegment })));
  return result;
}

async function main() {
  const output = resolve(__dirname, '../results');
  mkdirSync(output, { recursive: true });
  const pair = buildPair();
  const results = [];
  for (const [name, config] of [['baseline', pair.baseline], ['optimized', pair.optimized]] as const) {
    const result = await experiment(name, config);
    writeFileSync(resolve(output, `${name}.json`), JSON.stringify(decimalJson(result), null, 2));
    results.push(result);
  }
  const reference = results[0], optimized = results[1];
  assert(new Decimal(reference.migration.thresholdRaw).sub(optimized.migration.thresholdRaw).abs().lte(100), 'raise held constant within 100 lamports');
  assert(new Decimal(reference.migration.postSqrtPriceRaw).div(optimized.migration.postSqrtPriceRaw).sub(1).abs().lt(0.00001), 'terminal prices matched');
  for (const row of optimized.measurements.filter(r => r.staysInTerminalSegment)) {
    assert(row.gapPercentagePoints < 0.001, 'matched order gap below 0.001 percentage points');
  }
  assert(optimized.measurements.find(r => r.pctTotalSupply === 20)!.gapPercentagePoints > 1,
    'outside terminal range must expose discontinuity, not claim universal matching');
  const sensitivity = [];
  for (const scenario of [{ fee: 0, threshold: 1, boundary: 0.7 },
    { fee: 0, threshold: 25, boundary: 0.7 }, { fee: 5, threshold: 5, boundary: 0.7 },
    { fee: 0, threshold: 5, boundary: 0.9 }]) {
    const name = `optimized-fee${scenario.fee}-raise${scenario.threshold}-boundary${scenario.boundary}`;
    const config = buildPair(scenario.fee, scenario.threshold, scenario.boundary).optimized;
    const result = await experiment(name, config);
    for (const row of result.measurements.filter(r => r.staysInTerminalSegment)) {
      assert(row.gapPercentagePoints < 0.001, `${name} matching gap`);
    }
    writeFileSync(resolve(output, `${name}.json`), JSON.stringify(decimalJson(result), null, 2));
    sensitivity.push({ name, migration: result.migration, measurements: result.measurements });
  }
  const mismatchedFeeConfig = { ...pair.optimized,
    migratedPoolFee: { ...pair.optimized.migratedPoolFee, poolFeeBps: 100 } };
  const mismatched = await experiment('control-mismatched-trading-fee', mismatchedFeeConfig);
  assert(mismatched.measurements.find(r => r.pctTotalSupply === 1)!.gapPercentagePoints > 0.7,
    'matching liquidity alone must not imply matching fee-inclusive execution');
  writeFileSync(resolve(output, `${mismatched.name}.json`), JSON.stringify(decimalJson(mismatched), null, 2));
  writeFileSync(resolve(output, 'summary.json'), JSON.stringify({ generatedAt: new Date().toISOString(),
    scope: 'Local compiled-program execution, not devnet/mainnet; sample order sizes use total supply, not circulating supply.',
    baselineMigration: reference.migration, optimizedMigration: optimized.migration,
    baselineMeasurements: reference.measurements, optimizedMeasurements: optimized.measurements,
    sensitivity, mismatchedTradingFeeControl: { migration: mismatched.migration, measurements: mismatched.measurements } }, null, 2));
  console.log('Proof passed. Results saved to proof/results.');
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
