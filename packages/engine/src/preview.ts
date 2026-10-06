import Decimal from "decimal.js";
import * as dbc from "@meteora-ag/dynamic-bonding-curve-sdk";
import { buildPair, migrationPrice, SUPPLY } from "./curves";

export type Settings = {
  raiseSol: number;
  allocationPct: number;
  compoundBps: number;
};
export const PRESETS = [
  { id: "fast", name: "Cepat", raiseSol: 2.5, allocationPct: 10 },
  { id: "balanced", name: "Seimbang", raiseSol: 5, allocationPct: 20 },
  { id: "deep", name: "Lebih dalam", raiseSol: 7.5, allocationPct: 30 },
];
export function settings(input: unknown): Settings {
  const s = input as Settings;
  if (
    !s ||
    !Number.isFinite(s.raiseSol) ||
    s.raiseSol < 0.25 ||
    s.raiseSol > 100 ||
    !Number.isFinite(s.allocationPct) ||
    s.allocationPct < 5 ||
    s.allocationPct > 35 ||
    ![0, 5000, 10000].includes(s.compoundBps)
  )
    throw new Error("Target 0,25–100 SOL, LP 5–35%, compounding 0/50/100%.");
  return {
    raiseSol: s.raiseSol,
    allocationPct: s.allocationPct,
    compoundBps: s.compoundBps,
  };
}
const scale = new Decimal(2).pow(64);
const sqrt = (raw: { toString(): string }) =>
  new Decimal(raw.toString()).div(scale);
export function spotSol(s: { toString(): string }): number {
  return sqrt(s).pow(2).div(1000).toNumber();
}
function terminalSell(config: dbc.ConfigParameters, amount: Decimal): Decimal {
  let current = sqrt(migrationPrice(config)),
    remaining = amount,
    result = new Decimal(0);
  for (let i = config.curve.length - 1; i >= 0 && remaining.gt(0); i--) {
    const segment = config.curve[i];
    if (sqrt(segment.sqrtPrice).lt(current)) continue;
    const lower = sqrt(
      i === 0 ? config.sqrtStartPrice : config.curve[i - 1].sqrtPrice,
    );
    const l = new Decimal(segment.liquidity.toString()).div(scale);
    const capacity = l.mul(
      new Decimal(1).div(lower).sub(new Decimal(1).div(current)),
    );
    const used = Decimal.min(capacity, remaining);
    const next = l.mul(current).div(l.add(used.mul(current)));
    result = result.add(l.mul(current.sub(next)));
    remaining = remaining.sub(used);
    current = next;
  }
  if (remaining.gt("0.01"))
    throw new Error("Order melebihi kapasitas base kurva.");
  return result.mul(0.9975); // Fixed quote-output trading fee, 25 bps.
}
function points(config: dbc.ConfigParameters) {
  let start = sqrt(config.sqrtStartPrice),
    baseSold = new Decimal(0);
  const terminal = sqrt(migrationPrice(config)),
    rows = [{ soldPct: 0, priceSol: start.pow(2).div(1000).toNumber() }];
  for (const segment of config.curve) {
    const end = Decimal.min(sqrt(segment.sqrtPrice), terminal);
    if (end.lte(start)) continue;
    const l = new Decimal(segment.liquidity.toString()).div(scale),
      from = start;
    for (let i = 1; i <= 24; i++) {
      const s = from.add(end.sub(from).mul(i / 24));
      rows.push({
        soldPct: baseSold
          .add(l.mul(new Decimal(1).div(from).sub(new Decimal(1).div(s))))
          .div(1e6)
          .div(SUPPLY)
          .mul(100)
          .toNumber(),
        priceSol: s.pow(2).div(1000).toNumber(),
      });
    }
    baseSold = baseSold.add(
      l.mul(new Decimal(1).div(from).sub(new Decimal(1).div(end))),
    );
    start = end;
    if (end.eq(terminal)) break;
  }
  return rows;
}
export function preview(input: unknown) {
  const s = settings(input),
    pair = buildPair(0, s.raiseSol, 0.7, s.allocationPct, s.compoundBps);
  const config = pair.optimized,
    terminal = migrationPrice(config),
    pRaw = sqrt(terminal).pow(2);
  const yRaw = new Decimal(config.migrationQuoteThreshold.toString()).mul(
      0.998,
    ),
    xRaw = yRaw.div(pRaw);
  const liq = new Decimal(
    config.curve[config.curve.length - 1].liquidity.toString(),
  ).div(scale);
  const boundary = sqrt(config.curve[config.curve.length - 2].sqrtPrice);
  const coverage = liq
    .mul(new Decimal(1).div(boundary).sub(new Decimal(1).div(sqrt(terminal))))
    .div(1e6)
    .div(SUPPLY)
    .mul(100)
    .toNumber();
  const rows = [0.25, 0.5, 1, 3, 5, 10, 20].map((pct) => {
    const q = new Decimal(SUPPLY).mul(1e6).mul(pct / 100);
    const post = yRaw.mul(q).div(xRaw.add(q)).mul(0.9975);
    const pre = terminalSell(config, q),
      base = terminalSell(pair.baseline, q);
    const impact = (output: Decimal) =>
      new Decimal(1)
        .sub(output.div(q.mul(pRaw)))
        .mul(100)
        .toNumber();
    return {
      pct,
      pre: impact(pre),
      post: impact(post),
      baseline: impact(base),
      covered: pct <= coverage,
      preOutputRaw: pre.floor().toFixed(0),
      postOutputRaw: post.floor().toFixed(0),
    };
  });
  return {
    settings: s,
    config,
    baselineConfig: pair.baseline,
    summary: {
      settings: s,
      supply: SUPPLY,
      feeBps: 25,
      protocolMigrationFeeBps: 20,
      lpLockPct: 100,
      coveragePct: coverage,
      migrationSpotSol: spotSol(terminal),
      quoteDepositSol: yRaw.div(1e9).toNumber(),
      baseDepositTokens: xRaw.div(1e6).toNumber(),
      rows,
      curve: points(config),
      baselineCurve: points(pair.baseline),
      provenance:
        "Analytical preview from solved config; integer SBF checks run in integration tests.",
    },
  };
}
