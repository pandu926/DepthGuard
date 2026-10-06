import { expect, test, vi } from "vitest";
import { newId } from "../src/app/id";
test("draft IDs need no secure-context-only randomUUID API", () => {
  const getRandomValues = crypto.getRandomValues.bind(crypto);
  vi.stubGlobal("crypto", { getRandomValues });
  try {
    expect(newId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(newId()).not.toBe(newId());
  } finally {
    vi.unstubAllGlobals();
  }
});
