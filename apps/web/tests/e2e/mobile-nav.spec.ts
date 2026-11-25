import { test, expect } from "@playwright/test";
import { STORAGE_STATE } from "./constants";

// A-FE-19: the mobile nav drawer is role="dialog" aria-modal="true", so
// Tab must cycle inside it while open instead of escaping into the
// obscured page behind it. journeys.spec.ts covers open → navigate →
// close; this spec covers Tab order.
test.use({ storageState: STORAGE_STATE });

test("mobile nav drawer traps Tab focus while open", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dashboard");
  await page.getByRole("button", { name: /open navigation/i }).click();
  const drawer = page.getByRole("dialog", { name: /navigation/i });
  await expect(drawer).toBeVisible();
  await expect(page.getByRole("button", { name: /close navigation/i })).toBeFocused();

  const focusInsideDrawer = () => page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null);

  // Tab more times than there are focusable elements in the drawer
  // (close button + brand link + nav links + sign out): focus must
  // wrap around and never leave the drawer.
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press("Tab");
    await expect.poll(focusInsideDrawer).toBe(true);
  }

  // Shift+Tab from the first element (the close button, focused on
  // open) wraps to the last (Sign out), and further Shift+Tabs stay
  // inside too.
  await page.getByRole("button", { name: /close navigation/i }).focus();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: /sign out/i })).toBeFocused();
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("Shift+Tab");
    await expect.poll(focusInsideDrawer).toBe(true);
  }

  // Escape still closes and returns focus to the menu button.
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(page.getByRole("button", { name: /open navigation/i })).toBeFocused();
});
