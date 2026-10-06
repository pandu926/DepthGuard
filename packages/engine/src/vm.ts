import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  AccountInfo,
  SystemProgram,
} from "@solana/web3.js";
import {
  LiteSVM,
  FailedTransactionMetadata,
  SimulatedTransactionInfo,
} from "litesvm";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, MintLayout } from "@solana/spl-token";
import * as dbc from "@meteora-ag/dynamic-bonding-curve-sdk";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import manifest from "../../../proof/fixture-manifest.json";

export const FIXTURES = resolve(__dirname, "../../../proof/fixtures");
export type Receipt = {
  label: string;
  localSignatureHex: string;
  computeUnits: string;
  logs: string[];
};

export class ProofVm {
  readonly svm = new LiteSVM();
  readonly connection: Connection;
  readonly receipts: Receipt[] = [];
  readonly binaryHashes: Record<string, string> = {};
  constructor() {
    for (const [id, file] of [
      [dbc.DYNAMIC_BONDING_CURVE_PROGRAM_ID, "dynamic_bonding_curve.so"],
      [dbc.DAMM_V2_PROGRAM_ID, "cp_amm.so"],
      [dbc.METAPLEX_PROGRAM_ID, "metaplex.so"],
    ] as const) {
      this.binaryHashes[file] = createHash("sha256")
        .update(readFileSync(resolve(FIXTURES, file)))
        .digest("hex");
      if (this.binaryHashes[file] !== manifest.sha256[file])
        throw new Error(`Fixture checksum mismatch: ${file}`);
      this.svm.addProgramFromFile(id, resolve(FIXTURES, file));
    }
    const mint = Buffer.alloc(MintLayout.span);
    MintLayout.encode(
      {
        mintAuthorityOption: 0,
        mintAuthority: PublicKey.default,
        supply: 0n,
        decimals: 9,
        isInitialized: true,
        freezeAuthorityOption: 0,
        freezeAuthority: PublicKey.default,
      },
      mint,
    );
    this.svm.setAccount(NATIVE_MINT, {
      data: mint,
      lamports: 1_500_000,
      owner: TOKEN_PROGRAM_ID,
      executable: false,
    });
    // Official DBC test harness funds this PDA to supply migration's flash rent.
    this.svm.setAccount(dbc.deriveDbcPoolAuthority(), {
      data: new Uint8Array(),
      lamports: 1_000_000_000,
      owner: SystemProgram.programId,
      executable: false,
    });
    const clock = this.svm.getClock();
    clock.unixTimestamp = 1_790_000_000n;
    clock.slot = 100n;
    this.svm.setClock(clock);
    this.connection = new Connection("http://127.0.0.1:8899", "confirmed");
    const read = async (
      address: PublicKey,
    ): Promise<AccountInfo<Buffer> | null> => {
      const a = this.svm.getAccount(address);
      return a ? { ...a, data: Buffer.from(a.data) } : null;
    };
    Object.assign(this.connection, {
      getAccountInfo: read,
      getAccountInfoAndContext: async (address: PublicKey) => ({
        context: { slot: 100 },
        value: await read(address),
      }),
      getMultipleAccountsInfo: async (addresses: PublicKey[]) =>
        Promise.all(addresses.map(read)),
      getMinimumBalanceForRentExemption: async (length: number) =>
        Number(this.svm.minimumBalanceForRentExemption(BigInt(length))),
      getLatestBlockhash: async () => ({
        blockhash: this.svm.latestBlockhash(),
        lastValidBlockHeight: 10000,
      }),
      getSlot: async () => Number(this.svm.getClock().slot),
      getBlockTime: async () => Number(this.svm.getClock().unixTimestamp),
      getEpochInfo: async () => ({
        epoch: 0,
        absoluteSlot: 100,
        slotIndex: 100,
        slotsInEpoch: 432000,
      }),
      _rpcRequest: async () => {
        throw new Error("Network RPC disabled in local proof");
      },
    });
  }
  wallet(): Keypair {
    const keypair = Keypair.generate();
    const result = this.svm.airdrop(keypair.publicKey, 100_000_000_000n);
    if (result instanceof FailedTransactionMetadata)
      throw new Error(result.toString());
    return keypair;
  }
  prepare(tx: Transaction, signers: Keypair[]) {
    tx.feePayer = signers[0].publicKey;
    tx.recentBlockhash = this.svm.latestBlockhash();
    tx.sign(...signers);
  }
  simulate(tx: Transaction, signers: Keypair[]): SimulatedTransactionInfo {
    this.prepare(tx, signers);
    const result = this.svm.simulateTransaction(tx);
    if (result instanceof FailedTransactionMetadata) {
      throw new Error(
        result.toString() + "\n" + result.meta().logs().join("\n"),
      );
    }
    return result;
  }
  send(label: string, tx: Transaction, signers: Keypair[]) {
    this.simulate(tx, signers);
    const result = this.svm.sendTransaction(tx);
    if (result instanceof FailedTransactionMetadata)
      throw new Error(result.toString());
    this.receipts.push({
      label,
      localSignatureHex: Buffer.from(result.signature()).toString("hex"),
      computeUnits: result.computeUnitsConsumed().toString(),
      logs: result.logs(),
    });
    this.svm.expireBlockhash();
  }
  balance(address: PublicKey): bigint {
    const data = this.svm.getAccount(address)?.data;
    return data && data.length >= 72
      ? Buffer.from(data).readBigUInt64LE(64)
      : 0n;
  }
  trialOutput(
    tx: Transaction,
    signers: Keypair[],
    outputAccount: PublicKey,
  ): bigint {
    const before = this.balance(outputAccount);
    // Keep WSOL output alive to measure token output independently of fees/rent.
    tx.instructions = tx.instructions.filter(
      (ix) => !(ix.programId.equals(TOKEN_PROGRAM_ID) && ix.data[0] === 9),
    );
    const result = this.simulate(tx, signers);
    const account = result
      .postAccounts()
      .find(([key]) => key.equals(outputAccount))?.[1];
    if (!account) throw new Error("Output account missing from simulation");
    return Buffer.from(account.data()).readBigUInt64LE(64) - before;
  }
}
