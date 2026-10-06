import React, { useState } from "react";

export function LifecycleDiagram() {
  return (
    <div className="dg-lifecycle" aria-label="Design, discover, and graduate">
      {[
        [
          "01",
          "Design the economy",
          "A model with a purpose",
          "/docs/economy-studio",
        ],
        [
          "02",
          "Discover its market",
          "Price discovery through DBC",
          "/docs/community-launch",
        ],
        [
          "03",
          "Continue after graduation",
          "A destination market on DAMM v2",
          "/docs/graduation",
        ],
      ].map(([number, title, caption, href]) => (
        <a key={number} href={href}>
          <span className="dg-lifecycle-number">
            {number}
            <span>↗</span>
          </span>
          <strong>{title}</strong>
          <span>{caption}</span>
        </a>
      ))}
    </div>
  );
}
export function CurveDiagram() {
  const [shape, setShape] = useState<"flat" | "linear" | "convex">("linear");
  const [order, setOrder] = useState(35);
  const q = order / 100;
  const price = (x: number) =>
    shape === "flat" ? 1 : shape === "linear" ? 1 + 2 * x : 1 + 2 * x * x;
  const cost =
    shape === "flat"
      ? q
      : shape === "linear"
        ? q + q * q
        : q + (2 * q * q * q) / 3;
  const x = (v: number) => 50 + v * 490;
  const y = (v: number) => 210 - (v - 1) * 72;
  const path = Array.from(
    { length: 101 },
    (_, i) =>
      `${i === 0 ? "M" : "L"}${x(i / 100).toFixed(1)},${y(price(i / 100)).toFixed(1)}`,
  ).join(" ");
  const fill =
    `M${x(0)},240 ` +
    Array.from(
      { length: 81 },
      (_, i) =>
        `L${x((q * i) / 80).toFixed(1)},${y(price((q * i) / 80)).toFixed(1)}`,
    ).join(" ") +
    ` L${x(q)},240 Z`;
  return (
    <figure className="dg-curve-figure">
      <div className="dg-figure-top">
        <span>PRICE DISCOVERY / ILLUSTRATION</span>
        <span>Normalized units</span>
      </div>
      <div className="dg-curve-controls" aria-label="Illustrative curve shape">
        {(["flat", "linear", "convex"] as const).map((value) => (
          <button
            key={value}
            aria-pressed={shape === value}
            onClick={() => setShape(value)}
          >
            {value}
          </button>
        ))}
      </div>
      <svg
        viewBox="0 0 580 285"
        role="img"
        aria-label={`${shape} marginal price curve with ${order}% of the allocation interval shaded`}
      >
        {[1, 2, 3].map((v) => (
          <g key={v}>
            <line
              x1="50"
              x2="540"
              y1={y(v)}
              y2={y(v)}
              className="dg-chart-grid"
            />
            <text x="28" y={y(v) + 4}>
              {v}
            </text>
          </g>
        ))}
        <path d={fill} className="dg-chart-area" />
        <path d={path} className="dg-chart-curve" />
        <line
          x1={x(q)}
          x2={x(q)}
          y1={y(price(q))}
          y2="240"
          className="dg-chart-guide"
        />
        <circle cx={x(q)} cy={y(price(q))} r="5" className="dg-chart-point" />
        <line x1="50" x2="540" y1="240" y2="240" className="dg-chart-axis" />
        {[0, 0.25, 0.5, 0.75, 1].map((v) => (
          <text key={v} x={x(v)} y="262" textAnchor="middle">
            {v.toFixed(2)}
          </text>
        ))}
        <text x="50" y="18">
          Marginal price
        </text>
        <text x="540" y="282" textAnchor="end">
          Allocation coordinate q
        </text>
      </svg>
      <label className="dg-range-label" htmlFor="dg-order-size">
        <span>Purchase interval</span>
        <strong>{order}%</strong>
      </label>
      <input
        id="dg-order-size"
        type="range"
        min="5"
        max="100"
        step="5"
        value={order}
        onChange={(e) => setOrder(Number(e.target.value))}
      />
      <div className="dg-chart-metrics" aria-live="polite">
        <span>
          Marginal price<strong>{price(q).toFixed(3)}</strong>
        </span>
        <span>
          Average price<strong>{(cost / q).toFixed(3)}</strong>
        </span>
        <span>
          Cumulative cost<strong>{cost.toFixed(3)}</strong>
        </span>
      </div>
      <figcaption>
        Shaded area represents net cost in a fee-free theoretical example. This
        illustration neither produces a launch configuration nor estimates a
        live quote.
      </figcaption>
    </figure>
  );
}
