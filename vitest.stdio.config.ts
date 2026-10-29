// vitest.stdio.config.ts — the one real-stdio protocol test; needs `npm run build` first (spawns dist/server/stdio.js).
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/stdio/**/*.test.ts"],
    testTimeout: 60_000,
    fileParallelism: false,
  },
});
