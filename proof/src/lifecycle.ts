import assert from 'node:assert/strict';
import BN from 'bn.js';
import Decimal from 'decimal.js';
import { PublicKey, Keypair } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { CpAmm, SwapMode, PoolState, derivePositionAddress, derivePositionNftAccount } from '@meteora-ag/cp-amm-sdk';
import { ProofVm } from './vm';
import { amountForPct } from './curves';

/** Execute a synthetic trading path; reserve bookkeeping is checked after every swap. */
export async function runLifecycle(vm: ProofVm, cp: CpAmm, address: PublicKey, owner: Keypair,
  baseMint: PublicKey, options: { roundTrips: number; quotePerBuySol: number; dumpPct: number; balancedLpSol?: number }) {
  let totalProtocol = new BN(0), totalClaimable = new BN(0), totalCompound = new BN(0);
  let buys = new BN(0), sells = new BN(0), executed = 0;
  const quote = (pool: PoolState, buy: boolean, amount: BN) => cp.getQuote2({
    poolState: pool, inputTokenMint: buy ? NATIVE_MINT : baseMint,
    amountIn: amount, swapMode: SwapMode.ExactIn, slippage: 0.1, hasReferral: false,
    tokenADecimal: 6, tokenBDecimal: 9,
    currentPoint: new BN(vm.svm.getClock().unixTimestamp.toString()),
  });
  const snapshot = async (label: string) => {
    const pool = await cp.fetchPoolState(address);
    const p = new Decimal(pool.sqrtPrice.toString()).div(new Decimal(2).pow(64)).pow(2);
    const sell = quote(pool, false, amountForPct(1));
    const buy = quote(pool, true, new BN(1_000_000_000));
    return { label, executedSwaps: executed, baseReserveRaw: pool.tokenAAmount.toString(),
      quoteReserveRaw: pool.tokenBAmount.toString(), kRaw: new Decimal(pool.tokenAAmount.toString()).mul(pool.tokenBAmount.toString()).toFixed(0),
      spotSolPerToken: p.div(1000).toNumber(),
      sell1PctShortfallPct: new Decimal(1).sub(new Decimal(sell.outputAmount.toString())
        .div(new Decimal(amountForPct(1).toString()).mul(p))).mul(100).toNumber(),
      buy1SolShortfallPct: new Decimal(1).sub(new Decimal(buy.outputAmount.toString())
        .mul(p).div(1_000_000_000)).mul(100).toNumber(),
      cumulativeCompoundRaw: totalCompound.toString(), cumulativeClaimableRaw: totalClaimable.toString(),
      cumulativeProtocolRaw: totalProtocol.toString(), cumulativeQuoteBuyRaw: buys.toString(),
      cumulativeQuoteSellOutputRaw: sells.toString() };
  };
  const trade = async (label: string, buy: boolean, input: BN) => {
    const before = await cp.fetchPoolState(address);
    const q = quote(before, buy, input);
    const inputMint = buy ? NATIVE_MINT : baseMint, outputMint = buy ? baseMint : NATIVE_MINT;
    const outputAta = getAssociatedTokenAddressSync(outputMint, owner.publicKey);
    const beforeBalance = vm.balance(outputAta);
    const tx = await cp.swap({ payer: owner.publicKey, pool: address, inputTokenMint: inputMint,
      outputTokenMint: outputMint, amountIn: input, minimumAmountOut: q.minimumAmountOut!,
      tokenAVault: before.tokenAVault, tokenBVault: before.tokenBVault,
      tokenAMint: baseMint, tokenBMint: NATIVE_MINT, tokenAProgram: TOKEN_PROGRAM_ID,
      tokenBProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null, poolState: before });
    const simulated = vm.trialOutput(tx, [owner], outputAta);
    assert.equal(simulated.toString(), q.outputAmount.toString());
    vm.send(label, tx, [owner]);
    assert.equal((vm.balance(outputAta) - beforeBalance).toString(), q.outputAmount.toString(), 'executed token transfer equals quote');
    const after = await cp.fetchPoolState(address);
    const feeTotal = q.claimingFee.add(q.compoundingFee).add(q.protocolFee).add(q.referralFee);
    if (buy) {
      assert(after.tokenAAmount.eq(before.tokenAAmount.sub(q.outputAmount)));
      assert(after.tokenBAmount.eq(before.tokenBAmount.add(q.excludedFeeInputAmount).add(q.compoundingFee)));
      buys = buys.add(input);
    } else {
      assert(after.tokenAAmount.eq(before.tokenAAmount.add(q.excludedFeeInputAmount)));
      assert(after.tokenBAmount.eq(before.tokenBAmount.sub(q.outputAmount).sub(feeTotal).add(q.compoundingFee)));
      sells = sells.add(q.outputAmount);
    }
    totalProtocol = totalProtocol.add(q.protocolFee);
    totalClaimable = totalClaimable.add(q.claimingFee);
    totalCompound = totalCompound.add(q.compoundingFee);
    executed++;
    return q.outputAmount;
  };
  const series = [await snapshot('after-migration')];
  const buySize = new BN(new Decimal(options.quotePerBuySol).mul(1e9).toFixed(0));
  for (let i = 0; i < options.roundTrips; i++) {
    const baseReceived = await trade(`round-${i + 1}-buy`, true, buySize);
    await trade(`round-${i + 1}-sell-back`, false, baseReceived);
    series.push(await snapshot(`after-round-${i + 1}`));
  }
  const start = series[0], afterRounds = series.at(-1)!;
  assert.equal(afterRounds.baseReserveRaw, start.baseReserveRaw, 'closed round trips leave base reserve unchanged');
  const growth = new BN(afterRounds.quoteReserveRaw).sub(new BN(start.quoteReserveRaw));
  const quoteLoss = buys.sub(sells);
  assert(growth.eq(quoteLoss.sub(totalProtocol).sub(totalClaimable)), 'reserve growth funded by trader costs after fee payouts');
  let balancedLiquidity;
  if (options.balancedLpSol) {
    const before = await snapshot('before-balanced-lp');
    const pool = await cp.fetchPoolState(address);
    const budget = new BN(new Decimal(options.balancedLpSol).mul(1e9).toFixed(0));
    const deposit = cp.getDepositQuote({ inAmount: budget, isTokenA: false,
      minSqrtPrice: pool.sqrtMinPrice, maxSqrtPrice: pool.sqrtMaxPrice, sqrtPrice: pool.sqrtPrice,
      collectFeeMode: pool.collectFeeMode, tokenAAmount: pool.tokenAAmount,
      tokenBAmount: pool.tokenBAmount, liquidity: pool.liquidity });
    const nft = Keypair.generate();
    const tx = await cp.createPositionAndAddLiquidity({ owner: owner.publicKey, pool: address,
      positionNft: nft.publicKey, liquidityDelta: deposit.liquidityDelta,
      maxAmountTokenA: deposit.outputAmount.addn(2), maxAmountTokenB: budget.addn(2),
      tokenAAmountThreshold: deposit.outputAmount.addn(2), tokenBAmountThreshold: budget.addn(2),
      tokenAMint: baseMint, tokenBMint: NATIVE_MINT, tokenAProgram: TOKEN_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID });
    vm.send('balanced-add-liquidity', tx, [owner, nft]);
    const position = derivePositionAddress(nft.publicKey);
    const lock = await cp.permanentLockPosition({ owner: owner.publicKey, pool: address, position,
      positionNftAccount: derivePositionNftAccount(nft.publicKey), unlockedLiquidity: deposit.liquidityDelta });
    vm.send('balanced-lp-permanent-lock', lock, [owner]);
    const state = await cp.fetchPositionState(position);
    assert(state.permanentLockedLiquidity.eq(deposit.liquidityDelta));
    const after = await snapshot('after-balanced-lp');
    const baseDeposit = new BN(after.baseReserveRaw).sub(new BN(before.baseReserveRaw));
    const quoteDeposit = new BN(after.quoteReserveRaw).sub(new BN(before.quoteReserveRaw));
    assert(baseDeposit.sub(deposit.outputAmount).abs().lten(2));
    assert(quoteDeposit.sub(budget).abs().lten(2));
    assert(Math.abs(after.spotSolPerToken / before.spotSolPerToken - 1) < 1e-7);
    assert(after.sell1PctShortfallPct < before.sell1PctShortfallPct);
    balancedLiquidity = { before, after, baseDepositedRaw: baseDeposit.toString(),
      quoteDepositedRaw: quoteDeposit.toString(), permanentLockVerified: true, position: position.toBase58() };
    series.push(after);
  }
  const beforeDump = await snapshot('before-dump');
  await trade('whale-dump', false, amountForPct(options.dumpPct));
  const afterDump = await snapshot('after-dump');
  series.push(afterDump);
  return { assumptions: 'Synthetic same-wallet buy/sell-back path; fixed fee; no organic volume or time decay. Each round returns the exact base bought. Optional balanced LP is separately funded after the rounds.',
    options, series, balancedLiquidity, roundTrips: { quoteReserveGrowthRaw: growth.toString(), quoteTraderLossRaw: quoteLoss.toString(),
      protocolFeeRaw: afterRounds.cumulativeProtocolRaw, claimableLpFeeRaw: afterRounds.cumulativeClaimableRaw,
      compoundedLpFeeRaw: afterRounds.cumulativeCompoundRaw, accountingVerified: true },
    dump: { pctTotalSupply: options.dumpPct,
      quoteReserveChangePct: new Decimal(afterDump.quoteReserveRaw).div(beforeDump.quoteReserveRaw).sub(1).mul(100).toNumber(),
      spotPriceChangePct: new Decimal(afterDump.spotSolPerToken).div(beforeDump.spotSolPerToken).sub(1).mul(100).toNumber(),
      before: beforeDump, after: afterDump }, quoteAndExecutionParityChecks: executed };
}
