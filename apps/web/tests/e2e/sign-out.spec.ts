import { test, expect } from "@playwright/test";
import { STORAGE_STATE } from "./constants";

test.use({ storageState: STORAGE_STATE });

// A-FE-20: sign-out must only navigate to /login when the logout
// request succeeds. On failure the session is still alive, so the user
// stays in the app with an error shown (the old try/finally navigated
// unconditionally and /login bounced straight back to /dashboard).
// Both cases stub the endpoint: a real successful logout would revoke
// the shared storage-state session server-side and break later tests.
test("failed logout keeps the user signed in with an error", async ({ page }) => {
  await page.route("**/api/auth/logout", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "logout_failed" }),
    }),
  );
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Couldn't sign out" })).toBeVisible();
  // Still signed in: no navigation to /login, session UI visible and
  // the button usable again.
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("button", { name: "Sign out" })).toBeEnabled();
});

test("successful logout navigates to /login", async ({ page }) => {
  await page.route("**/api/auth/logout", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "ok" }),
    }),
  );
  await page.goto("/dashboard");
  // The fulfilled 200 does not clear the session cookie, so /login's
  // server-side signed-in redirect bounces back to /dashboard; assert
  // the client-side navigation to /login was initiated instead (in
  // production the real Set-Cookie drops the session and /login
  // renders).
  const loginNav = page.waitForRequest((req) => req.url().includes("/login"), { timeout: 10_000 });
  await page.getByRole("button", { name: "Sign out" }).click();
  await loginNav;
  await expect(page.getByRole("alert").filter({ hasText: "Couldn't sign out" })).toHaveCount(0);
});
