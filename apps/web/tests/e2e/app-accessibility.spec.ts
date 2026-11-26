import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { STORAGE_STATE } from "./constants";

// Accessibility gate for signed-in pages (Phase 8). Same bar as the
// signed-out spec: zero axe violations at ANY impact level (A-COV-13
// tightened this from critical/serious-only — moderate and minor
// violations no longer pass silently).
test.use({ storageState: STORAGE_STATE });

const PAGES = [
  "/dashboard",
  "/websites",
  "/teams",
  "/members",
  "/integrations",
  "/health",
  "/insights",
  "/transfers",
  "/audit",
  "/settings/security",
  "/settings/reports",
  "/settings/api-keys",
];

for (const path of PAGES) {
  test(`${path} has no accessibility violations`, async ({ page }) => {
    await page.goto(path);
    await expect(page).toHaveURL(new RegExp(path.replace(/\//g, "\\/")));
    // Wait for the streamed page content (not just the (app) loading
    // skeleton, which has no h1) before scanning — otherwise axe can
    // run against the skeleton and flake on page-has-heading-one.
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const results = await new AxeBuilder({ page }).analyze();
    const blocking = results.violations.filter(
      (v) => v.impact === "critical" || v.impact === "serious" || v.impact === "moderate" || v.impact === "minor",
    );
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

test("skip link is the first focusable element and targets main content", async ({ page }) => {
  await page.goto("/dashboard");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: /skip to main content/i });
  await expect(skip).toBeFocused();
  await skip.click();
  await expect(page.locator("#main-content")).toBeFocused();
});
