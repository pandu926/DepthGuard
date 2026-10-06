import { useEffect, useId, useRef, useState, type CSSProperties } from "react";

/** Illustrative migration flow. Actual configuration curves live in CurveChart. */
export function LiquidityVisual({
  capitalPercent = 0,
  segments = 2,
}: {
  capitalPercent?: number;
  segments?: number;
}) {
  const id = useId().replace(/:/g, "");
  const [reduced, setReduced] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [time, setTime] = useState(0);
  const [scrubbing, setScrubbing] = useState(false);
  const [paused, setPaused] = useState(false);
  const clock = useRef(0);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReduced(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    if (reduced || scrubbing || paused) return;
    let frame = 0,
      previous = 0,
      drawn = 0;
    const tick = (now: number) => {
      if (previous && !document.hidden)
        clock.current =
          (clock.current + Math.min(now - previous, 100) / 1000) % 10;
      previous = now;
      if (now - drawn > 40) {
        setTime(clock.current);
        drawn = now;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [reduced, scrubbing, paused]);
  const phase = reduced
    ? "DBC → DAMM v2"
    : time < 3
      ? "Price discovery"
      : time < 5
        ? "Threshold"
        : time < 8
          ? "Migration"
          : "Real liquidity";
  const stream =
    "M24 326 C65 318 88 283 96 253 C135 339 190 285 252 223 S367 179 520 206 C639 230 761 240 886 240";
  return (
    <div
      className="liquidity-visual"
      data-autoplay={!reduced && !scrubbing && !paused}
    >
      <svg
        viewBox="0 0 1100 390"
        role="img"
        aria-label="Illustrative DBC migration into DAMM v2 liquidity"
      >
        <defs>
          <linearGradient id={`${id}-ink`}>
            <stop stopColor="#38548d" />
            <stop offset="1" stopColor="#183d79" />
          </linearGradient>
        </defs>
        <g
          className="flow-field"
          fill="none"
          stroke="currentColor"
          strokeWidth=".62"
        >
          {Array.from({ length: Math.min(60, 30 + segments * 4) }, (_, i) => {
            const t = i / 37;
            return (
              <path
                key={i}
                opacity={0.18 + 0.3 * (1 - Math.abs(t - 0.5) * 2)}
                d={`M24 326 C${51 + t * 14} 317 ${85 + t * 6} ${290 - t * 40} 96 253 C${126 + t * 5} ${350 - t * 31} ${190 + t * 34} ${320 - t * 210} ${279 + t * 30} ${105 + t * 146} S${400 + t * 12} ${177 + t * 52} 520 ${183 + t * 61} C${594 + t * 13} ${333 - t * 183} ${727 + t * 26} ${265 - t * 42} 886 240`}
              />
            );
          })}
          {Array.from({ length: 37 }, (_, i) => (
            <ellipse
              key={`ring-${i}`}
              cx="886"
              cy="240"
              rx={(22 + i * 5.05) * (1 - capitalPercent / 200)}
              ry={7 + i * 2.15}
              opacity={0.2 + Math.sin((i / 37) * Math.PI) * 0.28}
            />
          ))}
          <ellipse
            cx="886"
            cy="240"
            rx="212"
            ry="96"
            strokeDasharray="1 4"
            opacity=".32"
          />
          <path
            d="M96 253 C139 330 190 172 285 92 S443 162 520 181"
            strokeDasharray="1 4"
            opacity=".5"
          />
        </g>
        <g
          className="flow-guides"
          fill="none"
          stroke="currentColor"
          strokeWidth=".7"
        >
          <path d="M96 104V253M546 65V327M886 66V240" />
          <path d="M520 119L546 93V327L520 353Z" className="migration-gate" />
          <path d="M526 115V347M532 109V341M538 102V335" opacity=".4" />
        </g>
        <path
          id={`${id}-stream`}
          d={stream}
          fill="none"
          stroke={`url(#${id}-ink)`}
          strokeWidth="1.8"
        />
        {!reduced && (
          <path
            className="flow-highlight"
            d={stream}
            fill="none"
            stroke="var(--blue)"
            strokeWidth="2.3"
            strokeDasharray="20 1160"
          />
        )}
        <g className="flow-nodes" fill="var(--ink)">
          {[
            [96, 104],
            [96, 253],
            [298, 123],
            [307, 247],
            [396, 173],
            [546, 65],
            [886, 66],
            [886, 240],
            [1037, 240],
            [893, 293],
          ].map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r="1.55" />
          ))}
        </g>
        {!reduced &&
          !scrubbing &&
          [0, 1, 2].map((i) => (
            <circle
              key={i}
              r={i === 0 ? 2.6 : 1.9}
              fill="var(--blue)"
              opacity={0.9 - i * 0.2}
            >
              <animateMotion
                dur="7s"
                begin={`${-i * 2.3}s`}
                repeatCount="indefinite"
              >
                <mpath href={`#${id}-stream`} />
              </animateMotion>
            </circle>
          ))}
        <text x="96" y="84" textAnchor="middle">
          DBC
        </text>
        <text x="546" y="45" textAnchor="middle">
          Migration
        </text>
        <text x="886" y="45" textAnchor="middle">
          DAMM v2
        </text>
      </svg>
      <div className="flow-timeline">
        <button
          className="motion-pause"
          aria-label={paused ? "Resume animation" : "Pause animation"}
          onClick={() => setPaused(!paused)}
        >
          {paused ? "↻" : "Ⅱ"}
        </button>
        <span className="flow-phase">
          <i />
          {phase}
        </span>
        <input
          type="range"
          aria-label="Timeline preview"
          min="0"
          max="10"
          step=".05"
          value={time}
          style={{ "--timeline-progress": `${time * 10}%` } as CSSProperties}
          onPointerDown={() => setScrubbing(true)}
          onPointerUp={() => setScrubbing(false)}
          onPointerCancel={() => setScrubbing(false)}
          onKeyDown={() => setScrubbing(true)}
          onKeyUp={() => setScrubbing(false)}
          onBlur={() => setScrubbing(false)}
          onChange={(e) => {
            clock.current = Number(e.target.value);
            setTime(clock.current);
          }}
        />
        <small>Illustrative flow</small>
      </div>
    </div>
  );
}
