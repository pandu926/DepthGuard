import React from "react";
import { Link } from "react-router-dom";
export function Heading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <span className="eyebrow">{eyebrow || "DepthGuard"}</span>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {action}
    </div>
  );
}
export function Empty({
  title,
  text,
  action,
}: {
  title: string;
  text?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-symbol">◌</span>
      <h2>{title}</h2>
      <p>{text}</p>
      {action}
    </div>
  );
}
export function Status({
  query,
}: {
  query: { isPending: boolean; error: Error | null; refetch: () => unknown };
}) {
  if (query.isPending) return <div className="skeleton" aria-label="Loading" />;
  if (query.error)
    return (
      <div className="error" role="alert">
        {query.error.message}
        <button onClick={() => query.refetch()}>Try again ↗</button>
      </div>
    );
  return null;
}
export function Notice({ children }: { children: React.ReactNode }) {
  return <div className="notice">{children}</div>;
}
export function JsonView({
  value,
  label = "Technical details",
}: {
  value: unknown;
  label?: string;
}) {
  return (
    <details className="details">
      <summary>{label}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
export function Metric({
  label,
  value,
  unit,
}: {
  label: string;
  value: React.ReactNode;
  unit?: string;
}) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>
        {value} <small>{unit}</small>
      </strong>
    </div>
  );
}
export function CardLink({
  to,
  title,
  subtitle,
  badge,
}: {
  to: string;
  title: string;
  subtitle: string;
  badge?: string;
}) {
  return (
    <Link className="product-card" to={to}>
      <div className="card-top">
        <span className="token-avatar">{title.slice(0, 2).toUpperCase()}</span>
        <span className="badge">{badge}</span>
      </div>
      <h2>{title}</h2>
      <p>{subtitle}</p>
      <span className="card-arrow">↗</span>
    </Link>
  );
}
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  const id = React.useId();
  return (
    <label className="field">
      <span id={id}>{label}</span>
      {React.Children.map(children, (child) =>
        React.isValidElement(child) &&
        ["input", "select", "textarea"].includes(child.type as string)
          ? React.cloneElement(child as React.ReactElement<any>, {
              "aria-labelledby": id,
            })
          : child,
      )}
      {hint && <small>{hint}</small>}
    </label>
  );
}
