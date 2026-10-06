import { newId } from "../app/id";
import React, { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { request, download, Json, units } from "../app/client";
import { useDraft } from "../app/draft";
import { useWallet } from "../app/wallet";
import {
  Heading,
  Field,
  JsonView,
  Notice,
  Metric,
  Status,
} from "../app/components";
import { LiquidityVisual } from "../LiquidityVisual";
const scenarios = [
  "graduation",
  "single_swap",
  "sequential_trading",
  "whale_sell",
  "redemption",
  "funding",
  "compounding",
  "royalty_fork",
  "historical_replay",
];
export function SimulationLab() {
  const { draft } = useDraft();
  const wallet = useWallet();
  const [scenario, setScenario] = useState("graduation");
  const [orders, setOrders] = useState(
    '[{"direction":"buy","amount":"100000000","exact_out":false}]',
  );
  const [inputs, setInputs] = useState("{}");
  const [result, setResult] = useState<Json>();
  const [comparison, setComparison] = useState<Json>();
  const [job, setJob] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function simulate(queued = false) {
    setBusy(true);
    setError("");
    try {
      const c = {
        scenario,
        economy: draft.economy,
        orders: ["graduation", "full_curve"].includes(scenario)
          ? []
          : JSON.parse(orders),
        inputs: JSON.parse(inputs),
      };
      if (queued) {
        if (!wallet.user) await wallet.login();
        const j = await request(
          "/simulations",
          {
            evidence: "analytical",
            seed: "studio",
            clock: 0,
            cases: [c],
            frozen_paths: [],
          },
          { headers: { "Idempotency-Key": newId() } },
        );
        setJob(j.id);
      } else setResult(await request("/previews", c));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const c = result?.result?.compiled;
  return (
    <>
      <Heading
        eyebrow="Simulation Lab"
        title="Ask better questions."
        description="Stress an economy before asking anyone to fund it."
        action={
          <Link className="secondary" to="/studio">
            Edit parameters ↗
          </Link>
        }
      />
      <div className="research-layout">
        <section>
          <Field label="Scenario">
            <select
              value={scenario}
              onChange={(e) => setScenario(e.target.value)}
            >
              {scenarios.map((s) => (
                <option key={s} value={s}>
                  {s.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Order sequence"
            hint="Atomic amounts, explicit buy/sell direction"
          >
            <textarea
              className="code-input"
              value={orders}
              onChange={(e) => setOrders(e.target.value)}
            />
          </Field>
          <Field
            label="Scenario inputs"
            hint="Redemption: reserve, outstanding_supply, burn. Funding: escrow_reserve, requested_release, approved. Amounts use atomic units."
          >
            <textarea
              className="code-input"
              value={inputs}
              onChange={(e) => setInputs(e.target.value)}
            />
          </Field>
          <div className="actions">
            <button
              className="primary"
              disabled={busy}
              onClick={() => simulate()}
            >
              Run preview ↗
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => simulate(true)}
            >
              Save research run
            </button>
          </div>
          {job && (
            <Link className="block text-button" to={`/research/${job}`}>
              Open research job ↗
            </Link>
          )}
          {error && <p className="error">{error}</p>}
        </section>
        <section className="research-results">
          <LiquidityVisual
            capitalPercent={draft.economy.migration_fee_pct}
            segments={draft.economy.curve.length}
          />
          <Notice>
            Analytical research uses integer arithmetic and explicit
            assumptions. It does not certify deployment or predict returns.
          </Notice>
          {result && (
            <>
              <div className="metrics">
                <Metric label="Result" value={result.status} />
                <Metric label="Evidence" value={result.evidence} />
                {c && (
                  <Metric
                    label="DAMM quote"
                    value={units(c.pool_quote)}
                    unit="SOL"
                  />
                )}
              </div>
              <JsonView value={result} label="Inspect calculated results" />
              <div className="actions">
                <button
                  className="secondary"
                  onClick={() => setComparison(result)}
                >
                  Pin as baseline
                </button>
                <button
                  onClick={() =>
                    download("simulation.json", { result, comparison })
                  }
                >
                  Export evidence ↓
                </button>
              </div>
            </>
          )}
          {comparison && (
            <JsonView value={comparison} label="Pinned comparison baseline" />
          )}
        </section>
      </div>
    </>
  );
}
export function ResearchResult() {
  const { id } = useParams();
  const wallet = useWallet();
  const q = useQuery({
    queryKey: ["research", id],
    queryFn: () => request(`/simulations/${id}`),
    enabled: !!wallet.user,
    refetchInterval: (q) =>
      ["queued", "running"].includes(q.state.data?.status) ? 1500 : false,
  });
  const results = useQuery({
    queryKey: ["research-export", id],
    queryFn: () => request(`/simulations/${id}/export`),
    enabled: q.data?.status === "completed",
  });
  const [error, setError] = useState("");
  const [cancelling, setCancelling] = useState(false);
  return (
    <>
      <Heading eyebrow="Research evidence" title="Your experiment." />
      <Status query={q} />
      {q.data && (
        <>
          <div className="metrics">
            <Metric label="Status" value={q.data.status} />
            <Metric
              label="Completed"
              value={`${q.data.progress} / ${q.data.total}`}
            />
          </div>
          {["queued", "running"].includes(q.data.status) && (
            <button
              className="secondary"
              disabled={cancelling}
              onClick={async () => {
                setCancelling(true);
                setError("");
                try {
                  await request(`/simulations/${id}/cancel`, {});
                  await q.refetch();
                } catch (e) {
                  const latest = await q.refetch();
                  if (
                    latest.error ||
                    ![
                      "completed",
                      "cancelled",
                      "failed",
                      "unavailable",
                    ].includes(latest.data?.status)
                  )
                    setError((e as Error).message);
                } finally {
                  setCancelling(false);
                }
              }}
            >
              {cancelling ? "Cancelling…" : "Cancel run"}
            </button>
          )}
          <JsonView value={results.data || q.data} label="Research results" />
          <button
            onClick={() =>
              download(`research-${id}.json`, results.data || q.data)
            }
          >
            Export ↓
          </button>
        </>
      )}
      {error && <p className="error">{error}</p>}
    </>
  );
}
