import { test, expect } from "@playwright/test";
import { STORAGE_STATE } from "./constants";

test.use({ storageState: STORAGE_STATE });

// A-FE-12: the theme toggle must persist the choice — toggling dark and
// reloading keeps the `dark` class on <html> (the server renders it from
// the `theme` cookie), and the button exposes its pressed state.
test("theme toggle persists across reload", async ({ page }) => {
  await page.goto("/dashboard");
  const toggle = page.getByRole("button", { name: "Dark / Light" });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("html")).not.toHaveClass(/dark/);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("html")).toHaveClass(/dark/);

  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.getByRole("button", { name: "Dark / Light" })).toHaveAttribute("aria-pressed", "true");
});
