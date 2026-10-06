// Real HTTP API and worker acceptance against the persistent Rust SBF test runtime.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const bs58 = require("bs58").default;
const { Transaction } = require("@solana/web3.js");
module.exports = async function (vm, fixture, root) {
  assert(
    process.env.DATABASE_URL,
    "DATABASE_URL is required for HTTP contract acceptance",
  );
  const database =
    "depthguard_contract_e2e_" + crypto.randomBytes(8).toString("hex");
  const url = new URL(process.env.DATABASE_URL);
  const pg = {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: database,
  };
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "depthguard-contract-http-"),
  );
  const history = new Map();
  let rpc, api, worker;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const command = (name, args) => {
    const p = spawnSync(name, args, { env: pg, encoding: "utf8" });
    assert.equal(p.status, 0, name + " failed");
    return p.stdout;
  };
  command("createdb", [database]);
  url.pathname = "/" + database;
  try {
    const account = (address) => {
      const a = vm.svm.getAccount(
        new (require("@solana/web3.js").PublicKey)(address),
      );
      return a
        ? {
            data: [Buffer.from(a.data).toString("base64"), "base64"],
            owner: a.owner.toBase58(),
            lamports: a.lamports,
            executable: a.executable,
          }
        : null;
    };
    rpc = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      const r = JSON.parse(body),
        p = r.params || [];
      let result;
      try {
        switch (r.method) {
          case "getGenesisHash":
            result = "11111111111111111111111111111111";
            break;
          case "getAccountInfo":
            result = { context: { slot: 100 }, value: account(p[0]) };
            break;
          case "getMultipleAccounts":
            result = { context: { slot: 100 }, value: p[0].map(account) };
            break;
          case "getLatestBlockhash":
            result = {
              context: { slot: 100 },
              value: {
                blockhash: vm.svm.latestBlockhash(),
                lastValidBlockHeight: 10000,
              },
            };
            break;
          case "getBlockHeight":
            result = 100;
            break;
          case "simulateTransaction": {
            const wire = Buffer.from(p[0], "base64"),
              t = Transaction.from(wire);
            t.serialize = () => wire;
            vm.svm.withSigverify(Boolean(p[1].sigVerify));
            try {
              vm.svm.simulateTransaction(t);
              result = { context: { slot: 100 }, value: { err: null } };
            } catch (e) {
              result = {
                context: { slot: 100 },
                value: { err: { local_error: String(e) } },
              };
            } finally {
              vm.svm.withSigverify(true);
            }
            break;
          }
          case "sendTransaction": {
            const t = Transaction.from(Buffer.from(p[0], "base64"));
            assert(t.verifySignatures());
            const signature = bs58.encode(t.signature);
            if (!history.has(signature)) {
              const meta = vm.svm.sendTransaction(t),
                m = t.compileMessage();
              history.set(signature, {
                slot: 100,
                transaction: {
                  signatures: t.signatures.map((s) => bs58.encode(s.signature)),
                  message: {
                    accountKeys: m.accountKeys.map(String),
                    instructions: m.instructions,
                  },
                },
                meta: {
                  err: null,
                  logMessages: meta.logs(),
                  innerInstructions: [],
                },
              });
            }
            result = signature;
            break;
          }
          case "getSignatureStatuses":
            result = {
              context: { slot: 100 },
              value: p[0].map((s) =>
                history.has(s)
                  ? {
                      slot: 100,
                      err: null,
                      confirmationStatus: "finalized",
                      confirmations: null,
                    }
                  : null,
              ),
            };
            break;
          case "getTransaction":
            result = history.get(p[0]) || null;
            break;
          case "getSignaturesForAddress":
            result = [];
            break;
          default:
            throw Error("Unknown local test RPC " + r.method);
        }
        res.end(JSON.stringify({ jsonrpc: "2.0", id: r.id, result }));
      } catch (e) {
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: r.id,
            error: { code: -32603, message: String(e) },
          }),
        );
      }
    });
    await new Promise((resolve) => rpc.listen(0, "127.0.0.1", resolve));
    const probe = http.createServer();
    await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
    const origin = `http://127.0.0.1:${port}`;
    const env = {
      ...process.env,
      DATABASE_URL: url.toString(),
      BIND_ADDRESS: `127.0.0.1:${port}`,
      APP_ORIGIN: origin,
      SOLANA_CLUSTER: "localnet",
      SOLANA_RPC_URLS: `http://127.0.0.1:${rpc.address().port}`,
      ENABLE_CHAIN_WRITES: "true",
      ENABLE_CONTRACTS: "true",
      NATIVE_HELPER_PATH: path.join(
        root,
        "backend/native/target/debug/depthguard-native",
      ),
      ARTIFACTS_DIR: directory,
    };
    const apiPath = path.join(root, "backend/target/debug/depthguard-api"),
      workerPath = path.join(root, "backend/target/debug/depthguard-worker");
    assert.equal(
      spawnSync(apiPath, ["migrate"], { env, encoding: "utf8" }).status,
      0,
    );
    if (process.env.APP_DB_PASSWORD) {
      const u = new URL(env.DATABASE_URL);
      u.username = "depthguard_app";
      u.password = process.env.APP_DB_PASSWORD;
      env.DATABASE_URL = u.toString();
    }
    const log = fs.openSync(path.join(directory, "services.log"), "a");
    api = spawn(apiPath, [], { env, stdio: ["ignore", log, log] });
    worker = spawn(workerPath, [], { env, stdio: ["ignore", log, log] });
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(origin + "/health/ready")).ok) break;
      } catch {}
      await sleep(100);
    }
    let cookie, csrf;
    async function call(method, route, body) {
      const r = await fetch(origin + route, {
        method,
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
          ...(cookie ? { Cookie: cookie, "X-CSRF-Token": csrf } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const value = await r.json();
      assert(r.ok, route + " " + JSON.stringify(value));
      if (r.headers.get("set-cookie"))
        cookie = r.headers.get("set-cookie").split(";")[0];
      return value;
    }
    const wallet = fixture.launcher;
    const challenge = await call("POST", "/api/v1/auth/challenges", {
      wallet: wallet.publicKey.toBase58(),
    });
    const key = crypto.createPrivateKey({
      format: "der",
      type: "pkcs8",
      key: Buffer.concat([
        Buffer.from("302e020100300506032b657004220420", "hex"),
        Buffer.from(wallet.secretKey.slice(0, 32)),
      ]),
    });
    const signature = crypto.sign(null, Buffer.from(challenge.message), key);
    const auth = await call("POST", "/api/v1/auth/verify", {
      id: challenge.id,
      signature: bs58.encode(signature),
    });
    csrf = auth.csrf_token;
    const security = [];
    async function deny(label, route, body, status, headers = {}) {
      const r = await fetch(origin + route, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
          Cookie: cookie,
          "X-CSRF-Token": csrf,
          ...headers,
        },
        body: JSON.stringify(body),
      });
      assert.equal(r.status, status, label + " " + (await r.text()));
      security.push(label);
    }
    const request = {
      action: "reserve_redeem",
      accounts: fixture.accounts,
      args: { burn_amount: fixture.burn.toString(), min_payout: "1" },
    };
    await deny("session_required", "/api/v1/contracts/prepare", request, 401, {
      Cookie: "",
    });
    await deny("csrf_required", "/api/v1/contracts/prepare", request, 403, {
      "X-CSRF-Token": "",
    });
    await deny(
      "foreign_origin_rejected",
      "/api/v1/contracts/prepare",
      request,
      403,
      { Origin: "https://attacker.invalid" },
    );
    await deny(
      "foreign_holder_role_rejected",
      "/api/v1/contracts/prepare",
      {
        ...request,
        accounts: {
          ...request.accounts,
          holder: require("@solana/web3.js")
            .Keypair.generate()
            .publicKey.toBase58(),
        },
      },
      403,
    );
    await deny(
      "arbitrary_action_rejected",
      "/api/v1/contracts/prepare",
      { ...request, action: "arbitrary_cpi" },
      422,
    );
    await deny(
      "noncanonical_atomic_amount_rejected",
      "/api/v1/contracts/prepare",
      { ...request, args: { burn_amount: "01", min_payout: "1" } },
      422,
    );
    await deny(
      "login_challenge_replay_rejected",
      "/api/v1/auth/verify",
      { id: challenge.id, signature: bs58.encode(signature) },
      401,
    );

    const state = await call(
      "GET",
      `/api/v1/contracts/reserve/${fixture.vault}`,
    );
    assert.equal(state.state.state, 1);
    const burn = fixture.burn.toString();
    const quote = await call(
      "POST",
      `/api/v1/contracts/reserve/${fixture.vault}/redemption-quote`,
      { burn_amount: burn },
    );
    assert(BigInt(quote.quote.payout) > 0n);
    const prepared = await call("POST", "/api/v1/contracts/prepare", {
      action: "reserve_redeem",
      accounts: fixture.accounts,
      args: { burn_amount: burn, min_payout: quote.quote.payout },
    });
    const t = Transaction.from(Buffer.from(prepared.transaction, "base64"));
    t.partialSign(wallet);
    const changed = Transaction.from(t.serialize());
    const target = changed.instructions[changed.instructions.length - 1];
    assert(target.data.length > 8);
    target.data = Buffer.from(target.data);
    target.data[8] ^= 1;
    assert.notDeepEqual(changed.serializeMessage(), t.serializeMessage());
    changed.partialSign(wallet);
    await deny(
      "signed_instruction_tampering_rejected",
      `/api/v1/transactions/${prepared.id}/submit`,
      { transaction: changed.serialize().toString("base64") },
      422,
    );
    await call("POST", `/api/v1/transactions/${prepared.id}/submit`, {
      transaction: t.serialize().toString("base64"),
    });
    for (let i = 0; i < 100; i++) {
      const value = await call("GET", `/api/v1/transactions/${prepared.id}`);
      if (value.state === "finalized") break;
      assert(value.state !== "failed", JSON.stringify(value));
      await sleep(100);
    }
    // A factory client can create its native DFS vault through the Rust API too.
    const feeBase = require("@solana/web3.js").Keypair.generate();
    const recipient = require("@solana/web3.js").Keypair.generate();
    const feePrepared = await call("POST", "/api/v1/contracts/prepare", {
      action: "create_fee_vault",
      accounts: {
        fee_base: feeBase.publicKey.toBase58(),
        launcher: wallet.publicKey.toBase58(),
        quote_mint: "So11111111111111111111111111111111111111112",
        vault: fixture.vault,
      },
      args: {
        recipients: [
          { wallet: wallet.publicKey.toBase58(), share: 9000 },
          { wallet: recipient.publicKey.toBase58(), share: 1000 },
        ],
      },
    });
    assert.deepEqual(
      feePrepared.summary.projections,
      [],
      "Extra labels cannot inject a contract projection",
    );
    const feeTx = Transaction.from(
      Buffer.from(feePrepared.transaction, "base64"),
    );
    feeTx.partialSign(wallet, feeBase);
    await call("POST", `/api/v1/transactions/${feePrepared.id}/submit`, {
      transaction: feeTx.serialize().toString("base64"),
    });
    for (let i = 0; i < 100; i++) {
      const receipt = await call(
        "GET",
        `/api/v1/transactions/${feePrepared.id}`,
      );
      if (receipt.state === "finalized") break;
      assert(receipt.state !== "failed", JSON.stringify(receipt));
      await sleep(100);
    }
    security.push("unused_account_labels_cannot_inject_projections");
    const count = () =>
      command("psql", [
        "--no-psqlrc",
        "--tuples-only",
        "--command",
        "SELECT count(*) FROM contract_receipts;",
      ]).trim();
    for (let i = 0; i < 100 && count() !== "2"; i++) await sleep(100);
    assert.equal(count(), "2");
    const events = command("psql", [
      "--no-psqlrc",
      "--tuples-only",
      "--command",
      "SELECT count(*) FROM chain_events WHERE commitment='finalized' AND data->>'kind'='redeemed';",
    ]).trim();
    assert.equal(events, "1");
    const projected = command("psql", [
      "--no-psqlrc",
      "--tuples-only",
      "--command",
      "SELECT count(*) FROM contract_accounts WHERE kind='reserve';",
    ]).trim();
    assert.equal(projected, "1");
    return {
      status: "passed",
      security_checks: security,
      checks: [
        "wallet_auth",
        "native_dfs_creation_with_two_client_signers",
        "finalized_state",
        "coherent_redemption_quote",
        "unsigned_simulation",
        "signed_submission",
        "worker_finality",
        "contract_event_ingestion",
        "durable_projection",
      ],
      runtime_role: process.env.APP_DB_PASSWORD
        ? "depthguard_app"
        : "test_admin",
    };
  } finally {
    for (const p of [api, worker])
      if (p) {
        p.kill("SIGTERM");
        await Promise.race([
          new Promise((resolve) => p.once("exit", resolve)),
          sleep(5000),
        ]);
        if (p.exitCode === null) p.kill("SIGKILL");
      }
    if (rpc) await new Promise((resolve) => rpc.close(resolve));
    if (fs.existsSync(path.join(directory, "services.log")))
      fs.copyFileSync(
        path.join(directory, "services.log"),
        path.join(root, ".local/contracts/http-services.log"),
      );
    command("dropdb", ["--force", database]);
    fs.rmSync(directory, { recursive: true, force: true });
  }
};
