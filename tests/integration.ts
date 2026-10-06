import assert from "node:assert/strict";
import { Keypair, Transaction } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import Decimal from "decimal.js";
import * as dbc from "@meteora-ag/dynamic-bonding-curve-sdk";
import { createApp } from "../server/src/app";
import { Runtime } from "../server/src/runtime";

async function main() {
  const { app, rt } = await createApp();
  const creator = Keypair.generate(),
    trader = Keypair.generate();
  async function request(url: string, body?: any, status = 200) {
    const r = await app.inject({
      method: body ? "POST" : "GET",
      url,
      payload: body,
      headers: body ? { "x-depthguard-session": rt.session } : undefined,
    });
    assert.equal(r.statusCode, status, r.body);
    return r.json();
  }
  async function signed(p: any, key: Keypair) {
    const tx = Transaction.from(Buffer.from(p.transaction, "base64"));
    tx.partialSign(key);
    return request("/api/transactions/send", {
      id: p.id,
      transaction: tx.serialize().toString("base64"),
      session: p.session,
    });
  }
  async function trade(
    id: string,
    side: string,
    amountRaw: string,
    key = trader,
  ) {
    const p = await request(`/api/launches/${id}/swap`, {
      wallet: key.publicKey.toBase58(),
      side,
      amountRaw,
      slippageBps: 100,
    });
    const walletBefore = rt.wallet(key.publicKey.toBase58());
    const result = await signed(p, key),
      walletAfter = result.wallet;
    if (side === "buy")
      assert.equal(
        BigInt(walletAfter.tokens[id]) - BigInt(walletBefore.tokens[id]),
        BigInt(p.quote.outputRaw),
        "executed base output matches SDK quote",
      );
    else
      assert.equal(
        BigInt(walletAfter.solRaw) - BigInt(walletBefore.solRaw) + 5000n,
        BigInt(p.quote.outputRaw),
        "unwrapped native SOL output matches SDK quote after tx fee",
      );
    assert(!result.verificationError, result.verificationError);
    return { ...result, quote: p.quote };
  }
  await request("/api/faucet", { wallet: creator.publicKey.toBase58() });
  await request("/api/faucet", { wallet: trader.publicKey.toBase58() });
  await request("/api/faucet", { wallet: trader.publicKey.toBase58() }, 409);
  const evil = await app.inject({
    method: "POST",
    url: "/api/faucet",
    payload: { wallet: trader.publicKey.toBase58() },
    headers: {
      origin: "https://evil.example",
      "x-depthguard-session": rt.session,
    },
  });
  assert.equal(evil.statusCode, 403);
  await request(
    "/api/preview",
    { raiseSol: 5, allocationPct: 40, compoundBps: 0 },
    400,
  );
  const launches = [];
  for (const allocationPct of [10, 20, 30])
    for (const compoundBps of [0, 5000, 10000]) {
      const s = { raiseSol: allocationPct / 4, allocationPct, compoundBps };
      const prediction = await request("/api/preview", s);
      assert(
        prediction.rows
          .filter((r: any) => r.covered)
          .every((r: any) => Math.abs(r.pre - r.post) < 0.001),
      );
      let p = await request("/api/launches/prepare", {
        wallet: creator.publicKey.toBase58(),
        name: "Local Test",
        symbol: "TEST",
        description: "Actual SBF execution",
        link: "",
        settings: s,
      });
      const id = p.launchId;
      // Server must reject missing/tampered signatures without executing state.
      const unsigned = await request(
        "/api/transactions/send",
        { id: p.id, transaction: p.transaction, session: p.session },
        400,
      );
      assert(unsigned.error);
      await request(
        `/api/launches/${id}/resume`,
        { wallet: trader.publicKey.toBase58() },
        403,
      );
      const first = await signed(p, creator);
      assert.equal(first.launch.state.phase, "DRAFT_POOL");
      p = await request(`/api/launches/${id}/resume`, {
        wallet: creator.publicKey.toBase58(),
      });
      const created = await signed(p, creator);
      assert.equal(created.launch.state.phase, "DBC");
      const metadata = await request(`/metadata/${id}.json`);
      assert.equal(metadata.symbol, "TEST");
      await request(`/api/launches/${id}/migrate`, {}, 409);
      await request(
        `/api/launches/${id}/swap`,
        {
          wallet: trader.publicKey.toBase58(),
          side: "sell",
          amountRaw: "1000000",
          slippageBps: 100,
        },
        400,
      );
      const l = rt.launches.get(id)!,
        cfg = (await rt.client.state.getPoolConfig(l.config.publicKey))!;
      const desired = cfg.migrationQuoteThreshold.subn(1000);
      const [gross] = dbc.getIncludedFeeAmount(new BN(25 * 100_000), desired);
      await trade(id, "buy", gross.toString());
      const near = await request(`/api/launches/${id}`);
      assert.equal(near.state.phase, "DBC");
      const pre = (await rt.client.state.getPool(l.pool))!;
      // SDK quote vs official SBF simulation without changing the economic transaction.
      for (const pct of [0.25, 1, 3, 5, 10]) {
        const amount = new BN(new Decimal(1e15).mul(pct / 100).toFixed(0));
        const q = rt.client.pool.swapQuote({
          virtualPool: pre,
          config: cfg,
          swapBaseForQuote: true,
          amountIn: amount,
          slippageBps: 100,
          hasReferral: false,
          currentPoint: new BN(rt.vm.svm.getClock().unixTimestamp.toString()),
          eligibleForFirstSwapWithMinFee: false,
        });
        const beforeToken = rt.wallet(trader.publicKey.toBase58()).tokens[id];
        const p = await request(`/api/launches/${id}/swap`, {
          wallet: trader.publicKey.toBase58(),
          side: "sell",
          amountRaw: amount.toString(),
          slippageBps: 100,
        });
        const tx = Transaction.from(Buffer.from(p.transaction, "base64"));
        tx.partialSign(trader);
        const sim = rt.vm.svm.simulateTransaction(tx);
        assert("postAccounts" in sim, "simulation should succeed");
        const after = sim
          .postAccounts()
          .find(([a]: any) => a.equals(trader.publicKey))![1]
          .lamports();
        assert.equal(
          BigInt(after) -
            (rt.vm.svm.getBalance(trader.publicKey) ?? 0n) +
            5000n,
          BigInt(q.outputAmount.toString()),
        );
        assert.equal(
          rt.wallet(trader.publicKey.toBase58()).tokens[id],
          beforeToken,
          "simulation cannot mutate state",
        );
      }
      const migrated = await trade(id, "buy", "10000");
      assert.equal(migrated.launch.state.phase, "DAMM");
      assert(
        migrated.launch.migration?.verified,
        migrated.launch.migrationError,
      );
      assert(
        migrated.launch.migration.lockVerified &&
          migrated.launch.migration.rangeVerified &&
          migrated.launch.migration.vaultConservationVerified,
      );
      const again = await request(`/api/launches/${id}/migrate`, {});
      assert.equal(again.damm, migrated.launch.damm);
      const bought = await trade(id, "buy", "100000000");
      await trade(id, "sell", bought.quote.outputRaw);
      launches.push(id);
      console.log(`PASS LP ${allocationPct}% / compound ${compoundBps / 100}%`);
    }
  // A migrated pool with unverified invariants must not remain tradable.
  const guarded = rt.launches.get(launches[0])!;
  guarded.migration.verified = false;
  assert.equal((await rt.state(guarded)).phase, "DAMM_UNVERIFIED");
  await request(
    `/api/launches/${guarded.id}/quote`,
    {
      wallet: trader.publicKey.toBase58(),
      side: "buy",
      amountRaw: "1000000",
      slippageBps: 100,
    },
    409,
  );
  guarded.migration.verified = true;
  // A state revision change invalidates a prepared transaction before it can execute.
  const id = launches[0];
  const p = await request(`/api/launches/${id}/swap`, {
    wallet: trader.publicKey.toBase58(),
    side: "buy",
    amountRaw: "1000000",
    slippageBps: 100,
  });
  const t = Transaction.from(Buffer.from(p.transaction, "base64"));
  t.partialSign(trader);
  await request("/api/faucet", {
    wallet: Keypair.generate().publicKey.toBase58(),
  });
  await request(
    "/api/transactions/send",
    {
      id: p.id,
      transaction: t.serialize().toString("base64"),
      session: p.session,
    },
    409,
  );
  // Forged minimum output causes simulation failure and leaves pool reserves unchanged.
  const l = rt.launches.get(id)!,
    before = await rt.state(l),
    pool = await rt.cp.fetchPoolState(l.damm!);
  const bad = await rt.cp.swap({
    payer: trader.publicKey,
    pool: l.damm!,
    inputTokenMint: NATIVE_MINT,
    outputTokenMint: l.mint.publicKey,
    amountIn: new BN(1_000_000),
    minimumAmountOut: new BN("1000000000000000"),
    tokenAVault: pool.tokenAVault,
    tokenBVault: pool.tokenBVault,
    tokenAMint: l.mint.publicKey,
    tokenBMint: pool.tokenBMint,
    tokenAProgram: TOKEN_PROGRAM_ID,
    tokenBProgram: TOKEN_PROGRAM_ID,
    referralTokenAccount: null,
    poolState: pool,
  });
  rt.vm.prepare(bad, [trader]);
  const failed = rt.vm.svm.simulateTransaction(bad);
  assert(!("postAccounts" in failed));
  assert.equal((await rt.state(l)).quoteReserveRaw, before.quoteReserveRaw);
  const exported = await request(`/api/launches/${id}/export`);
  assert(exported.receipts.length >= 5);
  assert.equal(Object.keys(exported.binaryHashes).length, 3);
  console.log(
    "PASS 9 preset/compounding lifecycles; native SOL parity; stale/unsigned/slippage/migration guards.",
  );
  await app.close();
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
