import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import katex from "katex";
import {
  docBySlug,
  docGroups,
  readingMinutes,
  searchDocs,
  type DocBlock,
  type DocPage,
} from "./content";
import { CurveDiagram, LifecycleDiagram } from "./diagrams";
import "./documentation.css";

type IconName =
  | "search"
  | "arrow"
  | "menu"
  | "close"
  | "book"
  | "link"
  | "chevron";
function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, React.ReactNode> = {
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 4.5 4.5" />
      </>
    ),
    arrow: (
      <>
        <path d="M5 12h14M13 6l6 6-6 6" />
      </>
    ),
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    book: (
      <>
        <path d="M12 5v15M12 5C8 2 4 3 3 4v15c3-2 6-1 9 1 3-2 6-3 9-1V4c-1-1-5-2-9 1Z" />
      </>
    ),
    link: (
      <>
        <path
          d="m10 14 4-4M8 16l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0M16 8l1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"
          transform="translate(1 0) scale(.9)"
        />
      </>
    ),
    chevron: <path d="m9 5 7 7-7 7" />,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
function Text({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  const regex = /\[([^\]]+)\]\((\/[^)]+)\)|\*\*([^*]+)\*\*/g;
  let cursor = 0;
  for (const match of text.matchAll(regex)) {
    parts.push(text.slice(cursor, match.index));
    parts.push(
      match[3] ? (
        <strong key={match.index}>{match[3]}</strong>
      ) : (
        <Link key={match.index} to={match[2]}>
          {match[1]}
        </Link>
      ),
    );
    cursor = match.index! + match[0].length;
  }
  parts.push(text.slice(cursor));
  return <>{parts}</>;
}
function Equation({
  block,
}: {
  block: Extract<DocBlock, { type: "equation" }>;
}) {
  const html = useMemo(
    () =>
      katex.renderToString(block.latex, {
        output: "mathml",
        displayMode: true,
        throwOnError: true,
        trust: false,
        strict: "error",
        maxExpand: 100,
        maxSize: 20,
      }),
    [block.latex],
  );
  return (
    <figure className="dg-equation">
      <span className="dg-equation-label">{block.title}</span>
      <div
        className="dg-math-scroll"
        tabIndex={0}
        role="region"
        aria-label={`${block.title} equation`}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <figcaption>
        <Text text={block.caption} />
      </figcaption>
    </figure>
  );
}
function Block({ block }: { block: DocBlock }) {
  if (block.type === "paragraph")
    return (
      <p>
        <Text text={block.text} />
      </p>
    );
  if (block.type === "equation") return <Equation block={block} />;
  if (block.type === "diagram")
    return block.kind === "price-curves" ? (
      <CurveDiagram />
    ) : (
      <LifecycleDiagram />
    );
  if (block.type === "note")
    return (
      <aside className="dg-note">
        <span className="dg-note-mark">i</span>
        <div>
          <strong>{block.title}</strong>
          <p>
            <Text text={block.text} />
          </p>
        </div>
      </aside>
    );
  if (block.type === "table")
    return (
      <div
        className="dg-table-scroll"
        tabIndex={0}
        role="region"
        aria-label="Reference table"
      >
        <table>
          <thead>
            <tr>
              {block.columns.map((c) => (
                <th key={c} scope="col">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td key={j}>
                    <Text text={cell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  if (block.type === "faq")
    return (
      <div className="dg-faq">
        {block.items.map((item) => (
          <details key={item.question}>
            <summary>
              {item.question}
              <Icon name="chevron" size={15} />
            </summary>
            <p>
              <Text text={item.answer} />
            </p>
          </details>
        ))}
      </div>
    );
  const Tag = block.type === "steps" ? "ol" : "ul";
  return (
    <Tag className={block.type === "steps" ? "dg-steps" : "dg-list"}>
      {block.items.map((item, i) => (
        <li key={i}>
          <Text text={item} />
        </li>
      ))}
    </Tag>
  );
}
function Navigation({ slug, close }: { slug: string; close?: () => void }) {
  return (
    <nav className="dg-chapters" aria-label="Documentation chapters">
      {docGroups.map((group) => (
        <section key={group.title}>
          <h2>{group.title}</h2>
          {group.pages.map((id) => (
            <Link
              key={id}
              to={id === "introduction" ? "/docs" : `/docs/${id}`}
              className={slug === id ? "is-current" : ""}
              aria-current={slug === id ? "page" : undefined}
              onClick={close}
            >
              {docBySlug.get(id)!.title === "Economies by design."
                ? "Introduction"
                : docBySlug.get(id)!.title}
              {slug === id && <span className="dg-nav-dot" />}
            </Link>
          ))}
        </section>
      ))}
    </nav>
  );
}
function SearchDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const navigate = useNavigate();
  const results = useMemo(() => searchDocs(query), [query]);
  useEffect(() => {
    if (!open) {
      ref.current?.close();
      return;
    }
    setQuery("");
    setSelected(0);
    ref.current?.showModal();
    input.current?.focus();
  }, [open]);
  useEffect(() => {
    setSelected(0);
  }, [query]);
  useEffect(() => {
    if (open && results.length)
      document
        .getElementById(`dg-result-${selected}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [open, selected, results]);
  function select(index: number) {
    const result = results[index];
    if (!result) return;
    navigate(
      `/docs/${result.page.slug}${result.section ? `#${result.section.id}` : ""}`,
    );
    onClose();
  }
  return (
    <dialog
      ref={ref}
      className="dg-search-dialog"
      aria-labelledby="dg-search-title"
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <h2 id="dg-search-title" className="dg-sr-only">
        Search the DepthGuard handbook
      </h2>
      <div className="dg-search-input">
        <Icon name="search" />
        <input
          ref={input}
          value={query}
          placeholder="Search the handbook…"
          aria-label="Search documentation"
          role="combobox"
          aria-expanded={results.length > 0}
          aria-controls="dg-search-results"
          aria-activedescendant={
            results.length ? `dg-result-${selected}` : undefined
          }
          autoComplete="off"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSelected((s) =>
                Math.max(0, Math.min(s + 1, results.length - 1)),
              );
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setSelected((s) => Math.max(0, s - 1));
            }
            if (e.key === "Enter") {
              e.preventDefault();
              select(selected);
            }
          }}
        />
        <button onClick={onClose} aria-label="Close search">
          <Icon name="close" />
        </button>
      </div>
      <div
        className="dg-search-results"
        id="dg-search-results"
        role="listbox"
        aria-label="Search results"
      >
        {!query.trim() ? (
          <div className="dg-search-empty">
            <Icon name="book" size={28} />
            <h3>Find your next answer.</h3>
            <p>Try “graduation”, “reserve”, or “price discovery”.</p>
            <div className="dg-search-suggestions">
              {["Graduation", "Reserve", "Mathematics"].map((q) => (
                <button
                  key={q}
                  onClick={() => setQuery(q === "Mathematics" ? "capital" : q)}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : !results.length ? (
          <div className="dg-search-empty">
            <h3>No matches for “{query}”.</h3>
            <p>Try a shorter phrase or browse the chapters.</p>
          </div>
        ) : (
          results.map((result, i) => (
            <button
              key={`${result.page.slug}-${result.section?.id}`}
              id={`dg-result-${i}`}
              role="option"
              aria-selected={i === selected}
              className={i === selected ? "is-selected" : ""}
              onClick={() => select(i)}
            >
              <span className="dg-result-path">
                {result.page.title}
                <Icon name="chevron" size={11} />
                {result.section?.title}
              </span>
              <span>{result.excerpt}</span>
              <Icon name="arrow" size={16} />
            </button>
          ))
        )}
      </div>
      <div className="dg-search-footer">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> Navigate
        </span>
        <span>
          <kbd>↵</kbd> Open
        </span>
        <span>
          <kbd>esc</kbd> Close
        </span>
      </div>
    </dialog>
  );
}
function Article({ page }: { page: DocPage }) {
  const ordered = docGroups
    .flatMap((g) => g.pages)
    .map((s) => docBySlug.get(s)!);
  const index = ordered.findIndex((p) => p.slug === page.slug);
  const group = docGroups.find((g) => g.pages.includes(page.slug))!;
  return (
    <article className="dg-article">
      <div className="dg-breadcrumb">
        <Link to="/docs">Handbook</Link>
        <Icon name="chevron" size={12} />
        <span>{group.title}</span>
      </div>
      <div className="dg-article-heading">
        <span className="dg-eyebrow">
          {page.slug === "introduction"
            ? "THE DEPTHGUARD HANDBOOK"
            : group.title}
        </span>
        <h1>{page.title}</h1>
        <p className="dg-lead">{page.description}</p>
        <div className="dg-article-meta">
          <span>
            <Icon name="book" size={14} />
            {readingMinutes(page)} min read
          </span>
          <span>Product documentation</span>
        </div>
      </div>
      {page.slug === "introduction" && (
        <>
          <LifecycleDiagram />
          <div className="dg-starting-links">
            <Link to="/docs/quickstart">
              <span>GET STARTED</span>Your first session
              <Icon name="arrow" />
            </Link>
            <Link to="/docs/mathematical-framework">
              <span>GO DEEPER</span>The mathematical perspective
              <Icon name="arrow" />
            </Link>
          </div>
        </>
      )}
      <div className="dg-prose">
        {page.sections.map((section) => (
          <section
            id={section.id}
            key={section.id}
            className="dg-article-section"
          >
            <h2>
              <Link
                to={`#${section.id}`}
                aria-label={`Link to ${section.title}`}
              >
                {section.title}
                <span aria-hidden="true">#</span>
              </Link>
            </h2>
            {section.blocks.map((block, i) => (
              <Block key={i} block={block} />
            ))}
          </section>
        ))}
      </div>
      <div className="dg-page-navigation">
        {[ordered[index - 1], ordered[index + 1]].map((target, i) =>
          target ? (
            <Link
              key={i}
              to={`/docs/${target.slug}`}
              className={i ? "dg-next" : "dg-previous"}
            >
              <span>{i ? "Continue reading" : "Previous article"}</span>
              <strong>
                {target.title}
                <Icon name="arrow" size={17} />
              </strong>
            </Link>
          ) : (
            <span key={i} />
          ),
        )}
      </div>
      <div className="dg-article-footer">
        <span>DepthGuard Handbook</span>
        <span>Reviewed October 3, 2026</span>
      </div>
    </article>
  );
}
export default function Documentation() {
  const location = useLocation();
  const slug =
    location.pathname.replace(/^\/docs\/?/, "").replace(/\/$/, "") ||
    "introduction";
  const page = docBySlug.get(slug);
  const [searchOpen, setSearchOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeSection, setActiveSection] = useState("");
  const [copied, setCopied] = useState("");
  const menu = useRef<HTMLDialogElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  useEffect(() => {
    const previous = document.title;
    document.title = `${page?.title || "Page not found"} — DepthGuard Docs`;
    const priorDescription = document.querySelector<HTMLMetaElement>(
      'meta[name="description"]',
    );
    const description = priorDescription || document.createElement("meta");
    const oldDescription = description.content;
    description.name = "description";
    description.content =
      page?.description || "Browse the DepthGuard product handbook.";
    if (!priorDescription) document.head.append(description);
    const priorCanonical = document.querySelector<HTMLLinkElement>(
      'link[rel="canonical"]',
    );
    const canonical = priorCanonical || document.createElement("link");
    const oldCanonical = canonical.href;
    canonical.rel = "canonical";
    canonical.href = new URL(
      page?.slug === "introduction" ? "/docs" : `/docs/${slug}`,
      window.location.origin,
    ).href;
    if (!priorCanonical) document.head.append(canonical);
    if (location.hash)
      requestAnimationFrame(() =>
        document
          .getElementById(decodeURIComponent(location.hash.slice(1)))
          ?.scrollIntoView(),
      );
    else window.scrollTo(0, 0);
    setActiveSection(page?.sections[0]?.id || "");
    setMenuOpen(false);
    setCopied("");
    return () => {
      document.title = previous;
      if (priorDescription) description.content = oldDescription;
      else description.remove();
      if (priorCanonical) canonical.href = oldCanonical;
      else canonical.remove();
    };
  }, [page, slug, location.hash]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  useEffect(() => {
    if (menuOpen) menu.current?.showModal();
    else menu.current?.close();
  }, [menuOpen]);
  useEffect(() => {
    if (!page) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        let id = page.sections[0].id;
        for (const s of page.sections)
          if (
            (document.getElementById(s.id)?.getBoundingClientRect().top ??
              Infinity) <= 145
          )
            id = s.id;
        setActiveSection(id);
      });
    };
    window.addEventListener("scroll", update, { passive: true });
    update();
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", update);
    };
  }, [page]);
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied("Link copied");
    } catch {
      setCopied("Copy the address from your browser");
    }
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(""), 2500);
  }
  return (
    <div className="dg-docs">
      <a className="dg-skip" href="#dg-article">
        Skip to article
      </a>
      <header className="dg-docs-header">
        <div className="dg-header-brand">
          <Link to="/" className="dg-wordmark">
            <span>◈</span>DepthGuard
          </Link>
          <span className="dg-header-divider" />
          <Link to="/docs" className="dg-header-label">
            Docs
          </Link>
        </div>
        <button
          className="dg-search-trigger"
          onClick={() => setSearchOpen(true)}
        >
          <Icon name="search" />
          <span>Search documentation</span>
          <kbd>⌘ K</kbd>
        </button>
        <Link to="/explore" className="dg-open-app">
          Open app
          <Icon name="arrow" size={15} />
        </Link>
        <button
          className="dg-mobile-menu"
          onClick={() => setMenuOpen(true)}
          aria-label="Open documentation navigation"
        >
          <Icon name="menu" />
        </button>
      </header>
      <div className="dg-docs-layout">
        <aside className="dg-sidebar">
          <div className="dg-sidebar-label">
            <Icon name="book" size={15} /> THE HANDBOOK
          </div>
          <Navigation slug={slug} />
          <Link to="/docs/release-status" className="dg-release-label">
            <span />
            Development preview
            <Icon name="arrow" size={13} />
          </Link>
        </aside>
        <main id="dg-article" className="dg-docs-main">
          {page ? (
            <Article page={page} />
          ) : (
            <article className="dg-article dg-not-found">
              <span className="dg-eyebrow">DOCUMENTATION</span>
              <h1>Let's find your next page.</h1>
              <p>
                This article isn't in the handbook. Browse the chapters or
                search for a topic.
              </p>
              <Link to="/docs" className="dg-open-app">
                Back to the handbook
                <Icon name="arrow" />
              </Link>
            </article>
          )}
        </main>
        <aside className="dg-toc" aria-label="On this page">
          {page && (
            <>
              <span className="dg-toc-heading">ON THIS PAGE</span>
              <nav>
                {page.sections.map((s) => (
                  <Link
                    key={s.id}
                    to={`#${s.id}`}
                    className={activeSection === s.id ? "is-current" : ""}
                    aria-current={
                      activeSection === s.id ? "location" : undefined
                    }
                  >
                    {s.title}
                  </Link>
                ))}
              </nav>
              <button className="dg-copy-link" onClick={copyLink}>
                <Icon name="link" size={14} />
                {copied || "Copy page link"}
              </button>
              <span className="dg-sr-only" role="status">
                {copied}
              </span>
              <div className="dg-toc-bottom">
                <span>
                  Understand the model.
                  <br />
                  Review the terms.
                  <br />
                  Choose deliberately.
                </span>
                <Link to="/docs/quickstart">
                  Start here
                  <Icon name="arrow" size={13} />
                </Link>
              </div>
            </>
          )}
        </aside>
      </div>
      <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />
      <dialog
        ref={menu}
        className="dg-navigation-dialog"
        aria-labelledby="dg-mobile-nav-title"
        onCancel={() => setMenuOpen(false)}
        onClick={(e) => {
          if (e.target === menu.current) setMenuOpen(false);
        }}
      >
        <div className="dg-mobile-nav-heading">
          <h2 id="dg-mobile-nav-title">The handbook</h2>
          <button
            aria-label="Close documentation navigation"
            onClick={() => setMenuOpen(false)}
          >
            <Icon name="close" />
          </button>
        </div>
        <Navigation slug={slug} close={() => setMenuOpen(false)} />
      </dialog>
    </div>
  );
}
