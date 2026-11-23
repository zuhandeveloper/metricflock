import { test, expect } from "@playwright/test";
import { STORAGE_STATE } from "./constants";

// Core user journeys through the real UI (Phase 8). Names are unique
// per run so the suite is re-runnable against the same database.
test.use({ storageState: STORAGE_STATE });

const stamp = Date.now().toString(36);

test("create a team from the Teams page", async ({ page }) => {
  await page.goto("/teams");
  await page.getByLabel(/team name/i).fill(`E2E Team ${stamp}`);
  await page.getByLabel(/slug/i).fill(`e2e-team-${stamp}`);
  await page.getByRole("button", { name: /create team/i }).click();
  await expect(page.getByText(`E2E Team ${stamp}`)).toBeVisible();
});

test("create a website from the Websites page", async ({ page }) => {
  await page.goto("/websites");
  await page
    .getByLabel(/website name|name/i)
    .first()
    .fill(`E2E Site ${stamp}`);
  await page.getByLabel(/domain/i).fill(`e2e-${stamp}.example.com`);
  await page.getByRole("button", { name: /add website|create website/i }).click();
  await expect(page.getByText(`e2e-${stamp}.example.com`)).toBeVisible();
});

test("create and revoke an API key", async ({ page }) => {
  await page.goto("/settings/api-keys");
  await page.getByLabel(/key name/i).fill(`E2E key ${stamp}`);
  await page.getByRole("button", { name: /create api key/i }).click();
  // The secret is shown once.
  await expect(page.getByText(/copy this secret now/i)).toBeVisible();
  await expect(page.getByText(`E2E key ${stamp}`)).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  const row = page.getByRole("row", { name: new RegExp(`E2E key ${stamp}`) });
  await row.getByRole("button", { name: /revoke/i }).click();
  await expect(row.getByText(/revoked/i)).toBeVisible();
});

test("save a weekly report schedule", async ({ page }) => {
  await page.goto("/settings/reports");
  await page.getByLabel(/send the weekly report automatically/i).check();
  await page.getByLabel(/day \(utc\)/i).selectOption("3"); // Wednesday
  await page.getByRole("button", { name: /save schedule/i }).click();
  await expect(page.getByText(/schedule saved/i)).toBeVisible();
});

test("mobile navigation opens, navigates, and closes", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dashboard");
  await page.getByRole("button", { name: /open navigation/i }).click();
  const drawer = page.getByRole("dialog", { name: /navigation/i });
  await expect(drawer).toBeVisible();
  await drawer.getByRole("link", { name: /websites/i }).click();
  await expect(page).toHaveURL(/\/websites/);
  await expect(drawer).toBeHidden();
});
