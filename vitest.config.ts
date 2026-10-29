// vitest.config.ts — in-process suites (unit, contract, parity self-tests, static). The real-stdio test has its own config.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/stdio/**", "node_modules/**", "dist/**"],
    testTimeout: 20_000,
  },
});
