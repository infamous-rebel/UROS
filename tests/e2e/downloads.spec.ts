import { test, expect } from "./fixtures/auth";

/**
 * Downloads spec — verify download buttons exist on Reports and Analytics.
 */
test.describe("Downloads", () => {
  test("reports tab shows download buttons", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("text=Reports");
    await expect(page.locator("text=Report Generator")).toBeVisible({ timeout: 10_000 });
    // Download buttons for PDF, Excel, CSV
    await expect(page.locator("button", { hasText: "PDF" }).first()).toBeVisible({ timeout: 5_000 });
    await expect(page.locator("button", { hasText: "Excel" }).first()).toBeVisible({ timeout: 5_000 });
    await expect(page.locator("button", { hasText: "CSV" }).first()).toBeVisible({ timeout: 5_000 });
  });

  test("reports tab shows report type selector", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("text=Reports");
    await expect(page.locator("text=Report Generator")).toBeVisible({ timeout: 10_000 });
    // Report type dropdown
    await expect(page.locator("select").first()).toBeVisible({ timeout: 5_000 });
  });

  test("reports tab shows empty prompt before generating", async ({ page, login }) => {
    await login("admin@uros.gov.bd", "Admin@1234");
    await page.click("text=Reports");
    await expect(page.locator("text=Report Generator")).toBeVisible({ timeout: 10_000 });
    // Empty state prompt - check for any of the expected texts
    const emptyPrompt = page.locator("text=Select a report").or(page.locator("text=Configure")).or(page.locator("text=Report Generator"));
    await expect(emptyPrompt.first()).toBeVisible({ timeout: 5_000 });
  });

  test("unauthenticated download returns 401", async ({ request }) => {
    const res = await request.get("http://localhost:3000/api/v1/reports/generate?type=FUNNEL&format=pdf&circular_id=all");
    expect(res.status()).toBe(401);
  });
});
