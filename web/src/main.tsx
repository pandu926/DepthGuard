import { Buffer } from "buffer";
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Link,
  NavLink,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { WalletProvider, useWallet } from "./app/wallet";
import { WalletNetwork } from "./app/wallet-network";
import {
  hasSeenOnboarding,
  markOnboardingSeen,
} from "./features/onboarding/preferences";
import { networkFor } from "./app/network";
import { TransactionProvider } from "./app/transactions";
import { DraftProvider } from "./app/draft";
import { ErrorBoundary } from "./app/error-boundary";
import { request, short } from "./app/client";
import { Empty, Heading, Status } from "./app/components";
import "@fontsource-variable/dm-sans/wght.css";
import "@fontsource/instrument-serif/latin-400.css";
import "./style.css";
import "./preview.css";
(globalThis as any).Buffer = Buffer;
const feature = (load: () => Promise<any>, name: string) =>
  React.lazy(async () => ({
    default: (await load())[name] as React.ComponentType<any>,
  }));
const Landing = React.lazy(() => import("./landing/Landing"));
const Documentation = React.lazy(() => import("./docs/Documentation"));
const Onboarding = React.lazy(() => import("./features/onboarding/Onboarding"));
const Explore = feature(() => import("./features/markets"), "Explore");
const TokenDetail = feature(() => import("./features/markets"), "TokenDetail");
const CreateToken = feature(() => import("./features/create"), "CreateToken");
const EconomyStudio = feature(
  () => import("./features/models"),
  "EconomyStudio",
);
const ModelMarketplace = feature(
  () => import("./features/models"),
  "ModelMarketplace",
);
const ModelDetail = feature(() => import("./features/models"), "ModelDetail");
const PublishModel = feature(() => import("./features/models"), "PublishModel");
const SimulationLab = feature(
  () => import("./features/research"),
  "SimulationLab",
);
const ResearchResult = feature(
  () => import("./features/research"),
  "ResearchResult",
);
const HolderRights = feature(() => import("./features/rights"), "HolderRights");
const CreatorDashboard = feature(
  () => import("./features/account"),
  "CreatorDashboard",
);
const LaunchProgress = feature(
  () => import("./features/account"),
  "LaunchProgress",
);
const Portfolio = feature(() => import("./features/account"), "Portfolio");
const Earnings = feature(() => import("./features/account"), "Earnings");
const Activity = feature(() => import("./features/account"), "Activity");
const TransactionDetail = feature(
  () => import("./features/account"),
  "TransactionDetail",
);
const WalletSettings = feature(
  () => import("./features/account"),
  "WalletSettings",
);
const query = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 15000, refetchOnWindowFocus: true },
  },
});
function Protected() {
  const w = useWallet();
  return w.user ? (
    <Outlet />
  ) : (
    <>
      <Heading eyebrow="Your workspace" title="A wallet makes it yours." />
      <Empty
        title={w.account ? "Authenticate to continue." : "Connect your wallet."}
        text="Sign an expiring message to access your drafts, launches and transactions."
        action={
          w.account ? (
            <button
              className="primary"
              disabled={w.busy || !w.networkSupported}
              onClick={() => w.login().catch(() => {})}
            >
              Sign in ↗
            </button>
          ) : (
            <Link className="primary" to="/settings">
              Choose a wallet ↗
            </Link>
          )
        }
      />
    </>
  );
}
function Shell() {
  const wallet = useWallet();
  const [open, setOpen] = useState(false);
  const [onboardingSeen, setOnboardingSeen] = useState(hasSeenOnboarding);
  const finishOnboarding = () => {
    markOnboardingSeen();
    setOnboardingSeen(true);
  };
  const location = useLocation();
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.querySelector<HTMLButtonElement>(".modal-close")?.focus();
    return () => {
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, [open]);
  useEffect(() => {
    window.scrollTo(0, 0);
    setOpen(false);
  }, [location.pathname]);
  return (
    <>
      <header>
        <Link className="wordmark" to="/">
          <span className="brand-symbol">◈</span>DepthGuard
        </Link>
        <nav aria-label="Main navigation">
          <NavLink to="/explore" end>
            Explore
          </NavLink>
          <NavLink to="/models">Models</NavLink>
          <NavLink to="/studio">Studio</NavLink>
          <NavLink to="/research">Research</NavLink>
          <NavLink to="/creator">Creator</NavLink>
          <NavLink to="/docs">Docs</NavLink>
          <NavLink className="onboarding-mobile-link" to="/onboarding">
            Getting started
          </NavLink>
        </nav>
        <button className="wallet" onClick={() => setOpen(!open)}>
          {wallet.account ? short(wallet.account.address) : "Connect wallet"}{" "}
          <small className="wallet-network-label">
            {networkFor(wallet.cluster)?.label || wallet.cluster}
          </small>
          <span>↗</span>
        </button>
      </header>
      <div className="environment">
        <span className="dot" />
        {wallet.cluster} · Meteora DBC / DAMM v2 / DFS
        <Link to="/activity">Activity ↗</Link>
      </div>
      {wallet.account && !wallet.networkSupported && (
        <div className="network-mismatch" role="alert">
          Your wallet account cannot sign on{" "}
          {networkFor(wallet.cluster)?.label || wallet.cluster}.
          <button onClick={() => setOpen(true)}>
            Review network settings ↗
          </button>
        </div>
      )}
      <div className="app-layout">
        <aside className="side-nav" aria-label="Workspace navigation">
          <NavLink to="/portfolio">Portfolio</NavLink>
          <NavLink to="/earnings">Earnings</NavLink>
          <NavLink to="/authors">My models</NavLink>
          <NavLink to="/settings">Wallet & network</NavLink>
          <NavLink to="/onboarding">Getting started</NavLink>
        </aside>
        <main>
          {!onboardingSeen &&
            location.pathname !== "/onboarding" &&
            location.pathname !== "/explore" && (
              <div className="onboarding-invitation">
                <span>
                  New to DepthGuard? Find your starting point in three short
                  steps.
                </span>
                <Link
                  to={`/onboarding?returnTo=${encodeURIComponent(location.pathname + location.search)}`}
                >
                  Get started ↗
                </Link>
                <button
                  onClick={finishOnboarding}
                  aria-label="Dismiss getting started invitation"
                >
                  Dismiss
                </button>
              </div>
            )}
          <ErrorBoundary key={location.pathname}>
            <React.Suspense
              fallback={<div className="skeleton" aria-label="Loading page" />}
            >
              <Routes>
                <Route
                  path="/explore"
                  element={
                    onboardingSeen ? (
                      <Explore />
                    ) : (
                      <Navigate
                        replace
                        to={`/onboarding?returnTo=${encodeURIComponent(location.pathname + location.search)}`}
                      />
                    )
                  }
                />
                <Route
                  path="/onboarding"
                  element={
                    <Onboarding
                      onConnect={() => setOpen(true)}
                      onFinish={finishOnboarding}
                    />
                  }
                />
                <Route path="/tokens/:address" element={<TokenDetail />} />
                <Route
                  path="/tokens/:address/funding"
                  element={<HolderRights kind="escrow" />}
                />
                <Route
                  path="/tokens/:address/reserve"
                  element={<HolderRights kind="reserve" />}
                />
                <Route
                  path="/tokens/:address/review"
                  element={<HolderRights kind="escrow" reviewer />}
                />
                <Route path="/create/:step" element={<CreateToken />} />
                <Route path="/studio" element={<EconomyStudio />} />
                <Route path="/research" element={<SimulationLab />} />
                <Route path="/models" element={<ModelMarketplace />} />
                <Route path="/models/publish" element={<PublishModel />} />
                <Route path="/models/:id" element={<ModelDetail />} />
                <Route path="/settings" element={<WalletSettingsWithList />} />
                <Route element={<Protected />}>
                  <Route path="/creator" element={<CreatorDashboard />} />
                  <Route
                    path="/authors"
                    element={<CreatorDashboard author />}
                  />
                  <Route
                    path="/creator/launches/:id"
                    element={<LaunchProgress />}
                  />
                  <Route path="/research/:id" element={<ResearchResult />} />
                  <Route path="/portfolio" element={<Portfolio />} />
                  <Route path="/earnings" element={<Earnings />} />
                  <Route path="/activity" element={<Activity />} />
                  <Route path="/activity/:id" element={<TransactionDetail />} />
                </Route>
                <Route
                  path="*"
                  element={
                    <Empty
                      title="This page is not here."
                      action={
                        <Link className="secondary" to="/explore">
                          Back to Explore
                        </Link>
                      }
                    />
                  }
                />
              </Routes>
            </React.Suspense>
          </ErrorBoundary>
        </main>
      </div>
      <footer>
        <span>DepthGuard · Economies by design.</span>
        <Link to="/docs">Read the handbook ↗</Link>
        <span>{wallet.cluster}</span>
      </footer>
      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <section
            className="wallet-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Connect wallet"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setOpen(false);
                return;
              }
              if (e.key !== "Tab") return;
              const controls = Array.from(
                e.currentTarget.querySelectorAll<HTMLElement>(
                  'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
                ),
              );
              const first = controls[0],
                last = controls.at(-1);
              if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last?.focus();
              } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first?.focus();
              }
            }}
          >
            <button
              className="modal-close"
              aria-label="Close wallet chooser"
              onClick={() => setOpen(false)}
            >
              ×
            </button>
            <h2>
              Connect to {networkFor(wallet.cluster)?.label || wallet.cluster}.
            </h2>
            <WalletNetwork />
            <WalletList />
            {wallet.account && (
              <div className="actions">
                <button
                  className="primary"
                  disabled={
                    wallet.busy || !wallet.networkSupported || !!wallet.user
                  }
                  onClick={() => wallet.login().catch(() => {})}
                >
                  {wallet.user ? "Authenticated" : "Authenticate"}
                </button>
                <button onClick={() => wallet.disconnect()}>Disconnect</button>
              </div>
            )}
            {wallet.error && <p className="error">{wallet.error}</p>}
          </section>
        </div>
      )}
    </>
  );
}
function NoticeForHttpWallet() {
  return (
    <p className="notice">
      Use an HTTPS origin for wallet signing. You can browse and save drafts on
      this HTTP preview.
    </p>
  );
}
function WalletList() {
  const w = useWallet();
  if (!window.isSecureContext) return <NoticeForHttpWallet />;
  const available = w.wallets.filter(
    (x) =>
      x.features["solana:signTransaction"] && x.features["solana:signMessage"],
  );
  return (
    <>
      {available.length ? (
        available.map((x) => (
          <button
            className="wallet-option"
            key={x.name}
            disabled={w.busy}
            onClick={() => w.connect(x)}
          >
            <img src={x.icon} alt="" />
            <span>{x.name}</span>
            <span>↗</span>
          </button>
        ))
      ) : (
        <p className="notice">
          Install a Solana Wallet Standard wallet to sign in. You can browse
          without connecting.
        </p>
      )}
    </>
  );
}
function WalletSettingsWithList() {
  return (
    <>
      <WalletSettings />
      <section className="wallet-options">
        <WalletList />
      </section>
    </>
  );
}
function App() {
  const q = useQuery({
    queryKey: ["capabilities"],
    queryFn: () => request("/capabilities"),
    staleTime: 60000,
  });
  if (!q.data)
    return (
      <main>
        <Heading
          title="DepthGuard."
          description="Connecting to your economy infrastructure."
        />
        <Status query={q} />
      </main>
    );
  return (
    <WalletProvider cluster={q.data.cluster || "localnet"}>
      <TransactionProvider>
        <DraftProvider>
          <Shell />
        </DraftProvider>
      </TransactionProvider>
    </WalletProvider>
  );
}
class Boundary extends React.Component<
  { children: React.ReactNode },
  { error?: Error }
> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    return this.state.error ? (
      <main>
        <Empty
          title="Something interrupted this page."
          text="Your backend transactions remain recorded. Reload to recover the interface."
          action={
            <button
              className="primary"
              onClick={() => window.location.reload()}
            >
              Reload
            </button>
          }
        />
      </main>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Boundary>
      <QueryClientProvider client={query}>
        <BrowserRouter>
          <Routes>
            <Route
              path="/docs/*"
              element={
                <React.Suspense
                  fallback={
                    <main aria-label="Loading documentation">
                      <div className="skeleton" />
                    </main>
                  }
                >
                  <Documentation />
                </React.Suspense>
              }
            />
            <Route
              path="/"
              element={
                <React.Suspense
                  fallback={
                    <main aria-label="Loading homepage">
                      <div className="skeleton" />
                    </main>
                  }
                >
                  <Landing />
                </React.Suspense>
              }
            />
            <Route path="*" element={<App />} />
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>
    </Boundary>
  </React.StrictMode>,
);
