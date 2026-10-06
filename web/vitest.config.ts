import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["web/tests/**/*.test.ts"],
    environment: "node",
    setupFiles: ["web/tests/setup.ts"],
  },
});
