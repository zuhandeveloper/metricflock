import { defineConfig } from "@playwright/test";

// E2E + accessibility harness (Stage 9; closes Stage 6's deferred axe
// gate). Runs against a production build (`pnpm build` first, then
// `pnpm test:e2e` boots `next start` itself via webServer below).
// Requires the same env as the app (DATABASE_URL etc.) — in CI the
// service containers provide them; locally point DATABASE_URL at a
// dev database. Phase 8 adds signed-in coverage: the "setup" project
// signs in once with the seeded demo admin and saves the session;
// the "app" project (axe on signed-in pages + UI journeys) reuses
// it. The "signed-out" project keeps the original auth-page gate.
const PORT = Number(process.env.E2E_PORT ?? 3200);

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: `http://localhost:${PORT}` },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    { name: "signed-out", testMatch: /(^|\/)accessibility\.spec\.ts$/ },
    {
      name: "app",
      testMatch: /(app-accessibility|journeys|website-status|session-revoke)\.spec\.ts/,
      dependencies: ["setup"],
    },
  ],
  webServer: {
    command: `pnpm exec next start -p ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
