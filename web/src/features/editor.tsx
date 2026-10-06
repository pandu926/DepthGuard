import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { request, Economy } from "../app/client";
import { NativeParameterEditor } from "./native-editor";
import { Field, JsonView } from "../app/components";
export function EconomyEditor({
  value,
  onChange,
}: {
  value: Economy;
  onChange(v: Economy): void;
}) {
  const [advanced, setAdvanced] = useState(false);
  const [raw, setRaw] = useState("");
  const [error, setError] = useState("");
  const [nativeResult, setNativeResult] = useState<any>();
  const parameters = useQuery({
    queryKey: ["parameters"],
    queryFn: () => request("/parameters"),
    enabled: advanced,
  });
  const edit = (key: keyof Economy, next: any) =>
    onChange({ ...value, [key]: next });
  let nativeValue: any;
  try {
    nativeValue = JSON.parse(raw);
  } catch {}
  return (
    <>
      <div className="section-row">
        <h2>Economic parameters</h2>
        <button
          className="text-button"
          onClick={() => {
            setAdvanced(!advanced);
            if (!advanced)
              request("/economies/native-parameters", value)
                .then((r) => setRaw(JSON.stringify(r.parameters, null, 2)))
                .catch((e) => setError(e.message));
          }}
        >
          {advanced ? "Close advanced" : "Advanced controls ↗"}
        </button>
      </div>
      <div className="form-grid">
        <Field
          label="Graduation threshold"
          hint="Atomic quote units; 1 SOL = 1,000,000,000"
        >
          <input
            inputMode="numeric"
            value={value.migration_quote_threshold}
            onChange={(e) => edit("migration_quote_threshold", e.target.value)}
          />
        </Field>
        <Field label="Supply" hint="Atomic base token units">
          <input
            inputMode="numeric"
            value={value.supply}
            onChange={(e) => edit("supply", e.target.value)}
          />
        </Field>
        <Field label="Token decimals">
          <select
            value={value.base_decimals}
            onChange={(e) => edit("base_decimals", Number(e.target.value))}
          >
            {[6, 7, 8, 9].map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </Field>
        <Field label="Trading fee" hint="Basis points; 100 bps = 1%">
          <input
            type="number"
            min="25"
            max="1000"
            value={value.trade_fee_bps}
            onChange={(e) => edit("trade_fee_bps", Number(e.target.value))}
          />
        </Field>
        <Field
          label="Capital allocation"
          hint="Percent of graduation quote assigned to the module"
        >
          <input
            type="number"
            min="0"
            max="99"
            value={value.migration_fee_pct}
            onChange={(e) => edit("migration_fee_pct", Number(e.target.value))}
            disabled={
              value.mechanism === "meme" || value.mechanism === "asset_quote"
            }
          />
        </Field>
        <Field
          label="Fee compounding"
          hint="Basis points; 10,000 = all pool fees compounded"
        >
          <input
            type="number"
            min="0"
            max="10000"
            value={value.compounding_fee_bps}
            onChange={(e) =>
              edit("compounding_fee_bps", Number(e.target.value))
            }
          />
        </Field>
        <Field label="Starting square-root price" hint="Native Q64 integer">
          <input
            value={value.sqrt_start_price}
            onChange={(e) => edit("sqrt_start_price", e.target.value)}
          />
        </Field>
        <Field
          label="Quote decimals"
          hint="The executable factory profile uses WSOL"
        >
          <input value={value.quote_decimals} readOnly />
        </Field>
      </div>
      <div className="section-row">
        <h2>Curve segments</h2>
        <button
          className="secondary"
          disabled={value.curve.length >= 16}
          onClick={() =>
            edit("curve", [
              ...value.curve,
              {
                sqrt_price: (
                  BigInt(value.curve.at(-1)?.sqrt_price || "1") * 2n
                ).toString(),
                liquidity: value.curve.at(-1)?.liquidity || "1",
              },
            ])
          }
        >
          Add segment +
        </button>
      </div>
      <div className="segment-header">
        <span>Segment</span>
        <span>Upper square-root price · Q64</span>
        <span>Liquidity · native integer</span>
      </div>
      {value.curve.map((segment, i) => (
        <div className="segment" key={i}>
          <span>{String(i + 1).padStart(2, "0")}</span>
          <input
            aria-label={`Segment ${i + 1} price`}
            value={segment.sqrt_price}
            onChange={(e) =>
              edit(
                "curve",
                value.curve.map((s, j) =>
                  j === i ? { ...s, sqrt_price: e.target.value } : s,
                ),
              )
            }
          />
          <input
            aria-label={`Segment ${i + 1} liquidity`}
            value={segment.liquidity}
            onChange={(e) =>
              edit(
                "curve",
                value.curve.map((s, j) =>
                  j === i ? { ...s, liquidity: e.target.value } : s,
                ),
              )
            }
          />
          <button
            aria-label={`Remove segment ${i + 1}`}
            disabled={value.curve.length === 1}
            onClick={() =>
              edit(
                "curve",
                value.curve.filter((_, j) => j !== i),
              )
            }
          >
            ×
          </button>
        </div>
      ))}
      {value.mechanism === "funding" && value.module && (
        <>
          <div className="section-row">
            <h2>Milestone policy</h2>
            <button
              onClick={() =>
                edit("module", {
                  ...value.module,
                  milestones: [
                    ...value.module!.milestones,
                    {
                      weight_bps: 1000,
                      deadline_offset: String(
                        Number(
                          value.module!.milestones.at(-1)?.deadline_offset || 0,
                        ) + 2592000,
                      ),
                    },
                  ],
                })
              }
            >
              Add milestone +
            </button>
          </div>
          <Field label="Required approvals">
            <select
              value={value.module.reviewer_threshold}
              onChange={(e) =>
                edit("module", {
                  ...value.module,
                  reviewer_threshold: Number(e.target.value),
                })
              }
            >
              <option value="2">2</option>
              <option value="3">3</option>
            </select>
          </Field>
          {value.module.milestones.map((m, i) => (
            <div className="segment" key={i}>
              <span>{i + 1}</span>
              <input
                aria-label={`Milestone ${i + 1} weight bps`}
                value={m.weight_bps}
                onChange={(e) =>
                  edit("module", {
                    ...value.module,
                    milestones: value.module!.milestones.map((s, j) =>
                      j === i
                        ? { ...s, weight_bps: Number(e.target.value) }
                        : s,
                    ),
                  })
                }
              />
              <input
                aria-label={`Milestone ${i + 1} deadline seconds`}
                value={m.deadline_offset}
                onChange={(e) =>
                  edit("module", {
                    ...value.module,
                    milestones: value.module!.milestones.map((s, j) =>
                      j === i ? { ...s, deadline_offset: e.target.value } : s,
                    ),
                  })
                }
              />
              <button
                onClick={() =>
                  edit("module", {
                    ...value.module,
                    milestones: value.module!.milestones.filter(
                      (_, j) => j !== i,
                    ),
                  })
                }
              >
                ×
              </button>
            </div>
          ))}
          <small>
            Weights must total 10,000 bps. Deadlines are increasing seconds from
            activation.
          </small>
        </>
      )}
      <details className="details">
        <summary>Author attribution and fee sharing</summary>
        <div className="form-grid">
          <Field label="Original author">
            <input value={value.fee_policy.author} readOnly />
          </Field>
          {(["launcher_bps", "author_bps", "platform_bps"] as const).map(
            (k) => (
              <Field key={k} label={k.replaceAll("_", " ")}>
                <input value={value.fee_policy[k]} readOnly />
              </Field>
            ),
          )}
        </div>
        <small>
          Official forks preserve the original attribution and royalty policy.
        </small>
      </details>
      {advanced && (
        <section className="advanced">
          <h2>Native configuration</h2>
          <p>
            Edit the full native configuration for structural research. This
            workspace is separate from the launch model; launch support remains
            bounded by the factory profile.
          </p>
          {nativeValue && (
            <NativeParameterEditor
              value={nativeValue}
              onChange={(v) => setRaw(JSON.stringify(v, null, 2))}
            />
          )}
          <textarea
            className="code-input"
            aria-label="Native configuration JSON"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
          />
          <div className="actions">
            <button
              className="secondary"
              onClick={() => {
                try {
                  const v = JSON.parse(raw);
                  if (!v || typeof v !== "object" || Array.isArray(v))
                    throw Error("Configuration must be an object.");
                  request("/native/validate", {
                    protocol: "dbc",
                    root: "ConfigParameters",
                    parameters: v,
                  })
                    .then(setNativeResult)
                    .catch((e) => setError(e.message));
                  setError("");
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Validate native configuration
            </button>
            <button
              onClick={() =>
                request("/economies/native-parameters", value)
                  .then((r) => setRaw(JSON.stringify(r.parameters, null, 2)))
                  .catch((e) => setError(e.message))
              }
            >
              Reset to launch profile
            </button>
          </div>
          {error && <p className="error">{error}</p>}
          {nativeResult && (
            <JsonView
              value={nativeResult}
              label="Structural validation evidence"
            />
          )}
          <JsonView
            value={parameters.data}
            label="Native parameter inventory, units and restrictions"
          />
        </section>
      )}
    </>
  );
}
