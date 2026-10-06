import React, { useState, useRef } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { request, atomic, units, short } from "../app/client";
import { useWallet } from "../app/wallet";
import { useTransactions } from "../app/transactions";
import {
  Heading,
  Status,
  CardLink,
  Empty,
  Metric,
  Field,
  JsonView,
  Notice,
} from "../app/components";
export function Explore() {
  const [search, setSearch] = useState("");
  const [mechanism, setMechanism] = useState("");
  const [offset, setOffset] = useState(0);
  const q = useQuery({
    queryKey: ["tokens", search, mechanism, offset],
    queryFn: () =>
      request(
        `/tokens?search=${encodeURIComponent(search)}&mechanism=${mechanism}&offset=${offset}&limit=24`,
      ),
    refetchInterval: 10000,
  });
  return (
    <>
      <Heading
        eyebrow="Discover economies"
        title="More than a token."
        description="Communities, projects and reserves. One open market."
        action={
          <Link className="primary" to="/create/identity">
            Launch an economy ↗
          </Link>
        }
      />
      <div className="filters">
        <input
          aria-label="Search tokens"
          value={search}
          placeholder="Search a name or symbol…"
          onChange={(e) => {
            setSearch(e.target.value);
            setOffset(0);
          }}
        />
        <select
          aria-label="Filter mechanism"
          value={mechanism}
          onChange={(e) => {
            setMechanism(e.target.value);
            setOffset(0);
          }}
        >
          <option value="">All economies</option>
          <option value="meme">Community</option>
          <option value="funding">Funding</option>
          <option value="backed">Reserve</option>
        </select>
      </div>
      <Status query={q} />
      {q.data &&
        (q.data.items.length ? (
          <div className="cards">
            {q.data.items.map((t: any) => (
              <CardLink
                key={t.address}
                to={`/tokens/${t.address}`}
                title={t.metadata.name}
                subtitle={`${t.metadata.symbol} · ${t.chain_state ? ["Declared", "Config ready", "DBC trading", "Migrated", "Module funded"][t.chain_state.phase] : "Awaiting on-chain launch"}`}
                badge={t.metadata.mechanism}
              />
            ))}
          </div>
        ) : (
          <Empty
            title="The next economy starts here."
            text="No launches match this selection."
            action={
              <Link className="secondary" to="/create/identity">
                Create a token
              </Link>
            }
          />
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
export function TokenDetail() {
  const { address } = useParams();
  const q = useQuery({
    queryKey: ["token", address],
    queryFn: () => request(`/tokens/${address}`),
    refetchInterval: 5000,
  });
  const wallet = useWallet();
  const tx = useTransactions();
  const [side, setSide] = useState("buy");
  const [amount, setAmount] = useState("0.1");
  const [slippage, setSlippage] = useState(100);
  const [error, setError] = useState("");
  const [preparing, setPreparing] = useState(false);
  const preparingRef = useRef(false);
  let raw = "";
  try {
    raw = atomic(
      amount,
      side === "buy" ? 9 : (q.data?.metadata.base_decimals ?? 6),
    );
  } catch {}
  const order = {
    protocol: q.data?.protocol,
    pool: q.data?.pool,
    amount: raw,
    base_for_quote: side === "sell",
    mode:
      side === "buy" && q.data?.protocol === "dbc"
        ? "partial_fill"
        : "exact_in",
    slippage_bps: slippage,
  };
  const quote = useQuery({
    queryKey: ["quote", order],
    queryFn: () => request("/quotes", order),
    enabled: !!raw && !!q.data?.pool,
    staleTime: 0,
    refetchInterval: 6000,
    retry: false,
  });
  async function swap() {
    if (preparingRef.current) return;
    preparingRef.current = true;
    setPreparing(true);
    setError("");
    try {
      if (!wallet.user) await wallet.login();
      const fresh = await quote.refetch();
      if (fresh.error) throw fresh.error;
      await tx.run(await request("/swaps/prepare", order));
      setAmount("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      preparingRef.current = false;
      setPreparing(false);
    }
  }
  const t = q.data;
  return (
    <>
      <Status query={q} />
      {t && (
        <>
          <Heading
            eyebrow={`${t.metadata.mechanism} / ${t.protocol === "dbc" ? "Price discovery" : "DAMM v2"}`}
            title={t.metadata.name}
            description={`${t.metadata.symbol} · ${short(t.state.base_mint)}`}
            action={
              <Link className="secondary" to={`/models/${t.model_version_id}`}>
                Inspect economy ↗
              </Link>
            }
          />
          <div className="trade-layout">
            <section className="market-panel">
              <div className="metrics">
                <Metric
                  label="Market"
                  value={t.protocol === "dbc" ? "DBC" : "DAMM v2"}
                />
                <Metric
                  label="Capital rights"
                  value={
                    t.metadata.mechanism === "meme"
                      ? "Trading only"
                      : t.state.phase === 4
                        ? "Active"
                        : "Awaiting activation"
                  }
                />
                <Metric label="Finalized slot" value={t.context_slot} />
              </div>
              <MarketChart observations={t.observations} />
              <div className="actions">
                {t.metadata.mechanism === "funding" && (
                  <Link className="secondary" to={`/tokens/${address}/funding`}>
                    Funding & milestones ↗
                  </Link>
                )}
                {t.metadata.mechanism === "backed" && (
                  <Link className="secondary" to={`/tokens/${address}/reserve`}>
                    Reserve & redemption ↗
                  </Link>
                )}
              </div>
              <JsonView
                value={t.state}
                label="Verified launch accounts and lifecycle"
              />
            </section>
            <section className="swap-panel">
              <div className="tabs">
                {["buy", "sell"].map((s) => (
                  <button
                    key={s}
                    className={side === s ? "active" : ""}
                    onClick={() => setSide(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>
              <Field
                label={
                  side === "buy"
                    ? "You pay · WSOL"
                    : `You sell · ${t.metadata.symbol}`
                }
              >
                <input
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </Field>
              <Field label="Slippage tolerance">
                <select
                  value={slippage}
                  onChange={(e) => setSlippage(Number(e.target.value))}
                >
                  <option value="50">0.5%</option>
                  <option value="100">1%</option>
                  <option value="300">3%</option>
                </select>
              </Field>
              <div className="quote-lines">
                <p>
                  Expected output{" "}
                  <span>
                    {units(
                      quote.data?.result?.output,
                      side === "buy" ? t.metadata.base_decimals : 9,
                    )}
                  </span>
                </p>
                <p>
                  Minimum received{" "}
                  <span>
                    {units(
                      quote.data?.minimum_output,
                      side === "buy" ? t.metadata.base_decimals : 9,
                    )}
                  </span>
                </p>
                <p>
                  Native trading fee{" "}
                  <span>{quote.data?.result?.trading_fee || "—"} atomic</span>
                </p>
              </div>
              {quote.error && <p className="error">{quote.error.message}</p>}
              <button
                className="primary full"
                disabled={
                  !quote.data || quote.isFetching || tx.busy || preparing
                }
                onClick={swap}
              >
                {tx.busy || preparing
                  ? "Confirming…"
                  : `${side === "buy" ? "Buy" : "Sell"} ${t.metadata.symbol} ↗`}
              </button>
              <small className="block">
                Uses your WSOL balance.{" "}
                <Link className="text-button" to="/portfolio">
                  Wrap SOL in Portfolio.
                </Link>{" "}
                Fees and rent are reviewed in your wallet.
              </small>
              {error && <p className="error">{error}</p>}
            </section>
          </div>
        </>
      )}
    </>
  );
}
function MarketChart({ observations }: { observations: any[] }) {
  const points =
    observations
      ?.filter((o) => o.state?.sqrt_price)
      .map((o) => {
        const s = Number(o.state.sqrt_price);
        return { slot: o.slot, y: Math.log(s) };
      }) || [];
  if (points.length < 2)
    return (
      <Empty
        title="Price history is forming."
        text="The chart appears after multiple finalized market observations."
      />
    );
  const min = Math.min(...points.map((p) => p.y)),
    max = Math.max(...points.map((p) => p.y));
  const path = points
    .map(
      (p, i) =>
        `${i ? "L" : "M"}${30 + (i / (points.length - 1)) * 760},${250 - ((p.y - min) / (max - min || 1)) * 190}`,
    )
    .join(" ");
  return (
    <div className="price-chart">
      <span className="eyebrow">Observed price movement · log scale</span>
      <svg
        viewBox="0 0 820 300"
        role="img"
        aria-label="Finalized native pool price history"
      >
        <path
          d="M30 60H790 M30 150H790 M30 250H790"
          stroke="var(--line)"
          fill="none"
        />
        <path d={path} fill="none" stroke="var(--blue)" strokeWidth="2" />
      </svg>
      <small>
        Finalized account observations; this is not an OHLC trade feed.
      </small>
    </div>
  );
}
