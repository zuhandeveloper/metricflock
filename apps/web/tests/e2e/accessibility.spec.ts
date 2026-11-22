import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Accessibility gate (FE-3 / Stage 6 deferred item): the signed-out
// auth pages must have zero critical/serious axe violations, and the
// security headers (CI-2) must be present on real browser responses —
// the HTML-level smoke assertions can't see either.
const PAGES = ["/login", "/forgot-password"];

for (const path of PAGES) {
  test(`${path} has no critical/serious accessibility violations`, async ({ page }) => {
    await page.goto(path);
    const results = await new AxeBuilder({ page }).analyze();
    const blocking = results.violations.filter((v) => v.impact === "critical" || v.impact === "serious");
    expect(
      blocking,
      JSON.stringify(
        blocking.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })),
        null,
        2,
      ),
    ).toEqual([]);
  });
}

test("login page carries the security headers", async ({ page }) => {
  const res = await page.goto("/login");
  const headers = res!.headers();
  const csp = headers["content-security-policy"];
  expect(csp).toContain("default-src 'self'");
  // F-6.8: nonce-based script-src — no 'unsafe-inline' for scripts.
  expect(csp).toMatch(/script-src[^;]*'nonce-[A-Za-z0-9+/=]+'/);
  expect(csp).toMatch(/script-src[^;]*'strict-dynamic'/);
  expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  expect(csp).toContain("img-src 'self' data:");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["strict-transport-security"]).toContain("max-age=");
  expect(headers["x-request-id"]).toBeTruthy();
});

test("login page loads without CSP violations", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (msg) => {
    if (/content security policy/i.test(msg.text())) violations.push(msg.text());
  });
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  expect(violations).toEqual([]);
});

test("signed-out /dashboard redirects to sign-in", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("button", { name: /continue with google/i })).toBeVisible();
});
