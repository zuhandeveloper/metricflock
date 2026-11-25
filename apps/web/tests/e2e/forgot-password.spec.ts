import { test, expect } from "@playwright/test";

// A-FE-17: the forgot-password form must not claim a reset email is on
// its way when the request never reached the server. better-auth
// returns 200 even for unknown emails (no enumeration), and that 200
// still shows the success message — but a transport failure (offline,
// server down) must surface an error instead. Route interception
// simulates both cases without touching the real endpoint.
test("forgot-password shows an error when the reset request cannot reach the server", async ({ page }) => {
  await page.route("**/api/auth/request-password-reset", (route) => route.abort());
  await page.goto("/forgot-password");
  await page.getByLabel("Email", { exact: true }).fill("someone@example.com");
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Couldn't reach the server" })).toBeVisible();
  // No success claim, and the form is still there for a retry.
  await expect(page.getByText(/a password reset link is on its way/)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send reset link" })).toBeVisible();
});

test("forgot-password still shows the success message when the server responds", async ({ page }) => {
  await page.route("**/api/auth/request-password-reset", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
  );
  await page.goto("/forgot-password");
  await page.getByLabel("Email", { exact: true }).fill("someone@example.com");
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByText(/a password reset link is on its way/)).toBeVisible();
});
