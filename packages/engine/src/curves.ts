import BN from "bn.js";
import Decimal from "decimal.js";
import * as dbc from "@meteora-ag/dynamic-bonding-curve-sdk";

Decimal.set({ precision: 60 });

export const SUPPLY = 1_000_000_000;
export const BASE_DECIMALS = 6;
export const TRADE_FEE_BPS = 25;
export const PROTOCOL_MIGRATION_FEE_BPS = 20;
export const CROSSING_RATIO = 0.7;
export const ORDER_PCTS = [0.25, 0.5, 1, 3, 5, 10, 20];
export function common(migrationFeePercent = 0, compoundingFeeBps = 0) {
  return {
    token: {
      tokenType: dbc.TokenType.SPLToken,
      tokenBaseDecimal: 6 as const,
      tokenQuoteDecimal: 9 as const,
      tokenAuthorityOption: dbc.TokenAuthorityOption.Immutable,
      totalTokenSupply: SUPPLY,
      leftover: 1000,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: dbc.BaseFeeMode.FeeSchedulerLinear as const,
        feeSchedulerParam: {
          startingFeeBps: TRADE_FEE_BPS,
          endingFeeBps: TRADE_FEE_BPS,
          numberOfPeriod: 0,
          totalDuration: 0,
        },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: dbc.CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: 0,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: dbc.MigrationOption.MET_DAMM_V2,
      migrationFeeOption: dbc.MigrationFeeOption.Customizable,
      migrationFee: {
        feePercentage: migrationFeePercent,
        creatorFeePercentage: 0,
      },
      migratedPoolFee: {
        collectFeeMode:
          compoundingFeeBps > 0
            ? dbc.MigratedCollectFeeMode.Compounding
            : dbc.MigratedCollectFeeMode.QuoteToken,
        dynamicFee: dbc.DammV2DynamicFeeMode.Disabled,
        poolFeeBps: TRADE_FEE_BPS,
        compoundingFeeBps,
        baseFeeMode: dbc.DammV2BaseFeeMode.FeeTimeSchedulerLinear,
      },
    },
    liquidityDistribution: {
      partnerLiquidityPercentage: 0,
      partnerPermanentLockedLiquidityPercentage: 100,
      creatorLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 0,
    },
    lockedVesting: {
      totalLockedVestingAmount: 0,
      numberOfVestingPeriod: 0,
      cliffUnlockAmount: 0,
      totalVestingDuration: 0,
      cliffDurationFromMigrationTime: 0,
    },
    activationType: dbc.ActivationType.Timestamp,
  };
}

export function migrationPrice(config: dbc.ConfigParameters): BN {
  return dbc.getMigrationThresholdPrice(
    config.migrationQuoteThreshold,
    config.sqrtStartPrice,
    config.curve,
  );
}

/** Solve early liquidity and start price while preserving supply, raise, and terminal price. */
export function buildPair(
  migrationFeePercent = 0,
  thresholdSol = 5,
  boundaryRatio = CROSSING_RATIO,
  allocationPct = 20,
  compoundingFeeBps = 0,
) {
  const params = common(migrationFeePercent, compoundingFeeBps);
  const baseline = dbc.buildCurve({
    ...params,
    percentageSupplyOnMigration: allocationPct,
    migrationQuoteThreshold: thresholdSol,
  });
  const terminal = migrationPrice(baseline);
  const sm = new Decimal(terminal.toString());
  if (!(boundaryRatio > 0.6 && boundaryRatio < 1))
    throw new Error("boundaryRatio must be between 0.6 and 1");
  const sc = sm.mul(boundaryRatio).floor();
  const retained = new Decimal(1)
    .sub(migrationFeePercent / 100)
    .mul(1 - PROTOCOL_MIGRATION_FEE_BPS / 10_000);
  const target = baseline.migrationQuoteThreshold;
  const candidate = (ratio: number) => {
    const s0 = sm.mul(ratio).floor();
    // L_early*(sc-s0) + L_terminal*(sm-sc) = Q*2^128.
    // L_terminal = retained*Q*2^128/(sm-s_min).
    const effectiveMin =
      compoundingFeeBps > 0 ? "0" : dbc.MIN_SQRT_PRICE.toString();
    const earlyWeight = sm
      .sub(effectiveMin)
      .div(retained)
      .sub(sm.sub(sc))
      .div(sc.sub(s0))
      .toNumber();
    return dbc.buildCurveWithCustomSqrtPrices({
      ...params,
      sqrtPrices: [new BN(s0.toFixed(0)), new BN(sc.toFixed(0)), terminal],
      liquidityWeights: [earlyWeight, 1],
    });
  };
  let lo = 0.01,
    hi = boundaryRatio - 0.000001;
  if (
    candidate(lo).migrationQuoteThreshold.gte(target) ||
    candidate(hi).migrationQuoteThreshold.lte(target)
  ) {
    throw new Error(
      "Requested allocation and terminal coverage are infeasible in this two-segment family",
    );
  }
  for (let i = 0; i < 55; i++) {
    const mid = (lo + hi) / 2;
    const c = candidate(mid);
    if (c.migrationQuoteThreshold.lt(target)) lo = mid;
    else hi = mid;
  }
  const optimized = candidate((lo + hi) / 2);
  return { baseline, optimized, migrationFeePercent, thresholdSol };
}

export const amountForPct = (pct: number) =>
  new BN(
    new Decimal(SUPPLY)
      .mul(10 ** BASE_DECIMALS)
      .mul(pct)
      .div(100)
      .toFixed(0),
  );

/** Ideal execution shortfall including a quote-output fee, within one segment. */
export function idealSellOutput(
  sqrtRaw: BN,
  liquidity: BN,
  amount: BN,
): Decimal {
  const s = new Decimal(sqrtRaw.toString()).div(new Decimal(2).pow(64));
  const l = new Decimal(liquidity.toString()).div(new Decimal(2).pow(64));
  const q = new Decimal(amount.toString());
  return l
    .mul(s.sub(l.mul(s).div(l.add(q.mul(s)))))
    .mul(1 - TRADE_FEE_BPS / 10_000);
}
