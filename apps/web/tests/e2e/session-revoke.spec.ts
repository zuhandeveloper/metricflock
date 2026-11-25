import { test, expect, request as apiRequest } from "@playwright/test";
import { DEMO_EMAIL, DEMO_PASSWORD, STORAGE_STATE } from "./constants";

// A-FE-10: a failed session revoke must show an error and leave the
// session row in place (pre-fix the response was discarded, so a failed
// revoke looked successful while the session stayed live). A second
// session is created via the sign-in API from a separate request
// context (distinct UA, own cookie jar) so the storage-state session
// stays current and untouched; the test revokes it for real at the end
// to leave the account as it found it.
test.use({ storageState: STORAGE_STATE });

const OTHER_UA = "E2E-Other-Device";

test("a failed session revoke shows an error and keeps the session row", async ({ page, baseURL }) => {
  const other = await apiRequest.newContext({ baseURL: baseURL ?? undefined, userAgent: OTHER_UA });
  const signIn = await other.post("/api/auth/sign-in/email", {
    data: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
  });
  expect(signIn.ok()).toBeTruthy();
  await other.dispose();

  await page.goto("/settings/security");
  const row = page.getByRole("listitem").filter({ hasText: OTHER_UA });
  await expect(row).toBeVisible();

  // Stub the revoke endpoint to fail, then revoke: the error must be
  // shown and the session must still be listed.
  await page.route("**/api/auth/revoke-session", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "revoke_failed" }),
    }),
  );
  await row.getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByRole("alert")).toHaveText(/Couldn't revoke that session/);
  await expect(row).toBeVisible();

  // Cleanup + success path: un-stub and revoke for real; the row goes.
  await page.unroute("**/api/auth/revoke-session");
  await row.getByRole("button", { name: "Revoke" }).click();
  await expect(row).toBeHidden();
});
