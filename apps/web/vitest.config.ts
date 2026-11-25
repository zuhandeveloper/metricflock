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
      // Same for ioredis (@metricflock/shared's dependency): without the
      // alias, vi.mock("ioredis") silently misses and tests hit a real
      // Redis when one is listening (CI service container).
      ioredis: path.resolve(__dirname, "../../packages/shared/node_modules/ioredis"),
      // Same for bullmq (@metricflock/worker's dependency): without the
      // alias, vi.mock("bullmq") resolves a different pnpm copy than the
      // worker imports and silently misses (real Workers then try to
      // connect to Redis).
      bullmq: path.resolve(__dirname, "../../apps/worker/node_modules/bullmq"),
    },
  },
  test: {
    environment: "node",
    // A-BASE-01: the default 10s hook timeout flakes on slow machines —
    // rate-limit-failclosed.test.ts re-imports the @metricflock/shared
    // barrel inside beforeAll (vi.resetModules + dynamic import), which
    // can exceed 10s when the suite runs on a constrained CPU. 30s is
    // headroom for hooks only; per-test timeouts are unchanged.
    hookTimeout: 30_000,
    // A-PERF-04: `isolate: false` was evaluated 2026-11-25 — it cuts the
    // suite from ~171s to ~49s, but 221 of 1,531 tests fail: with a
    // shared module registry, per-file `vi.mock` registrations bleed
    // across files (e.g. a null-session auth mock makes later route
    // tests return 401). Isolation stays ON; do not re-enable without
    // first making every file's mocks registry-safe.
    include: ["tests/unit/**/*.test.{ts,tsx}"],
    // jest-dom matchers for component tests (jsdom). Loaded for every test
    // file; it only extends expect, so node-env unit tests are unaffected.
    // Component tests opt into jsdom with a per-file
    // `// @vitest-environment jsdom` docblock.
    setupFiles: ["./tests/setup.ts"],
    coverage: {
      provider: "v8",
      // A-COV-01 (Stage 1, row 14): the gate must measure the repo, not
      // just the 8 lib files the unit suite happens to import. `include`
      // names every measured file set — routes, packages and the worker —
      // and `allowExternal` is required because packages/worker live
      // outside this config's root (apps/web). (Vitest 5 removed the old
      // `coverage.all` flag; `include` + `allowExternal` is its
      // replacement.) Thresholds are NOT lowered.
      // Globs are relative to this config (apps/web): packages/worker
      // live two levels up, hence the ../../ prefixes. NOTE: vitest
      // matches coverage globs against path.relative(root, file), which
      // is the SHORTEST relative path — for apps/worker that is
      // "../worker/..." (one "..": apps/web -> apps), NOT
      // "../../apps/worker/..." (picomatch does not normalize "..", so
      // the two-".." form never matched and worker files were silently
      // absent from coverage). Packages need "../../packages/..." because
      // they live outside apps/.
      include: ["src/**/*.ts", "src/**/*.tsx", "../../packages/*/src/**/*.ts", "../worker/src/**/*.ts"],
      allowExternal: true,
      // Thresholds set just below measured values (2026-11-21:
      // 97.7% stmts / 91.7% branch / 100% funcs / 100% lines) so a
      // regression in a tested module fails CI (CI-5).
      thresholds: { statements: 90, branches: 80, functions: 90, lines: 90 },
    },
  },
});
