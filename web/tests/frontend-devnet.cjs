// All application actions originate in browser UI. RPC is limited to devnet funding and independent verification.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { chromium, expect } = require("@playwright/test");
const { Keypair, Transaction, SystemProgram } = require("@solana/web3.js");
require("ts-node").register({ transpileOnly: true });
const root = path.resolve(__dirname, "../..");
process.env.DEVNET_RPC_FILE ||= path.join(root, ".local/devnet/rpc-url");
const rpc = require("../../contracts/scripts/devnet-rpc.cjs").connect(
  "finalized",
);
const origin = "https://depthguard.rbexp.com";
const dir = path.join(root, ".local/frontend-e2e");
fs.mkdirSync(dir, { recursive: true });
const evidencePath = path.join(root, "web/tests/evidence/frontend-devnet.json");
const evidence = fs.existsSync(evidencePath)
  ? JSON.parse(fs.readFileSync(evidencePath))
  : {
      network: "devnet",
      origin,
      started_at: new Date().toISOString(),
      wallet_kind:
        "Wallet Standard adapter backed by real persisted Ed25519 keypairs; no browser extension claims",
      application_actions:
        "Browser UI only; no direct API calls or injected draft state",
      checkpoints: [],
      transactions: [],
      launches: {},
      coverage: [],
      errors: [],
    };
if (evidence.last_failure)
  evidence.last_failure.message = evidence.last_failure.message.slice(0, 4000);
const save = () =>
  fs.writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
function record(stage, data = {}) {
  evidence.checkpoints.push({ stage, ...data, at: new Date().toISOString() });
  save();
  console.log(stage);
}
const key = (n) =>
  Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(path.join(root, ".local/devnet/keys", n + ".json")),
      ),
    ),
  );
const creator = key("creator");
const reviewers = [1, 2, 3].map((n) => key("reviewer-" + n));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let browser, latest;
async function actor(k) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  latest = page;
  page.setDefaultTimeout(25000);
  const priv = crypto.createPrivateKey({
    format: "der",
    type: "pkcs8",
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      Buffer.from(k.secretKey.slice(0, 32)),
    ]),
  });
  await page.exposeFunction("__realSignMessage", (a) => [
    ...crypto.sign(null, Buffer.from(a), priv),
  ]);
  await page.exposeFunction("__realSignTransaction", (a) => {
    const t = Transaction.from(Buffer.from(a));
    t.partialSign(k);
    return [...t.serialize()];
  });
  await page.addInitScript(
    ({ address, pubkey }) => {
      const account = {
        address,
        publicKey: new Uint8Array(pubkey),
        chains: ["solana:devnet"],
        features: ["solana:signMessage", "solana:signTransaction"],
      };
      const wallet = {
        version: "1.0.0",
        name: "Devnet E2E Wallet",
        icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=",
        chains: account.chains,
        accounts: [account],
        features: {
          "standard:connect": {
            version: "1.0.0",
            connect: async () => ({ accounts: [account] }),
          },
          "standard:disconnect": {
            version: "1.0.0",
            disconnect: async () => {},
          },
          "standard:events": { version: "1.0.0", on: () => () => {} },
          "solana:signMessage": {
            version: "1.0.0",
            signMessage: async ({ message }) => [
              {
                signedMessage: message,
                signature: new Uint8Array(
                  await window.__realSignMessage([...message]),
                ),
              },
            ],
          },
          "solana:signTransaction": {
            version: "1.0.0",
            supportedTransactionVersions: ["legacy"],
            signTransaction: async ({ transaction, chain }) => {
              if (window.__rejectNextTransaction) {
                window.__rejectNextTransaction = false;
                throw Error("The user rejected the transaction.");
              }
              if (chain !== "solana:devnet")
                throw Error("Only devnet signing is permitted");
              return [
                {
                  signedTransaction: new Uint8Array(
                    await window.__realSignTransaction([...transaction]),
                  ),
                },
              ];
            },
          },
        },
      };
      window.addEventListener("wallet-standard:app-ready", (e) =>
        e.detail.register(wallet),
      );
      window.dispatchEvent(
        new CustomEvent("wallet-standard:register-wallet", {
          detail: (api) => api.register(wallet),
        }),
      );
    },
    { address: k.publicKey.toBase58(), pubkey: [...k.publicKey.toBytes()] },
  );
  page.on("pageerror", (e) => {
    evidence.errors.push({ type: "browser", message: e.message });
    save();
  });
  page.on("response", async (r) => {
    try {
      if (!r.url().includes("/api/v1/")) return;
      const j = await r.json();
      if (r.status() >= 400) {
        evidence.http_errors ||= [];
        evidence.http_errors.push({
          path: new URL(r.url()).pathname,
          status: r.status(),
          method: r.request().method(),
        });
        save();
      }
      for (const receipt of [
        j,
        ...(Array.isArray(j.transactions) ? j.transactions : []),
      ]) {
        if (!receipt.signature || receipt.state !== "finalized") continue;
        const existing = evidence.transactions.find(
          (t) => t.signature === receipt.signature,
        );
        const action =
          receipt.summary?.action || receipt.summary?.kind || receipt.step;
        if (existing) {
          existing.action ||= action;
          continue;
        }
        evidence.transactions.push({
          id: receipt.id,
          signature: receipt.signature,
          action,
          protocol: receipt.summary?.protocol,
          wallet: k.publicKey.toBase58(),
          state: receipt.state,
          observed_in: new URL(r.url()).pathname,
        });
        save();
      }
    } catch {}
  });
  await page.goto(origin + "/settings");
  await page.locator(".wallet").click();
  await page
    .locator(".wallet-modal")
    .getByRole("button", { name: /Devnet E2E Wallet/ })
    .click();
  await page.getByRole("button", { name: "Authenticate", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Authenticated", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close wallet chooser" }).click();
  record("wallet-authenticated", { wallet: k.publicKey.toBase58() });
  return page;
}
async function clean(p) {
  const close = p.getByRole("button", { name: "Dismiss transaction" });
  if (await close.count()) await close.click();
}
async function tx(p, button) {
  await clean(p);
  await button.click();
  await expect(p.locator(".tx-toast strong")).toHaveText("finalized", {
    timeout: 150000,
  });
  await expect(
    p.getByRole("button", { name: "Dismiss transaction" }),
  ).toBeVisible({ timeout: 30000 });
  await sleep(300);
  await p.screenshot({
    path: path.join(dir, "tx-" + Date.now() + ".png"),
    fullPage: true,
  });
  assert.equal(
    await p.locator("p.error").count(),
    0,
    await p.locator("p.error").allTextContents(),
  );
}
async function importEconomy(p) {
  const dbc = require("@meteora-ag/dynamic-bonding-curve-sdk");
  const { common } = require("../../packages/engine/src/curves.ts");
  const c = dbc.buildCurve({
    ...common(),
    percentageSupplyOnMigration: 20,
    migrationQuoteThreshold: 0.1,
  });
  const e = require("../src/app/economy.ts").initialEconomy(
    creator.publicKey.toBase58(),
  );
  e.sqrt_start_price = c.sqrtStartPrice.toString();
  e.curve = c.curve.map((x) => ({
    sqrt_price: x.sqrtPrice.toString(),
    liquidity: x.liquidity.toString(),
  }));
  e.migration_quote_threshold = c.migrationQuoteThreshold.toString();
  await p.goto(origin + "/studio");
  await p.getByRole("button", { name: "New model", exact: true }).click();
  await p.locator("input[type=file]").setInputFiles({
    name: "devnet-economy.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(e)),
  });
  await expect(p.getByLabel("Graduation threshold")).toHaveValue(
    e.migration_quote_threshold,
  );
  return e;
}
async function launch(p, mechanism, variant = mechanism) {
  if (evidence.launches[variant]) return evidence.launches[variant];
  await importEconomy(p);
  const stamp = Date.now().toString().slice(-7);
  const name = "UI " + variant + " " + stamp;
  const symbol = "U" + mechanism.slice(0, 2).toUpperCase() + stamp.slice(-4);
  await p.getByLabel("Model name").fill(name);
  await p.getByRole("button", { name: "Validate", exact: true }).click();
  await expect(p.getByText("Validation result", { exact: true })).toBeVisible();
  await p.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(p.getByText("Draft saved", { exact: true })).toBeVisible();
  await p.goto(origin + "/create/identity");
  await p.getByLabel("Token name").fill(name);
  await p.getByLabel("Symbol", { exact: true }).fill(symbol);
  await p.getByLabel("Metadata URI").fill("https://depthguard.rbexp.com/docs");
  await p.getByRole("button", { name: /Continue/ }).click();
  await p
    .getByRole("button", {
      name: {
        meme: /Community launch/,
        funding: /Milestone funding/,
        backed: /Reserve economy/,
      }[mechanism],
    })
    .click();
  await p.getByRole("link", { name: /Continue/ }).click();
  if (mechanism === "funding")
    await p
      .getByLabel("Reviewer wallets")
      .fill(reviewers.map((k) => k.publicKey.toBase58()).join("\n"));
  if (variant !== mechanism && mechanism === "funding") {
    await p
      .locator(".segment")
      .filter({ has: p.getByLabel("Milestone 2 weight bps") })
      .getByRole("button", { name: "×", exact: true })
      .click();
    await p.getByLabel("Milestone 1 weight bps").fill("10000");
    await p
      .getByLabel("Milestone 1 deadline seconds")
      .fill(variant === "funding_expired" ? "30" : "3600");
  }
  await p.getByRole("link", { name: /Simulate economy/ }).click();
  await p.getByRole("link", { name: /Review launch/ }).click();
  await p.getByRole("button", { name: /Create launch workflow/ }).click();
  await p.waitForURL("**/creator/launches/*");
  const workflow = p.url();
  const item = { name, symbol, workflow };
  evidence.launches[variant] = item;
  save();
  return item;
}
async function ready(p, item) {
  await p.goto(item.workflow);
  for (let i = 0; i < 25; i++) {
    const ready = p.getByRole("button", { name: "Launch ready", exact: true });
    if (await ready.count()) break;
    await clean(p);
    await p.getByRole("button", { name: /Continue signing workflow/ }).click();
    await expect(
      p.getByRole("button", { name: /Continue signing workflow|Launch ready/ }),
    ).toBeVisible({ timeout: 150000 });
    const errors = await p.locator("p.error").allTextContents();
    assert.deepEqual(errors, []);
    if (i === 24) throw Error("Workflow did not complete");
  }
  item.token = await p
    .getByRole("link", { name: "Open token page", exact: true })
    .getAttribute("href");
  save();
  record("launch-ready", { ...item });
}
async function swap(p, item, side, amount, protocol = "dbc") {
  if (
    evidence.checkpoints.some(
      (c) =>
        c.stage === "swap" &&
        c.mechanism === item.name &&
        c.side === side &&
        c.amount === amount &&
        (c.protocol || "dbc") === protocol,
    )
  )
    return;
  await p.goto(origin + item.token);
  await p.getByRole("button", { name: side, exact: true }).click();
  await p
    .getByLabel(side === "buy" ? "You pay · WSOL" : "You sell · " + item.symbol)
    .fill(amount);
  await p.getByLabel("Slippage tolerance").selectOption("100");
  await tx(
    p,
    p.getByRole("button", {
      name: new RegExp(
        "^" + (side === "buy" ? "Buy" : "Sell") + " " + item.symbol,
      ),
    }),
  );
  record("swap", { mechanism: item.name, side, amount, protocol });
}
async function graduate(p, item) {
  if (
    evidence.checkpoints.some(
      (c) => c.stage === "graduated" && c.token === item.token,
    )
  )
    return;
  await p.goto(origin + item.token);
  await p.locator(".trade-layout").waitFor();
  const migrated = await p
    .locator(".metric")
    .filter({ hasText: "Market" })
    .innerText();
  const rights = await p
    .locator(".metric")
    .filter({ hasText: "Capital rights" })
    .innerText();
  if (
    migrated.includes("DAMM v2") &&
    (item.name.includes("meme") || rights.includes("Active"))
  ) {
    record("graduated", { token: item.token, recovered_from_ui: true });
    return;
  }
  await p.goto(item.workflow);
  for (let i = 0; i < 10; i++) {
    await clean(p);
    const button = p.getByRole("button", {
      name: /Continue graduation & activation/,
    });
    await expect(button).toBeVisible();
    const [result] = await Promise.all([
      p.waitForResponse(
        (r) =>
          r.url().includes("/factory/launches/") &&
          r.url().endsWith("/graduate") &&
          r.request().method() === "POST",
        { timeout: 90000 },
      ),
      button.click(),
    ]);
    assert(result.ok(), "Graduation preparation failed");
    const prepared = await result.json();
    if (prepared.state !== "complete") {
      await expect(p.locator(".tx-toast strong")).toHaveText("finalized", {
        timeout: 150000,
      });
      await expect(
        p.getByRole("button", { name: "Dismiss transaction" }),
      ).toBeVisible({ timeout: 30000 });
    }
    assert.deepEqual(await p.locator("p.error").allTextContents(), []);
    await p.getByRole("link", { name: "Open token page", exact: true }).click();
    await p.locator(".trade-layout").waitFor();
    const migrated = await p.getByText("DAMM v2", { exact: true }).count();
    if (
      migrated &&
      (item.name.includes("meme") ||
        (await p.getByText("Active", { exact: true }).count()))
    ) {
      record("graduated", { token: item.token });
      return;
    }
    await p.goto(item.workflow);
  }
  throw Error("Activation incomplete");
}
(async () => {
  assert.equal(
    await rpc.getGenesisHash(),
    "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
  );
  const balance = await rpc.getBalance(creator.publicKey);
  const freshRun = !evidence.checkpoints.some((c) => c.stage === "wrapped");
  const financialWorkPending = !evidence.checkpoints.some(
    (c) => c.stage === "unwrap-and-reconnect",
  );
  const fundingMinimum = freshRun
    ? 1800000000
    : financialWorkPending
      ? 300000000
      : 0;
  if (balance < fundingMinimum) {
    const amount = (freshRun ? 2000000000 : 1000000000) - balance;
    assert(
      (await rpc.getBalance(key("authority").publicKey)) >= amount + 5000,
      "The devnet funding source needs more test SOL",
    );
    const transfer = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: key("authority").publicKey,
        toPubkey: creator.publicKey,
        lamports: amount,
      }),
    );
    transfer.feePayer = key("authority").publicKey;
    transfer.recentBlockhash = (await rpc.getLatestBlockhash()).blockhash;
    transfer.sign(key("authority"));
    const funding = await rpc.sendRawTransaction(transfer.serialize());
    for (let i = 0; i < 90; i++) {
      const s = (await rpc.getSignatureStatuses([funding])).value[0];
      if (s?.err) throw Error("Devnet funding failed");
      if (s?.confirmationStatus === "finalized") break;
      await sleep(1500);
      if (i === 89) throw Error("Funding confirmation timed out");
    }
    record("wallet-funded", {
      wallet: creator.publicKey.toBase58(),
      devnet_lamports: amount,
      signature: funding,
    });
  }
  browser = await chromium.launch({ headless: true });
  const p = await actor(creator);
  if (!evidence.checkpoints.some((c) => c.stage === "wrapped")) {
    await p.goto(origin + "/portfolio");
    await p.getByLabel("SOL to wrap").fill("0.5");
    await tx(p, p.getByRole("button", { name: /Wrap SOL ↗/ }));
    record("wrapped", { amount: "0.5" });
  }
  for (const mechanism of ["meme", "backed", "funding"]) {
    const item = await launch(p, mechanism);
    if (!item.token) await ready(p, item);
    if (!item.graduated) {
      await swap(p, item, "buy", "0.001");
      await swap(p, item, "sell", "100");
      await swap(p, item, "buy", "0.12");
      await graduate(p, item);
      await swap(p, item, "buy", "0.001", "damm_v2");
      item.graduated = true;
      save();
    }
  }
  record("core-lifecycles-completed");
  const reserve = evidence.launches.backed;
  if (!reserve.redeemed) {
    await p.goto(origin + reserve.token + "/reserve");
    await p.getByLabel("Donate WSOL").fill("0.001");
    await tx(p, p.getByRole("button", { name: "Donate ↗", exact: true }));
    await p.getByLabel("Tokens to burn").fill("1000");
    await p
      .getByRole("button", { name: "Get payout quote", exact: true })
      .click();
    await tx(p, p.getByRole("button", { name: /Confirm burn & payout/ }));
    reserve.redeemed = true;
    save();
    record("reserve-donation-and-redemption");
  }
  const funding = evidence.launches.funding;
  for (const approve of [true, false]) {
    for (let i = 0; i < 2; i++) {
      const stage = "review-" + approve + "-" + i;
      if (evidence.checkpoints.some((c) => c.stage === stage)) continue;
      const r = await actor(reviewers[i]);
      await r.goto(origin + funding.token + "/review");
      await tx(
        r,
        r.getByRole("button", {
          name: approve ? "Approve milestone" : "Reject milestone",
          exact: true,
        }),
      );
      record(stage);
      await r.context().close();
    }
  }
  if (!funding.refunded) {
    await p.goto(origin + funding.token + "/funding");
    await p.getByLabel("Tokens to burn").fill("1000");
    await p
      .getByRole("button", { name: "Get payout quote", exact: true })
      .click();
    await tx(p, p.getByRole("button", { name: /Confirm burn & payout/ }));
    funding.refunded = true;
    save();
    record("funding-refund");
  }
  for (const variant of ["funding_completed", "funding_expired"]) {
    if (evidence.checkpoints.some((c) => c.stage === variant)) continue;
    if (
      !evidence.checkpoints.some((c) => c.stage === "extended-funding-wrapped")
    ) {
      await p.goto(origin + "/portfolio");
      await p.getByLabel("SOL to wrap").fill("0.25");
      await tx(p, p.getByRole("button", { name: /Wrap SOL ↗/ }));
      record("extended-funding-wrapped");
    }
    const item = await launch(p, "funding", variant);
    if (!item.token) await ready(p, item);
    if (!item.graduated) {
      await swap(p, item, "buy", "0.12");
      await graduate(p, item);
      item.graduated = true;
      save();
    }
    if (variant === "funding_completed") {
      for (let i = 0; i < 2; i++) {
        const stage = variant + "-vote-" + i;
        if (evidence.checkpoints.some((c) => c.stage === stage)) continue;
        const r = await actor(reviewers[i]);
        await r.goto(origin + item.token + "/review");
        await tx(
          r,
          r.getByRole("button", { name: "Approve milestone", exact: true }),
        );
        record(stage);
        await r.context().close();
      }
      await p.goto(origin + item.token + "/funding");
      await expect(
        p.locator(".metric").filter({ hasText: "Module state" }),
      ).toContainText("Completed", { timeout: 25000 });
    } else {
      await p.goto(origin + item.token + "/funding");
      const expiry = p.getByRole("button", {
        name: "Mark expired milestone",
        exact: true,
      });
      await expect(expiry).toBeEnabled({ timeout: 60000 });
      await tx(p, expiry);
      await expect(
        p.locator(".metric").filter({ hasText: "Module state" }),
      ).toContainText("Refunding", { timeout: 25000 });
      await p.getByLabel("Tokens to burn").fill("1000");
      await p
        .getByRole("button", { name: "Get payout quote", exact: true })
        .click();
      await tx(p, p.getByRole("button", { name: /Confirm burn & payout/ }));
    }
    record(variant, { token: item.token });
  }
  latest = p;
  await require("./frontend-devnet-workspaces.cjs")({
    p,
    origin,
    evidence,
    record,
    tx,
    importEconomy,
    forkActor: () => actor(reviewers[2]),
  });
  if (
    !evidence.checkpoints.some(
      (c) => c.stage === "independent-holder-trading-and-redemption",
    )
  ) {
    const trader = key("trader");
    assert(
      (await rpc.getBalance(trader.publicKey)) > 30000000,
      "Independent devnet trader needs funding",
    );
    const t = await actor(trader);
    if (!evidence.checkpoints.some((c) => c.stage === "holder-wrapped")) {
      await t.goto(origin + "/portfolio");
      await t.getByLabel("SOL to wrap").fill("0.02");
      await tx(t, t.getByRole("button", { name: /Wrap SOL ↗/ }));
      record("holder-wrapped");
    }
    const item = evidence.launches.backed;
    if (!evidence.checkpoints.some((c) => c.stage === "holder-bought")) {
      await t.goto(origin + item.token);
      await t.getByLabel("You pay · WSOL").fill("0.001");
      await tx(
        t,
        t.getByRole("button", { name: new RegExp("^Buy " + item.symbol) }),
      );
      record("holder-bought");
    }
    if (!evidence.checkpoints.some((c) => c.stage === "holder-sold")) {
      await t.goto(origin + item.token);
      await t.getByRole("button", { name: "sell", exact: true }).click();
      await t.getByLabel("You sell · " + item.symbol).fill("100");
      await tx(
        t,
        t.getByRole("button", { name: new RegExp("^Sell " + item.symbol) }),
      );
      record("holder-sold");
    }
    if (!evidence.checkpoints.some((c) => c.stage === "holder-redeemed")) {
      await t.goto(origin + item.token + "/reserve");
      await t.getByLabel("Tokens to burn").fill("1000");
      await t
        .getByRole("button", { name: "Get payout quote", exact: true })
        .click();
      await tx(t, t.getByRole("button", { name: /Confirm burn & payout/ }));
      record("holder-redeemed");
    }
    await t.goto(origin + "/portfolio");
    await tx(
      t,
      t.getByRole("button", {
        name: "Unwrap entire WSOL account",
        exact: true,
      }),
    );
    record("independent-holder-trading-and-redemption", {
      wallet: trader.publicKey.toBase58(),
    });
    await t.context().close();
    latest = p;
  }
  for (const route of [
    "/",
    "/docs",
    "/explore",
    "/models",
    "/creator",
    "/authors",
    "/portfolio",
    "/earnings",
    "/activity",
    "/settings",
    "/research",
  ]) {
    await p.goto(origin + route);
    await p.locator("h1").first().waitFor();
    await sleep(1500);
    assert.deepEqual(await p.locator("p.error").allTextContents(), [], route);
    await p.screenshot({
      path: path.join(dir, route.replaceAll("/", "_") || "landing") + ".png",
      fullPage: true,
    });
    record("route-rendered", { route });
  }
  if (
    !evidence.checkpoints.some(
      (c) => c.stage === "wallet-transaction-rejection",
    )
  ) {
    await p.goto(origin + "/portfolio");
    await p.getByLabel("SOL to wrap").fill("0.001");
    await clean(p);
    const before = await rpc.getBalance(creator.publicKey);
    const count = evidence.transactions.length;
    await p.evaluate(() => {
      window.__rejectNextTransaction = true;
    });
    await p.getByRole("button", { name: /Wrap SOL ↗/ }).click();
    await expect(p.locator(".tx-toast strong")).toContainText("user rejected", {
      timeout: 30000,
    });
    assert.equal(await rpc.getBalance(creator.publicKey), before);
    assert.equal(evidence.transactions.length, count);
    record("wallet-transaction-rejection");
    await clean(p);
  }
  if (
    !evidence.checkpoints.some((c) => c.stage === "empty-wallet-swap-rejected")
  ) {
    const emptyFile = path.join(dir, "empty-wallet.json");
    if (!fs.existsSync(emptyFile))
      fs.writeFileSync(
        emptyFile,
        JSON.stringify([...Keypair.generate().secretKey]),
        { mode: 0o600 },
      );
    const empty = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(fs.readFileSync(emptyFile))),
    );
    assert.equal(await rpc.getBalance(empty.publicKey), 0);
    const emptyPage = await actor(empty);
    await emptyPage.goto(origin + evidence.launches.meme.token);
    await emptyPage.getByLabel("You pay · WSOL").fill("0.001");
    await emptyPage
      .getByRole("button", {
        name: new RegExp("^Buy " + evidence.launches.meme.symbol),
      })
      .click();
    await expect(emptyPage.locator("p.error")).toBeVisible({ timeout: 30000 });
    assert.equal(await emptyPage.locator(".tx-toast").count(), 0);
    record("empty-wallet-swap-rejected", {
      wallet: empty.publicKey.toBase58(),
      message: await emptyPage.locator("p.error").innerText(),
    });
    await emptyPage.context().close();
    latest = p;
  }
  for (const item of Object.values(evidence.launches)) {
    await p.goto(item.workflow);
    await p.locator(".workflow").waitFor();
    await p.screenshot({
      path: path.join(dir, item.symbol + "-workflow.png"),
      fullPage: true,
    });
  }
  const signatures = evidence.transactions.map((t) => t.signature);
  for (let i = 0; i < signatures.length; i += 20) {
    const s = await rpc.getSignatureStatuses(signatures.slice(i, i + 20), {
      searchTransactionHistory: true,
    });
    assert(
      s.value.every((x) => x && x.confirmationStatus === "finalized" && !x.err),
    );
  }
  record("independent-finality-verified", { transactions: signatures.length });
  if (evidence.last_failure) {
    evidence.resolved_failures ||= [];
    evidence.resolved_failures.push(evidence.last_failure);
    delete evidence.last_failure;
  }
  assert.deepEqual(evidence.errors, [], "Browser runtime errors were observed");
  evidence.coverage = [
    ["Wallet authentication", "wallet-authenticated"],
    ["SOL wrapping", "wrapped"],
    ["Core DBC/DAMM lifecycles", "core-lifecycles-completed"],
    ["Reserve donation and redemption", "reserve-donation-and-redemption"],
    ["Milestone approval and rejection", "review-false-1"],
    ["Funding refund", "funding-refund"],
    ["Fully approved funding", "funding_completed"],
    ["Expired milestone and refund", "funding_expired"],
    ["Fee sweeps and claims", "fees-swept-and-claimed"],
    [
      "Studio publication, registration, fork, import/export",
      "studio-model-published-forked-imported",
    ],
    [
      "Cross-wallet author preservation",
      "cross-wallet-author-attribution-preserved",
    ],
    ["Simulation Lab and research export", "research-scenarios-and-export"],
    [
      "Search, pagination, receipts and mobile",
      "search-pagination-receipts-mobile",
    ],
    [
      "Landing and documentation interactions",
      "landing-and-documentation-interactions",
    ],
    ["SOL unwrapping and reconnect", "unwrap-and-reconnect"],
    [
      "Validation and unauthorized reviewer guards",
      "invalid-import-identity-and-reviewer-guards",
    ],
    ["Unsupported asset adapter guard", "asset-quote-research-only-guard"],
    ["Unfunded real wallet rejection", "empty-wallet-swap-rejected"],
    ["Wallet transaction rejection", "wallet-transaction-rejection"],
    ["Research cancellation", "research-job-cancellation"],
    [
      "Research cancellation completion race",
      "research-cancel-completion-race",
    ],
    ["Portfolio mint clipboard", "portfolio-mint-clipboard"],
    ["Creator draft navigation", "creator-draft-navigation"],
    ["All mobile routes", "mobile-route-coverage"],
    [
      "Independent holder trading and redemption",
      "independent-holder-trading-and-redemption",
    ],
  ].map(([feature, stage]) => ({
    feature,
    status: evidence.checkpoints.some((c) => c.stage === stage)
      ? "passed"
      : "not_run",
  }));
  assert(
    evidence.coverage.every((c) => c.status === "passed"),
    "Required UI coverage is incomplete",
  );
  evidence.not_exercised = [
    "Phantom/Solflare extension prompts and hardware wallets",
    "Browser extension rejection prompts (adapter rejection tested)",
    "Worker interruption recovery",
    "Mainnet, asset-quote execution, historical market parity, sustained load and external security certification",
    "External metadata hosting and artwork validation",
  ];
  evidence.production_certified = false;
  evidence.e2e_accepted = true;
  evidence.completed_at = new Date().toISOString();
  save();
})()
  .catch(async (e) => {
    console.error(e.message.slice(0, 4000));
    evidence.e2e_accepted = false;
    evidence.last_failure = {
      message: e.message.slice(0, 4000),
      at: new Date().toISOString(),
      url: latest?.url(),
    };
    save();
    if (latest)
      await latest
        .screenshot({ path: path.join(dir, "failure.png"), fullPage: true })
        .catch(() => {});
    process.exitCode = 1;
  })
  .finally(async () => {
    if (browser) await browser.close();
  });
