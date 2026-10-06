import { useEffect, useState } from "react";
import { economies } from "./economies";
import { EconomyVisual } from "./EconomyVisual";
import { Link } from "react-router-dom";
import "./landing.css";

function Arrow() {
  return <span aria-hidden="true">↗</span>;
}

export default function Landing() {
  const [model, setModel] = useState(0);
  const [paused, setPaused] = useState(false);
  const selected = economies[model];
  useEffect(() => {
    window.scrollTo(0, 0);
    const title = document.title;
    document.title = "DepthGuard — Design the economy. Launch the token.";
    const entries = [
      [
        "name",
        "description",
        "Design, simulate, and launch reusable token economies on Solana. Discover configurable launches built around Meteora DBC and DAMM v2.",
      ],
      ["property", "og:title", "DepthGuard — Economies by design"],
      [
        "property",
        "og:description",
        "A token is a beginning. Design what comes next.",
      ],
      ["property", "og:type", "website"],
      ["property", "og:url", "https://depthguard.rbexp.com/"],
      ["name", "twitter:card", "summary"],
    ];
    const restore: (() => void)[] = [];
    for (const [attr, key, value] of entries) {
      let meta = document.head.querySelector<HTMLMetaElement>(
        `meta[${attr}="${key}"]`,
      );
      const old = meta?.content;
      if (!meta) {
        meta = document.createElement("meta");
        meta.setAttribute(attr, key);
        document.head.appendChild(meta);
      }
      meta.content = value;
      const node = meta;
      restore.push(() => {
        if (old === undefined) node.remove();
        else node.content = old;
      });
    }
    let canonical = document.head.querySelector<HTMLLinkElement>(
      'link[rel="canonical"]',
    );
    const oldHref = canonical?.getAttribute("href");
    if (!canonical) {
      canonical = document.createElement("link");
      canonical.rel = "canonical";
      document.head.appendChild(canonical);
    }
    canonical.href = "https://depthguard.rbexp.com/";
    const link = canonical;
    return () => {
      document.title = title;
      restore.forEach((fn) => fn());
      if (oldHref == null) link.remove();
      else link.setAttribute("href", oldHref);
    };
  }, []);
  return (
    <div className="lp-page">
      <a href="#lp-main" className="lp-skip">
        Skip to content
      </a>
      <header className="lp-header">
        <Link to="/" className="lp-brand">
          <span aria-hidden="true">◈</span>DepthGuard
        </Link>
        <nav aria-label="Landing navigation">
          <a href="#how-it-works">How it works</a>
          <a href="#economy-models">Economy models</a>
          <Link to="/docs">Docs</Link>
        </nav>
        <Link className="lp-button lp-button-small" to="/explore">
          Open app <Arrow />
        </Link>
      </header>
      <main id="lp-main" className="lp-main" tabIndex={-1}>
        <section className="lp-hero" aria-labelledby="lp-title">
          <div className="lp-eyebrow">
            <span className="lp-live-dot" /> ECONOMIES BY DESIGN{" "}
            <span className="lp-devnet">DEVNET PREVIEW</span>
          </div>
          <h1 id="lp-title">
            Design the economy.
            <br />
            <em>Launch the token.</em>
          </h1>
          <p>
            A token is a beginning. Shape its price discovery, capital
            allocation, and life beyond launch.
          </p>
          <div className="lp-actions">
            <Link className="lp-button" to="/create/identity">
              Launch an economy <Arrow />
            </Link>
            <Link className="lp-text-link" to="/models">
              Explore models <Arrow />
            </Link>
          </div>
        </section>
        <section
          className="lp-demonstration"
          aria-label="Interactive economy demonstration"
        >
          <div
            className="lp-preview-options"
            role="group"
            aria-label="Preview an economy"
          >
            <span>PREVIEW A MODEL</span>
            {economies.map((item, i) => (
              <button
                key={item.name}
                aria-label={`Preview ${item.name} economy`}
                aria-pressed={model === i}
                onClick={() => setModel(i)}
              >
                {item.name}
                {i === 3 ? " · Research" : ""}
              </button>
            ))}
          </div>
          <EconomyVisual model={model} paused={paused} />
          <div className="lp-demo-controls">
            <span>One foundation. Different possibilities.</span>
            <button
              onClick={() => setPaused(!paused)}
              aria-pressed={paused}
              aria-label={
                paused ? "Resume economy animation" : "Pause economy animation"
              }
            >
              {paused ? "Resume motion ↗" : "Pause motion Ⅱ"}
            </button>
          </div>
        </section>
        <div className="lp-stack">
          <span>BUILT ON SOLANA</span>
          <p>
            Meteora DBC <span>→</span> DAMM v2 <span>·</span> Fee sharing
          </p>
          <Link to="/docs/graduation">
            Understand the transition <Arrow />
          </Link>
        </div>
        <section
          id="economy-models"
          className="lp-models"
          aria-labelledby="lp-model-title"
        >
          <div className="lp-section-heading">
            <span className="lp-eyebrow">01 / POSSIBILITIES</span>
            <h2 id="lp-model-title">
              Not every token
              <br />
              needs the same economy.
            </h2>
            <p>Start with a purpose. Choose the mechanics that support it.</p>
          </div>
          <div className="lp-model-workspace">
            <div
              className="lp-model-list"
              role="group"
              aria-label="Choose an economy mechanism"
            >
              {economies.map((item, i) => (
                <button
                  key={item.name}
                  aria-pressed={model === i}
                  onClick={() => setModel(i)}
                >
                  <span className="lp-model-number">0{i + 1}</span>
                  <span>
                    {item.name}
                    {i === 3 && <small>Research</small>}
                  </span>
                  <span aria-hidden="true">↗</span>
                </button>
              ))}
            </div>
            <div className="lp-model-detail" key={selected.name}>
              <span className="lp-eyebrow">
                {model === 3 ? "RESEARCH DIRECTION" : "ECONOMY BLUEPRINT"}
              </span>
              <h3>{selected.title}</h3>
              <p>{selected.description}</p>
              <dl>
                <div>
                  <dt>Discovery</dt>
                  <dd>{selected.curve}</dd>
                </div>
                <div>
                  <dt>Capital destination</dt>
                  <dd>{selected.allocation}</dd>
                </div>
                <div>
                  <dt>Holder experience</dt>
                  <dd>{selected.rights}</dd>
                </div>
              </dl>
              <Link className="lp-text-link" to={`/docs/${selected.doc}`}>
                Understand this model <Arrow />
              </Link>
            </div>
          </div>
        </section>
        <section
          id="how-it-works"
          className="lp-process"
          aria-labelledby="lp-process-title"
        >
          <div className="lp-section-heading">
            <span className="lp-eyebrow">02 / FROM IDEA TO MARKET</span>
            <h2 id="lp-process-title">Intent becomes mechanics.</h2>
          </div>
          <div className="lp-steps">
            <article>
              <span className="lp-step-number">01</span>
              <div className="lp-mini-curve" aria-hidden="true">
                <svg viewBox="0 0 240 95">
                  <path d="M10 80H230M10 10V80" />
                  <path d="M10 75C80 75 130 70 225 15" />
                  <circle cx="135" cy="53" r="4" />
                </svg>
              </div>
              <h3>Design.</h3>
              <p>
                Choose a model. Shape the curve, fees, and capital allocation in
                Economy Studio.
              </p>
              <Link to="/studio" className="lp-text-link">
                Open Studio <Arrow />
              </Link>
            </article>
            <article>
              <span className="lp-step-number">02</span>
              <div className="lp-mini-curve" aria-hidden="true">
                <svg viewBox="0 0 240 95">
                  <path d="M10 80H230M10 10V80" />
                  <path d="M10 75C90 73 140 58 225 16M10 75C90 76 140 70 225 40M10 75C90 65 140 36 225 10" />
                </svg>
              </div>
              <h3>Simulate.</h3>
              <p>
                Compare scenarios. Inspect price sensitivity and the tradeoffs
                before signing a launch.
              </p>
              <Link to="/research" className="lp-text-link">
                Enter the lab <Arrow />
              </Link>
            </article>
            <article>
              <span className="lp-step-number">03</span>
              <div className="lp-mini-curve" aria-hidden="true">
                <svg viewBox="0 0 240 95">
                  <path d="M10 50H230M105 15V85M120 15V85" />
                  <ellipse cx="183" cy="50" rx="36" ry="20" />
                  <ellipse cx="183" cy="50" rx="46" ry="30" />
                  <circle cx="55" cy="50" r="4" />
                </svg>
              </div>
              <h3>Launch.</h3>
              <p>
                Create your token on devnet. Follow discovery and the transition
                into DAMM v2 liquidity.
              </p>
              <Link to="/create/identity" className="lp-text-link">
                Create an economy <Arrow />
              </Link>
            </article>
          </div>
        </section>
        <section className="lp-reuse" aria-labelledby="lp-reuse-title">
          <div className="lp-reuse-art" aria-hidden="true">
            <span className="lp-art-label">MODEL / ORIGIN</span>
            <svg viewBox="0 0 430 340">
              <g fill="none">
                <path
                  d="M80 170H180M180 170C230 170 210 65 295 65M180 170H295M180 170C230 170 210 275 295 275"
                  stroke="#a5b4a5"
                />
                <path
                  d="M53 145L80 130L107 145V195L80 210L53 195Z"
                  stroke="#344e89"
                />
                <path d="M53 145L80 160L107 145M80 160V210" stroke="#344e89" />
                {[65, 170, 275].map((y) => (
                  <g key={y}>
                    <path
                      d={`M295 ${y - 25}L323 ${y - 40}L351 ${y - 25}V${y + 25}L323 ${y + 40}L295 ${y + 25}Z`}
                      stroke="#344e89"
                    />
                    <path
                      d={`M295 ${y - 25}L323 ${y - 10}L351 ${y - 25}M323 ${y - 10}V${y + 40}`}
                      stroke="#344e89"
                    />
                  </g>
                ))}
                <circle cx="180" cy="170" r="4" fill="#344e89" />
              </g>
            </svg>
            <span className="lp-art-label lp-art-bottom">
              ONE MODEL → MANY LAUNCHES
            </span>
          </div>
          <div>
            <span className="lp-eyebrow">03 / AN ECONOMY OF IDEAS</span>
            <h2 id="lp-reuse-title">
              Build once.
              <br />
              <em>Let others build on it.</em>
            </h2>
            <p>
              Publish your model. Let other creators reuse it through the
              platform, with attribution and a share of eligible fees for the
              model author.
            </p>
            <Link className="lp-text-link" to="/models">
              Discover the model library <Arrow />
            </Link>
            <div className="lp-reuse-note">
              Author earnings follow the configured fee split and actual
              eligible activity.
            </div>
          </div>
        </section>
        <section className="lp-theory">
          <span className="lp-eyebrow">THE REASONING BEHIND THE MARKET</span>
          <h2>
            Beautiful on the surface.
            <br />
            <em>Considered underneath.</em>
          </h2>
          <p>
            Price discovery, capital conservation, and redemption mechanics.
            Explore the principles behind the experience.
          </p>
          <Link className="lp-text-link" to="/docs/mathematical-framework">
            Read the mathematical framework <Arrow />
          </Link>
        </section>
        <section className="lp-closing">
          <span className="lp-eyebrow">YOUR NEXT ECONOMY STARTS HERE</span>
          <h2>Give your idea a market.</h2>
          <div className="lp-actions">
            <Link className="lp-button" to="/explore">
              Open app <Arrow />
            </Link>
            <Link className="lp-text-link" to="/docs">
              Read the handbook <Arrow />
            </Link>
          </div>
          <p>
            Currently on Solana devnet. Explore and experiment before a public
            production release.
          </p>
        </section>
      </main>
      <footer className="lp-footer">
        <Link className="lp-brand" to="/">
          DepthGuard
        </Link>
        <span>Economies by design.</span>
        <nav aria-label="Footer navigation">
          <Link to="/docs">Documentation</Link>
          <Link to="/docs/release-status">Release status</Link>
          <Link to="/docs/security">Security</Link>
        </nav>
        <span className="lp-footer-status">
          <span className="lp-live-dot" /> Devnet preview
        </span>
      </footer>
    </div>
  );
}
