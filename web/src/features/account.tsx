import React, { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { request, units, atomic, short } from "../app/client";
import { WalletNetwork } from "../app/wallet-network";
import { networkFor } from "../app/network";
import { useWallet } from "../app/wallet";
import { useTransactions } from "../app/transactions";
import { useDraft } from "../app/draft";
import {
  Heading,
  Empty,
  Status,
  CardLink,
  Notice,
  JsonView,
  Metric,
  Field,
} from "../app/components";
export function CreatorDashboard({ author = false }: { author?: boolean }) {
  const wallet = useWallet();
  const { update } = useDraft();
  const [error, setError] = useState("");
  const drafts = useQuery({
    queryKey: ["my-models", wallet.user?.wallet],
    queryFn: () => request("/me/models"),
    enabled: !!wallet.user,
  });
  const launches = useQuery({
    queryKey: ["my-launches", wallet.user?.wallet],
    queryFn: () => request("/me/launches"),
    enabled: !!wallet.user,
    refetchInterval: 5000,
  });
  return (
    <>
      <Heading
        eyebrow={author ? "Mechanism author" : "Creator dashboard"}
        title={author ? "Your ideas, in motion." : "What you are building."}
        action={
          <Link
            className="primary"
            to={author ? "/studio" : "/create/identity"}
          >
            {author ? "Design economy" : "Create token"} ↗
          </Link>
        }
      />
      <Status query={drafts} />
      <div className="section-row">
        <h2>Economy drafts</h2>
        <Link to="/models">Explore models ↗</Link>
      </div>
      {drafts.data &&
        (drafts.data.items.length ? (
          <div className="draft-list">
            {drafts.data.items.map((d: any) => (
              <Link
                className="list-row"
                to="/studio"
                key={d.id}
                onClick={() =>
                  update({
                    economy: d.economy,
                    modelId: d.id,
                    revision: d.revision,
                    modelName: d.name,
                    versionId: undefined,
                  })
                }
              >
                <span>
                  <strong>{d.name}</strong>
                  <small>
                    {d.economy.mechanism} · Revision {d.revision}
                  </small>
                </span>
                <span>Edit ↗</span>
              </Link>
            ))}
          </div>
        ) : (
          <Empty
            title="Room for a new idea."
            text="Saved economy drafts appear here."
          />
        ))}
      <div className="section-row">
        <h2>Launches</h2>
        <Link to="/earnings">View earnings ↗</Link>
      </div>
      <Status query={launches} />
      {launches.data &&
        (launches.data.items.length ? (
          <div className="cards">
            {launches.data!.items.map((l: any) => (
              <CardLink
                key={l.id}
                to={`/creator/launches/${l.id}`}
                title={l.metadata.name}
                subtitle={l.metadata.symbol}
                badge={l.state}
              />
            ))}
          </div>
        ) : (
          <Empty title="Your first launch awaits." />
        ))}
      {error && <p className="error">{error}</p>}
    </>
  );
}
export function LaunchProgress() {
  const { id } = useParams();
  const wallet = useWallet();
  const tx = useTransactions();
  const [error, setError] = useState("");
  const [complete, setComplete] = useState(false);
  const [working, setWorking] = useState(false);
  const q = useQuery({
    queryKey: ["factory", id],
    queryFn: () => request(`/factory/launches/${id}`),
    enabled: !!wallet.user,
    refetchInterval: 2000,
  });
  async function next() {
    setWorking(true);
    setError("");
    try {
      const p = await request(`/factory/launches/${id}/next`, {});
      if (p.state === "complete") {
        setComplete(true);
        q.refetch();
      } else {
        await tx.run(p);
        q.refetch();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(false);
    }
  }
  return (
    <>
      <Heading
        eyebrow="Launch workflow"
        title={q.data?.metadata.name || "Bring it to life."}
        description="Every step is simulated, signed and verified."
      />
      <Status query={q} />
      {q.data && (
        <>
          <Notice>
            Keep your wallet on {wallet.cluster}. Progress is saved by the
            backend and can be resumed after refresh.
          </Notice>
          <div className="workflow">
            {q.data.steps.map((s: string, i: number) => {
              const t = q.data!.transactions.find((t: any) => t.step === s);
              const registeredModel =
                !t &&
                (s === "begin_model" ||
                  s === "seal_model" ||
                  s.startsWith("write_model_")) &&
                q.data!.transactions.some(
                  (receipt: any) =>
                    receipt.step === "initialize_launch" &&
                    receipt.state === "finalized",
                );
              return (
                <div className="list-row" key={s}>
                  <span className="step-number">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <strong>{s.replaceAll("_", " ")}</strong>
                  <span
                    className={`badge ${t?.state === "finalized" || registeredModel ? "success" : ""}`}
                  >
                    {t?.state ||
                      (registeredModel ? "Previously registered" : "Pending")}
                  </span>
                  {t?.id && <Link to={`/activity/${t.id}`}>Receipt ↗</Link>}
                </div>
              );
            })}
          </div>
          <div className="actions">
            <button
              className="primary"
              disabled={working || tx.busy || complete}
              onClick={next}
            >
              {working
                ? "Confirming step…"
                : complete
                  ? "Launch ready"
                  : "Continue signing workflow ↗"}
            </button>
            <Link
              className="secondary"
              to={`/tokens/${q.data.accounts.launch}`}
            >
              Open token page
            </Link>
          </div>
          {["trading", "migrated"].includes(q.data.state) && (
            <div className="actions">
              <button
                className="secondary"
                disabled={working || tx.busy}
                onClick={async () => {
                  setWorking(true);
                  setError("");
                  try {
                    const p = await request(
                      `/factory/launches/${id}/graduate`,
                      {},
                    );
                    if (p.state !== "complete") await tx.run(p);
                    q.refetch();
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setWorking(false);
                  }
                }}
              >
                {working
                  ? "Preparing graduation & activation…"
                  : "Continue graduation & activation ↗"}
              </button>
            </div>
          )}
          <JsonView value={q.data.accounts} label="Deployment accounts" />
        </>
      )}
      {error && <p className="error">{error}</p>}
    </>
  );
}
export function Portfolio() {
  const wallet = useWallet();
  const tx = useTransactions();
  const [amount, setAmount] = useState("0.1");
  const [error, setError] = useState("");
  const q = useQuery({
    queryKey: ["portfolio", wallet.user?.wallet],
    queryFn: () => request("/me/portfolio"),
    enabled: !!wallet.user,
    refetchInterval: 8000,
  });
  async function wrap(unwrap = false) {
    try {
      setError("");
      await tx.run(
        await request("/contracts/prepare", {
          action: unwrap ? "unwrap_sol" : "wrap_sol",
          accounts: { launcher: wallet.account!.address },
          args: unwrap ? {} : { amount: atomic(amount, 9) },
        }),
      );
      q.refetch();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <Heading eyebrow="Your portfolio" title="Where you stand." />
      <Status query={q} />
      {q.data && (
        <>
          <div className="metrics">
            <Metric label="SOL balance" value={units(q.data.sol_lamports)} />
            <Metric label="Token accounts" value={q.data.items.length} />
            <Metric label="Commitment" value="Finalized" />
          </div>
          <section className="wrap-panel">
            <h2>SOL ↔ WSOL</h2>
            <Field label="SOL to wrap">
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                inputMode="decimal"
              />
            </Field>
            <div className="actions">
              <button
                className="primary"
                disabled={tx.busy}
                onClick={() => wrap()}
              >
                Wrap SOL ↗
              </button>
              <button
                className="secondary"
                disabled={tx.busy}
                onClick={() => wrap(true)}
              >
                Unwrap entire WSOL account
              </button>
            </div>
            <small>
              Unwrapping closes your canonical WSOL token account and returns
              its SOL plus rent.
            </small>
          </section>
          {q.data.items.length ? (
            <div className="holdings">
              {q.data.items.map((t: any) => (
                <div className="list-row" key={t.account}>
                  <span>
                    <strong>{short(t.mint)}</strong>
                    <small>{short(t.account)}</small>
                  </span>
                  <strong>{units(t.amount, t.decimals)}</strong>
                  <button
                    className="text-button"
                    disabled={!navigator.clipboard}
                    title={
                      navigator.clipboard
                        ? "Copy mint address"
                        : "Copy requires HTTPS"
                    }
                    onClick={() =>
                      navigator.clipboard
                        ?.writeText(t.mint)
                        .catch(() =>
                          setError("The mint address could not be copied."),
                        )
                    }
                  >
                    Copy mint
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <Empty title="No token accounts yet." />
          )}
        </>
      )}
      {error && <p className="error">{error}</p>}
    </>
  );
}
export function Earnings() {
  const wallet = useWallet();
  const tx = useTransactions();
  const [error, setError] = useState("");
  const [claiming, setClaiming] = useState(false);
  const [settledClaims, setSettledClaims] = useState<Record<string, string>>(
    {},
  );
  const q = useQuery({
    queryKey: ["earnings", wallet.user?.wallet],
    queryFn: () => request("/me/earnings"),
    enabled: !!wallet.user,
    refetchInterval: 10000,
  });
  const launches = useQuery({
    queryKey: ["my-launches", wallet.user?.wallet],
    queryFn: () => request("/me/launches"),
    enabled: !!wallet.user,
  });
  async function claim(address: string) {
    const owner = wallet.account!.address;
    const claimed = BigInt(
      q.data?.vaults.find((v: any) => v.address === address)?.recipient
        ?.claimed || "0",
    );
    setClaiming(true);
    try {
      setError("");
      const receipt = await tx.run(
        await request(`/fee-vaults/${address}/claims/prepare`, {}),
      );
      setSettledClaims((previous) => ({
        ...previous,
        [`${owner}:${address}`]: (
          claimed + BigInt(receipt.summary.expected_pending)
        ).toString(),
      }));
      await q.refetch();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setClaiming(false);
    }
  }
  function awaitingSnapshot(vault: any) {
    const target = settledClaims[`${wallet.account?.address}:${vault.address}`];
    return !!target && BigInt(vault.recipient?.claimed || "0") < BigInt(target);
  }
  return (
    <>
      <Heading
        eyebrow="Fees & royalties"
        title="Value from use."
        description="Actual claimable fees, separate from project and reserve capital."
      />
      <Status query={q} />
      {q.data && (
        <>
          {q.data.vaults.length ? (
            q.data.vaults.map((v: any) => (
              <div className="list-row" key={v.address}>
                <span>
                  <strong>{short(v.address)}</strong>
                  <small>
                    WSOL · Finalized snapshot {v.context_slot || "pending"}
                  </small>
                </span>
                <span>
                  {awaitingSnapshot(v)
                    ? "Updating finalized snapshot…"
                    : `${units(v.recipient?.pending)} pending`}
                </span>
                <button
                  className="secondary"
                  aria-busy={claiming}
                  disabled={
                    tx.busy ||
                    claiming ||
                    awaitingSnapshot(v) ||
                    !v.recipient?.pending ||
                    v.recipient.pending === "0"
                  }
                  onClick={() => claim(v.address)}
                >
                  Claim ↗
                </button>
              </div>
            ))
          ) : (
            <Empty
              title="Earnings follow activity."
              text="Verified fee vaults and finalized claims appear here."
            />
          )}
          <JsonView
            value={q.data.finalized_claims}
            label="Finalized payout ledger"
          />
        </>
      )}
      {launches.data?.items.length > 0 && (
        <>
          <div className="section-row">
            <h2>Collect trading fees into DFS</h2>
          </div>
          {launches.data!.items.map((l: any) => (
            <div className="list-row" key={l.id}>
              <strong>{l.metadata.name}</strong>
              {["dbc", "damm_v2"].map((protocol) => (
                <button
                  key={protocol}
                  className="secondary"
                  disabled={tx.busy}
                  onClick={async () => {
                    try {
                      await tx.run(
                        await request(`/launches/${l.id}/fees/sweep/prepare`, {
                          protocol,
                        }),
                      );
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  }}
                >
                  Sweep {protocol === "dbc" ? "DBC" : "DAMM"}
                </button>
              ))}
            </div>
          ))}
        </>
      )}
      {error && <p className="error">{error}</p>}
    </>
  );
}
export function Activity() {
  const wallet = useWallet();
  const [offset, setOffset] = useState(0);
  const q = useQuery({
    queryKey: ["activity", wallet.user?.wallet, offset],
    queryFn: () => request(`/me/activity?offset=${offset}&limit=24`),
    enabled: !!wallet.user,
    refetchInterval: 4000,
  });
  return (
    <>
      <Heading eyebrow="Activity" title="Every step, accounted for." />
      <Status query={q} />
      {q.data &&
        (q.data.items.length ? (
          q.data.items.map((t: any) => (
            <Link className="list-row" key={t.id} to={`/activity/${t.id}`}>
              <span>
                <strong>{t.summary.action || t.summary.kind}</strong>
                <small>{new Date(t.created_at).toLocaleString()}</small>
              </span>
              <span className="badge">{t.state}</span>
              <span>{short(t.signature)}</span>
            </Link>
          ))
        ) : (
          <Empty title="A clear record starts here." />
        ))}
      <div className="pagination">
        <button disabled={!offset} onClick={() => setOffset(offset - 24)}>
          ← Previous
        </button>
        <button
          disabled={q.data?.next_offset == null}
          onClick={() => setOffset(q.data!.next_offset)}
        >
          Next →
        </button>
      </div>
    </>
  );
}
export function TransactionDetail() {
  const { id } = useParams();
  const wallet = useWallet();
  const q = useQuery({
    queryKey: ["transaction", id],
    queryFn: () => request(`/transactions/${id}`),
    enabled: !!wallet.user,
    refetchInterval: 2500,
  });
  return (
    <>
      <Heading eyebrow="Transaction receipt" title="The exact record." />
      <Status query={q} />
      {q.data && (
        <>
          <div className="metrics">
            <Metric label="State" value={q.data.state} />
            <Metric label="Network" value={q.data.cluster} />
          </div>
          <p className="hash">{q.data.signature || "Not submitted"}</p>
          <Notice>
            Submitted and confirmed transactions remain pending until finality.
            Failed or expired transactions require fresh preparation from their
            original workflow.
          </Notice>
          <JsonView
            value={q.data.summary}
            label="Signed action and execution bounds"
          />
        </>
      )}
    </>
  );
}
export function WalletSettings() {
  const wallet = useWallet();
  return (
    <>
      <Heading eyebrow="Wallet & network" title="Your connection." />
      <div className="metrics">
        <Metric
          label="Application network"
          value={networkFor(wallet.cluster)?.label || wallet.cluster}
        />
        <Metric label="Wallet" value={wallet.wallet?.name || "Disconnected"} />
        <Metric
          label="Session"
          value={wallet.user ? "Authenticated" : "Public browsing"}
        />
      </div>
      <WalletNetwork />
      {wallet.account && <p className="hash">{wallet.account.address}</p>}
      <div className="actions">
        {wallet.account && !wallet.user && (
          <button
            className="primary"
            disabled={wallet.busy || !wallet.networkSupported}
            onClick={() => wallet.login().catch(() => {})}
          >
            Authenticate wallet
          </button>
        )}
        {wallet.wallet && (
          <button className="secondary" onClick={() => wallet.disconnect()}>
            Disconnect
          </button>
        )}
      </div>
      {wallet.error && <p className="error">{wallet.error}</p>}
    </>
  );
}
