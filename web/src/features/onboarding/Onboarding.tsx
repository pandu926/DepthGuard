import React, { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useWallet } from "../../app/wallet";
import { networkFor } from "../../app/network";
import { WalletNetwork } from "../../app/wallet-network";
import { onboardingDestination } from "./preferences";

const goals = [
  {
    title: "Explore & trade",
    detail: "Discover economies. Understand a token before your first trade.",
    route: "/explore",
    mark: "01",
    next: "Explore economies",
    steps: [
      "Open a token to inspect its model and launch stage.",
      "Connect your wallet and prepare quote tokens in Portfolio.",
      "Review your quote, fees and network before approving a trade.",
    ],
  },
  {
    title: "Launch a token",
    detail:
      "Give your token an identity, choose a model and preview the launch.",
    route: "/create/identity",
    mark: "02",
    next: "Create your token",
    steps: [
      "Enter your token identity and choose an economy model.",
      "Review the parameters and simulation before committing.",
      "Approve each launch transaction, then track progress in Creator.",
    ],
  },
  {
    title: "Design an economy",
    detail: "Start with a model. Adjust its parameters and test your ideas.",
    route: "/studio",
    mark: "03",
    next: "Open Economy Studio",
    steps: [
      "Choose a preset or copy a model from the marketplace.",
      "Adjust the curve, fees and supported post-launch rights.",
      "Simulate in Research, then save or use the model for a launch.",
    ],
  },
];

export default function Onboarding({
  onConnect,
  onFinish,
}: {
  onConnect: () => void;
  onFinish: () => void;
}) {
  const wallet = useWallet();
  const network = networkFor(wallet.cluster);
  const [params] = useSearchParams();
  const destination = onboardingDestination(params.get("returnTo"));
  const [goal, setGoal] = useState(() =>
    Math.max(
      0,
      goals.findIndex((g) => destination.startsWith(g.route)),
    ),
  );
  const [step, setStep] = useState(0);
  const title = useRef<HTMLHeadingElement>(null);
  const navigate = useNavigate();
  const finish = (route: string) => {
    onFinish();
    navigate(route, { replace: true });
  };
  useEffect(() => {
    title.current?.focus();
  }, [step]);
  const selected = goals[goal];
  return (
    <section className="onboarding" aria-label="Getting started">
      <div className="onboarding-top">
        <span>WELCOME TO DEPTHGUARD</span>
        <button onClick={() => finish(destination)}>Skip for now ↗</button>
      </div>
      <ol className="onboarding-progress" aria-label="Onboarding progress">
        {["Your purpose", "Your wallet", "Your first step"].map(
          (label, index) => (
            <li key={label} aria-current={step === index ? "step" : undefined}>
              <button onClick={() => setStep(index)}>
                <span>{index < step ? "✓" : `0${index + 1}`}</span>
                {label}
              </button>
            </li>
          ),
        )}
      </ol>
      <div className="onboarding-heading">
        <p className="onboarding-eyebrow">{`0${step + 1} / 03`}</p>
        <h1 ref={title} tabIndex={-1}>
          {
            [
              "An economy starts with an idea.",
              "The right network. A clear start.",
              "You know where to go next.",
            ][step]
          }
        </h1>
        <p>
          {
            [
              "What would you like to do first? You can explore every workspace later.",
              "You can browse and design without a wallet. Connect when you are ready to act.",
              "Start small. Preview the details, then approve only what you understand.",
            ][step]
          }
        </p>
      </div>
      {step === 0 && (
        <>
          <div
            className="onboarding-goals"
            role="group"
            aria-label="Choose your purpose"
          >
            {goals.map((g, index) => (
              <button
                key={g.route}
                className={`onboarding-goal ${goal === index ? "selected" : ""}`}
                aria-pressed={goal === index}
                onClick={() => setGoal(index)}
              >
                <span className="onboarding-goal-mark">
                  {g.mark}
                  <span>{goal === index ? "●" : "○"}</span>
                </span>
                <strong>{g.title}</strong>
                <p>{g.detail}</p>
                <span className="onboarding-goal-link">
                  {goal === index ? "Your starting point" : "Choose this path"}{" "}
                  ↗
                </span>
              </button>
            ))}
          </div>
          <div className="onboarding-flow" aria-label="Token lifecycle">
            <span>
              <strong>Launch</strong>
              <small>Price discovery on DBC</small>
            </span>
            <i aria-hidden="true">→</i>
            <span>
              <strong>Graduate</strong>
              <small>Liquidity moves to DAMM v2</small>
            </span>
            <i aria-hidden="true">→</i>
            <span>
              <strong>Manage</strong>
              <small>Rights depend on the model</small>
            </span>
          </div>
        </>
      )}
      {step === 1 && (
        <div className="onboarding-setup">
          <div>
            <WalletNetwork />
            <div className="onboarding-wallet-status" role="status">
              {wallet.account
                ? wallet.networkSupported
                  ? "Wallet connected · network supported"
                  : "Wallet connected · network setup required"
                : "Wallet not connected"}
              {wallet.user && " · signed in"}
            </div>
            <div className="actions">
              <button className="primary" onClick={onConnect}>
                {wallet.account ? "Review wallet" : "Connect wallet"} ↗
              </button>
              {wallet.account && !wallet.user && (
                <button
                  className="secondary"
                  disabled={wallet.busy || !wallet.networkSupported}
                  onClick={() => wallet.login().catch(() => {})}
                >
                  {wallet.busy ? "Waiting for wallet…" : "Sign in"}
                </button>
              )}
            </div>
            {wallet.error && (
              <p className="error" role="alert">
                {wallet.error}
              </p>
            )}
          </div>
          <div className="onboarding-checklist">
            <h2>Before your first transaction</h2>
            <ol>
              <li>
                <strong>Connect & sign in</strong>
                <p>
                  Sign-in uses a message, with no network fee. Transactions
                  require a separate approval.
                </p>
              </li>
              <li>
                <strong>
                  Prepare {network?.label || "the required network"} SOL
                </strong>
                <p>
                  {network?.test
                    ? "Test SOL pays network fees and account creation costs. Mainnet SOL cannot be used here."
                    : "Real SOL pays network fees and account creation costs. Review costs before signing."}
                </p>
                {wallet.cluster === "devnet" && (
                  <a
                    href="https://faucet.solana.com/"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open the Solana Devnet faucet ↗
                  </a>
                )}
              </li>
              <li>
                <strong>Prepare your quote token</strong>
                <p>
                  For SOL-quoted trading, wrap SOL into WSOL in Portfolio. Keep
                  some SOL available for fees.
                </p>
              </li>
            </ol>
          </div>
        </div>
      )}
      {step === 2 && (
        <div className="onboarding-next">
          <div>
            <span className="onboarding-eyebrow">YOUR PATH</span>
            <h2>{selected.title}</h2>
            <ol>
              {selected.steps.map((text, index) => (
                <li key={text}>
                  <span>{index + 1}</span>
                  <p>{text}</p>
                </li>
              ))}
            </ol>
          </div>
          <aside>
            <span className="onboarding-eyebrow">KEEP IN REACH</span>
            <Link to="/docs">
              The handbook <span>Concepts, models and walkthroughs ↗</span>
            </Link>
            <Link to="/settings">
              Wallet & network <span>Connection and network guidance ↗</span>
            </Link>
            <Link to="/portfolio">
              Portfolio <span>Balances and SOL wrapping ↗</span>
            </Link>
            <p>
              You can reopen this guide from Getting started in the workspace
              menu.
            </p>
          </aside>
        </div>
      )}
      <div className="onboarding-bottom">
        <span>
          {network?.label || wallet.cluster}
          {network?.test ? " · Test environment" : " · Live environment"}
        </span>
        <div className="actions">
          {step > 0 && (
            <button className="secondary" onClick={() => setStep(step - 1)}>
              Back
            </button>
          )}
          {step < 2 ? (
            <button className="primary" onClick={() => setStep(step + 1)}>
              {step === 1 && !wallet.user
                ? "Continue without signing in"
                : "Continue"}{" "}
              →
            </button>
          ) : (
            <button className="primary" onClick={() => finish(selected.route)}>
              {selected.next} ↗
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
