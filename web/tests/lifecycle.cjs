// Real browser + Rust API + PostgreSQL + localnet/devnet acceptance. Keys stay in Node.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { chromium } = require("@playwright/test");
const { Keypair, Connection, Transaction } = require("@solana/web3.js");
const bs58 = require("bs58").default;
const root = path.resolve(__dirname, "../..");
const saved = Object.fromEntries(
  fs
    .readFileSync(path.join(root, ".local/backend.env"), "utf8")
    .split("\n")
    .filter((v) => v && !v.startsWith("#") && v.includes("="))
    .map((v) => {
      const i = v.indexOf("=");
      return [v.slice(0, i), v.slice(i + 1).replace(/^['"]|['"]$/g, "")];
    }),
);
const devnet = process.env.DEPTHGUARD_ACCEPTANCE_CLUSTER === "devnet";
assert(
  !process.env.DEPTHGUARD_ACCEPTANCE_CLUSTER ||
    ["localnet", "devnet"].includes(process.env.DEPTHGUARD_ACCEPTANCE_CLUSTER),
);
const rpcUrl = devnet
  ? process.env.DEVNET_RPC_FILE
    ? fs.readFileSync(process.env.DEVNET_RPC_FILE, "utf8").trim()
    : process.env.DEVNET_RPC_URL || "https://api.devnet.solana.com"
  : "http://127.0.0.1:18999";
const apiPort = devnet ? 8812 : 8811;
const webPort = devnet ? 5176 : 5175;
const name = devnet
  ? "depthguard_devnet"
  : "depthguard_web_" + crypto.randomBytes(6).toString("hex");
const dir = path.join(
  root,
  devnet ? ".local/devnet/acceptance" : ".local/web-acceptance",
);
fs.mkdirSync(dir, { recursive: true });
const log = fs.openSync(path.join(dir, "services.log"), "w");
const admin = {
  ...process.env,
  PGHOST: "127.0.0.1",
  PGPORT: saved.POSTGRES_PORT || "55439",
  PGUSER: "depthguard",
  PGPASSWORD: saved.POSTGRES_PASSWORD,
  PGDATABASE: "depthguard",
};
function command(bin, args, env = admin) {
  const r = spawnSync(bin, args, { env, encoding: "utf8" });
  assert.equal(r.status, 0, `${bin} failed`);
  return r.stdout;
}
const services = [];
let browser;
let latestPage;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const origin = `http://127.0.0.1:${webPort}`;
const evidenceFile = path.join(
  root,
  `web/tests/evidence/${devnet ? "devnet-lifecycle" : "lifecycle"}.json`,
);
const resumeExtra =
  devnet && process.env.DEPTHGUARD_ACCEPTANCE_MODE === "devnet-extra";
const priorEvidence = resumeExtra
  ? JSON.parse(fs.readFileSync(evidenceFile))
  : null;
if (resumeExtra)
  assert(
    priorEvidence.network === "devnet" &&
      priorEvidence.checkpoints.some((c) => c.stage === "meme-graduated") &&
      priorEvidence.checkpoints.some(
        (c) => c.stage === "reserve-redemption-accounting",
      ),
    "Earlier core devnet evidence is required for resuming extra scenarios",
  );
const evidence = {
  network: devnet ? "devnet" : "localnet",
  e2e_accepted: false,
  production_certified: false,
  recorded_at: new Date().toISOString(),
  checkpoints: [],
};
function checkpoint(stage, data = {}) {
  evidence.checkpoints.push({
    stage,
    ...data,
    recorded_at: new Date().toISOString(),
  });
  fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
  if (process.env.DEPTHGUARD_ACCEPTANCE_MODE !== "model-transfer")
    fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2) + "\n");
  console.log(`Acceptance: ${stage}`);
}
let worker;
let serviceEnv;
const interval = devnet ? 2000 : 500;
let duplicateSubmitChecked = false;
(async () => {
  const connection = devnet
    ? require("../../contracts/scripts/devnet-rpc.cjs").connect()
    : new Connection(rpcUrl, "confirmed");
  const genesis = await connection.getGenesisHash();
  if (devnet) {
    assert.equal(genesis, "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG");
    const deployment = JSON.parse(
      fs.readFileSync(
        path.join(root, "contracts/tests/evidence/devnet-deployment.json"),
      ),
    );
    assert(
      deployment.deployment_verified && deployment.platform?.initialized,
      "Deploy and initialize the devnet release first",
    );
    evidence.release_programs = deployment.programs.map(
      ({ address, sha256 }) => ({ address, sha256 }),
    );
    const exists = command("psql", [
      "-At",
      "-c",
      `SELECT 1 FROM pg_database WHERE datname='${name}'`,
    ]).trim();
    if (!exists) command("createdb", [name]);
  } else {
    assert(
      ![
        "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
        "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
      ].includes(genesis),
    );
    command("createdb", [name]);
  }
  const encryptionFile = path.join(root, ".local/devnet/encryption-key");
  if (devnet && !fs.existsSync(encryptionFile))
    fs.writeFileSync(encryptionFile, crypto.randomBytes(32).toString("hex"), {
      mode: 0o600,
    });
  const db = new URL(`postgres://127.0.0.1:${admin.PGPORT}/${name}`);
  db.username = "depthguard";
  db.password = saved.POSTGRES_PASSWORD;
  const env = {
    ...process.env,
    DATABASE_URL: db.toString(),
    APP_ORIGIN: origin,
    BIND_ADDRESS: `127.0.0.1:${apiPort}`,
    SOLANA_CLUSTER: devnet ? "devnet" : "localnet",
    SOLANA_RPC_URLS:
      devnet && rpcUrl !== "https://api.devnet.solana.com"
        ? `${rpcUrl},https://api.devnet.solana.com`
        : rpcUrl,
    ENABLE_CONTRACTS: "true",
    ENABLE_CHAIN_WRITES: "true",
    KEY_ENCRYPTION_KEY: devnet
      ? fs.readFileSync(encryptionFile, "utf8").trim()
      : crypto.randomBytes(32).toString("hex"),
    ARTIFACTS_DIR: path.join(dir, "artifacts"),
    NATIVE_HELPER_PATH: path.join(
      root,
      "backend/native/target/debug/depthguard-native",
    ),
  };
  command(
    path.join(root, "backend/target/debug/depthguard-api"),
    ["migrate"],
    env,
  );
  db.username = "depthguard_app";
  db.password = saved.APP_DB_PASSWORD;
  env.DATABASE_URL = db.toString();
  serviceEnv = env;
  for (const bin of ["depthguard-api", "depthguard-worker"]) {
    const child = spawn(path.join(root, "backend/target/debug", bin), [], {
      env,
      stdio: ["ignore", log, log],
    });
    services.push(child);
    if (bin === "depthguard-worker") worker = child;
  }
  if (devnet)
    fs.writeFileSync(
      path.join(root, ".local/devnet/runtime-env.json"),
      JSON.stringify(env),
      { mode: 0o600 },
    );
  services.push(
    spawn(
      path.join(root, "node_modules/.bin/vite"),
      ["--config", "web/vite.config.mjs"],
      {
        cwd: root,
        env: {
          ...process.env,
          DEPTHGUARD_API_PORT: String(apiPort),
          DEPTHGUARD_WEB_PORT: String(webPort),
        },
        stdio: ["ignore", log, log],
      },
    ),
  );
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(origin + "/api/v1/capabilities")).ok) break;
    } catch {}
    await sleep(200);
  }
  const key = devnet
    ? Keypair.fromSecretKey(
        Uint8Array.from(
          JSON.parse(
            fs.readFileSync(path.join(root, ".local/devnet/keys/creator.json")),
          ),
        ),
      )
    : Keypair.generate();
  if (devnet) {
    assert(
      (await connection.getBalance(key.publicKey)) >=
        (resumeExtra ? 30_000_000 : 1_000_000_000),
      "Devnet creator has insufficient fixture funding",
    );
    evidence.wallet = key.publicKey.toBase58();
    evidence.wallet_balance_before_sol =
      (await connection.getBalance(key.publicKey)) / 1e9;
  } else {
    const sig = await connection.requestAirdrop(key.publicKey, 100000000000);
    await connection.confirmTransaction(sig, "confirmed");
  }
  checkpoint("services-ready");
  browser = await chromium.launch({
    executablePath: "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  latestPage = page;
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const privateKey = crypto.createPrivateKey({
    format: "der",
    type: "pkcs8",
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      Buffer.from(key.secretKey.slice(0, 32)),
    ]),
  });
  await page.exposeFunction("__signMessageForAcceptance", (arr) => [
    ...crypto.sign(null, Buffer.from(arr), privateKey),
  ]);
  await page.exposeFunction("__signTransactionForAcceptance", (arr) => {
    const tx = Transaction.from(Buffer.from(arr));
    tx.partialSign(key);
    return [...tx.serialize()];
  });
  await page.addInitScript(
    ({ address, pubkey }) => {
      const account = {
        address,
        publicKey: new Uint8Array(pubkey),
        chains: ["solana:localnet", "solana:devnet"],
        features: ["solana:signMessage", "solana:signTransaction"],
      };
      const wallet = {
        version: "1.0.0",
        name: "Acceptance Wallet",
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
                  await window.__signMessageForAcceptance([...message]),
                ),
              },
            ],
          },
          "solana:signTransaction": {
            version: "1.0.0",
            supportedTransactionVersions: ["legacy", 0],
            signTransaction: async ({ transaction }) => [
              {
                signedTransaction: new Uint8Array(
                  await window.__signTransactionForAcceptance([...transaction]),
                ),
              },
            ],
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
    { address: key.publicKey.toBase58(), pubkey: [...key.publicKey.toBytes()] },
  );
  async function call(route, body, method) {
    return page.evaluate(
      async ({ route, body, method }) => {
        for (let attempt = 0; attempt < 4; attempt++) {
          const r = await fetch("/api/v1" + route, {
            method: method || (body === undefined ? "GET" : "POST"),
            headers: {
              "Content-Type": "application/json",
              "X-CSRF-Token": sessionStorage.getItem("depthguard.csrf") || "",
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          });
          const v = await r.json();
          if (r.status === 503 && attempt < 3) {
            await new Promise((resolve) =>
              setTimeout(resolve, 1000 * 2 ** attempt),
            );
            continue;
          }
          if (!r.ok) throw Error(`${r.status} ${JSON.stringify(v)}`);
          return v;
        }
        throw Error("API availability retry exhausted");
      },
      { route, body, method },
    );
  }
  async function clickSwap(label) {
    const pending = page.waitForResponse(
      (r) => r.url().endsWith("/api/v1/swaps/prepare"),
      { timeout: 30000 },
    );
    await page.getByRole("button", { name: label }).click();
    const response = await pending;
    const prepared = await response.json();
    assert(response.ok(), JSON.stringify(prepared));
    for (let n = 0; n < 150; n++) {
      const receipt = await call(`/transactions/${prepared.id}`);
      if (receipt.state === "finalized") return receipt;
      if (["failed", "expired", "verification_failed"].includes(receipt.state))
        throw Error(receipt.state);
      await sleep(interval);
    }
    throw Error("Swap finality deadline");
  }
  async function signPrepared(p, signer = key) {
    if (p.state === "complete") return;
    if (p.state === "prepared") {
      const wire = Transaction.from(Buffer.from(p.transaction, "base64"));
      wire.partialSign(signer);
      const payload = { transaction: wire.serialize().toString("base64") };
      const submitted = await call(`/transactions/${p.id}/submit`, payload);
      if (devnet && !duplicateSubmitChecked) {
        const repeated = await call(`/transactions/${p.id}/submit`, payload);
        assert.equal(repeated.signature, submitted.signature);
        duplicateSubmitChecked = true;
        checkpoint("duplicate-submit-idempotent", {
          signature: submitted.signature,
        });
      }
    }
    for (let n = 0; n < 220; n++) {
      const r = await call(`/transactions/${p.id}`);
      if (r.state === "finalized") return r;
      if (["failed", "expired", "verification_failed"].includes(r.state))
        throw Error(`${p.step || p.id}: ${r.state}`);
      await sleep(interval);
    }
    throw Error("Finality deadline");
  }
  async function finish(route) {
    for (let n = 0; n < 20; n++) {
      const p = await call(route, {});
      if (p.state === "complete") return;
      await signPrepared(p);
    }
    throw Error("Workflow did not complete");
  }
  await page.goto(origin + "/explore");
  await page.getByRole("heading", { name: "More than a token." }).waitFor();
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await page.getByRole("button", { name: "Acceptance Wallet" }).click();
  await page.getByRole("button", { name: "Authenticate", exact: true }).click();
  await page
    .getByRole("button", { name: "Authenticated", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Close wallet chooser" }).click();
  if (process.env.DEPTHGUARD_ACCEPTANCE_MODE === "model-transfer") {
    require("ts-node").register({
      transpileOnly: true,
      compilerOptions: { module: "CommonJS" },
    });
    const initialEconomy = require("../src/app/economy.ts").initialEconomy;
    const author = Keypair.generate();
    let cookie = "",
      csrf = "";
    async function authorCall(route, body) {
      const r = await fetch(`http://127.0.0.1:${apiPort}/api/v1` + route, {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          Cookie: cookie,
          "X-CSRF-Token": csrf,
        },
        body: JSON.stringify(body),
      });
      const value = await r.json();
      assert(r.ok, JSON.stringify(value));
      if (r.headers.get("set-cookie"))
        cookie = r.headers.get("set-cookie").split(";")[0];
      return value;
    }
    const challenge = await authorCall("/auth/challenges", {
      wallet: author.publicKey.toBase58(),
    });
    const signingKey = crypto.createPrivateKey({
      format: "der",
      type: "pkcs8",
      key: Buffer.concat([
        Buffer.from("302e020100300506032b657004220420", "hex"),
        Buffer.from(author.secretKey.slice(0, 32)),
      ]),
    });
    csrf = (
      await authorCall("/auth/verify", {
        id: challenge.id,
        signature: bs58.encode(
          crypto.sign(null, Buffer.from(challenge.message), signingKey),
        ),
      })
    ).csrf_token;
    const model = await authorCall("/models", {
      name: "Transfer acceptance",
      economy: initialEconomy(author.publicKey.toBase58()),
    });
    const version = await authorCall(`/models/${model.id}/publish`, {});
    await page.goto(origin + "/models/" + version.id);
    const downloaded = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Export JSON", exact: false })
      .click();
    const exportFile = await downloaded;
    const payload = JSON.parse(
      fs.readFileSync(await exportFile.path(), "utf8"),
    );
    assert.equal(payload.format, "depthguard.model.v1");
    assert.equal(payload.version_id, version.id);
    await page.goto(origin + "/studio");
    await page.locator("input[type=file]").setInputFiles({
      name: "economy.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(payload)),
    });
    await page.getByText("Validation result", { exact: true }).waitFor();
    const draft = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("depthguard.draft.v2")),
    );
    assert.equal(draft.economy.fee_policy.author, author.publicKey.toBase58());
    assert(draft.modelId);
    assert.notEqual(draft.modelId, model.id);
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await page.getByText("Draft saved", { exact: true }).waitFor();
    const tampered = structuredClone(payload);
    tampered.economy.fee_policy.author = key.publicKey.toBase58();
    await page.locator("input[type=file]").setInputFiles({
      name: "tampered.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(tampered)),
    });
    await page
      .getByText("The imported file does not match the published economy.", {
        exact: false,
      })
      .waitFor();
    const after = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("depthguard.draft.v2")),
    );
    assert.equal(after.modelId, draft.modelId);
    const evidence = {
      real_browser: true,
      real_rust_api: true,
      real_postgres: true,
      published_export_roundtrip: true,
      original_author_preserved: true,
      tampered_import_rejected: true,
      writes_to_chain: false,
      recorded_at: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(root, "web/tests/evidence/model-transfer.json"),
      JSON.stringify(evidence, null, 2) + "\n",
    );
    console.log(JSON.stringify(evidence));
    return;
  }
  let launchId, tokenAddress, launch;
  let mechanismEvidence = [],
    cases = [];
  if (!resumeExtra) {
    // Route and responsive acceptance against actual API empty states.
    for (const route of [
      "/models",
      "/studio",
      "/research",
      "/creator",
      "/authors",
      "/portfolio",
      "/earnings",
      "/activity",
      "/settings",
    ]) {
      await page.goto(origin + route);
      await page.locator("h1").waitFor();
      assert.equal(await page.locator(".error").count(), 0, route);
    }
    if (devnet) {
      require("ts-node").register({ transpileOnly: true });
      const dbc = require("@meteora-ag/dynamic-bonding-curve-sdk");
      const { common } = require("../../packages/engine/src/curves.ts");
      const curve = dbc.buildCurve({
        ...common(),
        percentageSupplyOnMigration: 20,
        migrationQuoteThreshold: 0.1,
      });
      const economy = require("../src/app/economy.ts").initialEconomy(
        key.publicKey.toBase58(),
      );
      economy.sqrt_start_price = curve.sqrtStartPrice.toString();
      economy.curve = curve.curve.map((p) => ({
        sqrt_price: p.sqrtPrice.toString(),
        liquidity: p.liquidity.toString(),
      }));
      economy.migration_quote_threshold =
        curve.migrationQuoteThreshold.toString();
      await page.evaluate(
        (economy) =>
          localStorage.setItem(
            "depthguard.draft.v2",
            JSON.stringify({
              name: "",
              symbol: "",
              uri: "",
              modelName: "Devnet acceptance",
              economy,
              reviewers: [],
              launchKey: crypto.randomUUID(),
            }),
          ),
        economy,
      );
      await page.reload();
      evidence.fixture_graduation_sol = 0.1;
    }
    launchId = devnet ? process.env.DEPTHGUARD_DEVNET_RESUME_LAUNCH : undefined;
    if (launchId) {
      assert(/^[a-f0-9-]{36}$/.test(launchId));
      await page.goto(origin + "/creator/launches/" + launchId);
    } else {
      await page.goto(origin + "/create/identity");
      await page
        .getByLabel("Token name", { exact: true })
        .fill("Browser Economy");
      await page.getByLabel("Symbol", { exact: true }).fill("BROWSE");
      await page
        .getByLabel("Metadata URI", { exact: true })
        .fill("https://example.com/browser.json");
      await page.getByRole("button", { name: "Continue" }).click();
      await page.getByRole("link", { name: "Continue" }).click();
      await page.getByRole("link", { name: "Simulate economy" }).click();
      await page.getByRole("link", { name: "Review launch" }).click();
      await page
        .getByRole("button", { name: "Create launch workflow" })
        .click();
      await page.waitForURL(/creator\/launches\//);
      launchId = page.url().split("/").at(-1);
    }
    checkpoint("launch-workflow-created", { launch_id: launchId });
    for (let i = 0; i < 20; i++) {
      const next = page.getByRole("button", {
        name: "Continue signing workflow",
      });
      if (
        await page
          .getByRole("button", { name: "Launch ready", exact: true })
          .count()
      )
        break;
      await next.click();
      await page.waitForFunction(
        () =>
          !document.querySelector(".primary[disabled]") ||
          document.querySelector(".error"),
        undefined,
        { timeout: 110000 },
      );
      if (await page.locator(".error").count())
        throw Error(await page.locator(".error").allTextContents());
      launch = await call(`/factory/launches/${launchId}`);
      if (
        launch.transactions.length === launch.steps.length &&
        launch.transactions.every((t) => t.state === "finalized")
      ) {
        await next.click();
        break;
      }
    }
    launch = await call(`/factory/launches/${launchId}`);
    assert(launch.transactions.every((t) => t.state === "finalized"));
    await page.goto(origin + "/portfolio");
    await page.getByLabel("SOL to wrap").fill(devnet ? "0.25" : "12");
    await page.getByRole("button", { name: "Wrap SOL", exact: false }).click();
    await page.waitForFunction(
      () =>
        document.querySelector(".tx-toast strong")?.textContent === "finalized",
      undefined,
      { timeout: 110000 },
    );
    tokenAddress = launch.accounts.launch;
    await page.goto(origin + "/tokens/" + tokenAddress);
    await page.getByLabel("You pay · WSOL").fill(devnet ? "0.001" : "0.1");
    await clickSwap("Buy BROWSE");
    // Saved drafts and receipts survive browser reload; authenticate again through the wallet.
    await page.reload();
    await page.getByRole("heading", { name: "Browser Economy" }).waitFor();
    await page.getByRole("button", { name: "sell", exact: true }).click();
    await page.getByLabel("You sell · BROWSE").fill("100");
    await clickSwap("Sell BROWSE");
    if (await page.locator(".tx-toast button").count())
      await page.locator(".tx-toast button").click();
    await page.getByRole("button", { name: "buy", exact: true }).click();
    await page.getByLabel("You pay · WSOL").fill(devnet ? "0.12" : "6");
    await clickSwap("Buy BROWSE");
    await page.goto(origin + "/creator/launches/" + launchId);
    await finish(`/factory/launches/${launchId}/graduate`);
    const migrated = await call("/tokens/" + tokenAddress);
    assert.equal(migrated.state.phase, 3);
    assert.equal(migrated.protocol, "damm_v2");
    checkpoint("meme-graduated", {
      launch_id: launchId,
      launch_address: tokenAddress,
    });
    await page.goto(origin + "/tokens/" + tokenAddress);
    await page.getByRole("heading", { name: "Browser Economy" }).waitFor();
    await page.getByLabel("You pay · WSOL").fill("0.01");
    await clickSwap("Buy BROWSE");
    await page.screenshot({
      path: path.join(dir, "trade-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: path.join(dir, "trade-mobile.png"),
      fullPage: true,
    });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      "Mobile horizontal overflow",
    );
    const models = await call("/me/models");
    const original = await call("/models/" + models.items[0].id);
    await signPrepared(
      await call("/contracts/prepare", {
        action: "wrap_sol",
        accounts: { launcher: key.publicKey.toBase58() },
        args: { amount: devnet ? "300000000" : "12000000000" },
      }),
    );
    mechanismEvidence = [];
    cases = [];
    for (const mechanism of ["backed", "funding"]) {
      cases.push(
        await (async () => {
          const economy = structuredClone(original.economy);
          economy.mechanism = mechanism;
          economy.migration_fee_pct = 20;
          economy.module =
            mechanism === "funding"
              ? {
                  reviewer_threshold: 2,
                  milestones: [
                    { weight_bps: 5000, deadline_offset: "2592000" },
                    { weight_bps: 5000, deadline_offset: "5184000" },
                  ],
                }
              : { reviewer_threshold: 0, milestones: [] };
          const model = await call("/models", {
            name: `Acceptance ${mechanism}`,
            economy,
          });
          const version = await call(`/models/${model.id}/publish`, {});
          // Publish independently of a token launch, then reuse the sealed on-chain model.
          await finish(`/factory/models/${version.id}/next`);
          const reviewers =
            mechanism === "funding"
              ? devnet
                ? [1, 2, 3].map((i) =>
                    Keypair.fromSecretKey(
                      Uint8Array.from(
                        JSON.parse(
                          fs.readFileSync(
                            path.join(
                              root,
                              `.local/devnet/keys/reviewer-${i}.json`,
                            ),
                          ),
                        ),
                      ),
                    ),
                  )
                : [Keypair.generate(), Keypair.generate(), Keypair.generate()]
              : [];
          const created = await page.evaluate(
            async (input) => {
              const r = await fetch("/api/v1/factory/launches", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "X-CSRF-Token": sessionStorage.getItem("depthguard.csrf"),
                  "Idempotency-Key": crypto.randomUUID(),
                },
                body: JSON.stringify(input),
              });
              const v = await r.json();
              if (!r.ok) throw Error(JSON.stringify(v));
              return v;
            },
            {
              model_version_id: version.id,
              name: `Acceptance ${mechanism}`,
              symbol: mechanism === "backed" ? "BACK" : "FUND",
              uri: "https://example.com/acceptance.json",
              reviewers: reviewers.map((k) => k.publicKey.toBase58()),
            },
          );
          await finish(`/factory/launches/${created.id}/next`);
          const detail = await call(`/factory/launches/${created.id}`);
          await signPrepared(
            await call("/swaps/prepare", {
              protocol: "dbc",
              pool: detail.accounts.pool,
              amount: devnet ? "120000000" : "6000000000",
              base_for_quote: false,
              mode: "partial_fill",
              slippage_bps: 100,
            }),
          );
          await finish(`/factory/launches/${created.id}/graduate`);
          const active = await call("/tokens/" + detail.accounts.launch);
          assert.equal(active.state.phase, 4);
          return { mechanism, detail, active, reviewers };
        })(),
      );
    }
    for (const { mechanism, detail, active, reviewers } of cases) {
      const rights = mechanism === "backed" ? "reserve" : "funding";
      await page.goto(
        origin + "/tokens/" + detail.accounts.launch + "/" + rights,
      );
      await page.locator("h1").waitFor();
      await page
        .getByText("Immutable terms, votes and account state")
        .waitFor();
      assert.equal(await page.locator(".error").count(), 0);
      if (mechanism === "backed") {
        let reserveBefore, supplyBefore;
        if (devnet) {
          const { PublicKey } = require("@solana/web3.js");
          reserveBefore = BigInt(
            (
              await connection.getTokenAccountBalance(
                new PublicKey(detail.accounts.token_vault),
                "finalized",
              )
            ).value.amount,
          );
          supplyBefore = BigInt(
            (
              await connection.getTokenSupply(
                new PublicKey(detail.accounts.base_mint),
                "finalized",
              )
            ).value.amount,
          );
        }
        await page.getByLabel("Tokens to burn").fill("100");
        await page.getByRole("button", { name: "Get payout quote" }).click();
        await page.getByText("Quoted payout", { exact: true }).waitFor();
        const redemptionPending = page.waitForResponse((r) =>
          r.url().endsWith("/api/v1/contracts/prepare"),
        );
        await page
          .getByRole("button", { name: "Confirm burn & payout", exact: false })
          .click();
        const redemption = await (await redemptionPending).json();
        let finalized = false;
        for (let n = 0; n < 220; n++) {
          const r = await call("/transactions/" + redemption.id);
          if (r.state === "finalized") {
            finalized = true;
            break;
          }
          if (["failed", "expired", "verification_failed"].includes(r.state))
            throw Error("Reserve redemption failed");
          await sleep(interval);
        }
        assert(finalized, "Reserve redemption finality");
        if (devnet) {
          const { PublicKey } = require("@solana/web3.js");
          const supplyAfter = BigInt(
            (
              await connection.getTokenSupply(
                new PublicKey(detail.accounts.base_mint),
                "finalized",
              )
            ).value.amount,
          );
          const reserveAfter = BigInt(
            (
              await connection.getTokenAccountBalance(
                new PublicKey(detail.accounts.token_vault),
                "finalized",
              )
            ).value.amount,
          );
          assert.equal(supplyBefore - supplyAfter, 100_000_000n);
          assert.equal(
            reserveBefore - reserveAfter,
            (reserveBefore * 100_000_000n) / supplyBefore,
          );
          checkpoint("reserve-redemption-accounting", {
            burned_atomic: "100000000",
            payout_lamports: (reserveBefore - reserveAfter).toString(),
          });
        }
      }
      mechanismEvidence.push({
        mechanism,
        launch: detail.accounts.launch,
        phase: active.state.phase,
        standalone_model_registered: true,
        rights_browser_verified: true,
      });
    }
  } else {
    const newCheckpoints = evidence.checkpoints;
    Object.assign(evidence, priorEvidence);
    evidence.checkpoints = [
      ...priorEvidence.checkpoints.filter((c) => c.stage !== "failed"),
      ...newCheckpoints,
    ];
    evidence.e2e_accepted = false;
    const memeCheckpoint = priorEvidence.checkpoints.find(
      (c) => c.stage === "meme-graduated",
    );
    launchId = memeCheckpoint.launch_id;
    tokenAddress = memeCheckpoint.launch_address;
    launch = await call(`/factory/launches/${launchId}`);
    assert.equal((await call(`/tokens/${tokenAddress}`)).state.phase, 3);
    const existing = await call("/me/launches?limit=100");
    for (const mechanism of ["backed", "funding"]) {
      const item = existing.items.find(
        (item) => item.metadata.mechanism === mechanism,
      );
      assert(item, `Missing ${mechanism} acceptance launch`);
      const detail = await call(`/factory/launches/${item.id}`);
      const active = await call(`/tokens/${detail.accounts.launch}`);
      assert.equal(active.state.phase, 4);
      const reviewers =
        mechanism === "funding"
          ? [1, 2, 3].map((i) =>
              Keypair.fromSecretKey(
                Uint8Array.from(
                  JSON.parse(
                    fs.readFileSync(
                      path.join(root, `.local/devnet/keys/reviewer-${i}.json`),
                    ),
                  ),
                ),
              ),
            )
          : [];
      cases.push({ mechanism, detail, active, reviewers });
      await page.goto(
        origin +
          `/tokens/${detail.accounts.launch}/${mechanism === "backed" ? "reserve" : "funding"}`,
      );
      await page
        .getByText("Immutable terms, votes and account state")
        .waitFor();
      assert.equal(await page.locator(".error").count(), 0);
      mechanismEvidence.push({
        mechanism,
        launch: detail.accounts.launch,
        phase: active.state.phase,
        standalone_model_registered: true,
        rights_browser_verified: true,
      });
    }
    checkpoint("extra-scenarios-resumed");
  }
  if (devnet) {
    evidence.extra = await require("./devnet-actions.cjs")({
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
    });
    worker.kill("SIGTERM");
    await new Promise((resolve) => worker.once("exit", resolve));
    worker = spawn(
      path.join(root, "backend/target/debug/depthguard-worker"),
      [],
      { env: serviceEnv, stdio: ["ignore", log, log] },
    );
    services.push(worker);
    await sleep(3000);
    assert.equal(
      (await call(`/factory/launches/${launchId}`)).accounts.launch,
      tokenAddress,
    );
    checkpoint("worker-restart-state-preserved");
  }
  assert.equal(errors.length, 0, errors.join("\n"));
  const activity = { items: [] };
  let offset = 0;
  while (true) {
    const pageOfActivity = await call(
      `/me/activity?limit=100&offset=${offset}`,
    );
    activity.items.push(...pageOfActivity.items);
    if (pageOfActivity.next_offset == null) break;
    offset = pageOfActivity.next_offset;
  }
  Object.assign(evidence, {
    network: devnet ? "devnet" : "localnet",
    e2e_accepted: true,
    real_browser: true,
    real_rust_api: true,
    real_postgres: true,
    real_validator: true,
    graduation_verified: true,
    mechanisms: mechanismEvidence,
    launch_id: launchId,
    launch_address: tokenAddress,
    finalized_transactions: activity.items.filter(
      (v) => v.state === "finalized",
    ).length,
    browser_errors: errors,
    responsive_overflow: false,
    recorded_at: new Date().toISOString(),
    production_certified: false,
  });
  if (devnet) {
    evidence.wallet_balance_after_sol =
      (await connection.getBalance(key.publicKey)) / 1e9;
    evidence.transactions = activity.items.filter(
      (v) => v.state === "finalized",
    );
  }
  fs.mkdirSync(path.join(root, "web/tests/evidence"), { recursive: true });
  fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence));
})()
  .catch(async (e) => {
    checkpoint("failed", { error: e.message });
    console.error(e.message);
    if (latestPage) {
      console.error("Page:", latestPage.url());
      console.error(
        "UI errors:",
        await latestPage.locator(".error").allTextContents(),
      );
      await latestPage
        .screenshot({ path: path.join(dir, "failure.png"), fullPage: true })
        .catch(() => {});
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    await browser?.close();
    for (const p of services) p.kill("SIGTERM");
    await sleep(1000);
    for (const p of services) if (p.exitCode == null) p.kill("SIGKILL");
    if (!devnet) command("dropdb", ["--force", name]);
    fs.closeSync(log);
  });
