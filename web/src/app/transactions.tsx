import React, { createContext, useContext, useState, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { request, Json } from "./client";
import { useWallet } from "./wallet";
const Context = createContext<{ run(p: Json): Promise<Json>; busy: boolean }>(
  null!,
);
export const terminal = (s: string) =>
  ["finalized", "failed", "expired", "verification_failed"].includes(s);
export function TransactionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const running = useRef(false);
  const wallet = useWallet();
  const query = useQueryClient();
  const [receipt, setReceipt] = useState<Json>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function run(prepared: Json) {
    if (running.current) throw Error("A transaction is already in progress.");
    running.current = true;
    setBusy(true);
    setError("");
    setReceipt(prepared);
    try {
      let p = prepared;
      if (p.state === "prepared") {
        if (p.broadcast_enabled === false)
          throw Error("Transactions are disabled on this deployment.");
        const bytes = Uint8Array.from(atob(p.transaction), (c) =>
          c.charCodeAt(0),
        );
        const signed = await wallet.sign(bytes);
        let wire = "";
        for (const b of signed) wire += String.fromCharCode(b);
        p = await request(`/transactions/${p.id}/submit`, {
          transaction: btoa(wire),
        });
      }
      const started = Date.now();
      while (true) {
        p = await request(`/transactions/${prepared.id}`);
        setReceipt(p);
        if (terminal(p.state)) break;
        if (Date.now() - started > 120000)
          throw Error(
            "Confirmation is taking longer. Track this transaction in Activity; do not submit it again.",
          );
        await new Promise((r) => setTimeout(r, 1200));
      }
      if (p.state !== "finalized")
        throw Error(
          `Transaction ${p.state}. Reopen the action for a fresh preparation.`,
        );
      await query.invalidateQueries();
      return p;
    } catch (e) {
      setError((e as Error).message);
      throw e;
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <Context.Provider value={{ run, busy }}>
      {children}
      {receipt && (
        <aside className="tx-toast" role="status">
          <div>
            <span className="eyebrow">Transaction</span>
            <strong>{error || receipt.state}</strong>
            <small>
              {receipt.signature?.slice(0, 28) ||
                receipt.summary?.action ||
                receipt.step ||
                "Waiting for wallet"}
            </small>
          </div>
          {!busy && (
            <button
              aria-label="Dismiss transaction"
              onClick={() => setReceipt(undefined)}
            >
              ×
            </button>
          )}
        </aside>
      )}
    </Context.Provider>
  );
}
export const useTransactions = () => useContext(Context);
