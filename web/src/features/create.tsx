import React, { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQuery } from "@tanstack/react-query";
import { useDraft } from "../app/draft";
import { useWallet } from "../app/wallet";
import { request, Json, units, short } from "../app/client";
import {
  Heading,
  Field,
  Notice,
  JsonView,
  Metric,
  Status,
} from "../app/components";
import { mechanisms } from "../app/economy";
import { EconomyEditor } from "./editor";
import { LiquidityVisual } from "../LiquidityVisual";
const identity = z.object({
  name: z.string().min(1).max(32),
  symbol: z.string().min(1).max(10),
  uri: z
    .string()
    .max(200)
    .refine(
      (v) => v.startsWith("https://") || v.startsWith("ipfs://"),
      "Use an HTTPS or IPFS metadata URI.",
    ),
});
const steps = ["identity", "mechanism", "parameters", "preview", "review"];
export function CreateToken() {
  const { step = "identity" } = useParams();
  const nav = useNavigate();
  const { draft, update } = useDraft();
  const wallet = useWallet();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const form = useForm({
    resolver: zodResolver(identity),
    defaultValues: { name: draft.name, symbol: draft.symbol, uri: draft.uri },
  });
  const preview = useQuery({
    queryKey: ["preview", draft.economy],
    queryFn: () =>
      request("/previews", {
        scenario: "graduation",
        economy: draft.economy,
        orders: [],
        inputs: {},
      }),
    enabled: step === "preview" || step === "review",
    retry: false,
  });
  async function launch() {
    setBusy(true);
    setError("");
    try {
      if (!wallet.user) await wallet.login();
      if (!identity.safeParse(draft).success)
        throw Error("Complete token identity first.");
      if (draft.economy.mechanism === "asset_quote")
        throw Error("Asset quote launches require an accepted quote adapter.");
      let version = draft.versionId;
      if (!version) {
        let model = draft.modelId;
        const economy =
          draft.economy.fee_policy.author === "11111111111111111111111111111111"
            ? {
                ...draft.economy,
                fee_policy: {
                  ...draft.economy.fee_policy,
                  author: wallet.account!.address,
                },
              }
            : draft.economy;
        if (!model) {
          const r = await request("/models", {
            name: draft.modelName,
            economy,
          });
          model = r.id;
          update({ modelId: model, revision: r.revision });
        } else {
          const r = await request(
            `/models/${model}`,
            { name: draft.modelName, economy, revision: draft.revision ?? 1 },
            { method: "PATCH" },
          );
          update({ revision: r.revision });
        }
        const published = await request(`/models/${model}/publish`, {});
        version = published.id;
        update({ versionId: version });
      }
      const r = await request(
        "/factory/launches",
        {
          model_version_id: version,
          name: draft.name,
          symbol: draft.symbol,
          uri: draft.uri,
          reviewers: draft.reviewers,
        },
        { headers: { "Idempotency-Key": draft.launchKey } },
      );
      nav(`/creator/launches/${r.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const compiled = preview.data?.result?.compiled;
  return (
    <>
      <Heading
        eyebrow="Creator / New launch"
        title="Make an economy."
        description="A familiar launch. Rules that are yours."
      />
      <div className="wizard">
        <aside className="wizard-steps">
          {steps.map((s, i) => (
            <Link
              key={s}
              className={s === step ? "selected" : ""}
              to={`/create/${s}`}
            >
              <span>{String(i + 1).padStart(2, "0")}</span>
              {s === "mechanism"
                ? "Choose a model"
                : s === "review"
                  ? "Review & launch"
                  : s.charAt(0).toUpperCase() + s.slice(1)}
            </Link>
          ))}
          <small>Draft saved on this device.</small>
        </aside>
        <section className="wizard-content">
          {step === "identity" && (
            <form
              onSubmit={form.handleSubmit((v) => {
                update(v);
                nav("/create/mechanism");
              })}
            >
              <h2>The beginning.</h2>
              <div className="form-grid">
                <Field label="Token name">
                  <input
                    {...form.register("name")}
                    placeholder="Your community, your name"
                  />
                  {form.formState.errors.name && (
                    <small>{form.formState.errors.name.message}</small>
                  )}
                </Field>
                <Field label="Symbol">
                  <input {...form.register("symbol")} placeholder="TOKEN" />
                  {form.formState.errors.symbol && (
                    <small>{form.formState.errors.symbol.message}</small>
                  )}
                </Field>
                <Field
                  label="Metadata URI"
                  hint="A published JSON document containing your image and description"
                >
                  <input
                    {...form.register("uri")}
                    placeholder="https://…/metadata.json"
                  />
                  {form.formState.errors.uri && (
                    <small>{form.formState.errors.uri.message}</small>
                  )}
                </Field>
              </div>
              <button className="primary">Continue ↗</button>
            </form>
          )}
          {step === "mechanism" && (
            <>
              <h2>Choose what it becomes.</h2>
              <div className="mechanism-grid">
                {mechanisms.map((m) => (
                  <button
                    className={`mechanism ${draft.economy.mechanism === m.id ? "selected" : ""}`}
                    key={m.id}
                    onClick={() =>
                      update({
                        economy: {
                          ...draft.economy,
                          mechanism: m.id,
                          migration_fee_pct:
                            m.id === "funding" || m.id === "backed" ? 20 : 0,
                          module:
                            m.id === "funding"
                              ? {
                                  reviewer_threshold: 2,
                                  milestones: [
                                    {
                                      weight_bps: 5000,
                                      deadline_offset: "2592000",
                                    },
                                    {
                                      weight_bps: 5000,
                                      deadline_offset: "5184000",
                                    },
                                  ],
                                }
                              : m.id === "backed"
                                ? { reviewer_threshold: 0, milestones: [] }
                                : undefined,
                        },
                      })
                    }
                  >
                    <span className="eyebrow">{m.number}</span>
                    <h2>{m.title}</h2>
                    <p>{m.text}</p>
                    {m.id === "asset_quote" && (
                      <small>Research only · adapter pending</small>
                    )}
                  </button>
                ))}
              </div>
              <div className="actions">
                <Link className="secondary" to="/models">
                  Use a published model
                </Link>
                <Link className="primary" to="/create/parameters">
                  Continue ↗
                </Link>
              </div>
            </>
          )}
          {step === "parameters" && (
            <>
              <EconomyEditor
                value={draft.economy}
                onChange={(economy) => update({ economy })}
              />
              {draft.economy.mechanism === "funding" && (
                <Field
                  label="Reviewer wallets"
                  hint="3–5 distinct addresses, one per line; the beneficiary cannot review"
                >
                  <textarea
                    value={draft.reviewers.join("\n")}
                    onChange={(e) =>
                      update({
                        reviewers: e.target.value.split(/\s+/).filter(Boolean),
                      })
                    }
                  />
                </Field>
              )}
              <div className="actions">
                <Link className="primary" to="/create/preview">
                  Simulate economy ↗
                </Link>
              </div>
            </>
          )}
          {(step === "preview" || step === "review") && (
            <>
              <div className="section-row">
                <h2>
                  {step === "preview"
                    ? "Before the first trade."
                    : `${draft.name || "Your token"} / ${draft.symbol || "TOKEN"}`}
                </h2>
                <span className="badge">{draft.economy.mechanism}</span>
              </div>
              <LiquidityVisual
                capitalPercent={draft.economy.migration_fee_pct}
                segments={draft.economy.curve.length}
              />
              <Status query={preview} />
              {compiled && (
                <div className="metrics">
                  <Metric
                    label="Graduation"
                    value={units(draft.economy.migration_quote_threshold)}
                    unit="SOL"
                  />
                  <Metric
                    label="Destination liquidity"
                    value={units(compiled.pool_quote)}
                    unit="SOL"
                  />
                  <Metric
                    label="Module capital"
                    value={units(compiled.migration_allocation)}
                    unit="SOL"
                  />
                </div>
              )}
              {preview.data?.status !== "completed" && preview.data && (
                <Notice>
                  {preview.data.reason || preview.data.issues?.join("; ")}
                </Notice>
              )}
              <Notice>
                {draft.economy.mechanism === "backed"
                  ? "Redemption activates after verified migration and reserve funding. Payout is a share of actual remaining reserves; all unburned supply counts."
                  : draft.economy.mechanism === "funding"
                    ? "Project funds activate after migration. Reviewer majority releases milestones; rejection or expiry enables remaining-capital burn refunds."
                    : "Trading fees and permanently locked liquidity follow the published model."}
              </Notice>
              <JsonView
                value={preview.data}
                label="Simulation evidence and assumptions"
              />
              {step === "preview" ? (
                <div className="actions">
                  <Link className="secondary" to="/research">
                    Run more scenarios
                  </Link>
                  <Link className="primary" to="/create/review">
                    Review launch ↗
                  </Link>
                </div>
              ) : (
                <>
                  <div className="review-lines">
                    <p>
                      Author{" "}
                      <span>{short(draft.economy.fee_policy.author)}</span>
                    </p>
                    <p>
                      Claimable fee shares{" "}
                      <span>
                        {draft.economy.fee_policy.launcher_bps / 100}% launcher
                        / {draft.economy.fee_policy.author_bps / 100}% author /{" "}
                        {draft.economy.fee_policy.platform_bps / 100}% platform
                      </span>
                    </p>
                    <p>
                      Network <span>{wallet.cluster}</span>
                    </p>
                    <p>
                      Quote <span>WSOL</span>
                    </p>
                  </div>
                  <button
                    className="primary"
                    disabled={
                      busy ||
                      preview.data?.status !== "completed" ||
                      draft.economy.mechanism === "asset_quote"
                    }
                    onClick={launch}
                  >
                    {busy ? "Preparing workflow…" : "Create launch workflow ↗"}
                  </button>
                  <small className="block">
                    The following screen requests wallet signatures for each
                    simulated step.
                  </small>
                </>
              )}
            </>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </section>
      </div>
    </>
  );
}
