"use strict";
const assert = require("node:assert/strict");
const {
  Keypair,
  Transaction,
  SystemProgram,
  ComputeBudgetProgram,
} = require("@solana/web3.js");
const {
  TOKEN_PROGRAM_ID,
  createInitializeAccount3Instruction,
} = require("@solana/spl-token");

// These fixtures run against compiled SBF with runtime signature verification enabled.
module.exports = function exercise({
  vm,
  native,
  send,
  ix,
  names,
  mechanism,
  vault,
  tokenVault,
  mint,
  holderTokens,
  holder,
  receiver,
  attacker,
  quoteMint,
  read,
}) {
  const action = mechanism === 1 ? "escrow_refund" : "reserve_redeem";
  const accounts = {
    vault,
    base_mint: mint,
    holder: holder.publicKey,
    holder_tokens: holderTokens,
    token_vault: tokenVault,
    receiver,
    token_program: TOKEN_PROGRAM_ID,
  };
  const checks = [];
  function rejected(
    label,
    roles,
    args,
    signers = [holder],
    pattern = /AnchorError|InstructionError|Invalid/,
  ) {
    assert.throws(() => send(action, roles, args, signers), pattern, label);
    checks.push(label);
  }
  const burn = vm.balance(holderTokens) / 100n;
  const supply = () =>
    Buffer.from(vm.svm.getAccount(mint).data).readBigUInt64LE(36);
  const snapshot = () => ({
    supply: supply(),
    holder: vm.balance(holderTokens),
    reserve: vm.balance(tokenVault),
  });
  const before = snapshot();
  rejected("zero_burn", accounts, { burn_amount: "0", min_payout: "1" });
  rejected("zero_minimum", accounts, {
    burn_amount: String(burn),
    min_payout: "0",
  });
  rejected("burn_exceeds_supply", accounts, {
    burn_amount: String(supply() + 1n),
    min_payout: "1",
  });
  rejected(
    "foreign_holder",
    { ...accounts, holder: attacker.publicKey },
    { burn_amount: String(burn), min_payout: "1" },
    [attacker],
  );
  rejected(
    "wrong_mint",
    { ...accounts, base_mint: quoteMint },
    { burn_amount: String(burn), min_payout: "1" },
  );
  rejected(
    "wrong_token_program",
    { ...accounts, token_program: SystemProgram.programId },
    { burn_amount: String(burn), min_payout: "1" },
  );

  // A real attacker can initialize another SPL account with a PDA as its owner.
  // Matching mint and authority alone must never make it the reserve account.
  const alternative = Keypair.generate();
  vm.send(
    "attacker-creates-alternative-vault",
    new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: attacker.publicKey,
        newAccountPubkey: alternative.publicKey,
        lamports: Number(vm.svm.minimumBalanceForRentExemption(165)),
        space: 165,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeAccount3Instruction(
        alternative.publicKey,
        quoteMint,
        vault,
      ),
    ),
    [attacker, alternative],
  );

  rejected(
    "alternative_vault_ata",
    { ...accounts, token_vault: alternative.publicKey },
    { burn_amount: String(burn), min_payout: "1" },
  );
  assert.deepEqual(snapshot(), before);

  // Fault injection is test-only: a WSOL issuer cannot freeze this account in production.
  // Sending the transaction directly bypasses the preflight test helper and exercises rollback.
  const original = vm.svm.getAccount(receiver);
  const frozen = { ...original, data: Buffer.from(original.data) };
  frozen.data[108] = 2;
  vm.svm.setAccount(receiver, frozen);
  try {
    const built = native({
      operation: "contract_build",
      action,
      accounts: names(accounts),
      args: { burn_amount: String(burn), min_payout: "1" },
    });
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1000000 }),
      ix(built),
    );
    vm.prepare(tx, [holder]);
    assert.throws(
      () => vm.svm.sendTransaction(tx),
      /frozen|Custom\(17\)|0x11/i,
    );
    assert.deepEqual(
      snapshot(),
      before,
      "Failed transfer must roll back the preceding burn",
    );
    checks.push("submitted_burn_then_transfer_failure_rolls_back");
  } finally {
    vm.svm.setAccount(receiver, original);
    vm.svm.expireBlockhash();
  }
  if (mechanism === 2) {
    const balance = vm.balance(tokenVault),
      oldSupply = supply();
    send(
      "reserve_deposit",
      {
        vault,
        base_mint: mint,
        depositor: holder.publicKey,
        source: receiver,
        token_vault: tokenVault,
        token_program: TOKEN_PROGRAM_ID,
      },
      { amount: "1000000" },
    );
    assert.equal(vm.balance(tokenVault), balance + 1000000n);
    assert.equal(
      supply(),
      oldSupply,
      "Donations must never mint additional rights",
    );
    checks.push("reserve_top_up_changes_balance_without_minting");
  }
  return checks;
};
