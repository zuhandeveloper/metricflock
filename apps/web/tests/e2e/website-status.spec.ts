import { test, expect } from "@playwright/test";
import { STORAGE_STATE } from "./constants";

// A-FE-09: the edit-website status select must offer the documented
// client-settable set — including SOLD (previously unreachable from the
// UI) and excluding TRANSFER_PENDING (owned by the transfer workflow).
// The website name/domain are unique per run so the suite is re-runnable
// against the same database (journeys.spec.ts pattern).
test.use({ storageState: STORAGE_STATE });

const stamp = Date.now().toString(36);

test("edit-website status select offers SOLD and excludes TRANSFER_PENDING", async ({ page }) => {
  await page.goto("/websites");
  const domain = `e2e-status-${stamp}.example.com`;
  await page.getByLabel("Website name", { exact: true }).fill(`E2E Status ${stamp}`);
  await page.getByLabel("Domain", { exact: true }).fill(domain);
  await page.getByRole("button", { name: /add website|create website/i }).click();
  await expect(page.getByText(domain)).toBeVisible();
  await page.getByRole("row", { name: domain }).getByRole("link", { name: /open/i }).click();
  await expect(page).toHaveURL(/\/websites\//);
  const select = page.getByLabel("Status");
  await expect(select).toBeVisible();
  const values = await select
    .locator("option")
    .evaluateAll((options) => options.map((o) => (o as HTMLOptionElement).value));
  expect(values).toEqual(["ACTIVE", "PENDING_SETUP", "DISCONNECTED", "SOLD", "ARCHIVED"]);
});
