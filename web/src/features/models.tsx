import React, { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { request, download, short } from "../app/client";
import { useDraft } from "../app/draft";
import { useWallet } from "../app/wallet";
import { useTransactions } from "../app/transactions";
import {
  Heading,
  Empty,
  CardLink,
  Status,
  Field,
  JsonView,
  Notice,
  Metric,
} from "../app/components";
import { EconomyEditor } from "./editor";
export function ModelMarketplace() {
  const [search, setSearch] = useState("");
  const [mechanism, setMechanism] = useState("");
  const [offset, setOffset] = useState(0);
  const q = useQuery({
    queryKey: ["models", offset, search, mechanism],
    queryFn: () =>
      request(
        `/model-versions?limit=24&offset=${offset}&search=${encodeURIComponent(search)}&mechanism=${mechanism}`,
      ),
  });
  return (
    <>
      <Heading
        eyebrow="Model marketplace"
        title="Ideas that compound."
        description="Inspect, copy and build on published economies."
        action={
          <Link className="primary" to="/studio">
            Design a model ↗
          </Link>
        }
      />
      <div className="filters">
        <input
          aria-label="Search models"
          placeholder="Find an economy…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setOffset(0);
          }}
        />
        <select
          aria-label="Model mechanism"
          value={mechanism}
          onChange={(e) => {
            setMechanism(e.target.value);
            setOffset(0);
          }}
        >
          <option value="">All mechanisms</option>
          {["meme", "funding", "backed", "asset_quote"].map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
      </div>
      <Status query={q} />
      {q.data &&
        (q.data.items.length ? (
          <div className="cards">
            {q.data.items.map((m: any) => (
              <CardLink
                key={m.id}
                to={`/models/${m.id}`}
                title={m.name}
                subtitle={`By ${short(m.author)} · Version ${m.version}`}
                badge={m.compiled.economy.mechanism}
              />
            ))}
          </div>
        ) : (
          <Empty
            title="An open canvas."
            text="The first registered economy can be yours."
            action={
              <Link className="secondary" to="/studio">
                Open Economy Studio
              </Link>
            }
          />
        ))}
      <div className="pagination">
        <button
          disabled={!offset}
          onClick={() => setOffset(Math.max(0, offset - 24))}
        >
          ← Previous
        </button>
        <span>{offset / 24 + 1}</span>
        <button
          disabled={q.data?.items.length !== 24}
          onClick={() => setOffset(offset + 24)}
        >
          Next →
        </button>
      </div>
    </>
  );
}
export function ModelDetail() {
  const { id } = useParams();
  const q = useQuery({
    queryKey: ["model", id],
    queryFn: () => request(`/model-versions/${id}`),
  });
  const { update } = useDraft();
  const wallet = useWallet();
  const nav = useNavigate();
  const tx = useTransactions();
  const [error, setError] = useState("");
  const [registering, setRegistering] = useState(false);
  async function register() {
    setRegistering(true);
    setError("");
    try {
      if (!wallet.user) await wallet.login();
      const p = await request(`/factory/models/${id}/next`, {});
      if (p.state !== "complete") await tx.run(p);
      await q.refetch();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRegistering(false);
    }
  }
  async function useModel(fork: boolean) {
    try {
      const m = q.data!;
      if (fork) {
        if (!wallet.user) await wallet.login();
        const r = await request(`/model-versions/${id}/fork`, {
          name: "Forked economy",
        });
        update({
          economy: m.economy,
          modelId: r.id,
          revision: r.revision,
          modelName: "Forked economy",
        });
        nav("/studio");
      } else {
        update({
          economy: m.economy,
          versionId: id,
          modelId: undefined,
          modelName: "Registered economy",
        });
        nav("/create/identity");
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <Heading eyebrow="Immutable model version" title="A closer look." />
      <Status query={q} />
      {q.data && (
        <>
          <div className="metrics">
            <Metric label="Mechanism" value={q.data.economy.mechanism} />
            <Metric
              label="Author"
              value={short(q.data.economy.fee_policy.author)}
            />
            <Metric
              label="Trading fee"
              value={q.data.economy.trade_fee_bps / 100}
              unit="%"
            />
          </div>
          <Notice>
            Official forks keep the original author and fee policy. A published
            database version becomes launch-ready only after its executable
            model is registered on-chain.
          </Notice>
          <div className="actions">
            {q.data.publisher === wallet.account?.address &&
              !q.data.registry_address && (
                <button
                  className="primary"
                  disabled={registering || tx.busy}
                  onClick={register}
                >
                  {registering
                    ? "Preparing registration…"
                    : "Continue on-chain registration ↗"}
                </button>
              )}
            <button
              className="primary"
              disabled={
                !q.data.registry_address &&
                q.data.publisher !== wallet.account?.address
              }
              onClick={() => useModel(false)}
            >
              Use this economy ↗
            </button>
            <button className="secondary" onClick={() => useModel(true)}>
              Fork into Studio
            </button>
            <button
              onClick={() =>
                download(`economy-${id}.json`, {
                  format: "depthguard.model.v1",
                  version_id: id,
                  content_hash: q.data!.content_hash,
                  economy: q.data!.economy,
                })
              }
            >
              Export JSON ↓
            </button>
          </div>
          <JsonView value={q.data.economy} label="Inspect economy parameters" />
          <JsonView
            value={q.data.compiled}
            label="Compiled model and evidence"
          />
          <p className="hash">{q.data.content_hash}</p>
        </>
      )}
      {error && <p className="error">{error}</p>}
    </>
  );
}
export function EconomyStudio() {
  const { draft, update, reset } = useDraft();
  const wallet = useWallet();
  const [error, setError] = useState("");
  const [result, setResult] = useState<any>();
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  async function save() {
    setBusy(true);
    setError("");
    try {
      if (!wallet.user) await wallet.login();
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
      if (
        !draft.modelId &&
        economy.fee_policy.author !== wallet.account!.address
      )
        throw Error(
          "Use a published model export or Fork to preserve another author's attribution.",
        );
      const r = draft.modelId
        ? await request(
            `/models/${draft.modelId}`,
            { name: draft.modelName, economy, revision: draft.revision },
            { method: "PATCH" },
          )
        : await request("/models", { name: draft.modelName, economy });
      update({ economy, modelId: r.id || draft.modelId, revision: r.revision });
      setResult({ saved: true, revision: r.revision });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function importModel(file?: File) {
    if (!file) return;
    try {
      if (file.size > 65536) throw Error("Model import is limited to 64 KiB.");
      const payload = JSON.parse(await file.text());
      if (payload.format === "depthguard.model.v1") {
        if (!/^[0-9a-f-]{36}$/i.test(payload.version_id))
          throw Error("Invalid published model version.");
        const source = await request(`/model-versions/${payload.version_id}`);
        if (
          source.content_hash !== payload.content_hash ||
          canonical(source.economy) !== canonical(payload.economy)
        )
          throw Error(
            "The imported file does not match the published economy. Download an unchanged source export.",
          );
        if (!wallet.user) await wallet.login();
        const fork = await request(
          `/model-versions/${payload.version_id}/fork`,
          { name: `Imported ${source.name}`.slice(0, 80) },
        );
        reset(wallet.account?.address);
        update({
          economy: source.economy,
          modelId: fork.id,
          revision: fork.revision,
          modelName: `Imported ${source.name}`.slice(0, 80),
        });
        setResult({
          imported: true,
          source_version_id: payload.version_id,
          author_preserved: true,
        });
        setError("");
        return;
      }
      const economy = payload;
      const r = await request("/economies/validate", economy);
      if (!r.valid) throw Error(r.issues.join("; "));
      reset(wallet.account?.address);
      update({ economy, modelId: undefined, versionId: undefined });
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <Heading
        eyebrow="Economy Studio"
        title="Write the rules."
        description="Edit, validate, simulate and publish reusable models."
        action={
          <Link className="primary" to="/research">
            Simulation Lab ↗
          </Link>
        }
      />
      <div className="studio-toolbar">
        <Field label="Model name">
          <input
            value={draft.modelName}
            onChange={(e) => update({ modelName: e.target.value })}
          />
        </Field>
        <label className="secondary">
          Import JSON
          <input
            type="file"
            accept="application/json"
            className="file-input"
            onChange={(e) => importModel(e.target.files?.[0])}
          />
        </label>
        <button
          className="secondary"
          onClick={() => download("economy.json", draft.economy)}
        >
          Export ↓
        </button>
        <button onClick={() => reset(wallet.account?.address)}>
          New model
        </button>
      </div>
      <section className="editor-sheet">
        <EconomyEditor
          value={draft.economy}
          onChange={(economy) => update({ economy })}
        />
        <div className="actions">
          <button
            className="secondary"
            onClick={async () => {
              try {
                setResult(await request("/economies/validate", draft.economy));
                setError("");
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Validate
          </button>
          <button className="secondary" disabled={busy} onClick={save}>
            Save draft
          </button>
          <button className="primary" onClick={() => nav("/models/publish")}>
            Review publication ↗
          </button>
        </div>
        {error && <p className="error">{error}</p>}
        {result && (
          <JsonView
            value={result}
            label={result.saved ? "Draft saved" : "Validation result"}
          />
        )}
      </section>
    </>
  );
}
export function PublishModel() {
  const { draft, update } = useDraft();
  const wallet = useWallet();
  const nav = useNavigate();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const q = useQuery({
    queryKey: ["compile", draft.economy],
    queryFn: () => request("/economies/compile", draft.economy),
    retry: false,
  });
  async function publish() {
    setBusy(true);
    try {
      if (!wallet.user) await wallet.login();
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
      let id = draft.modelId;
      if (!id) {
        const r = await request("/models", { name: draft.modelName, economy });
        id = r.id;
        update({ economy, modelId: id, revision: r.revision });
      } else {
        const r = await request(
          `/models/${id}`,
          { name: draft.modelName, economy, revision: draft.revision },
          { method: "PATCH" },
        );
        update({ revision: r.revision });
      }
      const r = await request(`/models/${id}/publish`, {});
      update({ versionId: r.id });
      nav(`/models/${r.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Heading
        eyebrow="Publication"
        title="Let others build on it."
        description={draft.modelName}
      />
      <Status query={q} />
      <Notice>
        Publication creates an immutable model version. Executable registration
        occurs through the factory signing workflow; royalties are enforced on
        launches using its registered model.
      </Notice>
      <JsonView value={draft.economy} label="Terms to publish" />
      <div className="actions">
        <Link className="secondary" to="/studio">
          Back to editing
        </Link>
        <button
          className="primary"
          disabled={busy || !q.data}
          onClick={publish}
        >
          Publish version ↗
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </>
  );
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
