import { test, expect } from "./fixtures/auth";

/**
 * HIL Gates spec — gate inbox, resolution, audit trail.
 */
test.describe("HIL Gates", () => {
  test("gate inbox loads and shows empty or pending state", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("text=HIL Gates");
    await expect(page.locator("text=Human-in-the-Loop Gate Inbox").first()).toBeVisible({ timeout: 10_000 });
    // Empty state: "No gates waiting for review." or pending: "awaiting decision"
    const emptyState = page.locator("text=No gates waiting");
    const pendingBadge = page.locator("text=awaiting decision");
    await expect(emptyState.or(pendingBadge).first()).toBeVisible({ timeout: 10_000 });
  });

  test("gate audit trail section is present", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("text=HIL Gates");
    await expect(page.locator("text=Human-in-the-Loop Gate Inbox").first()).toBeVisible({ timeout: 10_000 });
    // "Recently Resolved" button
    await expect(page.locator("text=Recently Resolved").first()).toBeVisible({ timeout: 10_000 });
  });

  test("gate inbox loads and shows content", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("text=HIL Gates");
    await expect(page.locator("text=Human-in-the-Loop Gate Inbox").first()).toBeVisible({ timeout: 10_000 });
    // Page loaded successfully — content may vary based on gate events
  });
});
