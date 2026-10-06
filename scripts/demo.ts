import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { Keypair, Transaction } from "@solana/web3.js";
import BN from "bn.js";
import * as dbc from "@meteora-ag/dynamic-bonding-curve-sdk";
import { API_ORIGIN } from "../server/src/config";
async function main() {
  const info = (await fetch(API_ORIGIN + "/api/session").then((r) =>
    r.json(),
  )) as any;
  async function call(path: string, body?: any) {
    const r = await fetch(API_ORIGIN + path, {
      method: body ? "POST" : "GET",
      headers: body
        ? {
            "Content-Type": "application/json",
            "x-depthguard-session": info.session,
          }
        : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const value = (await r.json()) as any;
    if (!r.ok) throw new Error(value.error);
    return value;
  }
  async function execute(p: any, key: Keypair) {
    const t = Transaction.from(Buffer.from(p.transaction, "base64"));
    t.partialSign(key);
    const result = await call("/api/transactions/send", {
      id: p.id,
      session: p.session,
      transaction: t.serialize().toString("base64"),
    });
    assert(!result.verificationError, result.verificationError);
    return result;
  }
  const results = [];
  for (const compoundBps of [0, 5000, 10000]) {
    const creator = Keypair.generate(),
      trader = Keypair.generate();
    await call("/api/faucet", { wallet: creator.publicKey.toBase58() });
    await call("/api/faucet", { wallet: trader.publicKey.toBase58() });
    let prepared = await call("/api/launches/prepare", {
      wallet: creator.publicKey.toBase58(),
      name: `Demo Compound ${compoundBps / 100}`,
      symbol: "DEMO",
      description: "Executed local lifecycle; synthetic volume.",
      link: "",
      settings: { raiseSol: 5, allocationPct: 20, compoundBps },
    });
    let r = await execute(prepared, creator);
    while (r.launch.state.phase.startsWith("DRAFT")) {
      prepared = await call(`/api/launches/${r.launch.id}/resume`, {
        wallet: creator.publicKey.toBase58(),
      });
      r = await execute(prepared, creator);
    }
    const id = r.launch.id;
    async function trade(side: string, amountRaw: string) {
      const p = await call(`/api/launches/${id}/swap`, {
        wallet: trader.publicKey.toBase58(),
        side,
        amountRaw,
        slippageBps: 100,
      });
      return { ...(await execute(p, trader)), quote: p.quote };
    }
    const cfg = (await call(`/api/launches/${id}/export`)).config;
    const [gross] = dbc.getIncludedFeeAmount(
      new BN(25 * 100_000),
      new BN(cfg.migrationQuoteThreshold).subn(1000),
    );
    await trade("buy", gross.toString());
    r = await trade("buy", "10000");
    assert.equal(r.launch.state.phase, "DAMM");
    assert(r.launch.migration?.verified);
    const start = r.launch.state,
      series = [start];
    let grossBuys = 0n,
      netSells = 0n;
    for (let i = 0; i < 40; i++) {
      const bought = await trade("buy", "1000000000");
      const sold = await trade("sell", bought.quote.outputRaw);
      grossBuys += 1_000_000_000n;
      netSells += BigInt(sold.quote.outputRaw);
      series.push(sold.launch.state);
    }
    const last = series.at(-1)!;
    assert.equal(last.baseReserveRaw, start.baseReserveRaw);
    const growth = BigInt(last.quoteReserveRaw) - BigInt(start.quoteReserveRaw);
    assert.equal(
      growth,
      grossBuys -
        netSells -
        BigInt(last.feeLedger.protocol) -
        BigInt(last.feeLedger.claimable),
    );
    const dumped = await trade("sell", "100000000000000");
    const dumpQuoteChangePct =
      (Number(dumped.launch.state.quoteReserveRaw) /
        Number(last.quoteReserveRaw) -
        1) *
      100;
    assert(dumpQuoteChangePct < -30);
    results.push({
      id,
      compoundBps,
      rounds: 40,
      series,
      netQuoteGrowthRaw: growth.toString(),
      traderQuoteLossRaw: (grossBuys - netSells).toString(),
      feeLedger: last.feeLedger,
      accountingVerified: true,
      dumpQuoteChangePct,
      proof: await call(`/api/launches/${id}/export`),
    });
    console.log(
      `PASS compound ${compoundBps / 100}%: growth ${Number(growth) / 1e9} local SOL; dump ${dumpQuoteChangePct.toFixed(2)}%`,
    );
  }
  assert(
    BigInt(results[2].netQuoteGrowthRaw) > BigInt(results[0].netQuoteGrowthRaw),
  );
  mkdirSync(".local", { recursive: true });
  writeFileSync(
    ".local/demo.json",
    JSON.stringify(
      {
        session: info.session,
        scope:
          "Actual local SBF execution, same-wallet synthetic round trips; no organic volume.",
        results,
      },
      null,
      2,
    ),
  );
  console.log(
    "Saved .local/demo.json; three launches visible in Trade. No private keys exported.",
  );
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
