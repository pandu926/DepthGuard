import { useEffect, useId, useRef, useState } from "react";
import { economies } from "./economies";

export function EconomyVisual({
  model,
  paused,
}: {
  model: number;
  paused: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [progress, setProgress] = useState(0.28);
  const clock = useRef(0.28);
  const id = useId().replace(/:/g, "");
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener("change", update);
    const observer = new IntersectionObserver(([entry]) =>
      setVisible(entry.isIntersecting),
    );
    if (ref.current) observer.observe(ref.current);
    return () => {
      media.removeEventListener("change", update);
      observer.disconnect();
    };
  }, []);
  useEffect(() => {
    if (!visible || paused || reduced) return;
    let frame = 0,
      previous = 0,
      drawn = 0;
    const tick = (now: number) => {
      if (previous && !document.hidden)
        clock.current =
          (clock.current + Math.min(now - previous, 80) / 14000) % 1;
      previous = now;
      if (now - drawn > 45) {
        setProgress(clock.current);
        drawn = now;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [visible, paused, reduced]);
  const t = reduced ? 0.68 : progress;
  const selected = economies[model];
  const discovery = Math.min(t / 0.62, 1);
  const phase =
    t < 0.62
      ? "Price discovery"
      : t < 0.78
        ? "Liquidity transition"
        : "Open market";
  const y = (x: number) => 310 - 180 * Math.pow(x, selected.power);
  const points = Array.from(
    { length: 81 },
    (_, i) => `${135 + i * 5.2},${y(i / 80)}`,
  );
  const path = "M" + points.join(" L");
  return (
    <div
      ref={ref}
      className="lp-engine"
      data-animating={visible && !paused && !reduced}
    >
      <div className="lp-engine-top">
        <span>
          <i /> ECONOMY ENGINE
        </span>
        <span>ILLUSTRATIVE · NOT LIVE DATA</span>
      </div>
      <svg
        className="lp-engine-svg"
        viewBox="0 0 1160 440"
        role="img"
        aria-label={`${selected.name}: an illustrative curve flows through a DBC graduation threshold into DAMM v2 liquidity`}
      >
        <defs>
          <linearGradient id={`${id}-fade`} x1="0" x2="0" y1="0" y2="1">
            <stop stopColor="#344e89" stopOpacity=".13" />
            <stop offset="1" stopColor="#344e89" stopOpacity="0" />
          </linearGradient>
          <clipPath id={`${id}-reveal`}>
            <rect x="130" y="80" width={425 * discovery} height="270" />
          </clipPath>
        </defs>
        <g className="lp-grid" stroke="#dddeda" strokeWidth=".6" fill="none">
          {[130, 185, 240, 295, 350].map((v) => (
            <path key={v} d={`M96 ${v}H1100`} />
          ))}
          {[135, 239, 343, 447, 551, 655, 759, 863, 967, 1071].map((v) => (
            <path key={v} d={`M${v} 95V350`} strokeDasharray="2 7" />
          ))}
        </g>
        <text x="96" y="62" className="lp-svg-label">
          01 / DISCOVERY
        </text>
        <text x="628" y="62" className="lp-svg-label">
          02 / GRADUATION
        </text>
        <text x="897" y="62" className="lp-svg-label">
          03 / LIQUIDITY
        </text>
        <g fill="none" stroke="#344e89">
          {Array.from({ length: 22 }, (_, i) => (
            <path
              key={i}
              d={`M135 310 C${220 + i * 2} ${320 - i * 2} ${340 + i * 4} ${260 - i * 6} 551 ${130 + i * 4} C610 ${130 + i * 4} 631 ${195 + i * 2} 679 220 S780 ${180 + i * 3} 913 220`}
              opacity={0.07 + i * 0.005}
              strokeWidth=".7"
            />
          ))}
          {Array.from({ length: 22 }, (_, i) => (
            <ellipse
              key={`e${i}`}
              cx="969"
              cy="220"
              rx={34 + i * 5.3}
              ry={13 + i * 3.4}
              opacity={0.11 + i * 0.005}
              strokeWidth=".7"
            />
          ))}
        </g>
        <path d={`${path} L551 350 L135 350Z`} fill={`url(#${id}-fade)`} />
        <path
          d={path}
          fill="none"
          stroke="#344e89"
          strokeOpacity=".25"
          strokeWidth="1.5"
        />
        <path
          d={path}
          fill="none"
          stroke="#344e89"
          strokeWidth="2.4"
          clipPath={`url(#${id}-reveal)`}
        />
        <path
          d="M551 130C610 130 625 220 679 220H920"
          fill="none"
          stroke="#344e89"
          strokeOpacity=".55"
          strokeWidth="1.2"
          strokeDasharray="4 5"
        />
        <path
          d="M663 101L697 82V331L663 350Z"
          fill="#f3f4ef"
          stroke="#b3bdb2"
          strokeWidth="1"
        />
        <path
          d="M672 97V345M681 92V340M690 86V335"
          stroke="#b3bdb2"
          strokeWidth=".6"
        />
        <circle
          cx={135 + discovery * 416}
          cy={y(discovery)}
          r="12"
          fill="#344e89"
          fillOpacity=".08"
        />
        <circle
          cx={135 + discovery * 416}
          cy={y(discovery)}
          r="4"
          fill="#344e89"
        />
        <circle
          cx="969"
          cy="220"
          r="29"
          fill="#fcfbf7"
          stroke="#344e89"
          strokeOpacity=".35"
        />
        <path
          d="M957 219L969 207L981 219L969 231Z"
          fill="none"
          stroke="#344e89"
          strokeWidth="1.5"
        />
        {t >= 0.62 && (
          <circle
            cx={705 + ((t - 0.62) / 0.38) * 211}
            cy="220"
            r="4"
            fill="#344e89"
          />
        )}
        <text x="135" y="382" className="lp-svg-caption">
          Token supply →
        </text>
        <text x="628" y="382" className="lp-svg-caption">
          DBC threshold
        </text>
        <text x="926" y="382" className="lp-svg-caption">
          DAMM v2
        </text>
        <text x="96" y="416" className="lp-svg-small">
          NORMALIZED PRICE / SUPPLY
        </text>
        <text x="1100" y="416" textAnchor="end" className="lp-svg-small">
          CONTINUITY BY DESIGN
        </text>
      </svg>
      <svg
        className="lp-engine-mobile"
        viewBox="0 0 360 270"
        role="img"
        aria-label={`${selected.name}: discovery, graduation, and liquidity`}
      >
        <defs>
          <clipPath id={`${id}-mobile-reveal`}>
            <rect x="22" y="55" width={118 * discovery} height="165" />
          </clipPath>
        </defs>
        <g fill="none" stroke="#dce1d4" strokeWidth=".6">
          {[100, 140, 180, 220].map((v) => (
            <path key={v} d={`M22 ${v}H338`} />
          ))}
        </g>
        <text x="22" y="42" className="lp-mobile-label">
          DISCOVERY
        </text>
        <text x="153" y="42" className="lp-mobile-label">
          GRADUATION
        </text>
        <text x="264" y="42" className="lp-mobile-label">
          LIQUIDITY
        </text>
        <path
          d={
            "M" +
            Array.from(
              { length: 41 },
              (_, i) =>
                `${22 + i * 2.9},${205 - 95 * Math.pow(i / 40, selected.power)}`,
            ).join(" L")
          }
          fill="none"
          stroke="#344e89"
          strokeOpacity=".2"
          strokeWidth="1.5"
        />
        <path
          d={
            "M" +
            Array.from(
              { length: 41 },
              (_, i) =>
                `${22 + i * 2.9},${205 - 95 * Math.pow(i / 40, selected.power)}`,
            ).join(" L")
          }
          fill="none"
          stroke="#344e89"
          strokeWidth="2"
          clipPath={`url(#${id}-mobile-reveal)`}
        />
        <path
          d="M138 110C161 110 168 155 190 155H278"
          fill="none"
          stroke="#344e89"
          strokeDasharray="3 4"
          strokeOpacity=".5"
        />
        <path
          d="M181 80L196 71V204L181 213Z"
          fill="#f3f4ef"
          stroke="#a9b5a3"
          strokeWidth=".8"
        />
        <path d="M186 77V210M191 74V207" stroke="#a9b5a3" strokeWidth=".5" />
        {Array.from({ length: 12 }, (_, i) => (
          <ellipse
            key={i}
            cx="292"
            cy="155"
            rx={14 + i * 3.2}
            ry={7 + i * 2.2}
            fill="none"
            stroke="#344e89"
            strokeWidth=".6"
            strokeOpacity=".2"
          />
        ))}
        <circle
          cx="292"
          cy="155"
          r="13"
          fill="#fcfbf7"
          stroke="#344e89"
          strokeOpacity=".5"
        />
        <path
          d="M286 155L292 149L298 155L292 161Z"
          fill="none"
          stroke="#344e89"
        />
        <circle
          cx={22 + discovery * 116}
          cy={205 - 95 * Math.pow(discovery, selected.power)}
          r="3"
          fill="#344e89"
        />
        {t >= 0.62 && (
          <circle
            cx={207 + ((t - 0.62) / 0.38) * 65}
            cy="155"
            r="3"
            fill="#344e89"
          />
        )}
        <text x="22" y="250" className="lp-mobile-caption">
          Token supply →
        </text>
        <text x="165" y="250" className="lp-mobile-caption">
          DBC
        </text>
        <text x="271" y="250" className="lp-mobile-caption">
          DAMM v2
        </text>
      </svg>
      <div className="lp-engine-bottom">
        <span>
          <span className="lp-live-dot" />
          {reduced ? "Discovery → Graduation → Liquidity" : phase}
        </span>
        <span>{selected.curve}</span>
        <span>DBC → DAMM v2</span>
      </div>
    </div>
  );
}
