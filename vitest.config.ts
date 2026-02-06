import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@exams2quiz/shared/types": path.resolve(
        __dirname,
        "packages/shared/src/types/index.ts",
      ),
      "@exams2quiz/shared/config": path.resolve(
        __dirname,
        "packages/shared/src/config/index.ts",
      ),
      "@exams2quiz/shared/queue": path.resolve(
        __dirname,
        "packages/shared/src/queue/index.ts",
      ),
      "@exams2quiz/shared/db": path.resolve(
        __dirname,
        "packages/shared/src/db/index.ts",
      ),
    },
  },
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
