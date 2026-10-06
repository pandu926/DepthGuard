import React, { createContext, useContext, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import bs58 from "bs58";
import { request, setCsrf, Json } from "./client";
import { networkFor, networkInstructions, supportsNetwork } from "./network";
type Context = {
  account?: WalletAccount;
  wallet?: Wallet;
  user?: Json;
  wallets: readonly Wallet[];
  error: string;
  busy: boolean;
  cluster: string;
  networkSupported: boolean;
  connect(w: Wallet): Promise<void>;
  login(): Promise<void>;
  disconnect(): Promise<void>;
  sign(wire: Uint8Array): Promise<Uint8Array>;
};
const WalletContext = createContext<Context>(null!);
export function WalletProvider({
  children,
  cluster,
}: {
  children: React.ReactNode;
  cluster: string;
}) {
  const cache = useQueryClient();
  function clearPrivate() {
    cache.removeQueries({
      predicate: (q) =>
        [
          "my-models",
          "my-launches",
          "factory",
          "transaction",
          "research",
          "research-export",
          "portfolio",
          "earnings",
          "activity",
        ].includes(String(q.queryKey[0])),
    });
  }
  const [wallets, update] = useState(getWallets().get());
  const [wallet, select] = useState<Wallet>();
  const [account, setAccount] = useState<WalletAccount>();
  const [user, setUser] = useState<Json>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const registry = getWallets();
    const refresh = () => update(registry.get());
    const a = registry.on("register", refresh),
      b = registry.on("unregister", refresh);
    return () => {
      a();
      b();
    };
  }, []);
  useEffect(() => {
    if (!wallet) return;
    const feature = wallet.features["standard:events"] as any;
    return feature?.on("change", (change: any) => {
      if (change.accounts) {
        const next = change.accounts[0];
        setAccount(next);
        if (next?.address !== account?.address) {
          clearPrivate();
          setUser(undefined);
          setCsrf("");
        }
      }
    });
  }, [wallet, account?.address]);
  async function connect(w: Wallet) {
    setBusy(true);
    setError("");
    try {
      const f = w.features["standard:connect"] as any;
      if (
        !f ||
        !w.features["solana:signTransaction"] ||
        !w.features["solana:signMessage"]
      )
        throw Error(
          "This wallet must support message and transaction signing.",
        );
      const r = await f.connect();
      const next = r.accounts[0];
      if (!next) throw Error("Wallet returned no account.");
      if (next.address !== account?.address) clearPrivate();
      select(w);
      setAccount(next);
      sessionStorage.setItem("depthguard.wallet", w.name);
      try {
        const me = await request("/me");
        if (
          me.wallet === next.address &&
          sessionStorage.getItem("depthguard.csrf")
        )
          setUser(me);
        else {
          setUser(undefined);
          setCsrf("");
        }
      } catch {
        setUser(undefined);
        setCsrf("");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    const name = sessionStorage.getItem("depthguard.wallet");
    const w = wallets.find((w) => w.name === name);
    if (w && !wallet) {
      const f = w.features["standard:connect"] as any;
      f?.connect({ silent: true })
        .then(async (r: any) => {
          const next = r.accounts[0];
          if (!next) return;
          select(w);
          setAccount(next);
          try {
            const me = await request("/me");
            if (
              me.wallet === next.address &&
              sessionStorage.getItem("depthguard.csrf")
            )
              setUser(me);
          } catch {
            setUser(undefined);
          }
        })
        .catch(() => {});
    }
  }, [wallets]);
  function requireNetwork() {
    if (!account || !supportsNetwork(account.chains, cluster))
      throw Error(
        `Your wallet account cannot sign on ${networkFor(cluster)?.label || cluster}. ${networkInstructions(cluster)}`,
      );
  }
  async function login() {
    if (!wallet || !account) throw Error("Connect a wallet first.");
    setBusy(true);
    setError("");
    try {
      requireNetwork();
      const c = await request("/auth/challenges", { wallet: account.address });
      const [signed] = await (
        wallet.features["solana:signMessage"] as any
      ).signMessage({ account, message: new TextEncoder().encode(c.message) });
      const r = await request("/auth/verify", {
        id: c.id,
        signature: bs58.encode(signed.signature),
      });
      setCsrf(r.csrf_token);
      setUser(r);
    } catch (e) {
      setError((e as Error).message);
      throw e;
    } finally {
      setBusy(false);
    }
  }
  async function disconnect() {
    try {
      if (user) await request("/auth/logout", {});
    } finally {
      await (wallet?.features["standard:disconnect"] as any)?.disconnect();
      clearPrivate();
      sessionStorage.removeItem("depthguard.wallet");
      select(undefined);
      setAccount(undefined);
      setUser(undefined);
      setCsrf("");
    }
  }
  async function sign(wire: Uint8Array) {
    if (!wallet || !account || user?.wallet !== account.address)
      throw Error("Connect and authenticate the signing wallet.");
    const chain = networkFor(cluster)?.chain;
    if (!chain) throw Error("Unsupported network.");
    requireNetwork();
    const [r] = await (
      wallet.features["solana:signTransaction"] as any
    ).signTransaction({ account, chain, transaction: wire });
    return r.signedTransaction;
  }
  return (
    <WalletContext.Provider
      value={{
        account,
        wallet,
        user,
        wallets,
        busy,
        error,
        cluster,
        networkSupported: !!account && supportsNetwork(account.chains, cluster),
        connect,
        login,
        disconnect,
        sign,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
}
export const useWallet = () => useContext(WalletContext);
