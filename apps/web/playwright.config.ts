import { defineConfig } from "@playwright/test";

// E2E + accessibility harness (Stage 9; closes Stage 6's deferred axe
// gate). Runs against a production build (`pnpm build` first, then
// `pnpm test:e2e` boots `next start` itself via webServer below).
// Requires the same env as the app (DATABASE_URL etc.) — in CI the
// service containers provide them; locally point DATABASE_URL at a
// dev database. Only signed-out pages are covered here; authenticated
// flows are covered by scripts/smoke-test.sh over HTTP.
const PORT = Number(process.env.E2E_PORT ?? 3200);

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: `http://localhost:${PORT}` },
  webServer: {
    command: `pnpm exec next start -p ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
