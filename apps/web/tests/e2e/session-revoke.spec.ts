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

test("a failed session revoke shows an error and keeps the session row", async ({ page, baseURL }) => {
  // Unique UA per invocation: on a retry, the failed attempt's second
  // session is still listed, and a shared UA would match two rows
  // (strict-mode violation). A per-run UA keeps the row locator exact.
  const otherUa = `E2E-Other-Device-${Date.now()}`;
  // Playwright Test's request.newContext() inherits this test's
  // storageState (the demo session cookies) unless overridden — with a
  // Cookie header present, better-auth's origin check runs and rejects
  // the headerless API sign-in with MISSING_OR_NULL_ORIGIN. An empty
  // storage state gives the intended clean jar, so the origin check is
  // skipped for this first-login-style request.
  const other = await apiRequest.newContext({
    baseURL: baseURL ?? undefined,
    userAgent: otherUa,
    storageState: { cookies: [], origins: [] },
  });
  const signInOnce = () =>
    other.post("/api/auth/sign-in/email", {
      data: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
    });
  let signIn = await signInOnce();
  // better-auth rate-limits /sign-in/email (3 per 10s per IP); the setup
  // project signed in moments earlier, so this second sign-in can land in
  // the same window. Wait out a 429 using its Retry-After; any other
  // failure is real and is reported with its status/body below.
  for (let attempt = 0; signIn.status() === 429 && attempt < 3; attempt++) {
    const retryAfter = Number(signIn.headers()["retry-after"] ?? 10);
    await new Promise((resolve) => setTimeout(resolve, (retryAfter + 1) * 1000));
    signIn = await signInOnce();
  }
  expect(signIn.ok(), `sign-in failed: ${signIn.status()} ${await signIn.text()}`).toBeTruthy();
  await other.dispose();

  await page.goto("/settings/security");
  const row = page.getByRole("listitem").filter({ hasText: otherUa });
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
  await expect(page.getByRole("alert").filter({ hasText: "Couldn't revoke that session" })).toBeVisible();
  await expect(row).toBeVisible();

  // Cleanup + success path: un-stub and revoke for real; the row goes.
  await page.unroute("**/api/auth/revoke-session");
  await row.getByRole("button", { name: "Revoke" }).click();
  await expect(row).toBeHidden();
});
