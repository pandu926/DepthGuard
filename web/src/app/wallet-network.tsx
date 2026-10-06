import React from "react";
import { useWallet } from "./wallet";
import { networkFor, networkInstructions } from "./network";
export function WalletNetwork() {
  const wallet = useWallet();
  const network = networkFor(wallet.cluster);
  return (
    <section className="wallet-network" aria-label="Wallet network guidance">
      <div className="wallet-network-heading">
        <span>Application network</span>
        <strong>
          {network?.label || "Unsupported network"}
          {network?.test ? " · Test network" : ""}
        </strong>
      </div>
      <p>
        {network?.test
          ? `All transactions use ${network.label} SOL. Mainnet balances are separate.`
          : network
            ? "Transactions on Mainnet use real SOL."
            : "Signing is unavailable until the application network is configured."}
      </p>
      {wallet.account && (
        <p
          className={wallet.networkSupported ? "network-compatible" : "error"}
          role="status"
        >
          {wallet.networkSupported
            ? `This wallet account supports ${network?.label}.`
            : `This wallet account has not enabled ${network?.label || "the required network"}. Signing is blocked.`}
        </p>
      )}
      <details open={!!wallet.account && !wallet.networkSupported}>
        <summary>How to use {network?.label || "the required network"}</summary>
        <p>{networkInstructions(wallet.cluster)}</p>
        <p>
          Connecting does not switch your wallet’s network display. Check the
          network in the wallet approval before signing.
        </p>
        {wallet.cluster === "devnet" && (
          <a
            href="https://faucet.solana.com/"
            target="_blank"
            rel="noopener noreferrer"
          >
            Get Devnet SOL ↗
          </a>
        )}
      </details>
    </section>
  );
}
