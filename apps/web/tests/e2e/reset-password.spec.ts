import { test, expect } from "@playwright/test";

// A-FE-13: the reset-password form must catch a mistyped new password
// before submitting — the reset token is single-use, so a typo would
// otherwise only surface at the next (failing) sign-in. The page renders
// the form for any token, so a dummy token is enough here; the mismatch
// check is client-side and must block the POST entirely.
test("reset-password form blocks submission when the passwords do not match", async ({ page }) => {
  const resetPosts: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().includes("/api/auth/reset-password")) resetPosts.push(req.url());
  });
  await page.goto("/reset-password/e2e-dummy-token");
  await page.getByLabel("New password", { exact: true }).fill("a-very-long-password");
  await page.getByLabel("Confirm new password", { exact: true }).fill("a-different-password");
  await page.getByRole("button", { name: "Reset password" }).click();
  await expect(page.getByRole("alert")).toHaveText("Passwords do not match.");
  // Still on the form (no success state) and nothing was posted.
  await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
  await expect(page.getByText(/Your password has been reset/)).toHaveCount(0);
  expect(resetPosts).toEqual([]);
});
