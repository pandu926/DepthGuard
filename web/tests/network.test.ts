import { expect, it } from "vitest";
import { supportsNetwork } from "../src/app/network";
it("requires the deployment chain even when the account supports other Solana networks", () => {
  expect(supportsNetwork(["solana:mainnet"], "devnet")).toBe(false);
  expect(supportsNetwork(["solana:mainnet", "solana:devnet"], "devnet")).toBe(
    true,
  );
  expect(supportsNetwork(["solana:devnet"], "mainnet-beta")).toBe(false);
  expect(supportsNetwork(["solana:localnet"], "unknown")).toBe(false);
});
