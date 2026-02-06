import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["packages/*/src/**/*.test.ts"],
    pool: "threads",
    coverage: {
      provider: "v8",
      include: ["packages/shared/src/**/*.ts"],
      exclude: [
        "packages/*/src/**/*.test.ts",
        "packages/shared/src/db/**",
        "packages/shared/src/index.ts",
      ],
      thresholds: {
        statements: 50,
        branches: 40,
        functions: 40,
        lines: 50,
      },
    },
  },
});
