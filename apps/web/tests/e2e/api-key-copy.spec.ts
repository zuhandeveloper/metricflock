import { test, expect } from "@playwright/test";
import { STORAGE_STATE } from "./constants";

// A-FE-18: the one-time API-key secret gets a Copy button — clicking it
// must write the exact secret to the clipboard (pre-fix the user had to
// manually select the long token at the one moment it is shown).
test.use({ storageState: STORAGE_STATE });

const stamp = Date.now().toString(36);

test("copy button writes the new API-key secret to the clipboard", async ({ page, context }) => {
  await page.goto("/settings/api-keys");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByLabel(/key name/i).fill(`E2E copy key ${stamp}`);
  await page.getByRole("button", { name: /create api key/i }).click();
  // The secret is shown once, in the amber box.
  await expect(page.getByText(/copy this secret now/i)).toBeVisible();
  const secret = await page.locator("p", { hasText: "Copy this secret now" }).locator("..").locator("code").innerText();
  expect(secret.length).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(page.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toBe(secret);

  // Cleanup: revoke the key so the account is left as found.
  page.once("dialog", (dialog) => dialog.accept());
  const row = page.getByRole("row", { name: new RegExp(`E2E copy key ${stamp}`) });
  await row.getByRole("button", { name: /revoke/i }).click();
  await expect(row.getByText(/revoked/i)).toBeVisible();
});
