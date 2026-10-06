"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Keypair, PublicKey, Transaction } = require("@solana/web3.js");
const {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} = require("@solana/spl-token");
const bs58 = require("bs58").default;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
module.exports = async ({
  root,
  origin,
  connection,
  key,
  call,
  signPrepared,
  cases,
  launch,
  launchId,
  checkpoint,
}) => {
  const clients = new Map();
  async function actor(signer) {
    const wallet = signer.publicKey.toBase58();
    if (clients.has(wallet)) return clients.get(wallet);
    let cookie = "",
      csrf = "";
    const client = async (route, body, expected = 200) => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const response = await fetch(origin + "/api/v1" + route, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            Origin: origin,
            "Content-Type": "application/json",
            Cookie: cookie,
            "X-CSRF-Token": csrf,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const value = await response.json();
        if (response.status === 503 && attempt < 3) {
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        assert.equal(
          response.status,
          expected,
          `${route}: ${JSON.stringify(value)}`,
        );
        if (response.headers.get("set-cookie"))
          cookie = response.headers.get("set-cookie").split(";")[0];
        return value;
      }
      throw Error("API availability retry exhausted");
    };
    const challenge = await client("/auth/challenges", { wallet });
    const privateKey = crypto.createPrivateKey({
      format: "der",
      type: "pkcs8",
      key: Buffer.concat([
        Buffer.from("302e020100300506032b657004220420", "hex"),
        signer.secretKey.slice(0, 32),
      ]),
    });
    csrf = (
      await client("/auth/verify", {
        id: challenge.id,
        signature: bs58.encode(
          crypto.sign(null, Buffer.from(challenge.message), privateKey),
        ),
      })
    ).csrf_token;
    clients.set(wallet, client);
    return client;
  }
  const receipts = [];
  async function finalize(client, prepared, signer, checkBadSignature = false) {
    const tx = Transaction.from(Buffer.from(prepared.transaction, "base64"));
    tx.partialSign(signer);
    if (checkBadSignature) {
      const bad = Transaction.from(tx.serialize());
      bad.signatures[0].signature = Buffer.alloc(64, 1);
      await client(
        `/transactions/${prepared.id}/submit`,
        {
          transaction: bad
            .serialize({ verifySignatures: false })
            .toString("base64"),
        },
        422,
      );
      checkpoint("invalid-signature-rejected");
    }
    await client(`/transactions/${prepared.id}/submit`, {
      transaction: tx.serialize().toString("base64"),
    });
    for (let i = 0; i < 150; i++) {
      const receipt = await client(`/transactions/${prepared.id}`);
      if (receipt.state === "finalized") {
        receipts.push(receipt);
        return receipt;
      }
      assert(
        !["failed", "expired", "verification_failed"].includes(receipt.state),
        JSON.stringify(receipt),
      );
      await sleep(2000);
    }
    throw Error("Reviewer transaction did not finalize");
  }
  async function balance(address) {
    return BigInt(
      (
        await connection.getTokenAccountBalance(
          new PublicKey(address),
          "finalized",
        )
      ).value.amount,
    );
  }
  const trader = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(path.join(root, ".local/devnet/keys/trader.json")),
      ),
    ),
  );
  const traderClient = await actor(trader);
  await finalize(
    traderClient,
    await traderClient("/contracts/prepare", {
      action: "wrap_sol",
      accounts: { launcher: trader.publicKey.toBase58() },
      args: { amount: "5000000" },
    }),
    trader,
  );
  const meme = await call(`/tokens/${launch.accounts.launch}`);
  await finalize(
    traderClient,
    await traderClient("/swaps/prepare", {
      protocol: "damm_v2",
      pool: meme.pool,
      amount: "1000000",
      base_for_quote: false,
      mode: "exact_in",
      slippage_bps: 100,
    }),
    trader,
  );
  const purchased = await balance(
    getAssociatedTokenAddressSync(
      new PublicKey(launch.accounts.base_mint),
      trader.publicKey,
    ).toBase58(),
  );
  assert(purchased > 0n);
  checkpoint("independent-trader-damm-buy", {
    wallet: trader.publicKey.toBase58(),
    purchased_atomic: purchased.toString(),
  });
  const funding = cases.find((item) => item.mechanism === "funding");
  const a = funding.detail.accounts;
  const before = (await call(`/contracts/escrow/${a.module_vault}`)).state;
  const vaultBefore = await balance(a.token_vault);
  assert.equal(vaultBefore.toString(), before.initial_funding);
  const beneficiaryAta = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    key.publicKey,
  ).toBase58();
  const beneficiaryBefore = await balance(beneficiaryAta);
  const vote = (reviewer, approve) => ({
    action: "escrow_vote",
    accounts: {
      vault: a.module_vault,
      reviewer,
      token_vault: a.token_vault,
      beneficiary_tokens: beneficiaryAta,
      token_program: TOKEN_PROGRAM_ID.toBase58(),
    },
    args: { approve },
  });
  const first = await actor(funding.reviewers[0]);
  const second = await actor(funding.reviewers[1]);
  const creator = await actor(key);
  await creator(
    "/contracts/prepare",
    vote(funding.reviewers[0].publicKey.toBase58(), true),
    403,
  );
  await creator(
    "/contracts/prepare",
    vote(key.publicKey.toBase58(), true),
    422,
  );
  checkpoint("unauthorized-reviewer-rejected");
  assert.equal(
    before.current_milestone,
    0,
    "Extra scenarios must resume before the first milestone release",
  );
  if ((Number(before.approve_mask) & 1) === 0) {
    await finalize(
      first,
      await first(
        "/contracts/prepare",
        vote(funding.reviewers[0].publicKey.toBase58(), true),
      ),
      funding.reviewers[0],
      true,
    );
  }
  assert.equal(
    await balance(a.token_vault),
    vaultBefore,
    "One reviewer must not release funds",
  );
  await first(
    "/contracts/prepare",
    vote(funding.reviewers[0].publicKey.toBase58(), true),
    422,
  );
  checkpoint("duplicate-vote-rejected");
  await finalize(
    second,
    await second(
      "/contracts/prepare",
      vote(funding.reviewers[1].publicKey.toBase58(), true),
    ),
    funding.reviewers[1],
    true,
  );
  const approved = (await call(`/contracts/escrow/${a.module_vault}`)).state;
  assert.equal(approved.current_milestone, 1);
  const released = BigInt(before.budgets[0]);
  assert.equal(await balance(a.token_vault), vaultBefore - released);
  assert.equal(await balance(beneficiaryAta), beneficiaryBefore + released);
  checkpoint("funding-majority-release", {
    released_lamports: released.toString(),
  });
  for (let i = 0; i < 2; i++) {
    const client = i === 0 ? first : second;
    const signer = funding.reviewers[i];
    await finalize(
      client,
      await client(
        "/contracts/prepare",
        vote(signer.publicKey.toBase58(), false),
      ),
      signer,
    );
  }
  const rejected = (await call(`/contracts/escrow/${a.module_vault}`)).state;
  assert.equal(rejected.state, 2);
  const mint = new PublicKey(a.base_mint);
  const burn = "1000000000";
  const quote = await call(
    `/contracts/escrow/${a.module_vault}/redemption-quote`,
    { burn_amount: burn },
  );
  const supplyBefore = BigInt(
    (await connection.getTokenSupply(mint, "finalized")).value.amount,
  );
  const reserveBefore = await balance(a.token_vault);
  const payout = (BigInt(burn) * reserveBefore) / supplyBefore;
  assert(payout > 0n);
  const refund = {
    action: "escrow_refund",
    accounts: {
      vault: a.module_vault,
      base_mint: a.base_mint,
      holder: key.publicKey.toBase58(),
      holder_tokens: getAssociatedTokenAddressSync(
        mint,
        key.publicKey,
      ).toBase58(),
      token_vault: a.token_vault,
      receiver: beneficiaryAta,
      token_program: TOKEN_PROGRAM_ID.toBase58(),
      quote_mint: NATIVE_MINT.toBase58(),
    },
    args: { burn_amount: burn, min_payout: payout.toString() },
  };
  const excessive = structuredClone(refund);
  excessive.args.min_payout = (payout + 1n).toString();
  await creator("/contracts/prepare", excessive, 422);
  checkpoint("minimum-payout-protected");
  await signPrepared(await call("/contracts/prepare", refund));
  assert.equal(
    BigInt((await connection.getTokenSupply(mint, "finalized")).value.amount),
    supplyBefore - BigInt(burn),
  );
  assert.equal(await balance(a.token_vault), reserveBefore - payout);
  checkpoint("funding-rejection-refund", {
    burn_amount: burn,
    payout_lamports: payout.toString(),
    quote,
  });
  // Both DBC and DAMM fees feed the same native DFS vault after graduation.
  const vault = launch.accounts.fee_vault;
  for (const protocol of ["dbc", "damm_v2"])
    await signPrepared(
      await call(`/launches/${launchId}/fees/sweep/prepare`, { protocol }),
    );
  const feesBefore = (await call(`/fee-vaults/${vault}`)).state;
  assert.equal(feesBefore.total_share, 10000);
  assert(BigInt(feesBefore.total_funded) > 0n);
  const recipient = feesBefore.recipients.find(
    (r) => r.wallet === key.publicKey.toBase58(),
  );
  assert(recipient && BigInt(recipient.pending) > 0n);
  const tokenBefore = await balance(beneficiaryAta);
  await signPrepared(await call(`/fee-vaults/${vault}/claims/prepare`, {}));
  assert.equal(
    await balance(beneficiaryAta),
    tokenBefore + BigInt(recipient.pending),
  );
  const feesAfter = (await call(`/fee-vaults/${vault}`)).state;
  assert.equal(
    feesAfter.recipients.find((r) => r.wallet === key.publicKey.toBase58())
      .pending,
    "0",
  );
  const accounted = feesAfter.recipients.reduce(
    (sum, r) => sum + BigInt(r.claimed) + BigInt(r.pending),
    0n,
  );
  assert(
    accounted <= BigInt(feesAfter.total_funded),
    "Royalties cannot exceed native claimed trading fees",
  );
  checkpoint("dbc-damm-dfs-fee-sharing", {
    total_funded: feesAfter.total_funded,
    claimed: recipient.pending,
  });
  const actorTransactions = [];
  for (const signer of [trader, ...funding.reviewers.slice(0, 2)]) {
    const client = await actor(signer);
    let offset = 0;
    do {
      const activity = await client(`/me/activity?limit=100&offset=${offset}`);
      actorTransactions.push(
        ...activity.items.filter((r) => r.state === "finalized"),
      );
      offset = activity.next_offset;
    } while (offset != null);
  }
  const release = JSON.parse(
    fs.readFileSync(
      path.join(root, "contracts/tests/evidence/devnet-deployment.json"),
    ),
  );
  return {
    release_programs: release.programs.map(({ address, sha256 }) => ({
      address,
      sha256,
    })),
    actor_transactions: actorTransactions,
    scenario_receipts: receipts,
    creator_activity_count_scope:
      "All finalized rows in the creator's paginated activity; other actor receipts are listed separately",
    independent_trader_buy: true,
    funding_approval: true,
    funding_rejection_refund: true,
    wrong_signature_rejected: true,
    unauthorized_reviewer_rejected: true,
    duplicate_vote_rejected: true,
    minimum_payout_protected: true,
    dfs_claim_verified: true,
  };
};
