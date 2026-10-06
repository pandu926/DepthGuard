import React, { createContext, useContext, useState } from "react";
import { initialEconomy } from "./economy";
import { newId } from "./id";
import { Economy } from "./client";
type Draft = {
  name: string;
  symbol: string;
  uri: string;
  modelName: string;
  economy: Economy;
  reviewers: string[];
  modelId?: string;
  versionId?: string;
  revision?: number;
  launchKey: string;
};
const Context = createContext<{
  draft: Draft;
  update(value: Partial<Draft>): void;
  reset(author?: string): void;
}>(null!);
const initial = (author?: string): Draft => ({
  name: "",
  symbol: "",
  uri: "",
  modelName: "My economy",
  economy: initialEconomy(author),
  reviewers: [],
  launchKey: newId(),
});
export function DraftProvider({ children }: { children: React.ReactNode }) {
  const [draft, setDraft] = useState<Draft>(() => {
    try {
      const d = JSON.parse(
        localStorage.getItem("depthguard.draft.v2") || "null",
      );
      return d?.economy?.schema_version === 2 ? d : initial();
    } catch {
      return initial();
    }
  });
  function update(value: Partial<Draft>) {
    setDraft((old) => {
      const next = { ...old, ...value };
      if (value.economy) {
        if (!("versionId" in value)) next.versionId = undefined;
        next.launchKey = newId();
      }
      if (
        ["name", "symbol", "uri", "reviewers"].some(
          (k) =>
            k in value &&
            JSON.stringify((old as any)[k]) !==
              JSON.stringify((value as any)[k]),
        )
      )
        next.launchKey = newId();
      localStorage.setItem("depthguard.draft.v2", JSON.stringify(next));
      return next;
    });
  }
  function reset(author?: string) {
    const next = initial(author);
    localStorage.setItem("depthguard.draft.v2", JSON.stringify(next));
    setDraft(next);
  }
  return (
    <Context.Provider value={{ draft, update, reset }}>
      {children}
    </Context.Provider>
  );
}
export const useDraft = () => useContext(Context);
