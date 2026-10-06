// Test-only synchronous adapter for the pinned Rust LiteSVM runtime.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { PublicKey } = require("@solana/web3.js");
class RustVm {
  constructor() {
    const root = path.resolve(__dirname, "../..");
    fs.mkdirSync(path.join(root, ".local/contracts"), { recursive: true });
    this.child = spawn(
      path.join(root, "backend/sbf/target/debug/depthguard-contract-runner"),
      [],
      {
        stdio: [
          "pipe",
          "pipe",
          fs.openSync(path.join(root, ".local/contracts/runner.log"), "a"),
        ],
      },
    );
    this.input = this.child.stdin._handle.fd;
    this.output = this.child.stdout._handle.fd;
    this.pending = "";
  }
  call(v) {
    fs.writeSync(this.input, JSON.stringify(v) + "\n");
    const started = Date.now();
    for (;;) {
      const line = this.pending.indexOf("\n");
      if (line >= 0) {
        const response = JSON.parse(this.pending.slice(0, line));
        this.pending = this.pending.slice(line + 1);
        if (!response.ok) throw new Error(response.error);
        return response.result;
      }
      const bytes = Buffer.alloc(65536);
      try {
        const n = fs.readSync(this.output, bytes);
        if (!n) throw new Error("Rust test runtime exited");
        this.pending += bytes.subarray(0, n).toString();
      } catch (e) {
        if (e.code !== "EAGAIN") throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
      }
      if (Date.now() - started > 20000)
        throw new Error("Rust test operation timed out");
    }
  }
  addProgramFromFile(address, file) {
    return this.call({
      op: "load",
      address: address.toBase58(),
      path: path.resolve(file),
    });
  }
  getAccount(address) {
    const a = this.call({ op: "get", address: address.toBase58() });
    return a
      ? {
          data: Buffer.from(a.data, "base64"),
          lamports: Number(a.lamports),
          owner: new PublicKey(a.owner),
          executable: a.executable,
        }
      : null;
  }
  setAccount(address, a) {
    return this.call({
      op: "set",
      address: address.toBase58(),
      account: {
        ...a,
        data: Buffer.from(a.data).toString("base64"),
        lamports: String(a.lamports),
        owner: a.owner.toBase58(),
      },
    });
  }
  getClock() {
    const c = this.call({ op: "clock" });
    return { slot: BigInt(c.slot), unixTimestamp: BigInt(c.unixTimestamp) };
  }
  setClock(c) {
    return this.call({
      op: "set_clock",
      slot: String(c.slot),
      unixTimestamp: String(c.unixTimestamp),
    });
  }
  latestBlockhash() {
    return this.call({ op: "blockhash" });
  }
  expireBlockhash() {
    return this.call({ op: "expire" });
  }
  airdrop(address, amount) {
    return this.call({
      op: "airdrop",
      address: address.toBase58(),
      amount: String(amount),
    });
  }
  minimumBalanceForRentExemption(size) {
    return BigInt(this.call({ op: "rent", size: Number(size) }));
  }
  withSigverify(value) {
    this.call({ op: "sigverify", value });
    return this;
  }
  simulateTransaction(tx) {
    return this.call({
      op: "simulate",
      wire: tx.serialize().toString("base64"),
    });
  }
  sendTransaction(tx) {
    const r = this.call({
      op: "send",
      wire: tx.serialize().toString("base64"),
    });
    return {
      logs: () => r.logs,
      signature: () => r.signature,
      computeUnitsConsumed: () => BigInt(r.computeUnits),
    };
  }
  close() {
    this.child.stdin.end();
    this.child.kill("SIGTERM");
  }
}
module.exports = { RustVm };
