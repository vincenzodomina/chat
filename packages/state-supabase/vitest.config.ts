import { defineProject } from "vitest/config";

const runIntegration = process.env.RUN_INTEGRATION === "1";

export default defineProject({
  test: {
    globals: true,
    environment: "node",
    testTimeout: runIntegration ? 120_000 : 10_000,
    hookTimeout: runIntegration ? 90_000 : 10_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
    },
  },
});
