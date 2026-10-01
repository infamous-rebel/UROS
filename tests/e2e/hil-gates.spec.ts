import { test, expect } from "./fixtures/auth";

/**
 * HIL Gates spec — gate inbox, resolution, audit trail.
 */
test.describe("HIL Gates", () => {
  // Clear all pending gates before each test to ensure empty state
  test.beforeEach(async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    // Get the auth token from localStorage
    const token = await page.evaluate(() => localStorage.getItem("uros_dev_token"));
    if (token) {
      // Fetch all pending gates
      const gates = await page.evaluate(async (tok) => {
        const res = await fetch("/api/v1/gates", {
          headers: { Authorization: `Bearer ${tok}` },
        });
        const data = await res.json();
        return data.gates || [];
      }, token);
      // Resolve each gate to ensure empty state
      for (const gate of gates) {
        await page.evaluate(
          async ({ tok, gateId }) => {
            await fetch(`/api/v1/gates/${gateId}/resolve`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${tok}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                decision: "APPROVE",
                reason_comment: "Cleared by test setup",
              }),
            });
          },
          { tok: token, gateId: gate.gate_id }
        );
      }
    }
  });

  test("gate inbox loads and shows empty or pending state", async ({ page }) => {
    await page.click("text=HIL Gates");
    await expect(page.locator("text=Human-in-the-Loop Gate Inbox").first()).toBeVisible({ timeout: 10_000 });
    // Empty state: "No gates waiting for review." or pending: "awaiting decision"
    const emptyState = page.locator("text=No gates waiting");
    const pendingBadge = page.locator("text=awaiting decision");
    await expect(emptyState.or(pendingBadge).first()).toBeVisible({ timeout: 10_000 });
  });

  test("gate audit trail section is present", async ({ page }) => {
    await page.click("text=HIL Gates");
    await expect(page.locator("text=Human-in-the-Loop Gate Inbox").first()).toBeVisible({ timeout: 10_000 });
    // "Recently Resolved" button
    await expect(page.locator("text=Recently Resolved").first()).toBeVisible({ timeout: 10_000 });
  });

  test("empty state shows helpful message", async ({ page }) => {
    await page.click("text=HIL Gates");
    await expect(page.locator("text=Human-in-the-Loop Gate Inbox").first()).toBeVisible({ timeout: 10_000 });
    // Wait for API response to ensure data is loaded
    await page.waitForLoadState("networkidle");
    // Empty state shows "0 pending" badge, "No gates waiting for review.", and "Pipeline is flowing"
    await expect(page.locator("text=0 pending").first()).toBeVisible({ timeout: 5_000 });
    await expect(page.locator("text=No gates waiting").first()).toBeVisible({ timeout: 5_000 });
    await expect(page.locator("text=Pipeline is flowing").first()).toBeVisible({ timeout: 5_000 });
  });
});
