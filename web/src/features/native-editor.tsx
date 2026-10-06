import React from "react";
import { Field } from "../app/components";
/** Native research values stay separate from the immutable executable model. */
export function NativeParameterEditor({
  value,
  onChange,
  path = "",
}: {
  value: any;
  onChange(value: any): void;
  path?: string;
}) {
  if (Array.isArray(value))
    return (
      <details className="native-group">
        <summary>
          {path.split(".").at(-1)?.replaceAll("_", " ")} · {value.length}{" "}
          entries
        </summary>
        {value.map((entry, i) => (
          <NativeParameterEditor
            key={i}
            value={entry}
            path={`${path}.${i}`}
            onChange={(next) =>
              onChange(value.map((v, j) => (j === i ? next : v)))
            }
          />
        ))}
      </details>
    );
  if (value && typeof value === "object")
    return (
      <div className={path ? "native-group-body" : "native-grid"}>
        {Object.entries(value).map(([key, field]) => {
          const nextPath = path ? `${path}.${key}` : key;
          const nested = field && typeof field === "object";
          return nested ? (
            <details className="native-group" key={key}>
              <summary>{key.replaceAll("_", " ")}</summary>
              <NativeParameterEditor
                value={field}
                path={nextPath}
                onChange={(next) => onChange({ ...value, [key]: next })}
              />
            </details>
          ) : (
            <NativeParameterEditor
              key={key}
              value={field}
              path={nextPath}
              onChange={(next) => onChange({ ...value, [key]: next })}
            />
          );
        })}
      </div>
    );
  const label = path.split(".").at(-1)?.replaceAll("_", " ") || "Value";
  return (
    <Field
      label={label}
      hint={`${path} · ${typeof value === "string" && /^\d+$/.test(value) ? "native integer string" : typeof value === "number" ? "native integer / enum" : value === null ? "optional; edit JSON to enable" : typeof value}`}
    >
      {typeof value === "boolean" ? (
        <select
          value={String(value)}
          onChange={(e) => onChange(e.target.value === "true")}
        >
          <option value="false">Disabled</option>
          <option value="true">Enabled</option>
        </select>
      ) : value === null ? (
        <input value="None" readOnly />
      ) : (
        <input
          value={String(value)}
          inputMode={typeof value === "number" ? "numeric" : undefined}
          onChange={(e) =>
            onChange(
              typeof value === "number"
                ? Number(e.target.value)
                : e.target.value,
            )
          }
        />
      )}
    </Field>
  );
}
