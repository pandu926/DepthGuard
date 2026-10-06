import React, { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";
const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
const ATA_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);
import { request, atomic, units, short } from "../app/client";
import { useWallet } from "../app/wallet";
import { useTransactions } from "../app/transactions";
import {
  Heading,
  Status,
  Notice,
  Field,
  Metric,
  JsonView,
} from "../app/components";
const ata = (mint: string, owner: string) =>
  PublicKey.findProgramAddressSync(
    [
      new PublicKey(owner).toBuffer(),
      TOKEN_PROGRAM_ID.toBuffer(),
      new PublicKey(mint).toBuffer(),
    ],
    ATA_PROGRAM_ID,
  )[0].toBase58();
export function HolderRights({
  reviewer = false,
  kind,
}: {
  reviewer?: boolean;
  kind: "escrow" | "reserve";
}) {
  const { address } = useParams();
  const wallet = useWallet();
  const tx = useTransactions();
  const [amount, setAmount] = useState("1");
  const [deposit, setDeposit] = useState("0.1");
  const [quote, setQuote] = useState<any>();
  const [error, setError] = useState("");
  const token = useQuery({
    queryKey: ["token", address],
    queryFn: () => request(`/tokens/${address}`),
    refetchInterval: 5000,
  });
  const vault = token.data?.accounts.module_vault;
  const state = useQuery({
    queryKey: ["module", kind, vault],
    queryFn: () => request(`/contracts/${kind}/${vault}`),
    enabled: !!vault && token.data?.state.module_initialized,
    refetchInterval: 5000,
  });
  const s = state.data?.state;
  const funding = kind === "escrow";
  const ready = s && (funding ? s.state === 2 || s.state === 3 : s.state === 1);
  const isReviewer = !!s?.reviewers?.includes(wallet.account?.address);
  const voted =
    s && wallet.account
      ? ((s.approve_mask | s.reject_mask) &
          (1 << s.reviewers.indexOf(wallet.account.address))) !==
        0
      : false;
  async function action(name: string, args: any = {}) {
    setError("");
    try {
      if (!wallet.user) await wallet.login();
      const owner = wallet.account!.address;
      let accounts: Record<string, string> = {
        vault,
        token_program: TOKEN_PROGRAM_ID.toBase58(),
      };
      if (name.includes("redeem") || name.includes("refund"))
        accounts = {
          ...accounts,
          base_mint: s.base_mint,
          quote_mint: s.quote_mint,
          holder: owner,
          holder_tokens: ata(s.base_mint, owner),
          receiver: ata(s.quote_mint, owner),
          token_vault: ata(s.quote_mint, vault),
        };
      if (name === "reserve_deposit")
        accounts = {
          ...accounts,
          base_mint: s.base_mint,
          depositor: owner,
          source: ata(s.quote_mint, owner),
          token_vault: ata(s.quote_mint, vault),
        };
      if (name === "escrow_vote")
        accounts = {
          ...accounts,
          reviewer: owner,
          token_vault: ata(s.quote_mint, vault),
          beneficiary_tokens: ata(s.quote_mint, s.beneficiary),
        };
      await tx.run(
        await request("/contracts/prepare", { action: name, accounts, args }),
      );
      setQuote(undefined);
      state.refetch();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function redemptionQuote() {
    try {
      setError("");
      const next = await request(
        `/contracts/${kind}/${vault}/redemption-quote`,
        {
          burn_amount: atomic(amount, token.data!.metadata.base_decimals),
        },
      );
      if (BigInt(next.quote.payout) < 2n)
        throw Error(
          "Increase the token amount. The quoted payout is too small to execute.",
        );
      setQuote(next);
    } catch (e) {
      setQuote(undefined);
      setError((e as Error).message);
    }
  }
  async function redeem() {
    try {
      const fresh = await request(
        `/contracts/${kind}/${vault}/redemption-quote`,
        { burn_amount: atomic(amount, token.data!.metadata.base_decimals) },
      );
      if (
        !quote ||
        fresh.quote.burn_amount !== quote.quote.burn_amount ||
        fresh.quote.payout !== quote.quote.payout
      ) {
        setQuote(fresh);
        throw Error(
          "The reserve quote changed. Review the updated payout and confirm again.",
        );
      }
      const minimum = (
        (BigInt(fresh.quote.payout) * 9900n) /
        10000n
      ).toString();
      if (minimum === "0")
        throw Error("Payout is below the supported minimum.");
      await action(funding ? "escrow_refund" : "reserve_redeem", {
        burn_amount: fresh.quote.burn_amount,
        min_payout: minimum,
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <Heading
        eyebrow={`${token.data?.metadata.name || "Token"} / Holder rights`}
        title={
          reviewer
            ? "Review what comes next."
            : funding
              ? "Capital with conditions."
              : "A reserve you can inspect."
        }
        action={
          <Link className="secondary" to={`/tokens/${address}`}>
            Back to trading ↗
          </Link>
        }
      />
      <Status query={token} />
      {token.data && !token.data.state.module_initialized && (
        <Notice>
          Module rights are not initialized. The creator must complete the
          launch workflow.
        </Notice>
      )}
      {vault && token.data?.state.module_initialized && (
        <Status query={state} />
      )}
      {s && (
        <>
          <div className="metrics">
            <Metric
              label="Module state"
              value={
                funding
                  ? ["Unfunded", "Active", "Refunding", "Completed"][s.state]
                  : s.state === 1
                    ? "Active"
                    : "Unfunded"
              }
            />
            <Metric
              label="Initial funding"
              value={units(s.initial_funding)}
              unit="WSOL"
            />
            <Metric label="Beneficiary" value={short(s.beneficiary)} />
          </div>
          <Notice>
            Rights activate after verified migration and actual module funding.
            Burn payouts use remaining reserves divided by all unburned supply,
            including liquidity and team tokens. They do not guarantee your
            original purchase price.
          </Notice>
          {funding && (
            <section className="milestones">
              {s.milestones.map((m: any, i: number) => (
                <div
                  className={`milestone ${i === s.current_milestone ? "current" : ""}`}
                  key={i}
                >
                  <span className="milestone-number">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <div>
                    <h2>Milestone {i + 1}</h2>
                    <small>
                      {s.activated_at
                        ? new Date(
                            (s.activated_at + Number(m.deadline_offset)) * 1000,
                          ).toLocaleString()
                        : `${Number(m.deadline_offset) / 86400} days after activation`}
                    </small>
                  </div>
                  <strong>{units(s.budgets[i])} WSOL</strong>
                  <span className="badge">
                    {i < s.current_milestone
                      ? "Released"
                      : i === s.current_milestone
                        ? "Current"
                        : "Upcoming"}
                  </span>
                </div>
              ))}
              <div className="actions">
                <Link className="secondary" to={`/tokens/${address}/review`}>
                  Reviewer workspace ↗
                </Link>
                <button
                  disabled={
                    tx.busy ||
                    s.state !== 1 ||
                    !s.activated_at ||
                    Date.now() <
                      (s.activated_at +
                        Number(
                          s.milestones[s.current_milestone]?.deadline_offset ??
                            0,
                        )) *
                        1000
                  }
                  onClick={() => action("escrow_fail_expired")}
                >
                  Mark expired milestone
                </button>
              </div>
              {reviewer && (
                <>
                  <p>
                    Required approvals: {s.threshold}. Each reviewer may vote
                    once for the current milestone.
                  </p>
                  <div className="actions">
                    <button
                      className="primary"
                      disabled={
                        !isReviewer || voted || s.state !== 1 || tx.busy
                      }
                      onClick={() => action("escrow_vote", { approve: true })}
                    >
                      Approve milestone
                    </button>
                    <button
                      className="secondary"
                      disabled={
                        !isReviewer || voted || s.state !== 1 || tx.busy
                      }
                      onClick={() => action("escrow_vote", { approve: false })}
                    >
                      Reject milestone
                    </button>
                  </div>
                  {!isReviewer && (
                    <Notice>Only the fixed reviewer set can vote.</Notice>
                  )}
                </>
              )}
            </section>
          )}
          <div className="rights-layout">
            <section>
              <h2>
                {funding
                  ? "Burn for remaining-capital refund"
                  : "Redeem from reserve"}
              </h2>
              <Field label="Tokens to burn">
                <input
                  value={amount}
                  onChange={(e) => {
                    setAmount(e.target.value);
                    setQuote(undefined);
                  }}
                  inputMode="decimal"
                />
              </Field>
              <div className="actions">
                <button
                  className="secondary"
                  disabled={!ready || tx.busy}
                  onClick={redemptionQuote}
                >
                  Get payout quote
                </button>
                <button
                  className="primary"
                  disabled={!ready || !quote || tx.busy}
                  onClick={redeem}
                >
                  Confirm burn & payout ↗
                </button>
              </div>
              {quote && (
                <>
                  <Metric
                    label="Quoted payout"
                    value={units(quote.quote.payout)}
                    unit="WSOL"
                  />
                  <small>
                    Execution requires at least 99% of the quoted payout. Burn
                    and transfer are atomic.
                  </small>
                  <JsonView
                    value={quote}
                    label="Reserve, supply and quote slot"
                  />
                </>
              )}
            </section>
            {!funding && (
              <section>
                <h2>Grow the reserve.</h2>
                <Field
                  label="Donate WSOL"
                  hint="A donation does not mint tokens or grant donor withdrawal rights"
                >
                  <input
                    value={deposit}
                    onChange={(e) => setDeposit(e.target.value)}
                  />
                </Field>
                <button
                  className="secondary"
                  disabled={s.state !== 1 || tx.busy}
                  onClick={() => {
                    try {
                      action("reserve_deposit", { amount: atomic(deposit, 9) });
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  Donate ↗
                </button>
                <Link className="block text-button" to="/portfolio">
                  Wrap SOL first
                </Link>
              </section>
            )}
          </div>
          <JsonView
            value={s}
            label="Immutable terms, votes and account state"
          />
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
