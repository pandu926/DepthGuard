import { API_ORIGIN } from "./config";
import { randomUUID } from "node:crypto";
import BN from "bn.js";
import Decimal from "decimal.js";
import bs58 from "bs58";
import { Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import * as dbc from "@meteora-ag/dynamic-bonding-curve-sdk";
import { CpAmm, SwapMode, getUnClaimLpFee } from "@meteora-ag/cp-amm-sdk";
import { FailedTransactionMetadata } from "litesvm";
import { ProofVm } from "../../packages/engine/src/vm";
import { preview, Settings, spotSol } from "../../packages/engine/src/preview";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function json(value: any): any {
  if (BN.isBN(value)) return value.toString(10);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof PublicKey) return value.toBase58();
  if (Array.isArray(value)) return value.map(json);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, json(v)]),
    );
  return value;
}
export type Launch = {
  id: string;
  name: string;
  symbol: string;
  description: string;
  link: string;
  image?: string;
  creator: PublicKey;
  config: Keypair;
  mint: Keypair;
  pool: PublicKey;
  settings: Settings;
  built: dbc.ConfigParameters;
  prediction: ReturnType<typeof preview>["summary"];
  stage: "config" | "pool" | "live";
  damm?: PublicKey;
  position?: PublicKey;
  migrationError?: string;
  migration?: any;
  history: any[];
  feeLedger: { compound: BN; claimable: BN; protocol: BN };
};
type Prepared = {
  id: string;
  revision: number;
  expires: number;
  message: Buffer;
  wire: string;
  wallet: string;
  label: string;
  launch: string;
  after: () => Promise<void>;
  quote?: any;
};
export class Runtime {
  readonly vm = new ProofVm();
  readonly client = new dbc.DynamicBondingCurveClient(
    this.vm.connection,
    "confirmed",
  );
  readonly cp = new CpAmm(this.vm.connection);
  readonly platform = this.vm.wallet();
  readonly session = randomUUID();
  readonly launches = new Map<string, Launch>();
  readonly pending = new Map<string, Prepared>();
  readonly receipts: any[] = [];
  readonly cache = new Map<string, Keypair>();
  private faucetAccounts = new Set<string>();
  private tail: Promise<any> = Promise.resolve();
  revision = 0;
  dammConfig!: PublicKey;
  async init() {
    const program = dbc.createDammV2Program(this.vm.connection);
    const operator = PublicKey.findProgramAddressSync(
      [Buffer.from("operator"), this.platform.publicKey.toBuffer()],
      dbc.DAMM_V2_PROGRAM_ID,
    )[0];
    this.vm.send(
      "bootstrap-operator",
      await program.methods
        .createOperatorAccount(new BN(1))
        .accountsPartial({
          operator,
          whitelistedAddress: this.platform.publicKey,
          signer: this.platform.publicKey,
          payer: this.platform.publicKey,
        })
        .transaction(),
      [this.platform],
    );
    const index = new BN(1);
    this.dammConfig = PublicKey.findProgramAddressSync(
      [Buffer.from("config"), index.toArrayLike(Buffer, "le", 8)],
      dbc.DAMM_V2_PROGRAM_ID,
    )[0];
    this.vm.send(
      "bootstrap-damm-config",
      await program.methods
        .createDynamicConfig(index, {
          poolCreatorAuthority: dbc.deriveDbcPoolAuthority(),
          permission: new BN(1),
        })
        .accountsPartial({
          config: this.dammConfig,
          operator,
          signer: this.platform.publicKey,
          payer: this.platform.publicKey,
        })
        .transaction(),
      [this.platform],
    );
    // Clock starts at wall time, then advances deterministically after accepted transactions.
    const clock = this.vm.svm.getClock();
    clock.unixTimestamp = BigInt(Math.floor(Date.now() / 1000));
    this.vm.svm.setClock(clock);
  }
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }
  tick() {
    this.revision++;
    this.vm.svm.expireBlockhash();
    const c = this.vm.svm.getClock();
    c.slot++;
    c.unixTimestamp++;
    this.vm.svm.setClock(c);
  }
  wallet(address: string) {
    const owner = new PublicKey(address),
      balances: Record<string, string> = {};
    for (const l of this.launches.values())
      balances[l.id] = this.vm
        .balance(getAssociatedTokenAddressSync(l.mint.publicKey, owner))
        .toString();
    return {
      address,
      solRaw: (this.vm.svm.getBalance(owner) ?? 0n).toString(),
      wsolRaw: this.vm
        .balance(getAssociatedTokenAddressSync(NATIVE_MINT, owner))
        .toString(),
      tokens: balances,
    };
  }
  async faucet(address: string) {
    const owner = new PublicKey(address);
    if (this.faucetAccounts.has(address))
      throw new ApiError(
        409,
        "This wallet has already received faucet funds in this session.",
      );
    const r = this.vm.svm.airdrop(owner, 100_000_000_000n);
    if (r instanceof FailedTransactionMetadata)
      throw new ApiError(400, r.toString());
    this.faucetAccounts.add(address);
    this.tick();
    return this.wallet(address);
  }
  private l(id: string) {
    const l = this.launches.get(id);
    if (!l) throw new ApiError(404, "Launch not found.");
    return l;
  }
  private prepare(
    tx: Transaction,
    signers: Keypair[],
    wallet: PublicKey,
    label: string,
    launch: string,
    after: () => Promise<void>,
    quote?: any,
  ) {
    for (const [id, p] of this.pending)
      if (p.expires < Date.now()) this.pending.delete(id);
    if (this.pending.size > 300)
      throw new ApiError(429, "Too many pending transactions.");
    tx.feePayer = wallet;
    tx.recentBlockhash = this.vm.svm.latestBlockhash();
    if (signers.length) tx.partialSign(...signers);
    const p: Prepared = {
      id: randomUUID(),
      revision: this.revision,
      expires: Date.now() + 90_000,
      message: tx.serializeMessage(),
      wire: tx
        .serialize({ requireAllSignatures: false, verifySignatures: false })
        .toString("base64"),
      wallet: wallet.toBase58(),
      label,
      launch,
      after,
      quote,
    };
    this.pending.set(p.id, p);
    return {
      id: p.id,
      transaction: p.wire,
      revision: p.revision,
      session: this.session,
      expires: p.expires,
      launchId: launch,
      label,
      quote,
    };
  }
  async create(input: any) {
    const owner = new PublicKey(input.wallet);
    if (
      typeof input.name !== "string" ||
      !input.name.trim() ||
      input.name.length > 32 ||
      typeof input.symbol !== "string" ||
      !/^[A-Z0-9]{2,10}$/.test(input.symbol)
    )
      throw new ApiError(
        400,
        "The name must be at most 32 characters; the ticker must contain 2–10 uppercase letters or digits.",
      );
    if (
      typeof input.description !== "string" ||
      input.description.length > 500 ||
      typeof input.link !== "string" ||
      input.link.length > 200
    )
      throw new ApiError(
        400,
        "The description must be at most 500 characters; the link must be at most 200 characters.",
      );
    if (input.link && !/^https?:\/\//.test(input.link))
      throw new ApiError(400, "Links must use HTTP or HTTPS.");
    const solved = preview(input.settings),
      key = JSON.stringify(solved.summary.settings),
      cached = this.cache.get(key);
    const config = cached ?? Keypair.generate(),
      mint = Keypair.generate(),
      id = randomUUID();
    let image: string | undefined;
    if (input.image) {
      if (typeof input.image !== "string" || input.image.length > 2_800_000)
        throw new ApiError(400, "Images must be at most 2 MB.");
      const match = input.image.match(
        /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/,
      );
      if (!match) throw new ApiError(400, "Use PNG, JPEG, or WebP.");
      const b = Buffer.from(match[2], "base64");
      const valid =
        match[1] === "png"
          ? b
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : match[1] === "jpeg"
            ? b[0] === 255 && b[1] === 216
            : b.toString("ascii", 0, 4) === "RIFF" &&
              b.toString("ascii", 8, 12) === "WEBP";
      if (!valid || b.length > 2_000_000)
        throw new ApiError(400, "The image is invalid or too large.");
      image = input.image;
    }
    const launch: Launch = {
      id,
      name: input.name.trim(),
      symbol: input.symbol,
      description: input.description,
      link: input.link,
      image,
      creator: owner,
      config,
      mint,
      pool: dbc.deriveDbcPoolAddress(
        NATIVE_MINT,
        mint.publicKey,
        config.publicKey,
      ),
      settings: solved.summary.settings,
      built: solved.config,
      prediction: solved.summary,
      stage: cached ? "pool" : "config",
      history: [],
      feeLedger: {
        compound: new BN(0),
        claimable: new BN(0),
        protocol: new BN(0),
      },
    };
    this.launches.set(id, launch);
    return this.resume(id, owner.toBase58());
  }
  async resume(id: string, wallet: string) {
    const l = this.l(id),
      owner = new PublicKey(wallet);
    if (!l.creator.equals(owner))
      throw new ApiError(403, "Only the creator can resume this launch.");
    if (l.stage === "live") throw new ApiError(409, "The pool has already been created.");
    if (l.stage === "config") {
      const tx = await this.client.partner.createConfig({
        ...l.built,
        config: l.config.publicKey,
        feeClaimer: this.platform.publicKey,
        leftoverReceiver: this.platform.publicKey,
        quoteMint: NATIVE_MINT,
        payer: owner,
      });
      return this.prepare(
        tx,
        [l.config],
        owner,
        "create-config",
        id,
        async () => {
          l.stage = "pool";
          this.cache.set(JSON.stringify(l.settings), l.config);
        },
      );
    }
    const tx = await this.client.creator.createPool({
      config: l.config.publicKey,
      baseMint: l.mint.publicKey,
      name: l.name,
      symbol: l.symbol,
      uri: `${API_ORIGIN}/metadata/${l.id}.json`,
      payer: owner,
      poolCreator: owner,
    });
    return this.prepare(tx, [l.mint], owner, "create-pool", id, async () => {
      l.stage = "live";
      await this.recordPrice(l, "launch");
    });
  }
  private async recordPrice(l: Launch, label: string, extra: any = {}) {
    const state = await this.state(l);
    l.history.push({
      label,
      time: Number(this.vm.svm.getClock().unixTimestamp),
      spotSol: state.spotSol,
      revision: this.revision,
      ...extra,
    });
  }
  async state(l: Launch) {
    if (l.stage !== "live")
      return {
        phase: l.stage === "config" ? "DRAFT_CONFIG" : "DRAFT_POOL",
        spotSol: 0,
        quoteReserveRaw: "0",
        baseReserveRaw: "0",
        progressPct: 0,
      };
    const virtual = await this.client.state.getPool(l.pool),
      cfg = await this.client.state.getPoolConfig(l.config.publicKey);
    if (!virtual || !cfg) throw new Error("Pool state is unavailable.");
    const v = virtual.poolState;
    if (v.isMigrated === 1) {
      l.damm = dbc.deriveDammV2PoolAddress(
        this.dammConfig,
        l.mint.publicKey,
        NATIVE_MINT,
      );
      const p = await this.cp.fetchPoolState(l.damm);
      const claimable = l.position
        ? getUnClaimLpFee(p, await this.cp.fetchPositionState(l.position))
            .feeTokenB
        : new BN(0);
      return {
        phase: l.migration?.verified ? "DAMM" : "DAMM_UNVERIFIED",
        spotSol: spotSol(p.sqrtPrice),
        quoteReserveRaw: p.tokenBAmount.toString(),
        baseReserveRaw: p.tokenAAmount.toString(),
        progressPct: 100,
        sqrtPriceRaw: p.sqrtPrice.toString(),
        protocolFeesQuoteRaw: p.protocolBFee.toString(),
        metrics: json(p.metrics),
        claimableLpQuoteRaw: claimable.toString(),
        feeLedger: json(l.feeLedger),
        collectFeeMode: p.collectFeeMode,
      };
    }
    return {
      phase: v.quoteReserve.gte(cfg.migrationQuoteThreshold) ? "READY" : "DBC",
      spotSol: spotSol(v.sqrtPrice),
      quoteReserveRaw: v.quoteReserve.toString(),
      baseReserveRaw: this.vm.balance(v.baseVault).toString(),
      progressPct: Math.min(
        100,
        new Decimal(v.quoteReserve.toString())
          .div(cfg.migrationQuoteThreshold.toString())
          .mul(100)
          .toNumber(),
      ),
      sqrtPriceRaw: v.sqrtPrice.toString(),
      protocolFeesQuoteRaw: v.protocolQuoteFee.toString(),
      partnerFeesQuoteRaw: v.partnerQuoteFee.toString(),
    };
  }
  async view(id: string) {
    const l = this.l(id);
    return {
      id: l.id,
      name: l.name,
      symbol: l.symbol,
      description: l.description,
      link: l.link,
      image: l.image,
      creator: l.creator.toBase58(),
      mint: l.mint.publicKey.toBase58(),
      config: l.config.publicKey.toBase58(),
      pool: l.pool.toBase58(),
      damm: l.damm?.toBase58(),
      settings: l.settings,
      prediction: l.prediction,
      state: await this.state(l),
      migration: l.migration,
      migrationError: l.migrationError,
      history: l.history,
      ownership: {
        creatorTradingFeePct: 0,
        permanentlyLockedLpPct: 100,
        lpOwner: this.platform.publicKey.toBase58(),
        lpBeneficiary: "platform",
      },
    };
  }
  async list() {
    return Promise.all([...this.launches.keys()].map((id) => this.view(id)));
  }
  async quote(id: string, input: any) {
    const l = this.l(id),
      wallet = new PublicKey(input.wallet);
    if (
      !["buy", "sell"].includes(input.side) ||
      typeof input.amountRaw !== "string" ||
      !/^\d{1,19}$/.test(input.amountRaw) ||
      !Number.isInteger(input.slippageBps) ||
      input.slippageBps < 1 ||
      input.slippageBps > 500
    )
      throw new ApiError(
        400,
        "The amount must be positive integer units; slippage tolerance must be 1–500 bps.",
      );
    const amount = new BN(input.amountRaw);
    if (amount.isZero())
      throw new ApiError(400, "The amount must be greater than zero.");
    const before = await this.state(l),
      buy = input.side === "buy";
    if (before.phase !== "DBC" && before.phase !== "DAMM")
      throw new ApiError(409, "Trading is paused until migration completes.");
    const balance = buy
      ? (this.vm.svm.getBalance(wallet) ?? 0n)
      : this.vm.balance(
          getAssociatedTokenAddressSync(l.mint.publicKey, wallet),
        );
    if (BigInt(amount.toString()) > balance)
      throw new ApiError(400, "Insufficient balance.");
    if (before.phase === "DBC") {
      const pool = (await this.client.state.getPool(l.pool))!,
        cfg = (await this.client.state.getPoolConfig(l.config.publicKey))!;
      const q = this.client.pool.swapQuote2({
        virtualPool: pool,
        config: cfg,
        swapBaseForQuote: !buy,
        amountIn: amount,
        swapMode: buy ? dbc.SwapMode.PartialFill : dbc.SwapMode.ExactIn,
        slippageBps: input.slippageBps,
        hasReferral: false,
        currentPoint: new BN(this.vm.svm.getClock().unixTimestamp.toString()),
        eligibleForFirstSwapWithMinFee: false,
      });
      return {
        l,
        wallet,
        buy,
        amount,
        before,
        q,
        phase: "DBC",
        output: q.outputAmount,
        min: q.minimumAmountOut!,
        fee: q.tradingFee.add(q.protocolFee),
        consumed: q.includedFeeInputAmount,
      };
    }
    const pool = await this.cp.fetchPoolState(l.damm!);
    const q = this.cp.getQuote2({
      poolState: pool,
      inputTokenMint: buy ? NATIVE_MINT : l.mint.publicKey,
      amountIn: amount,
      swapMode: SwapMode.ExactIn,
      slippage: input.slippageBps / 100,
      hasReferral: false,
      tokenADecimal: 6,
      tokenBDecimal: 9,
      currentPoint: new BN(this.vm.svm.getClock().unixTimestamp.toString()),
    });
    return {
      l,
      wallet,
      buy,
      amount,
      before,
      q,
      phase: "DAMM",
      output: q.outputAmount,
      min: q.minimumAmountOut!,
      fee: q.claimingFee.add(q.compoundingFee).add(q.protocolFee),
      consumed: amount,
    };
  }
  quoteJson(result: Awaited<ReturnType<Runtime["quote"]>>) {
    const { buy, amount, before, output, min, fee, consumed } = result;
    const spot = new Decimal(before.spotSol);
    const shortfall = buy
      ? new Decimal(1).sub(
          new Decimal(output.toString())
            .div(1e6)
            .mul(spot)
            .div(new Decimal(consumed.toString()).div(1e9)),
        )
      : new Decimal(1).sub(
          new Decimal(output.toString())
            .div(1e9)
            .div(new Decimal(amount.toString()).div(1e6).mul(spot)),
        );
    return {
      phase: result.phase,
      side: buy ? "buy" : "sell",
      inputRaw: amount.toString(),
      consumedInputRaw: consumed.toString(),
      outputRaw: output.toString(),
      minimumOutputRaw: min.toString(),
      feeRaw: fee.toString(),
      feeMint: "SOL",
      shortfallPct: shortfall.mul(100).toNumber(),
      revision: this.revision,
      session: this.session,
    };
  }
  async swap(id: string, input: any) {
    const result = await this.quote(id, input),
      { l, wallet, buy, amount, min, q, before } = result;
    let tx: Transaction;
    if (result.phase === "DBC")
      tx = await this.client.pool.swap2({
        owner: wallet,
        pool: l.pool,
        amountIn: amount,
        minimumAmountOut: min,
        swapBaseForQuote: !buy,
        swapMode: buy ? dbc.SwapMode.PartialFill : dbc.SwapMode.ExactIn,
        referralTokenAccount: null,
      });
    else {
      const p = await this.cp.fetchPoolState(l.damm!);
      tx = await this.cp.swap({
        payer: wallet,
        pool: l.damm!,
        inputTokenMint: buy ? NATIVE_MINT : l.mint.publicKey,
        outputTokenMint: buy ? l.mint.publicKey : NATIVE_MINT,
        amountIn: amount,
        minimumAmountOut: min,
        tokenAVault: p.tokenAVault,
        tokenBVault: p.tokenBVault,
        tokenAMint: l.mint.publicKey,
        tokenBMint: NATIVE_MINT,
        tokenAProgram: TOKEN_PROGRAM_ID,
        tokenBProgram: TOKEN_PROGRAM_ID,
        referralTokenAccount: null,
        poolState: p,
      });
    }
    return this.prepare(
      tx,
      [],
      wallet,
      `${result.phase.toLowerCase()}-${buy ? "buy" : "sell"}`,
      id,
      async () => {
        if (result.phase === "DAMM") {
          const a = q as any;
          l.feeLedger.compound = l.feeLedger.compound.add(a.compoundingFee);
          l.feeLedger.claimable = l.feeLedger.claimable.add(a.claimingFee);
          l.feeLedger.protocol = l.feeLedger.protocol.add(a.protocolFee);
          const after = await this.cp.fetchPoolState(l.damm!);
          const preBase = new BN(before.baseReserveRaw),
            preQuote = new BN(before.quoteReserveRaw);
          const expectedBase = buy
            ? preBase.sub(result.output)
            : preBase.add(a.excludedFeeInputAmount);
          const expectedQuote = buy
            ? preQuote.add(a.excludedFeeInputAmount).add(a.compoundingFee)
            : preQuote.sub(result.output).sub(result.fee).add(a.compoundingFee);
          if (
            !after.tokenAAmount.eq(expectedBase) ||
            !after.tokenBAmount.eq(expectedQuote)
          )
            throw new Error("Reserve accounting invariant failed.");
        }
        await this.recordPrice(l, "swap", {
          side: input.side,
          inputRaw: amount.toString(),
          outputRaw: result.output.toString(),
          wallet: wallet.toBase58(),
        });
      },
      this.quoteJson(result),
    );
  }
  async submit(id: string, wire: string, session: string) {
    if (session !== this.session)
      throw new ApiError(
        409,
        "The VM session changed. Reload and prepare a new transaction.",
      );
    const p = this.pending.get(id);
    if (!p)
      throw new ApiError(404, "The transaction was not found or has already been submitted.");
    if (p.expires < Date.now() || p.revision !== this.revision)
      throw new ApiError(
        409,
        "The quote or state has expired. Prepare a new transaction.",
      );
    const tx = Transaction.from(Buffer.from(wire, "base64"));
    if (!tx.serializeMessage().equals(p.message) || !tx.verifySignatures())
      throw new ApiError(400, "Invalid signature or transaction message.");
    const simulated = this.vm.svm.simulateTransaction(tx);
    if (simulated instanceof FailedTransactionMetadata)
      throw new ApiError(
        400,
        simulated.toString() + "\n" + simulated.meta().logs().join("\n"),
      );
    const result = this.vm.svm.sendTransaction(tx);
    if (result instanceof FailedTransactionMetadata)
      throw new ApiError(400, result.toString());
    this.pending.delete(id);
    this.tick();
    const receipt = {
      id: randomUUID(),
      launchId: p.launch,
      label: p.label,
      signature: bs58.encode(result.signature()),
      computeUnits: result.computeUnitsConsumed().toString(),
      logs: result.logs(),
      revision: this.revision,
      time: Date.now(),
      quote: p.quote,
    };
    this.receipts.push(receipt);
    let verificationError: string | undefined;
    try {
      await p.after();
    } catch (e) {
      verificationError = (e as Error).message;
      receipt.logs.push("Post-transaction verification: " + verificationError);
    }
    const l = this.l(p.launch);
    if (l.stage === "live" && (await this.state(l)).phase === "READY")
      await this.migrate(l.id);
    return {
      receipt,
      verificationError,
      launch: await this.view(p.launch),
      wallet: this.wallet(p.wallet),
      session: this.session,
      revision: this.revision,
    };
  }
  async migrate(id: string) {
    const l = this.l(id),
      before = await this.state(l);
    if (["DAMM", "DAMM_UNVERIFIED"].includes(before.phase))
      return this.view(id);
    if (before.phase !== "READY")
      throw new ApiError(409, "The graduation threshold has not been reached.");
    try {
      const v = (await this.client.state.getPool(l.pool))!.poolState;
      const cfg = (await this.client.state.getPoolConfig(l.config.publicKey))!;
      const baseBefore = this.vm.balance(v.baseVault),
        quoteBefore = this.vm.balance(v.quoteVault);
      const migration = await this.client.migration.migrateToDammV2({
        pool: l.pool,
        dammConfig: this.dammConfig,
        payer: this.platform.publicKey,
      });
      this.vm.send("migrate-damm-v2", migration.transaction, [
        this.platform,
        migration.firstPositionNftKeypair,
        migration.secondPositionNftKeypair,
      ]);
      this.tick();
      const r = this.vm.receipts.at(-1)!;
      this.receipts.push({
        id: randomUUID(),
        launchId: id,
        label: "migrate-damm-v2",
        signature: bs58.encode(Buffer.from(r.localSignatureHex, "hex")),
        computeUnits: r.computeUnits,
        logs: r.logs,
        time: Date.now(),
        revision: this.revision,
      });
      l.damm = dbc.deriveDammV2PoolAddress(
        this.dammConfig,
        l.mint.publicKey,
        NATIVE_MINT,
      );
      l.position = dbc.derivePositionAddress(
        migration.firstPositionNftKeypair.publicKey,
      );
      const p = await this.cp.fetchPoolState(l.damm),
        position = await this.cp.fetchPositionState(l.position);
      const dead =
        l.settings.compoundBps > 0 ? new BN(100).shln(64) : new BN(0);
      const actualBase = this.vm.balance(p.tokenAVault),
        actualQuote = this.vm.balance(p.tokenBVault);
      if (
        baseBefore - this.vm.balance(v.baseVault) !== actualBase ||
        quoteBefore - this.vm.balance(v.quoteVault) !== actualQuote
      )
        throw new Error("Migration vault conservation failed.");
      if (!position.permanentLockedLiquidity.add(dead).eq(p.liquidity))
        throw new Error("Permanent lock invariant failed.");
      const after = (await this.client.state.getPool(l.pool))!.poolState;
      const compounding = l.settings.compoundBps > 0;
      if (
        compounding
          ? !p.sqrtMinPrice.isZero() ||
            !p.sqrtMaxPrice.eq(new BN(1).shln(128).subn(1))
          : !p.sqrtMinPrice.eq(dbc.MIN_SQRT_PRICE) ||
            !p.sqrtMaxPrice.eq(dbc.MAX_SQRT_PRICE) ||
            !p.sqrtPrice.eq(cfg.migrationSqrtPrice)
      )
        throw new Error("Migration range/price mismatch.");
      const sqrtPriceRelativeError = new Decimal(p.sqrtPrice.toString())
        .div(cfg.migrationSqrtPrice.toString())
        .sub(1)
        .abs();
      if (compounding && sqrtPriceRelativeError.gt("0.00001"))
        throw new Error("Migration price deviation exceeds tolerance.");
      l.migration = {
        verified: true,
        sqrtPriceRelativeError: sqrtPriceRelativeError.toString(),
        quoteDepositedRaw: actualQuote.toString(),
        baseDepositedRaw: actualBase.toString(),
        protocolQuoteFeeRaw: after.protocolMigrationQuoteFeeAmount.toString(),
        protocolBaseFeeRaw: after.protocolMigrationBaseFeeAmount.toString(),
        sqrtPriceRaw: p.sqrtPrice.toString(),
        lockVerified: true,
        lockedLiquidityRaw: position.permanentLockedLiquidity.toString(),
        deadLiquidityRaw: dead.toString(),
        vaultConservationVerified: true,
        position: l.position.toBase58(),
        rangeVerified: true,
      };
      l.migrationError = undefined;
      await this.recordPrice(l, "migration");
    } catch (e) {
      l.migrationError = (e as Error).message;
    }
    return this.view(id);
  }
  export(id: string) {
    const l = this.l(id);
    return {
      session: this.session,
      binaryHashes: this.vm.binaryHashes,
      settings: l.settings,
      config: json(l.built),
      predicted: l.prediction,
      migration: l.migration,
      receipts: this.receipts.filter((r) => r.launchId === id),
      history: l.history,
    };
  }
}
