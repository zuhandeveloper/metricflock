import { test as setup, expect } from "@playwright/test";
import { DEMO_EMAIL, DEMO_PASSWORD, STORAGE_STATE } from "./constants";

// Authenticated e2e setup (Phase 8): sign in once with the seeded
// demo admin and save the session for the app specs. Runs as a
// Playwright setup project, so the webServer (and, in CI, the
// migrated + seeded database) is already up. One login total keeps
// us well under better-auth's sign-in rate limit.
setup("authenticate as demo admin", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel(/email/i).fill(DEMO_EMAIL);
  await page.getByLabel(/password/i).fill(DEMO_PASSWORD);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  await page.context().storageState({ path: STORAGE_STATE });
});
