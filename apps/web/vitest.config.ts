import { defineConfig } from "vitest/config";
import path from "path";
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // googleapis is a dependency of @metricflock/google, not of the web
      // app — alias it so test files and package sources resolve the same
      // module instance (required for vi.mock("googleapis") to intercept).
      googleapis: path.resolve(__dirname, "../../packages/google/node_modules/googleapis"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // Scope = modules exercised by the unit suite (pure logic:
      // parsers, crypto, tenant policy, sync engine). Route-level and
      // DB-backed coverage comes from the CI smoke suite
      // (scripts/smoke-test.sh), not from unit coverage.
      // Thresholds set just below measured values (2026-11-21:
      // 97.7% stmts / 91.7% branch / 100% funcs / 100% lines) so a
      // regression in a tested module fails CI (CI-5).
      thresholds: { statements: 90, branches: 80, functions: 90, lines: 90 },
    },
  },
});
